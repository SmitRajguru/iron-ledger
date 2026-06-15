1. **FIXED** — `client/src/Today.svelte` applies `uniq()` at `hydrate`, `startRoutine`, and `sessionExerciseIds = uniq([...selection, ...loggedIds])`, so the keyed `{#each sessionExerciseIds as exId (exId)}` path is protected from duplicate keys across persisted/routine/logged sources.

2. **FIXED** — `client/src/ExerciseCard.svelte` now skips focused fields in `syncDisplayFromBase()` during unit toggle while still converting unfocused fields, and `confirmSet()` logs canonical `draftWeightBase`/`draftAddedBase` (full-precision base) so F4 precision is preserved.

**NEW bug:** `client/src/ExerciseCard.svelte` blur handlers only clear `weightFocused`/`addedFocused` and do not re-sync display from base, so toggle-while-focused then blur-without-edit can leave stale old-unit text under the new unit label (stored base remains canonical, but UI can mislead before next re-sync).
