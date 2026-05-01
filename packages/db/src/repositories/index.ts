// packages/db/src/repositories/index.ts
//
// Public surface of the repository layer. Re-exports the two repos in scope
// and the domain types they consume/produce.

export { RunRepository, type CounterDelta } from "./run-repo";
export { AttemptRepository } from "./attempt-repo";
export { DatasetRepository } from "./dataset-repo";
export { PromptTemplateRepository } from "./prompt-template-repo";
export { EvaluationRepository, type FinalStatus } from "./evaluation-repo";
export { ScoreRepository, type ScoreInput } from "./score-repo";

export {
  RepositoryConflictError,
  RepositoryForeignKeyError,
} from "./db-errors";

export type {
  // Branded primitives
  RunId,
  AttemptId,
  CaseId,
  StrategyName,
  ModelId,
  AttemptIdx,
  ISO8601,
  Sha256Hex,
  CostUSD,

  // Cost / usage primitives
  TokenUsage,
  Cost,

  // Run domain
  RunStatus,
  RunConfig,
  Run,

  // Attempt domain
  AttemptStatus,
  Attempt,
} from "./types";
