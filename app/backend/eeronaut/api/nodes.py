"""Per-node actions and notifications, via eero's cloud.

The local channel covers reboot and status without the internet; these are the
cloud equivalents, plus the things only the cloud knows about — firmware
updates, notification history, and the people who share the network.
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..clients.cloud import EeroCloud
from ..core import nodecache, outages
from ..core.errors import UpstreamError
from .deps import authed_cloud, current_network

router = APIRouter(prefix="/api", tags=["nodes"])
Json = dict[str, Any]


class Confirm(BaseModel):
    # Destructive calls echo the target back, so a stray request cannot fire.
    confirm: str


@router.post("/eeros/{eero_id}/reboot")
async def reboot_node(eero_id: str, body: Confirm,
                      c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Reboot through the cloud. Drops every client on that node.

    Prefer the local channel when it is available: this path needs eero's cloud
    to be reachable, which is exactly what is missing during an outage.
    """
    if body.confirm != eero_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "confirmation does not match")
    await c.post(f"2.2/eeros/{eero_id}/reboot", json={})
    return {"rebooted": eero_id, "at": time.time()}


@router.delete("/eeros/{eero_id}")
async def remove_node(eero_id: str, confirm: str,
                      c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """Take an eero off the network.

    `DELETE` on the eero's own resource, which is what eero's app calls — its
    `deleteEero` takes the eero's URL rather than an id.

    The gateway is refused. eero's own screen for this is named
    `RemoveLeafEero`, and the reason is plain: deleting the eero that holds the
    internet connection takes the network down with it, and there is then no
    network left to add it back through. A leaf can be removed and re-added; the
    gateway is a different operation with a different recovery.

    There is a second path for this on the local plane
    (`DELETE /api/local/nodes/{serial}`), but it needs the node to answer. This
    one goes through the cloud, so it still works on an eero that has stopped
    responding — which is most of the reason anybody removes one.
    """
    if confirm != eero_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "confirmation does not match")
    e = await c.get(f"2.2/eeros/{eero_id}")
    if e.get("gateway"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This eero is the gateway. Removing it would take the network "
            "down, and eero's own app does not offer it either.")
    await c.delete(e.get("url") or f"2.2/eeros/{eero_id}")
    return {"removed": eero_id, "location": e.get("location"), "at": time.time()}


_HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class NightlightSchedule(BaseModel):
    enabled: bool = False
    on: str = Field("20:00", pattern=_HHMM)
    off: str = Field("06:00", pattern=_HHMM)


class Nightlight(BaseModel):
    """The ambient nightlight on Beacons, which is not the status LED.

    Two separate things share the word "light" on an eero. The status LED is
    `led_on` and `led_brightness` on the eero itself, and every model has one.
    The nightlight is a downward-facing lamp that only Beacons have, it can run
    on a schedule, and eero keeps it in its own object.
    """
    enabled: bool
    brightness_percentage: int | None = Field(None, ge=0, le=100)
    schedule: NightlightSchedule | None = None


@router.get("/eeros/{eero_id}/nightlight")
async def get_nightlight(eero_id: str,
                         c: EeroCloud = Depends(authed_cloud)) -> Json:
    """The current nightlight settings, read from the eero object.

    There is no readable `nightlight/settings` resource — that path is
    write-only, and a GET against it returns 404 on every node, Beacon or not.
    eero carries the current settings as a `nightlight` field on the eero
    itself, which is where its own app reads them from.
    """
    e = await c.get(f"2.2/eeros/{eero_id}")
    nl = (e or {}).get("nightlight")
    if not isinstance(nl, dict):
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "this eero has no nightlight")
    return nl


@router.put("/eeros/{eero_id}/nightlight")
async def set_nightlight(eero_id: str, body: Nightlight,
                         c: EeroCloud = Depends(authed_cloud)) -> Json:
    payload = body.model_dump(exclude_none=True)
    return await c.put(f"2.2/eeros/{eero_id}/nightlight/settings", json=payload)


class NightlightPreview(BaseModel):
    brightness_percentage: int = Field(..., ge=0, le=100)


@router.post("/eeros/{eero_id}/nightlight/preview")
async def preview_nightlight(eero_id: str, body: NightlightPreview,
                             c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Light the nightlight at a brightness without saving it.

    Form-encoded with a single field, which is what the override endpoint
    takes; sending it JSON does nothing.
    """
    await c.post(f"2.2/eeros/{eero_id}/nightlight/override",
                 data={"brightness_percentage": body.brightness_percentage})
    return {"previewing": body.brightness_percentage}


@router.post("/eeros/{serial}/identify")
async def identify_node(serial: str, c: EeroCloud = Depends(authed_cloud)) -> Json:
    """Flash a node's LED so you can tell which physical unit it is.

    Form-encoded with a color list, a total duration, and a dwell time per
    color; an empty JSON body is accepted and does nothing. The values match
    what the app sends when you tap "identify".
    """
    await c.post(f"2.2/eeros/{serial}/led_cycle",
                 data={"colors[]": ["blue", "white"],
                       "duration": "10", "time_per_color": "1"})
    return {"identifying": serial}


class NodeName(BaseModel):
    location: str = Field(..., min_length=1, max_length=64)


@router.put("/eeros/{eero_id}/name")
async def rename_node(eero_id: str, body: NodeName,
                      c: EeroCloud = Depends(authed_cloud)) -> Json:
    """An eero's name is its `location` — where in the house it sits."""
    await c.put(f"2.2/eeros/{eero_id}", data={"location": body.location})
    return {"location": body.location}


class Led(BaseModel):
    on: bool | None = None
    brightness: int | None = Field(None, ge=0, le=100)


@router.put("/eeros/{eero_id}/led")
async def set_led(eero_id: str, body: Led,
                  c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    """The status light: on or off, and how bright.

    The light is its own sub-resource, `/2.2/eeros/{id}/led` — the address eero
    itself publishes as `resources.led_action` on the eero object. Writing the
    same fields to the eero object instead returns 200 and changes nothing,
    which is how this went unnoticed: the call looked like it worked, the light
    stayed as it was, and the next read put the old value back in the menu.

    Separate form-encoded fields upstream rather than one object, so they are
    sent as separate calls. Sequentially, because two writes to the same light
    in flight at once do not both land.
    """
    done: Json = {}
    url = await _led_url(c, eero_id)
    if body.on is not None:
        await c.put(url, data={"led_on": str(body.on).lower()})
        done["on"] = body.on
    if body.brightness is not None:
        await c.put(url, data={"led_brightness": body.brightness})
        done["brightness"] = body.brightness
    if not done:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing to change")
    # The local pages read node state from the cache, not the cloud, so it has
    # to learn about this or the menu reverts on the next refresh.
    nodecache.set_led_state(nodecache.network_key(net), eero_id,
                            on=body.on, brightness=body.brightness)
    return done


async def _led_url(c: EeroCloud, eero_id: str) -> str:
    """Prefer the address eero publishes for this eero's light.

    Falls back to the conventional path when the resources block is missing, so
    a node that does not advertise it is still controllable.
    """
    try:
        e = await c.get(f"2.2/eeros/{eero_id}")
        url = ((e or {}).get("resources") or {}).get("led_action")
        if isinstance(url, str) and url.strip():
            return url.lstrip("/")
    except Exception:
        pass
    return f"2.2/eeros/{eero_id}/led"


BACKUP_CATEGORY = "backup.internet.status.change"


async def _carrying_now(c: EeroCloud, net: str) -> Json | None:
    """Which backup is holding the network up, and what the primary is doing.

    eero's own notification says only that it "detected an internet outage and
    switched to backup" — not which of the two backups took over, and not what
    the outage was. Both are knowable while it is happening: the Signal says
    whether it is carrying, the gateway reports the WAN type it is actually
    using, and the WAN state names the fault.

    None when the primary is up, because then there is nothing to say. Nothing
    here is inferred for a past event: an outage that ended left no record of
    which backup ran, and guessing would be worse than silence.
    """
    try:
        n = await c.follow(net)
    except Exception:                                        # noqa: BLE001
        return None
    cell = n.get("cellular_backup") or {}
    # "off" is eero's word for standing by. Anything else means it is up.
    cell_live = bool(cell.get("dsn")) and str(
        cell.get("status") or "off").lower() not in ("off", "standby", "")

    # The cheap question first. Every page load reads notifications, and
    # walking the nodes over gRPC to confirm what the cloud has already said
    # is fine would put a second or two on all of them.
    healthy = ((n.get("health") or {}).get("internet") or {}
               ).get("status") == "connected"
    if healthy and not cell_live:
        return None

    state = None
    wan_type = None
    try:                                  # Local only: it answers with the WAN down.
        from .local import network_status
        ns = await network_status()
        wan = (ns or {}).get("wan") or {}
        wan_type = wan.get("type")
        ifaces = wan.get("interfaces") or []
        state = (ifaces[0] or {}).get("state") if ifaces else None
    except Exception:                                        # noqa: BLE001
        pass

    if state == "ONLINE" and not cell_live:
        return None

    if cell_live:
        which = "cellular"
    elif wan_type and wan_type != "wired":
        # The gateway is using something other than the wired port, which on
        # this network can only be a saved hotspot.
        which = "hotspot"
    else:
        which = "unknown"
    return {"active": which,
            "model": cell.get("model") if which == "cellular" else None,
            "wan_state": state,
            "wan_type": wan_type}


def _device_mac(n: Json) -> str | None:
    """The MAC of the device a notification is about, where it names one.

    A new-device notification carries `meta.device_url`, which ends in the
    device's MAC without separators (`.../devices/02005e0000a1`). The
    interface opens that client's drawer from it."""
    url = str(((n.get("meta") or {}).get("device_url")) or "")
    tail = url.rstrip("/").split("/")[-1].lower()
    if len(tail) != 12 or any(ch not in "0123456789abcdef" for ch in tail):
        return None
    return ":".join(tail[i:i + 2] for i in range(0, 12, 2))


@router.get("/notifications")
async def notifications(c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    nid = net.rstrip("/").split("/")[-1]
    try:
        history = await c.get(f"2.2/networks/{nid}/notifications_history")
    except UpstreamError:
        history = {}
    try:
        unread = await c.get(f"2.2/networks/{nid}/notifications/has_unread")
    except UpstreamError:
        unread = {}
    items = c.as_list(history, "notifications")
    out = [
        # eero identifies an item by `uuid`; there is no `id` on them.
        {"id": n.get("uuid") or n.get("id"), "title": n.get("title"), "body": n.get("body"),
         "category": n.get("category"), "created": n.get("created_at")
         or n.get("timestamp"), "read": bool(n.get("read")),
         "device_mac": _device_mac(n)}
        for n in items]

    # Every backup event gets whatever was written down while it was
    # happening. This used to enrich only the newest one and only while a
    # backup was still carrying, which meant an outage that had ended — every
    # outage anybody ever reads about — carried nothing at all.
    paired: dict[str, list[Json]] = {}
    for n in out:
        if n["category"] != BACKUP_CATEGORY:
            continue
        seen = outages.covering(net, n.get("created"))
        if seen:
            n["backup"] = {"active": seen.get("backup"),
                           "model": seen.get("model"),
                           "wan_state": seen.get("wan_state"),
                           "wan_type": seen.get("wan_type"),
                           "started": seen.get("started"),
                           "ended": seen.get("ended"),
                           "observed": True}
            paired.setdefault(str(seen.get("started")), []).append(n)

    # One outage, two notifications: eero raises one when the backup takes
    # over and another when the primary comes back. Both fall inside the same
    # record, so both were being handed the whole of it — and "the primary is
    # active again: DNS failure, cellular backup" reads as though something is
    # still wrong and something is still carrying. None of it belongs to the
    # recovery notice: the fault and the backup that stood in for it are both
    # what the earlier notification is announcing, and by the time the second
    # one is raised neither is true any more.
    #
    # Decided by pairing rather than by comparing the notification's time to
    # the end of the outage: the end is when this machine noticed, up to a
    # minute after eero did, so the recovery notice can be stamped before it.
    for group in paired.values():
        for n in sorted(group, key=lambda x: x.get("created") or "")[1:]:
            n.pop("backup", None)
    # And the newest one prefers what is true right now, which is better than
    # a record because it cannot be stale.
    newest = next((x for x in out if x["category"] == BACKUP_CATEGORY), None)
    if newest is not None:
        carrying = await _carrying_now(c, net)
        if carrying:
            newest["backup"] = {**(newest.get("backup") or {}), **carrying}
    return {
        "has_unread": bool((unread or {}).get("has_unread")),
        "count": len(items),
        "notifications": out,
    }


@router.post("/notifications/read")
async def mark_notifications_read(c: EeroCloud = Depends(authed_cloud),
                                  net: str = Depends(current_network)) -> Json:
    nid = net.rstrip("/").split("/")[-1]
    await c.post(f"2.2/networks/{nid}/notifications/mark_read", json={})
    return {"marked": True}


@router.get("/members")
async def members(c: EeroCloud = Depends(authed_cloud),
                  net: str = Depends(current_network)) -> Json:
    """People who share access to this network."""
    nid = net.rstrip("/").split("/")[-1]
    try:
        people = c.as_list(await c.get(f"2.2/networks/{nid}/members"), "members")
    except UpstreamError:
        people = []
    return {"count": len(people),
            "members": [{"name": m.get("user_name") or m.get("name"),
                         "role": m.get("user_role") or m.get("role"),
                         "is_you": "is_me" in (m.get("user_tags") or [])}
                        for m in people]}


@router.post("/speedtests/run")
async def run_speed_test(c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """Start a speed test.

    Saturates the WAN link for its duration, so anything latency-sensitive on
    the network will notice. Results appear in the history once it finishes.
    """
    await c.post(f"{net}/speedtest", json={})
    return {"started": True, "at": time.time()}
