#!/usr/bin/env bash
# Iron Ledger — REMOTE redeploy: pull latest code, rebuild, restart the server.
#
# Run this ON THE DEPLOY BOX (the git clone the Cloudflare tunnel points at) after
# you've pushed changes from your dev machine. It is the "redeploy" half of the
# edit-here / sync-there loop:
#
#   dev box:    git push            (publish changes to origin — see README leak rules)
#   deploy box: ./scripts/redeploy.sh   (this script — pull + rebuild + restart)
#
# Steps:
#   1. Refuse to run on a dirty tree (the deploy box should track origin only).
#   2. git pull --ff-only.
#   3. ./run.sh — rebuild client/dist + uv sync + public-deps gate + boot-verify.
#      (Always rebuilds, even with no new commits, so a stale client/dist is refreshed.)
#   4. Restart uvicorn inside its tmux session (respawn-window — kills the old
#      serve.sh and runs a fresh one in the same window). Falls back to printing
#      manual restart steps if no matching tmux session is found.
#   5. Health-probe the running server.
#
# Server is restarted in the tmux session named by IRON_LEDGER_TMUX (default
# "iron-ledger"). Run serve.sh in a session of that name (a session/window target
# like "mysess:0" also works) so this script can find and respawn it:
#   tmux new-session -s iron-ledger './scripts/serve.sh'
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/server/.env"
TMUX_TARGET="${IRON_LEDGER_TMUX:-iron-ledger}"

info() { printf '\033[1;34m[redeploy]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[redeploy]\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m[redeploy]\033[0m %s\n' "$1" >&2; }

# Read KEY=value from server/.env (env var wins, else .env, else default) — same
# resolution serve.sh/run.sh use, so the health probe hits the real listen address.
env_or() {
  local cur="${!1:-}"
  if [ -z "$cur" ] && [ -f "$ENV_FILE" ]; then
    cur="$(grep -E "^$1=.+" "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
  fi
  printf '%s' "${cur:-$2}"
}

cd "$REPO_DIR"

# ---- 1. must be a clean git clone --------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  err "$REPO_DIR is not a git clone — redeploy expects a clone it can 'git pull'."
  err "Re-clone the deploy box: git clone <origin-url> ~/iron_ledger"
  exit 1
}
# --porcelain lists tracked modifications, staged changes AND untracked files,
# but never gitignored ones — so generated server/.env, data/, backups/, dist/,
# uv.lock don't trip it. A non-empty result on the deploy box is real source drift.
if [ -n "$(git status --porcelain)" ]; then
  err "Working tree is not clean — refusing to pull over local changes."
  err "The deploy box should track origin only. Inspect with 'git status', then"
  err "discard/stash the changes (or remove stray untracked files) and re-run."
  exit 1
fi

# ---- 2. pull -----------------------------------------------------------------
before="$(git rev-parse HEAD)"
info "Pulling latest from origin…"
git pull --ff-only
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  info "Already at origin HEAD (${after:0:9}) — rebuilding anyway to refresh client/dist."
else
  info "Updated ${before:0:9} -> ${after:0:9}."
fi

# ---- 3. rebuild --------------------------------------------------------------
# run.sh rebuilds client/dist, syncs server deps, enforces public-only deps, and
# boot-verifies. It is non-interactive once WT_INVITE_CODE is set (it is on a live
# deploy); it only prompts if the invite code is still missing/placeholder.
info "Rebuilding via ./run.sh…"
./run.sh

# ---- 4. restart --------------------------------------------------------------
# Post-deploy reminder: a fresh build can still look "old" on a device because of
# the service-worker cache, not the deploy. Shown after both restart paths.
print_sw_reminder() {
  cat <<'EOF'

  Device still showing the OLD UI? That's the service-worker cache, not the deploy:
    • The PWA auto-updates on the login page; logged in, tap the "new version — Reload" banner.
    • Confirm via the footer build stamp (v<date>) — it should match the new build.
    • If stuck: unregister the service worker + clear site data for the site, then reload.
EOF
}

restart_server() {
  if ! command -v tmux >/dev/null 2>&1 || ! tmux has-session -t "$TMUX_TARGET" 2>/dev/null; then
    # No tmux session to respawn — run the server right here in the current
    # terminal (foreground; Ctrl-C to stop), the same way serve.sh runs by hand.
    # exec replaces this process, so nothing after returns; print the post-deploy
    # reminder FIRST. (If a server is already running elsewhere on the port,
    # serve.sh will fail to bind with a clear "address already in use".)
    warn "No tmux session '$TMUX_TARGET' — starting the server in THIS terminal (Ctrl-C to stop)."
    warn "  (Set IRON_LEDGER_TMUX=<session[:window]> to have redeploy respawn a tmux window instead.)"
    print_sw_reminder
    info "Code: ${before:0:9} -> ${after:0:9}; client/dist rebuilt. Starting serve.sh…"
    exec "$REPO_DIR/scripts/serve.sh"
  fi
  # respawn-window targets ONE window; with a session-only target it acts on that
  # session's ACTIVE window, which may not be the server's. Warn if the session has
  # more than one window so a multi-window setup doesn't silently restart the wrong
  # one — point the user at the exact target. (The documented setup is a dedicated
  # single-window session, where this is unambiguous.)
  if [[ "$TMUX_TARGET" != *:* ]]; then
    # Fallback assignment: under `set -euo pipefail` a failing tmux list-windows
    # (e.g. the session vanished after has-session) would otherwise abort the script.
    local nwin=1
    nwin="$(tmux list-windows -t "$TMUX_TARGET" 2>/dev/null | wc -l)" || nwin=1
    if [ "${nwin:-1}" -gt 1 ]; then
      warn "tmux session '$TMUX_TARGET' has $nwin windows — respawning its ACTIVE window."
      warn "  If serve.sh isn't there, set IRON_LEDGER_TMUX='$TMUX_TARGET:<window>' and re-run."
    fi
  fi
  info "Restarting server in tmux target '$TMUX_TARGET'…"
  # respawn-window -k kills whatever the window is running (the old serve.sh /
  # uvicorn) and starts a fresh serve.sh in the SAME window — deterministic,
  # no Ctrl-C key-send timing to get wrong.
  tmux respawn-window -k -t "$TMUX_TARGET" "cd '$REPO_DIR' && exec ./scripts/serve.sh"
  info "Server respawned. Watch it:  tmux attach -t $TMUX_TARGET"
  return 0
}

# ---- 5. health probe ---------------------------------------------------------
health_probe() {
  command -v curl >/dev/null 2>&1 || { warn "curl not found — skipping health probe."; return 0; }
  local host port url
  host="$(env_or WT_HOST 127.0.0.1)"
  port="$(env_or WT_PORT 8000)"
  # 0.0.0.0 means "all interfaces" — not a probe target; hit loopback instead.
  [ "$host" = "0.0.0.0" ] && host="127.0.0.1"
  url="http://$host:$port/api/health"
  info "Probing $url …"
  local _ code
  for _ in 1 2 3 4 5 6; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)"
    if [ "$code" = "200" ]; then info "Health OK (200) — server is up."; return 0; fi
    sleep 1
  done
  warn "Health probe got '$code' (want 200) at $url."
  warn "  503 = data dir not writable (NAS not mounted?). Empty = not listening yet."
  warn "  Check the server window: tmux attach -t $TMUX_TARGET"
  return 1
}

# Reached only on the tmux-respawn path (the no-tmux path exec's serve.sh and never
# returns). Verify health so the summary + exit code never claim success when a
# killed-old + failed-new restart left the server down.
restart_server
if health_probe; then
  info "Redeploy OK — server is up."
  info "  Code: ${before:0:9} -> ${after:0:9}; client/dist rebuilt; restarted in tmux '$TMUX_TARGET', health 200."
  print_sw_reminder
  exit 0
fi
err "Redeploy restarted the server but it is NOT healthy — it may be DOWN."
err "  Code rebuilt (${before:0:9} -> ${after:0:9}); inspect:  tmux attach -t $TMUX_TARGET"
exit 1
