"""Whether a newer Eeronaut has been released, looked up once a day.

The newest release of the repository on GitHub is compared with the version
running. Nothing is downloaded or installed: the interface only says a new
version is out and links to its notes, and updating stays the person's to do
(`docker compose pull && docker compose up -d`, or the source steps).

Quiet on failure. No answer, no releases, or a repository GitHub will not
show without signing in (while it is private) all leave `latest` at None,
which the interface reads as "nothing to say".
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

import httpx

from .config import app_version

log = logging.getLogger("eeronaut.update")

REPOSITORY = "Bretteroo/Eeronaut"
_LATEST = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
_INTERVAL = 24 * 3600
_FIRST = 90

_state: dict[str, object] = {"latest": None, "url": None, "checked_at": 0.0}


def _key(v: str) -> tuple[int, ...]:
    """1.2.10 above 1.2.9; anything after the numbers (a -rc) is ignored."""
    return tuple(int(n) for n in re.findall(r"\d+", v.split("-")[0])[:3]) or (0,)


def status() -> dict[str, object]:
    current = app_version()
    latest = _state["latest"]
    newer = bool(latest) and current != "dev" and _key(str(latest)) > _key(current)
    return {"current": current, "latest": latest, "url": _state["url"],
            "available": newer, "checked_at": _state["checked_at"]}


async def check_once() -> None:
    async with httpx.AsyncClient(timeout=15, follow_redirects=True, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"Eeronaut/{app_version()}"}) as c:
        r = await c.get(_LATEST)
    _state["checked_at"] = time.time()
    if r.status_code != 200:
        return
    data = r.json()
    tag = str(data.get("tag_name") or "").lstrip("vV")
    if tag and not data.get("draft") and not data.get("prerelease"):
        _state["latest"] = tag
        _state["url"] = data.get("html_url")


async def _loop() -> None:
    await asyncio.sleep(_FIRST)
    while True:
        try:
            await check_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.info("release check failed: %s", e)
        await asyncio.sleep(_INTERVAL)


_task: asyncio.Task | None = None


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="app-update-watch")


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
        _task = None
