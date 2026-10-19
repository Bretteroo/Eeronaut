"""Home Assistant's ingress: Eeronaut's page inside Home Assistant.

The Home Assistant app (homeassistant/eeronaut/) shows Eeronaut in Home
Assistant's sidebar. Home Assistant serves an app's page through its own
proxy, at ``/api/hassio_ingress/<token>/`` on Home Assistant's address, and its
Supervisor passes each request on with the prefix taken off. ``X-Ingress-Path``
names that prefix. The page needs it, or every ``/api/...`` it asks for goes to
Home Assistant's own API, so the index carries it to the page in a meta tag
(frontend/src/lib/base.ts).

A request that came this way has been signed in by Home Assistant, which only
lets its administrators open the page (the app's ``panel_admin``), so it needs
no interface password of its own. That makes the test below the one that
matters. Headers are anyone's to send, so they count only when the app said so
(``EERONAUT_HA_INGRESS``, set in its config) and the request came from the
Supervisor's own address on Home Assistant's internal network, which nothing
outside that machine can use.
"""
from __future__ import annotations

import html
import ipaddress
import os
import re

#: The Supervisor's address on Home Assistant's internal network, which every
#: ingress request comes from.
SUPERVISOR = ipaddress.ip_address("172.30.32.2")

_PREFIX = re.compile(r"/api/hassio_ingress/[A-Za-z0-9_-]+")


def enabled() -> bool:
    """Whether this copy is running as the Home Assistant app."""
    return os.environ.get("EERONAUT_HA_INGRESS", "").strip().lower() in {"1", "true", "yes"}


def client_host(connection) -> str | None:
    """The address a request came from, if it says."""
    client = getattr(connection, "client", None)
    return client.host if client else None


def _from_supervisor(host: str | None) -> bool:
    try:
        return ipaddress.ip_address(host or "") == SUPERVISOR
    except ValueError:
        return False


def prefix(request) -> str:
    """The ingress path this request came through, or '' if it did not."""
    if not enabled() or not _from_supervisor(client_host(request)):
        return ""
    path = (request.headers.get("x-ingress-path") or "").strip().rstrip("/")
    return path if _PREFIX.fullmatch(path) else ""


def tag_page(body: bytes, path: str) -> bytes:
    """index.html, with its own files named from the root it is served under.

    The build names them relative to the page (``./assets/...``), which only
    works on a page at the top: the one at ``/v/<view>`` would look for
    ``/v/assets``. Here they are made absolute, under the ingress path when
    there is one, and the page is told that path for the URLs it builds
    itself.
    """
    if path:
        # Before the files below, whose new names start /api/ too.
        body = body.replace(b'href="/api/', f'href="{path}/api/'.encode())
    body = body.replace(b'="./', f'="{path}/'.encode())
    if not path:
        return body
    tag = f'<meta name="eeronaut-base" content="{html.escape(path, quote=True)}" />'
    return body.replace(b"<head>", b"<head>\n    " + tag.encode(), 1)
