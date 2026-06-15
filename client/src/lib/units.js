/**
 * Unit model for WT Tracker (docs/UNIT-MODEL.md).
 *
 * Canonical stored unit = `lb`, FIXED app-wide and hidden from the user. ALL
 * stored weights/increments are numbers in lb. The client holds a *display* unit
 * toggle (lb/kg, persisted in localStorage) that converts every displayed weight
 * and the entry field; entry in the displayed unit is converted to lb before any
 * event payload is built. There is NO per-user base_unit / signup selector.
 *
 * Plain module on purpose — no Svelte component coupling — so Phase 2b and the
 * eventual watch reuse the same conversion/format logic. The only reactive bit
 * is `displayUnit` (a tiny writable store) so UI re-renders on toggle.
 */

import { writable, get } from "svelte/store";

/** Exact ratio (docs/UNIT-MODEL.md). */
export const LB_PER_KG = 2.2046226218;
/** Canonical stored unit — fixed constant, never user-configurable. */
export const BASE_UNIT = "lb";
const DISPLAY_UNIT_KEY = "wt_display_unit";

/** @typedef {"lb" | "kg"} Unit */

/** Read the persisted display unit, defaulting to "lb". */
function readDisplayUnit() {
  try {
    const v = localStorage.getItem(DISPLAY_UNIT_KEY);
    return v === "kg" || v === "lb" ? v : "lb";
  } catch {
    return "lb";
  }
}

/**
 * Reactive display unit. Components subscribe to re-render on toggle; non-UI
 * code can read it synchronously via `getDisplayUnit()`.
 * @type {import('svelte/store').Writable<Unit>}
 */
export const displayUnit = writable(readDisplayUnit());

/** Set + persist the display unit. */
export function setDisplayUnit(/** @type {Unit} */ u) {
  displayUnit.set(u);
  try {
    localStorage.setItem(DISPLAY_UNIT_KEY, u);
  } catch {
    /* storage unavailable -- store still drives the UI for this session */
  }
}

/** Synchronous read of the current display unit (for non-reactive callers). */
export function getDisplayUnit() {
  return get(displayUnit);
}

/**
 * Canonical stored unit. FIXED app-wide constant `lb`, hidden from the user
 * (docs/UNIT-MODEL.md). Kept as a function so callers (and `lbToBase`, now
 * identity) stay unchanged; there is no per-user base_unit.
 * @returns {Unit}
 */
export function getBaseUnit() {
  return BASE_UNIT;
}

/** kg -> lb. */
export function kgToLb(kg) {
  return kg * LB_PER_KG;
}

/** lb -> kg. */
export function lbToKg(lb) {
  return lb / LB_PER_KG;
}

/**
 * Convert a weight between units. No-op when from === to.
 * @param {number} value
 * @param {Unit} from
 * @param {Unit} to
 * @returns {number}
 */
export function convert(value, from, to) {
  if (from === to) return value;
  return from === "kg" ? kgToLb(value) : lbToKg(value);
}

/** Round to the nearest 0.5 (display only; stored values keep entry precision). */
export function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

/**
 * A lb constant (catalog / group-default increment, defined in lb) -> the value
 * to STORE in base_unit, at FULL precision (review H2). Never routed through
 * display rounding, so a kg user's prefilled increment is exact.
 * @param {number} lb
 * @returns {number} value in base_unit
 */
export function lbToBase(lb) {
  return convert(lb, "lb", getBaseUnit());
}

/**
 * A stored base-unit weight -> the value to SHOW in the current display unit,
 * rounded to the nearest 0.5. Returns the bare number (caller adds the unit).
 * @param {number} baseValue - weight in base_unit
 * @param {Unit} [display] - display unit (defaults to current toggle)
 * @returns {number}
 */
export function toDisplay(baseValue, display = getDisplayUnit()) {
  return roundHalf(convert(baseValue, getBaseUnit(), display));
}

/**
 * Format a stored base-unit weight for display, with the unit suffix.
 * e.g. toDisplay(2.5 kg-base) shown in lb -> "5.5 lb".
 * @param {number} baseValue
 * @param {Unit} [display]
 * @returns {string}
 */
export function formatWeight(baseValue, display = getDisplayUnit()) {
  if (baseValue == null || Number.isNaN(baseValue)) return "—";
  const n = toDisplay(baseValue, display);
  // Drop a trailing ".0" so "5 lb" not "5.0 lb"; keep ".5".
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${text} ${display}`;
}

/**
 * A value the user TYPED in the display unit -> the number to STORE in
 * base_unit, keeping full entry precision (no rounding). Use when building any
 * weight/increment in an event payload.
 * @param {number} displayValue - value entered in the current display unit
 * @param {Unit} [display]
 * @returns {number}
 */
export function toBase(displayValue, display = getDisplayUnit()) {
  return convert(displayValue, display, getBaseUnit());
}

// ---------------------------------------------------------------------------
// Body-measurement lengths (e.g. waist). Canonical stored unit = cm; the DISPLAY
// length unit pairs with the weight toggle (lb -> inches, kg -> cm), so there's
// one "units" mental model. Full precision stored; display rounded to 0.1.
// ---------------------------------------------------------------------------

export const CM_PER_IN = 2.54;

/** Length unit that pairs with the current weight display unit (lb -> in, kg -> cm). */
export function lengthUnitFor(display = getDisplayUnit()) {
  return display === "kg" ? "cm" : "in";
}

/** Canonical cm -> the value to SHOW (in or cm), rounded to 0.1. Null-safe. */
export function lengthToDisplay(cm, display = getDisplayUnit()) {
  if (cm == null || Number.isNaN(cm)) return null;
  const v = lengthUnitFor(display) === "in" ? cm / CM_PER_IN : cm;
  return Math.round(v * 10) / 10;
}

/** A typed display length (in/cm) -> canonical cm (full precision). Empty -> null. */
export function lengthToBase(value, display = getDisplayUnit()) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return null;
  return lengthUnitFor(display) === "in" ? Number(value) * CM_PER_IN : Number(value);
}

// ---------------------------------------------------------------------------
// Distance units (Phase 5a cardio). Canonical = meters; display km or mi.
// ---------------------------------------------------------------------------

const DISTANCE_UNIT_KEY = "wt_distance_unit";
export const M_PER_MI = 1609.344;
export const M_PER_KM = 1000;

/** @typedef {"km" | "mi"} DistanceUnit */

function readDistanceUnit() {
  try {
    const v = localStorage.getItem(DISTANCE_UNIT_KEY);
    return v === "mi" || v === "km" ? v : "km";
  } catch {
    return "km";
  }
}

/** Reactive display distance unit (km|mi), persisted in localStorage. */
export const distanceUnit = writable(readDistanceUnit());

export function setDistanceUnit(/** @type {DistanceUnit} */ u) {
  distanceUnit.set(u);
  try {
    localStorage.setItem(DISTANCE_UNIT_KEY, u);
  } catch {
    /* storage unavailable */
  }
}
export function getDistanceUnit() {
  return get(distanceUnit);
}

/** meters -> display distance value (km or mi), unrounded. */
export function metersToDisplay(m, unit = getDistanceUnit()) {
  if (m == null || Number.isNaN(m)) return null;
  return unit === "mi" ? m / M_PER_MI : m / M_PER_KM;
}

/** display distance value (km or mi) -> canonical meters (full precision). */
export function distanceToMeters(value, unit = getDistanceUnit()) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return null;
  return unit === "mi" ? Number(value) * M_PER_MI : Number(value) * M_PER_KM;
}

/** Format meters for display, e.g. "5.00 km". null -> "—". */
export function formatDistance(m, unit = getDistanceUnit()) {
  const v = metersToDisplay(m, unit);
  if (v == null) return "—";
  return `${v.toFixed(2)} ${unit}`;
}

/** Format whole seconds as mm:ss (or h:mm:ss past an hour). */
export function formatDuration(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
