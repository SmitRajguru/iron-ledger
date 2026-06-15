#!/usr/bin/env bash
# Back up WT Tracker's data/ (the only durable source of truth: per-user JSONL
# event log + users.json). The log is append-only, so a plain timestamped tar is
# internally consistent even if taken while the server runs. Keeps the last N.
#
# Usage:
#   scripts/backup.sh                      # -> ./backups/wt-data-YYYYmmdd-HHMMSS.tar.gz
#   WT_BACKUP_DIR=/mnt/external scripts/backup.sh
#   scripts/backup.sh --restore backups/wt-data-20260601-120000.tar.gz   # restore (stops nothing!)
#
# Schedule nightly via cron, e.g.:
#   15 3 * * *  cd ~/iron_ledger && scripts/backup.sh >> backups/backup.log 2>&1
#
# Restore procedure (manual, deliberate):
#   1. Stop the server (Ctrl-C the running uvicorn / serve.sh).
#   2. scripts/backup.sh --restore <tarball>   (replaces the data dir)
#   3. Start it again (./scripts/serve.sh).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/server/.env"
# Resolve the data dir: WT_DATA_DIR from the environment wins; else read it from
# server/.env (so cron, which has no env, still backs up the right -- possibly NAS --
# location); else default to <repo>/data.
DATA_DIR="${WT_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && [ -f "$ENV_FILE" ]; then
  DATA_DIR="$(grep -E '^WT_DATA_DIR=.+' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
fi
DATA_DIR="${DATA_DIR:-$REPO_DIR/data}"
BACKUP_DIR="${WT_BACKUP_DIR:-$REPO_DIR/backups}"
RETAIN="${WT_BACKUP_RETAIN:-14}"   # keep this many most-recent backups

if [[ "${1:-}" == "--restore" ]]; then
  TARBALL="${2:?usage: backup.sh --restore <tarball>}"
  [[ -f "$TARBALL" ]] || { echo "no such tarball: $TARBALL" >&2; exit 1; }
  echo "WARNING: this overwrites $DATA_DIR. Ctrl-C within 5s to abort."; sleep 5
  rm -rf "$DATA_DIR"
  mkdir -p "$(dirname "$DATA_DIR")"
  tar -xzf "$TARBALL" -C "$(dirname "$DATA_DIR")"
  echo "restored $DATA_DIR from $TARBALL"
  exit 0
fi

[[ -d "$DATA_DIR" ]] || { echo "no data dir at $DATA_DIR (nothing to back up)" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/wt-data-$STAMP.tar.gz"
# Archive the data dir by name (so restore recreates it under its parent).
tar -czf "$OUT" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Prune old backups beyond the retention count (newest kept).
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/wt-data-*.tar.gz 2>/dev/null | tail -n "+$((RETAIN + 1))")
if ((${#OLD[@]})); then
  printf '%s\n' "${OLD[@]}" | xargs -r rm -f
  echo "pruned ${#OLD[@]} old backup(s), kept $RETAIN"
fi
