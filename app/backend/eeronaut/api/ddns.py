"""Third-party dynamic DNS.

eero's own dynamic DNS is an eero Plus feature and only publishes under
`eero.online`. Pointing a name at this network anywhere else does not involve
eero at all — this app holds the credentials and does the updating — so it is
not gated, and the interface only marks the one option that is.

Credentials go in and never come back out. The configuration endpoint reports
which fields are set, not what they contain: a secret that can be read back
out of an interface is a secret sitting in every screenshot and browser cache
of that page.
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from ..clients.cloud import EeroCloud
from ..core import ddns as store
from ..core import ddns_update
from ..clients.ddns import BY_ID, PROVIDERS
from .deps import authed_cloud, current_network

Json = dict[str, Any]

router = APIRouter(prefix="/api/ddns", tags=["dynamic dns"])


@router.get("/providers")
async def providers(
        c: EeroCloud = Depends(authed_cloud)) -> list[Json]:
    """The providers on offer, and what each one needs.

    The form is built from this rather than from a copy in the interface, so a
    provider's fields cannot drift out of step with the client that sends them.
    """
    return [
        {
            "id": p.id, "name": p.name, "kind": p.kind, "note": p.note,
            "ipv6": p.ipv6,
            "fields": [
                {"name": f.name, "label": f.label, "secret": f.secret,
                 "placeholder": f.placeholder, "hint": f.hint,
                 "optional": f.optional}
                for f in p.fields
            ],
        }
        for p in PROVIDERS
    ]


def _view(cfg: store.Config, st: store.State, wan_ip: str) -> Json:
    prov = BY_ID.get(cfg.provider)
    secret = prov.secret_names if prov else set()
    return {
        "provider": cfg.provider,
        "enabled": cfg.enabled,
        # What is filled in, never what it says. A secret reports only that it
        # is present.
        "fields": {k: ("" if k in secret else v) for k, v in cfg.fields.items()},
        "secrets_set": sorted(k for k in secret if (cfg.fields.get(k) or "")),
        # The name being published, worked out by the provider's own rule --
        # DuckDNS implies a suffix and dynv6 names a zone, so the interface
        # should not be guessing at it. Empty for FreeDNS, which
        # never names the record it updates.
        "name": prov.fqdn(cfg.fields) if prov else "",
        "missing": ddns_update.missing_fields(cfg.provider, cfg.fields)
                   if cfg.provider else [],
        "status": {**asdict(st), "wan_ip": wan_ip},
    }


async def _wan_ip(c: EeroCloud, net: str) -> str:
    """The address to publish, from eero rather than an echo service.

    eero already reports what it believes the network's public address is, and
    that is the address worth publishing — no third-party dependency, and no
    disagreement between the two.
    """
    try:
        n = await c.follow(net)
        return str(n.get("wan_ip") or "")
    except Exception:
        return ""


@router.get("")
async def get_ddns(c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    prov = BY_ID.get(store.provider_of(net))
    cfg, st = store.load(net, prov.secret_names if prov else set())
    return _view(cfg, st, await _wan_ip(c, net))


class ConfigBody(BaseModel):
    provider: str = ""
    enabled: bool = False
    fields: dict[str, str] = {}


@router.put("")
async def put_ddns(body: ConfigBody, c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    if body.provider and body.provider not in BY_ID:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"no provider called {body.provider!r}")
    prov = BY_ID.get(body.provider)
    secret = prov.secret_names if prov else set()

    old_provider = store.provider_of(net)
    old_prov = BY_ID.get(old_provider)
    old_cfg, _ = store.load(net, old_prov.secret_names if old_prov else set())

    # A blank secret means "leave it alone", not "clear it" — the interface
    # cannot show what is there, so it cannot send it back either. Changing
    # provider drops the old secrets rather than carrying them across.
    # Only the fields this provider declares. A switch of provider replaces
    # the stored record whole, so nothing typed for the one before — a zone, a
    # hostname, a password, a token — survives it; keeping to the declared
    # fields means nothing else can ride along under the new one either.
    declared = {f.name for f in prov.fields} if prov else set()
    merged = {k: v for k, v in body.fields.items() if k in declared}
    if old_provider == body.provider:
        for k in secret:
            if not (merged.get(k) or "").strip() and (old_cfg.fields.get(k) or ""):
                merged[k] = old_cfg.fields[k]

    store.save_config(net, store.Config(provider=body.provider,
                                        enabled=body.enabled, fields=merged),
                      secret)
    # A changed configuration has to be republished even if the address has
    # not moved, so the next attempt is not skipped as unchanged.
    _, st = store.load(net, secret)
    if (old_provider != body.provider
            or merged != old_cfg.fields
            or st.result in ("auth", "notfound", "blocked")):
        st.last_published = ""
        st.result = "unconfigured" if not body.provider else "pending"
        st.detail = ""
        st.detail_key = ""
        st.detail_args = {}
        # The name being checked may itself have just changed, so any earlier
        # verdict is about a different record.
        st.resolve_state = ""
        st.resolved_ip = ""
        st.resolved_at = 0.0
        store.save_state(net, st)

    cfg, st = store.load(net, secret)
    return _view(cfg, st, await _wan_ip(c, net))


# What a provider says when the change itself is wrong, as opposed to the
# provider having a bad moment. Only these undo a change.
_REJECTIONS = ("auth", "notfound", "blocked")


@router.post("/apply")
async def apply_ddns(body: ConfigBody, c: EeroCloud = Depends(authed_cloud),
                     net: str = Depends(current_network)) -> Json:
    """Save a configuration and publish it at once, which is what Connect and
    Update now do.

    A change the provider rejects does not replace one that was working. It
    used to: a mistyped password was saved over the right one, the record of
    the name being published was cleared, and the panel said "Rejected" from
    then on, although the name went on pointing here. Nothing would have
    published the next address either, with the wrong password stored. So
    when the old configuration had published and the new one is rejected,
    the old one is put back, and the rejection is handed back once, in
    `rejected`, rather than stored as the state.

    Only a rejection undoes the change. A provider that is down or slow says
    nothing about whether the change was right, so that change stands and is
    tried again on the usual timer.
    """
    old_prov = BY_ID.get(store.provider_of(net))
    old_secret = old_prov.secret_names if old_prov else set()
    old_cfg, old_st = store.load(net, old_secret)
    working = bool(old_cfg.provider and old_cfg.enabled and old_st.last_published
                   and old_st.result in ("ok", "nochange"))

    await put_ddns(body, c, net)
    ip = await _wan_ip(c, net)
    st = await ddns_update.publish(net, ip, force=True)

    rejected: Json | None = None
    if working and st.result in _REJECTIONS:
        rejected = {"result": st.result, "detail": st.detail,
                    "detail_key": st.detail_key, "detail_args": st.detail_args}
        store.save_config(net, old_cfg, old_secret)
        store.save_state(net, old_st)

    prov = BY_ID.get(store.provider_of(net))
    cfg, st = store.load(net, prov.secret_names if prov else set())
    return {**_view(cfg, st, ip), "rejected": rejected}


@router.post("/update")
async def update_now(c: EeroCloud = Depends(authed_cloud),
                     net: str = Depends(current_network)) -> Json:
    """Publish now, because somebody pressed the button.

    `force` skips only the unchanged check. It is also the one path that will
    retry after a rejection the user has to fix — pressing the button is a
    person saying they have fixed it.
    """
    ip = await _wan_ip(c, net)
    await ddns_update.publish(net, ip, force=True)
    prov = BY_ID.get(store.provider_of(net))
    cfg, st = store.load(net, prov.secret_names if prov else set())
    return _view(cfg, st, ip)


@router.delete("")
async def forget_ddns(c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """Forget the configuration and its credentials.

    The record is deleted rather than blanked, so nothing is left encrypted on
    disk for a name that is no longer being updated.
    """
    store.clear(net)
    cfg, st = store.load(net, set())
    return _view(cfg, st, await _wan_ip(c, net))
