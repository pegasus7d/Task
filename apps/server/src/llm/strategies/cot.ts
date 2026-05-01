// apps/server/src/llm/strategies/cot.ts
//
// Strategy C — manual chain-of-thought via a <thinking> block. Forced tool-
// use is incompatible with Anthropic's `thinking` parameter, so we instruct
// the model in the system prompt to emit a <thinking>...</thinking> turn
// before calling extract_clinical. The reasoning is logged for the trace UI
// but never scored.

import type { Sha256Hex } from "@test-evals/db/repositories";

import { sha256, canonicalJson } from "../../utils/hash";
import { EXTRACT_CLINICAL_TOOL } from "../tool-definition";
import type { IStrategy, MessagePayload, StrategyContext } from "../types";

const SYSTEM_BODY = `You are a clinical-extraction assistant.
Extract structured fields from a doctor-patient transcript.

PROCESS:
Before calling extract_clinical, write a <thinking> block that:
  1. Lists each field required by the schema.
  2. For each field, quotes the relevant transcript span (or marks it absent).
  3. Notes any normalization decisions (dose units, ICD-10 mapping, frequency).
Then call the extract_clinical tool exactly once.

RULES:
- Use ONLY information present in the transcript.
- If a field is not stated, set it to null. Do not infer.
- The <thinking> block is for your own reasoning; the tool call is the answer.`;

let cachedPromptHash: Sha256Hex | null = null;

export const cotStrategy: IStrategy = {
  name:        "cot",
  description: "Manual chain-of-thought: <thinking> block before the tool call.",

  promptHash() {
    if (cachedPromptHash) return cachedPromptHash;
    cachedPromptHash = sha256(canonicalJson({
      strategy:    "cot",
      system:      SYSTEM_BODY,
      tool:        EXTRACT_CLINICAL_TOOL,
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
          text: `<transcript>\n${ctx.transcript}\n</transcript>\n\nRemember: <thinking> first, then call extract_clinical.`,
        }],
      },
    ];

    if (ctx.prevFeedback) {
      messages.push({
        role: "user",
        content: [{
          type:        "tool_result",
          tool_use_id: ctx.prevFeedback.prior_tool_use_id,
          is_error:    true,
          content:     JSON.stringify({ schema_version: 1, feedback: ctx.prevFeedback }),
        }],
      });
    }

    return {
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
