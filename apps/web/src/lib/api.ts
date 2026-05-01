// apps/web/src/lib/api.ts
//
// Thin typed fetch helpers for the eval-harness backend. Server Components
// use these directly during render; Client Components import as needed.
//
// Response shapes derived 1:1 from apps/server/src/api/runs.ts and the
// service return types it composes (RunRepository.list, AttemptRepository
// .listForRun, CompareService.compare, DatasetRepository.getCaseDetail).

// Server URL — matches packages/env/src/web.ts schema (NEXT_PUBLIC_SERVER_URL).
// Falls back to localhost:8787 so the UI works in dev without an .env.
const API_BASE =
  process.env.NEXT_PUBLIC_SERVER_URL
  ?? process.env.NEXT_PUBLIC_API_URL
  ?? "http://localhost:8787";

// ─── Domain shapes (mirrors of contracts.md / repos) ───────────────────────

export type RunStatus =
  | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface Cost {
  total_usd: number;
  input_usd: number;
  output_usd: number;
  cache_creation_usd: number;
  cache_read_usd: number;
}

export interface RunConfig {
  strategy: string;
  model: string;
  case_filter?: string[] | null;
  force?: boolean;
  cost_cap_usd?: number;
  max_attempts?: 1 | 2 | 3;
  temperature?: number;
  max_tokens?: number;
  cache_ttl?: "5m" | "1h";
}

export interface Run {
  run_id: string;
  status: RunStatus;
  config: RunConfig;
  prompt_hash: string;
  tools_hash: string;
  schema_hash: string;
  dataset_hash: string;
  config_hash: string;
  started_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  duration_ms: number | null;
  case_count: number;
  case_completed: number;
  case_succeeded: number;
  case_failed: number;
  case_in_flight: number;
  total_usage: TokenUsage;
  total_cost: Cost;
  notes?: string;
}

export type AttemptStatus =
  | "queued" | "in_flight" | "succeeded" | "schema_invalid"
  | "grounding_failed" | "feedback_retry" | "rate_limited"
  | "overloaded" | "failed_terminal";

export interface Attempt {
  schema_version: 1;
  attempt_id: string;
  run_id: string;
  case_id: string;
  attempt_idx: 1 | 2 | 3;
  status: AttemptStatus;
  strategy: string;
  model: string;
  prompt_hash: string;
  idempotency_key: string;
  anthropic_request_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  predicted_json: Record<string, unknown> | null;
  raw_response_path: string | null;
  validation_result: Record<string, unknown> | null;
  retry_reason: string | null;
  usage: TokenUsage;
  cost: Cost;
}

export interface ScoreRow {
  scorer_name: string;
  scorer_version: number;
  category: string;
  field_path: string;
  value: number;
  weight: number;
  metadata: unknown;
}

export interface CaseDetail {
  case_id: string;
  transcript: string;
  gold: Record<string, unknown>;
  attempts: Attempt[];
  scores: ScoreRow[];
}

export interface FieldDelta {
  field_path: string;
  a: number | null;
  b: number | null;
  delta: number;
  winner: "a" | "b" | "tie";
  sample_size: number;
}

export interface CaseDelta {
  case_id: string;
  a: number | null;
  b: number | null;
  delta: number;
  a_status: string;
  b_status: string;
}

export interface CompareResponse {
  run_a: Run;
  run_b: Run;
  dataset_hash_match: boolean;
  aggregate_delta: {
    weighted: number;
    cost: number;
    duration_ms: number | null;
  };
  per_field_delta: FieldDelta[];
  case_buckets: {
    improved: CaseDelta[];
    regressed: CaseDelta[];
    unchanged: CaseDelta[];
  };
  hallucination_delta: { a: number; b: number };
  schema_invalid_delta: { a: number; b: number };
  overall_winner: "a" | "b" | "tie";
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
    throw new Error(`API ${res.status} on ${path}: ${detail}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listRuns: () =>
    fetchJson<{ runs: Run[]; next_cursor: string | null }>("/api/v1/runs"),

  getRun: (id: string) =>
    fetchJson<{ run: Run; attempts: Attempt[] }>(`/api/v1/runs/${id}`),

  getCase: (runId: string, caseId: string) =>
    fetchJson<CaseDetail>(`/api/v1/runs/${runId}/cases/${caseId}`),

  compare: (a: string, b: string) =>
    fetchJson<CompareResponse>(`/api/v1/runs/compare?a=${a}&b=${b}`),

  startRun: (body: {
    strategy: "zero_shot" | "few_shot" | "cot";
    model?: string;
    case_filter?: string[];
    skip_grounding?: boolean;
  }) =>
    fetchJson<{ run_id: string; status: string; summary: unknown; stream_url: string }>(
      "/api/v1/runs",
      { method: "POST", body: JSON.stringify(body) },
    ),
};
