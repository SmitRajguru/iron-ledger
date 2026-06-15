# Iron Ledger

Self-hosted, mobile-first, offline-first workout tracker (working name was "WT Tracker"). **Svelte PWA** frontend + **FastAPI** backend,
append-only JSON event log on disk. For a few trusted users (invite-gated). Built phase-by-phase; full design in
`docs/DESIGN.md`, build history + reviews under `phases/`.

## Features
- **Auth:** invite-gated signup, login, signed httpOnly sliding session cookie. A handful of trusted users.
- **Offline-first:** every action writes to IndexedDB instantly and a sync queue (`_enq`-ordered) pushes to the
  server when online. Log a whole workout with no signal; it syncs later. Append-only event log, edits/deletes are
  superseding events (`voids`) / tombstones — no destructive writes.
- **Exercise library:** custom + a 54-entry curated catalog; types weighted / bodyweight (assisted or weighted) /
  cardio; per-exercise rep range + increment; soft-archive.
- **Named routines:** Push/Pull/Legs/A/B… each an ordered exercise list with optional weekday-default assignment;
  handle-only drag-reorder. Start today's routine, pick another, or build a one-off custom day.
- **Logging loop (Today):** one-tap-confirm prefill (this-session → last-session by set_index → empty), per-exercise
  increment steppers, per-set save state on the row (saved-on-device → synced → red error), warmup toggle, mid-session
  +set/skip/swap/log-out-of-order, assisted-lift entry (hides the sign math), auto-scroll, a date picker (log past days).
- **Analytics:** per-exercise **e1RM** (Epley, reps capped at 12, warmups excluded) + **volume** graphs (12-week
  default), **body composition** (bodyweight 7-day moving average + muscle/fat%/fat-mass trends, derived fat mass),
  **double-progression** hints in Today (muted, one-tap apply, per-exercise hold toggle, never auto-changes weight).
- **Rest timer** (wall-clock, survives lock/reload), **PR badges** (e1RM/volume, quiet), **cardio logging**
  (duration/distance + trends).
- **Smartwatch:** a lazy `/watch` route — ultra-minimal single-set entry for a watch browser, reuses the shared core.
- **Units:** one fixed hidden canonical (lb) stored; a lb/kg display toggle converts everything (display-only).

## Architecture
```
[Phone / Desktop / Watch browser]  PWA (Svelte)
        IndexedDB (offline source of truth) + _enq-ordered sync queue
            | HTTPS (Cloudflare Tunnel)
        [FastAPI]  auth + append-only event store + serves the built client (SPA fallback)
            | files
        data/<user>/log/sets-YYYY-MM.jsonl  (+ seq.json, users.json)   — human-readable JSON
```
- **Client is the offline source of truth** during a session; the server is a thin append store + auth + static host.
- **Append-only events**: envelope `{id, type, ts, device, voids, payload}`; types `set_logged`, `measurement`,
  `exercise_defined/updated`, `routine_defined/updated`. Current state = pure client-side fold over the log
  (`client/src/lib/logging.js`); analytics are pure reads (`analytics.js`). Server dedupes by `id`, assigns an immutable
  per-user `_seq` (reserve-before-append + fsync + self-heal), validates per-type, rejects bad events individually.

## Prerequisites
- [uv](https://docs.astral.sh/uv/) (manages Python; pins 3.12 — system Python unused).
- Node.js 18+ and npm.
- git, and a **native Linux filesystem** for the checkout. `node_modules` needs symlinks and a
  virtualenv's python is arch-specific, so a Windows-mounted / cloud-synced / NAS folder breaks the
  build (`Cannot find module …/node_modules/dist/node/cli.js`) or `exec format error`. Clone to a
  native path (`~/iron_ledger`). The **event log** can still live on a NAS via `WT_DATA_DIR` (below).

`./setup.sh` (idempotent) verifies prereqs (and **offers to install Node LTS** if missing/old), drops a
broken/copied `.venv` so uv rebuilds it natively, drops a `uv.lock` pinned to a private package index so
uv resolves from public PyPI, checks the filesystem supports symlinks, runs `uv sync` + `npm install`,
enables the git pre-commit hook, and generates a gitignored `server/.env` with a random `WT_SECRET` +
placeholder `WT_INVITE_CODE`. **Set a real `WT_INVITE_CODE`** before inviting users.

## Deploy — copy-paste (prod, your own ports/paths)
Paste top to bottom. Prod is a **single port** (the server serves API + client on one origin).
```sh
# 1. Clone onto a NATIVE Linux filesystem (one-liner does clone + setup):
curl -fsSL https://raw.githubusercontent.com/SmitRajguru/iron-ledger/main/install.sh | bash
#   …or manually:
#   git clone https://github.com/SmitRajguru/iron-ledger.git ~/iron_ledger
cd ~/iron_ledger

# 2. Install deps + generate server/.env (skip if step 1 already ran ./setup.sh).
./setup.sh

# 3. Configure server/.env — set what you need (WT_SECRET is already generated):
#      WT_INVITE_CODE=<a real code>              # signup is 503 until this is set
#      WT_PORT=8080                              # your server port (default 8000)
#      WT_HOST=127.0.0.1                         # keep loopback (only the tunnel reaches it)
#      WT_DATA_DIR=/mnt/your-nas/iron-ledger-data   # optional: keep the event log on the NAS
nano server/.env                              # or: $EDITOR server/.env

# 4. Build + verify (prints resolved host:port + data dir; does NOT start the server).
./run.sh

# 5. Start it (foreground; Ctrl-C to stop). Reads WT_HOST/WT_PORT from server/.env:
./scripts/serve.sh

# 6. (Optional) public URL — Cloudflare tunnel ingress -> http://127.0.0.1:8080
#    (MUST match WT_HOST:WT_PORT). See deploy/cloudflared-config.yml.

# 7. Back up the data dir whenever (honors WT_DATA_DIR); or cron it:
( crontab -l 2>/dev/null; echo "15 3 * * * cd ~/iron_ledger && scripts/backup.sh >> backups/backup.log 2>&1" ) | crontab -

# Verify it's up (use your WT_PORT), from another terminal:
curl -s http://127.0.0.1:8080/api/health      # -> {"status":"ok","data_dir_writable":true}
```

## Run

**Dev** (hot reload; Vite proxies `/api` → :8000, so the cookie works same-origin):
```sh
cd client && npm run dev                                   # http://localhost:5173
cd server && uv run uvicorn app.main:app --reload --port 8000
```

**Production / phone / watch** (server serves the built client + SPA fallback at `/`):
```sh
./run.sh        # prep: ensures WT_SECRET, prompts for a real WT_INVITE_CODE, builds the
                # client, uv sync, boot-verifies, then prints the start command. Does NOT start.
```
Then start it (foreground; **Ctrl-C to stop**):
```sh
./scripts/serve.sh        # runs uvicorn using WT_HOST/WT_PORT from server/.env
```
Expose the port via your Cloudflare Tunnel (HTTPS — required for PWA install + service worker). Visit the URL on a
phone to install the PWA; the watch uses the same URL at `/watch`.

> **Single worker only.** The append path uses an in-process per-user lock; multiple workers won't coordinate
> (`server/app/storage.py` documents the multi-worker caveat).

### Ports
**Prod is a single port.** The API server also serves the built client (one origin — required: the session
cookie is same-origin). There is no separate "client port" in prod.
- Set it in `server/.env` (read by `run.sh` / `serve.sh`):
  ```
  WT_HOST=127.0.0.1     # loopback = tunnel-only; use 0.0.0.0 to reach it on the LAN IP
  WT_PORT=8080          # whatever you want
  ```
  `./scripts/serve.sh` reads these and starts uvicorn with the right `--host`/`--port`. **Note:** a hand-typed
  `uvicorn` does NOT read `WT_HOST`/`WT_PORT` — pass `--host`/`--port` yourself. For LAN access use `WT_HOST=0.0.0.0`
  (and `WT_COOKIE_SECURE=false` if you serve plain HTTP over the LAN — else login fails; also no PWA/offline over http).

**Dev uses two ports** (Vite client + uvicorn API), both overridable:
```sh
WT_CLIENT_PORT=5174 WT_API_PORT=8001 npm run dev      # client on 5174, proxies /api → 8001
cd server && uv run uvicorn app.main:app --reload --port 8001
```
`WT_API_PORT` must match the uvicorn `--port`. If you change the client port and ever hit the API
cross-origin (not via the proxy), set `WT_DEV_ORIGIN=http://localhost:5174` so CORS allows it.

### Deploy / operations
- **Deploy on a native fs, data on the NAS:** run the code from `~/iron_ledger` (native — see Prerequisites),
  and point the event log at the NAS by setting `WT_DATA_DIR=/mnt/.../iron-ledger-data` in `server/.env`.
  Only `data/` lives on the NAS; the app + venv + build stay native. `run.sh` creates/verifies the data dir
  and `/api/health` 503s if it's unwritable (e.g. NAS not mounted).
- **Run / stop:** `./scripts/serve.sh` runs the server in the foreground — **Ctrl-C to stop**. (Backgrounded it
  with `&`/`nohup`? Stop with `pkill -f "uvicorn app.main:app"` — check first with `ss -ltnp | grep <port>`.)
- **Debug:** logs print straight to the terminal serve.sh runs in. Confirm it's listening:
  `ss -ltnp | grep <port>` (want `0.0.0.0:<port>` for LAN, `127.0.0.1:<port>` for loopback). Health:
  `curl -s http://127.0.0.1:<port>/api/health` → `503` means the data dir isn't writable (NAS not mounted?).
- **Back up the data dir (the only durable truth):** `scripts/backup.sh` writes a timestamped tarball (default
  `./backups/`, keeps 14; honors `WT_DATA_DIR`). Schedule nightly via cron. Restore: stop the server (Ctrl-C) →
  `scripts/backup.sh --restore <tarball>` → start it again.
- **Set a real `WT_INVITE_CODE`:** signup **fails closed** (503) while the code is still the `change-me-…` placeholder
  from `setup.sh`. Change it before exposing the tunnel.
- **Cloudflare tunnel:** see `deploy/cloudflared-config.yml` (example ingress → `http://127.0.0.1:8000`, run `cloudflared`
  as its own restart-on-crash service). After deploy, set `WT_ALLOWED_HOSTS=<your hostname>` in `server/.env` to enable
  the Host allow-list. TLS terminates at Cloudflare; the cookie is auto-marked `Secure` off-localhost.
- **Security headers + health:** the server sends `nosniff`/`X-Frame-Options: DENY`/`Referrer-Policy`/CSP (and HSTS
  off-localhost). `GET /api/health` returns `503` if `data/` isn't writable — wire it to an uptime check.
- **On a NAS/SMB mount:** `fsync` is best-effort (logged once if the mount rejects it); durability is delegated to the
  NAS. Keep `data/` backed up regardless.
- **Updates are visible:** the client uses a prompt-to-refresh service worker — after you redeploy, devices show an
  "A new version is available — Reload to update" banner (no more silent stale bundles). The footer shows the running
  build stamp (`v<date>`), so you can confirm at a glance which bundle a device has.
- See `docs/PRODUCTION-READINESS.md` for the full tiered hardening checklist (security headers, rate limiting, tunnel
  config, tests/CI, etc.).

## Checks
```sh
cd client && npm run check       # svelte-check (0/0) — guards undefined-globals etc. that vite build misses
cd client && npm run build       # also a smoke that the bundle compiles
./scripts/check-public-deps.sh   # asserts all deps resolve from PUBLIC registries (no private mirror)
```
**Public dependencies only.** `check-public-deps.sh` fails if any lockfile/config points at a non-public
package index (it allowlists pypi.org / files.pythonhosted.org / registry.npmjs.org). `run.sh` runs it as a
deploy gate, and `setup.sh`/`run.sh` auto-drop a `uv.lock` pinned to a private index so uv re-resolves from
public PyPI. Keep it that way — never commit a lockfile generated against a corporate mirror.

**Pre-commit hook.** `setup.sh` enables `core.hooksPath .githooks`. The hook runs `check-public-deps.sh`
and, if you set `IRON_LEDGER_LEAK_CHECKER=/path/to/checker` (an external denylist for private/org content
— kept external so this public repo carries no internal names), runs it on the staged files too.

The logging/analytics layers are covered by ad-hoc `fake-indexeddb` harnesses (22-case regression run green during
development). There is no committed automated test suite yet — see Known gaps.

## Environment (`server/.env`, gitignored — see `server/.env.example`)
| Var | Purpose |
|---|---|
| `WT_SECRET` | Signs the session cookie. Long + random. Rotating it invalidates all sessions. |
| `WT_INVITE_CODE` | Shared code required by signup. Hand only to trusted users. |
| `WT_HOST` / `WT_PORT` | Prod listen host/port (one origin). `127.0.0.1` = tunnel-only; `0.0.0.0` = reachable on the LAN IP. **Honored by `./scripts/serve.sh` / `run.sh`** — a hand-typed `uvicorn` needs explicit `--host`/`--port`. |
| `WT_COOKIE_SECURE` | `auto` (default) / `true` / `false`. Set `false` for plain-HTTP LAN access or login fails (browser drops a Secure cookie over `http://`). |
| `WT_DATA_DIR` | Event-log dir (default `<repo>/data`). Point at a NAS to keep data off the box. |
| `WT_ALLOWED_HOSTS` | Optional comma-separated Host allow-list (off = any host). |

## API
Auth: `POST /api/auth/{signup,login,logout}`, `GET /api/auth/me` (all return `{username}`; signup needs `invite_code`).
Sync: `POST /api/sync {events:[...]}` → `{accepted, duplicate, rejected:[{id,reason}]}` (bad events rejected
individually, batch never fails); `GET /api/events?since=<seq>` → `{events:[...+_seq], cursor}`. Per-type payload
validation lives in `server/app/events.py`. Non-`/api` paths serve the SPA shell (client-side routing).

## Docs map
- `docs/DESIGN.md` — full spec + resolved decisions. `docs/ROADMAP.md` — phases. `docs/TEAM.md` — the build process
  (subagent roles + codex review). `docs/UNIT-MODEL.md` — the unit model. `docs/FEEDBACK.md` — single freeform feedback
  file (dump testing notes here). `docs/FEEDBACK-template.md` — per-iteration template.
- `phases/<phase>/` — per-phase CONTRACT, BRAINSTORM, REVIEW-*, CLOSEOUT, FEEDBACK. Read the CLOSEOUTs for what shipped.
- `docs/HANDOFF.md` — pick-up guide for a fresh session.

## Known gaps / TODO
- **Real-device QA pending:** the whole app is harness/mock-proven, not browser/real-device verified. Each
  `phases/*/CLOSEOUT.md` lists the device-only items (chart taps, rest-timer feel, drag, watch rendering, etc.).
- **No committed test suite** (only dev-time harnesses) and **no CI**. Adding `npm run check` + a real test runner to CI
  is the top hardening task.
- **Single-worker** assumption (needs an OS file lock for multi-worker).
- **Deferred:** health-app import (Apple Health / Google Fit) — the only unbuilt roadmap item.
