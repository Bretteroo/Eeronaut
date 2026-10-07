"""Content filtering, blocked domains, and applications, and eero Secure."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from ..clients.cloud import EeroCloud
from ..core.labels import clean_domain
from ..core.capabilities import (parse as parse_caps, is_premium,
                                 apply_subscription, entitled_capabilities)
from .deps import authed_cloud, current_network

router = APIRouter(prefix="/api/security", tags=["security"])
Json = dict[str, Any]


async def _require_entitlement(c: EeroCloud, net: str, name: str) -> None:
    """Refuse a write to a feature this network is not entitled to.

    The entitlements feed is the authority on what a network may use, so this
    interface asks it before writing rather than assuming. A feature that
    belongs to a paid tier is not offered to a network that has not paid for
    it, in the interface or at the API.

    Fails open only when the entitlement itself cannot be read — refusing on a
    network error would break the feature for people who do pay.
    """
    try:
        n = await c.follow(net)
        caps = apply_subscription(parse_caps(n.get("capabilities")), is_premium(n),
                                  await _entitlements(c, net))
    except HTTPException:
        raise
    except Exception:
        return
    cap = caps.get(name)
    if cap is not None and not cap.available and cap.primary_reason is not None \
            and cap.primary_reason.value == "subscription":
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            "This network has no eero Plus subscription, and blocked and "
            "allowed domain lists are part of it.")


async def _entitlements(c: EeroCloud, net: str) -> set[str] | None:
    try:
        return entitled_capabilities(await c.entitlements(net))
    except Exception:
        return None


@router.get("/overview")
async def overview(c: EeroCloud = Depends(authed_cloud),
                   net: str = Depends(current_network)) -> Json:
    n = await c.follow(net)
    pd = n.get("premium_dns") or {}
    try:
        entitled = entitled_capabilities(await c.entitlements(net))
    except Exception:
        entitled = None
    caps = apply_subscription(parse_caps(n.get("capabilities")), is_premium(n), entitled)

    def cap(name: str) -> Json:
        x = caps.get(name)
        return ({"available": True, "reason": None, "explanation": ""} if not x
                else x.as_dict())

    return {
        "premium_status": n.get("premium_status"),
        "dns_provider": pd.get("dns_provider"),
        "policies_enabled": pd.get("any_policies_enabled_for_network"),
        "block_malware": (pd.get("dns_policies") or {}).get("block_malware"),
        "ad_block": {
            "enabled": (pd.get("ad_block_settings") or {}).get("enabled"),
            "profiles": (pd.get("ad_block_settings") or {}).get("profiles") or [],
        },
        "advanced_content_filters": pd.get("advanced_content_filters"),
        # Gating metadata so the UI can gray the right controls for the right
        # reason without a second round trip.
        "capabilities": {k: cap(k) for k in (
            "ad_block", "block_apps", "dnsfilter_blocklist", "dnsfilter_allowlist",
            "dnsfilter_threat_categories", "advanced_security", "safe_search",
        )},
    }


class DomainRule(BaseModel):
    domain: str = Field(..., min_length=1, max_length=253)
    keep_profiles: bool = True

    @field_validator("domain")
    @classmethod
    def _clean(cls, v: str) -> str:
        return clean_domain(v)


@router.get("/domains")
async def list_domains(c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    """Blocked and allowed domain rules.

    eero returns entries as objects keyed `domain_name`, with the profiles the
    rule applies to. Normalized here so the interface has one predictable shape
    rather than reaching into eero's field names.
    """
    d = await c.get(f"{net}/dns_policies/advanced_content_filter")

    def norm(items: Any) -> list[Json]:
        out = []
        for x in items or []:
            if isinstance(x, str):
                out.append({"domain": x, "network_wide": True, "profiles": []})
            elif isinstance(x, dict):
                out.append({
                    "domain": x.get("domain_name") or x.get("domain") or "",
                    "network_wide": bool(x.get("applied_to_network")),
                    # Flattened to name/url so a caller can match a rule to a
                    # profile without knowing eero's field names.
                    "profiles": [
                        {"name": pf.get("profile_name"),
                         "url": pf.get("profile_url")}
                        for pf in (x.get("profile_list") or [])
                        if isinstance(pf, dict)],
                })
        return [x for x in out if x["domain"]]

    return {"blocked": norm((d or {}).get("blocked_list")),
            "allowed": norm((d or {}).get("allowed_list"))}


@router.put("/domains/blocked")
async def block_domain(body: DomainRule, c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    await _require_entitlement(c, net, "dnsfilter_blocklist")
    return await c.put(f"{net}/dns_policies/network/blocked",
                       json={"domain": body.domain, "is_delete": False,
                             "keep_profiles": body.keep_profiles})


@router.delete("/domains/blocked")
async def unblock_domain(domain: str, keep_profiles: bool = True,
                         c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    """Removal is the same PUT with is_delete set; eero has no DELETE here."""
    await _require_entitlement(c, net, "dnsfilter_blocklist")
    return await c.put(f"{net}/dns_policies/network/blocked",
                       json={"domain": domain, "is_delete": True,
                             "keep_profiles": keep_profiles})


@router.put("/domains/allowed")
async def allow_domain(body: DomainRule, c: EeroCloud = Depends(authed_cloud),
                       net: str = Depends(current_network)) -> Json:
    await _require_entitlement(c, net, "dnsfilter_allowlist")
    return await c.put(f"{net}/dns_policies/network/allowed",
                       json={"domain": body.domain, "is_delete": False,
                             "keep_profiles": body.keep_profiles, "add_cname": True})


@router.delete("/domains/allowed")
async def unallow_domain(domain: str, keep_profiles: bool = True,
                         c: EeroCloud = Depends(authed_cloud),
                         net: str = Depends(current_network)) -> Json:
    await _require_entitlement(c, net, "dnsfilter_allowlist")
    return await c.put(f"{net}/dns_policies/network/allowed",
                       json={"domain": domain, "is_delete": True,
                             "keep_profiles": keep_profiles, "add_cname": False})


class AdBlock(BaseModel):
    enabled: bool
    profiles: list[str] = Field(default_factory=list)


@router.put("/adblock")
async def set_adblock(body: AdBlock, c: EeroCloud = Depends(authed_cloud),
                      net: str = Depends(current_network)) -> Json:
    """Network-wide ad and tracker blocking at the DNS layer.

    Requires an eero Plus subscription; without one eero rejects the call and
    the interface grays the control rather than letting it fail silently.
    """
    # The app POSTs to {network}/dns_policies/adblock; the /adblock_settings
    # path this used before is not a real endpoint and did nothing.
    # AdBlockSettingsRequest names the field "enable", not "enabled". Sending
    # the wrong key is accepted and ignored, so the toggle does nothing.
    await c.post(f"{net.rstrip('/')}/dns_policies/adblock",
                 json={"enable": body.enabled, "profiles": body.profiles})
    return {"enabled": body.enabled}


class AdvancedSecurity(BaseModel):
    enabled: bool


@router.put("/advanced-security")
async def set_advanced_security(body: AdvancedSecurity,
                                c: EeroCloud = Depends(authed_cloud),
                                net: str = Depends(current_network)) -> Json:
    """eero Secure's advanced security: block known malicious and phishing
    sites at the DNS layer (the block_malware policy). Requires eero Plus."""
    # Form-encoded, flat: the endpoint takes a @FieldMap of policy slug ->
    # boolean, not a nested JSON document. A JSON body is accepted and
    # silently ignored, which is why the toggle appeared to do nothing.
    await c.post(f"{net.rstrip('/')}/dns_policies/network",
                 data={"block_malware": str(body.enabled).lower()})
    return {"enabled": body.enabled}


class ContentFilters(BaseModel):
    """Per-subnet content categories.

    Names come from eero's own policy object rather than being invented here,
    so they keep meaning if eero adds categories.
    """
    subnet_id: str | None = None
    block_pornographic_content: bool | None = None
    block_violent_content: bool | None = None
    block_illegal_content: bool | None = None
    block_gaming_content: bool | None = None
    block_social_content: bool | None = None
    block_streaming_content: bool | None = None
    block_shopping_content: bool | None = None
    block_messaging_content: bool | None = None
    safe_search_enabled: bool | None = None
    youtube_restricted: bool | None = None


@router.put("/content-filters")
async def set_content_filters(body: ContentFilters,
                              c: EeroCloud = Depends(authed_cloud),
                              net: str = Depends(current_network)) -> Json:
    nid = net.rstrip("/").split("/")[-1]
    payload = {k: v for k, v in body.model_dump().items()
               if v is not None and k != "subnet_id"}
    if not payload:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "no filters supplied")
    doc: Json = {"dns_policies": payload}
    if body.subnet_id:
        doc["subnet_id"] = body.subnet_id
    await c.put(f"2.2/networks/{nid}/subnets_config/dns_policies/content_filters",
                json=doc)
    return payload


@router.get("/filter-levels")
async def filter_levels(scope: str = "profile",
                        c: EeroCloud = Depends(authed_cloud),
                        net: str = Depends(current_network)) -> Json:
    """The content-filter catalog: eero's preset levels and, with them, the
    name and explanation of every individual filter.

    The `safeFilterType` query is what makes eero return the `categories`
    block. Without it the response carries only policy slugs, which is why the
    titles used to be guessed at from the phone app's string table and came out
    wrong — "Adult" where eero says "Adult Content", and no YouTube Restricted
    entry at all. These are the same strings the phone app displays.
    """
    kind = "SubnetFilter" if scope == "subnet" else "ProfileFilter"
    d = await c.get(f"{net}/safe_filter_levels",
                    params={"safeFilterType": kind})
    return d or {}
