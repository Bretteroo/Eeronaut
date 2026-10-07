"""The speed the household pays its provider for, kept beside the readings.

eero has no field for it, and it is the one number that turns a speed test
from a figure into a verdict: 600 Mbps is fine on a 600 plan and a problem on
a gigabit one. Kept per network in settings.json, since the person running
Eeronaut may look after more than one.
"""
from __future__ import annotations

from typing import Any

from . import settingsfile

MAX_MBPS = 100_000


def get(network_url: str) -> dict[str, float | None]:
    sect = (settingsfile.read().get("networks") or {}).get(
        settingsfile.net_key(network_url)) or {}
    row = sect.get("plan") if isinstance(sect.get("plan"), dict) else {}
    return {"down_mbps": _clean(row.get("down_mbps")),
            "up_mbps": _clean(row.get("up_mbps"))}


def _clean(v: Any) -> float | None:
    """A positive number within reason, or nothing. Written by this module,
    but the file is on disk and a hand edit should not take the page down."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if 0 < v <= MAX_MBPS else None


def set_plan(network_url: str, down_mbps: float | None, up_mbps: float | None) -> dict[str, float | None]:
    # Kept even when both are cleared: null is "not set", and the file shows
    # every network's entry whether or not a plan was ever typed.
    row = {"down_mbps": _clean(down_mbps), "up_mbps": _clean(up_mbps)}
    data = settingsfile.read()
    settingsfile.network(data, settingsfile.net_key(network_url))["plan"] = row
    settingsfile.write(data)
    return row


def ensure(network_url: str) -> None:
    """Give this network a plan, both speeds null until somebody types one."""
    data = settingsfile.read()
    sect = settingsfile.network(data, settingsfile.net_key(network_url))
    if not isinstance(sect.get("plan"), dict):
        sect["plan"] = {"down_mbps": None, "up_mbps": None}
        settingsfile.write(data)
