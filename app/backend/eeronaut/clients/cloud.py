"""Client for the eero cloud API at api-user.e2ro.com.

The wire contract was recovered from the shipped Android app. Two things about
this API shape the client:

* Responses are wrapped in a ``{"meta": ..., "data": ...}`` envelope.
* It is strongly link-driven. Most objects carry a ``url`` field, and the app
  follows those rather than rebuilding paths. ``follow()`` exists for that, and
  callers should prefer it over hand-assembling routes.
"""
from __future__ import annotations

import time
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from ..core.config import settings
from ..core.errors import CloudUnreachable, NotAuthenticated, UpstreamError

Json = dict[str, Any]


def _error_message(payload: Any) -> str:
    """A sentence out of eero's error, never a repr of it.

    `meta.error` is usually a string. Sometimes it is an object, and `str()` on
    one of those put `{'id': '8eh6jcalj'}` in front of somebody as the entire
    explanation for why the Network page was empty. An id is worth keeping --
    it is what eero's support can look up -- but it is not an explanation, and
    Python's dict syntax around it is nobody's business.
    """
    if not isinstance(payload, dict):
        return ""
    err = (payload.get("meta") or {}).get("error") or payload.get("error")
    if isinstance(err, str):
        return err
    if isinstance(err, dict):
        for field in ("message", "detail", "description", "reason", "error"):
            value = err.get(field)
            if isinstance(value, str) and value.strip():
                return value.strip()
        ref = err.get("id") or err.get("code") or err.get("request_id")
        if ref:
            return f"eero's service returned an error (reference {ref})."
    return ""


class EeroCloud:
    def __init__(self, token: str | None = None, base: str | None = None,
                 auto_refresh: bool = False):
        self.base = base or settings.api_base
        self._token = token
        # When set, a rejected request triggers one refresh attempt before the
        # caller sees a failure. eero tokens are long-lived but not eternal,
        # and without this the whole interface simply starts returning 401 with
        # nothing to explain why.
        self._auto_refresh = auto_refresh
        self._refreshing = False
        # Short-lived read cache. A single page can ask for the same network
        # object several times; without this each one is a round trip to eero.
        # Any write clears it outright rather than trying to reason about which
        # entries a change invalidated - the window is seconds, so the cost of
        # being coarse is small and the cost of being wrong is showing stale
        # state right after the user changed something.
        self._cache: dict[str, tuple[float, Any]] = {}
        self._client = httpx.AsyncClient(
            timeout=settings.http_timeout_s,
            headers={"User-Agent": settings.effective_user_agent,
                     "Accept": "application/json"},
            follow_redirects=False,
        )

    # ---------------------------------------------------------------- lifecycle

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "EeroCloud":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    @property
    def token(self) -> str | None:
        return self._token

    @token.setter
    def token(self, value: str | None) -> None:
        self._token = value

    # ----------------------------------------------------------------- plumbing

    def _url(self, path: str) -> str:
        if path.startswith(("http://", "https://")):
            return path
        return urljoin(self.base, path.lstrip("/"))

    def _headers(self, url: str) -> dict[str, str]:
        host = urlparse(url).hostname or ""
        if self._token and host in settings.token_hosts:
            return {"X-User-Token": self._token}
        return {}

    def _cache_key(self, url: str, params: Json | None) -> str:
        return url + "?" + repr(sorted((params or {}).items()))

    async def request(self, method: str, path: str, *, params: Json | None = None,
                      data: Json | None = None, json: Any = None,
                      _retry: bool = True, cache: bool = True) -> Any:
        url = self._url(path)

        if method == "GET" and cache and settings.read_cache_seconds > 0:
            key = self._cache_key(url, params)
            hit = self._cache.get(key)
            if hit and (time.monotonic() - hit[0]) < settings.read_cache_seconds:
                return hit[1]
        elif method != "GET":
            self._cache.clear()

        try:
            resp = await self._client.request(
                method, url, params=params, data=data, json=json,
                headers=self._headers(url),
            )
        except httpx.TransportError as exc:
            # No answer at all: DNS, refused, timed out. Every cloud call in
            # the app comes through here, and without this each one escaped as
            # an unhandled exception and FastAPI turned it into "Internal
            # Server Error" — on every pane at once, during an outage, in an
            # app whose whole point is to be usable during one.
            raise CloudUnreachable(str(exc) or "eero's cloud did not answer") from exc
        # Only 401 means the token itself was rejected. 403 is "forbidden" —
        # the token is fine, but this network is not entitled to the feature
        # (an eero Plus endpoint on a network without Plus) or the account
        # lacks permission. Treating 403 as an auth failure logged the user out
        # merely for opening a Plus-gated page, so 403 falls through to a normal
        # UpstreamError and never touches the session.
        if resp.status_code == 401:
            # One refresh attempt, then give up. The guard prevents a refresh
            # that itself 401s from recursing.
            if self._auto_refresh and _retry and not self._refreshing:
                self._refreshing = True
                try:
                    await self.refresh()
                except NotAuthenticated:
                    raise NotAuthenticated("eero rejected the session token") from None
                # A refresh that could not be made (no answer, rate limited,
                # eero's own error) says nothing about the session, so it goes
                # up as that failure. Taken for a rejected token, it cleared a
                # good remembered session over a moment's lost connection.
                finally:
                    self._refreshing = False
                return await self.request(method, path, params=params, data=data,
                                          json=json, _retry=False)
            raise NotAuthenticated("eero rejected the session token")
        try:
            payload = resp.json()
        except ValueError:
            # Not every endpoint returns JSON: the trust bundle comes back as
            # application/x-pem-file. Hand back the raw text rather than losing it.
            payload = resp.text
        if resp.status_code >= 400:
            raise UpstreamError(resp.status_code,
                                _error_message(payload) or resp.text[:200],
                                payload)
        result = payload["data"] if isinstance(payload, dict) and "data" in payload \
            else payload
        if method == "GET" and cache and settings.read_cache_seconds > 0:
            self._cache[self._cache_key(url, params)] = (time.monotonic(), result)
        return result

    async def get(self, path: str, **kw: Any) -> Any:
        return await self.request("GET", path, **kw)

    async def post(self, path: str, **kw: Any) -> Any:
        return await self.request("POST", path, **kw)

    async def put(self, path: str, **kw: Any) -> Any:
        return await self.request("PUT", path, **kw)

    async def delete(self, path: str, **kw: Any) -> Any:
        return await self.request("DELETE", path, **kw)

    @staticmethod
    def as_list(payload: Any, key: str | None = None) -> list:
        """Coerce one of eero's collection responses into a list.

        Some endpoints answer with a bare array and others wrap it in an object
        keyed by the resource name — `{"members": [...]}`, `{"schedules": []}`.
        Iterating the wrapper directly yields dict *keys*, which then fail on
        attribute access somewhere far from the cause. This has been the single
        most common source of bugs against this API, so it is handled in one
        place rather than at each call site.
        """
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            if key and isinstance(payload.get(key), list):
                return payload[key]
            # Fall back to the sole list value, if there is exactly one.
            lists = [v for v in payload.values() if isinstance(v, list)]
            if len(lists) == 1:
                return lists[0]
        return []

    async def follow(self, obj: Json | str, method: str = "GET", **kw: Any) -> Any:
        """Follow a resource's own ``url``, the way the mobile app does."""
        url = obj if isinstance(obj, str) else obj.get("url")
        if not url:
            raise ValueError("object has no url to follow")
        return await self.request(method, url, **kw)

    # --------------------------------------------------------------------- auth

    async def login(self, login: str) -> str:
        """Start login. Returns a provisional token; a code is sent out-of-band."""
        data = await self.post("2.2/login", data={"login": login})
        token = (data or {}).get("user_token")
        if not token:
            raise UpstreamError(200, "login did not return a user_token", data)
        self._token = token
        return token

    async def verify(self, code: str) -> Json:
        """Complete login with the emailed/texted code. Returns the user."""
        return await self.post("2.2/login/verify", data={"code": code})

    async def resend(self) -> Any:
        return await self.post("2.2/login/resend", json={})

    async def refresh(self) -> Json:
        """Ask eero to renew the session, and keep the token it hands back.

        The answer is the user, carrying a `user_token` when eero issued a new
        one. It used to be discarded, so the retry went out with the old token,
        was rejected again, and the remembered session was deleted: every
        user was signed out the first time a token needed renewing. The new
        one replaces this client's and the stored session's, on disk too when
        the session is remembered.
        """
        data = await self.post("2.2/login/refresh", json={})
        token = (data or {}).get("user_token") if isinstance(data, dict) else None
        if token and token != self._token:
            self._token = token
            if self._auto_refresh:
                from ..core.session import store
                if store.token:
                    store.update(token=token)
        return data

    async def logout(self) -> Any:
        return await self.post("2.2/logout", data={"Cookie": self._token or ""})

    async def account(self) -> Json:
        return await self.get("2.2/account")

    # ----------------------------------------------------------------- networks

    async def networks(self) -> list[Json]:
        acct = await self.account()
        nets = (acct.get("networks") or {}).get("data") or []
        return nets

    async def resource(self, network_url: str, name: str, fallback: str | None = None) -> str:
        """A collection's URL as eero publishes it, not as we guess it.

        The network object carries a `resources` map of links, and they are not
        all on the same API version — port forwards are served from 2.3 while
        the network itself is 2.2. Building paths by string-joining the network
        URL silently produced a 2.2 forwards path, so following the published
        link is the only reliable way.
        """
        n = await self.follow(network_url)
        url = ((n.get("resources") or {}).get(name)
               or fallback or f"{network_url.rstrip('/')}/{name}")
        return url.lstrip("/")

    async def entitlements(self, network_url: str) -> Json:
        """eero's authoritative Plus feature list for this network."""
        nid = network_url.rstrip("/").split("/")[-1]
        return await self.get(f"2.2/entitlements/networks/{nid}/features")

    async def network(self, url: str) -> Json:
        return await self.follow(url)

    async def eeros(self, network_url: str) -> list[Json]:
        return await self.get(f"{network_url}/eeros")

    async def devices(self, network_url: str) -> list[Json]:
        return await self.get(f"{network_url}/devices")

    async def profiles(self, network_url: str) -> list[Json]:
        return await self.get(f"{network_url}/profiles")

    async def blocked_devices(self, network_url: str) -> list[Json]:
        return await self.get(f"{network_url}/blacklist")

    async def speed_tests(self, network_url: str) -> list[Json]:
        return await self.get(f"{network_url}/speedtest")

    async def reservations(self, network_url: str) -> list[Json]:
        return await self.get(f"{network_url}/reservations")

    async def forwards(self, network_url: str) -> list[Json]:
        # Served from a different API version than the network itself.
        return await self.get(await self.resource(network_url, "forwards"))
