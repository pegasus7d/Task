# HEALOSBENCH

**A production-grade LLM evaluation harness for structured clinical extraction.** Three prompt strategies, retry-with-feedback, fuzzy hallucination detection, bounded concurrency with 429 backoff, resumable runs, and a compare dashboard — all built end-to-end against [the brief](#the-brief) at `medinoteorg/test-evals`.

Turns a clinical doctor–patient transcript into structured JSON (chief complaint, vitals, medications, diagnoses, plan, follow-up), then scores every field against gold using the metric appropriate to its type, and surfaces per-field deltas between prompt strategies in a comparison UI.

---

## Quick start

```bash
git clone <this-repo> test-evals
cd test-evals
bun install
docker compose up -d
bun run db:push
cp .env.example apps/server/.env       # then paste a real ANTHROPIC_API_KEY
cp .env.example apps/web/.env          # trim to the NEXT_PUBLIC_SERVER_URL line
./scripts/run-full-eval.sh             # full 3-strategy × 50-case eval, ~$0.55, ~10 min
```

For the interactive dashboard: `./scripts/start-dev.sh` then open `http://localhost:3001`.

For a free mock-mode sanity run (no API key needed): leave `USE_ANTHROPIC=0` in `apps/server/.env` and run `cd apps/server && bun run eval -- --strategy=zero_shot`.

**Full setup, env, scripts, troubleshooting:** [`SETUP.md`](./SETUP.md).
**Submission notes, results, what surprised me, what's next:** [`NOTES.md`](./NOTES.md).
**Pre-build design docs** (idea → approach → lld → contracts → entities → runner-design): [`docs/`](./docs/).

---

## Headline results

50-case dataset, real Claude Haiku 4.5, Tier-2 fuzzy grounding ON:

| Strategy   | Weighted F1 | Cost (USD) | Duration | Grounded-out |
|------------|------------:|-----------:|---------:|-------------:|
| zero_shot  | 0.7531      | $0.20      | 171s     | 8 / 50       |
| few_shot   | 0.7417      | $0.21      | 149s     | 0 / 50       |
| **cot**    | **0.7584**  | $0.21      | 177s     | 0 / 50       |

Per-field × strategy means + the surprising bits ("CoT was the only strategy that moved diagnoses"; "few-shot *hurt* `chief_complaint`") are in [`NOTES.md`](./NOTES.md).

---

## Tech stack

TypeScript-first monorepo on **Bun** with **Turborepo** orchestration. The backend is **Hono** running on Bun (`:8787`) with **Zod** validation, talking to **Claude Haiku 4.5** through **`@anthropic-ai/sdk`** using forced tool-use for schema-conformant output and `cache_control` for prompt caching; rate-limit handling, 5-in-flight concurrency, retry-with-feedback, and cross-run idempotency are custom-built (no Bottleneck/p-limit). Persistence is **Postgres 16** (Docker Compose) with **Drizzle ORM** + **Drizzle Kit** for the 13-table schema and migrations. The dashboard is **Next.js 16** (App Router, React 19, React Compiler) on `:3001`, styled with **Tailwind CSS 4**, with **TanStack React Form**, **Lucide**, **next-themes**, and **Sonner**. Validation runs a Zod schema check followed by Tier-2 fuzzy grounding (Levenshtein DP + 4-char anchor-token escape hatch); the evaluator uses ten atomic scorers (fuzzy / exact / ±tolerance / set-F1 / ICD partial credit). Tooling: **Bun's built-in test runner** (73 tests, fully in-memory), **Docker Compose** for local Postgres, **`@t3-oss/env-core`** for split server/client env validation, and bash scripts for the full-eval pipeline and dev-server orchestration.

---

## What was built — coverage of the brief's hard requirements

| # | Requirement | Implementation |
|---|---|---|
| 1 | Tool use / structured output, not regex | `tool_choice: {type:"tool", name:"extract_clinical"}` forced in every strategy. `JSON.parse` is never called on raw model text. |
| 2 | Retry-with-error-feedback, ≤ 3, all attempts logged | `RunnerService.runOneCase` loops `i:1..3`, validation errors injected as a `tool_result` turn for the next attempt. Every attempt = a row in the `attempts` table. |
| 3 | Prompt caching, verified | `cache_control: {type:"ephemeral"}` on `system + tools` (verified against the [May-2026 caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)). `cache_read_input_tokens` is surfaced through `attempts.usage`. Honest caveat in NOTES §3: Haiku 4.5's 4096-token cache floor exceeds our ~775-token prefix, so reads stay at zero on this model — wire format is correct and ready to land hits on Sonnet 4.5 / Opus 4.x (1024-token floor). |
| 4 | Concurrency + 429 handling | 5-in-flight via a 25-LOC inline async semaphore + `Promise.allSettled`. 429s caught at the adapter boundary, translated into a typed `RateLimitError` carrying `Retry-After`, then absorbed by `withRateLimitRetry` (≤ 4 retries, 30s cap). Sits *outside* the per-case validation budget so a rate-limit storm doesn't eat the 3-attempt retry budget. Documented in [`NOTES.md` § Concurrency & Rate Limiting](./NOTES.md). |
| 5 | Resumable runs | `POST /api/v1/runs/:id/resume` re-processes only cases without a terminal `evaluations` row. Cross-run idempotency replay (content-addressed `idempotency_key` on `attempts`) short-circuits any successful attempt that landed pre-crash, so resume is safe even after partial-write failures. |
| 6 | Per-field metrics matched to field type | 10 atomic scorers in `apps/server/src/evaluators/scorers.ts`: `chiefComplaintFuzzy`, `vitalsBpExact`, `vitalsHrTolerant`, `vitalsTempTolerant` (±0.2 °F), `vitalsSpo2Tolerant`, `medicationsSetF1` (with `BID ↔ twice daily` canonicalization), `diagnosesSetF1` (with ICD-10 partial credit 1.0 / 0.5 / 0.0), `planSetF1`, `followUpIntervalExact`, `followUpReasonFuzzy`. |
| 7 | Hallucination detection | Tier-2 fuzzy grounding in `apps/server/src/validators/grounding.ts` — approximate substring matching via Levenshtein DP (threshold 0.55, tuned on real Haiku output) plus a 4-char anchor-token escape hatch that catches medical formalization (`"GERD"` matching `"reflux"`). Empirical false-positive rate on the 50-case run: 16% — all are short clinical labels formalized from lay symptoms. |
| 8 | Compare view with real signal | `/compare` UI bound to `GET /api/v1/runs/compare?a=…&b=…`. Per-field deltas, per-case bucketing (regressed / unchanged / improved), winner-per-field. |
| 9 | ≥ 8 tests, including the named list | **73 tests** in 4 files. Named list covered: schema-validation retry path ✓, fuzzy med matching ✓, set-F1 correctness ✓, hallucination detector pos + neg ✓, **resumability** ✓, idempotency ✓, **rate-limit backoff (mock SDK)** ✓, prompt-hash stability ✓. |
| 10 | No API key in the browser | Split env via `@t3-oss/env-core`. `apps/web/.env` ships only `NEXT_PUBLIC_SERVER_URL`; `ANTHROPIC_API_KEY` lives in `apps/server/.env` and is consumed only by the Hono server. |

---

## Architecture

```
┌─────────────────────────┐    HTTP     ┌──────────────────────────────────────┐
│  Next.js 16 dashboard   │ ─────────▶  │  Hono server  (apps/server  :8787)   │
│  (apps/web  :3001)       │             │                                      │
│  • Runs list             │             │  ┌────────────────────────────────┐  │
│  • Run / case detail     │             │  │  RunnerService                 │  │
│  • Compare view          │             │  │  • 5-in-flight semaphore        │  │
└─────────────────────────┘             │  │  • per-case retry-with-feedback │  │
                                          │  │  • 429 backoff (Retry-After)    │  │
                                          │  │  • resumeRun(id)                │  │
                                          │  └─────┬─────────────┬─────────────┘  │
                                          │        ▼             ▼                │
                                          │  ExtractorService  EvaluatorService   │
                                          │   • forced tool-use   • 10 scorers    │
                                          │   • Zod + Tier-2      • set-F1, fuzzy │
                                          │     fuzzy grounding   • ICD partial   │
                                          │   • cross-run                         │
                                          │     idempotency                       │
                                          └──┬───────────────┬────────────────────┘
                                             ▼               ▼
                                       ┌────────────┐  ┌──────────────────────┐
                                       │ Anthropic  │  │ Postgres 16 (Drizzle)│
                                       │ Haiku 4.5  │  │ 13 tables            │
                                       │            │  │ runs / attempts /    │
                                       │ tool-use + │  │ evaluations / scores │
                                       │ caching    │  │ traces / prompts / … │
                                       └────────────┘  └──────────────────────┘
```

### Key paths

| Concern | File |
|---|---|
| Retry / concurrency / resume | `apps/server/src/services/runner.service.ts` |
| Single-attempt extractor + idempotency | `apps/server/src/services/extractor.service.ts` |
| Per-field scoring | `apps/server/src/services/evaluator.service.ts`, `apps/server/src/evaluators/scorers.ts` |
| Compare logic | `apps/server/src/services/compare.service.ts` |
| Validators (schema → grounding) | `apps/server/src/validators/{chain,schema,grounding,feedback}.ts` |
| Strategies | `apps/server/src/llm/strategies/{zero-shot,few-shot,cot}.ts` |
| Real / mock LLM adapters | `apps/server/src/llm/{anthropic-adapter,mock-adapter,select-adapter}.ts` |
| API routes | `apps/server/src/api/runs.ts` |
| Drizzle schema | `packages/db/src/schema/eval.ts` (13 tables) |
| UI pages | `apps/web/src/app/{page,runs/new,runs/[id],runs/[id]/cases/[caseId],compare}/page.tsx` |

---

## API surface

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/v1/runs` | Synchronous: run a strategy on the dataset, return summary |
| `GET`  | `/api/v1/runs?limit=50` | Paginated runs list |
| `GET`  | `/api/v1/runs/compare?a=&b=` | Per-field deltas + winner |
| `GET`  | `/api/v1/runs/:id` | Run + attempts |
| `GET`  | `/api/v1/runs/:id/cases/:caseId` | Transcript + gold + predicted + scores |
| `POST` | `/api/v1/runs/:id/resume` | Continue a previously-started run; safe after server crash |

Curl examples + the full request body shape are in [`SETUP.md`](./SETUP.md#9-api-surface).

---

## Tests

```bash
cd apps/server
bun test    # 73 tests, ~200 ms
```

Four files, all in-memory (no DB, no network):

| File | Coverage |
|---|---|
| `harness.test.ts` | Schema validator, Tier-2 grounding (substring + anchor-token), feedback collector, scorers, idempotency-key, validator chain |
| `retry-loop.test.ts` | Retry-with-feedback end-to-end through `ExtractorService` + `MockLLMAdapter`, plus idempotency replay |
| `extended.test.ts` | 3-strategy registry, all 6 fields scored, prompt-cache visibility, adapter selection |
| `concurrency-resume.test.ts` | 429 backoff (mock SDK), `withRateLimitRetry` budget, semaphore primitive, `completedCaseIds` resume filter, partial-crash idempotency replay |

---

## Repo layout

```
test-evals/
├── apps/
│   ├── server/        Hono backend on :8787
│   │   └── src/
│   │       ├── api/, cli/, data/, evaluators/, llm/, services/,
│   │       ├── validators/, utils/, __tests__/
│   └── web/           Next.js 16 dashboard on :3001
├── packages/
│   ├── db/            Postgres schema + repositories (Drizzle ORM)
│   ├── env/, ui/, config/
├── data/
│   ├── transcripts/   50 synthetic clinical transcripts
│   ├── gold/          ground-truth extractions
│   └── schema.json
├── scripts/
│   ├── start-dev.sh         server + web together with log tailing
│   ├── run-full-eval.sh     full 3-strategy submission run
│   ├── aggregate-runs.sh    refresh artifacts from existing run_ids
│   └── db.sh                local Postgres helper
├── docker-compose.yml
├── README.md      (this file)
├── SETUP.md       clone-to-run setup guide
└── NOTES.md       results, what surprised me, what's next
```

---

## The brief

The original take-home brief lives here for context — the assignment was to build a repeatable evaluation harness for an LLM that turns clinical transcripts into structured JSON, with three prompt strategies, retry-with-feedback, prompt caching, per-field metrics, hallucination detection, a compare dashboard, resumable runs, and ≥ 8 tests. Synthetic data only, ~8–12 hours, full 3-strategy run under $1.

Full requirement breakdown, dataset description, hard requirements, stretch goals, and constraints are in the [original assessment README](https://github.com/medinoteorg/test-evals).

---

## License + attribution

Synthetic data only — no PHI. Built solo against the assessment brief. Submission notes, results, design tradeoffs, and future work are in [`NOTES.md`](./NOTES.md).
