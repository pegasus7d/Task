// apps/server/src/services/runner.service.ts
//
// Per-case retry-with-feedback loop (≤3 attempts), bounded concurrency
// (5 in-flight cases), 429 backoff that honors `Retry-After`, and a resume
// path that skips cases already terminal in `evaluations`.

import { sql } from "drizzle-orm";

import { db } from "@test-evals/db";
import { evaluations } from "@test-evals/db/schema";
import {
  AttemptRepository,
  DatasetRepository,
  EvaluationRepository,
  PromptTemplateRepository,
  RunRepository,
  ScoreRepository,
  type RunConfig,
  type RunId,
  type Sha256Hex,
} from "@test-evals/db/repositories";
import { eq } from "drizzle-orm";

import { ALL_SCORERS } from "../evaluators/scorers";
import { mockLLMAdapter } from "../llm/mock-adapter";
import { selectAdapter } from "../llm/select-adapter";
import { zeroShotStrategy } from "../llm/strategies/zero-shot";
import { fewShotStrategy } from "../llm/strategies/few-shot";
import { cotStrategy } from "../llm/strategies/cot";
import { EXTRACT_CLINICAL_TOOL, EXTRACT_CLINICAL_INPUT_SCHEMA } from "../llm/tool-definition";
import { RateLimitError, type ILLMAdapter, type IStrategy } from "../llm/types";
import { canonicalJson, sha256 } from "../utils/hash";
import { newRunId } from "../utils/ids";
import { loadDataset, type DatasetManifest } from "../data/dataset-loader";

import { ExtractorService, type ExtractOutput } from "./extractor.service";
import { EvaluatorService } from "./evaluator.service";
import {
  collectFeedback,
  toValidationFeedback,
  type AttemptIdx,
  type ValidationFeedback,
} from "../validators/feedback";

const MAX_ATTEMPTS: AttemptIdx = 3;

/** Max cases in-flight against the LLM at any one time (brief §3 hard req #4). */
const MAX_CONCURRENCY = 5;

/** How many times we'll re-issue a single LLM call after a 429 before giving up. */
const MAX_429_RETRIES = 4;

/** Cap any single 429 backoff at 30s so a misconfigured server can't hang. */
const MAX_429_BACKOFF_MS = 30_000;

const STRATEGIES: Record<string, IStrategy> = {
  zero_shot: zeroShotStrategy,
  few_shot:  fewShotStrategy,
  cot:       cotStrategy,
};

/**
 * p-limit shaped semaphore. `run(fn)` resolves with `fn`'s result and never
 * holds more than `limit` `fn`s in-flight. Inline because it's the only caller.
 */
export function createLimiter(limit: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < limit) { active++; resolve(); }
      else waiters.push(() => { active++; resolve(); });
    });
  const release = (): void => {
    active--;
    waiters.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try { return await fn(); } finally { release(); }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a single LLM call so 429s are absorbed at the adapter boundary: read
 * `Retry-After`, sleep, retry. Bounded by MAX_429_RETRIES to avoid burning
 * forever in a sustained throttle. Other errors propagate unchanged.
 */
export function withRateLimitRetry(adapter: ILLMAdapter): ILLMAdapter {
  return {
    id: adapter.id,
    async call(payload, caseId) {
      let lastErr: unknown;
      for (let i = 0; i <= MAX_429_RETRIES; i++) {
        try {
          return await adapter.call(payload, caseId);
        } catch (err) {
          if (!(err instanceof RateLimitError)) throw err;
          lastErr = err;
          if (i === MAX_429_RETRIES) break;
          const wait = Math.min(err.retryAfterMs, MAX_429_BACKOFF_MS);
          await sleep(wait);
        }
      }
      throw lastErr;
    },
  };
}

export interface RunnerOptions {
  skipGrounding?: boolean;       // V1 only — see validators/chain.ts
}

export interface RunSummary {
  run_id:             RunId;
  case_count:         number;
  case_succeeded:     number;
  case_failed:        number;
  weighted_aggregate: number;     // mean across succeeded cases
  total_cost_usd:     number;
  duration_ms:        number;
}

export class RunnerService {
  constructor(
    private readonly runs:       RunRepository,
    private readonly attempts:   AttemptRepository,
    private readonly dataset:    DatasetRepository,
    private readonly prompts:    PromptTemplateRepository,
    private readonly evalRepo:   EvaluationRepository,
    private readonly scoreRepo:  ScoreRepository,
  ) {}

  /**
   * Public entry: start a run + drive it to completion. V1 is synchronous
   * (returns when the run is done). V2 will return the run_id immediately and
   * fan out via the async processRun loop.
   */
  async startRun(config: RunConfig, opts: RunnerOptions = {}): Promise<RunSummary> {
    const t0 = Date.now();

    // Stage 1 — resolve strategy.
    const strategy = STRATEGIES[config.strategy];
    if (!strategy) throw new Error(`Unknown strategy: ${config.strategy}`);

    // Stage 2 — load dataset from disk + prime the mock (no-op for real adapter).
    const manifest = await loadDataset();
    mockLLMAdapter.loadDataset(manifest.cases);

    // Stage 3 — bootstrap dataset rows + prompt template (idempotent).
    await this.bootstrapDataset(manifest);
    const promptHash: Sha256Hex = strategy.promptHash();
    const toolsHash: Sha256Hex  = sha256(canonicalJson([EXTRACT_CLINICAL_TOOL]));
    const schemaHash: Sha256Hex = sha256(canonicalJson(EXTRACT_CLINICAL_INPUT_SCHEMA));

    await this.prompts.upsert({
      prompt_hash:      promptHash,
      strategy_name:    strategy.name,
      template_body:    "see strategies/zero-shot.ts SYSTEM_BODY",
      tools_hash:       toolsHash,
      tool_definitions: [EXTRACT_CLINICAL_TOOL],
      schema_hash:      schemaHash,
    });

    // Stage 4 — filter cases.
    const filtered = config.case_filter
      ? manifest.cases.filter((c) => config.case_filter!.includes(c.case_id))
      : manifest.cases;

    if (filtered.length === 0) {
      throw new Error("RunnerService.startRun: empty case set after filter");
    }

    // Stage 5 — compute config_hash + create the run row.
    const configHash: Sha256Hex = sha256(canonicalJson({
      ...config,
      prompt_hash:  promptHash,
      tools_hash:   toolsHash,
      schema_hash:  schemaHash,
      dataset_hash: manifest.dataset_hash,
      case_count:   filtered.length,
    }));

    const runId = newRunId();
    await this.runs.create({
      run_id:         runId,
      status:         "queued",
      config,
      prompt_hash:    promptHash,
      tools_hash:     toolsHash,
      schema_hash:    schemaHash,
      dataset_hash:   manifest.dataset_hash,
      config_hash:    configHash,
      started_at:     new Date().toISOString(),
      completed_at:   null,
      cancelled_at:   null,
      duration_ms:    null,
      case_count:     filtered.length,
      case_completed: 0,
      case_succeeded: 0,
      case_failed:    0,
      case_in_flight: 0,
      total_usage:    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      total_cost:     { total_usd: 0, input_usd: 0, output_usd: 0, cache_creation_usd: 0, cache_read_usd: 0 },
    });

    // Stage 6 — drive the run.
    await this.processRun(runId, strategy, promptHash, toolsHash, filtered, opts);

    const r = await this.runs.findById(runId);
    if (!r) throw new Error("RunnerService.startRun: run vanished");
    return this.buildSummary(runId, r, Date.now() - t0);
  }

  /**
   * Resume a previously-started run — re-process only cases that aren't
   * already terminal in `evaluations`. Cross-attempt idempotency in
   * ExtractorService prevents double-charging on attempts that did succeed
   * but didn't make it into `evaluations` before the crash.
   */
  async resumeRun(runId: RunId, opts: RunnerOptions = {}): Promise<RunSummary> {
    const t0  = Date.now();
    const run = await this.runs.findById(runId);
    if (!run) throw new Error(`resumeRun: run ${runId} not found`);

    const strategy = STRATEGIES[run.config.strategy];
    if (!strategy) throw new Error(`resumeRun: unknown strategy ${run.config.strategy}`);

    const manifest = await loadDataset();
    mockLLMAdapter.loadDataset(manifest.cases);

    const filtered = run.config.case_filter
      ? manifest.cases.filter((c) => run.config.case_filter!.includes(c.case_id))
      : manifest.cases;

    // Skip cases that already have a terminal `evaluations` row. These are the
    // only cases that produced a final outcome (success OR exhausted retries),
    // so re-processing them would either be a no-op (idempotency replay) or a
    // wasted second LLM spend on a case the user already paid for.
    const completed = await this.evalRepo.completedCaseIds(runId);
    const remaining = filtered.filter((c) => !completed.has(c.case_id));

    if (remaining.length === 0) {
      const r = await this.runs.findById(runId);
      return this.buildSummary(runId, r!, Date.now() - t0);
    }

    await this.processRun(runId, strategy, run.prompt_hash, run.tools_hash, remaining, opts);

    const r = await this.runs.findById(runId);
    return this.buildSummary(runId, r!, Date.now() - t0);
  }

  /**
   * Drive the case set: bounded-concurrency fan-out, each case its own
   * retry-with-feedback loop, 429s absorbed inside the adapter wrapper.
   */
  private async processRun(
    runId:      RunId,
    strategy:   IStrategy,
    promptHash: Sha256Hex,
    toolsHash:  Sha256Hex,
    cases:      DatasetManifest["cases"],
    opts:       RunnerOptions,
  ): Promise<void> {
    const t0 = Date.now();
    await this.runs.updateStatus(runId, "running");

    // Adapter is selected at processRun entry — env-flag gated. Mock by default.
    // Wrap once so every per-case call inherits the 429 handler.
    const baseAdapter = selectAdapter();
    const adapter     = withRateLimitRetry(baseAdapter);
    const extractor = new ExtractorService(adapter, strategy, this.attempts, {
      skipGrounding: opts.skipGrounding,
    });
    const evaluator = new EvaluatorService(ALL_SCORERS, this.evalRepo, this.scoreRepo);

    const limit = createLimiter(MAX_CONCURRENCY);

    await Promise.allSettled(
      cases.map((c) => limit(() => this.runOneCase(
        runId, strategy, promptHash, toolsHash, c, extractor, evaluator,
      ))),
    );

    await this.runs.markCompleted(runId, Date.now() - t0);
  }

  /** Per-case body — extracted so `processRun` can fan out via the limiter. */
  private async runOneCase(
    runId:      RunId,
    _strategy:  IStrategy,
    promptHash: Sha256Hex,
    toolsHash:  Sha256Hex,
    c:          DatasetManifest["cases"][number],
    extractor:  ExtractorService,
    evaluator:  EvaluatorService,
  ): Promise<void> {
    try {
      await this.runs.incrementCounters(runId, {
        completedDelta: 0, succeededDelta: 0, failedDelta: 0,
        inFlightDelta: 1,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0,
      });

      const totals = { in: 0, out: 0, cRead: 0, cCreate: 0, cost: 0 };
      let lastExt: ExtractOutput | null = null;
      let succeeded = false;
      let feedback: ValidationFeedback | null = null;

      for (let i: AttemptIdx = 1; i <= MAX_ATTEMPTS; i = ((i + 1) as AttemptIdx)) {
        const ext = await extractor.extract({
          run_id:        runId,
          case_id:       c.case_id,
          transcript:    c.transcript,
          prompt_hash:   promptHash,
          tools_hash:    toolsHash,
          attempt_idx:   i,
          prev_feedback: feedback,
        });

        lastExt = ext;
        totals.in      += ext.input_tokens;
        totals.out     += ext.output_tokens;
        totals.cRead   += ext.cache_read_tokens;
        totals.cCreate += ext.cache_creation_tokens;
        totals.cost    += ext.cost_total_usd;

        if (ext.status === "succeeded" && ext.predicted) {
          await evaluator.scoreCase({
            run_id:              runId,
            attempt_id:          ext.attempt_id,
            case_id:             c.case_id,
            predicted:           ext.predicted,
            gold:                c.gold,
            transcript:          c.transcript,
            schema_invalid:      false,
            hallucination_count: ext.validation.hallucination_count,
          });
          succeeded = true;
          break;
        }

        if (i < MAX_ATTEMPTS) {
          const sf = collectFeedback(ext.validation);
          feedback = toValidationFeedback(sf, ext.tool_use_id, ((i + 1) as AttemptIdx));
        }
      }

      if (!succeeded && lastExt) {
        const finalStatus =
          lastExt.status === "schema_invalid"   ? "failed_schema_unrecoverable"   :
          lastExt.status === "grounding_failed" ? "failed_grounding_unrecoverable":
                                                  "failed_mixed";

        await this.evalRepo.upsert({
          evaluation_id:        crypto.randomUUID(),
          run_id:               runId,
          case_id:              c.case_id,
          attempt_id:           lastExt.attempt_id,
          final_status:         finalStatus,
          termination_reason:   `max_attempts(${MAX_ATTEMPTS}) exhausted: last=${lastExt.status}`,
          weighted_aggregate:   null,
          unweighted_aggregate: null,
          schema_invalid:       lastExt.validation.schema_invalid,
          hallucination_count:  lastExt.validation.hallucination_count,
          grounded_field_rate:  null,
          duration_ms:          lastExt.duration_ms,
        });
      }

      await this.runs.incrementCounters(runId, {
        completedDelta:      1,
        succeededDelta:      succeeded ? 1 : 0,
        failedDelta:         succeeded ? 0 : 1,
        inFlightDelta:      -1,
        inputTokens:         totals.in,
        outputTokens:        totals.out,
        cacheCreationTokens: totals.cCreate,
        cacheReadTokens:     totals.cRead,
        costUsd:             totals.cost,
      });
    } catch (err) {
      console.error(`[runner] case ${c.case_id} threw:`, err);
      await this.runs.incrementCounters(runId, {
        completedDelta: 1, succeededDelta: 0, failedDelta: 1, inFlightDelta: -1,
        inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0,
      });
    }
  }

  private async buildSummary(
    runId: RunId,
    run: NonNullable<Awaited<ReturnType<RunRepository["findById"]>>>,
    durationMs: number,
  ): Promise<RunSummary> {
    return {
      run_id:             runId,
      case_count:         run.case_count,
      case_succeeded:     run.case_succeeded,
      case_failed:        run.case_failed,
      weighted_aggregate: await this.computeAverageWeighted(runId),
      total_cost_usd:     run.total_cost.total_usd,
      duration_ms:        durationMs,
    };
  }

  /** V1 — average `evaluations.weighted_aggregate` across succeeded cases. */
  private async computeAverageWeighted(runId: RunId): Promise<number> {
    const [row] = await db
      .select({
        avg: sql<string | null>`AVG(${evaluations.weightedAggregate})::text`,
      })
      .from(evaluations)
      .where(eq(evaluations.runId, runId));
    return row?.avg ? Number(row.avg) : 0;
  }

  private async bootstrapDataset(manifest: DatasetManifest): Promise<void> {
    await this.dataset.upsertDataset({
      version: {
        dataset_hash:   manifest.dataset_hash,
        schema_hash:    manifest.schema_hash,
        case_count:     manifest.case_count,
        manifest_jsonb: { case_count: manifest.case_count, cases: manifest.cases.map((c) => ({
          case_id: c.case_id, tokens: c.tokens, tags: c.tags,
        })) },
      },
      cases: manifest.cases.map((c) => ({
        case_id:      c.case_id,
        dataset_hash: manifest.dataset_hash,
        transcript:   c.transcript,
        tokens:       c.tokens,
        tags:         c.tags,
      })),
      gold: manifest.cases.map((c) => ({
        case_id:      c.case_id,
        dataset_hash: manifest.dataset_hash,
        gold_jsonb:   c.gold,
      })),
    });
  }
}
