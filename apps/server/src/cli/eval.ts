// apps/server/src/cli/eval.ts
//
// Usage:
//   bun run eval -- --strategy=zero_shot
//   bun run eval -- --strategy=zero_shot --cases=case_001,case_002
//
// V1 surface: just --strategy and --cases. More flags land in V2.

import "dotenv/config";

import {
  AttemptRepository,
  DatasetRepository,
  EvaluationRepository,
  PromptTemplateRepository,
  RunRepository,
  ScoreRepository,
  type RunConfig,
  type StrategyName,
} from "@test-evals/db/repositories";

import { RunnerService } from "../services/runner.service";

interface CliArgs {
  strategy:       StrategyName;
  cases?:         string[];
  skipGrounding:  boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let strategy: StrategyName | null = null;
  let cases: string[] | undefined;
  let skipGrounding = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--strategy=")) {
      strategy = arg.slice("--strategy=".length) as StrategyName;
    } else if (arg.startsWith("--cases=")) {
      cases = arg.slice("--cases=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--skip-grounding") {
      skipGrounding = true;
    }
  }

  if (!strategy) {
    console.error("usage: bun run eval -- --strategy=zero_shot [--cases=case_001,case_002] [--skip-grounding]");
    process.exit(2);
  }

  return { strategy, cases, skipGrounding };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const config: RunConfig = {
    strategy: args.strategy,
    model:    "claude-haiku-4-5-20251001",
    case_filter: args.cases ?? null,
  };

  const runner = new RunnerService(
    new RunRepository(),
    new AttemptRepository(),
    new DatasetRepository(),
    new PromptTemplateRepository(),
    new EvaluationRepository(),
    new ScoreRepository(),
  );

  console.log(`▶  starting run: strategy=${config.strategy} cases=${args.cases?.length ?? "all"}${args.skipGrounding ? " [skip-grounding]" : ""}`);
  const t0 = Date.now();

  try {
    const summary = await runner.startRun(config, { skipGrounding: args.skipGrounding });

    console.log("");
    console.log("════════════════════════════════════════════════");
    console.log("  RUN COMPLETED");
    console.log("════════════════════════════════════════════════");
    console.log(`  run_id              ${summary.run_id}`);
    console.log(`  cases               ${summary.case_count}`);
    console.log(`  succeeded           ${summary.case_succeeded}`);
    console.log(`  failed              ${summary.case_failed}`);
    console.log(`  weighted_aggregate  ${summary.weighted_aggregate.toFixed(4)}`);
    console.log(`  total_cost_usd      $${summary.total_cost_usd.toFixed(4)}`);
    console.log(`  duration            ${(Date.now() - t0) / 1000}s`);
    console.log("════════════════════════════════════════════════");
    console.log("  see scores in psql:");
    console.log(`    SELECT scorer_name, AVG(value::numeric)::numeric(6,4) AS mean`);
    console.log(`    FROM scores WHERE run_id = '${summary.run_id}'`);
    console.log(`    GROUP BY scorer_name ORDER BY scorer_name;`);
    console.log("");

    process.exit(summary.case_failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("✖ run failed:", err);
    process.exit(1);
  }
}

await main();
