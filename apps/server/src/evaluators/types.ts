// apps/server/src/evaluators/types.ts
//
// V1 subset of contracts.md §7 (ScoreResult) + §8 (IScorer).

export type ScoreCategory = "exact" | "fuzzy" | "tolerant" | "set_f1" | "grounding" | "schema";

export interface ScoreResult {
  scorer_name:     string;
  scorer_version:  number;
  category:        ScoreCategory;
  field_path:      string;
  value:           number;       // ∈ [0, 1]
  weight:          number;
  metadata?:       Record<string, unknown>;
}

export interface ScorerContext {
  predicted:  unknown;
  gold:       unknown;            // ClinicalExtraction at runtime
  transcript: string;
}

export interface IScorer {
  readonly name:             string;
  readonly version:          number;
  readonly category:         ScoreCategory;
  readonly applies_to_field: string;
  readonly weight:           number;
  score(ctx: ScorerContext): ScoreResult;
}
