# Phase 2a — Closeout (exercise library + seed catalog + named routines)

Status: **complete**. All review findings resolved + confirmed by codex (5 audit rounds).

## Delivered
- **Unit model:** canonical `base_unit` (signup, immutable, exposed via login + `/me`), client lb/kg display toggle,
  shared `units.js` (convert/format, `lbToBase` full-precision — no display rounding into storage).
- **Exercise library:** define custom + from a 54-entry curated catalog, edit (superseding `voids`), soft-archive.
  Muscle-group default prefills. Catalog empty-state → "add as custom".
- **Named routines** (replaced weekday-only templates): create/rename/archive, ordered exercises, handle-only
  drag-reorder, optional weekday-default assignment with conflict detection. Any routine startable any day (2b).
- **Server:** per-type payload validation on `/api/sync` (`exercise_*`, `routine_*`; `voids` required on updates),
  `rejected[]` without failing the batch; `base_unit` on profile.
- **Sync/projection hardening:** monotonic local `_enq` enqueue key (memoized awaited seeding), outbox folds in
  enqueue order, `logRevision` bumps on every outbox mutation, projection skips voided events + tombstone delete,
  rejected events dead-lettered (no retry loop).

## Review trail (codex gpt-5.3-codex + Advocate gym-goer)
- `REVIEW-codex.md` / Advocate → `REVIEW-summary.md`: 3 critical (offline ordering), highs (precision/voids), M1, A1 routine model, catalog/UX.
- `REVIEW-codex-round2..5.md`: iterated the critical sync/projection concurrency to a clean structural fix
  (synchronous `pendingRoutines` + single `effectiveRoutine` read-path + dedup/reconcile). Round 5 = FIXED, no new bug.

## Verified (fake-indexeddb harness + mock server, 20+ regression cases)
Offline superseding-edit ordering (UUID-order-independent), logRevision freshness, increment precision
byte-identical, named-routine define/reorder/archive/reload, A1 voids cannot resurrect + tombstone delete,
weekday conflict, unit conversion exact, rejected dead-letter no-loop, rapid-edit compose + failure isolation +
`_enq` monotonic under storage failure, add-then-reorder keeps the add, double-add dedups.

## NEEDS YOUR REAL-DEVICE CHECK (not harness/browser-proven)
- **Handle-only touch drag on a phone:** drag the ⠿ grip reorders; swiping the row body scrolls (the anti-fling fix).
  Verified at data layer + compile only.
- **Rapid real-finger interactions** (add-then-drag, double-tap-add) in the actual DOM — logic mirrored in harness,
  not driven in a browser.
- **Live backend integration:** all sync validated against the mock; run the dev proxy (client :5173 → server :8000)
  to exercise the real FastAPI path end-to-end.

## Next: Phase 2b — the Today logging loop
Carry-overs in `BRAINSTORM-phase2.md`: one-tap-confirm prefill, per-exercise increment steppers, per-set save
state on the row, frictionless +set / skip / swap / tap-any-card-out-of-order, last-session display, assisted-lift
UI (hide sign math), "next set to log" as a pure function (watch groundwork), rest-timer hook + row slot. Plus:
start-of-workout routine picker / one-off custom day (per the named-routine decision).
