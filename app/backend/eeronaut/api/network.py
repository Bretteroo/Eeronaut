"""Network, node, client, and configuration endpoints."""
from __future__ import annotations

import ipaddress
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from ..clients.cloud import EeroCloud
from ..core import burst, photos, plan
from ..core.capabilities import (parse as parse_caps, is_premium,
                                 apply_subscription, entitled_capabilities,
                                 name_gateway)
from ..core import nodecache
from ..core.labels import (accessory_status, accessory_status_key,
                           band_label, node_status, node_status_key,
                           reboot_claim_is_stale)
from ..core.session import store
from .deps import authed_cloud, current_network
from .config import (accessory_issue, cellular_bars, attached_accessories,
                     signal_product, signal_variant)

router = APIRouter(prefix="/api", tags=["network"])
Json = dict[str, Any]


# ------------------------------------------------------------------- networks

@router.get("/networks")
async def list_networks(c: EeroCloud = Depends(authed_cloud)) -> list[Json]:
    """Every network on the account, each marked local or remote.

    "Local" means this machine shares a network segment with that network's
    eeros — the only place the local control plane works. It is decided by
    comparing each network's eero MACs against an mDNS sweep of the segment,
    so it reflects where this machine actually is rather than which network
    happens to be selected.
    """
    from .local import present_macs                 # avoids a circular import

    nets = await c.networks()
    seen = await present_macs()
    for n in nets:
        n["on_segment"] = None
        if seen is None:
            continue
        try:
            macs = {str(e.get("mac_address") or "").lower()
                    for e in await c.eeros(n["url"])}
        except Exception:
            continue                                # leave it undetermined
        macs.discard("")
        if macs:
            n["on_segment"] = bool(macs & seen)
    return nets


class SelectNetwork(BaseModel):
    url: str


@router.post("/networks/select")
async def select_network(body: SelectNetwork) -> dict[str, str]:
    from ..core import datadir
    store.update(network_url=body.url)
    datadir.ensure_defaults(body.url)      # this network's settings, written out
    return {"network_url": body.url}


@router.get("/network")
async def get_network(c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """The network, as much of it as anything here reads.

    This handed the browser eero's whole network object, which is far more
    than the two callers want and includes several things nothing in this app
    ever means to publish: the Wi-Fi password in clear, the Signal's IMEI,
    IMSI, EID, and ICCID — the same SIM identifiers `nodedetail` goes out of
    its way to strip — the account's payment method and next billing date,
    the owner, and the geo-IP block naming the ISP and its ASN. It is fetched
    on every page load, so all of that sat in the browser on every visit.

    A projection instead, and a short one. Widen it when a caller needs a
    field, rather than starting from everything eero sends and hoping.
    `url` is here because the interface uses it to tell one network from
    another; `capabilities` has an endpoint of its own.
    """
    n = await c.follow(net)
    return {
        "url": n.get("url"),
        "name": n.get("name"),
        "status": n.get("status"),
        "premium_status": n.get("premium_status"),
        # The connection panel's three: eero's own verdict, what kind of WAN
        # it is on, and whether it is behind a second NAT.
        "health": n.get("health"),
        "wan_type": n.get("wan_type"),
        "ip_settings": n.get("ip_settings"),
    }


@router.get("/network/settings")
async def network_settings(c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    # Surface the settings the UI actually edits, flattened for convenience.
    return {
        "name": n.get("name"),
        "public_ip": n.get("ip_settings", {}).get("public_ip"),
        "gateway_ip": n.get("gateway_ip"),
        "isp": n.get("isp"),
        "wan_type": n.get("wan_type"),
        "upnp": n.get("upnp"),
        "ipv6_upstream": n.get("ipv6_upstream"),
        "thread": n.get("thread"),
        "band_steering": n.get("band_steering"),
        "wpa3": n.get("wpa3"),
        "sqm": n.get("sqm"),
        "dns": n.get("dns"),
        "guest_network": n.get("guest_network"),
        "health": n.get("health"),
        "capabilities": n.get("capabilities"),
    }


async def _entitled(c: EeroCloud, net: str) -> set[str] | None:
    """The entitled feature set, or None when the feed cannot be read so the
    caller falls back to the coarser subscription flag."""
    try:
        return entitled_capabilities(await c.entitlements(net))
    except Exception:
        return None


async def _gateway_model(c: EeroCloud, net: str) -> str | None:
    """What the gateway is called on the box, for explanations that name it.

    Best-effort: an explanation that says "this network's gateway" instead of
    "an eero Pro 6E" is still an explanation, and is not worth failing the
    whole capability map for.
    """
    try:
        for e in await c.eeros(net) or []:
            if e.get("gateway"):
                return e.get("model") or None
    except Exception:                                        # noqa: BLE001
        pass
    return None


@router.get("/network/capabilities")
async def network_capabilities(c: EeroCloud = Depends(authed_cloud),
                               net: str = Depends(current_network)) -> Json:
    """Per-feature availability with the reason each unavailable one is gated.

    The UI grays features out using this, so the reason must be accurate: a
    hardware limitation must never be reported as a subscription limitation.
    Where eero says the gateway is the part that cannot, the gateway's own
    model is fetched so the sentence can name it — eero's requirement carries
    an internal codename, which is no use to the person reading it.
    """
    n = await c.follow(net)
    caps = apply_subscription(parse_caps(n.get("capabilities")), is_premium(n),
                              await _entitled(c, net))
    caps = name_gateway(caps, await _gateway_model(c, net))
    return {name: cap.as_dict() for name, cap in sorted(caps.items())}


@router.get("/network/entitlement")
async def network_entitlement(c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    caps = apply_subscription(parse_caps(n.get("capabilities")), is_premium(n),
                              await _entitled(c, net))
    return {
        "premium": is_premium(n),
        "premium_status": n.get("premium_status"),
        # Which tier, not just whether there is one. eero sells two: the
        # `tier` field on the account distinguishes them, and the app's own
        # enum lists premium, premium-plus, premium_plus_100 and no-tier.
        # It lives on the account rather than the network, because the
        # subscription is bought once and covers every network on it.
        **(await _tier(c)),
        "available": sum(1 for x in caps.values() if x.available),
        "total": len(caps),
    }


# What eero calls each tier, and what a person calls it. The raw values come
# from the Android app's own `Tier` enum; the plain names are the ones eero
# markets them under.
TIER_NAMES: dict[str, str] = {
    "premium": "eero Secure",
    "premium-plus": "eero Plus",
    "premium_plus_100": "eero Plus 100",
    "no-tier": "",
}


async def _tier(c: EeroCloud) -> Json:
    """The subscription tier and how it is billed, or empty when there is none.

    Fails soft: a missing or unreadable account leaves the interface saying a
    subscription is present without naming it, which is what it said before
    this existed. An unrecognized tier is passed through as eero sent it rather
    than being renamed to something wrong.
    """
    try:
        acct = await c.get("2.2/account")
    except Exception:
        return {}
    d = (acct or {}).get("premium_details") or {}
    raw = d.get("tier") or ""
    if not raw or raw == "no-tier":
        return {}
    return {
        "tier": raw,
        "tier_name": TIER_NAMES.get(raw) or raw,
        "tier_interval": d.get("interval"),
        "subscribed_since": d.get("subscribed_since"),
        "trial_ends": d.get("trial_ends"),
    }


# ---------------------------------------------------------------------- nodes

# Identifiers eero puts on a cellular accessory that the node list has no use
# for. The list is the view most likely to end up in a screenshot, so none of
# them appear in it.
#
# The IMEI is offered on the accessory's own detail, where somebody has gone
# looking for it — it is a fact about the modem, like the FCC and IC ids
# printed on the case. Its companions are not: the ICCID, IMSI, and EID
# identify the SIM and the person paying for it, and are served nowhere.
_ACCESSORY_SECRETS = ("imei", "imsi", "eid", "iccid", "msisdn", "phone_number")


def _accessory_cellular(a: Json) -> Json | None:
    """The operational half of a cellular accessory: how good the signal is,
    who is carrying it, and what state it is in.

    `signal_score` is eero's 0-4 rating, the same scale the phone app draws as
    a quarter-filled bar per step.
    """
    props = a.get("properties") or {}
    if props.get("type") != "cellular_backup":
        return None
    v = props.get("value")
    if not isinstance(v, dict):
        return None
    score = v.get("signal_score")
    carrier = (v.get("carrier") or "").strip()
    return {
        "bars": cellular_bars(score, a.get("configuration_status")),
        # eero says "unknown" when it has no SIM registration, which is not a
        # carrier name and should not be shown as one.
        "carrier": None if carrier.lower() in ("", "unknown") else carrier,
        "status": (v.get("status") or "").strip() or None,
    }


def _channel_mhz(band: str, channel: int | None) -> int | None:
    """The primary channel's center, in MHz.

    The local plane reports the center of the whole block; this is the center
    of the primary channel, which is the only thing the cloud says. They agree
    at 20 MHz and differ on a wider one, so the column that shows it says
    which it is looking at.
    """
    if not channel:
        return None
    if "2_4" in band or "2.4" in band:
        return 2407 + 5 * channel
    if "6" in band and "5" not in band.replace("6", ""):
        return 5950 + 5 * channel
    return 5000 + 5 * channel


@router.get("/eeros/radios")
async def eero_radios(c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> list[Json]:
    """Per-radio channel assignment and airtime, from eero's cloud.

    The same facts the local plane reports, for networks this machine is not
    sitting on — or for one where the eeros cannot be reached. It is not
    identical: the cloud has every node rather than the one being talked to,
    and it has no wired port state at all, so the page that falls back to this
    says where the figures came from.
    """
    eeros = await c.eeros(net)
    out: list[Json] = []
    for e in eeros:
        stats = e.get("radio_channel_stats") or {}
        radios = []
        for band, r in stats.items():
            if not isinstance(r, dict):
                continue
            radios.append({
                "band": band_label(band),
                "raw_band": band,
                "channel": r.get("channel"),
                "center_freq_mhz": _channel_mhz(band, r.get("channel")),
                "width": r.get("channel_width"),
                "busyness": r.get("channel_utilization"),
                "clients": r.get("client_count"),
                "tx_power": r.get("tx_power"),
            })
        if radios:
            out.append({"location": e.get("location") or e.get("serial"),
                        "serial": e.get("serial"),
                        "radios": sorted(radios, key=lambda x: str(x["raw_band"]))})
    return out


@router.get("/eeros")
async def list_eeros(c: EeroCloud = Depends(authed_cloud),
                     net: str = Depends(current_network)) -> list[Json]:
    eeros = await c.eeros(net)
    # Cache reachability data so the offline control page still works when the
    # WAN is down and this endpoint cannot be reached at all.
    try:
        n = await c.follow(net)
        # When the last firmware install began, and which nodes eero says did
        # not take it. Both live on the network rather than on any node, and
        # both are needed to judge a node's claimed uptime below.
        _updates = n.get("updates") or {}
        _last_user = _updates.get("last_user_update") or {}
        last_install = _updates.get("last_update_started")
        install_target = (_updates.get("update_to_firmware")
                          or _updates.get("target_firmware"))
        skipped = [*(_last_user.get("unresponsive_eeros") or []),
                   *(_last_user.get("incomplete_eeros") or [])]
        # An accessory's fault is reported on the network object, not on the
        # node's own copy, so merge it in — otherwise a Signal with no cellular
        # connection looks healthy everywhere the node list is drawn.
        faults = {a.get("dsn"): a.get("configuration_status")
                  for a in (n.get("accessories") or []) if a.get("dsn")}
        # The same object decides which accessories are still on the network
        # at all. The node's copy keeps one for some minutes after it is
        # removed in eero's app, and every pane that draws a Signal drew it.
        for e in eeros:
            e["accessories"] = attached_accessories(n, e)
            for a in e["accessories"]:
                if not a.get("configuration_status") and a.get("dsn") in faults:
                    a["configuration_status"] = faults[a["dsn"]]
        # eero states the fault as a configuration_status code. Turning it into
        # a label here rather than in each caller is what lets the dashboard and
        # the topology show the same caution mark the node detail already did.
        # The model number is the only thing that separates a 4G Signal from a
        # 5G one, and the node's own copy of the accessory does not carry it —
        # only the accessory's own record does. So it is fetched per accessory.
        # That is one extra call for each Signal on the network, of which there
        # is at most one per node and usually none at all; without it every
        # Signal was drawn as a bare "eero Signal", which is the product line
        # rather than the device. Best-effort: a name is worth a round trip, but
        # not the node list.
        for e in eeros:
            for a in (e.get("accessories") or []):
                if a.get("model_number") or not a.get("dsn"):
                    continue
                try:
                    full = await c.get(
                        f"{net.lstrip('/')}/accessories/{a['dsn']}")
                    a["model_number"] = (full or {}).get("model_number")
                except Exception:
                    pass
        for e in eeros:
            for a in (e.get("accessories") or []):
                a["issue"] = accessory_issue(a.get("configuration_status"))
                a["cellular"] = _accessory_cellular(a)
                a["variant"] = signal_variant(a.get("model_number"))
                a["product"] = signal_product(a.get("model_number"),
                                              a.get("model"))
                for k in _ACCESSORY_SECRETS:
                    ((a.get("properties") or {}).get("value") or {}).pop(k, None)
                a["status_key"] = accessory_status_key(a)
                a["status_label"] = accessory_status(a)
            # Both: the key is what the interface translates, the label is
            # what it falls back to for a state added after this release.
            e["status_key"] = node_status_key(e)
            e["status_label"] = node_status(e)
            # An uptime eero's own data contradicts is withheld rather than
            # printed. See reboot_claim_is_stale: a firmware install reboots
            # every eero, so one that began after the claimed reboot means the
            # node has rebooted since. The node keeps the figure eero can still
            # stand behind — how long it has been talking to the cloud — which
            # the interface already knows how to label as the lesser claim.
            if reboot_claim_is_stale(e.get("last_reboot"), last_install,
                                     e.get("url"), skipped,
                                     e.get("os_version"), install_target):
                e["last_reboot"] = None
                e["reboot_time_stale"] = True
                if isinstance(e.get("uptime"), dict):
                    e["uptime"]["since_last_reboot_s"] = None
        nodecache.save(str(n.get("name") or ""), eeros,
                       key=nodecache.network_key(net))
    except Exception:
        pass                      # caching is best-effort, never fatal
    return eeros


# -------------------------------------------------------------------- clients

def _v6_scope(address: str) -> str:
    """Which kind of IPv6 address this is, derived from the address itself.

    eero sends a `scope` field and it cannot be trusted. On a network with no
    IPv6 from the ISP it labels the locally generated fd3b::/64 prefix
    "global" — 37 addresses on one network here — while labeling four
    addresses from the same prefix "ula". fd00::/8 is a unique local address by
    RFC 4193 whatever eero calls it, and telling somebody an address is
    internet-routable when it is not is the kind of wrong that sends them
    debugging the wrong thing.

    The prefix is the definition, so the prefix is what is read.
    """
    a = (address or "").strip().lower()
    if not a:
        return "unknown"
    if a == "::1":
        return "loopback"
    # fe80::/10 — the first hextet runs fe80 to febf.
    if a.startswith(("fe8", "fe9", "fea", "feb")):
        return "link"
    # fc00::/7 — fc and fd.
    if a.startswith(("fc", "fd")):
        return "ula"
    if a.startswith("ff"):
        return "multicast"
    return "global"


@router.get("/devices")
async def list_devices(c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> list[Json]:
    rows = await c.devices(net)
    # The same correction the detail endpoint makes. eero's `ip` is whichever
    # address it last saw, so a client with no DHCP lease reports a link-local
    # IPv6 there, and every consumer of this list treats `ip` as the v4: the
    # client table renders it under an IPv4 heading, and the port-forward
    # picker would offer it as a forwarding target. The address is not lost —
    # it is already in `ipv6_addresses`.
    for d in rows:
        if isinstance(d, dict):
            d["ip"] = _ipv4(d)
    return rows


@router.get("/devices/blocked")
async def blocked_devices(c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> list[Json]:
    """The blocklist, exactly as eero keeps it.

    Entries normally carry their profile. Some do not — the two on the test
    network with `profile: null` were stale, first seen in 2020, and belonged
    to no profile whether blocked or not. An earlier reading of those two led
    to the wrong rule ("blocking removes a device from its profile"); a device
    blocked while assigned keeps its profile, and the interface shows it.
    A null is a device eero has no assignment for, not a consequence of
    blocking.
    """
    return await c.blocked_devices(net)


def _hex_mac(mac: str) -> str:
    """The bare hex form eero uses in device URLs (no separators)."""
    return "".join(ch for ch in mac if ch in "0123456789abcdefABCDEF").lower()


def _device_url(net: str, mac: str, write: bool = False) -> str:
    """Build the device URL the way eero stores it.

    Device URLs use the bare hex MAC with no separators
    (…/devices/001122334455). A client hands us whatever it has — often the
    colon form — so normalize to hex-only.

    Writes go to API 2.3, which is what the eero app uses for updateDevice.
    A write to the 2.2 path is accepted and does nothing, which is why pausing
    a client appeared to succeed and never took effect.
    """
    base = net.rstrip("/")
    if write:
        base = base.replace("/2.2/", "/2.3/", 1)
    return f"{base}/devices/{_hex_mac(mac) or mac}"


class DeviceUpdate(BaseModel):
    nickname: str | None = None
    device_type: str | None = None


@router.put("/devices/{mac}")
async def update_device(mac: str, body: DeviceUpdate,
                        c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    return await c.put(_device_url(net, mac, write=True),
                       json={"mac": _hex_mac(mac), **payload})


@router.put("/profiles/{profile_id}/devices/{mac}")
async def assign_device_to_profile(profile_id: str, mac: str,
                                   c: EeroCloud = Depends(authed_cloud),
                                   net: str = Depends(current_network)) -> Json:
    """Put a client under a profile, so its schedules and filters apply.

    eero models this as a device update carrying the profile's URL rather than
    as an edit to the profile, which is why it writes to the device endpoint.
    """
    await c.put(_device_url(net, mac, write=True),
                json={"mac": _hex_mac(mac),
                      "profile": {"url": f"{net.rstrip('/')}/profiles/{profile_id}"}})
    return {"mac": mac, "profile_id": profile_id}


async def _unassigned_profile(c: EeroCloud, net: str) -> str | None:
    """The URL of the network's catch-all profile.

    eero gives every network one profile named "Unassigned" that holds every
    client not placed in a real profile. It is a normal profile object, not a
    flag, so it has to be found by name.
    """
    profiles = await c.get(f"{net.rstrip('/')}/profiles")
    rows = profiles if isinstance(profiles, list) else (profiles or {}).get("data") or []
    for p in rows:
        if isinstance(p, dict) and (p.get("name") or "").strip().lower() == "unassigned":
            return p.get("url")
    return None


@router.delete("/profiles/{profile_id}/devices/{mac}")
async def remove_device_from_profile(profile_id: str, mac: str,
                                     c: EeroCloud = Depends(authed_cloud),
                                     net: str = Depends(current_network)) -> Json:
    """Take a client back out of a profile. The client keeps working; it is
    simply no longer covered by that profile's schedules or filters.

    There is no way to clear the field: a device update carrying a null profile
    is accepted with a 200 and ignored, whichever shape the null takes. What
    actually detaches a client is moving it to the "Unassigned" profile, which
    is where eero parks everything that has no profile of its own.
    """
    home = await _unassigned_profile(c, net)
    if not home:
        raise HTTPException(502, "This network has no Unassigned profile to "
                                 "move the client back to.")
    await c.put(_device_url(net, mac, write=True),
                json={"mac": _hex_mac(mac), "profile": {"url": home}})
    return {"mac": mac, "removed_from": profile_id}


def _ipv4(d: Json) -> str | None:
    """The client's IPv4 address, or None if it has not got one.

    eero's `ip` field is whichever address it last saw, so a client holding no
    DHCP lease reports a link-local IPv6 there. Rendering that under a heading
    marked IPv4 is simply wrong, and the address is already listed among the
    IPv6 ones.
    """
    v = d.get("ipv4") or d.get("ip")
    if not isinstance(v, str):
        return None
    parts = v.split(".")
    if len(parts) != 4:
        return None
    return v if all(p.isdigit() and len(p) <= 3 and int(p) < 256 for p in parts) else None


@router.get("/devices/{mac}/rate")
async def device_rate(mac: str, c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """What eero last published as one client's throughput, and whether it
    published anything at all.

    Rates only exist while something is asking for them, so this asks first —
    see `core.burst`. eero then computes them network-wide and publishes them
    with every device read, which means a single device's zero is ambiguous:
    it is "idle" only if something else on the network has a rate. If nothing
    anywhere does, eero has not published yet — the first reading arrives
    about thirteen seconds after the request — and the meter says so rather
    than drawing a flat line the client did not earn.

    Uncached deliberately: the read cache is five seconds, which is also the
    poll interval, so a cached answer would be the previous tick's.
    """
    await burst.keep_rates_flowing(c, net)
    devices = await c.get(f"{net}/devices", cache=False)
    rows = devices or []
    def rate(d: Json) -> tuple[float, float]:
        u = d.get("usage") or {}
        return float(u.get("down_mbps") or 0), float(u.get("up_mbps") or 0)
    want = mac.lower()
    mine = next((d for d in rows if str(d.get("mac") or "").lower() == want), None)
    down, up = rate(mine) if mine else (0.0, 0.0)
    reported = any(sum(rate(d)) > 0 for d in rows)
    return {"down_mbps": down, "up_mbps": up, "reported": reported,
            "connected": bool((mine or {}).get("connected"))}


@router.get("/devices/{mac}/detail")
async def device_detail(mac: str, c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    """Everything known about one client, flattened for a detail view."""
    d = await c.get(_device_url(net, mac))
    conn = d.get("connectivity") or {}
    src = d.get("source") or {}
    iface = d.get("interface") or {}
    # A device with a DHCP reservation always gets the same address. eero
    # carries these on the device object; the first one is the fixed lease.
    rez = d.get("reservations")
    rez_list = rez if isinstance(rez, list) else (rez or {}).get("data") or []
    reserved = rez_list[0] if rez_list else None
    return {
        "mac": d.get("mac"),
        # eero stores a *deny* flag; the phone app asks "Allow on backup". The
        # inversion happens here, once, rather than at each caller — a boolean
        # whose name is the opposite of its meaning is how you get a switch
        # that does the reverse of what it says. Absent means allowed, which is
        # eero's own default for a device that has never been configured.
        "allow_on_backup": not bool(d.get("secondary_wan_deny_access")),
        "reserved_ip": (reserved or {}).get("ip"),
        "reservation_url": (reserved or {}).get("url"),
        "has_reservation": bool(reserved),
        "name": d.get("nickname") or d.get("hostname") or d.get("display_name"),
        "nickname": d.get("nickname"),
        "hostname": d.get("hostname"),
        # eero reports identity two ways: values the client actually announced,
        # and values eero inferred from the MAC OUI and traffic fingerprinting.
        # Make and manufacturer are different things and eero reports both:
        # the make is the brand you would recognize ("Reolink"), while the
        # manufacturer is whoever registered the MAC prefix ("Guangzhou
        # Shiyuan Electronic Technology Company Limited"). Collapsing them
        # loses the useful one, so both are carried, as the eero app does.
        "make": d.get("inferred_make"),
        "manufacturer": d.get("manufacturer"),
        # The model row does still fall back: `model` is empty on almost every
        # client while `inferred_model` is populated on most, so ignoring the
        # inference there would throw away the majority of the useful data.
        "model": d.get("model_name") or d.get("model") or d.get("inferred_model"),
        "model_inferred": not (d.get("model_name") or d.get("model"))
                          and bool(d.get("inferred_model")),
        "device_type": d.get("device_type"),
        "ip": _ipv4(d),
        # Every address with the kind it is, rather than a flat list. A client
        # having several is normal in IPv6 and the reason differs per address:
        # the link-local is always there, a ULA is network-only, and a host
        # with privacy extensions keeps a rotating global alongside a stable
        # one. Without the kind, the drawer was listing three addresses and
        # explaining none of them.
        "ipv6": [
            {"address": addr, "scope": _v6_scope(addr)}
            for addr in (
                (a.get("address") if isinstance(a, dict) else a)
                for a in (d.get("ipv6_addresses") or [])
            )
            if addr
        ],
        "connected": d.get("connected"),
        "wireless": d.get("wireless"),
        "paused": d.get("paused"),
        "guest": d.get("is_guest"),
        "ssid": d.get("ssid"),
        "first_active": d.get("first_active"),
        "last_active": d.get("last_active"),
        "profile": (d.get("profile") or {}).get("name") if d.get("profile") else None,
        "connected_to": {
            "location": src.get("location"),
            "model": src.get("model"),
            "is_gateway": src.get("is_gateway"),
        },
        "radio": {
            "band": f"{iface.get('frequency')} {iface.get('frequency_unit')}"
                    if iface.get("frequency") else None,
            "frequency_mhz": conn.get("frequency"),
            "bssid": conn.get("bssid"),
            "signal_dbm": conn.get("signal"),
            "signal_avg": conn.get("signal_avg"),
            "snr_db": conn.get("snr"),
            "rx_bitrate": conn.get("rx_bitrate"),
            "tx_bitrate": conn.get("tx_bitrate"),
            # Retries climbing is a better congestion signal than raw RSSI.
            "tx_retry_pct": conn.get("tx_retry_pct"),
            "score_bars": conn.get("score_bars"),
        } if d.get("wireless") else None,
        "throughput": {
            "down_mbps": (d.get("usage") or {}).get("down_mbps"),
            "up_mbps": (d.get("usage") or {}).get("up_mbps"),
        },
    }


class BlockRequest(BaseModel):
    mac: str = Field(..., min_length=17, max_length=17,
                     pattern=r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


@router.post("/devices/block")
async def block_device(body: BlockRequest, c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Block a client from the network. It loses connectivity immediately.

    eero answers with the full blocked list rather than the single entry, so a
    plain confirmation is returned instead of passing that shape through.
    """
    await c.post(f"{net}/blacklist", data={"mac": body.mac})
    return {"blocked": body.mac}


@router.delete("/devices/block/{mac}")
async def unblock_device(mac: str, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    await c.delete(f"{net}/blacklist/{mac}")
    return {"unblocked": mac}


class DevicePause(BaseModel):
    paused: bool


class DeviceBackupAccess(BaseModel):
    allow: bool


@router.put("/devices/{mac}/backup-access")
async def set_device_backup_access(mac: str, body: DeviceBackupAccess,
                                   c: EeroCloud = Depends(authed_cloud),
                                   net: str = Depends(current_network)) -> Json:
    """Whether this client may use a backup connection during an outage.

    `PUT /2.3/networks/{id}/devices/{mac}` with `secondary_wan_deny_access` —
    version 2.3, not the 2.2 the rest of the device writes use, because the
    field does not exist on the older endpoint. Sent inverted, since eero's
    flag denies and the setting allows.
    """
    nid = net.rstrip("/").split("/")[-1]
    await c.put(f"2.3/networks/{nid}/devices/{_hex_mac(mac)}",
                json={"secondary_wan_deny_access": not body.allow})
    return {"allow_on_backup": body.allow}


@router.put("/devices/{mac}/pause")
async def pause_device(mac: str, body: DevicePause,
                       c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Pause or resume a single client's internet access."""
    # Send the mac in the body as well as the URL; eero's NetworkDeviceRequest
    # carries it, and a bare {"paused": …} was being accepted with no effect.
    await c.put(_device_url(net, mac, write=True),
                json={"mac": _hex_mac(mac), "paused": body.paused})
    return {"mac": mac, "paused": body.paused}


# ------------------------------------------------------------------- profiles

# The names eero uses for its filter switches, in the order a person would
# reasonably scan them rather than alphabetically.
CONTENT_FILTERS = [
    ("block_pornographic_content", "Adult content"),
    ("block_violent_content", "Violent content"),
    ("block_illegal_content", "Illegal content"),
    ("block_gaming_content", "Gaming"),
    ("block_social_content", "Social media"),
    ("block_streaming_content", "Streaming"),
    ("block_shopping_content", "Shopping"),
    ("block_messaging_content", "Messaging"),
    ("safe_search_enabled", "Safe search"),
    ("youtube_restricted", "YouTube restricted mode"),
]


def _summarise_profile(p: Json) -> Json:
    """Flatten a profile into what the interface actually shows."""
    devices = p.get("devices") or []
    filters = ((p.get("unified_content_filters") or {}).get("dns_policies") or {})
    premium = p.get("premium_dns") or {}
    state = p.get("state") or {}
    return {
        "url": p.get("url"),
        "name": p.get("name"),
        "paused": bool(p.get("paused")),
        "state": state.get("value"),
        # A profile paused by a schedule is not the same as one a person
        # paused, and the interface should not present them identically.
        "paused_by_schedule": bool(state.get("schedule")),
        "default": bool(p.get("default")),
        # eero's catch-all bucket. A client sits here when it belongs to no
        # profile, so there is nothing to remove it from and nothing to delete.
        "unassigned": (p.get("name") or "").strip().lower() == "unassigned",
        "device_count": len(devices),
        "devices_online": sum(1 for d in devices if d.get("connected")),
        "devices": [{"url": d.get("url"), "mac": d.get("mac"),
                     "name": d.get("nickname") or d.get("hostname")
                             or d.get("display_name") or "Unknown device",
                     "connected": bool(d.get("connected"))}
                    for d in devices],
        "filters": [{"key": k, "label": label, "on": bool(filters.get(k))}
                    for k, label in CONTENT_FILTERS],
        "filters_configured": bool((p.get("unified_content_filters") or {})
                                   .get("is_content_filters_set")),
        "ad_block": bool((premium.get("ad_block_settings") or {}).get("enabled")),
        # Whether the network-wide switch is what turned it on. eero tracks the
        # two separately, and a profile switch that silently disagrees with the
        # network one is worse than saying which is in force.
        "ad_block_network": bool((premium.get("ad_block_settings") or {})
                                 .get("enabled_for_network")),
        # This profile's own blocked and allowed sites. eero keeps a list per
        # profile as well as the network-wide one; only the network-wide half
        # was surfaced, so a per-profile rule was invisible here.
        "sites": {
            "blocked": [d for d in ((premium.get("advanced_content_filters") or {})
                                    .get("blocked_list") or []) if isinstance(d, str)],
            "allowed": [d for d in ((premium.get("advanced_content_filters") or {})
                                    .get("allowed_list") or []) if isinstance(d, str)],
        },
        "blocked_applications": premium.get("blocked_applications") or [],
        "schedules": [{"url": s.get("url"), "name": s.get("name"),
                       "enabled": bool(s.get("enabled")),
                       "days": s.get("days"), "start": s.get("start"),
                       "end": s.get("end")}
                      for s in (p.get("schedule") or [])],
    }


class PlanSpeeds(BaseModel):
    """What the provider sells, in Mbps. Null clears a figure."""
    down_mbps: float | None = Field(None, gt=0, le=plan.MAX_MBPS)
    up_mbps: float | None = Field(None, gt=0, le=plan.MAX_MBPS)


@router.get("/network/plan")
async def plan_speeds(c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """The speeds the household pays for. Kept here; eero has no field."""
    return plan.get(net)


@router.put("/network/plan")
async def set_plan_speeds(body: PlanSpeeds, c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    return plan.set_plan(net, body.down_mbps, body.up_mbps)


def _with_photo(summary: Json, net: str) -> Json:
    """Whether a photo is stored here for this profile, and a version the
    browser can key its cache on. Local state, so it is added after the eero
    summary rather than inside it."""
    pid = (summary.get("url") or "").rstrip("/").split("/")[-1]
    path = photos.find(net, pid) if pid.isdigit() else None
    summary["has_photo"] = path is not None
    summary["photo_version"] = photos.version(path) if path else None
    return summary


@router.get("/profiles")
async def list_profiles(c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> list[Json]:
    return [_with_photo(_summarise_profile(p), net)
            for p in (await c.profiles(net) or [])]


def _photo_id(profile_id: str) -> str:
    # Numeric or nothing: the id becomes part of a filename.
    if not profile_id.isdigit():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such profile")
    return profile_id


@router.get("/profiles/{profile_id}/photo")
async def profile_photo(profile_id: str, c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> FileResponse:
    """The photo on a profile card. Stored on this machine only; eero never
    sees it. `no-cache` so a replaced photo shows without a hard reload — the
    browser revalidates and gets a 304 while it is unchanged."""
    path = photos.find(net, _photo_id(profile_id))
    if path is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no photo for this profile")
    return FileResponse(path, media_type=photos.media_type(path),
                        headers={"Cache-Control": "private, no-cache"})


@router.put("/profiles/{profile_id}/photo")
async def put_profile_photo(profile_id: str, request: Request,
                            c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Store a photo: the raw image as the body, JPEG, PNG, or WebP, decided
    from its bytes. The interface crops and shrinks before sending, so a real
    upload is tens of kilobytes; the cap is for anything else reaching this."""
    pid = _photo_id(profile_id)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > photos.MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            "image too large; 1 MB at most")
    data = await request.body()
    if len(data) > photos.MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            "image too large; 1 MB at most")
    if photos.sniff(data) is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            "not a JPEG, PNG, or WebP image")
    path = photos.save(net, pid, data)
    return {"has_photo": True, "photo_version": photos.version(path)}


@router.delete("/profiles/{profile_id}/photo")
async def delete_profile_photo(profile_id: str, c: EeroCloud = Depends(authed_cloud),
                               net: str = Depends(current_network)) -> Json:
    photos.remove(net, _photo_id(profile_id))
    return {"has_photo": False, "photo_version": None}


class ProfileCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    device_urls: list[str] = Field(default_factory=list)
    paused: bool = False


@router.post("/profiles")
async def create_profile(body: ProfileCreate, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    return await c.post(f"{net}/profiles",
                        json={"name": body.name, "paused": body.paused,
                              "devices": body.device_urls})


class ProfileUpdate(BaseModel):
    name: str | None = None
    paused: bool | None = None
    device_urls: list[str] | None = None


@router.put("/profiles")
async def update_profile(url: str, body: ProfileUpdate,
                         c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Update a profile. `url` is the profile's own url, as eero returns it."""
    payload: Json = {}
    if body.name is not None:
        # eero creates "Unassigned" itself and parks every client with no
        # profile there. Renaming it would leave the catch-all under a name
        # nothing else refers to, so it is refused here as well as in the
        # interface — this endpoint is reachable without going through it.
        current = await c.request("GET", url)
        if (current or {}).get("name", "").strip().lower() == "unassigned":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "The Unassigned profile is created by eero and cannot be renamed.")
        payload["name"] = body.name
    if body.paused is not None:
        payload["paused"] = body.paused
    if body.device_urls is not None:
        payload["devices"] = body.device_urls
    return await c.request("PUT", url, json=payload)


@router.delete("/profiles")
async def delete_profile(url: str, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    result = await c.request("DELETE", url)
    # The face goes with the profile. Only once eero has agreed to the
    # deletion, so a refused one keeps its photo.
    pid = url.rstrip("/").split("/")[-1]
    if pid.isdigit():
        photos.remove(net, pid)
    return result


class ScheduleCreate(BaseModel):
    """A recurring pause window for a profile.

    eero wants capitalized full day names here — "Monday", not "monday" and
    not the "MON" its own Android enum uses internally. Anything else is
    refused with `error.form.enum.invalid`, and `name` is required rather than
    optional. Both were established from the API's own field-level errors.

    Note this is not the same shape as the power-saving schedule on
    `/network/power-saving/schedules`, which takes capitalized days — the
    opposite of this one, and the reason schedules there were being refused.
    """
    name: str = Field("Scheduled pause", min_length=1, max_length=64)
    days: list[str] = Field(..., min_length=1)
    start: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    end: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    enabled: bool = True

    @field_validator("days")
    @classmethod
    def _days(cls, v: list[str]) -> list[str]:
        allowed = {"monday", "tuesday", "wednesday", "thursday",
                   "friday", "saturday", "sunday"}
        bad = [d for d in v if d.strip().lower() not in allowed]
        if bad:
            raise ValueError(f"not day names: {bad}")
        return [d.strip().capitalize() for d in v]


@router.post("/profiles/schedules")
async def create_schedule(url: str, body: ScheduleCreate,
                          c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Add a scheduled pause. `url` is the profile's own url."""
    return await c.request("POST", f"{url}/schedules", json=body.model_dump())


@router.put("/profiles/schedules")
async def update_schedule(url: str, body: ScheduleCreate,
                          c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Change a scheduled pause. `url` is the schedule's own url."""
    return await c.request("PUT", url, json=body.model_dump())


@router.delete("/profiles/schedules")
async def delete_schedule(url: str, c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Remove a scheduled pause. `url` is the schedule's own url."""
    await c.request("DELETE", url)
    return {"deleted": url}


# ----------------------------------------------------- forwards, reservations

@router.get("/forwards")
async def list_forwards(c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> list[Json]:
    return await c.forwards(net)


class Forward(BaseModel):
    ip: str
    gateway_port: str
    client_port: str
    protocol: str = "tcp"          # tcp | udp | both
    # Required, and enforced here rather than only in the form: a hole in the
    # firewall with nothing said about it is one nobody can audit later, and
    # a rule only the interface applies is not a rule. Whitespace does not
    # count as an answer.
    description: str = Field(..., min_length=1, max_length=200)
    enabled: bool = True

    @field_validator("description")
    @classmethod
    def _said_something(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("a description is required")
        return v.strip()


@router.post("/forwards")
async def create_forward(body: Forward, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    return await c.post(await c.resource(net, "forwards"),
                        json=body.model_dump())


@router.put("/forwards")
async def update_forward(url: str, body: Forward,
                         c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Change an existing port forward.

    eero replaces the whole object, so every field is sent. `url` is the
    forward's own link, which is how delete identifies it too.
    """
    return await c.put(url.lstrip("/"), json=body.model_dump())


@router.delete("/forwards")
async def delete_forward(url: str, c: EeroCloud = Depends(authed_cloud)) -> Json:
    return await c.request("DELETE", url)


@router.get("/reservations")
async def list_reservations(c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> list[Json]:
    return await c.reservations(net)


class Reservation(BaseModel):
    """A reserved address, validated the way eero's own app validates it.

    Format only, deliberately. The Android app checks the address against
    `Patterns.IP_ADDRESS` and the MAC against a dotted-quad-style pattern
    (`ValidationUtils.isValidIP4` / `isValidMACAddress`, reached through
    `Validators.IP4_ADDRESS`), and does not check the subnet at all — an
    address outside it is refused by eero, which returns
    `error.reservation.ip.invalid` for exactly that. Adding a subnet check here
    would be inventing a rule eero already owns, and getting it wrong on a
    network with more than one subnet.

    What the app does *not* do, and neither did this, is check anything at all
    before sending. An unparseable address reached eero and came back as a
    generic failure.
    """

    mac: str
    ip: str
    description: str = ""

    @field_validator("ip")
    @classmethod
    def _ip(cls, v: str) -> str:
        v = (v or "").strip()
        try:
            addr = ipaddress.ip_address(v)
        except ValueError:
            raise ValueError("that is not a valid IP address") from None
        if addr.version != 4:
            raise ValueError("a reservation needs an IPv4 address")
        return v

    @field_validator("mac")
    @classmethod
    def _mac(cls, v: str) -> str:
        v = (v or "").strip()
        if not re.fullmatch(r"(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}", v):
            raise ValueError("that is not a valid MAC address. It should look "
                             "like 02:00:00:00:00:01")
        return v


@router.post("/reservations")
async def create_reservation(body: Reservation, c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    return await c.post(f"{net}/reservations", json=body.model_dump())


@router.put("/reservations")
async def update_reservation(url: str, body: Reservation,
                             c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Change an existing reservation.

    eero replaces the whole object, so the MAC has to be sent even when only
    the address is changing. `url` is the reservation's own link, the same
    identifier delete uses — reservations have no id of their own.
    """
    return await c.put(url.lstrip("/"),
                       json={"mac": body.mac, "ip": body.ip,
                             "description": body.description})


@router.delete("/reservations")
async def delete_reservation(url: str, c: EeroCloud = Depends(authed_cloud)) -> Json:
    return await c.request("DELETE", url)


# --------------------------------------------------------------- diagnostics

@router.get("/speedtests")
async def speed_tests(c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> list[Json]:
    return await c.speed_tests(net)
