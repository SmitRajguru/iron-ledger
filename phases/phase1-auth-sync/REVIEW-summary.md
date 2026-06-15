# Phase 1 Review — Consolidated Fix List

Sources: `REVIEW-codex.md` (gpt-5.3-codex, correctness/security) + `REVIEW-advocate.md` (gym-goer UX).
Ordered by severity. "Fix now" = before Phase 2 builds on this pipe.

## Critical — fix now
- **C1. `_seq` data loss (storage.py).** `_seq` recomputed by lexicographic month-file order → appending an
  older-month event renumbers prior events, making new events invisible to `since`-cursor pulls. **Fix:** persist
  an immutable per-user append-order counter at write time (`seq.json` or monotonic line counter that never
  re-derives from file order); query by stable seq.

## High — fix now
- **H1. Username path traversal (storage.py).** `username` used unsanitized in `data/<username>/` paths →
  `../` escapes DATA_DIR. **Fix:** strict username regex at API boundary (`^[A-Za-z0-9_-]{3,32}$`) + `resolve()`
  and assert path stays under DATA_DIR before mkdir/open.

## Trust trio — fix now (advocate, all UX-critical)
- **T1 (F1). Distinct `error` sync state.** flush/pull failures while online → `kind:'error'` (red, "Sync failed —
  will retry"), distinct from amber pending. Today errors are swallowed → silent failure.
- **T2 (F2 + #6). 401 / network handling.** flush/pull 401 → mark session expired, prompt re-login WITHOUT
  discarding outbox. `me()` on app load: distinguish real 401 (→ Login) from network failure (→ stay optimistically
  logged in / show cached shell). Currently any failure dumps to Login = gym lockout.

## Medium — fix now or early Phase 2
- **M1. Sliding session not refreshed (auth.py).** Cookie only re-issued on login/signup; authed reads don't extend
  expiry → "30-day sliding" is really fixed. **Fix:** re-issue cookie on authed requests.
- **M2. Non-atomic outbox→events (sync.js).** Confirmed ids deleted from outbox before persisted to events; if
  `pull()` fails they're in neither store. **Fix:** finalize delete only after events write succeeds (or intermediate "acked" state).
- **M3. IndexedDB upgrade wipes events (db.js).** `onupgradeneeded` always deletes `events` → future version bump
  erases synced history. **Fix:** gate destructive migration on `oldVersion` (only recreate from legacy schema).

## Low — fix opportunistically
- **L1. sync.js listeners leak** — `stopSync()` doesn't remove online/offline listeners; relogin accumulates handlers. Remove on stop.
- **L2. setup.sh secret window** — `chmod 600` after write; set `umask 077` before creating `.env`.
- **L3. Login papercuts** — show/hide password toggle, `autocorrect=off spellcheck=false` on username, focus mgmt on failure, "Offline · saved locally" label, "Saved · n to sync" wording.

## Deferred to Phase 2 planning (advocate forward-looking)
Per-set save confirmation hooks; keep `unit` in every event; bodyweight staleness warning for assisted-lift e1RM;
ad-hoc swap/reorder defaults to per-session (not template rewrite); per-set `warmup` flag for progression logic;
rest-timer pull-forward vote.
