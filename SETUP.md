# Setup

Everything you need to clone, install, configure, run, evaluate, and debug the HEALOSBENCH eval harness.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Clone + install](#2-clone--install)
3. [Environment variables](#3-environment-variables)
4. [Database](#4-database-postgres)
5. [Schema migration](#5-schema-migration)
6. [Run mode A — full pipeline (one command)](#6-run-mode-a--full-pipeline-one-command)
7. [Run mode B — interactive UI + API](#7-run-mode-b--interactive-ui--api)
8. [Run mode C — CLI eval (single strategy)](#8-run-mode-c--cli-eval-single-strategy)
9. [API surface](#9-api-surface)
10. [Tests](#10-tests)
11. [Useful scripts](#11-useful-scripts)
12. [Mock vs real LLM](#12-mock-vs-real-llm)
13. [Cost expectations](#13-cost-expectations)
14. [Troubleshooting](#14-troubleshooting)
15. [Project layout](#15-project-layout)

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Bun** | ≥ 1.3.0 (workspaces use `bun@1.3.5`) | Package manager + runtime + test runner |
| **Docker** + **Docker Compose v2** | any recent | Local Postgres in a container |
| **Node-shaped tooling** | not required | Bun provides everything; Node isn't called |
| **macOS / Linux** | — | Tested on macOS 14 (Darwin 24); Linux should work; Windows untested |

Anthropic API key only needed if you want real-LLM runs (see [§12](#12-mock-vs-real-llm)).

Quick check:

```bash
bun --version          # → 1.3.x
docker compose version # → Docker Compose v2.x
```

---

## 2. Clone + install

```bash
git clone <your-clone-url> test-evals
cd test-evals
bun install
```

The repo is a **bun workspaces + Turborepo** monorepo:

- `apps/server` — Hono API on `:8787`
- `apps/web` — Next.js 16 dashboard on `:3001`
- `packages/db` — Postgres schema + repositories (Drizzle ORM)
- `packages/env`, `packages/ui`, `packages/config` — shared infra

`bun install` installs everything for every workspace in one shot.

---

## 3. Environment variables

Two env files. **Both are gitignored.** Templates live in `.env.example` at the repo root.

### `apps/server/.env`

```bash
# Database — matches docker-compose port 5433
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/eval_db

# Anthropic. Real key shape: sk-ant-api03-<~95 base64-url chars>
# Get one at https://console.anthropic.com/settings/keys
# A placeholder is shape-correct but the server rejects it when USE_ANTHROPIC=1.
ANTHROPIC_API_KEY=sk-ant-api03-DUMMY00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000

# Adapter selector
#   USE_ANTHROPIC=1 → real Haiku 4.5  (requires real ANTHROPIC_API_KEY)
#   USE_ANTHROPIC=0 → mock adapter    (default — no network, free)
USE_ANTHROPIC=0

# Web ↔ Server CORS — must equal the Next.js dev port
CORS_ORIGIN=http://localhost:3001

NODE_ENV=development
```

### `apps/web/.env`

```bash
# The ONLY var the browser sees. Never put secrets in NEXT_PUBLIC_*.
NEXT_PUBLIC_SERVER_URL=http://localhost:8787
```

### Quick start from the templates

```bash
cp .env.example apps/server/.env       # then paste your real key (or leave the dummy for mock-mode)
cp .env.example apps/web/.env          # keep only the NEXT_PUBLIC_* line, delete the rest
```

The server validates env on startup via Zod (`packages/env/src/server.ts`); a missing or malformed required var fails fast with a readable error.

---

## 4. Database (Postgres)

We ship a `docker-compose.yml` with `postgres:16-alpine` on host port **5433** (the container internally still listens on 5432; the host port avoids collisions with other local Postgres instances).

```bash
# Bring up
docker compose up -d
# OR via the helper
./scripts/db.sh up
```

`scripts/db.sh` wraps the common operations:

| Command | Effect |
|---|---|
| `./scripts/db.sh up` | Start Postgres in the background |
| `./scripts/db.sh down` | Stop Postgres (data preserved) |
| `./scripts/db.sh status` | Container + healthcheck state |
| `./scripts/db.sh logs` | Tail Postgres logs |
| `./scripts/db.sh psql` | Open `psql` inside the container |
| `./scripts/db.sh wait` | Block until Postgres is healthy |
| `./scripts/db.sh reset` | ⚠️ Stop AND **drop the data volume** |
| `./scripts/db.sh push` | Apply Drizzle schema |
| `./scripts/db.sh generate` | Generate migration SQL |
| `./scripts/db.sh migrate` | Apply generated migrations |
| `./scripts/db.sh studio` | Open Drizzle Studio |

Connection string for direct psql from the host:

```bash
PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d eval_db
# or via container
docker exec -it test-evals-postgres psql -U postgres -d eval_db
```

---

## 5. Schema migration

The schema lives in `packages/db/src/schema/eval.ts` (13 tables: runs, attempts, evaluations, scores, traces, prompt_templates, etc.). Drizzle Kit generates and pushes migrations.

```bash
bun run db:push          # syncs schema directly to the live DB (development)
# or
bun run db:generate      # writes SQL migration files
bun run db:migrate       # applies the SQL migrations
```

`db:push` is the dev path. Use `generate` + `migrate` if you want versioned SQL artifacts (e.g. for prod parity).

Drizzle reads `DATABASE_URL` from `apps/server/.env` (configured in `packages/db/drizzle.config.ts`).

---

## 6. Run mode A — full pipeline (one command)

The submission deliverable. Brings the system end-to-end: pre-flight gates, smoke test, all 3 strategies on all 50 cases, results dumped to disk, NOTES regenerated.

```bash
./scripts/run-full-eval.sh
```

What it does, in order:

1. **Pre-flight gates** — Postgres healthy, `USE_ANTHROPIC=1`, key isn't a placeholder, ≥ 13 tables present.
2. **Smoke test** — one real call against case_001 (~$0.004). Stops with a clear message if billing is broken.
3. **3 strategy runs** — `zero_shot`, `few_shot`, `cot` — sequentially, each on all 50 cases. Tier-2 grounding ON by default.
4. **Aggregation SQL** — pulls per-strategy rollups + per-field × strategy means out of `runs`/`evaluations`/`scores`.
5. **Artifacts** — writes `results/run_<strategy>.json` + `results/summary.json`.
6. **NOTES.md** — auto-generated with §1 aggregate table, §2 per-field × strategy means, §3 config, plus stub sections for §4/§5/§6 prose.

Useful flags:

```bash
./scripts/run-full-eval.sh --sample 5            # only the first 5 cases — sanity run
./scripts/run-full-eval.sh --skip-grounding      # disable Tier-2 fuzzy hallucination gate
```

If you already have run_ids and just want to refresh the artifacts without re-billing:

```bash
./scripts/aggregate-runs.sh <run_id_zero> <run_id_few> <run_id_cot>
```

---

## 7. Run mode B — interactive UI + API

For poking around — start a run from the browser, click into a case, compare two runs.

```bash
./scripts/start-dev.sh
```

This boots **both** servers in parallel, tails logs, and shuts both down on Ctrl+C.

| URL | What it serves |
|---|---|
| `http://localhost:3001` | Runs list |
| `http://localhost:3001/runs/new` | Start a new run |
| `http://localhost:3001/runs/<id>` | Run detail (per-case scores) |
| `http://localhost:3001/runs/<id>/cases/<case_id>` | Transcript + gold vs predicted + scores |
| `http://localhost:3001/compare?a=<run_a>&b=<run_b>` | Per-field deltas + winner |
| `http://localhost:8787` | API (returns `OK`) |

Useful flags:

```bash
./scripts/start-dev.sh --no-open       # don't auto-open the browser
./scripts/start-dev.sh --kill-only     # kill anything on :8787 / :3001 and exit
```

Logs are at `.dev-logs/server.log` and `.dev-logs/web.log` (gitignored).

If you'd rather run the two servers manually, use two terminals:

```bash
# Terminal 1 — backend
cd apps/server && bun run dev          # :8787, --hot

# Terminal 2 — frontend
cd apps/web    && bun run dev          # :3001
```

Or via Turbo from the repo root:

```bash
bun run dev              # boots both via turborepo
bun run dev:server       # backend only
bun run dev:web          # frontend only
```

---

## 8. Run mode C — CLI eval (single strategy)

For programmatic / CI use. No UI, no SSE. Prints a summary table to stdout.

```bash
cd apps/server
bun run eval -- --strategy=zero_shot
bun run eval -- --strategy=few_shot --cases=case_001,case_002,case_003
bun run eval -- --strategy=cot --skip-grounding
```

Flags:

| Flag | Default | Effect |
|---|---|---|
| `--strategy=<name>` | (required) | One of `zero_shot`, `few_shot`, `cot` |
| `--cases=<id1,id2>` | all 50 | Comma-separated case-id allowlist |
| `--skip-grounding` | off | Disables the Tier-2 fuzzy grounding gate |

Output is a banner with `run_id`, case counts, weighted F1, total cost, duration. Per-case scores are persisted to the `scores` and `evaluations` tables.

---

## 9. API surface

All routes are under `/api/v1/`. The server is a small Hono app — see `apps/server/src/api/runs.ts`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET`  | `/` | — | `OK` (health) |
| `POST` | `/api/v1/runs` | `{ strategy, model?, case_filter?, force?, cost_cap_usd?, max_attempts?, temperature?, max_tokens?, cache_ttl?, skip_grounding? }` | `{ run_id, status, summary }` (synchronous) |
| `GET`  | `/api/v1/runs?limit=50` | — | `{ runs: [...], next_cursor: null }` |
| `GET`  | `/api/v1/runs/compare?a=<runA>&b=<runB>[&allow_cross_dataset=true]` | — | Per-field deltas + bucketing + winner |
| `GET`  | `/api/v1/runs/:id` | — | `{ run, attempts: [...] }` |
| `GET`  | `/api/v1/runs/:id/cases/:caseId` | — | `{ case_id, transcript, gold, attempts, scores }` |
| `POST` | `/api/v1/runs/:id/resume` | — | `{ run_id, status, summary }`. Re-processes only cases without a terminal `evaluations` row. Idempotency replay short-circuits any successful attempt that already landed |

Quick smoke test:

```bash
# Health
curl http://localhost:8787/

# List runs
curl http://localhost:8787/api/v1/runs

# Start a run (mock-mode is safe — costs nothing)
curl -X POST http://localhost:8787/api/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"strategy":"zero_shot","case_filter":["case_001","case_002"]}'

# Resume after a crash
curl -X POST http://localhost:8787/api/v1/runs/<run_id>/resume
```

---

## 10. Tests

Bun's built-in test runner.

```bash
cd apps/server
bun test                                # all 73 tests, ~200ms
bun test src/__tests__/harness.test.ts  # just one file
```

Test files:

| File | Coverage |
|---|---|
| `harness.test.ts` | Schema validator, Tier-2 grounding (substring + anchor-token), feedback collector, per-field scorers, idempotency key, validator chain |
| `retry-loop.test.ts` | End-to-end retry-with-feedback through `ExtractorService` + `MockLLMAdapter` |
| `extended.test.ts` | 3-strategy registry, all 6 fields scored, prompt-cache visibility, adapter selection |
| `concurrency-resume.test.ts` | 429 backoff (mock SDK), `withRateLimitRetry` budget, semaphore primitive, `completedCaseIds` resume filter, partial-crash idempotency replay |

Tests run fully in-memory — no DB, no network. Real-LLM and DB-coupled paths are tested via in-memory fakes that implement the methods the production code actually calls.

---

## 11. Useful scripts

All under `scripts/`:

| Script | Purpose |
|---|---|
| `start-dev.sh` | Boot server + web together with crash detection and log tailing |
| `run-full-eval.sh` | End-to-end submission run (pre-flight + 3 strategies + artifacts + NOTES) |
| `aggregate-runs.sh <run_a> <run_b> <run_c>` | Re-generate `results/*.json` from existing `run_id`s without re-running the LLM |
| `db.sh` | Wrap docker-compose + drizzle-kit (see [§4](#4-database-postgres)) |

---

## 12. Mock vs real LLM

Adapter selection happens at runtime in `apps/server/src/llm/select-adapter.ts`:

| `USE_ANTHROPIC` | Adapter | Network | Cost |
|---|---|---|---|
| `0` or unset | `MockLLMAdapter` | none | $0 |
| `1` | `AnthropicAdapter` (Haiku 4.5 by default) | yes | metered |

The mock adapter:
- Returns the gold extraction with light noise (one frequency normalization, e.g. `BID ↔ twice daily`) so scorers produce non-trivial deltas.
- Supports scripted failures (`schema_invalid`, `grounding_failed`, `throw`, `rate_limit_429`) for testing the retry loop and 429 handling.
- Simulates cache hits when `cache_control` blocks are present (2nd+ call with the same prefix → reports `cache_read_input_tokens > 0`).

The real adapter:
- Forces tool-use via `tool_choice: {type:"tool", name:"extract_clinical"}`.
- Uses `cache_control` on stable prefix (system + tools).
- Translates Anthropic `429` errors into a typed `RateLimitError` with parsed `Retry-After`. The runner wraps every adapter with `withRateLimitRetry` (up to 4 retries, capped at 30s per backoff).
- Costs are computed per-call from token counts and surfaced on the `attempts` row.

To flip to real LLM:

```bash
# Edit apps/server/.env
USE_ANTHROPIC=1
ANTHROPIC_API_KEY=sk-ant-api03-<your real key>
```

Then either:

```bash
./scripts/run-full-eval.sh        # full 3-strategy submission run
# OR
cd apps/server && bun run eval -- --strategy=zero_shot
```

⚠️ **Always set `USE_ANTHROPIC=0` after a real run** to prevent accidental spend on the next dev session. The CI smoke test fails closed when set to `1` with a placeholder key.

---

## 13. Cost expectations

| Run | Cost | Time |
|---|---|---|
| Single strategy × 1 case (smoke) | ~$0.004 | ~2s |
| Single strategy × 50 cases | ~$0.17–$0.21 | ~3 min |
| Full 3-strategy × 50 cases (`run-full-eval.sh`) | ~$0.55–$0.70 | ~10 min |
| Resume of a partially-completed run | proportional to remaining cases (not re-run) | proportional |

Caching does NOT reduce cost on Haiku 4.5: the cache floor is **4096 tokens** and our stable prefix (~775 tokens) sits well below it. See `NOTES.md §3` for the full discussion.

The brief sets a $1 budget for one full 3-strategy run — we sit comfortably under that.

---

## 14. Troubleshooting

### "EISDIR reading packages/db/src/schema/eval.ts" in dev logs

The `--hot` watcher in Bun occasionally races a file-write atomic-rename. Errors are non-fatal — requests still return 200. To clear, restart the server: `./scripts/start-dev.sh --kill-only && ./scripts/start-dev.sh`.

### Postgres "port 5432 already in use"

We deliberately publish on host port **5433**, not 5432. If `docker compose up -d` complains, something else holds 5433. Either stop the other process or temporarily edit `docker-compose.yml` to map another host port (and update `DATABASE_URL` to match).

### `bun run db:push` errors with `gold_records_case_fk depends on cases_dataset_hash_case_id_pk`

This is a Drizzle Kit interactive prompt the script is rejecting non-interactively. Either:
- Run `bun run db:generate` then `bun run db:migrate` (versioned SQL path), or
- Apply the schema change manually via `docker exec test-evals-postgres psql -U postgres -d eval_db -c "<DDL>"`.

### Anthropic "credit balance is too low"

`run-full-eval.sh` detects this in the smoke test and stops with a link to the billing page (`https://console.anthropic.com/settings/billing`). Top up, then re-run.

### `cache_read_input_tokens` is always 0

Expected on Haiku 4.5 — model floor is 4096 tokens, our stable prefix is ~775. To actually land cache hits, switch to Sonnet 4.5 / Opus 4.x (1024-token floor) or pad the system prompt past 4096. See `NOTES.md §3`.

### Server bound to port 3000 instead of 8787

Bun defaults to 3000 when you `export default { fetch }` without a port. We pin 8787 explicitly in `apps/server/src/index.ts`. Override with `PORT=… bun run dev`.

### Web shows "ECONNREFUSED 127.0.0.1:8787"

Backend isn't running. Start it (`cd apps/server && bun run dev`) or use `./scripts/start-dev.sh` which boots both.

### Tests fail with "DATABASE_URL must be set"

Tests are designed to run without a DB — but a few repository-coupled tests gate on `DATABASE_URL`. Set it in your shell or in `apps/server/.env` (the dev DB URL works fine).

---

## 15. Project layout

```
test-evals/
├── apps/
│   ├── server/                   Hono backend on :8787
│   │   ├── src/
│   │   │   ├── api/runs.ts        HTTP routes (POST, GET, /resume, /compare, /:id, /:id/cases/:caseId)
│   │   │   ├── cli/eval.ts        CLI entry — `bun run eval`
│   │   │   ├── data/              Dataset loader, clinical Zod schema
│   │   │   ├── evaluators/scorers.ts   10 atomic scorers (fuzzy / exact / tolerant / set-F1 / ICD partial)
│   │   │   ├── llm/
│   │   │   │   ├── strategies/    zero-shot, few-shot, cot — swappable IStrategy implementations
│   │   │   │   ├── anthropic-adapter.ts   Real adapter — 429 → RateLimitError
│   │   │   │   ├── mock-adapter.ts        Scripted-failure-capable mock
│   │   │   │   ├── select-adapter.ts      Env-flag gating (USE_ANTHROPIC)
│   │   │   │   ├── tool-definition.ts     The single forced tool
│   │   │   │   └── types.ts               IStrategy, ILLMAdapter, RateLimitError
│   │   │   ├── services/
│   │   │   │   ├── runner.service.ts      Concurrency (5-in-flight semaphore), retry-with-feedback, resume
│   │   │   │   ├── extractor.service.ts   Single-attempt extractor + cross-run idempotency replay
│   │   │   │   ├── evaluator.service.ts   Drives all scorers + persists per-case scores
│   │   │   │   └── compare.service.ts     Per-field deltas + winner
│   │   │   ├── validators/
│   │   │   │   ├── chain.ts          Schema → grounding pipeline (fail-fast on schema)
│   │   │   │   ├── schema.ts         Zod-based JSON-schema validator
│   │   │   │   ├── grounding.ts      Tier-2 fuzzy + 4-char anchor-token gate
│   │   │   │   └── feedback.ts       Validation errors → tool_result feedback turn
│   │   │   ├── utils/                ID generation, sha256, canonicalJson
│   │   │   └── __tests__/            73 tests, fully in-memory
│   │   └── .env                    GITIGNORED — your real key
│   └── web/                        Next.js 16 dashboard on :3001
│       └── src/app/
│           ├── page.tsx             Runs list
│           ├── runs/new/page.tsx     Start a run form
│           ├── runs/[id]/page.tsx     Run detail
│           ├── runs/[id]/cases/[caseId]/page.tsx   Case detail
│           └── compare/page.tsx       Compare view
├── packages/
│   ├── db/                         Postgres schema + repos (Drizzle ORM)
│   │   └── src/
│   │       ├── schema/eval.ts        13 tables — single source of truth
│   │       └── repositories/         Run / Attempt / Dataset / Evaluation / Score / PromptTemplate
│   ├── env/                        Zod-validated env loader (split server / client)
│   ├── ui/                         Shared UI primitives
│   └── config/                     Shared TypeScript / lint config
├── data/
│   ├── transcripts/*.txt           50 synthetic clinical transcripts
│   ├── gold/*.json                  ground-truth extractions
│   └── schema.json                  the JSON schema all extractions must conform to
├── scripts/
│   ├── start-dev.sh                Boot both servers + tail logs
│   ├── run-full-eval.sh            Full 3-strategy submission run + NOTES regen
│   ├── aggregate-runs.sh           Refresh artifacts from existing run_ids
│   └── db.sh                       Local Postgres + Drizzle wrapper
├── results/                        GITIGNORED — output of run-full-eval.sh
├── docker-compose.yml              Postgres on :5433
├── .env.example                    Single committed env template (split into apps/server/.env + apps/web/.env)
├── README.md                       The brief
├── NOTES.md                        Submission notes (per-strategy results, what surprised, what's next)
└── SETUP.md                        This file
```

---

## TL;DR — quickest possible run

```bash
# Mock mode (free, no key needed) — full 50-case sanity in ~30s
git clone <url> test-evals && cd test-evals
bun install
docker compose up -d
bun run db:push
cp .env.example apps/server/.env
cp .env.example apps/web/.env       # then trim to NEXT_PUBLIC_SERVER_URL only
cd apps/server && bun run eval -- --strategy=zero_shot
```

```bash
# Real LLM — full submission run
# (after putting a real ANTHROPIC_API_KEY into apps/server/.env and setting USE_ANTHROPIC=1)
./scripts/run-full-eval.sh
```
