# HEALOSBENCH — System Contracts

> Single source of truth for all types, interfaces, and schemas across backend, LLM layer, evaluator, repositories, UI.
> Companion docs: [idea.md](idea.md ) · [approach.md](approach.md) · [lld.md](lld.md)
>
> Convention: all TypeScript types live in `packages/shared/src`. JSON schemas are derived from Zod via `zod-to-json-schema`.

---

## Table of Contents

1. [Common Primitives](#1-common-primitives)
2. [Core Data Schema — ClinicalExtraction](#2-core-data-schema--clinicalextraction)
3. [Strategy Contract](#3-strategy-contract)
4. [Extraction Contracts](#4-extraction-contracts)
5. [Validation Contracts](#5-validation-contracts)
6. [Retry Feedback Contract](#6-retry-feedback-contract)
7. [Evaluator Contracts](#7-evaluator-contracts)
8. [Scorer Interface](#8-scorer-interface)
9. [LLM Adapter Contract](#9-llm-adapter-contract)
10. [Runner Contracts](#10-runner-contracts)
11. [Repository Contracts](#11-repository-contracts)
12. [Event (SSE) Contracts](#12-event-sse-contracts)
13. [API Contracts](#13-api-contracts)
14. [CLI Contract](#14-cli-contract)
15. [Test Fixtures & Mock Adapter](#15-test-fixtures--mock-adapter)

> Note: Compare service interface is at §13.10.1 (`ICompareService`); evaluator service at §7.3 (`IEvaluatorService`); extractor service at §4 (`IExtractorService`); cache policy at §3.6 (`ICachePolicy`).

---

## 1. Common Primitives

```ts
// packages/shared/src/primitives.ts

export type RunId        = string & { readonly __brand: "RunId" };
export type AttemptId    = string & { readonly __brand: "AttemptId" };
export type CaseId       = string;                 // e.g. "case_001"
export type StrategyName = "zero_shot" | "few_shot" | "cot" | (string & {});
export type ModelId      = "claude-haiku-4-5-20251001" | (string & {});
export type ScorerName   = string;                 // e.g. "medications_set_f1"
export type AttemptIdx   = 1 | 2 | 3;              // canonical retry-budget bound

export type ISO8601      = string;                 // "2026-04-30T22:13:05.123Z"
export type Sha256Hex    = string;                 // 64-char hex
export type CostUSD      = number;                 // 6-decimal precision
export type Score01      = number;                 // ∈ [0, 1]

export interface TokenUsage {
  input_tokens:                 number;
  output_tokens:                number;
  cache_creation_input_tokens:  number;
  cache_read_input_tokens:      number;
}

export interface Cost {
  total_usd:           CostUSD;
  input_usd:           CostUSD;
  output_usd:          CostUSD;
  cache_creation_usd:  CostUSD;
  cache_read_usd:      CostUSD;
}

export interface Pricing {
  input_per_mtok:           CostUSD;   // $/1M tokens
  output_per_mtok:          CostUSD;
  cache_write_5m_per_mtok:  CostUSD;
  cache_write_1h_per_mtok:  CostUSD;
  cache_read_per_mtok:      CostUSD;
}

export interface Range<T> { min: T; max: T; }

export type Result<T, E = Error> =
  | { ok: true;  value: T }
  | { ok: false; error: E };
```

---

## 2. Core Data Schema — `ClinicalExtraction`

### 2.1 TypeScript / Zod (`packages/shared/src/schema.ts`)

```ts
import { z } from "zod";

export const VitalsSchema = z.object({
  bp:      z.string().regex(/^[0-9]{2,3}\/[0-9]{2,3}$/).nullable(),
  hr:      z.number().int().min(20).max(250).nullable(),
  temp_f:  z.number().min(90).max(110).nullable(),
  spo2:    z.number().int().min(50).max(100).nullable(),
}).strict();
export type Vitals = z.infer<typeof VitalsSchema>;

export const MedicationSchema = z.object({
  name:           z.string().min(1),
  dose:           z.string().nullable(),
  frequency:      z.string().nullable(),
  route:          z.string().nullable(),
  evidence_quote: z.string().min(1).optional(),    // grounding aid; not in gold
}).strict();
export type Medication = z.infer<typeof MedicationSchema>;

export const DiagnosisSchema = z.object({
  description:    z.string().min(1),
  icd10:          z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/).optional(),
  evidence_quote: z.string().min(1).optional(),
}).strict();
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const FollowUpSchema = z.object({
  interval_days: z.number().int().min(0).max(730).nullable(),
  reason:        z.string().nullable(),
}).strict();
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const ClinicalExtractionSchema = z.object({
  chief_complaint: z.string().min(1),
  vitals:          VitalsSchema,
  medications:     z.array(MedicationSchema),
  diagnoses:       z.array(DiagnosisSchema),
  plan:            z.array(z.string().min(1)),
  follow_up:       FollowUpSchema,
}).strict();
export type ClinicalExtraction = z.infer<typeof ClinicalExtractionSchema>;

export type FieldPath =
  | "chief_complaint"
  | "vitals.bp" | "vitals.hr" | "vitals.temp_f" | "vitals.spo2"
  | `medications[${number}].${"name"|"dose"|"frequency"|"route"}`
  | `diagnoses[${number}].${"description"|"icd10"}`
  | `plan[${number}]`
  | "follow_up.interval_days" | "follow_up.reason";
```

### 2.2 JSON Schema (Anthropic tool input)

Auto-derived via `zodToJsonSchema(ClinicalExtractionSchema)`. The version sent to Anthropic's `tools[].input_schema`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"],
  "properties": {
    "chief_complaint": { "type": "string", "minLength": 1 },
    "vitals": {
      "type": "object",
      "additionalProperties": false,
      "required": ["bp", "hr", "temp_f", "spo2"],
      "properties": {
        "bp":     { "type": ["string","null"], "pattern": "^[0-9]{2,3}/[0-9]{2,3}$" },
        "hr":     { "type": ["integer","null"], "minimum": 20, "maximum": 250 },
        "temp_f": { "type": ["number","null"],  "minimum": 90, "maximum": 110 },
        "spo2":   { "type": ["integer","null"], "minimum": 50, "maximum": 100 }
      }
    },
    "medications": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "dose", "frequency", "route"],
        "properties": {
          "name":           { "type": "string", "minLength": 1 },
          "dose":           { "type": ["string","null"] },
          "frequency":      { "type": ["string","null"] },
          "route":          { "type": ["string","null"] },
          "evidence_quote": { "type": "string", "minLength": 1 }
        }
      }
    },
    "diagnoses": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["description"],
        "properties": {
          "description":    { "type": "string", "minLength": 1 },
          "icd10":          { "type": "string", "pattern": "^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$" },
          "evidence_quote": { "type": "string", "minLength": 1 }
        }
      }
    },
    "plan":      { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "follow_up": {
      "type": "object",
      "additionalProperties": false,
      "required": ["interval_days", "reason"],
      "properties": {
        "interval_days": { "type": ["integer","null"], "minimum": 0, "maximum": 730 },
        "reason":        { "type": ["string","null"] }
      }
    }
  }
}
```

### 2.3 Tool definition (sent to Anthropic)

```ts
export const EXTRACT_CLINICAL_TOOL = {
  name: "extract_clinical",
  description:
    "Record the structured clinical findings from the encounter. " +
    "Use ONLY information present in the transcript. " +
    "If a field is not stated, set it to null. " +
    "For each medical field, populate evidence_quote with the verbatim " +
    "transcript span supporting the value.",
  input_schema: clinicalExtractionJsonSchema,
} as const;
```

### 2.4 Dataset / Gold contract

```ts
// packages/shared/src/dataset.ts

export interface Case {
  case_id:     CaseId;
  transcript:  string;
  /** Pre-computed token count of transcript. */
  tokens:      number;
  /** Optional case tags for faceted aggregations (e.g. "ambiguous", "med_heavy"). */
  tags?:       string[];
}

export interface GoldRecord {
  case_id:     CaseId;
  gold:        ClinicalExtraction;
}

export interface DatasetManifest {
  dataset_hash:   Sha256Hex;        // sha256 of canonical JSONL of (case + gold) pairs
  schema_hash:    Sha256Hex;        // sha256 of data/schema.json
  case_count:     number;
  cases:          Case[];
  /** Linkage table — case_id → gold record. Always 1:1 with cases[]. */
  gold:           Record<CaseId, GoldRecord>;
  /** Validation: every case has a matching gold; every gold has a matching case. */
  validate(): { ok: boolean; orphan_cases: CaseId[]; orphan_gold: CaseId[] };
}

export interface ICaseDataset {
  /** Returns the manifest with content-addressed hash. */
  load(): Promise<DatasetManifest>;
  /** Lazy single-case fetch for the trace UI. */
  getCase(id: CaseId): Promise<Case>;
  getGold(id: CaseId): Promise<GoldRecord>;
  /** Optional filter respected by the runner. */
  filter(ids: CaseId[] | null): Promise<Case[]>;
}

export interface IGoldRepository {
  /** Bulk-load all gold; cached after first call. */
  loadAll(): Promise<Record<CaseId, GoldRecord>>;
  get(caseId: CaseId): Promise<GoldRecord>;
  /** Sanity check: gold conforms to ClinicalExtractionSchema. */
  validateGold(): Promise<{ ok: boolean; errors: ValidationError[] }>;
}
```

---

## 3. Strategy Contract

```ts
// packages/llm/src/strategies/_interface.ts

import type { Anthropic } from "@anthropic-ai/sdk";
import type { ValidationFeedback } from "../validation";
import type { Sha256Hex, StrategyName } from "@test-evals/shared";

/**
 * Anthropic content block types we use.
 */
export type ContentBlock =
  | { type: "text"; text: string;
      cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string;
      is_error?: boolean; content: string };

export interface MessagePayload {
  /** Anthropic system prompt blocks (with cache_control breakpoints). */
  system:   ContentBlock[];

  /** Tool definitions; tool_use is forced via tool_choice. */
  tools: Array<{
    name: string;
    description: string;
    input_schema: object;
    cache_control?: { type: "ephemeral"; ttl: "5m" | "1h" };
  }>;

  /** Conversation messages (user/assistant turns + retry feedback). */
  messages: Array<{ role: "user" | "assistant"; content: ContentBlock[] }>;

  /** Forced single-tool execution (always set for extraction). */
  tool_choice: { type: "tool"; name: string };

  /** Sampling params — pinned per strategy for reproducibility. */
  temperature: number;
  max_tokens:  number;
}

export interface StrategyContext {
  transcriptId: string;
  transcript:   string;
  /** Empty on attempt 1; populated on retries 2+. */
  prevFeedback: ValidationFeedback | null;
  /** Strategy may consume this to vary prompt; should NOT affect prompt_hash. */
  attemptIdx:   AttemptIdx;
}

export interface IStrategy {
  /** Stable identifier. Used in dropdowns, CLI flag, DB. */
  readonly name: StrategyName;

  /** Human-readable description for the UI. */
  readonly description: string;

  /** Number of LLM call steps this strategy makes per attempt. 1 for single-shot, 2+ for chained. */
  readonly steps: number;

  /**
   * Content hash of the strategy's static prompt assets (template + examples + tool def).
   * Stamped on every result row. Changes when ANY character of the rendered prompt changes.
   */
  promptHash(): Sha256Hex;

  /** Build the message payload for one LLM call. */
  buildMessages(ctx: StrategyContext): MessagePayload;

  /**
   * For multi-step strategies (e.g. CoVe extract→verify), called between LLM calls.
   * Default impl returns input unchanged for single-step strategies.
   */
  intermediateStep?(stepIdx: number, intermediate: unknown): MessagePayload | null;

  /**
   * Final assembly hook — combines outputs of all steps into a single ClinicalExtraction.
   * Default impl returns the last step's tool_use input.
   */
  finalize?(stepOutputs: unknown[]): unknown;
}

/** Registry surface — extension point for adding new strategies. */
export interface IStrategyRegistry {
  get(name: StrategyName): IStrategy;
  list(): readonly IStrategy[];
  register(strategy: IStrategy): void;
}
```

### 3.4 Few-shot example type

```ts
// packages/llm/src/strategies/few-shot.ts

export interface FewShotExample {
  example_id:    string;          // stable, used in prompt_hash via order
  transcript:    string;
  expected:      ClinicalExtraction;
  /** Optional: tag the kind of case this exemplifies. */
  archetype?:    "clean_visit" | "ambiguous" | "med_change" | (string & {});
}

export interface FewShotConfig {
  k:               number;        // 3–5 per Anthropic guidance
  examples:        FewShotExample[];
  /** If true, examples are placed inside the cached strategy suffix. */
  cache_examples:  boolean;
}
```

### 3.5 Prompt builder + cache strategy

```ts
// packages/llm/src/prompt-builder.ts

export type CacheBreakpoint = { ttl: "5m" | "1h" };

export interface CacheConfig {
  /** Min total prefix tokens to enable caching (Haiku 4.5: 4096). */
  min_prefix_tokens:    number;
  /** Hint for default TTL on shared prefix. */
  shared_prefix_ttl:    "5m" | "1h";
  /** Hint for default TTL on strategy suffix. */
  strategy_suffix_ttl:  "5m" | "1h";
  /** If padding is needed to clear min_prefix_tokens, this glossary is appended. */
  reference_glossary?:  string;
}

export interface IPromptBuilder {
  withTools(tools: MessagePayload["tools"], bp?: CacheBreakpoint): IPromptBuilder;
  withSystemPrompt(body: string, glossary?: string, bp?: CacheBreakpoint): IPromptBuilder;
  withStrategySuffix(suffix: ContentBlock[], bp?: CacheBreakpoint): IPromptBuilder;
  withTranscript(transcript: string): IPromptBuilder;
  withFeedback(fb: ValidationFeedback): IPromptBuilder;
  withSampling(temperature: number, max_tokens: number): IPromptBuilder;
  build(): MessagePayload;
}
```

### 3.6 Cache policy abstraction

```ts
// packages/llm/src/cache-policy.ts

export interface CacheVerification {
  /** Pulled from Anthropic response usage block. */
  cache_creation_input_tokens: number;
  cache_read_input_tokens:     number;
  /** True if cache_read_input_tokens > 0 — required by hard requirement #3. */
  cache_hit:                   boolean;
  /** True if min_prefix_tokens threshold was satisfied for this request. */
  threshold_cleared:           boolean;
  /** Aggregate efficiency for the run (0..1) — surfaced in run summary. */
  efficiency_ratio:            Score01;
}

export interface ICachePolicy {
  /** Decide where breakpoints land for a given strategy + request. */
  decideBreakpoints(
    payload: MessagePayload,
    config: CacheConfig
  ): MessagePayload;

  /** Pre-warm shared prefix before fanning out cases. */
  prewarm(
    adapter: ILLMAdapter,
    payload: MessagePayload
  ): Promise<{ warmed: boolean; reason?: string }>;

  /** Post-call introspection — populates run summary cache stats. */
  verify(events: ExtractEvent[]): CacheVerification;

  /** Aggregate verification across all attempts of a run. */
  aggregateRun(perAttempt: CacheVerification[]): {
    total_cache_read_tokens:     number;
    total_cache_creation_tokens: number;
    overall_efficiency_ratio:    Score01;
    cache_hit_rate:              Score01;
  };
}
```

---

## 4. Extraction Contracts

```ts
// packages/shared/src/extraction.ts

import type {
  RunId, AttemptId, CaseId, StrategyName, ModelId,
  ISO8601, Sha256Hex, TokenUsage, Cost, Result,
} from "./primitives";
import type { ClinicalExtraction } from "./schema";
import type { ValidationResult } from "./validation";

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

export interface Attempt {
  schema_version:            1;                      // wire-format version
  attempt_id:                AttemptId;
  run_id:                    RunId;
  case_id:                   CaseId;
  attempt_idx:               AttemptIdx;
  status:                    AttemptStatus;
  strategy:                  StrategyName;
  model:                     ModelId;
  prompt_hash:               Sha256Hex;
  idempotency_key:           Sha256Hex;
  anthropic_request_id:      string | null;          // audit only

  started_at:                ISO8601;
  completed_at:              ISO8601 | null;
  duration_ms:               number | null;

  predicted_json:            ClinicalExtraction | null;
  raw_response_path:         string | null;          // disk path to JSONL trace
  validation_result:         ValidationResult | null;
  retry_reason:              string | null;

  usage:                     TokenUsage;
  cost:                      Cost;
}

/** Granular per-case terminal status — finer than AttemptStatus (which is per-attempt). */
export type FinalStatus =
  | "succeeded"
  | "failed_schema_unrecoverable"      // 3 attempts, all schema_invalid
  | "failed_grounding_unrecoverable"   // 3 attempts, all grounding_failed
  | "failed_mixed"                     // mixed failures across attempts
  | "failed_rate_limited"              // exhausted 429 retry budget
  | "failed_overloaded"                // exhausted 529 retry budget
  | "failed_auth"                      // non-retryable auth error
  | "failed_request_too_large"
  | "failed_timeout"
  | "cancelled"                        // user cancelled mid-attempt
  | "cost_cap_exceeded";               // guardrail aborted

export interface ExtractionResult {
  case_id:           CaseId;
  attempts:          Attempt[];                       // chronological, length 1..3
  final_status:      FinalStatus;
  final_output:      ClinicalExtraction | null;
  total_usage:       TokenUsage;
  total_cost:        Cost;
  total_duration_ms: number;
  /** Why the loop terminated, in plain text — for the trace UI. */
  termination_reason: string;
}

export type ExtractError =
  | { kind: "rate_limited";       retry_after_ms: number }
  | { kind: "overloaded";         attempts: number }
  | { kind: "schema_unrecoverable"; lastErrors: ValidationResult["errors"] }
  | { kind: "request_too_large";  bytes: number }
  | { kind: "auth_error" }
  | { kind: "unknown";            cause: string };

export type ExtractionOutcome = Result<ExtractionResult, ExtractError>;

// ─────────────────────────────────────────────────────────────────────────
// Extractor service interface

export interface ExtractInput {
  run_id:        RunId;
  case_id:       CaseId;
  transcript:    string;
  strategy_name: StrategyName;
  /** Override per-run defaults. */
  max_attempts?: AttemptIdx;
  trace_id?:     string;
}

export interface IExtractorService {
  /** Runs the retry-with-feedback loop end-to-end for one case. */
  extract(input: ExtractInput): Promise<ExtractionResult>;

  /** For partial-retry stretch goal — re-extract only specified fields. */
  extractFields?(
    input: ExtractInput,
    fields: Array<FieldPath | string>
  ): Promise<ExtractionResult>;
}
```

---

## 5. Validation Contracts

```ts
// packages/shared/src/validation.ts

import type { FieldPath } from "./schema";

export type ValidationErrorKind =
  | "schema_required_missing"
  | "schema_type_mismatch"
  | "schema_pattern_violation"
  | "schema_enum_violation"
  | "schema_additional_property"
  | "schema_range_violation"
  | "grounding_substring_miss"
  | "grounding_fuzzy_miss"
  | "grounding_quote_not_found"
  | "enum_value_invalid"
  | "custom_rule_violation";

export interface ValidationError {
  kind:        ValidationErrorKind;
  field_path:  FieldPath | string;       // e.g. "medications[0].dose"
  message:     string;                   // human-readable
  hint:        string | null;            // actionable guidance to send back to LLM
  expected?:   unknown;                  // for schema errors — what was expected
  actual?:     unknown;                  // what the model produced
  evidence?: {                           // for grounding failures
    candidate_value:    string;
    closest_transcript: string | null;
    similarity:         number;          // ∈ [0,1]
  };
}

export interface ValidationResult {
  ok:                  boolean;
  errors:              ValidationError[];
  schema_invalid:      boolean;
  grounding_failed:    boolean;
  hallucination_count: number;
  validators_run:      string[];         // names of validators executed
  duration_ms:         number;
}

export interface IValidator {
  readonly name: string;
  validate(
    predicted: unknown,
    transcript: string,
  ): ValidationResult | Promise<ValidationResult>;
}

export interface IValidatorChain {
  validate(predicted: unknown, transcript: string): Promise<ValidationResult>;
  with(validator: IValidator): IValidatorChain;       // builder for composition
}
```

### 5.5 Grounding detector (hallucination detection contract)

```ts
// packages/shared/src/validation.ts — APPEND

export interface GroundingConfig {
  /** Lowercase + strip whitespace before any matching. */
  normalize:        boolean;
  /** Token-set ratio threshold for fuzzy match. Default: 0.80. */
  fuzzy_threshold:  number;
  /** Token window radius around candidate match. Default: 20. */
  window_tokens:    number;
  /** Field paths to skip grounding on (e.g. derived values). */
  skip_field_paths: string[];
}

export interface IGroundingDetector extends IValidator {
  readonly name: "grounding_substring_fuzzy";
  readonly config: GroundingConfig;
  /** Per-field grounding result for trace + scoring. */
  detect(predicted: ClinicalExtraction, transcript: string): Promise<{
    flagged: Array<{
      field_path:        string;
      candidate_value:   string;
      best_similarity:   number;
      best_match_window: string | null;
    }>;
    grounded_field_count:   number;
    total_field_count:      number;
  }>;
}
```

### 5.6 Validator chain composition

```ts
// packages/shared/src/validation.ts — APPEND

export interface ValidatorChainConfig {
  validators: Array<
    | { kind: "schema" }
    | { kind: "grounding"; config: GroundingConfig }
    | { kind: "enum_membership" }
    | { kind: "custom"; name: string }
  >;
  /** Fail-fast on first error class, vs run-all and collect. Default: fail-fast. */
  short_circuit: boolean;
}

export interface IValidatorChainBuilder {
  fromConfig(cfg: ValidatorChainConfig): IValidatorChain;
}
```

---

## 6. Retry Feedback Contract

```ts
// packages/shared/src/feedback.ts

import type { ValidationError } from "./validation";

/**
 * Structured payload encoded into a tool_result block (is_error: true)
 * and sent back to the LLM as the next user turn.
 *
 * The LLM has been trained on this shape; it should produce a corrected
 * extract_clinical tool call on the next response.
 */
export interface ValidationFeedback {
  attempt_idx:       AttemptIdx;         // which attempt we're requesting now
  prior_tool_use_id: string;             // the id of the previous tool_use block
  errors:            FeedbackError[];
  hint:              string;             // top-level summary nudge
}

export interface FeedbackError {
  error_type:  ValidationError["kind"];
  field:       string;                   // e.g. "medications[0].dose"
  message:     string;                   // what's wrong
  hint:        string;                   // how to fix
}

/**
 * Wire format embedded inside the tool_result content (JSON-stringified).
 */
export interface FeedbackWireFormat {
  schema_version: 1;
  feedback:       ValidationFeedback;
}
```

Construction example:

```ts
export function buildFeedbackTurn(fb: ValidationFeedback): {
  role: "user";
  content: Array<{
    type: "tool_result";
    tool_use_id: string;
    is_error: true;
    content: string;
  }>;
} {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: fb.prior_tool_use_id,
      is_error: true,
      content: JSON.stringify({ schema_version: 1, feedback: fb }),
    }],
  };
}
```

---

## 7. Evaluator Contracts

```ts
// packages/shared/src/evaluation.ts

import type { AttemptId, CaseId, RunId, Score01, ScorerName } from "./primitives";
import type { ClinicalExtraction, FieldPath } from "./schema";

export type ScoreCategory =
  | "exact"
  | "fuzzy"
  | "tolerant"
  | "set_f1"
  | "grounding"
  | "schema";

export interface ScoreResult {
  scorer_name:    ScorerName;
  scorer_version: number;                // bump on rubric change
  category:       ScoreCategory;
  field_path:     FieldPath | string;    // "medications" for set-level scorers
  value:          Score01;
  weight:         number;                // for aggregation
  metadata?: {
    precision?:    Score01;
    recall?:       Score01;
    tp?: number; fp?: number; fn?: number;
    partial_credit_count?: number;
    expected?:     unknown;
    actual?:       unknown;
  };
}

export interface FieldAggregate {
  field_path:    FieldPath | string;
  primary_score: Score01;                // headline number for this field
  precision?:    Score01;
  recall?:       Score01;
  f1?:           Score01;
  scorer_results: ScoreResult[];         // raw scorer outputs for drill-down
}

export interface EvaluationResult {
  schema_version:       1;                // wire-format version
  attempt_id:           AttemptId;
  case_id:              CaseId;
  run_id:               RunId;

  field_aggregates:     FieldAggregate[];
  weighted_aggregate:   Score01;         // headline F1 over all fields
  unweighted_aggregate: Score01;

  schema_invalid:       boolean;
  hallucination_count:  number;
  grounded_field_rate:  Score01;

  duration_ms:          number;
}

export interface RunAggregate {
  run_id:               RunId;
  case_count:           number;
  case_completed:       number;
  case_succeeded:       number;
  case_failed_terminal: number;

  weighted_aggregate:   Score01;
  per_field:            FieldAggregate[];

  schema_invalid_rate:  Score01;
  hallucination_rate:   Score01;
  retry_rate:           Score01;         // attempts beyond #1 / total cases

  bootstrap_ci?: {
    lower_95: Score01;
    upper_95: Score01;
    samples:  number;
  };
}
```

### 7.1 Bootstrap CI

```ts
// packages/shared/src/evaluation.ts — APPEND

export interface IBootstrapCi {
  /**
   * Compute 95% bootstrap CI on the difference of weighted aggregates
   * between two runs over their per-case scores.
   */
  compute(
    casesA: Array<{ case_id: CaseId; score: Score01 }>,
    casesB: Array<{ case_id: CaseId; score: Score01 }>,
    opts?: { samples?: number; alpha?: number; seed?: number }
  ): Promise<{
    delta_mean:  number;
    lower_95:    number;
    upper_95:    number;
    samples:     number;
    significant: boolean;     // true if CI excludes 0
  }>;
}
```

### 7.2 Tag / faceted aggregation

```ts
// packages/shared/src/evaluation.ts — APPEND

export type TagFacet = string;     // e.g. "ambiguous", "med_heavy", "no_vitals"

export interface TaggedAggregate {
  tag:                  TagFacet;
  case_count:           number;
  weighted_aggregate:   Score01;
  per_field:            FieldAggregate[];
}

/** Non-breaking extension of RunAggregate with optional facets. */
export interface RunAggregateWithFacets extends RunAggregate {
  by_tag?: TaggedAggregate[];
}
```

### 7.3 Evaluator service

```ts
// packages/shared/src/evaluation.ts — APPEND

export interface EvaluationInput {
  run_id:        RunId;
  attempt_id:    AttemptId;
  case_id:       CaseId;
  predicted:     ClinicalExtraction;     // post-validation, schema-valid
  gold:          ClinicalExtraction;
  transcript:    string;
  schema_invalid: boolean;               // carried through from validation
  hallucination_count: number;           // from grounding detector
  tags?:         string[];               // case-level tags for facet aggregation
}

export interface IEvaluatorService {
  /** Run all applicable scorers over a single (predicted, gold, transcript) tuple. */
  scoreCase(input: EvaluationInput): Promise<EvaluationResult>;

  /** Aggregate per-case results into RunAggregate (called on run_completed). */
  aggregateRun(runId: RunId): Promise<RunAggregateWithFacets>;

  /** Recompute aggregates without re-scoring (e.g. after rubric version bump). */
  rebuildAggregates(runId: RunId): Promise<RunAggregateWithFacets>;
}
```

---

## 8. Scorer Interface

```ts
// packages/shared/src/scorers/_interface.ts

import type { ClinicalExtraction, FieldPath } from "../schema";
import type { ScoreCategory, ScoreResult } from "../evaluation";

export interface ScorerContext {
  predicted:  unknown;                   // model output (post-validation may be partial)
  gold:       ClinicalExtraction;
  transcript: string;
  /** Optional: pre-computed grounding signal so scorers can fold it in. */
  grounding?: {
    flagged:              Array<{ field_path: string; best_similarity: number }>;
    grounded_field_count: number;
    total_field_count:    number;
  };
}

export interface IScorer {
  readonly name:     string;
  readonly version:  number;
  readonly category: ScoreCategory;
  readonly applies_to_field: FieldPath | string;
  readonly weight:   number;             // default aggregation weight

  score(ctx: ScorerContext): ScoreResult | Promise<ScoreResult>;
}

export interface IScorerRegistry {
  get(name: string): IScorer;
  forField(fieldPath: string): IScorer[];
  list(): readonly IScorer[];
  register(scorer: IScorer): void;
}

/** Field-specific scorer name conventions used in the registry. */
export type CanonicalScorerName =
  | "chief_complaint_fuzzy"
  | "vitals_bp_exact"
  | "vitals_hr_tolerant"
  | "vitals_temp_tolerant"
  | "vitals_spo2_tolerant"
  | "medications_set_f1_strict"
  | "medications_set_f1_partial"
  | "diagnoses_set_f1"
  | "diagnoses_icd_partial_credit"
  | "plan_set_f1"
  | "follow_up_interval_exact"
  | "follow_up_reason_fuzzy"
  | "grounding_substring"
  | "grounding_fuzzy_window"
  | "schema_validity";
```

---

## 9. LLM Adapter Contract

```ts
// packages/llm/src/adapters/_interface.ts

import type {
  ModelId, Sha256Hex, TokenUsage, Cost, ISO8601,
} from "@test-evals/shared";
import type { MessagePayload } from "../strategies/_interface";

export interface ExtractRequest {
  model:           ModelId;
  payload:         MessagePayload;
  /** Used to short-circuit on resume; must include attempt_idx. */
  idempotency_key: Sha256Hex;
  /** Required for tracing + idempotency repository lookups. */
  run_id:          RunId;
  case_id:         CaseId;
  attempt_idx:     AttemptIdx;
  /** Per-request override; defaults from RunConfig. */
  timeout_ms?:     number;
  /** Anthropic metadata.user_id for log correlation. */
  trace_id?:       string;
}

export type ExtractEvent =
  | { type: "request_started";  ts: ISO8601 }
  | { type: "cache_status";     cache_creation_input_tokens: number;
                                cache_read_input_tokens: number }
  | { type: "thinking_delta";   text: string }                // manual <thinking>
  | { type: "tool_use_started"; tool_use_id: string; tool_name: string }
  | { type: "tool_input_delta"; partial_json: string }
  | { type: "tool_use_completed"; tool_use_id: string; input: unknown }
  | { type: "rate_limit_headers";
        requests_remaining: number;
        input_tokens_remaining: number;
        output_tokens_remaining: number;
        reset_at: ISO8601 }
  | { type: "error";            error_kind: ExtractErrorKind;
                                retry_after_ms?: number; message: string }
  | { type: "completed";        usage: TokenUsage; cost: Cost;
                                anthropic_request_id: string;
                                stop_reason: "tool_use" | "end_turn" | "max_tokens" |
                                             "stop_sequence" | "refusal" };

export type ExtractErrorKind =
  | "rate_limit_429"
  | "overloaded_529"
  | "server_5xx"
  | "request_too_large_413"
  | "auth_401_403"
  | "bad_request_400"
  | "timeout"
  | "network";

export interface ILLMAdapter {
  /** Stable identifier — `"anthropic"`, `"anthropic+caching+rate-limited+idempotency"`, etc. */
  readonly id: string;

  /** Returns an async iterable of streaming events. Throws only on unrecoverable terminal errors. */
  extract(req: ExtractRequest): AsyncIterable<ExtractEvent>;

  /** Cheap pre-flight for cost guardrail. */
  countTokens(payload: MessagePayload): Promise<{
    input_tokens: number;
    cached_input_tokens_estimate: number;
  }>;
}

/** Decorator base — for layering caching/rate-limit/idempotency etc. */
export interface IDecoratedAdapter extends ILLMAdapter {
  readonly inner: ILLMAdapter;
}
```

### 9.1 Adapter composition (decorator stack)

```ts
// packages/llm/src/adapters/composition.ts

export interface AdapterStackConfig {
  caching:      { enabled: boolean; cache_ttl: "5m" | "1h" };
  rate_limited: { enabled: boolean; settings: RunnerSettings };
  retrying:     { enabled: boolean; max_attempts: number };   // for 429/529/5xx
  tracing:      { enabled: boolean; trace_repo: ITraceRepository };
  idempotency:  { enabled: boolean; attempt_repo: IAttemptRepository };
}

export interface IAdapterFactory {
  /**
   * Build the decorator chain (innermost = real Anthropic).
   * Order: Idempotency → Tracing → Retrying → RateLimited → Caching → caller.
   */
  build(base: ILLMAdapter, cfg: AdapterStackConfig): ILLMAdapter;
}
```

---

## 10. Runner Contracts

```ts
// packages/shared/src/runner.ts

import type {
  RunId, CaseId, StrategyName, ModelId, ISO8601, Sha256Hex,
  TokenUsage, Cost,
} from "./primitives";

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunConfig {
  strategy:        StrategyName;
  model:           ModelId;
  /** Subset of cases; null/undefined = full dataset. */
  case_filter?:    CaseId[] | null;
  /** If false, idempotency cache may serve a previous matching attempt. */
  force?:          boolean;
  /** Aborts run early if projected cost > cap. */
  cost_cap_usd?:   number;
  /** Max attempts per case (validation-feedback budget). */
  max_attempts?:   AttemptIdx;
  /** Sampling. */
  temperature?:    number;
  max_tokens?:     number;
  /** Cache TTL hint to the LLM adapter. */
  cache_ttl?:      "5m" | "1h";
}

export interface RunnerSettings {
  /** Concurrency cap (in-flight cases). Default: 5. */
  max_concurrent:           number;
  /** Initial concurrency at start of run; ramps to max_concurrent. Default: 2. */
  ramp_initial_concurrent:  number;
  /** Ramp duration in ms. Default: 30_000. */
  ramp_duration_ms:         number;
  /** Min ms between dispatches (RPM cap). Default: 1200 (50 RPM). */
  min_dispatch_interval_ms: number;
  /** Bottleneck reservoir (RPM). Default: 50. */
  reservoir_per_minute:     number;
  /** Heartbeat threshold — in_flight rows older than this are re-queued on resume. */
  heartbeat_stale_ms:       number;
}

export interface Run {
  run_id:          RunId;
  status:          RunStatus;
  config:          RunConfig;
  prompt_hash:     Sha256Hex;
  tools_hash:      Sha256Hex;       // used in config_hash derivation
  schema_hash:     Sha256Hex;
  dataset_hash:    Sha256Hex;
  config_hash:     Sha256Hex;       // denormalized for fast idempotency lookup

  started_at:      ISO8601;
  completed_at:    ISO8601 | null;
  cancelled_at:    ISO8601 | null;
  duration_ms:     number | null;

  case_count:      number;
  case_completed:  number;
  case_succeeded:  number;          // for runs-list aggregate
  case_failed:     number;
  case_in_flight:  number;          // derived: count - completed - failed

  total_usage:     TokenUsage;
  total_cost:      Cost;

  notes?:          string;
}

export interface IRunnerService {
  start(config: RunConfig): Promise<{ run_id: RunId }>;
  resume(runId: RunId): Promise<{ resumed_attempts: number }>;
  cancel(runId: RunId): Promise<void>;
  getStatus(runId: RunId): Promise<Run>;
}
```

**Concurrency assumptions** (encoded in `RunnerSettings` defaults):
- Tier-1 Haiku 4.5: `50 RPM / 50,000 ITPM / 10,000 OTPM`.
- Bottleneck: `maxConcurrent: 5`, `minTime: 1200ms`, `reservoir: 50` refilled every `60_000ms`.
- Ramp-up: `2 → 5` over `30s` to avoid acceleration-limit 429s.
- Adaptive throttle: after each response, read `anthropic-ratelimit-*` headers and clamp the next dispatch.

### 10.1 Cost guardrail

```ts
// packages/shared/src/cost-guardrail.ts

export interface CostProjection {
  cases:                       number;
  est_input_tokens_per_case:   number;
  est_output_tokens_per_case:  number;
  est_cache_read_per_case:     number;
  est_cache_creation_per_run:  number;
  projected_cost_usd:          CostUSD;
  pricing:                     Pricing;
}

export interface ICostGuardrail {
  project(cfg: RunConfig, manifest: DatasetManifest): Promise<CostProjection>;
  /** Hard reject before run starts if projection > cap. */
  enforcePreRun(cap: CostUSD, projection: CostProjection): void;
  /** Soft check during run; aborts if running total > cap. */
  enforceMidRun(cap: CostUSD, runningTotal: CostUSD): void;
}
```

### 10.2 Resume plan

```ts
// packages/shared/src/runner.ts — APPEND

export interface ResumePlan {
  run_id:               RunId;
  /** Attempts left in flight beyond heartbeat — re-queued with same key. */
  stale_in_flight:      AttemptId[];
  /** Cases never enqueued (newly added or skipped). */
  unstarted_cases:      CaseId[];
  /** Cases where attempt_idx === max_attempts but status !== succeeded. */
  terminal_failures:    CaseId[];
  estimated_cost_remaining_usd: CostUSD;
}

export interface IResumeService {
  plan(runId: RunId, settings: RunnerSettings): Promise<ResumePlan>;
  execute(plan: ResumePlan): Promise<{ resumed_attempts: number }>;
}
```

---

## 11. Repository Contracts

```ts
// packages/db/src/repositories/_interface.ts

import type {
  RunId, AttemptId, CaseId, ISO8601, Sha256Hex,
} from "@test-evals/shared";
import type { Run } from "@test-evals/shared/runner";
import type { Attempt } from "@test-evals/shared/extraction";
import type { ScoreResult } from "@test-evals/shared/evaluation";

export interface IRepository<T, ID> {
  findById(id: ID): Promise<T | null>;
  exists(id: ID):   Promise<boolean>;
}

export interface IRunRepository extends IRepository<Run, RunId> {
  create(input: Omit<Run, "run_id"> & { run_id?: RunId }): Promise<Run>;
  list(filter?: {
    status?: Run["status"];
    strategy?: string;
    model?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ runs: Run[]; next_cursor: string | null }>;
  updateStatus(runId: RunId, status: Run["status"]): Promise<void>;
  updateAggregates(runId: RunId, patch: Partial<Run>): Promise<void>;

  /** Idempotency at run level: same inputs → same run_id unless force=true. */
  findByConfigHash(hash: Sha256Hex): Promise<Run | null>;
}

export interface IAttemptRepository extends IRepository<Attempt, AttemptId> {
  create(attempt: Attempt): Promise<void>;
  update(attemptId: AttemptId, patch: Partial<Attempt>): Promise<void>;

  listForRun(runId: RunId): Promise<Attempt[]>;
  listForCase(runId: RunId, caseId: CaseId): Promise<Attempt[]>;

  /** Resume support — attempts left in flight beyond heartbeat. */
  findStaleInFlight(runId: RunId, olderThan: ISO8601): Promise<Attempt[]>;

  /** Idempotency at attempt level. */
  findByIdempotencyKey(key: Sha256Hex): Promise<Attempt | null>;

  /** For runs page aggregates without scanning scores. */
  countByStatus(runId: RunId): Promise<Record<Attempt["status"], number>>;
}

/** ScoreResult joined with the attempt it belongs to (write-time shape). */
export type AttachedScore = ScoreResult & { attempt_id: AttemptId };

export interface IScoreRepository {
  createMany(scores: AttachedScore[]): Promise<void>;
  listForAttempt(attemptId: AttemptId): Promise<ScoreResult[]>;
  listForRun(runId: RunId): Promise<Map<AttemptId, ScoreResult[]>>;

  /** Compare-view helper. */
  aggregateByField(runId: RunId): Promise<Array<{
    field_path: string;
    mean_score: number;
    precision?: number;
    recall?: number;
    f1?: number;
    sample_size: number;
  }>>;
}

export interface ITraceRepository {
  append(events: TraceEvent[]): Promise<void>;
  listForAttempt(attemptId: AttemptId): Promise<TraceEvent[]>;
  /** Streaming reader for the trace UI. */
  stream(attemptId: AttemptId): AsyncIterable<TraceEvent>;
}

/** Per-(run, case) eval row — written on case-final regardless of outcome. */
export interface EvaluationRow {
  evaluation_id:        string;
  run_id:               RunId;
  case_id:              CaseId;
  attempt_id:           AttemptId;            // case-final attempt
  final_status:         FinalStatus;          // from extraction outcome
  termination_reason:   string | null;
  weighted_aggregate:   Score01 | null;       // NULL on failure
  unweighted_aggregate: Score01 | null;       // NULL on failure
  schema_invalid:       boolean;
  hallucination_count:  number;
  grounded_field_rate:  Score01 | null;       // NULL on failure
  duration_ms:          number;
  schema_version:       1;
  created_at:           ISO8601;
}

export interface IEvaluationRepository {
  /**
   * Upsert the case-final row. Called from two paths:
   *   - Success: by EvaluatorService after scoring (full row with scores).
   *   - Failure: by RunnerService for terminal-failure cases (stub row,
   *     weighted_aggregate = null, final_status carries the reason).
   * ON CONFLICT (run_id, case_id) DO UPDATE so rebuilds are safe.
   */
  upsert(row: Omit<EvaluationRow, "evaluation_id" | "created_at">): Promise<EvaluationRow>;

  findByCase(runId: RunId, caseId: CaseId): Promise<EvaluationRow | null>;
  listForRun(runId: RunId): Promise<EvaluationRow[]>;

  /** Compare-view bucketing: improved / regressed / unchanged across two runs. */
  caseDeltas(runA: RunId, runB: RunId): Promise<Array<{
    case_id:       CaseId;
    a_score:       Score01 | null;
    b_score:       Score01 | null;
    a_status:      FinalStatus;
    b_status:      FinalStatus;
    delta:         number;       // 0-default if either side is null
  }>>;

  /** Compare-view "where did B regress?" — failure-mode breakdown. */
  failureBreakdown(runIds: RunId[]): Promise<Map<RunId, Record<FinalStatus, number>>>;
}

export interface TraceEvent {
  trace_id:     string;
  attempt_id:   AttemptId;
  event_idx:    number;
  event_type:
    | "request_sent"
    | "sse_delta"
    | "tool_use_assembled"
    | "schema_validation"
    | "grounding_validation"
    | "feedback_sent"
    | "scoring"
    | "persisted"
    | "error";
  payload:      unknown;
  ts:           ISO8601;
}
```

---

## 12. Event (SSE) Contracts

```ts
// packages/shared/src/events.ts

import type {
  RunId, AttemptId, AttemptIdx, CaseId, StrategyName, ISO8601,
  TokenUsage, Cost, Score01,
} from "./primitives";
import type { AttemptStatus, FinalStatus } from "./extraction";
import type { ValidationError } from "./validation";
import type { FieldAggregate } from "./evaluation";

export type SseEventType =
  | "run_started"
  | "attempt_started"
  | "attempt_completed"
  | "validation_failed"
  | "case_scored"
  | "run_progress"
  | "run_completed"
  | "run_failed"
  | "heartbeat";

interface BaseEvent {
  schema_version: 1;
  event_id:       string;            // monotonic UUIDv7 — for client dedup on reconnect
  run_id:         RunId;
  ts:             ISO8601;
}

export interface RunStartedEvent extends BaseEvent {
  type:           "run_started";
  strategy:       StrategyName;
  case_count:     number;
}

export interface AttemptStartedEvent extends BaseEvent {
  type:           "attempt_started";
  case_id:        CaseId;
  attempt_id:     AttemptId;
  attempt_idx:    AttemptIdx;
}

export interface AttemptCompletedEvent extends BaseEvent {
  type:           "attempt_completed";
  case_id:        CaseId;
  attempt_id:     AttemptId;
  attempt_idx:    AttemptIdx;
  /** Subset of AttemptStatus — only attempt-terminal statuses surface here. */
  status: Extract<AttemptStatus,
    "succeeded" | "schema_invalid" | "grounding_failed"
    | "feedback_retry" | "rate_limited" | "overloaded" | "failed_terminal">;
  duration_ms:    number;
  usage:          TokenUsage;
  cost:           Cost;
}

export interface ValidationFailedEvent extends BaseEvent {
  type:           "validation_failed";
  case_id:        CaseId;
  attempt_id:     AttemptId;
  attempt_idx:    AttemptIdx;
  errors:         ValidationError[];
  will_retry:     boolean;
}

export interface CaseScoredEvent extends BaseEvent {
  type:           "case_scored";
  case_id:        CaseId;
  weighted_aggregate:   Score01;
  per_field:            FieldAggregate[];
  hallucination_count:  number;
  schema_invalid:       boolean;
}

export interface RunProgressEvent extends BaseEvent {
  type:                 "run_progress";
  cases_completed:      number;
  cases_total:          number;
  rolling_aggregate:    Score01;
  in_flight:            number;
  estimated_remaining_ms: number;
}

export interface RunCompletedEvent extends BaseEvent {
  type:                 "run_completed";
  weighted_aggregate:   Score01;
  total_usage:          TokenUsage;
  total_cost:           Cost;
  duration_ms:          number;
  schema_invalid_rate:  Score01;
  hallucination_rate:   Score01;
}

export interface RunFailedEvent extends BaseEvent {
  type:    "run_failed";
  reason:  Extract<FinalStatus,
    "cost_cap_exceeded" | "failed_auth" | "cancelled"
  > | "internal_error";
  message: string;
}

export interface HeartbeatEvent extends BaseEvent {
  type:           "heartbeat";
}

export type SseEvent =
  | RunStartedEvent
  | AttemptStartedEvent
  | AttemptCompletedEvent
  | ValidationFailedEvent
  | CaseScoredEvent
  | RunProgressEvent
  | RunCompletedEvent
  | RunFailedEvent
  | HeartbeatEvent;
```

**SSE wire format** (each line per the spec):

```
id: 01JG7M9R6V8YBPW5N4D3FYZQ4K
event: case_scored
data: {"schema_version":1,"event_id":"01JG7M9R6V8YBPW5N4D3FYZQ4K","run_id":"...","ts":"2026-04-30T22:13:05.123Z","type":"case_scored","case_id":"case_007","weighted_aggregate":0.86,"per_field":[...],"hallucination_count":0,"schema_invalid":false}

```

Heartbeat every 15s. Client uses `Last-Event-ID` header for resume on reconnect.

### 12.1 Event bus interface

```ts
// packages/shared/src/event-bus.ts

export interface SseSubscription {
  unsubscribe(): void;
}

export interface IEventBus {
  /** Server-side publish. Persists to traces (write-through) THEN fans out. */
  publish(event: SseEvent): Promise<void>;

  /** Per-run subscription with `Last-Event-ID` resumption. */
  subscribe(
    runId: RunId,
    onEvent: (event: SseEvent) => void,
    opts?: { last_event_id?: string }
  ): SseSubscription;

  /** Replay buffer for reconnects (since `last_event_id`). */
  replay(runId: RunId, sinceEventId: string): AsyncIterable<SseEvent>;
}
```

---

## 13. API Contracts

All endpoints rooted at `/api/v1`. JSON over HTTP unless otherwise noted. Errors follow [RFC 7807 problem+json](https://datatracker.ietf.org/doc/html/rfc7807).

### 13.1 Common error shape

```ts
export interface ApiError {
  type:     string;             // URI reference, e.g. "/errors/not-found"
  title:    string;
  status:   400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  detail:   string;
  instance?: string;            // request ID
  errors?:  Array<{ field: string; message: string }>;   // validation
}
```

### 13.2 `POST /api/v1/runs`

```ts
// Request
export interface CreateRunRequest {
  strategy:      StrategyName;
  model:         ModelId;
  case_filter?:  CaseId[];
  force?:        boolean;
  cost_cap_usd?: number;
  max_attempts?: AttemptIdx;
  temperature?:  number;
  max_tokens?:   number;
  cache_ttl?:    "5m" | "1h";
  notes?:        string;
}

// 202 Accepted
export interface CreateRunResponse {
  run_id:        RunId;
  status:        "queued";
  config_hash:   Sha256Hex;     // for client-side dedup awareness
  cached:        boolean;       // true if a matching prior run was returned (force=false)
  stream_url:    string;        // "/api/v1/runs/{run_id}/stream"
}

// 409 Conflict — when force=false and an identical config is currently running.
```

### 13.3 `GET /api/v1/runs`

```ts
// Query: ?status=...&strategy=...&model=...&limit=...&cursor=...
export interface ListRunsResponse {
  runs:        Run[];
  next_cursor: string | null;
}
```

### 13.4 `GET /api/v1/runs/:run_id`

```ts
// 200 OK
export interface GetRunResponse {
  run:        Run;
  aggregate:  RunAggregate;
}

// 404 if not found
```

### 13.5 `GET /api/v1/runs/:run_id/stream` — SSE

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- Supports `Last-Event-ID` header for resume.
- Closes after `run_completed` / `run_failed`; client should treat that as terminal.

### 13.6 `POST /api/v1/runs/:run_id/resume`

```ts
// Empty body
// 200 OK
export interface ResumeRunResponse {
  run_id:            RunId;
  resumed_attempts:  number;       // count re-queued
  status:            "running";
}

// 409 if run is already in terminal state.
```

### 13.7 `POST /api/v1/runs/:run_id/cancel`

```ts
// 200 OK
export interface CancelRunResponse {
  run_id:        RunId;
  status:        "cancelled";
  cancelled_at:  ISO8601;
}
```

### 13.8 `GET /api/v1/runs/:run_id/cases/:case_id`

```ts
// 200 OK
export interface GetCaseResponse {
  case_id:          CaseId;
  transcript:       string;
  tags:             string[];                // for facet drill-through
  gold:             ClinicalExtraction;
  attempts:         Attempt[];
  scores:           ScoreResult[];
  field_aggregates: FieldAggregate[];
  /** Per-field grounding annotation for transcript-highlight UI. */
  grounding_spans:  Array<{
    field_path: string;
    value:      string;
    span:       { start: number; end: number } | null;
  }>;
}
```

### 13.9 `GET /api/v1/runs/:run_id/cases/:case_id/trace/:attempt_id`

```ts
// 200 OK
export interface GetTraceResponse {
  attempt_id:  AttemptId;
  events:      TraceEvent[];
}
```

### 13.10 `GET /api/v1/compare`

```ts
// Query: ?a=<runId>&b=<runId>&allow_cross_dataset=false&facet=<tag>&ci_samples=<n>
// Backed by ICompareService.compare().
// Returns 422 if preflight().compatible === false (with `reason` in detail).
export interface CompareResponse {
  run_a:                 Run;
  run_b:                 Run;
  /** Hard rejection if dataset_hash differs without `?allow_cross_dataset=true`. */
  dataset_hash_match:    boolean;

  aggregate_delta: {
    weighted: Score01;                    // b - a
    cost:     CostUSD;
    duration_ms: number;
  };

  per_field_delta: Array<{
    field_path:    FieldPath | string;
    a:             Score01;
    b:             Score01;
    delta:         Score01;
    winner:        "a" | "b" | "tie";
    significant:   boolean;               // 95% bootstrap CI excludes 0
  }>;

  case_buckets: {
    improved:   CaseDelta[];
    regressed:  CaseDelta[];
    unchanged:  CaseDelta[];
  };

  hallucination_delta: { a: number; b: number };
  schema_invalid_delta: { a: number; b: number };
}

export interface CaseDelta {
  case_id: CaseId;
  a:       Score01;
  b:       Score01;
  delta:   Score01;
}
```

#### 13.10.1 Compare service (backend)

```ts
// packages/shared/src/compare.ts

export interface CompareInput {
  run_a_id:               RunId;
  run_b_id:               RunId;
  /** Default false — rejected if dataset_hash differs. */
  allow_cross_dataset?:   boolean;
  /** Optional facet filter (only compute for these tags). */
  facet?:                 TagFacet;
  /** Bootstrap config override. */
  ci_samples?:            number;
}

export interface ICompareService {
  /** Validates dataset/schema-hash compatibility, raises if incompatible. */
  preflight(input: CompareInput): Promise<{
    compatible:   boolean;
    reason?:      "dataset_hash_mismatch" | "schema_hash_mismatch"
                  | "case_set_mismatch" | "incomplete_run";
  }>;

  /** Builds the full CompareResponse — same shape as §13.10. */
  compare(input: CompareInput): Promise<CompareResponse>;

  /** Per-case granular diff for the drill-down UI. */
  caseDiff(runA: RunId, runB: RunId, caseId: CaseId): Promise<{
    case_id:         CaseId;
    transcript:      string;
    gold:            ClinicalExtraction;
    predicted_a:     ClinicalExtraction | null;
    predicted_b:     ClinicalExtraction | null;
    field_deltas:    Array<{
      field_path: FieldPath | string;
      a:          Score01;
      b:          Score01;
      delta:      Score01;
    }>;
    attempt_a:       Attempt | null;
    attempt_b:       Attempt | null;
  }>;
}
```

### 13.11 `GET /api/v1/strategies`

```ts
// 200 OK
export interface ListStrategiesResponse {
  strategies: Array<{
    name:        StrategyName;
    description: string;
    steps:       number;
    prompt_hash: Sha256Hex;
  }>;
}
```

### 13.12 `GET /api/v1/scorers`

```ts
// 200 OK
export interface ListScorersResponse {
  scorers: Array<{
    name:         string;
    version:      number;
    category:     ScoreCategory;
    applies_to:   string;
    weight:       number;
  }>;
}
```

### 13.13 `GET /api/v1/health`

```ts
// 200 OK
export interface HealthResponse {
  ok:                boolean;
  uptime_s:          number;
  db:                "up" | "down";
  anthropic_reachable: boolean;
  in_flight_runs:    number;
  in_flight_attempts: number;
}
```

### 13.14 API-key isolation contract

```ts
// apps/server/src/security.ts

/** Compile-time gate: this type may only be imported in apps/server, not apps/web. */
export interface ServerOnlyEnv {
  readonly __server_only: unique symbol;
  ANTHROPIC_API_KEY: string;
  DATABASE_URL:      string;
}

/** Helper enforced via ESLint no-restricted-imports + tsconfig path mapping. */
export interface IServerOnlyAccess {
  /** Throws if invoked from a context tagged as client. */
  getEnv(): ServerOnlyEnv;
}
```

Enforcement (must be in place even though the contract is a type):
- `apps/web/tsconfig.json` excludes `apps/server/**` and `packages/llm/**` from path mapping.
- ESLint rule `no-restricted-imports` blocks `process.env.ANTHROPIC_API_KEY` and any import of `apps/server/src/security.ts` from `apps/web/**`.
- Hard requirement #10: web → Hono → Anthropic only. Never web → Anthropic.

---

## 14. CLI Contract

```ts
// apps/server/src/cli/_args.ts

export interface EvalCliArgs {
  strategy:      StrategyName;
  model?:        ModelId;
  cases?:        CaseId[];          // --cases case_001,case_002
  no_cache?:     boolean;           // --no-cache
  budget_usd?:   number;            // --budget=1.00
  max_attempts?: AttemptIdx;
  resume?:       RunId;             // --resume <run_id>
  output?:       "json" | "table";  // default: table
  json_path?:    string;            // --json-path=results/run_123.json
  quiet?:        boolean;
}

export interface CliSummaryRow {
  strategy:             StrategyName;
  case_count:           number;
  weighted_aggregate:   Score01;
  per_field_f1:         Record<string, Score01>;
  schema_invalid_rate:  Score01;
  hallucination_rate:   Score01;
  total_cost_usd:       CostUSD;
  duration_ms:          number;
}

export interface ICli {
  parse(argv: string[]): EvalCliArgs;
  /** Returns process exit code: 0 success, 1 eval-error, 2 usage-error. */
  run(args: EvalCliArgs): Promise<{ exit_code: 0 | 1 | 2 }>;
  /** Prints the summary table to stdout (used in CI). */
  printSummary(runIds: RunId[]): Promise<CliSummaryRow[]>;
}
```

CLI entry point: `bun run eval -- --strategy=cot --model=claude-haiku-4-5-20251001`. A 3-strategy summary run uses `bun run eval -- --strategy=zero_shot,few_shot,cot` and prints one row per strategy.

---

## 15. Test Fixtures & Mock Adapter

### 15.1 Mock LLM adapter

```ts
// packages/llm/src/adapters/mock.ts

export interface MockResponseScript {
  /** Ordered list of canned responses; consumed in call order. */
  responses: Array<
    | { kind: "tool_use"; input: unknown;
        usage?: Partial<TokenUsage>; cost?: Partial<Cost> }
    | { kind: "schema_invalid"; raw: unknown }      // returns shape that fails validation
    | { kind: "rate_limit_429"; retry_after_ms: number }
    | { kind: "overloaded_529" }
    | { kind: "server_5xx"; status: 500 | 502 | 503 | 504 }
    | { kind: "timeout" }
  >;
}

export interface IMockLLMAdapter extends ILLMAdapter {
  readonly id: "mock";
  /** Set up the canned-response script for a test run. */
  script(s: MockResponseScript): void;
  /** Records every request the SUT made — for assertion. */
  readonly observed: ExtractRequest[];
  reset(): void;
}
```

### 15.2 Test fixture set

```ts
// packages/shared/src/test-fixtures.ts

/** Fixture set used by the 8 required tests. */
export interface TestFixtureSet {
  /** Tiny synthetic dataset for tests 2, 3, 4. */
  tiny_dataset:           DatasetManifest;

  /** Test 2 — fuzzy med matching: BID == twice daily, 10mg == 10 mg. */
  fuzzy_med_pairs:        Array<{ a: Medication; b: Medication; expected_match: boolean }>;

  /** Test 3 — set-F1 correctness on synthetic case. */
  set_f1_cases:           Array<{
    predicted: ClinicalExtraction;
    gold:      ClinicalExtraction;
    expected_f1: { medications: Score01; diagnoses: Score01; plan: Score01 };
  }>;

  /** Test 4 — hallucination detector positive + negative. */
  grounding_positives:    Array<{ predicted: ClinicalExtraction; transcript: string }>;
  grounding_negatives:    Array<{ predicted: ClinicalExtraction; transcript: string }>;

  /** Test 8 — prompt-hash stability: identical inputs → identical hash. */
  prompt_hash_pairs:      Array<{ a: MessagePayload; b: MessagePayload; same_hash: boolean }>;
}
```

### 15.3 Required test scenario coverage

| # | Test | Primary contracts exercised |
| - | --- | --- |
| 1 | Schema-validation retry path | `IMockLLMAdapter.script([schema_invalid, tool_use])` + `IValidatorChain` + `Attempt.attempt_idx` |
| 2 | Fuzzy med matching | `MedicationsSetF1Scorer` + `TestFixtureSet.fuzzy_med_pairs` |
| 3 | Set-F1 correctness | `IScorer` impls + `TestFixtureSet.set_f1_cases` |
| 4 | Hallucination detector ± | `IGroundingDetector` + `TestFixtureSet.grounding_positives/negatives` |
| 5 | Resumability | `IResumeService` + `IAttemptRepository.findStaleInFlight` |
| 6 | Idempotency | `computeIdempotencyKey` + `IAttemptRepository.findByIdempotencyKey` |
| 7 | Rate-limit backoff | `IMockLLMAdapter.script([rate_limit_429])` + `RateLimitedAdapter` |
| 8 | Prompt-hash stability | `computePromptHash` + `TestFixtureSet.prompt_hash_pairs` |

---

## Cross-Cutting Conventions

**Idempotency key construction** (used by `IdempotencyAdapter`):

```ts
import { createHash } from "node:crypto";

export function computeIdempotencyKey(parts: {
  model:         ModelId;
  prompt_hash:   Sha256Hex;
  tools_hash:    Sha256Hex;
  temperature:   number;
  max_tokens:    number;
  case_id:       CaseId;
  attempt_idx:   AttemptIdx;        // canonical 1 | 2 | 3
}): Sha256Hex {
  const canonical = [
    parts.model, parts.prompt_hash, parts.tools_hash,
    parts.temperature.toFixed(6), String(parts.max_tokens),
    parts.case_id, String(parts.attempt_idx),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex") as Sha256Hex;
}
```

**Prompt hash construction** (stable across renderings):

```ts
export function computePromptHash(payload: MessagePayload): Sha256Hex {
  // Strip cache_control + transcript content; canonicalize JSON keys.
  const stable = canonicalizeForHashing(payload);
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex") as Sha256Hex;
}
```

**Hash registry — single source of truth for content addressing:**

```ts
// packages/shared/src/hashing.ts

export interface IHashRegistry {
  /** Stable across renderings; strips cache_control + transcript content. */
  promptHash(payload: MessagePayload): Sha256Hex;
  /** Hash of the rendered tools array (sorted keys, no cache_control). */
  toolsHash(tools: MessagePayload["tools"]): Sha256Hex;
  /** Hash of the JSON Schema (Anthropic input_schema). */
  schemaHash(jsonSchema: object): Sha256Hex;
  /** Hash of the full dataset (canonical JSONL of cases). */
  datasetHash(cases: Case[]): Sha256Hex;
  /** Hash of the resolved RunConfig + all upstream hashes — used for run-level idempotency. */
  configHash(cfg: RunConfig & {
    prompt_hash:  Sha256Hex;
    tools_hash:   Sha256Hex;
    schema_hash:  Sha256Hex;
    dataset_hash: Sha256Hex;
  }): Sha256Hex;
}
```

The `config_hash` field returned by `POST /api/v1/runs` (§13.2) is computed via `IHashRegistry.configHash()`. Two runs with identical `config_hash` are considered equivalent for idempotency unless `force=true`.

**Pricing constants** (Haiku 4.5 — `claude-haiku-4-5-20251001`):

```ts
export const HAIKU_4_5_PRICING: Pricing = {
  input_per_mtok:           1.00,   // $/MTok
  output_per_mtok:          5.00,
  cache_write_5m_per_mtok:  1.25,
  cache_write_1h_per_mtok:  2.00,
  cache_read_per_mtok:      0.10,
};
```

**HTTP status conventions**:

| Code | Use |
| ---- | --- |
| 200  | Successful read |
| 202  | Accepted (run queued) |
| 204  | Successful action with no body (rare) |
| 400  | Bad request (malformed JSON, invalid query) |
| 401  | Unauthenticated |
| 403  | Forbidden |
| 404  | Resource not found |
| 409  | Conflict (duplicate run, cancel of completed run) |
| 422  | Validation error on request body |
| 429  | Rate-limited by upstream (Anthropic) — propagated |
| 500  | Internal error |
| 503  | Anthropic overloaded (529) — propagated as 503 |

**Versioning**: `schema_version: 1` on all wire formats (events, feedback). Bump on breaking changes; old clients reject unknown versions.

---

*End of `contracts.md`. These types are the source-of-truth import target for `apps/server`, `apps/web`, `packages/llm`, `packages/db`, and the CLI.*
