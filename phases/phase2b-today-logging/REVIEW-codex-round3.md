1. **FIXED** — `client/src/ExerciseCard.svelte` uses one reactive `effectiveDate` for `todaySets`, `lastSessionFromFold`, `nextSetFromFold` prefill, and `buildSetEvent(...session_date: effectiveDate)`, and the old `sessionDate` prop path is gone.  
2. **FIXED** — `client/src/lib/logging.js` prefill now matches last-session by `set_index` (`find((s) => s.set_index === set_index)`) and cleanly falls to empty when missing (no array-position or last-set fallback).  
3. **NOT-FIXED** — M2 is only partial: pending is id-keyed and exact-id clear works, but `freshestBodyweight()` always returns pending while pending exists, so a different strictly newer projected measurement does **not** supersede it.  
4. **FIXED** — C2 path is correct: `buildSetDeleteEvent` emits minimal `{exercise_id, deleted:true}` + `voids`, `foldLog` removes by `voids`, and `server/app/events.py` tombstone validation accepts that minimal shape with required non-null `voids`.  

**NEW bug:** `freshestBodyweight()` can get stuck on stale pending if that pending id never appears in projection (e.g., rejected/failed enqueue), because pending is only cleared on exact-id match and has no newer/timeout/failure escape path.
