1. **FIXED** — `server/app/storage.py` now does reserve-then-append (`_reserve_seq(...)` before any JSONL write), reserves durably (temp-file `fsync` + `replace` + parent-dir `fsync`), self-heals with `max(_read_seq_file(username), _max_logged_seq(username))`, and still dedupes by id via `seen = _seen_ids(username)` + in-batch `seen.add(eid)`.

2. **FIXED** — `server/app/routes_auth.py` removed regex from `LoginBody`, login now returns generic 401 for username-rule failures (`if not storage.USERNAME_RE.match(body.username): ...401`), while signup still enforces the username rule via `SignupBody` pattern (422 on invalid signup username).

NEW issue: **[LOW]** `server/app/routes_auth.py` still returns 422 (not 401) for some malformed login usernames handled by Pydantic length checks (e.g., empty or >256 chars) because `LoginBody.username` keeps `min_length`/`max_length`.
