"""Auth endpoints: signup (invite-gated), login, logout, me."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import auth, config, storage

router = APIRouter(prefix="/api/auth", tags=["auth"])


# Username charset mirrors storage.USERNAME_RE; enforcing it here (signup) rejects bad names
# with 422 before any filesystem path is built. Pattern + storage's resolve() check = H1 fix.
_USERNAME_PATTERN = r"^[A-Za-z0-9_-]{3,32}$"


class SignupBody(BaseModel):
    username: str = Field(pattern=_USERNAME_PATTERN)
    password: str = Field(min_length=1, max_length=256)
    invite_code: str


class LoginBody(BaseModel):
    # No constraints on username here on purpose: any malformed username at login (bad charset,
    # empty, or over-length) must look exactly like a wrong password (generic 401), not a 422
    # that reveals the name was invalid. The handler applies USERNAME_RE itself (which bounds
    # length to 3..32) and returns the same 401 either way.
    username: str
    password: str = Field(min_length=1, max_length=256)


@router.post("/signup", status_code=201)
async def signup(body: SignupBody, request: Request, response: Response) -> dict:
    configured_code = config.get_invite_code()
    # Fail closed if the invite code is still the setup.sh placeholder: an
    # unchanged default behind a public tunnel = open signup for anyone with the
    # URL. Force the operator to set a real WT_INVITE_CODE before signup works.
    if configured_code.startswith("change-me"):
        raise HTTPException(
            status_code=503,
            detail="signup disabled: set a real WT_INVITE_CODE on the server",
        )
    # compare_digest avoids leaking the invite code length/prefix via timing.
    if not hmac.compare_digest(body.invite_code, configured_code):
        raise HTTPException(status_code=403, detail="invalid invite code")
    try:
        await storage.create_user(body.username, auth.hash_password(body.password))
    except storage.InvalidUsername:
        raise HTTPException(status_code=422, detail="invalid username")
    except ValueError:
        raise HTTPException(status_code=409, detail="username taken")
    auth.issue_session(response, request, body.username)
    return {"username": body.username}


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response) -> dict:
    # A username that can't be valid (fails the charset rules) can't match any account.
    # Return the SAME generic 401 as a bad password so we don't leak that it was a format
    # problem -- and so we never feed an unsanitized name to storage path-building.
    if not storage.USERNAME_RE.match(body.username):
        raise HTTPException(status_code=401, detail="invalid credentials")
    user = storage.get_user(body.username)
    # Verify even when the user is missing? bcrypt.checkpw on a missing hash short-circuits;
    # the timing difference is acceptable for a tiny trusted-user app. Same 401 either way.
    if user is None or not auth.verify_password(body.password, user["pw_hash"]):
        raise HTTPException(status_code=401, detail="invalid credentials")
    auth.issue_session(response, request, body.username)
    return {"username": body.username}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response) -> Response:
    # Mutate the injected Response (don't return a fresh one) so the cookie-clearing
    # Set-Cookie header survives. 204 has no body.
    auth.clear_session(response, request)
    response.status_code = 204
    return response


@router.get("/me")
def me(username: str = Depends(auth.current_user)) -> dict:
    return {"username": username}
