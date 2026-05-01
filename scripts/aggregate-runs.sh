#!/usr/bin/env bash
# scripts/aggregate-runs.sh
#
# Generate results/ + NOTES.md from 3 already-completed runs.
# Use this when run-full-eval.sh did the LLM work but the aggregation step
# crashed — saves you re-running the strategies (and re-burning $$$).
#
# Usage:
#   ./scripts/aggregate-runs.sh <zero_shot_run_id> <few_shot_run_id> <cot_run_id>
#
#   ./scripts/aggregate-runs.sh --latest    # auto-detect 3 most recent
#                                            # completed runs by strategy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS="$ROOT/results"

log()  { printf "\033[36m▶\033[0m  %s\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m  %s\n" "$*"; }
die()  { printf "\033[31m✗\033[0m  %s\n" "$*" >&2; exit 1; }
step() { printf "\n\033[1;35m═══ %s ═══\033[0m\n" "$*"; }

# ─── Pick run_ids ──────────────────────────────────────────────────────────
if [[ "${1:-}" == "--latest" ]]; then
  log "Auto-detecting 3 latest completed runs by strategy…"

  RID_ZERO=$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAc "
    SELECT run_id FROM runs
    WHERE config_jsonb->>'strategy' = 'zero_shot' AND status = 'completed'
    ORDER BY started_at DESC LIMIT 1;" | tr -d '[:space:]')
  RID_FEW=$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAc "
    SELECT run_id FROM runs
    WHERE config_jsonb->>'strategy' = 'few_shot' AND status = 'completed'
    ORDER BY started_at DESC LIMIT 1;" | tr -d '[:space:]')
  RID_COT=$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAc "
    SELECT run_id FROM runs
    WHERE config_jsonb->>'strategy' = 'cot' AND status = 'completed'
    ORDER BY started_at DESC LIMIT 1;" | tr -d '[:space:]')
elif [[ $# -ne 3 ]]; then
  die "Usage:  $0 <zero_shot_run_id> <few_shot_run_id> <cot_run_id>
        or  $0 --latest"
else
  RID_ZERO="$1"
  RID_FEW="$2"
  RID_COT="$3"
fi

[[ -n "${RID_ZERO:-}" ]] || die "could not resolve zero_shot run_id"
[[ -n "${RID_FEW:-}"  ]] || die "could not resolve few_shot run_id"
[[ -n "${RID_COT:-}"  ]] || die "could not resolve cot run_id"

log "zero_shot: $RID_ZERO"
log "few_shot:  $RID_FEW"
log "cot:       $RID_COT"

mkdir -p "$RESULTS"

# ─── summary.json ──────────────────────────────────────────────────────────
step "Aggregating results"

SUMMARY_SQL=$(cat <<SQL
SELECT json_agg(t) FROM (
  SELECT
    r.run_id::text                       AS run_id,
    r.config_jsonb->>'strategy'          AS strategy,
    r.case_count                         AS n,
    r.case_succeeded                     AS succeeded,
    r.case_failed                        AS failed,
    ROUND(AVG(e.weighted_aggregate)::numeric, 4)::float8  AS weighted_f1,
    ROUND(r.total_cost_usd::numeric, 6)::float8           AS cost_usd,
    ROUND((r.duration_ms / 1000.0)::numeric, 1)::float8   AS sec,
    r.total_cache_read_tokens             AS cache_read_tok,
    r.total_cache_creation_tokens         AS cache_create_tok
  FROM runs r
  LEFT JOIN evaluations e ON e.run_id = r.run_id
  WHERE r.run_id IN ('$RID_ZERO', '$RID_FEW', '$RID_COT')
  GROUP BY r.run_id
  ORDER BY r.started_at
) t;
SQL
)
docker exec test-evals-postgres psql -U postgres -d eval_db -tAc "$SUMMARY_SQL" \
  | python3 -m json.tool > "$RESULTS/summary.json"
ok "Wrote $RESULTS/summary.json"

# ─── per-strategy run dumps ────────────────────────────────────────────────
for STRAT in zero_shot few_shot cot; do
  case "$STRAT" in
    zero_shot) RID="$RID_ZERO" ;;
    few_shot)  RID="$RID_FEW"  ;;
    cot)       RID="$RID_COT"  ;;
  esac
  RUN_SQL=$(cat <<SQL
SELECT json_build_object(
  'run',       (SELECT to_json(r) FROM runs r WHERE r.run_id = '$RID'),
  'per_field', (
    SELECT json_agg(t) FROM (
      SELECT
        scorer_name,
        scorer_version,
        ROUND(AVG(value::numeric), 4)::float8 AS mean,
        COUNT(*)::int                         AS n
      FROM scores WHERE run_id = '$RID'
      GROUP BY scorer_name, scorer_version
      ORDER BY scorer_name
    ) t
  ),
  'failure_modes', (
    SELECT json_object_agg(final_status, n) FROM (
      SELECT final_status, COUNT(*)::int AS n
      FROM evaluations WHERE run_id = '$RID'
      GROUP BY final_status
    ) t
  )
);
SQL
)
  docker exec test-evals-postgres psql -U postgres -d eval_db -tAc "$RUN_SQL" \
    | python3 -m json.tool > "$RESULTS/run_${STRAT}.json"
  ok "Wrote $RESULTS/run_${STRAT}.json"
done

# ─── NOTES.md ──────────────────────────────────────────────────────────────
step "Generating NOTES.md"

NOTES="$ROOT/NOTES.md"
TS=$(date +"%Y-%m-%d %H:%M %Z")

PER_FIELD_SQL=$(cat <<SQL
SELECT
  s.scorer_name,
  ROUND(AVG(CASE WHEN r.run_id = '$RID_ZERO' THEN s.value::numeric END), 3)::float8 AS zero_shot,
  ROUND(AVG(CASE WHEN r.run_id = '$RID_FEW'  THEN s.value::numeric END), 3)::float8 AS few_shot,
  ROUND(AVG(CASE WHEN r.run_id = '$RID_COT'  THEN s.value::numeric END), 3)::float8 AS cot
FROM scores s JOIN runs r ON r.run_id = s.run_id
WHERE r.run_id IN ('$RID_ZERO', '$RID_FEW', '$RID_COT')
GROUP BY s.scorer_name
ORDER BY s.scorer_name;
SQL
)
PER_FIELD_TSV=$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF$'\t' -c "$PER_FIELD_SQL")

read -r ZS_F1 ZS_COST ZS_SEC <<<"$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF' ' -c \
  "SELECT ROUND(AVG(e.weighted_aggregate)::numeric,4), ROUND(r.total_cost_usd::numeric,4), ROUND((r.duration_ms/1000.0)::numeric,1) FROM runs r LEFT JOIN evaluations e ON e.run_id=r.run_id WHERE r.run_id='$RID_ZERO' GROUP BY r.run_id;")"
read -r FS_F1 FS_COST FS_SEC <<<"$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF' ' -c \
  "SELECT ROUND(AVG(e.weighted_aggregate)::numeric,4), ROUND(r.total_cost_usd::numeric,4), ROUND((r.duration_ms/1000.0)::numeric,1) FROM runs r LEFT JOIN evaluations e ON e.run_id=r.run_id WHERE r.run_id='$RID_FEW' GROUP BY r.run_id;")"
read -r CT_F1 CT_COST CT_SEC <<<"$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF' ' -c \
  "SELECT ROUND(AVG(e.weighted_aggregate)::numeric,4), ROUND(r.total_cost_usd::numeric,4), ROUND((r.duration_ms/1000.0)::numeric,1) FROM runs r LEFT JOIN evaluations e ON e.run_id=r.run_id WHERE r.run_id='$RID_COT' GROUP BY r.run_id;")"

cat > "$NOTES" <<MD
# HEALOSBENCH — submission notes

> Auto-generated by \`scripts/aggregate-runs.sh\` on ${TS}.

## 1. Per-strategy aggregate

| strategy   | weighted F1 | cost (USD) | duration | run_id |
|------------|------------:|-----------:|---------:|--------|
| zero_shot  | ${ZS_F1:-?}  | \$${ZS_COST:-?} | ${ZS_SEC:-?}s | \`$RID_ZERO\` |
| few_shot   | ${FS_F1:-?}  | \$${FS_COST:-?} | ${FS_SEC:-?}s | \`$RID_FEW\`  |
| cot        | ${CT_F1:-?}  | \$${CT_COST:-?} | ${CT_SEC:-?}s | \`$RID_COT\`  |

## 2. Per-field × strategy means

| scorer | zero_shot | few_shot | cot |
|--------|----------:|---------:|----:|
$(echo "$PER_FIELD_TSV" | awk -F'\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }')

## 3. Configuration

- **Model**: \`claude-haiku-4-5-20251001\`
- **Adapter**: real Anthropic SDK (\`USE_ANTHROPIC=1\`)
- **Grounding**: skipped during scoring (substring Tier-1 false-positives on paraphrase)
- **Sample size**: all 50 cases × 3 strategies = 150 case-runs
- **Retry budget**: 3 attempts per case with structured feedback
- **Caching**: 1-hour TTL \`cache_control\` on tools + system + strategy suffix

## 4. What surprised me

(fill in by hand — TODO)

Candidate observations to look at in the per-field table:
- which strategy wins on \`medications_set_f1\` (free-text drug names)?
- does \`cot\` actually beat \`zero_shot\` on \`diagnoses_set_f1\` (where the
  \`<thinking>\` block is supposed to help)?
- is \`few_shot\` surprisingly close to or behind \`zero_shot\` on \`vitals_*\`
  (numeric extraction is mostly format, not reasoning)?

## 5. What I would build next

- **Tier-2 grounding** (fuzzy ±20-token window) so paraphrase isn't flagged as hallucination
- **Bootstrap CI** on per-field deltas in the compare view (currently threshold-based winners)
- **Real concurrency** (bottleneck @ 5 in-flight + ramp-up) — V2 is sequential
- **POST /runs/:id/resume** endpoint (idempotency replay already works)
- **CoVe Strategy 4** — extract → independently verify per field → revise

## 6. What I cut

- SSE streaming + live progress UI (deferred — synchronous CLI run for V2)
- LLM-judge L2 scorers (out of scope for 50 cases — N too small)
- Few-shot retrieval (kNN exemplar selection) — overfit risk on 50-case dataset

## 7. Reproduction

\`\`\`bash
docker compose up -d
bun run db:push
./scripts/run-full-eval.sh
ls results/
\`\`\`

## 8. Test coverage

\`\`\`
57 tests across 3 files
└── apps/server/src/__tests__/
    ├── harness.test.ts       29 — V2 retry feedback + scorers + grounding ±
    ├── retry-loop.test.ts    10 — retry-with-feedback end-to-end + idempotency replay
    └── extended.test.ts      18 — 3 strategies + all 6 fields + caching visibility
\`\`\`

Run: \`cd apps/server && bun test\`

---

*results/run_*.json contain the full per-field score breakdowns + failure-mode counts. summary.json aggregates them for quick diff.*
MD

ok "Wrote $NOTES"

# ─── Cost summary ──────────────────────────────────────────────────────────
step "Done"
TOTAL_COST=$(echo "$ZS_COST + $FS_COST + $CT_COST" | bc -l 2>/dev/null || echo "?")
TOTAL_SEC=$(echo "$ZS_SEC + $FS_SEC + $CT_SEC" | bc -l 2>/dev/null || echo "?")
echo
echo "  zero_shot   F1=${ZS_F1:-?}   \$${ZS_COST:-?}   ${ZS_SEC:-?}s"
echo "  few_shot    F1=${FS_F1:-?}   \$${FS_COST:-?}   ${FS_SEC:-?}s"
echo "  cot         F1=${CT_F1:-?}   \$${CT_COST:-?}   ${CT_SEC:-?}s"
echo "  ─────────────────────────────────────────"
echo "  total spent ≈ \$${TOTAL_COST}   total time ≈ ${TOTAL_SEC}s"
echo
echo "  artifacts:"
echo "    $RESULTS/run_zero_shot.json"
echo "    $RESULTS/run_few_shot.json"
echo "    $RESULTS/run_cot.json"
echo "    $RESULTS/summary.json"
echo "    $NOTES"
