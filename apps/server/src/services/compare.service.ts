// apps/server/src/services/compare.service.ts
//
// Compares two runs. Per-field deltas (mean score) + per-case bucketing
// (improved / regressed / unchanged) — the headline screen of the brief.
// Reads only from `runs`, `evaluations`, `scores` (already populated by the
// pipeline). No re-scoring.

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@test-evals/db";
import { evaluations, scores } from "@test-evals/db/schema";
import {
  RunRepository,
  type Run,
  type RunId,
} from "@test-evals/db/repositories";

export interface CaseDelta {
  case_id:  string;
  a:        number | null;       // null if final_status !== 'succeeded' for that side
  b:        number | null;
  delta:    number;              // (b ?? 0) - (a ?? 0)
  a_status: string;
  b_status: string;
}

export interface FieldDelta {
  field_path:  string;
  a:           number | null;
  b:           number | null;
  delta:       number;
  winner:      "a" | "b" | "tie";
  sample_size: number;          // min(n_a, n_b) — fairness guard
}

export interface CompareResponse {
  run_a:                 Run;
  run_b:                 Run;
  dataset_hash_match:    boolean;

  aggregate_delta: {
    weighted: number;            // (b - a) over case-weighted means
    cost:     number;            // total_cost_usd: b - a
    duration_ms: number | null;
  };

  per_field_delta:    FieldDelta[];
  case_buckets: {
    improved:  CaseDelta[];      // delta > 0
    regressed: CaseDelta[];      // delta < 0
    unchanged: CaseDelta[];      // delta == 0
  };
  hallucination_delta:  { a: number; b: number };
  schema_invalid_delta: { a: number; b: number };
  overall_winner:       "a" | "b" | "tie";
}

export class CompareService {
  constructor(private readonly runs: RunRepository) {}

  async compare(runAId: RunId, runBId: RunId): Promise<CompareResponse> {
    const [a, b] = await Promise.all([this.runs.findById(runAId), this.runs.findById(runBId)]);
    if (!a) throw new Error(`run not found: ${runAId}`);
    if (!b) throw new Error(`run not found: ${runBId}`);

    const datasetHashMatch = a.dataset_hash === b.dataset_hash;

    const [perField, caseRows, hallucCounts, schemaInvalidCounts] = await Promise.all([
      this.perFieldAggregate(runAId, runBId),
      this.caseLevel(runAId, runBId),
      this.countMetric(runAId, runBId, evaluations.hallucinationCount),
      this.countSchemaInvalid(runAId, runBId),
    ]);

    const improved   = caseRows.filter((c) => c.delta > 0);
    const regressed  = caseRows.filter((c) => c.delta < 0);
    const unchanged  = caseRows.filter((c) => c.delta === 0);

    // Aggregate delta = mean of case deltas (treating non-succeeded sides as 0).
    const totalDelta = caseRows.reduce((sum, c) => sum + c.delta, 0);
    const meanDelta  = caseRows.length === 0 ? 0 : totalDelta / caseRows.length;

    const overall: "a" | "b" | "tie" =
      meanDelta > 0.005  ? "b"  :
      meanDelta < -0.005 ? "a"  :
      "tie";

    return {
      run_a: a, run_b: b,
      dataset_hash_match: datasetHashMatch,
      aggregate_delta: {
        weighted:    meanDelta,
        cost:        b.total_cost.total_usd - a.total_cost.total_usd,
        duration_ms: (b.duration_ms ?? 0) - (a.duration_ms ?? 0),
      },
      per_field_delta: perField,
      case_buckets:    { improved, regressed, unchanged },
      hallucination_delta:  hallucCounts,
      schema_invalid_delta: schemaInvalidCounts,
      overall_winner:  overall,
    };
  }

  // ─── Internal queries ────────────────────────────────────────────────────

  private async perFieldAggregate(runA: RunId, runB: RunId): Promise<FieldDelta[]> {
    // Mean score per (run_id, field_path) over all rows for both runs.
    const rows = await db
      .select({
        runId:     scores.runId,
        fieldPath: scores.fieldPath,
        meanValue: sql<string>`AVG(${scores.value}::numeric)::text`,
        n:         sql<number>`COUNT(*)::int`,
      })
      .from(scores)
      .where(inArray(scores.runId, [runA, runB]))
      .groupBy(scores.runId, scores.fieldPath);

    const byField = new Map<string, { a?: number; b?: number; nA?: number; nB?: number }>();
    for (const r of rows) {
      const cur = byField.get(r.fieldPath) ?? {};
      const v = r.meanValue == null ? null : Number(r.meanValue);
      if (r.runId === runA) { cur.a = v ?? undefined; cur.nA = r.n; }
      else                   { cur.b = v ?? undefined; cur.nB = r.n; }
      byField.set(r.fieldPath, cur);
    }

    const result: FieldDelta[] = [];
    for (const [field, v] of byField) {
      const av = v.a ?? null;
      const bv = v.b ?? null;
      const delta = (bv ?? 0) - (av ?? 0);
      result.push({
        field_path:  field,
        a:           av,
        b:           bv,
        delta,
        winner:      delta > 0.005 ? "b" : delta < -0.005 ? "a" : "tie",
        sample_size: Math.min(v.nA ?? 0, v.nB ?? 0),
      });
    }
    result.sort((x, y) => x.field_path.localeCompare(y.field_path));
    return result;
  }

  private async caseLevel(runA: RunId, runB: RunId): Promise<CaseDelta[]> {
    const rows = await db
      .select({
        runId:        evaluations.runId,
        caseId:       evaluations.caseId,
        weighted:     evaluations.weightedAggregate,
        finalStatus:  evaluations.finalStatus,
      })
      .from(evaluations)
      .where(inArray(evaluations.runId, [runA, runB]));

    const byCase = new Map<string, { a?: { score: number | null; status: string };
                                     b?: { score: number | null; status: string } }>();
    for (const r of rows) {
      const cur = byCase.get(r.caseId) ?? {};
      const score = r.weighted == null ? null : Number(r.weighted);
      const entry = { score, status: r.finalStatus };
      if (r.runId === runA) cur.a = entry; else cur.b = entry;
      byCase.set(r.caseId, cur);
    }

    const result: CaseDelta[] = [];
    for (const [caseId, v] of byCase) {
      // Only emit a row if BOTH runs have an evaluation for this case.
      if (!v.a || !v.b) continue;
      const a = v.a.score; const b = v.b.score;
      result.push({
        case_id:  caseId,
        a, b,
        delta:    (b ?? 0) - (a ?? 0),
        a_status: v.a.status,
        b_status: v.b.status,
      });
    }
    result.sort((x, y) => y.delta - x.delta);
    return result;
  }

  private async countMetric(
    runA: RunId, runB: RunId, col: typeof evaluations.hallucinationCount,
  ): Promise<{ a: number; b: number }> {
    const rows = await db
      .select({ runId: evaluations.runId, total: sql<number>`COALESCE(SUM(${col})::int, 0)` })
      .from(evaluations)
      .where(inArray(evaluations.runId, [runA, runB]))
      .groupBy(evaluations.runId);
    const out = { a: 0, b: 0 };
    for (const r of rows) {
      if (r.runId === runA) out.a = r.total;
      else                   out.b = r.total;
    }
    return out;
  }

  private async countSchemaInvalid(runA: RunId, runB: RunId): Promise<{ a: number; b: number }> {
    const rows = await db
      .select({ runId: evaluations.runId, n: sql<number>`COUNT(*)::int` })
      .from(evaluations)
      .where(and(
        inArray(evaluations.runId, [runA, runB]),
        eq(evaluations.schemaInvalid, true),
      ))
      .groupBy(evaluations.runId);
    const out = { a: 0, b: 0 };
    for (const r of rows) {
      if (r.runId === runA) out.a = r.n;
      else                   out.b = r.n;
    }
    return out;
  }
}
