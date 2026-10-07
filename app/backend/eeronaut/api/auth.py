"""Sign-in, sign-out, and session state."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..clients.cloud import EeroCloud
from ..core.errors import UpstreamError
from ..core.upstream_messages import humanize
from ..core.session import Session, store
from .deps import authed_cloud, cloud

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    login: str = Field(..., description="Account email address or mobile number")
    remember: bool = Field(False, description="Persist the session across restarts")


class VerifyRequest(BaseModel):
    code: str = Field(..., min_length=4, max_length=12)


class AuthState(BaseModel):
    authenticated: bool
    awaiting_code: bool = False
    login: str = ""
    remembered: bool = False
    # Empty until a network is chosen. The account may own several, so signing
    # in is not enough on its own — the app is scoped to one network at a time
    # and needs to know which. The frontend shows a picker while this is empty.
    network_url: str = ""


# Holds the provisional token between login and verify. Deliberately in-memory:
# an unverified token should not survive a restart.
_pending: dict[str, str] = {}


@router.get("/state", response_model=AuthState)
async def state() -> AuthState:
    s = store.session
    return AuthState(
        authenticated=bool(s and not _pending),
        awaiting_code=bool(_pending),
        login=(s.login if s else _pending.get("login", "")),
        remembered=bool(s and store._persisted),
        network_url=(s.network_url if s else ""),
    )


@router.post("/login", response_model=AuthState)
async def login(body: LoginRequest, client: EeroCloud = Depends(cloud)) -> AuthState:
    try:
        token = await client.login(body.login)
    except UpstreamError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, humanize(exc.message)) from exc
    _pending.update(token=token, login=body.login,
                    remember="1" if body.remember else "")
    return AuthState(authenticated=False, awaiting_code=True, login=body.login)


@router.post("/verify", response_model=AuthState)
async def verify(body: VerifyRequest) -> AuthState:
    if not _pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "no login in progress")
    client = EeroCloud(token=_pending["token"])
    try:
        user = await client.verify(body.code)
    except UpstreamError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            humanize(exc.message) or "that code was not accepted") from exc
    finally:
        await client.aclose()

    remember = bool(_pending.get("remember"))
    store.set(Session(token=_pending["token"], login=_pending.get("login", ""),
                      user_id=str((user or {}).get("id", ""))), remember=remember)
    _pending.clear()
    return AuthState(authenticated=True, login=store.session.login,
                     remembered=remember, network_url=store.session.network_url)


@router.post("/resend")
async def resend() -> dict[str, bool]:
    if not _pending:
        raise HTTPException(status.HTTP_409_CONFLICT, "no login in progress")
    client = EeroCloud(token=_pending["token"])
    try:
        await client.resend()
    finally:
        await client.aclose()
    return {"sent": True}


@router.post("/logout")
async def logout(client: EeroCloud = Depends(authed_cloud)) -> dict[str, bool]:
    try:
        await client.logout()
    except UpstreamError:
        pass          # local sign-out should succeed regardless
    store.clear()
    _pending.clear()
    return {"ok": True}
