# RunnerService — Design

> Orchestration layer for the HEALOSBENCH eval harness. Strict design only — no code.
> Source-of-truth refs: [contracts.md](contracts.md) (interfaces), [entities.md](entities.md) (DB), [lld.md](lld.md) (patterns), [approach.md](approach.md) (build plan).
>
> Architecture (fixed): **Controller → RunnerService → ExtractorService → Validator → EvaluatorService → Repository**.

---

## Table of Contents

1. [Responsibilities](#1-responsibilities)
2. [Execution Flow](#2-execution-flow)
3. [Component Interactions](#3-component-interactions)
4. [Data Flow](#4-data-flow)
5. [State Machine](#5-state-machine)
6. [Retry Logic](#6-retry-logic)
7. [Concurrency Model](#7-concurrency-model)
8. [Idempotency Handling](#8-idempotency-handling)
9. [Failure Modes](#9-failure-modes)
10. [Minimal Implementation Scope (V1)](#10-minimal-implementation-scope-v1)

---

## 1. Responsibilities

### 1.1 What RunnerService DOES

- **Run lifecycle**: create the `runs` row, mark `running`, mark `completed` / `failed` / `cancelled` with timestamps.
- **Case fan-out**: enumerate cases for the run (full dataset or `case_filter`), iterate them with bounded concurrency.
- **Per-case orchestration**: invoke `ExtractorService.extract()`, then on success invoke `EvaluatorService.scoreCase()`, then write counters.
- **Counter denormalization**: atomically update `runs.case_completed`, `case_succeeded`, `case_failed`, `case_in_flight`, plus token/cost aggregates after each case. (Mapping to entities.md §6.2 "Attempt write" transaction.)
- **Resume**: on `POST /runs/:id/resume`, build a `ResumePlan` (contracts §10.2) from `attempts` in `queued` / stale `in_flight`, re-enqueue with the same `idempotency_key`.
- **Idempotency at run level**: before creating a new run, look up `runs.config_hash`; return cached `run_id` if `force=false` and a matching prior run exists.
- **Cost guardrail enforcement**: if `RunConfig.cost_cap_usd` is set, fail the run cleanly when `runs.total_cost_usd` exceeds the cap (between cases — never mid-attempt).
- **SSE event emission**: publish `run_started`, `attempt_started`, `attempt_completed`, `validation_failed`, `case_scored`, `run_progress`, `run_completed`, `run_failed` to the `EventBus` (contracts §12.1) at the right boundaries.

### 1.2 What RunnerService does NOT do

- **Build prompts** — that's `IStrategy.buildMessages()` invoked by `ExtractorService`.
- **Call the LLM** — that's `ILLMAdapter.extract()` invoked by `ExtractorService`.
- **Validate output** — that's `IValidatorChain.validate()` invoked by `ExtractorService`.
- **Score cases** — that's `IEvaluatorService.scoreCase()` invoked by Runner *after* a successful extraction.
- **Persist attempts / scores / traces directly** — those are owned by `ExtractorService` and `EvaluatorService` via their respective repositories. Runner only writes to the `runs` row and emits SSE events.
- **Decide retry-with-feedback semantics** — the validation-feedback loop lives entirely inside `ExtractorService.extract()`. Runner only sees the final `ExtractionResult`.
- **Apply rate-limit / 429-529 retries** — those live in the `LLMAdapter` decorator stack (contracts §9.1). Runner is unaware of HTTP-level retries.
- **Manage strategy registration** — `IStrategyRegistry` is read-only at Runner; it just resolves a name to an `IStrategy`.

This separation keeps Runner narrow: **it orchestrates, it does not extract or evaluate.**

---

## 2. Execution Flow

Four methods. All other internal state lives in instance fields (concurrency limiter, dataset reference, event bus handle).

### 2.1 `startRun(config: RunConfig): Promise<{ run_id: RunId }>`

```
  1. Resolve strategy:   strategy = strategyRegistry.get(config.strategy)
                         throw if not found.
  2. Compute hashes:     prompt_hash  = strategy.promptHash()
                         tools_hash   = hash(tool_definitions)
                         schema_hash  = hash(input_schema)
                         dataset_hash = dataset.load() → manifest.dataset_hash
                         config_hash  = hash(config + 4 hashes)
  3. Idempotency check:  runRepo.findByConfigHash(config_hash)
                         if hit AND !config.force → return cached run_id.
  4. (Optional) cost projection:
                         if config.cost_cap_usd → costGuardrail.project()
                         and enforcePreRun(); throw 422 on breach.
  5. Persist row:        runId = newRunId()    // UUIDv7 from packages/shared
                         runRepo.create({ runId, status: "queued", ...hashes,
                                          configJsonb: config, caseCount })
  6. Hand off async:     queueMicrotask(() => processRun(runId))
  7. Return:             { run_id: runId }
```

**Returns immediately** with HTTP 202; the actual work runs in the background. The caller subscribes to SSE for progress.

### 2.2 `processRun(runId: RunId): Promise<void>`

```
  1. Mark running:       runRepo.updateStatus(runId, "running")
                         emit RunStartedEvent.
  2. Load case set:      cases = dataset.filter(config.case_filter)
                         golds  = goldRepo.loadAll()
  3. Bounded fan-out:    for each case in cases (concurrency-limited):
                            await processCase(runId, case, golds[case.case_id])
  4. Wait for drain:     all in-flight cases settle (success or terminal fail).
  5. (Optional) aggregate: evaluatorService.aggregateRun(runId)
                         → populates field_aggregates table.
  6. Mark complete:      runRepo.markCompleted(runId, durationMs)
                         emit RunCompletedEvent.
  7. On unrecoverable error (auth, dataset hash mismatch, cost cap mid-run):
                         runRepo.updateStatus(runId, "failed")
                         emit RunFailedEvent.
```

**Never throws to the caller** — `startRun` already returned. Errors are persisted to `runs.status = "failed"` and surfaced via SSE.

### 2.3 `processCase(runId, case, gold): Promise<void>`

This is the per-case unit of work. One case = one `evaluations` row regardless of outcome.

```
  1. Counter increment:  runRepo.incrementCounters({ inFlightDelta: +1 })
  2. Extract:            result = await extractorService.extract({
                            run_id: runId, case_id: case.case_id,
                            transcript: case.transcript,
                            strategy_name: config.strategy,
                            max_attempts: config.max_attempts ?? 3
                         })
                         // → ExtractionResult (contracts §4) with up-to-3 attempts,
                         //   final_status: FinalStatus, final_output | null.
                         // Extractor has already persisted attempts + traces.
  3. Branch on result:
       if result.final_status === "succeeded":
            evaluation = await evaluatorService.scoreCase({
                run_id: runId,
                attempt_id: lastSucceededAttempt.attempt_id,
                case_id: case.case_id,
                predicted: result.final_output,
                gold: gold.gold,
                transcript: case.transcript,
                schema_invalid: false,
                hallucination_count: result.lastValidation.hallucination_count,
                tags: case.tags
            })
            // Evaluator persists evaluations + scores rows.
            emit CaseScoredEvent(weighted_aggregate, per_field, ...)

       else (final_status is one of failed_*, cancelled, cost_cap_exceeded):
            evalRepo.upsert({
                run_id: runId, case_id: case.case_id,
                attempt_id: lastAttempt.attempt_id,
                final_status: result.final_status,
                weighted_aggregate: null,
                schema_invalid: ...,
                hallucination_count: ...,
            })
            // Per entities.md §1.7 — failed cases still get an evaluations row,
            //   weighted_aggregate IS NULL, final_status carries the reason.

  4. Counter update:     runRepo.incrementCounters({
                            completedDelta: +1,
                            succeededDelta: result.final_status === "succeeded" ? +1 : 0,
                            failedDelta:    result.final_status === "succeeded" ? 0 : +1,
                            inFlightDelta: -1,
                            inputTokens / outputTokens / cache_* / costUsd from result
                         })
  5. Progress emit:      every K cases (e.g. K=5) emit RunProgressEvent.
```

`processCase` **never throws** — every terminal outcome (success or failure) results in a clean `evaluations` row + counter update. Exceptions inside Extractor are converted to `FinalStatus = "failed_*"` before reaching here.

### 2.4 `processAttempt` — explicitly NOT in Runner

The retry-with-feedback loop (3 attempts max) lives entirely inside `ExtractorService.extract()`. Runner sees only the final `ExtractionResult`. This boundary is critical:

- Runner cannot inspect intermediate validation state.
- Runner cannot decide whether to retry based on the validation result.
- Runner cannot mutate the message payload.

If Runner needed to do any of those, the abstraction would be wrong (and the strategy registry would be coupled to the orchestrator). See [lld.md §2.6 Template Method] — the retry skeleton is owned by Extractor, the message building varies by Strategy.

---

## 3. Component Interactions

```
                     ┌──────────────────────────┐
                     │      RunController       │
                     │  POST /runs · /:id ·     │
                     │  /:id/stream · /:id/resume│
                     └─────────┬────────────────┘
                               │ start / resume / cancel
                               ▼
                     ┌──────────────────────────┐
                     │     RunnerService        │
                     │                          │
                     │  startRun(config)        │
                     │  processRun(runId)       │
                     │  processCase(runId,c,g)  │
                     │  resume(runId)           │
                     │  cancel(runId)           │
                     └─┬──────┬──────┬──────┬──┘
            ┌──────────┘      │      │      └──────────┐
            ▼                 ▼      ▼                 ▼
   ┌─────────────────┐  ┌────────┐ ┌────────────┐ ┌──────────────┐
   │ ExtractorService│  │EventBus│ │EvaluatorSvc│ │ Repositories │
   │                 │  │        │ │            │ │              │
   │  extract()      │  │publish │ │ scoreCase()│ │ run / attempt│
   │   ↓ owns:       │  │        │ │  ↓ owns:   │ │ score / trace│
   │   ValidatorChn  │  │        │ │  Scorers   │ │ evaluation   │
   │   LLMAdapter    │  │        │ │            │ │              │
   │   StrategyReg.  │  │        │ │            │ │              │
   │   AttemptRepo   │  │        │ │ ScoreRepo  │ │              │
   │   TraceRepo     │  │        │ │ EvalRepo   │ │              │
   └─────────────────┘  └────────┘ └────────────┘ └──────────────┘
```

### 3.1 Runner ↔ ExtractorService

- **Call**: `extractorService.extract({ run_id, case_id, transcript, strategy_name, max_attempts })`
- **Receives**: `ExtractionResult` (contracts §4) — chronological list of attempts (length 1–3), `final_status: FinalStatus`, optional `final_output`, total usage/cost, total duration.
- **Side effects already done by Extractor before returning**: attempts persisted, traces emitted, validation results captured, raw response files written.
- **Contract**: Extractor never throws on routine failure (schema_invalid, grounding, rate_limit). Returns a `FinalStatus`. Throws only on programmer errors (e.g. unknown strategy name, malformed input).

### 3.2 Runner ↔ Validator (indirect)

Runner never calls a Validator directly. The validation chain (`SchemaValidator → GroundingValidator`) is owned by `ExtractorService`. Runner only sees `ValidationResult` aggregated into `Attempt.validation_result` and the final `ExtractionResult.lastValidation`.

### 3.3 Runner ↔ EvaluatorService

- **Call**: `evaluatorService.scoreCase({ run_id, attempt_id, case_id, predicted, gold, transcript, schema_invalid, hallucination_count, tags? })`
- **Receives**: `EvaluationResult` (contracts §7) — per-field aggregates, weighted score, grounded field rate.
- **Side effects already done by Evaluator**: `scores` rows inserted, `evaluations` row upserted.
- **Called only on `final_status === "succeeded"`**. For terminal failures, Runner upserts a stub `evaluations` row directly with `weighted_aggregate = null` (the CHECK constraint allows this; entities.md §1.7).

### 3.4 Runner ↔ Repositories

- **`IRunRepository`**: `create`, `findByConfigHash`, `findById`, `updateStatus`, `markCompleted`, `incrementCounters`. No other consumer touches `runs`.
- **`IEvaluationRepository`**: only the failure-path stub upsert (so every case has an evaluations row regardless of outcome).
- **`IAttemptRepository`**: read-only for Runner (`findStaleInFlight` during resume, `listForRun` during status/aggregate). Writes are owned by Extractor.
- **`IScoreRepository`**: never touched by Runner.
- **`ITraceRepository`**: only via `EventBus.publish()` write-through (Runner never inserts traces directly).

### 3.5 Runner ↔ EventBus

Runner publishes 5 of the 9 SSE event types (`run_started`, `case_scored`, `run_progress`, `run_completed`, `run_failed`). Extractor emits 3 (`attempt_started`, `attempt_completed`, `validation_failed`) since it owns the per-attempt loop. EventBus emits 1 (`heartbeat`) on a 15-second timer.

| Event | Emitted by | When |
| --- | --- | --- |
| `run_started` | Runner | First line of `processRun` after `status = running` |
| `attempt_started` | Extractor | Beginning of each retry-loop iteration |
| `attempt_completed` | Extractor | After validation result is known |
| `validation_failed` | Extractor | When validation fails AND attempt < max |
| `case_scored` | Runner | After successful Evaluator return |
| `run_progress` | Runner | Every K completed cases (configurable, default K=5) |
| `run_completed` | Runner | Last line of `processRun` happy path |
| `run_failed` | Runner | Unrecoverable failure path |
| `heartbeat` | EventBus | Internal — every 15s, emitted by the bus itself |

---

## 4. Data Flow

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  CASE INPUT                                                          │
   │    case.transcript: string  +  gold.gold: ClinicalExtraction         │
   └──────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  EXTRACTOR — retry-with-feedback ≤3                                  │
   │                                                                      │
   │  Strategy.buildMessages()  ─►  MessagePayload                        │
   │    ╲ uses transcript + (optional ValidationFeedback from prev attempt) │
   │                                                                      │
   │  LLMAdapter.extract()  ─►  AsyncIterable<ExtractEvent>                │
   │    ╲ emits tool_use_completed.input  →  predicted: ClinicalExtraction│
   │                                                                      │
   │  ValidatorChain.validate(predicted, transcript)  ─►  ValidationResult│
   │    ╲ schema (AJV/Zod) → grounding (substring + fuzzy)                │
   │                                                                      │
   │  if !valid  AND attempt_idx < max:                                    │
   │     build ValidationFeedback  →  loop with prevFeedback              │
   │                                                                      │
   │  Persist Attempt row                                                 │
   │  Append Trace events                                                 │
   └──────────────────────────┬───────────────────────────────────────────┘
                              │
                              │  ExtractionResult {
                              │    final_status: FinalStatus,
                              │    final_output: ClinicalExtraction | null,
                              │    attempts[], total_usage, total_cost
                              │  }
                              ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  RUNNER — branch on final_status                                     │
   │                                                                      │
   │   if "succeeded":                                                    │
   │     EvaluatorService.scoreCase({predicted, gold, transcript,...})    │
   │        ╲ runs all IScorer impls                                       │
   │        ╲ writes scores rows                                           │
   │        ╲ upserts evaluations row (weighted_aggregate populated)      │
   │     emit CaseScoredEvent                                             │
   │                                                                      │
   │   else "failed_*" / "cancelled" / "cost_cap_exceeded":                │
   │     EvalRepo.upsert(stub row, weighted_aggregate = NULL,             │
   │                     final_status = result.final_status)              │
   │     // no scores rows                                                │
   │                                                                      │
   │   runRepo.incrementCounters(...)                                      │
   └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Storage targets per stage

| Stage | Tables written | Owner |
| --- | --- | --- |
| Run created | `runs` | Runner |
| Each attempt | `attempts`, `traces` | Extractor |
| Each LLM call | `traces` (tool_input_delta etc.) | LLMAdapter (via EventBus write-through) |
| Validation done | `attempts.validation_jsonb` | Extractor |
| Successful case | `evaluations`, `scores` | Evaluator |
| Failed case | `evaluations` (stub) | Runner |
| After every case | `runs.case_*`, `runs.total_*` | Runner |
| Run done | `runs.status`, `runs.completed_at` | Runner |
| End-of-run | `field_aggregates` (optional) | Evaluator (called by Runner) |

---

## 5. State Machine

### 5.1 Run states (`runs.status`)

```
                          startRun()
                              │
                              ▼
                          ┌────────┐
                          │ queued │
                          └────┬───┘
                               │ processRun() begins
                               ▼
                          ┌─────────┐
                          │ running │
                          └────┬────┘
              ┌────────────────┼──────────────────┐
              │                │                  │
       cases drain      cancel() called    unrecoverable
              │                │            failure (auth,
              ▼                ▼            cost_cap,
        ┌───────────┐    ┌───────────┐     internal_error)
        │ completed │    │ cancelled │            │
        └───────────┘    └───────────┘            ▼
                                            ┌────────┐
                                            │ failed │
                                            └────────┘
```

`paused` is reserved for future use (e.g. operator-pause via API). V1 does not transition into it.

### 5.2 Attempt states (`attempts.status`)

```
                        Extractor begins iteration
                                  │
                                  ▼
                            ┌──────────┐
                            │  queued  │     (transient — written
                            └─────┬────┘      between dispatch and
                                  │           the actual LLM call)
                                  ▼
                            ┌───────────┐
                            │ in_flight │
                            └─────┬─────┘
                                  │  LLM call returns
                  ┌───────────────┼───────────────────────────────┐
                  │               │                               │
                  ▼               ▼                               ▼
           ┌───────────┐   ┌────────────────┐            ┌──────────────────┐
           │ succeeded │   │ schema_invalid │            │ rate_limited /   │
           │ (terminal)│   │ grounding_     │            │ overloaded       │
           └───────────┘   │ failed         │            │ (transient HTTP) │
                           └────┬───────────┘            └──────┬───────────┘
                                │                               │
                            attempt_idx < max?              attempt_idx < max?
                                │                               │
                          ┌─────┴─────┐                   ┌─────┴────────┐
                          │           │                   │              │
                          ▼           ▼                   ▼              ▼
                   feedback_retry  failed_terminal    feedback_retry  failed_terminal
                   (next iter)     (loop ends)        (next iter)     (loop ends)
```

**Per-attempt status** is populated as the loop runs. **Per-case `FinalStatus`** (entities.md §1.7) is derived at loop exit and stored on the `evaluations` row. Status enums are deliberately different granularities — see [contracts.md §4 FinalStatus] for the 11-value union.

---

## 6. Retry Logic

### 6.1 Three independent retry budgets

Per [approach.md §Step 3] and [contracts.md §6]:

| Budget | Owner | Trigger | Max | Backoff |
| --- | --- | --- | --- | --- |
| **Validation feedback** | Extractor | schema_invalid OR grounding_failed | 3 | None — feedback inline |
| **HTTP 429 rate-limit** | LLMAdapter (RateLimitedAdapter) | `error_kind = rate_limit_429` | 3 | Honor `retry-after` from headers |
| **HTTP 529 / 5xx** | LLMAdapter (RetryingAdapter) | `error_kind = overloaded_529` etc. | 5 | Full-jitter exponential |

Runner does NOT manage any of these. It sees only the final outcome.

### 6.2 Validation-feedback flow (inside Extractor — for context)

```
   attempt 1:
     buildMessages(prev=null) → call LLM → predicted
     validate(predicted) → ValidationResult
     if ok: return success
     else: build ValidationFeedback {
        attempt_idx: 1,
        prior_tool_use_id: <from this attempt>,
        errors: [{ error_type, field, message, hint }, ...],
        hint: "Top-level summary"
     }

   attempt 2:
     buildMessages(prev=feedback)
       → strategy injects a tool_result block with is_error: true,
         content = JSON.stringify({schema_version:1, feedback})
     call LLM (cache-read on the prefix!) → predicted
     validate again ...

   attempt 3:
     same as attempt 2
     if still failing → final_status determined by failure pattern:
       all-schema-fails → "failed_schema_unrecoverable"
       all-grounding   → "failed_grounding_unrecoverable"
       mixed           → "failed_mixed"
```

### 6.3 Feedback wire shape (contracts §6)

```
   {
     "schema_version": 1,
     "feedback": {
       "attempt_idx": 2,
       "prior_tool_use_id": "toolu_abc...",
       "errors": [
         { "error_type": "schema_required_missing",
           "field": "medications[0].dose",
           "message": "required field missing",
           "hint": "Quote the dose verbatim from transcript."
         }
       ],
       "hint": "Fix the listed errors, re-call extract_clinical."
     }
   }
```

This is encoded inside a `tool_result` block with `is_error: true` and sent as the next user turn. The LLM has been trained on this shape.

### 6.4 Retry counter & idempotency

Each attempt has a different `attempt_idx ∈ {1, 2, 3}` and therefore a different `idempotency_key` (the key includes `attempt_idx`). This is intentional — replaying attempt 2 must not deduplicate against attempt 1's stored response.

---

## 7. Concurrency Model

### 7.1 V1 — single-threaded sequential

```
   processRun:
     for case of cases:
        await processCase(runId, case, gold)
```

Simple, debuggable, no race conditions on counters. Acceptable because the LLM call dominates wall time (~1–3 s per attempt) — sequentialism makes a 50-case run take ~1–3 minutes. Within the brief's tolerance.

### 7.2 V2 — bounded concurrency (~5)

Per [approach.md §Step 6] and [contracts.md §10 RunnerSettings]:

```
   limiter = Bottleneck({
     maxConcurrent:           5,
     minTime:                 1200,   // 50 RPM cap
     reservoir:               50,
     reservoirRefreshAmount:  50,
     reservoirRefreshInterval: 60_000,
   })

   processRun:
     for case of cases:
        limiter.schedule(() => processCase(runId, case, gold))
     await limiter.drain()
```

Plus **ramp-up** from `2 → 5` over the first 30 s to dodge Anthropic's acceleration-limit 429s.

### 7.3 V2.1 — adaptive throttle

After every LLM response, the LLMAdapter reads `anthropic-ratelimit-{requests,input-tokens,output-tokens}-remaining` headers. If `remaining < threshold`, the adapter signals the limiter to clamp the next dispatch. Runner stays oblivious — this lives entirely in `RateLimitedAdapter`.

### 7.4 Counter race safety

Even with concurrency, `runs` counter updates must be atomic. Two options:

- **A)** Use SQL `UPDATE runs SET case_completed = case_completed + 1, ...` — Postgres MVCC handles concurrent increments.
- **B)** Use `SELECT ... FOR UPDATE` then update — explicit but slower.

V1/V2 use **(A)** — Postgres handles it for free. (The `runRepo.incrementCounters` method is already shaped this way per the existing repo skeleton.)

---

## 8. Idempotency Handling

Three layers, each owned by a different component.

### 8.1 Run-level idempotency (Runner)

```
   key = config_hash = sha256(
            promptHash + toolsHash + schemaHash + datasetHash
            + canonicalJson(config without notes/force)
         )

   if runRepo.findByConfigHash(key) AND !config.force:
       return cached.run_id   // 200 with cached: true
   else:
       runRepo.create({ runId: newRunId(), configHash: key, ... })
```

Indexed via `runs_config_hash` partial index (entities.md §3.1) — only matches runs in non-terminal-failure states. Idempotency degrades gracefully: a previously-failed run does not block a new attempt.

### 8.2 Attempt-level idempotency (Extractor + LLMAdapter)

```
   idempotency_key = sha256(
       model + prompt_hash + tools_hash + temperature + max_tokens
       + case_id + attempt_idx
   )

   // Inside IdempotencyAdapter (LLMAdapter decorator):
   existing = attemptRepo.findByIdempotencyKey(idempotency_key)
   if existing.status === "succeeded":
       return existing.predicted_jsonb  // skip the LLM call entirely
   else:
       proceed with real call
```

Indexed via `attempts_idempotency_key` UNIQUE (entities.md §3.1). Mandatory because resume must not re-charge.

### 8.3 Evaluation-level idempotency (Evaluator)

```
   evalRepo.upsert({ run_id, case_id, ... })
     ON CONFLICT (run_id, case_id) DO UPDATE SET ...
```

Lets `IEvaluatorService.rebuildAggregates(runId)` be safely re-runnable — useful when a scorer version is bumped and old runs need re-scoring without re-extraction.

### 8.4 What Runner does on resume

```
   resume(runId):
     1. Build ResumePlan via attemptRepo.findStaleInFlight(runId, heartbeat=30s)
     2. For each stale attempt:
          a. Compute idempotency_key from its (model, prompt_hash, ..., attempt_idx)
          b. Check attemptRepo.findByIdempotencyKey(key)
          c. If hit AND status === "succeeded":
               mark stale row "failed_terminal" with retry_reason =
               "superseded_by_idempotent_replay" — do NOT re-call LLM
          d. Else: re-enqueue with the SAME idempotency_key
     3. Resume normal processRun loop from where queue stands.
     4. Return { resumed_attempts: count }
```

This guarantees **zero double-charge** even if the original DB write succeeded but the SSE notification didn't. (Per entities.md §6.3.)

---

## 9. Failure Modes

### 9.1 Per-attempt failures (handled by Extractor)

| Failure | `attempts.status` | Loop continues? | Eventual `FinalStatus` if exhausted |
| --- | --- | :-: | --- |
| Schema-invalid output | `schema_invalid` | yes | `failed_schema_unrecoverable` |
| Grounding miss | `grounding_failed` | yes | `failed_grounding_unrecoverable` |
| Mixed (e.g. 1× schema, 1× grounding) | varies | yes | `failed_mixed` |
| 429 rate-limit | `rate_limited` | yes (HTTP retry inside adapter) | `failed_rate_limited` |
| 529 / 5xx overloaded | `overloaded` | yes (HTTP retry inside adapter) | `failed_overloaded` |

### 9.2 Per-case unrecoverable failures (visible to Runner)

| Failure | Source | `FinalStatus` |
| --- | --- | --- |
| 401/403 auth error | LLMAdapter | `failed_auth` |
| 413 request too large | LLMAdapter | `failed_request_too_large` |
| Network/timeout exhausted | LLMAdapter | `failed_timeout` |
| Cost cap exceeded mid-run | Runner (cost guardrail) | `cost_cap_exceeded` |
| User cancelled | Runner | `cancelled` |

For all of these: Runner upserts a stub `evaluations` row, increments `case_failed`, emits `attempt_completed` (carried through from Extractor) and continues to the next case.

### 9.3 Run-level catastrophic failures

Some failures terminate the entire run, not just one case:

- **`failed_auth` on first attempt** — almost certainly a bad API key. Runner aborts the loop, marks `runs.status = "failed"`, emits `RunFailedEvent { reason: "auth_error" }`.
- **Cost cap exceeded** — Runner emits `RunFailedEvent { reason: "cost_cap_exceeded" }`, drains in-flight cases, marks `runs.status = "failed"`.
- **Operator cancel** — `runner.cancel(runId)` flips `runs.status = "cancelled"`, signals the limiter to drain, emits `RunFailedEvent { reason: "cancelled" }`.
- **Internal exception** (unexpected throw inside Runner — bug) — caught at the top of `processRun`, marks run failed, emits `RunFailedEvent { reason: "internal_error" }`. Should never happen in production; logged with full stack.

### 9.4 Failure-isolation guarantee

**One failed case must never abort the run.** A single `failed_grounding_unrecoverable` does NOT propagate to `runs.status`. The run is `completed` if any case succeeded; the per-case failures are visible via `evaluations.final_status` in the compare view.

The only exceptions are the four run-level failures in §9.3.

---

## 10. Minimal Implementation Scope (V1)

Per [approach.md §"If time is tight"], V1 ships with a deliberately narrow surface. This is the build order:

### 10.1 V1 — the smallest thing that scores one case

```
   ✓ Single run                    (one run_id, one config)
   ✓ Single case at a time          (sequential loop, no concurrency)
   ✓ Single attempt only            (max_attempts: 1, no retry)
   ✓ zero_shot strategy only        (one IStrategy, no registry switching)
   ✓ IMockLLMAdapter                (no real Anthropic call — contracts §15.1)
   ✓ Schema validator               (Zod safeParse)
   ✓ Grounding validator            (substring only, no fuzzy window)
   ✓ Three scorers                  (chief_complaint fuzzy, vitals exact, plan set-F1)
   ✓ Repository writes              (runs, attempts, evaluations, scores)
   ✗ No SSE                         (poll GET /runs/:id for progress)
   ✗ No prompt caching              (mock returns canned response anyway)
   ✗ No idempotency                 (every run is a new run)
   ✗ No resume                      (kill + restart = lose work)
   ✗ No cost guardrail
   ✗ No bootstrap CI
   ✗ No tag facets
```

**Verification gate**: `bun run eval -- --strategy=zero_shot` runs end-to-end on 1 case, prints `weighted_aggregate` to stdout, exits 0.

### 10.2 V2 — retry + concurrency + SSE

Add in this order:

```
   1. Retry-with-feedback inside Extractor (max 3, max_attempts: 3)
   2. Real AnthropicAdapter (replace mock — gated behind env flag)
   3. Bottleneck concurrency in Runner (5 in-flight, ramp 2→5 over 30s)
   4. EventBus + SSE endpoint
   5. Idempotency at attempt level (IdempotencyAdapter decorator)
   6. Resume endpoint (ResumeService)
   7. Prompt caching (cache_control breakpoints in PromptBuilder)
```

Each step is independently shippable and testable.

### 10.3 V3 — the headline screen

```
   8. Compare view (CompareService + /api/v1/compare endpoint)
   9. Bootstrap CI on aggregate delta
  10. Run detail UI in apps/web (transcript highlighting, retry trace)
  11. Few-shot strategy + CoT strategy
  12. Tag facets + faceted aggregates
```

### 10.4 What never lands in V1–V3

Per [approach.md §"What We're NOT Building"]:

- Multi-tenant scoping
- Auth integration (better-auth tables exist but unused)
- Vector / RAG layer
- Self-Consistency, Tree-of-Thoughts (N×-cost strategies, off-budget)
- Prompt-edit UI (prompts live in code only)

---

## Implementation Checklist

This design is implementable in the order below — each row is one PR-sized change.

```
   1. RunnerService.startRun()                         ~50 LOC
   2. RunnerService.processRun() — sequential          ~80 LOC
   3. RunnerService.processCase() — happy path only    ~60 LOC
   4. processCase failure-path stub eval upsert        ~30 LOC
   5. CLI wiring: bun run eval -- --strategy=...       ~40 LOC
   ─── V1 ships here ───────────────────────────────────────────
   6. Extractor retry-with-feedback loop (≤3)         ~120 LOC
   7. Real AnthropicAdapter                           ~150 LOC
   8. Bottleneck concurrency + ramp-up                 ~60 LOC
   9. EventBus + SSE endpoint                          ~80 LOC
  10. ResumeService + /resume endpoint                 ~70 LOC
  11. CostGuardrail + cap enforcement                  ~50 LOC
   ─── V2 ships here ───────────────────────────────────────────
  12. CompareService + /compare endpoint              ~120 LOC
  13. Bootstrap CI                                     ~80 LOC
  14. Compare view UI                                 ~250 LOC
   ─── V3 ships here ───────────────────────────────────────────
```

The boundaries above are the natural separation points. Any future strategy (CoVe, Self-Consistency) lands as a single new file in `packages/llm/src/strategies/` plus one registry-entry line — no Runner changes required (per [lld.md §6 Extension Surfaces]).

---

*End of `runner-design.md`. Ready to implement starting from V1 step 1.*
