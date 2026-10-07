"""Runtime configuration."""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings

# The eero app version presented until the first daily check moves it on.
DEFAULT_CLIENT_VERSION = "26.9.1.36793"


class Settings(BaseSettings):
    model_config = {"env_prefix": "EERONAUT_", "extra": "ignore"}

    api_base: str = "https://api-user.e2ro.com/"
    # The upstream app refuses to attach the session token to any other host.
    # Mirrored here so a redirect can never leak credentials.
    token_hosts: tuple[str, ...] = ("api-user.e2ro.com",)

    data_dir: Path = Path(os.environ.get("EERONAUT_DATA_DIR", "/data"))
    session_file: str = "session.json"

    # Local gRPC control plane. Optional: the app is
    # fully functional without it, just with slower status polling.
    local_enabled: bool = True
    local_port: int = 3001
    local_timeout_s: float = 2.0

    http_timeout_s: float = 20.0
    # Seconds to reuse a GET response within a single request-scoped client.
    # Deliberately short: long enough to collapse the repeat reads a page does,
    # short enough that it cannot show a stale value after a change. Set to 0
    # to disable.
    read_cache_seconds: float = 5.0

    # eero's API parses the client version out of the User-Agent and uses it to
    # decide which features a network is "capable" of. An unrecognized agent
    # fails every has_min_mobile_version check, which silently removes about a
    # third of the feature set (ad blocking, app blocking, DNS filtering,
    # device management, historical usage). We therefore present a version in
    # the form the API expects.
    client_version: str = DEFAULT_CLIENT_VERSION
    android_version: str = "14"

    @field_validator("client_version", mode="before")
    @classmethod
    def _not_from_the_environment(cls, _: object) -> str:
        """Never read from the environment. The `EERONAUT_` prefix would otherwise
        take it from EERONAUT_CLIENT_VERSION, which no longer exists: Eeronaut
        keeps the version current itself (see `client_update_watch`), and a
        pinned one would only fall behind. The saved one, if any, is applied
        on top at startup."""
        return DEFAULT_CLIENT_VERSION

    @property
    def effective_user_agent(self) -> str:
        """The mobile app's own agent, carrying the version presented."""
        return (f"eero-android/{self.client_version} Dalvik/2.1.0 "
                f"(Linux; U; Android {self.android_version})")

    @property
    def session_path(self) -> Path:
        return self.data_dir / self.session_file


settings = Settings()


def app_version() -> str:
    """The installed version, from pyproject rather than a second constant that
    would drift from it. Falls back when running from a source tree that was
    never installed."""
    try:
        from importlib.metadata import version
        return version("eeronaut")
    except Exception:
        return "dev"
