// packages/db/src/repositories/dataset-repo.ts
//
// Bootstrap of dataset_versions + cases + gold_records on first run for a
// given dataset_hash. Idempotent — subsequent runs with the same hash skip
// inserts. Required because runs.dataset_hash is RESTRICT-FK'd to this table.

import { and, eq } from "drizzle-orm";

import { db } from "../index";
import { cases, datasetVersions, goldRecords, runs, scores } from "../schema/eval";
import { throwIfConstraintViolation } from "./db-errors";
import type { CaseId, RunId, Sha256Hex } from "./types";

export interface DatasetVersionInput {
  dataset_hash:   Sha256Hex;
  schema_hash:    Sha256Hex;
  case_count:     number;
  manifest_jsonb: unknown;
}

export interface CaseInput {
  case_id:      CaseId;
  dataset_hash: Sha256Hex;
  transcript:   string;
  tokens:       number;
  tags:         string[];
}

export interface GoldRecordInput {
  case_id:      CaseId;
  dataset_hash: Sha256Hex;
  gold_jsonb:   unknown;
}

export class DatasetRepository {
  async datasetVersionExists(datasetHash: Sha256Hex): Promise<boolean> {
    const rows = await db
      .select({ datasetHash: datasetVersions.datasetHash })
      .from(datasetVersions)
      .where(eq(datasetVersions.datasetHash, datasetHash))
      .limit(1);
    return rows.length > 0;
  }

  /** Insert dataset_version + cases + gold_records in one tx. No-op if hash exists. */
  async upsertDataset(input: {
    version: DatasetVersionInput;
    cases:   CaseInput[];
    gold:    GoldRecordInput[];
  }): Promise<{ inserted: boolean }> {
    if (await this.datasetVersionExists(input.version.dataset_hash)) {
      return { inserted: false };
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(datasetVersions).values({
          datasetHash:   input.version.dataset_hash,
          schemaHash:    input.version.schema_hash,
          caseCount:     input.version.case_count,
          manifestJsonb: input.version.manifest_jsonb as never,
        });

        if (input.cases.length > 0) {
          await tx.insert(cases).values(input.cases.map((c) => ({
            caseId:      c.case_id,
            datasetHash: c.dataset_hash,
            transcript:  c.transcript,
            tokens:      c.tokens,
            tags:        c.tags,
          })));
        }

        if (input.gold.length > 0) {
          await tx.insert(goldRecords).values(input.gold.map((g) => ({
            caseId:      g.case_id,
            datasetHash: g.dataset_hash,
            goldJsonb:   g.gold_jsonb as never,
          })));
        }
      });
      return { inserted: true };
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }

  /**
   * Fetch transcript + gold + per-case scores by joining via the run's
   * dataset_hash. Powers the case-detail UI page.
   */
  async getCaseDetail(runId: RunId, caseId: CaseId): Promise<{
    transcript: string;
    gold:       unknown;
    scores:     Array<{
      scorer_name:   string;
      scorer_version: number;
      category:      string;
      field_path:    string;
      value:         number;
      weight:        number;
      metadata:      unknown;
    }>;
  } | null> {
    const [runRow] = await db
      .select({ datasetHash: runs.datasetHash })
      .from(runs).where(eq(runs.runId, runId)).limit(1);
    if (!runRow) return null;

    const [caseRow] = await db
      .select({ transcript: cases.transcript })
      .from(cases)
      .where(and(eq(cases.datasetHash, runRow.datasetHash), eq(cases.caseId, caseId)))
      .limit(1);
    const [goldRow] = await db
      .select({ gold: goldRecords.goldJsonb })
      .from(goldRecords)
      .where(and(eq(goldRecords.datasetHash, runRow.datasetHash), eq(goldRecords.caseId, caseId)))
      .limit(1);
    if (!caseRow || !goldRow) return null;

    const scoreRows = await db
      .select({
        name:    scores.scorerName,
        version: scores.scorerVersion,
        cat:     scores.category,
        path:    scores.fieldPath,
        value:   scores.value,
        weight:  scores.weight,
        meta:    scores.metadataJsonb,
      })
      .from(scores)
      .where(and(eq(scores.runId, runId), eq(scores.caseId, caseId)));

    return {
      transcript: caseRow.transcript,
      gold:       goldRow.gold,
      scores:     scoreRows.map((s) => ({
        scorer_name:    s.name,
        scorer_version: s.version,
        category:       s.cat,
        field_path:     s.path,
        value:          Number(s.value),
        weight:         Number(s.weight),
        metadata:       s.meta,
      })),
    };
  }
}
