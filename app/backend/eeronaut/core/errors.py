"""Exception types surfaced to the API layer."""
from __future__ import annotations


class EeroError(Exception):
    """Base class for anything that went wrong talking to eero."""


class NotAuthenticated(EeroError):
    """No session, or the session was rejected."""


class VerificationRequired(EeroError):
    """Login accepted; a verification code is now needed."""


class UpstreamError(EeroError):
    """eero returned an error response."""

    def __init__(self, status: int, message: str, payload: object = None):
        super().__init__(f"eero returned {status}: {message}")
        self.status = status
        self.message = message
        self.payload = payload


class CloudUnreachable(EeroError):
    """eero's cloud could not be reached at all.

    Distinct from `UpstreamError`, which is eero answering with a refusal.
    This is no answer: DNS failed, the connection was refused, the request
    timed out. It is the ordinary state during an internet outage — which is
    when somebody is most likely to open this interface — so it must read as
    "eero's cloud cannot be reached from here" rather than as a fault in the
    app.
    """


class LocalUnavailable(EeroError):
    """The local gRPC channel could not be reached."""
