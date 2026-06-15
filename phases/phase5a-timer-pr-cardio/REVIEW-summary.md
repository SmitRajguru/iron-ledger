# Phase 5a Review — Consolidated Fix List

Sources: `REVIEW-codex.md` (gpt-5.3-codex) + Advocate (gym-goer). The harness passed 21/21 but MISSED a render crash
(it tests pure functions directly; `vite build` doesn't flag undefined runtime globals in expressions). Process gap:
no `svelte-check`/lint + the Today screen was never opened after the change.

## CRITICAL
- **X1. Render crash — `get` not imported (analytics.js).** `prsFor` does `get(libraryMap)[exercise_id]` but only
  `derived` is imported → `ReferenceError: get is not defined`. `isSessionPR` runs reactively on every non-cardio Today
  card and `Graphs.svelte` calls `prsFor` → **Today + Graphs white-screen**. FIX (also resolves the purity finding M1):
  pass exercise metadata/type EXPLICITLY into `prsFor`/`isSessionPR` (caller supplies it from `libraryMap`) and remove
  the store `get(...)`. No store access inside the pure analytics fns.
- **X2. Cardio double-tap overwrite (ExerciseCard).** The cardio confirm path lacks the index-advance guard the strength
  path has (the C4 fix), so a fast second tap enqueues the same `(exercise_id, session_date, set_index)` and overwrites a
  set. FIX: latch `cardioConfirming` until `prefill.set_index` increments (mirror the strength `confirmingFromIndex`).

## High
- **X3. Rest timer fires on warmups (ExerciseCard).** `confirmSet` always `startRest`, even for warmup sets → a 120s timer
  after every warmup single. FIX: skip the rest timer when the logged set is a warmup (or use a short warmup rest).
- **X4. Timer not cleared on elapse (restTimer.js).** At 0 it persists with `alerted:true` + a live interval/localStorage
  entry. FIX: clear state immediately after the zero alert (stop ticking + drop persistence).

## Medium
- **X5. Rest starts before queue success (ExerciseCard).** Timer starts before `queue(ev)` resolves → a failed write still
  spawns/replaces a timer. FIX: start rest only after successful enqueue (or roll back in the catch).
- **X6. PR computed per-card-per-render (perf).** `isSessionPR` re-folds full history per card per render. FIX: compute
  `prsFor` once per exercise per fold (derived/Today-level) and pass down.

## Low
- **X7. Cardio `distance=0` accepted (ExerciseCard).** "duration or distance" lets a 0 through. FIX: require at least one
  STRICTLY POSITIVE metric (`duration_s>0 || distance_m>0`).
- **X8. Rest ±15/skip tap targets 36px** vs 48–56px elsewhere → sweaty mis-taps next to "skip". FIX: bump to ~44px min.

## PROCESS (do in this round)
- **Add `svelte-check` (or eslint `no-undef`) to `client/package.json` and run it** — this exact class (undefined global
  in a Svelte/JS expression) is invisible to `vite build`. Add a Today+Graphs render smoke step to done-criteria.

## Confirmed GOOD
Rest timer wall-clock survival (lock phone / app-switch → correct remaining), single timer, vibrate-once, per-exercise
rest plumbing; PR logic (beats-all-prior, first-not-PR, warmups excluded) — correct once X1 fixed; cardio entry
(mm:ss + distance, km/mi canonical meters, no weight/reps/unit, duration-or-distance), cardio graphs (no e1RM).
