/**
 * Exercise library + weekly template projections (CONTRACT-phase2a §Projections).
 *
 * State = a fold over `events ∪ outbox` in chronological order. Confirmed events
 * carry a server `_seq`; outbox events are not yet sequenced and are always the
 * newest local writes, so they sort AFTER every confirmed event. Within each
 * bucket we preserve insertion order (getAll returns key order: _seq asc / id).
 *
 * - Library: per `exercise_id`, the latest non-voided `exercise_defined`/
 *   `exercise_updated`. `archived:true` is kept (history) but filtered from
 *   pickers via `activeExercises`. Materialized in IndexedDB ("library" store)
 *   keyed by exercise_id + a "meta" cursor, rebuilt on load.
 * - Routines: per `routine_id`, the latest non-voided `routine_defined`/
 *   `routine_updated` (named, decoupled from the calendar). Archived kept but
 *   hidden from pickers. Plus a derived `weekday → routine_id` default map from
 *   each routine's `weekday_assignments` (latest-wins per weekday). Cheap
 *   in-memory fold (no materialization).
 *
 * Also exports the static muscle-group list + defaults table (contract: a client
 * constant the define-flow prefills from; the event stores RESOLVED values).
 */

import { writable, derived } from "svelte/store";
import { getAll, putAll, clear, put, get } from "./db.js";
import { syncState } from "./sync.js";
import { migrateEvent } from "./migrations.js";

/** Fixed muscle-group list shown in the define-flow + used for grouping. */
export const MUSCLE_GROUPS = [
  "chest",
  "back",
  "legs",
  "shoulders",
  "arms",
  "core",
  "cardio",
];

/**
 * Static per-group defaults the define-flow prefills (rep range + increment in
 * lb). The saved event stores the resolved numbers, so later edits to this table
 * never reinterpret existing exercises. Cardio has no rep range / increment.
 * @type {Record<string, {rep_low: number|null, rep_high: number|null, increment_lb: number|null}>}
 */
export const GROUP_DEFAULTS = {
  chest: { rep_low: 6, rep_high: 10, increment_lb: 5 },
  back: { rep_low: 6, rep_high: 10, increment_lb: 5 },
  legs: { rep_low: 6, rep_high: 10, increment_lb: 10 },
  shoulders: { rep_low: 8, rep_high: 12, increment_lb: 5 },
  arms: { rep_low: 8, rep_high: 12, increment_lb: 5 },
  core: { rep_low: 10, rep_high: 15, increment_lb: 5 },
  cardio: { rep_low: null, rep_high: null, increment_lb: null },
};

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Convert a JS Date.getDay() (0=Sunday…6=Saturday) to our weekday convention
 * (0=Monday…6=Sunday). Single helper per the contract.
 * @param {number} jsDay - result of Date.getDay()
 * @returns {number} 0=Monday … 6=Sunday
 */
export function weekdayFromJsDay(jsDay) {
  return (jsDay + 6) % 7;
}

/**
 * Build the payload for a new exercise definition. Always self-describing: the
 * resolved (not inherited) values are stored. `exercise_id` is generated once.
 * @param {object} fields
 * @returns {object} exercise_defined / exercise_updated payload
 */
export function buildExercisePayload(fields) {
  return {
    exercise_id: fields.exercise_id || crypto.randomUUID(),
    name: fields.name.trim(),
    type: fields.type,
    uses_bodyweight: !!fields.uses_bodyweight,
    muscle_group: fields.muscle_group,
    rep_range_low: fields.type === "cardio" ? null : fields.rep_range_low,
    rep_range_high: fields.type === "cardio" ? null : fields.rep_range_high,
    increment: fields.type === "cardio" ? null : fields.increment,
    catalog_id: fields.catalog_id || null,
    archived: !!fields.archived,
    // Phase 3: when true, the progression hint stays silent for this exercise.
    hold_progression: !!fields.hold_progression,
    // Phase 5a: per-exercise rest in seconds (int ≥ 0). null/undefined -> global
    // default applies. Cardio has no rest timer, so never stamp it there.
    rest_seconds:
      fields.type === "cardio" ||
      fields.rest_seconds == null ||
      fields.rest_seconds === ""
        ? null
        : Math.max(0, Math.round(Number(fields.rest_seconds))),
  };
}

/**
 * Build the payload for a named routine (A1). Self-describing full-replace;
 * `routine_id` generated once. `weekday_assignments` = 0+ weekdays this routine
 * defaults to (0=Mon…6=Sun); [] = unassigned.
 * @param {object} fields
 * @returns {object} routine_defined / routine_updated payload
 */
export function buildRoutinePayload(fields) {
  return {
    routine_id: fields.routine_id || crypto.randomUUID(),
    name: (fields.name || "").trim(),
    ordered_exercise_ids: Array.isArray(fields.ordered_exercise_ids)
      ? [...fields.ordered_exercise_ids]
      : [],
    weekday_assignments: Array.isArray(fields.weekday_assignments)
      ? [...fields.weekday_assignments].sort((a, b) => a - b)
      : [],
    archived: !!fields.archived,
  };
}

/**
 * Library as `exercise_id -> latest definition payload` (includes archived).
 * @type {import('svelte/store').Writable<Record<string, object>>}
 */
export const libraryMap = writable({});

/**
 * Routines as `routine_id -> latest routine payload` (includes archived).
 * Each carries `__src_id` (producing event id) so edits can void the prior.
 * @type {import('svelte/store').Writable<Record<string, object>>}
 */
export const routinesMap = writable({});

/** Exercises visible in pickers (non-archived), sorted by name. */
export const activeExercises = derived(libraryMap, ($m) =>
  Object.values($m)
    .filter((x) => !x.archived)
    .sort((a, b) => a.name.localeCompare(b.name)),
);

/** Active exercises grouped by muscle group (for the Exercises screen list). */
export const exercisesByGroup = derived(activeExercises, ($list) => {
  /** @type {Record<string, object[]>} */
  const out = {};
  for (const g of MUSCLE_GROUPS) out[g] = [];
  for (const ex of $list) {
    (out[ex.muscle_group] ||= []).push(ex);
  }
  return out;
});

/** Routines visible in pickers (non-archived), sorted by name. */
export const activeRoutines = derived(routinesMap, ($m) =>
  Object.values($m)
    .filter((r) => !r.archived)
    .sort((a, b) => a.name.localeCompare(b.name)),
);

/**
 * Default routine per weekday from `weekday_assignments`, latest-wins. Computed
 * from the ALREADY-folded routinesMap (each entry is the latest per routine_id),
 * so "latest wins" within a weekday is resolved by which routine event is newer.
 * To get that ordering we fold during project(); here we just expose the result
 * via `weekdayDefaults` + any `weekdayConflicts`.
 */
export const weekdayDefaults = writable(
  /** @type {Record<number, string>} */ ({}),
);
/**
 * Weekdays claimed by more than one active routine (UI warns). Map of
 * weekday -> [routine_id, ...] (in fold order; last is the current winner).
 * @type {import('svelte/store').Writable<Record<number, string[]>>}
 */
export const weekdayConflicts = writable(
  /** @type {Record<number, string[]>} */ ({}),
);

/**
 * Fold a chronological event list into the library + routine projections.
 * Pure (no IO) so it's unit-testable; `rebuild()` wires it to storage.
 *
 * Latest-wins per entity (exercise_id / routine_id) -- iterating in order means
 * the last write for an id is the survivor. The weekday→default-routine map is
 * folded in the SAME pass: each routine event re-stakes its claimed weekdays
 * (and releases any it dropped), so the newest routine event wins a contested
 * weekday. Conflicts (a weekday currently claimed by 2+ active routines) are
 * reported for a UI warning.
 * @param {{type: string, voids?: string|null, id: string, payload: object}[]} ordered
 * @returns {{ library: Record<string, object>, routines: Record<string, object>, weekdayDefaults: Record<number, string>, weekdayConflicts: Record<number, string[]> }}
 */
export function project(ordered) {
  // Contract: "latest NON-VOIDED per id". Collect every event id that some other
  // event voids; a voided event can never win the fold. This lets a delete be a
  // superseding event that voids the current head (and, for a pure delete, marks
  // itself a tombstone via `payload.deleted` so it removes the entity rather than
  // re-establishing it). Applied identically to exercises + routines (A1 fix).
  const voidedIds = new Set();
  for (const e of ordered) {
    if (e.voids) voidedIds.add(e.voids);
  }

  /** @type {Record<string, object>} */
  const library = {};
  /** @type {Record<string, object>} */
  const routines = {};
  for (const e of ordered) {
    // Skip events superseded/voided by a later event: never let them win.
    if (voidedIds.has(e.id)) continue;
    const p = e.payload || {};
    if (e.type === "exercise_defined" || e.type === "exercise_updated") {
      if (!p.exercise_id) continue;
      if (p.deleted) {
        delete library[p.exercise_id]; // tombstone: remove the entity entirely
        continue;
      }
      // Stamp the producing event id so an edit can set voids = prior def id
      // (contract: exercise_updated MUST void the prior definition event).
      library[p.exercise_id] = { ...p, __src_id: e.id };
    } else if (e.type === "routine_defined" || e.type === "routine_updated") {
      if (!p.routine_id) continue;
      if (p.deleted) {
        delete routines[p.routine_id]; // tombstone: delete the routine
        continue;
      }
      routines[p.routine_id] = { ...p, __src_id: e.id };
    }
  }

  // Derive weekday → default routine_id from the FINAL state of each routine's
  // weekday_assignments (the folded `routines` map already holds latest-per-id).
  // Multiple routines can list the same weekday; we order claimants by each
  // routine's latest-event position so the newest wins. Track all claimants per
  // weekday so the UI can warn. Archived routines don't claim weekdays.
  /** @type {Record<number, string[]>} */
  const claims = {};
  // Stable ordering of routines by when their latest event appeared in `ordered`.
  const orderIndex = new Map();
  ordered.forEach((e, i) => {
    const rid = e.payload && e.payload.routine_id;
    if (rid && (e.type === "routine_defined" || e.type === "routine_updated")) {
      orderIndex.set(rid, i);
    }
  });
  const orderedRoutines = Object.values(routines).sort(
    (a, b) => (orderIndex.get(a.routine_id) || 0) - (orderIndex.get(b.routine_id) || 0),
  );
  for (const r of orderedRoutines) {
    if (r.archived) continue;
    for (const wd of r.weekday_assignments || []) {
      if (typeof wd !== "number") continue;
      (claims[wd] ||= []).push(r.routine_id);
    }
  }
  /** @type {Record<number, string>} */
  const wdDefaults = {};
  /** @type {Record<number, string[]>} */
  const wdConflicts = {};
  for (const [wd, ids] of Object.entries(claims)) {
    // Last claimant in fold order = newest routine event for that weekday.
    wdDefaults[wd] = ids[ids.length - 1];
    if (ids.length > 1) wdConflicts[wd] = ids;
  }

  return {
    library,
    routines,
    weekdayDefaults: wdDefaults,
    weekdayConflicts: wdConflicts,
  };
}

/**
 * Merge confirmed events (have `_seq`) with outbox events (no `_seq` yet, treated
 * as newest) into one chronological list. Confirmed sort by server `_seq`;
 * outbox sorts by the local enqueue key `_enq` (C1) -- NOT id/UUID order -- so
 * superseding offline edits resolve latest-wins correctly. Outbox is appended
 * after all confirmed events (it's the newest local work).
 * @param {object[]} events - confirmed, each with `_seq`
 * @param {object[]} outbox - unsynced, each with `_enq`
 * @returns {object[]}
 */
function mergeOrdered(events, outbox) {
  const confirmed = [...events].sort((a, b) => a._seq - b._seq);
  const pending = [...outbox].sort((a, b) => (a._enq || 0) - (b._enq || 0));
  // Upcast each event to the current schema (identity for v1) and drop any from a
  // newer schema this client can't yet read; _seq/_enq are preserved so order holds.
  return [...confirmed, ...pending].map(migrateEvent).filter((e) => e !== null);
}

const LIBRARY_CURSOR_KEY = "library_cursor";

/**
 * Rebuild both projections from the event log (`events ∪ outbox`), publish them
 * to the stores, and re-materialize the library in IndexedDB keyed by the max
 * `_seq` seen. Call on app load and after every local emit/sync.
 * @returns {Promise<void>}
 */
export async function rebuild() {
  const [events, outbox] = await Promise.all([
    getAll("events"),
    getAll("outbox"),
  ]);
  const ordered = mergeOrdered(events, outbox);
  const { library, routines, weekdayDefaults: wdDef, weekdayConflicts: wdConf } =
    project(ordered);

  libraryMap.set(library);
  routinesMap.set(routines);
  weekdayDefaults.set(wdDef);
  weekdayConflicts.set(wdConf);

  // Materialize the library cache. Confirmed-only max _seq is the durable
  // cursor; outbox rows aren't sequenced yet but are included in the live store.
  const maxSeq = events.reduce((m, e) => (e._seq > m ? e._seq : m), 0);
  await clear("library");
  await putAll("library", Object.values(library));
  await put("meta", { key: LIBRARY_CURSOR_KEY, value: maxSeq });
}

/** Read the materialized library straight from IndexedDB (e.g. fast first paint). */
export async function loadMaterializedLibrary() {
  const rows = /** @type {object[]} */ (await getAll("library"));
  /** @type {Record<string, object>} */
  const map = {};
  for (const r of rows) map[r.exercise_id] = r;
  libraryMap.set(map);
  const cursor = await get("meta", LIBRARY_CURSOR_KEY);
  return cursor ? cursor.value : 0;
}

let projectionsStarted = false;
let unsubRevision;

/**
 * Begin keeping the projections fresh: paint from the materialized cache first,
 * then rebuild on every event-log change (sync.logRevision). Call once after
 * auth, alongside startSync(). Idempotent.
 */
export async function startProjections() {
  if (projectionsStarted) return;
  projectionsStarted = true;
  await loadMaterializedLibrary();
  await rebuild();
  let first = true;
  unsubRevision = syncState.logRevision.subscribe(() => {
    if (first) {
      first = false; // skip the initial fire; we just rebuilt above
      return;
    }
    rebuild().catch((e) => console.warn("[library] rebuild failed", e));
  });
}

/** Stop projection rebuilds (used on logout). */
export function stopProjections() {
  if (!projectionsStarted) return;
  projectionsStarted = false;
  if (unsubRevision) unsubRevision();
}
