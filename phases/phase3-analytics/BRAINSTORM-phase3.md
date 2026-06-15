# Phase 3 Brainstorm — synthesis (Discussion + Advocate, opus)

## Architecture (agreed)
- **New `client/src/lib/analytics.js`** — pure functions over `foldLog` output (NOT extending logging.js; keeps the
  watch-reusable logging core lean). Derived-on-read, no IndexedDB cache (single user, few-thousand sets; memoize
  in-memory by `(exercise_id, logRevision)` only if ever needed).
- **One reusable `LineChart.svelte`** — hand-rolled inline SVG (no chart library; offline PWA + tiny bundle + crisp +
  themeable + reviewable). Props `{points:[{x,y}], yLabel, formatY, formatX}`; handles null gaps, ~4-5 ticks, tap readout.
  Reused by lift graphs + all body-comp metrics.
- **No new server endpoints.** Only measurement validation tweak (below).

## Computation (analytics.js, pure)
- `effectiveLoad(set, exercise)`: weighted → `set.weight`; bodyweight → `bodyweight_snapshot + (added_weight ?? 0)`
  (assist negative); **null snapshot → null (unusable)**. Never use live bodyweight (frozen snapshot only).
- **e1RM per session** = max over WORKING sets of `load*(1+reps/30)` (Epley). Warmups excluded. Guard load>0, reps>0.
  **Cap reps fed to Epley at ~12** (Advocate: high-rep sets inflate fake 1RMs); flag/distinguish single-rep-derived points.
- **Volume per session** = Σ working sets `effectiveLoad*reps`; null when no usable set (sparse, not 0).
- Cardio → no e1RM/volume (cardio logging deferred → no data; defer cardio graphs).

## Graphs (lift)
- Per-exercise series `points:[{session_date, e1rm, volume}]` (base lb), sorted by date.
- **e1RM is the hero line** (default); volume secondary (separate chart/toggle, NOT dual-axis on phone). Top-set as dots/context.
- **Default window = 12 weeks**; toggles 6mo/1y/all-time (all-time opt-in, never the landing view).
- Null points → line GAP (never 0/interpolated). Convert lb→display at render (units.js); ticks in display units.
- Tooltip shows the source set ("102.5×6, working, May 12"). Distinguish clean rep-PR vs single-rep e1RM artifact.
- Bodyweight lifts: also surface assist/added-weight progression as a secondary line so a cut (lower BW → lower
  effective load) doesn't read as a strength loss; hover note "computed off bodyweight from [date]" + stale (>30d) handling.

## Body composition
- `measurement` payload: `{date, bodyweight?, muscle_mass?, body_fat_pct?, fat_mass?, unit:"lb"}` — all metrics optional,
  ≥1 required (UI). Weights base lb; bf% unitless (not converted).
- **fat_mass derive-on-read** = `bodyweight*body_fat_pct/100` when not explicitly entered (explicit wins). Symmetric:
  derive bf% from fat_mass+bodyweight too. Never store derived values.
- **foldLog extended** to expose full `measurements[]` history (keep `latestBodyweight` as-is for the 2b assisted path).
  Multiple measurements same date → plot all (append-only honesty); latest-by-event-order for "current" readout.
- **Bodyweight headline = trailing moving average** (7-day), raw dots faint behind — daily weight is noise. Muscle/fat%
  trend-only (consumer bioimpedance is noisy; no precise single-number callout).
- Body screen: log form (4 optional fields, date default today, fat_mass shows derived placeholder) + 4 trend charts.
  Absorbs the 2b minimal bodyweight capture (same event). Edit/delete via voids.

## Progression (double progression, DESIGN §6)
- Pure `progressionSuggestion(folded, exercise)` over the LAST working session.
- Rule: hit `rep_range_high` on ALL working sets → `add_weight` (+increment, reset to `rep_range_low`); assisted (last
  session added_weight<0) → `reduce_assist` (−increment); else → `add_reps` (+1). First time → suggest range, no delta.
  Missing rep range / increment / cardio → no suggestion (stay quiet, don't fabricate).
- **Only suggests on success; never scolds** → a missed top-of-range or a deload week simply produces no "add weight"
  suggestion (deloads handled gracefully without an explicit deload flag in v1).
- **Per-exercise "hold progression" toggle** (rehab/accessory/intentional hold) — set once, silent thereafter.
- Surfaces in Today as a muted inline hint beside the PROVEN-weight prefill, with optional one-tap "apply". **Never
  auto-decides the working weight** (the tested 2b prefill stays the safe default). Goes quiet after the first working set.

## Server
- Relax `_validate_measurement_payload`: bodyweight no longer strictly required → require ≥1 of
  {bodyweight, muscle_mass, body_fat_pct, fat_mass} present+numeric; add `0 ≤ body_fat_pct ≤ 100` range check. ~Few lines.

## Anti-features (Advocate — do NOT build)
Muscle-group volume pie/heatmap, total-tonnage vanity number, estimated calories, readiness/intensity gauges,
streaks/gamification/confetti, RPE/velocity charts, tape measurements, predictive "you'll bench X by August",
user comparisons/percentiles, combined dual-axis mashup dashboards. Rule: if you can't act on a chart, it doesn't ship.

## Sequencing — ADVISORS SPLIT (user to decide)
- Advocate: **graphs FIRST** (the payoff/reward for logging), then progression, then body-comp.
- Discussion: **body-comp first** (smallest, builds the shared LineChart, barely touches logging core), then graphs, then progression.
- Both agree progression goes LAST (only piece touching the tested Today loop) and recommend a 3a/3b/3c split over one build.
