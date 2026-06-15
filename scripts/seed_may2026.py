#!/usr/bin/env python3
"""Compile the Advocate's realistic May-2026 PPL spec into valid WT Tracker events
and inject them into a user's append-only log via the real storage path.

Run from the `server/` dir so `from app import ...` resolves:

    cd server && uv run python ../scripts/seed_may2026.py --user test_user --wipe

Every event is run through `events.validate_envelope` + `events.validate_payload`
BEFORE injection (same checks the server applies to a real /api/sync POST), and
injected with `storage.append_events`, which stamps the immutable `_seq` and
month-buckets the JSONL exactly like a live sync. Weights are stored canonical lb
(the spec is already lb); distance canonical meters; duration whole seconds.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from datetime import date, timedelta
from pathlib import Path

# Make the `app` package importable regardless of cwd (run via `uv run` from server/).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from app import events, storage, config

SPEC_PATH = Path(__file__).resolve().parent / "may2026_spec.json"
TZ_OFFSET = "-07:00"  # PDT (May is daylight time in America/Los_Angeles)
DEVICE = "seed-may2026"

YEAR, MONTH = 2026, 5
DAY_FOR_WEEKDAY = {  # PPL split -> the project weekday convention (0=Mon..6=Sun)
    "push": {0, 3},
    "pull": {1, 4},
    "legs": {2, 5},
}


def _id() -> str:
    return str(uuid.uuid4())


def _ev(etype: str, payload: dict, ts: str, voids: str | None = None) -> dict:
    return {
        "v": 1,  # schema version (matches client sync.SCHEMA_VERSION)
        "id": _id(),
        "type": etype,
        "ts": ts,
        "device": DEVICE,
        "voids": voids,
        "payload": payload,
    }


def _round5(x: float) -> float:
    return float(round(x / 5.0) * 5)


def _week_index(d: int) -> int:
    """1-based week of the month (week 1 = days 1-7)."""
    return (d - 1) // 7 + 1


def _working_weight(prog: dict, week: int) -> float:
    """Top working weight for a weighted lift in a given week: start + per-week
    increment, skipping `stall_weeks` (no progression that week), with the deload
    week pulled back ~12% off the pre-deload load."""
    start = float(prog["start_top_lb"])
    inc = float(prog.get("weekly_increment_lb", 0))
    stalls = set(prog.get("stall_weeks", []))
    deload = prog.get("deload_week")

    def cumulative(up_to_week: int) -> float:
        steps = sum(1 for w in range(2, up_to_week + 1) if w not in stalls)
        return start + inc * steps

    if deload and week == deload:
        # Deload off the last loaded week before it.
        return _round5(cumulative(week - 1) * 0.88)
    if deload and week > deload:
        # Resume: count the deload week as a non-progressing week.
        steps = sum(1 for w in range(2, week + 1) if w not in stalls and w != deload)
        return start + inc * steps
    return cumulative(week)


def _warmup_plan(top: float, n: int) -> list[tuple[float, int]]:
    """(weight, reps) ramp for `n` warmup sets up to working weight `top`."""
    if n <= 0:
        return []
    reps_ramp = [8, 5, 3, 2, 2]
    out = []
    for i in range(n):
        frac = 0.6 if n == 1 else 0.45 + (0.85 - 0.45) * i / (n - 1)
        out.append((_round5(top * frac), reps_ramp[min(i, len(reps_ramp) - 1)]))
    return out


def _interp(a: float, b: float, frac: float, ndigits: int = 1) -> float:
    return round(a + (b - a) * frac, ndigits)


def build_events(spec: dict) -> list[dict]:
    ex_id = {e["key"]: _id() for e in spec["exercises"]}
    by_key = {e["key"]: e for e in spec["exercises"]}
    defs_ts = f"{YEAR}-{MONTH:02d}-01T00:00:00{TZ_OFFSET}"

    out: list[dict] = []

    # --- exercise_defined (one per exercise) -------------------------------
    for e in spec["exercises"]:
        out.append(
            _ev(
                "exercise_defined",
                {
                    "exercise_id": ex_id[e["key"]],
                    "name": e["name"],
                    "type": e["type"],
                    "rest_seconds": int(e.get("rest_seconds", 0)),
                },
                defs_ts,
            )
        )

    # --- routine_defined (Push/Pull/Legs) ----------------------------------
    for r in spec["routines"]:
        out.append(
            _ev(
                "routine_defined",
                {
                    "routine_id": _id(),
                    "name": r["name"],
                    "ordered_exercise_ids": [ex_id[k] for k in r["exercise_keys"]],
                    "weekday_assignments": sorted(r["weekdays"]),
                },
                defs_ts,
            )
        )

    # --- body-comp measurements (baseline May 1 + each Sunday) -------------
    bc = spec["bodycomp"]
    last_day = (date(YEAR, MONTH, 28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    ndays = last_day.day
    measure_wd = set(bc.get("measure_weekdays", [6]))
    measure_days = sorted(
        {1} | {d for d in range(1, ndays + 1) if date(YEAR, MONTH, d).weekday() in measure_wd}
    )
    # `latest measurement on/before a session date` (base lb) for assisted snapshots.
    snapshots: list[tuple[str, float]] = []  # (date, bodyweight_lb) sorted
    for d in measure_days:
        frac = (d - 1) / (ndays - 1)
        ds = f"{YEAR}-{MONTH:02d}-{d:02d}"
        bw = _interp(bc["bw_start_lb"], bc["bw_end_lb"], frac)
        out.append(
            _ev(
                "measurement",
                {
                    "date": ds,
                    "unit": "lb",
                    "bodyweight": bw,
                    "body_fat_pct": _interp(bc["bf_start_pct"], bc["bf_end_pct"], frac),
                    "muscle_mass": _interp(bc["muscle_start_lb"], bc["muscle_end_lb"], frac),
                    # waist is canonical cm (the client converts in/cm on display).
                    "waist": _interp(bc["waist_start_cm"], bc["waist_end_cm"], frac),
                },
                f"{ds}T08:00:00{TZ_OFFSET}",
            )
        )
        snapshots.append((ds, bw))

    def snapshot_for(session_date: str) -> tuple[str, float]:
        chosen = snapshots[0]
        for ds, bw in snapshots:
            if ds <= session_date:
                chosen = (ds, bw)
            else:
                break
        return chosen

    prog = spec["progression"]
    cardio = spec["cardio"]

    # --- per-day training sessions -----------------------------------------
    for d in range(1, ndays + 1):
        wd = date(YEAR, MONTH, d).weekday()  # 0=Mon..6=Sun (matches app convention)
        session_date = f"{YEAR}-{MONTH:02d}-{d:02d}"
        ts = f"{session_date}T18:00:00{TZ_OFFSET}"
        week = _week_index(d)

        # Which split runs today (rest on Sunday=6 -> no day matches).
        day_name = next((dn for dn, wds in DAY_FOR_WEEKDAY.items() if wd in wds), None)
        if day_name:
            for key, e in by_key.items():
                if e.get("day") != day_name:
                    continue
                p = prog[key]
                idx = 0
                assisted = e.get("assisted", False)
                deload = p.get("deload_week")
                is_deload = deload and week == deload
                work_sets = max(1, p["work_sets"] - (1 if is_deload else 0))
                reps = list(p["reps"])

                if assisted:
                    # Assist (weight removed) trends DOWN as they get stronger; deload
                    # eases it back up a touch. added_weight stored NEGATIVE.
                    assist = p["start_assist_lb"] - p["weekly_assist_reduction_lb"] * (week - 1)
                    if is_deload:
                        assist += 10
                    assist = max(20.0, _round5(assist))
                    snap_date, snap_bw = snapshot_for(session_date)
                    for j in range(work_sets):
                        r = reps[min(j, len(reps) - 1)]
                        out.append(
                            _ev(
                                "set_logged",
                                {
                                    "exercise_id": ex_id[key],
                                    "session_date": session_date,
                                    "set_index": idx,
                                    "unit": "lb",
                                    "warmup": False,
                                    "weight": None,
                                    "reps": int(r),
                                    "added_weight": -assist,
                                    "bodyweight_snapshot": snap_bw,
                                    "bodyweight_snapshot_date": snap_date,
                                },
                                ts,
                            )
                        )
                        idx += 1
                    continue

                top = _working_weight(p, week)
                # Warmups (excluded from e1RM/volume) ramp to the working weight.
                for w_weight, w_reps in _warmup_plan(top, p.get("warmup_sets", 0)):
                    out.append(
                        _ev(
                            "set_logged",
                            {
                                "exercise_id": ex_id[key],
                                "session_date": session_date,
                                "set_index": idx,
                                "unit": "lb",
                                "warmup": True,
                                "weight": w_weight,
                                "reps": int(w_reps),
                            },
                            ts,
                        )
                    )
                    idx += 1
                # Working sets. On a stall week the final set drops a rep (missed it).
                for j in range(work_sets):
                    r = reps[min(j, len(reps) - 1)]
                    if week in set(p.get("stall_weeks", [])) and j == work_sets - 1:
                        r = max(1, r - 1)
                    out.append(
                        _ev(
                            "set_logged",
                            {
                                "exercise_id": ex_id[key],
                                "session_date": session_date,
                                "set_index": idx,
                                "unit": "lb",
                                "warmup": False,
                                "weight": top,
                                "reps": int(r),
                            },
                            ts,
                        )
                    )
                    idx += 1

        # Cardio (independent of the PPL split; its own weekdays).
        for key, c in cardio.items():
            if wd not in set(c["days"]):
                continue
            dist_km = c["distance_km"] + c.get("weekly_distance_growth_km", 0) * (week - 1)
            dur_min = c["duration_min"] * (dist_km / c["distance_km"])
            out.append(
                _ev(
                    "set_logged",
                    {
                        "exercise_id": ex_id[key],
                        "session_date": session_date,
                        "set_index": 0,
                        "warmup": False,
                        "duration_s": int(round(dur_min * 60)),
                        "distance_m": round(dist_km * 1000),
                    },
                    ts,
                )
            )

    return out


def validate_all(evs: list[dict]) -> None:
    for ev in evs:
        events.validate_envelope(ev)
        events.validate_payload(ev)


def order_for_injection(evs: list[dict]) -> list[dict]:
    """Definitions first (lowest _seq), then everything chronologically by ts."""
    defs = [e for e in evs if e["type"] in ("exercise_defined", "routine_defined")]
    rest = sorted(
        (e for e in evs if e["type"] not in ("exercise_defined", "routine_defined")),
        key=lambda e: e["ts"],
    )
    return defs + rest


def wipe_user_log(username: str) -> None:
    log_dir = config.DATA_DIR / username / "log"
    if log_dir.is_dir():
        for f in log_dir.glob("sets-*.jsonl"):
            f.unlink()
    seq = config.DATA_DIR / username / "seq.json"
    if seq.exists():
        seq.unlink()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="test_user")
    ap.add_argument("--wipe", action="store_true", help="clear the user's log + seq first")
    ap.add_argument("--dry-run", action="store_true", help="validate + summarize, don't write")
    args = ap.parse_args()

    spec = json.loads(SPEC_PATH.read_text())
    evs = build_events(spec)
    validate_all(evs)

    counts: dict[str, int] = {}
    for e in evs:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    sets = [e for e in evs if e["type"] == "set_logged"]
    work = [e for e in sets if not e["payload"].get("warmup") and "duration_s" not in e["payload"]]
    print(f"built {len(evs)} events: {counts}")
    print(f"  working strength sets: {len(work)} | cardio: "
          f"{sum('duration_s' in e['payload'] for e in sets)}")
    sess_dates = sorted({e['payload']['session_date'] for e in sets})
    print(f"  session days: {len(sess_dates)} ({sess_dates[0]}..{sess_dates[-1]})")

    if args.dry_run:
        print("dry-run: validated OK, nothing written")
        return

    if args.wipe:
        wipe_user_log(args.user)
        print(f"wiped {args.user} log + seq.json")

    accepted, duplicate = await storage.append_events(args.user, order_for_injection(evs))
    print(f"injected: {len(accepted)} accepted, {len(duplicate)} duplicate")


if __name__ == "__main__":
    asyncio.run(main())
