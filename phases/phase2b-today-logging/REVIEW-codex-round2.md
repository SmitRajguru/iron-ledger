- **C1 — FIXED** — `nextSetFromFold` now computes `set_index` as `Math.max(today set_index)+1` from folded (non-voided/non-deleted) sets, so tombstone holes no longer cause index reuse.
- **C2 — NOT-FIXED** — server tombstone validation is permissive (`deleted:true` + non-null `voids` + `exercise_id`) and delete persists through outbox drain, but `buildSetDeleteEvent` emits a superset payload (`exercise_id`, `session_date`, `set_index`, `deleted:true`) rather than the requested exact minimal shape.
- **C3 — FIXED** — `buildWarmupToggleEvent` copies stored payload verbatim and only flips `warmup`, so no `toDisplay -> toBase` round-trip corruption.
- **C4 — FIXED** — `confirming` guard blocks double-tap enqueue at stale `set_index`, and releases on fold advance (plus explicit release on `queue` throw), so no normal-path permanent lock.
- **H1 — FIXED** — logged event `session_date` is computed at tap time via `todayLocalDate()` in LA timezone, not from mount-time state.
- **M1 — NOT-FIXED** — last-session prefill uses positional access `last.sets[today.length]`, not explicit matching by next `set_index`, so it can violate strict “same `set_index` or empty” semantics.
- **M2 — NOT-FIXED** — `freshestBodyweight` clears pending when `projected.date >= pending.date`; on same-day bodyweight updates this can drop pending too early and return stale value immediately after Save.
- **U2 — FIXED** — `saveStateFor` checks `rejectedIds` before `synced`/`outbox`, and `ExerciseCard` renders rejected rows as error/retry, so rejected sets do not appear as saved.
- **Units/Auth/Login — FIXED** — `getBaseUnit()` is constant `"lb"`, `lbToBase` is effectively identity under fixed lb base, `auth.js` no longer carries `base_unit`, and `Login.svelte` has no base-unit selector.

**NEW bugs**
- **[HIGH] Midnight rollover index/prefill mismatch:** `ExerciseCard` derives `prefill`/`set_index` from `sessionDate` prop, while confirm logs `session_date` via fresh `todayLocalDate()`; if app stays open across midnight before log-state refresh, first post-midnight set can be logged with today’s date but yesterday-derived `set_index`/prefill values.
