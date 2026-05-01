// apps/server/src/validators/types.ts
//
// V1 subset of contracts.md §5 (ValidationError, ValidationResult, IValidator).
// Lifts to @test-evals/shared once that package exists.

export type ValidationErrorKind =
  | "schema_required_missing"
  | "schema_type_mismatch"
  | "schema_pattern_violation"
  | "schema_range_violation"
  | "schema_additional_property"
  | "grounding_substring_miss"
  | "custom_rule_violation";

export interface ValidationError {
  kind:        ValidationErrorKind;
  field_path:  string;
  message:     string;
  hint:        string | null;
  expected?:   unknown;
  actual?:     unknown;
  evidence?: {
    candidate_value:    string;
    closest_transcript: string | null;
    similarity:         number;
  };
}

export interface ValidationResult {
  ok:                  boolean;
  errors:              ValidationError[];
  schema_invalid:      boolean;
  grounding_failed:    boolean;
  hallucination_count: number;
  validators_run:      string[];
  duration_ms:         number;
}

export interface IValidator {
  readonly name: string;
  validate(predicted: unknown, transcript: string): ValidationResult;
}
