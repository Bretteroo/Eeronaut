"""Asking eero to publish live per-client throughput.

Nothing in the cloud carries a client's current rate until something asks for
it. The phone app's live-usage screen posts to the network's `burst_reporters`
resource, gets back a `next_burst` time, and posts again once that time has
passed; between those posts the nodes publish a `usage` block with every
device read, and outside them every rate is zero. Read without the post, a
network where all hundred clients are busy looks exactly like one where all
hundred are idle.

Measured against this account's own network: the first non-zero readings land
about thirteen seconds after the post, and one post is good for roughly a
minute.

Which is why this does not wait to be asked. eero's own app starts bursting
when it comes to the foreground and stops when it goes to the background —
`AppLifecycleObserver` starts `BurstService`, which polls the decision once a
second for as long as the app is on screen — so by the time anybody opens a
device, the rates are already arriving. Doing it only when a meter opens costs
that same thirteen seconds every time, which reads as the app being slow
rather than as eero warming up. The equivalent of "on screen" here is a
browser that has asked this machine for something recently; see `seen`.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from ..clients.cloud import EeroCloud
from .errors import CloudUnreachable, UpstreamError
from .session import store

log = logging.getLogger("eeronaut.burst")

# How long to wait before asking again after eero refused or did not answer.
# Long enough that a network which cannot burst at all is not being asked once
# per poll, short enough that a passing failure costs one reading.
_BACKOFF = timedelta(seconds=30)

# What to assume when the reply arrives without a usable time. eero has sent
# about a minute each time it was asked here; half that errs toward asking
# again too soon, which costs a request, rather than too late, which costs the
# reading itself.
_ASSUMED = timedelta(seconds=30)

# How long after a browser's last request the interface still counts as being
# looked at. Every page polls something at ten to sixty seconds, so ninety
# covers the slowest of them with room to spare; past that, nobody is there
# and eero is left alone.
_WATCHING_S = 90

# How often the loop checks. It only reaches eero when the window has lapsed,
# so this is the resolution of "the browser just arrived", not a request rate.
_TICK_S = 5

_next_burst: datetime | None = None
_bursting: str | None = None
_lock = asyncio.Lock()
_last_seen: float | None = None


def seen() -> None:
    """A browser just asked for something. Called from the request middleware."""
    global _last_seen
    _last_seen = time.monotonic()


def watching() -> bool:
    """Whether anybody is looking at the interface right now."""
    return _last_seen is not None and (time.monotonic() - _last_seen) < _WATCHING_S


def _parse(reply: object) -> datetime | None:
    stamp = reply.get("next_burst") if isinstance(reply, dict) else None
    if not isinstance(stamp, str):
        return None
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def _due(net: str) -> bool:
    """Whether the window eero last gave has run out for this network."""
    return not (_bursting == net and _next_burst
                and datetime.now(timezone.utc) < _next_burst)


async def keep_rates_flowing(c: EeroCloud, net: str) -> None:
    """Make sure eero is publishing rates, without asking more than it wants.

    Held under a lock because the loop below and every open meter can arrive
    together and the answer is network-wide: one post covers all of them. The
    window is remembered against the network it was asked for, so switching
    networks asks again instead of waiting out a window that belongs to
    somewhere else.
    """
    global _next_burst, _bursting
    async with _lock:
        now = datetime.now(timezone.utc)
        if not _due(net):
            return
        _bursting = net
        try:
            reply = await c.post(f"{net}/burst_reporters")
        except (CloudUnreachable, UpstreamError):
            _next_burst = now + _BACKOFF
            return
        _next_burst = _parse(reply) or now + _ASSUMED


async def _loop() -> None:
    while True:
        try:
            net = store.session.network_url if store.session else ""
            if watching() and net and store.token and _due(net):
                c = EeroCloud(token=store.token, auto_refresh=True)
                try:
                    await keep_rates_flowing(c, net)
                finally:
                    await c.aclose()
        except asyncio.CancelledError:
            raise
        except Exception as e:                               # noqa: BLE001
            # Live rates are a nicety; a failure here must not take the task
            # down and leave the meters permanently empty with no explanation.
            log.debug("burst: could not ask: %s", e)
        await asyncio.sleep(_TICK_S)


_task: asyncio.Task | None = None


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="burst")


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):
        pass
    _task = None


def forget() -> None:
    """Drop the remembered burst window and the last sighting. For tests."""
    global _next_burst, _bursting, _last_seen
    _next_burst = None
    _bursting = None
    _last_seen = None
