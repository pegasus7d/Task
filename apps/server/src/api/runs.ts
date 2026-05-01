// apps/server/src/api/runs.ts
//
// HTTP routes for run lifecycle. Synchronous V2 — startRun() blocks until the
// run completes (sequential per-case loop). When V3 lands the runner returns
// immediately and the client subscribes via SSE.

import { Hono } from "hono";
import { z } from "zod";

import {
  AttemptRepository,
  DatasetRepository,
  EvaluationRepository,
  PromptTemplateRepository,
  RunRepository,
  ScoreRepository,
  type RunConfig,
  type RunId,
} from "@test-evals/db/repositories";

import { RunnerService } from "../services/runner.service";
import { CompareService } from "../services/compare.service";

// ─── Repos (singletons — created once on module load) ──────────────────────

const runRepo      = new RunRepository();
const attemptRepo  = new AttemptRepository();
const datasetRepo  = new DatasetRepository();
const promptRepo   = new PromptTemplateRepository();
const evalRepo     = new EvaluationRepository();
const scoreRepo    = new ScoreRepository();

const runner = new RunnerService(
  runRepo, attemptRepo, datasetRepo, promptRepo, evalRepo, scoreRepo,
);
const compareSvc = new CompareService(runRepo);

// ─── Request validation ─────────────────────────────────────────────────────

const CreateRunBody = z.object({
  strategy:      z.enum(["zero_shot", "few_shot", "cot"]),
  model:         z.string().default("claude-haiku-4-5-20251001"),
  case_filter:   z.array(z.string()).optional().nullable(),
  force:         z.boolean().optional(),
  cost_cap_usd:  z.number().positive().optional(),
  max_attempts:  z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  temperature:   z.number().min(0).max(1).optional(),
  max_tokens:    z.number().int().positive().optional(),
  cache_ttl:     z.enum(["5m", "1h"]).optional(),
  notes:         z.string().optional(),
  /** V2 dev flag — bypass grounding (paraphrased gold + substring match always fails). */
  skip_grounding: z.boolean().optional(),
});

// ─── Router ─────────────────────────────────────────────────────────────────

export const runsRouter = new Hono();

/** POST /api/v1/runs — start (and synchronously drive) a new run. */
runsRouter.post("/", async (c) => {
  let body: z.infer<typeof CreateRunBody>;
  try {
    body = CreateRunBody.parse(await c.req.json());
  } catch (err) {
    return c.json(
      { type: "/errors/bad-request", title: "Invalid request body", status: 400, detail: String(err) },
      400,
    );
  }

  const config: RunConfig = {
    strategy:     body.strategy,
    model:        body.model as RunConfig["model"],
    case_filter:  body.case_filter ?? null,
    force:        body.force,
    cost_cap_usd: body.cost_cap_usd,
    max_attempts: body.max_attempts,
    temperature:  body.temperature,
    max_tokens:   body.max_tokens,
    cache_ttl:    body.cache_ttl,
  };

  try {
    const summary = await runner.startRun(config, { skipGrounding: body.skip_grounding });
    return c.json({
      run_id:     summary.run_id,
      status:     "completed",          // V2 is synchronous
      summary,
      stream_url: `/api/v1/runs/${summary.run_id}/stream`,  // not implemented in V2
    }, 202);
  } catch (err) {
    return c.json(
      { type: "/errors/internal", title: "Run failed", status: 500, detail: (err as Error).message },
      500,
    );
  }
});

/** GET /api/v1/runs — list all runs (latest first). */
runsRouter.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  const runs = await runRepo.list({ limit });
  return c.json({ runs, next_cursor: null });
});

/**
 * GET /api/v1/runs/compare?a=<runA>&b=<runB>
 *
 * Per-field deltas + per-case bucketing + winner. Backed by CompareService;
 * no re-scoring (reads `evaluations` + `scores` only).
 *
 * MUST be declared before /:id so Hono's router doesn't match "compare" as :id.
 */
runsRouter.get("/compare", async (c) => {
  const a = c.req.query("a") as RunId | undefined;
  const b = c.req.query("b") as RunId | undefined;
  if (!a || !b) {
    return c.json(
      { type: "/errors/bad-request", title: "Missing run id(s)", status: 400, detail: "a and b query params required" },
      400,
    );
  }
  if (a === b) {
    return c.json(
      { type: "/errors/bad-request", title: "Cannot compare a run with itself", status: 400, detail: a },
      400,
    );
  }

  try {
    const result = await compareSvc.compare(a, b);
    if (!result.dataset_hash_match && c.req.query("allow_cross_dataset") !== "true") {
      return c.json(
        {
          type:    "/errors/dataset-hash-mismatch",
          title:   "Cross-dataset compare blocked",
          status:  422,
          detail:  `run_a.dataset_hash=${result.run_a.dataset_hash} != run_b.dataset_hash=${result.run_b.dataset_hash}. Pass ?allow_cross_dataset=true to override.`,
        },
        422,
      );
    }
    return c.json(result);
  } catch (err) {
    return c.json(
      { type: "/errors/not-found", title: "Compare failed", status: 404, detail: (err as Error).message },
      404,
    );
  }
});

/**
 * POST /api/v1/runs/:id/resume
 *
 * Continue a previously-started run. Skips any case that already has a
 * terminal `evaluations` row. Idempotency replay (extractor.service.ts)
 * prevents double-charge if a successful attempt landed but the
 * `evaluations` row didn't make it before the crash.
 */
runsRouter.post("/:id/resume", async (c) => {
  const runId = c.req.param("id") as RunId;
  const existing = await runRepo.findById(runId);
  if (!existing) {
    return c.json(
      { type: "/errors/not-found", title: "Run not found", status: 404, detail: runId },
      404,
    );
  }
  try {
    const summary = await runner.resumeRun(runId);
    return c.json({ run_id: runId, status: "completed", summary }, 200);
  } catch (err) {
    return c.json(
      { type: "/errors/internal", title: "Resume failed", status: 500, detail: (err as Error).message },
      500,
    );
  }
});

/** GET /api/v1/runs/:id — single run + attempts list. */
runsRouter.get("/:id", async (c) => {
  const runId = c.req.param("id") as RunId;
  const run = await runRepo.findById(runId);
  if (!run) {
    return c.json(
      { type: "/errors/not-found", title: "Run not found", status: 404, detail: runId },
      404,
    );
  }
  const attempts = await attemptRepo.listForRun(runId);
  return c.json({ run, attempts });
});

/**
 * GET /api/v1/runs/:id/cases/:caseId
 * Returns transcript + gold + attempts (chronological) + per-case scores.
 * Powers the case-detail UI page.
 */
runsRouter.get("/:id/cases/:caseId", async (c) => {
  const runId  = c.req.param("id") as RunId;
  const caseId = c.req.param("caseId");

  const detail   = await datasetRepo.getCaseDetail(runId, caseId);
  if (!detail) {
    return c.json(
      { type: "/errors/not-found", title: "Case not found", status: 404, detail: `${runId}/${caseId}` },
      404,
    );
  }
  const attempts = await attemptRepo.listForCase(runId, caseId);
  return c.json({
    case_id:    caseId,
    transcript: detail.transcript,
    gold:       detail.gold,
    attempts,
    scores:     detail.scores,
  });
});
