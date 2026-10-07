"""Discover the current eero Android app version.

eero's API derives feature capability from the client version in the
User-Agent, so this value has to stay current. Rather than baking it in, the
app looks up the published version, and `client_update_watch` adopts it once a
day.

Advisory by design. Every failure path returns "no suggestion" rather than
raising, because a store lookup failing is not a reason to degrade the app.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

import httpx

from . import client_identity
from .config import settings

_PLAY = ("https://play.google.com/store/apps/details"
         "?id=com.eero.android&hl=en_US&gl=US")
_BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
               "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

# The Play listing embeds the version inside a nested JSON array. Kept first
# because it is unambiguous; the looser pattern is a fallback for markup drift.
_EXACT = re.compile(r'\[\[\["(\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.\d{1,6})?)"\]\]')
_LOOSE = re.compile(r'\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{3,6})\b')

CACHE_TTL_S = 6 * 3600


def _vkey(v: str) -> tuple[int, ...]:
    try:
        return tuple(int(p) for p in v.split("."))
    except ValueError:
        return (0,)


@dataclass
class VersionInfo:
    latest: str | None
    current: str
    source: str
    checked_at: float
    stale: bool = False

    @property
    def update_available(self) -> bool:
        return bool(self.latest) and _vkey(self.latest) > _vkey(self.current)

    def as_dict(self) -> dict[str, object]:
        return {"latest": self.latest, "current": self.current,
                "source": self.source, "checked_at": self.checked_at,
                "update_available": self.update_available, "stale": self.stale}


def _read_cache() -> dict | None:
    """The last good check, kept under "play" in `client.json`."""
    play = client_identity.read_all().get("play")
    return play if isinstance(play, dict) and play else None


async def _from_play() -> str | None:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True,
                                 headers={"User-Agent": _BROWSER_UA,
                                          "Accept-Language": "en-US,en;q=0.9"}) as c:
        r = await c.get(_PLAY)
        if r.status_code != 200:
            return None
        m = _EXACT.findall(r.text)
        if m:
            return max(m, key=_vkey)
        loose = _LOOSE.findall(r.text)
        return max(loose, key=_vkey) if loose else None


async def check(force: bool = False) -> VersionInfo:
    current = settings.client_version
    cached = _read_cache()
    if cached and not force and time.time() - cached.get("checked_at", 0) < CACHE_TTL_S:
        return VersionInfo(cached.get("latest"), current,
                           cached.get("source", "cache"), cached["checked_at"])
    try:
        latest = await _from_play()
        source = "play"
    except (httpx.HTTPError, OSError):
        latest, source = None, "unreachable"

    if latest is None and cached:
        # Keep showing the last known good answer rather than nothing.
        return VersionInfo(cached.get("latest"), current, "cache",
                           cached.get("checked_at", 0), stale=True)

    info = VersionInfo(latest, current, source, time.time())
    if latest:
        client_identity.write_all({**client_identity.read_all(),
                                   "play": {"latest": latest, "source": source,
                                            "checked_at": info.checked_at}})
    return info
