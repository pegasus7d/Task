// apps/server/src/llm/anthropic-adapter.ts
//
// Minimal real-LLM adapter. Loaded only when ANTHROPIC_API_KEY is set; the
// mock remains the default so tests + CI never hit the network.
//
// Tool-use is forced via `tool_choice = {type:"tool", name:"extract_clinical"}`.
// Cache reads/writes are surfaced from the response usage block so the runner
// can populate `attempts.cache_read_input_tokens` and the run's headline
// caching efficiency.

import Anthropic from "@anthropic-ai/sdk";

import type { AdapterCallResult, ILLMAdapter, MessagePayload } from "./types";

export class AnthropicAdapter implements ILLMAdapter {
  readonly id = "anthropic";
  private readonly client: Anthropic;
  private readonly model:  string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model  = opts.model ?? "claude-haiku-4-5-20251001";
  }

  async call(payload: MessagePayload, _caseId: string): Promise<AdapterCallResult> {
    const resp = await this.client.messages.create({
      model:        this.model,
      max_tokens:   payload.max_tokens,
      temperature:  payload.temperature,
      system:       payload.system as never,        // already in Anthropic shape
      tools:        payload.tools as never,
      tool_choice:  payload.tool_choice,
      messages:     payload.messages as never,
    });

    const toolUse = resp.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error(`AnthropicAdapter: expected tool_use block, got stop_reason=${resp.stop_reason}`);
    }

    const usage = resp.usage as {
      input_tokens:                 number;
      output_tokens:                number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?:     number | null;
    };

    // Rough cost estimate using Haiku 4.5 base prices ($1/MTok in, $5/MTok out,
    // 0.1× cache read, 2× cache write 1h). Approximate — for a real number,
    // integrate with the canonical Pricing constant from contracts.md.
    const inUsd        = (usage.input_tokens                       / 1_000_000) * 1.0;
    const outUsd       = (usage.output_tokens                      / 1_000_000) * 5.0;
    const cacheReadUsd = ((usage.cache_read_input_tokens     ?? 0) / 1_000_000) * 0.1;
    const cacheWrtUsd  = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * 2.0;

    return {
      predicted:                   toolUse.input as never,
      tool_use_id:                 toolUse.id,
      anthropic_request_id:        resp.id,
      input_tokens:                usage.input_tokens,
      output_tokens:               usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens:     usage.cache_read_input_tokens     ?? 0,
      cost_total_usd:              inUsd + outUsd + cacheReadUsd + cacheWrtUsd,
    };
  }
}
