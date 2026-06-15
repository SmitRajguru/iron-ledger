#!/usr/bin/env bash
# Run the Iron Ledger server in the FOREGROUND, on demand. Ctrl-C to stop.
# Reads WT_HOST/WT_PORT from server/.env (env var > .env > default); the rest of
# the config (WT_SECRET, WT_DATA_DIR, WT_COOKIE_SECURE, …) is loaded from
# server/.env by the app itself. No systemd, no background process.
#
#   ./scripts/serve.sh            # listen per server/.env (default 127.0.0.1:8000)
#   WT_HOST=0.0.0.0 ./scripts/serve.sh   # one-off override for LAN access
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
ENV_FILE="$SERVER_DIR/.env"

env_or() { # env var wins, else server/.env, else default
  local cur="${!1:-}"
  if [ -z "$cur" ] && [ -f "$ENV_FILE" ]; then
    cur="$(grep -E "^$1=.+" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${cur:-$2}"
}

HOST="$(env_or WT_HOST 127.0.0.1)"
PORT="$(env_or WT_PORT 8000)"
echo "Iron Ledger -> http://$HOST:$PORT   (Ctrl-C to stop)"
cd "$SERVER_DIR"
# exec so Ctrl-C goes straight to uvicorn and the process exits cleanly.
exec uv run uvicorn app.main:app --host "$HOST" --port "$PORT" --workers 1
