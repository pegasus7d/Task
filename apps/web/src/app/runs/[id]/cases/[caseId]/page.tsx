// apps/web/src/app/runs/[id]/cases/[caseId]/page.tsx
//
// Case detail. Renders:
//   - transcript (left panel)
//   - gold vs predicted JSON, side by side (the case-final attempt's predicted_json)
//   - per-field scores table (sorted by score, with weight)
//   - retry trace (each attempt's status + validation summary)

import Link from "next/link";
import { notFound } from "next/navigation";

import { api, type ScoreRow } from "@/lib/api";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ id: string; caseId: string }> }

export default async function CaseDetailPage({ params }: PageProps) {
  const { id: runId, caseId } = await params;

  let detail;
  try {
    detail = await api.getCase(runId, caseId);
  } catch (e) {
    if ((e as Error).message.includes("404")) notFound();
    throw e;
  }
  const { transcript, gold, attempts, scores } = detail;

  const finalAttempt = attempts[attempts.length - 1] ?? null;
  const predicted    = finalAttempt?.predicted_json ?? null;

  const sortedScores = [...scores].sort((a, b) => a.field_path.localeCompare(b.field_path));

  return (
    <main className="container mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6">
        <div className="text-sm">
          <Link href={`/runs/${runId}`} className="underline">← run detail</Link>
        </div>
        <h1 className="mt-2 text-xl font-semibold">
          {caseId} <span className="opacity-60 text-sm">in run {runId.slice(0, 8)}…</span>
        </h1>
      </header>

      {/* ── Transcript ───────────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">Transcript</h2>
        <pre className="whitespace-pre-wrap rounded border bg-muted/20 p-3 text-xs">
{transcript}
        </pre>
      </section>

      {/* ── Gold vs Predicted side-by-side ───────────────────────────────── */}
      <section className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
            Gold (ground truth)
          </h2>
          <pre className="overflow-auto rounded border bg-green-50/30 dark:bg-green-950/10 p-3 text-xs">
{JSON.stringify(gold, null, 2)}
          </pre>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
            Predicted (final attempt)
          </h2>
          {predicted ? (
            <pre className="overflow-auto rounded border bg-blue-50/30 dark:bg-blue-950/10 p-3 text-xs">
{JSON.stringify(predicted, null, 2)}
            </pre>
          ) : (
            <p className="rounded border p-3 text-xs opacity-70">
              No predicted JSON — final status: {finalAttempt?.status ?? "(no attempts)"}
            </p>
          )}
        </div>
      </section>

      {/* ── Per-field scores ─────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
          Per-field scores ({sortedScores.length})
        </h2>
        {sortedScores.length === 0 ? (
          <p className="text-sm opacity-70">
            No scores stored — case was a terminal failure (scores only land on success).
          </p>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr className="border-b">
                  <th className="px-3 py-2">field</th>
                  <th className="px-3 py-2">scorer</th>
                  <th className="px-3 py-2">category</th>
                  <th className="px-3 py-2 text-right">value</th>
                  <th className="px-3 py-2 text-right">weight</th>
                </tr>
              </thead>
              <tbody>
                {sortedScores.map((s) => (
                  <tr key={`${s.scorer_name}_v${s.scorer_version}_${s.field_path}`}
                      className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">{s.field_path}</td>
                    <td className="px-3 py-2">{s.scorer_name}<span className="opacity-50"> v{s.scorer_version}</span></td>
                    <td className="px-3 py-2"><span className="opacity-70">{s.category}</span></td>
                    <td className="px-3 py-2 text-right font-mono">
                      <ValueCell value={s.value} />
                    </td>
                    <td className="px-3 py-2 text-right opacity-70">{s.weight.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Retry trace ──────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
          Retry trace ({attempts.length} attempt{attempts.length === 1 ? "" : "s"})
        </h2>
        <ol className="space-y-2">
          {attempts.map((a) => {
            const v = a.validation_result as Record<string, unknown> | null;
            const errors = (v?.errors as Array<{ kind: string; field_path: string; message: string }> | undefined) ?? [];
            return (
              <li key={a.attempt_id} className="rounded border p-3 text-xs">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono">attempt {a.attempt_idx}</span>
                  <span className="opacity-70">·</span>
                  <span>{a.status}</span>
                  <span className="opacity-70">·</span>
                  <span>{a.duration_ms ?? 0} ms</span>
                  <span className="opacity-70">·</span>
                  <span className="font-mono">
                    cache_read {a.usage.cache_read_input_tokens} tok
                  </span>
                </div>
                {errors.length > 0 && (
                  <ul className="mt-2 ml-4 list-disc space-y-0.5">
                    {errors.slice(0, 6).map((e, i) => (
                      <li key={i}>
                        <code className="font-mono">{e.field_path}</code>
                        {" — "}
                        <span className="opacity-80">{e.kind}</span>
                        {": "}
                        {e.message}
                      </li>
                    ))}
                    {errors.length > 6 && <li className="opacity-60">… {errors.length - 6} more</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}

function ValueCell({ value }: { value: ScoreRow["value"] }) {
  const c =
    value >= 0.9 ? "text-green-700 dark:text-green-400" :
    value >= 0.5 ? "text-amber-700 dark:text-amber-300" :
                    "text-red-700 dark:text-red-400";
  return <span className={c}>{value.toFixed(3)}</span>;
}
