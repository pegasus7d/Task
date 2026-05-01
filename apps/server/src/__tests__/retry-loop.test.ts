// apps/server/src/__tests__/retry-loop.test.ts
//
// Direct exercise of the V2 retry-with-feedback loop using an in-memory
// AttemptRepository fake + the scripted MockLLMAdapter. No DB required.
//
// Covers the brief's hard requirements:
//   - test #1 (schema-validation retry path) — invalid → invalid → tool_use
//   - test #5 (resume / idempotency replay) — same key → no second LLM call

import { describe, expect, test } from "bun:test";

import { ExtractorService, type ExtractInput } from "../services/extractor.service";
import { MockLLMAdapter } from "../llm/mock-adapter";
import { zeroShotStrategy } from "../llm/strategies/zero-shot";
import type { ClinicalExtraction } from "../data/clinical-schema";
import type {
  Attempt,
  AttemptId,
  AttemptStatus,
  Sha256Hex,
} from "@test-evals/db/repositories";

// ─── In-memory AttemptRepository fake ──────────────────────────────────────
//
// Implements the methods the ExtractorService actually calls: create, update,
// findByIdempotencyKey. Anything else throws if invoked (so the test fails
// loudly if the production code starts depending on a method we haven't
// faked).

class FakeAttemptRepository {
  private readonly byKey = new Map<Sha256Hex, Attempt>();
  private readonly byId  = new Map<AttemptId, Attempt>();

  async create(a: Attempt): Promise<void> {
    this.byKey.set(a.idempotency_key, a);
    this.byId.set(a.attempt_id, a);
  }

  async update(id: AttemptId, patch: Partial<Attempt>): Promise<void> {
    const cur = this.byId.get(id);
    if (!cur) throw new Error(`fake repo: missing id=${id}`);
    const merged = { ...cur, ...patch } as Attempt;
    this.byId.set(id, merged);
    this.byKey.set(merged.idempotency_key, merged);
  }

  async findByIdempotencyKey(key: Sha256Hex): Promise<Attempt | null> {
    return this.byKey.get(key) ?? null;
  }

  // Other methods left intentionally unimplemented.
  async findById()       { throw new Error("not in fake"); }
  async exists()         { throw new Error("not in fake"); }
  async listForRun()     { throw new Error("not in fake"); }
  async listForCase()    { throw new Error("not in fake"); }

  /** Test helper: snapshot all attempts (chronological by creation order). */
  all(): Attempt[] {
    return [...this.byId.values()];
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TRANSCRIPT = "Patient has a sore throat. BP 120/80.";
const GOLD: ClinicalExtraction = {
  chief_complaint: "sore throat",
  vitals:       { bp: "120/80", hr: null, temp_f: null, spo2: null },
  medications:  [],
  diagnoses:    [],
  plan:         [],
  follow_up:    { interval_days: null, reason: null },
};

function makeServices() {
  const adapter = new MockLLMAdapter();
  adapter.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT, gold: GOLD, tokens: 10, tags: [] }]);
  const repo = new FakeAttemptRepository();
  // The fake repo has the methods extractor uses; cast because we don't
  // implement the full interface.
  const ext = new ExtractorService(adapter, zeroShotStrategy, repo as never);
  return { adapter, repo, ext };
}

const baseInput = (attempt_idx: 1 | 2 | 3): ExtractInput => ({
  run_id:      "run_test" as never,
  case_id:     "c1",
  transcript:  TRANSCRIPT,
  prompt_hash: "p_hash" as never,
  tools_hash:  "t_hash" as never,
  attempt_idx,
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("ExtractorService retry path (brief test #1)", () => {
  test("attempt 1 schema_invalid → status flagged + row persisted", async () => {
    const { adapter, repo, ext } = makeServices();
    adapter.script("c1", [{ kind: "schema_invalid" }]);

    const r = await ext.extract(baseInput(1));
    expect(r.status).toBe("schema_invalid");
    expect(r.predicted).toBeNull();
    expect(repo.all()).toHaveLength(1);
    expect(repo.all()[0]?.status).toBe<AttemptStatus>("schema_invalid");
  });

  test("attempt 1 succeeded → status=succeeded + predicted populated", async () => {
    const { adapter, repo, ext } = makeServices();
    adapter.script("c1", [{ kind: "tool_use" }]);

    const r = await ext.extract(baseInput(1));
    expect(r.status).toBe("succeeded");
    expect(r.predicted).not.toBeNull();
    expect(repo.all()[0]?.status).toBe<AttemptStatus>("succeeded");
  });

  test("idempotency replay: same key on 2nd call → no second adapter call", async () => {
    const { adapter, repo, ext } = makeServices();
    adapter.script("c1", [{ kind: "tool_use" }]);   // only one scripted response

    const r1 = await ext.extract(baseInput(1));
    expect(r1.status).toBe("succeeded");
    expect(adapter.observed).toHaveLength(1);

    // Second extract with same (run_id, case_id, attempt_idx) → same idempotency key.
    // Should short-circuit on the cached row.
    const r2 = await ext.extract(baseInput(1));
    expect(r2.status).toBe("succeeded");
    expect(adapter.observed).toHaveLength(1);  // STILL 1 — no second LLM call
    expect(r2.attempt_id).toBe(r1.attempt_id); // same persisted attempt
    expect(repo.all()).toHaveLength(1);        // no duplicate row
  });

  test("different attempt_idx → different idempotency key → new LLM call", async () => {
    const { adapter, repo, ext } = makeServices();
    adapter.script("c1", [{ kind: "tool_use" }, { kind: "tool_use" }]);

    await ext.extract(baseInput(1));
    await ext.extract(baseInput(2));   // attempt_idx changes → key changes

    expect(adapter.observed).toHaveLength(2);
    expect(repo.all()).toHaveLength(2);
  });

  test("grounding_failed flagged when fabricated medication present", async () => {
    const { adapter, ext } = makeServices();
    adapter.script("c1", [{ kind: "grounding_failed" }]);

    const r = await ext.extract(baseInput(1));
    expect(r.status).toBe("grounding_failed");
    expect(r.predicted).not.toBeNull();          // schema-valid
    expect(r.validation.hallucination_count).toBeGreaterThan(0);
  });
});

describe("retry-loop end-to-end (brief test #1)", () => {
  // Recreates the runner's per-case loop on the fake repo. We don't pull in
  // the full RunnerService here because its DB writes are out of scope for
  // this in-memory test — what we're verifying is the feedback-propagation
  // logic.

  async function caseLoop(adapter: MockLLMAdapter, ext: ExtractorService): Promise<{
    finalStatus: "succeeded" | "schema_invalid" | "grounding_failed" | "failed_terminal";
    attemptCount: number;
    feedbackPropagated: boolean;
  }> {
    let prevFeedback = null as Awaited<ReturnType<typeof import("../validators/feedback").toValidationFeedback>> | null;
    const messageCounts: number[] = [];

    for (let i = 1 as 1 | 2 | 3; i <= 3; i = ((i + 1) as 1 | 2 | 3)) {
      const before = adapter.observed.length;
      const r = await ext.extract({
        run_id:        "run_x" as never,
        case_id:       "c1",
        transcript:    TRANSCRIPT,
        prompt_hash:   `p${i}` as never,    // vary so idempotency keys are unique
        tools_hash:    "t" as never,
        attempt_idx:   i,
        prev_feedback: prevFeedback,
      });
      messageCounts.push(adapter.observed[before]?.messageCount ?? 0);

      if (r.status === "succeeded") {
        return { finalStatus: "succeeded", attemptCount: i, feedbackPropagated: messageCounts[1] === 2 };
      }

      // Build feedback for next iteration (using the helpers under test).
      const { collectFeedback, toValidationFeedback } =
        await import("../validators/feedback");
      const sf = collectFeedback(r.validation);
      prevFeedback = toValidationFeedback(sf, r.tool_use_id, ((i + 1) as 1 | 2 | 3));
    }

    return {
      finalStatus: "failed_terminal",
      attemptCount: 3,
      feedbackPropagated: messageCounts.slice(1).every((n) => n >= 2),
    };
  }

  test("schema_invalid → succeeded on attempt 2 (feedback turn injected)", async () => {
    const { adapter, ext } = makeServices();
    adapter.script("c1", [{ kind: "schema_invalid" }, { kind: "tool_use" }]);

    const r = await caseLoop(adapter, ext);
    expect(r.finalStatus).toBe("succeeded");
    expect(r.attemptCount).toBe(2);
    expect(r.feedbackPropagated).toBe(true);  // 2nd call carried 2 messages = transcript + feedback
  });

  test("schema_invalid × 2 → succeeded on attempt 3", async () => {
    const { adapter, ext } = makeServices();
    adapter.script("c1", [
      { kind: "schema_invalid" },
      { kind: "schema_invalid" },
      { kind: "tool_use" },
    ]);

    const r = await caseLoop(adapter, ext);
    expect(r.finalStatus).toBe("succeeded");
    expect(r.attemptCount).toBe(3);
  });

  test("schema_invalid × 3 → terminal failure", async () => {
    const { adapter, ext } = makeServices();
    adapter.script("c1", [
      { kind: "schema_invalid" },
      { kind: "schema_invalid" },
      { kind: "schema_invalid" },
    ]);

    const r = await caseLoop(adapter, ext);
    expect(r.finalStatus).toBe("failed_terminal");
    expect(r.attemptCount).toBe(3);
  });

  test("grounding_failed on 1, 2 → succeeded on 3", async () => {
    const { adapter, ext } = makeServices();
    adapter.script("c1", [
      { kind: "grounding_failed" },
      { kind: "grounding_failed" },
      { kind: "tool_use" },
    ]);

    const r = await caseLoop(adapter, ext);
    expect(r.finalStatus).toBe("succeeded");
    expect(r.attemptCount).toBe(3);
  });

  test("loop never exceeds 3 attempts", async () => {
    const { adapter, ext } = makeServices();
    adapter.script("c1", [
      { kind: "schema_invalid" },
      { kind: "schema_invalid" },
      { kind: "schema_invalid" },
      { kind: "schema_invalid" },   // 4th — must never be consumed
    ]);

    await caseLoop(adapter, ext);
    expect(adapter.observed).toHaveLength(3);
  });
});
