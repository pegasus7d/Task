// apps/server/src/validators/grounding.ts
//
// Tier-1 hallucination detector (entities.md §1.10 grounding signal). For
// every leaf string in the prediction, assert it appears in the transcript
// (case-insensitive substring). V2 will add fuzzy-window matching.
//
// Skip-paths: vitals (numeric, formatting differs), interval_days (derived).

import type { ClinicalExtraction } from "../data/clinical-schema";
import type { IValidator, ValidationError, ValidationResult } from "./types";

const SKIP_PATHS = new Set<string>([
  "vitals.bp", "vitals.hr", "vitals.temp_f", "vitals.spo2",
  "follow_up.interval_days",
]);

export const groundingValidator: IValidator = {
  name: "grounding",

  validate(predicted: unknown, transcript: string): ValidationResult {
    const start = Date.now();

    if (predicted == null || typeof predicted !== "object") {
      return {
        ok: true, errors: [],
        schema_invalid: false, grounding_failed: false,
        hallucination_count: 0,
        validators_run: ["grounding"],
        duration_ms: Date.now() - start,
      };
    }

    const errors: ValidationError[] = [];
    const lower = transcript.toLowerCase();
    const pred  = predicted as ClinicalExtraction;

    const check = (path: string, value: string | null | undefined) => {
      if (!value || SKIP_PATHS.has(path)) return;
      if (!lower.includes(value.toLowerCase())) {
        errors.push({
          kind:       "grounding_substring_miss",
          field_path: path,
          message:    `value "${value}" not found in transcript`,
          hint:       "Quote a verbatim transcript span.",
          evidence: {
            candidate_value:    value,
            closest_transcript: null,
            similarity:         0,
          },
        });
      }
    };

    check("chief_complaint", pred.chief_complaint);
    pred.medications?.forEach((m, i) => check(`medications[${i}].name`, m.name));
    pred.diagnoses?.forEach((d, i)   => check(`diagnoses[${i}].description`, d.description));
    pred.plan?.forEach((p, i)        => check(`plan[${i}]`, p));

    return {
      ok:                  errors.length === 0,
      errors,
      schema_invalid:      false,
      grounding_failed:    errors.length > 0,
      hallucination_count: errors.length,
      validators_run:      ["grounding"],
      duration_ms:         Date.now() - start,
    };
  },
};
