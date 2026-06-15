/**
 * Sync queue + reactive sync state for WT Tracker (CONTRACT-phase1.md).
 *
 * Flow: queue(event) -> outbox (IndexedDB) -> flush() POSTs to /api/sync ->
 * accepted/duplicate ids move out of outbox into the events store. pull() reads
 * server events newer than the highest _seq we've seen. The queue is idempotent
 * because the server dedupes by event id, so retrying a flush is always safe.
 */

import { writable, derived } from "svelte/store";
import { putAll, getAll, deleteMany, put } from "./db.js";
import { user } from "./auth.js";
import { CURRENT_VERSION } from "./migrations.js";

const DEVICE_KEY = "wt_device_id";
const ENQ_COUNTER_KEY = "wt_enq_counter";
/**
 * Event schema version, stamped on every new event (forward-migration lever).
 * Single source of truth lives in migrations.js (the upcast layer keyed on it);
 * the server treats an absent `v` as 1 for events written before the field existed.
 */
export const SCHEMA_VERSION = CURRENT_VERSION;
/**
 * Max events per /api/sync POST. flush() drains the outbox in chunks of this size
 * so a large offline backlog never lands as one oversized all-or-nothing request
 * (which could time out / hit a body limit and wedge the queue). Kept well below
 * the server's hard cap (routes_sync.MAX_EVENTS_PER_SYNC) so a chunk never trips it.
 */
const FLUSH_BATCH = 250;
// Periodic safety-net retry: covers cases the `online` event misses (e.g. flaky
// connectivity that never fully toggled offline, or a server that was down).
const RETRY_INTERVAL_MS = 30_000;

/**
 * Monotonic local enqueue sequence (C1). The outbox is id-keyed (UUIDs), so
 * getAll() returns UUID order, NOT enqueue order -- that would POST superseding
 * edits out of order (server `_seq` inverts) and fold the projection wrong
 * offline. We stamp each outbox record with `_enq` so flush() can POST in
 * enqueue order and library.js can fold in enqueue order. `_enq` is a
 * client-only field, stripped from the envelope before POST.
 *
 * MED fix: the counter lives in a MODULE-LEVEL in-memory variable that ALWAYS
 * increments, regardless of whether localStorage works. It is seeded once from
 * max(persisted counter, highest existing outbox _enq); localStorage is a
 * best-effort persistence layer only. A storage failure can never reset the
 * sequence toward 1 or produce ties (which would reintroduce UUID-order folds).
 */
let enqCounter = 0;
/**
 * Memoized seed promise. queue() MUST `await seedEnq()` before nextEnq() so no
 * `_enq` is ever assigned until seeding has fully RESOLVED (not merely started).
 * The earlier version flipped a synchronous `seeded` flag before awaiting the
 * outbox scan, so the first enqueue could race ahead and assign an `_enq` below
 * an existing outbox value. A single shared promise closes that window.
 * @type {Promise<void> | null}
 */
let enqSeedPromise = null;

/** Seed the in-memory counter once from persisted state + the existing outbox. */
function seedEnq() {
  if (enqSeedPromise) return enqSeedPromise;
  enqSeedPromise = (async () => {
    let fromStore = 0;
    try {
      fromStore = parseInt(localStorage.getItem(ENQ_COUNTER_KEY) || "0", 10) || 0;
    } catch {
      /* storage unavailable -- rely on the outbox scan below */
    }
    let fromOutbox = 0;
    try {
      const rows = /** @type {any[]} */ (await getAll("outbox"));
      for (const r of rows) {
        if (typeof r._enq === "number" && r._enq > fromOutbox) fromOutbox = r._enq;
      }
    } catch {
      /* no outbox yet */
    }
    enqCounter = Math.max(enqCounter, fromStore, fromOutbox);
  })();
  return enqSeedPromise;
}

/** Next strictly-increasing enqueue key. In-memory is authoritative. */
function nextEnq() {
  enqCounter += 1; // always advances, even if persistence below throws
  try {
    localStorage.setItem(ENQ_COUNTER_KEY, String(enqCounter));
  } catch {
    /* best-effort persistence; in-memory monotonicity already guaranteed */
  }
  return enqCounter;
}

/** Sort outbox records by their local enqueue order. */
function byEnq(a, b) {
  return (a._enq || 0) - (b._enq || 0);
}

/** Drop client-only fields before POSTing the canonical envelope to the server. */
function toEnvelope({ _enq, ...envelope }) {
  return envelope;
}

/**
 * Events currently waiting in the outbox (the local source of truth for what's
 * unsynced). Kept as the full records so the UI can show a pending-sync viewer;
 * `pending` count derives from it. Refreshed on every queue/flush.
 * @type {import('svelte/store').Writable<ReturnType<typeof makeEvent>[]>}
 */
const outbox = writable([]);
/** Number of events waiting in the outbox (derived from `outbox`). */
const pending = derived(outbox, ($o) => $o.length);
/** True while a flush/pull request is in flight. */
const busy = writable(false);
/**
 * Consecutive flush/pull failures while we believed we were online. >0 drives
 * the distinct red "error" state so a failing server is not mistaken for a
 * healthy draining queue (review T1).
 */
const failures = writable(0);
/** Browser connectivity (navigator.onLine + online/offline events). */
const browserOnline = writable(
  typeof navigator !== "undefined" ? navigator.onLine : true,
);
/**
 * Set true when the server returns 401 from sync/pull mid-session: the cookie
 * expired. The UI prompts re-login; the outbox is NOT discarded (review T2).
 */
const sessionExpired = writable(false);
/**
 * Dev-only "simulate offline" switch. When true, queue() still persists locally
 * but flush()/pull() skip the network, so disconnection is testable in-app
 * without DevTools. Always false in a production build (toggle is DEV-guarded).
 */
const simulatedOffline = writable(false);
/**
 * Monotonic counter bumped whenever the local event log changes (queue or a
 * successful pull). Projections (library.js) subscribe to this to rebuild
 * without sync.js depending on the projection layer (one-way dependency).
 */
const logRevision = writable(0);
const bumpLog = () => logRevision.update((n) => n + 1);
/**
 * Count of events the server rejected this session (malformed = client bug, not
 * user error). Drives a quiet "n item(s) couldn't sync" note. Details live in
 * the "deadletter" IndexedDB store (CONTRACT-phase2a §rejected handling).
 */
const rejectedCount = writable(0);
/**
 * Set of event ids the server rejected (dead-lettered) this session. The Today
 * screen cross-refs a set row's id against this to show a LOUD red per-set error
 * state (U2) -- a rejected set must never masquerade as "saved".
 * @type {import('svelte/store').Writable<Set<string>>}
 */
const rejectedIds = writable(new Set());

export const syncState = {
  outbox,
  pending,
  busy,
  failures,
  browserOnline,
  sessionExpired,
  simulatedOffline,
  logRevision,
  rejectedCount,
  rejectedIds,
};

/** True when we should actually talk to the network. */
const effectiveOnline = derived(
  [browserOnline, simulatedOffline],
  ([$on, $sim]) => $on && !$sim,
);

/**
 * Coarse sync status for the header indicator.
 * Precedence: offline (calm, data saved locally) > error (red, retrying) >
 * syncing > pending (amber, "saved, n to sync") > online.
 * @type {import('svelte/store').Readable<{kind: 'online'|'offline'|'error'|'pending'|'syncing', count: number}>}
 */
export const syncStatus = derived(
  [effectiveOnline, busy, pending, failures],
  ([$online, $busy, $pending, $failures]) => {
    if (!$online) return { kind: "offline", count: $pending };
    if ($failures > 0) return { kind: "error", count: $pending };
    if ($busy) return { kind: "syncing", count: $pending };
    if ($pending > 0) return { kind: "pending", count: $pending };
    return { kind: "online", count: 0 };
  },
);

/**
 * Stable per-device id, persisted in localStorage (not sensitive). Resilient to
 * storage failures: falls back to a session-only id so event construction never
 * throws (the MED enqueue-resilience guarantee depends on queue() not crashing).
 */
let sessionDeviceId = null;
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    if (!sessionDeviceId) sessionDeviceId = crypto.randomUUID();
    return sessionDeviceId;
  }
}

/**
 * Build a valid event envelope (DESIGN.md §4 / contract). Caller supplies the
 * event `type` and `payload`; the rest is filled in here.
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @returns {{id: string, type: string, ts: string, device: string, voids: null, payload: Record<string, unknown>}}
 */
export function makeEvent(type, payload = {}) {
  return {
    v: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    type,
    ts: new Date().toISOString(),
    device: deviceId(),
    voids: null,
    payload,
  };
}

/** Reload the outbox store from IndexedDB (enqueue order) for the count + viewer. */
async function refreshOutbox() {
  const rows = /** @type {any[]} */ (await getAll("outbox"));
  rows.sort(byEnq);
  outbox.set(rows);
}

let online = true;
effectiveOnline.subscribe((v) => (online = v));

let flushing = false;

/** Raised on a 401 so the sync cycle can mark the session expired and stop. */
class SessionExpiredError extends Error {}

/**
 * Enqueue an event and try to flush immediately.
 * @param {ReturnType<typeof makeEvent>} event
 */
export async function queue(event) {
  await seedEnq(); // one-time seed from persisted counter + existing outbox
  // Stamp a monotonic local enqueue key so order survives the id-keyed store (C1).
  const record = { ...event, _enq: nextEnq() };
  await putAll("outbox", [record]);
  await refreshOutbox();
  bumpLog(); // projections rebuild from the new local write immediately
  flush().catch((e) => console.warn("[sync] flush after queue failed", e));
}

/**
 * Drain the outbox to the server, then pull. Idempotent: the server dedupes by
 * id, so accepted+duplicate ids are both treated as confirmed.
 *
 * Failure handling (review T1/T2/M2):
 *  - 401 -> mark session expired, keep the outbox, surface a re-login prompt.
 *  - other failure while online -> bump the failure counter (red error state).
 *  - success -> reset the failure counter.
 * @returns {Promise<void>}
 */
export async function flush() {
  if (!online || flushing) return;
  // Claim the reentrancy guard BEFORE the first await: getAll() below yields, so
  // two near-simultaneous flush() calls (queue + interval) would otherwise both
  // pass the check and run overlapping chunk loops. Reset in the outer finally.
  flushing = true;
  try {
    // Local snapshot of the outbox records to push (distinct from the `outbox`
    // store, which the UI reads), in enqueue order so the server assigns `_seq`
    // monotonically with our local order (C1).
    const queued = /** @type {any[]} */ (await getAll("outbox"));
    queued.sort(byEnq);
    if (!queued.length) {
      // Nothing to push, but still reconcile remote events. No `busy` flash here
      // so the 30s interval doesn't pulse "Syncing…" when there's no work.
      try {
        await pull();
        failures.set(0);
      } catch (e) {
        handleSyncError(e);
      }
      return;
    }

    busy.set(true);
    try {
      // Drain in enqueue order, FLUSH_BATCH events at a time. A week-long offline
      // backlog thus never POSTs as one oversized all-or-nothing request that could
      // time out / hit a body limit and wedge the queue. Each chunk preserves the
      // M2 atomicity (pull-before-delete) so a confirmed event is never lost.
      for (let i = 0; i < queued.length; i += FLUSH_BATCH) {
        const chunk = queued.slice(i, i + FLUSH_BATCH);
        const res = await fetch("/api/sync", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          // Strip the client-only `_enq` -- the server stores the canonical envelope.
          body: JSON.stringify({ events: chunk.map(toEnvelope) }),
        });
        if (res.status === 401) throw new SessionExpiredError();
        if (!res.ok) throw new Error(`/api/sync -> ${res.status}`);
        /** @type {{accepted: string[], duplicate: string[], rejected?: {id: string, reason: string}[]}} */
        const { accepted = [], duplicate = [], rejected = [] } = await res.json();

        // Rejected = the server found the event malformed. That's a CLIENT bug, not
        // user error -- retrying forever would loop. Remove it from the outbox,
        // dead-letter it for inspection, and surface a quiet note (no red alarm).
        // Scope the lookup to THIS chunk -- those are the ids that were POSTed.
        if (rejected.length) await handleRejected(chunk, rejected);

        const confirmedIds = new Set([...accepted, ...duplicate]);
        const confirmed = chunk.filter((e) => confirmedIds.has(e.id));
        if (confirmed.length) {
          // Atomicity (review M2): pull the confirmed events into "events" FIRST,
          // then delete them from "outbox". The server assigns _seq, so we pull to
          // learn it. If the pull throws, the confirmed events stay in the outbox
          // and get re-pushed next cycle (server dedupes) -- never lost from both.
          await pull();
          await deleteMany(
            "outbox",
            confirmed.map((e) => e.id),
          );
          // C2: the confirmed events now live only in "events" (with their _seq).
          // Bump so the projection rebuilds without the stale outbox copies that
          // a pull-triggered rebuild would otherwise still fold as winners.
          bumpLog();
        }
      }
      // Final reconcile so remote-only events land even if the last chunk added none.
      await pull();
      await refreshOutbox();
      failures.set(0);
    } catch (e) {
      handleSyncError(e);
    } finally {
      busy.set(false);
    }
  } finally {
    flushing = false;
  }
}

/** Map a sync/pull error to the right reactive state. */
function handleSyncError(e) {
  if (e instanceof SessionExpiredError) {
    // Session gone: prompt re-login. Outbox is intentionally untouched so the
    // queued work flushes once the user logs back in.
    sessionExpired.set(true);
    user.set(null);
    console.warn("[sync] session expired (401) -- outbox preserved");
    return;
  }
  // Real failure while online (network/server). Surface the red error state.
  failures.update((n) => n + 1);
  console.warn("[sync] sync failed", e);
}

/** Highest _seq we've stored, or 0 if none. */
async function maxSeq() {
  const events = /** @type {{_seq: number}[]} */ (await getAll("events"));
  return events.reduce((m, e) => (e._seq > m ? e._seq : m), 0);
}

/**
 * Pull server events newer than the highest _seq we've seen into "events".
 * Throws SessionExpiredError on 401 so callers can handle re-login. Other
 * failures throw normally and bubble to the caller's error handling.
 * @returns {Promise<void>}
 */
export async function pull() {
  if (!online) return;
  const since = await maxSeq();
  const res = await fetch(`/api/events?since=${since}`, {
    credentials: "include",
  });
  if (res.status === 401) throw new SessionExpiredError();
  if (!res.ok) throw new Error(`/api/events -> ${res.status}`);
  /** @type {{events: {_seq: number}[]}} */
  const { events = [] } = await res.json();
  if (events.length) {
    await putAll("events", events);
    bumpLog(); // new confirmed events -> projections rebuild
  }
}

/**
 * Move server-rejected events out of the outbox into the dead-letter store so
 * they stop looping, and bump the quiet rejected-count note.
 * @param {ReturnType<typeof makeEvent>[]} queued - the batch we just pushed
 * @param {{id: string, reason: string}[]} rejected
 */
async function handleRejected(queued, rejected) {
  const byId = new Map(queued.map((e) => [e.id, e]));
  for (const r of rejected) {
    const orig = byId.get(r.id);
    console.error("[sync] event rejected by server (client bug):", r, orig);
    await put("deadletter", {
      id: r.id,
      reason: r.reason,
      event: orig || null,
      at: new Date().toISOString(),
    });
  }
  await deleteMany(
    "outbox",
    rejected.map((r) => r.id),
  );
  // Track rejected ids so the UI can paint a LOUD per-set error state (U2).
  rejectedIds.update((s) => {
    const next = new Set(s);
    for (const r of rejected) next.add(r.id);
    return next;
  });
  // C3: dead-lettered events are gone from the outbox -- rebuild so they vanish
  // from the projection immediately, not on the next unrelated event.
  bumpLog();
  rejectedCount.update((n) => n + rejected.length);
}

/** Real event types the app projects over; anything else is noise (e.g. an old
 * dev `dev_noop` that the server rejected). Used to purge junk dead-letters. */
const REAL_EVENT_TYPES = new Set([
  "set_logged",
  "measurement",
  "exercise_defined",
  "exercise_updated",
  "routine_defined",
  "routine_updated",
]);

/**
 * Seed rejectedIds from the persisted dead-letter store (survives reload), AND
 * purge non-real-event entries (F1): a stale `dev_noop` rejected by the server
 * should never keep showing "N items couldn't sync". The note reflects only
 * real events that genuinely failed.
 */
async function seedRejectedIds() {
  try {
    const rows = /** @type {{id: string, event?: {type?: string}}[]} */ (
      await getAll("deadletter")
    );
    if (!rows.length) return;
    const junk = rows.filter(
      (r) => !r.event || !REAL_EVENT_TYPES.has(r.event.type),
    );
    if (junk.length) {
      await deleteMany(
        "deadletter",
        junk.map((r) => r.id),
      );
    }
    const real = rows.filter(
      (r) => r.event && REAL_EVENT_TYPES.has(r.event.type),
    );
    rejectedIds.set(new Set(real.map((r) => r.id)));
    rejectedCount.set(real.length);
  } catch {
    /* no deadletter store yet */
  }
}

/**
 * Dismiss the "N items couldn't sync" note (F1). Clears the user-facing count;
 * the dead-letter records themselves remain for debugging, and per-set error
 * rows (rejectedIds) still surface a rejected set on its own row.
 */
export function dismissRejectedNote() {
  rejectedCount.set(0);
}

/**
 * Clear the session-expired flag after a successful re-login, then flush the
 * preserved outbox. Call this from the auth flow once the user logs back in.
 */
export function resumeAfterRelogin() {
  sessionExpired.set(false);
  failures.set(0);
  flush().catch((e) => console.warn("[sync] flush after relogin failed", e));
}

/** Toggle the dev-only simulated-offline switch. */
export function setSimulatedOffline(v) {
  simulatedOffline.set(v);
  if (!v) flush().catch((e) => console.warn("[sync] flush on resume failed", e));
}

let started = false;
let intervalId;
// Keep handler refs so stopSync() can remove them (review L1: relogin cycles
// were stacking duplicate listeners).
let goOnline;
let goOffline;

/**
 * Wire up automatic syncing: reflect browser connectivity, flush on reconnect,
 * and retry on a modest interval. Call once after the user is authenticated.
 */
export function startSync() {
  if (started) return;
  started = true;

  // Best-effort: ask the browser to keep our IndexedDB durable. Without this the
  // outbox (logged-but-unsynced sets) can be evicted under storage pressure --
  // esp. an installed PWA on iOS -- which is silent data loss. No-op if denied.
  try {
    navigator.storage?.persist?.().then(
      (granted) => console.info("[storage] persistent:", granted),
      () => {},
    );
  } catch {
    /* storage API unavailable */
  }

  goOnline = () => {
    browserOnline.set(true);
    flush().catch((e) => console.warn("[sync] flush on reconnect failed", e));
  };
  goOffline = () => browserOnline.set(false);
  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);

  intervalId = setInterval(() => {
    flush().catch((e) => console.warn("[sync] interval flush failed", e));
  }, RETRY_INTERVAL_MS);

  seedEnq(); // seed the enqueue counter from any persisted/offline outbox
  seedRejectedIds(); // restore dead-letter ids so error rows survive reload
  refreshOutbox();
  // Initial sync: push anything queued offline, then pull down remote events.
  flush().catch((e) => console.warn("[sync] initial flush failed", e));
}

/** Tear down listeners/interval (used on logout). */
export function stopSync() {
  if (!started) return;
  started = false;
  clearInterval(intervalId);
  window.removeEventListener("online", goOnline);
  window.removeEventListener("offline", goOffline);
}
