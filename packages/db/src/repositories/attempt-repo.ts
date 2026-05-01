// packages/db/src/repositories/attempt-repo.ts
//
// Subset of IAttemptRepository (contracts.md §11): create, update, findById,
// findByIdempotencyKey, listForRun, listForCase, exists. Remaining methods
// (findStaleInFlight, countByStatus) are deferred until consumers need them.

import { and, asc, eq } from "drizzle-orm";

import { db } from "../index";
import { attempts, type AttemptRow, type AttemptRowNew } from "../schema/eval";
import { throwIfConstraintViolation } from "./db-errors";
import type {
  Attempt,
  AttemptId,
  AttemptIdx,
  AttemptStatus,
  CaseId,
  Cost,
  ModelId,
  RunId,
  Sha256Hex,
  StrategyName,
  TokenUsage,
} from "./types";

// ─── Mapping ────────────────────────────────────────────────────────────────

function mapAttemptRow(row: AttemptRow): Attempt {
  const usage: TokenUsage = {
    input_tokens:                row.inputTokens,
    output_tokens:               row.outputTokens,
    cache_creation_input_tokens: row.cacheCreationInputTokens,
    cache_read_input_tokens:     row.cacheReadInputTokens,
  };

  const cost: Cost = {
    total_usd:          Number(row.costTotalUsd),
    input_usd:          Number(row.costInputUsd),
    output_usd:         Number(row.costOutputUsd),
    cache_creation_usd: Number(row.costCacheCreationUsd),
    cache_read_usd:     Number(row.costCacheReadUsd),
  };

  return {
    schema_version:       row.schemaVersion as Attempt["schema_version"],
    attempt_id:           row.attemptId as AttemptId,
    run_id:               row.runId as RunId,
    case_id:              row.caseId,
    attempt_idx:          row.attemptIdx as AttemptIdx,
    status:               row.status as AttemptStatus,
    strategy:             row.strategyName as StrategyName,
    model:                row.model as ModelId,
    prompt_hash:          row.promptHash,
    idempotency_key:      row.idempotencyKey,
    anthropic_request_id: row.anthropicRequestId,
    started_at:           row.startedAt.toISOString(),
    completed_at:         row.completedAt ? row.completedAt.toISOString() : null,
    duration_ms:          row.durationMs,
    predicted_json:       (row.predictedJsonb as Record<string, unknown> | null) ?? null,
    raw_response_path:    row.rawResponsePath,
    retry_reason:         row.retryReason,
    validation_result:    (row.validationJsonb as Record<string, unknown> | null) ?? null,
    usage,
    cost,
  };
}

// ─── Repository ─────────────────────────────────────────────────────────────

export class AttemptRepository {
  async create(attempt: Attempt): Promise<void> {
    const values: AttemptRowNew = {
      attemptId:                attempt.attempt_id,
      runId:                    attempt.run_id,
      caseId:                   attempt.case_id,
      attemptIdx:               attempt.attempt_idx,
      status:                   attempt.status,
      strategyName:             attempt.strategy,
      model:                    attempt.model,
      promptHash:               attempt.prompt_hash,
      idempotencyKey:           attempt.idempotency_key,
      anthropicRequestId:       attempt.anthropic_request_id,
      startedAt:                new Date(attempt.started_at),
      completedAt:              attempt.completed_at ? new Date(attempt.completed_at) : null,
      durationMs:               attempt.duration_ms,
      heartbeatAt:              null,
      predictedJsonb:           attempt.predicted_json as never,
      rawResponsePath:          attempt.raw_response_path,
      retryReason:              attempt.retry_reason,
      validationJsonb:          attempt.validation_result as never,
      inputTokens:              attempt.usage.input_tokens,
      outputTokens:             attempt.usage.output_tokens,
      cacheCreationInputTokens: attempt.usage.cache_creation_input_tokens,
      cacheReadInputTokens:     attempt.usage.cache_read_input_tokens,
      costTotalUsd:             String(attempt.cost.total_usd),
      costInputUsd:             String(attempt.cost.input_usd),
      costOutputUsd:            String(attempt.cost.output_usd),
      costCacheCreationUsd:     String(attempt.cost.cache_creation_usd),
      costCacheReadUsd:         String(attempt.cost.cache_read_usd),
      schemaVersion:            attempt.schema_version,
    };

    try {
      await db.insert(attempts).values(values);
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }

  async update(attemptId: AttemptId, patch: Partial<Attempt>): Promise<void> {
    if (patch.prompt_hash !== undefined) {
      throw new Error("AttemptRepository.update: prompt_hash is immutable");
    }

    const set: Partial<AttemptRowNew> = {};

    if (patch.status !== undefined) set.status = patch.status;
    if (patch.strategy !== undefined) set.strategyName = patch.strategy;
    if (patch.model !== undefined) set.model = patch.model;
    if (patch.started_at !== undefined) set.startedAt = new Date(patch.started_at);
    if (patch.completed_at !== undefined) {
      set.completedAt = patch.completed_at ? new Date(patch.completed_at) : null;
    }
    if (patch.duration_ms !== undefined) set.durationMs = patch.duration_ms;
    if (patch.predicted_json !== undefined) set.predictedJsonb = patch.predicted_json as never;
    if (patch.raw_response_path !== undefined) set.rawResponsePath = patch.raw_response_path;
    if (patch.validation_result !== undefined) {
      set.validationJsonb = patch.validation_result as never;
    }
    if (patch.retry_reason !== undefined) set.retryReason = patch.retry_reason;
    if (patch.anthropic_request_id !== undefined) {
      set.anthropicRequestId = patch.anthropic_request_id;
    }

    if (patch.usage !== undefined) {
      set.inputTokens = patch.usage.input_tokens;
      set.outputTokens = patch.usage.output_tokens;
      set.cacheCreationInputTokens = patch.usage.cache_creation_input_tokens;
      set.cacheReadInputTokens = patch.usage.cache_read_input_tokens;
    }
    if (patch.cost !== undefined) {
      set.costTotalUsd = String(patch.cost.total_usd);
      set.costInputUsd = String(patch.cost.input_usd);
      set.costOutputUsd = String(patch.cost.output_usd);
      set.costCacheCreationUsd = String(patch.cost.cache_creation_usd);
      set.costCacheReadUsd = String(patch.cost.cache_read_usd);
    }
    if (patch.schema_version !== undefined) set.schemaVersion = patch.schema_version;

    if (Object.keys(set).length === 0) return;

    try {
      const rows = await db
        .update(attempts)
        .set(set)
        .where(eq(attempts.attemptId, attemptId))
        .returning({ attemptId: attempts.attemptId });
      if (rows.length === 0) throw new Error("AttemptRepository.update: attempt not found");
    } catch (e) {
      throwIfConstraintViolation(e);
    }
  }

  async findByIdempotencyKey(key: Sha256Hex): Promise<Attempt | null> {
    const [row] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.idempotencyKey, key))
      .limit(1);
    return row ? mapAttemptRow(row) : null;
  }

  async findById(id: AttemptId): Promise<Attempt | null> {
    const [row] = await db.select().from(attempts).where(eq(attempts.attemptId, id)).limit(1);
    return row ? mapAttemptRow(row) : null;
  }

  async exists(id: AttemptId): Promise<boolean> {
    const row = await db
      .select({ attemptId: attempts.attemptId })
      .from(attempts)
      .where(eq(attempts.attemptId, id))
      .limit(1);
    return row.length > 0;
  }

  async listForRun(runId: RunId): Promise<Attempt[]> {
    const rows = await db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, runId))
      .orderBy(asc(attempts.caseId), asc(attempts.attemptIdx));

    return rows.map(mapAttemptRow);
  }

  async listForCase(runId: RunId, caseId: CaseId): Promise<Attempt[]> {
    const rows = await db
      .select()
      .from(attempts)
      .where(and(eq(attempts.runId, runId), eq(attempts.caseId, caseId)))
      .orderBy(asc(attempts.attemptIdx));

    return rows.map(mapAttemptRow);
  }
}
