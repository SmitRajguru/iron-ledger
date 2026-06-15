# Phase 2b Review — Consolidated Fix List

Sources: `REVIEW-codex.md` (gpt-5.3-codex) + Advocate (gym-goer, opus). Ordered by severity.
This fix round ALSO folds in the unit-model simplification (`docs/UNIT-MODEL.md`).

## Critical (data correctness)
- **C1. `set_index` reuse (logging.js).** Next index uses `today.length`; after a tombstone leaves a hole, a new set
  reuses an existing index → overwrites a different set in the projection. **Fix:** next index = `max(existing set_index)+1`
  (over non-voided sets for that exercise+date), not count.
- **C2. Tombstones rejected by server (events.py).** `_validate_set_logged_payload` always requires `unit`+`warmup`, so a
  DELETE tombstone (`deleted:true` + `voids`, minimal payload) is rejected → deleted sets reappear after outbox drains.
  **Fix (backend + client must agree):** a tombstone = `set_logged` with `payload.deleted === true` + non-null `voids` +
  `exercise_id` (uuid). Validator: if `deleted===true`, require only `exercise_id`(uuid) and that `voids` is a uuid; skip
  unit/warmup/etc. Client `buildSetEvent` delete path must emit exactly this shape.
- **C3. Warmup-toggle corrupts stored load (ExerciseCard).** Toggling warmup reconstructs weights via
  `toDisplay()->toBase()` (display-rounded) → mutates previously logged weight/added_weight. **Fix:** preserve the exact
  stored base values; only the `warmup` flag changes; never round stored numbers on a flag toggle.
- **C4. Confirm not click-locked (ExerciseCard).** Rapid double-tap enqueues multiple events with the same stale
  `set_index` → set loss/dup. **Fix:** disable/guard Confirm with an in-flight flag from tap until the fold reflects the
  new set (debounce).

## High
- **H1. `sessionDate` captured once at init (Today.svelte).** Logging across local midnight keeps writing the prior LA
  date → sets misfiled into yesterday's session. **Fix:** compute `sessionDate` (America/Los_Angeles) at log time, not once at mount.

## Medium
- **M1. Prefill fallback wrong (logging.js).** When last-session has no matching `set_index`, code falls back to the last
  set instead of the contract's empty/default branch. **Fix:** match contract priority exactly (this-session → last-session
  SAME index → empty).
- **M2. Bodyweight snapshot stale right after save (Today.svelte).** Bodyweight `measurement` queues async; an assisted set
  logged before rebuild snapshots stale/null. **Fix:** read freshest bodyweight synchronously (pending-aware), like the
  routine pending pattern.

## Trust / UX (Advocate — high user impact)
- **U1. Auto-scroll active exercise into view — MISSING (contract-required).** Daily friction killer: scrolling a growing
  card stack to find the next lift. Use the `setlogged` dispatch hook → `scrollIntoView` the next non-skipped/active card.
- **U2. LOUD red per-set failure state — MISSING (contract-required).** `saveStateFor` has only draft/saved/synced and its
  fallback masquerades a failure as "saved" forever. Add a 4th `error` state: cross-ref the row's event id against the
  rejected/dead-letter ids → render "didn't save — tap to retry" in `var(--danger)` on the row.
- **U3. Sticky confirm reachable with keyboard up.** Confirm is in-flow; with the numpad open it can be covered. Make it
  reachable (sticky within card viewport, or scroll into view on field focus). Contract says fixed-position.
- **U4. Human recency on Last.** Show "6 days ago" (use existing `daysSince()`), not the raw ISO date.
- **U5. (minor) Recents in Swap sheet** — currently same-muscle only. Acceptable to defer; do if cheap.

## Hardening (forward to Phase 3)
- **P1. Dev test-event emits a junk `set_logged`** ({note,at}, no exercise_id). `foldLog` skips it, but it still pushes into
  the real `events` store. Ensure it can't leak into a synced prod log before Phase 3 reads everything.
- Keep ALL Phase 3 numbers reading through `foldLog` (warmup exclusion + frozen `bodyweight_snapshot` already correct there).

## Unit-model simplification (USER decision — `docs/UNIT-MODEL.md`)
- Fixed hidden canonical = lb; user toggles lb/kg display only; NO per-user base_unit.
- **Backend:** remove `base_unit` from `SignupBody`, `storage.create_user`, users.json, `/api/auth/login` + `/me` responses.
- **Client:** `units.js getBaseUnit()` → constant `"lb"`; `auth.js` stop consuming base_unit; remove the signup base-unit
  selector in `Login.svelte`. Events still store lb; the display toggle is the only user-facing unit control.

## Confirmed GOOD (no change)
Prefill priority this-session→last (the matching branch), steppers stepping by exercise increment, mid-typing not clobbered
by background rebuild, assisted sign-math hidden + polarity, skip/swap session-local (no routine leak), tap-any-card
out-of-order, +set via always-present draft row, shared pure logging module (watch-ready).
