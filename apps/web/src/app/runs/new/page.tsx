"use client";

// apps/web/src/app/runs/new/page.tsx
//
// Tiny form to start a run via POST /api/v1/runs. V2 backend is synchronous,
// so the form blocks until the run completes — display the summary inline
// and link to the run detail page on success.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "@/lib/api";

type Strategy = "zero_shot" | "few_shot" | "cot";

export default function NewRunPage() {
  const router = useRouter();
  const [strategy,      setStrategy]      = useState<Strategy>("zero_shot");
  const [skipGrounding, setSkipGrounding] = useState(true);
  const [submitting,    setSubmitting]    = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.startRun({ strategy, skip_grounding: skipGrounding });
      router.push(`/runs/${res.run_id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Start a new run</h1>
        <Link href="/" className="text-sm underline">← all runs</Link>
      </header>

      <form onSubmit={onSubmit} className="space-y-4 rounded border p-4 text-sm">
        <label className="flex flex-col">
          <span className="text-xs uppercase tracking-wide opacity-60">strategy</span>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as Strategy)}
            className="mt-0.5 rounded border bg-background px-2 py-1.5"
            disabled={submitting}
          >
            <option value="zero_shot">zero_shot</option>
            <option value="few_shot">few_shot</option>
            <option value="cot">cot</option>
          </select>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={skipGrounding}
            onChange={(e) => setSkipGrounding(e.target.checked)}
            disabled={submitting}
          />
          <span>skip grounding (mock adapter returns paraphrased gold; substring grounding always trips)</span>
        </label>

        <p className="text-xs opacity-70">
          model: <code className="font-mono">claude-haiku-4-5-20251001</code>
          {" · "}
          adapter:{" "}
          <code className="font-mono">
            mock (set <span className="font-bold">USE_ANTHROPIC=1</span> to use the real adapter)
          </code>
        </p>

        <button
          type="submit"
          disabled={submitting}
          className="rounded border px-3 py-1.5 hover:bg-muted/40 disabled:opacity-50"
        >
          {submitting ? "running…" : "start run"}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded border border-red-500/40 bg-red-50 dark:bg-red-950/30 p-3 text-sm">
          {error}
        </div>
      )}
    </main>
  );
}
