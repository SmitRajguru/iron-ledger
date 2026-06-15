#!/usr/bin/env bash
# Run the Iron Ledger server in the FOREGROUND, on demand. Ctrl-C to stop.
# Reads WT_HOST/WT_PORT from server/.env (env var > .env > default); the rest of
# the config (WT_SECRET, WT_DATA_DIR, WT_COOKIE_SECURE, …) is loaded from
# server/.env by the app itself. No systemd, no background process.
#
# Before starting, it checks whether an existing Iron Ledger server is already
# holding the port (the "address already in use" trap when a redeploy starts a
# second instance). If so it offers to stop the old one first. Non-interactive
# callers can pre-answer with WT_KILL_STALE=1 (kill) or leave it unset (abort).
#
#   ./scripts/serve.sh            # listen per server/.env (default 127.0.0.1:8000)
#   WT_HOST=0.0.0.0 ./scripts/serve.sh   # one-off override for LAN access
#   WT_KILL_STALE=1 ./scripts/serve.sh   # auto-stop a stale instance, no prompt
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
ENV_FILE="$SERVER_DIR/.env"

info() { printf '\033[1;34m[serve]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[serve]\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m[serve]\033[0m %s\n' "$1" >&2; }

env_or() { # env var wins, else server/.env, else default
  local cur="${!1:-}"
  if [ -z "$cur" ] && [ -f "$ENV_FILE" ]; then
    cur="$(grep -E "^$1=.+" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${cur:-$2}"
}

HOST="$(env_or WT_HOST 127.0.0.1)"
PORT="$(env_or WT_PORT 8000)"

# True if anything is LISTENing on $PORT (any interface). ss output puts the
# local address:port in a whitespace-bounded column, so ":<port> " matches.
port_busy() { ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; }

# PIDs LISTENing on $PORT specifically — parsed from `ss -ltnp` (same-user PIDs
# are shown without root). Scoping to the port is what keeps us from killing an
# Iron Ledger instance running on a DIFFERENT port. Empty if ss can't attribute a
# PID (e.g. the listener belongs to another user).
port_pids() {
  ss -ltnp 2>/dev/null \
    | awk -v port=":${PORT}" '$4 ~ port"$" { print }' \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

# Is PID our uvicorn (app.main:app)? Final guard so we only ever kill the port's
# holder when it's actually this app, never some unrelated listener.
is_our_server() {
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q "uvicorn app.main:app"
}

# If the port is taken by a previous Iron Ledger server, offer to stop it so the
# new build can bind. Refuse to kill a non-Iron-Ledger process on the port.
if command -v ss >/dev/null 2>&1 && port_busy; then
  pids=""
  for pid in $(port_pids); do
    is_our_server "$pid" && pids="${pids:+$pids }$pid"
  done
  if [ -z "$pids" ]; then
    err "Port $PORT is in use, but the listener is NOT an Iron Ledger server (or runs as another user) — refusing to kill it."
    err "  Inspect:  ss -ltnp | grep $PORT"
    exit 1
  fi
  # shellcheck disable=SC2086  # $pids is an intentional space-separated PID list
  warn "An Iron Ledger server is already running on port $PORT (PIDs: $pids)."
  # Decide whether to stop it: an explicit WT_KILL_STALE wins (so an UNATTENDED
  # caller — e.g. a tmux respawn pane nobody is watching — never blocks on a
  # prompt); else prompt when interactive; else abort rather than kill silently.
  ans="n"
  case "$(printf '%s' "${WT_KILL_STALE:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on)
      ans="y"; info "WT_KILL_STALE set — stopping the stale server without prompting." ;;
    *)
      if [ -t 0 ]; then
        read -r -p "$(printf '\033[1;33m[serve]\033[0m Stop it and start the new build? [y/N] ')" ans || ans="n"
      else
        err "Port $PORT in use and no tty to prompt — set WT_KILL_STALE=1 to auto-stop, or free it. Aborting."
        exit 1
      fi ;;
  esac
  case "$ans" in
    y | Y | yes | 1)
      info "Stopping old server (PIDs: $pids)…"
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do port_busy || break; sleep 1; done
      if port_busy; then
        warn "Old server still up after SIGTERM — sending SIGKILL."
        # shellcheck disable=SC2086
        kill -9 $pids 2>/dev/null || true
        for _ in 1 2 3; do port_busy || break; sleep 1; done
      fi
      port_busy && { err "Port $PORT still in use — aborting."; exit 1; }
      info "Old server stopped."
      ;;
    *)
      err "Port $PORT in use and not stopped — not starting. Free the port and retry."
      exit 1
      ;;
  esac
fi

echo "Iron Ledger -> http://$HOST:$PORT   (Ctrl-C to stop)"
cd "$SERVER_DIR"
# exec so Ctrl-C goes straight to uvicorn and the process exits cleanly.
exec uv run uvicorn app.main:app --host "$HOST" --port "$PORT" --workers 1
