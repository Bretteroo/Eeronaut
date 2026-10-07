"""Talking to dynamic DNS providers.

Every endpoint, field, and reply here was measured against the provider, with
the source it came from. Read that before changing any string in this file: a
wrong value does not raise, it leaves a hostname pointing at an address the
network no longer has.

Three rules the providers ask of a client, and all three live here rather than
in the caller:

  * a real User-Agent, or you get rate-limited or blocked;
  * only send an update when the address has actually changed;
  * act on the reply — a rejection is not something to retry on a timer.

The last one is why `Outcome.retry` exists. `auth`, `notfound`, and `blocked`
are the user's to fix and must not be retried; `provider` and `transport` are
worth trying again.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from ..core.config import app_version

# Identifies this client to the providers. Not decoration — No-IP: "it is
# important that your HTTP request include an HTTP User-Agent", and clients
# without an approved one "risk being rate-limited or blocked".
USER_AGENT = f"Eeronaut/{app_version()} (dynamic DNS updater)"


@dataclass
class Field:
    name: str
    label: str
    secret: bool = False
    placeholder: str = ""
    hint: str = ""
    # Not needed to publish. Left empty, it is not reported as missing.
    optional: bool = False


@dataclass
class Provider:
    id: str
    name: str
    kind: str                      # dyndns2 | duckdns | freedns | dynv6
    fields: list[Field]
    host: str = ""
    note: str = ""
    ipv6: bool = True

    @property
    def secret_names(self) -> set[str]:
        return {f.name for f in self.fields if f.secret}

    def fqdn(self, f: dict[str, str]) -> str:
        """The name this provider is being asked to point at us, if it is
        knowable from what was filled in.

        Worth knowing because a provider accepting an update and the name
        actually resolving are two different things — a No-IP hostname
        suspended for want of a confirmation click keeps accepting updates and
        replying `good` while it has stopped resolving.

        FreeDNS can answer it only when the optional hostname was typed in: its
        update URL carries an opaque token and never names the record. An empty
        string means "not knowable", which is reported as such rather than
        guessed at.
        """
        g = lambda k: (f.get(k) or "").strip().rstrip(".")   # noqa: E731
        if self.id == "duckdns":
            d = g("domain")
            return f"{d}.duckdns.org" if d else ""
        if self.id == "dynv6":
            return g("zone")
        return g("hostname")


_HOST = Field("hostname", "Hostname", placeholder="home.example.com")
_USER = Field("username", "Username")
_PASS = Field("password", "Password or DDNS key", secret=True,
              hint="Many providers issue a separate key for updates; either "
                   "works here.")

PROVIDERS: list[Provider] = [
    Provider(
        id="duckdns", name="DuckDNS", kind="duckdns",
        fields=[
            # "domain" is the name DuckDNS's update URL gives it, and what a
            # saved configuration is stored under. To the person filling it
            # in it is a subdomain, which is what duckdns.org calls it too.
            Field("domain", "Subdomain", placeholder="myhome",
                  hint="Just your subdomain, without .duckdns.org."),
            Field("token", "Token", secret=True),
        ],
    ),
    Provider(
        id="dynu", name="Dynu", kind="dyndns2",
        host="https://api.dynu.com/nic/update",
        fields=[_HOST, _USER, _PASS],
    ),
    Provider(
        id="dynv6", name="dynv6", kind="dynv6",
        fields=[
            Field("zone", "Zone", placeholder="myhome.dynv6.net",
                  hint="The zone name as it appears in dynv6."),
            Field("token", "Token", secret=True,
                  hint="The HTTP token for this zone."),
        ],
    ),
    Provider(
        id="freedns", name="FreeDNS (afraid.org)", kind="freedns",
        # The update URL carries only a token and never names the record, so
        # without the name typed in here nothing could show it or check that
        # it resolves; the dashboard showed "freedns" as the hostname. Never
        # sent to FreeDNS, and optional, so a setup saved without it still
        # publishes.
        fields=[Field("hostname", "Hostname",
                      placeholder="myhome.chickenkiller.com", optional=True,
                      hint="The name you added at FreeDNS, used to show it "
                           "and to check that it resolves."),
                Field("token", "Update token", secret=True,
                      hint="The random token from your FreeDNS update URL.")],
        note="FreeDNS gives each record its own update URL; only the token is "
             "needed.",
    ),
    Provider(
        id="noip", name="No-IP", kind="dyndns2",
        host="https://dynupdate.no-ip.com/nic/update",
        fields=[_HOST, _USER, _PASS],
        # Not something this app can do anything about, and precisely why it is
        # worth saying: a hostname suspended for want of a click in an email
        # stops resolving while the updates keep succeeding, so it looks exactly
        # like this app having broken.
        note="On a free No-IP account a hostname has to be confirmed every 30 "
             "days from a link they email you, or it stops resolving. Updates "
             "from here will not keep it alive.",
    ),
]

BY_ID = {p.id: p for p in PROVIDERS}


@dataclass
class Outcome:
    result: str                    # ok nochange auth notfound blocked provider transport
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.result in ("ok", "nochange")

    @property
    def retry(self) -> bool:
        """Whether trying again unprompted is appropriate.

        No-IP: clients that "do not properly respond to update return codes
        risk being blocked". A rejected credential retried on a timer is the
        behavior that gets an account blocked, so it is not retried.
        """
        return self.result in ("provider", "transport")


# The dyndns2 reply vocabulary. The first eight are on
# noip.com/integrate/response; the rest are Dynu's own list at
# dynu.com/DynamicDNS/IP-Update-Protocol, which is longer. Re-read 2026-09-09.
#
# Every word here is placed on the right side of one line: a result in
# ("auth", "notfound", "blocked") stops until the user changes something, and
# only "provider" and "transport" are retried. An unlisted word falls to
# "provider" and is retried every ten minutes for as long as it keeps coming
# back, which is why a rejection the providers do document must be listed —
# retrying one is the behavior No-IP says gets a client blocked.
_DYNDNS2 = {
    "good": ("ok", ""),
    "nochg": ("nochange", ""),
    "nohost": ("notfound", "The provider does not have that hostname on this "
                           "account."),
    "badauth": ("auth", "The provider rejected the credentials."),
    "badagent": ("blocked", "The provider refused this client."),
    "abuse": ("blocked", "The provider has blocked this account for update "
                         "abuse."),
    "911": ("provider", "The provider reported a problem on its side."),
    "notfqdn": ("notfound", "That hostname is not a fully qualified name."),
    "numhost": ("provider", "The provider refused the number of hostnames "
                            "sent."),
    "dnserr": ("provider", "The provider reported a DNS error on its side."),
    # "Requested feature is not available to this user" (No-IP), "feature is
    # only available to members" (Dynu). Nothing here can earn it, so it stops
    # rather than asking again every ten minutes for ever.
    "!donator": ("blocked", "The provider does not offer this on your "
                            "account."),
    # Dynu's own word for a fault on its side, beside 911.
    "servererror": ("provider", "The provider reported a problem on its "
                                "side."),
    # Dynu: "invalid request or badly formatted parameters". The values are
    # the user's to correct, so this stops too.
    "unknown": ("notfound", "The provider did not understand the update. "
                            "Check the hostname and credentials."),
}


def _read_dyndns2(body: str) -> Outcome:
    word = (body or "").strip().split()[0].lower() if body.strip() else ""
    known = _DYNDNS2.get(word)
    if known:
        return Outcome(known[0], known[1])
    return Outcome("provider", f"Unrecognized reply from the provider: {body.strip()[:80]!r}")


async def _get(client: httpx.AsyncClient, url: str, **kw: Any) -> httpx.Response:
    headers = {"User-Agent": USER_AGENT, **(kw.pop("headers", {}) or {})}
    return await client.get(url, headers=headers, timeout=20.0, **kw)


async def _update_dyndns2(client, prov: Provider, f: dict[str, str],
                          ip: str) -> Outcome:
    host = (f.get("hostname") or "").strip()
    if not host:
        return Outcome("notfound", "No hostname is set.")
    r = await _get(client, prov.host, params={"hostname": host, "myip": ip},
                   auth=((f.get("username") or "").strip(), f.get("password") or ""))
    if r.status_code == 401:
        return Outcome("auth", "The provider rejected the credentials.")
    if r.status_code >= 400:
        # Anything other than the 401 above, at any status. Treated as the
        # provider's side rather than a rejection to fix, which means it waits
        # out the ten minutes and tries again — the safe way to be wrong, since
        # a status these providers do not document is not something to stop
        # over permanently.
        return Outcome("provider", f"The provider answered {r.status_code}.")
    return _read_dyndns2(r.text)


async def _update_duckdns(client, prov: Provider, f: dict[str, str],
                          ip: str) -> Outcome:
    r = await _get(client, "https://www.duckdns.org/update",
                   params={"domains": (f.get("domain") or "").strip(),
                           "token": f.get("token") or "", "ip": ip,
                           "verbose": "true"})
    body = (r.text or "").strip()
    if r.status_code >= 400:
        return Outcome("provider", f"DuckDNS answered {r.status_code}.")
    if body.upper().startswith("OK"):
        # verbose=true answers OK\n<ip>\n<ipv6>\n<UPDATED|NOCHANGE>
        return Outcome("nochange" if "NOCHANGE" in body.upper() else "ok")
    # KO carries no reason, so there is nothing more honest to say than this.
    return Outcome("auth", "DuckDNS rejected the update. Check the domain and "
                           "token.")


async def _update_freedns(client, prov: Provider, f: dict[str, str],
                          ip: str) -> Outcome:
    token = (f.get("token") or "").strip()
    if not token:
        return Outcome("notfound", "No update token is set.")
    r = await _get(client, f"https://sync.afraid.org/u/{token}/",
                   params={"address": ip})
    if r.status_code >= 400:
        return Outcome("provider", f"FreeDNS answered {r.status_code}.")
    body = (r.text or "").strip()
    low = body.lower()
    if "no ip change" in low or "has not changed" in low:
        return Outcome("nochange")
    if "updated" in low:
        return Outcome("ok")
    return Outcome("provider", f"FreeDNS said: {body[:80]!r}")


async def _update_dynv6(client, prov: Provider, f: dict[str, str],
                        ip: str) -> Outcome:
    zone = (f.get("zone") or "").strip()
    if not zone:
        return Outcome("notfound", "No zone is set.")
    r = await _get(client, "https://dynv6.com/api/update",
                   params={"zone": zone, "token": f.get("token") or "",
                           "ipv4": ip})
    if r.status_code in (401, 403):
        return Outcome("auth", "dynv6 rejected the token.")
    if r.status_code >= 400:
        return Outcome("provider", f"dynv6 answered {r.status_code}.")
    # The reply format is not documented, so the status code carries the
    # verdict and the body is only read for the unchanged case.
    low = (r.text or "").strip().lower()
    if "unchanged" in low or "not changed" in low:
        return Outcome("nochange")
    return Outcome("ok")


_BY_KIND = {
    "dyndns2": _update_dyndns2,
    "duckdns": _update_duckdns,
    "freedns": _update_freedns,
    "dynv6": _update_dynv6,
}


async def update(provider_id: str, fields: dict[str, str], ip: str,
                 client: httpx.AsyncClient | None = None) -> Outcome:
    """Publish `ip` for one configuration.

    Does not decide whether an update is warranted — that is the caller's job,
    and the caller has the last published address to decide with.
    """
    prov = BY_ID.get(provider_id)
    if not prov:
        return Outcome("notfound", f"No provider called {provider_id!r}.")
    if not ip:
        return Outcome("transport", "This network has no public address to "
                                    "publish yet.")
    own = client is None
    client = client or httpx.AsyncClient()
    try:
        return await _BY_KIND[prov.kind](client, prov, fields, ip)
    except httpx.HTTPError as e:
        return Outcome("transport", f"Could not reach the provider: {e}")
    finally:
        if own:
            await client.aclose()
