"""Shared FastAPI dependencies."""
from __future__ import annotations

from typing import AsyncIterator

from fastapi import Depends, HTTPException, status

from ..clients.cloud import EeroCloud
from ..core.errors import NotAuthenticated
from ..core.session import store


async def cloud() -> AsyncIterator[EeroCloud]:
    """An eero client carrying the current session token, if any."""
    client = EeroCloud(token=store.token)
    try:
        yield client
    finally:
        await client.aclose()


async def authed_cloud() -> AsyncIterator[EeroCloud]:
    """A client that refreshes once before reporting the session as dead.

    If the refresh also fails the stored session is cleared, so the interface
    asks for a sign-in rather than showing a working-looking page whose every
    request quietly fails.
    """
    if not store.token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not signed in")
    client = EeroCloud(token=store.token, auto_refresh=True)
    try:
        yield client
    except NotAuthenticated:
        store.clear()
        raise
    finally:
        await client.aclose()


def current_network() -> str:
    s = store.session
    if not s or not s.network_url:
        raise HTTPException(status.HTTP_409_CONFLICT, "no network selected")
    return s.network_url
