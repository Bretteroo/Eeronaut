"""Application entrypoint."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .api import admins as admins_api
from .api import ddns as ddns_api, appauth as appauth_api
from .api import auth, config as config_api, insights, local as local_api
from .api import extras, network, nodedetail, nodes, security
from .api import settings as settings_api
from .api import themes as themes_api
from .core.themes import ENGINE_VERSION as THEME_ENGINE
from .core import appauth, burst, datadir
from .core.config import app_version, settings
from .core.errors import (CloudUnreachable, LocalUnavailable, NotAuthenticated,
                          UpstreamError)
from .core.upstream_messages import humanize

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
# httpx logs every request at INFO with its full URL, and three of the dynamic
# DNS providers take their token in the URL: every update wrote the secret to
# the container log, which is the thing people paste into bug reports.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("eeronaut")


def _name_process() -> None:
    """Show up as "eeronaut" in process lists instead of "python".

    Linux keeps a short name per thread that top, ps and GNOME's System
    Monitor show, and threads started later copy it, so naming the main
    thread at import covers the server. Elsewhere this does nothing.
    """
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        PR_SET_NAME = 15
        libc.prctl(PR_SET_NAME, b"eeronaut", 0, 0, 0)
    except (OSError, AttributeError):
        pass


_name_process()

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Pooled gRPC channels outlive individual requests, so close them here.

    Also where the background watchers live. Two of them have to run whether
    or not anybody has the interface open: a name that only updates while
    somebody is looking at a browser tab is not dynamic DNS, and an outage
    only says how it failed while it is failing — which on this network is at
    ten past six in the morning.

    The third is the opposite, and deliberately so. `burst` asks eero to
    publish live client rates, and asks only while somebody is actually
    looking; with nobody there it costs eero's service nothing, which is the
    same bargain eero's own app strikes when it goes to the background.
    """
    from .core import (app_update, client_identity, client_update_watch,
                       ddns_watch, identity_watch, wan_watch)
    # Refused outright rather than accepted: a short password from the
    # environment is the one way round the minimum the page enforces.
    if problem := appauth.env_password_problem():
        raise RuntimeError(problem)
    # The variables used to be named EERO_*. One left behind is ignored, which
    # for EERO_UI_PASSWORD or EERO_DATA_DIR would otherwise pass unnoticed.
    if old := sorted(k for k in os.environ if k.startswith("EERO_")):
        log.warning("Ignoring %s: these settings are now named EERONAUT_*.",
                    ", ".join(old))
    if not appauth.data_dir_writable():
        log.error("%s. Nothing can be saved: not the password, not the eero "
                  "session.", appauth.unwritable_message())
    else:
        datadir.tidy()
    # Before anything talks to eero: the agent a request carries decides which
    # features the network is told it has.
    client_identity.apply()
    # After apply, so client.json records the version actually in force.
    if appauth.data_dir_writable():
        from .core.session import store
        datadir.ensure_defaults(store.session.network_url if store.session else "")
    ddns_watch.start()
    wan_watch.start()
    client_update_watch.start()
    identity_watch.start()
    app_update.start()
    burst.start()
    yield
    await burst.stop()
    await app_update.stop()
    await identity_watch.stop()
    await client_update_watch.stop()
    await wan_watch.stop()
    await ddns_watch.stop()
    try:
        from .clients.local import close_channels
        await close_channels()
    except Exception:
        pass


# No generated API docs: /docs, /redoc and /openapi.json sit outside /api/,
# where the interface password does not reach, and they describe every
# endpoint to anyone who can reach the port.
app = FastAPI(title="Eeronaut", version="1.0.0",
              description="A web interface for eero mesh networks.",
              lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

app.include_router(appauth_api.router)
app.include_router(auth.router)
app.include_router(network.router)
app.include_router(nodes.router)
app.include_router(config_api.router)
app.include_router(admins_api.router)
app.include_router(insights.router)
app.include_router(local_api.router)
app.include_router(security.router)
app.include_router(settings_api.router)
app.include_router(extras.router)
app.include_router(nodedetail.router)
app.include_router(ddns_api.router)
app.include_router(themes_api.router)


# Paths reachable without an interface session: the access endpoints
# themselves, the health check, the theme files (the sign-in form is drawn
# by a theme, so its stylesheet loads before there is a session), and
# anything that is not the API (the SPA has to load in order to show a
# sign-in form).
_OPEN_PREFIXES = ("/api/app/", "/api/health", "/api/themes")


@app.middleware("http")
async def require_interface_session(request: Request, call_next):
    """Gate the whole API behind the interface password.

    Applied as middleware rather than a per-router dependency deliberately: with
    sixty-odd endpoints, a dependency is one you eventually forget to add to a
    new route, and forgetting here means exposing node reboots and the Wi-Fi
    password to anyone who can reach the port.
    """
    path = request.url.path
    if path.startswith("/api/") and not path.startswith(_OPEN_PREFIXES):
        # Closed both before and after setup. First-run setup only needs the
        # /api/app endpoints, so leaving the rest open until a password exists
        # would expose an unattended deployment that never finished setup.
        if not appauth.valid_session(request.cookies.get(appauth.COOKIE_NAME)):
            detail = ("interface sign-in required" if appauth.is_configured()
                      else "set an interface password first")
            return JSONResponse(status_code=401, content={"detail": detail})
        # Somebody with a session just asked for something, so the interface is
        # open in front of them. The one thing that depends on knowing: live
        # client rates, which eero publishes only while asked. Deliberately not
        # counting /api/health or the sign-in endpoints above — a container
        # health probe is not a person.
        burst.seen()
    return await call_next(request)


# What a page may load, sent with every response. The one that matters is
# that nothing is fetched from anywhere but this server: a theme somebody
# installs brings its own stylesheet, and without this a hostile one could
# send what is on the page elsewhere through a `url()`, or run script from an
# SVG opened at its own address. Styles may be inline because the interface
# writes its own layout rules into the page and sets styles on elements; no
# script may be.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
       "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", CSP)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


@app.exception_handler(NotAuthenticated)
async def _not_authenticated(request: Request, exc: NotAuthenticated) -> JSONResponse:
    return JSONResponse(status_code=401, content={"detail": "not signed in"})


@app.exception_handler(UpstreamError)
async def _upstream_error(request: Request, exc: UpstreamError) -> JSONResponse:
    """eero rejected or failed the call.

    A client error from eero (403 not entitled, 404 missing, 409 conflict) is
    passed through with its own status so the interface can react to it — a
    forbidden feature must not look like a gateway failure, and must never look
    like a lost session. Everything else (5xx, network) is a genuine gateway
    error.
    """
    status = exc.status if exc.status in (403, 404, 409) else 502
    # eero answers with a key, not a sentence. Translated here rather than in
    # each caller so no route can forget and put `error.network.adblock.enabled`
    # in front of somebody. `upstream_error` keeps the key itself for anyone
    # reading the network tab.
    return JSONResponse(status_code=status,
                        content={"detail": humanize(exc.message),
                                 "upstream_error": exc.message,
                                 "upstream_status": exc.status})


@app.exception_handler(CloudUnreachable)
async def _cloud_unreachable(request: Request, exc: CloudUnreachable) -> JSONResponse:
    """eero's cloud gave no answer at all.

    503 rather than 502: nothing is wrong with the request or with eero, the
    machine simply could not reach it. The raw transport message is kept for
    anyone reading the network tab and left out of the sentence, which has to
    make sense to somebody whose internet is down.
    """
    return JSONResponse(status_code=503,
                        content={"detail": "eero's cloud could not be reached "
                                           "from here. Check this machine's "
                                           "internet connection.",
                                 "transport_error": str(exc),
                                 "cloud_unreachable": True})


@app.exception_handler(LocalUnavailable)
async def _local_unavailable(request: Request, exc: LocalUnavailable) -> JSONResponse:
    """The local gRPC plane is not reachable — most often because no client
    identity has been enrolled yet. This is an expected state, not a crash, so
    it must not surface as a 500: the pages that use it show an "enable local
    control" message when they see this."""
    return JSONResponse(status_code=503,
                        content={"detail": str(exc) or "local control unavailable",
                                 "local_unavailable": True})


@app.get("/api/health")
async def health() -> dict[str, object]:
    # The theme engine's version beside the program's, for somebody building
    # a theme against this install.
    return {"ok": True, "local_enabled": settings.local_enabled,
            "version": app_version(), "theme_engine": THEME_ENGINE}


STATIC = Path(__file__).parent / "static"
if not STATIC.is_dir():
    # Said rather than left to a bare {"detail":"Not Found"} at /, which is all
    # a run from source shows when the interface was never built.
    log.warning("No interface at %s, so the page will not load. Build it with "
                "`npm ci && npm run build` in app/frontend.", STATIC)
if STATIC.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str) -> Response:
        # An unmatched /api path is a mistake, not a deep link. This route is
        # the last one registered, so it used to answer a removed or mistyped
        # endpoint with the HTML shell and a 200 — which reads as success to
        # anything expecting JSON and hides the typo from whoever made it.
        if path.startswith("api/"):
            return JSONResponse(status_code=404,
                                content={"detail": f"no such endpoint: /{path}"})
        # Only a file inside the build. The path arrives percent-decoded, so
        # `/%2Fetc%2Fhostname` came in as an absolute path, and joining an
        # absolute path onto a directory discards the directory: this route
        # served any file on the machine, the install secret included, to
        # anyone who could reach the port and without a session.
        root = STATIC.resolve()
        candidate = (STATIC / path).resolve()
        if path and candidate.is_relative_to(root) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC / "index.html")
