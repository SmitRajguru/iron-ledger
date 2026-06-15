# Production Readiness — WT Tracker

Synthesized from a 6-dimension parallel audit (security, deploy/ops, testing/CI, data+sync integrity, frontend UX/a11y, performance/scale) on 2026-06-01. Tiered for the actual plan: **deploy → solo 1-week trial → feedback**. Severity = production risk; Effort = S(<1h)/M(half-day)/L(multi-day).

> The core is genuinely solid — see [§ Already solid](#already-solid). These are gaps, not a rewrite.

---

## TIER 0 — Do BEFORE the week-long trial ✅ DONE (2026-06-01, codex-reviewed)
Cheap, and each prevents a trial-ruining or **irreversible** problem. All 8 implemented; `check` 0/0, build clean; codex round found 3 minor issues (flush reentrancy gap, banner dismiss, chunked-body bypass) — first two fixed, third documented as edge-mitigated.

- [x] **Add an envelope version field `v: 1`** · `sync.js makeEvent` (`SCHEMA_VERSION`), `events.py validate_envelope` (absent⇒v1, else positive int), seed script. Trial data re-seeded versioned. *(data-sync, high)*
- [x] **PWA update flow + visible version stamp** · `vite.config.js` (`registerType:'prompt'` + `injectRegister:null` + `__APP_VERSION__` define), `lib/pwa.js` (registerSW + `needRefresh`/`applyUpdate`), `main.js` initPWA, `AppShell.svelte` "Update available — Reload" banner + `v<build>` footer stamp. *(deploy + frontend + testing, high ×3)*
- [x] **Process supervision (systemd, Restart=always)** · `deploy/iron-ledger.service` (binds 127.0.0.1, `--workers 1`), README. *(deploy, high)*
- [x] **data/ backup + restore runbook** · `scripts/backup.sh` (timestamped tar, retention, `--restore`), README. *(deploy, high)*
- [x] **`navigator.storage.persist()` on startup** · `sync.js startSync` (best-effort, logged). *(data-sync, high)*
- [x] **Global error boundary** · `main.js` boot try/catch → fallback; `window 'error'` → dismissible reload banner; `unhandledrejection` → log-only (avoids false-positive banners on transient rejections). *(frontend, high)*
- [x] **Invite-code guard** · `routes_auth.py signup` fails closed (503) while code is `change-me…`. *(security, medium)*
- [x] **/api/sync body + batch-size cap** · `routes_sync.py` `Field(max_length=1000)` + `main.py` 5 MB Content-Length middleware + client `flush()` chunked at 250 (preserves per-chunk M2 atomicity). *(security high + data-sync medium)*

---

## Backward-compat / data migration ✅ DONE (2026-06-01, codex-reviewed)
Append-only + the `v` field made the store migration-*ready*; this added the **upcast-on-read** layer so future schema changes stay backward compatible. See `docs/DATA-MIGRATION.md`.
- [x] **Client upcast seam** · `client/src/lib/migrations.js` — `CURRENT_VERSION`, `migrateEvent()` (ordered `MIGRATIONS` registry, identity for v1), envelope-fields pinned so a step can only touch payload. Hooked into both folds (`logging.js`/`library.js mergeOrdered`).
- [x] **Version-skew guards** · client skips events with `v > CURRENT_VERSION` (newer device); server `events.py MAX_EVENT_VERSION` rejects future-`v` events (dead-lettered).
- [x] **Policy doc** · `docs/DATA-MIGRATION.md` — server-first rollout, never-rewrite/never-repurpose, additive-optional needs no bump, how to add v2.

---

## TIER 1 — Before WIDER exposure (anything past your own use)
The perimeter is the weak spot once the tunnel is public. **Quick wins done 2026-06-01** (codex-reviewed); rate limiting deferred.

- [ ] **Rate limiting on /login + /signup** · M · Cloudflare WAF rule (lowest effort) or `slowapi` — **DEFERRED** (relying on strong invite + bcrypt for the solo trial; do before wider exposure). *(security, high)*
- [x] **Security response headers** · `main.py security_and_body_limits` — nosniff, X-Frame-Options:DENY, Referrer-Policy:no-referrer, CSP (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`…), HSTS off-localhost. *(security, medium)*
- [x] **TrustedHost (opt-in) + bind 127.0.0.1** · `main.py` adds `TrustedHostMiddleware` when `WT_ALLOWED_HOSTS` set (+localhost); uvicorn binds 127.0.0.1 via run.sh/systemd. *(security, low)*
- [x] **Cloudflare tunnel config, committed** · `deploy/cloudflared-config.yml` (ingress → `127.0.0.1:8000`, run as a service) + README. *(deploy, medium)*
- [x] **Deepen /api/health** · `main.py` — 503 when `DATA_DIR` not writable (wire a cron/Cloudflare uptime check to it). *(deploy, low)*
- [x] **NAS best-effort fsync** · `storage.py _best_effort_fsync` — fsync degrades gracefully (warn-once) on mounts that reject it; durability delegated to the NAS. *(data-sync)*

---

## TIER 2 — Hardening: tests + CI (the documented top gap)
No committed test suite or CI exists. The riskiest logic is already pure → cheap to cover.

- [ ] **Install runners** · S · `client/package.json`, `server/pyproject.toml` — *blocker for any test*
  Client: `vitest + jsdom + @testing-library/svelte + fake-indexeddb`. Server: dev group `pytest + httpx`. *(testing, blocker)*
- [ ] **Pure-fn unit tests** · M · `logging.js`, `analytics.js`, `units.js`, `session.js`
  foldLog void/tombstone/ordering + `nextSetFromFold` max+1 after delete hole; e1RM rep-cap@12; `effectiveLoad` null-not-0/live-BW; PR excludes first session; units lb/kg round-trip preserves precision. Reuse `may2026_spec` events as fixtures. *(testing, high)*
- [ ] **Server tests** · M · `events.py`, `storage.py`, `routes_sync.py`
  Validation matrix (good + each malformed + tombstones); `_seq` monotonic across month buckets; dedupe; `read_events_since` since-cursor; `_load_counter` self-heals from a zeroed seq.json (never reissues). *(testing, high — riskiest untested path)*
- [ ] **Sync tests** · M · `sync.js`
  `flush()` POSTs in `_enq` order; reject → deadletter + rejectedIds + leaves outbox; pull-throw-after-accept keeps confirmed in outbox; 401 → sessionExpired, outbox preserved; enqCounter never ties/regresses. *(testing, high — other riskiest path)*
- [ ] **Today/Graphs render smoke** · M · `Today.svelte`, `Graphs.svelte`
  Mount with a seeded fold, assert renders without throwing + a known value appears. The harness "repeatedly missed render bugs" — this is cheap insurance. *(testing, medium)*
- [ ] **GitHub Actions CI** · S · `.github/workflows/ci.yml`
  client: `npm ci` → `check` → `test` → `build`; server: `uv sync --group dev` → `pytest`. On push + PR. Add a post-build assert that `sw.js`/precache references content-hashed filenames (guards the stale-SW recurrence). *(testing, high)*

---

## TIER 3 — Polish, a11y, perf (post-trial, informed by your feedback)

**Recovery / ops visibility**
- [ ] Dead-letter viewer + stuck-outbox "N items stuck" escalation (retry via `buildSetRetryEvent` / discard) · M · `sync.js` *(data-sync, medium)*
- [ ] Log strategy: journald + documented `journalctl` tail, or RotatingFileHandler · S · `main.py` *(deploy, medium)*

**Accessibility / UX**
- [ ] Picker/swap sheet: move focus in, trap Tab, Escape-to-close, restore focus · M · `Today.svelte` *(frontend, medium)*
- [ ] Sync-status `aria-live` announcement; watch status stripe is color-only · S · `AppShell.svelte`, `Watch.svelte` *(frontend, medium)*
- [ ] Contrast pass: `--muted`/`--warn`/`--accent` likely fail AA at small sizes (gym/outdoor legibility) · S · `app.css` *(frontend, medium)*
- [ ] iOS PWA metadata: `apple-touch-icon` (180), standalone metas, verify 512 maskable safe-zone · S · `index.html` *(frontend, medium)*
- [ ] `<noscript>` + boot fallback inside `#app` (bundle 404 / JS blocked) · S · `index.html` *(frontend, low)*
- [ ] Inline validation: bodyweight non-positive, empty reps on confirm, rep_low > rep_high (cardio path already does this) · S · *(frontend, low)*
- [ ] Remove dead "Coming in a later phase" placeholder tab · S · `AppShell.svelte` *(frontend, low)*
- [ ] **Advocate graph backlog (9 items)** — see `docs/FEEDBACK.md` (deload-looks-like-weaker, headline trend number, tap-to-pin crosshair, PR+est. marker, auto-fit range, …)

**Performance (only matters as history grows — fine for the trial)**
- [ ] Coalesce `logRevision` bumps per flush; skip library rebuild when no exercise/routine change · M · `sync.js` *(perf, medium)*
- [ ] `read_events_since` newest-first short-circuit / cache per-file max-seq · S · `storage.py` *(perf, medium)*
- [ ] In-memory per-user id-set + max-`_seq` under the lock (kills the O(N) rescan per append) · S · `storage.py` *(perf, medium)*
- [ ] Lazy-import Graphs/Body like WatchRoute · S · `vite.config.js` *(perf, low)*
- [ ] (Multi-year) folded-state checkpoint / voided-event compaction · L · *(perf, low)*

**Security (lower)**
- [ ] Document `WT_SECRET` rotation = global logout; consider shorter `SESSION_MAX_AGE` or token version/blocklist if exposure widens · M · `auth.py` *(security, low)*
- [ ] `_month_key` clock-skew clamp (a wrong client clock misfiles into `sets-2099-01.jsonl`; cosmetic, no integrity impact) · S · `storage.py` *(data-sync, low)*

---

## <a name="already-solid"></a>Already solid — do NOT redo
- **Auth:** bcrypt cost-12 w/ safe verify, signed HttpOnly+SameSite=Lax cookie, Secure auto-on off-localhost, sliding expiry, `hmac.compare_digest` invite check, enumeration-safe 401, double-guarded path traversal.
- **Durability:** `_seq` reserved+fsynced before append, per-file + per-dir fsync, atomic `users.json` rename, self-healing counter → no data loss / no duplicate `_seq` on power loss.
- **Sync correctness:** idempotent dedupe-by-id, `_enq` enqueue-ordered fold (survives id-keyed store), pull-before-delete atomicity, dead-letter loop-breaker, ordering driven by `_seq`/`_enq` not client `ts` (clock-skew immune), additive IndexedDB upgrade path.
- **Validation:** thorough per-type envelope/payload checks, per-event reject (bad event dropped, batch survives), no `{@html}`/XSS sinks.
- **Setup:** idempotent `setup.sh`, 0600 `.env`, strong random `WT_SECRET`, fail-fast on missing config, careful SPA-fallback mount, `/api/health` exists.
- **UX:** calm offline wording, 44–56px touch targets, focus-visible, login focus mgmt, per-set save/retry states, drag-handle-only reorder, watch index-clamp + confirm-latch, safe-area insets.

---

### How this maps to your plan
Tier 0 before you deploy (irreversibles + "stays up" + "fixes are visible"). Tier 1 before the URL is shared with anyone. Tier 2 in parallel as the safety net. Tier 3 after the trial, reprioritized by what `docs/FEEDBACK-week1.md` surfaces.
