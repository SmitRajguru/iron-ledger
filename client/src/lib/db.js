/**
 * Thin IndexedDB wrapper for WT Tracker.
 *
 * Two object stores, per CONTRACT-phase1.md:
 *   - "outbox": unsynced events, keyed by the client-generated event `id`.
 *   - "events": confirmed events pulled/echoed from the server, keyed by the
 *     server-assigned monotonic `_seq`.
 *
 * The client is the offline source of truth during a session (DESIGN.md §3):
 * writes land in IndexedDB immediately and are enqueued in the outbox; the sync
 * queue (sync.js) flushes them to the server and moves confirmed events into the
 * "events" store. Helpers stay generic so callers pass the store name + record.
 */

const DB_NAME = "wt";
// v3: + "library" (materialized exercise projection, keyed by exercise_id),
//        "deadletter" (server-rejected events, keyed by event id),
//        "meta" (small key/value store, e.g. library projection cursor).
// v2: split key paths -- outbox keyed by event `id`, events keyed by `_seq`.
const DB_VERSION = 3;

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/**
 * Open (and lazily cache) the "wt" database, creating object stores on first run.
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const oldVersion = e.oldVersion; // 0 = fresh install

      // The "events" store needs a "_seq" key path. Phase 0 (v1) created it
      // keyed by "id", so ONLY the legacy v1->v2 migration may drop/recreate
      // it. Gating on oldVersion ensures a future version bump never wipes
      // synced history (review M3) -- the keyPath is immutable once created, so
      // we recreate strictly for the legacy schema and otherwise leave it.
      if (oldVersion === 0) {
        // Fresh install: create both stores with their final key paths.
        db.createObjectStore("events", { keyPath: "_seq" });
        db.createObjectStore("outbox", { keyPath: "id" });
      } else if (oldVersion === 1) {
        // Legacy v1 had "events" keyed by "id" and (maybe) no/old "outbox".
        if (db.objectStoreNames.contains("events")) {
          db.deleteObjectStore("events");
        }
        db.createObjectStore("events", { keyPath: "_seq" });
        if (!db.objectStoreNames.contains("outbox")) {
          db.createObjectStore("outbox", { keyPath: "id" });
        }
      }
      // oldVersion >= 2: stores already have correct key paths -- preserve data.
      // Add forward migrations here (new stores/indexes) WITHOUT deleting events.

      // v3 stores (additive -- safe to create for any oldVersion < 3 without
      // touching events/outbox). "library" + "meta" are a regenerable cache of
      // the event-log projection; "deadletter" records rejected events.
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains("library")) {
          db.createObjectStore("library", { keyPath: "exercise_id" });
        }
        if (!db.objectStoreNames.contains("deadletter")) {
          db.createObjectStore("deadletter", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", { keyPath: "key" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Wrap an IDBRequest as a promise. */
function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve when a write transaction commits (IDBTransaction fires `oncomplete`). */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Store a record (insert or replace by the store's key path).
 * @param {string} store - object store name ("events" | "outbox")
 * @param {Record<string, unknown>} value - record carrying the store's key field
 * @returns {Promise<void>}
 */
export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
}

/**
 * Store many records in one transaction.
 * @param {string} store - object store name
 * @param {Record<string, unknown>[]} values
 * @returns {Promise<void>}
 */
export async function putAll(store, values) {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  await txDone(tx);
}

/**
 * Read one record by key.
 * @param {string} store - object store name
 * @param {IDBValidKey} key - the record's key
 * @returns {Promise<unknown>} the record, or undefined if absent
 */
export async function get(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return asPromise(tx.objectStore(store).get(key));
}

/**
 * Read every record in a store.
 * @param {string} store - object store name
 * @returns {Promise<unknown[]>}
 */
export async function getAll(store) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return asPromise(tx.objectStore(store).getAll());
}

/**
 * Delete records by key.
 * @param {string} store - object store name
 * @param {IDBValidKey[]} keys
 * @returns {Promise<void>}
 */
export async function deleteMany(store, keys) {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  const os = tx.objectStore(store);
  for (const k of keys) os.delete(k);
  await txDone(tx);
}

/**
 * Remove every record in a store.
 * @param {string} store - object store name
 * @returns {Promise<void>}
 */
export async function clear(store) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await txDone(tx);
}

/**
 * Count records in a store.
 * @param {string} store - object store name
 * @returns {Promise<number>}
 */
export async function count(store) {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return asPromise(tx.objectStore(store).count());
}
