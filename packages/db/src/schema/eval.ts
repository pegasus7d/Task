// packages/db/src/schema/eval.ts
//
// Drizzle ORM schema derived from entities.md (single source of truth).
// 13 tables in dependency order.
//
// IDs: every surrogate UUID PK requires the application to supply a UUIDv7
// (via packages/shared `newId()`). We deliberately do NOT use `.defaultRandom()`
// (which generates UUIDv4) because `sse_events.event_id` and `traces.trace_id`
// rely on monotonic ordering for replay correctness (entities.md §5.5).
//
// Migration-ready fixes applied vs. literal entities.md DDL:
//   1. `field_aggregates` uses two partial unique indexes instead of a PK
//      containing a nullable column (Postgres rejects nullable PK columns).
//   2. `prompt_templates.first_seen_run` is a soft reference (no FK) to break
//      the runs ↔ prompt_templates cycle; documented inline.
//   3. `traces` is NOT yet partitioned — partition migration deferred to
//      a custom SQL migration when scale demands it.

import { sql, relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  jsonb,
  timestamp,
  numeric,
  char,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// JSONB shape placeholders.
//
// TODO: once `packages/shared` exists per contracts.md, replace these with real
// imports from @test-evals/shared. Schema columns are typed via `$type<T>()` so
// repository consumers see the same shapes as the wire format.
// ─────────────────────────────────────────────────────────────────────────────

type ClinicalExtraction = {
  chief_complaint: string;
  vitals: { bp: string | null; hr: number | null; temp_f: number | null; spo2: number | null };
  medications: Array<{
    name: string; dose: string | null; frequency: string | null; route: string | null;
    evidence_quote?: string;
  }>;
  diagnoses: Array<{ description: string; icd10?: string; evidence_quote?: string }>;
  plan: string[];
  follow_up: { interval_days: number | null; reason: string | null };
};

type ValidationResultShape = {
  ok: boolean;
  errors: Array<{
    kind: string;
    field_path: string;
    message: string;
    hint: string | null;
    expected?: unknown;
    actual?: unknown;
    evidence?: { candidate_value: string; closest_transcript: string | null; similarity: number };
  }>;
  schema_invalid: boolean;
  grounding_failed: boolean;
  hallucination_count: number;
  validators_run: string[];
  duration_ms: number;
};

type RunConfigShape = {
  strategy: string;
  model: string;
  case_filter?: string[] | null;
  force?: boolean;
  cost_cap_usd?: number;
  max_attempts?: 1 | 2 | 3;
  temperature?: number;
  max_tokens?: number;
  cache_ttl?: "5m" | "1h";
};

type DatasetManifestShape = {
  dataset_hash: string;
  schema_hash: string;
  case_count: number;
  cases: Array<{ case_id: string; transcript: string; tokens: number; tags?: string[] }>;
  gold: Record<string, { case_id: string; gold: ClinicalExtraction }>;
};

type ScoreMetadata = {
  precision?: number;
  recall?: number;
  tp?: number;
  fp?: number;
  fn?: number;
  partial_credit_count?: number;
  expected?: unknown;
  actual?: unknown;
};

type ToolDefinition = Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}>;

// Generic SSE event payload — concrete type lives in contracts §12 SseEvent union.
type SseEventPayload = Record<string, unknown>;

// Generic trace event payload — concrete shape varies by event_type.
type TraceEventPayload = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// 1.1  dataset_versions
// ─────────────────────────────────────────────────────────────────────────────

export const datasetVersions = pgTable(
  "dataset_versions",
  {
    datasetHash:   char("dataset_hash", { length: 64 }).primaryKey(),
    schemaHash:    char("schema_hash", { length: 64 }).notNull(),
    caseCount:     integer("case_count").notNull(),
    manifestJsonb: jsonb("manifest_jsonb").$type<DatasetManifestShape>().notNull(),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    notes:         text("notes"),
  },
  (t) => ({
    caseCountPositive: check(
      "dataset_versions_case_count_positive",
      sql`${t.caseCount} > 0`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.2  cases
// ─────────────────────────────────────────────────────────────────────────────

export const cases = pgTable(
  "cases",
  {
    caseId:      text("case_id").notNull(),
    datasetHash: char("dataset_hash", { length: 64 })
                   .notNull()
                   .references(() => datasetVersions.datasetHash, { onDelete: "restrict" }),
    transcript:  text("transcript").notNull(),
    tokens:      integer("tokens").notNull(),
    tags:        text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.datasetHash, t.caseId] }),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.3  gold_records
// ─────────────────────────────────────────────────────────────────────────────

export const goldRecords = pgTable(
  "gold_records",
  {
    caseId:      text("case_id").notNull(),
    datasetHash: char("dataset_hash", { length: 64 }).notNull(),
    goldJsonb:   jsonb("gold_jsonb").$type<ClinicalExtraction>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.datasetHash, t.caseId] }),
    caseFk: foreignKey({
      columns:        [t.datasetHash, t.caseId],
      foreignColumns: [cases.datasetHash, cases.caseId],
      name:           "gold_records_case_fk",
    }).onDelete("cascade"),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.4  prompt_templates
// ─────────────────────────────────────────────────────────────────────────────

export const promptTemplates = pgTable("prompt_templates", {
  promptHash:      char("prompt_hash", { length: 64 }).primaryKey(),
  strategyName:    text("strategy_name").notNull(),
  templateBody:    text("template_body").notNull(),
  toolsHash:       char("tools_hash", { length: 64 }).notNull(),
  toolDefinitions: jsonb("tool_definitions").$type<ToolDefinition>().notNull(),
  schemaHash:      char("schema_hash", { length: 64 }).notNull(),
  variablesJsonb:  jsonb("variables_jsonb")
                     .$type<Record<string, unknown>>()
                     .notNull()
                     .default(sql`'{}'::jsonb`),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Soft reference to runs(run_id) — no FK to break the runs ↔ prompt_templates
  // cycle. Application code should treat as "first run that introduced this
  // hash" advisory metadata; staleness is acceptable.
  firstSeenRun:    uuid("first_seen_run"),
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.12  strategy_registry
// ─────────────────────────────────────────────────────────────────────────────

export const strategyRegistry = pgTable("strategy_registry", {
  strategyName: text("strategy_name").primaryKey(),
  description:  text("description").notNull(),
  steps:        smallint("steps").notNull(),
  promptHash:   char("prompt_hash", { length: 64 })
                  .notNull()
                  .references(() => promptTemplates.promptHash, { onDelete: "restrict" }),
  enabled:      boolean("enabled").notNull().default(true),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// 1.13  scorer_registry
// ─────────────────────────────────────────────────────────────────────────────

export const scorerRegistry = pgTable(
  "scorer_registry",
  {
    scorerName:     text("scorer_name").notNull(),
    scorerVersion:  integer("scorer_version").notNull(),
    category:       text("category").notNull(),
    appliesToField: text("applies_to_field").notNull(),
    weight:         numeric("weight", { precision: 4, scale: 2 }).notNull(),
    enabled:        boolean("enabled").notNull().default(true),
    registeredAt:   timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scorerName, t.scorerVersion] }),
    categoryCheck: check(
      "scorer_registry_category_check",
      sql`${t.category} IN ('exact','fuzzy','tolerant','set_f1','grounding','schema')`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.5  runs
// ─────────────────────────────────────────────────────────────────────────────

export const runs = pgTable(
  "runs",
  {
    runId:                    uuid("run_id").primaryKey(),
    status:                   text("status").notNull(),

    strategyName:             text("strategy_name").notNull(),
    model:                    text("model").notNull(),
    promptHash:               char("prompt_hash", { length: 64 })
                                .notNull()
                                .references(() => promptTemplates.promptHash, { onDelete: "restrict" }),
    toolsHash:                char("tools_hash", { length: 64 }).notNull(),
    schemaHash:               char("schema_hash", { length: 64 }).notNull(),
    datasetHash:              char("dataset_hash", { length: 64 })
                                .notNull()
                                .references(() => datasetVersions.datasetHash, { onDelete: "restrict" }),
    configHash:               char("config_hash", { length: 64 }).notNull(),
    configJsonb:              jsonb("config_jsonb").$type<RunConfigShape>().notNull(),

    startedAt:                timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt:              timestamp("completed_at", { withTimezone: true }),
    cancelledAt:              timestamp("cancelled_at", { withTimezone: true }),
    durationMs:               integer("duration_ms"),

    caseCount:                integer("case_count").notNull(),
    caseCompleted:            integer("case_completed").notNull().default(0),
    caseSucceeded:            integer("case_succeeded").notNull().default(0),
    caseFailed:               integer("case_failed").notNull().default(0),
    caseInFlight:             integer("case_in_flight").notNull().default(0),

    totalInputTokens:         integer("total_input_tokens").notNull().default(0),
    totalOutputTokens:        integer("total_output_tokens").notNull().default(0),
    totalCacheCreationTokens: integer("total_cache_creation_tokens").notNull().default(0),
    totalCacheReadTokens:     integer("total_cache_read_tokens").notNull().default(0),
    totalCostUsd:             numeric("total_cost_usd", { precision: 12, scale: 6 })
                                .notNull().default("0"),

    weightedAggregate:        numeric("weighted_aggregate", { precision: 6, scale: 4 }),
    schemaInvalidRate:        numeric("schema_invalid_rate", { precision: 6, scale: 4 }),
    hallucinationRate:        numeric("hallucination_rate", { precision: 6, scale: 4 }),
    retryRate:                numeric("retry_rate", { precision: 6, scale: 4 }),

    notes:                    text("notes"),
    createdAt:                timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusCheck: check(
      "runs_status_check",
      sql`${t.status} IN ('queued','running','paused','completed','failed','cancelled')`,
    ),
    listIdx: index("runs_list").on(t.startedAt.desc(), t.status, t.strategyName),
    configHashIdx: index("runs_config_hash")
                     .on(t.configHash)
                     .where(sql`status NOT IN ('failed','cancelled')`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.6  attempts
// ─────────────────────────────────────────────────────────────────────────────

export const attempts = pgTable(
  "attempts",
  {
    // entities.md §1.6 — `attempt_id UUID NOT NULL UNIQUE` (column-level UNIQUE
    // constraint, not a unique INDEX). Required so child tables
    // (evaluations / scores / traces) can FK against `attempts.attempt_id` —
    // drizzle-kit only wires FKs whose target is a PRIMARY KEY or a UNIQUE
    // CONSTRAINT, not a bare UNIQUE INDEX.
    attemptId:                uuid("attempt_id").notNull().unique("attempts_attempt_id_unique"),
    runId:                    uuid("run_id")
                                .notNull()
                                .references(() => runs.runId, { onDelete: "cascade" }),
    caseId:                   text("case_id").notNull(),
    attemptIdx:               smallint("attempt_idx").notNull(),

    status:                   text("status").notNull(),

    strategyName:             text("strategy_name").notNull(),
    model:                    text("model").notNull(),
    promptHash:               char("prompt_hash", { length: 64 })
                                .notNull()
                                .references(() => promptTemplates.promptHash, { onDelete: "restrict" }),

    idempotencyKey:           char("idempotency_key", { length: 64 }).notNull(),
    anthropicRequestId:       text("anthropic_request_id"),

    startedAt:                timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt:              timestamp("completed_at", { withTimezone: true }),
    durationMs:               integer("duration_ms"),
    heartbeatAt:              timestamp("heartbeat_at", { withTimezone: true }),

    predictedJsonb:           jsonb("predicted_jsonb").$type<ClinicalExtraction>(),
    rawResponsePath:          text("raw_response_path"),
    retryReason:              text("retry_reason"),

    validationJsonb:          jsonb("validation_jsonb").$type<ValidationResultShape>(),

    inputTokens:              integer("input_tokens").notNull().default(0),
    outputTokens:             integer("output_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    cacheReadInputTokens:     integer("cache_read_input_tokens").notNull().default(0),

    costTotalUsd:             numeric("cost_total_usd", { precision: 10, scale: 6 })
                                .notNull().default("0"),
    costInputUsd:             numeric("cost_input_usd", { precision: 10, scale: 6 })
                                .notNull().default("0"),
    costOutputUsd:            numeric("cost_output_usd", { precision: 10, scale: 6 })
                                .notNull().default("0"),
    costCacheCreationUsd:     numeric("cost_cache_creation_usd", { precision: 10, scale: 6 })
                                .notNull().default("0"),
    costCacheReadUsd:         numeric("cost_cache_read_usd", { precision: 10, scale: 6 })
                                .notNull().default("0"),

    schemaVersion:            smallint("schema_version").notNull().default(1),
  },
  (t) => ({
    pk:                primaryKey({ columns: [t.runId, t.caseId, t.attemptIdx] }),
    idempotencyUnique: uniqueIndex("attempts_idempotency_key").on(t.idempotencyKey),
    runCaseIdx:        index("attempts_run_case").on(t.runId, t.caseId, t.attemptIdx),
    resumeScanIdx:     index("attempts_resume_scan")
                         .on(t.runId, t.status, t.heartbeatAt)
                         .where(sql`status IN ('queued','in_flight')`),
    requestIdIdx:      index("attempts_anthropic_request_id")
                         .on(t.anthropicRequestId)
                         .where(sql`anthropic_request_id IS NOT NULL`),

    attemptIdxRange: check(
      "attempts_attempt_idx_range",
      sql`${t.attemptIdx} BETWEEN 1 AND 3`,
    ),
    statusCheck: check(
      "attempts_status_check",
      sql`${t.status} IN ('queued','in_flight','succeeded','schema_invalid',
                          'grounding_failed','feedback_retry','rate_limited',
                          'overloaded','failed_terminal')`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.7  evaluations
//
// Per (run, case) eval row — created on case-final regardless of outcome.
// Stores granular FinalStatus (per-case) plus optional score fields (NULL on
// terminal failure, NOT NULL on success — enforced via CHECK).
// ─────────────────────────────────────────────────────────────────────────────

export const evaluations = pgTable(
  "evaluations",
  {
    evaluationId:        uuid("evaluation_id").primaryKey(),
    runId:               uuid("run_id")
                           .notNull()
                           .references(() => runs.runId, { onDelete: "cascade" }),
    caseId:              text("case_id").notNull(),
    attemptId:           uuid("attempt_id").notNull(),

    finalStatus:         text("final_status").notNull(),
    terminationReason:   text("termination_reason"),

    weightedAggregate:   numeric("weighted_aggregate", { precision: 6, scale: 4 }),
    unweightedAggregate: numeric("unweighted_aggregate", { precision: 6, scale: 4 }),

    schemaInvalid:       boolean("schema_invalid").notNull(),
    hallucinationCount:  integer("hallucination_count").notNull().default(0),
    groundedFieldRate:   numeric("grounded_field_rate", { precision: 6, scale: 4 }),

    durationMs:          integer("duration_ms").notNull(),
    schemaVersion:       smallint("schema_version").notNull().default(1),

    createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runCaseUnique: uniqueIndex("evaluations_run_case").on(t.runId, t.caseId),
    attemptFk: foreignKey({
      columns:        [t.attemptId],
      foreignColumns: [attempts.attemptId],
      name:           "evaluations_attempt_fk",
    }).onDelete("cascade"),

    finalStatusCheck: check(
      "evaluations_final_status_check",
      sql`${t.finalStatus} IN (
        'succeeded',
        'failed_schema_unrecoverable',
        'failed_grounding_unrecoverable',
        'failed_mixed',
        'failed_rate_limited',
        'failed_overloaded',
        'failed_auth',
        'failed_request_too_large',
        'failed_timeout',
        'cancelled',
        'cost_cap_exceeded'
      )`,
    ),
    scoreOnSuccessCheck: check(
      "evaluations_score_on_success_check",
      sql`(
        (${t.finalStatus} = 'succeeded' AND ${t.weightedAggregate} IS NOT NULL)
        OR
        (${t.finalStatus} <> 'succeeded' AND ${t.weightedAggregate} IS NULL)
      )`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.8  scores
// ─────────────────────────────────────────────────────────────────────────────

export const scores = pgTable(
  "scores",
  {
    scoreId:       uuid("score_id").primaryKey(),
    attemptId:     uuid("attempt_id").notNull(),
    runId:         uuid("run_id")
                     .notNull()
                     .references(() => runs.runId, { onDelete: "cascade" }),
    caseId:        text("case_id").notNull(),

    scorerName:    text("scorer_name").notNull(),
    scorerVersion: integer("scorer_version").notNull(),
    category:      text("category").notNull(),
    fieldPath:     text("field_path").notNull(),

    value:         numeric("value", { precision: 6, scale: 4 }).notNull(),
    weight:        numeric("weight", { precision: 4, scale: 2 }).notNull().default("1.0"),

    metadataJsonb: jsonb("metadata_jsonb").$type<ScoreMetadata>(),

    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    attemptFk: foreignKey({
      columns:        [t.attemptId],
      foreignColumns: [attempts.attemptId],
      name:           "scores_attempt_fk",
    }).onDelete("cascade"),

    attemptIdx: index("scores_attempt").on(t.attemptId),
    compareIdx: index("scores_compare")
                  .on(t.runId, t.fieldPath, t.scorerName, t.scorerVersion),

    valueRange: check(
      "scores_value_range",
      sql`${t.value} >= 0 AND ${t.value} <= 1`,
    ),
    categoryCheck: check(
      "scores_category_check",
      sql`${t.category} IN ('exact','fuzzy','tolerant','set_f1','grounding','schema')`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.9  field_aggregates
//
// Cannot use a PK that contains a nullable column (Postgres rejects). Use two
// partial unique indexes instead — preserves the "one un-faceted row + N
// faceted rows per (run_id, field_path)" semantic from entities.md §1.9.
// ─────────────────────────────────────────────────────────────────────────────

export const fieldAggregates = pgTable(
  "field_aggregates",
  {
    runId:        uuid("run_id")
                    .notNull()
                    .references(() => runs.runId, { onDelete: "cascade" }),
    fieldPath:    text("field_path").notNull(),

    primaryScore: numeric("primary_score", { precision: 6, scale: 4 }).notNull(),
    precision:    numeric("precision", { precision: 6, scale: 4 }),
    recall:       numeric("recall", { precision: 6, scale: 4 }),
    f1:           numeric("f1", { precision: 6, scale: 4 }),
    sampleSize:   integer("sample_size").notNull(),
    caseCount:    integer("case_count").notNull(),

    tagFacet:     text("tag_facet"),

    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unfacetedUnique: uniqueIndex("field_aggregates_unfaceted")
                       .on(t.runId, t.fieldPath)
                       .where(sql`${t.tagFacet} IS NULL`),
    facetedUnique:   uniqueIndex("field_aggregates_faceted")
                       .on(t.runId, t.fieldPath, t.tagFacet)
                       .where(sql`${t.tagFacet} IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.10  traces
//
// Append-only fine-grained event log per attempt. entities.md §1.10 specifies
// PARTITION BY RANGE (ts); deferred to a custom SQL migration when scale
// demands it. v1: keep as a regular table.
// ─────────────────────────────────────────────────────────────────────────────

export const traces = pgTable(
  "traces",
  {
    traceId:      uuid("trace_id").primaryKey(),
    attemptId:    uuid("attempt_id").notNull(),
    runId:        uuid("run_id").notNull(),
    eventIdx:     integer("event_idx").notNull(),
    eventType:    text("event_type").notNull(),
    payloadJsonb: jsonb("payload_jsonb").$type<TraceEventPayload>().notNull(),
    ts:           timestamp("ts", { withTimezone: true })
                    .notNull()
                    .default(sql`clock_timestamp()`),
  },
  (t) => ({
    attemptFk: foreignKey({
      columns:        [t.attemptId],
      foreignColumns: [attempts.attemptId],
      name:           "traces_attempt_fk",
    }).onDelete("cascade"),

    attemptEventUnique: uniqueIndex("traces_attempt_event_unique")
                          .on(t.attemptId, t.eventIdx),
    eventTypeCheck: check(
      "traces_event_type_check",
      sql`${t.eventType} IN ('request_sent','sse_delta','tool_use_assembled',
                             'schema_validation','grounding_validation',
                             'feedback_sent','scoring','persisted','error')`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// 1.11  sse_events
//
// event_id is UUIDv7 (app-supplied) so `event_id > $last_event_id` orders
// monotonically for SSE replay.
// ─────────────────────────────────────────────────────────────────────────────

export const sseEvents = pgTable(
  "sse_events",
  {
    eventId:       uuid("event_id").primaryKey(),
    runId:         uuid("run_id")
                     .notNull()
                     .references(() => runs.runId, { onDelete: "cascade" }),
    eventType:     text("event_type").notNull(),
    payloadJsonb:  jsonb("payload_jsonb").$type<SseEventPayload>().notNull(),
    ts:            timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    schemaVersion: smallint("schema_version").notNull().default(1),
  },
  (t) => ({
    replayIdx: index("sse_events_replay").on(t.runId, t.eventId),
    runTsIdx:  index("sse_events_run_ts").on(t.runId, t.ts.desc()),

    eventTypeCheck: check(
      "sse_events_event_type_check",
      sql`${t.eventType} IN ('run_started','attempt_started','attempt_completed',
                             'validation_failed','case_scored','run_progress',
                             'run_completed','run_failed','heartbeat')`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Relations (Drizzle query API)
// ─────────────────────────────────────────────────────────────────────────────

export const datasetVersionsRelations = relations(datasetVersions, ({ many }) => ({
  cases: many(cases),
  runs:  many(runs),
}));

export const casesRelations = relations(cases, ({ one }) => ({
  datasetVersion: one(datasetVersions, {
    fields:     [cases.datasetHash],
    references: [datasetVersions.datasetHash],
  }),
  gold: one(goldRecords, {
    fields:     [cases.datasetHash, cases.caseId],
    references: [goldRecords.datasetHash, goldRecords.caseId],
  }),
}));

export const goldRecordsRelations = relations(goldRecords, ({ one }) => ({
  case: one(cases, {
    fields:     [goldRecords.datasetHash, goldRecords.caseId],
    references: [cases.datasetHash, cases.caseId],
  }),
}));

export const promptTemplatesRelations = relations(promptTemplates, ({ many }) => ({
  runs:       many(runs),
  attempts:   many(attempts),
  strategies: many(strategyRegistry),
}));

export const strategyRegistryRelations = relations(strategyRegistry, ({ one }) => ({
  prompt: one(promptTemplates, {
    fields:     [strategyRegistry.promptHash],
    references: [promptTemplates.promptHash],
  }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  prompt: one(promptTemplates, {
    fields:     [runs.promptHash],
    references: [promptTemplates.promptHash],
  }),
  dataset: one(datasetVersions, {
    fields:     [runs.datasetHash],
    references: [datasetVersions.datasetHash],
  }),
  attempts:        many(attempts),
  evaluations:     many(evaluations),
  scores:          many(scores),
  fieldAggregates: many(fieldAggregates),
  sseEvents:       many(sseEvents),
}));

export const attemptsRelations = relations(attempts, ({ one, many }) => ({
  run: one(runs, {
    fields:     [attempts.runId],
    references: [runs.runId],
  }),
  prompt: one(promptTemplates, {
    fields:     [attempts.promptHash],
    references: [promptTemplates.promptHash],
  }),
  evaluation: one(evaluations, {
    fields:     [attempts.attemptId],
    references: [evaluations.attemptId],
  }),
  scores: many(scores),
  traces: many(traces),
}));

export const evaluationsRelations = relations(evaluations, ({ one }) => ({
  run: one(runs, {
    fields:     [evaluations.runId],
    references: [runs.runId],
  }),
  attempt: one(attempts, {
    fields:     [evaluations.attemptId],
    references: [attempts.attemptId],
  }),
}));

export const scoresRelations = relations(scores, ({ one }) => ({
  attempt: one(attempts, {
    fields:     [scores.attemptId],
    references: [attempts.attemptId],
  }),
  run: one(runs, {
    fields:     [scores.runId],
    references: [runs.runId],
  }),
}));

export const fieldAggregatesRelations = relations(fieldAggregates, ({ one }) => ({
  run: one(runs, {
    fields:     [fieldAggregates.runId],
    references: [runs.runId],
  }),
}));

export const tracesRelations = relations(traces, ({ one }) => ({
  attempt: one(attempts, {
    fields:     [traces.attemptId],
    references: [attempts.attemptId],
  }),
}));

export const sseEventsRelations = relations(sseEvents, ({ one }) => ({
  run: one(runs, {
    fields:     [sseEvents.runId],
    references: [runs.runId],
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Inferred row types — use these in services / repositories
// ─────────────────────────────────────────────────────────────────────────────

export type DatasetVersion       = typeof datasetVersions.$inferSelect;
export type DatasetVersionNew    = typeof datasetVersions.$inferInsert;

export type CaseRow              = typeof cases.$inferSelect;
export type CaseRowNew           = typeof cases.$inferInsert;

export type GoldRecordRow        = typeof goldRecords.$inferSelect;
export type GoldRecordRowNew     = typeof goldRecords.$inferInsert;

export type PromptTemplate       = typeof promptTemplates.$inferSelect;
export type PromptTemplateNew    = typeof promptTemplates.$inferInsert;

export type StrategyRow          = typeof strategyRegistry.$inferSelect;
export type StrategyRowNew       = typeof strategyRegistry.$inferInsert;

export type ScorerRow            = typeof scorerRegistry.$inferSelect;
export type ScorerRowNew         = typeof scorerRegistry.$inferInsert;

export type RunRow               = typeof runs.$inferSelect;
export type RunRowNew            = typeof runs.$inferInsert;

export type AttemptRow           = typeof attempts.$inferSelect;
export type AttemptRowNew        = typeof attempts.$inferInsert;

export type EvaluationRow        = typeof evaluations.$inferSelect;
export type EvaluationRowNew     = typeof evaluations.$inferInsert;

export type ScoreRow             = typeof scores.$inferSelect;
export type ScoreRowNew          = typeof scores.$inferInsert;

export type FieldAggregateRow    = typeof fieldAggregates.$inferSelect;
export type FieldAggregateRowNew = typeof fieldAggregates.$inferInsert;

export type TraceRow             = typeof traces.$inferSelect;
export type TraceRowNew          = typeof traces.$inferInsert;

export type SseEventRow          = typeof sseEvents.$inferSelect;
export type SseEventRowNew       = typeof sseEvents.$inferInsert;
