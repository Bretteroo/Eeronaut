"""Third-party dynamic DNS: what is configured, and how it last went.

eero's own dynamic DNS only publishes a name under `eero.online`. Pointing a
name at this network anywhere else is work this app does itself, which means it
holds the credentials for it — so they are encrypted at rest under the same
key the remembered session uses, and they are never returned by the API.

Two records, kept apart on purpose:

  config   provider, the fields that provider needs, and whether it is on.
           Written by the user. The secret fields are encrypted.
  state    the last address published, when, and how the provider replied.
           Written by the updater, and the only thing the status line reads.

`last_published` is not a log entry, it is a control: the providers ask that a
client only send an update when the address has actually changed, so this is
what makes that possible.

Both records are kept per network, keyed by eero's network id. An account with
several networks has a different public address on each and wants a different
name pointing at each, so a single shared record would publish one network's
address under another network's hostname — and switching networks in the
interface would silently rewrite the other one's credentials. The same mistake,
unscoped local state, had already been made once in this codebase for pinhole
descriptions; see core/notes.py for what it cost.
"""
from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass, asdict, field
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import settings
from .session import _load_or_create_secret          # same machine secret

_FILE = "ddns.json"


def _fernet() -> Fernet:
    """A key of its own, derived from the same machine secret.

    A separate `info` string from the session's, so a credential blob cannot be
    decrypted by anything holding the session key and the two can be rotated
    independently later.
    """
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"eeronaut",
               info=b"ddns-v1").derive(_load_or_create_secret())
    return Fernet(base64.urlsafe_b64encode(key))


def _path():
    return settings.data_dir / _FILE


def net_key(net: str) -> str:
    """eero's network id. A leading slash or version prefix is not a new key."""
    return str(net or "").rstrip("/").split("/")[-1]


@dataclass
class Config:
    provider: str = ""
    enabled: bool = False
    """The provider's own fields, as typed. Secrets are encrypted on the way to
    disk and never sent back out."""
    fields: dict[str, str] = field(default_factory=dict)


@dataclass
class State:
    last_published: str = ""
    last_attempt: float = 0.0
    last_success: float = 0.0
    """One of: ok, nochange, auth, notfound, blocked, provider, transport,
    nosession (no eero session to read the address with), unconfigured. `auth`, `notfound`, and `blocked` are the user's to fix and the
    updater stops trying; the rest it will retry."""
    result: str = "unconfigured"
    detail: str = ""
    """Set when the sentence in `detail` is this app's own rather than a
    provider's, so the interface can show it in the reader's language. A
    provider's reply text is passed through as it came and has no key: it is
    not ours to translate, and paraphrasing it would hide what was actually
    said."""
    detail_key: str = ""
    detail_args: dict[str, str] = field(default_factory=dict)
    """Whether the name actually resolves here, which is a separate question
    from whether the provider accepted the update. One of: "" (not looked up
    yet), match, mismatch, missing, unchecked (the lookup did not complete),
    unknowable (the provider never names the record — FreeDNS)."""
    resolve_state: str = ""
    resolved_ip: str = ""
    resolved_at: float = 0.0


def _blank() -> dict[str, Any]:
    return {"config": asdict(Config()), "state": asdict(State())}


def _read_file() -> dict[str, Any]:
    p = _path()
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text())
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    # The first shape of this file held one unscoped record. It is read as
    # belonging to no network rather than guessed at, so it cannot publish one
    # network's address under another's name.
    if "config" in data or "state" in data:
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def _read_raw(net: str = "") -> dict[str, Any]:
    rows = _read_file()
    out = _blank()
    row = rows.get(net_key(net)) or {}
    for k in ("config", "state"):
        if isinstance(row.get(k), dict):
            out[k].update(row[k])
    return out


def _save(rows: dict[str, Any]) -> None:
    """Write the file owner-only, like the session beside it.

    The provider secrets inside are encrypted, but the key is in the same
    folder, so anyone who can read both can read the tokens. This used to be
    written with the default mode, readable by every account on the machine.
    Written to a temporary file and moved into place, so a crash mid-write
    leaves the old file rather than half a new one.
    """
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        os.fchmod(f.fileno(), 0o600)
        f.write(json.dumps(rows, indent=1, sort_keys=True))
    os.replace(tmp, p)


def _write_raw(net: str, data: dict[str, Any]) -> None:
    rows = _read_file()
    rows[net_key(net)] = data
    _save(rows)


def configured_networks() -> list[str]:
    """Which networks have a configuration, for the scheduler to walk."""
    return [k for k, v in _read_file().items()
            if (v.get("config") or {}).get("provider")]


def _decrypt_fields(raw: dict[str, Any], secret_names: set[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in (raw or {}).items():
        if k in secret_names and isinstance(v, str) and v.startswith("enc:"):
            try:
                out[k] = _fernet().decrypt(v[4:].encode()).decode()
            except InvalidToken:
                # A blob written under a secret that has since been replaced.
                # Dropped rather than raised: the rest of the configuration is
                # still readable and the status line can say a field is missing.
                out[k] = ""
        else:
            out[k] = str(v)
    return out


def _encrypt_fields(fields: dict[str, str], secret_names: set[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in (fields or {}).items():
        if k in secret_names and v:
            out[k] = "enc:" + _fernet().encrypt(str(v).encode()).decode()
        else:
            out[k] = str(v)
    return out


def load(net: str, secret_names: set[str] | None = None) -> tuple[Config, State]:
    raw = _read_raw(net)
    cfg = Config(**{k: v for k, v in raw["config"].items()
                    if k in Config.__dataclass_fields__})
    cfg.fields = _decrypt_fields(raw["config"].get("fields") or {},
                                 secret_names or set())
    st = State(**{k: v for k, v in raw["state"].items()
                  if k in State.__dataclass_fields__})
    return cfg, st


def save_config(net: str, cfg: Config, secret_names: set[str]) -> None:
    raw = _read_raw(net)
    stored = asdict(cfg)
    stored["fields"] = _encrypt_fields(cfg.fields, secret_names)
    raw["config"] = stored
    _write_raw(net, raw)


def save_state(net: str, st: State) -> None:
    raw = _read_raw(net)
    raw["state"] = asdict(st)
    _write_raw(net, raw)


def record(net: str, result: str, detail: str = "",
           published: str | None = None, *, key: str = "",
           args: dict[str, str] | None = None) -> State:
    """Note the outcome of an attempt.

    `published` is only set on an outcome that actually placed the address, so a
    failure cannot leave the store thinking the address is live — which would
    suppress the retry that fixes it.
    """
    _, st = load(net)
    now = time.time()
    st.last_attempt = now
    st.result = result
    st.detail = detail
    st.detail_key = key
    st.detail_args = dict(args or {})
    if published is not None:
        if published != st.last_published:
            # A newly published address makes any earlier verdict about the
            # name stale: "match" against the address it used to hold would
            # read as confirmation of the address it holds now.
            st.resolve_state = ""
            st.resolved_ip = ""
            st.resolved_at = 0.0
        st.last_published = published
        st.last_success = now
    save_state(net, st)
    return st


def note_resolution(net: str, state: str, ip: str, when: float) -> State:
    """Record what a lookup of the published name found.

    Kept apart from `record()` because it must not touch `last_attempt` or
    `result`: this is not an update attempt, and letting a DNS lookup move the
    updater's own bookkeeping would either suppress a due update or reset a
    back-off the providers require.
    """
    _, st = load(net)
    st.resolve_state = state
    st.resolved_ip = ip
    st.resolved_at = when
    save_state(net, st)
    return st


def provider_of(net: str) -> str:
    """The configured provider, read without needing its secret names first.

    Chicken and egg: the secret names come from the provider, and the provider
    comes out of the same record. Read once without decrypting to learn which.
    """
    return str((_read_raw(net).get("config") or {}).get("provider") or "")


def clear(net: str) -> None:
    """Forget one network's configuration, leaving every other network alone.

    Put back to the blank entry rather than removed, so the file still shows
    the network with no provider."""
    rows = _read_file()
    k = net_key(net)
    if k not in rows:
        return
    rows[k] = _blank()
    _save(rows)


def ensure(net: str) -> None:
    """Give this network the blank entry: no provider, nothing to publish."""
    rows = _read_file()
    k = net_key(net)
    if k and k not in rows:
        rows[k] = _blank()
        _save(rows)
