// apps/server/src/llm/types.ts
//
// Subset of contracts.md §3 (Strategy) + §9 (LLMAdapter) needed for V1.
// Once @test-evals/shared exists, these move there.

import type { Sha256Hex, StrategyName } from "@test-evals/db/repositories";
import type { ClinicalExtraction } from "../data/clinical-schema";
import type { ValidationFeedback } from "../validators/feedback";

// ─── Anthropic-shaped content blocks ────────────────────────────────────────

export type ContentBlock =
  | { type: "text"; text: string;
      cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean; content: string };

export interface MessagePayload {
  system: ContentBlock[];
  tools: Array<{
    name:         string;
    description:  string;
    input_schema: object;
    cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" };
  }>;
  messages:    Array<{ role: "user" | "assistant"; content: ContentBlock[] }>;
  tool_choice: { type: "tool"; name: string };
  temperature: number;
  max_tokens:  number;
}

export interface StrategyContext {
  transcriptId: string;
  transcript:   string;
  attemptIdx:   1 | 2 | 3;
  /** V2: present on attempts 2+, carries the feedback derived from the prior attempt. */
  prevFeedback?: ValidationFeedback | null;
}

export interface IStrategy {
  readonly name:        StrategyName;
  readonly description: string;
  promptHash():         Sha256Hex;
  buildMessages(ctx: StrategyContext): MessagePayload;
}

// ─── LLM adapter (V1: only the call we need) ────────────────────────────────

export interface AdapterCallResult {
  predicted:               ClinicalExtraction;
  tool_use_id:             string;
  anthropic_request_id:    string;
  input_tokens:            number;
  output_tokens:           number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_total_usd:          number;
}

export interface ILLMAdapter {
  readonly id: string;
  call(payload: MessagePayload, caseId: string): Promise<AdapterCallResult>;
}
