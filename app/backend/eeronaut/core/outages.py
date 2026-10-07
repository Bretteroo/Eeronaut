"""What was true while the internet was down, kept until somebody reads it.

eero's own notification says it "detected an internet outage and switched to
backup". It does not say what the fault was, or which of the two backups took
over. Both are knowable — but only while it is happening: the Signal reports
whether it is carrying, and the gateway's WAN interface names the fault. Ten
minutes later the primary is back, every one of those readings says "fine",
and the notification is the only trace left.

So the readings are written down as they are taken. This is the file they go
in: one open outage at a time per network, closed when the primary returns,
and looked up afterward by the moment eero stamped on its notification.

Deliberately small. It records what was observed and nothing derived — no
guess at a cause, no inference from a later state. An outage nobody was
watching leaves no record here, and a record that does not exist is reported
as not existing rather than as "no backup ran".
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import settings
from .nodecache import network_key

# Enough to cover a fortnight of a daily outage, which is the shape of the one
# that prompted this. Trimmed from the front, so the newest always survive.
KEEP = 100
# How far from a notification's timestamp an outage may start and still be the
# one it is talking about. eero stamps when it noticed; the first sample here
# lands up to one poll later, and the two clocks are not the same clock.
NEAR = timedelta(minutes=15)


@dataclass
class Outage:
    """One run of the primary connection being down."""
    started: str
    ended: str | None = None
    # The fault, in the gateway's own words: NO_LINK, NO_IP_ADDRESS,
    # NO_DEFAULT_ROUTE, DNS_UNREACHABLE. Never translated here — the word eero
    # uses is the one worth keeping.
    wan_state: str | None = None
    wan_type: str | None = None
    # Which backup carried it: "cellular", "hotspot", or "unknown" when the
    # primary was down and neither could be confirmed.
    backup: str | None = None
    model: str | None = None
    samples: int = 0


def _path(key: str) -> Path:
    return settings.data_dir / f"outages-{key}.json"


def _read(key: str) -> list[dict]:
    try:
        data = json.loads(_path(key).read_text())
    except (OSError, ValueError):
        return []
    rows = data.get("outages") if isinstance(data, dict) else data
    return [r for r in (rows or []) if isinstance(r, dict)]


def _write(key: str, rows: list[dict]) -> None:
    p = _path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"outages": rows[-KEEP:]}, indent=1))


def _when(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def observe(network_url: str, fault: dict | None,
            now: datetime | None = None) -> Outage | None:
    """Record one reading. `fault` is None when the primary is up.

    Returns the open outage, or None when there is nothing happening. Safe to
    call every poll: repeated readings of the same outage extend it rather
    than starting another.
    """
    key = network_key(network_url)
    at = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    rows = _read(key)
    open_row = rows[-1] if rows and not rows[-1].get("ended") else None

    if fault is None:
        if open_row is None:
            return None
        open_row["ended"] = at
        _write(key, rows)
        return Outage(**{k: v for k, v in open_row.items()
                         if k in Outage.__annotations__})

    if open_row is None:
        open_row = asdict(Outage(started=at))
        rows.append(open_row)
    open_row["samples"] = int(open_row.get("samples") or 0) + 1
    # First answer wins for the fault itself: the interesting reading is how
    # the link failed, and by the second sample the modem may already be
    # renegotiating into a different state on its way back.
    for field_name in ("wan_state", "wan_type"):
        if not open_row.get(field_name) and fault.get(field_name):
            open_row[field_name] = fault[field_name]
    # The backup is the opposite: it takes a moment to come up, so a later
    # reading that names one is better than an earlier "unknown".
    if fault.get("backup") and fault["backup"] != "unknown":
        open_row["backup"] = fault["backup"]
        open_row["model"] = fault.get("model") or open_row.get("model")
    elif not open_row.get("backup"):
        open_row["backup"] = fault.get("backup")
    _write(key, rows)
    return Outage(**{k: v for k, v in open_row.items()
                     if k in Outage.__annotations__})


def covering(network_url: str, when: str | None) -> dict | None:
    """The outage a notification stamped at `when` is about, if it was seen.

    Matches an outage that contains the moment, and otherwise the one that
    began near it — a "primary is active" notification is stamped at the end
    of an outage, which is a moment the outage no longer contains.
    """
    at = _when(when)
    if at is None:
        return None
    best = None
    for r in _read(network_key(network_url)):
        start = _when(r.get("started"))
        if start is None:
            continue
        end = _when(r.get("ended"))
        if start - NEAR <= at <= (end or start) + NEAR:
            # The closest start wins, so two outages in one hour do not both
            # answer for the same notification.
            gap = abs((at - start).total_seconds())
            if best is None or gap < best[0]:
                best = (gap, r)
    return dict(best[1]) if best else None


def recent(network_url: str, limit: int = 20) -> list[dict]:
    """The most recent outages, newest first."""
    return list(reversed(_read(network_key(network_url))))[:limit]
