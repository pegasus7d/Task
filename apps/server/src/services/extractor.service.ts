// apps/server/src/services/extractor.service.ts
//
// V2 — single-attempt extractor. Caller (RunnerService) owns the retry loop
// and supplies attempt_idx + optional prev_feedback. Persists exactly ONE row
// to `attempts` per call.

import {
  AttemptRepository,
  type AttemptId,
  type CaseId,
  type RunId,
  type Sha256Hex,
  type StrategyName,
} from "@test-evals/db/repositories";

import type { ClinicalExtraction } from "../data/clinical-schema";
import type { ILLMAdapter, IStrategy } from "../llm/types";
import { runValidatorChain, type ChainOptions } from "../validators/chain";
import type { ValidationResult } from "../validators/types";
import type { ValidationFeedback, AttemptIdx } from "../validators/feedback";
import { computeIdempotencyKey } from "../utils/hash";
import { newAttemptId } from "../utils/ids";

export interface ExtractInput {
  run_id:        RunId;
  case_id:       CaseId;
  transcript:    string;
  prompt_hash:   Sha256Hex;
  tools_hash:    Sha256Hex;
  /** V2: required so each attempt has a unique idempotency_key. */
  attempt_idx:   AttemptIdx;
  /** V2: optional — present on attempts 2+ to drive the LLM to self-correct. */
  prev_feedback?: ValidationFeedback | null;
}

export interface ExtractOutput {
  attempt_id:          AttemptId;
  attempt_idx:         AttemptIdx;
  predicted:           ClinicalExtraction | null;
  validation:          ValidationResult;
  status:              "succeeded" | "schema_invalid" | "grounding_failed" | "failed_terminal";
  /** V2: needed by Runner to build feedback for the next attempt. */
  tool_use_id:         string;
  duration_ms:         number;
  input_tokens:        number;
  output_tokens:       number;
  cache_creation_tokens: number;
  cache_read_tokens:   number;
  cost_total_usd:      number;
}

export class ExtractorService {
  constructor(
    private readonly adapter:    ILLMAdapter,
    private readonly strategy:   IStrategy,
    private readonly attempts:   AttemptRepository,
    private readonly chainOpts:  ChainOptions = {},
  ) {}

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const attemptId  = newAttemptId();
    const startedAt  = new Date();
    const t0         = Date.now();

    const messages = this.strategy.buildMessages({
      transcriptId: input.case_id,
      transcript:   input.transcript,
      attemptIdx:   input.attempt_idx,
      prevFeedback: input.prev_feedback ?? null,
    });

    const idempotencyKey: Sha256Hex = computeIdempotencyKey({
      run_id:      input.run_id,
      model:       "claude-haiku-4-5-20251001" as const,
      prompt_hash: input.prompt_hash,
      tools_hash:  input.tools_hash,
      temperature: messages.temperature,
      max_tokens:  messages.max_tokens,
      case_id:     input.case_id,
      attempt_idx: input.attempt_idx,
    });

    // Stage 0 — idempotency pre-flight: if a prior attempt with this exact
    // (model, prompt_hash, tools_hash, sampling, case_id, attempt_idx) tuple
    // already succeeded, replay its stored response without calling the LLM.
    // This is what makes resume safe (no double-charge).
    const existing = await this.attempts.findByIdempotencyKey(idempotencyKey);
    if (existing && existing.status === "succeeded" && existing.predicted_json) {
      const cached = existing.predicted_json as unknown as ClinicalExtraction;
      const validation = runValidatorChain(cached, input.transcript, this.chainOpts);
      const status: ExtractOutput["status"] =
        validation.schema_invalid   ? "schema_invalid" :
        validation.grounding_failed ? "grounding_failed" :
                                      "succeeded";
      return {
        attempt_id:           existing.attempt_id,
        attempt_idx:          input.attempt_idx,
        predicted:            validation.schema_invalid ? null : cached,
        validation,
        status,
        tool_use_id:          existing.anthropic_request_id ?? "",
        duration_ms:          0,
        input_tokens:         existing.usage.input_tokens,
        output_tokens:        existing.usage.output_tokens,
        cache_creation_tokens: existing.usage.cache_creation_input_tokens,
        cache_read_tokens:    existing.usage.cache_read_input_tokens,
        cost_total_usd:       existing.cost.total_usd,
      };
    }

    // Stage 1 — write attempt row in `in_flight` so resume can find it later.
    await this.attempts.create({
      schema_version:       1,
      attempt_id:           attemptId,
      run_id:               input.run_id,
      case_id:              input.case_id,
      attempt_idx:          input.attempt_idx,
      status:               "in_flight",
      strategy:             this.strategy.name as StrategyName,
      model:                "claude-haiku-4-5-20251001" as const,
      prompt_hash:          input.prompt_hash,
      idempotency_key:      idempotencyKey,
      anthropic_request_id: null,
      started_at:           startedAt.toISOString(),
      completed_at:         null,
      duration_ms:          null,
      predicted_json:       null,
      raw_response_path:    null,
      validation_result:    null,
      retry_reason:         null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost:  { total_usd: 0, input_usd: 0, output_usd: 0, cache_creation_usd: 0, cache_read_usd: 0 },
    });

    // Stage 2 — call the adapter (mock or real).
    const callResult = await this.adapter.call(messages, input.case_id);

    // Stage 3 — validate.
    const validation = runValidatorChain(callResult.predicted, input.transcript, this.chainOpts);

    const status: ExtractOutput["status"] =
      validation.schema_invalid   ? "schema_invalid" :
      validation.grounding_failed ? "grounding_failed" :
                                    "succeeded";

    const completedAt = new Date();
    const durationMs  = Date.now() - t0;

    // Stage 4 — patch the row with the call results + validation + final status.
    await this.attempts.update(attemptId, {
      status,
      completed_at:         completedAt.toISOString(),
      duration_ms:          durationMs,
      anthropic_request_id: callResult.anthropic_request_id,
      predicted_json:       callResult.predicted as unknown as Record<string, unknown>,
      validation_result:    validation as unknown as Record<string, unknown>,
      retry_reason:         status === "succeeded" ? null : `attempt_${input.attempt_idx}_${status}`,
      usage: {
        input_tokens:                callResult.input_tokens,
        output_tokens:               callResult.output_tokens,
        cache_creation_input_tokens: callResult.cache_creation_input_tokens,
        cache_read_input_tokens:     callResult.cache_read_input_tokens,
      },
      cost: {
        total_usd:          callResult.cost_total_usd,
        input_usd:          0,
        output_usd:         0,
        cache_creation_usd: 0,
        cache_read_usd:     0,
      },
    });

    return {
      attempt_id:           attemptId,
      attempt_idx:          input.attempt_idx,
      predicted:            validation.schema_invalid ? null : callResult.predicted,
      validation,
      status,
      tool_use_id:          callResult.tool_use_id,
      duration_ms:          durationMs,
      input_tokens:         callResult.input_tokens,
      output_tokens:        callResult.output_tokens,
      cache_creation_tokens: callResult.cache_creation_input_tokens,
      cache_read_tokens:    callResult.cache_read_input_tokens,
      cost_total_usd:       callResult.cost_total_usd,
    };
  }
}
