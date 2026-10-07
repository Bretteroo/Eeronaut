"""Interpret eero's per-network capability map.

Each network object carries a ``capabilities`` dict of roughly 118 entries:

    "vlan": {"capable": true, "requirements": {"has_gateway": true,
                                               "has_minimum_firmware": true}}

The value of this structure is that it says *why* something is unavailable, so
the interface can explain the reason rather than silently graying a control out.
Requirement keys are classified into reason categories below.

A caution about mobile-version requirements: eero computes them from the client
version it parses out of the User-Agent. If the client does not present a
version the API recognizes, every such check fails and roughly a third of the
capability map reads as unsupported. The fix is to send a parseable agent (see
``Settings.effective_user_agent``), not to ignore the requirement here.
``mobile_gate_only`` therefore signals a probable client-identification problem
worth logging, and ``ignore_mobile_gates`` defaults to False.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any


class Reason(str, Enum):
    SUBSCRIPTION = "subscription"   # needs eero Plus / Secure
    HARDWARE     = "hardware"       # node model doesn't support it
    FIRMWARE     = "firmware"       # node firmware too old
    MOBILE_APP   = "mobile_app"     # eero's app version gate; not relevant to us
    NETWORK_MODE = "network_mode"   # bridged, connection mode, network type
    ROLE         = "role"           # not the owner / insufficient role
    REGION       = "region"         # country or location restriction
    ROLLOUT      = "rollout"        # feature flag / group / A-B rollout
    OTHER        = "other"


_PATTERNS: tuple[tuple[re.Pattern[str], Reason], ...] = (
    # Order matters: the first match wins. The mobile-app gate is checked
    # before the generic version patterns so it is not mistaken for firmware.
    (re.compile(r'min_mobile_version|mobile_version'),         Reason.MOBILE_APP),
    (re.compile(r'premium|secure_plus|subscription|business_license|'
                r'available_seats|datapack|data_plan'),        Reason.SUBSCRIPTION),
    (re.compile(r'hardware|gateway_model|supported_eeros|supported_gateway|'
                r'supported_leaf|has_gateway|gateway_capable|certified_gateway|'
                r'gateway_kilimanjaro|gateway_node_eligible|retrograde|vega|'
                r'border|has_nodes|wifi_nodes|wifi_capable|thread_network_capable|'
                r'ipv6_capable|access_point_capable|bifrost|account_linking_capable|'
                r'business_ready'),                            Reason.HARDWARE),
    (re.compile(r'firmware|min_version|node_version|_version|legacy_network|'
                r'compatible_with_v'),                         Reason.FIRMWARE),
    (re.compile(r'bridge|connection_mode|network_type|is_retail_network|'
                r'custom_mode|wireless_mode|internet_backup|primary_wan|'
                r'isp_managed'),                               Reason.NETWORK_MODE),
    (re.compile(r'countr(y|ies)|location|service_area|exclusion_list'), Reason.REGION),
    (re.compile(r'owner|role|org|owned_network_count|network_count|'
                r'user_state|retail_user|auth_method'),        Reason.ROLE),
    (re.compile(r'feature_flag|enabled_groups|allowed_group|enabled_group|'
                r'is_enabled|is_feature_enabled|throttle|enabled_for_network|'
                r'feature_enabled|decoupled|adblock_group|is_active|'
                r'upgrade_enabled|partner_app|^enabled$'),      Reason.ROLLOUT),
)


# Wording that beats the generic reason label for a specific feature. Only
# consulted for hardware/firmware gating, where the generic text can mislead.
#
# "Your eero hardware does not support this" is true of every one of these and
# useful for none of them: it does not say which eero, or what about it, or
# whether anything could change the answer. Each entry below says the thing
# somebody could act on. `{gateway}` is filled in with the gateway's model when
# the network is at hand and dropped when it is not, so the sentence reads
# either way.
_FEATURE_LABELS = {
    "mlo_mode": "eero with Wi-Fi 7 required",
    # Power saving idles the radios, and eero decides it from the gateway
    # alone — the requirement it fails carries `gateway_model` and nothing
    # about the leaves. A newer eero at the front of the network is the only
    # thing that changes it; replacing a leaf will not.
    "power_saving":
        "Power saving is the gateway's to do, and {gateway} is not one of the "
        "models that can. Only a newer eero at the front of the network would "
        "add it — changing a leaf will not.",
    "scheduled_power_saving":
        "Scheduling follows power saving, which the gateway does, and "
        "{gateway} cannot. A newer eero at the front of the network is what "
        "would add it.",
    # Thread is a radio, not a setting: an eero either has one or does not.
    "thread_network":
        "Thread needs an eero with a Thread radio in it. None of the eeros on "
        "this network has one, and no update adds one.",
    "supports_6ghz":
        "6 GHz needs a Wi-Fi 6E or Wi-Fi 7 eero. The eeros on this network "
        "have no radio for that band.",
    "wpa3":
        "WPA3 needs an eero new enough to have it in hardware. The ones on "
        "this network do not.",
}

# What to say when the gateway is the part that cannot, and the feature has no
# wording of its own. Still better than naming no part at all.
_GATEWAY_HARDWARE = ("This is decided by the gateway, and {gateway} does not "
                     "support it. Changing a leaf will not help.")

_NO_GATEWAY_NAME = "this network's gateway"

_LABELS = {
    Reason.SUBSCRIPTION: "Requires an eero Plus subscription",
    Reason.HARDWARE:     "Your eero hardware does not support this",
    Reason.FIRMWARE:     "Requires newer eero firmware",
    Reason.MOBILE_APP:   "Gated on eero's mobile app version",
    Reason.NETWORK_MODE: "Not available with this network configuration",
    Reason.ROLE:         "Requires network owner access",
    Reason.REGION:       "Not available in this region",
    Reason.ROLLOUT:      "Not yet enabled for this network by eero",
    Reason.OTHER:        "Unavailable",
}


def classify(key: str) -> Reason:
    for pattern, reason in _PATTERNS:
        if pattern.search(key):
            return reason
    return Reason.OTHER


@dataclass
class Capability:
    name: str
    available: bool
    reasons: list[Reason] = field(default_factory=list)
    unmet: list[str] = field(default_factory=list)
    # True when every unmet requirement is a mobile-version gate, which usually
    # means this client was not identified correctly rather than that the
    # network lacks the feature.
    mobile_gate_only: bool = False
    # The requirement values eero sends that are context rather than gates:
    # `gateway_model`, `firmware`, `country_from_geo_ip`. Their presence is
    # what says which part of the network a hardware gate is about — a
    # requirement set that names a gateway model is a statement about the
    # gateway and not about the eeros around it.
    context: dict[str, str] = field(default_factory=dict)
    # The gateway's model as somebody would say it — "eero Pro 6E" — which
    # eero's capability map does not carry: its `gateway_model` is an internal
    # codename. Filled in by `name_gateway` from the node list.
    gateway: str | None = None

    @property
    def primary_reason(self) -> Reason | None:
        for r in (Reason.SUBSCRIPTION, Reason.HARDWARE, Reason.FIRMWARE,
                  Reason.NETWORK_MODE, Reason.REGION, Reason.ROLE,
                  Reason.ROLLOUT, Reason.MOBILE_APP, Reason.OTHER):
            if r in self.reasons:
                return r
        return None

    @property
    def explanation(self) -> str:
        r = self.primary_reason
        if self.available and not r:
            return ""
        # A per-feature wording wins over the generic reason label where the
        # generic one is technically true but useless. eero reports multi-link
        # as a firmware requirement, which reads as "wait for an update" —
        # but MLO is a Wi-Fi 7 capability, so on older hardware no update will
        # ever supply it. Say the thing the user can act on.
        if r in (Reason.FIRMWARE, Reason.HARDWARE):
            gateway = self.gateway or _NO_GATEWAY_NAME
            specific = _FEATURE_LABELS.get(self.name)
            if specific:
                return specific.format(gateway=gateway)
            # No wording of its own, but eero said which part it judged.
            if r is Reason.HARDWARE and "gateway_model" in self.context:
                return _GATEWAY_HARDWARE.format(gateway=gateway)
        return _LABELS.get(r or Reason.OTHER, "")

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "available": self.available,
                "reason": (self.primary_reason.value if self.primary_reason else None),
                "explanation": self.explanation,
                # Whether the feature belongs to eero Plus at all, which is not
                # the same question as whether it is available. On a subscribed
                # network a Plus feature is available and has no reason, so
                # without this the interface cannot tell it apart from one that
                # was never gated — and the user cannot see what they are
                # paying for.
                "plus": self.name in PLUS_FEATURES,
                "unmet": self.unmet, "mobile_gate_only": self.mobile_gate_only}


# Requirement keys whose *false* value is the acceptable one. eero's
# requirements map mixes polarities: most keys mean "this holds" (true is
# good), but some ask a question where false is the desired answer —
# `require_secure_plus: false` means the feature does not need a subscription,
# not that a subscription is missing. Treating those as failures produced
# reasons that were wrong: a feature blocked purely by firmware could be
# reported as subscription-gated because `require_secure_plus` happened to be
# false beside it.
#
# Derived empirically: each of these was observed false on a network where the
# feature was nonetheless capable, which is only possible if false is fine.
NEGATIVE_SENSE = frozenset({
    "is_legacy_network",
    "require_secure_plus",
    "is_not_isp_org_managed",
    "min_firmware_version",
    "in_enabled_groups",
    "has_allowed_org",
    "has_secure_plus",
})


def parse(capabilities: dict[str, Any] | None,
          ignore_mobile_gates: bool = False) -> dict[str, Capability]:
    out: dict[str, Capability] = {}
    for name, raw in (capabilities or {}).items():
        if not isinstance(raw, dict):
            continue
        capable = bool(raw.get("capable"))
        reqs = raw.get("requirements") or {}
        # Only boolean requirements express pass/fail; strings are context
        # (firmware version, country code) and are not gates on their own.
        unmet = [k for k, v in reqs.items()
                 if v is False and k not in NEGATIVE_SENSE]
        context = {k: v for k, v in reqs.items() if isinstance(v, str)}
        reasons = sorted({classify(k) for k in unmet}, key=lambda r: r.value)
        mobile_only = bool(unmet) and all(classify(k) is Reason.MOBILE_APP for k in unmet)
        effective = capable or (ignore_mobile_gates and mobile_only)
        out[name] = Capability(name=name, available=effective,
                               reasons=[] if effective else reasons,
                               unmet=[] if effective else unmet,
                               mobile_gate_only=mobile_only,
                               context=context)
    return out


def name_gateway(caps: dict[str, Capability], model: str | None
                 ) -> dict[str, Capability]:
    """Put the gateway's own model name where the explanations can reach it.

    eero names the gateway in a capability's requirements, but as an internal
    codename — "Trieste", "Merci" — which means nothing to anybody. The node
    list has the name on the box, so the two are joined here rather than by
    shipping a codename table that would fall behind every new model.
    """
    if not model:
        return caps
    return {name: (replace(cap, gateway=f"a {model}")
                   if "gateway_model" in cap.context else cap)
            for name, cap in caps.items()}


# eero publishes the Plus feature list per network at
# 2.2/entitlements/networks/{id}/features. A subscribed network lists the
# features it is entitled to; an unsubscribed one lists none. This interface
# treats that feed as the authority, and the per-network `capabilities` map as
# what it reads like — a hint about which screens an app may show, which is a
# different question from which features an account may use.
#
# These are eero's entitlement names mapped onto the capability names this
# interface gates on. Channel utilization is on the list, which is why radio
# analytics is marked as a Plus feature here.
ENTITLEMENT_CAPS: dict[str, tuple[str, ...]] = {
    "ad_blocking":           ("ad_block",),
    "block_and_allow_sites": ("dnsfilter_blocklist", "dnsfilter_allowlist"),
    "block_apps":            ("block_apps",),
    "content_filter":        ("content_filters", "safe_search",
                              "dnsfilter_threat_categories", "advanced_security"),
    "dynamic_dns":           ("ddns_enabled",),
    "historical_data_usage": ("historical_usage", "historical_insights",
                              "per_device_insights"),
    "channel_utilization":   ("channel_utilization",),
    "cellular_backup":       ("cellular_backup",),
    "internet_backup":       ("internet_backup",),
    "event_stream":          ("event_stream",),
}

# Every capability name the entitlement feed can gate.
PLUS_FEATURES = frozenset(
    name for names in ENTITLEMENT_CAPS.values() for name in names)


def entitled_capabilities(feed: dict[str, Any] | None) -> set[str]:
    """Capability names this network is entitled to, from the feed.

    An empty or missing feed means no entitlements, which is the correct answer
    for a network with no subscription.
    """
    feats = (feed or {}).get("features") or {}
    out: set[str] = set()
    for ent, names in ENTITLEMENT_CAPS.items():
        if ent in feats:
            out.update(names)
    return out


def apply_subscription(caps: dict[str, "Capability"],
                       premium: bool,
                       entitled: set[str] | None = None) -> dict[str, "Capability"]:
    """Mark eero Plus features unavailable when the network is not entitled.

    `entitled` comes from the entitlements feed and is preferred when present.
    Without it, fall back to the subscription flag, which is coarser but still
    right for the common case.

    A capability eero already reports unavailable keeps its own reason: a
    hardware or firmware limit is not lifted by a subscription.
    """
    if entitled is None and premium:
        return _name_every_plus_feature(caps)
    allowed = entitled if entitled is not None else (PLUS_FEATURES if premium else set())
    gated = Capability(name="", available=False, reasons=[Reason.SUBSCRIPTION],
                       unmet=["has_premium"], mobile_gate_only=False)
    for name in PLUS_FEATURES:
        if name in allowed:
            continue
        cap = caps.get(name)
        # Absent as well as present: eero omits some Plus features from the
        # capability map entirely, and an absent name otherwise reads as
        # "not gated".
        if cap is None or cap.available:
            caps[name] = replace(gated, name=name)
    return _name_every_plus_feature(caps)


def _name_every_plus_feature(caps: dict[str, "Capability"]) -> dict[str, "Capability"]:
    """Give every eero Plus feature an entry, including ones eero omits.

    eero's per-network capability map lists only some of them — seven of the
    sixteen are simply absent on a subscribed network. The loop above fills the
    gaps for an unentitled network, because there the answer is "unavailable",
    but an entitled one was left with nothing at all under those names. That
    left the interface unable to say a feature is part of Plus, which is a
    different question from whether it is available and one it can always
    answer: membership comes from this list, not from eero's map.

    Available, because an entitled network can use it and a capability absent
    from eero's map is not a statement that anything is gated.
    """
    for name in PLUS_FEATURES:
        if name not in caps:
            caps[name] = Capability(name=name, available=True)
    return caps


def is_premium(network: dict[str, Any]) -> bool:
    """True when the network carries an active eero Plus subscription."""
    return str(network.get("premium_status", "")).lower() == "active"
