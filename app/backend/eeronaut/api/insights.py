"""Speed test history, data usage, and security insights.

All of this is cloud-side: eero aggregates it centrally and the local channel
has no equivalent. Every endpoint takes a window in days rather than raw
timestamps, since that is what the interface actually asks for.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, Query

from ..clients.cloud import EeroCloud
from ..core.errors import UpstreamError
from .deps import authed_cloud, current_network

router = APIRouter(prefix="/api/insights", tags=["insights"])
Json = dict[str, Any]

# Types eero accepts vary by network and subscription; the rest return
# error.form.errors. Unsupported ones are reported rather than hidden, so the
# interface can say "not available here" instead of silently showing nothing.
INSIGHT_TYPES = ("inspected", "blocked", "adblock", "filtered")


def _window(days: int) -> tuple[str, str]:
    now = dt.datetime.now(dt.timezone.utc)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return (now - dt.timedelta(days=days)).strftime(fmt), now.strftime(fmt)


@router.get("/speedtests")
async def speedtests(limit: int = Query(30, ge=1, le=200),
                     days: int | None = Query(None, ge=1, le=400),
                     c: EeroCloud = Depends(authed_cloud),
                     net: str = Depends(current_network)) -> Json:
    """Historical speed tests, newest first as eero returns them.

    `days` asks for a window instead of a count, which is the question the
    history chart is actually asking — eero takes `startTime` and `endTime`,
    as its own app does. A count is still right for the dashboard, which wants
    the last few whenever they happened.

    Either way eero returns at most 100, whatever is asked of it: measured at
    limit=1000 and again over a year's window. On the network this was built
    against that ceiling is only reached past six months, so the windows this
    interface offers are served whole.
    """
    params: Json = {"limit": limit}
    if days is not None:
        now = dt.datetime.now(dt.timezone.utc)
        fmt = "%Y-%m-%dT%H:%M:%SZ"
        params = {"limit": 200,
                  "startTime": (now - dt.timedelta(days=days)).strftime(fmt),
                  "endTime": now.strftime(fmt)}
    data = await c.get(f"{net}/speedtest", params=params)
    tests = [{"date": t.get("date"),
              "down_mbps": t.get("down_mbps"),
              "up_mbps": t.get("up_mbps")} for t in (data or [])]
    downs = [t["down_mbps"] for t in tests if t["down_mbps"] is not None]
    ups = [t["up_mbps"] for t in tests if t["up_mbps"] is not None]
    return {
        "count": len(tests),
        "latest": tests[0] if tests else None,
        "best_down": max(downs) if downs else None,
        "best_up": max(ups) if ups else None,
        "median_down": sorted(downs)[len(downs) // 2] if downs else None,
        "median_up": sorted(ups)[len(ups) // 2] if ups else None,
        "tests": tests,
    }


@router.get("/usage")
async def usage(days: int = Query(7, ge=1, le=90),
                cadence: str = Query("daily", pattern="^(daily|hourly)$"),
                timezone: str = "UTC",
                c: EeroCloud = Depends(authed_cloud),
                net: str = Depends(current_network)) -> Json:
    """Upload and download over time."""
    start, end = _window(days)
    data = await c.get(f"{net}/data_usage",
                       params={"start": start, "end": end,
                               "cadence": cadence, "timezone": timezone})
    series = {s.get("type"): {"total_bytes": s.get("sum"),
                              "points": [{"t": v.get("time"), "bytes": v.get("value")}
                                         for v in (s.get("values") or [])]}
              for s in (data or {}).get("series", [])}
    return {"start": (data or {}).get("start"), "end": (data or {}).get("end"),
            "cadence": cadence, "series": series}


@router.get("/usage/breakdown")
async def usage_breakdown(days: int = Query(7, ge=1, le=90),
                          top: int = Query(15, ge=1, le=100),
                          timezone: str = "UTC",
                          c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    """Totals for the window plus the heaviest clients."""
    start, end = _window(days)
    d = await c.get(f"{net}/data_usage/breakdown",
                    params={"start": start, "end": end, "timezone": timezone})
    devices = sorted(
        ({"name": (x.get("nickname") or x.get("display_name")
                   or x.get("hostname") or "Unknown device"),
          "mac": x.get("mac"),
          "manufacturer": x.get("manufacturer"),
          "connection": x.get("connection_type"),
          "download": x.get("download") or 0,
          "upload": x.get("upload") or 0,
          "total": (x.get("download") or 0) + (x.get("upload") or 0)}
         for x in (d or {}).get("devices") or []),
        key=lambda x: x["total"], reverse=True)
    return {
        "download": (d or {}).get("download") or 0,
        "upload": (d or {}).get("upload") or 0,
        "device_count": len(devices),
        "devices": devices[:top],
    }


@router.get("/device/{mac}/usage")
async def device_usage(mac: str, days: int = Query(7, ge=1, le=90),
                       cadence: str = Query("daily", pattern="^(daily|hourly)$"),
                       timezone: str = "UTC",
                       c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Data transferred by one client over the window."""
    start, end = _window(days)
    d = await c.get(f"{net}/data_usage/devices/{mac}",
                    params={"start": start, "end": end,
                            "cadence": cadence, "timezone": timezone})
    series = {s.get("type"): {"total_bytes": s.get("sum"),
                              "points": [{"t": v.get("time"), "bytes": v.get("value")}
                                         for v in (s.get("values") or [])]}
              for s in (d or {}).get("series", [])}
    return {"cadence": cadence, "series": series}


@router.get("/device/{mac}/security")
async def device_security(mac: str, days: int = Query(7, ge=1, le=90),
                          c: EeroCloud = Depends(authed_cloud),
                          net: str = Depends(current_network)) -> Json:
    start, end = _window(days)
    out: dict[str, Any] = {}
    for t in INSIGHT_TYPES:
        try:
            d = await c.get(f"{net}/insights/devices/{mac}",
                            params={"start": start, "end": end,
                                    "cadence": "daily", "insight_type": t})
        except UpstreamError:
            out[t] = None
            continue
        series = ((d or {}).get("series") or [{}])[0]
        out[t] = series.get("sum") or 0
    return {"types": out}


@router.get("/security")
async def security_insights(days: int = Query(7, ge=1, le=90),
                            cadence: str = Query("daily", pattern="^(daily|hourly)$"),
                            c: EeroCloud = Depends(authed_cloud),
                            net: str = Depends(current_network)) -> Json:
    """Counts per insight type over the window.

    Types eero rejects for this network are reported as unsupported rather than
    dropped, so the interface can distinguish "nothing happened" from
    "not measured here".
    """
    start, end = _window(days)
    out: dict[str, Any] = {}
    for t in INSIGHT_TYPES:
        try:
            d = await c.get(f"{net}/insights",
                            params={"start": start, "end": end,
                                    "cadence": cadence, "insight_type": t})
        except UpstreamError:
            out[t] = {"supported": False, "total": None, "points": []}
            continue
        series = ((d or {}).get("series") or [{}])[0]
        out[t] = {
            "supported": True,
            "total": series.get("sum") or 0,
            "points": [{"t": v.get("time"), "value": v.get("value")}
                       for v in (series.get("values") or [])],
        }
    return {"start": start, "end": end, "cadence": cadence, "types": out}
