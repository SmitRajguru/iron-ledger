# Phase 3 Contract — Analytics (graphs + body comp + progression)

Builds on Phases 1/2. Full rationale + edge cases: `BRAINSTORM-phase3.md` (read it). Built as ONE round.
All analytics are PURE reads over the existing `foldLog` output; weights stored canonical lb, displayed via units.js toggle.

## Scope
1. Per-exercise lift graphs: estimated 1RM + total volume over time.
2. Body composition: log + trend bodyweight / muscle mass / body-fat % / fat mass.
3. Progression suggestions (double progression) as a muted Today hint.

## 1. Computation — new `client/src/lib/analytics.js` (pure, over foldLog output; NO IndexedDB cache)
- `effectiveLoad(set, exercise)`: weighted → `set.weight`; bodyweight → `bodyweight_snapshot + (added_weight ?? 0)`
  (assist negative); **null snapshot → null** (unusable; never live bodyweight, never 0).
- `sessionE1RM` = max over WORKING sets (`!warmup`) of `load*(1+min(reps,12)/30)` — **cap reps at 12** so high-rep sets
  don't post fake 1RMs. Guard load>0, reps>0. null when no usable working set. Track whether the best came from a
  single-rep set (for distinct marking) and the source set (for tooltip).
- `sessionVolume` = Σ working sets `effectiveLoad*reps`; null when none usable (sparse, not 0).
- `exerciseSeries(exercise_id)` → `{type, points:[{session_date, e1rm, volume, topSet, fromSingle}], empty}` sorted by date.
- Cardio → no e1RM/volume (defer cardio graphs).
- Pure functions; consume `logState.folded` via a `derived` store. Memoize in-memory by `(exercise_id, logRevision)` only if needed.

## 2. `client/src/lib/LineChart.svelte` — hand-rolled inline SVG, NO chart library
Props `{points:[{x,y}], yLabel, formatY, formatX, secondary?}`. Single line + dots, ~4–5 nice ticks, null → line GAP
(not 0/interpolated), 1 point → dot+label (no line), tap/hover crosshair + value readout, optional secondary series line.
CSS-themeable, retina-crisp, accessible DOM. Reused by lift graphs + all body-comp metrics. Keep ~150–250 lines.

## 3. Lift Graphs screen
- Pick an exercise → **e1RM hero chart** (default) + **volume** (separate chart/toggle, NOT dual-axis). Convert lb→display
  at render; ticks in display units. Top-set shown as context on the e1RM points.
- **Default range = 12 weeks**; toggles 6mo / 1y / all-time (all-time opt-in, never the landing default).
- Tooltip shows the source working set ("102.5×6, May 12"). Distinguish a clean rep-PR point from a single-rep e1RM
  artifact (e.g. hollow/dashed marker for `fromSingle`).
- Empty state when no working sessions ("Log a few sessions to see trends").
- **Bodyweight exercises:** also plot assist/added-weight progression as a secondary line (so a cut → lower effective
  load doesn't read as a strength loss); hover note "computed off bodyweight from [date]"; >30-day-stale snapshot noted.

## 4. Body composition
### `measurement` payload (final)
```json
{ "date":"YYYY-MM-DD", "bodyweight":null|num, "muscle_mass":null|num,
  "body_fat_pct":null|num, "fat_mass":null|num, "unit":"lb" }
```
- All metric fields optional + independently nullable; **UI requires ≥1**. Weights base lb (convert from display on entry);
  `body_fat_pct` unitless (not converted).
- **Derive-on-read, never store derived:** `fat_mass = bodyweight*body_fat_pct/100` when not entered (explicit wins);
  symmetric — derive `body_fat_pct` from fat_mass+bodyweight too.
- Edit/delete a measurement = superseding event (`voids`); carry `__src_id` in the projection.
### foldLog extension
- Expose full `measurements:[{date, bodyweight, muscle_mass, body_fat_pct, fat_mass, __src_id}]` (non-voided, sorted by
  date). **Keep `latestBodyweight` exactly as-is** (the 2b assisted-snapshot path must not change). Multiple same-date
  measurements: plot all for trends; latest-by-event-order for any "current" readout.
### Body screen
- Log form: 4 optional numeric inputs (date default today, display-unit aware); fat_mass field shows the derived
  placeholder (overridable). Absorbs the 2b minimal bodyweight capture (same event; keep the Today entry point).
- **Bodyweight headline = trailing 7-day moving average line, raw dots faint behind it.** Muscle mass / fat% / fat mass
  as trend lines (no precise single-number callout — bioimpedance is noisy). Same 12wk/6mo/1y/all range control.

## 5. Progression (double progression) — muted hint + one-tap apply
- Pure `progressionSuggestion(folded, exercise)` over the LAST working session:
  - hit `rep_range_high` on ALL working sets → `add_weight` (+increment, target reps = `rep_range_low`); if last session
    was assisted (added_weight<0) → `reduce_assist` (−increment); else → `add_reps` (+1 rep, hold weight).
  - first time / no history → suggest the rep range, no delta. Missing rep range or increment, or cardio → no suggestion.
  - **Only suggests on success; never scolds** (a missed top-of-range or deload week → simply no add-weight suggestion).
- **Per-exercise "hold progression" toggle** (stored as a field on `exercise_updated`, e.g. `hold_progression:true`) →
  silent thereafter.
- Today integration: a MUTED inline hint beside the proven last-weight prefill ("hit 3×12 — try +5 lb → 6 reps"), with an
  optional **one-tap "apply"** that sets the draft row to the suggestion. **Never auto-changes the prefill.** Hint goes
  quiet once the first working set of that exercise is logged this session.

## 6. Server
- Relax `_validate_measurement_payload` (events.py): drop strict `bodyweight`-required → require **≥1** of
  {bodyweight, muscle_mass, body_fat_pct, fat_mass} present + numeric; add `0 ≤ body_fat_pct ≤ 100` range check.
  If `hold_progression` is added to exercise payloads, accept it as an optional bool. No new endpoints.

## 7. Do NOT build (Advocate anti-features)
Tonnage vanity totals, estimated calories, readiness/intensity gauges, streaks/gamification, muscle-group pie/heatmaps,
RPE/velocity, tape measurements, predictive projections, user comparisons, dual-axis mashup dashboards. If you can't act
on a chart, it doesn't ship.

## 8. Done criteria
Open an exercise → see its e1RM + volume trends (12wk default, warmups excluded, capped-rep e1RM, source-set tooltip,
null gaps, bodyweight-lift assist line); log body comp → see bodyweight moving-average trend + the other metrics with
derived fat_mass; in Today, earned exercises show a muted progression hint with one-tap apply + a hold-progression toggle.
All pure client reads (except the small measurement-validation relax); offline-first; reload rebuilds everything from the log.
