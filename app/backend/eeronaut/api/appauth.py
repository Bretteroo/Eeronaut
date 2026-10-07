"""Sign-in for the web interface itself, separate from the eero account."""
from __future__ import annotations

import asyncio

from fastapi import (APIRouter, Depends, HTTPException, Request, Response,
                     status)
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from ..core import appauth, themes
from ..core.prefs import Prefs

router = APIRouter(prefix="/api/app", tags=["app access"])


class PasswordBody(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


class AccessState(BaseModel):
    configured: bool
    signed_in: bool
    locked_for: int = 0
    # The theme to draw, named here because this is the first thing the
    # interface asks and the only thing it can ask before signing in. The
    # sign-in screens are themed too. An installation-wide fact, not an
    # account one: which stylesheet a page loads says nothing about the
    # network behind the password.
    theme: str = themes.DEFAULT


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def require_app_session(request: Request) -> None:
    """Refuse an unauthenticated caller before the body is even looked at.

    As a route dependency rather than a check inside the handler: FastAPI
    validates the body first otherwise, so a signed-out caller posting nothing
    got 422 instead of 401 and the route read as ungated.
    """
    if not appauth.valid_session(request.cookies.get(appauth.COOKIE_NAME)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in first")


@router.get("/state", response_model=AccessState)
async def state(request: Request) -> AccessState:
    return AccessState(
        configured=appauth.is_configured(),
        signed_in=appauth.valid_session(request.cookies.get(appauth.COOKIE_NAME)),
        locked_for=appauth.lockout_remaining(_client(request)),
        theme=themes.active_id(Prefs.load().theme),
    )


def _set_cookie(response: Response, request: Request) -> None:
    response.set_cookie(
        appauth.COOKIE_NAME, appauth.issue_session(),
        max_age=appauth.SESSION_MAX_AGE,
        httponly=True,          # not readable from JavaScript
        samesite="lax",         # not sent on cross-site form posts
        # Only mark Secure when the request actually arrived over TLS; setting
        # it unconditionally would break plain-HTTP use on a LAN, which is the
        # normal deployment.
        secure=request.url.scheme == "https",
        path="/",
    )


# One setup at a time, so the check that no password is set and the write
# that sets one cannot interleave: two first visits at once both passed the
# check and both got a signed-in cookie.
_setup_lock = asyncio.Lock()


@router.post("/setup", response_model=AccessState)
async def setup(body: PasswordBody, request: Request, response: Response) -> AccessState:
    """Set the interface password on first run. Refuses once one exists.

    Starts from no eero sign-in. A lost password is reset by deleting its file,
    which used to leave the eero session in place: whoever on the network set a
    password first, before the owner got back to the page, inherited a signed-in
    eero account. On a fresh install there is no session to clear.
    """
    async with _setup_lock:
        if appauth.is_configured():
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "a password is already set for this interface")
        # The password first, so one that is refused changes nothing: it used
        # to clear the eero sign-in and then fail the length rule.
        try:
            appauth.check_password(body.password)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        # Whether or not a session loaded. `store.session` is None when its
        # file could not be read just now, and keying on it left that file
        # behind for a later read to bring back.
        from ..core.session import store
        store.clear()
        try:
            await run_in_threadpool(appauth.set_password, body.password)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        except OSError as exc:
            # Almost always a data directory the container cannot write, such
            # as a bind mount created by root. Said plainly, not as a bare 500.
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR,
                                appauth.unwritable_message()) from exc
    _set_cookie(response, request)
    return AccessState(configured=True, signed_in=True)


@router.post("/login", response_model=AccessState)
async def login(body: PasswordBody, request: Request, response: Response) -> AccessState:
    client = _client(request)
    wait = appauth.lockout_remaining(client)
    if wait:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            f"too many attempts, try again in {wait} seconds")
    if not await run_in_threadpool(appauth.verify_password, body.password):
        wait = appauth.record_failure(client)
        detail = "that password was not accepted"
        if wait:
            detail += f"; further attempts blocked for {wait} seconds"
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)
    appauth.record_success(client)
    _set_cookie(response, request)
    return AccessState(configured=True, signed_in=True)


class ChangePasswordBody(BaseModel):
    current: str = Field(..., min_length=1, max_length=256)
    new: str = Field(..., min_length=1, max_length=256)


@router.post("/password", response_model=AccessState,
             dependencies=[Depends(require_app_session)])
async def change_password(body: ChangePasswordBody, request: Request,
                          response: Response) -> AccessState:
    """Replace the interface password.

    Requires the current one even though the caller is already signed in: a
    session cookie proves someone had the password once, not that the person
    holding the keyboard now knows it. Rate-limited on the same counter as
    sign-in, so this cannot become a quieter way to guess it.
    """
    if appauth.env_password_in_use():
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this interface's password comes from the EERONAUT_UI_PASSWORD "
            "environment variable, which overrides anything stored here. "
            "Change it where that variable is set, or unset it and restart.")

    client = _client(request)
    wait = appauth.lockout_remaining(client)
    if wait:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            f"too many attempts, try again in {wait} seconds")
    if not await run_in_threadpool(appauth.verify_password, body.current):
        wait = appauth.record_failure(client)
        detail = "that is not the current password"
        if wait:
            detail += f"; further attempts blocked for {wait} seconds"
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)
    if body.new == body.current:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "the new password is the same as the current one")
    try:
        await run_in_threadpool(appauth.set_password, body.new)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    appauth.record_success(client)
    # Every other session is now invalid, including any this browser holds in
    # another tab, so this one is re-issued rather than left to expire.
    _set_cookie(response, request)
    return AccessState(configured=True, signed_in=True)


@router.post("/logout", response_model=AccessState)
async def logout(response: Response) -> AccessState:
    response.delete_cookie(appauth.COOKIE_NAME, path="/")
    return AccessState(configured=appauth.is_configured(), signed_in=False)
