# Phase 1 Contract — Auth + Data Plumbing

Shared interface. Backend and frontend BOTH build against this. Do not deviate without updating here.

## Scope
Auth (signup/login/logout/me), append-only event sync (push + pull), per-user JSON-on-disk store,
client IndexedDB + sync queue wired for real. NO exercise/log/graph UI yet (Phase 2) — Phase 1 proves
the pipe: log in, enqueue events offline, sync up, pull down on another device.

## Auth
- **Signup is invite-gated.** `POST /api/auth/signup` requires field `invite_code` matching env
  `WT_INVITE_CODE`. Prevents random signups on an internet-exposed app. (One shared invite code for the few trusted users is fine for v1.)
- Passwords hashed with **bcrypt** (`passlib[bcrypt]` or `bcrypt`).
- Session = **signed httpOnly cookie** (`itsdangerous` signer over `{username, issued_at}`), `SameSite=Lax`,
  `Secure` when not localhost. Secret from env `WT_SECRET` (generated + written to a gitignored
  `server/.env` by the setup script if absent). No server-side session store.
- Cookie name: `wt_session`. Expiry: 30 days, sliding.

### Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/auth/signup` | `{username, password, invite_code}` | 201, sets cookie, `{username}` / 403 bad invite / 409 taken |
| POST | `/api/auth/login` | `{username, password}` | 200, sets cookie, `{username}` / 401 |
| POST | `/api/auth/logout` | — | 204, clears cookie |
| GET | `/api/auth/me` | — (cookie) | 200 `{username}` / 401 |

All `/api/sync` + `/api/events` require a valid cookie → else 401.

## Events (append-only)
Envelope (matches DESIGN.md §4):
```json
{ "id": "uuid-v4", "type": "set_logged|measurement|exercise_defined|exercise_updated|template_updated",
  "ts": "ISO-8601-UTC", "device": "string", "voids": "uuid|null", "payload": { } }
```
- `id` is client-generated UUID v4. **Server dedupes by id** (append only if unseen) → safe retof offline queue.
- Phase 1 does NOT validate payload bodies per-type beyond shape `{}` — that arrives with Phase 2 features.
  Server validates the envelope (required keys, id is uuid, type in allowed set, ts parseable).

### Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/sync` | `{events: [envelope, ...]}` | 200 `{accepted: [id...], duplicate: [id...]}` |
| GET | `/api/events?since=<seq>` | — | 200 `{events: [envelope+_seq...], cursor: <seq>}` |

- Server assigns a monotonic per-user `_seq` (line number across the log) on append; `GET /api/events?since`
  returns events with `_seq > since` for pull-down sync. `since` omitted → all.

## On-disk (server)
```
data/
  users.json                       # { "<username>": { "pw_hash": "...", "created": "iso", "dir": "<username>" } }
  <username>/
    log/sets-YYYY-MM.jsonl         # one envelope JSON per line, appended; month-chunked by ts
```
- Append concurrency: in-process **per-user asyncio lock** (single-worker uvicorn assumption). Document that
  multi-worker deploy needs a real file lock — out of scope v1, leave a clear comment.
- `_seq` = global line index over the user's chronological log files (recompute on read, or maintain a small
  `<username>/seq.json` counter — implementer's call, just be consistent and documented).

## Client (frontend)
- `db.js`: real IndexedDB stores `outbox` (unsynced events) + `events` (confirmed, by `_seq`). Keep wrapper generic.
- `sync.js`:
  - `queue(event)` → write to `outbox`, attempt flush.
  - `flush()` → POST all `outbox` events to `/api/sync`; on `accepted`/`duplicate`, move them out of `outbox`
    into `events`. Retries on reconnect (`online` event) + on interval. Idempotent (server dedupes).
  - `pull()` → `GET /api/events?since=<max _seq seen>`, store into `events`.
  - Expose sync state: `online | offline | pending(n) | syncing` → drives the existing top indicator (replace the static placeholder).
- **Login screen** (new): username/password (+ invite code on a signup toggle). On success store nothing
  sensitive client-side beyond the httpOnly cookie; call `/api/auth/me` on load to decide logged-in vs login screen.
- A **dev-only "Simulate offline" toggle** in the UI (guarded by `import.meta.env.DEV`) that makes sync.js
  behave as if offline, so disconnection is testable without DevTools. Also document DevTools Network→Offline.
- **Fix the laptop width bug:** layout must use full width responsively. Mobile = single column full-bleed;
  desktop = use available width (centered max-width is fine but it must clearly use the wide viewport, e.g.
  a comfortable max like 900–1100px is acceptable ONLY if it currently looks cramped — prefer a fluid layout).

## Out of scope Phase 1
Exercise library, templates, set-logging UI, graphs, body comp, progression. Those are Phase 2.
