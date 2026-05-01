// apps/server/src/utils/hash.ts
//
// sha256 helpers for content-addressing (entities.md §6 — the 5 hashes:
// prompt_hash, tools_hash, schema_hash, dataset_hash, config_hash).

import { createHash } from "node:crypto";
import type {
  AttemptIdx, CaseId, ModelId, RunId, Sha256Hex,
} from "@test-evals/db/repositories";

export function sha256(s: string): Sha256Hex {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable JSON: sorted keys at every level. Required for hash determinism. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function computeIdempotencyKey(parts: {
  /**
   * V1 includes run_id so re-runs don't collide on attempts_idempotency_key
   * UNIQUE. V2 removes it once `IdempotencyAdapter` (contracts §9.1) is in
   * place — runner-design.md §10.1 explicitly defers idempotency.
   */
  run_id:       RunId;
  model:        ModelId;
  prompt_hash:  Sha256Hex;
  tools_hash:   Sha256Hex;
  temperature:  number;
  max_tokens:   number;
  case_id:      CaseId;
  attempt_idx:  AttemptIdx;
}): Sha256Hex {
  return sha256([
    parts.run_id,
    parts.model, parts.prompt_hash, parts.tools_hash,
    parts.temperature.toFixed(6), String(parts.max_tokens),
    parts.case_id, String(parts.attempt_idx),
  ].join("|"));
}
