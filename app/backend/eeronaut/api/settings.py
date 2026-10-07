"""Application settings: display preferences, and the eero app version Eeronaut presents."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from ..core import client_identity, client_version, langtag, notifstate
from ..core.config import settings
from ..core import themes
from ..core import prefs as prefs_mod
from ..core.prefs import Prefs

router = APIRouter(prefix="/api/settings", tags=["settings"])


class PrefsBody(BaseModel):
    hide_subscription_gated: bool = False
    hide_capability_limited: bool = False
    hide_plus_badges: bool = False
    appearance: str = "system"
    theme: str = themes.DEFAULT
    clock_24h: bool = False
    language: str = "auto"

    @field_validator("language")
    @classmethod
    def _language(cls, v: str) -> str:
        """A BCP 47 tag, or "auto" to follow the browser.

        Checked for shape and written in the conventional case, so `pt_br`
        and `PT-BR` both come back as `pt-BR` and every later comparison is
        against one spelling. Not validated against the shipped catalogs: a
        contributor who drops in a new one should not also have to find this
        list, and the interface falls back to English for a tag it has no
        catalog for, so an unknown value degrades rather than breaks.
        """
        v = (v or "auto").strip()
        if v == "auto":
            return v
        if not langtag.valid(v):
            raise ValueError(
                "language must be 'auto' or a BCP 47 tag like 'es', 'pt-BR' "
                "or 'zh-Hant'")
        return langtag.canonical(v)

    @field_validator("appearance")
    @classmethod
    def _appearance(cls, v: str) -> str:
        if v not in ("system", "light", "dark"):
            raise ValueError("appearance must be system, light, or dark")
        return v

    @field_validator("theme")
    @classmethod
    def _theme(cls, v: str) -> str:
        """An installed theme, by id.

        Checked against what is on disk, unlike the language above: a theme
        that is not installed cannot be drawn at all, and accepting the id
        would save a preference the interface then silently ignores.
        """
        if not themes.get(v):
            raise ValueError(f"no theme called {v!r} is installed")
        return v


def _network_key() -> str:
    """Which network the feature filters being read or written belong to.

    From the stored session rather than from the request, like the web
    notifications above: switching network reloads the interface, so the two
    always agree, and this keeps working with eero's cloud unreachable.
    """
    from ..core import nodecache
    from ..core.session import store as session_store
    s = session_store.session
    return nodecache.network_key(s.network_url if s else "")


@router.get("/prefs", response_model=PrefsBody)
async def get_prefs() -> PrefsBody:
    p = Prefs.load()
    # A theme removed from under the preference is reported as the default,
    # which is what the interface will draw. The file keeps the old id
    # until the next write, so putting the theme back brings it back.
    return PrefsBody(**{**p.__dict__, "theme": themes.active_id(p.theme),
                        **p.for_network(_network_key())})


@router.put("/prefs", response_model=PrefsBody)
async def put_prefs(body: PrefsBody) -> PrefsBody:
    sent = body.model_dump()
    # Loaded first, so that the networks this one is not is left alone: the
    # body carries one network's filters and knows nothing of the others.
    p = Prefs.load()
    p.set_network(_network_key(), sent)
    for name, value in sent.items():
        if name not in prefs_mod.PER_NETWORK:
            setattr(p, name, value)
    p.save()
    return body


# ------------------------------------------------ web-interface notifications
#
# The switches are kept per network in settings.json and what has been read
# in notifications-<network>.json (see `notifstate`). The network is read
# from the stored session so this keeps working with the cloud unreachable.

class WebNotifications(BaseModel):
    """Which events raise an in-app alert in this web interface.

    Separate from the mobile-app notification settings on the eero account:
    those decide what the phone pushes; these decide what surfaces here. Keyed
    by the same event names so the two columns line up in the UI.
    """
    preferences: dict[str, bool] = Field(default_factory=dict)


@router.get("/web-notifications", response_model=WebNotifications)
async def get_web_notifications() -> WebNotifications:
    return WebNotifications(preferences=notifstate.alerts(_network_key()))


@router.put("/web-notifications", response_model=WebNotifications)
async def put_web_notifications(body: WebNotifications) -> WebNotifications:
    return WebNotifications(
        preferences=notifstate.set_alerts(_network_key(), body.preferences))


class NotificationState(BaseModel):
    """What this installation has read, dismissed, and already alerted on."""
    read_at: str
    dismissed: list[str]
    backlog_seen: bool


def _state(data: dict) -> NotificationState:
    return NotificationState(read_at=data["read_at"], dismissed=data["dismissed"],
                             backlog_seen=data["backlog_seen"])


@router.get("/notification-state", response_model=NotificationState)
async def get_notification_state() -> NotificationState:
    return _state(notifstate.load(_network_key()))


class StateImport(BaseModel):
    """What a browser kept before this moved to the server, sent once."""
    read_at: str | None = Field(default=None, max_length=40)
    dismissed: list[str] | None = Field(default=None, max_length=notifstate.KEEP)
    alerted: list[str] | None = Field(default=None, max_length=notifstate.KEEP)


@router.put("/notification-state", response_model=NotificationState)
async def import_notification_state(body: StateImport) -> NotificationState:
    """Taken only while the server has none of its own: the first browser to
    arrive after an upgrade carries its history across, and nothing after
    that can overwrite what the installation has since recorded."""
    key = _network_key()
    data = notifstate.load(key)
    if not data["backlog_seen"]:
        data = notifstate.update(key, read_at=body.read_at,
                                 dismissed=body.dismissed, alerted=body.alerted,
                                 backlog_seen=body.alerted is not None or None)
    return _state(data)


class Dismiss(BaseModel):
    item: str = Field(min_length=1, max_length=200)


@router.post("/notification-state/dismiss", response_model=NotificationState)
async def dismiss_notification(body: Dismiss) -> NotificationState:
    return _state(notifstate.dismiss(_network_key(), body.item))


@router.post("/notification-state/read-all", response_model=NotificationState)
async def read_all_notifications() -> NotificationState:
    return _state(notifstate.read_all(_network_key()))


class Claim(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=notifstate.KEEP)


@router.post("/notification-state/claim")
async def claim_alerts(body: Claim) -> dict[str, list[str]]:
    """Which of these eero items are new, and so should alert. See
    `notifstate.claim`."""
    return {"new": notifstate.claim(_network_key(), body.ids)}


@router.get("/client")
async def get_client() -> dict[str, object]:
    """The eero app version presented to eero, and the agent it goes out in."""
    return {"client_version": settings.client_version,
            "effective_user_agent": settings.effective_user_agent}


@router.get("/app-update")
async def app_update_status() -> dict[str, object]:
    """Whether a newer Eeronaut has been released (see `core.app_update`)."""
    from ..core import app_update
    return app_update.status()


@router.get("/client/latest")
async def latest_client(force: bool = False) -> dict[str, object]:
    """Suggest the current published eero app version. Advisory only."""
    info = await client_version.check(force=force)
    return info.as_dict()
