"use client";

// apps/web/src/app/compare/page.tsx
//
// Compare two runs. Two dropdowns (loaded from /api/v1/runs) → fetches
// /api/v1/runs/compare on submit. Renders aggregate delta + per-field deltas
// (highlighting winner) + case bucketing.

import Link from "next/link";
import { useEffect, useState, useMemo } from "react";

import { api, type CompareResponse, type Run } from "@/lib/api";

export default function ComparePage() {
  const [runs,    setRuns]    = useState<Run[]>([]);
  const [a,       setA]       = useState("");
  const [b,       setB]       = useState("");
  const [data,    setData]    = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Load run list on mount.
  useEffect(() => {
    api.listRuns()
      .then((r) => setRuns(r.runs))
      .catch((e: unknown) => setError((e as Error).message));
  }, []);

  const selectableA = useMemo(() => runs.filter((r) => r.run_id !== b), [runs, b]);
  const selectableB = useMemo(() => runs.filter((r) => r.run_id !== a), [runs, a]);

  async function onCompare(e: React.FormEvent) {
    e.preventDefault();
    if (!a || !b) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await api.compare(a, b);
      setData(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Compare runs</h1>
        <Link href="/" className="text-sm underline">← all runs</Link>
      </header>

      {/* ── Selection form ─────────────────────────────────────────────── */}
      <form onSubmit={onCompare} className="mb-6 flex flex-wrap items-end gap-3 rounded border p-4 text-sm">
        <RunSelect label="Run A" value={a} onChange={setA} options={selectableA} />
        <RunSelect label="Run B" value={b} onChange={setB} options={selectableB} />
        <button
          type="submit"
          disabled={!a || !b || loading}
          className="rounded border px-3 py-1.5 hover:bg-muted/40 disabled:opacity-50"
        >
          {loading ? "comparing…" : "compare"}
        </button>
      </form>

      {error && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-50 dark:bg-red-950/30 p-3 text-sm">
          {error}
        </div>
      )}

      {!data && !loading && !error && (
        <p className="text-sm opacity-70">Pick two runs and click compare.</p>
      )}

      {data && <CompareView data={data} />}
    </main>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function RunSelect({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void; options: Run[];
}) {
  return (
    <label className="flex flex-col">
      <span className="text-xs uppercase tracking-wide opacity-60">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 min-w-[280px] rounded border bg-background px-2 py-1.5 text-sm"
      >
        <option value="">— select —</option>
        {options.map((r) => (
          <option key={r.run_id} value={r.run_id}>
            {r.config.strategy} · {r.run_id.slice(0, 8)}… · {r.case_succeeded}/{r.case_count} ok ·{" "}
            {r.started_at.slice(0, 19).replace("T", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompareView({ data }: { data: CompareResponse }) {
  return (
    <div className="space-y-6">
      {!data.dataset_hash_match && (
        <div className="rounded border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
          ⚠ Cross-dataset comparison — these runs were graded against different dataset versions.
        </div>
      )}

      {/* ── Aggregate header ───────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 rounded border p-4 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase tracking-wide opacity-60">Run A</div>
          <div className="mt-1 font-mono text-xs">{data.run_a.run_id.slice(0, 12)}…</div>
          <div className="text-sm">{data.run_a.config.strategy}</div>
        </div>
        <div className="text-center">
          <div className="text-xs uppercase tracking-wide opacity-60">Aggregate Δ (B − A)</div>
          <div className="mt-1 text-2xl font-semibold">
            <DeltaSpan v={data.aggregate_delta.weighted} />
          </div>
          <div className="mt-1 text-sm opacity-80">
            winner: <strong>{data.overall_winner}</strong>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide opacity-60">Run B</div>
          <div className="mt-1 font-mono text-xs">{data.run_b.run_id.slice(0, 12)}…</div>
          <div className="text-sm">{data.run_b.config.strategy}</div>
        </div>
      </section>

      {/* ── Per-field deltas ───────────────────────────────────────────── */}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">
          Per-field deltas
        </h2>
        {data.per_field_delta.length === 0 ? (
          <p className="text-sm opacity-70">No scores recorded for either run.</p>
        ) : (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr className="border-b">
                  <th className="px-3 py-2">field</th>
                  <th className="px-3 py-2 text-right">A</th>
                  <th className="px-3 py-2 text-right">B</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                  <th className="px-3 py-2">winner</th>
                  <th className="px-3 py-2 text-right">n</th>
                </tr>
              </thead>
              <tbody>
                {data.per_field_delta.map((f) => (
                  <tr key={f.field_path} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">{f.field_path}</td>
                    <td className="px-3 py-2 text-right font-mono">{f.a == null ? "—" : f.a.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono">{f.b == null ? "—" : f.b.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono"><DeltaSpan v={f.delta} /></td>
                    <td className="px-3 py-2"><WinnerBadge w={f.winner} /></td>
                    <td className="px-3 py-2 text-right opacity-70">{f.sample_size}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Case bucketing ─────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Bucket title="Improved (B > A)"  cases={data.case_buckets.improved}  color="green" />
        <Bucket title="Regressed (A > B)" cases={data.case_buckets.regressed} color="red"   />
        <Bucket title="Unchanged"          cases={data.case_buckets.unchanged} color="zinc"  />
      </section>

      {/* ── Failure / hallucination summary ────────────────────────────── */}
      <section className="grid grid-cols-2 gap-4 rounded border p-4 text-sm">
        <Field label="Hallucinations">
          A: {data.hallucination_delta.a} · B: {data.hallucination_delta.b}
        </Field>
        <Field label="Schema-invalid cases">
          A: {data.schema_invalid_delta.a} · B: {data.schema_invalid_delta.b}
        </Field>
      </section>
    </div>
  );
}

function Bucket({
  title, cases, color,
}: {
  title: string;
  cases: CompareResponse["case_buckets"]["improved"];
  color: "green" | "red" | "zinc";
}) {
  const head =
    color === "green" ? "text-green-700 dark:text-green-400" :
    color === "red"   ? "text-red-700 dark:text-red-400"     :
                         "text-zinc-700 dark:text-zinc-400";
  return (
    <div className="rounded border p-3">
      <div className={`mb-2 text-sm font-semibold ${head}`}>{title} ({cases.length})</div>
      {cases.length === 0 ? (
        <p className="text-xs opacity-70">none</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {cases.slice(0, 12).map((c) => (
            <li key={c.case_id} className="flex justify-between gap-2">
              <span className="font-mono">{c.case_id}</span>
              <span className="font-mono">
                {(c.a ?? 0).toFixed(2)} → {(c.b ?? 0).toFixed(2)}{" "}
                <DeltaSpan v={c.delta} />
              </span>
            </li>
          ))}
          {cases.length > 12 && (
            <li className="opacity-60">… {cases.length - 12} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function DeltaSpan({ v }: { v: number }) {
  if (Math.abs(v) < 1e-4) return <span className="opacity-60">0.000</span>;
  const c = v > 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400";
  return <span className={c}>{v >= 0 ? "+" : ""}{v.toFixed(3)}</span>;
}

function WinnerBadge({ w }: { w: "a" | "b" | "tie" }) {
  const color =
    w === "b" ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" :
    w === "a" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"         :
                 "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200";
  return <span className={`inline-block rounded px-2 py-0.5 text-xs ${color}`}>{w}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide opacity-60">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
