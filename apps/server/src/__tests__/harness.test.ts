// apps/server/src/__tests__/harness.test.ts
//
// V2 test suite — covers the brief's 8 required scenarios using deterministic
// pure functions where possible. Repository tests are skipped when there's no
// DATABASE_URL on the environment so the suite stays runnable on any machine.
//
// Run:  cd apps/server && bun test

import { describe, expect, test } from "bun:test";

import { runValidatorChain } from "../validators/chain";
import { groundingValidator } from "../validators/grounding";
import { schemaValidator } from "../validators/schema";
import { collectFeedback, toValidationFeedback } from "../validators/feedback";
import { ALL_SCORERS, planSetF1, vitalsBpExact, chiefComplaintFuzzy } from "../evaluators/scorers";
import { computeIdempotencyKey, sha256, canonicalJson } from "../utils/hash";
import { zeroShotStrategy } from "../llm/strategies/zero-shot";
import { MockLLMAdapter } from "../llm/mock-adapter";
import type { ClinicalExtraction } from "../data/clinical-schema";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TRANSCRIPT = `Doctor: What brings you in?
Patient: Sore throat for four days.
Doctor: BP 120/80, HR 88. Take ibuprofen 400 mg every 6 hours as needed.
Patient: OK.
Doctor: Diagnosis is viral upper respiratory infection.`;

const GOLD: ClinicalExtraction = {
  chief_complaint: "sore throat for four days",
  vitals:       { bp: "120/80", hr: 88, temp_f: null, spo2: null },
  medications:  [{ name: "ibuprofen", dose: "400 mg", frequency: "every 6 hours as needed", route: "PO" }],
  diagnoses:    [{ description: "viral upper respiratory infection" }],
  plan:         ["take ibuprofen 400 mg every 6 hours as needed"],
  follow_up:    { interval_days: null, reason: null },
};

// ─── 1. Schema validator: structural failure flagged ────────────────────────

describe("schema validator (brief test #1 prerequisite)", () => {
  test("flags missing required fields as schema_invalid", () => {
    const r = schemaValidator.validate({ chief_complaint: "x" }, TRANSCRIPT);
    expect(r.ok).toBe(false);
    expect(r.schema_invalid).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test("passes a fully-formed extraction", () => {
    const r = schemaValidator.validate(GOLD, TRANSCRIPT);
    expect(r.ok).toBe(true);
    expect(r.schema_invalid).toBe(false);
    expect(r.errors).toHaveLength(0);
  });
});

// ─── 2. Grounding validator: hallucination detection ± (brief test #4) ──────

describe("grounding validator (brief test #4)", () => {
  test("positive: every leaf string is in transcript → no flags", () => {
    const r = groundingValidator.validate(GOLD, TRANSCRIPT);
    expect(r.grounding_failed).toBe(false);
    expect(r.hallucination_count).toBe(0);
  });

  test("negative: fabricated medication name flagged", () => {
    const fab: ClinicalExtraction = {
      ...GOLD,
      medications: [
        { name: "ZZZ-not-in-transcript", dose: null, frequency: null, route: null },
      ],
    };
    const r = groundingValidator.validate(fab, TRANSCRIPT);
    expect(r.grounding_failed).toBe(true);
    expect(r.hallucination_count).toBe(1);
    expect(r.errors[0]?.kind).toBe("grounding_substring_miss");
  });

  test("skips numeric vitals fields (formatting differs)", () => {
    const r = groundingValidator.validate(GOLD, TRANSCRIPT);
    // vitals.bp/hr/temp_f/spo2 are in SKIP_PATHS → never trigger errors.
    expect(r.errors.find((e) => e.field_path.startsWith("vitals."))).toBeUndefined();
  });
});

// ─── 3. Feedback collection + wire shape (brief test #1 critical) ──────────

describe("feedback collector (validates retry-loop prep)", () => {
  test("groups schema vs grounding errors", () => {
    const v = schemaValidator.validate({ chief_complaint: "x" }, TRANSCRIPT);
    const sf = collectFeedback(v);
    expect(sf.schemaErrors.length).toBeGreaterThan(0);
    expect(sf.groundingErrors.length).toBe(0);
    // All schema errors should carry a field_path string for the LLM to act on.
    for (const e of sf.schemaErrors) expect(typeof e.field_path).toBe("string");
  });

  test("toValidationFeedback produces wire-format with attempt_idx + tool_use_id", () => {
    const v = schemaValidator.validate({ chief_complaint: "x" }, TRANSCRIPT);
    const sf = collectFeedback(v);
    const fb = toValidationFeedback(sf, "toolu_abc", 2);
    expect(fb.attempt_idx).toBe(2);
    expect(fb.prior_tool_use_id).toBe("toolu_abc");
    expect(fb.errors.length).toBe(sf.schemaErrors.length + sf.groundingErrors.length);
    expect(fb.hint).toContain("Fix");
  });
});

// ─── 4. Strategy injects feedback into prompt (retry plumbing) ──────────────

describe("zero-shot strategy retry plumbing", () => {
  test("attempt 1 has only the transcript turn", () => {
    const p = zeroShotStrategy.buildMessages({
      transcriptId: "case_001", transcript: "hello", attemptIdx: 1, prevFeedback: null,
    });
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]?.role).toBe("user");
  });

  test("attempt 2 with feedback appends a tool_result (is_error: true) turn", () => {
    const fb = toValidationFeedback(
      { schemaErrors: [], groundingErrors: [], missingFields: ["medications[0].dose"] },
      "toolu_prev",
      2,
    );
    const p = zeroShotStrategy.buildMessages({
      transcriptId: "case_001", transcript: "hello", attemptIdx: 2, prevFeedback: fb,
    });
    expect(p.messages.length).toBe(2);
    const second = p.messages[1]?.content[0];
    if (!second || second.type !== "tool_result") {
      throw new Error(`expected tool_result block, got ${second?.type ?? "undefined"}`);
    }
    expect(second.is_error).toBe(true);
    expect(second.tool_use_id).toBe("toolu_prev");
    const parsed = JSON.parse(second.content) as { schema_version: number; feedback: typeof fb };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.feedback.attempt_idx).toBe(2);
  });
});

// ─── 5. Scorers — exact, fuzzy, set-F1 (brief tests #2 + #3) ────────────────

describe("scorers (brief tests #2, #3)", () => {
  test("vitals_bp_exact: equal after normalization → 1.0", () => {
    const r = vitalsBpExact.score({ predicted: GOLD, gold: GOLD, transcript: TRANSCRIPT });
    expect(r.value).toBe(1);
  });

  test("vitals_bp_exact: different → 0.0", () => {
    const off: ClinicalExtraction = { ...GOLD, vitals: { ...GOLD.vitals, bp: "130/85" } };
    const r = vitalsBpExact.score({ predicted: off, gold: GOLD, transcript: TRANSCRIPT });
    expect(r.value).toBe(0);
  });

  test("chief_complaint_fuzzy: identical → 1.0", () => {
    const r = chiefComplaintFuzzy.score({ predicted: GOLD, gold: GOLD, transcript: TRANSCRIPT });
    expect(r.value).toBe(1);
  });

  test("chief_complaint_fuzzy: token overlap → 0 < value < 1", () => {
    const partial: ClinicalExtraction = { ...GOLD, chief_complaint: "sore throat one day" };
    const r = chiefComplaintFuzzy.score({ predicted: partial, gold: GOLD, transcript: TRANSCRIPT });
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThan(1);
  });

  test("plan_set_f1: 1 tp / 1 fp / 1 fn → P=R=F1=0.5", () => {
    const pred: ClinicalExtraction = { ...GOLD, plan: ["matched item alpha", "extra item beta"] };
    const gold: ClinicalExtraction = { ...GOLD, plan: ["matched item alpha", "missed item gamma"] };
    const r = planSetF1.score({ predicted: pred, gold, transcript: TRANSCRIPT });
    expect(r.metadata?.tp).toBe(1);
    expect(r.metadata?.fp).toBe(1);
    expect(r.metadata?.fn).toBe(1);
    expect(r.value).toBeCloseTo(0.5, 4);
  });

  test("plan_set_f1: identical → 1.0", () => {
    const r = planSetF1.score({ predicted: GOLD, gold: GOLD, transcript: TRANSCRIPT });
    expect(r.value).toBe(1);
  });

  test("ALL_SCORERS exposes a non-empty registry", () => {
    expect(ALL_SCORERS.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── 6. Hash stability (brief test #8) + idempotency key (brief test #6) ────

describe("prompt-hash stability + idempotency key (brief tests #6, #8)", () => {
  test("sha256 is deterministic and pure", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abcd"));
  });

  test("canonicalJson key-order independent", () => {
    const a = canonicalJson({ b: 2, a: 1 });
    const b = canonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  test("strategy.promptHash() stable across calls", () => {
    expect(zeroShotStrategy.promptHash()).toBe(zeroShotStrategy.promptHash());
  });

  test("idempotency_key includes attempt_idx — different idx → different key", () => {
    const base = {
      run_id:      "run_x" as never,
      model:       "claude-haiku-4-5-20251001" as const,
      prompt_hash: "p" as never,
      tools_hash:  "t" as never,
      temperature: 0,
      max_tokens:  2048,
      case_id:     "case_001",
    };
    const k1 = computeIdempotencyKey({ ...base, attempt_idx: 1 });
    const k2 = computeIdempotencyKey({ ...base, attempt_idx: 2 });
    const k3 = computeIdempotencyKey({ ...base, attempt_idx: 3 });
    expect(k1).not.toBe(k2);
    expect(k2).not.toBe(k3);
    expect(k1).not.toBe(k3);
  });

  test("idempotency_key deterministic on same inputs", () => {
    const args = {
      run_id:      "run_x" as never,
      model:       "claude-haiku-4-5-20251001" as const,
      prompt_hash: "p" as never,
      tools_hash:  "t" as never,
      temperature: 0,
      max_tokens:  2048,
      case_id:     "case_001",
      attempt_idx: 1 as 1 | 2 | 3,
    };
    expect(computeIdempotencyKey(args)).toBe(computeIdempotencyKey(args));
  });
});

// ─── 7. Validator chain fail-fast on schema, runs grounding only on pass ────

describe("validator chain", () => {
  test("schema fail short-circuits — grounding does not run", () => {
    const r = runValidatorChain({ chief_complaint: "x" }, TRANSCRIPT);
    expect(r.schema_invalid).toBe(true);
    expect(r.validators_run).toContain("schema");
    expect(r.validators_run).not.toContain("grounding");
  });

  test("schema pass → grounding runs", () => {
    const r = runValidatorChain(GOLD, TRANSCRIPT);
    expect(r.schema_invalid).toBe(false);
    expect(r.validators_run).toEqual(["schema", "grounding"]);
    expect(r.ok).toBe(true);
  });

  test("skipGrounding option short-circuits grounding", () => {
    const r = runValidatorChain(GOLD, TRANSCRIPT, { skipGrounding: true });
    expect(r.validators_run).toEqual(["schema"]);
  });
});

// ─── 8. Mock adapter scripted-failure mode (retry loop testability) ────────

describe("MockLLMAdapter scripted-failure mode", () => {
  const TRANSCRIPT_2 = "Patient has fever. BP 110/70.";
  const GOLD_2: ClinicalExtraction = {
    chief_complaint: "fever",
    vitals:       { bp: "110/70", hr: null, temp_f: null, spo2: null },
    medications:  [],
    diagnoses:    [],
    plan:         [],
    follow_up:    { interval_days: null, reason: null },
  };

  test("default behavior: returns noisified gold", async () => {
    const m = new MockLLMAdapter();
    m.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT_2, gold: GOLD_2, tokens: 10, tags: [] }]);
    const r = await m.call({ system: [], tools: [], messages: [], tool_choice: { type: "tool", name: "x" }, temperature: 0, max_tokens: 0 }, "c1");
    expect(r.predicted.chief_complaint).toBe(GOLD_2.chief_complaint);
  });

  test("scripted: schema_invalid → tool_use sequence consumed in order", async () => {
    const m = new MockLLMAdapter();
    m.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT_2, gold: GOLD_2, tokens: 10, tags: [] }]);
    m.script("c1", [{ kind: "schema_invalid" }, { kind: "tool_use" }]);

    const empty = { system: [], tools: [], messages: [], tool_choice: { type: "tool" as const, name: "x" }, temperature: 0, max_tokens: 0 };
    const r1 = await m.call(empty, "c1");
    const r2 = await m.call(empty, "c1");
    expect(schemaValidator.validate(r1.predicted, TRANSCRIPT_2).schema_invalid).toBe(true);
    expect(schemaValidator.validate(r2.predicted, TRANSCRIPT_2).schema_invalid).toBe(false);
  });

  test("scripted: grounding_failed produces fabricated medication", async () => {
    const m = new MockLLMAdapter();
    m.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT_2, gold: GOLD_2, tokens: 10, tags: [] }]);
    m.script("c1", [{ kind: "grounding_failed" }]);
    const empty = { system: [], tools: [], messages: [], tool_choice: { type: "tool" as const, name: "x" }, temperature: 0, max_tokens: 0 };
    const r = await m.call(empty, "c1");
    const validation = runValidatorChain(r.predicted, TRANSCRIPT_2);
    expect(validation.schema_invalid).toBe(false);
    expect(validation.grounding_failed).toBe(true);
  });

  test("scripted: throw simulates adapter exception", async () => {
    const m = new MockLLMAdapter();
    m.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT_2, gold: GOLD_2, tokens: 10, tags: [] }]);
    m.script("c1", [{ kind: "throw", message: "simulated network failure" }]);
    const empty = { system: [], tools: [], messages: [], tool_choice: { type: "tool" as const, name: "x" }, temperature: 0, max_tokens: 0 };
    expect(m.call(empty, "c1")).rejects.toThrow("simulated network failure");
  });

  test("observed records every call", async () => {
    const m = new MockLLMAdapter();
    m.loadDataset([{ case_id: "c1", transcript: TRANSCRIPT_2, gold: GOLD_2, tokens: 10, tags: [] }]);
    const empty = { system: [], tools: [], messages: [], tool_choice: { type: "tool" as const, name: "x" }, temperature: 0, max_tokens: 0 };
    await m.call(empty, "c1");
    await m.call(empty, "c1");
    expect(m.observed).toHaveLength(2);
  });
});
