"""Event validation: envelope (Phase 1) + per-type payload (Phase 2a + 2b).

`validate_envelope` checks the shared envelope -- required keys, id is a UUID v4, type in the
allowed set, ts parseable. `validate_payload` adds per-type payload checks: exercise_* /
routine_* (2a) and set_logged / measurement (2b). Both raise EnvelopeError with a human-readable
reason; callers decide whether to reject the individual event or the batch. No referential
integrity (events arrive out of order; exercise_id existence is not checked).
"""

from __future__ import annotations

import uuid
from datetime import datetime

# Matches DESIGN.md §4 / CONTRACT-phase2a.md. `template_updated` was replaced by the named
# routine model (routine_defined/routine_updated) before any real data used it (review A1).
ALLOWED_TYPES = {
    "set_logged",
    "measurement",
    "exercise_defined",
    "exercise_updated",
    "routine_defined",
    "routine_updated",
}

# Per CONTRACT-phase2a.md: exercise type enum.
EXERCISE_TYPES = {"weighted", "bodyweight", "cardio"}

# Canonical weight units (CONTRACT-phase2b.md): set_logged.unit must equal the user's base_unit.
UNITS = {"lb", "kg"}

# Highest event schema `v` this server understands. Events with a higher `v` are
# rejected (dead-lettered by the client) rather than stored as a shape the server's
# payload validation can't check. Bump this IN LOCKSTEP with the client
# CURRENT_VERSION (migrations.js) and deploy the server FIRST — see
# docs/DATA-MIGRATION.md. Absent `v` is treated as 1 (back-compat).
MAX_EVENT_VERSION = 1

_REQUIRED_KEYS = {"id", "type", "ts", "device", "voids", "payload"}


class EnvelopeError(ValueError):
    """Raised when an event envelope is malformed; carries a human-readable reason."""


def _is_uuid_v4(value: str) -> bool:
    try:
        return uuid.UUID(value).version == 4
    except (ValueError, AttributeError, TypeError):
        return False


def validate_envelope(ev: object) -> dict:
    """Validate one event envelope, returning it unchanged. Raises EnvelopeError on failure."""
    if not isinstance(ev, dict):
        raise EnvelopeError("event must be an object")

    missing = _REQUIRED_KEYS - ev.keys()
    if missing:
        raise EnvelopeError(f"missing keys: {sorted(missing)}")

    if not _is_uuid_v4(ev["id"]):
        raise EnvelopeError("id must be a UUID v4")

    if ev["type"] not in ALLOWED_TYPES:
        raise EnvelopeError(f"type must be one of {sorted(ALLOWED_TYPES)}")

    ts = ev["ts"]
    if not isinstance(ts, str):
        raise EnvelopeError("ts must be an ISO-8601 string")
    try:
        datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        raise EnvelopeError("ts must be parseable ISO-8601")

    if not isinstance(ev["device"], str):
        raise EnvelopeError("device must be a string")

    voids = ev["voids"]
    if voids is not None and not _is_uuid_v4(voids):
        raise EnvelopeError("voids must be null or a UUID v4")

    # Schema version (forward-migration lever). Optional + back-compat: events
    # written before the field existed are treated as v1; if present it must be a
    # positive int, and no newer than this server understands (MAX_EVENT_VERSION) --
    # a future-version event is rejected so it can't land as an unvalidatable shape.
    v = ev.get("v")
    if v is not None:
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise EnvelopeError("v must be a positive integer")
        if v > MAX_EVENT_VERSION:
            raise EnvelopeError(
                f"event schema v{v} is newer than this server supports (max v{MAX_EVENT_VERSION})"
            )

    if not isinstance(ev["payload"], dict):
        raise EnvelopeError("payload must be an object")

    return ev


def _require(payload: dict, key: str) -> object:
    if key not in payload:
        raise EnvelopeError(f"payload missing required key: {key}")
    return payload[key]


def _is_number(value: object) -> bool:
    # JSON numbers parse to int or float; exclude bool (an int subclass) so True/False
    # can't pass as a weight/rep count.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_iso_date(value: object) -> bool:
    """True iff value is a 'YYYY-MM-DD' calendar date (no time component)."""
    if not isinstance(value, str):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _check_optional_number(payload: dict, key: str) -> None:
    """If `key` is present and non-null, it must be a JSON number. Absent/null = OK."""
    if payload.get(key) is not None and not _is_number(payload[key]):
        raise EnvelopeError(f"{key} must be a number")


def _check_optional_int(payload: dict, key: str) -> None:
    if payload.get(key) is not None and not _is_int(payload[key]):
        raise EnvelopeError(f"{key} must be an integer")


def _require_voids(ev: dict) -> None:
    """`*_updated` events supersede a prior event, so their envelope `voids` MUST be a uuid v4.

    (Envelope validation only allows null-or-uuid; here we tighten it to non-null for updates.)
    """
    if not _is_uuid_v4(ev["voids"]):
        raise EnvelopeError("voids must be a non-null UUID v4 for an update event")


def _validate_exercise_payload(payload: dict) -> None:
    if not _is_uuid_v4(_require(payload, "exercise_id")):
        raise EnvelopeError("exercise_id must be a UUID v4")
    name = _require(payload, "name")
    if not isinstance(name, str) or not name.strip():
        raise EnvelopeError("name must be a non-empty string")
    if _require(payload, "type") not in EXERCISE_TYPES:
        raise EnvelopeError(f"exercise type must be one of {sorted(EXERCISE_TYPES)}")
    # hold_progression (Phase 3): optional pause-progression flag. Reject only if present and
    # non-bool; absence is fine (older events / exercises that never set it).
    if "hold_progression" in payload and not isinstance(payload["hold_progression"], bool):
        raise EnvelopeError("hold_progression must be a boolean")
    # rest_seconds (Phase 5a): optional rest-timer default. If present, a non-negative int.
    rest = payload.get("rest_seconds")
    if rest is not None and (not _is_int(rest) or rest < 0):
        raise EnvelopeError("rest_seconds must be an integer >= 0")


def _validate_routine_payload(payload: dict) -> None:
    if not _is_uuid_v4(_require(payload, "routine_id")):
        raise EnvelopeError("routine_id must be a UUID v4")
    name = _require(payload, "name")
    if not isinstance(name, str) or not name.strip():
        raise EnvelopeError("name must be a non-empty string")
    ids = _require(payload, "ordered_exercise_ids")
    if not isinstance(ids, list) or not all(_is_uuid_v4(i) for i in ids):
        raise EnvelopeError("ordered_exercise_ids must be a list of UUID v4")
    # weekday_assignments is optional; validate range only if present.
    if "weekday_assignments" in payload:
        wa = payload["weekday_assignments"]
        # bool is an int subclass; exclude so True/False can't masquerade as a weekday.
        if not isinstance(wa, list) or not all(
            isinstance(w, int) and not isinstance(w, bool) and 0 <= w <= 6 for w in wa
        ):
            raise EnvelopeError("weekday_assignments must be a list of ints 0-6")


def _validate_set_logged(ev: dict) -> None:
    payload = ev["payload"]

    # Delete tombstone (review C2): a set_logged with payload.deleted === true voids a prior set.
    # It carries a minimal payload, so skip the full-set requirements -- require only a uuid
    # exercise_id and a non-null uuid `voids` (the set it deletes). Client buildSetEvent emits
    # exactly {exercise_id, deleted:true} + voids for this path.
    if payload.get("deleted") is True:
        if not _is_uuid_v4(_require(payload, "exercise_id")):
            raise EnvelopeError("exercise_id must be a UUID v4")
        _require_voids(ev)  # a tombstone must point at the set it deletes
        return

    # weight/reps are NOT required: pure bodyweight has null weight, assisted uses added_weight
    # (CONTRACT-phase2b.md). No referential integrity on exercise_id.
    if not _is_uuid_v4(_require(payload, "exercise_id")):
        raise EnvelopeError("exercise_id must be a UUID v4")
    if not _is_iso_date(_require(payload, "session_date")):
        raise EnvelopeError("session_date must be a YYYY-MM-DD date")
    set_index = _require(payload, "set_index")
    if not _is_int(set_index) or set_index < 0:
        raise EnvelopeError("set_index must be an integer >= 0")
    # unit is OPTIONAL (Phase 5a): a cardio set has no weight/unit. Enum-checked only if present.
    if "unit" in payload and payload["unit"] not in UNITS:
        raise EnvelopeError(f"unit must be one of {sorted(UNITS)}")
    if not isinstance(_require(payload, "warmup"), bool):
        raise EnvelopeError("warmup must be a boolean")
    # Optional fields: type-check only if present (reps/set are ints, the rest are numbers).
    _check_optional_int(payload, "reps")
    for key in ("weight", "added_weight", "bodyweight_snapshot", "duration_s", "distance_m"):
        _check_optional_number(payload, key)
    # bodyweight_snapshot_date (Phase 3 M1): the source measurement's date, stamped when a
    # bodyweight_snapshot is present so the UI can flag a stale snapshot. Optional; if present
    # must be YYYY-MM-DD.
    if payload.get("bodyweight_snapshot_date") is not None and not _is_iso_date(
        payload["bodyweight_snapshot_date"]
    ):
        raise EnvelopeError("bodyweight_snapshot_date must be a YYYY-MM-DD date")


# Body-comp metric fields a measurement can carry (Phase 3 Body screen).
# `waist` is a circumference stored canonical in cm (the client converts in/cm per
# the weight display toggle); like the others it's an optional numeric metric.
MEASUREMENT_METRICS = ("bodyweight", "muscle_mass", "body_fat_pct", "fat_mass", "waist")


def _validate_measurement(ev: dict) -> None:
    payload = ev["payload"]

    # Delete tombstone (review H1): a measurement with payload.deleted === true voids a prior
    # measurement. Minimal payload -- require only a non-null uuid `voids`; skip the date and
    # >=1-metric requirements. Mirrors the set_logged tombstone pattern.
    if payload.get("deleted") is True:
        _require_voids(ev)
        return

    if not _is_iso_date(_require(payload, "date")):
        raise EnvelopeError("date must be a YYYY-MM-DD date")
    # Phase 3: bodyweight is no longer mandatory -- a body-fat-only or muscle-mass-only entry is
    # valid. Each metric present must be a number; at least one must be present (so an empty
    # measurement can't sync). Back-compat: a bodyweight-only entry still passes.
    for key in MEASUREMENT_METRICS:
        _check_optional_number(payload, key)
    if not any(_is_number(payload.get(key)) for key in MEASUREMENT_METRICS):
        raise EnvelopeError(
            f"at least one numeric metric required: {list(MEASUREMENT_METRICS)}"
        )
    # body_fat_pct is a percentage; reject out-of-range values (caught only if present + numeric).
    bf = payload.get("body_fat_pct")
    if _is_number(bf) and not 0 <= bf <= 100:
        raise EnvelopeError("body_fat_pct must be between 0 and 100")


def validate_payload(ev: dict) -> dict:
    """Validate the payload per event type (CONTRACT-phase2a/2b/3). Returns ev unchanged.

    Required keys + enums/formats only -- no referential integrity (events arrive out of order).
    Raises EnvelopeError with a reason on failure.
    """
    etype = ev["type"]
    payload = ev["payload"]  # already validated to be a dict by validate_envelope

    if etype == "exercise_defined":
        _validate_exercise_payload(payload)
    elif etype == "exercise_updated":
        _validate_exercise_payload(payload)
        _require_voids(ev)  # an update supersedes a prior definition (review H3)
    elif etype == "routine_defined":
        _validate_routine_payload(payload)
    elif etype == "routine_updated":
        _validate_routine_payload(payload)
        _require_voids(ev)  # an update supersedes a prior routine event
    elif etype == "set_logged":
        _validate_set_logged(ev)  # branches on tombstone vs full set
    elif etype == "measurement":
        _validate_measurement(ev)  # branches on tombstone vs full measurement

    return ev
