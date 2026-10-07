"""Keeping the published address current without a browser open.

Dynamic DNS is only worth having if it works while nobody is looking, so this
runs in the background rather than on a page load. It walks the networks that
have a configuration and asks the updater to publish each one; the updater is
the thing that decides whether a request is warranted, which is where the
providers' "only when it changes" rule is enforced.

Deliberately dumb about scheduling. It wakes on a fixed interval and asks; it
does not try to predict when an address will move, and it does not retry faster
after a failure. A dynamic address typically changes every few days at most, so
a slow poll costs nothing and a fast one is how a client ends up rate-limited.

`_INTERVAL` is a poll of eero's own record of the address, not of the provider:
the provider is only contacted when the address has actually changed, so this
number is about how quickly a change is noticed, not how often anyone is asked.
"""
from __future__ import annotations

import asyncio
import logging

from ..clients.cloud import EeroCloud
from . import ddns, ddns_update, ddns_verify
from .session import store

log = logging.getLogger("eeronaut.ddns")

_INTERVAL = 5 * 60          # how soon a changed address is noticed
_FIRST = 20                 # let the app finish starting before the first look


async def _wan_ip(c: EeroCloud, net: str) -> str:
    n = await c.follow(net)
    return str(n.get("wan_ip") or "")


async def _sweep() -> None:
    """One pass over every configured network."""
    nets = ddns.configured_networks()
    if not nets:
        return
    if not store.token:
        # No eero session, so no way to learn the address: most often a
        # restart that dropped a session nobody asked to be remembered. Said
        # on the panel, which otherwise went on showing the last success
        # while nothing was being published at all.
        for nid in nets:
            net = f"/2.2/networks/{nid}"
            _, st = ddns.load(net)
            if st.result != "nosession":
                ddns.record(net, "nosession",
                            "Not updating: Eeronaut is not signed in to eero. "
                            "Sign in, and tick \"Stay signed in on this device\" "
                            "so updates carry on after a restart.",
                            key="ddns_detail.no_session")
        return
    # One client for the pass. `auto_refresh` so a session that expired
    # overnight is renewed rather than turning into a run of failures.
    c = EeroCloud(token=store.token, auto_refresh=True)
    try:
        for nid in nets:
            net = f"/2.2/networks/{nid}"
            try:
                ip = await _wan_ip(c, net)
            except Exception as e:
                # Not recorded as a provider failure: this is us failing to
                # learn the address, and writing it to the status would blame
                # the provider for something it never saw.
                log.info("ddns: could not read the address for %s: %s", nid, e)
                continue
            try:
                st = await ddns_update.publish(net, ip)
                if st.result not in ("ok", "nochange"):
                    log.info("ddns: %s -> %s (%s)", nid, st.result, st.detail)
            except Exception as e:
                log.warning("ddns: update failed for %s: %s", nid, e)
            try:
                # Separate from the update on purpose: a name can stop
                # resolving without any update ever failing, so this has to run
                # on its own schedule rather than only after a change. The
                # verifier decides whether a lookup is due.
                await ddns_verify.verify(net)
            except Exception as e:
                log.info("ddns: could not check the name for %s: %s", nid, e)
    finally:
        await c.aclose()


async def _loop() -> None:
    await asyncio.sleep(_FIRST)
    while True:
        try:
            await _sweep()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # A background task that dies takes dynamic DNS with it silently,
            # so nothing here is allowed to escape the loop.
            log.warning("ddns: sweep failed: %s", e)
        await asyncio.sleep(_INTERVAL)


_task: asyncio.Task | None = None


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="ddns-watch")


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
