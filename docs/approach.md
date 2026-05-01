# Approach — HEALOSBENCH Production Harness (Approach C)

> The build plan we're committing to. See [idea.md](idea.md ) for the full research dossier and architectural alternatives.

---

## TL;DR

We're building **Approach C** — the full production-grade harness — because it's the only one that delivers the headline compare view, which the brief explicitly calls "the most important screen."

```
  Approach        Hits 10 hard reqs?    Has compare UI?    Verdict
  ─────────────────────────────────────────────────────────────────
  A (script)         3/10                  ❌              Toy
  B (server, no UI)  8/10                  ❌ (text only)  Misses headline
  C (full stack)     10/10                 ✅              ✅ Ship this
```

Target effort: **8–12 focused hours**. Target cost: **<$1 per 50-case × 3-strategy run**.

---

## What "Approach C" Means

The full monorepo as already wired: **Next.js 16 dashboard + Hono server + Postgres/Drizzle + bun workspaces + Turborepo**, with a CLI on top. SSE streaming, real compare view, run detail with field-level diff and trace.

```
              ┌─────────────────────────────────────────┐
              │  apps/web (Next.js 16) — client only    │
              │  • Runs list                            │
              │  • Run detail (transcript + diff +trace)│
              │  • ⭐ Compare view                      │
              └────────────────┬────────────────────────┘
                               │ SSE + REST
                               ▼
              ┌─────────────────────────────────────────┐
              │  apps/server (Hono :8787)               │
              │  ┌───────────────────────────────────┐  │
              │  │ Runner — bounded concurrency (5)  │  │
              │  │ Strategy layer (zero/few/cot)     │  │
              │  │ Extractor (tool-use + caching)    │  │
              │  │ Retry-with-feedback ≤3            │  │
              │  │ Validator + grounding             │  │
              │  │ Evaluator (10+ field scorers)     │  │
              │  └─────────────────┬─────────────────┘  │
              └────────────────────┼────────────────────┘
                                   ▼
              ┌─────────────────────────────────────────┐
              │  Postgres + Drizzle                     │
              │  runs · attempts · scores · traces      │
              │  + raw response files on disk           │
              └─────────────────────────────────────────┘
                                   ▲
              ┌────────────────────┴────────────────────┐
              │  CLI: bun run eval -- --strategy=cot    │
              └─────────────────────────────────────────┘
                                   ▲
                          Anthropic Messages API
                       (Haiku 4.5 · strict tool-use)
```

---

## The 10 Hard Requirements — Where Each One Lives

```
  ✓ 1.  Tool use / structured output         → packages/llm (strict tool-use)
  ✓ 2.  Retry-with-feedback ≤3, all logged   → extract.service.ts + traces table
  ✓ 3.  Prompt caching, verified             → packages/llm cache_control + run summary
  ✓ 4.  Concurrency control (no Promise.all) → runner.service.ts (bottleneck)
  ✓ 5.  Resumable runs                       → runner.service.ts + attempts state machine
  ✓ 6.  Per-field metrics matched to type    → evaluate.service.ts (10+ scorers)
  ✓ 7.  Hallucination detection              → grounding detector (substring + fuzzy window)
  ✓ 8.  Compare view with deltas + winner    → apps/web /runs/compare
  ✓ 9.  ≥8 tests                             → __tests__/
  ✓ 10. No API key in browser                → web → Hono → Anthropic only
```

---

## Build Plan — 12.5 Hours, In Order

```
  ┌──────────────────────────────────────────────────────┬──────┐
  │ STEP                                                 │ TIME │
  ├──────────────────────────────────────────────────────┼──────┤
  │ 1.  Schema + types (Zod ↔ JSON Schema)               │ 0.5h │
  │ 2.  packages/llm: strategy registry + cached prompts │ 1.5h │
  │ 3.  Retry-with-feedback loop                         │ 1.0h │
  │ 4.  Validator + grounding detector                   │ 1.5h │
  │ 5.  Per-field scorers (10+ atomic)                   │ 1.5h │
  │ 6.  Runner: concurrency + bottleneck + resume        │ 1.0h │
  │ 7.  API routes + SSE                                 │ 0.5h │
  │ 8.  DB schema + migrations                           │ 0.5h │
  │ 9.  ⭐ Compare view (the headline screen)            │ 2.0h │
  │ 10. Run detail + trace view                          │ 1.0h │
  │ 11. Tests (≥8)                                       │ 1.0h │
  │ 12. CLI + smoke run + NOTES.md                       │ 0.5h │
  ├──────────────────────────────────────────────────────┼──────┤
  │ TOTAL                                                │12.5h │
  └──────────────────────────────────────────────────────┴──────┘
```

**If time is tight:** the brief explicitly allows *"a polished 35-case version beats a buggy 50-case one."* Cut transcript count before cutting any hard requirement.

---

## Step-by-Step Detail

### Step 1 — Schema + Types (0.5h)

Single source of truth. Zod schema for runtime validation; auto-derive the JSON Schema sent to Anthropic via `zod-to-json-schema`. Place in `packages/shared`.

```
  packages/shared/src/
   ├── schema.ts           Zod ClinicalExtractionSchema
   ├── jsonSchema.ts       Derived JSON Schema for Anthropic tool input
   └── types.ts            Run, Attempt, Score, Trace, Compare DTOs
```

Verify: import from both `apps/server` and `apps/web` cleanly.

### Step 2 — `packages/llm` (1.5h)

The Anthropic SDK wrapper. The hardest part to get right.

```
  packages/llm/src/
   ├── client.ts           Anthropic SDK init, model pinning
   ├── strategies/
   │    ├── zeroShot.ts    Builds messages for strategy A
   │    ├── fewShot.ts     Builds messages for strategy B (k=3 examples)
   │    └── cot.ts         Builds messages for strategy C (<thinking> CoT)
   ├── tool.ts             extract_clinical tool definition + cache_control
   ├── promptHash.ts       sha256 of rendered prompt
   └── extract.ts          Single-shot extract: messages → tool_use → JSON
```

Key decisions:
- `tool_choice = {type:"tool", name:"extract_clinical"}`, `temperature=0`
- All 3 strategies share tool definition + system prompt (cache breakpoint #1, 1h TTL)
- Strategy-specific suffix gets cache breakpoint #2
- Pad system prompt with reference glossary to clear Haiku 4.5's **4,096-token cache minimum**

### Step 3 — Retry-with-Feedback Loop (1.0h)

Reflexion-shaped. Lives in `apps/server/src/services/extract.service.ts`.

```
   Attempt n:
   ┌─────────────────┐         ┌──────────┐
   │ Send messages   │ ──────> │  Claude  │
   └─────────────────┘ <────── │  Haiku   │
                                └──────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │ AJV schema validate  │
                          │ + grounding check    │
                          └─────────┬────────────┘
                            ✅ pass │ ❌ fail
                                    ▼
                  Append to messages:
                  { role: "user", content: [{
                      type: "tool_result",
                      tool_use_id: <prev>,
                      is_error: true,
                      content: JSON.stringify({
                        schema_errors: [...],
                        grounding_misses: [...],
                        hint: "Quote a verbatim transcript span..."
                      })
                  }]}
                  → re-call (max 3 attempts)
```

Three retry budgets — separate, never share:

```
  ┌──────────────────────┬─────┬──────────────────────────┐
  │ Schema/grounding     │  3  │ None — feedback inline   │
  │ 429 rate-limit       │  3  │ Honor `retry-after`      │
  │ 529 / 5xx overloaded │  5  │ Full-jitter exponential  │
  └──────────────────────┴─────┴──────────────────────────┘
```

### Step 4 — Validator + Grounding Detector (1.5h)

Two layers:
- **AJV strict** post-validation (paranoid second check after Anthropic strict tool-use)
- **Grounding detector**: every leaf string in predicted JSON must appear in transcript via:
  - exact lowercased substring match, OR
  - `token_set_ratio ≥ 0.80` over a sliding ±20-token window

This is Tier-1 hallucination defense — ~100% precision, ~70% recall, deterministic.

### Step 5 — Per-Field Scorers (1.5h)

Table-driven. 10+ atomic scorers in `evaluate.service.ts`. Each is a pure function `(predicted, gold, transcript) → number ∈ [0,1]`.

```
  Field                   Metric                              Library
  ───────────────────────────────────────────────────────────────────
  chief_complaint         token_set_ratio fuzzy               rapidfuzz/JS
  vitals.bp               exact after normalization           regex
  vitals.hr               numeric ±2 BPM                       —
  vitals.temp_f           numeric ±0.2 °F                      —
  vitals.spo2             numeric ±2 %                         —
  medications             set-F1 (name fuzzy + dose+freq      rapidfuzz +
                           canonicalized — BID==twice daily)   custom canon
  diagnoses               set-F1 fuzzy desc + ICD partial      rapidfuzz +
                           credit (1.0 exact, 0.5 prefix)      ICD hierarchy
  plan                    set-F1 token_set_ratio ≥ 0.70        rapidfuzz
  follow_up.interval_days exact (incl. both null)              —
  follow_up.reason        token_set_ratio ≥ 0.70               rapidfuzz
```

Plus aggregate: weighted F1 across fields (medications 2.0×, diagnoses 2.0×, vitals 1.5×, others 1.0×).

### Step 6 — Runner (1.0h)

Bounded concurrency, rate-limit aware, resume-capable.

```
  ┌────────────────────────────────────────────┐
  │  Runner                                    │
  │                                            │
  │  bottleneck({                              │
  │    maxConcurrent: 5,                       │
  │    minTime: 1200,        // 50 RPM cap     │
  │    reservoir: 50,                          │
  │    reservoirRefreshAmount: 50,             │
  │    reservoirRefreshInterval: 60_000        │
  │  })                                        │
  │                                            │
  │  Ramp 2 → 5 over 30s to avoid              │
  │  acceleration-limit 429s                    │
  │                                            │
  │  After each call, read                      │
  │  anthropic-ratelimit-* headers              │
  │  to adjust headroom                         │
  └────────────────────────────────────────────┘
```

**Resume**: on `POST /runs/:id/resume`, scan `attempts WHERE status IN ('queued','in_flight')` and re-queue. Idempotency key = `sha256(model + prompt_hash + tools_hash + temp + max_tokens + case_id + attempt_idx)` — replay hits cache, costs nothing.

**SSE pub**: emit `attempt_started`, `attempt_completed`, `case_scored`, `run_completed` events.

### Step 7 — API Routes (0.5h)

Hono on `:8787`:

```
  POST /api/v1/runs                 Start a run (idempotent on prompt+dataset hash)
  GET  /api/v1/runs                 List runs with aggregates
  GET  /api/v1/runs/:id             Run detail
  GET  /api/v1/runs/:id/stream      SSE progress
  POST /api/v1/runs/:id/resume      Resume a crashed/cancelled run
  GET  /api/v1/runs/compare?a=&b=   Per-field deltas + winners
  GET  /api/v1/cases/:case_id       Transcript + gold for UI
```

### Step 8 — DB Schema (0.5h)

Drizzle migrations:

```sql
  runs        (id, strategy, model, prompt_hash, schema_hash,
               dataset_hash, status, started_at, completed_at,
               total_input_tokens, total_output_tokens,
               total_cache_read_tokens, total_cache_creation_tokens,
               total_cost_usd)

  attempts    (run_id, case_id, attempt_idx, status,
               started_at, completed_at,
               input_tokens, output_tokens,
               cache_read_input_tokens, cache_creation_input_tokens,
               anthropic_request_id, raw_response_path,
               predicted_json, validation_errors, retry_reason,
               PRIMARY KEY (run_id, case_id, attempt_idx))

  scores      (attempt_id, scorer_name, scorer_version,
               field_path, value, metadata)

  traces      (attempt_id, event_idx, event_type, payload, ts)
```

### Step 9 — Compare View ⭐ (2.0h)

The headline screen. Most important UI work in the project.

```
  COMPARE: run_a (few_shot) vs run_b (cot)

  Aggregate F1:        0.82 → 0.86   ▲ +0.04   95% CI [+0.01, +0.07]
  Cost:                $0.34 → $0.51 ▲ +$0.17  (+50%)
  Schema-valid rate:   98%   → 100%
  Hallucinations:      6     → 2

  Per-field F1:                           Δ
    chief_complaint  0.91 → 0.93         +0.02   (within noise)
    vitals           0.96 → 0.96         +0.00
    medications      0.74 → 0.84         +0.10   ◎ COT wins
    diagnoses        0.71 → 0.81         +0.10   ◎ COT wins
    plan             0.79 → 0.82         +0.03
    follow_up        0.85 → 0.86         +0.01

  Cases improved by run_b: 18  (case_007 +0.32, case_023 +0.28, ...)
  Cases regressed:          4  (case_011 -0.15, case_034 -0.09, ...)
  Cases unchanged:         28

  [click any case → run detail with side-by-side diff]
```

Bootstrap confidence intervals on the aggregate delta. Tag-faceted breakdowns. Reject cross-dataset-version comparisons with a loud warning.

### Step 10 — Run Detail + Trace View (1.0h)

For each case: transcript with grounded values highlighted, gold JSON vs predicted JSON side-by-side with field-level diff, full retry trace (every attempt, every tool_use, every validation error, cache stats).

### Step 11 — Tests (1.0h)

The 8 specified by the brief:

```
  ✓ 1. Schema-validation retry path (mock LLM returns invalid → valid)
  ✓ 2. Fuzzy med matching (BID == twice daily, 10mg == 10 mg)
  ✓ 3. Set-F1 correctness on a tiny synthetic case
  ✓ 4. Hallucination detector — positive + negative
  ✓ 5. Resumability (start run, kill, resume, no double-charge)
  ✓ 6. Idempotency (same input → cached response, no LLM call)
  ✓ 7. Rate-limit backoff (mock 429, verify retry-after honored)
  ✓ 8. Prompt-hash stability (same template+vars → same hash)
```

### Step 12 — CLI + Smoke Run + NOTES.md (0.5h)

```
  bun run eval -- --strategy=cot --model=claude-haiku-4-5-20251001
```

Single command, prints summary table, exits 0 on success. Used by CI.

`NOTES.md` at repo root with:
1. Per-strategy aggregate F1, cost, latency
2. Per-field F1 table (3 × 6)
3. Schema-invalid + hallucination rates per strategy
4. **What surprised you**
5. **What you'd build next**
6. **What you cut**

---

## Risk Register

```
  Risk                                          Mitigation
  ──────────────────────────────────────────────────────────────────
  Haiku 4.5 prompt < 4,096 token cache min      Pad with reference
                                                glossary
  Strict tool-use rejects schema keyword        Validate schema vs
                                                strict-mode subset first
  429 acceleration limits                       Ramp 2 → 5 over 30s
  Test set overfit                              Brief notes "may swap
                                                eval set" — don't hand-
                                                tune to these 50
  Cost overrun mid-dev                          Budget guardrail in CLI
                                                + running total
  Resume re-runs completed cases                Idempotency key check
                                                before any LLM call
```

---

## Stretch Goals (only after the 10 hard reqs pass)

In priority order:

```
  1. CoVe Strategy 4 (extract → independently verify per field → revise)
  2. Cost guardrail (refuse run if projected > $X)
  3. Cross-model compare (add Sonnet 4.6)
  4. Prompt diff view (which characters changed, which cases regressed)
  5. Active-learning hint (top-5 highest cross-strategy disagreement)
  6. NLI-based grounding for chief_complaint + plan
```

---

## Submission Checklist

```
  ☐ All 10 hard requirements pass
  ☐ All 8 tests pass
  ☐ bun install && bun run eval -- --strategy=zero_shot works clean
  ☐ Full 3-strategy run cost < $1
  ☐ NOTES.md at repo root
  ☐ Output of one full 3-strategy CLI run in results/ or NOTES.md
  ☐ No API key leaked to browser
  ☐ Submitted as private repo OR zip without node_modules
```

---

## What We're NOT Building

- Pretty UI (Tailwind defaults are fine — brief says so)
- Multi-user auth, multi-tenant, deployment story
- Vector DB / RAG layer
- Self-Consistency, Tree-of-Thoughts (N×-cost strategies, off-budget)
- Hand-tuned prompts overfit to these 50 cases
- Any feature whose absence won't be visible in the compare view

---

## Start Here

Begin with **Step 1** — the schema + types in `packages/shared`. Single source of truth from the start prevents hours of refactor pain later.

```bash
  cd test-evals
  bun install
  # Step 1: define ClinicalExtractionSchema in packages/shared
```

See [idea.md](idea.md ) §10.1 for the ranked build order with research-backed rationale, and §11 for the full source index.
