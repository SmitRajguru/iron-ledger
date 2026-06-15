#!/usr/bin/env bash
# Assert the project resolves dependencies ONLY from PUBLIC registries — no private
# / internal / corporate package mirror leaks into the lockfiles or index config.
# Allowlist-based (so it catches ANY private host, and carries no private name).
# Exit non-zero on any violation. Run in CI, and as a gate in run.sh before deploy.
#
#   scripts/check-public-deps.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUB_PY='pypi\.org|files\.pythonhosted\.org'   # public Python registry + CDN
PUB_NPM='registry\.npmjs\.org'                # public npm registry
fail=0

# Flag any http(s) host on a dependency-SOURCE line not on the allowlist. The
# line-filter ($4) restricts to source/registry fields so funding/homepage URLs
# (github, tidelift, …) in a package-lock are never mistaken for install sources.
check_hosts() { # file label allow-regex line-filter
  local f="$1" label="$2" allow="$3" filter="$4" bad
  [ -f "$f" ] || return 0
  bad="$(grep -E "$filter" "$f" | grep -oE 'https?://[^/"[:space:]]+' | sort -u | grep -ivE "$allow" || true)"
  if [ -n "$bad" ]; then
    echo "[$label] non-public host(s) in ${f#$REPO_DIR/}:"
    printf '%s\n' "$bad" | sed 's/^/    /'
    fail=1
  fi
}

# uv.lock: hosts live on `registry = "…"` and `url = "…"` lines. npm: on `"resolved": "…"`.
check_hosts "$REPO_DIR/server/uv.lock"           "uv.lock"      "$PUB_PY"  'registry = "|url = "'
check_hosts "$REPO_DIR/client/package-lock.json" "package-lock" "$PUB_NPM" '"resolved":'

# Index/registry config that would redirect installs to a private mirror.
scan_config() { # file allow-regex
  local f="$1" allow="$2" bad
  [ -f "$f" ] || return 0
  bad="$(grep -iE 'index-url|extra-index|^[[:space:]]*registry[[:space:]]*=|/simple' "$f" \
         | grep -oE 'https?://[^/"[:space:]]+' | sort -u | grep -ivE "$allow" || true)"
  if [ -n "$bad" ]; then
    echo "[config] private index in ${f#$REPO_DIR/}:"
    printf '%s\n' "$bad" | sed 's/^/    /'
    fail=1
  fi
}
scan_config "$REPO_DIR/server/pyproject.toml" "$PUB_PY"
scan_config "$REPO_DIR/server/uv.toml" "$PUB_PY"
scan_config "$REPO_DIR/uv.toml" "$PUB_PY"
while IFS= read -r npmrc; do
  scan_config "$npmrc" "$PUB_NPM"
done < <(find "$REPO_DIR" -name .npmrc -not -path '*/node_modules/*' 2>/dev/null)

if [ "$fail" -eq 0 ]; then
  echo "OK: all dependency sources are public registries."
else
  echo "FAILED: private-index reference(s) found above — re-resolve from public registries"
  echo "        (e.g. rm the lockfile and re-run uv sync / npm install on a public network)."
  exit 1
fi
