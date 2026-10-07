"""The parts of an IPv6 pinhole eero does not keep.

eero's pinhole record is url, device, protocol, port — nothing else. A port
forward, sitting right beside it in the same table, carries a description and
an enabled flag. Two rules that do the same job should not behave differently
because of that, so the missing parts are kept here:

  description   eero has no field for one.
  disabled      eero has no off switch. A pinhole is open or it does not
                exist, so turning one off closes it for real and this record
                remembers it well enough to reopen it later. Nothing is
                pretending: the hole really is shut while it is off.

Records are keyed by the network and by what the rule is — network, device,
port, protocol — rather than by URL, so a pinhole that is closed and reopened
keeps its label, and nothing has to guess which URL eero assigned on create.

The network is in the key because leaving it out was a real bug, and it caused
two separate kinds of damage on one account:

  * `prune` keeps the records for rules eero still has. Called while looking at
    one network, it was deleting the descriptions belonging to every other one —
    they are not in this network's live list, so they looked like rules eero had
    dropped. Opening the Security page on a second network silently wiped the
    first network's labels.

  * A pinhole held closed has no eero record, so it is listed from this record.
    Unscoped, a rule held closed on one network was drawn as a rule on every
    network the account can see. Nothing was actually opened anywhere — but a
    firewall rule shown on a network that does not have it is a lie in the
    dangerous direction.

Keys written before the network was part of them are still read, and are moved
under their network the first time that network reports the rule as live. One
that is live nowhere cannot be attributed to a network, so it is kept but never
listed — better a dormant record than either deleting somebody's label or
showing a rule to a network that has none.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from . import settingsfile

# The section of settings.json these live in.
SECTION = "pinhole_notes"


def key(net: str, device: str, port: str, protocol: str) -> str:
    """The record's identity, scoped to one network.

    `net` is eero's network resource path; only its trailing id is used, so a
    leading slash or a version prefix does not make a second key for the same
    network.
    """
    nid = str(net or "").rstrip("/").split("/")[-1]
    return f"{nid}|{device}|{port}|{protocol}".lower()


def _legacy_key(device: str, port: str, protocol: str) -> str:
    """The key shape used before records were scoped to a network."""
    return f"{device}|{port}|{protocol}".lower()


def _is_legacy(k: str) -> bool:
    return k.count("|") == 2


def _of_net(k: str, net: str) -> bool:
    nid = str(net or "").rstrip("/").split("/")[-1].lower()
    return not _is_legacy(k) and k.split("|", 1)[0] == nid


def belongs_to(k: str, net: str) -> bool:
    """Whether a stored key is this network's.

    Used by the pinhole list so a rule held closed on one network is not drawn
    as a rule on another. Unscoped keys from before the network was part of them
    belong to no network and are never listed — they cannot be attributed, and
    showing a firewall rule to a network that does not have it is worse than
    leaving a dormant record in the file.
    """
    return _of_net(k, net)


_NET_IN_DEVICE = re.compile(r"/networks/([^/]+)/", re.I)


def _adopt(k: str, row: dict[str, Any]) -> str:
    """The network-scoped key for an unscoped record, where one can be worked out.

    eero's device path carries the network in it —
    `/2.2/networks/1000001/devices/001122334466` — so a record written before
    the key was scoped can still be filed under the right network rather than
    left dormant. That matters: the two records on the account this was found on
    were both held-closed rules, which is the case that was being drawn as a
    rule on every other network, and dropping them would have taken their
    labels and their closed state with them.
    """
    m = _NET_IN_DEVICE.search(str(row.get("device") or ""))
    if not m:
        return k
    return key(m.group(1), str(row.get("device") or ""),
               str(row.get("port") or ""), str(row.get("protocol") or ""))


def load() -> dict[str, dict[str, Any]]:
    data = settingsfile.read().get(SECTION)
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    moved = False
    for k, v in data.items():
        row = v if isinstance(v, dict) else (
            # The first version of this file stored a bare description.
            {"description": v} if isinstance(v, str) else None)
        if row is None:
            continue
        k = str(k)
        if _is_legacy(k):
            adopted = _adopt(k, row)
            if adopted != k:
                k, moved = adopted, True
        out[k] = row
    if moved:
        _save(out)
    return out


def ensure() -> None:
    """Start the section empty, so it is there before the first note."""
    if not isinstance(settingsfile.read().get(SECTION), dict):
        _save({})


def _save(rows: dict[str, dict[str, Any]]) -> None:
    data = settingsfile.read()
    data[SECTION] = rows
    settingsfile.write(data)


def _row(rows, net: str, device: str, port: str, protocol: str) -> dict[str, Any]:
    k = key(net, device, port, protocol)
    # An unscoped record for the same rule is adopted rather than left behind,
    # so a description written before this change survives the first edit.
    old = rows.pop(_legacy_key(device, port, protocol), None)
    row = rows.setdefault(k, old or {})
    row["device"], row["port"], row["protocol"] = device, port, protocol
    return row


def describe(net: str, device: str, port: str, protocol: str,
             description: str) -> None:
    rows = load()
    row = _row(rows, net, device, port, protocol)
    text = description.strip()
    if text:
        row["description"] = text
    else:
        row.pop("description", None)
    _forget_if_empty(rows, key(net, device, port, protocol))
    _save(rows)


def set_disabled(net: str, device: str, port: str, protocol: str,
                 off: bool) -> None:
    rows = load()
    row = _row(rows, net, device, port, protocol)
    if off:
        row["disabled"] = True
    else:
        row.pop("disabled", None)
    _forget_if_empty(rows, key(net, device, port, protocol))
    _save(rows)


def move(net: str, old: tuple[str, str, str],
         new: tuple[str, str, str]) -> None:
    """Follow a rule that has been edited into a different identity.

    Records are keyed by device, port, and protocol, so changing any of those
    changes the key. Without this the description and the held-closed flag
    would be stranded under the old one.
    """
    if old == new:
        return
    rows = load()
    row = rows.pop(key(net, *old), None)
    if row is None:
        row = rows.pop(_legacy_key(*old), None)
    if row is None:
        return
    row["device"], row["port"], row["protocol"] = new
    rows[key(net, *new)] = row
    _save(rows)


def forget(net: str, device: str, port: str, protocol: str) -> None:
    rows = load()
    rows.pop(key(net, device, port, protocol), None)
    rows.pop(_legacy_key(device, port, protocol), None)
    _save(rows)


def _forget_if_empty(rows: dict[str, dict[str, Any]], k: str) -> None:
    row = rows.get(k) or {}
    if not row.get("description") and not row.get("disabled"):
        rows.pop(k, None)


def prune(net: str, live: Iterable[str]) -> dict[str, dict[str, Any]]:
    """Drop this network's records for pinholes eero no longer has and this app
    is not holding off.

    Scoped to one network. Unscoped, this deleted every other network's
    descriptions on every load: they are absent from this network's live list,
    which is indistinguishable from a rule eero has dropped. Records belonging
    to another network, and unscoped records from before this change, are left
    exactly as they are.

    Only ever called with a list eero has just returned, so a failed request
    cannot be mistaken for "there are none left".
    """
    rows = load()
    alive = set(live)
    keep = {
        k: v for k, v in rows.items()
        if not _of_net(k, net) or k in alive or v.get("disabled")
    }
    if len(keep) != len(rows):
        _save(keep)
    return keep
