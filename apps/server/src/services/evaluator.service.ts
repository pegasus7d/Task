// apps/server/src/services/evaluator.service.ts
//
// Runs all V1 scorers, computes weighted/unweighted aggregates, persists
// `scores` rows AND upserts the `evaluations` row (success path).

import {
  EvaluationRepository,
  ScoreRepository,
  type AttemptId,
  type CaseId,
  type RunId,
} from "@test-evals/db/repositories";

import type { ClinicalExtraction } from "../data/clinical-schema";
import type { IScorer } from "../evaluators/types";
import { newId } from "../utils/ids";

export interface EvaluationInput {
  run_id:              RunId;
  attempt_id:          AttemptId;
  case_id:             CaseId;
  predicted:           ClinicalExtraction;
  gold:                ClinicalExtraction;
  transcript:          string;
  schema_invalid:      boolean;
  hallucination_count: number;
}

export interface EvaluationOutput {
  weighted_aggregate:   number;
  unweighted_aggregate: number;
  scorer_count:         number;
  duration_ms:          number;
}

export class EvaluatorService {
  constructor(
    private readonly scorers:  readonly IScorer[],
    private readonly evalRepo: EvaluationRepository,
    private readonly scoreRepo: ScoreRepository,
  ) {}

  async scoreCase(input: EvaluationInput): Promise<EvaluationOutput> {
    const t0 = Date.now();

    const results = this.scorers.map((s) =>
      s.score({ predicted: input.predicted, gold: input.gold, transcript: input.transcript }),
    );

    const totalWeight     = results.reduce((sum, r) => sum + r.weight, 0);
    const weightedAgg     = totalWeight === 0
      ? 0
      : results.reduce((sum, r) => sum + r.value * r.weight, 0) / totalWeight;
    const unweightedAgg   = results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + r.value, 0) / results.length;
    const groundedRate    = 1 - input.hallucination_count / Math.max(1, results.length);

    const durationMs = Date.now() - t0;

    // Persist score rows.
    await this.scoreRepo.createMany(results.map((r) => ({
      score_id:       newId(),
      attempt_id:     input.attempt_id,
      run_id:         input.run_id,
      case_id:        input.case_id,
      scorer_name:    r.scorer_name,
      scorer_version: r.scorer_version,
      category:       r.category,
      field_path:     r.field_path,
      value:          r.value,
      weight:         r.weight,
      metadata:       r.metadata,
    })));

    // Persist the per-case evaluations row (success branch).
    await this.evalRepo.upsert({
      evaluation_id:        newId(),
      run_id:               input.run_id,
      case_id:              input.case_id,
      attempt_id:           input.attempt_id,
      final_status:         "succeeded",
      termination_reason:   null,
      weighted_aggregate:   weightedAgg,
      unweighted_aggregate: unweightedAgg,
      schema_invalid:       input.schema_invalid,
      hallucination_count:  input.hallucination_count,
      grounded_field_rate:  groundedRate,
      duration_ms:          durationMs,
    });

    return {
      weighted_aggregate:   weightedAgg,
      unweighted_aggregate: unweightedAgg,
      scorer_count:         results.length,
      duration_ms:          durationMs,
    };
  }
}
