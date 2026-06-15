1) **W1 full share:** **REGRESSION** — `Today.svelte` now uses shared `resolveSessionExercises(...)` + `defaultRoutineIdForDate(...)` with no inline union/dedup/default logic, but `hasSession = resolved.hasSession` makes default-fallback days look like an already-started session (skips start-card flow), so 2b session-start/persistence behavior is changed.

2) **Watch latch:** **FIXED** — `Watch.svelte` latches on `(confirmingExId, confirmingFromIndex)`, clears when exercise changes or same exercise `set_index` advances, and `prev()/next()` call `clearConfirmLatch()`, so mid-confirm navigation won’t stick and same-exercise double-tap is blocked to one set.

**NEW bug:** In `Today.svelte` + `session.js`, an uncommitted default-fallback session can collapse after first log (fallback stops once `loggedIds` exists, selection was never committed), so the routine’s remaining exercises can disappear unexpectedly.
