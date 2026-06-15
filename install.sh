#!/usr/bin/env bash
# Bootstrap Iron Ledger on a NATIVE Linux filesystem: git clone (or update) + setup.
#
#   curl -fsSL https://raw.githubusercontent.com/SmitRajguru/iron-ledger/main/install.sh | bash
# or, if you already cloned:
#   git clone https://github.com/SmitRajguru/iron-ledger.git ~/iron_ledger
#   cd ~/iron_ledger && ./setup.sh
#
# Overrides: IRON_LEDGER_REPO (clone URL), IRON_LEDGER_DIR (target dir, default ~/iron_ledger).
# Clone onto a native fs (not a NAS/synced mount) — node_modules needs symlinks. The
# event log can still live on a NAS via WT_DATA_DIR in server/.env (see README).
set -euo pipefail

REPO="${IRON_LEDGER_REPO:-https://github.com/SmitRajguru/iron-ledger.git}"
DEST="${IRON_LEDGER_DIR:-$HOME/iron_ledger}"

command -v git >/dev/null 2>&1 || { echo "git is required." >&2; exit 1; }

if [ -d "$DEST/.git" ]; then
  echo "[install] updating existing checkout: $DEST"
  git -C "$DEST" pull --ff-only
else
  echo "[install] cloning $REPO -> $DEST"
  git clone "$REPO" "$DEST"
fi

cd "$DEST"
echo "[install] running setup…"
./setup.sh
