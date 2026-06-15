/**
 * Today-session resolution + persistence (shared by the phone Today screen and
 * the watch view). The "session" for a date = its persisted exercise selection
 * ∪ any exercise with logged sets that day. Persisted per-date in localStorage
 * so the phone and watch see the SAME session and routine choice.
 *
 * Pure-ish: localStorage I/O + reads of the library/routine stores. Logging
 * projection + set construction live in logging.js — this only resolves WHICH
 * exercises are in today's session and in what order.
 */

import { get } from "svelte/store";
import { libraryMap, weekdayDefaults, routinesMap, weekdayFromJsDay } from "./library.js";
import { todayLocalDate } from "./logging.js";

const SESSION_KEY = (date) => `wt_today_session_${date}`;

/** Dedup an id array, preserving first-occurrence order (unique keyed lists). */
export function uniqIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Load the persisted session for a date (or null). */
export function loadSession(date) {
  try {
    const raw = localStorage.getItem(SESSION_KEY(date));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return {
      started: o.started ?? null, // routine_id | "custom" | null
      selection: Array.isArray(o.selection) ? uniqIds(o.selection) : [],
      skipped: Array.isArray(o.skipped) ? o.skipped : [],
    };
  } catch {
    return null;
  }
}

/** Persist the session for a date (same shape Today reads). */
export function saveSession(date, state) {
  try {
    localStorage.setItem(
      SESSION_KEY(date),
      JSON.stringify({
        started: state.started ?? null,
        selection: uniqIds(state.selection || []),
        skipped: [...(state.skipped || [])],
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

/** The default routine_id assigned to a YYYY-MM-DD date, or null. */
export function defaultRoutineIdForDate(date) {
  const wd = weekdayFromJsDay(new Date(date + "T00:00:00").getDay());
  return get(weekdayDefaults)[wd] || null;
}

/**
 * Build a fresh session selection from a routine's ordered exercises (active,
 * non-archived, deduped). Used to "start" the assigned routine.
 */
export function selectionFromRoutine(routineId) {
  const r = get(routinesMap)[routineId];
  const lib = get(libraryMap);
  if (!r) return [];
  return uniqIds(
    (r.ordered_exercise_ids || []).filter((id) => lib[id] && !lib[id].archived),
  );
}

/**
 * Resolve today's displayed exercise ids for a date — the ONE union/dedup/
 * default-routine code path shared by phone Today + the watch.
 *
 * Displayed list = **base ∪ logged** (deduped, base order first):
 *  - `base` = the committed session's `selection` when a session is committed
 *    (`started != null`), ELSE the day's default-routine exercise ids (fallback).
 *  - The fallback is UNIONED with logged (never replaced), so logging the first
 *    set on an uncommitted assigned-routine day never drops the other routine
 *    exercises (collapse fix).
 *
 * `hasCommittedSession` reflects ONLY a real committed session (persisted with
 * `started != null`); it is NOT set by the default-routine fallback, so Today can
 * still show its 2b start-card on an assigned-routine day that wasn't started.
 *
 * Source of the committed session:
 *  - watch: omit `current` -> reads persisted state via `loadSession(date)`.
 *  - phone Today: pass its LIVE in-memory `current` ({started, selection}) so the
 *    list updates instantly on add/remove/swap. `current == null` (or `started ==
 *    null`) means "not committed" -> base = default routine. An empty custom day
 *    `{started:"custom", selection:[]}` is committed with base `[]` -> empty (W2).
 *
 * @param {object} folded - foldLog result
 * @param {string} [date] - defaults to today's LA date
 * @param {{started:any, selection:string[]} | null} [current] - live session state
 * @returns {{ exerciseIds: string[], date: string, fromDefault: boolean, hasCommittedSession: boolean }}
 */
export function resolveSessionExercises(folded, date = todayLocalDate(), current) {
  const persisted = current !== undefined ? current : loadSession(date);
  const committed = persisted != null && persisted.started != null;
  const loggedIds = Object.keys(folded.sets || {}).filter(
    (id) => folded.sets[id] && folded.sets[id][date],
  );

  let base;
  let fromDefault = false;
  if (committed) {
    base = uniqIds(persisted.selection || []); // the started session's selection
  } else {
    // Not committed: the default routine is the base (UNIONED with logged below,
    // never replaced) so logging doesn't collapse the routine's other exercises.
    const rid = defaultRoutineIdForDate(date);
    base = rid ? selectionFromRoutine(rid) : [];
    fromDefault = base.length > 0;
  }

  const exerciseIds = uniqIds([...base, ...loggedIds]);
  return { exerciseIds, date, fromDefault, hasCommittedSession: committed };
}
