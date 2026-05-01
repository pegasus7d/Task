// apps/server/src/llm/strategies/zero-shot.ts
//
// Strategy A — single-shot extraction. System prompt + tool definition only;
// no examples, no <thinking> scaffold. Promotes to V2 by adding cache_control
// breakpoints; for V1 we ship without caching.

import type { Sha256Hex } from "@test-evals/db/repositories";

import { sha256 } from "../../utils/hash";
import { EXTRACT_CLINICAL_TOOL } from "../tool-definition";
import type { IStrategy, MessagePayload, StrategyContext } from "../types";

const SYSTEM_BODY = `You are a clinical-extraction assistant.
Extract structured fields from a doctor-patient transcript.
Use ONLY information present in the transcript.
If a field is not stated, set it to null. Do not infer.
Call the extract_clinical tool exactly once.`;

let cachedPromptHash: Sha256Hex | null = null;

export const zeroShotStrategy: IStrategy = {
  name:        "zero_shot",
  description: "Single-shot extraction with system prompt + transcript only.",

  promptHash() {
    if (cachedPromptHash) return cachedPromptHash;
    cachedPromptHash = sha256(JSON.stringify({
      strategy: "zero_shot",
      system:   SYSTEM_BODY,
      tool:     EXTRACT_CLINICAL_TOOL,
      tool_choice: { type: "tool", name: "extract_clinical" },
      temperature: 0,
      max_tokens:  2048,
    }));
    return cachedPromptHash;
  },

  buildMessages(ctx: StrategyContext): MessagePayload {
    const messages: MessagePayload["messages"] = [
      {
        role: "user",
        content: [{
          type: "text",
          text: `<transcript>\n${ctx.transcript}\n</transcript>`,
        }],
      },
    ];

    // V2: on retries, append a tool_result turn carrying the prior validation
    // errors so the LLM can self-correct. The wire format matches contracts §6.
    if (ctx.prevFeedback) {
      messages.push({
        role: "user",
        content: [{
          type:        "tool_result",
          tool_use_id: ctx.prevFeedback.prior_tool_use_id,
          is_error:    true,
          content:     JSON.stringify({
            schema_version: 1,
            feedback:       ctx.prevFeedback,
          }),
        }],
      });
    }

    return {
      // Cache breakpoints sit only on the stable prefix (tools + system).
      // Default 5m ephemeral TTL is GA — the 1h variant needs the
      // `extended-cache-ttl-2025-04-11` beta header which we do not send.
      system: [{ type: "text", text: SYSTEM_BODY,
                 cache_control: { type: "ephemeral" } }],
      tools:  [{ ...EXTRACT_CLINICAL_TOOL,
                 cache_control: { type: "ephemeral" } }],
      messages,
      tool_choice: { type: "tool", name: "extract_clinical" },
      temperature: 0,
      max_tokens:  2048,
    };
  },
};
