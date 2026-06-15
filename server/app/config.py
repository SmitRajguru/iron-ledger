"""Runtime configuration, sourced from environment (loaded from server/.env if present).

Secrets (WT_SECRET, WT_INVITE_CODE) live only in the environment / gitignored .env --
never hardcoded, never logged.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# Load server/.env (repo/server/.env). load_dotenv is a no-op if the file is absent,
# and it never overrides values already exported in the real environment.
_SERVER_DIR = Path(__file__).resolve().parents[1]
load_dotenv(_SERVER_DIR / ".env")

# Data root: repo/data. Overridable via WT_DATA_DIR (used by tests / alt deploys).
DATA_DIR = Path(os.environ.get("WT_DATA_DIR", _SERVER_DIR.parent / "data")).resolve()

# Cookie config.
COOKIE_NAME = "wt_session"
SESSION_MAX_AGE = 30 * 24 * 60 * 60  # 30 days, sliding (re-set on each authenticated request)


def get_secret() -> str:
    """Cookie-signing secret. Required at runtime; setup.sh generates one into .env."""
    secret = os.environ.get("WT_SECRET")
    if not secret:
        raise RuntimeError(
            "WT_SECRET is not set. Run ./setup.sh to generate server/.env, "
            "or export WT_SECRET in the environment."
        )
    return secret


def get_invite_code() -> str:
    """Shared signup invite code. Required for signup to function."""
    code = os.environ.get("WT_INVITE_CODE")
    if not code:
        raise RuntimeError(
            "WT_INVITE_CODE is not set. Set it in server/.env (see .env.example)."
        )
    return code
