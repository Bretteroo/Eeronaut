"""Network configuration: Wi-Fi, guest network, LAN, DHCP, DNS, and updates."""
from __future__ import annotations

from typing import Any

import datetime as dt
import ipaddress

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from ..clients.cloud import EeroCloud
from ..core.errors import UpstreamError
from ..core.labels import (ACCESSORY_CONFIGURING, ACCESSORY_UPDATING,
                          band_label)
from .deps import authed_cloud, current_network

router = APIRouter(prefix="/api/network", tags=["configuration"])
Json = dict[str, Any]


# Every client has to re-authenticate when these change, so each write is its
# own endpoint with its own validation rather than one permissive object PUT.
# An accidental extra field in a bulk update would be a network-wide outage.

SSID_MAX = 32          # 802.11 caps the SSID at 32 octets
WPA_MIN, WPA_MAX = 8, 63


class NetworkName(BaseModel):
    name: str = Field(..., min_length=1, max_length=SSID_MAX)


class NetworkPassword(BaseModel):
    password: str = Field(..., min_length=WPA_MIN, max_length=WPA_MAX)


class Toggle(BaseModel):
    enabled: bool


# Security mode per radio. Not a boolean: eero models this as a mode, and
# "WPA2 and WPA3 together" is a distinct, and usually the correct, setting.
WPA3_MODES = ("wpa2", "wpa2_wpa3", "wpa3")


class Wpa3Bands(BaseModel):
    band_2_4_ghz: str = Field(..., pattern="^(wpa2|wpa2_wpa3|wpa3)$")
    band_5_ghz: str = Field(..., pattern="^(wpa2|wpa2_wpa3|wpa3)$")


class MloMode(BaseModel):
    mlo_mode: str = Field(..., pattern="^(disabled|single|multi)$")


@router.get("/wifi")
async def get_wifi(c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    return {
        "name": n.get("name"),
        # The password is returned by eero but deliberately not surfaced here.
        # The UI shows a reveal control that calls /wifi/password explicitly, so
        # a shoulder-surfer does not get it just by loading the page.
        "has_password": bool(n.get("password")),
        "wpa3": n.get("wpa3"),
        "band_steering": n.get("band_steering"),
        "sqm": n.get("sqm"),
        "mlo_mode": n.get("mlo_mode"),
        "thread": n.get("thread"),
    }


@router.get("/wifi/password")
async def get_wifi_password(c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    return {"password": n.get("password")}


def _name_of(d: dict[str, Any]) -> str:
    return (d.get("nickname") or d.get("hostname") or d.get("display_name")
            or "Unknown device")


@router.get("/wifi/impact")
async def wifi_change_impact(c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    """What a Wi-Fi change would actually cost, before making one.

    Renaming the network or changing its password drops every wireless client
    until it is rejoined with the new details. Wired clients are unaffected.
    Knowing the number beforehand is the difference between an informed change
    and a surprise.

    The guest network is counted separately, and its own state comes back with
    it. Changing the guest password costs the guests and nobody else — and
    with the guest network switched off it costs nothing at all, which is not
    something a count of the main network's clients could ever say.
    """
    devices = await c.get(f"{net}/devices")
    live = [d for d in (devices or []) if d.get("connected")]
    guests = [d for d in live if d.get("guest")]
    mine = [d for d in live if not d.get("guest")]
    wireless = [d for d in mine if d.get("wireless")]
    wired = [d for d in mine if not d.get("wireless")]
    # Best effort: the counts above are the answer for the main network, and a
    # network document that will not load is no reason to withhold them.
    try:
        n = await c.follow(net)
    except Exception:                                        # noqa: BLE001
        n = {}
    return {
        "wireless_clients": len(wireless),
        "wired_clients": len(wired),
        "notable": sorted(_name_of(d) for d in wireless)[:8],
        "guest": {
            "enabled": bool((n.get("guest_network") or {}).get("enabled")),
            "wireless_clients": len(guests),
            "notable": sorted(_name_of(d) for d in guests)[:8],
        },
    }


@router.put("/wifi/name")
async def put_wifi_name(body: NetworkName, c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    """Rename the network. Every wireless client drops until it rejoins."""
    await c.put(net, data={"name": body.name})
    return {"name": body.name}


@router.put("/wifi/password")
async def put_wifi_password(body: NetworkPassword,
                            c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Change the Wi-Fi password. Every wireless client must re-authenticate.

    The password has its own resource URL; the network root is not it. Writing
    to the root is accepted and changes nothing, so the old password kept
    working and the new one never did.
    """
    n = await c.follow(net)
    url = ((n.get("resources") or {}).get("password")
           or f"{net.rstrip('/')}/password")
    await c.put(url.lstrip("/"), data={"password": body.password})
    return {"changed": True}


@router.put("/wifi/sqm")
async def put_sqm(body: Toggle, c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    """Smart Queue Management. Takes effect without dropping clients."""
    await c.put(net, params={"sqm": str(body.enabled).lower()})
    return {"sqm": body.enabled}


@router.get("/wifi/wpa3")
async def get_wpa3(c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    """Security mode per radio.

    6 GHz is reported but not settable: the specification requires WPA3 there,
    so eero's own request object carries only the 2.4 and 5 GHz bands.
    """
    nid = net.rstrip("/").split("/")[-1]
    d = await c.get(f"2.2/networks/{nid}/wpa3_per_band")
    return {
        "band_2_4_ghz": (d or {}).get("band_2_4_ghz"),
        "band_5_ghz": (d or {}).get("band_5_ghz"),
        "band_6_ghz": (d or {}).get("band_6_ghz"),
        "settable": ["band_2_4_ghz", "band_5_ghz"],
        "modes": list(WPA3_MODES),
    }


@router.put("/wifi/wpa3")
async def put_wpa3(body: Wpa3Bands, c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    """Set the security mode for the 2.4 and 5 GHz radios.

    Clients reconnect when this changes. Choosing `wpa3` alone excludes any
    device that cannot do WPA3, which is most things more than a few years old;
    `wpa2_wpa3` accepts both and is the safe choice.
    """
    nid = net.rstrip("/").split("/")[-1]
    await c.put(f"2.2/networks/{nid}/wpa3_per_band", json=body.model_dump())
    return body.model_dump()


@router.put("/wifi/mlo")
async def put_mlo(body: MloMode, c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    """Multi-Link Operation. Wi-Fi 7 hardware only."""
    nid = net.rstrip("/").split("/")[-1]
    await c.put(f"2.2/networks/{nid}/mlo_mode", json=body.model_dump())
    return body.model_dump()


class GuestSettings(BaseModel):
    enabled: bool
    name: str | None = Field(None, min_length=1, max_length=SSID_MAX)


class GuestPassword(BaseModel):
    password: str = Field(..., min_length=WPA_MIN, max_length=WPA_MAX)


@router.get("/guest")
async def get_guest(c: EeroCloud = Depends(authed_cloud),
                    net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    g = n.get("guest_network") or {}
    return {"enabled": g.get("enabled"), "name": g.get("name"),
            "has_password": bool(g.get("password")), "url": g.get("url")}


@router.put("/guest")
async def put_guest(body: GuestSettings, c: EeroCloud = Depends(authed_cloud),
                    net: str = Depends(current_network)) -> Json:
    """Enable, disable, or rename the guest network.

    Not just the guests. This said "clients on the main network stay
    connected", which was an assumption nobody had checked and is wrong:
    toggling the guest network interrupts the whole network's connection for
    fifteen to twenty-one seconds while the eeros apply it, though nothing
    restarts. The control in the interface says so before it is pressed; the
    measurement is beside it, in the Network page's `confirmGuest`.
    """
    n = await c.follow(net)
    guest = n.get("guest_network") or {}
    url = guest.get("url") or f"{net}/guestnetwork"
    await c.put(url, data={"name": body.name or guest.get("name") or "",
                           "enabled": str(body.enabled).lower()})
    return {"enabled": body.enabled}


@router.get("/guest/password")
async def get_guest_password(c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    """The guest password, on request only.

    Same shape as `/wifi/password` and for the same reason: the guest object
    carries the password, but `/guest` reports only whether one is set, so
    loading the page does not hand it to whoever is looking over your shoulder.
    """
    n = await c.follow(net)
    return {"password": (n.get("guest_network") or {}).get("password")}


@router.put("/guest/password")
async def put_guest_password(body: GuestPassword,
                             c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    url = (n.get("guest_network") or {}).get("url") or f"{net}/guestnetwork"
    await c.put(url, data={"password": body.password})
    return {"changed": True}


@router.get("/lan")
async def get_lan(c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    geo = n.get("geo_ip") if isinstance(n.get("geo_ip"), dict) else {}
    # Devices are read only to corroborate the subnet in automatic mode, where
    # eero states no mask. A failure to read them is not a failure to describe
    # the LAN: the subnet then comes back uncorroborated, which the interface
    # treats as "do not constrain".
    try:
        _devices = await c.get(f"{net.rstrip('/')}/devices") or []
    except Exception:
        _devices = []
    _subnet = lan_subnet(n, _devices)
    lease = n.get("lease") or {}
    conn = n.get("connection") or {}
    lease = n.get("lease") or {}
    dhcp = n.get("dhcp") or {}
    dns = n.get("dns") or {}
    ipv6 = n.get("ipv6") or {}
    v6ns = ipv6.get("name_servers") or {}
    # The app presents the LAN as one of three modes. Bridge is connection
    # mode "bridge"; otherwise it is NAT, and within NAT the DHCP mode is
    # either automatic or a custom lease range (what the app calls Manual IP).
    mode = ("bridge" if conn.get("mode") == "bridge"
            else "manual" if dhcp.get("mode") in ("custom", "custom_v2")
            else "automatic")
    return {
        "gateway_ip": n.get("gateway_ip"),
        "wan_type": n.get("wan_type"),
        "mode": mode,
        "dhcp_custom": dhcp.get("custom") or dhcp.get("custom_v2"),
        "dns_mode": dns.get("mode") or "automatic",
        "dns_v4": (dns.get("custom") or {}).get("ips") or [],
        "dns_v6_mode": v6ns.get("mode") or "automatic",
        "dns_v6": v6ns.get("custom") or [],
        "wan_ip": n.get("wan_ip") or n.get("public_ip"),
        # Shown on the app's Internet screen: who the connection is with, and
        # where the public address geolocates to.
        "isp": n.get("isp"),
        # DHCP, static, or PPPoE. eero reports it as `wan_type`; the lease's
        # own mode is the fallback because wan_type is occasionally absent.
        "wan_mode": _wan_mode(n),
        "static_lease": lease.get("static") or None,
        "pppoe_username": n.get("pppoe_username"),
        # `isp` is the provider the WAN address is registered to, from the same
        # lookup as the city. Not `organization`: that is eero's partner field,
        # "provided by" branding for an ISP-bundled eero, and on a retail
        # network it names a program rather than a carrier.
        "geo": {"city": geo.get("city"), "region": geo.get("region"),
                "country": geo.get("countryName") or geo.get("countryCode"),
                "isp": geo.get("isp") or geo.get("org")}
               if geo else None,
        "lease_mode": lease.get("mode"),
        "double_nat": (n.get("ip_settings") or {}).get("double_nat"),
        "dhcp": n.get("dhcp"),
        "dns": n.get("dns"),
        "ipv6_upstream": n.get("ipv6_upstream"),
        "ipv6": n.get("ipv6"),
        "upnp": n.get("upnp"),
        "thread": n.get("thread"),
        "nat_port_randomization": n.get("nat_port_randomization"),
        # eero stores the uplink VLAN tag as a bare string on the network
        # object, empty when unset. The Android app writes it the same way.
        "vlan": n.get("vlan") or "",
        "vlan_capable": bool(((n.get("capabilities") or {})
                              .get("vlan") or {}).get("capable")),
        # The LAN subnet, so the reservation form can offer only addresses that
        # are in it rather than accepting anything and having eero refuse.
        "lan_subnet": _subnet,
        # Local DNS caching: the eeros answer repeat lookups themselves instead
        # of going out for every one. eero gates it on firmware and connection
        # mode, so a network that cannot do it should not be offered it.
        "dns_caching": bool((n.get("dns") or {}).get("caching")),
        "dns_caching_capable": bool(((n.get("capabilities") or {})
                                     .get("dns_caching") or {}).get("capable")),
        # Whether to offer the control at all, by eero's own three conditions —
        # `NetworkExtensionsKt.isLocalDnsCachingVisible`. Capability alone is
        # not enough: caching makes the gateway the resolver every device is
        # handed, which cannot work in bridge mode and cannot coexist with
        # eero Plus filtering, since the filtering happens at eero's resolver
        # and a local cache would answer instead of it.
        "dns_caching_visible": _dns_caching_visible(n),
        # Whether eero will let the resolver be changed at all. Its own app
        # locks the whole DNS screen behind this one server-computed boolean
        # and tells you to turn off every Plus feature, which is not a figure
        # of speech: SafeSearch on a single profile sets it, and SafeSearch is
        # a per-profile policy that never appears in the network's own
        # `dns_policies`. One filter on one profile locks DNS for everybody.
        #
        # From `DnsViewModel`: `!(hasPremiumPlan && dns_policies_enabled)`.
        "dns_editable": _dns_editable(n),
        "ddns": n.get("ddns"),
        "sqm": n.get("sqm"),
        # The IPv6 resolvers the provider advertises, which is a different
        # field from every other DNS one here: `dns.parent.ips` carries only
        # the IPv4 pair, and `ipv6.name_servers` is the custom setting rather
        # than what the provider hands down. eero's own app reads exactly this
        # for the two IPv6 rows under ISP DNS — `LegacyDnsViewModel`'s
        # `defaultDnsIpv6`, from `ipv6Lease.getNameServers()`.
        "ipv6_lease": n.get("ipv6_lease"),
        # Its condition for showing those rows at all. A network whose
        # hardware or connection mode cannot do IPv6 is not told what its
        # provider would have offered.
        "ipv6_capable": bool(((n.get("capabilities") or {})
                              .get("ipv6") or {}).get("capable")),
    }


# eero's Automatic DHCP & NAT mode uses this LAN subnet by default. Recorded
# here because eero does not report the LAN mask in automatic mode at all —
# `dhcp.custom` is null and nothing else on the network object carries it.
#
# `lease.dhcp.mask` looks like the answer and is not: that is the *WAN*
# lease, whose mask belongs to the ISP. Building the reservation form around
# it would have constrained every address to the provider's subnet.
#
# The default is corroborated rather than trusted. A network whose devices
# span more addresses than a /24 holds cannot be on one, and the wider mask
# must be right — but that check is done per network in `lan_subnet()`
# below, because a guess that silently refuses a valid address is worse than
# no constraint at all.
AUTOMATIC_DEFAULT = "192.168.4.0/22"


def lan_subnet(n: Json, devices: list[Json] | None = None) -> Json | None:
    """The LAN subnet, and how confident we are about it.

    Two sources. In manual DHCP mode eero states the subnet outright and there
    is nothing to infer. In automatic mode it states nothing, so the documented
    default is used — and then checked against the gateway and every device
    address actually on the network. If any of them falls outside it, the
    default is wrong for this network and `certain` says so, which is the
    interface's cue to stop constraining input and let eero judge.
    """
    dhcp = n.get("dhcp") or {}
    custom = dhcp.get("custom") or dhcp.get("custom_v2")
    if custom and custom.get("subnet_ip") and custom.get("subnet_mask"):
        try:
            net = ipaddress.ip_network(
                f"{custom['subnet_ip']}/{custom['subnet_mask']}", strict=False)
        except ValueError:
            return None
        return {"cidr": str(net), "mask": str(net.netmask),
                "source": "dhcp", "certain": True}

    gw = n.get("gateway_ip")
    if not gw:
        return None
    try:
        net = ipaddress.ip_network(AUTOMATIC_DEFAULT)
        inside = ipaddress.ip_address(gw) in net
    except ValueError:
        return None

    # Every IPv4 address eero says is on this network has to fit, or the
    # default does not describe it.
    for d in devices or []:
        raw = d.get("ip")
        if not raw:
            continue
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if addr.version == 4 and addr not in net:
            inside = False
            break

    return {"cidr": str(net), "mask": str(net.netmask),
            "source": "automatic-default", "certain": inside}


def _dns_editable(n: Json) -> bool:
    """Whether the resolver can be changed, by eero's rule.

    eero Plus filtering is done by answering DNS at eero's own resolver, so
    pointing the network somewhere else would take the filtering with it. eero
    resolves that by refusing the change while any DNS policy is on, and it
    counts policies on profiles, not only the two the network document carries
    itself.

    Offering the control anyway would mean either a write eero rejects, or one
    it accepts while quietly ending the filtering somebody is paying for.
    """
    if (n.get("premium_status") or "") != "active":
        return True
    return not bool((n.get("premium_dns") or {}).get("dns_policies_enabled"))


def _dns_caching_visible(n: Json) -> bool:
    """Whether local DNS caching should be offered, matching eero's own rule.

    From `NetworkExtensionsKt.isLocalDnsCachingVisible`: capable, and not
    bridged, and not (an active Plus subscription with any DNS policy enabled
    for the network). Reproduced rather than simplified because each clause is
    a different reason and eero's support pages describe the outcome without
    the conditions — a control offered where it cannot work is worse than one
    that is absent.
    """
    caps = n.get("capabilities") or {}
    if not bool((caps.get("dns_caching") or {}).get("capable")):
        return False
    if (n.get("connection") or {}).get("mode") == "bridge":
        return False
    premium = (n.get("premium_status") or "") == "active"
    # `premium_dns` is the key eero sends. This read `premium_dns_network_settings`,
    # which is the *property* name in eero's Android model, annotated there as
    # @SerializedName("premium_dns"). That key appears in none of the 510
    # captured flows nor in either live network document, so the lookup always
    # missed, `policies` was always False, and the clause below could never
    # fire: caching was offered to every subscriber, filtering or not, which is
    # the exact case this function exists to catch.
    policies = bool((n.get("premium_dns") or {})
                    .get("any_policies_enabled_for_network"))
    return not (premium and policies)


class LanSettings(BaseModel):
    upnp: bool | None = None
    ipv6_upstream: bool | None = None
    thread: bool | None = None
    nat_port_randomization: bool | None = None
    sqm: bool | None = None


@router.put("/lan")
async def put_lan(body: LanSettings, c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    # These live in the network's settings object; the app PUTs the changed
    # fields to {network}/settings, not to the network root. Writing to the
    # root is silently accepted and changes nothing, which is why the toggles
    # appeared dead.
    return await c.put(f"{net.rstrip('/')}/settings", json=payload)


class DnsCaching(BaseModel):
    enabled: bool


@router.put("/dns-caching")
async def put_dns_caching(body: DnsCaching, c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    """Turn local DNS caching on or off.

    The whole `dns` object is read and sent back with only `caching` changed.
    eero's `dns` is {mode, parent, custom, caching} and this endpoint takes the
    object rather than the one field, so sending `{"caching": x}` alone would
    depend on eero merging rather than replacing — which is not documented
    either way. Reading first and resending the rest does not depend on knowing.

    This restarts the network. eero's own app puts its `reboot_required` dialog
    in front of the same change (`LocalDnsCachingViewModel`), so the interface
    warns before calling this.
    """
    current = await c.follow(net)
    dns = dict(current.get("dns") or {})
    dns["caching"] = body.enabled
    await c.put(f"{net.rstrip('/')}/settings", json={"dns": dns})
    return {"enabled": body.enabled}


class SimpleSetupVendor(BaseModel):
    vendor_id: int
    enabled: bool


class AutoSetup(BaseModel):
    """eero Simple Setup: whether a new wired eero sets itself up."""
    enabled: bool


# eero models this as a mode rather than a flag, and its own app writes two of
# the four values: `SimpleSetupSettingsViewModel` sends ZTS to turn the switch
# on and DEFAULT to turn it off.
#
# DEFAULT is a request, not a state. Asked for it on a live network and eero
# answered `{"mode": "LTS"}` and stored LTS — light-touch setup, where a new
# eero is found but you confirm it. So the only thing that can be compared
# after a write is whether the mode is ZTS, not whether it equals what was
# sent. Comparing the literal would have failed every switch-off with a 502
# about a write that had worked.
AUTO_SETUP_ON = "ZTS"
AUTO_SETUP_OFF = "DEFAULT"


@router.get("/simple-setup")
async def simple_setup(c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Which vendors may onboard their own devices onto this network.

    Not one switch: eero keeps a row per vendor under
    `{network}/simple_setup/vendors`, and each is enabled separately. Only one
    vendor exists in practice, but it is modeled as the list eero returns
    rather than flattened to a boolean — a second vendor appearing should not
    require this to be rewritten.
    """
    n = await c.follow(net)
    caps = (n.get("capabilities") or {})
    rows = await c.get(f"{net.rstrip('/')}/simple_setup/vendors")
    return {
        "capable": bool((caps.get("simple_setup") or {}).get("capable")),
        # eero's other Simple Setup, which is a different feature with a
        # confusingly close name: new *wired eeros* joining the mesh on their
        # own, rather than Amazon putting Alexa devices on the Wi-Fi. Its state
        # is a mode on the network document, not a vendor row.
        "auto_setup_mode": n.get("auto_setup_mode"),
        "auto_setup": (n.get("auto_setup_mode") or "") == AUTO_SETUP_ON,
        "vendors": [{"vendor_id": r.get("vendor_id"),
                     "enabled": bool(r.get("enabled"))}
                    for r in (rows or [])],
    }


@router.put("/simple-setup")
async def put_simple_setup(body: SimpleSetupVendor,
                           c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    """Enable or disable one vendor's onboarding.

    Form-encoded, not JSON. eero's own client is

        @FormUrlEncoded
        @PUT("2.2/networks/{network}/simple_setup/vendors/{vendor}")
        ... @Field("enabled") boolean enabled

    and a JSON body to the same path is answered 200 and ignored, so this
    switch reported success and did nothing. Found by trying to change it on a
    live network: eero echoed `enabled: true` in the response and both read
    paths still said false a minute later, while the same toggle in eero's own
    app worked and persisted.

    So the value is read back rather than inferred from the status code. A 200
    from this endpoint is not evidence that anything happened, and this is the
    second setting in this app to be caught by that — device writes to the 2.2
    path were accepted and never took effect either.

    eero warns of a `brief_network_interruption` when this is turned off. It
    does not happen: toggled by hand both ways on 2026-09-03 and the mesh
    stayed up, which is why the control no longer asks.
    """
    await c.put(f"{net.rstrip('/')}/simple_setup/vendors/{body.vendor_id}",
                data={"enabled": "true" if body.enabled else "false"})
    rows = await c.get(f"{net.rstrip('/')}/simple_setup/vendors", cache=False)
    got = next((r for r in rows or []
                if r.get("vendor_id") == body.vendor_id), None)
    landed = bool(got and got.get("enabled")) if got else None
    if landed is not None and landed != body.enabled:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=("eero accepted the change and did not apply it. The "
                    "setting is still "
                    f"{'on' if landed else 'off'}."))
    return {"vendor_id": body.vendor_id, "enabled": body.enabled}


@router.put("/auto-setup")
async def put_auto_setup(body: AutoSetup, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """Turn eero Simple Setup on or off.

    A JSON body here, unlike the vendor switch beside it which is form-encoded.
    eero's own client declares `@Body SetAutoSetupMode` against
    `2.2/networks/{id}/auto_setup_mode`, with the mode under the key `mode`.

    Read back rather than trusted, for the reason the vendor switch documents
    at length: a 200 from this API is not evidence that anything was stored.
    """
    nid = net.rstrip("/").rsplit("/", 1)[-1]
    want = AUTO_SETUP_ON if body.enabled else AUTO_SETUP_OFF
    await c.put(f"2.2/networks/{nid}/auto_setup_mode", json={"mode": want})
    mode = (await c.follow(net, cache=False) or {}).get("auto_setup_mode")
    # On is exactly ZTS. Everything else is off, including the LTS that eero
    # substitutes when asked for DEFAULT.
    landed = mode == AUTO_SETUP_ON
    if landed != body.enabled:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=("eero accepted the change and did not apply it. Simple "
                    f"Setup is still {'on' if landed else 'off'}."))
    return {"enabled": landed, "mode": mode}


class NetworkNickname(BaseModel):
    """A label the owner types, distinct from the Wi-Fi name."""
    nickname: str = Field(..., min_length=1, max_length=64)


class NetworkTimezone(BaseModel):
    """An IANA zone name, e.g. Europe/Paris."""
    timezone: str = Field(..., min_length=3, max_length=64,
                          pattern=r"^[A-Za-z]+/[A-Za-z0-9_+\-/]+$")


@router.get("/identity")
async def network_identity(c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    """What eero's "Nickname & location" screen shows.

    Two things the owner sets and one eero works out. `nickname_label` is a
    label on the network and is not the SSID — `name` is that. The zone is
    what schedules and usage windows are computed against, so it is not
    cosmetic: an override with the wrong zone moves every chart.
    """
    n = await c.follow(net)
    tz = n.get("timezone") or {}
    geo = n.get("geo_ip") or {}
    return {
        "nickname": n.get("nickname_label"),
        "name": n.get("name"),
        "timezone": tz.get("value"),
        # What eero guessed from the connection, so the interface can say
        # whether the zone in force is the guess or a choice.
        "timezone_from_geo": tz.get("geo_ip"),
        "geo": {"city": geo.get("city"), "region": geo.get("region"),
                "country": geo.get("countryName")},
    }


@router.put("/nickname")
async def put_nickname(body: NetworkNickname,
                       c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Set the network's label.

    Form-encoded to a query-parametered path, which is eero's own shape:

        @FormUrlEncoded
        @PUT("2.2/networks/{id}/label?labelType=specialMarket")
        ... @Field("label") String name

    Read back rather than trusted. This API answers 200 to writes it ignores —
    Simple Setup and the device pause both did — and a rename that silently
    fails is one somebody will retype three times before giving up.
    """
    await c.put(f"{net.rstrip('/')}/label?labelType=specialMarket",
                data={"label": body.nickname})
    n = await c.follow(net, cache=False)
    got = n.get("nickname_label")
    if got != body.nickname:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=("eero accepted the name and did not apply it. It is still "
                    + (f"\u201c{got}\u201d." if got else "unset.")))
    return {"nickname": got}


@router.put("/timezone")
async def put_timezone(body: NetworkTimezone,
                       c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Set the zone the network reports its own time in.

    Rides the settings object like the other network-level fields. The zone
    name is not validated against a list here: eero owns that list, and a
    hardcoded copy would rot every time the IANA database changes.
    """
    await c.put(f"{net.rstrip('/')}/settings",
                json={"timezone": {"value": body.timezone}})
    n = await c.follow(net, cache=False)
    got = (n.get("timezone") or {}).get("value")
    if got != body.timezone:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(f"eero accepted the time zone and did not apply it. It is "
                    f"still {got or 'unset'}."))
    return {"timezone": got}


class UplinkVlan(BaseModel):
    """The uplink VLAN tag, or empty to clear it.

    Some providers hand off tagged traffic and the gateway has to tag its
    uplink to match. eero's own field is a bare string on the network object
    and its app validates 1-4094 before sending, so the same range is enforced
    here rather than letting a bad value reach the WAN.
    """
    vlan: str = ""

    @field_validator("vlan")
    @classmethod
    def _range(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            return ""
        if not v.isdigit() or not 1 <= int(v) <= 4094:
            raise ValueError("VLAN ID must be a whole number between 1 and 4094")
        return str(int(v))


@router.put("/uplink-vlan")
async def put_uplink_vlan(body: UplinkVlan, c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    """Set or clear the uplink VLAN tag, then check it actually took.

    The write is read back deliberately. Every other network setting in this
    file had to be moved to the `/settings` sub-path because writing to the
    network root returned 200 and changed nothing, and this one could not be
    tested the usual way: a wrong uplink VLAN takes the WAN down, and the only
    way back is physical access to the gateway. So it writes, re-reads, and
    says plainly whether the value is there rather than reporting a success it
    has not confirmed.
    """
    await c.put(f"{net.rstrip('/')}/settings", json={"vlan": body.vlan})
    # The client drops its read cache on every write, so this re-read is a
    # real round trip rather than the value we just sent.
    n = await c.follow(net)
    got = (n.get("vlan") or "")
    if got != body.vlan:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "eero accepted the request but the network still reports "
            f"{got or 'no VLAN tag'}. The tag was not applied.")
    return {"vlan": got}


class BandSteering(BaseModel):
    enabled: bool


@router.put("/wifi/band-steering")
async def put_band_steering(body: BandSteering, c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Steer dual-band clients toward 5 GHz. Clients may briefly reconnect."""
    # Lives in the network's settings object, like the other radio settings.
    # Writing it to the network root is accepted and changes nothing.
    await c.put(f"{net.rstrip('/')}/settings",
                json={"band_steering": body.enabled})
    return {"band_steering": body.enabled}


class DnsConfig(BaseModel):
    """ISP default vs custom, with separate IPv4 and IPv6 servers.

    Each family takes a primary and an optional secondary; the app models DNS
    this way. Empty custom lists mean "use the ISP resolvers".
    """
    mode: str = Field("automatic", pattern="^(automatic|custom)$")
    ipv4: list[str] = Field(default_factory=list)
    ipv6: list[str] = Field(default_factory=list)


def _check_ips(addrs: list[str], want_v6: bool) -> None:
    for a in addrs:
        try:
            ip = ipaddress.ip_address(a)
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"{a} is not an IP address") from None
        if (ip.version == 6) != want_v6:
            fam = "IPv6" if want_v6 else "IPv4"
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"{a} is not an {fam} address")


@router.put("/dns")
async def put_dns(body: DnsConfig, c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    """Upstream resolvers, IPv4 and IPv6.

    Getting these wrong breaks name resolution for the whole network while
    leaving the link up, which presents as "the internet is broken" with no
    obvious cause. Choosing automatic hands resolution back to the ISP.
    """
    # Validated before anything is read or written. A malformed address is
    # refusable from the body alone, and making that answer wait on a round
    # trip to eero would be a slower no for no gain.
    if body.mode != "automatic":
        _check_ips(body.ipv4, want_v6=False)
        _check_ips(body.ipv6, want_v6=True)
        if not body.ipv4 and not body.ipv6:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "custom DNS needs at least one server")

    # Whatever caching is set to now, it stays set to. This sends a whole `dns`
    # object, and caching lives inside it — so leaving it out would turn it off
    # as a side effect of changing the resolver, which is exactly the kind of
    # silent change somebody would never think to look for.
    current = await c.follow(net)
    caching = bool((current.get("dns") or {}).get("caching"))
    if body.mode == "automatic":
        payload: Json = {"dns": {"mode": "automatic", "caching": caching},
                         "ipv6": {"name_servers": {"mode": "automatic"}}}
    else:
        payload = {"dns": {"mode": "custom", "custom": {"ips": body.ipv4},
                           "caching": caching},
                   "ipv6": {"name_servers": {"mode": "custom", "custom": body.ipv6}}}
    await c.put(f"{net.rstrip('/')}/settings", json=payload)
    return {"mode": body.mode, "ipv4": body.ipv4, "ipv6": body.ipv6}


class ConnectionMode(BaseModel):
    """automatic | manual | bridge, as the app presents the LAN."""
    mode: str = Field(..., pattern="^(automatic|manual|bridge)$")
    # Only for manual; validated the same way as the DHCP range endpoint.
    subnet_ip: str | None = None
    subnet_mask: str | None = None
    start_ip: str | None = None
    end_ip: str | None = None


@router.put("/mode")
async def put_mode(body: ConnectionMode, c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    """Switch the LAN between automatic NAT, a manual IP range, and bridge.

    Bridge turns off routing entirely, so DHCP, port forwards, reservations and
    the firewall all stop applying — the eeros become plain access points. This
    is the change most likely to strand devices, so the interface confirms it.
    """
    if body.mode == "bridge":
        await c.put(f"{net.rstrip('/')}/settings",
                    json={"connection": {"mode": "bridge"}})
        return {"mode": "bridge"}

    if body.mode == "automatic":
        await c.put(f"{net.rstrip('/')}/settings",
                    json={"connection": {"mode": "nat"},
                          "dhcp": {"mode": "automatic"}})
        return {"mode": "automatic"}

    # manual: validate the lease range exactly like /dhcp does
    fields = {"subnet_ip": body.subnet_ip, "subnet_mask": body.subnet_mask,
              "start_ip": body.start_ip, "end_ip": body.end_ip}
    if not all(fields.values()):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "manual mode needs subnet, mask, start, and end")
    for label, value in fields.items():
        try:
            ipaddress.ip_address(value)
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"{label} is not an IP address") from None
    network = ipaddress.ip_network(f"{body.subnet_ip}/{body.subnet_mask}", strict=False)
    for label in ("start_ip", "end_ip"):
        if ipaddress.ip_address(fields[label]) not in network:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"{label} is outside {network}")
    if ipaddress.ip_address(body.start_ip) >= ipaddress.ip_address(body.end_ip):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "the pool start must come before its end")
    await c.put(f"{net.rstrip('/')}/settings",
                json={"connection": {"mode": "nat"},
                      "dhcp": {"mode": "custom", "custom": {
                          "subnet_ip": body.subnet_ip, "subnet_mask": body.subnet_mask,
                          "start_ip": body.start_ip, "end_ip": body.end_ip}}})
    return {"mode": "manual", **fields}


class DdnsToggle(BaseModel):
    enabled: bool


@router.get("/ddns")
async def get_ddns(c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    d = n.get("ddns") or {}
    return {"enabled": bool(d.get("enabled")), "subdomain": d.get("subdomain")}


@router.put("/ddns")
async def put_ddns(body: DdnsToggle, c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    """Dynamic DNS gives the network a stable hostname despite a changing
    public address. eero models this as two endpoints rather than a flag."""
    nid = net.rstrip("/").split("/")[-1]
    await c.put(f"2.2/networks/{nid}/ddns/{'enable' if body.enabled else 'disable'}",
                json={})
    # Read back rather than trusted, as the other switches here are: a 200 from
    # this API is not evidence that anything was stored, and the interface
    # holds its selection until the network agrees, so a write that did not
    # land has to be reported as one.
    d = (await c.follow(net, cache=False) or {}).get("ddns") or {}
    landed = bool(d.get("enabled"))
    if landed != body.enabled:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=("eero accepted the change and did not apply it. eero.online "
                    f"is still {'on' if landed else 'off'}."))
    return {"enabled": landed, "subdomain": d.get("subdomain")}


# 802.11r fast transition is deliberately not exposed. eero still serves
# `2.2/networks/{id}/fast_transition`, but nothing in the phone app reaches it:
# the Retrofit methods and the FastTransitionStatus model are still compiled in
# and no screen, fragment, or view model calls either one. The only surviving
# clue to where it lived is a preference key, `pref_fast_transition`, whose
# value is its own name — a shape shared with exactly one other string in the
# table, `pref_debug_tools_screen`.
#
# A network-wide radio setting that eero withdrew from its own interface is not
# one to hand back out. It was a switch here, and the route it wrote through is
# gone with it rather than left reachable without a button.


@router.get("/channel-utilization")
async def channel_utilization(hours: int = 24,
                              c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    """Airtime occupancy over time, across every radio.

    The instantaneous figure from a node says how busy a channel is now; this
    says whether it has been busy all day, which is the question worth asking
    before blaming the hardware. `acs_events` record when eero moved a radio to
    a different channel on its own.

    eero keeps about two days of this and no more. A longer window is not
    refused, it is simply answered with the two days there are, which is why
    the reply says what it actually covers as well as what was asked for.

    `granularity` is in minutes and is eero's own parameter: without it every
    window comes back at the 30-second sampling rate, which is six thousand
    points per radio for a week. Asking for roughly three hundred points puts
    a day on five-minute buckets, which is what eero's own app asks for.
    """
    nid = net.rstrip("/").split("/")[-1]
    now = dt.datetime.now(dt.timezone.utc)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    d = await c.get(f"2.2/networks/{nid}/channel_utilization", params={
        "start": (now - dt.timedelta(hours=hours)).strftime(fmt),
        "end": now.strftime(fmt),
        "granularity": max(1, round(hours * 60 / 300))})

    eeros = {str(e.get("id") or e.get("eero_id")): (e.get("location") or e.get("name"))
             for e in c.as_list((d or {}).get("eeros"), "eeros")}

    radios = []
    for u in c.as_list((d or {}).get("utilization"), "utilization"):
        series = u.get("time_series_data") or []
        busy = [p.get("busy") for p in series if p.get("busy") is not None]
        radios.append({
            "node": eeros.get(str(u.get("eero_id"))) or str(u.get("eero_id")),
            "band": band_label(u.get("band")),
            "channel": u.get("channel"),
            "frequency_mhz": u.get("frequency"),
            "minutes_busy": u.get("minutes_over_busy_threshold"),
            "busy_now": busy[-1] if busy else None,
            "busy_avg": round(sum(busy) / len(busy)) if busy else None,
            "busy_peak": max(busy) if busy else None,
            "series": [{"t": p.get("timestamp"), "busy": p.get("busy"),
                        "noise": p.get("noise")} for p in series],
            # Each entry is eero deciding, unprompted, to move this radio.
            "channel_changes": [{"t": e.get("timestamp"),
                                 "from": e.get("from_channel"),
                                 "to": e.get("to_channel")}
                                for e in (u.get("acs_events") or [])],
        })
    radios.sort(key=lambda r: (r["node"], r["band"]))
    # Timestamps are milliseconds, as eero sends them, and every radio is on
    # the same clock — so the widest pair across all of them is the window
    # actually covered.
    stamps = [p["t"] for r in radios for p in r["series"] if p["t"]]
    covers = round((max(stamps) - min(stamps)) / 3_600_000, 1) if stamps else 0.0
    return {"hours": hours, "covers_hours": covers, "radios": radios}


@router.get("/power-saving")
async def get_power_saving(c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    nid = net.rstrip("/").split("/")[-1]
    try:
        schedules = c.as_list(
            await c.get(f"2.2/networks/{nid}/power_saving/schedules"), "schedules")
    except UpstreamError:
        schedules = []
    return {"enabled": bool(n.get("power_saving")),
            "schedule_enabled": bool(n.get("power_saving_schedule_enabled")),
            "schedules": schedules}


class PowerSaving(BaseModel):
    enabled: bool


@router.put("/power-saving")
async def put_power_saving(body: PowerSaving, c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    """Reduces power draw when the network is idle."""
    nid = net.rstrip("/").split("/")[-1]
    # The body field is "enable", not "enabled" (PowerOptimizationRequest);
    # sending the wrong key is accepted and ignored.
    await c.put(f"2.2/networks/{nid}/power_saving",
                json={"enable": body.enabled})
    return {"enabled": body.enabled}


class DhcpRange(BaseModel):
    """The LAN subnet and the pool eero hands addresses from."""
    subnet_ip: str
    subnet_mask: str
    start_ip: str
    end_ip: str


@router.put("/dhcp")
async def put_dhcp(body: DhcpRange, c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    """Change the LAN addressing.

    Every device renews onto the new subnet, which means anything with a static
    address or a reservation outside the new range stops being reachable. This
    is the setting most likely to lock you out of your own network.
    """
    for label, value in (("subnet_ip", body.subnet_ip), ("subnet_mask", body.subnet_mask),
                         ("start_ip", body.start_ip), ("end_ip", body.end_ip)):
        try:
            ipaddress.ip_address(value)
        except ValueError:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"{label} is not an IP address") from None
    try:
        network = ipaddress.ip_network(f"{body.subnet_ip}/{body.subnet_mask}", strict=False)
        for label, value in (("start_ip", body.start_ip), ("end_ip", body.end_ip)):
            if ipaddress.ip_address(value) not in network:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                    f"{label} is outside {network}")
        if ipaddress.ip_address(body.start_ip) >= ipaddress.ip_address(body.end_ip):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "the pool start must come before its end")
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from None

    nid = net.rstrip("/").split("/")[-1]
    await c.put(f"2.2/networks/{nid}/settings",
                json={"dhcp": {"mode": "custom", "custom": body.model_dump()}})
    return body.model_dump()


def _wan_mode(n: Json) -> str:
    """dhcp | static | pppoe, from whichever field eero populated."""
    wt = str(n.get("wan_type") or "").strip().lower()
    if wt in ("pppoe", "static_ip", "static", "dhcp"):
        return "static" if wt.startswith("static") else wt
    if n.get("pppoe_enabled"):
        return "pppoe"
    mode = str(((n.get("lease") or {}).get("mode")) or "").strip().lower()
    return mode if mode in ("dhcp", "static", "pppoe") else "dhcp"


class WanMode(BaseModel):
    """How the gateway gets its address from the provider.

    static needs the address trio; pppoe needs credentials and the gateway's
    serial, because eero encrypts them against that node.
    """
    mode: str = Field(..., pattern="^(dhcp|static|pppoe)$")
    ip: str | None = None
    mask: str | None = None
    router: str | None = None
    username: str | None = None
    password: str | None = None
    serial: str | None = None


@router.get("/wan")
async def get_wan(c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    lease = n.get("lease") or {}
    return {"mode": _wan_mode(n),
            "static": lease.get("static") or None,
            "dhcp": lease.get("dhcp") or None,
            "pppoe_username": n.get("pppoe_username")}


@router.put("/wan")
async def put_wan(body: WanMode, c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    """Change how the gateway obtains its WAN address.

    This is the single most disruptive setting in the interface: getting it
    wrong takes the whole network off the internet, and the only way back is
    physical access to the eero. Every branch is validated before anything is
    sent.
    """
    nid = net.rstrip("/").split("/")[-1]

    if body.mode == "dhcp":
        await c.put(f"2.2/networks/{nid}/settings",
                    json={"lease": {"mode": "dhcp"}})
        return {"mode": "dhcp"}

    if body.mode == "static":
        fields = {"ip": body.ip, "mask": body.mask, "router": body.router}
        missing = [k for k, v in fields.items() if not v]
        if missing:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"static addressing needs {', '.join(missing)}")
        for label, value in fields.items():
            try:
                ipaddress.ip_address(value)
            except ValueError:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                    f"{label} is not an IP address") from None
        # The gateway has to be reachable from the address being claimed, or
        # the link comes up with nowhere to send traffic.
        net4 = ipaddress.ip_network(f"{body.ip}/{body.mask}", strict=False)
        if ipaddress.ip_address(body.router) not in net4:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"the router address {body.router} is not inside {net4}")
        await c.put(f"2.2/networks/{nid}/settings",
                    json={"lease": {"mode": "static",
                                    "static": {"ip": body.ip, "mask": body.mask,
                                               "router": body.router}}})
        return {"mode": "static", **fields}

    # pppoe
    if not (body.username and body.password):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "PPPoE needs a username and password")
    serial = body.serial
    if not serial:
        eeros = await c.eeros(net)
        gw = next((e for e in eeros if e.get("gateway")), None)
        serial = (gw or {}).get("serial")
    if not serial:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "no gateway eero found to encrypt the credentials")
    enc = await c.post(f"2.2/eeros/{serial}/pppoe",
                       json={"pppoe": {"username": body.username,
                                       "password": body.password}})
    await c.put(f"2.2/networks/{nid}/settings",
                json={"connection": {"value": "pppoe"},
                      "pppoe": enc if isinstance(enc, dict) else {}})
    # The password is never echoed back.
    return {"mode": "pppoe", "username": body.username}


class PppoeSettings(BaseModel):
    username: str = Field(..., min_length=1, max_length=128)
    password: str = Field(..., min_length=1, max_length=128)


@router.put("/pppoe")
async def put_pppoe(body: PppoeSettings, serial: str,
                    c: EeroCloud = Depends(authed_cloud),
                    net: str = Depends(current_network)) -> Json:
    """Configure a PPPoE connection on the gateway.

    Providers that use PPPoE need a username and password to bring the link up,
    so getting these wrong takes the network off the internet entirely. eero
    encrypts the credentials against the gateway's own key before storing them,
    which is why this posts to a node rather than to the network.
    """
    enc = await c.post(f"2.2/eeros/{serial}/pppoe",
                       json={"pppoe": {"username": body.username,
                                       "password": body.password}})
    nid = net.rstrip("/").split("/")[-1]
    await c.put(f"2.2/networks/{nid}/settings",
                json={"connection": {"value": "pppoe"},
                      "pppoe": enc if isinstance(enc, dict) else {}})
    # The password is never echoed back.
    return {"configured": True, "username": body.username}


@router.get("/health")
async def network_health(c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """eero's own diagnosis of the network, rather than ours."""
    n = await c.follow(net)
    h = n.get("health") or {}
    return {
        "internet": (h.get("internet") or {}).get("status"),
        "isp_up": (h.get("internet") or {}).get("isp_up"),
        "eero_network": (h.get("eero_network") or {}).get("status"),
        "status": n.get("status"),
        "cellular": await _cellular_health(c, net),
    }


# eero ships the Signal in two variants, distinguished only by model number.
# The API never states the radio generation, but it does report the model, and
# eero's own support documentation maps them:
#   https://prod.eero.com/support/articles/eero-signal
# RG5W is 5G RedCap with an LTE Cat 4 fallback; the RG4* pair are LTE only.
SIGNAL_VARIANTS = {
    "RG5W": "5G RedCap",
    "RG4W": "4G LTE",
    "RG4U": "4G LTE",
}


# What eero calls each one on its own store page, which is the name to put on
# screen: "eero Signal comes in two versions — 4G LTE or 5G". `model` alone
# comes back as a bare "eero Signal" for both, which names a product line
# rather than a device.
SIGNAL_PRODUCTS = {
    "RG5W": "eero Signal 5G",
    "RG4W": "eero Signal 4G LTE",
    "RG4U": "eero Signal 4G LTE",
}


def signal_variant(model_number: str | None) -> str | None:
    """The radio generation for a Signal model number, if it is one we know.

    Unknown or missing model numbers return None rather than a guess: a new
    variant must not be mislabelled as an existing one.
    """
    return SIGNAL_VARIANTS.get((model_number or "").strip().upper())


def signal_product(model_number: str | None, model: str | None) -> str | None:
    """eero's product name for a Signal, falling back to whatever it reported.

    Same rule as the variant: an unknown model number falls back to `model`
    rather than picking one of the two names, because guessing wrong here puts
    "4G LTE" on a 5G unit — which is the exact mistake this exists to fix. The
    Signal on the network this was written against reports RG5W and is a 5G;
    reading the generation out of its serial number would have said 4G.
    """
    return SIGNAL_PRODUCTS.get((model_number or "").strip().upper()) or model


# configuration_status on an accessory. eero's own strings are the source of
# the wording; anything unrecognized is passed through tidied rather than
# swallowed, so a new fault still reaches the screen.
ACCESSORY_ISSUES = {
    "no_connection": "No cellular reception",
    # eero's ConfigurationStatus declares NO_SIGNAL beside NO_CONNECTION; to
    # anybody reading the screen they are the same fault.
    "no_signal": "No cellular reception",
    "device_issue": "Device issue",
    "service_issue": "Service issue",
    # eero's own word for it, from the app's `lte_data_inactive`. Named here
    # rather than left to the fallback below, which tidied it into "Disabled"
    # — the enum member with a capital letter, which is not a sentence anybody
    # wrote. `DISABLED` is a declared member of eero's ConfigurationStatus
    # alongside READY, OTA, NO_SIGNAL and the rest, so it is a state the API
    # states rather than one this has not met before. Seen on a Signal that
    # had been removed from the network in eero's app: the accessory lingered
    # in the cloud's copy for a while afterward carrying this status, and
    # every pane that draws a Signal said "Disabled" until it went.
    "disabled": "Inactive",
}


# What eero reports for an accessory that is working. `ready` is the one a
# healthy eero Signal actually sends; the others are here because eero uses
# them elsewhere for the same idea.
# `backup_in_use` joins them: a Signal carrying traffic is the accessory
# doing the job it is for. That the wired connection has failed is a warning
# about the *network*, which the interface states separately; reported here
# as a fault it put a red cross on working hardware.
ACCESSORY_HEALTHY = {"ready", "ok", "active", "connected", "configured",
                     "none", "backup_in_use"}


def accessory_issue(status: str | None) -> str | None:
    """A human label for a faulty accessory, or None when it is healthy.

    A status this does not recognize is treated as a fault rather than ignored,
    on the grounds that a spurious caution mark is easier to notice and correct
    than a fault that never surfaces.
    """
    raw = (status or "").strip().lower()
    if not raw or raw in ACCESSORY_HEALTHY:
        return None
    # Setting up and installing are states, not faults. They are reported
    # through `accessory_status_key` instead, which has a word for each; left
    # here they became "Configuring" and "Ota" on the red cross that the
    # interface uses for hardware nothing can reach.
    if raw in ACCESSORY_CONFIGURING or raw in ACCESSORY_UPDATING:
        return None
    return ACCESSORY_ISSUES.get(raw, raw.replace("_", " ").capitalize())


# The faults that mean the modem has no cellular network at all. eero keeps
# the last `signal_score` it had through them, so a Signal flagged with no
# connection still reported four bars; with nothing attached there is no
# signal to rate.
ACCESSORY_NO_SIGNAL = {"no_connection", "no_signal"}


def cellular_bars(score: object, status: str | None) -> int | None:
    """eero's 0-4 signal rating, or 0 when the modem has no network.

    None only when eero gave no rating. A real 0 stays 0: empty bars are a
    reading, and the drawer draws them as one.
    """
    if (status or "").strip().lower() in ACCESSORY_NO_SIGNAL:
        return 0
    return max(0, min(4, score)) if isinstance(score, int) else None


def attached_accessories(network: Json | None, eero: Json) -> list[Json]:
    """An eero's accessories, less any the network no longer lists.

    eero returns the accessory list twice and the two do not agree. Each eero
    in the eeros list carries its own `accessories`; the network object
    carries one of its own, each entry naming the eero it is plugged into in
    `connected_eero_url`. eero's app reads only the network's copy — every
    screen that draws a Signal goes through `Network.accessories` and matches
    on that URL, and `Eero.accessories` is passed around by a copy
    constructor and never rendered.

    The node copy lags. Removing a Signal in eero's app took it out of the app
    at once and left it in the node copy for some minutes afterward,
    carrying `configuration_status: disabled`, so every pane here that draws a
    Signal went on drawing one that had been taken off the network.

    The node copy is still what is read, because it is what carries the
    per-node grouping and the fields the panels want. This only removes from
    it what the network says is gone.

    A response that states no accessory list at all is not a response that
    says the accessories are gone: the filter then does nothing, so an
    unexpected shape cannot blank out hardware that is really there. An
    accessory with no DSN cannot be matched either way and is kept.
    """
    rows = list(eero.get("accessories") or [])
    listed = (network or {}).get("accessories")
    if not isinstance(listed, list):
        return rows
    keep = {(a.get("dsn") or "").strip().lower()
            for a in listed if a.get("dsn")}
    return [a for a in rows
            if not a.get("dsn") or (a["dsn"] or "").strip().lower() in keep]


async def _cellular_health(c: EeroCloud, net: str) -> Json | None:
    """State of an eero Signal, if the network has one.

    The Signal is a cellular-backup accessory attached to a node rather than a
    node itself, so it is found by walking the eeros' `accessories`. Returns
    None when there is no such device, so the interface can leave the row out
    rather than reporting on hardware that is not there.

    Note the polarity: a Signal *standing by* is the healthy state. One that is
    actively carrying traffic means the wired connection has failed, which is a
    warning even though the backup is doing its job.
    """
    try:
        eeros = await c.eeros(net)
    except Exception:
        return None
    # The per-node accessory copy leaves configuration_status null; the
    # network-level list is where the fault actually appears — and where an
    # accessory taken off the network stops appearing first.
    net_status: dict[str, str] = {}
    network: Json | None = None
    try:
        network = await c.follow(net)
        for a in (network.get("accessories") or []):
            if a.get("dsn"):
                net_status[a["dsn"]] = a.get("configuration_status") or ""
    except Exception:
        pass
    for e in eeros:
        for a in attached_accessories(network, e):
            props = a.get("properties") or {}
            if props.get("type") != "cellular_backup":
                continue
            val = props.get("value") or {}
            # The node list carries a thin accessory. The per-accessory
            # endpoint returns the plan, the data used this cycle and the
            # regulatory IDs, so prefer it and fall back to the thin one.
            dsn = a.get("dsn")
            if dsn:
                try:
                    full = await c.get(f"{net.lstrip('/')}/accessories/{dsn}")
                    val = ((full.get("properties") or {}).get("value")) or val
                    a = {**a, "model_number": full.get("model_number")}
                except Exception:
                    pass

            cell = val.get("cellular_backup") or {}
            usage = cell.get("data_usage") or {}
            cycle = cell.get("data_cycle") or {}
            status = (cell.get("status") or val.get("status") or "").strip().lower()
            carrier = (val.get("carrier") or "").strip().lower()
            active = status in ("connected", "active", "online", "in_use")

            used_kb = usage.get("used_data_kb")
            max_kb = usage.get("max_data_kb")
            unlimited = bool(usage.get("is_unlimited"))
            pct = (round(100 * used_kb / max_kb)
                   if used_kb is not None and max_kb else None)

            issue = accessory_issue(a.get("configuration_status")
                                    or net_status.get(dsn or ""))
            return {
                "present": True,
                "issue": issue,
                "model": a.get("model") or "eero Signal",
                # The radio generation comes from the model number via
                # SIGNAL_VARIANTS; it is never inferred from anything else.
                "model_number": a.get("model_number"),
                "variant": signal_variant(a.get("model_number")),
                "fcc_id": val.get("fcc"),
                "node": e.get("location") or a.get("name"),
                "registered": bool(a.get("registered")),
                "carrier": None if carrier in ("", "unknown") else val.get("carrier"),
                "signal_score": val.get("signal_score") or None,
                "bars": cell.get("bars"),
                "provider": cell.get("provider"),
                "backup_status": status or None,
                "active": active,
                "state": ("carrying traffic" if active
                          else "standing by" if a.get("registered")
                          else "not registered"),
                "data": ({"used_kb": used_kb, "max_kb": max_kb,
                          "unlimited": unlimited, "percent": pct,
                          "cycle_start": cycle.get("start"),
                          "cycle_end": cycle.get("end")}
                         if used_kb is not None or unlimited else None),
            }
    return None


class UpdateHour(BaseModel):
    """Which hour of the day eero is allowed to install firmware."""
    hour: int = Field(..., ge=0, le=23)


@router.put("/updates/window")
async def set_update_window(body: UpdateHour,
                            c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Move the nightly firmware update to a less disruptive hour.

    An update reboots every eero, so the hour it runs in is the difference
    between not noticing and dropping a call. eero interprets it in the
    network's own timezone, not the browser's.
    """
    n = await c.follow(net)
    updates = ((n.get("resources") or {}).get("updates")
               or f"{net.rstrip('/')}/updates")
    await c.post(f"{updates.lstrip('/')}/preferred_update_hour",
                 json={"preferred_update_hour": body.hour})
    return {"hour": body.hour}


@router.post("/updates/start")
async def start_update(c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Install available firmware now, rather than waiting for the window.

    Every eero reboots as it updates, so the network drops for a few minutes.
    The URL comes from the network's own resources.
    """
    n = await c.follow(net)
    updates = ((n.get("resources") or {}).get("updates")
               or f"{net.rstrip('/')}/updates")
    await c.post(updates.lstrip("/"), json={})
    return {"started": True}


@router.get("/updates")
async def get_updates(c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """What firmware is on, and what is coming.

    The version in use is not on the network object — only the nodes carry it,
    and `target_firmware` is the version eero would install, which equals the
    installed one only while there is nothing to install. So the nodes are
    read for it. They disagree in exactly one situation, which is worth seeing
    rather than smoothing over: partway through a rolling update, some are on
    the new firmware and some are not.
    """
    n = await c.follow(net)
    u = n.get("updates") or {}
    try:
        on = sorted({e.get("os_version") for e in await c.eeros(net) or []
                     if e.get("os_version")})
    except Exception:                                        # noqa: BLE001
        on = []
    return {"has_update": u.get("has_update"),
            "preferred_update_hour": u.get("preferred_update_hour"),
            "can_update_now": u.get("can_update_now"),
            "min_required_firmware": u.get("min_required_firmware"),
            "last_update_started": u.get("last_update_started"),
            "target_firmware": u.get("target_firmware"),
            "current_firmware": on[0] if len(on) == 1 else None,
            "firmware_versions": on}
