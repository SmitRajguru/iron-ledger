- X1 — **FIXED**: `client/src/lib/analytics.js` now threads exercise metadata explicitly into `prsFor`/`isSessionPR`; no store `get(...)` and no undefined global usage in those paths.
- X2 — **FIXED**: `client/src/ExerciseCard.svelte` has `cardioConfirmingFromIndex` + reactive release only after `prefill.set_index` advances.
- X3 — **FIXED**: `client/src/ExerciseCard.svelte` captures `wasWarmup` and skips `startRest(...)` for warmup logs.
- X4 — **FIXED**: `client/src/lib/restTimer.js` clears store state, localStorage, and interval immediately at elapse (`rem <= 0`).
- X5 — **FIXED**: `client/src/ExerciseCard.svelte` starts rest only after successful `await queue(ev)`; failure path resets confirm state and does not start timer.
- X6 — **FIXED**: `client/src/ExerciseCard.svelte` computes `prSet = prsFor(folded, ex)` reactively once per dependency change (exercise/fold), then does cheap set lookup via `isSessionPR`.
- X7 — **FIXED**: `client/src/ExerciseCard.svelte` cardio validation enforces strictly positive `duration_s` or `distance_m`.
- X8 — **FIXED**: `client/src/ExerciseCard.svelte` rest controls are bumped to 44px min target.

- W1 — **NOT-FIXED**: `client/src/Today.svelte` still keeps duplicated inline session resolution (`loggedIds`, union/dedup, default routine resolution) instead of using shared `resolveSessionExercises`/`defaultRoutineIdForDate`; only load/save/routine-selection were shared.
- W2 — **FIXED**: `client/src/lib/session.js` default-routine fallback runs only when `loadSession(date)` is null (no persisted session).
- W3 — **FIXED**: `client/src/Watch.svelte` implements `confirmingFromIndex` guard and releases on index advance.
- W4 — **FIXED**: `client/src/Watch.svelte` uses shared `nextSetToLog(...)` and `lastSessionFor(...)`.
- W5 — **FIXED**: `client/src/Watch.svelte` includes focus + visibility + 60s interval midnight ticker.

- backend SPA fallback — **FIXED**: `server/app/main.py` serves `index.html` for non-API 404s while preserving API-path 404 behavior and real static asset serving.

**NEW bug(s) found**
- `client/src/Watch.svelte`: confirm latch can stick if user navigates to another exercise before the original exercise’s `prefill.set_index` advances; release condition is index-only on the *current* exercise, so `confirming` may remain true indefinitely.
- `server/app/main.py`: `/api` (exact path, no trailing slash) is treated as non-API by `not path.startswith("api/")` and may incorrectly fall back to SPA HTML instead of JSON 404.

**Phone Today session-persistence regression scan**
- No new regression found in the tested phone persistence flow itself (per-date load/save, selection ∪ logged, dedup, routine start/custom, skipped persistence).
