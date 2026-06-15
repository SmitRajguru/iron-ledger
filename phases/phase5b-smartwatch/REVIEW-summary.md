# Phase 5b Review — Consolidated Fix List (codex gpt-5.3-codex)

Several findings are earlier PHONE fixes not carried into the new watch view (double-tap guard, midnight refresh) +
the "shared session resolver" not actually being shared.

## High
- **W1. Today doesn't use the shared `session.js` (Today.svelte).** Phone Today still has its own `SESSION_KEY`/load/
  save/uniq/hydrate logic; 5b extracted `session.js` but Today wasn't refactored to it → not actually shared, future
  divergence. FIX: refactor Today to import + use `session.js` (loadSession/saveSession/defaultRoutineIdForDate/
  selectionFromRoutine/resolveSessionExercises) for all session resolution; delete the duplicated inline logic.
- **W2. Empty-custom-day fallback divergence (session.js).** The default-routine fallback runs whenever `selection` is
  empty — even for an intentional `started:"custom"` empty day → watch shows the default routine while phone shows the
  custom-empty day. FIX: apply the default-routine fallback ONLY when there is no persisted session (persisted
  `started == null`), not merely when selection is empty.
- **W3. Watch confirm double-tap race (Watch.svelte).** `confirming` clears right after `queue()` returns, not after
  `prefill.set_index` advances → a quick second tap enqueues another event at the same stale set_index (dup/overwrite).
  FIX: mirror the phone `confirmingFromIndex` guard — release only when the fold recompute advances past the confirmed index.

## Medium
- **W4. Watch uses fold internals (Watch.svelte).** Uses `nextSetFromFold`/`lastSessionFromFold` directly instead of the
  shared live-store APIs `nextSetToLog(exerciseId, today)` / `lastSessionFor(exerciseId, today)`. FIX: switch to those.
- **W5. Watch midnight date not refreshed (Watch.svelte).** `today` re-pins only on `$logState` change → an idle watch
  page across local midnight logs to the previous date. FIX: same focus/visibilitychange/interval ticker as Today.

## Confirmed GOOD
Watch reuses buildSetEvent + queue + auth cookie (no bypass), prefill priority, assisted signed added_weight, prev/next
nav, offline queue, lazy chunk (not in phone bundle).
