# Handoff — WT Tracker

Pick-up guide for a fresh session. As of 2026-06-01, the full feature set is built (Phases 0–3, 5a, 5b) and
codex-reviewed; what remains is real-device QA, hardening (tests/CI), deploy (user-owned), and one deferred feature.

## State in one paragraph
A self-hosted offline-first workout PWA (Svelte) + FastAPI append-only event store. Login → exercise library + named
routines → per-set offline logging + sync → e1RM/volume graphs + body comp + progression hints → rest timer, PR badges,
cardio → a `/watch` single-set view. All app state is an append-only event log folded client-side; the server is a thin
auth + append + static host with per-type validation. Built by two persistent subagents (a backend agent + a frontend
agent) under a codex (gpt-5.3-codex via `cursor-agent`) + gym-goer-advocate review loop per `docs/TEAM.md`.

## How to run / verify (see README for detail)
- Dev: `client` `npm run dev` + `server` `uv run uvicorn app.main:app --reload --port 8000` (Vite proxies `/api`).
- Prod/phone/watch: `npm run build` then serve from `:8000` behind the Cloudflare tunnel (HTTPS).
- `cd client && npm run check` → svelte-check must stay 0/0.

## Where things live
- **Logging core (pure, watch-reusable):** `client/src/lib/logging.js` — `foldLog`, `nextSetToLog`, `lastSessionFor`,
  `buildSetEvent`, measurement helpers. THE source of truth for current state. Don't recompute outside the fold.
- **Analytics (pure):** `client/src/lib/analytics.js` — e1RM/volume/series, `progressionSuggestion`, PR, fat-mass derive,
  moving average. Pass exercise metadata IN (no store access — that caused a white-screen crash once).
- **Session resolution (shared phone+watch):** `client/src/lib/session.js` — `resolveSessionExercises` =
  base ∪ logged; `hasCommittedSession` gates the start-card. Don't re-inline this in components.
- **Units:** `client/src/lib/units.js` — fixed canonical lb; lb/kg + km/mi display toggles; full precision stored.
- **Sync:** `client/src/lib/sync.js` — outbox/events stores, `_enq` monotonic enqueue order, `logRevision`, dead-letter.
- **Screens:** `Today.svelte` + `ExerciseCard.svelte` (logging + progression + rest + cardio), `Routines.svelte`,
  `Exercises.svelte`, `Graphs.svelte`, `Body.svelte`, `Watch.svelte`/`WatchRoute.svelte`, `LineChart.svelte`.
- **Backend:** `server/app/` — `events.py` (per-type validation), `storage.py` (append + immutable `_seq`),
  `auth.py`/`routes_auth.py`, `routes_sync.py`, `main.py` (SPA fallback).

## Invariants — DON'T break these (each was a hard-won fix)
- Append-only; edits/deletes = superseding events (`voids`) / tombstones (`{deleted:true}`+voids). Never mutate in place.
- `_seq` is immutable, reserve-before-append, never re-derived from file order (older-ts events get a higher `_seq`).
- Outbox folds/POSTs in `_enq` order, NOT UUID order. Bump `logRevision` on every outbox mutation.
- Stored weights are canonical **lb** at full precision; display rounding is display-only — never round into storage.
- Warmups excluded from e1RM/volume/last-session; e1RM caps reps at 12; `bodyweight_snapshot` is frozen, never live.
- `latestBodyweight` (2b assisted-snapshot path) must stay intact when touching `foldLog`.
- Confirm buttons are double-tap-guarded by (exercise_id + set_index); release on index advance / clear on nav.
- Single canonical session resolver (`session.js`) for phone + watch; start-card keys off `hasCommittedSession`.
- Dev-only controls guarded by `import.meta.env.DEV`; the watch is a lazy chunk (keep it out of the main bundle).

## Top next tasks (priority order)
1. **Real-device QA pass** — work each `phases/*/CLOSEOUT.md` "needs real-device" list on a phone + watch; fix findings
   via the same backend/frontend agents + codex review loop. (`docs/FEEDBACK.md` is the single freeform feedback file.)
2. **Hardening:** commit a real test suite (port the dev harnesses for logging/analytics/sync to a runner) + CI running
   `npm run check` + tests + a Today/Graphs render smoke. There is no committed test suite yet.
3. **Deploy:** Cloudflare tunnel → `:8000` (user owns this); set a real `WT_INVITE_CODE`; back up `data/`.
4. **Deferred feature:** health-app import (Apple Health / Google Fit) — needs its own scoping (platform/API/auth).

## Process notes
- Per-phase loop: brainstorm (Discussion + gym-goer Advocate, opus) → CONTRACT → build (backend + frontend agents) →
  review (codex `cursor-agent -p --mode ask --model gpt-5.3-codex-high` + Advocate) → fix → re-confirm. Keep it.
- `cursor-agent` model id is `gpt-5.3-codex-high` (NOT `gpt-5`). Review is read-only (`--mode ask`).
- The harness passing is NOT sufficient — it tests pure functions and mock sync; it has repeatedly missed
  render/UX/integration issues. Always open the actual screen / run svelte-check.
