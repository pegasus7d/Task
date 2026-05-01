// apps/server/src/__tests__/extended.test.ts
//
// Coverage for V3 additions: 3 strategies, all 6 fields scored, prompt-cache
// signaling, adapter selection.

import { describe, expect, test } from "bun:test";

import { fewShotStrategy } from "../llm/strategies/few-shot";
import { cotStrategy } from "../llm/strategies/cot";
import { zeroShotStrategy } from "../llm/strategies/zero-shot";
import { MockLLMAdapter } from "../llm/mock-adapter";
import { selectAdapter } from "../llm/select-adapter";
import {
  ALL_SCORERS,
  medicationsSetF1,
  diagnosesSetF1,
  vitalsHrTolerant,
  vitalsTempTolerant,
  vitalsSpo2Tolerant,
  followUpIntervalExact,
  followUpReasonFuzzy,
} from "../evaluators/scorers";
import type { ClinicalExtraction } from "../data/clinical-schema";

const TRANSCRIPT = "x";
const GOLD: ClinicalExtraction = {
  chief_complaint: "x",
  vitals:       { bp: "120/80", hr: 88, temp_f: 100.4, spo2: 98 },
  medications:  [{ name: "ibuprofen", dose: "400 mg", frequency: "every 6 hours", route: "PO" }],
  diagnoses:    [{ description: "viral upper respiratory infection", icd10: "J06.9" }],
  plan:         ["x"],
  follow_up:    { interval_days: 7, reason: "recheck" },
};

// ─── 3 strategies registered + distinct prompt hashes ──────────────────────

describe("strategy registry (Priority 1 — 3 strategies)", () => {
  test("zero_shot, few_shot, cot are all distinct strategies", () => {
    expect(zeroShotStrategy.name).toBe("zero_shot");
    expect(fewShotStrategy.name).toBe("few_shot");
    expect(cotStrategy.name).toBe("cot");

    // Distinct prompt hashes — strategy is the only varied axis.
    const a = zeroShotStrategy.promptHash();
    const b = fewShotStrategy.promptHash();
    const c = cotStrategy.promptHash();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  test("few_shot includes <examples> in messages", () => {
    const p = fewShotStrategy.buildMessages({
      transcriptId: "x", transcript: "y", attemptIdx: 1, prevFeedback: null,
    });
    const text = p.messages[0]?.content[0];
    expect(text?.type).toBe("text");
    if (text?.type === "text") expect(text.text).toContain("<examples>");
  });

  test("cot strategy instructs model to emit <thinking>", () => {
    const p = cotStrategy.buildMessages({
      transcriptId: "x", transcript: "y", attemptIdx: 1, prevFeedback: null,
    });
    const sys = p.system[0];
    expect(sys?.type).toBe("text");
    if (sys?.type === "text") {
      expect(sys.text).toContain("<thinking>");
      expect(sys.text).toContain("extract_clinical");
    }
  });
});

// ─── All 6 fields covered by scorers (Priority 4) ───────────────────────────

describe("scorer coverage (Priority 4 — all 6 fields scored)", () => {
  test("ALL_SCORERS covers all 6 schema fields", () => {
    const fields = new Set(ALL_SCORERS.map((s) => s.applies_to_field));
    expect(fields.has("chief_complaint")).toBe(true);
    expect(fields.has("vitals.bp")).toBe(true);
    expect(fields.has("vitals.hr")).toBe(true);
    expect(fields.has("vitals.temp_f")).toBe(true);
    expect(fields.has("vitals.spo2")).toBe(true);
    expect(fields.has("medications")).toBe(true);
    expect(fields.has("diagnoses")).toBe(true);
    expect(fields.has("plan")).toBe(true);
    expect(fields.has("follow_up.interval_days")).toBe(true);
    expect(fields.has("follow_up.reason")).toBe(true);
  });

  test("medications set-F1: BID == twice daily after canonicalization", () => {
    const a: ClinicalExtraction = {
      ...GOLD,
      medications: [{ name: "metformin", dose: "500 mg", frequency: "BID", route: "PO" }],
    };
    const b: ClinicalExtraction = {
      ...GOLD,
      medications: [{ name: "metformin", dose: "500mg", frequency: "twice daily", route: "PO" }],
    };
    const r = medicationsSetF1.score({ predicted: a, gold: b, transcript: TRANSCRIPT });
    expect(r.value).toBe(1);
  });

  test("medications set-F1: dose drift not equal", () => {
    const a: ClinicalExtraction = {
      ...GOLD,
      medications: [{ name: "metformin", dose: "500 mg", frequency: "BID", route: "PO" }],
    };
    const b: ClinicalExtraction = {
      ...GOLD,
      medications: [{ name: "metformin", dose: "1000 mg", frequency: "BID", route: "PO" }],
    };
    const r = medicationsSetF1.score({ predicted: a, gold: b, transcript: TRANSCRIPT });
    expect(r.value).toBe(0);
  });

  test("diagnoses set-F1: exact ICD match → ICD bonus = 1.0", () => {
    const r = diagnosesSetF1.score({ predicted: GOLD, gold: GOLD, transcript: TRANSCRIPT });
    expect(r.value).toBeGreaterThan(0.95);  // 0.8 * 1.0 + 0.2 * 1.0 = 1.0
    expect(r.metadata?.icd_bonus).toBe(1);
  });

  test("diagnoses set-F1: same category-prefix → 0.5 ICD partial credit", () => {
    const a: ClinicalExtraction = {
      ...GOLD,
      diagnoses: [{ description: "viral upper respiratory infection", icd10: "J06.0" }],
    };
    const b: ClinicalExtraction = {
      ...GOLD,
      diagnoses: [{ description: "viral upper respiratory infection", icd10: "J06.9" }],
    };
    const r = diagnosesSetF1.score({ predicted: a, gold: b, transcript: TRANSCRIPT });
    expect(r.metadata?.icd_bonus).toBe(0.5);
  });

  test("vitals_hr_tolerant: within ±2 → 1.0", () => {
    const off: ClinicalExtraction = { ...GOLD, vitals: { ...GOLD.vitals, hr: 89 } };
    expect(vitalsHrTolerant.score({ predicted: off, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(1);
  });

  test("vitals_hr_tolerant: way off → 0.0", () => {
    const off: ClinicalExtraction = { ...GOLD, vitals: { ...GOLD.vitals, hr: 130 } };
    expect(vitalsHrTolerant.score({ predicted: off, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(0);
  });

  test("vitals_temp_tolerant: within ±0.2 °F → 1.0", () => {
    const off: ClinicalExtraction = { ...GOLD, vitals: { ...GOLD.vitals, temp_f: 100.5 } };
    expect(vitalsTempTolerant.score({ predicted: off, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(1);
  });

  test("vitals_spo2_tolerant: within ±2 → 1.0", () => {
    const off: ClinicalExtraction = { ...GOLD, vitals: { ...GOLD.vitals, spo2: 100 } };
    expect(vitalsSpo2Tolerant.score({ predicted: off, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(1);
  });

  test("follow_up_interval_exact: same int → 1.0; different → 0.0", () => {
    expect(followUpIntervalExact.score({ predicted: GOLD, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(1);
    const off: ClinicalExtraction = { ...GOLD, follow_up: { ...GOLD.follow_up, interval_days: 14 } };
    expect(followUpIntervalExact.score({ predicted: off, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(0);
  });

  test("follow_up_reason_fuzzy: identical → 1.0", () => {
    expect(followUpReasonFuzzy.score({ predicted: GOLD, gold: GOLD, transcript: TRANSCRIPT }).value).toBe(1);
  });
});

// ─── Prompt caching visibility (Priority 3) ─────────────────────────────────

describe("prompt caching (Priority 3)", () => {
  test("zero_shot has cache_control on system + tools", () => {
    const p = zeroShotStrategy.buildMessages({
      transcriptId: "x", transcript: "y", attemptIdx: 1, prevFeedback: null,
    });
    const sys = p.system[0];
    if (sys?.type === "text") {
      expect(sys.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    } else {
      throw new Error("expected text block in system");
    }
    expect(p.tools[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("few_shot has 2 cache breakpoints (shared + strategy suffix)", () => {
    const p = fewShotStrategy.buildMessages({
      transcriptId: "x", transcript: "y", attemptIdx: 1, prevFeedback: null,
    });
    const sys = p.system[0];
    if (sys?.type === "text") {
      expect(sys.cache_control).toBeDefined();   // breakpoint #1
    }
    const examplesBlock = p.messages[0]?.content[0];
    if (examplesBlock?.type === "text") {
      expect(examplesBlock.cache_control).toBeDefined();  // breakpoint #2
    } else {
      throw new Error("expected examples text block");
    }
  });

  test("MockLLMAdapter reports cache_read_input_tokens > 0 on second call", async () => {
    const m = new MockLLMAdapter();
    m.loadDataset([{ case_id: "c1", transcript: "t", gold: GOLD, tokens: 5, tags: [] }]);

    const payload = zeroShotStrategy.buildMessages({
      transcriptId: "c1", transcript: "t", attemptIdx: 1, prevFeedback: null,
    });

    const r1 = await m.call(payload, "c1");
    const r2 = await m.call(payload, "c1");

    // First call writes the cache; second reads it.
    expect(r1.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(r1.cache_read_input_tokens).toBe(0);
    expect(r2.cache_read_input_tokens).toBeGreaterThan(0);
    expect(r2.cache_creation_input_tokens).toBe(0);

    // Brief hard-req #3: cache_read increases across runs.
    expect(r2.cache_read_input_tokens).toBeGreaterThan(r1.cache_read_input_tokens);
  });
});

// ─── Adapter selection (Priority 5) ─────────────────────────────────────────

describe("adapter selection (Priority 5)", () => {
  test("defaults to mock when USE_ANTHROPIC is not set", () => {
    const prev = process.env.USE_ANTHROPIC;
    delete process.env.USE_ANTHROPIC;
    try {
      const a = selectAdapter();
      expect(a.id).toBe("mock");
    } finally {
      if (prev !== undefined) process.env.USE_ANTHROPIC = prev;
    }
  });
});
