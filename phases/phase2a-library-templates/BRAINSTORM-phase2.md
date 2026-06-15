# Phase 2 Brainstorm — synthesis (Discussion + Advocate, opus)

Covers all of Phase 2 (2a library/templates + 2b Today logging). Full agent briefs condensed here.

## Resolved decisions (both agents agree)
- **No envelope changes.** Phase 2 = new event *payloads* over the existing `{id,type,ts,device,voids,payload}` + sync pipe. Edits/deletes = superseding events via `voids`.
- **No new server endpoints.** Add thin per-`type` payload validation on `/api/sync`; reject the individual bad event (new `rejected:[{id,reason}]` in response), never 400 the whole batch. No referential-integrity checks (events arrive out of order).
- **`warmup` flag per set** — include now (default `false`/working, 1-tap toggle). Load-bearing for Phase 3 volume/e1RM/progression; excluded from "real" numbers. Cheap now, painful backfill later.
- **Ad-hoc session changes never mutate the weekly template.** No new event type: the set_logged events for a `session_date` *are* the session record (swap = no events for A, events for B; reorder = `set_index`; skip = absence). Template edits are a separate deliberate Routines action.
- **Assisted/weighted-bodyweight:** `added_weight` signed (negative = assist, positive = added) + `bodyweight_snapshot` frozen INTO the event (never reference a moving measurement). Effective load = `bodyweight_snapshot + added_weight`. Null snapshot still logs; soft nudge if bodyweight measurement > 30 days stale; never block logging.
- **Rest timer:** stays deferred to v2. BUT make per-set confirm emit a clean client-side "set logged" hook + leave a row slot, so the v2 timer is a bolt-on not a refactor.
- **Projections** rebuilt client-side by folding `events ∪ outbox` in `_seq` order: exercise library (latest non-voided per exercise_id), weekly templates (latest per weekday), last-session-per-exercise (hot read for Today). Volume/e1RM/progression are derived-at-read, Phase 3.

## UNIT MODEL (user decision — differs from Discussion's per-event unit)
- **One canonical stored unit per user** = `profile.base_unit` ∈ {lb,kg}, fixed at account creation. ALL stored weights (`weight`, `added_weight`, `increment`, bodyweight) are numbers in `base_unit`. Storage never mixes units → consistency.
- **Display toggle lb↔kg** (UI state, persisted): converts every displayed value AND the entry field. Entering in the non-base unit converts to `base_unit` before building the event. `1 kg = 2.2046226 lb`.
- Display rounding: nearest 0.5 (readable); stored value keeps full precision from entry. base_unit fixed after first log (no historical reinterpretation).
- Events still stamp `unit` = base_unit (constant, self-describing) — but there is NO per-exercise user-editable unit.

## Advocate's 2b logging-loop requirements (carry into 2b contract)
1. **One-tap confirm.** Prefill weight/reps: this-session prior set → last-session matching set → target. Straight-sets day = sets 2,3 are pure confirm taps.
2. **Per-exercise `increment` steppers** (−/+), keyboard (`inputmode=decimal`) as escape hatch, never force-popped. Big thumb-reachable confirm button, same place every time.
3. **Per-set save state ON THE ROW** derived from outbox/events membership by event id: draft → saved-locally ("saved on this phone") → synced. Failed = loud red. Optimistic instant row update.
4. **Mid-session:** frictionless "+ set" (drop/extra), one-tap skip (greys out, not deleted, no dialog), swap from library (recents/same-muscle surfaced), **tap any card to log out of order** (order is a suggestion, not a gate). Auto-scroll active exercise into view.
5. **Last-session display:** per-set actuals ("Last: 100×8, 100×8, 100×7", working sets only) + recency ("6 days ago"). Keep e1RM OUT of the logging loop (it's a Phase 3 graph number).
6. **Assisted UI hides the sign math:** show "Assisted pull-up — assist 40lb" / "Bodyweight + 25lb"; stepper polarity = less assist / more added = stronger. Assist machines seed their own increment.
7. **Smartwatch groundwork (cheap, do now):** "next set to log for exercise X today" must be a PURE FUNCTION over the event log, not UI/scroll state. Set-event construction lives in a shared plain module, not buried in Svelte components. Then watch reuses it.

## Open forks — RESOLVED
- weekday numbering: **0 = Monday** (lifting convention; convert from JS `getDay()` in one helper).
- cardio: **defer logging to later** (define-able in library, no Today logging UI in 2b).
- mixed units: **single canonical stored unit + display toggle** (user decision above).
- unsaved session reorder-without-logging: not persisted (accepted for v1).
- bodyweight staleness: soft nudge > 30 days, never block.
