// packages/db/src/repositories/evaluation-repo.ts
//
// One row per (run_id, case_id), regardless of outcome. final_status carries
// the per-case terminal state from contracts §4 FinalStatus (11 values).
// Score columns are NULL on terminal failure (CHECK constraint enforces this
// in the DB — entities.md §1.7).

import { and, eq } from "drizzle-orm";

import { db } from "../index";
import { evaluations } from "../schema/eval";
import { throwIfConstraintViolation } from "./db-errors";
import type { AttemptId, CaseId, RunId } from "./types";

export type FinalStatus =
  | "succeeded"
  | "failed_schema_unrecoverable"
  | "failed_grounding_unrecoverable"
  | "failed_mixed"
  | "failed_rate_limited"
  | "failed_overloaded"
  | "failed_auth"
  | "failed_request_too_large"
  | "failed_timeout"
  | "cancelled"
  | "cost_cap_exceeded";

export interface EvaluationUpsertInput {
  evaluation_id:        string;        // UUIDv7 from caller
  run_id:               RunId;
  case_id:              CaseId;
  attempt_id:           AttemptId;
  final_status:         FinalStatus;
  termination_reason:   string | null;
  weighted_aggregate:   number | null;     // NULL iff final_status !== 'succeeded'
  unweighted_aggregate: number | null;
  schema_invalid:       boolean;
  hallucination_count:  number;
  grounded_field_rate:  number | null;
  duration_ms:          number;
}

export class EvaluationRepository {
  /**
   * Insert-or-update per (run_id, case_id). Used both on the success path
   * (Evaluator-driven) and the failure path (Runner-driven stub upsert).
   */
  async upsert(input: EvaluationUpsertInput): Promise<void> {
    try {
      await db.insert(evaluations).values({
        evaluationId:        input.evaluation_id,
        runId:               input.run_id,
        caseId:              input.case_id,
        attemptId:           input.attempt_id,
        finalStatus:         input.final_status,
        terminationReason:   input.termination_reason,
        weightedAggregate:   input.weighted_aggregate === null ? null : String(input.weighted_aggregate),
        unweightedAggregate: input.unweighted_aggregate === null ? null : String(input.unweighted_aggregate),
        schemaInvalid:       input.schema_invalid,
        hallucinationCount:  input.hallucination_count,
        groundedFieldRate:   input.grounded_field_rate === null ? null : String(input.grounded_field_rate),
        durationMs:          input.duration_ms,
      }).onConflictDoUpdate({
        target: [evaluations.runId, evaluations.caseId],
        set: {
          attemptId:           input.attempt_id,
          finalStatus:         input.final_status,
          terminationReason:   input.termination_reason,
          weightedAggregate:   input.weighted_aggregate === null ? null : String(input.weighted_aggregate),
          unweightedAggregate: input.unweighted_aggregate === null ? null : String(input.unweighted_aggregate),
          schemaInvalid:       input.schema_invalid,
          hallucinationCount:  input.hallucination_count,
          groundedFieldRate:   input.grounded_field_rate === null ? null : String(input.grounded_field_rate),
          durationMs:          input.duration_ms,
        },
      });
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }

  async findByRunCase(runId: RunId, caseId: CaseId) {
    const [row] = await db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.runId, runId), eq(evaluations.caseId, caseId)))
      .limit(1);
    return row ?? null;
  }
}
