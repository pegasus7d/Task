// packages/db/src/repositories/db-errors.ts
//
// Maps `node-postgres` driver errors (attached as Drizzle's `error.cause`) to
// stable repository-level errors for callers (RunnerService, idempotency).

export class RepositoryConflictError extends Error {
  readonly pgCode = "23505" as const;
  constructor(message = "unique_violation") {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export class RepositoryForeignKeyError extends Error {
  readonly pgCode = "23503" as const;
  constructor(message = "foreign_key_violation") {
    super(message);
    this.name = "RepositoryForeignKeyError";
  }
}

function pgCodeFromUnknown(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const withCause = error as { cause?: unknown };
  const c = withCause.cause;
  if (c && typeof c === "object") {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const msg = error instanceof Error ? error.message : String(error);
  const m = msg.match(/\b(23505|23503)\b/);
  return m?.[1];
}

/** Re-throw as typed errors for 23505 / 23503; otherwise rethrow `error` unchanged. */
export function throwIfConstraintViolation(error: unknown): never {
  const code = pgCodeFromUnknown(error);
  if (code === "23505") throw new RepositoryConflictError();
  if (code === "23503") throw new RepositoryForeignKeyError();
  throw error;
}
