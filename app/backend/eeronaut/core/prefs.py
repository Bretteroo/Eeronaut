"""User interface preferences: the top level of settings.json, and each
network's feature filters in its section there (see `settingsfile`)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields

from . import settingsfile

# The preferences that belong to a network rather than to the person reading
# it. Whether a network's unavailable features are worth showing depends on
# that network: one with no subscription and old hardware is mostly marks,
# and one paying for everything has nothing to hide. Held per network, with
# the top-level value as the default a network falls back to until it says
# otherwise — which is also what carries an existing choice forward from
# before this was per network.
PER_NETWORK = ("hide_subscription_gated", "hide_capability_limited",
               "hide_plus_badges")


@dataclass
class Prefs:
    # Remove features that are unavailable purely because the network has no
    # eero Plus subscription. These are the ones that read as advertising.
    hide_subscription_gated: bool = False
    # Remove features unavailable because of node hardware or firmware. Off by
    # default: "your hardware cannot do this" is useful information, not a
    # sales pitch.
    hide_capability_limited: bool = False
    # Remove the "eero Plus" marks from features that belong to the
    # subscription. Off by default: which features are part of a paid tier is
    # worth knowing whether or not you pay for it.
    hide_plus_badges: bool = False
    # Light or dark. Follows the operating system by default; light and dark
    # are explicit overrides that win over prefers-color-scheme in both
    # directions. This field was called `theme` until themes became a
    # separate choice; `load` carries the old name over.
    appearance: str = "system"     # system | light | dark
    # Which theme draws the interface, by the id of its directory. Every new
    # installation starts on the default; a stored id whose theme has since
    # been removed falls back to it at read time rather than failing here.
    theme: str = "harbor"
    # Clock format for every time the interface prints. Off is 12-hour, which
    # is what most of the app already showed. Stated rather than inferred from
    # the browser locale, because the app had three conventions running at
    # once: schedules and update windows were hard-coded 12-hour, the Insights
    # hour axis was hard-coded 24-hour, and everything going through a
    # locale-formatted date was whichever the browser preferred.
    clock_24h: bool = False
    # Interface language. "auto" follows the browser, which is what somebody
    # who has never opened this setting almost certainly wants; anything else
    # is an explicit override that wins over the browser in both directions.
    # Stored as a bare tag rather than a full locale: the catalog is per
    # language, and a region only matters once someone contributes a regional
    # variant, at which point the tag grows a suffix and this still holds it.
    language: str = "auto"
    # How long eero holds 5 and 6 GHz off when a pause is asked for. eero
    # decides it and publishes it nowhere ahead of time, so this is learned
    # from the expiry each pause comes back with; 30 is what was measured.
    band_pause_minutes: int = 30
    # Per-network answers for the fields in PER_NETWORK, keyed by the same
    # network key the node cache and the web notifications use.
    networks: dict[str, dict[str, bool]] = field(default_factory=dict)

    @classmethod
    def load(cls) -> "Prefs":
        raw = settingsfile.read()
        _carry_over(raw)
        names = {f.name for f in fields(cls)} - {"networks"}
        mine = {k: v for k, v in raw.items() if k in names}
        # Only the filters: a network's section also holds its plan and
        # alerts, which belong to other modules.
        nets = {str(k): {f: bool(v[f]) for f in PER_NETWORK if f in v}
                for k, v in (raw.get("networks") or {}).items() if isinstance(v, dict)}
        try:
            return cls(**mine, networks=nets)
        except TypeError:
            return cls()

    def for_network(self, key: str) -> dict[str, bool]:
        """The feature filters as this network has them.

        Anything the network has not answered for itself falls back to the
        top-level value, so a choice made before these were per network still
        applies everywhere until it is changed on one of them.
        """
        mine = self.networks.get(key) or {}
        return {name: bool(mine.get(name, getattr(self, name)))
                for name in PER_NETWORK}

    def set_network(self, key: str, values: dict[str, bool]) -> None:
        """Record the feature filters for one network, leaving the rest."""
        self.networks[key] = {name: bool(values[name]) for name in PER_NETWORK
                              if name in values}

    def fill_network(self, key: str) -> None:
        """Give this network an answer for every per-network field, taken
        from what it currently falls back to, so the file shows each one."""
        self.networks[key] = self.for_network(key)

    def save(self) -> None:
        """Write the preferences and each network's filters, leaving the
        rest of settings.json (plans, alerts, notes) as it is."""
        data = settingsfile.read()
        mine = asdict(self)
        nets = mine.pop("networks")
        data.update(mine)
        for key, filters in nets.items():
            settingsfile.network(data, key).update(filters)
        settingsfile.write(data)


RENAMED = {"linkish": "winksys"}


def _carry_over(raw: dict) -> None:
    """Read preferences written by an earlier version: before themes existed,
    or naming a theme that has since been renamed.

    `theme` used to hold system, light, or dark. It now holds a theme id, and
    the old value moved to `appearance`. A file from before the change has
    `theme` set to one of the three and no `appearance` at all; that is
    unambiguous, so it is mapped rather than dropped. Only in that case: a
    file with both fields is already in the new shape, whatever it says.
    """
    if "appearance" not in raw and raw.get("theme") in ("system", "light", "dark"):
        raw["appearance"] = raw.pop("theme")
    # Themes that were renamed, by their old id. Without this a choice of one
    # would silently fall back to the default after the upgrade.
    if raw.get("theme") in RENAMED:
        raw["theme"] = RENAMED[raw["theme"]]
