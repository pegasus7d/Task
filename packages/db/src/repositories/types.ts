// packages/db/src/repositories/types.ts
//
// Domain types consumed by the repositories. These mirror contracts.md §1, §4,
// and §10 verbatim. Once `@test-evals/shared` exists per contracts.md, these
// declarations should be deleted and re-exported from there.

// ─── Branded primitives (contracts.md §1) ───────────────────────────────────

export type RunId        = string & { readonly __brand: "RunId" };
export type AttemptId    = string & { readonly __brand: "AttemptId" };
export type CaseId       = string;
export type StrategyName = "zero_shot" | "few_shot" | "cot" | (string & {});
export type ModelId      = "claude-haiku-4-5-20251001" | (string & {});
export type AttemptIdx   = 1 | 2 | 3;

export type ISO8601      = string;
export type Sha256Hex    = string;
export type CostUSD      = number;

export interface TokenUsage {
  input_tokens:                number;
  output_tokens:               number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens:     number;
}

export interface Cost {
  total_usd:          CostUSD;
  input_usd:          CostUSD;
  output_usd:         CostUSD;
  cache_creation_usd: CostUSD;
  cache_read_usd:     CostUSD;
}

// ─── Run (contracts.md §10) ─────────────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunConfig {
  strategy:      StrategyName;
  model:         ModelId;
  case_filter?:  CaseId[] | null;
  force?:        boolean;
  cost_cap_usd?: number;
  max_attempts?: AttemptIdx;
  temperature?:  number;
  max_tokens?:   number;
  cache_ttl?:    "5m" | "1h";
}

export interface Run {
  run_id:         RunId;
  status:         RunStatus;
  config:         RunConfig;
  prompt_hash:    Sha256Hex;
  tools_hash:     Sha256Hex;
  schema_hash:    Sha256Hex;
  dataset_hash:   Sha256Hex;
  config_hash:    Sha256Hex;

  started_at:     ISO8601;
  completed_at:   ISO8601 | null;
  cancelled_at:   ISO8601 | null;
  duration_ms:    number | null;

  case_count:     number;
  case_completed: number;
  case_succeeded: number;
  case_failed:    number;
  case_in_flight: number;

  total_usage:    TokenUsage;
  /**
   * Rolled-up cost for the run. Only `total_cost.total_usd` is persisted on
   * `runs` (entities.md §1.5). Per-bucket fields (`input_usd`, etc.) are not
   * stored on that row — `RunRepository` maps them to `0`; sum `attempts` for
   * a real breakdown.
   */
  total_cost:     Cost;

  notes?:         string;
}

// ─── Attempt (contracts.md §4) ──────────────────────────────────────────────

export type AttemptStatus =
  | "queued"
  | "in_flight"
  | "succeeded"
  | "schema_invalid"
  | "grounding_failed"
  | "feedback_retry"
  | "rate_limited"
  | "overloaded"
  | "failed_terminal";

/**
 * `predicted_json` (ClinicalExtraction) and `validation_result` (ValidationResult)
 * shapes are opaque at the repository layer — they are inserted/returned as JSON.
 * Callers that need to inspect their structure should narrow via shared types
 * (once `@test-evals/shared` is introduced).
 */
export interface Attempt {
  /** Wire format version (contracts §4). DB column may advance before shared types do. */
  schema_version:       1;
  attempt_id:           AttemptId;
  run_id:               RunId;
  case_id:              CaseId;
  attempt_idx:          AttemptIdx;
  status:               AttemptStatus;
  strategy:             StrategyName;
  model:                ModelId;
  prompt_hash:          Sha256Hex;
  idempotency_key:      Sha256Hex;
  anthropic_request_id: string | null;

  started_at:           ISO8601;
  completed_at:         ISO8601 | null;
  duration_ms:          number | null;

  predicted_json:       Record<string, unknown> | null;
  raw_response_path:    string | null;
  validation_result:    Record<string, unknown> | null;
  retry_reason:         string | null;

  usage:                TokenUsage;
  cost:                 Cost;
}
