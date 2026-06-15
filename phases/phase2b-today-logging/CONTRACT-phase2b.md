# Phase 2b Contract — The Today Logging Loop

Builds on Phase 1 (envelope + sync + auth) and Phase 2a (library, named routines, units, projections).
Brainstorm + rationale: `phases/phase2a-library-templates/BRAINSTORM-phase2.md` (§"Advocate's 2b logging-loop requirements").
This is THE core UX — optimize for one-tap logging with sweaty hands and bad signal.

## Scope (2b)
The **Today** screen: pick the session's routine, log sets per exercise (weight/reps), mid-session edits, per-set
save state, last-session display, assisted-lift entry, minimal bodyweight capture. Cardio logging DEFERRED.
Graphs, body-comp full screen, and progression SUGGESTIONS are Phase 3.

## Session start (routine resolution)
On opening Today: resolve `today's weekday (0=Mon)` → assigned default routine (from the 2a `weekday→routine` map).
- If a default exists → load it (pre-filled, editable for the session).
- If none / conflict → prompt to **pick a routine** (from active routines) or **build a one-off custom day**.
- Always offer "start a different routine" + "custom day" regardless of default.
- A **one-off custom day** = pick exercises ad hoc; it emits only `set_logged` events for today's `session_date`,
  NEVER a routine event. Routines are never mutated by a session (hard rule).

## `set_logged` event payload (envelope unchanged; weights in base_unit)
```json
{
  "exercise_id": "uuid",
  "session_date": "2026-05-31",   // LOCAL calendar date (America/Los_Angeles), groups the session
  "set_index": 0,                  // 0-based order within (session_date, exercise_id) as performed
  "unit": "lb",                    // = base_unit (constant, self-describing)
  "warmup": false,                 // default false (working); 1-tap toggle
  "weight": 185,                   // base_unit; null for pure bodyweight
  "reps": 8,
  "added_weight": 0,               // signed: + = added (weighted BW), − = assist; present when uses_bodyweight
  "bodyweight_snapshot": 178       // base_unit; frozen from latest measurement at log time; nullable
}
```
- Editing a logged set = emit a superseding `set_logged` with `voids` = prior id. Deleting = tombstone (`voids`).
- All weights ENTERED/DISPLAYED in the display unit (2a `units.js`), STORED in base_unit (convert on entry, full precision).

## Logging loop (the priority)
- **One-tap confirm via prefill**, in priority order: (1) the prior set logged THIS session for this exercise →
  (2) last-session's matching `set_index` → (3) empty/exercise target. Straight-sets day = sets 2,3 are confirm taps.
- **Per-exercise `increment` steppers** (− / value / +) for weight and reps; tapping the value opens a numeric pad
  (`inputmode="decimal"`), never force-popped. Weight step = the exercise's `increment` (in display unit).
- **Big, thumb-reachable, fixed-position confirm button.** Optimistic instant row update on confirm.
- **Per-set save state ON THE ROW** derived from store membership by event id: `draft` (no event) → `saved-locally`
  (id in `outbox`, label "saved on this phone") → `synced` (id in `events`). Failure = loud red "didn't save — retrying".
  Reuse the Phase 1 outbox/events stores; this is a read, no new persistence.
- **Auto-scroll the active exercise into view.**

## Mid-session (must feel frictionless)
- **+ set** (drop/extra): one tap adds a set row prefilled from the previous set; adjust with stepper taps.
- **Skip exercise:** one tap greys it out (no delete, no dialog); not "missing data", doesn't block anything.
- **Swap:** replace an exercise for this session from the library (surface recents / same muscle group first);
  the routine is untouched; the swapped-in exercise carries its own last-session numbers.
- **Tap any card to log out of order** — order is a suggestion, not a gate. (No forced reorder to log ahead.)
- All of the above are session-local; only `set_logged` events persist what was actually done.

## Warmup
- Per-set `warmup` flag, default working. 1-tap "W" toggle on the row; warmup sets visually de-emphasized.
- Warmups are STORED but flagged; Phase 3 excludes them from volume/e1RM/progression. 2b: just store + mark + exclude
  from the "last session" working-set prefill/display.

## Assisted / weighted-bodyweight UI (hide the sign math)
- For `uses_bodyweight` exercises: label "Assisted <name> — assist 40 lb" (stepper REDUCES assist) or
  "<name> + 25 lb" (stepper ADDS). Store as signed `added_weight` (assist negative, added positive). Stepper polarity
  must match "less assist / more added = stronger".
- `bodyweight_snapshot`: freeze the latest `measurement.bodyweight` (base_unit) into the event at log time.
  If no bodyweight exists → log with `null` snapshot + a one-time soft prompt to set bodyweight (don't block).
  If latest measurement > 30 days old → soft nudge ("bodyweight is N days old — update?"). Never block logging.

## Minimal bodyweight capture (only what assisted lifts need)
- A lightweight "set bodyweight" entry that emits a `measurement` event `{date, bodyweight, unit}` (base_unit).
  The full Body screen (muscle mass / fat% / fat mass) is Phase 3 — do NOT build it here.

## Cardio — DEFERRED
- Cardio exercises that appear in a routine render a clear "logging coming soon" placeholder card. Do NOT build
  duration/distance set entry in 2b.

## Projections (extend 2a)
- **Last-session-per-exercise:** fold `set_logged` (∪ outbox, enqueue order; skip voided). For each `exercise_id`,
  the most recent `session_date` that has WORKING sets → ordered working sets. Hot read for prefill + display.
- **Today's session:** the set_logged events for today's `session_date`, grouped by exercise, ordered by `set_index`.
- **`nextSetToLog(exercise_id, session_date)` = a PURE FUNCTION over the event log** (not UI/scroll state): returns the
  next `set_index` + prefill values. Lives in a shared plain module (reused by the eventual watch). REQUIRED.
- **Set-event construction lives in a shared module**, not buried in the Today component (watch groundwork).

## Server
- **Full `set_logged` per-type validation** on `/api/sync` (2a left it minimal): require `exercise_id`(uuid),
  `session_date`(YYYY-MM-DD), `set_index`(int ≥0), `unit`(lb|kg), `warmup`(bool); optional numeric
  weight/reps/added_weight/bodyweight_snapshot. Reject malformed individually (`rejected[]`), don't fail the batch.
- `measurement`: require `date`(YYYY-MM-DD), at least `bodyweight`(number) for 2b; keep other fields optional.
- No new endpoints.

## Rest timer — DEFERRED, but leave hooks
- Per-set confirm emits a clean client-side "set logged at T" signal/event hook; leave a slot on the set row where a
  countdown can later live. Do NOT build the timer.

## Done criteria (2b)
Start Today from the day's routine (or pick / custom day), log a full workout per-set with one-tap-confirm prefill +
steppers, add/skip/swap/reorder-free out-of-order logging, see per-set save state + last-session numbers, log an
assisted and a weighted-bodyweight set with correct sign/snapshot, set bodyweight via the minimal capture — ALL
offline-first through the existing sync pipe; reload rebuilds today's session + last-session from the log.
