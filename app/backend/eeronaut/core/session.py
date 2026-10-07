"""Session token storage.

Two modes, chosen by the "remember me" checkbox on the login screen:

* not remembered - the token lives only in this process, and is gone on restart
* remembered     - the token is encrypted at rest under a key derived from a
                   secret file in the same data folder. That keeps it out of
                   anything that copies the session file on its own, but it is
                   not protection against someone with the whole folder: the
                   key is right beside it, so treat the data folder as a
                   credential

The eero session token is the whole credential: anything holding it can act as
the account. It is never logged, never returned to the browser, and never
written in plaintext.
"""
from __future__ import annotations

import base64
import json
import os
import stat
from dataclasses import dataclass, asdict
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import settings


def _secret_path() -> Path:
    return settings.data_dir / ".secret"


def _load_or_create_secret() -> bytes:
    p = _secret_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        return p.read_bytes()
    secret = os.urandom(32)
    p.write_bytes(secret)
    p.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
    return secret


def _fernet() -> Fernet:
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"eeronaut",
               info=b"session-v1").derive(_load_or_create_secret())
    return Fernet(base64.urlsafe_b64encode(key))


@dataclass
class Session:
    token: str
    login: str = ""
    user_id: str = ""
    network_url: str = ""


class SessionStore:
    """Holds the active session, optionally persisting it."""

    def __init__(self) -> None:
        self._session: Session | None = None
        self._persisted = False
        # Why the last load failed, for the interface to surface rather than
        # silently showing a sign-in screen with no explanation.
        self.last_error = ""

    @property
    def session(self) -> Session | None:
        if self._session is None:
            self._session = self._read()
            self._persisted = self._session is not None
        return self._session

    @property
    def token(self) -> str | None:
        s = self.session
        return s.token if s else None

    def set(self, session: Session, remember: bool) -> None:
        self._session = session
        if remember:
            self._write(session)
            self._persisted = True
        else:
            self.forget_disk()

    def update(self, **fields: str) -> None:
        if not self._session:
            return
        for k, v in fields.items():
            setattr(self._session, k, v)
        if self._persisted:
            self._write(self._session)

    def clear(self) -> None:
        self._session = None
        self._persisted = False
        self.forget_disk()

    def forget_disk(self) -> None:
        p = settings.session_path
        if p.exists():
            p.unlink()

    # ------------------------------------------------------------------ on disk

    def _write(self, s: Session) -> None:
        p = settings.session_path
        p.parent.mkdir(parents=True, exist_ok=True)
        blob = _fernet().encrypt(json.dumps(asdict(s)).encode())
        p.write_bytes(blob)
        p.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def _read(self) -> Session | None:
        """Load a persisted session, or report why it could not be loaded.

        Deliberately does **not** delete the file on failure. It used to, which
        meant a transient read error permanently signed the user out with no
        explanation. An unreadable session is treated as absent; a later
        successful sign-in overwrites it, and the last error is available for
        the interface to explain itself.
        """
        p = settings.session_path
        if not p.exists():
            self.last_error = ""
            return None
        try:
            data = json.loads(_fernet().decrypt(p.read_bytes()))
            self.last_error = ""
            return Session(**data)
        except InvalidToken:
            # Almost always the install secret changing underneath us, which is
            # unrecoverable but not a reason to destroy evidence.
            self.last_error = ("the stored session could not be decrypted; "
                               "sign in again to replace it")
        except (ValueError, TypeError) as exc:
            self.last_error = f"the stored session is unreadable ({exc})"
        except OSError as exc:
            self.last_error = f"the stored session could not be read ({exc})"
        return None


store = SessionStore()
