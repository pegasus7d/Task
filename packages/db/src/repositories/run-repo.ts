// packages/db/src/repositories/run-repo.ts
//
// Subset of IRunRepository (contracts.md §11): create, findById, updateStatus,
// exists. Remaining methods (list, updateAggregates, findByConfigHash) are
// deferred until consumers need them.
//
// Multi-step writes (run + attempts + counters) should run inside a single
// `db.transaction(...)` at the RunnerService layer — this class does not open
// implicit transactions.

import { eq, sql } from "drizzle-orm";

import { db } from "../index";
import { runs, type RunRow, type RunRowNew } from "../schema/eval";
import { throwIfConstraintViolation } from "./db-errors";
import type {
  Cost,
  Run,
  RunConfig,
  RunId,
  RunStatus,
  TokenUsage,
} from "./types";

export interface CounterDelta {
  completedDelta:      number;
  succeededDelta:      number;
  failedDelta:         number;
  inFlightDelta:       number;
  inputTokens:         number;
  outputTokens:        number;
  cacheCreationTokens: number;
  cacheReadTokens:     number;
  costUsd:             number;
}

// ─── Mapping ────────────────────────────────────────────────────────────────

function toIso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function mapRunRow(row: RunRow): Run {
  const usage: TokenUsage = {
    input_tokens:                row.totalInputTokens,
    output_tokens:               row.totalOutputTokens,
    cache_creation_input_tokens: row.totalCacheCreationTokens,
    cache_read_input_tokens:     row.totalCacheReadTokens,
  };

  // entities.md §1.5 — `runs` stores only `total_cost_usd` (rolled-up). The
  // per-bucket USD fields on `Cost` are not persisted on this row; they are
  // always 0 here. Callers needing a true breakdown must sum from `attempts`
  // (RunnerService / aggregate jobs), not from this mapper.
  const cost: Cost = {
    total_usd:          Number(row.totalCostUsd),
    input_usd:          0,
    output_usd:         0,
    cache_creation_usd: 0,
    cache_read_usd:     0,
  };

  return {
    run_id:         row.runId as RunId,
    status:         row.status as RunStatus,
    config:         row.configJsonb as RunConfig,
    prompt_hash:    row.promptHash,
    tools_hash:     row.toolsHash,
    schema_hash:    row.schemaHash,
    dataset_hash:   row.datasetHash,
    config_hash:    row.configHash,
    started_at:     row.startedAt.toISOString(),
    completed_at:   toIso(row.completedAt),
    cancelled_at:   toIso(row.cancelledAt),
    duration_ms:    row.durationMs,
    case_count:     row.caseCount,
    case_completed: row.caseCompleted,
    case_succeeded: row.caseSucceeded,
    case_failed:    row.caseFailed,
    case_in_flight: row.caseInFlight,
    total_usage:    usage,
    total_cost:     cost,
    notes:          row.notes ?? undefined,
  };
}

function newRunId(): string {
  const g = globalThis as { Bun?: { randomUUIDv7?: () => string } };
  return g.Bun?.randomUUIDv7?.() ?? crypto.randomUUID();
}

// ─── Repository ─────────────────────────────────────────────────────────────

export class RunRepository {
  async create(input: Omit<Run, "run_id"> & { run_id?: RunId }): Promise<Run> {
    const runId = (input.run_id ?? newRunId()) as RunId;

    const values: RunRowNew = {
      runId,
      status:                   input.status,
      strategyName:             input.config.strategy,
      model:                    input.config.model,
      promptHash:               input.prompt_hash,
      toolsHash:                input.tools_hash,
      schemaHash:               input.schema_hash,
      datasetHash:              input.dataset_hash,
      configHash:               input.config_hash,
      configJsonb:              input.config,
      startedAt:                new Date(input.started_at),
      completedAt:              input.completed_at ? new Date(input.completed_at) : null,
      cancelledAt:              input.cancelled_at ? new Date(input.cancelled_at) : null,
      durationMs:               input.duration_ms,
      caseCount:                input.case_count,
      caseCompleted:            input.case_completed,
      caseSucceeded:            input.case_succeeded,
      caseFailed:               input.case_failed,
      caseInFlight:             input.case_in_flight,
      totalInputTokens:         input.total_usage.input_tokens,
      totalOutputTokens:        input.total_usage.output_tokens,
      totalCacheCreationTokens: input.total_usage.cache_creation_input_tokens,
      totalCacheReadTokens:     input.total_usage.cache_read_input_tokens,
      totalCostUsd:             String(input.total_cost.total_usd),
      notes:                    input.notes ?? null,
    };

    try {
      const [row] = await db.insert(runs).values(values).returning();
      if (!row) throw new Error("RunRepository.create: INSERT did not return a row");
      return mapRunRow(row);
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }

  async findById(id: RunId): Promise<Run | null> {
    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.runId, id))
      .limit(1);

    return row ? mapRunRow(row) : null;
  }

  async updateStatus(runId: RunId, status: RunStatus): Promise<void> {
    const rows = await db
      .update(runs)
      .set({ status })
      .where(eq(runs.runId, runId))
      .returning({ runId: runs.runId });
    if (rows.length === 0) throw new Error("RunRepository.updateStatus: run not found");
  }

  async exists(id: RunId): Promise<boolean> {
    const row = await db.select({ runId: runs.runId }).from(runs).where(eq(runs.runId, id)).limit(1);
    return row.length > 0;
  }

  /** Latest-first listing for the runs page. V2: no filtering, just limit. */
  async list(opts: { limit?: number } = {}): Promise<Run[]> {
    const limit = Math.min(opts.limit ?? 50, 500);
    const rows = await db.select().from(runs).orderBy(sql`${runs.startedAt} DESC`).limit(limit);
    return rows.map(mapRunRow);
  }

  /**
   * Atomic counter increments — uses SQL `column + delta` so concurrent case
   * completions don't race. Mapping to entities.md §6.2 "case-final write".
   */
  async incrementCounters(runId: RunId, d: CounterDelta): Promise<void> {
    await db.update(runs).set({
      caseCompleted:            sql`${runs.caseCompleted}            + ${d.completedDelta}`,
      caseSucceeded:            sql`${runs.caseSucceeded}            + ${d.succeededDelta}`,
      caseFailed:               sql`${runs.caseFailed}               + ${d.failedDelta}`,
      caseInFlight:             sql`GREATEST(0, ${runs.caseInFlight} + ${d.inFlightDelta})`,
      totalInputTokens:         sql`${runs.totalInputTokens}         + ${d.inputTokens}`,
      totalOutputTokens:        sql`${runs.totalOutputTokens}        + ${d.outputTokens}`,
      totalCacheCreationTokens: sql`${runs.totalCacheCreationTokens} + ${d.cacheCreationTokens}`,
      totalCacheReadTokens:     sql`${runs.totalCacheReadTokens}     + ${d.cacheReadTokens}`,
      totalCostUsd:             sql`${runs.totalCostUsd}             + ${d.costUsd.toFixed(6)}::numeric`,
    }).where(eq(runs.runId, runId));
  }

  async markCompleted(runId: RunId, durationMs: number): Promise<void> {
    await db.update(runs).set({
      status:      "completed",
      completedAt: new Date(),
      durationMs,
    }).where(eq(runs.runId, runId));
  }

  async markFailed(runId: RunId, durationMs: number): Promise<void> {
    await db.update(runs).set({
      status:      "failed",
      completedAt: new Date(),
      durationMs,
    }).where(eq(runs.runId, runId));
  }
}
