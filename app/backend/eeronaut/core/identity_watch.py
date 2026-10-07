"""Renew the local-access certificate before it expires, once a day.

The interface also renews on start-up (`POST /api/local/ensure`), but an
installation nobody opens for a month would let the certificate lapse, and
then local access stops until somebody happens to visit. This does it in the
background with the stored eero session, the way dynamic DNS keeps working
with nobody looking.
"""
from __future__ import annotations

import asyncio
import logging

from .config import settings

log = logging.getLogger("eeronaut.identity")

_INTERVAL = 24 * 3600
_FIRST = 120            # after start-up, and after the interface's own ensure


async def check_once() -> bool:
    """Renew if due. True when a new certificate was enrolled."""
    from ..clients import local as loc
    from ..clients.cloud import EeroCloud
    from ..core.session import store
    if not settings.local_enabled or not loc.GRPC_AVAILABLE or not store.token:
        return False
    ident = loc.load_identity()
    if not ident or not ident.renewal_due():
        return False
    from ..api.local import _do_enroll
    async with EeroCloud(token=store.token, auto_refresh=True) as c:
        result = await _do_enroll(c)
    log.info("renewed the local-access certificate (was due %s); new serial %s",
             ident.expires_at.date().isoformat(), result.serial)
    return True


async def _loop() -> None:
    await asyncio.sleep(_FIRST)
    while True:
        try:
            await check_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Tried again tomorrow; there are thirty days of margin.
            log.info("local-access certificate renewal failed: %s", e)
        await asyncio.sleep(_INTERVAL)


_task: asyncio.Task | None = None


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="identity-watch")


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except (asyncio.CancelledError, Exception):
            pass
        _task = None
