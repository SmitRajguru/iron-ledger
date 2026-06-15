I’ve completed the file-by-file check and mapped each requested item to concrete code paths. I’m now compiling the per-item verdict lines and a short list of genuinely new issues introduced by these fixes.
C1 — REGRESSION — `server/app/storage.py` now stamps immutable `_seq` from `seq.json` under the per-user lock (normal path fixed), but crash/error between JSONL append and durable `seq.json` advance can leave counter stale and later reassign `_seq`, which can break `since` visibility.  
H1 — REGRESSION — `server/app/storage.py` path confinement (`resolve` + under-`DATA_DIR` check) and username validation are in place, but `server/app/routes_auth.py` now enforces regex on login request parsing, so malformed usernames return 422 (not 401), a behavior regression.  
M1 — FIXED — `server/app/auth.py` re-issues `wt_session` in `current_user` (sliding expiry), and `server/app/routes_auth.py` logout still clears cookie via `clear_session`.  
M2 — FIXED — `client/src/lib/sync.js` deletes outbox only after successful `pull()`/events write path; on failure it preserves outbox entries (no “neither store” window).  
M3 — FIXED — `client/src/lib/db.js` gates destructive migration on `oldVersion` and no longer unconditionally deletes `events` on every upgrade.  
T1 — FIXED — `client/src/lib/sync.js` now tracks failures and exposes distinct `kind: "error"` state on flush/pull failure instead of swallowing it.  
T2 — FIXED — `client/src/lib/sync.js` maps 401 to `sessionExpired` while preserving outbox, and `client/src/lib/auth.js` `me()` distinguishes 401 logout from network/transient failures.  
L1 — FIXED — `client/src/lib/sync.js` `stopSync()` removes `online`/`offline` listeners and clears interval.  
L2 — FIXED — `setup.sh` sets `umask 077` before creating `server/.env`.

**NEW findings (introduced by fixes):**
- **[HIGH]** `server/app/storage.py`: seq durability hole remains; `_seq` can be duplicated after crash/power loss because log append and `seq.json` advancement are not crash-atomic/recoverable (fsync-less temp+rename plus no reconciliation on startup).  
- **[MEDIUM]** `server/app/routes_auth.py`: login endpoint now returns 422 for malformed usernames due `Field(pattern=...)`, diverging from 401-based invalid-credentials behavior.
