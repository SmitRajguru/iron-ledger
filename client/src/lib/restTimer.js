/**
 * Rest timer (CONTRACT-phase5a §1). One active countdown at a time, fully
 * client-side and offline. The running timer (exercise_id + start epoch ms +
 * duration s) is persisted in localStorage so a tab switch / reload doesn't lose
 * it — remaining is always recomputed from wall-clock, never accumulated. Clears
 * on elapse or when a new set starts (which restarts it for that exercise).
 *
 * Plain module + a tiny reactive store; the UI reads `restTimer` and calls
 * start/adjust/skip. A single 1s interval ticks while a timer is active.
 */

import { writable, derived, get } from "svelte/store";

const KEY = "wt_rest_timer";
/** Global default rest when an exercise has no `rest_seconds`. */
export const DEFAULT_REST_SECONDS = 120;
const STEP = 15; // ± seconds

/**
 * @typedef {{ exercise_id: string, startMs: number, durationS: number,
 *   alerted: boolean } | null} RestState
 */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (
      o &&
      typeof o.exercise_id === "string" &&
      typeof o.startMs === "number" &&
      typeof o.durationS === "number"
    ) {
      return { ...o, alerted: !!o.alerted };
    }
  } catch {
    /* ignore */
  }
  return null;
}
function persist(state) {
  try {
    if (state) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable -- in-memory store still drives the UI */
  }
}

/** Raw persisted timer state (or null). UI derives `remaining` reactively. */
const state = writable(load());

/** A monotonic tick so subscribers recompute `remaining` each second. */
const tick = writable(0);

/** Remaining seconds for the active timer right now (wall-clock), or null. */
export function remainingSeconds(s = get(state), now = Date.now()) {
  if (!s) return null;
  const elapsed = (now - s.startMs) / 1000;
  return Math.max(0, Math.ceil(s.durationS - elapsed));
}

/**
 * Reactive view for the UI: `{ exercise_id, remaining, durationS } | null`.
 * Recomputes on every tick + state change.
 * @type {import('svelte/store').Readable<{exercise_id:string, remaining:number, durationS:number}|null>}
 */
export const restTimer = derived([state, tick], ([$s]) => {
  if (!$s) return null;
  return {
    exercise_id: $s.exercise_id,
    remaining: remainingSeconds($s),
    durationS: $s.durationS,
  };
});

let intervalId = null;
function ensureTicking() {
  if (intervalId != null) return;
  intervalId = setInterval(() => {
    const s = get(state);
    if (!s) {
      stopTicking();
      return;
    }
    tick.update((n) => n + 1);
    const rem = remainingSeconds(s);
    if (rem <= 0) {
      // Gentle alert at 0: vibrate if available. (Sound is opt-in / default off.)
      try {
        if (typeof navigator !== "undefined" && navigator.vibrate) {
          navigator.vibrate(200);
        }
      } catch {
        /* vibration unsupported */
      }
      // X4: clear immediately after the alert — stop the interval AND drop the
      // persisted entry so an elapsed timer never lingers (no ghost on reload).
      state.set(null);
      persist(null);
      stopTicking();
    }
  }, 1000);
}
function stopTicking() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Start (or restart) the rest timer for an exercise. Resets any prior timer
 * (only one active at a time). No-op for cardio (caller passes durationS only
 * for non-cardio).
 * @param {string} exercise_id
 * @param {number} durationS
 */
export function startRest(exercise_id, durationS) {
  if (!exercise_id || !(durationS > 0)) return;
  const next = { exercise_id, startMs: Date.now(), durationS, alerted: false };
  state.set(next);
  persist(next);
  ensureTicking();
}

/** Adjust the active timer by ±seconds (clamped at 0). */
export function adjustRest(deltaS) {
  const s = get(state);
  if (!s) return;
  const next = {
    ...s,
    durationS: Math.max(0, s.durationS + deltaS),
    alerted: false, // re-arm the 0-alert if we extended past 0
  };
  state.set(next);
  persist(next);
  ensureTicking();
}
export const stepUp = () => adjustRest(STEP);
export const stepDown = () => adjustRest(-STEP);

/** Skip / clear the active timer. */
export function skipRest() {
  state.set(null);
  persist(null);
  stopTicking();
}

/** Resume ticking on app load if a persisted timer is still running. */
export function resumeRest() {
  const s = get(state);
  if (s && remainingSeconds(s) > 0) ensureTicking();
  else if (s) {
    // Already elapsed while away: keep it shown at 0 (no re-alert), let the UI
    // clear it; or clear immediately. We clear to avoid a stale 0 lingering.
    skipRest();
  }
}

/** Resolve the rest seconds for an exercise (override or global default). */
export function restSecondsFor(exercise) {
  if (!exercise || exercise.type === "cardio") return 0;
  const r = exercise.rest_seconds;
  return typeof r === "number" && r >= 0 ? r : DEFAULT_REST_SECONDS;
}
