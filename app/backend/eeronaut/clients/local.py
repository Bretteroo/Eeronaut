"""Local gRPC client for eero nodes.

Speaks eero's undocumented local control plane: gRPC over
mutual TLS on port 3001, addressed by the node's IPv6 link-local address.

Design notes:

* Enrollment is bootstrapped through the cloud once (``POST 2.2/account/trust``)
  and the resulting identity is reused thereafter.
* Every entry point degrades to ``LocalUnavailable`` rather than raising
  transport errors, because the whole channel is optional: the application is
  fully functional on cloud REST alone, just with slower status.
* The link-local address only resolves on the same layer-2 segment, so this is
  inert unless the container runs with host or macvlan networking.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import uuid
import ipaddress
import socket
import sys
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from ..core.config import settings
from ..core.errors import LocalUnavailable

_PROTO = Path(__file__).resolve().parent.parent / "proto"
if str(_PROTO) not in sys.path:
    sys.path.insert(0, str(_PROTO))

try:
    import grpc                                                   # noqa: E402
    from eero.network.status import status_pb2, status_pb2_grpc   # noqa: E402
    from eero.network.system import eero_system_pb2, eero_system_pb2_grpc  # noqa: E402
    from eero.network.topology import report_pb2, report_pb2_grpc  # noqa: E402
    from eero.network.backupaps import backupaps_pb2, backupaps_pb2_grpc  # noqa: E402
    from eero.network.setup.eeroconnect import station_pb2, station_pb2_grpc  # noqa: E402
    GRPC_AVAILABLE = True
except ImportError:                                # optional extra not installed
    GRPC_AVAILABLE = False
except Exception as e:                             # noqa: BLE001
    # The generated code checks the installed protobuf and grpcio against
    # the versions that wrote it, and raises VersionError or RuntimeError,
    # not ImportError, when one is too old. Uncaught, that stopped the whole
    # program from starting over a channel it can do without. Off instead,
    # and said why.
    import logging
    logging.getLogger(__name__).warning(
        "local control is off: %s", e)
    GRPC_AVAILABLE = False


# --------------------------------------------------------------------- identity

@dataclass
class Identity:
    key_pem: bytes
    cert_pem: bytes
    ca_pem: bytes = b""

    @property
    def serial(self) -> str:
        cert = x509.load_pem_x509_certificate(self.cert_pem)
        return f"{cert.serial_number:x}"

    @property
    def expires_at(self) -> dt.datetime:
        return x509.load_pem_x509_certificate(self.cert_pem).not_valid_after_utc

    def renewal_due(self, now: dt.datetime | None = None) -> bool:
        """Within RENEW_BEFORE of expiring, or past it. The certificate is
        made for a year and nothing on eero's side renews it: once it lapses
        the eeros refuse local connections and everything falls back to the
        slower cloud, without saying why."""
        now = now or dt.datetime.now(dt.timezone.utc)
        return self.expires_at - now <= RENEW_BEFORE


# How long before the certificate expires it is replaced.
RENEW_BEFORE = dt.timedelta(days=30)


def _identity_dir() -> Path:
    d = settings.data_dir / "identity"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_identity() -> Identity | None:
    d = _identity_dir()
    key, cert = d / "client.key", d / "client.crt"
    if not (key.exists() and cert.exists()):
        return None
    ca = d / "eero-ca.pem"
    return Identity(key.read_bytes(), cert.read_bytes(),
                    ca.read_bytes() if ca.exists() else b"")


def identity_name(log_id: str, install_id: str | None = None) -> tuple[str, str, str]:
    """Build the distinguished name eero expects, as (CN, OU, O).

    The app derives this in NimbleUtilsKt.getNimbleIdentityName:

        CN = "Android-" + first 8 characters of a per-install UUID
        OU = uppercase hex of SHA-1(user.log_id) as a BigInteger, first 10 chars
        O  = "eero"

    The OU is what binds a certificate to an account, so it has to be computed
    exactly - including the BigInteger conversion, which drops leading zeros.
    """
    install = install_id or str(uuid.uuid4())
    digest = hashlib.sha1(log_id.encode()).digest()
    ou = format(int.from_bytes(digest, "big"), "X")[:10]
    return f"Android-{install[:8]}", ou, "eero"


def create_identity(log_id: str, install_id: str | None = None) -> Identity:
    """Generate a client identity carrying eero's expected distinguished name."""
    cn, ou, org = identity_name(log_id, install_id)
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, ou),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + dt.timedelta(days=365))
        # The registered identity is used by nodes as a *trust anchor*, not as
        # an end-entity certificate, so it must be a CA. A CA:FALSE certificate
        # cannot anchor a path, and the node rejects the connection with
        # unknown_ca. Confirmed by extracting the app's own enrolled identity,
        # which carries CA:TRUE and nothing else beyond the key identifiers -
        # no keyUsage and no extendedKeyUsage.
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),
                       critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()),
                       critical=False)
        .sign(key, hashes.SHA256())
    )
    ident = Identity(
        key.private_bytes(serialization.Encoding.PEM,
                          serialization.PrivateFormat.PKCS8,
                          serialization.NoEncryption()),
        cert.public_bytes(serialization.Encoding.PEM),
    )
    d = _identity_dir()
    (d / "client.key").write_bytes(ident.key_pem)
    (d / "client.key").chmod(0o600)
    (d / "client.crt").write_bytes(ident.cert_pem)
    return ident


def delete_identity() -> None:
    """Remove local key material. Revocation with eero is done separately."""
    d = _identity_dir()
    for name in ("client.key", "client.crt", "eero-ca.pem"):
        (d / name).unlink(missing_ok=True)


def store_ca(pem: bytes) -> None:
    (_identity_dir() / "eero-ca.pem").write_bytes(pem)


# -------------------------------------------------------------------- addressing

def scope_id_for(address: str) -> int | None:
    """Interface index to use for a link-local address.

    Link-local addresses are ambiguous without one: the same fe80:: address can
    exist on several interfaces. Prefer the interface that already carries a
    link-local address of its own.
    """
    try:
        import socket as s
        candidates = []
        for idx, name in s.if_nameindex():
            if name == "lo":
                continue
            candidates.append((idx, name))
        for idx, _name in candidates:
            return idx
    except OSError:
        return None
    return None


def link_local_of(eero: dict) -> str | None:
    for entry in eero.get("ipv6_addresses") or []:
        if entry.get("scope") == "link" and entry.get("address"):
            raw = str(entry["address"]).split("/")[0]
            try:
                parsed = ipaddress.ip_address(raw)
            except ValueError:
                continue
            if parsed.is_link_local:
                # The API returns the uncompressed form; both the SAN match and
                # the app's own canonicalizeIpv6Address use the compressed one.
                return str(parsed)
    return None


def grpc_target(address: str, scope: int | None) -> str:
    # gRPC parses the target as a URI, so the zone separator must be escaped.
    host = f"{address}%25{scope}" if scope else address
    return f"[{host}]:{settings.local_port}"


# ----------------------------------------------------------------------- channel

# Channels are pooled per target. Each one costs a full mTLS handshake, and the
# interface opens several per page. Keyed by identity serial as well as target,
# so re-enrolling cannot leave a channel holding a revoked certificate.
_CHANNELS: dict[tuple[str, str], "grpc.aio.Channel"] = {}


async def close_channels() -> None:
    """Close every pooled channel. Called on application shutdown."""
    for ch in list(_CHANNELS.values()):
        try:
            await ch.close()
        except Exception:
            pass
    _CHANNELS.clear()


class LocalNode:
    def __init__(self, eero: dict, identity: Identity):
        if not GRPC_AVAILABLE:
            raise LocalUnavailable("grpc support is not installed")
        addr = link_local_of(eero)
        if not addr:
            raise LocalUnavailable("node has no link-local address")
        self.eero = eero
        self.target = grpc_target(addr, scope_id_for(addr))
        creds = grpc.ssl_channel_credentials(
            root_certificates=identity.ca_pem or None,
            private_key=identity.key_pem,
            certificate_chain=identity.cert_pem,
        )
        # The target must carry the zone index to be routable, but the node's
        # leaf certificate has only the bare link-local address in its SAN. So
        # the authority is overridden to the bracketed address *without* the
        # zone, or hostname verification fails. The Android app does the same.
        key = (self.target, identity.serial)
        channel = _CHANNELS.get(key)
        if channel is None:
            channel = grpc.aio.secure_channel(
                self.target, creds,
                options=[("grpc.default_authority", f"[{addr}]")],
            )
            _CHANNELS[key] = channel
        self._channel = channel
        self._pooled = True

    async def close(self) -> None:
        """No-op for pooled channels; they outlive a single request by design.

        Kept so call sites can stay symmetrical, and so a non-pooled channel
        would still be cleaned up.
        """
        if not getattr(self, "_pooled", False):
            await self._channel.close()

    async def _unary(self, stub_cls, method: str, request):
        stub = stub_cls(self._channel)
        try:
            return await getattr(stub, method)(request, timeout=settings.local_timeout_s)
        except grpc.aio.AioRpcError as exc:
            raise LocalUnavailable(f"{method}: {exc.code().name}") from exc

    async def network_status(self):
        return await self._unary(status_pb2_grpc.StatusStub, "GetNetworkStatus",
                                 status_pb2.StatusRequest())

    async def node_status(self):
        return await self._unary(status_pb2_grpc.StatusStub, "GetNodeStatus",
                                 status_pb2.StatusRequest())

    async def topology(self):
        return await self._unary(report_pb2_grpc.TopologyStub, "GetReport",
                                 report_pb2.ReportRequest())

    async def reboot(self, reason: str = "manual"):
        """Reboot this node. Destructive: drops every client attached to it."""
        return await self._unary(eero_system_pb2_grpc.SystemStub, "RebootNode",
                                 eero_system_pb2.RebootRequest(reason=reason))

    # ------------------------------------------------------------- topology

    async def topology_detail(self) -> dict:
        """Topology with radio, power, and backhaul detail decoded.

        Channel assignment, transmit power source, and per-port link rates are
        all in here, and none of it is exposed by eero's own interface.
        """
        r = await self.topology()

        def enum_name(msg, field, value):
            try:
                return msg.DESCRIPTOR.fields_by_name[field].enum_type \
                        .values_by_number[value].name
            except (KeyError, AttributeError):
                return str(value)

        channels = [{
            "radio": c.radio,
            "channel": c.channel,
            "center_freq_mhz": c.center_freq,
            "width": enum_name(report_pb2.BandChannelState, "width", c.width)
                     .replace("WIDTH_", ""),
            # Percentage of airtime the radio saw as occupied. High values on a
            # channel are the usual explanation for poor throughput.
            "busyness": c.busyness,
        } for c in r.channels]

        pi = r.power_info
        power = {
            "source": enum_name(report_pb2.PowerInfo, "power_source_type",
                                pi.power_source_type),
            "psu_input_mw": pi.psu_power_input,
            "poe_output_supported_mw": pi.total_poe_output_supported,
            "poe_output_allocated_mw": pi.total_poe_output_allocated,
            "usb_output_supported_mw": pi.total_usb_power_output_supported,
            "usb_output_allocated_mw": pi.total_usb_power_output_allocated,
        } if r.HasField("power_info") else None

        ports = [{
            "interface": st.if_num,
            "link": bool(st.has_carrier),
            "speed": enum_name(report_pb2.Ethernet.Status, "speed", st.speed)
                     .lstrip("P") + " Mbps" if st.has_carrier else None,
            "wan_port": bool(st.is_wan_port),
            "wired_upstream": bool(st.is_leaf_wired_to_upstream),
            "wired_eeros": len(st.wired_eeros),
        } for st in r.ethernet.statuses]

        return {
            "lan_ipv4": _fixed32_ip(r.lan_ipv4) if r.lan_ipv4 else None,
            "base_mac": _fixed64_mac(r.base_mac) if r.base_mac else None,
            "wired_internet": bool(r.ethernet.wired_internet),
            "channels": channels,
            "power": power,
            "ports": ports,
            "mesh_links": len(r.mesh_links),
            "mesh_paths": len(r.mesh_paths),
        }

    # --------------------------------------------------------------- scanning

    async def scan_networks(self, seconds: int = 5, timeout: float = 30.0) -> list[dict]:
        """Full-detail Wi-Fi scan.

        Only served while a node is in setup mode. In normal operation the node
        answers HTTP 502 for the Station service, surfaced as UNAVAILABLE. Use
        ``discover_ssids`` for a survey on a running network.
        """
        stub = station_pb2_grpc.StationStub(self._channel)
        seen: dict[str, dict] = {}
        try:
            async for reply in stub.ScanNetworks(
                    station_pb2.ScanRequest(scan_len=seconds), timeout=timeout):
                for ap in reply.aps:
                    seen[ap.bssid] = {
                        "ssid": ap.ssid, "bssid": ap.bssid,
                        "rssi": round(ap.rssi), "channel": ap.channel,
                        "freq_mhz": ap.freq, "country": ap.country_code,
                        "auth": ap.auth_types, "encryption": ap.encryptions,
                    }
        except grpc.aio.AioRpcError as exc:
            if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
                raise LocalUnavailable(f"ScanNetworks: {exc.code().name}") from exc
        return sorted(seen.values(), key=lambda a: a["rssi"], reverse=True)

    async def discover_ssids(self, timeout: float = 30.0) -> list[dict]:
        """Wi-Fi site survey of neighboring networks.

        This is the path that works on a running network. It reports SSID and
        signal strength but not channel; the full-detail scan is setup-only.
        Briefly occupies the radio.
        """
        stub = backupaps_pb2_grpc.BackupApStub(self._channel)
        seen: dict[str, int] = {}
        try:
            async for reply in stub.NodeSSIDDiscovery(
                    backupaps_pb2.SSIDDiscoveryRequest(), timeout=timeout):
                for s in reply.ssids:
                    seen[s.ssid] = max(seen.get(s.ssid, -127), s.rssi)
        except grpc.aio.AioRpcError as exc:
            if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
                raise LocalUnavailable(f"NodeSSIDDiscovery: {exc.code().name}") from exc
        return [{"ssid": k, "rssi": v} for k, v in
                sorted(seen.items(), key=lambda kv: kv[1], reverse=True)]

    # ------------------------------------------------------- backup internet

    async def backup_aps(self) -> dict:
        r = await self._unary(backupaps_pb2_grpc.BackupApStub, "GetBackupAps",
                              backupaps_pb2.GetBackupApRequest())
        return {
            "enabled": bool(r.enabled),
            "last_updated_at": r.last_updated_at,
            # Passwords are deliberately not returned.
            "credentials": [{"id": c.id, "ssid": c.ssid, "enabled": bool(c.enabled),
                             "has_password": bool(c.password), "created": c.created}
                            for c in r.credentials],
        }

    async def backup_ap_status(self) -> dict:
        r = await self._unary(backupaps_pb2_grpc.BackupApStub, "GetBackupApStatus",
                              backupaps_pb2.GetBackupApStatusRequest())
        return {"raw": str(r).strip()}

    async def enable_backup_aps(self, enabled: bool):
        return await self._unary(
            backupaps_pb2_grpc.BackupApStub, "EnableBackupAps",
            backupaps_pb2.EnableBackupApsRequest(enabled=enabled))

    async def set_backup_aps(self, enabled: bool, credentials: list[dict]):
        creds = [backupaps_pb2.ApCredential(
                    ssid=c["ssid"], password=c.get("password", ""),
                    enabled=bool(c.get("enabled", True)), id=c.get("id", ""))
                 for c in credentials]
        return await self._unary(
            backupaps_pb2_grpc.BackupApStub, "SetBackupAps",
            backupaps_pb2.BackupAps(enabled=enabled, credentials=creds))

    # ------------------------------------------------------- node lifecycle

    async def delete_from_network(self):
        """Remove this node from the mesh. It must be re-added via eero's app."""
        return await self._unary(eero_system_pb2_grpc.SystemStub,
                                 "DeleteNodeFromNetwork",
                                 eero_system_pb2.DeleteRequest())

    async def watch_status(self):
        """Yield live status updates. Server-streaming, so no polling."""
        stub = status_pb2_grpc.StatusStub(self._channel)
        try:
            async for update in stub.NetworkStatusStream(status_pb2.StatusRequest()):
                yield update
        except grpc.aio.AioRpcError as exc:
            raise LocalUnavailable(f"stream closed: {exc.code().name}") from exc


def _fixed32_ip(v: int) -> str:
    """Decode a fixed32 IPv4 from the topology report.

    protobuf fixed32 is little-endian on the wire, so the integer that reaches
    us has the octets in network order once read most-significant first.
    """
    return ".".join(str((v >> shift) & 0xFF) for shift in (24, 16, 8, 0))


def _fixed64_mac(v: int) -> str:
    """Decode a fixed64-packed MAC address (six significant bytes)."""
    return ":".join(f"{b:02x}" for b in v.to_bytes(8, "big")[2:])


def status_names(node_status) -> dict:
    """Turn a NodeStatus into plain values, resolving enums to their names.

    The wire form uses integers (wan_v4=2), which are meaningless downstream.
    The generated descriptors carry the names, so use them.
    """
    def name(field: str, value: int) -> str:
        try:
            enum = status_pb2.NodeStatus.DESCRIPTOR.fields_by_name[field].enum_type
            return enum.values_by_number[value].name
        except (KeyError, AttributeError):
            return str(value)

    return {
        "serial": node_status.serial,
        "mac": node_status.mac,
        "firmware": node_status.firmware,
        "wan_v4": name("wan_v4", node_status.wan_v4),
        "lan_v4": name("lan_v4", node_status.lan_v4),
        "wan_v6": name("wan_v6", node_status.wan_v6),
        "lan_v6": name("lan_v6", node_status.lan_v6),
    }


# ---------------------------------------------------------------------- presence

TYPES = ("_eerogw._tcp.local.", "_eero._tcp.local.")


async def presence(timeout: float = 4.0) -> list[dict]:
    """mDNS sweep for eero nodes. Presence only; addresses come from the cloud.

    On the asyncio API rather than the blocking one. The synchronous
    `Zeroconf` does its work on its own threads and closes by blocking, and
    closing it from inside a running event loop makes it skip unregistering
    its services and say so: "unregister_all_services skipped as it does
    blocking i/o; use AsyncZeroconf with asyncio". Every sweep logged that,
    1,373 times across this log, along with the IPv6 socket errors from the
    same close path. The async API cancels the browser and closes cleanly
    while the loop is running, which is the only way this is called.
    """
    try:
        from zeroconf import IPVersion, ServiceStateChange
        from zeroconf.asyncio import (AsyncServiceBrowser, AsyncServiceInfo,
                                      AsyncZeroconf)
    except ImportError:
        return []

    found: list[dict] = []
    tasks: set[asyncio.Task] = set()

    # Both versions: the nodes answer on IPv4 here, but restricting to it
    # missed a node on one of three sweeps when that was measured, and an
    # IPv6-only segment would find nothing at all.
    #
    # zeroconf still logs one "Error with socket ('::1', 5353): Network is
    # unreachable" as it binds the IPv6 loopback. That is once per process,
    # not once per sweep — measured at five sweeps per process — and naming
    # the interfaces explicitly does not avoid it. Left alone rather than
    # worked around on a guess.
    aiozc = AsyncZeroconf(ip_version=IPVersion.All)

    async def describe(type_: str, name: str) -> None:
        """Ask one node about itself. A node that does not answer in time is
        simply not counted: presence is what this is for, and a name with no
        properties says nothing about which eero it is."""
        info = AsyncServiceInfo(type_, name)
        if not await info.async_request(aiozc.zeroconf, 2000):
            return
        props = {(k.decode() if isinstance(k, bytes) else k):
                 (v.decode(errors="ignore") if isinstance(v, bytes) else v)
                 for k, v in (info.properties or {}).items()}
        found.append({"gateway": "eerogw" in type_,
                      "base_mac": props.get("base_mac")})

    def on_change(zeroconf, service_type, name, state_change, **_kw) -> None:
        # The browser calls this from the loop, and it must not block: the
        # lookup that follows is a request of its own, so it goes in a task.
        # Held in a set so it is not collected mid-flight.
        if state_change is not ServiceStateChange.Added:
            return
        task = asyncio.ensure_future(describe(service_type, name))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    browser = AsyncServiceBrowser(aiozc.zeroconf, list(TYPES),
                                  handlers=[on_change])
    try:
        await asyncio.sleep(timeout)
        # Whatever is still asking gets the rest of the window, then is
        # dropped: a node answering late must not hold the sweep open.
        if tasks:
            await asyncio.wait(tasks, timeout=2.0)
    finally:
        await browser.async_cancel()
        await aiozc.async_close()
    return found
