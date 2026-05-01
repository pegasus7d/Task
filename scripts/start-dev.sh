#!/usr/bin/env bash
# scripts/start-dev.sh
#
# Boots both the Hono backend (:8787) and the Next.js UI (:3001) in parallel,
# tails logs, and shuts them both down cleanly on Ctrl+C.
#
# Usage:
#   ./scripts/start-dev.sh              # both servers + logs
#   ./scripts/start-dev.sh --no-open    # don't auto-open browser
#   ./scripts/start-dev.sh --kill-only  # just kill anything on :8787 / :3001 and exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
WEB_DIR="$ROOT/apps/web"
LOG_DIR="$ROOT/.dev-logs"

OPEN_BROWSER=1
KILL_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-open)   OPEN_BROWSER=0; shift ;;
    --kill-only) KILL_ONLY=1; shift ;;
    -h|--help)
      grep "^#" "$0" | head -12 | sed 's/^#//'
      exit 0
      ;;
    *) echo "✗ unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── Pretty logging ─────────────────────────────────────────────────────────
log()  { printf "\033[36m▶\033[0m  %s\n" "$*"; }
ok()   { printf "\033[32m✓\033[0m  %s\n" "$*"; }
warn() { printf "\033[33m⚠\033[0m  %s\n" "$*"; }
die()  { printf "\033[31m✗\033[0m  %s\n" "$*" >&2; exit 1; }

# ─── Kill anything currently bound to our ports ─────────────────────────────
kill_port () {
  local PORT="$1"
  local PIDS
  PIDS=$(lsof -ti ":$PORT" 2>/dev/null || true)
  if [[ -n "$PIDS" ]]; then
    log "Killing existing process on :$PORT (pids: $PIDS)"
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

kill_port 8787
kill_port 3001

if [[ "$KILL_ONLY" -eq 1 ]]; then
  ok "Ports 8787 + 3001 are clear. Exiting."
  exit 0
fi

# ─── Pre-flight ─────────────────────────────────────────────────────────────
[[ -d "$SERVER_DIR" ]] || die "Server dir not found: $SERVER_DIR"
[[ -d "$WEB_DIR"    ]] || die "Web dir not found:    $WEB_DIR"

# Postgres check (warn only — server will fail with a clearer error if down)
if ! docker compose -f "$ROOT/docker-compose.yml" ps 2>/dev/null | grep -q "healthy"; then
  warn "Postgres doesn't look healthy. Start it with:  docker compose up -d"
fi

mkdir -p "$LOG_DIR"
SERVER_LOG="$LOG_DIR/server.log"
WEB_LOG="$LOG_DIR/web.log"
: > "$SERVER_LOG"
: > "$WEB_LOG"

# ─── Trap: kill children on Ctrl+C / exit ───────────────────────────────────
SERVER_PID=""
WEB_PID=""
cleanup () {
  local code=$?
  echo
  log "Shutting down…"
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  # Final port-clear in case grandchildren survived.
  kill_port 8787
  kill_port 3001
  ok "Both servers stopped. Logs in $LOG_DIR/"
  exit $code
}
trap cleanup INT TERM EXIT

# ─── Start backend ──────────────────────────────────────────────────────────
log "Starting server  → $SERVER_LOG"
( cd "$SERVER_DIR" && bun run dev ) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# ─── Start frontend ─────────────────────────────────────────────────────────
log "Starting web     → $WEB_LOG"
( cd "$WEB_DIR" && bun run dev ) >"$WEB_LOG" 2>&1 &
WEB_PID=$!

# ─── Wait for both to be ready ──────────────────────────────────────────────
wait_for_port () {
  local NAME="$1" PORT="$2" TIMEOUT="${3:-60}"
  local i=0
  while ! nc -z localhost "$PORT" 2>/dev/null; do
    if [[ $i -ge $TIMEOUT ]]; then
      echo "─── tail of log ───"
      [[ "$NAME" == "server" ]] && tail -30 "$SERVER_LOG"
      [[ "$NAME" == "web"    ]] && tail -30 "$WEB_LOG"
      die "$NAME never came up on :$PORT after ${TIMEOUT}s"
    fi
    # Detect early crashes.
    if [[ "$NAME" == "server" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      tail -30 "$SERVER_LOG"; die "server crashed on startup"
    fi
    if [[ "$NAME" == "web" ]] && ! kill -0 "$WEB_PID" 2>/dev/null; then
      tail -30 "$WEB_LOG"; die "web crashed on startup"
    fi
    sleep 1
    i=$((i+1))
  done
  ok "$NAME ready on :$PORT"
}

wait_for_port server 8787 60
wait_for_port web    3001 90

# ─── Open browser ───────────────────────────────────────────────────────────
URL="http://localhost:3001"
if [[ "$OPEN_BROWSER" -eq 1 ]]; then
  if command -v open >/dev/null 2>&1;     then open "$URL" 2>/dev/null || true
  elif command -v xdg-open >/dev/null;    then xdg-open "$URL" 2>/dev/null || true
  fi
fi

# ─── Banner + tail logs ─────────────────────────────────────────────────────
cat <<INFO

─────────────────────────────────────────────────────────────────────────────
  ✓ both servers running
─────────────────────────────────────────────────────────────────────────────
  UI                http://localhost:3001
  Compare view      http://localhost:3001/compare
  Start a new run   http://localhost:3001/runs/new
  API               http://localhost:8787
  Health            http://localhost:8787/

  logs:
    server          tail -f $SERVER_LOG
    web             tail -f $WEB_LOG

  Ctrl+C to stop both.
─────────────────────────────────────────────────────────────────────────────

INFO

# Tail both logs in the foreground (interleaved) until Ctrl+C.
tail -f "$SERVER_LOG" "$WEB_LOG"
