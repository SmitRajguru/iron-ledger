# Data Migration & Backward Compatibility

How Iron Ledger keeps reading old data after the schema changes. Read this before
shipping any event-payload change.

## The model: append-only + upcast-on-read

All app state is an **append-only event log**. A stored event is **never rewritten
or deleted** — edits/deletes are superseding events (`voids`) / tombstones. That
immutability is exactly what makes migration safe: there is no in-place data to
corrupt. The cost is that you can't "ALTER TABLE" old rows — so instead we
**upcast on read**.

Every event carries a schema version `v` (envelope field). On read, before any
fold/projection, each event is normalized to the current shape:

```
stored events (mixed v1, v2, …)  ──migrateEvent()──▶  all current-shape  ──▶ foldLog / project / analytics
```

- Client seam: `client/src/lib/migrations.js` — `CURRENT_VERSION`, `eventVersion(ev)`
  (absent `v` ⇒ 1), `MIGRATIONS` (ordered upcast steps), `migrateEvent(ev)`.
- Hooked into BOTH projection folds (`logging.js mergeOrdered`, `library.js mergeOrdered`)
  so nothing downstream ever sees an old shape. `_seq`/`_enq`/`id`/`ts` are preserved.

## Version-skew safety (multi-device)

Phone, watch, and laptop don't update in lockstep. Two guards keep a newer event
from corrupting an older reader:

- **Client (read):** `migrateEvent` returns `null` for an event whose `v` is newer
  than `CURRENT_VERSION`. The fold **skips** it (doesn't guess a shape). It's still
  in the store and folds correctly once that client updates.
- **Server (write):** `events.py MAX_EVENT_VERSION` rejects an inbound event whose
  `v` exceeds what the server understands (the client dead-letters it). This stops
  an unvalidatable future shape from landing in the log.

## Adding a new version (v(N) → v(N+1))

1. **Write the upcast.** In `migrations.js` add `MIGRATIONS[N] = (ev) => ({ ...ev,
   v: N+1, payload: /* old payload mapped to the new shape */ })`. Each step knows
   only its single increment; `migrateEvent` chains v1→v2→v3…
2. **Bump `CURRENT_VERSION`** in `migrations.js` (sync.js re-exports it as
   `SCHEMA_VERSION`, so new events stamp the new `v` automatically).
3. **Teach the server the new shape:** update `validate_payload` (events.py) to
   accept the v(N+1) payload AND keep accepting every older version (old, un-updated
   clients still POST old events). Bump `MAX_EVENT_VERSION` to N+1.
4. **Deploy SERVER FIRST, then clients.** A client emitting v(N+1) to a server still
   capped at N would have its events rejected → dead-lettered → lost. Server-first
   means the server already accepts the new version before any client emits it. For
   this single-host self-deploy (`run.sh` rebuilds both together) that ordering is
   automatic, but keep it in mind for any split rollout.
5. **Test** the new `MIGRATIONS[N]` against real old fixtures (e.g. `scripts/
   may2026_spec.json`-derived v1 events) — assert an old event folds to the same
   result a hand-written new event would.

## Hard rules

- **Never rewrite or delete stored events** to "migrate" them. Upcast on read only.
- **Never repurpose an existing field's meaning** (or change its units/encoding)
  without a version bump — old readers would misinterpret it.
- **Additive-friendly:** adding a new OPTIONAL payload field needs no version bump
  (old events simply lack it; folds already treat absent fields as null/default).
  A version bump is for *breaking* shape/semantics changes.
- **Weights stay canonical lb at full precision** across versions (see
  `docs/UNIT-MODEL.md`); display rounding is never stored.

## What V1 ships with

`CURRENT_VERSION = 1`, `MAX_EVENT_VERSION = 1`, `MIGRATIONS = {}` (empty). So
`migrateEvent` is identity for every current/legacy event, and the seam + skew
guards are in place for the first breaking change — no retrofit scramble later.
