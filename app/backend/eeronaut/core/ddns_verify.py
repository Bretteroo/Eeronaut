"""Checking that the name actually points here.

A provider accepting an update is not the same thing as the name resolving, and
the two come apart in ways that matter. A No-IP hostname suspended for want of
a confirmation click keeps accepting updates and keeps replying `good` while it
has stopped resolving, and the update log says everything is fine.

So the name is looked up and compared against what was published, which is the
only check that answers the question somebody actually has: is this working?

Two rules keep this from crying wolf:

  * Nothing is checked until `_GRACE` has passed since the address was
    published. A name that has not propagated yet is not a fault, and reporting
    one during the first minute would be wrong far more often than right.

  * A lookup that fails to complete is recorded as "could not check", never as
    "not resolving". A local resolver outage is not the provider's fault, and
    saying it is would send somebody to fix the wrong thing.
"""
from __future__ import annotations

import asyncio
import socket
import time

from . import ddns
from ..clients.ddns import BY_ID

# Long enough for a dynamic DNS record to appear. These providers publish with
# short TTLs — a minute or two is typical — so ten minutes is generous rather
# than tight, and being generous is the right way to be wrong here.
_GRACE = 10 * 60

# A name that already checks out is not looked up on every sweep. Nothing about
# it is likely to have changed, and the watcher wakes far more often than a DNS
# record moves.
_RECHECK_OK = 30 * 60
_RECHECK_BAD = 5 * 60

_TIMEOUT = 5.0


async def lookup(name: str) -> tuple[str, list[str]]:
    """Resolve a name to its IPv4 addresses.

    Returns a state and the addresses found:
      ("found", [ips])   the name resolves
      ("missing", [])    the name does not exist, or has no address record
      ("unchecked", [])  the lookup itself did not complete

    The distinction between the last two is the whole point of the function. A
    resolver that is down looks nothing like a name that has been suspended, and
    conflating them would put the blame in the wrong place.
    """
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(name, None, family=socket.AF_INET,
                             type=socket.SOCK_STREAM),
            timeout=_TIMEOUT)
    except asyncio.TimeoutError:
        return "unchecked", []
    except socket.gaierror as e:
        # Only "no such name" and "no address of that family" mean the record is
        # absent. Anything else is this machine failing to ask.
        absent = {getattr(socket, n, None) for n in ("EAI_NONAME", "EAI_NODATA")}
        return ("missing" if e.errno in absent else "unchecked"), []
    except Exception:
        return "unchecked", []
    ips = sorted({str(i[4][0]) for i in infos})
    return ("found" if ips else "missing"), ips


def _due(st: ddns.State, now: float) -> bool:
    """Whether this network's name is worth looking up again yet."""
    if not st.last_published or not st.last_success:
        return False                      # nothing has been published to check
    if now - st.last_success < _GRACE:
        return False                      # give it time to appear
    if st.resolve_state == "unknowable":
        # FreeDNS. Nothing about this can change while the configuration is the
        # same, and the configuration changing clears the verdict anyway — so
        # asking again is a disk write every five minutes for no new fact.
        return False
    if not st.resolved_at:
        return True                       # never checked
    gap = _RECHECK_OK if st.resolve_state == "match" else _RECHECK_BAD
    return now - st.resolved_at >= gap


async def verify(net: str, *, force: bool = False) -> ddns.State:
    """Look up this network's name and record whether it points here."""
    prov_id = ddns.provider_of(net)
    prov = BY_ID.get(prov_id)
    cfg, st = ddns.load(net, prov.secret_names if prov else set())
    if not prov or not cfg.enabled:
        return st

    now = time.time()
    if not force and not _due(st, now):
        return st

    name = prov.fqdn(cfg.fields)
    if not name:
        # FreeDNS without its optional hostname: the update URL never names
        # the record. Recorded plainly so the interface can say the check is
        # not available here rather than implying the name is broken.
        return ddns.note_resolution(net, "unknowable", "", now)

    state, ips = await lookup(name)

    # A lookup is the one slow step here, and the interface's own Update now
    # button can publish a new address while it is in flight. Comparing against
    # the address read before the lookup would then record a verdict about an
    # address that is no longer the one published — reporting "points here" for
    # an address the name does not hold. The publish clears the verdict itself,
    # so the right thing is to drop this one.
    _, fresh = ddns.load(net)
    if fresh.last_published != st.last_published:
        return fresh

    if state == "found":
        hit = st.last_published in ips
        return ddns.note_resolution(net, "match" if hit else "mismatch",
                                    ips[0] if ips else "", now)
    return ddns.note_resolution(net, state, "", now)
