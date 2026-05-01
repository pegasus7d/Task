# HEALOSBENCH — Database Entities & Persistence Model

> Production-grade Postgres schema derived from [contracts.md](contracts.md). Companion: [approach.md](approach.md) (build plan), [lld.md](lld.md) (system design).
>
> Storage authority: **Postgres** (canonical SoT) + **disk** (raw response JSONL files referenced from `attempts.raw_response_path`). Drizzle ORM is the implementation; the table shapes below are the source of truth.

---

## Table of Contents

1. [Entity Definitions](#1-entity-definitions)
2. [Relationships (ERD)](#2-relationships-erd)
3. [Indexing Strategy](#3-indexing-strategy)
4. [Data Storage Decisions](#4-data-storage-decisions)
5. [Query Patterns](#5-query-patterns)
6. [Idempotency & Consistency](#6-idempotency--consistency)

---

## 1. Entity Definitions

13 tables. Naming: snake_case throughout. Every PK is UUIDv7 (time-ordered, monotonic — good for indexes and trace replay).

### 1.1 `dataset_versions`

Immutable, content-addressed snapshot of `data/transcripts/*` + `data/gold/*` + `data/schema.json`. **Required for reproducibility** — every run stamps its `dataset_hash`. Maps to `DatasetManifest` (contracts §2.4).

```sql
CREATE TABLE dataset_versions (
  dataset_hash      CHAR(64) PRIMARY KEY,        -- sha256 of canonical JSONL of (case + gold) pairs
  schema_hash       CHAR(64) NOT NULL,           -- sha256 of data/schema.json
  case_count        INTEGER  NOT NULL CHECK (case_count > 0),
  manifest_jsonb    JSONB    NOT NULL,           -- full DatasetManifest for audit
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes             TEXT
);
```

**Why a separate table** — guarantees runs are repeatable on the *same* dataset; cross-dataset comparisons are gated at the SQL layer (`runs.dataset_hash` FK).

---

### 1.2 `cases`

Individual transcripts. Maps to `Case` (contracts §2.4). Joined to `dataset_versions` so a transcript edit produces a new dataset_hash without rewriting cases.

```sql
CREATE TABLE cases (
  case_id           TEXT NOT NULL,                -- "case_001" — stable across versions
  dataset_hash      CHAR(64) NOT NULL REFERENCES dataset_versions(dataset_hash),
  transcript        TEXT NOT NULL,
  tokens            INTEGER NOT NULL,             -- pre-computed
  tags              TEXT[] NOT NULL DEFAULT '{}', -- TagFacet[] for compare facets
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_hash, case_id)
);
```

---

### 1.3 `gold_records`

Ground truth per case. Maps to `GoldRecord` (contracts §2.4). Read-only after dataset publication.

```sql
CREATE TABLE gold_records (
  case_id           TEXT NOT NULL,
  dataset_hash      CHAR(64) NOT NULL,
  gold_jsonb        JSONB NOT NULL,               -- ClinicalExtraction
  PRIMARY KEY (dataset_hash, case_id),
  FOREIGN KEY (dataset_hash, case_id) REFERENCES cases(dataset_hash, case_id)
);
```

**Why split from `cases`** — cases have transcripts (model input), gold has ground truth (eval-only). Different access patterns: extractor reads cases, evaluator reads gold. Splitting prevents the runner from accidentally including gold in a prompt.

---

### 1.4 `prompt_templates`

Content-addressed prompt versions. Maps to the `prompt_hash` field on `Run` and `Attempt`. Built so prompt v6 vs v7 compare is *unambiguous*.

```sql
CREATE TABLE prompt_templates (
  prompt_hash       CHAR(64) PRIMARY KEY,         -- sha256 of canonicalized rendered prompt
  strategy_name     TEXT NOT NULL,                -- "zero_shot" | "few_shot" | "cot" | ...
  template_body     TEXT NOT NULL,                -- the rendered system + suffix (post-template, post-fewshot)
  tools_hash        CHAR(64) NOT NULL,            -- sha256 of tool definitions
  tool_definitions  JSONB NOT NULL,
  schema_hash       CHAR(64) NOT NULL,            -- sha256 of input_schema (Anthropic tool input)
  variables_jsonb   JSONB NOT NULL DEFAULT '{}',  -- e.g. {"k": 3, "examples_archetypes": [...]}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_seen_run    UUID                           -- nullable; first run that introduced this hash
);
```

**Why** — `IStrategyRegistry.list()` exposes `prompt_hash`; this table is the lookup target. Strategy code changes → new hash → new row → old runs still resolve.

---

### 1.5 `runs`

Top-level run record. Maps to `Run` (contracts §10). **Read-heavy** (runs list, runs detail) — aggregates are denormalized here so the list page doesn't scan attempts.

```sql
CREATE TABLE runs (
  run_id              UUID PRIMARY KEY,
  status              TEXT NOT NULL CHECK (status IN
                          ('queued','running','paused','completed','failed','cancelled')),

  -- Reproducibility — every hash that defines "what this run is"
  strategy_name       TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_hash         CHAR(64) NOT NULL REFERENCES prompt_templates(prompt_hash),
  tools_hash          CHAR(64) NOT NULL,
  schema_hash         CHAR(64) NOT NULL,
  dataset_hash        CHAR(64) NOT NULL REFERENCES dataset_versions(dataset_hash),
  config_hash         CHAR(64) NOT NULL,        -- denormalized; idempotency lookup key
  config_jsonb        JSONB    NOT NULL,        -- full RunConfig

  -- Lifecycle
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  duration_ms         INTEGER,

  -- Counters (denormalized — updated atomically per attempt)
  case_count          INTEGER NOT NULL,
  case_completed      INTEGER NOT NULL DEFAULT 0,
  case_succeeded      INTEGER NOT NULL DEFAULT 0,
  case_failed         INTEGER NOT NULL DEFAULT 0,
  case_in_flight      INTEGER NOT NULL DEFAULT 0,

  -- Token + cost aggregates (denormalized — updated atomically per attempt)
  total_input_tokens          INTEGER NOT NULL DEFAULT 0,
  total_output_tokens         INTEGER NOT NULL DEFAULT 0,
  total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  total_cost_usd              NUMERIC(12,6) NOT NULL DEFAULT 0,

  -- Headline aggregate (denormalized — populated on run_completed)
  weighted_aggregate          NUMERIC(6,4),  -- ∈ [0,1]
  schema_invalid_rate         NUMERIC(6,4),
  hallucination_rate          NUMERIC(6,4),
  retry_rate                  NUMERIC(6,4),

  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Why so many denormalized columns** — the runs-list page is the most-loaded screen; computing aggregates per-row from joins is unacceptable at any scale. Counters are updated transactionally as attempts complete (see §6).

---

### 1.6 `attempts`

Per-case-per-attempt row. Maps to `Attempt` (contracts §4). Composite PK enables natural ordering and resume queries; surrogate `attempt_id` exists for FK targeting from scores/traces.

```sql
CREATE TABLE attempts (
  attempt_id          UUID NOT NULL UNIQUE,           -- surrogate, for child FKs
  run_id              UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  case_id             TEXT NOT NULL,
  attempt_idx         SMALLINT NOT NULL CHECK (attempt_idx BETWEEN 1 AND 3),

  status              TEXT NOT NULL CHECK (status IN (
                          'queued','in_flight','succeeded','schema_invalid',
                          'grounding_failed','feedback_retry','rate_limited',
                          'overloaded','failed_terminal')),

  strategy_name       TEXT NOT NULL,                  -- denormalized for fast filter
  model               TEXT NOT NULL,
  prompt_hash         CHAR(64) NOT NULL REFERENCES prompt_templates(prompt_hash),

  -- Idempotency
  idempotency_key     CHAR(64) NOT NULL,              -- sha256(model+prompt_hash+tools_hash+temp+max_tokens+case_id+attempt_idx)
  anthropic_request_id TEXT,                          -- audit only

  -- Lifecycle
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  duration_ms         INTEGER,
  heartbeat_at        TIMESTAMPTZ,                    -- for resume scanner

  -- Output
  predicted_jsonb     JSONB,                          -- ClinicalExtraction or null
  raw_response_path   TEXT,                           -- "runs/{run_id}/{case_id}/attempt_{n}.jsonl"
  retry_reason        TEXT,

  -- Validation snapshot (full ValidationResult inlined for trace UI)
  validation_jsonb    JSONB,

  -- Token accounting (for cache verification)
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,

  -- Cost (denormalized — computed at write time using HAIKU_4_5_PRICING)
  cost_total_usd              NUMERIC(10,6) NOT NULL DEFAULT 0,
  cost_input_usd              NUMERIC(10,6) NOT NULL DEFAULT 0,
  cost_output_usd             NUMERIC(10,6) NOT NULL DEFAULT 0,
  cost_cache_creation_usd     NUMERIC(10,6) NOT NULL DEFAULT 0,
  cost_cache_read_usd         NUMERIC(10,6) NOT NULL DEFAULT 0,

  schema_version      SMALLINT NOT NULL DEFAULT 1,

  PRIMARY KEY (run_id, case_id, attempt_idx)
);
```

**Why composite PK + surrogate** — composite PK reflects domain identity (the *retry-budget* relationship), surrogate UUID lets `scores.attempt_id` and `traces.attempt_id` use a single FK column. The composite PK doubles as the natural index for resume scans.

---

### 1.7 `evaluations`

Per (run, case) eval result. Maps to `EvaluationResult` (contracts §7) **and** captures `FinalStatus` (contracts §4). One row per case per run — created on case-final regardless of outcome (success or terminal failure), so per-case "why did this fail?" is a single SELECT.

```sql
CREATE TABLE evaluations (
  evaluation_id       UUID PRIMARY KEY,
  run_id              UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  case_id             TEXT NOT NULL,
  /** FK to the case-final attempt: succeeded for happy path, last failed attempt otherwise. */
  attempt_id          UUID NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,

  /** Per-case granular terminal status — mirrors FinalStatus union in contracts §4. */
  final_status        TEXT NOT NULL CHECK (final_status IN (
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
                          'cost_cap_exceeded')),
  termination_reason  TEXT,                          -- plain-text reason for trace UI

  /** Score fields are NULL for terminal-failure rows (no successful extraction to score). */
  weighted_aggregate    NUMERIC(6,4),
  unweighted_aggregate  NUMERIC(6,4),

  schema_invalid       BOOLEAN NOT NULL,
  hallucination_count  INTEGER NOT NULL DEFAULT 0,
  grounded_field_rate  NUMERIC(6,4),                 -- NULL on failure

  duration_ms          INTEGER NOT NULL,
  schema_version       SMALLINT NOT NULL DEFAULT 1,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (run_id, case_id),                          -- one eval per case per run
  /** Score fields must be present iff the case succeeded. */
  CHECK (
    (final_status = 'succeeded' AND weighted_aggregate IS NOT NULL)
    OR
    (final_status <> 'succeeded' AND weighted_aggregate IS NULL)
  )
);
```

**Why this shape:**
- `attempts.status` is *per-attempt* (e.g. attempt 1 = `schema_invalid`, attempt 2 = `succeeded`). `evaluations.final_status` is *per-case* (10-value `FinalStatus`) — the answer to "did this case end well, and if not, why?"
- Creating an `evaluations` row for failures too means **the compare view, runs-list, and case-bucket queries never need a special-case `LEFT JOIN`** — every case has exactly one row.
- Score columns are nullable + CHECK-constrained: a row with `final_status = 'failed_grounding_unrecoverable'` has `weighted_aggregate IS NULL`, not `0`. This avoids polluting averages — `AVG(weighted_aggregate)` excludes failures by default; counts of failures come from `final_status`.

**Why not store `EvaluationInput`** — `EvaluationInput` (contracts §7.3) is the compute-side input to `IEvaluatorService.scoreCase`; it's reconstructible at any time from `attempts.predicted_jsonb` + `gold_records.gold_jsonb` + `cases.transcript`. Persisting it would duplicate three other tables. It is **deliberately transient**.

---

### 1.8 `scores`

Atomic scorer outputs. Maps to `ScoreResult` / `AttachedScore` (contracts §11). One row per scorer per attempt; ~14 rows per case (per the canonical scorer set in contracts §8).

```sql
CREATE TABLE scores (
  score_id            UUID PRIMARY KEY,
  attempt_id          UUID NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  run_id              UUID NOT NULL REFERENCES runs(run_id)         ON DELETE CASCADE,  -- denormalized
  case_id             TEXT NOT NULL,                                                    -- denormalized

  scorer_name         TEXT NOT NULL,
  scorer_version      INTEGER NOT NULL,
  category            TEXT NOT NULL CHECK (category IN
                          ('exact','fuzzy','tolerant','set_f1','grounding','schema')),
  field_path          TEXT NOT NULL,                  -- "medications" for set-level, "vitals.bp" for leaf

  value               NUMERIC(6,4) NOT NULL CHECK (value >= 0 AND value <= 1),
  weight              NUMERIC(4,2) NOT NULL DEFAULT 1.0,

  metadata_jsonb      JSONB,                          -- {precision, recall, tp, fp, fn, expected, actual}

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Why `run_id` and `case_id` denormalized here** — the compare query (§5.3) groups by `run_id, field_path` over millions of rows; a single attempt-FK join would force a plan that can't use the field_path index alone. Eating 16 bytes per row buys a 10–100× speedup on the headline screen.

---

### 1.9 `field_aggregates`

Denormalized per-field-per-run aggregate. Maps to `FieldAggregate` / `RunAggregate.per_field` (contracts §7). Materialized at run-completion (and rebuildable via `IEvaluatorService.rebuildAggregates`).

```sql
CREATE TABLE field_aggregates (
  run_id              UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  field_path          TEXT NOT NULL,

  primary_score       NUMERIC(6,4) NOT NULL,
  precision           NUMERIC(6,4),
  recall              NUMERIC(6,4),
  f1                  NUMERIC(6,4),
  sample_size         INTEGER NOT NULL,
  case_count          INTEGER NOT NULL,

  -- Optional facet — null = un-faceted (the headline row)
  tag_facet           TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (run_id, field_path, tag_facet)
);
-- NULL is treated as a distinct value in the PK for un-faceted rows
CREATE UNIQUE INDEX field_aggregates_unfaceted
  ON field_aggregates (run_id, field_path) WHERE tag_facet IS NULL;
```

**Why a real table not a view** — compare-view is the hottest path; computing per-field F1 on every page render across 50 cases × 14 scorers × 2 runs would dominate latency. Materialize once on `run_completed`.

---

### 1.10 `traces`

Append-only fine-grained event log per attempt. Maps to `TraceEvent` (contracts §11). High-volume — every SSE delta, every validation error, every retry decision goes here.

```sql
CREATE TABLE traces (
  trace_id            UUID PRIMARY KEY,
  attempt_id          UUID NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  run_id              UUID NOT NULL,                  -- denormalized for partition pruning
  event_idx           INTEGER NOT NULL,               -- monotonic per attempt — event ordering
  event_type          TEXT NOT NULL CHECK (event_type IN (
                          'request_sent','sse_delta','tool_use_assembled',
                          'schema_validation','grounding_validation',
                          'feedback_sent','scoring','persisted','error')),
  payload_jsonb       JSONB NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),  -- intra-tx ordering

  UNIQUE (attempt_id, event_idx)
)
PARTITION BY RANGE (ts);     -- monthly partitions; oldest dropped after retention window
```

**Why partition** — traces are write-heavy and ephemeral (after 30 days you only need them for runs you'll never re-read). Range partition by `ts` enables cheap drop of old data.

---

### 1.11 `sse_events`

Replay buffer for SSE reconnect. Maps to `SseEvent` (contracts §12). Distinct from `traces` — `sse_events` is the *coarse* client-facing stream, `traces` is the fine-grained server-side audit log.

```sql
CREATE TABLE sse_events (
  event_id            UUID PRIMARY KEY,               -- UUIDv7 — monotonic, used as Last-Event-ID
  run_id              UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL CHECK (event_type IN (
                          'run_started','attempt_started','attempt_completed',
                          'validation_failed','case_scored','run_progress',
                          'run_completed','run_failed','heartbeat')),
  payload_jsonb       JSONB NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version      SMALLINT NOT NULL DEFAULT 1
);
```

**Why separate from traces** — different consumers (browser SSE vs trace UI), different retention (SSE buffer = 1 hour, traces = 30 days), different shape.

---

### 1.12 `strategy_registry`

Mirror of `IStrategyRegistry.list()`. Powers the UI dropdown and CLI `--strategy=` autocomplete without scanning code at request time.

```sql
CREATE TABLE strategy_registry (
  strategy_name       TEXT PRIMARY KEY,
  description         TEXT NOT NULL,
  steps               SMALLINT NOT NULL,              -- 1 for single-shot, 2+ for chained
  prompt_hash         CHAR(64) NOT NULL REFERENCES prompt_templates(prompt_hash),
  enabled             BOOLEAN NOT NULL DEFAULT true,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Updated atomically on server start by reading the in-memory `STRATEGIES` map and upserting.

---

### 1.13 `scorer_registry`

Mirror of `IScorerRegistry.list()`. Populated at startup. Critical for `scorer_version` discipline — bumping a scorer in code creates a new row, old scores retain their old version.

```sql
CREATE TABLE scorer_registry (
  scorer_name         TEXT NOT NULL,
  scorer_version      INTEGER NOT NULL,
  category            TEXT NOT NULL CHECK (category IN
                          ('exact','fuzzy','tolerant','set_f1','grounding','schema')),
  applies_to_field    TEXT NOT NULL,
  weight              NUMERIC(4,2) NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  registered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scorer_name, scorer_version)
);
```

---

## 2. Relationships (ERD)

```
                       ┌──────────────────────┐
                       │  dataset_versions    │
                       └──────┬───────────────┘
                              │ 1:N
                ┌─────────────┴─────────────┐
                │                           │
                ▼                           ▼
          ┌──────────┐                ┌──────────────┐
          │  cases   │ 1:1 ────────▶ │ gold_records │
          └──────────┘                └──────────────┘

           ┌────────────────────┐
           │  prompt_templates  │
           └────────┬───────────┘
                    │ N:1 (many runs share a hash)
                    ▼
         ┌──────────────────┐
         │       runs       │ ◀───── strategy_registry (FK on strategy_name)
         └────────┬─────────┘
                  │ 1:N
       ┌──────────┴───────────────────┬──────────────────┐
       ▼                              ▼                  ▼
  ┌──────────┐                 ┌──────────────┐   ┌──────────────┐
  │ attempts │                 │ sse_events   │   │ field_       │
  └──────┬───┘                 │ (replay      │   │ aggregates   │
         │ 1:N                  │  buffer)    │   │ (compare     │
   ┌─────┴──────┬─────────┐    └──────────────┘   │  cache)      │
   ▼            ▼         ▼                       └──────────────┘
┌────────┐ ┌──────────┐ ┌───────────┐
│ scores │ │  traces  │ │evaluations│ ◀─── 1:1 with attempt_id (winning attempt)
└────────┘ └──────────┘ └───────────┘
                              ▲
                              │
                       scorer_registry (FK on scorer_name+version)
```

### Cardinalities (concise)

| Parent | Child | Cardinality | ON DELETE |
| --- | --- | --- | --- |
| `dataset_versions` | `cases` | 1:N | RESTRICT |
| `dataset_versions` | `runs` | 1:N | RESTRICT |
| `cases` | `gold_records` | 1:1 | CASCADE |
| `prompt_templates` | `runs` | 1:N | RESTRICT |
| `prompt_templates` | `attempts` | 1:N | RESTRICT |
| `runs` | `attempts` | 1:N (≤ 50 cases × 3 attempts = 150) | CASCADE |
| `runs` | `evaluations` | 1:N (exactly = case_count when complete — one row per case-final, success or failure) | CASCADE |
| `runs` | `field_aggregates` | 1:N (≈ 14 fields × {1 + N facets}) | CASCADE |
| `runs` | `sse_events` | 1:N (~3 events per attempt + heartbeats) | CASCADE |
| `attempts` | `scores` | 1:N (= 14 canonical scorers, only on winning attempt) | CASCADE |
| `attempts` | `traces` | 1:N (~10–50 events per attempt) | CASCADE |
| `attempts` | `evaluations` | 1:0..1 (the case-final attempt — succeeded or last-failed — owns the eval row) | CASCADE |

### Why dataset/prompt FKs are RESTRICT not CASCADE

Deleting a dataset version or prompt template that any run depends on would silently orphan historical results. RESTRICT forces the operator to explicitly retire dependent runs first — which is the correct compliance default for an eval system that grades models over time.

---

## 3. Indexing Strategy

Three index families: **lookup** (point reads), **scan** (list pages), **trace** (ordered ranges).

### 3.1 Lookup indexes (point reads)

```sql
-- Idempotency — hard requirement #6, must be exact-match O(1)
CREATE UNIQUE INDEX attempts_idempotency_key ON attempts (idempotency_key);

-- Idempotency at run level (POST /runs returns cached run on identical config)
CREATE INDEX runs_config_hash ON runs (config_hash) WHERE status NOT IN ('failed','cancelled');

-- Anthropic request ID lookup (for support escalations)
CREATE INDEX attempts_anthropic_request_id ON attempts (anthropic_request_id)
  WHERE anthropic_request_id IS NOT NULL;
```

### 3.2 Scan indexes (list / aggregation)

```sql
-- Runs list: latest-first, optionally filtered
CREATE INDEX runs_list ON runs (started_at DESC, status, strategy_name);

-- Run detail: attempts of a run grouped by case
CREATE INDEX attempts_run_case ON attempts (run_id, case_id, attempt_idx);

-- Attempts-by-status (resume scanner)
CREATE INDEX attempts_resume_scan ON attempts (run_id, status, heartbeat_at)
  WHERE status IN ('queued','in_flight');

-- Per-attempt scores (run detail drill-down)
CREATE INDEX scores_attempt ON scores (attempt_id);

-- Compare query: per-run-per-field aggregation over scores
CREATE INDEX scores_compare ON scores (run_id, field_path, scorer_name, scorer_version);

-- Per-case eval lookup (compare drill-down)
CREATE UNIQUE INDEX evaluations_run_case ON evaluations (run_id, case_id);
```

### 3.3 Trace / SSE replay indexes

```sql
-- Per-attempt event ordering (trace UI)
-- (already enforced by UNIQUE (attempt_id, event_idx))

-- SSE replay since `last_event_id`
CREATE INDEX sse_events_replay ON sse_events (run_id, event_id);     -- event_id is UUIDv7 = time-ordered

-- Active run progress queries
CREATE INDEX sse_events_run_ts ON sse_events (run_id, ts DESC);
```

### 3.4 Justifications & non-indexes

- **`scores` is NOT indexed by `case_id` alone** — every case-level query already constrains by `run_id`, so the composite `(run_id, field_path, ...)` covers it.
- **`field_aggregates` PK is sufficient** — the table is small (≈ 14 × 50 runs = 700 rows for a typical year of dev work), no extra indexes needed.
- **No GIN index on `metadata_jsonb`** — payload is opaque to compare queries; only fetched on case drill-down via attempt FK.
- **`payload_jsonb` on traces is NOT indexed** — append-only, only read in `event_idx` order via the UNIQUE constraint.

---

## 4. Data Storage Decisions

### 4.1 Normalized vs denormalized — explicit table

| Field | Location | Why denormalized (when applicable) |
| --- | --- | --- |
| `runs.weighted_aggregate` | denormalized | Runs list page renders 50+ rows; recomputing from scores is unacceptable. Updated transactionally on `run_completed`. |
| `runs.case_count`, `case_completed`, etc. | denormalized | Same — list page must be a single SELECT. |
| `runs.total_*_tokens`, `total_cost_usd` | denormalized | Cost-cap guardrail polls this column mid-run; can't afford a sum-over-attempts. |
| `attempts.cost_*_usd` | denormalized | Pricing changes shouldn't retro-affect historical runs. Compute at write time using the run's snapshot of `HAIKU_4_5_PRICING`. |
| `scores.run_id`, `scores.case_id` | denormalized | Compare query groups by `(run_id, field_path)` over millions of rows; avoids a join to attempts. |
| `traces.run_id` | denormalized | Partition pruning by `ts` + filter by `run_id` without joining attempts. |
| `attempts.predicted_jsonb` | normalized JSONB | Same shape as `ClinicalExtraction`; whole-object replacement on attempt write — never partial-updated. |
| `attempts.validation_jsonb` | normalized JSONB | `ValidationResult` is heterogeneous; querying its fields would be premature optimization. |
| `attempts.raw_response_path` | reference to disk | The full SSE event stream per attempt is large (~50–200 KB) and only read in the trace UI; storing on local disk + S3 (later) is cheaper than Postgres. |
| `field_aggregates.*` | denormalized table | Materialized cache of compare-view inputs. Rebuildable via `IEvaluatorService.rebuildAggregates`. |

### 4.2 JSONB usage policy

**JSONB only when** (a) the shape is heterogeneous (e.g. `metadata_jsonb` varies per scorer); (b) the field is opaque to query planning (only read whole-object); or (c) the schema may evolve (`payload_jsonb`, `manifest_jsonb`).

**Native columns when** (a) the field is in a WHERE / GROUP BY / ORDER BY; (b) the type is fixed (numeric, enum); (c) typed integrity matters (`status` CHECK constraint).

This keeps the optimizer informed and the migration story honest. JSONB is *never* the answer for `status`, `score`, or `case_id`.

### 4.3 Trade-offs accepted

- **Counter drift**: denormalized counters on `runs` can drift if an attempt write fails after `runs.case_completed += 1` is committed. Mitigation: per-status counts can be re-derived from `attempts` via a periodic reconciliation job (cheap, O(50 × 3) per run).
- **Score double-write on rebuild**: rerunning aggregations creates new `field_aggregates` rows for the same `(run_id, field_path)`; mitigated by ON CONFLICT DO UPDATE on the unique key.
- **Trace partition operations**: rolling monthly partitions is more DDL than truncating one table, but it makes 30-day retention a single `DROP PARTITION` instead of a multi-million-row DELETE.

---

## 5. Query Patterns

Five canonical queries cover ≥ 95% of read traffic. Each shown with the index it should hit.

### 5.1 Runs list (`GET /api/v1/runs`)

```sql
SELECT
  run_id, status, strategy_name, model,
  case_count, case_completed, case_succeeded, case_failed,
  weighted_aggregate, schema_invalid_rate, hallucination_rate,
  total_cost_usd, started_at, completed_at, duration_ms
FROM runs
WHERE
  ($1::text IS NULL OR status        = $1)
  AND ($2::text IS NULL OR strategy_name = $2)
  AND ($3::text IS NULL OR model     = $3)
  AND ($4::timestamptz IS NULL OR started_at < $4)   -- cursor
ORDER BY started_at DESC
LIMIT 50;
```

Index: `runs_list (started_at DESC, status, strategy_name)`. Single index scan, no joins. ≤ 5ms.

---

### 5.2 Run detail (`GET /api/v1/runs/:id`)

Two queries:

```sql
-- 5.2a Run header + aggregate
SELECT * FROM runs WHERE run_id = $1;

-- 5.2b Per-case state
SELECT
  a.case_id, a.attempt_idx, a.status, a.duration_ms,
  a.input_tokens, a.output_tokens, a.cache_read_input_tokens,
  e.weighted_aggregate, e.hallucination_count, e.schema_invalid
FROM attempts a
LEFT JOIN evaluations e
  ON e.run_id = a.run_id AND e.case_id = a.case_id AND e.attempt_id = a.attempt_id
WHERE a.run_id = $1
ORDER BY a.case_id, a.attempt_idx;
```

Index: `attempts_run_case`. ≤ 10ms for 150 rows.

---

### 5.3 Compare runs (`GET /api/v1/compare?a=&b=`)

Three queries — preflight, aggregate, case-level:

```sql
-- 5.3a Preflight: dataset compatibility
SELECT
  a.dataset_hash AS a_ds, b.dataset_hash AS b_ds,
  a.case_count   AS a_cc, b.case_count   AS b_cc,
  a.status       AS a_st, b.status       AS b_st
FROM runs a CROSS JOIN runs b
WHERE a.run_id = $1 AND b.run_id = $2;

-- 5.3b Per-field aggregate diff (powered by field_aggregates)
SELECT
  COALESCE(fa.field_path, fb.field_path) AS field_path,
  fa.primary_score AS a, fb.primary_score AS b,
  (fb.primary_score - fa.primary_score) AS delta,
  CASE
    WHEN fb.primary_score > fa.primary_score THEN 'b'
    WHEN fa.primary_score > fb.primary_score THEN 'a'
    ELSE 'tie'
  END AS winner
FROM field_aggregates fa
FULL OUTER JOIN field_aggregates fb
  ON fa.field_path = fb.field_path AND fb.run_id = $2 AND fb.tag_facet IS NULL
WHERE fa.run_id = $1 AND fa.tag_facet IS NULL;

-- 5.3c Per-case bucketing (improved / regressed / unchanged) + failure breakdown
SELECT
  ea.case_id,
  ea.final_status         AS a_status,
  eb.final_status         AS b_status,
  ea.weighted_aggregate   AS a,
  eb.weighted_aggregate   AS b,
  (COALESCE(eb.weighted_aggregate, 0) - COALESCE(ea.weighted_aggregate, 0)) AS delta
FROM evaluations ea
JOIN evaluations eb ON ea.case_id = eb.case_id AND eb.run_id = $2
WHERE ea.run_id = $1
ORDER BY delta DESC;

-- 5.3d Failure-mode breakdown (powers compare-view "where did B regress?")
SELECT
  final_status,
  COUNT(*) AS n
FROM evaluations
WHERE run_id IN ($1, $2)
GROUP BY run_id, final_status;
```

Indexes: `evaluations_run_case` covers 5.3c with two index lookups; `field_aggregates` PK covers 5.3b. Total ≤ 30ms for 50 cases × 14 fields.

---

### 5.4 Resume detection (`POST /api/v1/runs/:id/resume`)

```sql
-- Stale in-flight (attempt held a slot but no heartbeat)
SELECT attempt_id, run_id, case_id, attempt_idx, idempotency_key
FROM attempts
WHERE run_id = $1
  AND status IN ('queued','in_flight')
  AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '30 seconds')
ORDER BY case_id, attempt_idx;
```

Index: `attempts_resume_scan` (partial — only indexes rows in those statuses). ≤ 1ms even at 1000 attempts.

---

### 5.5 SSE replay (`GET /api/v1/runs/:id/stream` with `Last-Event-ID`)

```sql
SELECT event_id, event_type, payload_jsonb, ts
FROM sse_events
WHERE run_id = $1 AND event_id > $2     -- $2 = Last-Event-ID (UUIDv7 → ordered)
ORDER BY event_id
LIMIT 1000;
```

Index: `sse_events_replay`. ≤ 5ms.

---

### 5.6 Idempotency lookup (every LLM call)

```sql
-- Before any Anthropic call:
SELECT attempt_id, status, predicted_jsonb, raw_response_path,
       input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens
FROM attempts
WHERE idempotency_key = $1
  AND status = 'succeeded'
LIMIT 1;
```

Index: `attempts_idempotency_key` (UNIQUE). O(1). Hit → short-circuit, replay stored response.

---

## 6. Idempotency & Consistency

### 6.1 Idempotency at three layers

| Layer | Key | Behavior |
| --- | --- | --- |
| **Attempt** | `attempts.idempotency_key` (UNIQUE) | Pre-flight SELECT before each Anthropic call (Query 5.6). Hit → use stored response. Implements `IdempotencyAdapter` from contracts §9.1. |
| **Run** | `runs.config_hash` + status filter | `POST /runs` SELECTs `WHERE config_hash = $1 AND status NOT IN ('failed','cancelled')`. Hit + `force=false` → 200 with `cached: true`. |
| **Evaluation** | `evaluations (run_id, case_id)` UNIQUE | Re-running scoring on the same case is an UPSERT. Lets `IEvaluatorService.rebuildAggregates` be safely re-runnable. |

### 6.2 Consistency rules

**Attempt write — single transaction, atomic:**
```
BEGIN;
  INSERT INTO attempts (...) ...;
  INSERT INTO traces (..., 'persisted') ...;
  -- Update parent run counters atomically:
  UPDATE runs SET
    case_completed = case_completed + 1,
    case_succeeded = case_succeeded + (CASE WHEN $status = 'succeeded' THEN 1 ELSE 0 END),
    case_failed    = case_failed    + (CASE WHEN $status LIKE 'failed_%' THEN 1 ELSE 0 END),
    case_in_flight = case_in_flight - 1,
    total_input_tokens          = total_input_tokens          + $input_tokens,
    total_output_tokens         = total_output_tokens         + $output_tokens,
    total_cache_read_tokens     = total_cache_read_tokens     + $cache_read,
    total_cache_creation_tokens = total_cache_creation_tokens + $cache_creation,
    total_cost_usd              = total_cost_usd              + $attempt_cost
  WHERE run_id = $run_id;
COMMIT;
```

**Case-final write — single transaction (succeeds OR fails-out):**
```
BEGIN;
  -- Always write an evaluations row, regardless of outcome:
  INSERT INTO evaluations (run_id, case_id, attempt_id, final_status,
                           termination_reason, weighted_aggregate, ...,
                           schema_invalid, hallucination_count, duration_ms)
       VALUES (...)
  ON CONFLICT (run_id, case_id) DO UPDATE SET
       final_status        = EXCLUDED.final_status,
       weighted_aggregate  = EXCLUDED.weighted_aggregate,
       hallucination_count = EXCLUDED.hallucination_count,
       ... ;

  -- Score rows only on success:
  IF $final_status = 'succeeded' THEN
    INSERT INTO scores (...) (append-only, no conflict resolution);
  END IF;
COMMIT;
```

**Why this shape** — the `final_status` column is the single point of truth for "did this case end well?" Compare and runs-list queries never need to special-case missing rows. Failure cases get an eval row with `weighted_aggregate IS NULL` (excluded from averages by default in `AVG()`).

### 6.3 Resume safety

The resume scanner (Query 5.4) reads stale rows. For each, the runner:

1. Computes the `idempotency_key` from `(model, prompt_hash, tools_hash, temperature, max_tokens, case_id, attempt_idx)`.
2. Checks `attempts WHERE idempotency_key = $1 AND status = 'succeeded'`.
3. If hit → mark this stale attempt `failed_terminal` with `retry_reason = 'superseded_by_idempotent_replay'`, do NOT re-call Anthropic.
4. If miss → re-enqueue with the *same* idempotency_key. If the original call did succeed but failed to write, the next response will dedupe at the attempt level (`UNIQUE (idempotency_key)`).

This guarantees **no double-charge** even if the database write succeeded but the SSE notification didn't.

### 6.4 Dataset-version safety

`runs.dataset_hash` REFERENCES `dataset_versions(dataset_hash)`. To swap the eval set, the operator must:

1. Add a row to `dataset_versions`.
2. Insert new `cases` + `gold_records`.
3. Start runs against the new hash.
4. Cross-version compare is rejected at the API layer (`CompareResponse.dataset_hash_match = false` unless `?allow_cross_dataset=true`).

The schema thus encodes the brief's reproducibility requirement at the FK level.

### 6.5 Pricing-snapshot safety

`attempts.cost_*_usd` is computed at write time using whatever pricing constants the running server has compiled in. **Pricing changes never retroactively affect historical runs**. The `runs.total_cost_usd` is the sum of frozen attempt costs.

---

## Notes on Migration Order

Drizzle migrations should land in dependency order:

```
1. dataset_versions
2. cases, gold_records
3. prompt_templates
4. strategy_registry, scorer_registry
5. runs
6. attempts
7. evaluations, scores, field_aggregates
8. traces (with monthly partition rotation set up here)
9. sse_events
```

Each migration is reversible (DROP TABLE in reverse order) for dev resets. Production migrations are forward-only.

---

## What This Schema Does *NOT* Do

Aligned with [approach.md](approach.md) §"What We're NOT Building":

- **No user / auth tables** — better-auth uses its own tables (already in `packages/db/src/schema/auth.ts`); we never reference them.
- **No multi-tenant scoping** (no `org_id` columns) — single-tenant by design.
- **No vector / embedding columns** — no RAG layer.
- **No `prompt_diff` / `prompt_history` table** — handled by `prompt_templates` content addressing; diffs are computed on read.
- **No prompt-edit UI table** — prompts live in code, the `strategy_registry` table is a read-only mirror.

---

*End of `entities.md`. This schema is the persistence-layer source of truth and maps 1:1 to Drizzle definitions in `packages/db/src/schema/`.*
