// apps/server/src/validators/feedback.ts
//
// V2 — collect structured feedback from a failed ValidationResult and shape it
// into the wire payload that goes back to the LLM as a tool_result turn.
// Pure functions; no DB writes, no LLM calls.

import type { ValidationError, ValidationResult } from "./types";

export type AttemptIdx = 1 | 2 | 3;

export interface FeedbackError {
  error_type: ValidationError["kind"];
  field:      string;
  message:    string;
  hint:       string;
}

/** Wire shape — embedded inside a tool_result.content (JSON-stringified). */
export interface ValidationFeedback {
  attempt_idx:       AttemptIdx;          // the attempt being requested next
  prior_tool_use_id: string;
  errors:            FeedbackError[];
  hint:              string;              // top-level summary nudge
}

/** Internal grouping for the runner's logs / decision-making. */
export interface StructuredFeedback {
  schemaErrors:    ValidationError[];
  groundingErrors: ValidationError[];
  missingFields:   string[];
}

export function collectFeedback(v: ValidationResult): StructuredFeedback {
  const schemaErrors    = v.errors.filter((e) => e.kind.startsWith("schema_"));
  const groundingErrors = v.errors.filter((e) => e.kind.startsWith("grounding_"));
  const missingFields   = v.errors
    .filter((e) => e.kind === "schema_required_missing")
    .map((e) => e.field_path);
  return { schemaErrors, groundingErrors, missingFields };
}

export function toValidationFeedback(
  sf: StructuredFeedback,
  priorToolUseId: string,
  nextAttemptIdx: AttemptIdx,
): ValidationFeedback {
  const errors: FeedbackError[] = [
    ...sf.schemaErrors.map((e) => ({
      error_type: e.kind,
      field:      e.field_path,
      message:    e.message,
      hint:       e.hint ?? "fix the schema violation",
    })),
    ...sf.groundingErrors.map((e) => ({
      error_type: e.kind,
      field:      e.field_path,
      message:    e.message,
      hint:       e.hint ?? "quote a verbatim transcript span",
    })),
  ];

  const summary = sf.missingFields.length > 0
    ? `Missing required fields: ${sf.missingFields.join(", ")}. Fix the listed errors and re-call extract_clinical.`
    : "Fix the listed errors and re-call extract_clinical.";

  return {
    attempt_idx:       nextAttemptIdx,
    prior_tool_use_id: priorToolUseId,
    errors,
    hint:              summary,
  };
}
