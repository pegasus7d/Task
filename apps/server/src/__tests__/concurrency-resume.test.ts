// apps/server/src/__tests__/concurrency-resume.test.ts
//
// Brief hard-req #4 (concurrency / 429 backoff) + hard-req #5 (resumability).
// Both tests run in-memory — no DB, no network — using the existing fakes.

import { describe, expect, test } from "bun:test";

import { ExtractorService, type ExtractInput } from "../services/extractor.service";
import {
  createLimiter,
  withRateLimitRetry,
} from "../services/runner.service";
import { MockLLMAdapter } from "../llm/mock-adapter";
import { RateLimitError } from "../llm/types";
import { zeroShotStrategy } from "../llm/strategies/zero-shot";
import type { ClinicalExtraction } from "../data/clinical-schema";
import type {
  Attempt,
  AttemptId,
  CaseId,
  RunId,
  Sha256Hex,
} from "@test-evals/db/repositories";

// ─── Fixtures + reusable in-memory fakes ────────────────────────────────────

const TRANSCRIPT = "Patient has a sore throat. BP 120/80.";
const GOLD: ClinicalExtraction = {
  chief_complaint: "sore throat",
  vitals:       { bp: "120/80", hr: null, temp_f: null, spo2: null },
  medications:  [],
  diagnoses:    [],
  plan:         [],
  follow_up:    { interval_days: null, reason: null },
};

class FakeAttemptRepository {
  private readonly byKey = new Map<Sha256Hex, Attempt>();
  private readonly byId  = new Map<AttemptId, Attempt>();
  async create(a: Attempt) { this.byKey.set(a.idempotency_key, a); this.byId.set(a.attempt_id, a); }
  async update(id: AttemptId, patch: Partial<Attempt>) {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`fake repo: missing id=${id}`);
    const merged = { ...cur, ...patch } as Attempt;
    this.byId.set(id, merged); this.byKey.set(merged.idempotency_key, merged);
  }
  async findByIdempotencyKey(key: Sha256Hex) { return this.byKey.get(key) ?? null; }
  all() { return [...this.byId.values()]; }
}

const baseInput = (caseId: string, attempt_idx: 1 | 2 | 3): ExtractInput => ({
  run_id:      "run_test" as never,
  case_id:     caseId,
  transcript:  TRANSCRIPT,
  prompt_hash: "p_hash" as never,
  tools_hash:  "t_hash" as never,
  attempt_idx,
});

// ───────────────────────────────────────────────────────────────────────────
//  1. Rate-limit backoff (brief test #9 — "rate-limit backoff (mock the SDK)")
// ───────────────────────────────────────────────────────────────────────────

describe("withRateLimitRetry (brief hard-req #4 — 429 backoff)", () => {
  test("first call throws 429 → wrapper waits Retry-After then retries → success", async () => {
    const adapter = new MockLLMAdapter();
    adapter.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT, gold: GOLD, tokens: 10, tags: [] }]);
    // Script: 429 with 50ms Retry-After, then a successful tool_use.
    adapter.script("c1", [
      { kind: "rate_limit_429", retryAfterMs: 50 },
      { kind: "tool_use" },
    ]);

    const wrapped = withRateLimitRetry(adapter);
    const t0 = Date.now();
    const result = await wrapped.call(
      // Minimum payload the adapter needs.
      {
        system: [], tools: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tool_choice: { type: "tool", name: "extract_clinical" },
        temperature: 0, max_tokens: 1024,
      },
      "c1",
    );
    const elapsedMs = Date.now() - t0;

    expect(result.predicted).toBeDefined();
    // Honored Retry-After: at least the 50ms back-off elapsed.
    expect(elapsedMs).toBeGreaterThanOrEqual(45);
    // The wrapper made exactly two adapter calls — one 429, one success.
    expect(adapter.observed.length).toBe(2);
  });

  test("RateLimitError propagates after MAX_429_RETRIES exhausted", async () => {
    const adapter = new MockLLMAdapter();
    adapter.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT, gold: GOLD, tokens: 10, tags: [] }]);
    // Script: enough 429s to exceed the wrapper's retry budget (currently 4 retries → 5 attempts).
    adapter.script("c1", Array.from({ length: 6 }, () => ({ kind: "rate_limit_429" as const, retryAfterMs: 5 })));

    const wrapped = withRateLimitRetry(adapter);
    let caught: unknown;
    try {
      await wrapped.call(
        { system: [], tools: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tool_choice: { type: "tool", name: "extract_clinical" }, temperature: 0, max_tokens: 1024 },
        "c1",
      );
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(RateLimitError);
  });

  test("idempotency: extractor on same key after 429-recovered call → no second LLM call", async () => {
    // Confirms 429 retries don't create duplicate `attempts` rows.
    const adapter = new MockLLMAdapter();
    adapter.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT, gold: GOLD, tokens: 10, tags: [] }]);
    adapter.script("c1", [
      { kind: "rate_limit_429", retryAfterMs: 5 },
      { kind: "tool_use" },
    ]);

    const wrapped = withRateLimitRetry(adapter);
    const repo    = new FakeAttemptRepository();
    const ext     = new ExtractorService(wrapped, zeroShotStrategy, repo as never);

    const r1 = await ext.extract(baseInput("c1", 1));
    expect(r1.status).toBe("succeeded");
    expect(adapter.observed.length).toBe(2);   // one 429 + one success
    expect(repo.all()).toHaveLength(1);         // one attempt row regardless of retries

    // Second call with the same idempotency key — should replay, not call LLM.
    const r2 = await ext.extract(baseInput("c1", 1));
    expect(r2.status).toBe("succeeded");
    expect(adapter.observed.length).toBe(2);   // unchanged
    expect(repo.all()).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  2. Resumability (brief test #9 — "resumability")
// ───────────────────────────────────────────────────────────────────────────
//
// Models the exact filter `RunnerService.resumeRun` uses: ask
// `evalRepo.completedCaseIds(runId)` for the set of cases that already have a
// terminal `evaluations` row, skip them, process the rest. The fake
// EvaluationRepository here implements only the methods that path needs.

class FakeEvaluationRepository {
  private readonly completed = new Map<RunId, Set<CaseId>>();
  /** Test helper — mark a case as having a terminal evaluations row. */
  seedCompleted(runId: RunId, caseId: CaseId) {
    if (!this.completed.has(runId)) this.completed.set(runId, new Set());
    this.completed.get(runId)!.add(caseId);
  }
  async completedCaseIds(runId: RunId) {
    return this.completed.get(runId) ?? new Set<CaseId>();
  }
}

describe("resume path (brief hard-req #5 — resumable runs)", () => {
  test("completedCaseIds skips completed cases — only the rest hit the extractor", async () => {
    const runId   = "run_resume" as RunId;
    const evalRepo = new FakeEvaluationRepository();
    // Pretend cases 0 + 2 already finished before the (simulated) crash.
    evalRepo.seedCompleted(runId, "case_0" as CaseId);
    evalRepo.seedCompleted(runId, "case_2" as CaseId);

    const allCases = ["case_0", "case_1", "case_2", "case_3", "case_4"];
    const completed = await evalRepo.completedCaseIds(runId);
    const remaining = allCases.filter((id) => !completed.has(id as CaseId));

    expect(remaining).toEqual(["case_1", "case_3", "case_4"]);

    // Drive the extractor only over the remaining set — verify zero calls
    // for completed cases, exactly one per remaining case.
    const adapter = new MockLLMAdapter();
    adapter.loadDataset(allCases.map((cid) => ({
      case_id: cid, transcript: TRANSCRIPT, gold: GOLD, tokens: 10, tags: [],
    })));
    for (const cid of allCases) adapter.script(cid, [{ kind: "tool_use" }]);

    const repo = new FakeAttemptRepository();
    const ext  = new ExtractorService(adapter, zeroShotStrategy, repo as never);

    for (const cid of remaining) {
      await ext.extract(baseInput(cid, 1));
    }

    // Adapter saw exactly the 3 remaining cases, in order.
    expect(adapter.observed.map((o) => o.caseId)).toEqual(["case_1", "case_3", "case_4"]);
    // No attempts row for completed cases.
    const persistedCaseIds = repo.all().map((a) => a.case_id);
    expect(persistedCaseIds).not.toContain("case_0");
    expect(persistedCaseIds).not.toContain("case_2");
    // Three new attempt rows, no double-charging.
    expect(repo.all()).toHaveLength(3);
  });

  test("resume after a partial-write crash: idempotency replay short-circuits the surviving attempt", async () => {
    // Scenario: case_x had a successful extractor.attempt() persist its row,
    // but the server crashed before the evaluations upsert. On resume, the
    // case isn't in completedCaseIds (so it's re-queued), but the second
    // ext.extract() call hits findByIdempotencyKey → no second LLM call.
    const adapter = new MockLLMAdapter();
    adapter.loadDataset([{ case_id: "case_x", transcript: TRANSCRIPT, gold: GOLD, tokens: 10, tags: [] }]);
    adapter.script("case_x", [{ kind: "tool_use" }]);   // ONE scripted response only

    const repo = new FakeAttemptRepository();
    const ext  = new ExtractorService(adapter, zeroShotStrategy, repo as never);

    // Pre-crash: attempt completes, attempts row persisted.
    const r1 = await ext.extract(baseInput("case_x", 1));
    expect(r1.status).toBe("succeeded");
    expect(adapter.observed.length).toBe(1);

    // ── crash here (no evaluations row written) ──

    // Post-resume: case_x is NOT in completedCaseIds (no evaluations row),
    // so the runner re-queues it. The second extract should NOT call the LLM.
    const r2 = await ext.extract(baseInput("case_x", 1));
    expect(r2.status).toBe("succeeded");
    expect(adapter.observed.length).toBe(1);   // unchanged — replayed from attempts
    expect(r2.attempt_id).toBe(r1.attempt_id); // same row
    expect(repo.all()).toHaveLength(1);         // no duplicate persistence
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  3. Bonus: limiter primitive itself (sanity — ensures we never exceed N)
// ───────────────────────────────────────────────────────────────────────────

describe("createLimiter (concurrency primitive)", () => {
  test("never exceeds the configured concurrency", async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak   = 0;

    await Promise.all(Array.from({ length: 12 }, () => limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    })));

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);   // genuinely parallel, not serialised
  });
});
