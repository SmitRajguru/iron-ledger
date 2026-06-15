"""On-disk store: users.json + per-user month-chunked JSONL event log.

Layout (see CONTRACT-phase1.md / DESIGN.md §4):
    data/users.json                       # {username: {pw_hash, created, dir}}
    data/<username>/seq.json              # {"seq": <last assigned _seq>}  (append-order counter)
    data/<username>/log/sets-YYYY-MM.jsonl  # one event envelope JSON per line (with stamped _seq)

Concurrency: a per-user asyncio.Lock serialises appends. This is correct ONLY under a
single-worker uvicorn (the v1 deployment assumption) -- asyncio locks do not coordinate
across processes. A multi-worker deploy would need a real OS file lock (e.g. flock) or a
proper DB; that is explicitly out of scope for Phase 1.

_seq scheme (fixes review C1): _seq is an IMMUTABLE per-user counter assigned in append
order at WRITE time and STAMPED INTO the jsonl line. It is NOT re-derived from file
ordering. A late-arriving event with an older ts still lands in its own (older) month file,
but it gets the NEXT counter value -- so previously-stored events never get renumbered and
`GET /api/events?since=<seq>` stays correct (an older-month append is still a *new* higher
seq, hence visible to clients that synced earlier). The counter lives in seq.json and is
advanced under the same per-user lock that guards appends.

Crash durability (fixes review HIGH): the counter is RESERVED BEFORE the log append.
Under the per-user lock we (1) fsync-durably bump seq.json to the highest seq we're about
to use, THEN (2) append the stamped jsonl lines. A crash between the two leaves a reserved-
but-unused seq -- a harmless monotonic GAP, never a duplicate. Gaps are fine for `since`
(the client just never sees that number); a duplicate _seq is the real hazard because it
could hide a later event behind an already-acked cursor. On top of that, the in-memory
counter self-heals on load to max(seq.json, max _seq in the log), so a stale or lost
seq.json can never reissue an already-used seq.

Path safety (fixes review H1): usernames are regex-validated at the API boundary, and every
computed user path is additionally resolve()d and asserted to stay under DATA_DIR before any
mkdir/open -- belt and suspenders against directory traversal.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import config

logger = logging.getLogger("wt_tracker.storage")

# Some network filesystems (NAS over SMB/CIFS, certain mounts) don't SUPPORT fsync
# on a file/dir fd and raise OSError with one of these errnos. On such mounts the
# durability barrier is the storage server's job, so we degrade gracefully (warn
# once, continue). EVERY OTHER OSError (EIO, ENOSPC, EBADF, EROFS, …) is a REAL
# fault that must surface — never masked — so it re-raises and the write fails loud.
_FSYNC_UNSUPPORTED_ERRNOS = {errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}
_fsync_unsupported = False


def _best_effort_fsync(fd: int) -> None:
    global _fsync_unsupported
    try:
        os.fsync(fd)
    except OSError as e:
        if e.errno not in _FSYNC_UNSUPPORTED_ERRNOS:
            raise  # real I/O / disk-full / bad-fd fault — do NOT mask it
        if not _fsync_unsupported:
            _fsync_unsupported = True
            logger.warning(
                "fsync not supported on this filesystem (errno %s); durability is delegated "
                "to the underlying store (e.g. NAS). Appends continue best-effort.", e.errno
            )

USERS_FILE = config.DATA_DIR / "users.json"

# Strict username charset. Enforced here AND at the API boundary (routes_auth). No '.', '/',
# or whitespace -> no path traversal, no surprising filenames.
USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,32}$")

# Per-user append locks. defaultdict so the first append for a user lazily creates its lock.
# Module-level (process-wide) -- consistent with the single-worker assumption above.
_user_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

# users.json is small and read/modified rarely (signup only); one lock guards it.
_users_lock = asyncio.Lock()


class InvalidUsername(ValueError):
    """Raised when a username fails the charset/length rules."""


def _ensure_data_dir() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)


def _user_dir(username: str) -> Path:
    """Resolve the user's data dir, asserting it stays under DATA_DIR (defense in depth).

    The regex already forbids traversal characters; this resolve()+containment check is the
    second belt so a future caller that skips validation still can't escape DATA_DIR.
    """
    if not USERNAME_RE.match(username):
        raise InvalidUsername(username)
    base = config.DATA_DIR.resolve()
    path = (base / username).resolve()
    if path != base and base not in path.parents:
        raise InvalidUsername(username)
    return path


# ---- users.json ---------------------------------------------------------------

def _read_users() -> dict[str, dict]:
    if not USERS_FILE.exists():
        return {}
    with USERS_FILE.open("r", encoding="utf-8") as f:
        return json.load(f)


def _write_users(users: dict[str, dict]) -> None:
    _ensure_data_dir()
    # Write-to-temp + atomic rename so a crash can't leave users.json half-written.
    tmp = USERS_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)
    tmp.replace(USERS_FILE)


def get_user(username: str) -> dict | None:
    return _read_users().get(username)


async def create_user(username: str, pw_hash: str) -> dict:
    """Create a user record + their data dir. Raises ValueError if the name is taken.

    Raises InvalidUsername if the name fails the charset rules (caller maps to 422).

    No per-user unit: the canonical stored weight unit is a fixed app constant (lb), hidden from
    the user, with a client-side display toggle on top (docs/UNIT-MODEL.md). Older records may
    still carry a stray `base_unit` field; it is simply ignored.
    """
    user_dir = _user_dir(username)  # validates before we touch users.json
    async with _users_lock:
        users = _read_users()
        if username in users:
            raise ValueError("username taken")
        record = {
            "pw_hash": pw_hash,
            "created": datetime.now(timezone.utc).isoformat(),
            "dir": username,
        }
        users[username] = record
        _write_users(users)
    (user_dir / "log").mkdir(parents=True, exist_ok=True)
    return record


# ---- event log ----------------------------------------------------------------

def _user_log_dir(username: str) -> Path:
    return _user_dir(username) / "log"


def _seq_file(username: str) -> Path:
    return _user_dir(username) / "seq.json"


def _log_files(username: str) -> list[Path]:
    """User's log files (sorted for deterministic iteration; read order is re-sorted by _seq)."""
    log_dir = _user_log_dir(username)
    if not log_dir.is_dir():
        return []
    return sorted(log_dir.glob("sets-*.jsonl"))


def _month_key(ts: str) -> str:
    """YYYY-MM bucket from an event's ISO-8601 ts (parse-validated by the envelope check)."""
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt.strftime("%Y-%m")


def _read_seq_file(username: str) -> int:
    """The seq value persisted in seq.json (0 if absent/unreadable)."""
    path = _seq_file(username)
    if not path.exists():
        return 0
    try:
        with path.open("r", encoding="utf-8") as f:
            return int(json.load(f)["seq"])
    except (json.JSONDecodeError, KeyError, ValueError, OSError):
        # Corrupt/torn seq.json: fall back to the log scan in load_counter(), which is the
        # authoritative floor anyway. Returning 0 here just defers to max(_seq in log).
        return 0


def _max_logged_seq(username: str) -> int:
    """Highest _seq actually present in the user's log files (0 if none)."""
    hi = 0
    for path in _log_files(username):
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                seq = json.loads(line).get("_seq", 0)
                if seq > hi:
                    hi = seq
    return hi


def _load_counter(username: str) -> int:
    """Self-healing counter floor: max(seq.json, max _seq in the log).

    Defends against a stale/lost/corrupt seq.json -- the log's highest stamped _seq is a hard
    lower bound (those numbers are already used), so we can never reissue an existing _seq.
    """
    return max(_read_seq_file(username), _max_logged_seq(username))


def _reserve_seq(username: str, seq: int) -> None:
    """Durably persist the reserved high-water seq to seq.json BEFORE the log append.

    fsync the temp file (so its bytes hit disk) and fsync the containing dir (so the rename
    is durable). After this returns, `seq` is reserved: a crash before the log append leaves a
    gap, never a duplicate.
    """
    path = _seq_file(username)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump({"seq": seq}, f)
        f.flush()
        _best_effort_fsync(f.fileno())
    tmp.replace(path)
    _fsync_dir(path.parent)


def _fsync_dir(directory: Path) -> None:
    """fsync a directory so a rename/create within it is durable across power loss
    (best-effort: some network mounts don't support directory fsync)."""
    fd = os.open(directory, os.O_RDONLY)
    try:
        _best_effort_fsync(fd)
    finally:
        os.close(fd)


def _seen_ids(username: str) -> set[str]:
    """All event ids already stored for this user (for dedupe)."""
    ids: set[str] = set()
    for path in _log_files(username):
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    ids.add(json.loads(line)["id"])
    return ids


async def append_events(username: str, events: list[dict]) -> tuple[list[str], list[str]]:
    """Append unseen events to the user's month-chunked log, deduping by id.

    Each accepted event is stamped with the next monotonic _seq (from seq.json) at write time,
    so its _seq is immutable regardless of which month file it lands in.

    Returns (accepted_ids, duplicate_ids). Idempotent: re-posting the same ids is a no-op,
    which makes the client's offline retry queue safe.
    """
    async with _user_locks[username]:
        seen = _seen_ids(username)
        # Self-healing floor: never below the highest _seq already in the log.
        next_seq = _load_counter(username)
        accepted: list[str] = []
        duplicate: list[str] = []
        # Group accepted (seq-stamped) events by month so each file is opened once per batch.
        by_month: dict[str, list[dict]] = defaultdict(list)
        for ev in events:
            eid = ev["id"]
            if eid in seen:
                duplicate.append(eid)
                continue
            seen.add(eid)  # guard against duplicate ids within the same batch
            next_seq += 1
            stamped = {**ev, "_seq": next_seq}  # persist _seq into the jsonl line
            accepted.append(eid)
            by_month[_month_key(ev["ts"])].append(stamped)

        if accepted:
            log_dir = _user_log_dir(username)
            log_dir.mkdir(parents=True, exist_ok=True)
            # RESERVE the high-water seq durably BEFORE appending the log. A crash after this
            # but before the append leaves a gap (safe), never a reusable/duplicate seq.
            _reserve_seq(username, next_seq)
            for month, evs in by_month.items():
                path = log_dir / f"sets-{month}.jsonl"
                with path.open("a", encoding="utf-8") as f:
                    for ev in evs:
                        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
                    # fsync each touched log file so accepted events survive power loss before
                    # we ack them to the client (core no-data-loss guarantee on a native fs;
                    # best-effort on mounts that reject fsync — see _best_effort_fsync).
                    f.flush()
                    _best_effort_fsync(f.fileno())
        return accepted, duplicate


def read_events_since(username: str, since: int) -> tuple[list[dict], int]:
    """Return events with stored _seq > since, ordered by _seq, plus the new cursor (max _seq).

    _seq is read straight off each stored line (stamped at append time) -- never re-derived
    from file order -- so it is stable across late-arriving older-month appends.
    """
    out: list[dict] = []
    max_seq = 0
    for path in _log_files(username):
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                ev = json.loads(line)
                seq = ev["_seq"]
                if seq > max_seq:
                    max_seq = seq
                if seq > since:
                    out.append(ev)
    out.sort(key=lambda e: e["_seq"])  # month files interleave; client wants seq order
    return out, max_seq
