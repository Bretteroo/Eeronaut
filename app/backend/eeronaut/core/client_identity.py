"""The client version Eeronaut presents to eero, kept across restarts.

eero may eventually refuse older client versions, and an unrecognized agent
silently loses about a third of the feature set, so the version presented has
to survive a restart rather than falling back to the built-in default.

The version is kept current by `client_update_watch`, once a day; the
environment has no say in it, and the agent it goes out in is always the
app's own (`Settings.effective_user_agent`).
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path

from .config import settings

log = logging.getLogger(__name__)

# One file for everything about how Eeronaut identifies itself to eero: the
# version it presents, and under "play" the last Play Store check
# (`client_version`). These used to be two files, folded in by `migrate`.
FILE = "client.json"
_OLD_IDENTITY = "client_identity.json"
_OLD_PLAY = "client_version.json"

@dataclass
class ClientIdentity:
    # Empty means "whatever the program shipped with", not an empty agent:
    # the defaults live in `settings` and this file only records a change.
    client_version: str = ""

    @classmethod
    def load(cls) -> "ClientIdentity":
        return cls(client_version=str(read_all().get("client_version") or ""))

    def save(self) -> None:
        write_all({**read_all(), **asdict(self)})


def _path() -> Path:
    return settings.data_dir / FILE


def _read(p: Path) -> dict:
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text())
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError, TypeError):
        # A corrupt file is not a reason to refuse to start; the built-in
        # default is a working value.
        log.warning("could not read %s; using the built-in client version", p)
        return {}


def read_all() -> dict:
    return _read(_path())


def write_all(data: dict) -> None:
    """Replace the file, through a temporary one so a crash mid-write leaves
    the old file rather than half a new one."""
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, p)


def migrate() -> None:
    """Fold the two files earlier versions kept into `client.json`.

    What `client.json` already holds wins, so running this twice, or after a
    downgrade and upgrade, changes nothing.
    """
    d = settings.data_dir
    old_identity, old_play = d / _OLD_IDENTITY, d / _OLD_PLAY
    if not (old_identity.exists() or old_play.exists()):
        return
    data = read_all()
    for k, v in _read(old_identity).items():
        if k == "client_version" and v:
            data.setdefault(k, v)
    if play := _read(old_play):
        data.setdefault("play", play)
    try:
        write_all(data)
        old_identity.unlink(missing_ok=True)
        old_play.unlink(missing_ok=True)
    except OSError:
        pass                            # read-only folder: the old files stay


def ensure() -> None:
    """Write every field, so the file shows the version in force from the
    start. `play` stays empty-valued until the first Play Store check. A
    `user_agent` an earlier version wrote is dropped: the agent is no longer
    configurable."""
    data = read_all()
    want = {"client_version": data.get("client_version") or settings.client_version,
            "play": data.get("play") or {"latest": None, "source": "",
                                         "checked_at": 0}}
    if want != data:
        try:
            write_all(want)
        except OSError:
            pass


def apply() -> None:
    """Put the saved version into force.

    Called at startup and after every write, so the running process and the
    file never disagree.
    """
    migrate()
    saved = ClientIdentity.load()
    if saved.client_version:
        settings.client_version = saved.client_version


def store(client_version: str) -> None:
    """Record a new version and put it into force."""
    ClientIdentity(client_version=client_version.strip()).save()
    apply()
