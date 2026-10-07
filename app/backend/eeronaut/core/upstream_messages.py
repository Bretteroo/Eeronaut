"""eero's machine-readable error keys, in English.

eero answers a rejected write with a key rather than a sentence:
`{"meta": {"error": "error.network.adblock.enabled"}}`. Passed through
untouched, that key is what lands in front of the person who clicked the
button, which is how "error.network.adblock.enabled" came to be an error
message in this interface.

Keys come from `EeroError.java` in the phone app plus the ones this project
has seen live and the app does not name. The wording is eero's own where the
app pairs a key with a visible string — `reservation_error_conflict_message`
and friends in `res/values/strings.xml` — and this app's where it does not,
which is most of the network-settings side, because the phone app shows a
generic "Please try again" there.

Unknown keys are left alone. A key nobody has seen is better shown verbatim,
where it can be reported, than rewritten into a guess.
"""
from __future__ import annotations

MESSAGES: dict[str, str] = {
    # --- what this app writes to -------------------------------------------
    # Observed live: eero refuses to let a profile opt out of ad blocking
    # while the network-wide switch is on. The phone app never sends this
    # call, so it has no string for it.
    "error.network.adblock.enabled":
        "Ad blocking is turned on for the whole network, and eero will not "
        "let a single profile opt out of it. Turn off network-wide ad "
        "blocking under Security > Network-wide protection first, then "
        "choose which profiles it applies to.",

    # Reservations and port forwards.
    "error.reservation.failed":
        "eero could not save that reservation because it clashes with one "
        "already saved: the address, or that device, is reserved already.",
    "error.reservation.ip.invalid":
        "That address is not inside this network's own range, so it cannot "
        "be reserved here.",
    "error.assignment.ip.unavailable":
        "Another reservation already holds that address.",
    "error.assignment.port.unavailable":
        "Another port forward already uses that external port. Pick a "
        "different one, or change that forward first.",
    "error.forward.failed":
        "eero would not save that port forward. Check that the device still "
        "has a reserved address — a forward cannot outlive its reservation.",
    "error.public_static_ip.reservation.error":
        "eero refused to reserve that public static IP address.",

    # WAN settings.
    "error.network.multistaticipv2.wan_ip_not_in_range":
        "That WAN address is not inside the subnet its gateway and netmask "
        "describe. Check all three together.",

    # Guest and backup networks.
    "error.backup.access.point.ssid.already.exists":
        "A network with that name already exists.",
    "error.backup.access.point.ssid.conflict":
        "That network name conflicts with one already saved.",
    "error.max.number.of.backup.access.points.reached":
        "This network already has as many backup access points as eero "
        "allows.",

    # --- state of the account or the hardware ------------------------------
    "error.access.denied":
        "This account is not allowed to do that on this network.",
    "error.premium.user_not_subscribed":
        "That is part of eero Plus, and this account has no subscription.",
    "error.eero.offline":
        "That eero is offline, so the change could not reach it.",
    "error.eero.deactivated": "That eero has been deactivated.",
    "error.eero.not.capable":
        "This eero model cannot do that.",
    "error.eero.needs.reset":
        "That eero has to be reset before it can be used again.",
    "error.network.not.found":
        "eero has no record of that network. It may have been deleted, or "
        "the account may have lost access to it.",
    "error.network.unavailable":
        "eero could not reach that network.",
    "error.resource.not_found":
        "eero has no record of that. It may have been deleted since this "
        "page was loaded.",

    # --- transport-ish -----------------------------------------------------
    "error.rate.limit":
        "eero is rate-limiting this account. Wait a minute and try again.",
    "error.requests.rate.limited":
        "eero is rate-limiting this account. Wait a minute and try again.",
    "error.server.unknown":
        "Something went wrong at eero's end. Please try again.",
    "error.form.errors":
        "eero rejected those values without saying which one.",
    "error.app.version.blocked":
        "eero is refusing this client version.",

    # --- session -----------------------------------------------------------
    # These normally arrive as a 401 and are handled before reaching here.
    # Mapped anyway for the case where eero attaches one to another status.
    "error.session.expired": "The eero session has expired. Sign in again.",
    "error.session.invalid": "eero rejected the session. Sign in again.",
    "error.session.revoked": "The eero session was revoked. Sign in again.",
    "error.session.refresh": "The eero session could not be refreshed. "
                             "Sign in again.",
}


def humanize(message: str) -> str:
    """English for an eero error key, or the key unchanged.

    Also catches a key that arrives with surrounding text, which some eero
    endpoints do — the key is the part worth matching on.
    """
    if not message:
        return message
    key = message.strip()
    if key in MESSAGES:
        return MESSAGES[key]
    # A bare key is one token with dots in it. Only look inside the string
    # when it plainly contains one, so ordinary prose is never rewritten.
    for k, v in MESSAGES.items():
        if k in key:
            return v
    return message
