"""Local control: everything that works without a cloud connection.

This is the page you want when the WAN is down. Nothing here calls eero's cloud.
Node addresses come from a cache written during normal operation, and all
control goes over the local gRPC channel directly to the hardware.

Each endpoint reports whether it is actually reachable, so the interface can
tell you honestly what is available rather than spinning.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status as http_status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..core import nodecache
from ..core.session import store as session_store
from ..core.config import settings
from ..core.errors import LocalUnavailable
from ..core.session import store
from ..clients import local as loc
from ..clients.cloud import EeroCloud
from .deps import authed_cloud

router = APIRouter(prefix="/api/local", tags=["local control"])
log = logging.getLogger(__name__)

Json = dict[str, Any]


def require_session() -> None:
    """Local pages still need a signed-in session, but never a reachable cloud."""
    if not store.token:
        raise HTTPException(http_status.HTTP_401_UNAUTHORIZED, "not signed in")


def _identity():
    ident = loc.load_identity()
    if not ident:
        raise LocalUnavailable("no local identity has been enrolled yet")
    return ident


# mDNS sweeps take seconds and the status endpoint is polled, so the answer is
# held briefly. Short enough that plugging into a different network is noticed
# quickly.
_PRESENCE_TTL = 30.0
_presence_cache: dict[str, Any] = {"at": 0.0, "macs": None}


async def present_macs() -> set[str] | None:
    """MACs of eeros visible on this segment right now, or None if the sweep
    could not run (in which case reachability is not asserted either way)."""
    now = time.time()
    if _presence_cache["macs"] is not None and now - _presence_cache["at"] < _PRESENCE_TTL:
        return _presence_cache["macs"]
    try:
        found = await loc.presence(timeout=3.0)
    except Exception:
        return None
    macs = {str(f.get("base_mac", "")).lower() for f in found if f.get("base_mac")}
    _presence_cache.update(at=now, macs=macs)
    return macs


def _cache_key() -> str:
    """Cache key for the network currently selected.

    The local pages must keep working with the cloud unreachable, so this reads
    the selected network from the stored session rather than calling eero.
    """
    s = session_store.session
    return nodecache.network_key(s.network_url if s else "")


def _band_of(freq_mhz: int | None, channel: int | None) -> str | None:
    """Which Wi-Fi band a frequency (or channel) belongs to."""
    f = freq_mhz or 0
    if 2400 <= f <= 2500:
        return "2.4 GHz"
    if 5150 <= f <= 5895:
        return "5 GHz"
    if 5925 <= f <= 7125:
        return "6 GHz"
    # Fall back to the channel number when the frequency is missing.
    if channel:
        if channel <= 14:
            return "2.4 GHz"
        if channel <= 177:
            return "5 GHz"
        return "6 GHz"
    return None


@router.get("/status", dependencies=[Depends(require_session)])
async def local_status() -> Json:
    """Whether local control is usable, and if not, precisely why."""
    cache = nodecache.load(_cache_key())
    ident = loc.load_identity()
    reasons: list[str] = []
    # Whether this machine is on the same network segment as the selected
    # network's eeros. Separate from `usable`, which also goes false while
    # enrollment is still in progress: the interface hides the local pages
    # entirely when you are demonstrably on a different network, but not
    # merely because setup has not finished yet.
    on_segment: bool | None = None
    if not settings.local_enabled:
        reasons.append("Local control is disabled in settings.")
    if not loc.GRPC_AVAILABLE:
        reasons.append("gRPC support is not installed in this build.")
    if not ident:
        reasons.append("No client identity has been enrolled with eero yet.")
    elif not ident.ca_pem:
        reasons.append("eero's certificate authorities have not been fetched yet.")
    if not cache.nodes:
        reasons.append("No cached node addresses. Connect to the internet once "
                       "so the node list can be recorded for offline use.")
    elif not any(n.link_local for n in cache.nodes):
        reasons.append("Cached nodes have no link-local address. The container "
                       "may not be on the same network segment as your eeros.")
    elif ident and loc.GRPC_AVAILABLE:
        # A cached link-local address proves nothing about reachability: every
        # eero has one, including those on a network at another site. Ask the
        # local segment who is actually here and require an overlap, otherwise
        # a remote network's nodes look controllable when they are not.
        seen = await present_macs()
        if seen is not None:
            want = {n.mac.lower() for n in cache.nodes if n.mac}
            if want:
                on_segment = bool(want & seen)
            if want and not (want & seen):
                reasons.append(
                    f"None of {cache.network_name or 'this network'}'s eeros "
                    "answered on this network segment. Local control only works "
                    "while you are connected to the same network as the eeros.")
    return {
        "usable": not reasons,
        "reasons": reasons,
        "cache_age_seconds": None if cache.age_seconds == float("inf") else int(cache.age_seconds),
        "cached_at": cache.updated_at or None,
        "network_name": cache.network_name,
        "node_count": len(cache.nodes),
        "grpc_available": loc.GRPC_AVAILABLE,
        "identity_enrolled": bool(ident),
        # true  - these eeros answered here
        # false - they did not; you are on a different network
        # null  - could not be determined (no cache yet, sweep failed, or
        #         local control is switched off), so nothing is claimed
        "on_segment": on_segment,
    }


class EnrollResult(BaseModel):
    enrolled: bool
    serial: str = ""
    common_name: str = ""
    detail: str = ""


async def _do_enroll(c: EeroCloud) -> EnrollResult:
    """Register a client identity so nodes will accept local connections.

    The certificate must be a self-signed **CA** certificate: nodes use it as a
    trust anchor rather than as an end-entity certificate.
    """
    account = await c.account()
    log_id = account.get("log_id")
    if not log_id:
        raise HTTPException(http_status.HTTP_409_CONFLICT,
                            "account did not return a log_id")
    existing = loc.load_identity()
    if existing:
        # Revoke the old one first so identities do not accumulate.
        try:
            await c.delete(f"2.2/account/trust/{existing.serial}")
        except Exception:
            pass

    ident = loc.create_identity(log_id)
    cn, _ou, _o = loc.identity_name(log_id)
    await c.post("2.2/account/trust", data={"certificate": ident.cert_pem.decode()})
    anchors = await c.request("GET", "2.2/account/trust")
    if isinstance(anchors, str):
        loc.store_ca(anchors.encode())
    return EnrollResult(enrolled=True, serial=ident.serial, common_name=cn)


@router.post("/enroll", dependencies=[Depends(require_session)],
             response_model=EnrollResult)
async def enroll(c: EeroCloud = Depends(authed_cloud)) -> EnrollResult:
    """Force a fresh enrollment (revokes any existing identity first)."""
    return await _do_enroll(c)


@router.post("/ensure", dependencies=[Depends(require_session)],
             response_model=EnrollResult)
async def ensure(c: EeroCloud = Depends(authed_cloud)) -> EnrollResult:
    """Enroll a client identity if one is not already in place.

    Local control is meant to be on by default, so the app calls this quietly
    on start-up rather than making the user click a button. It is a no-op when
    an identity already exists, and it never raises for the caller: enrollment
    writes a credential to the eero account, and if that cannot happen (local
    disabled, no gRPC, an offline account) the local pages simply stay in their
    "unavailable" state instead of erroring on load.
    """
    if not settings.local_enabled or not loc.GRPC_AVAILABLE:
        return EnrollResult(enrolled=False, detail="local control not available")
    existing = loc.load_identity()
    if existing and existing.ca_pem and not existing.renewal_due():
        return EnrollResult(enrolled=True, serial=existing.serial)
    # Missing, never finished, or near its expiry: enrolling again revokes
    # the old certificate and registers a new one.
    try:
        return await _do_enroll(c)
    except Exception as exc:                       # never break app start-up
        return EnrollResult(enrolled=False, detail=str(exc))


@router.delete("/enroll", dependencies=[Depends(require_session)])
async def unenroll(c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Revoke the client identity and remove local key material."""
    ident = loc.load_identity()
    if not ident:
        return {"revoked": False, "detail": "nothing enrolled"}
    serial = ident.serial
    try:
        await c.delete(f"2.2/account/trust/{serial}")
    finally:
        loc.delete_identity()
    return {"revoked": True, "serial": serial}


@router.get("/nodes", dependencies=[Depends(require_session)])
async def nodes() -> list[Json]:
    """Nodes known from cache, with no cloud call in the path."""
    cache = nodecache.load(_cache_key())
    return [
        {"serial": n.serial, "location": n.location, "model": n.model,
         "firmware": n.firmware, "gateway": n.gateway,
         "reachable_locally": bool(n.link_local), "eero_id": n.eero_id,
         "led_on": n.led_on, "led_brightness": n.led_brightness}
        for n in cache.nodes
    ]


@router.get("/presence", dependencies=[Depends(require_session)])
async def presence() -> Json:
    """mDNS sweep. Proves the container can see eeros on this segment."""
    found = await loc.presence(timeout=settings.local_timeout_s + 2)
    return {"found": len(found),
            "gateways": sum(1 for f in found if f.get("gateway"))}


def _node_or_404(serial: str):
    cache = nodecache.load(_cache_key())
    node = next((n for n in cache.nodes if n.serial == serial), None)
    if not node:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "unknown node")
    if not node.link_local:
        raise HTTPException(http_status.HTTP_409_CONFLICT,
                            "no link-local address cached for this node")
    return node


def _as_eero(node) -> dict:
    return {"serial": node.serial,
            "ipv6_addresses": [{"address": node.link_local, "scope": "link"}]}


# --- WAN detail -----------------------------------------------------------
# `NodeStatus.wan_ts` carries the one thing that matters when the internet is
# down: not "offline" but *where* it stopped. The WANState ladder walks the
# connection outwards — no link, no address, no gateway, gateway unreachable,
# no DNS, DNS unreachable, walled garden, auth failed, online — and the rung it
# stops on is the difference between "the modem is dead" and "my ISP is down".
# Only the gateway populates it, which is right: it is the only node with a WAN.
#
# This was being read off the wire and thrown away. The endpoint returned four
# coarse enums per node and dropped the ladder, the WAN address, the interface
# name and the timestamp the link went down.

_WAN_TYPES = {0: "wired", 1: "lte", 2: "backup_ap"}


def _ipv4(packed: int) -> str | None:
    """A `fixed32` address as dotted quad.

    Big-endian, checked against the same address eero's cloud reports as
    `wan_ip` for this network rather than assumed: the two orders are both
    plausible-looking addresses, so guessing would have been wrong silently.
    """
    if not packed:
        return None
    return ".".join(str((packed >> shift) & 0xFF) for shift in (24, 16, 8, 0))


def _ipv6(raw: bytes) -> str | None:
    if not raw or len(raw) != 16:
        return None
    import ipaddress
    return str(ipaddress.IPv6Address(raw))


def _enum(msg: Any, field: str, value: int) -> str:
    try:
        return msg.DESCRIPTOR.fields_by_name[field].enum_type \
                  .values_by_number[value].name
    except (KeyError, AttributeError):
        return str(value)


def _wan_detail(node_status: Any) -> Json | None:
    """The gateway's WAN, or None for a node that has no WAN to report."""
    if not node_status.HasField("wan_ts"):
        return None
    w = node_status.wan_ts
    interfaces = []
    for i in w.if_status:
        # proto3 omits a zero enum, so an absent state is UNKNOWN rather than
        # missing. Read through the descriptor so the name is eero's own.
        offline = None
        if i.HasField("timestamp_offline") and i.timestamp_offline.seconds:
            offline = i.timestamp_offline.ToDatetime().isoformat() + "Z"
        interfaces.append({
            "state": _enum(i, "state", i.state),
            "ipv4": _ipv4(i.ipv4),
            "ipv6": _ipv6(i.ipv6),
            "ifname": i.ifname or None,
            "offline_since": offline,
        })
    routes = [{"gateway": r.gateway_ip or None,
               "interface": r.egress_interface or None,
               "destination": r.destination or None}
              for r in w.route
              # eero sends an empty Route for the default route on a healthy
              # link. An entry with nothing in it tells nobody anything.
              if r.gateway_ip or r.egress_interface or r.destination]
    return {"type": _WAN_TYPES.get(w.wan_type, str(w.wan_type)),
            "interfaces": interfaces, "routes": routes}


@router.get("/network-status", dependencies=[Depends(require_session)])
async def network_status() -> Json:
    """Live status straight from a node. Works with the WAN down."""
    cache = nodecache.load(_cache_key())
    ident = _identity()
    errors = []
    for n in [x for x in cache.nodes if x.link_local]:
        try:
            node = loc.LocalNode(_as_eero(n), ident)
            try:
                res = await node.network_status()
                nodes = []
                wan = None
                for st in res.nodes:
                    detail = _wan_detail(st)
                    if detail is not None and wan is None:
                        # Lifted to the top level as well as left on its node:
                        # every caller that wants it wants the gateway's, and
                        # hunting for the one node that has it is the caller
                        # repeating this loop.
                        role = None
                        if st.HasField("metadata"):
                            role = _enum(st.metadata, "role", st.metadata.role)
                        wan = dict(detail, serial=st.serial, role=role)
                    nodes.append(
                        {"serial": st.serial, "mac": st.mac,
                         "firmware": st.firmware,
                         "wan_v4": st.wan_v4, "lan_v4": st.lan_v4,
                         "wan_v6": st.wan_v6, "lan_v6": st.lan_v6,
                         "wan": detail})
                return {"source_serial": n.serial, "source_location": n.location,
                        "wan": wan, "nodes": nodes}
            finally:
                await node.close()
        except LocalUnavailable as exc:
            errors.append(f"{n.location or n.serial}: {exc}")
    # A gRPC status code is not an explanation. The common case by far is that
    # the eeros are simply not on this network segment — every node times out —
    # so say that instead of pasting three DEADLINE_EXCEEDEDs together. The raw
    # errors are kept alongside for anyone debugging.
    timed_out = errors and all("DEADLINE_EXCEEDED" in e for e in errors)
    if timed_out:
        detail = ("No eero answered. Local control needs this machine to be on "
                  "the same network as the eeros; if you are, they may be "
                  "briefly busy.")
    elif errors:
        detail = "No eero answered."
    else:
        detail = ("No eero has a known local address yet. Load the dashboard "
                  "once while connected to this network.")
    # The raw gRPC statuses go to the log, not the interface: they are useful
    # when debugging and meaningless to the person reading the screen.
    if errors:
        # The name is written out rather than read from a variable: this
        # block was copied from `_on_node`, where `fn_name` is a parameter,
        # and the copy kept the reference. Every node failing is the
        # ordinary case off the segment, so this handled path raised
        # NameError instead and the page showed "Internal Server Error".
        log.info("local call network_status failed on every node: %s",
                 "; ".join(errors))
    raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE, detail)


@router.get("/topology", dependencies=[Depends(require_session)])
async def topology() -> Json:
    cache = nodecache.load(_cache_key())
    ident = _identity()
    gw = next((n for n in cache.nodes if n.gateway and n.link_local), None)
    candidates = [gw] if gw else [n for n in cache.nodes if n.link_local]
    for n in candidates:
        try:
            node = loc.LocalNode(_as_eero(n), ident)
            try:
                r = await node.topology()
                return {"source_serial": n.serial,
                        "mesh_links": len(r.mesh_links),
                        "mesh_paths": len(r.mesh_paths),
                        "channels": len(r.channels)}
            finally:
                await node.close()
        except LocalUnavailable:
            continue
    raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE,
                        "no node answered a topology request")


@router.get("/stream", dependencies=[Depends(require_session)])
async def stream() -> StreamingResponse:
    """Server-sent events carrying live node status.

    Backed by the gRPC server-streaming RPC, so updates arrive as the network
    changes rather than on a polling interval, and never touch eero's cloud.
    Reconnects to another node if the one we are streaming from goes away.
    """
    cache = nodecache.load(_cache_key())
    ident = _identity()
    reachable = [n for n in cache.nodes if n.link_local]
    if not reachable:
        raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE,
                            "no node has a cached link-local address")

    async def events():
        def sse(event: str, data: Json) -> bytes:
            return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()

        while True:
            progressed = False
            for n in reachable:
                node = None
                try:
                    node = loc.LocalNode(_as_eero(n), ident)
                    yield sse("open", {"source": n.location or n.serial})
                    async for update in node.watch_status():
                        progressed = True
                        yield sse("status", {**loc.status_names(update.status),
                                             "at": time.time()})
                except LocalUnavailable as exc:
                    yield sse("warn", {"source": n.location or n.serial,
                                       "detail": str(exc)})
                except asyncio.CancelledError:
                    return
                finally:
                    if node is not None:
                        await node.close()
            if not progressed:
                # Every node refused; back off rather than spin.
                yield sse("warn", {"detail": "no node accepted a stream"})
                await asyncio.sleep(10)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


async def _on_node(serial: str | None, fn_name: str, *args, **kwargs):
    """Run a call against a specific node, or the first that answers."""
    cache = nodecache.load(_cache_key())
    ident = _identity()
    candidates = ([_node_or_404(serial)] if serial
                  else [n for n in cache.nodes if n.link_local])
    errors = []
    for n in candidates:
        node = None
        try:
            node = loc.LocalNode(_as_eero(n), ident)
            result = await getattr(node, fn_name)(*args, **kwargs)
            return n, result
        except LocalUnavailable as exc:
            errors.append(f"{n.location or n.serial}: {exc}")
        finally:
            if node is not None:
                await node.close()
    # A gRPC status code is not an explanation. The common case by far is that
    # the eeros are simply not on this network segment — every node times out —
    # so say that instead of pasting three DEADLINE_EXCEEDEDs together. The raw
    # errors are kept alongside for anyone debugging.
    timed_out = errors and all("DEADLINE_EXCEEDED" in e for e in errors)
    if timed_out:
        detail = ("No eero answered. Local control needs this machine to be on "
                  "the same network as the eeros; if you are, they may be "
                  "briefly busy.")
    elif errors:
        detail = "No eero answered."
    else:
        detail = ("No eero has a known local address yet. Load the dashboard "
                  "once while connected to this network.")
    # The raw gRPC statuses go to the log, not the interface: they are useful
    # when debugging and meaningless to the person reading the screen.
    if errors:
        log.info("local call %s failed on every node: %s", fn_name, "; ".join(errors))
    raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE, detail)


@router.get("/topology/detail", dependencies=[Depends(require_session)])
async def topology_detail(serial: str | None = None) -> Json:
    """Radio channels, transmit power, and wired backhaul, read from a node.

    None of this is available through eero's own interface.
    """
    n, r = await _on_node(serial, "topology_detail")
    return {"source_serial": n.serial, "source_location": n.location, **r}


@router.post("/survey", dependencies=[Depends(require_session)])
async def survey(serial: str | None = None) -> Json:
    """Wi-Fi site survey of surrounding networks.

    Briefly occupies the node's radio, so clients on that node may see a short
    blip. Nothing is changed.

    Uses BackupAp.NodeSSIDDiscovery rather than Station.ScanNetworks: the
    latter carries channel and security detail but is only served while a node
    is in setup mode, answering HTTP 502 otherwise.
    """
    # The full scan carries the channel (and so the band) but is served only in
    # setup mode; on a running network it answers UNAVAILABLE. Try it first so
    # the survey can show a band when possible, and fall back to the discovery
    # scan (SSID and signal only) that always works.
    try:
        n, aps = await _on_node(serial, "scan_networks", 4)
        nets = [{"ssid": a["ssid"], "rssi": a["rssi"],
                 "band": _band_of(a.get("freq_mhz"), a.get("channel"))}
                for a in aps]
        detailed = True
    except Exception:
        n, ssids = await _on_node(serial, "discover_ssids")
        nets = [{"ssid": x["ssid"], "rssi": x["rssi"], "band": None} for x in ssids]
        detailed = False
    return {"source_serial": n.serial, "source_location": n.location,
            "count": len(nets), "networks": nets, "has_band": detailed}


@router.post("/scan/full", dependencies=[Depends(require_session)])
async def scan_full(serial: str | None = None, seconds: int = 5) -> Json:
    """Full-detail scan with channel and security data. Setup mode only."""
    seconds = max(1, min(seconds, 15))
    n, aps = await _on_node(serial, "scan_networks", seconds)
    return {"source_serial": n.serial, "count": len(aps), "access_points": aps}


@router.get("/backup-aps", dependencies=[Depends(require_session)])
async def get_backup_aps(serial: str | None = None) -> Json:
    n, r = await _on_node(serial, "backup_aps")
    return {"source_serial": n.serial, **r}


class BackupApToggle(BaseModel):
    enabled: bool


@router.put("/backup-aps/enabled", dependencies=[Depends(require_session)])
async def put_backup_enabled(body: BackupApToggle, serial: str | None = None) -> Json:
    n, _ = await _on_node(serial, "enable_backup_aps", body.enabled)
    return {"source_serial": n.serial, "enabled": body.enabled}


class BackupApCredential(BaseModel):
    ssid: str = Field(..., min_length=1, max_length=32)
    password: str = ""
    enabled: bool = True
    id: str = ""


class BackupApSet(BaseModel):
    enabled: bool
    credentials: list[BackupApCredential]


@router.put("/backup-aps", dependencies=[Depends(require_session)])
async def put_backup_aps(body: BackupApSet, serial: str | None = None) -> Json:
    """Replace the backup access point list. This is a write to your network."""
    n, _ = await _on_node(serial, "set_backup_aps", body.enabled,
                          [c.model_dump() for c in body.credentials])
    return {"source_serial": n.serial, "count": len(body.credentials)}


class DestructiveRequest(BaseModel):
    # Destructive calls require the serial echoed back, so a stray request
    # cannot trigger them.
    confirm_serial: str


@router.delete("/nodes/{serial}", dependencies=[Depends(require_session)])
async def delete_node(serial: str, confirm_serial: str) -> Json:
    """Remove a node from the mesh. It must be re-added through eero's app."""
    if confirm_serial != serial:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST,
                            "confirmation does not match the node serial")
    n, _ = await _on_node(serial, "delete_from_network")
    return {"removed": serial, "location": n.location, "at": time.time()}


class RebootRequest(BaseModel):
    # Destructive, so it takes an explicit acknowledgement rather than firing on
    # a single click. Rebooting a node drops every client attached to it.
    confirm_serial: str = Field(..., description="Must equal the node's serial")


@router.post("/nodes/{serial}/reboot", dependencies=[Depends(require_session)])
async def reboot(serial: str, body: RebootRequest) -> Json:
    if body.confirm_serial != serial:
        raise HTTPException(http_status.HTTP_400_BAD_REQUEST,
                            "confirmation does not match the node serial")
    n = _node_or_404(serial)
    ident = _identity()
    node = loc.LocalNode(_as_eero(n), ident)
    try:
        await node.reboot(reason="manual")
        return {"rebooted": serial, "location": n.location, "at": time.time()}
    except LocalUnavailable as exc:
        raise HTTPException(http_status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    finally:
        await node.close()
