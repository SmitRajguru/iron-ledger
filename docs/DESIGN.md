# Workout Tracker — Design Spec (v0, resolved)

Status: design agreed via grill session 2026-05-31. Pending: user sign-off before implementation.

## 1. Goal

A small, self-hosted web app to log resistance training (weights/reps/sets/volume),
track body composition, and view historical trends. Mobile-first PWA, offline-tolerant,
for a handful of trusted users (me + family/friends). Smartwatch deferred.

## 2. Resolved decisions

| Area | Decision |
|---|---|
| Data home | Tiny self-hosted server; JSON files on disk; reachable via Cloudflare Tunnel (HTTPS) |
| Users | Few known accounts; real auth |
| Auth | Username + bcrypt-hashed password, httpOnly session cookie, per-user data namespace |
| Offline | Offline-first PWA: writes hit local IndexedDB instantly; background queue syncs to server when online |
| Write model | Append-only event log per user; edits/deletes = new superseding records (by id) |
| Stack | FastAPI (Python) backend + Svelte PWA frontend |
| Strength graph | Estimated 1RM (Epley: `w*(1+reps/30)`, best set) **and** total volume |
| Body comp | Bodyweight, muscle mass, body-fat %, fat mass; manual entry any time; fat mass auto-derivable from weight×bf% |
| Progression | Double progression (rep-range based) suggestions |
| Rep ranges/increment | Muscle-group defaults + per-exercise override |
| Exercise catalog | Bundled curated seed catalog (common lifts → group/type/default range); user picks/extends. NOT live runtime web search (offline-incompatible) |
| Rest timer | Deferred to v2 |
| Profiles | One user per device (no in-browser profile switch) |
| Routine model | Named routines (Push/Pull/Legs/A/B...) w/ optional weekday default assignment; at workout start use today's assigned routine, pick another, or build a one-off custom day; ad-hoc session never mutates a routine (revised from weekday-only templates) |
| Log grain | Per-set |
| Exercise types | Weighted; bodyweight (incl. assisted = negative added wt, or weighted = positive added wt); cardio/time/distance |
| Units | Single FIXED internal canonical unit (lb), hidden from user; user freely toggles lb/kg for display + entry (exact conversion only). No per-user stored unit, no immutable signup choice. |
| File layout | Per-user dir, split files; workout log month-chunked JSONL |
| Watch | Deferred (later: single-set view, native or PWA per platform) |

## 3. Architecture

```
[Phone/Desktop PWA] --HTTPS--> [Cloudflare Tunnel] --> [FastAPI server] --> [JSON files on disk]
       |
   IndexedDB (local source of truth while offline)
       |
   Sync queue --(when online)--> POST /sync (append events)
```

- **Client is the offline source of truth during a session.** Every logged set is written
  to IndexedDB immediately and enqueued. The sync queue flushes to the server when connectivity
  returns. A full workout can be logged with zero connectivity.
- **Server is an append store + auth + static host.** It validates the session cookie,
  appends incoming events to the user's log, and serves the PWA assets.
- **Conflict handling:** append-only + per-event UUID + device id + client timestamp. No
  destructive overwrites. Same record edited on two offline devices → both events stored;
  latest client-timestamp wins at read/projection time. Rare for single-user-per-account.

## 4. Data model (append-only events)

Each event is an immutable record. Current state = projection over events (latest non-voided wins).

Event envelope:
```json
{ "id": "uuid", "type": "...", "ts": "ISO-8601", "device": "id", "voids": "uuid|null", "payload": { } }
```

Event types:
- `set_logged` — payload: `exercise_id, session_date, set_index, weight, reps, unit, added_weight?, assist?, duration_s?, distance_m?`
- `measurement` — payload: `date, bodyweight?, muscle_mass?, body_fat_pct?, fat_mass?, unit`
- `exercise_defined` / `exercise_updated` — payload: `id, name, type(weighted|bodyweight|cardio), rep_range_low/high, increment, muscle_group`
- `template_updated` — payload: `weekday(0-6), ordered_exercise_ids[]`

Edit/delete = emit a new event with `voids` pointing at the target id (delete) or a corrected
record that supersedes (edit). History always preserved for graphs.

### On-disk layout
```
data/<user>/
  profile.json          # display name, unit pref, settings
  exercises.json         # exercise definitions (projection, regenerable from log)
  routines.json          # weekly templates per weekday
  measurements.json      # body-comp projection
  log/sets-2026-05.jsonl # append-only event log, one JSON per line, month-chunked
users.json               # {username: {pw_hash, salt, user_dir}}
```
`exercises.json` / `routines.json` / `measurements.json` are convenience projections of the
event log and can be rebuilt from `log/*.jsonl` if ever corrupted.

## 5. Volume & strength math

- Weighted: `volume = Σ(weight × reps)` over sets. `e1RM = max over sets of weight×(1+reps/30)`.
- Weighted bodyweight: effective load = `bodyweight + added_weight` (assist = negative). Volume/e1RM use effective load. (Bodyweight comes from latest `measurement`; if unknown, prompt once.)
- Cardio/time/distance: no volume/e1RM; graph duration and/or distance over time.

## 6. Progression suggestion (double progression)

Per exercise: `rep_range_low..rep_range_high` and an `increment`.
- If last session hit `rep_range_high` reps on **all** working sets → suggest `+increment` and reset target reps to `rep_range_low`.
- Else → suggest same weight, aim +1 rep.
- Assisted bodyweight → "reduce assist by `increment`" instead of adding weight.
- Suggestion is advisory; shown next to the exercise when logging.

## 7. UI surfaces (mobile-first)

1. **Login**
2. **Today** — pulls the weekday's template; per-exercise card with set inputs (weight/reps, big touch targets), shows last session + progression hint; add/remove/reorder for this session.
3. **Routines** — edit weekly templates, drag-reorder exercises per weekday.
4. **Exercises** — define/edit exercise library (type, rep range, increment, unit).
5. **Body** — log + view body-comp measurements.
6. **Graphs** — per-exercise e1RM & volume over time; body-comp trends. Cardio shows duration/distance.

PWA: installable, service worker caches shell, works offline, sync indicator (synced / pending N / offline).

## 8. Explicitly out of v1 (deferred)

- Smartwatch app.
- Scale / Apple Health / Google Fit import.
- PR badges (may fold into graphs later), full mesocycle programming.
- Rest timer (candidate for early v2 — flag in feedback if wanted in v1).

## 9. Exercise catalog (seed)

A curated `catalog.json` ships with the app: common exercises tagged with
`name, type, muscle_group, default_rep_low, default_rep_high, default_increment`.
When defining the user's library, they pick from the catalog (prefilling defaults) or
add custom entries. Muscle-group defaults apply unless the exercise overrides them.
Catalog is static/bundled and can be expanded in-repo; no runtime internet dependency.

## 10. Resolved (was open)

- Rest timer: deferred to v2.
- Rep ranges/increments: muscle-group defaults **+** per-exercise override.
- Exercise catalog: bundled curated seed (above), not live search.
- Profiles: one user per device, no in-browser switch.
