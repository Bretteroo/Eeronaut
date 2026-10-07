"""Housekeeping for the data folder, run once at startup."""
from __future__ import annotations

import logging
import os

from .config import settings

log = logging.getLogger("eeronaut")

# Files earlier versions wrote that nothing reads any more.
#   thread_scan-*.json      the Thread scan cache, from the removed Matter page
#   web_notifications.json  in-app alert choices from before they were kept
#                           per network
_LEFTOVERS = ("thread_scan-*.json", "web_notifications.json")

# Files holding credentials, which must be readable by their owner only.
# Their writers already set this; an older version may not have.
_OWNER_ONLY = ("ddns.json",)


def tidy() -> None:
    """Remove leftovers and tighten permissions. Never fatal: a folder that
    can't be tidied still works."""
    d = settings.data_dir
    for pattern in _LEFTOVERS:
        for p in d.glob(pattern):
            try:
                p.unlink()
                log.info("Removed %s, left over from an earlier version.", p.name)
            except OSError:
                pass
    for name in _OWNER_ONLY:
        p = d / name
        try:
            if p.exists() and p.stat().st_mode & 0o077:
                os.chmod(p, 0o600)
        except OSError:
            pass


def ensure_defaults(network_url: str = "") -> None:
    """Write every setting's value, defaults included, so nothing is missing
    from the folder just because it was never changed.

    Run at startup and whenever a network is chosen: the per-network files
    need to know which network. Caches (nodes-, outages-) are not settings
    and are left to their writers. Never fatal.
    """
    from . import client_identity, ddns, nodecache, notes, notifstate, plan, settingsfile
    from .prefs import Prefs
    # First: the older settings files are folded into settings.json before
    # anything reads it.
    steps = [settingsfile.migrate, client_identity.ensure, notes.ensure]
    key = nodecache.network_key(network_url) if network_url else ""

    def prefs() -> None:
        p = Prefs.load()
        if key:
            p.fill_network(key)
        p.save()
    steps.append(prefs)
    if key:
        steps += [lambda: notifstate.load(key), lambda: notifstate.alerts(key),
                  lambda: plan.ensure(network_url),
                  lambda: ddns.ensure(network_url)]
    for step in steps:
        try:
            step()
        except Exception:
            log.exception("could not write a default setting")
