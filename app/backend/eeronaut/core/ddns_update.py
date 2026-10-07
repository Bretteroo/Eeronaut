"""Deciding whether to publish, and recording what happened.

Split from the provider clients because the decision is the interesting part.
The clients know how to talk to a provider; this knows when it is appropriate
to, which is the rule the providers actually care about:

  "Your update client should only send a request to our system when it detects
   an IP address change."  — noip.com/integrate/request

So an address equal to the last one published is not sent at all. That is also
why `record()` only advances `last_published` on an outcome that really placed
the address: a failure that moved it would suppress the retry that fixes it.

A rejection is not retried unprompted. `badauth`, `nohost`, and `abuse` are the
user's to fix, and a client that retries them on a timer is the one that gets
an account blocked — the same page says clients that "do not properly respond
to update return codes risk being blocked from our system".

A provider-side fault has its own rule, and it is not a suggestion. Dynu on the
`911` reply: it means "the update is temporarily halted due to scheduled
maintenance" and the client must "suspend update process for 10 minutes". The
watcher polls more often than that, so the wait is enforced here rather than
left to the poll interval — otherwise a maintenance window would have this
client hammering through it at three times the permitted rate.
"""
from __future__ import annotations

import httpx

import time

from . import ddns
from ..clients.ddns import BY_ID, Outcome, update

# Dynu, on 911: "suspend update process for 10 minutes". Applied to transport
# failures too — if the provider could not be reached, trying again on the next
# five-minute tick is unlikely to help and is indistinguishable, from the
# provider's side, from a client that will not take no for an answer.
_BACKOFF = 10 * 60


def _fields_for(provider_id: str) -> set[str]:
    prov = BY_ID.get(provider_id)
    return prov.secret_names if prov else set()


def missing_fields(provider_id: str, fields: dict[str, str]) -> list[str]:
    """Which of the provider's fields have been left empty.

    Reported rather than guessed around: an update sent with a blank token gets
    a rejection that looks like bad credentials, which sends somebody checking
    the wrong thing.
    """
    prov = BY_ID.get(provider_id)
    if not prov:
        return []
    return [f.name for f in prov.fields
            if not f.optional and not (fields.get(f.name) or "").strip()]


async def publish(net: str, ip: str, *, force: bool = False,
                  client: httpx.AsyncClient | None = None) -> ddns.State:
    """Publish one network's address, if there is anything to do.

    `force` is for the button in the interface, which is somebody asking
    directly — it skips the unchanged check and the stop-after-rejection rule,
    but nothing else.
    """
    cfg, st = ddns.load(net, _fields_for(ddns.provider_of(net)))
    if not cfg.provider or not cfg.enabled:
        return ddns.record(net, "unconfigured", "")

    gaps = missing_fields(cfg.provider, cfg.fields)
    if gaps:
        prov = BY_ID.get(cfg.provider)
        labels = {f.name: f.label for f in (prov.fields if prov else [])}
        names = ", ".join(labels.get(g, g) for g in gaps)
        return ddns.record(net, "notfound", f"Still needs: {names}.",
                           key="ddns_detail.needs",
                           args={"names": ",".join(gaps)})

    if not ip:
        return ddns.record(net, "transport", "This network has no public "
                                             "address to publish yet.",
                           key="ddns_detail.no_address")

    if not force and ip and ip == st.last_published:
        # Deliberately not a request. The providers ask for exactly this.
        # Recorded without `published`, which would stamp the time as a new
        # publish: every five-minute sweep did, so "Last published" read as a
        # few minutes ago forever, and the resolve check, which waits ten
        # minutes after a publish, never came due.
        return ddns.record(net, "nochange", "")

    # A rejection that the user has to fix is not retried on a timer. The
    # interface's own button passes force=True, which is a person asking.
    if not force and st.result in ("auth", "notfound", "blocked"):
        return st

    # A provider-side fault or an unreachable provider waits out the required
    # ten minutes. The button still overrides it: that is a person choosing to
    # try, once, rather than a client retrying in a loop.
    if (not force and st.result in ("provider", "transport")
            and st.last_attempt and time.time() - st.last_attempt < _BACKOFF):
        return st

    out: Outcome = await update(cfg.provider, cfg.fields, ip, client=client)
    return ddns.record(net, out.result, out.detail,
                       published=ip if out.ok else None)
