# Phase 2a Review — Consolidated Fix List

Sources: `REVIEW-codex.md` (gpt-5.3-codex) + Advocate (gym-goer, opus). Ordered by severity.

## Critical — offline order/projection corruption (codex, same root)
- **C1. Outbox is id-keyed → no enqueue order.** `flush()` (`sync.js`) reads outbox via `getAll()` (UUID key order)
  and POSTs in that order, so the server assigns `_seq` out of enqueue order → superseding edits can invert.
  Projection (`library.js`) folds outbox unsorted → wrong latest-wins offline. **Fix:** add a monotonic LOCAL enqueue
  key to each outbox record (e.g. an auto-increment / client counter); POST in that order AND fold outbox in that
  order before merging with `events` (which sort by `_seq`).
- **C2. `logRevision` not bumped on confirmed delete.** After `deleteMany()` of confirmed ids in `flush()`, no
  `logRevision` bump → projection rebuilds (triggered by pull) can retain stale outbox winners/duplicates. **Fix:**
  bump `logRevision` after the confirmed delete.
- **C3. `logRevision` not bumped on reject delete** (`sync.js` ~286). Dead-lettered rejects stay visible in the
  projection until an unrelated event. **Fix:** bump `logRevision` after the rejected delete.

## High
- **H1. Increment precision drift on edit** (`Exercises.svelte`): edit seeds `increment_display = toDisplay()` (rounded
  0.5) then saves via `toBase()`, so re-saving (even just a name change) re-rounds the stored increment. **Fix:** keep
  the exact stored increment for the field; only convert on actual user change; display-round is display-only.
- **H2. Catalog/group defaults rounded before store** (`Exercises.svelte`): convert `default_increment` lb→base
  directly (full precision), not through display rounding — matters for kg users.
- **H3. `exercise_updated` doesn't require non-null `voids`** (`events.py`): contract says it MUST. Add a uuid-v4
  `voids` check for `exercise_updated`.

## Medium
- **M1. login response omits `base_unit`** (`auth.js` + backend `/api/auth/login`): `getBaseUnit()` falls back to lb
  until `/me`, mis-converting early writes for kg users. **Fix:** include `base_unit` in the login response too.

## Architectural — routine model (Advocate, USER-APPROVED change)
- **A1. Replace weekday-only templates with NAMED ROUTINES + optional weekday assignment.** Weekday-bound templates
  don't fit PPL/upper-lower rotations (drift off the calendar). New model: named routines (Push/Pull/Legs/A/B...),
  each an ordered exercise list, optionally assigned to weekday(s) as a default. At workout start (2b): use today's
  assigned routine, pick a different routine, or build a one-off custom day (ad-hoc session — never mutates a routine).
  Schema: `template_updated` → `routine_defined`/`routine_updated`. See updated CONTRACT-phase2a.md §Routines.

## Catalog / UX (Advocate, all USER-APPROVED to fix now)
- **Plank → timed/cardio** (currently `weighted`, 1–1 reps, +5lb; type locks after first set — fix before use).
- **Add missing entries:** cable bicep curl, machine chest press; fix "skull crusher" being aliased into Overhead
  Tricep Extension (separate movement) → give skull crusher its own entry.
- **Catalog empty-state → "Add '<query>' as custom"** prefilled, instead of dead-ending at "No matches".
- **Handle-only drag:** wire `svelte-dnd-action` so only the ⠿ handle starts a drag — scrolling a long day list must
  not fling exercises on a phone. Verify on device.

## Confirmed GOOD (no change)
Unit toggle model (display-only, single stored base_unit, immutable) — correct, no travel-to-kg-gym trap.
Soft-archive (hide from pickers, keep history) — correct. Catalog aliases (rdl/ohp/dl) work.

## Deferred to 2b (not 2a)
Assisted-lift increment polarity interpretation (less assist = stronger); "next set to log" pure function; per-set
save state on row. Carried in BRAINSTORM-phase2.md.
