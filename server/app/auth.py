"""Auth: bcrypt password hashing + signed httpOnly session cookie (no server-side store).

The session is a signed token over {username, issued_at}; itsdangerous guarantees integrity
(tamper -> bad signature) and enforces the 30-day max age. Because there is no server-side
session table, "logout" just clears the cookie; signatures remain valid until expiry, which is
the accepted trade-off for a tiny trusted-user app.
"""

from __future__ import annotations

import os
import time

import bcrypt
from fastapi import Cookie, HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from . import config, storage

_SALT = "wt_session"  # itsdangerous namespace salt (not a password salt); fixed is fine.


def _serializer() -> URLSafeTimedSerializer:
    # Built per-call so a rotated WT_SECRET takes effect without a process restart-time capture.
    return URLSafeTimedSerializer(config.get_secret(), salt=_SALT)


def hash_password(password: str) -> str:
    # bcrypt's own random salt is embedded in the output hash; default cost (12) is sane.
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, pw_hash: str) -> bool:
    # bcrypt.checkpw is constant-time w.r.t. the hash; truncates the pw at 72 bytes (bcrypt limit).
    try:
        return bcrypt.checkpw(password.encode("utf-8"), pw_hash.encode("ascii"))
    except ValueError:
        # Malformed stored hash -- treat as auth failure rather than 500.
        return False


def issue_session(response: Response, request: Request, username: str) -> None:
    """Sign a session token for `username` and set it as the wt_session cookie."""
    token = _serializer().dumps({"username": username, "issued_at": int(time.time())})
    response.set_cookie(
        key=config.COOKIE_NAME,
        value=token,
        max_age=config.SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        # Secure only off localhost: lets http://localhost dev work while staying secure
        # behind the Cloudflare Tunnel (HTTPS) in production.
        secure=_is_secure_request(request),
        path="/",
    )


def clear_session(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=config.COOKIE_NAME,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
        path="/",
    )


def _is_secure_request(request: Request) -> bool:
    # WT_COOKIE_SECURE overrides the heuristic: set "false" when serving over PLAIN
    # HTTP on a LAN IP (e.g. http://10.0.0.15:PORT) — otherwise the Secure flag makes
    # the browser refuse to store the cookie over HTTP and login silently fails. Set
    # "true" to force it. Default "auto": Secure off localhost (HTTPS via the tunnel),
    # insecure on localhost. NOTE: plain-HTTP LAN access also disables PWA install +
    # the service worker (those need a secure context — HTTPS or localhost).
    override = os.environ.get("WT_COOKIE_SECURE", "auto").strip().lower()
    if override in ("1", "true", "yes", "on"):
        return True
    if override in ("0", "false", "no", "off"):
        return False
    host = (request.url.hostname or "").lower()
    return host not in ("localhost", "127.0.0.1", "::1")


def current_user(
    request: Request,
    response: Response,
    wt_session: str | None = Cookie(default=None),
) -> str:
    """FastAPI dependency: returns the authenticated username or raises 401.

    Sliding expiry (review M1): on every authenticated request we re-issue the cookie with a
    fresh issued_at and a fresh 30-day Max-Age, so active use keeps the session alive. The
    `response` injected here is the same object FastAPI uses for the final response, so the
    refreshed Set-Cookie reaches the client. Logout is unaffected -- it runs without this
    dependency and clears the cookie on its own response.
    """
    if not wt_session:
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        data = _serializer().loads(wt_session, max_age=config.SESSION_MAX_AGE)
    except (SignatureExpired, BadSignature):
        raise HTTPException(status_code=401, detail="invalid or expired session")
    username = data.get("username")
    # Reject sessions for users that no longer exist (e.g. deleted account).
    if not username or storage.get_user(username) is None:
        raise HTTPException(status_code=401, detail="unknown user")
    issue_session(response, request, username)  # slide the expiry forward
    return username
