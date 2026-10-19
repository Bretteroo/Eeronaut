"""The Home Assistant app's options: the port Eeronaut listens on.

Home Assistant writes what was entered on the app's Configuration tab to
``/data/options.json`` before it starts the container. Eeronaut reads its port
from there and puts it where every other install sets it, the environment
(``EERONAUT_PORT``), so the rest of Eeronaut sees no difference. Outside Home
Assistant nothing here does anything.

The page in Home Assistant's sidebar comes through ingress, on a port of the
Supervisor's choosing (the app's ``ingress_port: 0``): with a fixed one, moving
the web port would have broken the sidebar. Eeronaut asks the Supervisor which
port that is and serves the same page there as well (``eeronaut.__main__``).
"""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from .ingress import enabled as in_home_assistant

#: Where Home Assistant leaves the options entered for the app.
OPTIONS = Path("/data/options.json")
#: The Supervisor's own API, reachable from an app that asks for it
#: (``hassio_api: true``) with the token it is given.
SUPERVISOR_INFO = "http://supervisor/addons/self/info"

#: Each option and the variable it sets.
PORTS = {"web_port": "EERONAUT_PORT"}


def _port(value) -> int | None:
    ok = isinstance(value, int) and not isinstance(value, bool) and 0 < value < 65536
    return value if ok else None


def apply(path: Path = OPTIONS) -> dict:
    """Set the port from the app's options, before anything reads it.

    Returns the options found: empty outside Home Assistant, or when the file
    is missing or unreadable, in which case the default stands.
    """
    if not in_home_assistant():
        return {}
    try:
        options = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(options, dict):
        return {}
    for option, variable in PORTS.items():
        if port := _port(options.get(option)):
            os.environ[variable] = str(port)
    return options


def ingress_port(timeout: float = 5.0) -> int | None:
    """The port the Supervisor sends the sidebar's page to, or None.

    None outside Home Assistant, and whenever the Supervisor cannot be asked;
    the page is then still served on the web port.
    """
    token = os.environ.get("SUPERVISOR_TOKEN", "")
    if not in_home_assistant() or not token:
        return None
    request = urllib.request.Request(SUPERVISOR_INFO,
                                     headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            info = json.load(answer)
    except (OSError, ValueError):
        return None
    data = info.get("data") if isinstance(info, dict) else None
    return _port(data.get("ingress_port")) if isinstance(data, dict) else None
