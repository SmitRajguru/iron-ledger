#!/bin/sh
# WT Tracker bootstrap. Prepares a fresh machine; safe to re-run (idempotent).
#
# What it does:
#   1. Checks for `uv` and `node`; if missing, explains how to get them (does NOT
#      silently install system packages -- it offers to run the official uv installer
#      only with an explicit echo of what it would do).
#   2. `uv sync` in server/, `npm install` in client/.
#   3. Generates server/.env with a random WT_SECRET + placeholder WT_INVITE_CODE if absent.
#   4. Prints next steps.

set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_DIR="$REPO_DIR/server"
CLIENT_DIR="$REPO_DIR/client"
ENV_FILE="$SERVER_DIR/.env"

info() { printf '\033[1;34m[setup]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m[setup]\033[0m %s\n' "$1" >&2; }

# ---- prerequisites ------------------------------------------------------------

check_uv() {
    if command -v uv >/dev/null 2>&1; then
        info "uv found: $(uv --version)"
        return 0
    fi
    warn "uv (Python toolchain) is not installed."
    printf '       Install it with the official script? This runs:\n'
    printf '         curl -LsSf https://astral.sh/uv/install.sh | sh\n'
    printf '       Proceed? [y/N] '
    read -r answer
    case "$answer" in
        [yY]*)
            info "Installing uv via the official astral.sh script..."
            curl -LsSf https://astral.sh/uv/install.sh | sh
            # The installer drops uv in ~/.local/bin or ~/.cargo/bin; make this run see it.
            PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
            export PATH
            command -v uv >/dev/null 2>&1 || { err "uv still not on PATH; restart your shell and re-run."; exit 1; }
            ;;
        *)
            err "uv is required. See https://docs.astral.sh/uv/ and re-run."
            exit 1
            ;;
    esac
}

NODE_MIN_MAJOR=18
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//'; }

# Build the package-manager command to install Node LTS, or empty if none known.
node_install_cmd() {
    if [ "$(id -u)" -eq 0 ]; then sudo=""; sudo_e=""; else sudo="sudo"; sudo_e="sudo -E"; fi
    if command -v apt-get >/dev/null 2>&1; then
        echo "curl -fsSL https://deb.nodesource.com/setup_lts.x | $sudo_e bash - && $sudo apt-get install -y nodejs"
    elif command -v dnf >/dev/null 2>&1; then
        echo "curl -fsSL https://rpm.nodesource.com/setup_lts.x | $sudo bash - && $sudo dnf install -y nodejs"
    elif command -v pacman >/dev/null 2>&1; then
        echo "$sudo pacman -S --noconfirm nodejs npm"
    elif command -v zypper >/dev/null 2>&1; then
        echo "$sudo zypper install -y nodejs npm"
    elif command -v brew >/dev/null 2>&1; then
        echo "brew install node"
    fi
}

check_node() {
    if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
        maj=$(node_major)
        if [ -n "$maj" ] && [ "$maj" -ge "$NODE_MIN_MAJOR" ]; then
            info "node found: $(node --version)"
            return 0
        fi
        warn "node $(node --version 2>/dev/null) is older than v$NODE_MIN_MAJOR (vite needs 18+)."
    else
        warn "Node.js + npm are not installed (required for the client build)."
    fi

    cmd=$(node_install_cmd)
    if [ -z "$cmd" ]; then
        err "No known package manager detected. Install Node ${NODE_MIN_MAJOR}+ via nvm"
        err "(https://github.com/nvm-sh/nvm) or https://nodejs.org/, then re-run ./setup.sh."
        exit 1
    fi
    printf '       Install Node.js (LTS) now? This runs:\n         %s\n       Proceed? [y/N] ' "$cmd"
    read -r answer
    case "$answer" in
        [yY]*)
            info "Installing Node.js (LTS)..."
            sh -c "$cmd" || { err "Node install failed. Install manually and re-run."; exit 1; }
            ;;
        *)
            err "Node ${NODE_MIN_MAJOR}+ is required. Install it and re-run ./setup.sh."
            exit 1
            ;;
    esac
    if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_MIN_MAJOR" ]; then
        info "node ready: $(node --version)"
    else
        err "Node still not on PATH / too old after install. Open a new shell and re-run ./setup.sh."
        exit 1
    fi
}

# npm creates symlinked CLI shims in node_modules/.bin. On filesystems WITHOUT
# symlink support (Windows-mounted / cloud-synced folders, many /mnt/* mounts)
# npm drops a copy instead, and the build later dies with a cryptic
# "Cannot find module .../node_modules/dist/node/cli.js" (vite, etc). Fail fast
# with a real explanation instead of letting that surface at `npm run`.
check_symlinks() {
    test_link="$CLIENT_DIR/.symlink_probe_$$"
    if ln -s . "$test_link" 2>/dev/null; then
        rm -f "$test_link"
        return 0
    fi
    rm -f "$test_link" 2>/dev/null || true
    err "This filesystem does not support symlinks:"
    err "  $CLIENT_DIR"
    err "npm's node_modules/.bin shims need symlinks; without them the build crashes with"
    err "  'Cannot find module .../node_modules/dist/node/cli.js'."
    err "This is common on Windows-mounted / synced / NAS folders (e.g. /mnt/...)."
    err ""
    err "Clone the repo onto a NATIVE Linux filesystem and set up there:"
    err "  git clone https://github.com/SmitRajguru/iron-ledger.git ~/iron_ledger"
    err "  cd ~/iron_ledger && ./setup.sh"
    err "The event log can still live on the NAS — set WT_DATA_DIR in server/.env."
    exit 1
}

# Activate the committed pre-commit hook (public-dependency + leak guard) for
# anyone who set the project up by cloning. No-op outside a git checkout.
install_git_hooks() {
    if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$REPO_DIR" config core.hooksPath .githooks
        info "Enabled git pre-commit hook (core.hooksPath=.githooks)."
    fi
}

# A virtualenv's python is machine/arch-specific. If .venv was COPIED from another
# box (e.g. via cp -r off a NAS) its python won't exec here ("exec format error
# (os error 8)"), and `uv sync` fails trying to query it. Drop a broken venv so uv
# rebuilds it natively.
check_venv() {
    venv_py="$SERVER_DIR/.venv/bin/python3"
    if [ -e "$venv_py" ] && ! "$venv_py" -c "" >/dev/null 2>&1; then
        warn "server/.venv looks broken (copied across machines?) -- removing so uv rebuilds it."
        rm -rf "$SERVER_DIR/.venv"
    fi
}

# A uv.lock pinned to a PRIVATE package index (e.g. a corporate mirror) is
# unreachable off that network -- `uv sync` then dies with a DNS error. If the lock
# points anywhere other than public PyPI, drop it so uv re-resolves from this box's
# default index (public PyPI). Deps in pyproject.toml are loose, so this is safe.
check_lock() {
    lock="$SERVER_DIR/uv.lock"
    [ -f "$lock" ] || return 0
    if grep -q 'registry = "' "$lock" && grep 'registry = "' "$lock" | grep -vq 'pypi\.org'; then
        reg=$(grep -m1 'registry = "' "$lock" | sed 's/.*registry = "\([^"]*\)".*/\1/')
        warn "uv.lock is pinned to a non-public index ($reg) -- unreachable off that network."
        warn "Removing uv.lock so uv re-resolves from public PyPI."
        rm -f "$lock"
    fi
}

# ---- .env generation ----------------------------------------------------------

gen_secret() {
    # Prefer Python's secrets (always present once uv is set up); fall back to openssl.
    if command -v python3 >/dev/null 2>&1; then
        python3 -c "import secrets; print(secrets.token_urlsafe(48))"
    elif command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-64
    else
        err "Need python3 or openssl to generate WT_SECRET."
        exit 1
    fi
}

write_env() {
    if [ -f "$ENV_FILE" ]; then
        info "server/.env already exists -- leaving it untouched."
        return 0
    fi
    info "Generating server/.env with a random WT_SECRET..."
    secret=$(gen_secret)
    invite_suffix=$(gen_secret | cut -c1-8)
    # umask 077 BEFORE creating the file (review L2): the file is born 0600, so the secret is
    # never world-readable even briefly. Scoped to a subshell so the caller's umask is untouched.
    (
        umask 077
        cat > "$ENV_FILE" <<EOF
# Generated by setup.sh. Gitignored. Do not commit.
WT_SECRET=$secret
# Replace with the invite code you hand to trusted users.
WT_INVITE_CODE=change-me-$invite_suffix
# OPTIONAL: where the event log lives (default: <repo>/data). Point this at the
# NAS to keep data off the deploy box, e.g. WT_DATA_DIR=/mnt/.../iron-ledger-data
# WT_DATA_DIR=
# OPTIONAL: single prod listen host/port (server serves API + client on one origin).
# WT_HOST=127.0.0.1
# WT_PORT=8000
EOF
    )
    warn "Set a real WT_INVITE_CODE in server/.env before sharing signup access."
}

# ---- run ----------------------------------------------------------------------

info "Repo: $REPO_DIR"
check_uv
check_node
check_symlinks
check_venv
check_lock

info "Installing server dependencies (uv sync)..."
( cd "$SERVER_DIR" && uv sync )

info "Installing client dependencies (npm install)..."
( cd "$CLIENT_DIR" && npm install )

write_env
install_git_hooks

cat <<EOF

$(info "Setup complete.")

Next steps:
  1. Edit server/.env and set WT_INVITE_CODE to your chosen invite code.
     (Optional: WT_DATA_DIR to put the event log on a NAS; WT_HOST/WT_PORT for the port.)
  2. Dev run (two terminals):
       cd client && npm run dev          # http://localhost:5173
       cd server && uv run uvicorn app.main:app --reload --port 8000
  3. Prod: ./run.sh   (build + verify), then ./scripts/serve.sh   (Ctrl-C to stop)

See README.md for details.
EOF
