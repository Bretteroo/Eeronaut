"""Authentication for the web interface itself.

Distinct from the eero account session. That one proves the *server* may talk to
eero; this one proves the *browser* may talk to the server. Without it anyone
who can reach the port can reboot nodes, block clients, and read the Wi-Fi
password, which is not an acceptable default for something sitting on a home
LAN.

Design notes:

* The password is stored only as a scrypt hash with a per-install salt. scrypt
  is memory-hard and in the standard library, so this needs no new dependency.
* Sessions are signed tokens, not server-side state, so they survive a restart
  without a store. They carry an issue time and are rejected once too old.
* Failed attempts are rate limited per client address with a growing lockout,
  because a four-word password on a LAN is otherwise brute-forceable.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import stat
import time
from dataclasses import dataclass

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import settings

COOKIE_NAME = "eero_ui"
SESSION_MAX_AGE = 14 * 24 * 3600          # two weeks
# n=2**15 with r=8 needs roughly 33 MB, which is just over OpenSSL's default
# 32 MB ceiling, so maxmem is raised rather than weakening the parameters.
_SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1, "dklen": 32, "maxmem": 96 * 1024 * 1024}


def _auth_path():
    return settings.data_dir / "appauth.json"


def _secret() -> bytes:
    """Reuse the same install secret the eero session store derives from."""
    from .session import _load_or_create_secret
    return _load_or_create_secret()


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_secret(), salt="eero-ui-session")


# ----------------------------------------------------------------- password

def hash_password(password: str, salt: bytes | None = None) -> dict:
    salt = salt or os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return {"salt": salt.hex(), "hash": dk.hex(), "algo": "scrypt", "v": 1}


def is_configured() -> bool:
    return _auth_path().exists() or bool(os.environ.get("EERONAUT_UI_PASSWORD"))


def password_version() -> int:
    """A stamp that changes whenever the password does.

    Carried in every session token so that changing the password ends the
    sessions held elsewhere. Without it a change would leave a stolen cookie
    working, which is the thing someone changing their password is usually
    trying to stop. Absent from installs that predate it, which read as 0 and
    keep working until the first change.
    """
    p = _auth_path()
    if not p.exists():
        return 0
    try:
        return int(json.loads(p.read_text()).get("pv", 0))
    except (OSError, ValueError, TypeError):
        return 0


def check_password(password: str) -> None:
    """Raise ValueError if `password` is not acceptable as the interface
    password. Separate from `set_password` so setup can refuse a bad one
    before it changes anything else."""
    if len(password) < 8:
        raise ValueError("password must be at least 8 characters")


def set_password(password: str) -> None:
    check_password(password)
    p = _auth_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    rec = hash_password(password)
    # A fresh random stamp rather than a count, because sessions only ever
    # compare it for equality and a count can repeat. Resetting a forgotten
    # password means deleting this file, which takes the count back to zero,
    # so the next password would issue pv=1 again and revive any cookie still
    # held from the first one. A clock is not enough either: two passwords set
    # in the same second would stamp the same value.
    rec["pv"] = secrets.randbits(48)
    p.write_text(json.dumps(rec))
    p.chmod(stat.S_IRUSR | stat.S_IWUSR)


def env_password_in_use() -> bool:
    """Whether the password comes from the environment rather than from disk.

    `verify_password` prefers `EERONAUT_UI_PASSWORD` when it is set, so writing a
    new one to disk would change nothing and the old password would keep
    working. Callers check this and refuse rather than reporting a success that
    did not happen.
    """
    return bool(os.environ.get("EERONAUT_UI_PASSWORD"))


def verify_password(password: str) -> bool:
    """Constant-time check against the stored hash, or the env override."""
    env = os.environ.get("EERONAUT_UI_PASSWORD")
    if env:
        # Compared in constant time so timing does not reveal a prefix match.
        return hmac.compare_digest(password.encode(), env.encode())
    p = _auth_path()
    if not p.exists():
        return False
    try:
        rec = json.loads(p.read_text())
        expect = bytes.fromhex(rec["hash"])
        got = hashlib.scrypt(password.encode(),
                             salt=bytes.fromhex(rec["salt"]), **_SCRYPT)
    except (ValueError, KeyError):
        return False
    return hmac.compare_digest(expect, got)


# ------------------------------------------------------------- data folder

def unwritable_message() -> str:
    d = settings.data_dir
    return (f"the data folder {d} cannot be written by this process "
            f"(uid {os.getuid()}). If it is a bind mount, give it to that user: "
            f"chown -R {os.getuid()} <the folder on the host>")


def data_dir_writable() -> bool:
    """Whether the data folder takes a write, tried rather than guessed from
    permission bits, which say nothing about read-only mounts."""
    d = settings.data_dir
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / f".write-test-{os.getpid()}"
        probe.write_text("")
        probe.unlink()
        return True
    except OSError:
        return False


def env_password_problem() -> str | None:
    """Why `EERONAUT_UI_PASSWORD` is not acceptable, or None. The same eight
    characters a password set through the page must have."""
    env = os.environ.get("EERONAUT_UI_PASSWORD")
    if env is not None and env != "" and len(env) < 8:
        return "EERONAUT_UI_PASSWORD must be at least 8 characters"
    return None


# ------------------------------------------------------------------ session

def issue_session() -> str:
    return _serializer().dumps({"iat": int(time.time()), "n": secrets.token_hex(8),
                                "pv": password_version()})


def valid_session(token: str | None) -> bool:
    if not token:
        return False
    try:
        data = _serializer().loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return False
    # A token issued under an earlier password is no longer a session.
    return int((data or {}).get("pv", 0)) == password_version()


# --------------------------------------------------------------- rate limit

@dataclass
class _Attempts:
    count: int = 0
    blocked_until: float = 0.0


_attempts: dict[str, _Attempts] = {}
_FREE_TRIES = 5

# And the same again for the whole interface, whoever is asking.
#
# The per-address count is only as good as the address, and the address comes
# from the connection unless somebody has put a proxy in front and said so —
# at which point it comes from a header. Run with proxy headers trusted from
# anywhere, as this image used to be, a guesser sends a different
# `X-Forwarded-For` each time and is never counted twice: measured at nine
# wrong passwords with no delay at all. The image no longer does that, and
# this is here so that getting it wrong again costs a slow brute force rather
# than an unlimited one.
#
# Far looser than the per-address ceiling, because this one can be tripped by
# somebody else: twenty wrong passwords across every client before it starts,
# and the same five-minute cap, which leaves a guesser about a dozen tries an
# hour. A correct password clears it, so the way out is to know the password.
_all = _Attempts()
_GLOBAL_FREE_TRIES = 20


def _delay_for(a: _Attempts, free: int) -> None:
    if a.count > free:
        # Doubling backoff, capped, so a determined guesser gets nowhere while
        # a fat-fingered human is only briefly inconvenienced.
        a.blocked_until = time.time() + min(2 ** (a.count - free), 300)


def _left(a: _Attempts) -> int:
    return max(0, int(a.blocked_until - time.time()))


def lockout_remaining(client: str) -> int:
    a = _attempts.get(client)
    return max(_left(a) if a else 0, _left(_all))


def record_failure(client: str) -> int:
    """Count a failed attempt and return how long the caller must now wait."""
    a = _attempts.setdefault(client, _Attempts())
    a.count += 1
    _delay_for(a, _FREE_TRIES)
    _all.count += 1
    _delay_for(_all, _GLOBAL_FREE_TRIES)
    return lockout_remaining(client)


def record_success(client: str) -> None:
    _attempts.pop(client, None)
    _all.count = 0
    _all.blocked_until = 0.0
