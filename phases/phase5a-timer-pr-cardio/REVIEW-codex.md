client/src/ExerciseCard.svelte:369 — CRITICAL — cardio logging lacks the strength-path index-advance guard, so a fast second tap can enqueue the same `(exercise_id, session_date, set_index)` and the later event overwrites the earlier set in projections (data corruption). fix: keep `cardioConfirming` latched until `prefill.set_index` increments (mirror `confirmingFromIndex` logic used in strength logging).

client/src/lib/restTimer.js:89 — HIGH — timer is not cleared at elapse (it persists at 0 with `alerted:true` and keeps a live interval/localStorage entry), violating “clear on elapse” and leaving stale active-timer state until skip/new set/reload. fix: after first zero alert, immediately clear state (`skipRest()` or equivalent) and stop ticking.

client/src/lib/analytics.js:156 — MEDIUM — `prsFor` is not pure over its inputs because it reads `libraryMap` via `get(...)`, which can yield transient false negatives (e.g., before library hydration) even when folded history exists. fix: pass exercise metadata/type explicitly into `prsFor`/`isSessionPR` and remove store access.

client/src/ExerciseCard.svelte:298 — MEDIUM — rest countdown starts before `queue(ev)` succeeds, so failed set writes still create/replace rest timers and desynchronize timer state from actual logged sets. fix: start rest only after successful enqueue (or roll back timer in the catch path).

client/src/ExerciseCard.svelte:365 — LOW — cardio validation accepts `distance=0` as satisfying “duration or distance,” allowing no-op cardio sets. fix: require at least one strictly positive metric (`duration_s > 0 || distance_m > 0`).
