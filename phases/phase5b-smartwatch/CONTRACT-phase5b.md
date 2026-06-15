# Phase 5b Contract — Watch-friendly web page (single-set entry)

Target (user decision): a **watch-friendly web page** loaded in the watch's browser — NOT a native app. Reuses the
existing PWA stack, same-origin auth cookie, and the pure logging core. Frontend-only; no backend changes.

Per the original spec: on a smartwatch the app is used to **view a single exercise's set at a time and enter weight/reps
during the workout** — nothing else (no graphs/library/routines on the watch).

## Scope
- A dedicated ultra-minimal route/view (e.g. `/watch`) optimized for a tiny watch browser viewport (round or square,
  ~tiny px). Huge tap targets, huge fonts, one thing on screen at a time, minimal chrome.
- **Single-set focus:** shows the current exercise name + the next set's prefilled weight & reps (from the shared
  `nextSetToLog`), with big − / + steppers (weight steps by the exercise `increment`; reps ±1) and ONE big Confirm/Log
  button. On confirm → log the set via the existing `buildSetEvent` + offline sync queue, then advance to the next set.
- **Minimal nav:** move to previous/next exercise in today's session; a compact "set N" + last-session hint ("last 100×8").
  Today's session comes from the same routine resolution used on the phone (today's assigned routine / current session).
- **Assisted/bodyweight:** show the same assist/added magnitude entry (hide sign math, like the phone card). Cardio: keep
  it out of the watch v1 (weight/reps single-set is the spec) unless trivial — defer cardio on watch.
- **Auth:** the watch browser uses the same httpOnly session cookie (same origin via the Cloudflare tunnel). Provide a
  minimal login on the watch route if not authenticated (username/password only). Stay logged in.
- **Offline:** best-effort — reuse the IndexedDB outbox + sync queue so a set entered on the watch with no signal queues
  and syncs later. (PWA install/service-worker on a watch browser is flaky; don't rely on install — just the web page +
  the existing offline queue if it loads.)

## Reuse (do NOT duplicate logic)
- `logging.js`: `nextSetToLog`, `buildSetEvent`, today-session projection, `lastSessionFor` — all already pure and
  watch-intended. The watch view is a thin presentational shell over these.
- `units.js` display conversion, `sync.js` queue/flush, `auth.js` me/login.
- The watch view must NOT reimplement set-construction or projection — call the shared module.

## Out of scope
Graphs, body comp, routine editing, exercise library management, progression hints, rest timer UI (the phone has these).
Native watch app (explicitly not chosen). Cardio entry on watch (defer).

## Done criteria
On a small watch-sized viewport, log in, see today's current exercise + prefilled next set, adjust weight/reps with big
steppers, confirm to log (offline-safe via the existing queue), and advance through sets/exercises — all reusing the
shared logging core with no duplicated logic.

## Notes
- Verify responsiveness at watch-sized viewports (e.g. ~320–410px square and smaller round). Real watch-browser testing
  is user-side; harness/devtools small-viewport check otherwise.
- Keep the route laz- / conditionally-loaded so it doesn't bloat the main phone bundle.
