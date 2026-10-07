"""Watching the primary connection, so an outage leaves a record behind.

eero notices an outage and says so; what it never says is how the link failed
or which backup took over. Both are readable while it is happening and from
nowhere afterward, so something has to be looking at the time. Nobody is
looking at 6:11 in the morning, which is when the outage that prompted this
happens.

Local first, deliberately. The gateway answers over the local channel with the
WAN down, which is the only moment this loop has anything to say; a cloud read
in the same situation fails, and a failure names no fault. Off the network's
own segment there is no local channel, so the loop records what the cloud says
instead and marks the fault unknown rather than inventing one.

Nothing here writes to the network. Every call is a read.
"""
from __future__ import annotations

import asyncio
import logging

from .outages import observe
from .session import store

log = logging.getLogger("eeronaut.wan")

_CALM = 60          # while the connection is up
_BUSY = 10          # once something is wrong, so the early moments are dense
_FIRST = 25         # let the app finish starting


async def _fault() -> dict | None:
    """What is wrong with the primary right now, or None if nothing is.

    The shape `outages.observe` takes: the WAN state in the gateway's own
    words, the kind of link it is actually using, and which backup is
    carrying.
    """
    from ..api.local import network_status          # avoid a circular import

    state = wan_type = None
    try:
        ns = await network_status()
        wan = (ns or {}).get("wan") or {}
        wan_type = wan.get("type")
        ifaces = wan.get("interfaces") or []
        state = (ifaces[0] or {}).get("state") if ifaces else None
    except Exception as e:                                   # noqa: BLE001
        log.debug("wan: no local read: %s", e)

    cell_live = False
    model = None
    try:
        from ..clients.cloud import EeroCloud
        net = store.session.network_url if store.session else ""
        if net and store.token:
            c = EeroCloud(token=store.token, auto_refresh=True)
            try:
                n = await c.follow(net)
                cell = n.get("cellular_backup") or {}
                model = cell.get("model")
                cell_live = bool(cell.get("dsn")) and str(
                    cell.get("status") or "off").lower() not in ("off", "standby", "")
                if state is None:
                    # No local channel. The cloud's own verdict is all there
                    # is, and it cannot name a fault — only that there is one.
                    healthy = ((n.get("health") or {}).get("internet") or {}
                               ).get("status") == "connected"
                    if healthy and not cell_live:
                        return None
            finally:
                await c.aclose()
    except Exception as e:                                   # noqa: BLE001
        # A cloud read failing during a WAN outage is expected, and is not
        # itself evidence of anything: the local reading above decides.
        log.debug("wan: no cloud read: %s", e)

    if state == "ONLINE" and not cell_live:
        return None
    if state is None and not cell_live:
        # Nothing could be read at all. Silence is not an outage.
        return None

    if cell_live:
        which = "cellular"
    elif wan_type and wan_type != "wired":
        which = "hotspot"
    else:
        which = "unknown"
    return {"wan_state": state, "wan_type": wan_type,
            "backup": which, "model": model if which == "cellular" else None}


async def _loop() -> None:
    await asyncio.sleep(_FIRST)
    while True:
        wait = _CALM
        try:
            net = store.session.network_url if store.session else ""
            if net:
                fault = await _fault()
                open_now = observe(net, fault)
                if fault is not None:
                    wait = _BUSY
                    log.info("wan: primary down (%s), backup %s",
                             fault.get("wan_state"), fault.get("backup"))
                elif open_now is not None:
                    log.info("wan: primary back after %s samples",
                             open_now.samples)
        except asyncio.CancelledError:
            raise
        except Exception as e:                               # noqa: BLE001
            # A background task that dies takes the record with it silently.
            log.warning("wan: sample failed: %s", e)
        await asyncio.sleep(wait)


_task: asyncio.Task | None = None


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="wan-watch")


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
