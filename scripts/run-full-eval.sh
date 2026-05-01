#!/usr/bin/env bash
# scripts/run-full-eval.sh
#
# Runs all 3 strategies (zero_shot, few_shot, cot) on the full 50-case dataset
# against real Anthropic Haiku 4.5, then writes:
#   - results/run_<strategy>.json   (per-strategy summary + per-field means)
#   - results/summary.json           (cross-strategy table for NOTES.md)
#   - NOTES.md                       (submission deliverable, auto-generated)
#
# Pre-flight gates run first; the script exits on any failure with a clear
# message instead of burning $$$ on a misconfigured run.
#
# Usage:
#   ./scripts/run-full-eval.sh                  # full 50-case × 3 strategies
#   ./scripts/run-full-eval.sh --sample 5       # smaller sanity run
#   ./scripts/run-full-eval.sh --no-skip-grounding   # exercise grounding
#
# Estimated cost (full run): ~$0.30–0.60 depending on cache hit rate.
# Estimated time:            ~10 min sequential.

set -euo pipefail

# ─── Resolve project root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER="$ROOT/apps/server"
RESULTS="$ROOT/results"

# ─── Args ───────────────────────────────────────────────────────────────────
SAMPLE=""
SKIP_GROUNDING="--skip-grounding"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sample)
      shift
      SAMPLE="$1"
      shift
      ;;
    --no-skip-grounding)
      SKIP_GROUNDING=""
      shift
      ;;
    -h|--help)
      grep "^#" "$0" | head -30 | sed 's/^#//'
      exit 0
      ;;
    *)
      echo "✗ unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ─── Pretty logging ─────────────────────────────────────────────────────────
log()    { printf "\033[36m▶\033[0m  %s\n" "$*"; }
ok()     { printf "\033[32m✓\033[0m  %s\n" "$*"; }
warn()   { printf "\033[33m⚠\033[0m  %s\n" "$*"; }
die()    { printf "\033[31m✗\033[0m  %s\n" "$*" >&2; exit 1; }
step()   { printf "\n\033[1;35m═══ %s ═══\033[0m\n" "$*"; }

# ─── Step 0 — Pre-flight ────────────────────────────────────────────────────
step "Pre-flight"

# 0a. Postgres reachable?
log "Checking Postgres…"
if ! docker compose -f "$ROOT/docker-compose.yml" ps 2>/dev/null | grep -q "healthy"; then
  die "Postgres not running. Start it with:  docker compose up -d"
fi
ok "Postgres healthy"

# 0b. .env present + USE_ANTHROPIC=1?
ENV_FILE="$SERVER/.env"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Copy from .env.example."

if ! grep -qE "^USE_ANTHROPIC=1\s*$" "$ENV_FILE"; then
  die "USE_ANTHROPIC=1 not set in $ENV_FILE. Real Haiku won't be called.
       Edit that line, then re-run."
fi
ok "USE_ANTHROPIC=1"

# 0c. ANTHROPIC_API_KEY isn't a placeholder
if grep -qE "^ANTHROPIC_API_KEY=(sk-ant-api03-DUMMY|sk-ant-REPLACE_ME|.*PLACEHOLDER.*)" "$ENV_FILE"; then
  die "ANTHROPIC_API_KEY in $ENV_FILE looks like a placeholder.
       Paste a real key from https://console.anthropic.com/settings/keys"
fi
ok "ANTHROPIC_API_KEY shape OK"

# 0d. Tables migrated?
TABLE_COUNT=$(docker exec test-evals-postgres \
  psql -U postgres -d eval_db -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
  2>/dev/null | tr -d '[:space:]')
if [[ "${TABLE_COUNT:-0}" -lt 13 ]]; then
  die "Only $TABLE_COUNT tables in eval_db. Run:  bun run db:push  from the project root."
fi
ok "DB has $TABLE_COUNT tables"

# 0e. Smoke test — single case, ~$0.004
step "Smoke test (1 case)"
log "Running case_001 against real Haiku 4.5…"
cd "$SERVER"
SMOKE_OUTPUT=$(bun run eval -- --strategy=zero_shot --cases=case_001 $SKIP_GROUNDING 2>&1 || true)
if echo "$SMOKE_OUTPUT" | grep -q "succeeded           1"; then
  ok "Smoke OK — real adapter reachable, key valid, billing live"
elif echo "$SMOKE_OUTPUT" | grep -q "credit balance is too low"; then
  die "Anthropic account has \$0 credit. Top up at:
       https://console.anthropic.com/settings/billing"
else
  echo "$SMOKE_OUTPUT" | tail -20
  die "Smoke test failed (see output above)"
fi

# ─── Step 1 — Run all 3 strategies ──────────────────────────────────────────
mkdir -p "$RESULTS"

# bash 3.2 (macOS default) doesn't support `declare -A`, so use parallel
# vars per strategy. Setter writes RUN_ID_<STRAT>; getter reads via eval.
RUN_ID_zero_shot=""
RUN_ID_few_shot=""
RUN_ID_cot=""

run_strategy () {
  local STRAT="$1"
  step "Strategy: $STRAT"

  local CASE_FLAG=""
  if [[ -n "$SAMPLE" ]]; then
    # Build comma-separated list of the first $SAMPLE case IDs.
    local CASES
    CASES=$(ls "$ROOT/data/transcripts/" \
      | sed 's/\.txt$//' | head -n "$SAMPLE" | paste -sd, -)
    CASE_FLAG="--cases=$CASES"
    log "Sample mode: $SAMPLE cases ($CASES)"
  fi

  cd "$SERVER"
  log "Running…  bun run eval -- --strategy=$STRAT $CASE_FLAG $SKIP_GROUNDING"
  local OUT
  OUT=$(bun run eval -- --strategy="$STRAT" $CASE_FLAG $SKIP_GROUNDING 2>&1) || {
    echo "$OUT" | tail -30
    die "$STRAT run crashed (see above)"
  }
  echo "$OUT" | tail -12

  # Extract run_id from the printed summary.
  local RID
  RID=$(echo "$OUT" | grep -oE "run_id +[0-9a-f-]{36}" | awk '{print $2}' | tail -1)
  if [[ -z "$RID" ]]; then
    die "Could not parse run_id from $STRAT output"
  fi
  eval "RUN_ID_${STRAT}=\"$RID\""
  ok "$STRAT  run_id=$RID"
}

run_strategy "zero_shot"
run_strategy "few_shot"
run_strategy "cot"

# Snapshot for the rest of the script.
RID_ZERO="$RUN_ID_zero_shot"
RID_FEW="$RUN_ID_few_shot"
RID_COT="$RUN_ID_cot"

# ─── Step 2 — Pull aggregates from DB ───────────────────────────────────────
step "Aggregating results"

# Per-strategy summary table → results/summary.json
SUMMARY_SQL=$(cat <<SQL
SELECT json_agg(t) FROM (
  SELECT
    r.run_id::text                       AS run_id,
    r.config_jsonb->>'strategy'                AS strategy,
    r.case_count                         AS n,
    r.case_succeeded                     AS succeeded,
    r.case_failed                        AS failed,
    ROUND(AVG(e.weighted_aggregate)::numeric, 4)::float8  AS weighted_f1,
    ROUND(r.total_cost_usd::numeric, 6)::float8           AS cost_usd,
    ROUND((r.duration_ms / 1000.0)::numeric, 1)::float8   AS sec,
    r.total_cache_read_tokens                              AS cache_read_tok,
    r.total_cache_creation_tokens                          AS cache_create_tok
  FROM runs r
  LEFT JOIN evaluations e ON e.run_id = r.run_id
  WHERE r.run_id IN ('$RID_ZERO', '$RID_FEW', '$RID_COT')
  GROUP BY r.run_id
  ORDER BY r.started_at
) t;
SQL
)

docker exec test-evals-postgres psql -U postgres -d eval_db -tAc "$SUMMARY_SQL" \
  > "$RESULTS/summary.json"
ok "Wrote $RESULTS/summary.json"

# Per-strategy run dump → results/run_<strategy>.json
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

# ─── Step 3 — Generate NOTES.md ─────────────────────────────────────────────
step "Generating NOTES.md"

NOTES="$ROOT/NOTES.md"
TS=$(date +"%Y-%m-%d %H:%M %Z")

# Pull per-field × strategy means for the markdown table.
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

# Headline numbers
read -r ZS_F1 ZS_COST ZS_SEC <<<"$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF' ' -c \
  "SELECT ROUND(AVG(e.weighted_aggregate)::numeric,4), ROUND(r.total_cost_usd::numeric,4), ROUND((r.duration_ms/1000.0)::numeric,1) FROM runs r LEFT JOIN evaluations e ON e.run_id=r.run_id WHERE r.run_id='$RID_ZERO' GROUP BY r.run_id;")"
read -r FS_F1 FS_COST FS_SEC <<<"$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF' ' -c \
  "SELECT ROUND(AVG(e.weighted_aggregate)::numeric,4), ROUND(r.total_cost_usd::numeric,4), ROUND((r.duration_ms/1000.0)::numeric,1) FROM runs r LEFT JOIN evaluations e ON e.run_id=r.run_id WHERE r.run_id='$RID_FEW' GROUP BY r.run_id;")"
read -r CT_F1 CT_COST CT_SEC <<<"$(docker exec test-evals-postgres psql -U postgres -d eval_db -tAF' ' -c \
  "SELECT ROUND(AVG(e.weighted_aggregate)::numeric,4), ROUND(r.total_cost_usd::numeric,4), ROUND((r.duration_ms/1000.0)::numeric,1) FROM runs r LEFT JOIN evaluations e ON e.run_id=r.run_id WHERE r.run_id='$RID_COT' GROUP BY r.run_id;")"

cat > "$NOTES" <<MD
# HEALOSBENCH — submission notes

> Auto-generated by \`scripts/run-full-eval.sh\` on ${TS}.

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
- **Grounding**: $([ -z "$SKIP_GROUNDING" ] && echo "enabled (substring Tier-1)" || echo "skipped (substring would false-positive on paraphrase)")
- **Sample size**: $([ -z "$SAMPLE" ] && echo "all 50 cases" || echo "$SAMPLE cases (sample mode)")
- **Retry budget**: 3 attempts per case with structured feedback
- **Caching**: 1-hour TTL \`cache_control\` on tools + system + strategy suffix

## 4. What surprised you

(fill in by hand — TODO)

## 5. What you would build next

- **Tier-2 grounding** (fuzzy ±20-token window) so paraphrase isn't flagged as hallucination
- **Bootstrap CI** on per-field deltas in the compare view (currently threshold-based winners)
- **Real concurrency** (bottleneck @ 5 in-flight + ramp-up) — V2 is sequential
- **POST /runs/:id/resume** endpoint (idempotency replay already works)
- **CoVe Strategy 4** — extract → independently verify per field → revise

## 6. What you cut

- SSE streaming + live progress UI (deferred — synchronous CLI run for V2)
- LLM-judge L2 scorers (out of scope for 50 cases — N too small)
- Few-shot retrieval (kNN exemplar selection) — overfit risk on 50-case dataset

## 7. Reproduction

\`\`\`bash
# 1. Postgres
docker compose up -d

# 2. Migrate schema
bun run db:push

# 3. Run all 3 strategies
./scripts/run-full-eval.sh

# 4. View results
ls results/
# - summary.json          cross-strategy table
# - run_zero_shot.json    per-field means + failure breakdown
# - run_few_shot.json
# - run_cot.json

# 5. Compare in the UI
# (in two separate terminals)
cd apps/server && bun run dev      # :8787
cd apps/web    && bun run dev      # :3001
# open http://localhost:3001/compare
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

# ─── Step 4 — Cost summary ──────────────────────────────────────────────────
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
echo
echo "  next steps:"
echo "    • Edit NOTES.md §4 (\"What surprised you\") by hand"
echo "    • View results in the UI: http://localhost:3001/compare"
echo "    • Optionally flip USE_ANTHROPIC=0 to stop accidental spend"
