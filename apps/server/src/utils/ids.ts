// apps/server/src/utils/ids.ts
//
// UUIDv7 generators — time-ordered IDs needed for SSE replay correctness
// (entities.md §5.5) and indexable per-attempt monotonicity.
//
// Bun has built-in `Bun.randomUUIDv7()`; fall back to crypto.randomUUID()
// (UUIDv4) if running under Node — only used in tests, never in prod code.

import type { AttemptId, RunId } from "@test-evals/db/repositories";

function uuidv7(): string {
  const g = globalThis as { Bun?: { randomUUIDv7?: () => string } };
  return g.Bun?.randomUUIDv7?.() ?? crypto.randomUUID();
}

export const newId         = (): string    => uuidv7();
export const newRunId      = (): RunId     => uuidv7() as RunId;
export const newAttemptId  = (): AttemptId => uuidv7() as AttemptId;
