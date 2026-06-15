"""WT Tracker FastAPI app.

Responsibilities (Phase 1):
  * health check at /api/health
  * auth: signup/login/logout/me  (app.routes_auth)
  * event sync: POST /api/sync, GET /api/events  (app.routes_sync)
  * serve the built Svelte PWA (client/dist) as static files at /

Single-worker uvicorn is assumed (see app.storage for the per-user append-lock rationale).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config, routes_auth, routes_sync

logger = logging.getLogger("wt_tracker")

# Hostnames treated as local dev (no HSTS — never force HTTPS on localhost).
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}

# Content-Security-Policy. The app is fully same-origin (no CDNs): one module
# script + one stylesheet from 'self', Svelte injects <style> blocks + inline
# style attributes at runtime (=> style-src needs 'unsafe-inline'), icons may be
# data: URIs, the service worker + API are same-origin. script-src stays 'self'
# (no inline scripts in the build) for real XSS defense.
_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "worker-src 'self'; "
    "manifest-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'"
)

# Reject oversized request bodies cheaply via Content-Length before they are read
# into memory. NOTE: a chunked request without Content-Length bypasses this check;
# the real hard bound is twofold -- the sync batch cap (routes_sync.MAX_EVENTS_PER_SYNC)
# limits *parsed* events, and the Cloudflare tunnel enforces a body-size ceiling at
# the edge. This middleware is the cheap in-app defense-in-depth layer for the common
# (Content-Length present) case; full streaming enforcement is intentionally left to
# the edge to avoid consuming the request body here.
MAX_BODY_BYTES = 5 * 1024 * 1024  # 5 MB

# client/dist lives two levels up from this file: server/app/main.py -> repo/client/dist
DIST_DIR = Path(__file__).resolve().parents[2] / "client" / "dist"


class SPAStaticFiles(StaticFiles):
    """StaticFiles that serves real assets, but falls back to index.html for unmatched paths.

    Plain StaticFiles 404s deep client routes like /watch (it only knows files on disk). For a
    client-side-routed SPA, a hard load / refresh of such a path must still return the app shell.
    We override the 404 path: if the requested file isn't found, serve index.html so the client
    router can take over. Real asset requests (js/css/icons/sw/manifest) still hit the file on
    disk and never fall through. /api/* never reaches here -- those routers are registered before
    this mount, so they take precedence.
    """

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            # Only swallow the not-found case; let other HTTP errors (e.g. 405) surface as-is.
            # `path` is the path RELATIVE to this mount (the leading "/" is stripped), so an
            # unmatched /api/* request arrives here as "api/..." and a bare /api as "api".
            # Never fall back for either -- the API must keep returning its real JSON 404.
            is_api = path == "api" or path.startswith("api/")
            if exc.status_code == 404 and not is_api:
                index = Path(self.directory) / "index.html"
                if index.is_file():
                    return FileResponse(index)
            raise

app = FastAPI(title="Iron Ledger")

# Optional Host allow-list (defense vs Host-header spoofing / cache poisoning).
# Opt-in via WT_ALLOWED_HOSTS (comma-separated, e.g. "ironledger.example.com");
# unset = allow any host (current behavior — avoids breaking an unconfigured deploy).
# uvicorn binds 127.0.0.1 so only the local tunnel reaches the app regardless.
_allowed_hosts = os.environ.get("WT_ALLOWED_HOSTS", "").strip()
if _allowed_hosts:
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=[h.strip() for h in _allowed_hosts.split(",") if h.strip()]
        + ["localhost", "127.0.0.1", "::1"],
    )

# CORS only matters in dev, where the Vite dev server calls the API on a different
# origin. In production the client is served same-origin from dist/ (no CORS).
# WT_DEV_ORIGIN overrides the dev origin if you change the Vite client port
# (comma-separated for multiple), e.g. WT_DEV_ORIGIN=http://localhost:5174
_dev_origins = [
    o.strip()
    for o in os.environ.get("WT_DEV_ORIGIN", "http://localhost:5173").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_dev_origins,
    allow_credentials=True,  # required so the dev client can send/receive the session cookie
    allow_methods=["*"],
    allow_headers=["*"],
)


def _apply_security_headers(headers, hostname) -> None:
    """Stamp defense-in-depth headers onto any response (success, 4xx, 413, 500)."""
    headers.setdefault("X-Content-Type-Options", "nosniff")
    headers.setdefault("X-Frame-Options", "DENY")
    headers.setdefault("Referrer-Policy", "no-referrer")
    headers.setdefault("Content-Security-Policy", _CSP)
    # HSTS only off-localhost: prod is HTTPS via the Cloudflare tunnel, but we must
    # never pin HTTPS on a localhost dev origin.
    if hostname not in _LOCAL_HOSTS:
        headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")


@app.middleware("http")
async def security_and_body_limits(request: Request, call_next):
    # Cheap Content-Length body cap (see MAX_BODY_BYTES note above). The early 413
    # gets the security headers too (not just the happy path).
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > MAX_BODY_BYTES:
                resp = JSONResponse({"detail": "request body too large"}, status_code=413)
                _apply_security_headers(resp.headers, request.url.hostname)
                return resp
        except ValueError:
            pass  # unparseable Content-Length -> let downstream handle it

    response = await call_next(request)
    _apply_security_headers(response.headers, request.url.hostname)
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # An unhandled error escapes the middleware's post-call_next path, so its 500
    # would otherwise ship without the security headers (and could leak a traceback).
    # Log it and return a clean, header-stamped 500.
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    resp = JSONResponse({"detail": "internal server error"}, status_code=500)
    _apply_security_headers(resp.headers, request.url.hostname)
    return resp


@app.get("/api/health")
def health() -> JSONResponse:
    # Liveness + readiness: the data dir must be writable or appends fail. We
    # mkdir(exist_ok) first because storage creates it lazily — so a fresh deploy
    # (dir not yet created) reads as OK, not a false 503. A genuinely unwritable /
    # un-creatable path (bad mount, full/read-only disk, misconfigured WT_DATA_DIR)
    # still 503s so an uptime probe catches it before the user does.
    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        writable = os.access(config.DATA_DIR, os.W_OK)
    except OSError:
        writable = False
    body = {"status": "ok" if writable else "degraded", "data_dir_writable": writable}
    return JSONResponse(body, status_code=200 if writable else 503)


app.include_router(routes_auth.router)
app.include_router(routes_sync.router)


# Mount the built client last so /api/* routes take precedence over the SPA catch-all.
# html=True serves index.html at directory paths; SPAStaticFiles additionally falls back to
# index.html for unmatched deep routes (e.g. /watch) so SPA routes survive a hard load/refresh.
# Guard against a missing build so the API still runs before `npm run build`.
if DIST_DIR.is_dir():
    app.mount("/", SPAStaticFiles(directory=DIST_DIR, html=True), name="client")
else:
    logger.warning(
        "client build not found at %s -- serving API only. "
        "Run `npm run build` in client/ to enable the PWA.",
        DIST_DIR,
    )
