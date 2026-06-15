/**
 * Shared logging logic for WT Tracker (CONTRACT-phase2b §Projections).
 *
 * PLAIN module on purpose — no Svelte-component coupling — so the eventual watch
 * reuses the same set-event construction + "next set to log" pure function. The
 * only reactive bits are stores rebuilt from the event log on `logRevision`.
 *
 * Projections fold `set_logged` ∪ outbox in enqueue order, skipping voided events
 * (mirrors library.js semantics): id voided by a later event never wins; a
 * `payload.deleted` tombstone removes a set. From that fold we expose:
 *   - today's session (set_logged for today's LOCAL date, grouped by exercise),
 *   - last-session-per-exercise (most recent session_date with WORKING sets),
 *   - the set of event ids confirmed in the server `events` store (save state),
 *   - the latest bodyweight measurement (for the assisted bodyweight_snapshot).
 */

import { writable, derived, get } from "svelte/store";
import { getAll } from "./db.js";
import { syncState, makeEvent } from "./sync.js";
import { getBaseUnit, toBase, lengthToBase } from "./units.js";
import { migrateEvent } from "./migrations.js";

/** Today's LOCAL calendar date (America/Los_Angeles) as YYYY-MM-DD. */
export function todayLocalDate(now = new Date()) {
  // en-CA gives YYYY-MM-DD; the timeZone pins it to the project convention.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Build a `set_logged` payload (CONTRACT-phase2b). Weights arrive in the DISPLAY
 * unit and are converted to base_unit at full precision here; the stored `unit`
 * is always base_unit (self-describing). `added_weight` is signed (assist
 * negative, added positive) and only meaningful for `uses_bodyweight` exercises.
 *
 * @param {object} f
 * @param {string} f.exercise_id
 * @param {string} f.session_date - YYYY-MM-DD (local)
 * @param {number} f.set_index
 * @param {boolean} [f.warmup]
 * @param {number|null} [f.weightDisplay] - weight typed in display unit (null = bodyweight)
 * @param {number|null} [f.weightBase] - weight already in base_unit (full precision);
 *   takes precedence over weightDisplay so an untouched, toggled value never bakes
 *   display rounding into storage (F4).
 * @param {number|null} [f.reps]
 * @param {number} [f.addedWeightDisplay] - signed added/assist in display unit
 * @param {number} [f.addedWeightBase] - signed added/assist already in base_unit
 * @param {number|null} [f.bodyweightSnapshot] - base_unit, frozen at log time
 * @param {boolean} [f.usesBodyweight]
 * @param {boolean} [f.deleted] - tombstone (delete a set)
 * @returns {object} set_logged payload
 */
export function buildSetPayload(f) {
  if (f.deleted) {
    // Minimal tombstone: identity + delete marker (projection drops the set).
    return {
      exercise_id: f.exercise_id,
      session_date: f.session_date,
      set_index: f.set_index,
      deleted: true,
    };
  }
  // Prefer a full-precision base value when supplied; else convert the typed
  // display value. (F4: a value carried through a unit toggle stays canonical.)
  const weight =
    f.weightBase != null
      ? f.weightBase
      : f.weightDisplay == null || f.weightDisplay === ""
        ? null
        : toBase(Number(f.weightDisplay));
  const payload = {
    exercise_id: f.exercise_id,
    session_date: f.session_date,
    set_index: f.set_index,
    unit: getBaseUnit(),
    warmup: !!f.warmup,
    weight,
    reps: f.reps == null || f.reps === "" ? null : Number(f.reps),
  };
  if (f.usesBodyweight) {
    payload.added_weight =
      f.addedWeightBase != null
        ? f.addedWeightBase
        : f.addedWeightDisplay == null || f.addedWeightDisplay === ""
          ? 0
          : toBase(Number(f.addedWeightDisplay));
    payload.bodyweight_snapshot =
      f.bodyweightSnapshot == null ? null : f.bodyweightSnapshot;
    // M1: freeze the snapshot's SOURCE measurement date so staleness can be
    // computed for real (session_date − snapshot_date). Only when a snapshot
    // exists + a date is known; older events simply lack it (show no note).
    if (f.bodyweightSnapshot != null && f.bodyweightSnapshotDate) {
      payload.bodyweight_snapshot_date = f.bodyweightSnapshotDate;
    }
  }
  return payload;
}

/**
 * Build a full `set_logged` event envelope (id/ts/device/voids via sync.makeEvent).
 * @param {object} fields - see buildSetPayload; plus optional `voids` (edit/delete)
 * @returns {object} event envelope
 */
export function buildSetEvent(fields) {
  const ev = makeEvent("set_logged", buildSetPayload(fields));
  if (fields.voids) ev.voids = fields.voids;
  return ev;
}

/**
 * Build a CARDIO `set_logged` event (CONTRACT-phase5a §3): `duration_s` and/or
 * `distance_m`, NO weight/reps, and OMIT `unit` (server now allows missing unit).
 * The client enforces "duration or distance required" at entry; this builder
 * just stamps whatever is provided. distance is stored canonical in meters.
 * @param {object} f
 * @param {string} f.exercise_id
 * @param {string} f.session_date
 * @param {number} f.set_index
 * @param {number|null} [f.duration_s] - whole seconds
 * @param {number|null} [f.distance_m] - meters (canonical)
 * @param {boolean} [f.warmup]
 * @param {string} [f.voids]
 * @returns {object} event envelope
 */
export function buildCardioSetEvent(f) {
  const payload = {
    exercise_id: f.exercise_id,
    session_date: f.session_date,
    set_index: f.set_index,
    warmup: !!f.warmup,
    // NO `unit` (cardio carries no weight); weight/reps omitted entirely.
  };
  if (f.duration_s != null && f.duration_s !== "") {
    payload.duration_s = Math.max(0, Math.round(Number(f.duration_s)));
  }
  if (f.distance_m != null && f.distance_m !== "") {
    payload.distance_m = Math.max(0, Number(f.distance_m));
  }
  const ev = makeEvent("set_logged", payload);
  if (f.voids) ev.voids = f.voids;
  return ev;
}

/**
 * Supersede a logged set's `warmup` flag ONLY, preserving every stored base-unit
 * number byte-identical (C3). The previous approach round-tripped weights through
 * display rounding, corrupting them on a flag toggle. Here we copy the exact
 * stored payload and flip `warmup`; `voids` the prior event.
 * @param {object} set - the projected set ({...payload, __src_id})
 * @returns {object} event envelope
 */
export function buildWarmupToggleEvent(set) {
  // Copy the stored payload verbatim, drop projection-only fields, flip warmup.
  const { __src_id, ...payload } = set;
  const ev = makeEvent("set_logged", { ...payload, warmup: !set.warmup });
  ev.voids = set.__src_id;
  return ev;
}

/**
 * Re-emit a set's EXACT stored base-unit payload as a FRESH event (new id, no
 * voids) — used to retry a rejected/dead-lettered set without re-converting any
 * weights. Strips projection-only fields.
 * @param {object} set - the projected set ({...payload, __src_id})
 * @returns {object} event envelope
 */
export function buildSetRetryEvent(set) {
  const { __src_id, ...payload } = set;
  return makeEvent("set_logged", payload);
}

/**
 * Tombstone delete for a logged set (C2: MINIMAL contract shape). Payload is
 * exactly `{exercise_id, deleted:true}`; `voids` = the prior event id. The fold
 * resolves the actual (session_date, set_index) to remove from the voided event,
 * so the tombstone needn't repeat them.
 * @param {object} set - the projected set ({...payload, __src_id})
 * @returns {object} event envelope
 */
export function buildSetDeleteEvent(set) {
  const ev = makeEvent("set_logged", {
    exercise_id: set.exercise_id,
    deleted: true,
  });
  ev.voids = set.__src_id;
  return ev;
}

// ---------------------------------------------------------------------------
// Pure fold over the event log
// ---------------------------------------------------------------------------

/** Merge confirmed (`_seq`) + outbox (`_enq`) set/measurement events in order,
 * upcasting each to the current schema first (migrateEvent) and dropping any from
 * a newer schema this client can't yet read. _seq/_enq are preserved by migration,
 * so ordering is unaffected. */
function mergeOrdered(events, outbox) {
  const confirmed = [...events].sort((a, b) => a._seq - b._seq);
  const pending = [...outbox].sort((a, b) => (a._enq || 0) - (b._enq || 0));
  return [...confirmed, ...pending].map(migrateEvent).filter((e) => e !== null);
}

/**
 * Fold the ordered event log into the logging projections (PURE).
 *  - sets: `exercise_id -> session_date -> set_index -> {payload, __src_id}`
 *    (latest non-voided per (exercise, session, set_index); tombstone removes).
 *  - latestBodyweight: {value, date} from the newest `measurement` with a weight.
 *  - measurements: full non-voided measurement history, sorted by date then
 *    event order (Phase 3 body-comp). latestBodyweight is UNCHANGED (the 2b
 *    assisted-snapshot path depends on its exact behavior).
 * @param {object[]} ordered
 */
export function foldLog(ordered) {
  const voided = new Set();
  for (const e of ordered) if (e.voids) voided.add(e.voids);

  /** @type {Record<string, Record<string, Record<number, object>>>} */
  const sets = {};
  /** @type {{value: number, date: string} | null} */
  let latestBodyweight = null;
  /** @type {object[]} */
  const measurementsOrdered = []; // in event order (chronological), non-voided

  for (const e of ordered) {
    if (voided.has(e.id)) continue;
    const p = e.payload || {};
    if (e.type === "set_logged") {
      // A tombstone removes its target purely via `voids` (the voided prior
      // event is skipped above), so the minimal `{exercise_id, deleted:true}`
      // shape needs no coords. Skip it as a contributor either way. (We still
      // honor coords if an older superset-shape tombstone carries them.)
      if (p.deleted) {
        if (p.session_date != null && p.set_index != null) {
          const sess = sets[p.exercise_id] && sets[p.exercise_id][p.session_date];
          if (sess) delete sess[p.set_index];
        }
        continue;
      }
      if (!p.exercise_id || p.session_date == null || p.set_index == null) continue;
      const ex = (sets[p.exercise_id] ||= {});
      const sess = (ex[p.session_date] ||= {});
      sess[p.set_index] = { ...p, __src_id: e.id };
    } else if (e.type === "measurement") {
      // A measurement TOMBSTONE (H1) removes its target purely via `voids` (the
      // voided prior is skipped above); the tombstone itself contributes nothing.
      if (p.deleted) continue;
      if (typeof p.bodyweight === "number" && p.date) {
        // Latest by event order (chronological) wins. Stamp the source event id
        // so the pending-bodyweight cache can clear by IDENTITY (M2), not by date.
        latestBodyweight = { value: p.bodyweight, date: p.date, __src_id: e.id };
      }
      // Phase 3: collect any measurement with ≥1 metric + a date for body-comp.
      if (
        p.date &&
        (typeof p.bodyweight === "number" ||
          typeof p.muscle_mass === "number" ||
          typeof p.body_fat_pct === "number" ||
          typeof p.fat_mass === "number" ||
          typeof p.waist === "number")
      ) {
        measurementsOrdered.push({
          date: p.date,
          bodyweight: typeof p.bodyweight === "number" ? p.bodyweight : null,
          muscle_mass: typeof p.muscle_mass === "number" ? p.muscle_mass : null,
          body_fat_pct: typeof p.body_fat_pct === "number" ? p.body_fat_pct : null,
          fat_mass: typeof p.fat_mass === "number" ? p.fat_mass : null,
          waist: typeof p.waist === "number" ? p.waist : null, // canonical cm
          __src_id: e.id,
          __order: measurementsOrdered.length, // preserve event order for same-date
        });
      }
    }
  }
  // Sorted by date, then event order (stable for same-date measurements).
  const measurements = measurementsOrdered
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.__order - b.__order));
  // Expose the voided-id set so callers (freshestBodyweightFull) can drop a
  // pending measurement that has since been tombstoned/superseded (MED fix).
  return { sets, latestBodyweight, measurements, voided };
}

/** Ordered set rows for one (exercise, session): array sorted by set_index. */
function sessionSets(folded, exercise_id, session_date) {
  const sess = folded.sets[exercise_id] && folded.sets[exercise_id][session_date];
  if (!sess) return [];
  return Object.values(sess).sort((a, b) => a.set_index - b.set_index);
}

/**
 * Most recent session STRICTLY BEFORE `beforeDate` for an exercise that has
 * WORKING sets — with its ordered working sets (warmups excluded). Hot read for
 * prefill + the "Last: …" display. Using "strictly before" (not just "not this
 * date") means logging for a PAST day prefills from the day before it, never
 * from a future session (F5).
 * @param {object} folded - foldLog result
 * @param {string} exercise_id
 * @param {string} [beforeDate] - the session date being logged; only earlier
 *   sessions count as "last". Omit to consider all sessions.
 * @returns {{session_date: string, sets: object[]} | null}
 */
export function lastSessionFromFold(folded, exercise_id, beforeDate) {
  const byDate = folded.sets[exercise_id];
  if (!byDate) return null;
  const dates = Object.keys(byDate)
    .filter((d) => (beforeDate == null ? true : d < beforeDate))
    .sort(); // YYYY-MM-DD lexicographic = chronological
  for (let i = dates.length - 1; i >= 0; i--) {
    const working = sessionSets(folded, exercise_id, dates[i]).filter((s) => !s.warmup);
    if (working.length) return { session_date: dates[i], sets: working };
  }
  return null;
}

/**
 * PURE: the next set to log for an exercise today + its prefill (CONTRACT-phase2b
 * priority): (1) prior set THIS session → (2) last-session matching set_index →
 * (3) empty. Returns base_unit numbers; the UI converts to display.
 * @param {object} folded - foldLog result
 * @param {string} exercise_id
 * @param {string} session_date - today's local date
 * @returns {{set_index: number, weight: number|null, reps: number|null, warmup: boolean, added_weight: number|null}}
 */
export function nextSetFromFold(folded, exercise_id, session_date) {
  const today = sessionSets(folded, exercise_id, session_date);
  // C1: next index = max existing set_index + 1, NOT count. After a tombstone
  // leaves a hole (e.g. delete set 1 of [0,1,2] -> [0,2]), the next index must
  // be 3, never a reused 1 that would overwrite an existing set in the fold.
  const set_index = today.length
    ? Math.max(...today.map((s) => s.set_index)) + 1
    : 0;

  // (1) prior set THIS session (the last one performed).
  if (today.length) {
    const prev = today[today.length - 1];
    return {
      set_index,
      weight: prev.weight ?? null,
      reps: prev.reps ?? null,
      warmup: false, // a new set defaults to working even if prev was warmup
      added_weight: prev.added_weight ?? null,
    };
  }

  // (2) last session's WORKING set whose set_index EQUALS the next set_index
  // (M1: match by set_index, not array position — they diverge after a delete
  // hole now that next index = max+1). No "last set" fallback: if last session
  // has no set at this index, fall through to empty.
  const last = lastSessionFromFold(folded, exercise_id, session_date);
  if (last) {
    const match = last.sets.find((s) => s.set_index === set_index);
    if (match) {
      return {
        set_index,
        weight: match.weight ?? null,
        reps: match.reps ?? null,
        warmup: false,
        added_weight: match.added_weight ?? null,
      };
    }
  }

  // (3) empty.
  return { set_index, weight: null, reps: null, warmup: false, added_weight: null };
}

// ---------------------------------------------------------------------------
// Reactive projection (rebuilt on logRevision)
// ---------------------------------------------------------------------------

/**
 * Folded log + the set of event ids confirmed in the server `events` store
 * (for per-set save state) + latest bodyweight. Rebuilt on every log change.
 * @type {import('svelte/store').Writable<{folded: object, syncedIds: Set<string>, latestBodyweight: object|null}>}
 */
export const logState = writable({
  folded: { sets: {}, latestBodyweight: null },
  syncedIds: new Set(),
  latestBodyweight: null,
});

/** Latest bodyweight measurement (base_unit) or null. */
export const latestBodyweight = derived(logState, ($s) => $s.latestBodyweight);

/** Rebuild the logging projection from events ∪ outbox. */
export async function rebuildLog() {
  const [events, outbox] = await Promise.all([getAll("events"), getAll("outbox")]);
  const ordered = mergeOrdered(events, outbox);
  const folded = foldLog(ordered);
  // syncedIds = ids present in the confirmed server store (save-state "synced").
  const syncedIds = new Set(events.map((e) => e.id));
  logState.set({ folded, syncedIds, latestBodyweight: folded.latestBodyweight });
}

let started = false;
let unsub;
/** Keep the logging projection fresh. Call once after auth (alongside startSync). */
export async function startLogging() {
  if (started) return;
  started = true;
  await rebuildLog();
  let first = true;
  unsub = syncState.logRevision.subscribe(() => {
    if (first) {
      first = false;
      return;
    }
    rebuildLog().catch((e) => console.warn("[logging] rebuild failed", e));
  });
}
export function stopLogging() {
  if (!started) return;
  started = false;
  if (unsub) unsub();
}

// ---------------------------------------------------------------------------
// Convenience reads off the live store (UI + watch)
// ---------------------------------------------------------------------------

/** Today's ordered sets for an exercise (live store read). */
export function todaySets(exercise_id, session_date) {
  const { folded } = get(logState);
  return sessionSets(folded, exercise_id, session_date);
}

/** nextSetToLog over the LIVE store (the required pure-function entrypoint). */
export function nextSetToLog(exercise_id, session_date) {
  return nextSetFromFold(get(logState).folded, exercise_id, session_date);
}

/** Last working session for an exercise over the live store. */
export function lastSessionFor(exercise_id, excludeDate) {
  return lastSessionFromFold(get(logState).folded, exercise_id, excludeDate);
}

/**
 * Per-set save state by event-id membership (CONTRACT-phase2b + U2):
 *   "error"   — id was server-rejected / dead-lettered (LOUD red, never "saved"),
 *   "synced"  — id in the confirmed `events` store,
 *   "saved"   — id in the `outbox` (saved on this device, not yet synced),
 *   "draft"   — not persisted yet (no id).
 * `error` is checked FIRST so a rejected set can never masquerade as saved.
 * @param {string|null} eventId
 * @param {Set<string>} syncedIds
 * @param {{id:string}[]} outboxList - reactive sync outbox store value
 * @param {Set<string>} [rejectedIds] - dead-lettered event ids (sync.js)
 * @returns {"draft"|"saved"|"synced"|"error"}
 */
export function saveStateFor(eventId, syncedIds, outboxList, rejectedIds) {
  if (!eventId) return "draft";
  if (rejectedIds && rejectedIds.has(eventId)) return "error";
  if (syncedIds.has(eventId)) return "synced";
  if (outboxList.some((e) => e.id === eventId)) return "saved";
  // Logged but neither store knows it yet (mid-rebuild) -> treat as saved.
  return "saved";
}

/**
 * A just-saved `measurement` queues async (the projection rebuild lags), so we
 * hold the last-emitted bodyweight here and prefer it until the projection
 * catches up — so an assisted set logged right after "Save bodyweight" freezes
 * the correct snapshot, not a stale/null value.
 * @type {{value: number, id: string, date: string} | null}
 */
let pendingBodyweight = null;

/**
 * Synchronous freshest bodyweight (base_unit), pending-aware. Null if unknown.
 *
 * Returns whichever is genuinely NEWEST between a still-relevant pending save and
 * the latest projected measurement. Pending is dropped once it is:
 *   - reflected in the projection (exact id match), OR
 *   - superseded by a strictly newer projected measurement (newer date), OR
 *   - rejected / dead-lettered (its id never lands -> don't get stuck stale).
 */
export function freshestBodyweight() {
  const f = freshestBodyweightFull();
  return f ? f.value : null;
}

/**
 * Like `freshestBodyweight()` but returns `{value, date}` (the source
 * measurement's date) so set logging can freeze `bodyweight_snapshot_date` for a
 * real staleness check (M1). Null when no bodyweight is known.
 * @returns {{value: number, date: string} | null}
 */
export function freshestBodyweightFull() {
  const $log = get(logState);
  const projected = $log.latestBodyweight;
  if (!pendingBodyweight) {
    return projected ? { value: projected.value, date: projected.date } : null;
  }

  // Pending was rejected -> it'll never land; drop it and use the projection.
  const rejected = get(syncState.rejectedIds);
  if (rejected && rejected.has(pendingBodyweight.id)) {
    pendingBodyweight = null;
    return projected ? { value: projected.value, date: projected.date } : null;
  }

  // MED: pending was voided/tombstoned -> a deleted bodyweight must never be
  // snapshotted. Drop it and fall back to the projection (which already excludes
  // the voided measurement).
  const voided = $log.folded && $log.folded.voided;
  if (voided && voided.has(pendingBodyweight.id)) {
    pendingBodyweight = null;
    return projected ? { value: projected.value, date: projected.date } : null;
  }

  if (projected) {
    // The projection now reflects exactly our pending save -> hand off.
    if (projected.__src_id === pendingBodyweight.id) {
      pendingBodyweight = null;
      return { value: projected.value, date: projected.date };
    }
    // A different, strictly NEWER projected measurement supersedes our pending.
    if (projected.date > pendingBodyweight.date) {
      pendingBodyweight = null;
      return { value: projected.value, date: projected.date };
    }
  }
  // Otherwise our just-saved value is the freshest known.
  return { value: pendingBodyweight.value, date: pendingBodyweight.date };
}

/**
 * Build a `measurement` event for the minimal (2b) bodyweight capture AND record
 * it as the pending freshest bodyweight synchronously, keyed by the event id (M2).
 */
export function buildMeasurementEvent(bodyweightDisplay, date = todayLocalDate()) {
  const value = toBase(Number(bodyweightDisplay));
  const ev = makeEvent("measurement", { date, bodyweight: value, unit: getBaseUnit() });
  pendingBodyweight = { value, id: ev.id, date };
  return ev;
}

/**
 * Build a full body-comp `measurement` event (Phase 3 Body screen). Weights are
 * passed in DISPLAY unit and converted to base lb; body_fat_pct is unitless.
 * Each field is optional; pass `null`/`undefined` to omit. `fields.voids` edits
 * a prior measurement. Keeps the 2b pending-bodyweight path correct when a
 * bodyweight is present.
 * Weight fields accept EITHER a display value (converted here) OR a full-precision
 * base value (`*Base`), which takes precedence — so a value carried through a unit
 * toggle without an edit logs byte-identical to its original precision, never
 * baking display rounding into storage (F4, mirrors buildSetPayload).
 * @param {object} f
 * @param {string} [f.date]
 * @param {number|null} [f.bodyweightDisplay]
 * @param {number|null} [f.bodyweightBase] - base lb, full precision (wins over display)
 * @param {number|null} [f.muscleMassDisplay]
 * @param {number|null} [f.muscleMassBase]
 * @param {number|null} [f.bodyFatPct] - unitless %
 * @param {number|null} [f.fatMassDisplay]
 * @param {number|null} [f.fatMassBase]
 * @param {number|null} [f.waistDisplay] - waist in display length unit (in/cm)
 * @param {number|null} [f.waistBase] - waist in canonical cm, full precision (wins)
 * @param {string} [f.voids]
 * @returns {object} measurement event envelope
 */
export function buildMeasurementEventFull(f) {
  const date = f.date || todayLocalDate();
  const num = (v) => (v == null || v === "" ? null : Number(v));
  const toB = (v) => (num(v) == null ? null : toBase(num(v)));
  // Prefer a supplied full-precision base; else convert the typed display value.
  const pickBase = (base, disp) => (base != null ? base : toB(disp));
  const payload = { date, unit: getBaseUnit() };
  const bw = pickBase(f.bodyweightBase, f.bodyweightDisplay);
  if (bw != null) payload.bodyweight = bw;
  const mm = pickBase(f.muscleMassBase, f.muscleMassDisplay);
  if (mm != null) payload.muscle_mass = mm;
  const bf = num(f.bodyFatPct);
  if (bf != null) payload.body_fat_pct = bf;
  const fm = pickBase(f.fatMassBase, f.fatMassDisplay);
  if (fm != null) payload.fat_mass = fm;
  // Waist is a LENGTH (canonical cm), not a weight -> its own conversion.
  const waist = f.waistBase != null ? f.waistBase : lengthToBase(f.waistDisplay);
  if (waist != null) payload.waist = waist;

  const ev = makeEvent("measurement", payload);
  if (f.voids) ev.voids = f.voids;
  // Keep the assisted-snapshot freshest-bodyweight path correct: a BW present
  // becomes the new pending; editing-away the BW of the pending measurement
  // (voids it with no bodyweight) clears the now-stale pending (MED).
  if (bw != null) {
    pendingBodyweight = { value: bw, id: ev.id, date };
  } else if (f.voids && pendingBodyweight && pendingBodyweight.id === f.voids) {
    pendingBodyweight = null;
  }
  return ev;
}

/**
 * Build a measurement TOMBSTONE (H1): a `measurement` event with payload
 * `{deleted:true}` + `voids` = the prior measurement event id. Mirrors the
 * set_logged tombstone; the server accepts the deleted shape (skips ≥1-metric)
 * and the fold removes the voided measurement.
 * @param {string} srcId - the prior measurement event id to void
 * @returns {object} measurement event envelope
 */
export function buildMeasurementDeleteEvent(srcId) {
  const ev = makeEvent("measurement", { deleted: true });
  ev.voids = srcId;
  // MED: if we're deleting the still-pending bodyweight, drop it synchronously so
  // an assisted set logged right after never snapshots the deleted value.
  if (pendingBodyweight && pendingBodyweight.id === srcId) {
    pendingBodyweight = null;
  }
  return ev;
}

/** Days since a YYYY-MM-DD date (for the >30d stale-bodyweight nudge). */
export function daysSince(dateStr, now = new Date()) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr + "T00:00:00");
  return Math.floor((now - then) / 86400000);
}
