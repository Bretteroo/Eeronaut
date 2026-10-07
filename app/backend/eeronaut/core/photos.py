"""Profile photos, kept on this machine and nowhere else.

eero's profiles carry no picture, so the face on a profile card is something
the person running Eeronaut added. It never goes to eero: the file lives in the
data directory beside the session, keyed by network and profile so two networks
with a profile "3" cannot share one. Small by construction — the browser crops
and shrinks the picture before sending it — with a cap here regardless, since
this endpoint is reachable without going through the interface.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from .config import settings

MAX_BYTES = 1_048_576
_ID = re.compile(r"^\d+$")

# Decided from the bytes, not from a header anybody can set.
_MAGIC: tuple[tuple[bytes, str, str], ...] = (
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"RIFF", "webp", "image/webp"),   # checked further below
)


def sniff(data: bytes) -> tuple[str, str] | None:
    """(extension, media type) for a JPEG, PNG, or WebP; None for anything else."""
    for magic, ext, media in _MAGIC:
        if data.startswith(magic):
            if ext == "webp" and data[8:12] != b"WEBP":
                return None
            return ext, media
    return None


def _net_id(network_url: str) -> str:
    tail = network_url.rstrip("/").split("/")[-1]
    if not _ID.match(tail):
        raise ValueError("network id is not numeric")
    return tail


def _folder() -> Path:
    return settings.data_dir / "photos"


def _stem(network_url: str, profile_id: str) -> str:
    if not _ID.match(profile_id):
        raise ValueError("profile id is not numeric")
    return f"{_net_id(network_url)}-{profile_id}"


def find(network_url: str, profile_id: str) -> Path | None:
    """The stored photo, whichever type it was, or None."""
    stem = _stem(network_url, profile_id)
    for _, ext, _ in _MAGIC:
        p = _folder() / f"{stem}.{ext}"
        if p.is_file():
            return p
    return None


def media_type(path: Path) -> str:
    return {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[path.suffix[1:]]


def version(path: Path) -> int:
    """Changes whenever the file does, so a browser can be told to refetch."""
    return int(path.stat().st_mtime_ns // 1_000_000)


def save(network_url: str, profile_id: str, data: bytes) -> Path:
    """Store a photo, replacing any earlier one of a different type.

    Written to a temporary name and renamed into place, so a reader never
    sees half a file.
    """
    kind = sniff(data)
    if kind is None:
        raise ValueError("not a JPEG, PNG, or WebP")
    if len(data) > MAX_BYTES:
        raise ValueError("too large")
    ext, _ = kind
    folder = _folder()
    folder.mkdir(parents=True, exist_ok=True)
    stem = _stem(network_url, profile_id)
    target = folder / f"{stem}.{ext}"
    tmp = folder / f"{stem}.{ext}.tmp"
    tmp.write_bytes(data)
    os.replace(tmp, target)
    for _, other, _ in _MAGIC:
        if other != ext:
            (folder / f"{stem}.{other}").unlink(missing_ok=True)
    return target


def remove(network_url: str, profile_id: str) -> bool:
    """Delete the photo. True if there was one."""
    p = find(network_url, profile_id)
    if p is None:
        return False
    p.unlink(missing_ok=True)
    return True
