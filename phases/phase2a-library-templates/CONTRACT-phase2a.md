# Phase 2a Contract — Exercise Library + Seed Catalog + Weekly Templates

Shared interface for backend + frontend. Builds on Phase 1 (event envelope, sync pipe, auth).
The Today logging loop is **Phase 2b** — NOT in this round. See `BRAINSTORM-phase2.md` for rationale.

## Scope (2a only)
1. **Unit model** (foundational, used everywhere): canonical stored unit + display toggle.
2. **Exercise library:** define / edit / archive exercises (weighted | bodyweight | cardio).
3. **Seed catalog:** bundled curated `catalog.json`; instantiate entries into the user's library.
4. **Weekly templates:** per-weekday ordered exercise list, drag-reorder, edit on a Routines screen.
5. **Server:** per-type payload validation for the new event types + `base_unit` on profile.

OUT of 2a: the Today screen, set logging, last-session display, progression, cardio logging UI, graphs, body comp.

## Unit model
- `profile.base_unit` ∈ `"lb" | "kg"`, chosen at signup (default `"lb"`), **immutable after first weight is logged**.
  All stored weights are numbers in `base_unit`.
- Client holds a **display unit** toggle (lb/kg), persisted in localStorage. It converts every displayed weight
  and the entry field; entry in the non-base unit converts to `base_unit` before any event is built.
  `1 kg = 2.2046226218 lb`. Display rounds to nearest 0.5; stored values keep entry precision.
- Provide a single shared client module for conversion + formatting (reused by 2b + eventual watch).

## Events (new payload types — envelope unchanged)
All weights/increments in `base_unit`. `voids` points at the prior event id when editing.

### `exercise_defined` / `exercise_updated`
Identical payload; `exercise_updated` MUST set `voids` = prior definition event id for that `exercise_id`.
```json
{
  "exercise_id": "uuid",          // stable identity, generated once at first define
  "name": "Barbell Bench Press",
  "type": "weighted",             // "weighted" | "bodyweight" | "cardio"
  "uses_bodyweight": false,       // true for bodyweight type (incl assisted/weighted-bodyweight)
  "muscle_group": "chest",        // string from a fixed client list
  "rep_range_low": 6,             // null for cardio
  "rep_range_high": 10,           // null for cardio
  "increment": 5,                 // step in base_unit; assist-reduction step for assisted; null for cardio
  "catalog_id": "bench_press_bb", // nullable provenance; NOT a runtime foreign key
  "archived": false               // soft-hide from pickers, keeps history
}
```
- Muscle-group defaults (rep range / increment) are a **static client constant**; the define-flow prefills from
  them, the event stores the RESOLVED values (always self-describing — no inherited/overridden ambiguity).
- `type` is fixed once any set is logged for the exercise (enforced in UI; offer "archive + new" instead).

### `routine_defined` / `routine_updated`  (replaces the old weekday-only `template_updated`)
Identical payload; `routine_updated` MUST set `voids` = prior event id for that `routine_id`.
```json
{
  "routine_id": "uuid",                 // stable identity, generated once at first define
  "name": "Push",                        // user-facing routine name (Push/Pull/Legs/Upper/A/B...)
  "ordered_exercise_ids": ["uuid", "..."],
  "weekday_assignments": [0, 3],         // optional list of weekdays (0=Mon..6=Sun) this routine is the DEFAULT for; [] = unassigned
  "archived": false                      // soft-hide, keeps history
}
```
- **Named routines decoupled from the calendar.** A routine is an ordered exercise list with a name. It MAY be
  assigned to 0+ weekdays as that day's default, but any routine can be started on any day (2b).
- `weekday`: **0 = Monday … 6 = Sunday** (convert from JS `getDay()` in one helper).
- Full-replace semantics: latest non-voided event per `routine_id` wins. Drag-reorder re-emits the whole list.
- **Weekday→default-routine projection:** fold all routines' `weekday_assignments`; if two routines claim the same
  weekday, latest event wins for that weekday (and the UI should warn on conflict). A weekday with no assignment =
  no default (2b prompts the user to pick a routine or build a custom day).
- One-off custom day (2b): the user picks exercises ad hoc for a single session — this is just `set_logged` events
  for that `session_date`, NOT a routine event. Routines are never mutated by a session.

## Projections (client, fold `events ∪ outbox` by `_seq`)
- **Library:** per `exercise_id`, latest non-voided `exercise_*` event. `archived:true` hidden from pickers, kept for history.
- **Routines:** per `routine_id`, latest non-voided `routine_*` event (archived hidden from pickers, kept). Plus a
  derived `weekday → routine_id` default map from `weekday_assignments` (latest-wins per weekday).
- Materialize the library in IDB keyed by max `_seq` seen (read on every screen); routines are a cheap in-memory fold.
- **Outbox folds in LOCAL ENQUEUE ORDER** (not UUID key order) so offline edits resolve latest-wins correctly — see fix C1.

## Seed catalog
- Bundled static asset `client/src/lib/catalog.json` (precached by the service worker; no network).
- Per entry: `{ catalog_id, name, type, uses_bodyweight, muscle_group, default_rep_low, default_rep_high,
  default_increment (in lb), aliases? }`.
- **Instantiate = copy, never link:** picking a catalog entry prefills an `exercise_defined` payload (fresh
  `exercise_id`, convert `default_increment` from lb to `base_unit`, copy `catalog_id` as provenance). User can
  tweak before saving. Later catalog changes never touch the user's library.
- Seed ~40–55 entries across chest/back/legs/shoulders/arms/core + bodyweight/assisted exemplars (pull-up, chin-up,
  dip) + a few cardio (treadmill, row, bike, plank) so the cardio/assisted paths exist. Curated, not a megadump.

## Server changes
- **Profile `base_unit`:** signup accepts optional `base_unit` (default `"lb"`); store in the user's profile;
  expose via `/api/auth/me` (so the client knows the canonical unit). Reject changing it once set if any weight
  event exists (or simply treat it as immutable post-signup for v1 — document the choice).
- **Per-type payload validation on `POST /api/sync`** (Phase 1 deferred this). Validate required keys + enums per type;
  return malformed events in a new `rejected: [{id, reason}]` field alongside `accepted`/`duplicate` — do NOT fail the
  batch. No referential integrity. Validate for `exercise_defined`/`exercise_updated` and `template_updated` now;
  keep `set_logged`/`measurement` minimal (full set_logged validation lands with 2b).

| type | required | enum/format |
|---|---|---|
| `exercise_defined` | exercise_id(uuid), name(nonempty), type | type∈{weighted,bodyweight,cardio} |
| `exercise_updated` | exercise_id(uuid), name, type, **voids(uuid)** | type enum; voids MUST be non-null uuid |
| `routine_defined` | routine_id(uuid), name(nonempty), ordered_exercise_ids(list of uuid) | weekday_assignments each 0–6 if present |
| `routine_updated` | routine_id(uuid), name, ordered_exercise_ids, **voids(uuid)** | as above; voids MUST be non-null uuid |

## UI surfaces (2a)
- **Exercises screen:** list library (grouped by muscle group, archived hidden), add custom, "Add from catalog"
  (searchable picker with aliases), edit, archive. Define-flow uses the muscle-group defaults prefill + unit display.
- **Routines screen:** list of NAMED routines (create/rename/archive). Open a routine → its ordered exercise list;
  add from library, remove, **handle-only** drag-reorder (touch-friendly; only the ⠿ grip starts a drag so scrolling
  a long list doesn't reorder). Each routine has an optional weekday-assignment control (pick 0+ weekdays it defaults
  to; warn on conflict). Saving re-emits the whole `routine_updated`/`routine_defined`.
- Unit display toggle (lb/kg) reachable from settings/header; affects all weight display app-wide.
- Mobile-first; cards grid into columns on wide screens (uses the now full-bleed width).

## Done criteria (2a)
Define exercises (custom + from catalog), create named routines with ordered exercises + handle-only reordering +
optional weekday assignment, all offline-first through the existing sync pipe; reload rebuilds library + routines
from the event log (outbox folded in enqueue order); lb/kg toggle converts display correctly without precision drift
into storage; server rejects malformed exercise/routine events (incl. `exercise_updated`/`routine_updated` missing
`voids`) without dropping good ones.
