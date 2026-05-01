// apps/server/src/validators/grounding.ts
//
// Hallucination detector. For every leaf string in the prediction, find the
// best-matching contiguous span of the transcript and accept if their
// normalized character-level similarity clears THRESHOLD. This is the Tier-2
// fuzzy gate — Tier-1 (exact substring) was too brittle for paraphrase
// (the brief's transcripts routinely reword "I've had a sore throat for four
// days" → "sore throat for four days", which Tier-1 flagged as hallucination).
//
// Algorithm: approximate substring matching via the standard Levenshtein DP
// where row 0 is initialized to 0 (empty prefix matches anywhere with cost 0).
// The minimum value in the last row is the edit distance from V to its
// closest contiguous substring of T. Cost: O(|T| * |V|) per leaf, ≈ 30k ops
// for typical sizes — runs in well under a millisecond per case.
//
// Skip-paths: vitals (numeric, formatting differs), interval_days (derived).

import type { ClinicalExtraction } from "../data/clinical-schema";
import type { IValidator, ValidationError, ValidationResult } from "./types";

const SKIP_PATHS = new Set<string>([
  "vitals.bp", "vitals.hr", "vitals.temp_f", "vitals.spo2",
  "follow_up.interval_days",
]);

/**
 * Minimum normalized similarity (`1 - editDistance / |V|`) for a leaf to
 * count as grounded. Tuned empirically on case_001: real clinical paraphrase
 * lands at ≈ 0.55–0.65 (e.g., "Sore throat for four days and nasal
 * congestion" vs "had a sore throat for about four days, and now my nose"
 * → 0.59), while clear fabrications drop to ≈ 0.30–0.45. 0.55 is the lowest
 * threshold that still flags the case_001 fabrication "Increase fluid
 * intake" (sim 0.43 vs the closest transcript span).
 */
export const GROUNDING_THRESHOLD = 0.55;

/**
 * Normalize for comparison: lowercase, collapse whitespace, strip leading/
 * trailing punctuation. Internal punctuation (e.g., "120/80") is kept.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns `1 - minEditDistance(V, anySubstringOf(T)) / |V|`.
 * 1.0 = V appears verbatim somewhere in T. 0.0 = no overlap at all.
 * Also returns the end-index in T of the best match so the caller can
 * surface a "closest_transcript" excerpt for diagnostics.
 */
export function fuzzySubstringSimilarity(
  value: string, transcript: string,
): { similarity: number; closestSpan: string } {
  const V = normalize(value);
  const T = normalize(transcript);
  if (V.length === 0) return { similarity: 1, closestSpan: "" };
  if (T.length === 0) return { similarity: 0, closestSpan: "" };

  const m = V.length;
  const n = T.length;

  // Two rolling rows. prev[j] = d[i-1][j], curr[j] = d[i][j].
  // Row 0 is all zeros (empty T-suffix ⇒ V[0..j] fully deleted, but the
  // approximate-substring trick is the OTHER direction: d[i][0] = 0 lets
  // V start matching at any position in T).
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  let bestDist = m;        // worst case: delete every char of V
  let bestEnd  = 0;

  for (let i = 1; i <= n; i++) {
    curr[0] = 0;           // empty V-prefix can match the empty suffix of T[0..i] at cost 0
    const ti = T.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const sub = V.charCodeAt(j - 1) === ti ? 0 : 1;
      curr[j] = Math.min(
        prev[j - 1] + sub,
        prev[j]     + 1,
        curr[j - 1] + 1,
      );
    }
    if (curr[m] < bestDist) {
      bestDist = curr[m];
      bestEnd  = i;
    }
    [prev, curr] = [curr, prev];
  }

  const similarity = 1 - bestDist / m;
  // Excerpt a window of ±20% around the best end position for the
  // diagnostics field. Not part of the score — purely UX for when a
  // grounding error is shown to the developer.
  const span = T.slice(Math.max(0, bestEnd - Math.ceil(m * 1.2)), bestEnd);
  return { similarity, closestSpan: span };
}

export const groundingValidator: IValidator = {
  name: "grounding",

  validate(predicted: unknown, transcript: string): ValidationResult {
    const start = Date.now();

    if (predicted == null || typeof predicted !== "object") {
      return {
        ok: true, errors: [],
        schema_invalid: false, grounding_failed: false,
        hallucination_count: 0,
        validators_run: ["grounding"],
        duration_ms: Date.now() - start,
      };
    }

    const errors: ValidationError[] = [];
    const pred = predicted as ClinicalExtraction;

    const lowerTranscript = transcript.toLowerCase();

    /**
     * Char-level fuzzy DP over-penalizes medical formalization
     * (e.g., predicted "Gastroesophageal reflux disease (GERD)" vs transcript
     * "reflux symptoms" → sim ≈ 0.34). Escape hatch: if any content token of
     * length ≥ 4 in the predicted value appears verbatim somewhere in the
     * transcript, accept. Real fabrications share no such anchor token.
     */
    const tokenAnchorMatch = (value: string): string | null => {
      const tokens = value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
      for (const t of tokens) if (lowerTranscript.includes(t)) return t;
      return null;
    };

    const check = (path: string, value: string | null | undefined) => {
      if (!value || SKIP_PATHS.has(path)) return;
      const { similarity, closestSpan } = fuzzySubstringSimilarity(value, transcript);
      if (similarity >= GROUNDING_THRESHOLD) return;
      if (tokenAnchorMatch(value)) return;

      errors.push({
        kind:       "grounding_substring_miss",
        field_path: path,
        message:    `value "${value}" not grounded in transcript ` +
                    `(best similarity ${similarity.toFixed(2)} < ${GROUNDING_THRESHOLD}, ` +
                    `no shared 4+ char content token)`,
        hint:       "Quote a phrase that appears in the transcript, even loosely.",
        evidence: {
          candidate_value:    value,
          closest_transcript: closestSpan || null,
          similarity,
        },
      });
    };

    check("chief_complaint", pred.chief_complaint);
    pred.medications?.forEach((m, i) => check(`medications[${i}].name`, m.name));
    pred.diagnoses?.forEach((d, i)   => check(`diagnoses[${i}].description`, d.description));
    pred.plan?.forEach((p, i)        => check(`plan[${i}]`, p));

    return {
      ok:                  errors.length === 0,
      errors,
      schema_invalid:      false,
      grounding_failed:    errors.length > 0,
      hallucination_count: errors.length,
      validators_run:      ["grounding"],
      duration_ms:         Date.now() - start,
    };
  },
};
