"""Human labels for eero's machine values.

eero returns constants like `band_5GHz_full`, `WALL_POWER` and `P1000`. Every
place that formatted one of these separately got it slightly wrong — the node
panel showed "2 4GHz", radio analytics showed "2.4GHz GHz" — so the formatting
lives here once and the interface only ever renders the result.
"""
from __future__ import annotations

# eero's radio identifiers. The 5 GHz band is reported either whole or split
# into its low and high halves, and the distinction matters when reading
# airtime, so it is kept rather than flattened.
_BANDS = {
    "band_2_4ghz": "2.4 GHz",
    "band_5ghz": "5 GHz",
    "band_5ghz_full": "5 GHz",
    "band_5ghz_low": "5 GHz (low)",
    "band_5ghz_high": "5 GHz (high)",
    "band_6ghz": "6 GHz",
    # Also accept the values with the prefix already stripped, because some
    # responses carry them that way.
    "2_4ghz": "2.4 GHz",
    "5ghz": "5 GHz",
    "5ghz_full": "5 GHz",
    "5ghz_low": "5 GHz (low)",
    "5ghz_high": "5 GHz (high)",
    "6ghz": "6 GHz",
}


def band_label(value: str | None) -> str | None:
    """"band_5GHz_low" -> "5 GHz (low)". Unknown bands are returned tidied
    rather than dropped, so a band eero adds later still reads as words."""
    if not value:
        return None
    key = str(value).strip().lower()
    if key in _BANDS:
        return _BANDS[key]
    tidy = key.removeprefix("band_").replace("_", " ").strip()
    return tidy.replace("ghz", " GHz").replace("  ", " ").strip() or None


_MESH_RADIOS = {
    "2.4ghz": "2.4 GHz",
    "5ghz": "5 GHz",
    # Real, and not a band anyone has seen written on a router: the original
    # eero Pro splits 5 GHz into two radios and eero names the lower one by
    # its frequency. Elsewhere the same radio is `band_5GHz_low`.
    "5.2ghz": "5 GHz (low)",
    "5.7ghz": "5 GHz (high)",
    "5.8ghz": "5 GHz (high)",
    "6ghz": "6 GHz",
}


def mesh_radio_label(value: str | None) -> str | None:
    """The radio a mesh link runs on, in the app's band vocabulary."""
    if not value:
        return None
    key = str(value).strip().lower().replace(" ", "")
    return _MESH_RADIOS.get(key, str(value).strip() or None)


def pretty_enum(value: str | None, known: dict[str, str] | None = None) -> str | None:
    """A readable label for a SCREAMING_SNAKE constant.

    Blind title-casing turns USB into "Usb", so acronyms are passed in via
    `known`; anything else becomes sentence case.
    """
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if known and raw.upper() in known:
        return known[raw.upper()]
    return raw.replace("_", " ").capitalize()


# The words eero's own status-light legend uses (Settings > Troubleshooting >
# Status light in the phone app): twelve for an eero, ten for an eero Signal.
# Only the ones the cloud API can actually distinguish are produced here —
# "Bluetooth pairing", "Identifying Zigbee devices", and the rest describe the
# physical light during setup and are not reported anywhere in the API, so
# claiming them would be invention.
NODE_STATES = {
    "online": "Online",
    "connected": "Connected",
    "backup_active": "Backup active",
    "power_saving": "Power saving",
    "updating": "Updating…",
    "restarting": "Restarting",
    "connecting": "Connecting…",
    "issue": "Issue",
    "offline": "Offline",
    "no_power": "No power or disabled",
    # A Signal that is standing by is ready, not active: it carries traffic
    # only while the wired connection is down. This was the one state
    # returned as a bare string rather than from this table.
    "backup_ready": "Backup ready",
    # A Signal that is still setting itself up. eero's own app groups
    # CONFIGURING, SCAN, and SWITCHING_CARRIER under one word, and this is it.
    "configuring": "Configuring",
}


# Accessory configuration statuses that are not faults.
#
# eero's ConfigurationStatus enum has twelve members and only some of them
# are problems. Its app reads CONFIGURING, SCAN, and SWITCHING_CARRIER as one
# "configuring" state and OTA as an install in progress
# (`GetAccessoryStateUseCase`); PENDING_REGISTER is the same kind of thing,
# and is what this already calls "connecting" when a Signal has no
# registration yet.
#
# They are listed because everything not listed somewhere is treated as a
# fault, which painted a Signal mid-setup with the red cross that means
# nothing can reach it.
ACCESSORY_CONFIGURING = {"configuring", "scan", "switching_carrier",
                         "pending_register"}
ACCESSORY_UPDATING = {"ota"}


def node_status_key(e: dict) -> str:
    """What an eero is doing, as a key into NODE_STATES.

    Derived from the fields eero actually reports rather than from the light
    itself, which the API never exposes. `state` is authoritative when it says
    anything other than online; otherwise the color in `status` separates a
    healthy node from one with a fault.

    A key rather than a sentence, because the interface has to be able to
    translate it. This returned English, so "Restarting" and "Backup ready"
    reached the browser as text no catalog could reach — and the browser-side
    scanner that finds untranslated strings cannot see them either, since it
    only reads frontend source. The English still ships beside the key as a
    fallback, for a state this app has not heard of yet.
    """
    state = (e.get("state") or "").strip().upper()
    if state in ("UPDATING", "UPDATE_IN_PROGRESS"):
        return "updating"
    if state in ("RESTARTING", "REBOOTING"):
        return "restarting"
    if state in ("CONNECTING", "PROVISIONING"):
        return "connecting"

    status = (e.get("status") or "").strip().lower()
    if state and state != "ONLINE" or status == "red":
        return "offline"
    # A scheduled power-saving window is a state of its own, and a node in it
    # is still healthy, so it is checked before the color.
    if ((e.get("power_saving") or {}).get("schedule") or {}).get("active"):
        return "power_saving"
    if status == "yellow":
        return "issue"
    if not e.get("heartbeat_ok", True):
        return "offline"
    return "online"


def accessory_status_key(a: dict) -> str:
    """The same idea for an eero Signal, whose legend has ten entries.

    A Signal that is standing by is ready, not active: it carries traffic only
    while the wired connection is down.
    """
    if a.get("issue"):
        return "issue"
    config = (a.get("configuration_status") or "").strip().lower()
    if config in ACCESSORY_UPDATING:
        return "updating"
    # Before the registration check: a Signal switching carrier is registered
    # to nothing for a moment, and "Connecting…" is the wrong word for it.
    if config in ACCESSORY_CONFIGURING:
        return "configuring"
    if not a.get("registered"):
        return "connecting"
    # The node list nests the SIM state under `cellular`; the per-accessory
    # detail flattens it. Accept either rather than making callers reshape.
    cell = a.get("cellular") or {}
    state = (cell.get("status") or a.get("status") or "").strip().upper()
    if state in ("ACTIVE", "CONNECTED"):
        return "backup_active"
    return "backup_ready"


# eero's Domain Guidelines, from the app's own help screen: a rule applies at
# whatever level of the hierarchy you name it. "org" affects every .org domain,
# "example.org" affects that domain and everything under it, and
# "subdomain.example.org" affects only that subdomain. There is no wildcard
# syntax — eero's own validator allows letters, digits, and dashes only.
_LABEL_OK = set("abcdefghijklmnopqrstuvwxyz0123456789-")


def clean_domain(value: str) -> str:
    """Normalize a domain rule, or say why it cannot be one.

    A bare label is legitimate here: eero treats it as a top-level domain rule.
    Requiring a dot rejected that, which is why this is not simply a regex on
    "something.something".
    """
    v = (value or "").strip().lower()
    v = v.removeprefix("http://").removeprefix("https://").split("/", 1)[0]
    v = v.split("?", 1)[0].split(":", 1)[0].strip(".")
    if not v:
        raise ValueError("Enter a domain, for example example.com")
    if "*" in v:
        raise ValueError(
            "eero has no wildcards. A rule for example.com already covers "
            "everything under it, so enter the domain on its own.")
    for label in v.split("."):
        if not 1 <= len(label) <= 63:
            raise ValueError("Each part of a domain must be 1 to 63 characters.")
        if set(label) - _LABEL_OK or label.startswith("-") or label.endswith("-"):
            raise ValueError(
                "A domain may contain only letters, numbers, and dashes.")
    return v


def node_status(e: dict) -> str:
    """The English for `node_status_key`, for callers that want both."""
    return NODE_STATES[node_status_key(e)]


def accessory_status(a: dict) -> str:
    """The English for `accessory_status_key`."""
    return NODE_STATES[accessory_status_key(a)]


# ---------------------------------------------------------------- uptime

def reboot_claim_is_stale(last_reboot: str | None,
                          last_update_started: str | None,
                          node_url: str | None = None,
                          skipped: object = None,
                          node_firmware: str | None = None,
                          target_firmware: str | None = None) -> bool:
    """Whether eero's "last rebooted" for a node cannot be true.

    eero sometimes pins a node's `last_reboot` to the moment it was first set
    up and never moves it again. One eero on a network here reports a reboot
    three minutes after it joined in 2020 and an uptime of 193,619,174
    seconds — six years and two months — while running firmware released long
    after that. Reported from use, and the reason this exists.

    The contradiction is in eero's own data rather than in anything inferred:
    installing firmware reboots every eero (measured, not assumed),
    and the network records when the last install began. An install that began
    after the claimed reboot means the node has rebooted since, whatever the
    claim says.

    Two ways to be wrong, and they are not equal. Calling a true uptime stale
    costs a figure that gets reported as "connected for" instead, which is a
    weaker statement but a true one. Believing a stale claim prints a number
    that is impossible on its face, which is what was reported. So the check
    errs toward not believing.

    Two exceptions, both from eero's own record of the install. A node it
    lists as unresponsive or incomplete may really not have taken it. And
    an install that began is not an install that landed: on one network here
    it started three weeks ago and every node is still on the firmware before
    it, so nothing rebooted and a 107-day uptime there is perfectly possible.
    So the node must be running what that install was delivering before its
    claim is doubted.
    """
    if not last_reboot or not last_update_started:
        return False
    if node_firmware and target_firmware and node_firmware != target_firmware:
        return False
    if node_url and isinstance(skipped, (list, tuple, set)):
        tail = str(node_url).rstrip("/").rsplit("/", 1)[-1]
        for other in skipped:
            if str(other).rstrip("/").rsplit("/", 1)[-1] == tail:
                return False
    a, b = _instant(last_reboot), _instant(last_update_started)
    return bool(a and b and b > a)


def _instant(value: str) -> float | None:
    """Seconds since the epoch for one of eero's timestamps, or None.

    eero writes these several ways — "…Z", "…+0000", and with anywhere from
    three to nine decimal places — so this parses rather than assumes.
    """
    import datetime as _dt
    import re as _re

    text = str(value).strip()
    text = _re.sub(r"(\.\d{6})\d+", r"\1", text)        # trim to microseconds
    text = _re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text)
    text = text.replace("Z", "+00:00")
    try:
        return _dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None
