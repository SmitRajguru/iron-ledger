- **C1 — FIXED:** `client/src/lib/sync.js` stamps outbox rows with `_enq`, `flush()` sorts by `_enq` and strips `_enq` before POST via `toEnvelope()`, and `client/src/lib/library.js` folds outbox by `_enq`; counter persistence is via `localStorage` (`wt_enq_counter`).
- **C2 — FIXED:** `client/src/lib/sync.js` bumps `logRevision` after confirmed `deleteMany("outbox", confirmedIds)`.
- **C3 — FIXED:** `client/src/lib/sync.js` bumps `logRevision` after rejected/dead-letter `deleteMany("outbox", rejectedIds)` in `handleRejected()`.
- **H1 — FIXED:** `client/src/Exercises.svelte` keeps exact `increment_base` on edit and only recomputes from display input when `incrementDirty` is true.
- **H2 — FIXED:** `client/src/lib/units.js` `lbToBase()` converts lb→base directly (no display rounding), and `Exercises.svelte` uses it for catalog/group defaults.
- **H3 — FIXED:** `server/app/events.py` enforces non-null UUIDv4 `voids` for both `exercise_updated` and `routine_updated`, not for `*_defined`.
- **M1 — FIXED:** `server/app/routes_auth.py` login returns `base_unit`, and `client/src/lib/auth.js` stores that user object; `client/src/lib/units.js` consumes `user.base_unit`.
- **A1 — NOT-FIXED:** named-routine UI/events are in place (`Routines.svelte`, `routine_defined/routine_updated`, drag handle selector), but `client/src/lib/library.js` projection does not implement “latest non-voided” semantics (it ignores `voids` and does latest-by-`routine_id`), so that contract clause is still unmet.

**NEW bugs introduced (severity-tagged):**
- **[HIGH] Lost-update race in `client/src/Routines.svelte`:** full-replace emitters (`addExercise`, `removeExercise`, `rename`, `toggleWeekday`, reorder finalize) read reactive `routine/orderedIds` snapshots that can be stale between rapid actions; consecutive edits can overwrite prior unsynced edits.
- **[MEDIUM] `_enq` fallback can collapse ordering in `client/src/lib/sync.js`:** if `localStorage` get/set throws, `nextEnq()` effectively resets to `1` repeatedly, causing `_enq` ties and reintroducing non-deterministic UUID-order folding/flush ordering.
- **[MEDIUM] Contract mismatch in `client/src/lib/library.js`:** routine projection ignores `voids`; malformed or divergent void chains can misproject despite the “latest non-voided” requirement.
