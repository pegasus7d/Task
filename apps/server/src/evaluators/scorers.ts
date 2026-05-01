// apps/server/src/evaluators/scorers.ts
//
// Per-field scorer set covering all 6 schema fields. Each scorer is a pure
// function (predicted, gold, transcript) → [0,1]. Per-field metric matched
// to field semantics (contracts §5 / brief table):
//
//   chief_complaint  → token-set fuzzy
//   vitals.bp        → exact after normalization
//   vitals.hr        → numeric tolerant ±2 BPM
//   vitals.temp_f    → numeric tolerant ±0.2 °F
//   vitals.spo2      → numeric tolerant ±2 %
//   medications      → set-F1 with name-fuzzy + dose+freq canonicalization
//   diagnoses        → set-F1 description fuzzy + ICD-10 partial credit (1.0 / 0.5 / 0.0)
//   plan             → set-F1 token-set fuzzy
//   follow_up.interval_days → exact (incl. both null)
//   follow_up.reason        → token-set fuzzy

import type { ClinicalExtraction, Diagnosis, Medication } from "../data/clinical-schema";
import type { IScorer, ScorerContext, ScoreResult } from "./types";

// ─── Helpers ────────────────────────────────────────────────────────────────

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function tokenSet(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter(Boolean));
}

/** Token-set Jaccard similarity ∈ [0, 1]. */
function tokenSetRatio(a: string | null | undefined, b: string | null | undefined): number {
  const A = tokenSet(a ?? "");
  const B = tokenSet(b ?? "");
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Numeric tolerance scoring: 1.0 within `tol`, linear decay to 0.0 at `5×tol`.
 * Both null → 1.0. One null → 0.0.
 */
function tolerantNumeric(
  pred: number | null | undefined,
  gold: number | null | undefined,
  tol:  number,
): number {
  if (pred == null && gold == null) return 1;
  if (pred == null || gold == null) return 0;
  const diff = Math.abs(pred - gold);
  if (diff <= tol) return 1;
  const cap = tol * 5;
  return diff >= cap ? 0 : 1 - (diff - tol) / (cap - tol);
}

function setF1<T>(
  predicted: T[],
  gold:      T[],
  match:     (a: T, b: T) => boolean,
): { f1: number; precision: number; recall: number; tp: number; fp: number; fn: number } {
  const matchedGold = new Array<boolean>(gold.length).fill(false);
  let tp = 0;
  for (const p of predicted) {
    const idx = gold.findIndex((g, i) => !matchedGold[i] && match(p, g));
    if (idx >= 0) { matchedGold[idx] = true; tp++; }
  }
  const fp        = predicted.length - tp;
  const fn        = gold.length - tp;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1        = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { f1, precision, recall, tp, fp, fn };
}

// ─── Medication canonicalization (BID == twice daily, 10 mg == 10mg) ────────

const FREQ_CANON: Record<string, string> = {
  "qd": "qd", "once daily": "qd", "daily": "qd", "every 24 hours": "qd",
  "bid": "bid", "twice daily": "bid", "twice a day": "bid", "every 12 hours": "bid", "q12h": "bid",
  "tid": "tid", "three times daily": "tid", "every 8 hours": "tid", "q8h": "tid",
  "qid": "qid", "four times daily": "qid", "every 6 hours": "qid", "q6h": "qid",
  "prn": "prn", "as needed": "prn",
  "qhs": "qhs", "at bedtime": "qhs", "nightly": "qhs",
};

// Match longest keys first so "twice daily" doesn't get pre-empted by "daily".
const FREQ_KEYS_BY_LEN = Object.keys(FREQ_CANON).sort((a, b) => b.length - a.length);

function canonFrequency(f: string | null | undefined): string {
  const n = norm(f);
  if (!n) return "";
  for (const k of FREQ_KEYS_BY_LEN) {
    if (n.includes(k)) return FREQ_CANON[k]!;
  }
  return n;
}

function canonDose(d: string | null | undefined): string {
  // "10 mg" / "10mg" / "10 milligrams" all collapse to "10mg".
  return norm(d).replace(/\s+/g, "")
                .replace(/milligrams?/g, "mg")
                .replace(/micrograms?/g, "mcg")
                .replace(/grams?\b/g, "g");
}

function medicationsMatch(p: Medication, g: Medication): boolean {
  return tokenSetRatio(p.name, g.name) >= 0.7
      && canonDose(p.dose) === canonDose(g.dose)
      && canonFrequency(p.frequency) === canonFrequency(g.frequency);
}

// ─── ICD-10 partial credit (1.0 / 0.5 / 0.0) ────────────────────────────────

function icdPartialCredit(p: string | undefined, g: string | undefined): number {
  if (!p && !g) return 1;
  if (!p || !g) return 0;
  const P = p.toUpperCase().trim();
  const G = g.toUpperCase().trim();
  if (P === G) return 1;
  // Same 3-character category → 0.5 (e.g. J06.9 vs J06.0).
  return P.slice(0, 3) === G.slice(0, 3) ? 0.5 : 0;
}

// ─── Scorer factory ─────────────────────────────────────────────────────────

interface ScorerSpec {
  name:             string;
  version:          number;
  category:         ScoreResult["category"];
  applies_to_field: string;
  weight:           number;
  fn: (ctx: ScorerContext) => Pick<ScoreResult, "value" | "metadata">;
}

function makeScorer(spec: ScorerSpec): IScorer {
  return {
    name:             spec.name,
    version:          spec.version,
    category:         spec.category,
    applies_to_field: spec.applies_to_field,
    weight:           spec.weight,
    score(ctx) {
      const { value, metadata } = spec.fn(ctx);
      return {
        scorer_name:    spec.name,
        scorer_version: spec.version,
        category:       spec.category,
        field_path:     spec.applies_to_field,
        weight:         spec.weight,
        value,
        metadata,
      };
    },
  };
}

// ─── chief_complaint ───────────────────────────────────────────────────────

export const chiefComplaintFuzzy: IScorer = makeScorer({
  name: "chief_complaint_fuzzy", version: 1, category: "fuzzy",
  applies_to_field: "chief_complaint", weight: 1.0,
  fn: ({ predicted, gold }) => ({
    value: tokenSetRatio(
      (predicted as ClinicalExtraction)?.chief_complaint,
      (gold      as ClinicalExtraction)?.chief_complaint,
    ),
  }),
});

// ─── vitals (4 sub-scorers) ────────────────────────────────────────────────

export const vitalsBpExact: IScorer = makeScorer({
  name: "vitals_bp_exact", version: 1, category: "exact",
  applies_to_field: "vitals.bp", weight: 1.5,
  fn: ({ predicted, gold }) => {
    const p = norm((predicted as ClinicalExtraction)?.vitals?.bp);
    const g = norm((gold      as ClinicalExtraction)?.vitals?.bp);
    return { value: p === g ? 1 : 0, metadata: { expected: g, actual: p } };
  },
});

export const vitalsHrTolerant: IScorer = makeScorer({
  name: "vitals_hr_tolerant", version: 1, category: "tolerant",
  applies_to_field: "vitals.hr", weight: 1.5,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.vitals?.hr ?? null;
    const g = (gold      as ClinicalExtraction)?.vitals?.hr ?? null;
    return { value: tolerantNumeric(p, g, 2), metadata: { expected: g, actual: p } };
  },
});

export const vitalsTempTolerant: IScorer = makeScorer({
  name: "vitals_temp_tolerant", version: 1, category: "tolerant",
  applies_to_field: "vitals.temp_f", weight: 1.5,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.vitals?.temp_f ?? null;
    const g = (gold      as ClinicalExtraction)?.vitals?.temp_f ?? null;
    return { value: tolerantNumeric(p, g, 0.2), metadata: { expected: g, actual: p } };
  },
});

export const vitalsSpo2Tolerant: IScorer = makeScorer({
  name: "vitals_spo2_tolerant", version: 1, category: "tolerant",
  applies_to_field: "vitals.spo2", weight: 1.5,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.vitals?.spo2 ?? null;
    const g = (gold      as ClinicalExtraction)?.vitals?.spo2 ?? null;
    return { value: tolerantNumeric(p, g, 2), metadata: { expected: g, actual: p } };
  },
});

// ─── medications (set-F1 with canonicalization) ────────────────────────────

export const medicationsSetF1: IScorer = makeScorer({
  name: "medications_set_f1", version: 1, category: "set_f1",
  applies_to_field: "medications", weight: 2.0,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.medications ?? [];
    const g = (gold      as ClinicalExtraction)?.medications ?? [];
    const r = setF1<Medication>(p, g, medicationsMatch);
    return {
      value: r.f1,
      metadata: { precision: r.precision, recall: r.recall, tp: r.tp, fp: r.fp, fn: r.fn },
    };
  },
});

// ─── diagnoses (set-F1 description fuzzy + ICD partial credit blended) ─────

export const diagnosesSetF1: IScorer = makeScorer({
  name: "diagnoses_set_f1", version: 1, category: "set_f1",
  applies_to_field: "diagnoses", weight: 2.0,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.diagnoses ?? [];
    const g = (gold      as ClinicalExtraction)?.diagnoses ?? [];
    const r = setF1<Diagnosis>(p, g, (a, b) => tokenSetRatio(a.description, b.description) >= 0.6);

    // ICD bonus: average partial credit across matched-pair ICD-10 codes.
    let icdSum = 0; let icdCount = 0;
    for (const a of p) {
      const match = g.find((b) => tokenSetRatio(a.description, b.description) >= 0.6);
      if (match) {
        icdSum += icdPartialCredit(a.icd10, match.icd10);
        icdCount++;
      }
    }
    const icdBonus = icdCount > 0 ? icdSum / icdCount : 0;
    // Final blend: 80% description F1, 20% ICD partial credit.
    const value = 0.8 * r.f1 + 0.2 * icdBonus;
    return {
      value,
      metadata: { precision: r.precision, recall: r.recall, tp: r.tp, fp: r.fp, fn: r.fn,
                  icd_bonus: icdBonus, icd_pairs: icdCount },
    };
  },
});

// ─── plan (set-F1 token fuzzy) ─────────────────────────────────────────────

export const planSetF1: IScorer = makeScorer({
  name: "plan_set_f1", version: 1, category: "set_f1",
  applies_to_field: "plan", weight: 1.0,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.plan ?? [];
    const g = (gold      as ClinicalExtraction)?.plan ?? [];
    const r = setF1<string>(p, g, (a, b) => tokenSetRatio(a, b) >= 0.7);
    return {
      value: r.f1,
      metadata: { precision: r.precision, recall: r.recall, tp: r.tp, fp: r.fp, fn: r.fn },
    };
  },
});

// ─── follow_up (interval exact + reason fuzzy) ─────────────────────────────

export const followUpIntervalExact: IScorer = makeScorer({
  name: "follow_up_interval_exact", version: 1, category: "exact",
  applies_to_field: "follow_up.interval_days", weight: 1.0,
  fn: ({ predicted, gold }) => {
    const p = (predicted as ClinicalExtraction)?.follow_up?.interval_days ?? null;
    const g = (gold      as ClinicalExtraction)?.follow_up?.interval_days ?? null;
    return { value: p === g ? 1 : 0, metadata: { expected: g, actual: p } };
  },
});

export const followUpReasonFuzzy: IScorer = makeScorer({
  name: "follow_up_reason_fuzzy", version: 1, category: "fuzzy",
  applies_to_field: "follow_up.reason", weight: 1.0,
  fn: ({ predicted, gold }) => ({
    value: tokenSetRatio(
      (predicted as ClinicalExtraction)?.follow_up?.reason,
      (gold      as ClinicalExtraction)?.follow_up?.reason,
    ),
  }),
});

// ─── Registry ───────────────────────────────────────────────────────────────

export const ALL_SCORERS: readonly IScorer[] = [
  chiefComplaintFuzzy,
  vitalsBpExact,
  vitalsHrTolerant,
  vitalsTempTolerant,
  vitalsSpo2Tolerant,
  medicationsSetF1,
  diagnosesSetF1,
  planSetF1,
  followUpIntervalExact,
  followUpReasonFuzzy,
] as const;
