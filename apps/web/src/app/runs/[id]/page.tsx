// apps/web/src/app/runs/[id]/page.tsx
//
// Run detail. Header summary + per-case row with link to the case-detail page
// (/runs/[id]/cases/[caseId]) where the user sees transcript + gold vs
// predicted JSON + per-field scores.

import Link from "next/link";
import { notFound } from "next/navigation";

import { api, type Attempt } from "@/lib/api";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ id: string }> }

export default async function RunDetailPage({ params }: PageProps) {
  const { id } = await params;

  let run, attempts;
  try {
    const res = await api.getRun(id);
    run      = res.run;
    attempts = res.attempts;
  } catch (e) {
    if ((e as Error).message.includes("404")) notFound();
    throw e;
  }

  // Group attempts by case_id, keep chronological order within a case.
  const byCase = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const arr = byCase.get(a.case_id) ?? [];
    arr.push(a);
    byCase.set(a.case_id, arr);
  }
  for (const arr of byCase.values()) {
    arr.sort((x, y) => x.attempt_idx - y.attempt_idx);
  }
  const cases = [...byCase.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <main className="container mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6">
        <div className="text-sm">
          <Link href="/" className="underline">← all runs</Link>
        </div>
        <h1 className="mt-2 text-xl font-semibold">Run {run.run_id.slice(0, 8)}…</h1>
      </header>

      <section className="mb-6 grid grid-cols-2 gap-4 rounded border p-4 text-sm sm:grid-cols-4">
        <Field label="strategy">{run.config.strategy}</Field>
        <Field label="model">{run.config.model}</Field>
        <Field label="status">{run.status}</Field>
        <Field label="started">{run.started_at.slice(0, 19).replace("T", " ")}</Field>
        <Field label="cases">{run.case_count}</Field>
        <Field label="succeeded / failed">
          <span className="text-green-700 dark:text-green-400">{run.case_succeeded}</span>
          {" / "}
          <span className="text-red-700 dark:text-red-400">{run.case_failed}</span>
        </Field>
        <Field label="duration">
          {run.duration_ms != null ? `${(run.duration_ms / 1000).toFixed(1)}s` : "—"}
        </Field>
        <Field label="total cost">${run.total_cost.total_usd.toFixed(4)}</Field>

        <Field label="prompt_hash">
          <code className="font-mono text-xs">{run.prompt_hash.slice(0, 12)}…</code>
        </Field>
        <Field label="dataset_hash">
          <code className="font-mono text-xs">{run.dataset_hash.slice(0, 12)}…</code>
        </Field>
        <Field label="cache reads">
          <code className="font-mono text-xs">
            {run.total_usage.cache_read_input_tokens.toLocaleString()} tok
          </code>
        </Field>
        <Field label="cache writes">
          <code className="font-mono text-xs">
            {run.total_usage.cache_creation_input_tokens.toLocaleString()} tok
          </code>
        </Field>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
          Cases ({cases.length})
        </h2>

        {cases.length === 0 && <p className="text-sm opacity-70">No attempts yet.</p>}

        {cases.length > 0 && (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr className="border-b">
                  <th className="px-3 py-2">case_id</th>
                  <th className="px-3 py-2">attempts</th>
                  <th className="px-3 py-2">final attempt status</th>
                  <th className="px-3 py-2 text-right">duration</th>
                  <th className="px-3 py-2 text-right">cost</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {cases.map(([caseId, group]) => {
                  const last = group[group.length - 1]!;
                  const totalCost = group.reduce((s, a) => s + a.cost.total_usd, 0);
                  const totalDur  = group.reduce((s, a) => s + (a.duration_ms ?? 0), 0);
                  return (
                    <tr key={caseId} className="border-b last:border-b-0 hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono">{caseId}</td>
                      <td className="px-3 py-2">{group.length}</td>
                      <td className="px-3 py-2">
                        <AttemptStatusBadge status={last.status} />
                      </td>
                      <td className="px-3 py-2 text-right">{totalDur.toLocaleString()}ms</td>
                      <td className="px-3 py-2 text-right font-mono">${totalCost.toFixed(4)}</td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/runs/${run.run_id}/cases/${caseId}`}
                          className="text-xs underline"
                        >
                          view →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide opacity-60">{label}</span>
      <span className="mt-0.5">{children}</span>
    </div>
  );
}

function AttemptStatusBadge({ status }: { status: Attempt["status"] }) {
  const color =
    status === "succeeded"      ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" :
    status === "schema_invalid" ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" :
    status === "grounding_failed" ? "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300" :
    status === "failed_terminal" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" :
                                    "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200";
  return <span className={`inline-block rounded px-2 py-0.5 text-xs ${color}`}>{status}</span>;
}
