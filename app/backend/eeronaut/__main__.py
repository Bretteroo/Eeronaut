"""``python -m eeronaut``: serve Eeronaut on ``EERONAUT_PORT`` (3340).

What the Docker image runs. In Home Assistant the port comes from the app's
options (``core/haoptions.py``), and the same page is also served on the port
the Supervisor sends the sidebar's requests to.

No proxy headers are trusted from anywhere but this machine, uvicorn's own
default. With ``--forwarded-allow-ips '*'`` uvicorn believed the
``X-Forwarded-For`` of whoever connected, so the address the sign-in lockout
counts against was one the attacker chose: a different one per request and the
lockout never fired.
"""
from __future__ import annotations

import asyncio
import contextlib
import os

import uvicorn

from .core import haoptions

APP = "eeronaut.main:app"


class _Alongside(uvicorn.Server):
    """A second listener for the same app. It leaves the signals to the main
    server, which stops it when it stops itself."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


async def _serve(main: uvicorn.Server, extra: uvicorn.Server) -> None:
    other = asyncio.create_task(extra.serve())
    try:
        await main.serve()
    finally:
        extra.should_exit = True
        await asyncio.gather(other, return_exceptions=True)


def main() -> None:
    # The app's options set the port before anything reads it.
    haoptions.apply()
    port = int(os.environ.get("EERONAUT_PORT") or 3340)
    ingress = haoptions.ingress_port()
    if not ingress or ingress == port:
        uvicorn.run(APP, host="0.0.0.0", port=port)
        return
    # Only the web port's server runs startup and shutdown, so there is one
    # Eeronaut behind both ports, with one set of background watchers.
    web = uvicorn.Server(uvicorn.Config(APP, host="0.0.0.0", port=port))
    sidebar = _Alongside(uvicorn.Config(APP, host="0.0.0.0", port=ingress, lifespan="off"))
    asyncio.run(_serve(web, sidebar))


if __name__ == "__main__":
    main()
