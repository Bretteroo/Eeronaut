"""Eeronaut's own notification settings and state, per network.

Which of eero's events raise an alert here is a setting, and lives in the
network's section of settings.json under "alerts" (see `settingsfile`).

What has been read and alerted on is state, and changes as notifications
come in, so it has a file per network, `notifications-<network>.json`:

* read_at       the "mark all read" watermark: anything older reads as read
* dismissed     items read one at a time since then, by category and time
* alerted       eero ids already turned into alerts, so each alerts once
* backlog_seen  whether the first look has happened. The first look records
                what is already there without alerting: a backlog of a hundred
                items is not a hundred new events.

The notifications themselves are not kept; they are eero's, read each time.

This state used to live in each browser's local storage, so a second browser
or a cleared cache showed everything unread again and brought dismissed items
back.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import settingsfile
from .config import settings

# The Eeronaut column's switches in Settings, by eero's own event keys: the
# same events as NOTIFICATION_PREFS in api/extras (a test holds the two
# together). All off until somebody switches one on.
EVENTS = (
    "network.updated",
    "network.scheduledUpdate.earlyNotification",
    "network.scheduledUpdate.lateNotification",
    "device.new",
    "device.restrict.new.private",
    "backup.internet.status.change",
    "network.dataUsageReport",
    "permissions.updates",
    "premium.activity.weeklyReport",
)

# Enough to cover eero's whole feed several times over, and no more: without
# a cap these lists would only grow.
KEEP = 400


def now_iso() -> str:
    """The time in the form the interface compares eero's timestamps against,
    as the browser's `toISOString` writes it: milliseconds and a Z."""
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _path(key: str) -> Path:
    return settings.data_dir / f"notifications-{key}.json"


def _read(p: Path) -> dict[str, Any]:
    try:
        raw = json.loads(p.read_text())
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _defaults() -> dict[str, Any]:
    return {"read_at": now_iso(), "dismissed": [], "alerted": [], "backlog_seen": False}


# ------------------------------------------------------------ the alert switches

def _complete_alerts(raw: Any) -> dict[str, bool]:
    """Every event with a value. Only events that exist: a key an older
    version used, or a typo in a hand edit, is dropped rather than kept as a
    switch nothing shows."""
    out = {k: False for k in EVENTS}
    if isinstance(raw, dict):
        out.update({k: bool(v) for k, v in raw.items() if k in EVENTS})
    return out


def alerts(key: str) -> dict[str, bool]:
    """This network's switches, complete, written back if they were not."""
    data = settingsfile.read()
    sect = settingsfile.network(data, key)
    have = _complete_alerts(sect.get("alerts"))
    if sect.get("alerts") != have:
        sect["alerts"] = have
        try:
            settingsfile.write(data)
        except OSError:
            pass                        # a read-only folder still reads
    return have


def set_alerts(key: str, changes: dict[str, bool]) -> dict[str, bool]:
    data = settingsfile.read()
    sect = settingsfile.network(data, key)
    have = _complete_alerts(sect.get("alerts"))
    have.update({k: bool(v) for k, v in changes.items() if k in EVENTS})
    sect["alerts"] = have
    settingsfile.write(data)
    return have


# ------------------------------------------------------------ read and alerted

def _complete(raw: dict[str, Any]) -> dict[str, Any]:
    """Every field present and of the right shape, whatever the file said. A
    hand edit or an older version should not take the bell down."""
    out = _defaults()
    if isinstance(raw.get("read_at"), str) and raw["read_at"]:
        out["read_at"] = raw["read_at"]
    for name in ("dismissed", "alerted"):
        if isinstance(raw.get(name), list):
            out[name] = [str(x) for x in raw[name]][-KEEP:]
    out["backlog_seen"] = bool(raw.get("backlog_seen", False))
    return out


def save(key: str, data: dict[str, Any]) -> None:
    p = _path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, p)


def load(key: str) -> dict[str, Any]:
    """This network's read and alerted state, complete. Written back when the
    file was missing or incomplete, so what is on disk shows every value."""
    raw = _read(_path(key))
    data = _complete(raw)
    if data != raw:
        try:
            save(key, data)
        except OSError:
            pass                        # a read-only folder still reads
    return data


def update(key: str, **fields: Any) -> dict[str, Any]:
    """Replace any of read_at, dismissed, alerted, and backlog_seen."""
    data = load(key)
    data.update({k: v for k, v in fields.items() if v is not None})
    data = _complete(data)
    save(key, data)
    return data


def dismiss(key: str, item: str) -> dict[str, Any]:
    data = load(key)
    if item not in data["dismissed"]:
        data["dismissed"] = (data["dismissed"] + [item])[-KEEP:]
        save(key, data)
    return data


def read_all(key: str, at: str | None = None) -> dict[str, Any]:
    return update(key, read_at=at or now_iso(), dismissed=[])


def claim(key: str, ids: list[str]) -> list[str]:
    """Record these eero ids as alerted, and return the ones that were new.

    The server answers rather than each browser deciding, so that two open
    tabs, or two components on one page, cannot both alert on the same item.
    Nothing awaits between reading the file and writing it, so on the one
    event loop this is not interleaved with another claim. On the first look
    everything is recorded and nothing is new.
    """
    data = load(key)
    have = set(data["alerted"])
    fresh = [i for i in dict.fromkeys(str(x) for x in ids) if i and i not in have]
    first = not data["backlog_seen"]
    if fresh or first:
        data["alerted"] = (data["alerted"] + fresh)[-KEEP:]
        data["backlog_seen"] = True
        save(key, data)
    return [] if first else fresh
