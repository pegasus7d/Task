// apps/server/src/validators/schema.ts
//
// Zod-based schema validator. Anthropic strict tool-use is the first defense;
// this is the post-hoc check that catches anything that slipped through.

import { ZodError } from "zod";

import { ClinicalExtractionSchema } from "../data/clinical-schema";
import type { IValidator, ValidationError, ValidationErrorKind, ValidationResult } from "./types";

function mapZodIssueCode(code: string): ValidationErrorKind {
  switch (code) {
    case "invalid_type":      return "schema_type_mismatch";
    case "too_small":
    case "too_big":           return "schema_range_violation";
    case "invalid_string":
    case "invalid_format":    return "schema_pattern_violation";
    case "unrecognized_keys": return "schema_additional_property";
    default:                  return "custom_rule_violation";
  }
}

export const schemaValidator: IValidator = {
  name: "schema",

  validate(predicted: unknown, _transcript: string): ValidationResult {
    const start  = Date.now();
    const result = ClinicalExtractionSchema.safeParse(predicted);

    if (result.success) {
      return {
        ok: true,
        errors: [],
        schema_invalid: false,
        grounding_failed: false,
        hallucination_count: 0,
        validators_run: ["schema"],
        duration_ms: Date.now() - start,
      };
    }

    const errors: ValidationError[] = (result.error as ZodError).issues.map((i) => {
      const fieldPath = i.path.join(".");
      const isMissing = i.code === "invalid_type" &&
                        ("received" in i ? i.received === "undefined" : false);
      return {
        kind:       isMissing ? "schema_required_missing" : mapZodIssueCode(i.code),
        field_path: fieldPath,
        message:    i.message,
        hint:       null,
        actual:     "received" in i ? i.received : undefined,
      };
    });

    return {
      ok: false,
      errors,
      schema_invalid: true,
      grounding_failed: false,
      hallucination_count: 0,
      validators_run: ["schema"],
      duration_ms: Date.now() - start,
    };
  },
};
