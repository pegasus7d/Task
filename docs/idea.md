# HEALOSBENCH — Design Document (`idea.md`)

> Production-grade evaluation harness for clinical-transcript JSON extraction
> Target model: **Anthropic Haiku 4.5** (`claude-haiku-4-5-20251001`)
> Strategies: `zero_shot`, `few_shot`, `cot`
> Output discipline: **strict tool-use**, **retry-with-feedback ≤3**, **prompt caching**, **bounded concurrency**, **resumable runs**, **compare-runs UI**

---

## Table of Contents

1. [Problem Understanding](#1-problem-understanding)
2. [Research Synthesis](#2-research-synthesis)
3. [System Architecture](#3-system-architecture)
4. [Prompting Strategies](#4-prompting-strategies)
5. [Evaluation Design](#5-evaluation-design)
6. [Retry & Feedback Loop Design](#6-retry--feedback-loop-design)
7. [Caching Strategy](#7-caching-strategy)
8. [Multiple Architecture Approaches](#8-multiple-architecture-approaches)
9. [Key Insights (Non-Obvious)](#9-key-insights-non-obvious)
10. [Recommendations](#10-recommendations)
11. [Appendix — Source Index](#11-appendix--source-index)

---

## 1. Problem Understanding

### 1.1 What this task is *really* about

On the surface this looks like an information-extraction task: turn a doctor-patient transcript into structured JSON across six fields (`chief_complaint`, `vitals`, `medications`, `diagnoses`, `plan`, `follow_up`). It is not. **The deliverable is not the extractor — it is the harness that lets you decide which extractor to ship.**

The brief makes this explicit: "you can't just *vibe-check* the prompt — you need a repeatable evaluation harness that tells you, with numbers, whether prompt v7 is better than prompt v6, on which fields, and where it fails." The most important screen is the **compare view**, not the dashboard, not the runner. Every other piece of the system (caching, retries, concurrency, resumability, prompt hashing, idempotency) is in service of producing **trustworthy, reproducible numbers** — because if the numbers are noisy, every prompt-engineering choice downstream is a coin flip.

That reframes the whole problem:

| Surface read | Real read |
| --- | --- |
| "Extract clinical JSON" | "Make the extractor's improvements *measurable* and *attributable* to specific changes" |
| "Build three prompt strategies" | "Design a controlled experiment where strategy is the only varied axis" |
| "Use tool-use, retries, caching" | "Eliminate cost, randomness, and engineering noise so the *prompt* is what's being measured" |
| "Compare view" | "Decision-support UI: which prompt ships?" |

### 1.2 The four hardest sub-problems

1. **Per-field evaluation that respects field semantics.** A single fuzzy-match-everything scorer would silently lie. `vitals.temp_f` needs ±0.2 °F tolerance; `medications` needs set-F1 over canonicalized records; `diagnoses` benefits from ICD-10 hierarchical partial credit; `plan` needs token-set fuzzy matching; `chief_complaint` is a single span. The **right metric per field** is half the project.
2. **Hallucination detection.** Clinical extraction is a domain where the worst failure is a **plausible-but-fabricated** dose or diagnosis — the model nailing the schema, scoring well on F1, and inventing a value not in the transcript. Schema validity does not catch this; only a grounding check does.
3. **Reproducibility under retries and caching.** Prompt caching, retry-with-feedback, and concurrency all introduce *non-determinism* (cache state, retry order, race conditions). The harness must produce the same aggregate F1 across two runs of the same `(prompt_hash, dataset_hash, model_id)` tuple, or comparison is meaningless.
4. **Cost & rate-limit envelope.** A 50-case run × 3 strategies × ≤3 retries can balloon to ~450 LLM calls. Without prompt caching this is expensive at Haiku and over rate-limit on Tier 1. Caching is not a nice-to-have — it is the load-bearing wall that keeps the harness inside its <$1 budget.

### 1.3 Success criteria, restated

A reviewer reading the compare view should be able to answer in <60 seconds:
- Which strategy wins on aggregate F1?
- On *which fields* does each strategy win?
- Which cases regressed when switching strategies?
- What were the failure modes (schema, hallucination, partial extraction)?
- Was the comparison fair (same dataset version, same prompt hashes pinned)?

If the answer to any of those is "you'd have to run a script," the harness has failed.

---

## 2. Research Synthesis

This section distills the load-bearing insights from Anthropic engineering, OpenAI cookbook, eval methodology blogs (Husain, Yan, Shankar, Bischof), production platforms (Braintrust, Inspect AI, Promptfoo, LangSmith, lm-evaluation-harness), and the prompting literature (Wei 2022, Kojima 2022, Wang 2022, Yao 2023, Shinn 2023, Madaan 2023, Dhuliawala 2023, Schulhoff 2024). Full URLs in §11.

### 2.1 Anthropic — what their docs *force* you to design

**Tool-use as the structured-output mechanism, not JSON mode, not prefill.**
Force `tool_choice = {"type":"tool","name":"extract_clinical"}` with `strict: true`. Strict mode compiles your JSON Schema into a sampling grammar — the model literally cannot emit `"two"` for an integer field, drop a `required` field, or hallucinate keys. ([anthropic strict tool use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use))

Strict-mode schema subset is real and constrains design: supports `enum` (primitives only), `const`, `anyOf`, `additionalProperties:false`, `required`, regex `pattern`, but **not** `minimum`/`maximum`/`minLength`/`maxLength`. Hard caps: 20 strict tools / request, 24 optional params, 16 union-typed params. ([structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs))

**HIPAA caveat: strict-mode schemas are cached server-side for ≤24h and "do not receive the same PHI protections as prompts and responses."** No PHI in property names, enums, consts, or regex patterns. Transcripts (the PHI surface) live only in `messages[].content`. Even though our data is synthetic, this discipline matters for the design.

**Prompt caching is the largest cost lever — and has a Haiku-4.5-specific gotcha.**
- Minimum cacheable prefix on Haiku 4.5: **4,096 tokens** (vs 1,024 on Sonnet 4.5, 2,048 on Haiku 3.5). Below threshold, caching silently no-ops (`cache_creation_input_tokens` and `cache_read_input_tokens` both 0). ([prompt caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching))
- Pricing: cache reads cost **0.1× base**, 5-min writes 1.25×, 1-hour writes 2.0×.
- **Cached input does not count toward Haiku 4.5 ITPM.** Effective throughput multiplies by your cache-hit ratio.
- Cache prefix order is fixed: `tools` → `system` → `messages`. Up to 4 `cache_control` breakpoints per request.
- Mutating *anything* upstream invalidates *everything* downstream.

**Forced tool-use is incompatible with extended/adaptive thinking.** Use **manual CoT** with `<thinking>` XML tags instead of the `thinking` parameter. ([extended thinking docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking))

**Anthropic's "evaluator-optimizer" pattern in *Building Effective Agents* (Dec 2024) = exactly your retry-with-feedback loop.** "One LLM generates responses while another provides iterative feedback in a loop." Encode validation errors as `tool_result` with `is_error: true` and a structured feedback payload. ([building effective agents](https://www.anthropic.com/engineering/building-effective-agents))

**Hallucination guidance — five techniques the Anthropic docs explicitly recommend:**
1. Allow "I don't know"
2. Extract direct quotes first
3. Require citations per claim
4. Chain-of-thought verification
5. External-knowledge restriction

The reduce-hallucinations doc literally uses an "AI physician's assistant" example with a quote-extraction pattern. ([reduce hallucinations](https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)) **Bake `evidence_quote` into the schema as a sibling field.**

**Tier-1 rate limits on Haiku 4.5:** 50 RPM / 50,000 ITPM / 10,000 OTPM. RPM is the binding constraint at full concurrency for a 50-case × 3-strategy × ≤3-retry run (~450 calls). ([rate limits docs](https://platform.claude.com/docs/en/api/rate-limits))

Response headers for adaptive throttling: `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` plus `retry-after` on 429. Reset values are RFC-3339 timestamps. **Idempotency-Key is not publicly documented on Messages API** — build it at the harness layer.

### 2.2 OpenAI — transferable methodology even though we use Anthropic

**Structured Outputs discipline: `additionalProperties:false` + all-fields-required.** ([openai structured outputs cookbook](https://developers.openai.com/cookbook/examples/structured_outputs_intro)) Designing the schema to satisfy *both* OpenAI's and Anthropic's strict modes makes it portable and forces explicit nullability — which clinical data needs (vitals fields are commonly `null`).

**Reliability gains from CoT — citable numbers.** "Let's think step by step" lifted MultiArith 18% → 79%; least-to-most decomposition 16% → 99.7% on long chains; verifier+sampling 33% → 55% on grade-school math. ([techniques to improve reliability](https://developers.openai.com/cookbook/articles/techniques_to_improve_reliability)) This justifies CoT as a *strategy worth measuring* — you should expect 5–15 pp F1 movement on free-text fields.

**`api_request_parallel_processor.py` pattern.** ([rate-limits cookbook](https://developers.openai.com/cookbook/examples/how_to_handle_rate_limits)) JSONL-in / JSONL-out, semaphore-bounded concurrency, RPM+TPM token-bucket throttling. Adopt the architecture; substitute SQLite for JSONL output for resumability.

**Retry recipe.** `wait_random_exponential(min=1, max=60), stop_after_attempt(6)` for HTTP-error retries. Distinct from your validation-feedback retry budget.

### 2.3 Eval methodology — Husain, Yan, Shankar, Bischof

**Hamel Husain's three-level hierarchy.** ([hamel.dev/blog/posts/evals](https://hamel.dev/blog/posts/evals/))
- **L1**: deterministic unit-test-style assertions (run on every commit) — schema validity, required-field coverage, evidence-quote substring presence, enum membership.
- **L2**: human + LLM-judge evaluation calibrated against a 10–20 case human-labeled subset. Husain's empirical: judge-human alignment converges in 3–4 iterations.
- **L3**: A/B in production. Out of scope for this harness.

Husain's three operational rules: "remove ALL friction from looking at data," "use what you have first," "you are doing it wrong if you aren't looking at lots of data." → The compare view *is* the friction-removal layer; treat it as P0.

**Eugene Yan — extraction-as-classification.** ([eugeneyan.com/writing/evals](https://eugeneyan.com/writing/evals/)) For extraction tasks: per-field **precision and recall**, not whole-record accuracy. "Accuracy is too coarse." He explicitly *dismisses* ROUGE/BERTScore/MoverScore/G-Eval for free-text on grounds of poor distribution separation. → Use NLI grounding instead of G-Eval.

**Shreya Shankar — *Who Validates the Validators?* (UIST '24).** ([arxiv.org/abs/2404.12272](https://arxiv.org/abs/2404.12272)) When you build LLM-judge prompts, they inherit the failure modes of the underlying model. Calibrate against ≥20 human-labeled cases; reject judges with Cohen's κ < 0.6. Build the calibration loop directly into the dashboard.

**Bryan Bischof (Hex) — "many small evaluators."** ([humanloop.com/blog/LLM-eval-done-right](https://humanloop.com/blog/LLM-eval-done-right)) Decompose evals into atomic scorers (one per field × tolerance mode). Aggregate to per-strategy F1 in the UI; **store atomic scores** so you can drill into "Strategy 2 regressed on `medications.dose`" without re-running.

**Jason Liu — Instructor's retry-with-feedback.** ([github.com/567-labs/instructor](https://github.com/567-labs/instructor)) Catch `ValidationError` → inject error message as a new turn → re-call. Default `max_retries=1`; for clinical data, **2–3 retries is the sweet spot**.

### 2.4 Eval platforms — feature surface to copy

| Platform | What to steal |
| --- | --- |
| **Braintrust** ([docs](https://www.braintrust.dev/docs/evaluate)) | Datasets / Experiments / Scorers abstraction; **Compare view** terminology — "improved / regressed / unchanged" cases per metric |
| **Inspect AI** ([inspect.aisi.org.uk](https://inspect.aisi.org.uk/)) | **Task / Solver / Scorer** decomposition. Each strategy = solver; each metric = scorer. Adding strategy-D becomes a 50-line change. |
| **Promptfoo** ([promptfoo.dev](https://www.promptfoo.dev/docs/configuration/expected-outputs/)) | `assert-set` with thresholds + per-assertion `weight`. Lets you say "case passes if ≥4 of 6 fields are correct" or "vitals errors weigh 2× follow_up errors." |
| **LangSmith** ([docs](https://docs.langchain.com/langsmith/evaluation)) | **Dataset versioning** as immutable named versions. Reject cross-version comparisons in the compare UI. |
| **lm-evaluation-harness** ([github](https://github.com/EleutherAI/lm-evaluation-harness)) | `VERSION` field on every task. Result tuple = `(model_id, task_name, task_version, dataset_version)`. Borrow this discipline. |
| **Simon Willison's `llm` CLI** ([github](https://github.com/simonw/llm)) | **Every prompt + response logged to SQLite.** A harness is ~80% disciplined logging. |

### 2.5 The prompting literature — what to actually use

The Schulhoff *Prompt Report* survey ([arxiv.org/abs/2406.06608](https://arxiv.org/abs/2406.06608)) catalogs 58 text-based prompting techniques. For our extraction harness only a handful are relevant; the rest are noise. The keepers:

| Technique | Source | In harness? |
| --- | --- | --- |
| Zero-shot | [Brown 2020](https://arxiv.org/abs/2005.14165) | **Yes — Strategy 1** |
| Few-shot (k=3–5) | Brown 2020; [Anthropic prompting docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering) | **Yes — Strategy 2** |
| Chain-of-Thought (manual, in `<thinking>`) | [Wei 2022](https://arxiv.org/abs/2201.11903) / [Kojima 2022](https://arxiv.org/abs/2205.11916) | **Yes — Strategy 3** |
| Self-Consistency | [Wang 2022](https://arxiv.org/abs/2203.11171) | Optional — costs N× |
| Reflexion / Self-Refine | [Shinn 2023](https://arxiv.org/abs/2303.11366) / [Madaan 2023](https://arxiv.org/abs/2303.17651) | **Implicit in retry-with-feedback** |
| Chain-of-Verification | [Dhuliawala 2023](https://arxiv.org/abs/2309.11495) | **Strategy 4 (stretch)** — best hallucination defense |
| Plan-and-Solve | [Wang 2023](https://arxiv.org/abs/2305.04091) | Embed inside CoT prompt |
| Step-Back | [Zheng 2023](https://arxiv.org/abs/2310.06117) | Optional |
| Tree of Thoughts / Graph of Thoughts | Yao 2023 / Besta 2023 | **Skip** — overkill for extraction |
| Skeleton-of-Thought / Generated Knowledge / Analogical | various | **Skip** |

**Verdict:** the canonical three (zero-shot, few-shot, CoT) cover 90% of the achievable signal. Reflexion semantics *already* live inside the validation-retry loop. CoVe is the natural Strategy 4 if time permits.

### 2.6 Hallucination detection landscape

- **Substring/fuzzy-substring grounding** — cheap, deterministic, ~100% precision, ~70% recall. Run on every output.
- **Chain-of-Verification (CoVe)** — 50–70% hallucination reduction on QA. Independence between draft and verification is load-bearing — *separate* API calls.
- **SelfCheckGPT** — sample N at non-zero temperature, score divergence via NLI. Costs N×; reserve as a tiebreaker.
- **NLI-based entailment** — DeBERTa-v3-large MNLI off-the-shelf; ~50ms CPU/inference. Use for `chief_complaint` and `plan` where paraphrase defeats substring matching.
- **G-Eval** — explicitly *avoid* per Yan's empirical critique (poor distribution separation at small N).

---

## 3. System Architecture

### 3.1 Layered architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        apps/web (Next.js 16)                           │
│  Runs list │ Run detail │ Case drill-down │ COMPARE VIEW │ Trace view │
│                          ↑ SSE + REST                                   │
└────────────────────────────────────────────────────────────────────────┘
                                   ↑
┌────────────────────────────────────────────────────────────────────────┐
│                      apps/server (Hono on :8787)                       │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │  HTTP Layer    POST /runs · GET /runs · GET /runs/:id (SSE)      │ │
│  │                POST /runs/:id/resume · GET /runs/compare?a=&b=  │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │  Runner        Job queue + bounded concurrency (8)                │ │
│  │                Resume scanner · Idempotency check · SSE pub      │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │  Strategy      ZeroShot · FewShot(k=3) · CoT(<thinking>)         │ │
│  │  Layer         All share tool definition + system prompt          │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │  Extractor     packages/llm — Anthropic SDK wrapper               │ │
│  │                Tool-use forced · cache_control · streaming        │ │
│  │                Retry-with-feedback ≤3 (Reflexion-shaped)          │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │  Validator     ajv (strict) + Zod runtime checks                  │ │
│  │                Schema errors → structured feedback payload        │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │  Evaluator     Per-field scorers (10+ atomic)                     │ │
│  │                Hallucination detector · L1/L2 split                │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │  Storage       Postgres + Drizzle: runs, attempts, scores, traces │ │
│  │                Content-addressable raw response files on disk     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
                                   ↑
┌────────────────────────────────────────────────────────────────────────┐
│  packages/shared    Types: Schema, Run, Attempt, Score, Trace          │
│  packages/llm       Strategy registry, prompt-hashing, cache-control   │
│  packages/db        Drizzle schema · migrations                        │
└────────────────────────────────────────────────────────────────────────┘
                                   ↑
                            Anthropic Messages API
                       (Haiku 4.5 · strict tool use)
```

### 3.2 Database schema (Drizzle / Postgres)

```ts
runs (
  id            uuid PK,
  strategy      enum('zero_shot','few_shot','cot'),
  model         text,                    -- 'claude-haiku-4-5-20251001'
  prompt_hash   text,                    -- sha256 of rendered prompt template
  schema_hash   text,
  dataset_hash  text,                    -- sha256 of JSONL of all transcripts
  status        enum('queued','running','completed','failed','cancelled'),
  started_at    timestamptz,
  completed_at  timestamptz,
  total_input_tokens         int,
  total_output_tokens        int,
  total_cache_read_tokens    int,
  total_cache_creation_tokens int,
  total_cost_usd             numeric,
  notes         text
)

attempts (
  id            uuid PK,
  run_id        uuid FK,
  case_id       text,                    -- 'case_001'
  attempt_idx   int,                     -- 1..3
  status        enum('queued','in_flight','succeeded','schema_invalid',
                     'feedback_retry','rate_limited','failed_terminal'),
  started_at    timestamptz,
  completed_at  timestamptz,
  input_tokens  int,
  output_tokens int,
  cache_read_input_tokens     int,
  cache_creation_input_tokens int,
  anthropic_request_id        text,      -- audit only, NOT idempotency key
  raw_response_path           text,      -- 'runs/{run_id}/{case_id}/attempt_{n}.jsonl'
  predicted_json              jsonb,     -- after successful tool_use
  validation_errors           jsonb,     -- structured array
  retry_reason                text,
  prompt_hash                 text,      -- redundant w/ run for fast filtering
  PRIMARY KEY (run_id, case_id, attempt_idx)
)

scores (
  id            uuid PK,
  attempt_id    uuid FK,
  scorer_name   text,                    -- 'chief_complaint_fuzzy', 'medications_setF1', ...
  scorer_version int,                    -- bump on rubric change
  field_path    text,                    -- e.g. 'medications[0].dose'
  value         numeric,                 -- ∈ [0,1]
  metadata      jsonb                    -- e.g. { precision, recall, partial_credit }
)

traces (
  id            uuid PK,
  attempt_id    uuid FK,
  event_idx     int,
  event_type    text,                    -- 'request', 'sse_delta', 'tool_use', 'validation', 'feedback'
  payload       jsonb,
  ts            timestamptz
)

prompt_templates (
  hash          text PK,                 -- content-addressed
  strategy      text,
  template_body text,
  variables     jsonb,
  created_at    timestamptz
)
```

### 3.3 Module breakdown

**`packages/llm`** — the Anthropic SDK wrapper.
- `Strategy` interface: `buildMessages(transcript) → { system, messages, tools, cache_control }`
- `extract(transcript, strategy) → ExtractionResult`
- `RetryLoop`: validation → feedback message → re-call, ≤3 attempts.
- `PromptHash`: SHA-256 of *rendered* prompt (post-template, post-fewshot-injection).
- `Cache controller`: places `cache_control: {type:"ephemeral", ttl:"1h"}` after tool definition + system prompt.

**`apps/server/src/services/`**
- `extract.service.ts` — single-case orchestration. Calls `packages/llm`, validates, retries.
- `evaluate.service.ts` — runs every scorer over `(predicted, gold, transcript)`.
- `runner.service.ts` — concurrency, rate-limit-aware throttling, SSE pub, resume.
- `compare.service.ts` — assembles per-field deltas + bootstrap CIs for two run IDs.

**`packages/shared`**
- DTOs: `ExtractionSchema`, `RunDTO`, `AttemptDTO`, `ScoreDTO`, `CompareDTO`.
- Zod schemas mirror the JSON Schema (single source-of-truth via `zod-to-json-schema`).

### 3.4 API surface

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/runs` | `{strategy, model, dataset_filter?, force?}`. Returns `{run_id}`. Idempotent on `(strategy, model, prompt_hash, dataset_hash)` unless `force=true`. |
| `GET` | `/api/v1/runs` | List runs with aggregate metrics |
| `GET` | `/api/v1/runs/:id` | Run detail |
| `GET` | `/api/v1/runs/:id/stream` | **SSE**: emits `attempt_started`, `attempt_completed`, `case_scored`, `run_completed` events |
| `POST` | `/api/v1/runs/:id/resume` | Re-queues `queued` + stale `in_flight` attempts |
| `GET` | `/api/v1/runs/compare?a=&b=` | Per-field deltas, winners, regression list |
| `GET` | `/api/v1/cases/:case_id/transcript` | For UI grounding-highlight |

### 3.5 CLI

```
bun run eval -- --strategy=cot --model=claude-haiku-4-5-20251001 [--cases case_001,case_002] [--no-cache] [--budget=1.00]
```

Single command runs the full eval, prints a summary table, exits 0 on success. Used by CI.

---

## 4. Prompting Strategies

### 4.1 The three strategies — controlled-experiment design

The strategies must be **meaningfully different**, not three flavors of the same prompt. The reviewer's "what does this measure?" question must have a clear answer per strategy. The shared layer (tool definition + system prompt) is **identical** across all three; only the suffix differs. This makes strategy the only varied axis.

**Shared layer (cached @ breakpoint #1, 1-hour TTL):**

```ts
tools = [{
  name: "extract_clinical",
  description: `Record the structured clinical findings from the encounter.
    Required fields must always have evidence quotes verbatim from the transcript.
    Set fields to null and add to unanswered[] if not stated.`,
  input_schema: ClinicalExtractionSchema,         // strict, additionalProperties:false
  cache_control: { type: "ephemeral", ttl: "1h" }
}];

system = [{
  type: "text",
  text: SYSTEM_PROMPT_BODY,                       // same for all 3 strategies
  cache_control: { type: "ephemeral", ttl: "1h" }
}];
```

#### Strategy A — `zero_shot` (baseline)

```
<task>Extract structured clinical fields from the transcript.</task>
<rules>
  - Use only information present in the transcript.
  - If a field is not stated, set it to null. Do not infer.
  - Call the `extract_clinical` tool exactly once.
</rules>
<transcript>{TRANSCRIPT}</transcript>
```

`tool_choice = {type:"tool", name:"extract_clinical"}`, `temperature=0`.

**Measures:** the floor — what does Haiku 4.5 produce on this schema with no scaffolding?

#### Strategy B — `few_shot` (k=3 diverse exemplars, after the cache breakpoint)

After the system prompt's cache breakpoint, inject 3 examples wrapped in `<examples>`:

```
<examples>
  <example>
    <transcript>...clean URI visit...</transcript>
    <output>{... clean JSON, all fields populated ...}</output>
  </example>
  <example>
    <transcript>...ambiguous symptoms, vitals partly null...</transcript>
    <output>{... JSON with nulls + unanswered[] ...}</output>
  </example>
  <example>
    <transcript>...med-change visit with dose adjustment...</transcript>
    <output>{... JSON with structured medications array ...}</output>
  </example>
</examples>
<transcript>{TRANSCRIPT}</transcript>
```

3–5 examples, diverse, structured ([Anthropic multishot guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering)). Examples placed *after* the system breakpoint go behind their own cache_control breakpoint (#2), paid for once per strategy.

**Measures:** how much does *demonstrating the format* lift over zero-shot? Expected wins on edge-case fields (`null` handling, unanswered tracking).

#### Strategy C — `cot` (manual chain-of-thought via `<thinking>`)

```
<task>Extract structured clinical fields from the transcript.</task>
<process>
  Before calling `extract_clinical`, write a <thinking> block that:
    1. Lists each field required by the schema.
    2. For each field, quotes the relevant transcript span (or marks it absent).
    3. Notes any normalization decisions (dose units, ICD-10 mapping).
  Then call the tool.
</process>
<transcript>{TRANSCRIPT}</transcript>
```

Manual CoT is required because **forced tool-use is incompatible with the native `thinking` parameter** ([extended thinking docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)). The `<thinking>` content arrives as a regular text block before the `tool_use` block; the harness logs it for the trace view but does not score it.

**Measures:** does explicit per-field reasoning improve recall and reduce hallucination? Expected: 5–15 pp F1 lift on `medications` and `diagnoses`; +30% output tokens.

### 4.2 Strategy comparison — when each works best

| Axis | zero_shot | few_shot | cot |
| --- | --- | --- | --- |
| **Latency** | Lowest (~500 ms median for Haiku) | Same as zero_shot for output; ~+5% for input | ~+30% (more output tokens) |
| **Input tokens** | Floor | +1.5–3k for k=3 examples (cached after first call) | Same as zero_shot |
| **Output tokens** | Floor | Floor | +30–60% (the `<thinking>` block) |
| **Cost vs zero_shot** | 1.0× | 1.0–1.05× steady-state (cached examples) | 1.3–1.5× |
| **Schema-valid rate** | High with strict tool-use | Highest | High; CoT can occasionally over-narrate |
| **Hallucination rate** | Highest baseline | Lower (format-anchored) | Lowest (evidence-tracking) |
| **F1 on `vitals`** | High (numeric, easy) | Marginal lift | Marginal lift |
| **F1 on `medications`** | Mid (dose/freq drift) | Higher (canonicalized examples) | Highest (per-field reasoning) |
| **F1 on `diagnoses`** | Mid (ICD-10 misses) | Higher | Highest |
| **F1 on `plan`** (free text) | Lower (fuzzy by nature) | Higher | Highest |
| **Best when** | High-signal transcripts, simple cases | Format ambiguity matters | Medical reasoning matters |
| **Worst when** | Edge cases (null, ambiguity) | Examples poorly chosen | Latency-sensitive |

### 4.3 What we deliberately *don't* do

- **No native `thinking` parameter** (forced-tool incompatible).
- **No prefill `{` hack** — deprecated on newer Claude models, returns 400 on Mythos/Opus 4.7/Sonnet 4.6 ([structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)).
- **No JSON.parse on raw model text** — fails the brief's hard requirement.
- **No Self-Consistency / Tree of Thoughts** — N× cost, doesn't fit the budget, and extraction isn't a search problem.
- **No retrieval-augmented few-shot** — kNN exemplar selection over 50 cases is overfit risk.

---

## 5. Evaluation Design

### 5.1 Per-field metric selection — with justification

Following Eugene Yan's "extraction-as-classification" framing: per-field precision and recall, never whole-record accuracy. Field metric must match field semantics.

| Field | Type | Metric | Library | Threshold | Why |
| --- | --- | --- | --- | --- | --- |
| `chief_complaint` | single string | `token_set_ratio` (rapidfuzz) after lowercase + strip; substring fallback | rapidfuzz / fastest-levenshtein | ≥ 0.80 → 1.0; linear from 0.5 | Single span; word-order varies; NBME comp validated this approach |
| `vitals.bp` | regex string | exact match after normalizing `120/80` ↔ `120 / 80` | regex | exact | Format is deterministic |
| `vitals.hr` | int | `\|pred − gold\| ≤ 2 BPM` → 1.0; linear out to ±10 → 0.0 | numeric | ±2 | Clinical tolerance — EHR-validation standard |
| `vitals.temp_f` | float | `\|pred − gold\| ≤ 0.2 °F` → 1.0; linear out to ±1.0 → 0.0 | numeric | ±0.2 | Per spec; clinical tolerance |
| `vitals.spo2` | int | `\|pred − gold\| ≤ 2 %` → 1.0 | numeric | ±2 | Clinical tolerance |
| `medications` | list of objects | **micro-F1 over `(name_canonical, dose_canonical, freq_canonical)` triples**. Match: name fuzzy ≥0.92 (Jaro-Winkler) AND dose canonical-equal AND freq canonical-equal | rapidfuzz + custom canonicalizer | F1 | Set semantics — order-independent. Canonicalization is load-bearing (BID≡q12h≡twice daily; 10 mg≡10mg). |
| `diagnoses` | list of objects | **set-F1 by `description` token_set_ratio ≥ 0.75; bonus credit for ICD-10**: 1.0 exact, 0.5 category-prefix (`J06.9` vs `J06`), 0.0 miss | rapidfuzz + ICD-10 hierarchy | F1 + ICD bonus | Hierarchical partial credit per CMS coding evals |
| `plan` | list of strings | **set-F1** with `token_set_ratio ≥ 0.70` matching | rapidfuzz | F1 | Fuzziest — clinicians vary phrasing |
| `follow_up.interval_days` | int | exact match (or both `null`) | — | exact | Discrete, important |
| `follow_up.reason` | string | `token_set_ratio ≥ 0.70` | rapidfuzz | linear | Free text |

**Both Strict and Partial F1 reported for `medications` and `diagnoses`** ([Batista's NER eval guide](https://www.davidsbatista.net/blog/2018/05/09/Named_Entity_Evaluation/)). Strict = canonical-equal on all keys; Partial = name match + 0.5 credit if dose/freq drift. Don't average — show both columns. A strategy that boosts Partial at the cost of Strict is a different failure mode than one that drops records.

**Aggregate metric:** weighted F1 across fields, with weights expressing clinical importance (e.g. `medications` = 2.0, `diagnoses` = 2.0, `vitals` = 1.5, others = 1.0). Display weights in the UI; reviewer can re-weight.

### 5.2 Hallucination detection — three-tier strategy

**Tier 1 — Substring grounding (cheap, deterministic, run on every output).**
For every leaf string value in predicted JSON, assert it appears in the source transcript, where "appears" =
- Exact lowercased substring, OR
- `token_set_ratio ≥ 0.80` over a sliding ±20-token window around the candidate position.

This is ~100% precision (anything that fails is a real grounding miss) and ~70% recall as a hallucination flag (paraphrase + derived values escape it). Track per-field grounding rate. **A 1.0 F1 with grounding miss is the worst clinical failure mode** — it means the model has memorized the schema and is filling in plausible defaults.

**Tier 2 — Evidence-quote schema field (zero-extra-cost, prompt-side).**
Schema includes a sibling `evidence_quote` per medical field (`medications[*].evidence_quote`, `diagnoses[*].evidence_quote`, etc.). The L1 deterministic grounding check then runs over the model's own quotes — catches both fabrication and paraphrase failures.

**Tier 3 — NLI entailment (Tier-2 grounding signal, run on flagged cases).**
For `chief_complaint` and `plan` where paraphrase is normal, run DeBERTa-v3-large MNLI ([Hugging Face model](https://huggingface.co/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli)) over `(transcript, claim)` pairs. CPU-fine for 50 cases. Flag low-entailment outputs in the compare UI for human review.

**Stretch:** Chain-of-Verification (CoVe) as Strategy 4. Two-pass: extract → independent per-field "is this in the transcript?" → revise. ([Dhuliawala 2023](https://arxiv.org/abs/2309.11495)). 50–70% hallucination reduction on QA benchmarks.

### 5.3 Schema validation

Two layers:
1. **Strict mode at the API surface** (Anthropic compiles JSON Schema → grammar). Type errors and missing required fields disappear at decode time.
2. **AJV (TypeScript) post-validation** on the model output (paranoid second check; catches cases where strict-mode is bypassed or the schema engine has a bug).

Schema-invalid escapes to scoring should be < 1% with strict tool-use. Track and surface the rate in the run summary.

### 5.4 The L1 / L2 split

**L1 (deterministic, free, run on every commit):**
- Schema validity (AJV) per attempt
- Required-field coverage
- Evidence-quote substring presence
- Enum membership (route ∈ {PO, IV, IM, ...})
- Numeric tolerance pass/fail
- ICD-10 regex shape

**L2 (model-graded or NLI, run per finalized run):**
- LLM-judge faithfulness for `plan` and `chief_complaint` (Husain calibration: judge agreement with human labels on 10–20 case dev slice; reject judge if Cohen's κ < 0.6)
- NLI grounding on free-text fields
- Per-field rubric ("is the medication's dose stated?")

L3 (production A/B) is **out of scope** — there's no production traffic.

### 5.5 What the compare view must surface

Following Braintrust's "improved / regressed / unchanged" pattern:

```
COMPARE: run_a (few_shot @ prompt_v6) vs run_b (cot @ prompt_v7)

Aggregate F1:        0.82  →  0.86   ▲ +0.04   (95% CI [+0.01, +0.07])
Cost:                $0.34 →  $0.51  ▲ +$0.17  (+50%)
Wall time:           2:14  →  3:08
Schema-valid rate:   98%   →  100%

Per-field F1:                       Δ
  chief_complaint  0.91 → 0.93     +0.02   (no winner — within noise)
  vitals           0.96 → 0.96     +0.00
  medications      0.74 → 0.84     +0.10   ◎ COT wins
  diagnoses        0.71 → 0.81     +0.10   ◎ COT wins
  plan             0.79 → 0.82     +0.03
  follow_up        0.85 → 0.86     +0.01

Cases where run_b improved: 18 (case_007 +0.32, case_023 +0.28, ...)
Cases where run_a was better: 4 (case_011 -0.15, case_034 -0.09, ...)
Cases unchanged: 28

Hallucinations flagged:
  run_a: 6 (mostly medications.dose, 1 diagnosis)
  run_b: 2 (both medications.dose)

Strategy budget:
  run_a tokens:  in 12.3k   out 1.4k   cache_read 187k   cache_write 8.4k
  run_b tokens:  in 12.3k   out 4.2k   cache_read 187k   cache_write 8.4k
```

Click any case → side-by-side gold vs predicted JSON with field-level diff, transcript with grounded spans highlighted, full retry trace (every attempt, every tool_use, every validation error). This is the Husain "remove all friction from looking at data" payoff.

---

## 6. Retry & Feedback Loop Design

### 6.1 Three retry budgets — explicitly separated

The brief's "max 3 retries" applies to **validation feedback retries**. Transient HTTP errors get a *separate* budget; otherwise a 429 storm consumes your validation budget.

| Retry class | Trigger | Max | Backoff | Notes |
| --- | --- | --- | --- | --- |
| **Validation feedback** | AJV schema failure, grounding miss | **3** | None | Reflexion-shaped: error becomes a `tool_result` with `is_error:true` |
| **Rate-limit (429)** | `rate_limit_error` | 3 | Honor `retry-after` exactly, no jitter | RFC 3339 timestamp; sleep deterministically |
| **Overloaded (529) / 5xx** | `overloaded_error`, 500, 502, 503, 504 | 5 | **Full Jitter** exponential: `sleep = random(0, min(30s, 1s × 2^attempt))` | Per AWS Architecture Blog; 529 ≠ rate-limit |

**Non-retryable:** 400 (bad request), 401 (auth), 402 (payment), 403 (forbidden), 404, 413 (payload too large — 32 MB Messages API hard limit). Raise immediately; mark attempt `failed_terminal`.

### 6.2 The validation-feedback shape (Anthropic-specific)

When AJV rejects the model's tool input or substring grounding fails, the harness emits the next turn as:

```jsonc
{
  "role": "user",
  "content": [{
    "type": "tool_result",
    "tool_use_id": "<previous tool_use id>",
    "is_error": true,
    "content": JSON.stringify({
      "schema_errors": [
        { "instancePath": "/medications/0/dose", "message": "must be string, got number" }
      ],
      "grounding_misses": [
        { "field": "diagnoses[0].description",
          "value": "type 2 diabetes mellitus",
          "reason": "value not found in transcript (closest: 'diabetes')" }
      ],
      "hint": "Quote a verbatim transcript span in evidence_quote for each medical field; leave dose null if not stated."
    })
  }]
}
```

Then re-call with the **same tool definition** + `tool_choice = {type:"tool", name:"extract_clinical"}` — the model has been trained to revise its tool input given an error tool_result. This is exactly the evaluator-optimizer pattern from *Building Effective Agents*.

### 6.3 Avoiding infinite loops — terminal conditions

- `attempt_idx > 3` → mark `failed_terminal`, save last attempt's predicted_json (even if invalid) for the trace, score zero on schema-validity.
- **Same error twice in a row** → break out early. If attempts 1 and 2 produce the same validation error verbatim, the model is stuck; further retries are wasted spend. Track the error fingerprint per attempt.
- **Cost guardrail** → per-run `total_cost_usd` budget. Aborts the run cleanly with a partial-results state on breach.

### 6.4 Optimization — partial retry

When only one field fails validation, prefer a **partial re-extraction tool** (`extract_medications_only` etc.) targeting just the failed subset. The system prefix is already cached; the tool input is much smaller. Token cost: ~1/6 of a full retry on average.

This is the Instructor "field-level retry" pattern at finer granularity. Implementation cost: a small tool registry keyed by field-subset (build only the 3–4 most common subsets — `medications`, `diagnoses`, `vitals`, `plan` — covering >90% of validation failures per sample analysis).

### 6.5 Logging discipline

Every attempt, retry, and feedback turn writes a `traces` row. The trace view in the dashboard renders the full sequence chronologically:

```
attempt 1 [00:00.000] → request (tool_use)
attempt 1 [00:00.480] ← tool_use response (cache_read 4096, in 312, out 187)
attempt 1 [00:00.481] → AJV validation: 1 error (medications[0].dose: required)
attempt 2 [00:00.482] → request (tool_result is_error:true + retry hint)
attempt 2 [00:00.871] ← tool_use response (cache_read 4096, in 412, out 195)
attempt 2 [00:00.872] → AJV validation: pass
attempt 2 [00:00.873] → grounding check: pass
                        SCORE COMPUTED.
```

---

## 7. Caching Strategy

### 7.1 Why caching is load-bearing

A 50-case × 3-strategy × ≤3-attempt run = up to 450 LLM calls. Without caching at Tier 1 Haiku 4.5: ~50–80k input tokens × 450 calls × $1/MTok = **$22+ per run** (over budget) and rate-limited to ~500 RPM equivalent input tokens (over Tier-1 ITPM).

With 1-hour TTL caching on the shared prefix, ≥95% of total input tokens become **cache reads at 0.1× base price** after the first call per strategy. Expected total cost: **~$0.30–$0.60 per full 3-strategy run** — comfortably inside the brief's <$1 budget.

### 7.2 The Haiku 4.5 cache-minimum gotcha

**Haiku 4.5 minimum cacheable prefix is 4,096 tokens** ([prompt caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)). Below threshold, caching silently no-ops. Verify by checking that `cache_creation_input_tokens` > 0 on the first call and `cache_read_input_tokens` > 0 on subsequent calls.

A bare system prompt + tool definition for this harness will be ~1,500–2,500 tokens — **likely below threshold**. Three options:

1. **Pad to threshold deliberately**: include 3 stable few-shot examples *in the cached system prefix* for all strategies. Increases shared prefix to ~5–6k tokens, comfortably caches. Trade-off: zero_shot strategy now sees examples, blurring the comparison.
2. **Pad with reference material**: include a stable medical-abbreviation glossary, ICD-10 quick reference, and the schema description in natural language as "context." Easily clears 4k tokens, doesn't change the strategy comparison.
3. **Accept no-cache for zero_shot only**: budget the extra cost. 50 zero_shot calls × ~2k input × $1/MTok = $0.10 — affordable.

**Recommendation: option 2.** The reference material is pedagogically defensible (the model genuinely benefits from a clinical glossary), keeps the strategy comparison clean, and crosses the threshold reliably.

### 7.3 Cache breakpoint placement

Two breakpoints, ordered:

```ts
// Breakpoint 1 — shared across all 3 strategies, all 50 cases. 1h TTL.
tools: [{ ...tool, cache_control: { type: "ephemeral", ttl: "1h" } }]
system: [
  { type: "text", text: SYSTEM_BODY + REFERENCE_MATERIAL,
    cache_control: { type: "ephemeral", ttl: "1h" } }
]

// Breakpoint 2 — strategy-specific (e.g. few-shot examples or CoT scaffold).
// Differs across strategies but is SHARED across the 50 cases of that strategy.
messages: [
  { role: "user", content: [
    { type: "text", text: STRATEGY_SUFFIX,
      cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: `<transcript>${transcript}</transcript>` }
  ]}
]
```

**Effect:** breakpoint 1 is written on the first call of the run and read on the next 449. Breakpoint 2 is written on the first call of each strategy and read on the next 49 of that strategy. The transcript content (variable) is *after* breakpoint 2 and never cached.

### 7.4 Cache invalidation discipline

Mutating *anything* upstream invalidates *everything* downstream. Specifically:
- Changing the **tool definition** invalidates tools + system + messages cache.
- Changing the **system prompt** invalidates system + messages cache.
- Changing **`tool_choice`** invalidates only messages cache.
- Changing the strategy suffix invalidates messages cache for that strategy only.

**Pin everything via content hashing.** The harness records `prompt_hash = sha256(rendered_template + variables)` for each attempt. The compare view rejects cross-prompt-hash comparisons silently turning into cross-cache-state confusion.

### 7.5 1-hour vs 5-min TTL

5-min writes cost 1.25× base; 1-hour writes cost 2.0× base. Break-even crossover at **6 reads per cache entry** within the cache lifetime. This harness reads each cached prefix 50–150× per run. **1-hour TTL is the right choice.**

For dev workflows where the developer iterates the prompt, 5-min TTL would be better (less waste on invalidation), but those iterations should bump the prompt hash anyway, invalidating cache. The 1-hour pricing is for the eval-pipeline use case, which is the dominant one here.

### 7.6 Pre-warming workaround

`max_tokens: 0` pre-warming is **not supported** with `tool_choice = {type:"tool"}` or streaming ([prompt caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)). Workaround: pre-warm with `tool_choice: "auto"` + `max_tokens: 1` *before* fanning out the run. The cached `tools` and `system` prefixes are reused; only the messages-cache fingerprint differs. Eliminates the cache-write spike on the first concurrent batch.

### 7.7 Cost accounting

Surface in the run summary:
- `total_input_tokens` (uncached portion)
- `total_cache_creation_input_tokens` × 2.0× pricing (1-hour TTL)
- `total_cache_read_input_tokens` × 0.1× pricing
- `total_output_tokens` × output price

Plus the **derived efficiency ratio** = `cache_read / (input + cache_create + cache_read)` — the headline caching metric. Target: > 0.85 for any non-first call.

---

## 8. Multiple Architecture Approaches

Three concrete architectures, increasing in sophistication. The brief asks for production-grade; we'll design it that way, but document the cheaper alternatives so trade-offs are explicit.

### 8.1 Approach A — Simple Baseline (~1 day to build)

**Stack:** single Bun script, JSONL output, no DB, no UI.

**Components:**
- `extract.ts` — synchronous loop over 50 cases × 3 strategies, calls Anthropic, parses tool_use, writes JSONL.
- `evaluate.ts` — reads JSONL, runs scorers, prints summary table.
- No caching, no retries, no concurrency, no resume.

**Pros:** ~250 LOC. Fast to ship. Sufficient for a one-time experiment.

**Cons:** Fails 7 of 10 hard requirements: no retry-with-feedback, no caching, no concurrency, no resume, no idempotency, no compare UI, no SSE.

**Verdict:** insufficient for the brief. Useful as a v0 to validate the schema and scorer math.

### 8.2 Approach B — Intermediate Single-Process Harness (~3–5 days)

**Stack:** apps/server only (no UI), Postgres for runs/attempts, CLI-only.

**Components:**
- All packages from §3.3.
- Strict tool-use, retry-with-feedback ≤3, prompt caching ✓.
- Bounded concurrency (8) via `bottleneck` or `p-queue`.
- Resume via SQL `WHERE status IN ('queued','in_flight')`.
- Stdout-only output; CLI prints a summary table.
- Compare via a CLI command: `bun run compare -- --a=run_xxx --b=run_yyy` printing a diff to stdout.

**Pros:** Hits 8 of 10 hard requirements (missing: nice compare UI, SSE streaming).
**Cons:** No human-friendly UI; comparison is text-only.
**Verdict:** Acceptable but loses the "compare view = decision-support" point. Skip.

### 8.3 Approach C — Production-Grade Harness (recommended, ~8–12 hours focused work as the brief targets)

**Stack:** the full monorepo as already wired up: Hono + Next.js + Postgres + Drizzle.

**Components:**
- All of Approach B's machinery.
- **SSE streaming** of attempt progress to the dashboard.
- **Compare view** — Braintrust-style side-by-side per-field deltas with regression callouts and bootstrap CIs.
- **Run detail** — case table, click-through trace, transcript with grounded spans highlighted.
- **CLI** for CI / reproducibility.
- **Idempotency keys** built at the harness layer (`sha256(prompt_hash + tools_hash + temperature + max_tokens + case_id + attempt_idx)`).
- **Prompt content hashing** for reproducibility.

**Time budget allocation (within the 8–12 hour target):**

| Block | Hours | Notes |
| --- | --- | --- |
| Schema + types + Zod ↔ JSON Schema | 0.5 | Single source of truth |
| `packages/llm` strategy registry + cached prompts | 1.5 | The hardest part to get right |
| Retry-with-feedback loop | 1.0 | Reflexion-shaped; structured error payload |
| Validator + grounding detector | 1.5 | AJV + substring + windowed fuzzy |
| Per-field scorers | 1.5 | 10+ atomic scorers, table-driven |
| Runner: concurrency + bottleneck + resume | 1.0 | bottleneck + DB state machine |
| API routes + SSE | 0.5 | Hono is fast |
| DB schema + migrations | 0.5 | Drizzle |
| Compare view | 2.0 | The most important screen — make it good |
| Run detail + trace view | 1.0 | Diff JSONs, highlight transcript |
| Tests (≥8) | 1.0 | Schema-retry, fuzzy, F1, grounding, resume, idempotency, rate-limit, prompt-hash |
| CLI + smoke run + NOTES.md | 0.5 | |
| **Total** | **12.5** | Within the brief's "polished 35-case beats buggy 50-case" tolerance |

**Verdict: this is the recommended approach.** It's the minimum that hits all 10 hard requirements *and* makes the compare view actually decision-supporting.

### 8.4 Approach D — Stretch (post-brief, only if time permits)

- **Strategy 4 — CoVe-flavored two-pass extract-then-verify.** ([Dhuliawala 2023](https://arxiv.org/abs/2309.11495)) Costs 2× but should beat all three baselines on hallucination metrics.
- **Active-learning hint:** surface 5 cases with highest cross-strategy disagreement — these are the cases most worth annotating better.
- **Cost guardrail:** projected-cost estimator that refuses to start a run > $X.
- **Cross-model comparison:** add Sonnet 4.6 as a second model so the compare view also handles model deltas.
- **Regression CI:** a GitHub Action that runs the eval on PR and posts the compare-view summary as a PR comment.
- **NLI-based grounding tier** for `chief_complaint` and `plan`.

---

## 9. Key Insights (Non-Obvious)

### 9.1 Insights from the docs that are easy to miss

1. **Haiku 4.5's cache minimum is 4,096 tokens, not 1,024.** Half-built designs with a 1.5k-token system prompt will silently fail to cache and blow the budget. Pad the prefix or accept no-cache.
2. **Forced tool-use is incompatible with extended thinking.** Don't reach for the `thinking` parameter to implement CoT; use manual `<thinking>` XML.
3. **`cache_read_input_tokens` does NOT count toward Haiku 4.5 ITPM.** Cache hits don't just cut cost — they also raise effective throughput. This is the difference between fitting in Tier 1 and needing Tier 2.
4. **Anthropic does not publicly expose an Idempotency-Key on Messages API.** `request_id` is audit-only. Build idempotency at the harness layer or pay double on resume.
5. **Strict-mode schemas are server-cached for 24h and don't get PHI protection.** No PHI in property names, enums, consts, regex. Even on synthetic data, build the discipline.
6. **Cache prefix is `tools → system → messages` — fixed.** Mutating tools invalidates everything downstream. Keep the tool definition stable across strategies; vary only the strategy suffix in `messages`.
7. **`max_tokens: 0` pre-warming is incompatible with `tool_choice: "tool"`.** Workaround: pre-warm with `auto` + `max_tokens: 1`.

### 9.2 Insights from eval methodology

8. **Per-field metrics, never whole-record accuracy.** "Strategy B got 84% accuracy" tells the reviewer nothing actionable. "Strategy B regressed 8 pp on `medications.dose` while gaining 6 pp on `diagnoses.icd10`" is a decision input.
9. **Strict and Partial F1 should both be reported, not averaged.** They measure different failure modes.
10. **Match list-of-objects records by canonicalized key, not by index.** A model that re-orders the medications list scores zero on naive index-based matching. RxNorm canonicalization or fuzzy-name + dose-canonical matching is mandatory.
11. **Hallucination is the most dangerous failure mode in clinical extraction — and schema validity does not catch it.** A 1.0 F1 with a substring-grounding miss is worse than a 0.7 F1 without one.
12. **Independence is load-bearing in CoVe.** Verifying claims in the same context as the draft loses 50–70% of the gain. Separate API calls.
13. **LLM-judge prompts inherit the failure modes of the underlying model.** Calibrate against ≥20 human-labeled cases; reject judges with κ < 0.6.
14. **G-Eval is a trap for small N.** Yan's data: distributions don't separate well below ~1000 labeled samples. Don't use it for free-text fields with 50 cases. Use NLI grounding.

### 9.3 Insights from harness engineering

15. **A "harness" is ~80% disciplined logging.** Simon Willison's `llm` CLI proves this. Every prompt + every response into a queryable store; the rest is UI.
16. **Prompt versioning via content hash is non-negotiable.** Without it, "did the model improve or did we change the rubric?" becomes unanswerable in week 3. Hash the *rendered* prompt, not the template.
17. **Dataset versioning is non-negotiable too.** Cross-dataset-version comparisons silently produce nonsense. Stamp the dataset hash on every run.
18. **Idempotency at the harness layer makes resumability cheap.** `sha256(model + prompt_hash + tools_hash + temperature + max_tokens + case_id + attempt_idx)` keyed against a stored response → replay costs nothing.
19. **Acceleration limits exist.** A sharp ramp from 0 → 50 concurrent calls trips 429s even when you're nominally under RPM. Ramp 2 → 8 over 30 s.
20. **429 and 529 are different beasts.** 429 = honor `retry-after` deterministically, no jitter. 529 = full-jitter exponential backoff. Conflating them produces 429 storms.

### 9.4 Insights from cross-source pattern matching

21. **Anthropic's "evaluator-optimizer" = Reflexion = Instructor's max_retries = your validation-feedback loop.** Four sources, one pattern. The literature converges hard here.
22. **Inspect AI's Task / Solver / Scorer = Braintrust's Datasets / Experiments / Scorers = lm-eval-harness's task / model / metrics.** All three top eval frameworks reach the same abstraction. Adopting it is a no-brainer.
23. **The "extract direct quotes first" pattern appears in Anthropic's reduce-hallucinations doc, FActScore (Min 2023), Chain-of-Note (Yu 2023), and CoVe (Dhuliawala 2023).** Strong signal. Bake `evidence_quote` into the schema.
24. **"Look at your data" is the most-cited eval principle across Husain, Yan, Shankar, Bischof, and the *What We Learned* field guide.** The compare view is where this happens; treat it as P0, not polish.

---

## 10. Recommendations

### 10.1 What to build (ranked, in order)

1. **JSON Schema (strict) + Zod types + AJV validator** — single source of truth.
2. **`packages/llm` with `Strategy` interface + tool-use forced + cache_control** — the load-bearing module.
3. **Retry-with-feedback loop** — Reflexion-shaped; structured error payload via `tool_result` `is_error:true`.
4. **Per-field scorers** (10+, table-driven) — each is a pure function `(predicted, gold, transcript) → number ∈ [0,1]`.
5. **Substring-fuzzy grounding detector** — Tier-1 hallucination defense.
6. **Runner** — bottleneck-based concurrency (8 in-flight, 50 RPM cap, ramp-up), three retry policies, DB-backed resume.
7. **DB schema + migrations + idempotency keys** — Drizzle + Postgres.
8. **API routes** — REST + SSE, ID-based.
9. **Compare view** — the headline screen. Side-by-side per-field deltas, winners, regression list, click-through to trace.
10. **Run detail + trace view** — gold-vs-predicted JSON diff + transcript with highlighted grounded spans.
11. **CLI** for CI / reproducibility — `bun run eval -- --strategy=cot`.
12. **Tests (≥8)** — schema-retry, fuzzy, F1, grounding, resume, idempotency, rate-limit, prompt-hash.
13. **NOTES.md** with results table + surprises + next steps.

### 10.2 What to *not* build

- Fancy auth flows (the brief excludes them).
- Multi-tenant / deployment / observability stacks.
- A vector DB / RAG layer.
- Self-Consistency, Tree-of-Thoughts, or other N×-cost strategies.
- Any feature whose absence won't be visible in the compare view.

### 10.3 Why this approach wins

- **Decision-support is the deliverable.** Every architectural choice routes through the compare view.
- **Reproducibility is enforced at three layers**: prompt-content hashing, dataset hashing, idempotency keys.
- **Cost is dominated by caching**, which the design treats as a first-class concern (1-hour TTL, 4k-token padding to clear Haiku 4.5's threshold, breakpoint placement aligned with strategy variation).
- **Strategy comparison is controlled.** Tool definition + system prompt are identical across strategies; only the suffix varies. Strategy is the only varied axis.
- **Hallucination is treated as the dominant failure mode**, not an afterthought. Three tiers of grounding (schema-side `evidence_quote`, deterministic substring/fuzzy, optional NLI).
- **Retry semantics are explicit**: separate budgets for validation feedback (3, no backoff), 429 (honor `retry-after`), 529 (full-jitter exponential).
- **The `Strategy` / `Scorer` abstractions** mean a Strategy 4 (CoVe) or a new scorer is a 50-line addition, not a refactor.

### 10.4 Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Haiku 4.5 prompt fails to cross 4k cache threshold | High | Pad with reference material (option 2 in §7.2) |
| Test set overfit (model memorized similar transcripts) | Medium | Brief notes "we may swap the eval set" — design assumes this |
| LLM-judge for `plan` field doesn't calibrate | Medium | Fall back to NLI; document κ < 0.6 case |
| 429 acceleration limits on full-fanout | Medium | Ramp-up scheduler 2 → 8 over 30s |
| Strict tool-use rejects schema (unsupported keyword) | Low | AJV-validate schema against strict-mode subset before deploy |
| Resume re-runs already-completed cases | Low | Idempotency key check before any LLM call |
| Cost overrun mid-dev | Low | Budget guardrail in CLI; track running total |

### 10.5 Stretch goals worth pursuing if time

In priority order: **(1) NLI-based grounding** for `plan` and `chief_complaint`; **(2) CoVe Strategy 4**; **(3) cost guardrail** at run-start; **(4) cross-model compare** (add Sonnet 4.6); **(5) prompt-diff view**; **(6) active-learning hint** (highest cross-strategy disagreement).

### 10.6 What to write in `NOTES.md`

1. Per-strategy aggregate F1, cost, latency.
2. Per-field F1 table (3 strategies × 6 fields).
3. Schema-invalid rate, hallucination rate per strategy.
4. **What surprised you.** (Per the brief: this is a key signal. Examples to look for: did CoT lift `medications` more than expected? Did few-shot regress on `null` handling? Did a strategy hallucinate evidence_quote text?)
5. **What you'd build next.** (CoVe; cross-model; production telemetry layer.)
6. **What you cut.** (Stretch goals; active-learning; prompt-diff.)

---

## 11. Appendix — Source Index

### Anthropic (engineering + docs)

- Tool use overview — https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview
- How tool use works — https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works
- **Strict tool use** — https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
- **Structured outputs** — https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- **Prompt caching** — https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- Streaming (SSE event shapes) — https://platform.claude.com/docs/en/docs/build-with-claude/streaming
- **Rate limits** — https://platform.claude.com/docs/en/api/rate-limits
- Errors / request_id — https://platform.claude.com/docs/en/api/errors
- **Reduce hallucinations** — https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
- Prompt engineering best practices (CoT / few-shot / XML) — https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering
- Extended thinking + tool-use compatibility — https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- **Building Effective Agents** — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic cookbook — https://github.com/anthropics/anthropic-cookbook
- Cookbook: extracting structured JSON via tool use — https://github.com/anthropics/anthropic-cookbook/blob/main/tool_use/extracting_structured_json.ipynb

### OpenAI (cookbook + evals)

- Structured Outputs — https://developers.openai.com/cookbook/examples/structured_outputs_intro
- How to handle rate limits — https://developers.openai.com/cookbook/examples/how_to_handle_rate_limits
- Techniques to improve reliability — https://developers.openai.com/cookbook/articles/techniques_to_improve_reliability
- Evals quickstart — https://developers.openai.com/cookbook/examples/evaluation/getting_started_with_openai_evals
- Evals repository — https://github.com/openai/evals

### Eval methodology — practitioners

- **Hamel Husain — Your AI Product Needs Evals** — https://hamel.dev/blog/posts/evals/
- Hamel — LLM-judge calibration — https://hamel.dev/blog/posts/llm-judge/index.html
- Hamel — Evals FAQ — https://hamel.dev/blog/posts/evals-faq/
- **Eugene Yan — Task-specific evals** — https://www.eugeneyan.com/writing/evals/
- Eugene Yan — LLM patterns — https://www.eugeneyan.com/writing/llm-patterns/
- Eugene Yan — LLM evaluators — https://www.eugeneyan.com/writing/llm-evaluators/
- **Shreya Shankar — Who Validates the Validators?** (UIST '24) — https://arxiv.org/abs/2404.12272
- Bryan Bischof (Hex) — LLM evals done right — https://humanloop.com/blog/LLM-eval-done-right
- **What We Learned from a Year of Building with LLMs** — https://www.oreilly.com/radar/what-we-learned-from-a-year-of-building-with-llms-part-i/
- Applied LLMs field guide — https://applied-llms.org/

### Eval platforms & frameworks

- **Inspect AI (UK AISI)** — https://inspect.aisi.org.uk/
- Inspect AI scorers — https://inspect.aisi.org.uk/scorers.html
- Inspect AI solvers — https://inspect.aisi.org.uk/solvers.html
- **Braintrust evals** — https://www.braintrust.dev/docs/evaluate
- Braintrust experiments interpretation — https://www.braintrust.dev/docs/guides/experiments/interpret
- **Promptfoo expected outputs** — https://www.promptfoo.dev/docs/configuration/expected-outputs/
- Promptfoo model-graded — https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/
- **LangSmith evaluation** — https://docs.langchain.com/langsmith/evaluation
- **lm-evaluation-harness (EleutherAI)** — https://github.com/EleutherAI/lm-evaluation-harness
- Langfuse — https://langfuse.com/
- Phoenix Arize — https://docs.arize.com/phoenix
- Helicone — https://www.helicone.ai/
- **Instructor (Jason Liu)** — https://github.com/567-labs/instructor
- Simon Willison's `llm` CLI — https://github.com/simonw/llm

### Information-extraction / NER metrics

- **Batista — Named-Entity Evaluation** — https://www.davidsbatista.net/blog/2018/05/09/Named_Entity_Evaluation/
- nervaluate library — https://github.com/MantisAI/nervaluate
- RxNorm overview — https://www.nlm.nih.gov/research/umls/rxnorm/overview.html
- RxNorm at 6 years — https://pmc.ncbi.nlm.nih.gov/articles/PMC3128404/
- ICD-10-CM (CMS) — https://www.cms.gov/medicare/coding-billing/icd-10-codes
- MUC-5 metrics — https://aclanthology.org/M93-1007.pdf
- RapidFuzz docs — https://rapidfuzz.github.io/RapidFuzz/Usage/fuzz.html

### Kaggle / clinical comps

- NBME — Score Clinical Patient Notes — https://www.kaggle.com/competitions/nbme-score-clinical-patient-notes
- NBME — Six teams recognized — https://www.nbme.org/news/six-teams-recognized-nlp-advances-nbmes-patient-note-scoring-competition
- NBME — Academic write-up — https://arxiv.org/html/2401.12994v1
- Coleridge "Show US the Data" — https://www.kaggle.com/competitions/coleridgeinitiative-show-us-the-data/overview

### Prompt-engineering papers (chronological)

- GPT-3 / few-shot (Brown 2020) — https://arxiv.org/abs/2005.14165
- **Chain-of-Thought** (Wei 2022) — https://arxiv.org/abs/2201.11903
- Self-Consistency (Wang 2022) — https://arxiv.org/abs/2203.11171
- Zero-shot CoT (Kojima 2022) — https://arxiv.org/abs/2205.11916
- Least-to-Most (Zhou 2022) — https://arxiv.org/abs/2205.10625
- ReAct (Yao 2022) — https://arxiv.org/abs/2210.03629
- SelfCheckGPT (Manakul 2023) — https://arxiv.org/abs/2303.08896
- **Reflexion** (Shinn 2023) — https://arxiv.org/abs/2303.11366
- G-Eval (Liu 2023) — https://arxiv.org/abs/2303.16634
- **Self-Refine** (Madaan 2023) — https://arxiv.org/abs/2303.17651
- Plan-and-Solve (Wang 2023) — https://arxiv.org/abs/2305.04091
- Tree of Thoughts (Yao 2023) — https://arxiv.org/abs/2305.10601
- FActScore (Min 2023) — https://arxiv.org/abs/2305.14251
- Graph of Thoughts (Besta 2023) — https://arxiv.org/abs/2308.09687
- Chain-of-Density (Adams 2023) — https://arxiv.org/abs/2309.04269
- **Chain-of-Verification** (Dhuliawala 2023) — https://arxiv.org/abs/2309.11495
- Analogical Prompting (Yasunaga 2023) — https://arxiv.org/abs/2310.01714
- Step-Back Prompting (Zheng 2023) — https://arxiv.org/abs/2310.06117
- Chain-of-Note (Yu 2023) — https://arxiv.org/abs/2311.09210
- Self-Discover (Zhou 2024) — https://arxiv.org/abs/2402.03620
- A Systematic Survey of Prompt Engineering (Sahoo 2024) — https://arxiv.org/abs/2402.07927
- **The Prompt Report** (Schulhoff 2024) — https://arxiv.org/abs/2406.06608
- Prompt Survey site — https://trigaten.github.io/Prompt_Survey_Site/
- Prompting Guide — https://www.promptingguide.ai/techniques

### Hallucination detection (extra)

- DeBERTa-v3-large MNLI — https://huggingface.co/MoritzLaurer/DeBERTa-v3-large-mnli-fever-anli-ling-wanli
- SelfCheckGPT repo — https://github.com/potsawee/selfcheckgpt
- CoVe — Learn Prompting — https://learnprompting.org/docs/advanced/self_criticism/chain_of_verification

### Concurrency / backoff

- AWS Architecture Blog — Exponential backoff and jitter — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- AWS Builders Library — Timeouts, retries, backoff — https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- Anthropic — Our approach to API rate limits — https://support.anthropic.com/en/articles/8243635-our-approach-to-api-rate-limits
- bottleneck (npm) — https://github.com/SGrondin/bottleneck
- p-limit — https://github.com/sindresorhus/p-limit
- p-queue — https://github.com/sindresorhus/p-queue
- tenacity (Python) — https://tenacity.readthedocs.io/

---

*End of `idea.md`. The next step is to start building from §10.1, beginning with the schema + types as the single source of truth.*
