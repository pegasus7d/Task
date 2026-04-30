#!/usr/bin/env bash
#
# scripts/db.sh — local Postgres helper
#
# Wraps docker-compose so you don't have to remember the commands.
# Persistent data lives in the named volume `postgres_data` (see docker-compose.yml).
# Run from anywhere — the script always works against test-evals/docker-compose.yml.
#
# Usage:
#   ./scripts/db.sh up        # start postgres in the background
#   ./scripts/db.sh down      # stop postgres (data is PRESERVED)
#   ./scripts/db.sh status    # show container + healthcheck state
#   ./scripts/db.sh logs      # tail postgres logs (Ctrl+C to exit)
#   ./scripts/db.sh psql      # open a psql shell inside the container
#   ./scripts/db.sh wait      # block until postgres is accepting connections
#   ./scripts/db.sh reset     # ⚠️  STOP postgres AND DELETE ALL DATA (volume drop)
#   ./scripts/db.sh push      # apply Drizzle schema (drizzle-kit push)
#   ./scripts/db.sh generate  # generate Drizzle migration SQL
#   ./scripts/db.sh migrate   # apply generated migrations
#   ./scripts/db.sh studio    # open Drizzle Studio in the browser

set -euo pipefail

# Always operate from the repo root (parent of this script's dir).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE="docker compose"
SERVICE="postgres"
DB_NAME="eval_db"
DB_USER="postgres"

color()  { printf "\033[%sm%s\033[0m" "$1" "$2"; }
green()  { color "1;32" "$1"; }
yellow() { color "1;33" "$1"; }
red()    { color "1;31" "$1"; }
blue()   { color "1;34" "$1"; }

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "$(red "✖ docker is not installed")" >&2
    exit 127
  fi
}

cmd_up() {
  require_docker
  echo "$(blue "→") starting postgres (data persisted in volume 'postgres_data')…"
  $COMPOSE up -d "$SERVICE"
  cmd_wait
  echo "$(green "✔ postgres ready") at postgresql://${DB_USER}:postgres@localhost:5433/${DB_NAME}"
}

cmd_down() {
  require_docker
  echo "$(blue "→") stopping postgres (data is PRESERVED in volume 'postgres_data')…"
  $COMPOSE down
  echo "$(green "✔ stopped") — run \`./scripts/db.sh up\` to resume."
}

cmd_status() {
  require_docker
  $COMPOSE ps
}

cmd_logs() {
  require_docker
  $COMPOSE logs -f "$SERVICE"
}

cmd_psql() {
  require_docker
  $COMPOSE exec "$SERVICE" psql -U "$DB_USER" -d "$DB_NAME"
}

cmd_wait() {
  require_docker
  echo -n "$(blue "→") waiting for postgres to accept connections"
  for _ in $(seq 1 60); do
    if $COMPOSE exec -T "$SERVICE" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      echo " $(green "ready")"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo " $(red "timeout")"
  return 1
}

cmd_reset() {
  require_docker
  echo "$(red "⚠  DESTRUCTIVE") — this will DELETE ALL DATA in the postgres_data volume."
  printf "Type 'yes' to continue: "
  read -r reply
  [ "$reply" = "yes" ] || { echo "aborted."; exit 1; }
  $COMPOSE down -v
  echo "$(green "✔ volume dropped.") run \`./scripts/db.sh up\` to start fresh."
}

cmd_push()     { (cd packages/db && bun run db:push); }
cmd_generate() { (cd packages/db && bun run db:generate); }
cmd_migrate()  { (cd packages/db && bun run db:migrate); }
cmd_studio()   { (cd packages/db && bun run db:studio); }

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  up)        cmd_up        ;;
  down)      cmd_down      ;;
  status)    cmd_status    ;;
  logs)      cmd_logs      ;;
  psql)     cmd_psql      ;;
  wait)      cmd_wait      ;;
  reset)     cmd_reset     ;;
  push)      cmd_push      ;;
  generate)  cmd_generate  ;;
  migrate)   cmd_migrate   ;;
  studio)    cmd_studio    ;;
  ""|-h|--help|help) usage ;;
  *) echo "$(red "✖ unknown command: $1")"; echo; usage; exit 2 ;;
esac
