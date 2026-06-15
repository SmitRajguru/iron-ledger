# Phase 5a Contract — Rest Timer + PR Badges + Cardio Logging

Three independent deferred features, built in one round. Builds on Phases 1–3. Same conventions: append-only events,
pure reads over `foldLog`, weights canonical lb + display toggle, offline-first.

## 1. Rest timer
- **Exercise default rest:** add optional `rest_seconds` (int ≥ 0) to `exercise_defined`/`exercise_updated` payload
  (server accepts optional int). A global default (e.g. 120s) applies when an exercise has none; per-exercise override in
  the Exercises editor.
- **Behavior:** on set confirm (reuse the existing `setlogged` hook + the row slot left in 2b), start a countdown for that
  exercise's rest. Show remaining mm:ss in the row slot with −15s / +15s / skip controls. At 0 → a gentle alert
  (vibration via `navigator.vibrate` if available + a subtle visual; sound optional/muted by default). Runs fully offline
  (client-side timer).
- **Survives navigation:** persist the running timer (exercise_id + start timestamp + duration) in localStorage so a tab
  switch / reload doesn't lose it; recompute remaining from wall-clock on return; clear when it elapses or a new set starts.
- Only one active rest timer at a time (starting a new set resets it). No timer for cardio exercises.

## 2. PR badges
- **Pure analytics** (extend `analytics.js`, read over `foldLog`): for an exercise, a session is an **e1RM PR** if its
  session e1RM exceeds all prior sessions' e1RM, and a **volume PR** if its session volume exceeds all prior. Working sets
  only (warmups excluded); use the same capped-rep e1RM. Ignore the current session when comparing "prior".
- **Surface quietly** (Advocate: keep it non-intrusive): a small "PR" tag on the Today exercise card after a PR set is
  logged this session, and mark PR points on the Graphs e1RM/volume lines (e.g. a star/filled marker). No confetti, no
  streaks, no popups. A first-ever session is NOT a PR (nothing to beat).
- Pure function `prsFor(folded, exercise_id)` → set of PR session_dates (e1rm and/or volume); `isSessionPR(...)` for Today.

## 3. Cardio logging (finish the deferred path)
- **Entry:** replace the 2b "logging coming soon" placeholder on cardio (`type:"cardio"`) exercise cards with a real
  entry variant: **duration** (mm:ss input/steppers) and/or **distance** (number + a unit — km/mi display toggle reuse or
  a simple m/km/mi; store distance in meters canonical, `distance_m`). A cardio "set" = `set_logged` with
  `duration_s` and/or `distance_m` (no weight/reps). Per-set save state + warmup flag still apply (warmup rarely used for
  cardio but keep consistent). `set_index` as usual.
- **Server relax:** `set_logged` currently requires `unit` ∈ {lb,kg}. Make `unit` OPTIONAL (validate the enum only if
  present) so a cardio set (no weight/unit) validates. Require that a cardio-style set has at least one of
  `duration_s`/`distance_m`? The server has no exercise-type context (no referential integrity), so keep it lenient:
  just make unit optional; the CLIENT enforces "duration or distance required" for cardio entry. Keep weight/reps optional
  numbers (already are).
- **Cardio graphs:** `cardioSeries(folded, exercise_id)` → points `{session_date, duration_s, distance_m}` (sum or best
  per session — sum duration, sum distance across the day's cardio sets). Graphs screen: for a cardio exercise show
  duration and/or distance trend lines (reuse `LineChart`), NOT e1RM/volume. Distance shown in display distance unit.
- **Last-session display** for cardio: last duration/distance.

## Out of scope (5a)
Smartwatch (separate Phase 5b — needs platform decision). No changes to the strength logging loop beyond the cardio
card variant and the rest-timer slot.

## Server summary
- `exercise_*`: accept optional `rest_seconds` (int ≥ 0).
- `set_logged`: make `unit` OPTIONAL (enum-checked only when present); everything else unchanged. (PR badges + cardio
  graphs are pure client reads — no server work.)

## Done criteria
A rest countdown starts on set-confirm with skip/±15s and survives a tab switch; an exercise's e1RM/volume PR shows a quiet
tag in Today + a marked point on its graph; cardio exercises log duration/distance and show duration/distance trends —
all offline-first, reload rebuilds from the log.
