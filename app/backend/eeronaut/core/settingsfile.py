"""settings.json: every setting somebody chooses, in one file.

    {
      "theme": "harbor", "appearance": "system", ...     the preferences
      "networks": {
        "<network>": {
          "hide_subscription_gated": false, ...          its feature filters
          "plan": {"down_mbps": null, "up_mbps": null},  the speed paid for
          "alerts": {"device.new": false, ...}           Eeronaut's alerts
        }
      },
      "pinhole_notes": {...}                             port-forward notes
    }

Each module owns its part (`prefs`, `plan`, `notifstate`, `notes`) and reads
and writes it through here. Nothing awaits between a read and the write that
follows it, so on the one event loop two writers cannot interleave.

What stays in files of its own is not a setting: dynamic DNS (it holds
provider secrets), `client.json` (Eeronaut's own identity to eero), what has
been read and alerted on (notifications-<network>.json), and the caches.

These used to be prefs.json, plan.json, pinhole_notes.json and the "alerts" in
each notifications-<network>.json. `migrate` folds them in.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .config import settings

log = logging.getLogger("eeronaut")

FILE = "settings.json"


def _path() -> Path:
    return settings.data_dir / FILE


def net_key(network_url: str) -> str:
    """The key a network's section is filed under."""
    from .nodecache import network_key
    return network_key(network_url)


def _read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def read() -> dict[str, Any]:
    raw = _read_json(_path())
    return raw if isinstance(raw, dict) else {}


def write(data: dict[str, Any]) -> None:
    """Replace the file, through a temporary one so a crash mid-write leaves
    the old file rather than half a new one."""
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
    os.replace(tmp, p)


def network(data: dict[str, Any], key: str) -> dict[str, Any]:
    """This network's section of `data`, created if missing."""
    nets = data.get("networks")
    if not isinstance(nets, dict):
        nets = data["networks"] = {}
    sect = nets.get(key)
    if not isinstance(sect, dict):
        sect = nets[key] = {}
    return sect


def migrate() -> None:
    """Fold the older files in. What settings.json already holds wins, so
    this is safe to run on every start."""
    d = settings.data_dir
    prefs_p, plan_p, notes_p = d / "prefs.json", d / "plan.json", d / "pinhole_notes.json"
    alert_files = sorted(d.glob("notifications-*.json"))
    legacy_alerts = sorted(d.glob("web_notifications-*.json"))
    carrying = [p for p in (prefs_p, plan_p, notes_p) if p.exists()]
    alerts_to_move = [p for p in alert_files
                      if isinstance(_read_json(p), dict) and "alerts" in _read_json(p)]
    if not (carrying or alerts_to_move or legacy_alerts):
        return
    data = read()

    prefs = _read_json(prefs_p) if prefs_p.exists() else None
    if isinstance(prefs, dict):
        for k, v in prefs.items():
            if k == "networks" and isinstance(v, dict):
                for nk, filters in v.items():
                    if isinstance(filters, dict):
                        sect = network(data, str(nk))
                        for f, val in filters.items():
                            sect.setdefault(f, val)
            else:
                data.setdefault(k, v)

    plan = _read_json(plan_p) if plan_p.exists() else None
    if isinstance(plan, dict):
        for nk, row in plan.items():
            if isinstance(row, dict):
                network(data, str(nk)).setdefault("plan", row)

    notes = _read_json(notes_p) if notes_p.exists() else None
    if isinstance(notes, dict):
        have = data.setdefault("pinhole_notes", {})
        for k, v in notes.items():
            have.setdefault(k, v)

    # Alert switches, from notifications-<network>.json and, older still,
    # web_notifications-<network>.json.
    moved: list[tuple[Path, dict]] = []
    for p in alert_files:
        raw = _read_json(p)
        if isinstance(raw, dict) and isinstance(raw.get("alerts"), dict):
            key = p.stem.removeprefix("notifications-")
            sect = network(data, key).setdefault("alerts", {})
            for k, v in raw["alerts"].items():
                sect.setdefault(k, v)
            moved.append((p, {k: v for k, v in raw.items() if k != "alerts"}))
    for p in legacy_alerts:
        raw = _read_json(p)
        if isinstance(raw, dict):
            key = p.stem.removeprefix("web_notifications-")
            sect = network(data, key).setdefault("alerts", {})
            for k, v in raw.items():
                sect.setdefault(k, v)

    try:
        write(data)
        for p in carrying + legacy_alerts:
            p.unlink(missing_ok=True)
        for p, rest in moved:
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(rest, indent=1))
            os.replace(tmp, p)
        names = [p.name for p in carrying + legacy_alerts] + [
            f"alerts in {p.name}" for p, _ in moved]
        log.info("Moved %s into %s.", ", ".join(names), FILE)
    except OSError:
        pass                            # a read-only folder: the old files stay
