/**
 * Analytics for WT Tracker (CONTRACT-phase3). PURE reads over the foldLog output
 * — does NOT extend logging.js (keeps the watch-reusable logging core lean) and
 * does NOT cache to IndexedDB. All weights are canonical lb; the UI converts to
 * display via units.js at render. Derived stores recompute off `logState`.
 */

import { derived } from "svelte/store";
import { logState } from "./logging.js";
import { libraryMap } from "./library.js";

/** Epley caps reps at 12 so high-rep sets don't post fake 1RMs (contract). */
export const E1RM_REP_CAP = 12;

/**
 * Effective load (base lb) of a set.
 *  - weighted: `set.weight`.
 *  - bodyweight (uses_bodyweight): `bodyweight_snapshot + (added_weight ?? 0)`
 *    (assist is negative). NULL snapshot -> null (unusable; never live BW, never 0).
 * @param {object} set
 * @param {object} exercise
 * @returns {number|null}
 */
export function effectiveLoad(set, exercise) {
  if (exercise && exercise.uses_bodyweight) {
    const snap = set.bodyweight_snapshot;
    if (snap == null) return null; // unusable without a frozen snapshot
    return snap + (set.added_weight ?? 0);
  }
  return set.weight ?? null;
}

/** Working (non-warmup) sets of a session row array. */
function workingSets(sessionSetArr) {
  return sessionSetArr.filter((s) => !s.warmup);
}

/**
 * e1RM for one session's set array (base lb). Max over WORKING sets of
 * `load*(1+min(reps,12)/30)`, guarding load>0 & reps>0. Null when none usable.
 * Returns `{ e1rm, topSet, fromSingle }` (or null) — topSet is the source set
 * (for the tooltip); fromSingle flags that the best came from a 1-rep set.
 * @param {object[]} sessionSetArr
 * @param {object} exercise
 * @returns {{e1rm:number, topSet:object, fromSingle:boolean}|null}
 */
export function sessionE1RM(sessionSetArr, exercise) {
  let best = null;
  for (const s of workingSets(sessionSetArr)) {
    const load = effectiveLoad(s, exercise);
    const reps = s.reps;
    if (load == null || !(load > 0) || !(reps > 0)) continue;
    const capped = Math.min(reps, E1RM_REP_CAP);
    const e1rm = load * (1 + capped / 30);
    if (!best || e1rm > best.e1rm) {
      best = { e1rm, topSet: s, fromSingle: reps === 1 };
    }
  }
  return best;
}

/**
 * Total volume (base lb) for a session's set array = Σ working `effectiveLoad*reps`.
 * Null when no usable working set (sparse, not 0).
 * @param {object[]} sessionSetArr
 * @param {object} exercise
 * @returns {number|null}
 */
export function sessionVolume(sessionSetArr, exercise) {
  let sum = 0;
  let any = false;
  for (const s of workingSets(sessionSetArr)) {
    const load = effectiveLoad(s, exercise);
    const reps = s.reps;
    if (load == null || !(load > 0) || !(reps > 0)) continue;
    sum += load * reps;
    any = true;
  }
  return any ? sum : null;
}

/**
 * Per-exercise time series over the folded log (PURE).
 * @param {object} folded - foldLog result
 * @param {object} exercise - the exercise definition
 * @returns {{type:string, points:object[], empty:boolean}}
 *   point = {session_date, e1rm, volume, topSet, fromSingle, addedWeight, bwSnapshot}
 *   (e1rm/volume null when that session had no usable working set -> chart gap).
 */
export function exerciseSeries(folded, exercise) {
  if (!exercise || exercise.type === "cardio") {
    return { type: exercise ? exercise.type : "unknown", points: [], empty: true };
  }
  const byDate = folded.sets[exercise.exercise_id] || {};
  const dates = Object.keys(byDate).sort(); // YYYY-MM-DD asc
  const points = [];
  let anyUsable = false;
  for (const date of dates) {
    const arr = Object.values(byDate[date]).sort((a, b) => a.set_index - b.set_index);
    const e = sessionE1RM(arr, exercise);
    const v = sessionVolume(arr, exercise);
    if (e || v != null) anyUsable = true;
    // For bodyweight lifts, surface the session's added/assist + snapshot so the
    // graph can plot the assist line + a "computed off bodyweight from [date]" note.
    let addedWeight = null;
    let bwSnapshot = null;
    let bwSnapshotDate = null;
    if (exercise.uses_bodyweight) {
      const top = e ? e.topSet : workingSets(arr)[0];
      if (top) {
        addedWeight = top.added_weight ?? 0;
        bwSnapshot = top.bodyweight_snapshot ?? null;
        bwSnapshotDate = top.bodyweight_snapshot_date ?? null; // M1: real staleness
      }
    }
    points.push({
      session_date: date,
      e1rm: e ? e.e1rm : null,
      volume: v,
      topSet: e ? e.topSet : null,
      fromSingle: e ? e.fromSingle : false,
      addedWeight,
      bwSnapshot,
      bwSnapshotDate,
    });
  }
  return { type: exercise.type, points, empty: !anyUsable };
}

/** Reactive: the series for a given exercise_id, recomputed off the live log. */
export function exerciseSeriesStore(exercise_id) {
  return derived([logState, libraryMap], ([$log, $lib]) => {
    const ex = $lib[exercise_id];
    if (!ex) return { type: "unknown", points: [], empty: true };
    return exerciseSeries($log.folded, ex);
  });
}

// ---------------------------------------------------------------------------
// PR badges (CONTRACT-phase5a §2) — pure reads over foldLog
// ---------------------------------------------------------------------------

/**
 * PR session_dates for an exercise (PURE — no store access; X1). A session is an
 * e1RM PR if its session e1RM exceeds ALL prior sessions' e1RM; a volume PR
 * likewise. Working sets only (warmups excluded), capped-rep e1RM. The first-ever
 * session is NOT a PR (nothing prior to beat). Sessions with no usable working
 * set are skipped (they don't reset the running maxima).
 * @param {object} folded - foldLog result
 * @param {object} exercise - the exercise definition (caller supplies it)
 * @returns {{e1rm: Set<string>, volume: Set<string>}}
 */
export function prsFor(folded, exercise) {
  const e1rmPRs = new Set();
  const volPRs = new Set();
  if (!exercise || exercise.type === "cardio") return { e1rm: e1rmPRs, volume: volPRs };
  const byDate = folded.sets[exercise.exercise_id] || {};
  const dates = Object.keys(byDate).sort(); // chronological
  let bestE1RM = null;
  let bestVol = null;
  for (const date of dates) {
    const arr = Object.values(byDate[date]).sort((a, b) => a.set_index - b.set_index);
    const e = sessionE1RM(arr, exercise);
    const v = sessionVolume(arr, exercise);
    if (e && e.e1rm != null) {
      if (bestE1RM != null && e.e1rm > bestE1RM) e1rmPRs.add(date);
      if (bestE1RM == null || e.e1rm > bestE1RM) bestE1RM = e.e1rm;
    }
    if (v != null) {
      if (bestVol != null && v > bestVol) volPRs.add(date);
      if (bestVol == null || v > bestVol) bestVol = v;
    }
  }
  return { e1rm: e1rmPRs, volume: volPRs };
}

/**
 * Did `session_date` set a PR? Accepts either a precomputed `prsFor(...)` result
 * (preferred — compute once per exercise/fold, X6) or, for convenience, the
 * `{folded, exercise}` to compute on the fly.
 * @param {{e1rm:Set,volume:Set} | object} prsOrFolded - prsFor result OR folded
 * @param {string|object} session_date_or_exercise - session_date (when first arg
 *   is a prsFor result) OR the exercise (when first arg is folded)
 * @param {string} [session_date] - when computing from folded+exercise
 * @returns {{e1rm: boolean, volume: boolean, any: boolean}}
 */
export function isSessionPR(prsOrFolded, session_date_or_exercise, session_date) {
  let prs;
  let date;
  if (prsOrFolded && prsOrFolded.e1rm instanceof Set) {
    prs = prsOrFolded;
    date = session_date_or_exercise;
  } else {
    prs = prsFor(prsOrFolded, session_date_or_exercise);
    date = session_date;
  }
  const e = prs.e1rm.has(date);
  const v = prs.volume.has(date);
  return { e1rm: e, volume: v, any: e || v };
}

// ---------------------------------------------------------------------------
// Cardio series (CONTRACT-phase5a §3) — pure reads over foldLog
// ---------------------------------------------------------------------------

/**
 * Per-session cardio totals for an exercise (PURE). Sums duration_s and
 * distance_m across that day's cardio sets (warmups included — rare for cardio
 * but kept consistent; they carry no weight). Points sorted by date.
 * @param {object} folded - foldLog result
 * @param {string} exercise_id
 * @returns {{points:{session_date:string, duration_s:number|null, distance_m:number|null}[], empty:boolean}}
 */
export function cardioSeries(folded, exercise_id) {
  const byDate = folded.sets[exercise_id] || {};
  const dates = Object.keys(byDate).sort();
  const points = [];
  let any = false;
  for (const date of dates) {
    const arr = Object.values(byDate[date]);
    let dur = 0;
    let dist = 0;
    let hasDur = false;
    let hasDist = false;
    for (const s of arr) {
      if (typeof s.duration_s === "number") {
        dur += s.duration_s;
        hasDur = true;
      }
      if (typeof s.distance_m === "number") {
        dist += s.distance_m;
        hasDist = true;
      }
    }
    if (hasDur || hasDist) any = true;
    points.push({
      session_date: date,
      duration_s: hasDur ? dur : null,
      distance_m: hasDist ? dist : null,
    });
  }
  return { points, empty: !any };
}

// ---------------------------------------------------------------------------
// Body composition
// ---------------------------------------------------------------------------

/**
 * Resolve a measurement's fat_mass / body_fat_pct with derive-on-read. Explicit
 * values win; otherwise derive symmetrically from the other two (contract §4).
 * Never mutates / stores; returns a shallow copy with filled-in fields.
 * @param {object} m - {bodyweight, body_fat_pct, fat_mass, ...}
 * @returns {object} m + derived fat_mass/body_fat_pct where computable
 */
export function deriveBodyComp(m) {
  const out = { ...m };
  const bw = out.bodyweight;
  if (out.fat_mass == null && bw != null && out.body_fat_pct != null) {
    out.fat_mass = (bw * out.body_fat_pct) / 100;
  } else if (out.body_fat_pct == null && bw != null && out.fat_mass != null && bw > 0) {
    out.body_fat_pct = (out.fat_mass / bw) * 100;
  }
  return out;
}

/**
 * A single body-comp metric series over the measurement history (PURE).
 * @param {object[]} measurements - folded.measurements (sorted, non-voided)
 * @param {"bodyweight"|"muscle_mass"|"body_fat_pct"|"fat_mass"} metric
 * @returns {{date:string, value:number}[]} points where the metric is present/derivable
 */
export function measurementSeries(measurements, metric) {
  const pts = [];
  for (const raw of measurements || []) {
    const m = deriveBodyComp(raw);
    const v = m[metric];
    if (typeof v === "number" && !Number.isNaN(v)) {
      pts.push({ date: m.date, value: v });
    }
  }
  return pts;
}

/**
 * Trailing N-day moving average over date/value points. For each input point,
 * average the values within the trailing `windowDays` (inclusive). Points must
 * be date-sorted ascending. Returns `{date, value}[]` aligned to the inputs.
 * @param {{date:string, value:number}[]} points
 * @param {number} [windowDays=7]
 */
export function movingAverage(points, windowDays = 7) {
  if (!points || !points.length) return [];
  const ms = (d) => new Date(d + "T00:00:00").getTime();
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const endT = ms(points[i].date);
    const startT = endT - (windowDays - 1) * 86400000;
    let sum = 0;
    let n = 0;
    // Walk back while within window (points are sorted asc, so go backwards).
    for (let j = i; j >= 0; j--) {
      if (ms(points[j].date) < startT) break;
      sum += points[j].value;
      n += 1;
    }
    out.push({ date: points[i].date, value: n ? sum / n : points[i].value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Progression (double progression) — CONTRACT-phase3 §5
// ---------------------------------------------------------------------------

/**
 * Progression suggestion over the LAST working session (PURE, advisory). Returns
 * null when there's no actionable suggestion (cardio, no range/increment, held,
 * or simply "not earned"). NEVER scolds — a missed top-of-range yields null.
 *
 * @param {object} folded - foldLog result
 * @param {object} exercise - definition (rep_range_low/high, increment, type,
 *   uses_bodyweight, hold_progression)
 * @param {string} [beforeDate] - the session date being logged; only sessions
 *   STRICTLY BEFORE it count (mirrors lastSessionFor). Omit to consider all.
 *   Prevents a backfilled past day from basing its hint on a LATER session.
 * @returns {null | {
 *   kind: "add_weight"|"reduce_assist"|"add_reps"|"first_time",
 *   delta: number|null,       // base lb delta (signed); null for first_time/add_reps weight
 *   targetReps: number|null,  // suggested target reps
 *   message: string,          // short muted-hint text (display unit added by UI)
 *   fromSession: string|null  // session_date the suggestion is based on
 * }}
 */
export function progressionSuggestion(folded, exercise, beforeDate) {
  if (!exercise) return null;
  if (exercise.type === "cardio") return null;
  if (exercise.hold_progression) return null;
  const low = exercise.rep_range_low;
  const high = exercise.rep_range_high;
  const inc = exercise.increment;
  if (low == null || high == null) return null; // no range -> no suggestion

  const byDate = folded.sets[exercise.exercise_id] || {};
  const dates = Object.keys(byDate)
    .filter((d) => (beforeDate == null ? true : d < beforeDate))
    .sort();
  // Find the most recent working session strictly before `beforeDate`.
  let last = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    const arr = Object.values(byDate[dates[i]])
      .filter((s) => !s.warmup)
      .sort((a, b) => a.set_index - b.set_index);
    if (arr.length) {
      last = { date: dates[i], sets: arr };
      break;
    }
  }

  // First time / no history -> suggest the rep range, no delta.
  if (!last) {
    return {
      kind: "first_time",
      delta: null,
      targetReps: low,
      message: `aim ${low}–${high} reps`,
      fromSession: null,
    };
  }

  // Earned a step ONLY if every working set hit (>=) rep_range_high.
  const allHitTop = last.sets.every((s) => typeof s.reps === "number" && s.reps >= high);
  if (!allHitTop) return null; // missed top / deload -> stay quiet (never scold)

  // Assisted last session (any working set with negative added_weight).
  const wasAssisted = last.sets.some(
    (s) => typeof s.added_weight === "number" && s.added_weight < 0,
  );

  // Success path (H2):
  //  - assisted + increment -> reduce_assist (−increment)
  //  - non-assisted + increment -> add_weight (+increment), target reps = low
  //  - hit-top but NO usable increment (either case, e.g. bodyweight dips) ->
  //    add_reps (+1 rep, hold weight). Reward is never withheld for lack of an
  //    increment; the weight/assist deltas (add_weight/reduce_assist) need one.
  if (exercise.uses_bodyweight && wasAssisted && inc != null) {
    return {
      kind: "reduce_assist",
      delta: -inc, // reduce assist magnitude -> added_weight moves toward 0
      targetReps: low,
      message: null, // UI formats with the display-unit increment
      fromSession: last.date,
    };
  }
  if (!wasAssisted && inc != null) {
    return {
      kind: "add_weight",
      delta: inc,
      targetReps: low,
      message: null, // UI formats with the display-unit increment
      fromSession: last.date,
    };
  }
  // Hit top, no usable increment -> add a rep, hold the weight.
  return {
    kind: "add_reps",
    delta: null,
    targetReps: null, // current reps + 1 (resolved by the UI from the last set)
    message: "hit top reps — try +1 rep next time",
    fromSession: last.date,
  };
}
