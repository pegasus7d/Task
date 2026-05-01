// apps/web/src/app/page.tsx
//
// Runs list (root). Server Component — fetches GET /api/v1/runs at render
// time. Each row links to /runs/:id. Header includes a link to /compare and
// to /runs/new (start-run form).

import Link from "next/link";

import { api, type Run } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function RunsListPage() {
  let runs: Run[] = [];
  let error: string | null = null;
  try {
    const res = await api.listRuns();
    runs = res.runs;
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <main className="container mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">HEALOSBENCH — runs</h1>
        <nav className="flex gap-3 text-sm">
          <Link href="/runs/new" className="underline">+ new run</Link>
          <Link href="/compare" className="underline">compare runs</Link>
        </nav>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-50 dark:bg-red-950/30 p-3 text-sm">
          API error: {error}. Check the server is running on{" "}
          <code className="font-mono">localhost:8787</code>.
        </div>
      )}

      {runs.length === 0 && !error && (
        <p className="text-sm opacity-70">
          No runs yet. Start one via <Link href="/runs/new" className="underline">/runs/new</Link>{" "}
          or the CLI: <code className="font-mono">bun run eval -- --strategy=zero_shot</code>
        </p>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr className="border-b">
                <th className="px-3 py-2">started</th>
                <th className="px-3 py-2">strategy</th>
                <th className="px-3 py-2">status</th>
                <th className="px-3 py-2 text-right">cases</th>
                <th className="px-3 py-2 text-right">success / fail</th>
                <th className="px-3 py-2 text-right">cost</th>
                <th className="px-3 py-2">run_id</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-2 font-mono text-xs">{r.started_at.slice(0, 19).replace("T", " ")}</td>
                  <td className="px-3 py-2">{r.config.strategy}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-right">{r.case_count}</td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-green-700 dark:text-green-400">{r.case_succeeded}</span>
                    {" / "}
                    <span className="text-red-700 dark:text-red-400">{r.case_failed}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">${r.total_cost.total_usd.toFixed(4)}</td>
                  <td className="px-3 py-2">
                    <Link href={`/runs/${r.run_id}`} className="font-mono text-xs underline">
                      {r.run_id.slice(0, 8)}…
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: Run["status"] }) {
  const color =
    status === "completed" ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" :
    status === "running"   ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" :
    status === "failed"    ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" :
                              "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200";
  return <span className={`inline-block rounded px-2 py-0.5 text-xs ${color}`}>{status}</span>;
}
