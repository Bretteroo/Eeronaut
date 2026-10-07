"""Keeping the eero app version Eeronaut presents current, without being asked.

eero's API answers its own mobile apps, and Eeronaut presents itself as one:
`settings.client_version` goes into every request's user agent. An old one
risks eero refusing it, or quietly offering fewer features. Keeping it current
used to be the user's job, a field in Settings and a "Check for updates"
button. This does it once a day instead: it asks the Play Store for the newest
release and moves the presented version up to it.

Only ever forward. A custom user agent keeps its own shape, with the old
version inside it replaced.
"""
from __future__ import annotations

import asyncio
import logging

from . import client_identity, client_version
from .config import settings

log = logging.getLogger("eeronaut.client")

_INTERVAL = 24 * 3600
_FIRST = 60             # let the app finish starting before the first look


async def check_once() -> str | None:
    """Look once, and move up if there is something newer. Returns the new
    version when it moved, or None."""
    info = await client_version.check(force=True)
    old = settings.client_version
    if not info.latest or not info.update_available:
        return None
    client_identity.store(info.latest)
    log.info("now presenting eero app version %s to eero (was %s)", info.latest, old)
    return info.latest


async def _loop() -> None:
    await asyncio.sleep(_FIRST)
    while True:
        try:
            await check_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Nothing here may end the loop: a day without a check is fine,
            # every later day without one is not.
            log.info("client version check failed: %s", e)
        await asyncio.sleep(_INTERVAL)


_task: asyncio.Task | None = None


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="client-version-watch")


async def stop() -> None:
    global _task
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
