// apps/server/src/validators/chain.ts
//
// Sequential validator pipeline. Schema first (fail-fast: grounding doesn't
// run if schema fails), then grounding. Errors are collected, never thrown.

import { groundingValidator } from "./grounding";
import { schemaValidator } from "./schema";
import type { ValidationResult } from "./types";

export interface ChainOptions {
  /**
   * Escape hatch — leave grounding off. Defaults to false now that the
   * grounding validator is fuzzy (Tier-2). The flag exists so the smoke
   * tests + idempotency probes can run in pure-schema mode if needed.
   */
  skipGrounding?: boolean;
}

export function runValidatorChain(
  predicted: unknown,
  transcript: string,
  opts: ChainOptions = {},
): ValidationResult {
  const start = Date.now();
  const merged: ValidationResult = {
    ok: true,
    errors: [],
    schema_invalid: false,
    grounding_failed: false,
    hallucination_count: 0,
    validators_run: [],
    duration_ms: 0,
  };

  const schemaRes = schemaValidator.validate(predicted, transcript);
  merged.errors.push(...schemaRes.errors);
  merged.schema_invalid = schemaRes.schema_invalid;
  merged.validators_run.push(...schemaRes.validators_run);

  if (!schemaRes.schema_invalid && !opts.skipGrounding) {
    const groundingRes = groundingValidator.validate(predicted, transcript);
    merged.errors.push(...groundingRes.errors);
    merged.grounding_failed     = groundingRes.grounding_failed;
    merged.hallucination_count += groundingRes.hallucination_count;
    merged.validators_run.push(...groundingRes.validators_run);
  }

  merged.ok          = merged.errors.length === 0;
  merged.duration_ms = Date.now() - start;
  return merged;
}
