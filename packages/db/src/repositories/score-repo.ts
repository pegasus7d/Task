// packages/db/src/repositories/score-repo.ts
//
// Append-only writer for score rows. One bulk insert per case (Evaluator
// runs all scorers, then dumps them in a single round-trip).

import { db } from "../index";
import { scores } from "../schema/eval";
import { throwIfConstraintViolation } from "./db-errors";
import type { AttemptId, CaseId, RunId } from "./types";

export interface ScoreInput {
  score_id:        string;        // UUIDv7 from caller
  attempt_id:      AttemptId;
  run_id:          RunId;
  case_id:         CaseId;
  scorer_name:     string;
  scorer_version:  number;
  category:        "exact" | "fuzzy" | "tolerant" | "set_f1" | "grounding" | "schema";
  field_path:      string;
  value:           number;        // ∈ [0, 1]
  weight:          number;
  metadata?:       Record<string, unknown>;
}

export class ScoreRepository {
  async createMany(rows: ScoreInput[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await db.insert(scores).values(rows.map((r) => ({
        scoreId:       r.score_id,
        attemptId:     r.attempt_id,
        runId:         r.run_id,
        caseId:        r.case_id,
        scorerName:    r.scorer_name,
        scorerVersion: r.scorer_version,
        category:      r.category,
        fieldPath:     r.field_path,
        value:         String(r.value),
        weight:        String(r.weight),
        metadataJsonb: (r.metadata ?? null) as never,
      })));
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }
}
