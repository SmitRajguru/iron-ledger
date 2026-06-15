"""Event-sync endpoints: push (POST /api/sync) and pull (GET /api/events). Cookie-gated."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from . import auth, events, storage

router = APIRouter(prefix="/api", tags=["sync"])

# Hard cap on events per POST. The client flushes in smaller chunks (sync.js
# FLUSH_BATCH), so a legitimate request never approaches this; the cap exists to
# bound a malicious/runaway body, since append_events does O(log) work per call.
MAX_EVENTS_PER_SYNC = 1000


class SyncBody(BaseModel):
    events: list[dict] = Field(max_length=MAX_EVENTS_PER_SYNC)


@router.post("/sync")
async def sync(body: SyncBody, username: str = Depends(auth.current_user)) -> dict:
    # Per-event validation (envelope + per-type payload). Policy (CONTRACT-phase2a.md):
    # reject the INDIVIDUAL malformed event, never 400 the whole batch -- a good event in the
    # same batch must still be appended. Rejected events are not passed to storage.
    valid: list[dict] = []
    rejected: list[dict] = []
    for ev in body.events:
        try:
            events.validate_envelope(ev)
            events.validate_payload(ev)
        except events.EnvelopeError as e:
            # An event missing/with a non-string id can't be reported by id; surface what we can.
            eid = ev.get("id") if isinstance(ev, dict) else None
            rejected.append({"id": eid, "reason": str(e)})
            continue
        valid.append(ev)

    accepted, duplicate = await storage.append_events(username, valid)
    return {"accepted": accepted, "duplicate": duplicate, "rejected": rejected}


@router.get("/events")
def get_events(
    since: int = Query(default=0, ge=0),
    username: str = Depends(auth.current_user),
) -> dict:
    evs, cursor = storage.read_events_since(username, since)
    return {"events": evs, "cursor": cursor}
