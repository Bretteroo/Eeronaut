"""Features the eero app has that took a second pass to find.

Everything here came out of working backwards from the endpoints recovered
from the APK rather than from a list written by hand, which is the only way
these surfaced at all. See capture/scripts/unmapped.py.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from ..clients.cloud import EeroCloud
from ..core.labels import clean_domain
from ..core import config, notes
from ..core.prefs import Prefs
from ..core.session import store
from .deps import authed_cloud, cloud, current_network

Json = dict[str, Any]
router = APIRouter(prefix="/api", tags=["extras"])

_HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
DAYS = {"monday", "tuesday", "wednesday", "thursday", "friday",
        "saturday", "sunday"}


def _nid(net: str) -> str:
    """The bare network id out of a network URL like /2.2/networks/1234."""
    return net.rstrip("/").split("/")[-1]


# ------------------------------------------------- legacy device compatibility

@router.get("/network/legacy-mode")
async def get_legacy_mode(c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    return await c.get(f"2.2/networks/{_nid(net)}/ac_compat")


class LegacyMode(BaseModel):
    enabled: bool


@router.put("/network/legacy-mode")
async def set_legacy_mode(body: LegacyMode,
                          c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    """Keep older 802.11a/b/g clients able to associate.

    Form-encoded with a single field. Turning it on costs some throughput for
    everything else on the network, which is why eero keeps it off by default.
    """
    await c.put(f"2.2/networks/{_nid(net)}/ac_compat",
                data={"enabled": str(body.enabled).lower()})
    return {"enabled": body.enabled}


# --------------------------------------------------------- power saving schedules

class PowerSchedule(BaseModel):
    # 32 is eero's own ceiling, measured against the API: a 32-character name
    # is accepted and a 33 is refused with a bare `error.form.errors`, which
    # names no field and so reaches the reader as "that did not work". This
    # was 64, so anything between the two was refused upstream rather than
    # here, where the message can say which field and why.
    name: str = Field(..., min_length=1, max_length=32)
    enabled: bool = True
    days: list[str] = Field(..., min_length=1)
    start_time: str = Field(..., pattern=_HHMM)
    end_time: str = Field(..., pattern=_HHMM)

    def payload(self) -> Json:
        bad = [d for d in self.days if d.lower() not in DAYS]
        if bad:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                f"not days of the week: {bad}")
        if self.start_time == self.end_time:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "a schedule that starts and ends at the same "
                                "time would never run")
        # Capitalized, not lower-cased. eero rejects lower-case day names on
        # this endpoint with a bare `error.form.errors` and no indication of
        # which field it disliked, so every schedule this app created was
        # silently refused. Verified against the API: "monday" 400s,
        # "Monday" is accepted, and so are all seven capitalized.
        return {"name": self.name, "enabled": self.enabled,
                "days": [d.capitalize() for d in self.days],
                "start_time": self.start_time, "end_time": self.end_time}


@router.get("/network/power-saving/schedules")
async def power_schedules(c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> list[Json]:
    r = await c.get(f"2.2/networks/{_nid(net)}/power_saving/schedules")
    return EeroCloud.as_list(r, "schedules")


@router.post("/network/power-saving/schedules")
async def create_power_schedule(body: PowerSchedule,
                                c: EeroCloud = Depends(authed_cloud),
                                net: str = Depends(current_network)) -> Json:
    return await c.post(f"2.2/networks/{_nid(net)}/power_saving/schedules",
                        json=body.payload())


@router.put("/network/power-saving/schedules/{schedule_id}")
async def update_power_schedule(schedule_id: str, body: PowerSchedule,
                                c: EeroCloud = Depends(authed_cloud),
                                net: str = Depends(current_network)) -> Json:
    return await c.put(
        f"2.2/networks/{_nid(net)}/power_saving/schedules/{schedule_id}",
        json=body.payload())


@router.delete("/network/power-saving/schedules/{schedule_id}")
async def delete_power_schedule(schedule_id: str,
                                c: EeroCloud = Depends(authed_cloud),
                                net: str = Depends(current_network)) -> Json:
    await c.delete(
        f"2.2/networks/{_nid(net)}/power_saving/schedules/{schedule_id}")
    return {"deleted": schedule_id}


# ------------------------------------------------------------- blocked apps

@router.get("/profiles/{profile_id}/apps")
async def blocked_apps(profile_id: str,
                       c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Which applications this profile blocks, and what it could block.

    eero returns rich objects here — display name, logo, categories, and the
    current blocked state — not the bare identifiers the write endpoint takes.
    Passing them through raw made the interface treat each object as a string.
    """
    d = await c.get(f"2.2/networks/{_nid(net)}"
                    f"/dns_policies/profiles/{profile_id}/applications")
    apps = EeroCloud.as_list(d, "applications")
    available, blocked = [], []
    for a in apps:
        if not isinstance(a, dict):
            # Older shapes returned plain identifiers; keep working with them.
            available.append({"name": str(a), "label": str(a).replace("_", " ").title(),
                              "categories": []})
            continue
        name = a.get("name")
        if not name:
            continue
        available.append({
            "name": name,
            "label": a.get("display_name") or str(name).replace("_", " ").title(),
            "categories": a.get("categories") or [],
        })
        if a.get("is_blocked"):
            blocked.append(name)
    available.sort(key=lambda x: x["label"].lower())
    return {"available": available, "applications": blocked}


class BlockedApps(BaseModel):
    applications: list[str]


@router.put("/profiles/{profile_id}/apps")
async def set_blocked_apps(profile_id: str, body: BlockedApps,
                           c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    """Block named services for a profile.

    The list is the whole state, not a delta: whatever is sent becomes the
    blocked set, so sending an empty list unblocks everything.
    """
    await c.put(f"2.2/networks/{_nid(net)}/dns_policies/profiles/"
                f"{profile_id}/applications/blocked",
                json={"applications": body.applications})
    return {"applications": body.applications}


class ProfileAdBlock(BaseModel):
    enabled: bool


@router.put("/profiles/{profile_id}/adblock")
async def set_profile_adblock(profile_id: str, body: ProfileAdBlock,
                              c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    """Ad blocking for one profile.

    A profile has its own switch, separate from the network-wide one, and the
    field is `enable` rather than `enabled` — the plural spelling is accepted
    with a 200 and ignored.
    """
    await c.post(f"2.2/networks/{_nid(net)}/dns_policies/profiles/"
                 f"{profile_id}/adblock", json={"enable": body.enabled})
    return {"enabled": body.enabled}


class ProfileSite(BaseModel):
    domain: str = Field(..., min_length=1, max_length=253)
    """Which list to put it on."""
    allow: bool = False
    remove: bool = False

    @field_validator("domain")
    @classmethod
    def _plausible(cls, v: str) -> str:
        return clean_domain(v)


@router.put("/profiles/{profile_id}/sites")
async def set_profile_site(profile_id: str, body: ProfileSite,
                           c: EeroCloud = Depends(authed_cloud),
                           net: str = Depends(current_network)) -> Json:
    """Block or allow a site for one profile.

    `profiles` is the whole set of profiles a rule applies to, not a delta, and
    it holds profile URLs — sending an id is rejected with
    `Invalid url, <id>`. So the current rule is read first and this profile
    added to or removed from it. A rule with no profiles left is deleted
    outright, which is the only thing `is_delete` was observed to do: sent
    alongside a populated list it returns 200 and leaves the rule in place.
    All of this was established against the live API.
    """
    which = "allowed" if body.allow else "blocked"
    key = "allowed_list" if body.allow else "blocked_list"
    nid = _nid(net)
    mine = f"{net.rstrip('/')}/profiles/{profile_id}"

    current = await c.get(f"2.2/networks/{nid}/dns_policies/advanced_content_filter")
    rule = next((x for x in ((current or {}).get(key) or [])
                 if isinstance(x, dict) and x.get("domain_name") == body.domain),
                None)
    urls = [pf.get("profile_url") for pf in ((rule or {}).get("profile_list") or [])
            if isinstance(pf, dict) and pf.get("profile_url")]
    urls = [u for u in urls if u.rstrip("/") != mine.rstrip("/")]
    if not body.remove:
        urls.append(mine)

    payload: Json = {"domain": body.domain, "is_delete": not urls,
                     "override": True, "profiles": urls}
    if body.allow:
        payload["add_cname"] = True
    await c.put(f"2.2/networks/{nid}/dns_policies/profiles/{which}", json=payload)
    return {"domain": body.domain, "list": which, "profiles": urls}


class ProfileFilters(BaseModel):
    """Content categories for one profile.

    Free-form because eero owns the category names: they arrive on the profile
    as `unified_content_filters.dns_policies` and are echoed straight back, so
    a category eero adds later needs no change here.
    """
    filters: dict[str, bool]


@router.put("/profiles/{profile_id}/content-filters")
async def set_profile_filters(profile_id: str, body: ProfileFilters,
                              c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    """Block content categories for one profile.

    A profile's categories are not the network's: the network-wide endpoint
    writes to a subnet and fails with `error.network_subnet.not_found` when
    asked to stand in for a profile. This is the profile's own policy document,
    form-encoded and flat, the same shape as the network-level toggle.
    """
    if not body.filters:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no filters supplied")
    await c.post(f"2.2/networks/{_nid(net)}/dns_policies/profiles/{profile_id}",
                 data={k: str(v).lower() for k, v in body.filters.items()})
    return body.filters


# ------------------------------------------------------ data usage reporting

@router.get("/insights/report-settings")
async def usage_report_settings(c: EeroCloud = Depends(authed_cloud),
                                net: str = Depends(current_network)) -> Json:
    return await c.get(f"2.2/networks/{_nid(net)}/data_usage/report_settings")


class UsageReport(BaseModel):
    cadence: str = Field(..., pattern="^(weekly|monthly|none)$")
    notification_day: int | None = Field(None, ge=0, le=31)


def _report_day(cadence: str) -> int:
    """The day eero's own app pairs with a cadence.

    Its `getNotificationDay` is one line: 1 for weekly, 31 for anything else.
    So a weekly report goes out on the first day of the week and a monthly one
    on the last day of the month, and no other pairing is ever written by the
    app. Carrying over whatever day happened to be stored looked harmless and
    was not: it produced `monthly` with day 1, a combination eero's own client
    never creates.
    """
    return 1 if cadence == "weekly" else 31


@router.put("/insights/report-settings")
async def set_usage_report_settings(body: UsageReport,
                                    c: EeroCloud = Depends(authed_cloud),
                                    net: str = Depends(current_network)) -> Json:
    """Change how often eero mails the usage summary.

    eero validates this as a form and refuses a partial one: a body carrying
    only `cadence` comes back 400 `error.form.errors`, which reached the
    interface as "eero rejected those values without saying which one" every
    time somebody changed the frequency. So the day travels with the cadence,
    derived from it the way eero's app derives it, unless the caller names one.
    """
    url = f"2.2/networks/{_nid(net)}/data_usage/report_settings"
    day = body.notification_day
    if day is None:
        day = _report_day(body.cadence)
    return await c.put(url, json={"cadence": body.cadence,
                                  "notification_day": day})


# -------------------------------------------------------------- device labels

@router.get("/devices/{mac}/labels")
async def device_labels(mac: str, c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    return await c.get(f"2.2/networks/{_nid(net)}/devices/{mac}/labels")


class DeviceLabels(BaseModel):
    make_label: str | None = None
    model_label: str | None = None
    version_label: str | None = None
    type_label: str | None = None


@router.put("/devices/{mac}/labels")
async def set_device_labels(mac: str, body: DeviceLabels,
                            c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Correct what eero thinks a device is.

    eero guesses the make and model from the MAC and its own fingerprinting,
    and gets it wrong often enough to be worth overriding. Sent as query
    parameters rather than a body, which is eero's choice, not ours.
    """
    params = {k: v for k, v in body.model_dump().items() if v is not None}
    if not params:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing to change")
    await c.put(f"2.2/networks/{_nid(net)}/devices/{mac}/labels", params=params)
    return params


# ----------------------------------------------------------- internet backup


@router.get("/network/backup-internet")
async def backup_internet(c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    """Whether hotspot backup is armed, and what cellular backup is doing.

    Two different things share the word "backup" and only one of them is a
    switch. Hotspot backup is the network falling back to a Wi-Fi network you
    nominated in advance; it has its own on/off. Cellular backup is an eero
    Signal taking over, and there is no enable/disable for it anywhere in
    eero's API — no Retrofit method, no field on the network object. The only
    way to stop it is to take the accessory off the network.
    """
    nid = _nid(net)

    async def switch() -> bool | None:
        try:
            r = await c.get(f"2.2/networks/{nid}/backupinternet")
            return (r or {}).get("backup_internet_enabled")
        except Exception:
            return None

    # Side by side: each is a two-to-three-second round trip to eero when
    # cold, and the switch on the page was disabled until both had answered,
    # one after the other.
    enabled, n = await asyncio.gather(switch(), c.follow(net))
    if enabled is None:
        enabled = n.get("backup_internet_enabled")
    cell = n.get("cellular_backup") or {}
    return {
        "enabled": bool(enabled),
        "cellular": {
            "present": bool(cell.get("dsn")),
            "model": cell.get("model"),
            "status": cell.get("status"),
            "provider": cell.get("provider"),
            "bars": cell.get("bars"),
            # No control exists, so the interface says so rather than
            # offering a switch that cannot do anything.
            "can_disable": False,
        } if cell else {"present": False, "can_disable": False},
    }


class BackupInternet(BaseModel):
    enabled: bool


@router.put("/network/backup-internet")
async def set_backup_internet(body: BackupInternet,
                              c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    """Arm or disarm hotspot backup.

    The path is `backupinternet`, one word — the app's own Retrofit method
    spells it that way and the hyphenated and underscored variants are not
    routes.
    """
    await c.put(f"2.2/networks/{_nid(net)}/backupinternet",
                json={"backup_internet_enabled": body.enabled})
    return {"enabled": body.enabled}


@router.post("/network/backup-internet/test")
async def test_backup_internet(c: EeroCloud = Depends(authed_cloud),
                               net: str = Depends(current_network)) -> Json:
    """Ask eero to try the saved backup networks and report whether they work.

    Starts the check; the result arrives on the network object rather than in
    this response, the same way a speed test does.
    """
    await c.post(
        f"2.2/networks/{_nid(net)}/backup_access_points/connectivity_check")
    return {"started": True}


# ------------------------------------------------------- backup access points

class BackupNetwork(BaseModel):
    ssid: str = Field(..., min_length=1, max_length=32)
    password: str | None = None


@router.post("/local/backup-aps/networks")
async def add_backup_network(body: BackupNetwork,
                             c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    """Save a hotspot for eero to fall back to.

    eero's form has three fields and refuses a partial one: `ssid`,
    `password`, and a `uuid` the client makes up — its app sends
    `SystemUtils.randomUUID()`, and its request class will not even build
    with a null password, so an open network goes as "". Sending the two
    fields somebody actually typed came back 400 `error.form.errors` on
    every attempt.
    """
    payload: Json = {"ssid": body.ssid, "password": body.password or "",
                     "uuid": str(uuid.uuid4())}
    await c.post(f"2.2/networks/{_nid(net)}/backup_access_points", json=payload)
    return {"ssid": body.ssid}          # never echo the password back


@router.put("/local/backup-aps/networks/{backup_id}")
async def edit_backup_network(backup_id: str, body: BackupNetwork,
                              c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    """Change a saved hotspot's name or password.

    eero's app edits by taking the saved object as it came back from the
    list, copying it with the new name and password, and putting the whole
    thing back under its uuid (`BackupNetwork.copy$default` in
    `AddBackupNetworkViewModel.editBackupNetwork`). A body with only the two
    changed fields is a partial form, and eero refuses partial forms. The
    list does not carry passwords, so a change with no password sends "",
    which is what an open network has.
    """
    nid = _nid(net)
    current = await c.get(f"2.2/networks/{nid}/backup_access_points") or []
    entry = next((e for e in current if e.get("uuid") == backup_id), None)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "no saved backup network with that id")
    payload: Json = {**entry, "ssid": body.ssid,
                     "password": body.password if body.password is not None else ""}
    await c.put(f"2.2/networks/{nid}/backup_access_points/{backup_id}",
                json=payload)
    return {"ssid": body.ssid}          # never echo the password back


@router.delete("/local/backup-aps/networks/{backup_id}")
async def delete_backup_network(backup_id: str,
                                c: EeroCloud = Depends(authed_cloud),
                                net: str = Depends(current_network)) -> Json:
    await c.delete(f"2.2/networks/{_nid(net)}/backup_access_points/{backup_id}")
    return {"deleted": backup_id}


class BackupOrder(BaseModel):
    rearranged_ids: list[str] = Field(..., min_length=1)


@router.post("/local/backup-aps/order")
async def reorder_backup_networks(body: BackupOrder,
                                  c: EeroCloud = Depends(authed_cloud),
                                  net: str = Depends(current_network)) -> Json:
    """Set which backup network eero tries first."""
    if len(set(body.rearranged_ids)) != len(body.rearranged_ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "the same network appears more than once")
    await c.post(f"2.2/networks/{_nid(net)}/backup_access_points/rearrange",
                 json={"rearranged_ids": body.rearranged_ids})
    return {"order": body.rearranged_ids}


@router.post("/local/backup-aps/discover")
async def discover_backup_networks(c: EeroCloud = Depends(authed_cloud),
                                   net: str = Depends(current_network)) -> Json:
    """Have the eeros scan for nearby SSIDs to use as a backup."""
    await c.post(f"2.2/networks/{_nid(net)}"
                 f"/backup_access_points/ssid_discovery")
    return {"scanning": True}


@router.get("/local/backup-aps/discover")
async def backup_discovery_status(c: EeroCloud = Depends(authed_cloud),
                                  net: str = Depends(current_network)) -> Json:
    """What the last scan found, and whether one is still running.

    eero returns the list under `discovered_ssids`, as objects carrying an
    RSSI. Normalized here to one predictable shape: the interface was reading
    `ssids`, so a scan that had in fact completed showed nothing at all.
    """
    r = await c.get(f"2.2/networks/{_nid(net)}"
                    f"/backup_access_points/ssid_discovery") or {}
    raw = (r.get("discovered_ssids") or r.get("ssids")
           or r.get("networks") or [])
    found = []
    for x in raw:
        if isinstance(x, str):
            found.append({"ssid": x, "rssi": None})
        elif isinstance(x, dict) and x.get("ssid"):
            found.append({"ssid": x["ssid"], "rssi": x.get("rssi")})
    status = str(r.get("status") or "").lower()
    return {
        "status": status or "unknown",
        # Anything that is not a settled answer is treated as still running, so
        # a status eero adds later does not read as "finished with nothing".
        "running": status not in ("success", "failed", "error", ""),
        "ssids": found,
    }


@router.post("/local/backup-aps/check")
async def check_backup_connectivity(c: EeroCloud = Depends(authed_cloud),
                                    net: str = Depends(current_network)) -> Json:
    """Test that a saved backup network actually works, without failing over."""
    await c.post(f"2.2/networks/{_nid(net)}"
                 f"/backup_access_points/connectivity_check")
    return {"checking": True}


# --------------------------------------------------------------- subnets

@router.get("/network/subnets")
async def subnets(c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> list[Json]:
    """Separate networks that share the hardware, such as an IoT SSID."""
    r = await c.get(f"2.2/networks/{_nid(net)}/subnets_config")
    return EeroCloud.as_list(r, "subnets_config")


class Subnet(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)
    subnet_id: str | None = None
    enabled: bool = True
    open_network: bool = False
    password: str | None = None
    rate_limit_pct: int | None = Field(None, ge=1, le=100)


@router.put("/network/subnets")
async def save_subnet(body: Subnet, c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    if not body.open_network and not body.password and not body.subnet_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "a closed network needs a password")
    payload = body.model_dump(exclude_none=True)
    await c.put(f"2.2/networks/{_nid(net)}/subnets_config", json=payload)
    return {k: v for k, v in payload.items() if k != "password"}


@router.delete("/network/subnets/{subnet_type}")
async def delete_subnet(subnet_type: str,
                        c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    await c.delete(f"2.2/networks/{_nid(net)}/subnets_config/{subnet_type}")
    return {"deleted": subnet_type}


@router.get("/network/subnets/{subnet_id}/content-filters")
async def subnet_filters(subnet_id: str,
                         c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    return await c.get(f"2.2/networks/{_nid(net)}/subnets_config/"
                       f"{subnet_id}/dns_policies/content_filters")


class SubnetFilters(BaseModel):
    content_filters: Json


@router.put("/network/subnets/content-filters")
async def set_subnet_filters(body: SubnetFilters,
                             c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    return await c.put(
        f"2.2/networks/{_nid(net)}/subnets_config/dns_policies/content_filters",
        json={"content_filters": body.content_filters})


# ---------------------------------------------------------------- thread

async def _thread_url(c: EeroCloud, net: str) -> str:
    n = await c.follow(net)
    url = (n.get("resources") or {}).get("thread")
    if not url:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED,
                            "this network does not report a Thread border router")
    return url.lstrip("/")


SECRET_THREAD_FIELDS = ("master_key", "commissioning_credential",
                        "active_operational_dataset")


@router.get("/network/thread")
async def thread_network(c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """The Thread border router's settings, with the credentials withheld.

    The network key and commissioning credential are what a device needs to
    join the Thread network, so they are the equivalent of the Wi-Fi password
    and are not sent to the browser unless they are asked for by name.
    """
    t = await c.get(await _thread_url(c, net))
    out = {k: v for k, v in t.items() if k not in SECRET_THREAD_FIELDS}
    out["has_credentials"] = any(t.get(k) for k in SECRET_THREAD_FIELDS)
    return out


def _name_by_ip(clients: list[Json]) -> dict[str, Json]:
    """eero's clients keyed by every address they hold, for putting names to
    what mDNS finds.

    A departed client keeps its last lease, so a recycled address would put a
    dead client's name on a live device. Connected clients are indexed last so
    they win the key.
    """
    out: dict[str, Json] = {}
    for d in sorted(clients or [], key=lambda x: bool(x.get("connected"))):
        addrs = [d.get("ip")]
        addrs += [a.get("address") if isinstance(a, dict) else a
                  for a in (d.get("ipv6_addresses") or [])]
        for a in addrs:
            if isinstance(a, str) and a:
                out[a] = d
    return out

@router.get("/network/thread/credentials")
async def thread_credentials(c: EeroCloud = Depends(authed_cloud),
                             net: str = Depends(current_network)) -> Json:
    """The joining credentials, fetched only when explicitly requested."""
    t = await c.get(await _thread_url(c, net))
    return {k: t.get(k) for k in SECRET_THREAD_FIELDS}


class ThreadSettings(BaseModel):
    thread_enable: bool
    enable_credential_syncing: bool = False


@router.put("/network/thread")
async def set_thread(body: ThreadSettings,
                     c: EeroCloud = Depends(authed_cloud),
                     net: str = Depends(current_network)) -> Json:
    """Turning Thread on or off and changing credential syncing are two
    different eero endpoints, and conflating them is why the toggle did
    nothing. The on/off state is a PUT to {thread}/enable with {"enabled": …};
    the credential-syncing flag is a PUT to the thread object itself. Do the
    enable first (that is the switch the user actually flipped), then the
    settings object."""
    thread = await _thread_url(c, net)
    await c.put(f"{thread}/enable", json={"enabled": body.thread_enable})
    await c.put(f"2.2/networks/{_nid(net)}/thread",
                json={"thread_enable": body.thread_enable,
                      "enable_credential_syncing": body.enable_credential_syncing})
    return {"thread_enable": body.thread_enable,
            "enable_credential_syncing": body.enable_credential_syncing}


@router.post("/network/thread/regenerate")
async def regenerate_thread(confirm: str = "",
                            c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Issue a new Thread network key.

    Every Thread accessory on the network is joined with the old credentials
    and will drop off until it is re-paired by hand, one device at a time.
    There is no undo, so the caller has to say so explicitly.
    """
    if confirm != "regenerate":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "pass confirm=regenerate; this unpairs every Thread accessory")
    return await c.post(f"2.2/networks/{_nid(net)}/thread")


# ------------------------------------------------- notification preferences

# Which events eero will alert about. Distinct from the notification feed at
# /api/notifications, which is the list of alerts already sent; these are the
# switches deciding whether they get sent at all. Conflating the two is what
# hid this feature: both live under .../notifications, one with a suffix.
#
# The keys are eero's own, off the wire, and two of them do not look like the
# rest: `backup.internet.status.change` and `network.dataUsageReport`. Those
# were first read off the field names in eero's Android model class —
# backupNetworkUpdates, dataUsageReport — which are the names Kotlin uses, not
# the names the API uses; each field carries a @SerializedName saying what
# actually travels. Wrong keys meant every write sent names eero did not
# recognize and omitted ones it wanted, and eero refuses a partial form:
# `error.form.errors` on any change at all, including the one the New devices
# menu makes. They also read back as permanently off, since nothing in eero's
# reply ever matched.
#
# eero's object carries one more switch, `port.security.blocked`, for its
# wired port lockdown. That is Pro and business hardware, and eero's own app
# shows the row only behind a feature-availability flag, so it is left out
# here: not listed, and not written. eero keeps whatever it holds for it.
NOTIFICATION_PREFS: dict[str, str] = {
    "network.updated": "Firmware was installed",
    "network.scheduledUpdate.earlyNotification": "An update is coming up",
    "network.scheduledUpdate.lateNotification": "An update is due now",
    "device.new": "A device joined for the first time",
    "device.restrict.new.private": "A device joined using a private address",
    "backup.internet.status.change": "Backup internet took over or handed back",
    "network.dataUsageReport": "The usage report is ready",
    "permissions.updates": "Someone's access to the network changed",
    "premium.activity.weeklyReport": "The weekly eero Plus summary",
}


@router.get("/notifications/preferences")
async def notification_preferences(c: EeroCloud = Depends(authed_cloud),
                                   net: str = Depends(current_network)) -> Json:
    current = await c.get(f"2.2/networks/{_nid(net)}/notifications")
    return {"preferences": [
        {"key": k, "label": label, "enabled": bool(current.get(k))}
        for k, label in NOTIFICATION_PREFS.items()
    ]}


class NotificationPrefs(BaseModel):
    preferences: dict[str, bool]


@router.put("/notifications/preferences")
async def set_notification_preferences(body: NotificationPrefs,
                                       c: EeroCloud = Depends(authed_cloud),
                                       net: str = Depends(current_network)) -> Json:
    """eero replaces the whole object, so unknown keys would wipe real ones."""
    unknown = sorted(set(body.preferences) - set(NOTIFICATION_PREFS))
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"not notification settings: {unknown}")
    current = await c.get(f"2.2/networks/{_nid(net)}/notifications")
    merged = {k: bool(body.preferences.get(k, current.get(k)))
              for k in NOTIFICATION_PREFS}
    # `device.restrict.new.private` narrows `device.new` rather than replacing
    # it: it says alert about new devices, but only the ones arriving on a
    # private address. eero refuses the narrowing with nothing to narrow, and
    # says only `error.form.errors` — which is what reached anybody using the
    # New devices menu. Refused here instead, where the reason can be given.
    if merged["device.restrict.new.private"] and not merged["device.new"]:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "device.restrict.new.private narrows device.new, so it cannot be "
            "set while device.new is off")
    await c.put(f"2.2/networks/{_nid(net)}/notifications", json=merged)
    return {"preferences": merged}


# ------------------------------------------------------- IPv6 pinholes

# An IPv6 pinhole is the v6 counterpart to a port forward: there is no NAT to
# traverse, so instead of redirecting a port it punches a hole in the firewall
# straight through to a device's global address. Same consequence as a forward,
# and less obvious, because the device is then reachable from the entire
# internet rather than from whatever the gateway chose to map.


class Pinhole(BaseModel):
    device: str                      # the device's URL, as eero returns it
    port: str
    protocol: str = "tcp"
    # Neither of these reaches eero — it has no field for either. See
    # eeronaut/core/notes.py for where they are kept and why.
    #
    # Required all the same, and enforced here rather than only in the form:
    # a hole in the firewall with nothing said about it is one nobody can
    # audit later. eero keeps no description at all for a pinhole, so this is
    # the only record there will ever be of what it was opened for.
    description: str = Field(..., min_length=1, max_length=200)
    enabled: bool = True

    @field_validator("description")
    @classmethod
    def _said_something(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("a description is required")
        return v.strip()

    def payload(self) -> Json:
        if self.protocol not in ("tcp", "udp", "both"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "protocol must be tcp, udp, or both")
        ports = self.port.split("-") if "-" in self.port else [self.port]
        try:
            numbers = [int(x) for x in ports]
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "port must be a number or a low-high range")
        if not all(1 <= n <= 65535 for n in numbers):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "ports run from 1 to 65535")
        if len(numbers) == 2 and numbers[0] >= numbers[1]:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "the range has to start below where it ends")
        return {"device": self.device, "port": self.port,
                "protocol": self.protocol}


def _note_key(net: str, row: Json) -> str:
    return notes.key(net, str(row.get("device") or ""),
                     str(row.get("port") or ""),
                     str(row.get("protocol") or ""))


@router.get("/pinholes")
async def pinholes(c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> list[Json]:
    r = await c.get(f"{net.lstrip('/')}/ipv6/pinholes")
    live = EeroCloud.as_list(r, "pinholes")
    kept = notes.prune(net, (_note_key(net, row) for row in live))
    out: list[Json] = []
    for row in live:
        note = kept.get(_note_key(net, row)) or {}
        out.append({**row, "description": note.get("description", ""),
                    "enabled": True})
    # A pinhole this app is holding closed has no eero record to list, so it is
    # listed from here instead. Without this a disabled rule would simply
    # vanish, which is not what "disabled" means anywhere else in the app.
    # This network's held-closed rules only. Unscoped, a rule held closed on
    # one network was drawn as a rule on every network on the account.
    for k, note in kept.items():
        if not notes.belongs_to(k, net):
            continue
        if not note.get("disabled") or k in {_note_key(net, row) for row in live}:
            continue
        out.append({"url": f"disabled:{k}", "device": note.get("device", ""),
                    "port": note.get("port", ""),
                    "protocol": note.get("protocol", "tcp"),
                    "description": note.get("description", ""),
                    "enabled": False})
    return out


@router.post("/pinholes")
async def create_pinhole(body: Pinhole, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    r = await c.post(f"{net.lstrip('/')}/ipv6/pinholes", json=body.payload())
    notes.set_disabled(net, body.device, body.port, body.protocol, False)
    notes.describe(net, body.device, body.port, body.protocol, body.description)
    return r


@router.put("/pinholes/note")
async def describe_pinhole(body: Pinhole,
                           net: str = Depends(current_network)) -> Json:
    """The description, which lives here rather than at eero.

    Takes the network. Without it the description was filed under the rule
    alone, so it belonged to whichever network happened to ask — and every
    other network's copy was deleted the next time one of them loaded its list.
    """
    notes.describe(net, body.device, body.port, body.protocol, body.description)
    return {"device": body.device, "port": body.port,
            "protocol": body.protocol, "description": body.description}


class PinholeState(BaseModel):
    """A pinhole being opened or closed, identified rather than described.

    The same shape as `Pinhole` without the required description: this call
    names an existing rule by device, port, and protocol and flips it, and the
    description it already has is held locally and untouched. Demanding one
    here would mean a rule created before descriptions were required could
    never be turned off again.
    """
    device: str
    port: str
    protocol: str = "tcp"
    enabled: bool = True

    def payload(self) -> Json:
        return Pinhole(device=self.device, port=self.port,
                       protocol=self.protocol, description="-",
                       enabled=self.enabled).payload()


@router.put("/pinholes/state")
async def set_pinhole_state(body: PinholeState, c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Open or close a pinhole while keeping its label.

    eero has no disabled state for one, so off means closed. The record here
    is what lets it be reopened with the same port, protocol, and description.
    """
    if body.enabled:
        r = await c.post(f"{net.lstrip('/')}/ipv6/pinholes", json=body.payload())
        notes.set_disabled(net, body.device, body.port, body.protocol, False)
        return r
    live = EeroCloud.as_list(
        await c.get(f"{net.lstrip('/')}/ipv6/pinholes"), "pinholes")
    want = notes.key(net, body.device, body.port, body.protocol)
    for row in live:
        if _note_key(net, row) == want and row.get("url"):
            await c.delete(str(row["url"]).lstrip("/"))
    notes.set_disabled(net, body.device, body.port, body.protocol, True)
    return {"disabled": want}


class PinholeEdit(BaseModel):
    """A pinhole being changed, and what it used to be.

    The old identity is needed because the local record is keyed by device,
    port and protocol; editing any of them moves the record.

    `was` identifies and `now` describes, which is why they are different
    shapes. Requiring a description of `was` meant that giving a description to
    a rule that had none — the single most likely edit, and what the column's
    "Add description" placeholder invites — was refused, because the rule being
    replaced was the one with nothing to say.
    """
    was: PinholeState
    now: Pinhole


@router.put("/pinholes")
async def update_pinhole(body: PinholeEdit, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    payload = body.now.payload()          # validates before anything is written
    was, now = body.was, body.now
    live = EeroCloud.as_list(
        await c.get(f"{net.lstrip('/')}/ipv6/pinholes"), "pinholes")
    want = notes.key(net, was.device, was.port, was.protocol)
    url = next((str(row["url"]) for row in live
                if _note_key(net, row) == want and row.get("url")), None)
    if url:
        await c.put(url.lstrip("/"), json=payload)
    notes.move(net, (was.device, was.port, was.protocol),
               (now.device, now.port, now.protocol))
    notes.describe(net, now.device, now.port, now.protocol, now.description)
    # A pinhole held closed has no eero record, so editing it changes nothing
    # upstream and it stays closed.
    notes.set_disabled(net, now.device, now.port, now.protocol, not url)
    return {"updated": notes.key(net, now.device, now.port, now.protocol)}


@router.delete("/pinholes")
async def delete_pinhole(url: str, device: str = "", port: str = "",
                         protocol: str = "",
                         c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    # A pinhole being held closed exists only here, so there is nothing at eero
    # to delete; the synthetic url says so rather than being sent upstream.
    if not url.startswith("disabled:"):
        await c.delete(url.lstrip("/"))
    if device:
        notes.forget(net, device, port, protocol)
    return {"deleted": url}

# ----------------------------------------------- temporarily restrict to 2.4 GHz

HIDE_5G = "hide_5g"


@router.get("/network/band-pause")
async def band_pause(c: EeroCloud = Depends(authed_cloud),
                     net: str = Depends(current_network)) -> Json:
    """Whether 5 GHz and 6 GHz are currently held off the air.

    eero calls this a temporary flag rather than a setting, and it means it:
    the flag carries its own `expires_on` and the radios come back on their
    own. The expiry is eero's to decide — nothing in the request names a
    duration — so it is passed through rather than guessed at, and the
    interface counts down to whatever the server said.
    """
    n = await c.follow(net)
    flag = ((n.get("temporary_flags") or {}).get(HIDE_5G) or {})
    return {"paused": bool(flag.get("value")),
            "expires_on": flag.get("expires_on"),
            # How long a pause lasts, as last learned (see below), so the
            # switch can say "for N minutes" before one is set.
            "pause_minutes": Prefs.load().band_pause_minutes,
            # A network with only 2.4 and 5 GHz radios has nothing to say about
            # 6, and the label in the interface changes with it. eero publishes
            # this directly; the first version of this read the WPA3 capability
            # instead, which is true of plenty of hardware that has no 6 GHz
            # radio at all.
            "six_ghz": bool(((n.get("capabilities") or {})
                             .get("supports_6ghz") or {}).get("capable"))}


class BandPause(BaseModel):
    paused: bool


@router.put("/network/band-pause")
async def set_band_pause(body: BandPause, c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """Restrict the network to 2.4 GHz, or lift the restriction.

    Form-encoded, not JSON: the Android app's own call for this is
    `@FormUrlEncoded` with a single `value` field, and eero rejects a JSON body
    here. Clearing is a DELETE of the flag rather than a write of false —
    writing false leaves the flag in place with an expiry still ticking.
    """
    nid = _nid(net)
    if body.paused:
        await c.put(f"2.2/networks/{nid}/temporary_flags/{HIDE_5G}",
                    data={"value": "true"})
    else:
        await c.request("DELETE", f"2.2/networks/{nid}/temporary_flags/{HIDE_5G}")
    out = await band_pause(c, net)
    # How long eero gave it, learned at the moment it was set: the request
    # names no duration and nothing eero publishes says one ahead of time, so
    # the only place the figure exists is the expiry that comes back now. Kept
    # in the preferences so the switch can say "for N minutes" next time.
    if body.paused and out.get("expires_on"):
        try:
            ends = datetime.fromisoformat(str(out["expires_on"]).replace("Z", "+00:00"))
            secs = (ends - datetime.now(timezone.utc)).total_seconds()
            if secs > 0:
                minutes = max(1, round(secs / 60))
                out["duration_minutes"] = out["pause_minutes"] = minutes
                p = Prefs.load()
                if p.band_pause_minutes != minutes:
                    p.band_pause_minutes = minutes
                    p.save()
        except ValueError:
            pass
    return out

