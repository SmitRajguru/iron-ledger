# Phase 3 — Closeout (analytics)

Status: **complete**. All review findings resolved + confirmed by codex (3 audit rounds). Completes the v1+analytics build.

## Delivered
- **`analytics.js`** (pure over foldLog): `effectiveLoad` (frozen snapshot + signed added; null→null), `sessionE1RM`
  (max Epley over working sets, reps capped at 12, `fromSingle` flag, source set), `sessionVolume`, `exerciseSeries`,
  `progressionSuggestion`, fat_mass/bf% symmetric derive, `movingAverage` (calendar-day window). No IndexedDB cache.
- **`LineChart.svelte`** — hand-rolled inline SVG (no chart lib): null→gap, nice ticks, single-point, tap readout, secondary line.
- **Lift Graphs:** e1RM hero + volume (separate, no dual-axis), 12-week default (all-time opt-in), source-set tooltip,
  single-rep points marked, empty states; bodyweight lifts show an assist/added secondary line + a REAL stale-snapshot
  note (fires only when the snapshot's measurement date is >30d before the session; `bodyweight_snapshot_date` now in the event).
- **Body composition:** log form (4 optional metrics, ≥1 required, derived fat_mass placeholder, date default today),
  edit/delete via tombstone; bodyweight headline = 7-day moving average with faint raw dots; muscle/fat%/fat-mass trend lines.
- **Progression (double progression) in Today:** muted hint beside the proven prefill, one-tap apply, one-tap mute
  (per-exercise `hold_progression`); rules — hit-top+inc→add_weight, assisted+inc→reduce_assist, hit-top+no-inc→add_reps,
  first_time (range only), miss→silent (never scolds; deload-safe); strictly-before-date cutoff so backfilling a past day
  never uses a later session. Never auto-changes the prefill; quiet after the first working set.
- **Server:** measurement relax (≥1 metric, bf% 0–100), measurement tombstone, optional `bodyweight_snapshot_date`,
  optional `hold_progression`. No new endpoints.
- **Anti-features kept OUT:** tonnage/calories/readiness/streaks/pie-charts/RPE/predictions/dual-axis mashups.

## Review trail (codex gpt-5.3-codex + Advocate gym-goer)
- `REVIEW-codex.md` / Advocate → `REVIEW-summary.md`: measurement-delete break, missing add_reps rule, fake staleness
  note (Advocate's "worst issue"), first_time gating, message interpolation.
- `REVIEW-codex-round2..3.md`: fixes confirmed; closed 2 new edges (deleted-pending-bodyweight snapshot, progression
  future-session-on-backfill). Round 3 = FIXED, no new bug.

## Verified (fake-indexeddb harness, 21 regression cases)
e1RM rep-cap + warmup exclusion + fromSingle + null gaps, volume, assisted effective load + cut not read as loss,
fat_mass/bf% derive, 7-day moving average over gappy data, all progression branches + silent-on-miss + hold + date
cutoff + apply, measurement tombstone round-trip + latestBodyweight fallback, deleted-BW never snapshotted, real stale
note (50d fires / 1d + missing silent), display lb→unit conversion. `latestBodyweight` (2b assisted path) unchanged.

## NEEDS YOUR REAL-DEVICE CHECK (not harness/browser-proven)
- LineChart tap/tooltip/crosshair on touch, secondary assist line + hollow single-rep markers, stale-note rendering.
- Graphs exercise picker + e1RM/volume + range toggles; Body screen entry/edit/delete + derived placeholder.
- Today progression hint placement, one-tap apply populating the draft, one-tap mute silencing it.

## Roadmap status
v1 core loop (Phases 0–2b) + analytics (Phase 3) COMPLETE. Remaining per ROADMAP: Phase 4 deploy (Cloudflare tunnel —
user-owned) and Phase 5+ (smartwatch, health import, rest timer, PR badges) — all deferred.
