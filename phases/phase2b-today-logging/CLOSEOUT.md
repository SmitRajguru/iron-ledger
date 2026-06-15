# Phase 2b — Closeout (the Today logging loop)

Status: **complete**. All review findings resolved + confirmed by codex (4 audit rounds). Completes the v1 core loop.

## Delivered
- **Today screen:** session-start routine resolution (today's assigned routine / pick another / one-off custom day —
  custom + swaps emit only `set_logged`, never routine events). Per-exercise cards.
- **One-tap-confirm logging:** prefill priority this-session → last-session SAME set_index → empty; per-exercise
  increment steppers + numeric keypad escape hatch; big sticky confirm; optimistic instant row update.
- **Per-set save state on the row:** draft → saved-locally ("saved on this phone") → synced → **error** (loud red, from
  rejected/dead-letter ids). A rejected set can't masquerade as saved.
- **Mid-session:** always-present draft row (= +set / drop / extra), one-tap skip (grey, reversible), swap from library
  (recents → same-muscle → rest), tap-any-card out-of-order, auto-scroll active card.
- **Warmup** 1-tap toggle (default working, de-emphasized, excluded from working prefill/last-session).
- **Assisted / weighted-bodyweight:** sign math hidden (assist N / +N chips → signed `added_weight`); `bodyweight_snapshot`
  frozen from freshest measurement (pending-aware); soft prompt/nudge, never blocks.
- **Minimal bodyweight capture** (`measurement` event) — full Body screen is Phase 3.
- **Shared `logging.js`:** pure `nextSetToLog`/`lastSessionFor`/`foldLog` + `buildSetEvent` — watch-reusable, no UI coupling.
- **Cardio:** "logging coming soon" placeholder (deferred). **Rest timer:** confirm hook + row slot only (deferred).
- **Server:** full `set_logged` + `measurement` validation; delete tombstones (`deleted:true`+`voids`) accepted.
- **Unit model simplified** (per `docs/UNIT-MODEL.md`): fixed hidden canonical = lb; `getBaseUnit()` constant; user toggles
  lb/kg display only; NO per-user base_unit (removed from signup/storage/me/login + Login selector).

## Review trail (codex gpt-5.3-codex + Advocate gym-goer)
- `REVIEW-codex.md` / Advocate → `REVIEW-summary.md`: 4 critical (set_index reuse, tombstone rejection, warmup-toggle
  weight corruption, confirm double-tap), midnight session date, prefill/snapshot, missing auto-scroll + per-set failure state.
- `REVIEW-codex-round2..4.md`: iterated to a clean state — single `effectiveDate` source, prefill-by-set_index,
  id-keyed bodyweight pending with supersede/reject escapes, minimal tombstone. Round 4 = FIXED, no new bug.

## Verified (fake-indexeddb harness, 16+ regression cases)
set_index = max+1 (no overwrite after delete-hole), warmup toggle byte-identical weights, confirm double-tap → one set,
session_date unified across midnight, prefill by set_index → empty when missing, bodyweight snapshot freshest +
supersede/reject escapes, per-set error state from rejected ids, tombstone delete stays gone after drain+reload,
units constant lb + lb/kg display exact, offline `_enq`-ordered sync, reload rebuilds today + last-session.

## NEEDS YOUR REAL-DEVICE CHECK (not harness/browser-proven)
- **Auto-scroll** (smooth behavior / alignment / not fighting manual scroll) on a phone.
- **Sticky confirm** actually clearing the on-screen numpad (device/keyboard-specific).
- **Double-tap timing** on the real DOM button; general tap ergonomics (keypad, mid-typing not clobbered).
- **Live local-midnight rollover** in a long-open session (structurally correct; not observed live).
- Run the dev proxy (client :5173 → server :8000) to exercise the real FastAPI path (all sync was mock-tested).

## Next: Phase 3 — analytics
Per-exercise e1RM (Epley) + volume graphs, body-composition screen (bodyweight/muscle mass/fat%/fat mass) + trends,
double-progression SUGGESTIONS surfaced in Today. All read through `foldLog` (warmup-excluded, frozen
`bodyweight_snapshot`) — keep derived numbers in the pure layer, never recompute against live bodyweight.
