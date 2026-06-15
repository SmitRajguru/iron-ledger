/**
 * Event schema versioning + upcast-on-read (forward/backward compatibility).
 *
 * The store is APPEND-ONLY: a stored event is NEVER rewritten. Instead, every
 * event is normalized to CURRENT_VERSION at READ time (before folding), keyed on
 * its `v`. This is the single seam a future schema change plugs into — folds and
 * analytics always see current-shaped payloads regardless of how old the data is.
 *
 * Dependency-free on purpose (no svelte/db imports) so it stays unit-testable and
 * so sync.js can source the version constant from here without a circular import.
 *
 * --- Adding a new version (v(N) -> v(N+1)) ---
 *   1. Bump CURRENT_VERSION below (sync.js re-exports it as SCHEMA_VERSION, so new
 *      events stamp the new `v` automatically).
 *   2. Register MIGRATIONS[N] = (ev) => ({ ...ev, v: N+1, payload: <upcast payload> }).
 *      Each step knows ONLY its single increment; migrateEvent chains them.
 *   3. Bump server MAX_EVENT_VERSION (events.py) and teach validate_payload the new
 *      shape — deploy the SERVER FIRST (see docs/DATA-MIGRATION.md), then clients.
 *   4. NEVER repurpose an existing field's meaning without a version bump.
 */

/** The schema version new events are written at. Bump when payload shape changes. */
export const CURRENT_VERSION = 1;

/** A stored event's schema version. Events written before the field existed (and
 * any malformed `v`) are treated as v1. */
export function eventVersion(ev) {
  const v = ev && ev.v;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1;
}

/**
 * Ordered upcast steps. MIGRATIONS[n] takes a v(n) event and returns a v(n+1)
 * event (upcast payload + bumped `v`). Empty today — only v1 exists.
 * @type {Record<number, (ev: object) => object>}
 */
export const MIGRATIONS = {
  // Example for the future:
  // 1: (ev) => ({ ...ev, v: 2, payload: { ...ev.payload, /* upcast v1 -> v2 */ } }),
};

/**
 * Normalize a stored event to CURRENT_VERSION (PURE).
 *  - v1 / absent-v with no migrations registered  -> returned unchanged (identity).
 *  - older v with migrations registered            -> chained upcast to current.
 *  - NEWER than this client understands (v > CURRENT_VERSION) -> returns null so the
 *    caller SKIPS it instead of folding a shape it can't interpret. This is the
 *    real multi-device case: the phone PWA updates before the watch, so the watch
 *    may pull events a newer client wrote. Skipping (not crashing, not guessing) is
 *    the safe choice — the event is still stored server-side and folds correctly
 *    once this client updates.
 * Preserves _seq/_enq/id/ts (migration steps only touch payload + v).
 */
export function migrateEvent(ev) {
  let v = eventVersion(ev);
  if (v > CURRENT_VERSION) return null; // newer schema than we know -> skip
  if (v === CURRENT_VERSION) return ev; // fast path: nothing to upcast (all of v1 today)
  let out = ev;
  while (v < CURRENT_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) {
      // Registry gap (should never happen if a version was added correctly).
      console.warn(`[migrations] no upcast step v${v} -> v${v + 1}; leaving event as-is`);
      break;
    }
    const next = step(out);
    if (!next || typeof next !== "object") {
      // A broken step must NOT yield a falsy/garbage event that silently vanishes
      // from the fold. Keep the last good shape and stop.
      console.warn(`[migrations] step v${v} returned a non-object; keeping prior shape`);
      break;
    }
    out = next;
    v += 1;
  }
  // Pin the immutable envelope fields from the ORIGINAL event: a migration step may
  // only transform `payload` (and `v`). This structurally prevents a sloppy future
  // step from dropping id/_seq/_enq/ts/voids and breaking fold ordering / outbox
  // identity — even though no step exists today.
  const pinned = { ...out, id: ev.id, ts: ev.ts, device: ev.device, voids: ev.voids };
  if (ev._seq !== undefined) pinned._seq = ev._seq;
  if (ev._enq !== undefined) pinned._enq = ev._enq;
  return pinned;
}
