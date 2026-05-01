// apps/server/src/llm/mock-adapter.ts
//
// V2 mock LLM adapter — returns the GOLD extraction for the requested case,
// shifted by one field to introduce realistic noise. Scripted-failure mode
// (V2.1) injects schema_invalid / grounding_failed responses ahead of the
// successful one so the retry loop is testable end-to-end.
//
// For production we replace this with a real AnthropicAdapter; the
// ILLMAdapter interface is the swap point.

import type { ClinicalExtraction } from "../data/clinical-schema";
import type { CaseRecord } from "../data/dataset-loader";
import { newId } from "../utils/ids";
import { RateLimitError, type AdapterCallResult, type ILLMAdapter, type MessagePayload } from "./types";

/** What kind of response the mock should return on a given call. */
export type ScriptedResponse =
  | { kind: "tool_use" }                                      // succeed (with noisify)
  | { kind: "schema_invalid" }                                // return malformed object
  | { kind: "grounding_failed" }                              // valid schema but contains a fabricated value
  | { kind: "throw"; message: string }                        // simulate adapter exception
  | { kind: "rate_limit_429"; retryAfterMs?: number };        // simulate Anthropic 429

/** Inject a small distortion vs. gold so scorers produce non-trivial deltas. */
function noisify(gold: ClinicalExtraction): ClinicalExtraction {
  return {
    ...gold,
    chief_complaint: gold.chief_complaint, // identical → fuzzy scorer = 1.0
    medications: gold.medications.map((m, i) => i === 0
      ? { ...m, frequency: normalizeFreq(m.frequency) }   // BID ↔ twice daily noise
      : m,
    ),
  };
}

function normalizeFreq(freq: string | null): string | null {
  if (!freq) return freq;
  const map: Record<string, string> = {
    "every 6 hours as needed": "q6h prn",
    "twice daily":             "BID",
    "once daily":              "QD",
    "three times daily":       "TID",
  };
  return map[freq.toLowerCase()] ?? freq;
}

/** Hard-shaped invalid: required fields missing → schema validator fails. */
function schemaInvalidPayload(): unknown {
  return { chief_complaint: "" };  // empty string + missing vitals/medications/etc.
}

/** Schema-valid but contains a fabricated medication name → grounding fails. */
function fabricatedPayload(gold: ClinicalExtraction): ClinicalExtraction {
  return {
    ...gold,
    medications: [
      { name: "ZZZ-not-in-transcript-fake-drug", dose: "10 mg", frequency: "BID", route: "PO" },
      ...gold.medications,
    ],
  };
}

export class MockLLMAdapter implements ILLMAdapter {
  readonly id = "mock";

  /** Index built from the dataset so .call() can resolve case_id → gold. */
  private readonly goldByCaseId = new Map<string, ClinicalExtraction>();

  /** Per-case scripted response queues consumed FIFO. Empty → falls back to "tool_use". */
  private readonly scripts = new Map<string, ScriptedResponse[]>();

  /** Records every call for assertion in tests. */
  readonly observed: Array<{ caseId: string; messageCount: number }> = [];

  /** Tracks prefix fingerprints we've seen — second sighting → simulate cache read. */
  private readonly seenPrefixes = new Set<string>();

  loadDataset(cases: CaseRecord[]): void {
    this.goldByCaseId.clear();
    for (const c of cases) this.goldByCaseId.set(c.case_id, c.gold);
  }

  /** Queue a sequence of scripted responses for `caseId`. Consumed in order. */
  script(caseId: string, responses: ScriptedResponse[]): void {
    this.scripts.set(caseId, [...responses]);
  }

  reset(): void {
    this.scripts.clear();
    this.observed.length = 0;
    this.seenPrefixes.clear();
  }

  /**
   * Reads the cached prefix fingerprint from the payload. We treat the
   * (system block + tools array) as the cache prefix and report cache
   * reads on the 2nd+ call with the same prefix — this mirrors how
   * Anthropic's cache_control breakpoint behaves at the prefix level.
   */
  private cacheReport(payload: MessagePayload): { read: number; create: number } {
    const hasCacheControl =
      payload.system.some((b) => b.type === "text" && b.cache_control != null) ||
      payload.tools.some((t)  => t.cache_control != null);
    if (!hasCacheControl) return { read: 0, create: 0 };

    const fingerprint = JSON.stringify({
      system: payload.system.map((b) => b.type === "text" ? b.text : ""),
      tools:  payload.tools.map((t) => ({ name: t.name, input_schema: t.input_schema })),
    });
    if (this.seenPrefixes.has(fingerprint)) {
      // Subsequent call → simulate cache read. ~95% of the input becomes cached.
      return { read: 1140, create: 0 };  // 1140 of 1200 input tokens
    }
    this.seenPrefixes.add(fingerprint);
    return { read: 0, create: 1140 };
  }

  async call(payload: MessagePayload, caseId: string): Promise<AdapterCallResult> {
    const gold = this.goldByCaseId.get(caseId);
    if (!gold) {
      throw new Error(`MockLLMAdapter: no gold loaded for case ${caseId}`);
    }
    this.observed.push({ caseId, messageCount: payload.messages.length });

    const queue = this.scripts.get(caseId) ?? [];
    const next: ScriptedResponse = queue.shift() ?? { kind: "tool_use" };
    if (queue.length === 0) this.scripts.delete(caseId);

    if (next.kind === "throw") {
      throw new Error(next.message);
    }
    if (next.kind === "rate_limit_429") {
      throw new RateLimitError(next.retryAfterMs ?? 50);   // 50ms default keeps tests fast
    }

    let predicted: ClinicalExtraction;
    if (next.kind === "schema_invalid") {
      predicted = schemaInvalidPayload() as ClinicalExtraction;
    } else if (next.kind === "grounding_failed") {
      predicted = fabricatedPayload(gold);
    } else {
      predicted = noisify(gold);
    }

    const { read, create } = this.cacheReport(payload);
    // Adjust uncached portion so totals reconcile with Anthropic semantics:
    // input_tokens is the UNCACHED slice; cached portions report separately.
    const uncachedInput = Math.max(0, 1200 - read - create);

    return {
      predicted,
      tool_use_id:                 `toolu_${newId()}`,
      anthropic_request_id:        `req_${newId()}`,
      input_tokens:                uncachedInput,
      output_tokens:                350,
      cache_creation_input_tokens: create,
      cache_read_input_tokens:     read,
      cost_total_usd:              0.0035,
    };
  }
}

export const mockLLMAdapter = new MockLLMAdapter();
