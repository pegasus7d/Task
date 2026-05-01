// apps/server/src/llm/strategies/few-shot.ts
//
// Strategy B — k=3 diverse exemplars wrapped in <examples>. Identical tool
// definition + system prompt as zero_shot; the only varied axis is this
// suffix. Examples land BEFORE the case transcript so the LLM sees the
// format pattern first.

import type { Sha256Hex } from "@test-evals/db/repositories";

import type { ClinicalExtraction } from "../../data/clinical-schema";
import { sha256, canonicalJson } from "../../utils/hash";
import { EXTRACT_CLINICAL_TOOL } from "../tool-definition";
import type { IStrategy, MessagePayload, StrategyContext } from "../types";

const SYSTEM_BODY = `You are a clinical-extraction assistant.
Extract structured fields from a doctor-patient transcript.
Use ONLY information present in the transcript.
If a field is not stated, set it to null. Do not infer.
Call the extract_clinical tool exactly once.`;

interface FewShotExample {
  example_id: "clean_visit" | "ambiguous" | "med_change";
  transcript: string;
  expected:   ClinicalExtraction;
}

const EXAMPLES: readonly FewShotExample[] = [
  {
    example_id: "clean_visit",
    transcript: `Doctor: What brings you in?
Patient: Sore throat for four days.
Doctor: Vitals look fine — BP 118/76, HR 72.
Doctor: This is a viral upper respiratory infection. Take ibuprofen 400 mg every 6 hours as needed.`,
    expected: {
      chief_complaint: "sore throat for four days",
      vitals:       { bp: "118/76", hr: 72, temp_f: null, spo2: null },
      medications:  [{ name: "ibuprofen", dose: "400 mg", frequency: "every 6 hours as needed", route: "PO" }],
      diagnoses:    [{ description: "viral upper respiratory infection" }],
      plan:         ["take ibuprofen 400 mg every 6 hours as needed"],
      follow_up:    { interval_days: null, reason: null },
    },
  },
  {
    example_id: "ambiguous",
    transcript: `Patient: I just feel off, kind of dizzy.
Doctor: Any fever? Nausea?
Patient: Not sure. Maybe a little warm.
Doctor: BP 122/80, HR 88. We'll order basic labs.`,
    expected: {
      chief_complaint: "feeling off and dizzy",
      vitals:       { bp: "122/80", hr: 88, temp_f: null, spo2: null },
      medications:  [],
      diagnoses:    [],
      plan:         ["order basic labs"],
      follow_up:    { interval_days: null, reason: null },
    },
  },
  {
    example_id: "med_change",
    transcript: `Patient: My blood sugar's been high.
Doctor: Let's bump metformin from 500 mg twice daily to 1000 mg twice daily. See me in 30 days.`,
    expected: {
      chief_complaint: "elevated blood sugar",
      vitals:       { bp: null, hr: null, temp_f: null, spo2: null },
      medications:  [{ name: "metformin", dose: "1000 mg", frequency: "twice daily", route: "PO" }],
      diagnoses:    [],
      plan:         ["increase metformin from 500 mg to 1000 mg twice daily"],
      follow_up:    { interval_days: 30, reason: "recheck blood sugar" },
    },
  },
];

function renderExamples(): string {
  const blocks = EXAMPLES.map((e) =>
    `<example>\n<transcript>\n${e.transcript}\n</transcript>\n<output>${JSON.stringify(e.expected)}</output>\n</example>`,
  ).join("\n");
  return `<examples>\n${blocks}\n</examples>`;
}

const EXAMPLES_BLOCK = renderExamples();

let cachedPromptHash: Sha256Hex | null = null;

export const fewShotStrategy: IStrategy = {
  name:        "few_shot",
  description: "k=3 diverse <example> exemplars before the transcript.",

  promptHash() {
    if (cachedPromptHash) return cachedPromptHash;
    cachedPromptHash = sha256(canonicalJson({
      strategy:    "few_shot",
      system:      SYSTEM_BODY,
      tool:        EXTRACT_CLINICAL_TOOL,
      examples:    EXAMPLES,
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
        content: [
          // Cache breakpoint #2: examples shared across all 50 cases of this strategy.
          { type: "text", text: EXAMPLES_BLOCK,
            cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: `<transcript>\n${ctx.transcript}\n</transcript>` },
        ],
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
      // Cache breakpoint #1: shared across all strategies + all cases.
      system: [{ type: "text", text: SYSTEM_BODY,
                 cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools:  [{ ...EXTRACT_CLINICAL_TOOL,
                 cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages,
      tool_choice: { type: "tool", name: "extract_clinical" },
      temperature: 0,
      max_tokens:  2048,
    };
  },
};
