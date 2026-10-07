"""One eero, flattened for a detail view.

The cloud object for an eero carries far more than the list view uses: the
state of each wired port, how many clients are on each radio, when it last
rebooted, which BSSIDs it broadcasts, how it is powered, and — for a leaf —
which node it meshes to and on which radio. The Android app shows all of this
on its per-eero and per-port screens; none of it reached this interface until
now. This endpoint does the joining the app does, so the frontend renders
rather than reshapes.
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from ..clients.cloud import EeroCloud
from ..core.labels import band_label, pretty_enum
from .config import (accessory_issue, cellular_bars, attached_accessories,
                     signal_product, signal_variant)
from ..core.labels import (accessory_status, accessory_status_key,
                           mesh_radio_label, reboot_claim_is_stale)
from .deps import authed_cloud, current_network

Json = dict[str, Any]
router = APIRouter(prefix="/api", tags=["nodes"])

# eero reports link speed as a PhyRate code, not a number. Straight from the
# enum in the APK (PhyRate.java).
PHY_RATE_MBPS = {
    "P10": 10, "P100": 100, "P1000": 1000, "P2500": 2500,
    "P5000": 5000, "P10000": 10000, "P25000": 25000,
}


# eero returns these as SCREAMING_SNAKE constants. Title-casing blindly turns
# USB into "Usb" and PoE into "Poe", so the ones that are acronyms are spelled
# out explicitly and everything else falls back to sentence case.
POWER_SOURCES = {
    "USB": "USB",
    "WALL_POWER": "Wall power",
    "POE": "Power over Ethernet",
    "POWER_OVER_ETHERNET": "Power over Ethernet",
    "AC": "AC adapter",
    "BATTERY": "Battery",
}


def _speed_mbps(code: str | None) -> int | None:
    return PHY_RATE_MBPS.get(code or "")


def _peer(st: Json, gateway_url: str | None) -> Json | None:
    """What is on the other end of a port, when eero can tell.

    A port carrying an LLDP neighbor names it. An eero on the far end is the
    useful case: a leaf's `isWanPort` is set on whichever port reaches the rest
    of the network, so a port marked WAN on a leaf is really its wired backhaul
    to the gateway, not a connection to the internet.
    """
    n = st.get("neighbor") or None
    if not isinstance(n, dict):
        return None
    meta = n.get("metadata") or {}
    url = (meta.get("url") or "").rstrip("/")
    name = meta.get("location") or meta.get("name") or meta.get("system_name")
    if not name:
        return None
    return {
        "name": name,
        "kind": (n.get("type") or "").lower() or None,
        "is_gateway": bool(gateway_url and url == gateway_url.rstrip("/")),
        "port": meta.get("port_name"),
    }


def _client_peer(names: list[str] | None) -> Json | None:
    """What is on a port, worked out from the clients that arrived through it.

    One client is that client. Several can only mean something bridging them
    onto the one physical port — a switch, almost always; a hub or a powerline
    or MoCA bridge otherwise. eero cannot see that device itself (an unmanaged
    switch is invisible to it, and the switch's own MAC is indistinguishable
    from the clients behind it), so it is named for what it does rather than
    picking one of the clients and calling it the switch.
    """
    if not names:
        return None
    if len(names) == 1:
        return {"name": names[0], "kind": "client", "is_gateway": False,
                "port": None, "count": 1}
    return {"name": "Network switch", "kind": "switch",
            "is_gateway": False, "port": None, "count": len(names)}


def _clients_by_port(devices: list[Json], node_url: str | None) -> dict[str, list[str]]:
    """Which wired clients sit on each of this node's ports.

    eero only reports an LLDP `neighbor` for hardware that announces itself,
    which in practice means another eero. Everything else — a console, a
    printer, a switch — is invisible there, but each wired client says which
    eero and which port it came in on, so the same fact is available from the
    other end.
    """
    out: dict[str, list[str]] = {}
    want = (node_url or "").rstrip("/")
    for d in devices or []:
        if not d.get("connected"):
            continue
        es = (d.get("connectivity") or {}).get("ethernet_status") or {}
        port = es.get("port_name")
        src = (d.get("source") or {}).get("url") or ""
        if not port or not want or src.rstrip("/") != want:
            continue
        name = (d.get("nickname") or d.get("hostname") or d.get("display_name")
                or d.get("mac") or "client")
        out.setdefault(str(port), []).append(name)
    return out


def _ports(eero: Json, gateway_url: str | None = None,
           clients: dict[str, list[str]] | None = None) -> list[Json]:
    """Join the two places port information lives.

    `port_details` names the physical ports; `ethernet_status.statuses` says
    what is happening on each, keyed by the same interface number / position.
    The app shows them as one thing, so they are merged here.
    """
    details = {p.get("position"): p for p in (eero.get("port_details") or [])}
    statuses = ((eero.get("ethernet_status") or {}).get("statuses")) or []
    ports = []
    for st in statuses:
        pos = st.get("interfaceNumber")
        det = details.get(pos, {})
        neighbor = st.get("neighbor") or None
        usage = st.get("bandwidth_usage") or {}
        ports.append({
            "name": st.get("port_name") or det.get("port_name") or str(pos),
            "position": pos,
            "connected": bool(st.get("hasCarrier")),
            "speed_mbps": _speed_mbps(st.get("speed")),
            "role": ("wan" if st.get("isWanPort")
                     else "lte" if st.get("isLte") else "lan"),
            "uplink": bool(st.get("isLeafWiredToUpstream")),
            "poe": st.get("poe"),
            "mac": det.get("ethernet_address"),
            # An LLDP neighbor means eero can see what is plugged in — usually
            # a managed switch announcing itself.
            "neighbor": neighbor,
            "peer": _peer(st, gateway_url)
                    or _client_peer((clients or {}).get(
                        str(st.get("port_name") or det.get("port_name") or pos))),
            "tx_bytes": usage.get("tx_bytes"),
            "rx_bytes": usage.get("rx_bytes"),
        })
    # Fall back to the physical port list when no live status is reported, so a
    # powered-off port still appears rather than the whole section vanishing.
    if not ports and details:
        for pos, det in sorted(details.items(), key=lambda kv: kv[0] or 0):
            ports.append({
                "name": det.get("port_name") or str(pos), "position": pos,
                "connected": None, "speed_mbps": None, "role": "lan",
                "uplink": False, "poe": None,
                "mac": det.get("ethernet_address"), "neighbor": None,
                "tx_bytes": None, "rx_bytes": None,
            })
    return ports


async def _accessories(c: EeroCloud, net: str, eero: Json,
                       network: Json | None = None) -> list[Json]:
    """Sub-devices attached to this eero. The one that matters is eero Signal,
    the cellular-backup modem eero Plus subscribers can add: it keeps the
    network online over LTE when the wired connection drops. Only the status
    fields are surfaced — the IMEI/IMSI/EID/ICCID identify the SIM and are not
    needed to show whether backup is working.

    `network` is the network object, when the caller has one. It is what says
    whether an accessory is still on the network: the node's own copy keeps a
    removed one for some minutes afterward. Without it nothing is filtered,
    which is the same behavior as before.
    """
    out = []
    for a in attached_accessories(network, eero):
        props = a.get("properties") or {}
        val = props.get("value") or {}
        # The node object carries only a thin accessory; the per-accessory
        # endpoint has the plan, usage, and regulatory IDs.
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
        carrier = (val.get("carrier") or "").strip().lower()
        out.append({
            # eero calls it a DSN; it is the serial printed on the underside,
            # and it is what a support conversation or a warranty claim asks
            # for. The panel is fetched by it and never showed it.
            "serial": a.get("dsn"),
            "model": a.get("model"),
            # eero's name for the actual product. `model` is "eero Signal" for
            # both the 4G and the 5G, which names the line and not the device.
            "product": signal_product(a.get("model_number"), a.get("model")),
            "issue": accessory_issue(a.get("configuration_status")),
            # eero's own code for the fault, beside the label made from it.
            # The label names the fault; the code is what decides which
            # advice goes with it.
            "configuration_status": a.get("configuration_status"),
            # The radio generation is derived from the model number, which is
            # the only thing that distinguishes the Signal variants.
            "model_number": a.get("model_number"),
            "variant": signal_variant(a.get("model_number")),
            "fcc_id": val.get("fcc"),
            "ic_id": val.get("ic_id"),
            # The modem's own identifier, which is a fact about the hardware in
            # the way the FCC and IC ids beside it are. Deliberately not its
            # companions: the ICCID, IMSI, and EID identify the SIM and the
            # subscriber, and those stay off every response. Carried only on
            # this detail, never in the node list, which is the view most
            # likely to end up in a screenshot.
            "imei": val.get("imei"),
            "kind": props.get("type"),
            "registered": a.get("registered"),
            "carrier": None if carrier in ("", "unknown") else val.get("carrier"),
            "signal_score": cellular_bars(val.get("signal_score"),
                                          a.get("configuration_status")),
            "provider": cell.get("provider"),
            "status": (cell.get("status") or val.get("status") or "").strip() or None,
            "used_kb": usage.get("used_data_kb"),
            "max_kb": usage.get("max_data_kb"),
            "unlimited": bool(usage.get("is_unlimited")),
            "cycle_end": cycle.get("end"),
        })
    return out


def _bssids(eero: Json) -> list[Json]:
    return [{"band": band_label(b.get("band")), "bssid": b.get("ethernet_address")}
            for b in (eero.get("bssids_with_bands") or [])]


@router.get("/accessories/{dsn}")
async def accessory_detail(dsn: str, c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    """One accessory, on its own.

    An eero Signal is a device in its own right even though eero files it under
    the eero it plugs into, so its detail is reachable without going through
    that eero. Which eero it is attached to is part of the answer rather than
    the route.
    """
    want = (dsn or "").strip().lower()
    # A fault is recorded on the network's copy of the accessory, not on the
    # node's — the node reports configuration_status as null while the network
    # says no_connection. The node list already merges the two; without the
    # same merge here the drawer showed a device flagged with a problem and
    # then declined to say what it was.
    faults: dict[str, str] = {}
    network: Json | None = None
    try:
        network = await c.follow(net)
        faults = {a.get("dsn"): a.get("configuration_status")
                  for a in (network.get("accessories") or [])
                  if a.get("dsn") and a.get("configuration_status")}
    except Exception:
        pass

    for e in (await c.eeros(net) or []):
        # The network's list, not the node's: an accessory the network has
        # dropped is gone, and its drawer is a 404 rather than a panel about
        # hardware that is no longer there.
        for a in attached_accessories(network, e):
            if (a.get("dsn") or "").strip().lower() != want:
                continue
            if not a.get("configuration_status") and a.get("dsn") in faults:
                a = {**a, "configuration_status": faults[a["dsn"]]}
            rows = await _accessories(c, net, {"accessories": [a]})
            if rows:
                return {**rows[0],
                        "status_key": accessory_status_key(rows[0]),
                        "status_label": accessory_status(rows[0]),
                        "node": e.get("location"),
                        "node_url": e.get("url"),
                        "joined": a.get("joined")}
    raise HTTPException(status.HTTP_404_NOT_FOUND, "no such accessory")


@router.get("/eeros/details")
async def eero_details(c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> list[Json]:
    """Every eero's detail in one request.

    The same answer as asking for each in turn, and far cheaper. Three of the
    four upstream reads behind a detail are network-wide — the network object,
    the node list, the client list — so asking node by node fetches them once
    per node. Five eeros cost twenty calls that way and eight this way.

    It exists so a table of eeros can have the contents of every drawer in
    hand before anybody opens one. Opening a drawer used to sit on a 2.4s
    round trip, and everything below the first few rows arrived after the
    panel did.
    """
    shared = await _shared(c, net)
    peers = shared[1] or []
    nodes = await asyncio.gather(*(
        c.follow(x) for x in peers if x.get("url")), return_exceptions=True)
    out = []
    for e in nodes:
        # One unreadable node is not a reason to answer with nothing: the
        # caller is warming a cache, and a missing entry only means that
        # drawer fetches for itself.
        if isinstance(e, BaseException) or not isinstance(e, dict):
            continue
        out.append(await _detail(c, net, e, shared))
    return out


@router.get("/eeros/{eero_id}/detail")
async def eero_detail(eero_id: str, c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    e, shared = await asyncio.gather(c.get(f"2.2/eeros/{eero_id}"),
                                     _shared(c, net))
    return await _detail(c, net, e, shared)


async def _shared(c: EeroCloud, net: str) -> tuple[Json | None, list[Json], list[Json]]:
    """The three network-wide reads a detail needs, fetched at once.

    Each is best-effort and each has a reason to be: the network object says
    which accessories are still attached and whether a claimed reboot time can
    be true, the node list turns "meshed over 5 GHz" into the name of the eero
    it reaches, and the client list says which clients sit on which port. A
    panel missing one of those is worth more than no panel, so a failure here
    is an empty value rather than an error.

    Run together rather than one after another. Sequentially they were four
    round trips to eero's cloud with nothing else happening in between, which
    is most of the 2.4 seconds a drawer took to fill in.
    """
    async def safe(coro, fallback):
        try:
            return await coro
        except Exception:                                    # noqa: BLE001
            return fallback

    return await asyncio.gather(              # type: ignore[return-value]
        safe(c.follow(net), None),
        safe(c.eeros(net), []),
        safe(c.devices(net), []),
    )


async def _detail(c: EeroCloud, net: str, e: Json,
                  shared: tuple[Json | None, list[Json], list[Json]]) -> Json:
    """One eero, flattened, given the network-wide reads it needs."""
    network, peers, clients = shared

    # Whether this node's claimed reboot time can be true, judged against the
    # network's record of the last firmware install.
    stale_reboot = False
    if network:
        updates = network.get("updates") or {}
        last = updates.get("last_user_update") or {}
        stale_reboot = reboot_claim_is_stale(
            e.get("last_reboot"), updates.get("last_update_started"), e.get("url"),
            [*(last.get("unresponsive_eeros") or []),
             *(last.get("incomplete_eeros") or [])],
            e.get("os_version"),
            updates.get("update_to_firmware") or updates.get("target_firmware"))

    # Which eero holds the internet connection, so a port pointing at it can be
    # named as backhaul rather than as this node's own WAN, and what every node
    # is called — the second is what turns a wireless uplink from "yes, over
    # 5 GHz" into the name of the eero it actually reaches, which is the only
    # form of that fact anyone can act on.
    names: dict[str, str] = {}
    gateway_url = next((x.get("url") for x in peers if x.get("gateway")), None)
    for x in peers:
        label = x.get("location") or x.get("serial")
        for key in (x.get("node_id"), x.get("serial"),
                    str(x.get("id") or "") or None,
                    (x.get("url") or "").rstrip("/").split("/")[-1] or None):
            if key and label:
                names[str(key)] = label

    wired = _clients_by_port(clients, e.get("url"))
    upstream = e.get("wireless_upstream_node") or None
    power = e.get("power_info") or {}
    return {
        # The id the per-node route is keyed by, so a caller that asked for
        # all of them at once can file each answer under the question it
        # would otherwise have asked.
        "id": (e.get("url") or "").rstrip("/").split("/")[-1] or None,
        "location": e.get("location"),
        "serial": e.get("serial"),
        "model": e.get("model"),
        "model_number": e.get("model_number"),
        "firmware": e.get("os_version"),
        "gateway": e.get("gateway"),
        "status": e.get("status"),
        "ip": e.get("ip_address"),
        "mac": e.get("mac_address"),
        # Withheld where eero's own data contradicts it — see
        # reboot_claim_is_stale, and the node list, which does the same.
        "last_reboot": None if stale_reboot else e.get("last_reboot"),
        "reboot_time_stale": stale_reboot,
        "last_heartbeat": e.get("last_heartbeat"),
        "update_available": e.get("update_available"),
        "clients": {
            "wireless": e.get("connected_wireless_clients_count"),
            "wired": e.get("connected_wired_clients_count"),
            "total": e.get("connected_clients_count"),
        },
        "mesh": {
            # Present only on a leaf that reaches the network over Wi-Fi. A
            # wired leaf, or the gateway, has no wireless uplink.
            "wireless_uplink": bool(upstream),
            "uplink_node_id": (upstream or {}).get("node_or_proxied_node_id"),
            # eero puts the peer's name on the upstream object itself, and
            # that is the only reliable source for it: `node_or_proxied_node_id`
            # is in a different id namespace from the one in a node's own `url`
            # (an eight-digit node id against a seven-digit resource id), so
            # joining the two never matches — every wirelessly-meshed leaf
            # showed its band with no peer beside it. The node-list lookup
            # stays as a fallback in case a firmware omits the name.
            "uplink_name": (upstream or {}).get("name") or names.get(
                str((upstream or {}).get("node_or_proxied_node_id") or "")),
            "uplink_radio": mesh_radio_label((upstream or {}).get("primary_mesh_radio")),
            "quality_bars": e.get("mesh_quality_bars"),
        },
        "power": {
            "source": pretty_enum(power.get("power_source"), POWER_SOURCES),
            # PoE-out: this eero powering another device through its port.
            "provides_poe": bool(e.get("provide_device_power")),
        },
        "ports": _ports(e, gateway_url, wired),
        "bssids": _bssids(e),
        "accessories": await _accessories(c, net, e, network),
    }
