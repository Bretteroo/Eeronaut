"""Locally cached node reachability data.

The local gRPC channel needs each node's IPv6 link-local address, and that
address is only published by eero's cloud. If the WAN is down, the cloud is
unreachable and the address cannot be looked up - which would make the offline
control page useless precisely when it is needed.

So every successful cloud fetch of the node list writes a small cache here.
The offline page reads only from this cache and speaks to nodes directly, with
no cloud call in the path.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from .config import settings


@dataclass
class CachedNode:
    serial: str
    location: str
    model: str = ""
    firmware: str = ""
    gateway: bool = False
    link_local: str = ""
    mac: str = ""
    eero_id: str = ""
    led_on: bool | None = None
    led_brightness: int | None = None


@dataclass
class NodeCache:
    updated_at: float = 0.0
    network_name: str = ""
    nodes: list[CachedNode] = field(default_factory=list)

    @property
    def age_seconds(self) -> float:
        return time.time() - self.updated_at if self.updated_at else float("inf")


def network_key(network_url: str) -> str:
    """A filesystem-safe key for a network, from its URL."""
    tail = (network_url or "").rstrip("/").split("/")[-1]
    return "".join(ch for ch in tail if ch.isalnum()) or "default"


def _path(key: str = "default") -> Path:
    # One file per network. A single shared file meant that viewing a second
    # network overwrote the first one's nodes, so the local-control page would
    # happily show — and offer to act on — eeros belonging to whichever network
    # was looked at last.
    return settings.data_dir / f"nodes-{key}.json"


def save(network_name: str, eeros: list[dict],
         key: str = "default") -> NodeCache:
    """Record what is needed to reach these nodes without the cloud."""
    from ..clients.local import link_local_of          # avoid a circular import

    nodes = [
        CachedNode(
            serial=str(e.get("serial") or ""),
            location=str(e.get("location") or ""),
            model=str(e.get("model") or ""),
            firmware=str(e.get("os_version") or e.get("os") or ""),
            gateway=bool(e.get("gateway")),
            link_local=link_local_of(e) or "",
            mac=str(e.get("mac_address") or ""),
            eero_id=str(e.get("url") or "").rstrip("/").split("/")[-1],
            led_on=e.get("led_on") if isinstance(e.get("led_on"), bool) else None,
            led_brightness=(e["led_brightness"]
                            if isinstance(e.get("led_brightness"), int) else None),
        )
        for e in eeros
    ]
    cache = NodeCache(updated_at=time.time(), network_name=network_name, nodes=nodes)
    p = _path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"updated_at": cache.updated_at,
                             "network_name": cache.network_name,
                             "nodes": [asdict(n) for n in nodes]}, indent=1))
    return cache


def set_led_state(key: str, eero_id: str, *, on: bool | None = None,
                  brightness: int | None = None) -> None:
    """Record a light change against the cached node.

    The local pages read node state from this file rather than from the cloud,
    so without this a light that was just changed still reported its old value
    and the menu snapped back to where it had been.
    """
    p = _path(key)
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return
    changed = False
    for n in data.get("nodes") or []:
        if str(n.get("eero_id")) != str(eero_id):
            continue
        if on is not None:
            n["led_on"] = on
        if brightness is not None:
            n["led_brightness"] = brightness
        changed = True
    if changed:
        try:
            p.write_text(json.dumps(data, indent=1))
        except OSError:
            pass


def load(key: str = "default") -> NodeCache:
    p = _path(key)
    if not p.exists():
        return NodeCache()
    try:
        d = json.loads(p.read_text())
    except ValueError:
        return NodeCache()
    return NodeCache(updated_at=d.get("updated_at", 0.0),
                     network_name=d.get("network_name", ""),
                     nodes=[_node(n) for n in d.get("nodes", [])])


def _node(d: dict) -> CachedNode:
    """Tolerate cache files written by a different version of the app."""
    keep = {f.name for f in fields(CachedNode)}
    return CachedNode(**{k: v for k, v in d.items() if k in keep})
