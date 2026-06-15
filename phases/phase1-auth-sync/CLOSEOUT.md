# Phase 1 — Closeout (auth + data plumbing)

Status: **complete**. All review findings resolved + re-confirmed by codex.

## Delivered
- **Backend (FastAPI):** invite-gated signup, login, logout, `/me`; bcrypt; signed httpOnly sliding 30-day cookie;
  append-only event store with immutable per-user `_seq` counter (crash-durable: reserve-before-append + fsync +
  self-heal); `POST /api/sync` (dedupe-by-id) + `GET /api/events?since`; per-user asyncio lock; username regex +
  path-confinement. `setup.sh` bootstrap, `.env` (umask 077).
- **Frontend (Svelte PWA):** login/signup screen, auth gate, IndexedDB outbox/events, real sync queue with
  atomic outbox→events, distinct online/offline/pending/syncing/**error** states, mid-session 401 handling
  (re-login without losing outbox), network-failure-tolerant `me()` (no gym lockout), version-gated IDB migration,
  full-width responsive layout, dev-only offline toggle + test-event button, login papercut polish.

## Review trail
- `REVIEW-codex.md` — round 1 (gpt-5.3-codex): 1 critical, 1 high, 3 med, 2 low.
- `REVIEW-advocate.md` — gym-goer UX: silent-failure trio (error state, mid-session 401, launch lockout) + papercuts.
- `REVIEW-summary.md` — consolidated prioritized fix list.
- `REVIEW-codex-round2.md` — fixes confirmed; escalated `_seq` crash durability (HIGH) + login 422 (MED).
- `REVIEW-codex-round3.md` — both confirmed fixed; 1 LOW (login length 422) — fixed inline (now 401), verified.

## Verified
Backend: full auth flow, C1 ordering (older-ts append keeps seq), self-heal (3 corruption cases recover, no dup),
H1 traversal rejected, M1 sliding cookie, login 401 (empty/long/bad-charset) vs signup 422. Frontend: build + PWA
assets, fake-indexeddb harness for M2/T1/T2/M3/L1, dev controls stripped from prod.

## Live integration — VERIFIED
Added a Vite dev proxy (`client/vite.config.js`: `/api` → `:8000`). Ran a real end-to-end smoke through
the proxy (browser-origin → backend): health, signup+cookie, `/me`, `POST /api/sync` (accepted), `GET /api/events`
(`_seq:1`, `cursor:1`) — all pass. The earlier mock-only gap is closed.

## Known limitations (accepted for v1)
- fsync durability verified logically, not by real power-loss/`kill -9`.
- Single-worker assumption; multi-worker deploy needs a real OS file lock (documented in storage.py).

## Phase 2 carry-over (settle at Phase 2 brainstorm)
Per-set save confirmation hooks; `unit` in every event; bodyweight staleness warning (assisted-lift e1RM);
ad-hoc swap/reorder defaults to per-session; per-set `warmup` flag for progression; rest-timer pull-forward vote.
