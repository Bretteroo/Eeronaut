"""Where the installed themes are, and what each one declares.

A theme is a directory. It holds a manifest, a stylesheet, two screenshots
and whatever images or fonts the stylesheet refers to, and nothing else: no
code of any kind, and no words but those only it would say: its title, its
one-line description and its `strings`. Every word the interface shows
whatever theme is worn comes from the string catalogs, and nothing one theme
says is ever put there. What a
theme may say about the interface's structure is
whatever the manifest schema below has a field for, which is the whole reason
the manifest exists — a theme rearranges the interface through declared knobs
that the app knows how to honor, not through anything it can run.

Two places are searched, in order: the themes that ship with the program, and
a `themes` directory under the data directory for ones somebody has added.
A theme in the second place with the same id as one in the first is ignored,
so an installed copy can never be shadowed by an upload. Nothing in one theme
may refer to another: each is served from its own directory alone, and a theme
that fails to validate is left out of the list without affecting the rest.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from .config import settings

log = logging.getLogger(__name__)

# The theme every new installation starts with, and the one the interface
# falls back to when the chosen theme is no longer installed.
DEFAULT = "harbor"

# The theme engine: everything a theme is built against, which is more than
# its manifest. The parts a stylesheet styles, the tokens it sets, the rules
# about what CSS may do, and the manifest's fields are all one contract, and
# this is its version, separate from Eeronaut's own so a release that changes
# nothing for themes does not look as if it might have.
#
# A theme names the engine it was built for, and loads when the major
# versions match and its minor is not newer than this one. A minor release
# only adds: a new part, a new manifest field. A major one breaks something a
# theme may rely on, a part renamed or gone, and every theme built for the
# one before is refused rather than half-drawn. THEMES.md keeps the history.
ENGINE = (1, 1)
ENGINE_VERSION = f"{ENGINE[0]}.{ENGINE[1]}"

MANIFEST = "theme.json"
STYLESHEET = "theme.css"

ID = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")

# What a browser will accept as a tab icon, out of what a theme may hold.
FAVICON_TYPES = {".png", ".svg", ".webp", ".ico"}

# What a theme directory may hold. Anything else is not served: a script or
# an HTML file in a theme is not a theme asset, and refusing the extension
# is what "no code" means at the point the browser would ask for it.
SERVABLE = {
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain",
    ".ico": "image/vnd.microsoft.icon",
}


class PagePlan(BaseModel):
    """How one page lays out its panes.

    Panes are named by the anchor each card already carries for search,
    so a theme author can read the id off the address bar (`?pane=dns`).
    A pane named here that the page does not have is ignored; a pane the
    page has that is not named keeps its place after the named ones.
    """
    model_config = {"extra": "forbid"}

    # Panes in the order they should appear. Anything not listed follows,
    # in the page's own order.
    order: list[str] = Field(default_factory=list)
    # Panes left out of the page entirely.
    hidden: list[str] = Field(default_factory=list)
    # Panes that take a full row on a wide screen. On a page that lays its
    # panes out in two columns this is how one card is made to span both;
    # a pane not listed here or in `narrow` keeps the width the page gives it.
    wide: list[str] = Field(default_factory=list)
    # Panes that take half a row on a wide screen.
    narrow: list[str] = Field(default_factory=list)


# A group's or a view's name: what the manifest calls it, and what goes into
# a route and a stylesheet. Not a word on the screen; the label a reader sees
# is the theme's own, in its `strings`, because wording only one theme uses
# never goes in the program's catalogs.
KEY = re.compile(r"^[a-z][a-z_]{0,31}$")

# The groups any theme may use without naming them, labeled by the program
# in every language under `nav_group.<id>`: a grouping of Eeronaut's own
# pages by what they are about, which is not one theme's voice. A theme's
# label for one of these is refused, since it would change a shared word.
SHARED_GROUPS = ("connection", "devices", "activity")

# The pages a view may take panes from, by route name, and the pieces that
# are not panes of any page but can stand as one: dynamic DNS is a row of the
# Internet card, and the network switcher sits in the bar.
PAGES = ("dashboard", "internet", "network", "clients", "profiles", "topology",
         "airtime", "security", "insights", "settings")
SECTIONS = ("ddns", "network_switcher", "notifications")

# A route, as the navigation names them: "/", "/network", "/clients", and a
# theme's own assembled pages, "/v/basic_setup".
ROUTE = re.compile(r"^/[a-z][a-z-]*$|^/$|^/v/[a-z][a-z_]*$")


class View(BaseModel):
    """A page a theme assembles from other pages' panes.

    Each pane is named `page/pane`, the page by its route name and the pane by
    the anchor it already carries — or `section/<name>` for one of the pieces
    that can stand alone. The page is drawn at `/v/<view>`, with the panes in
    the order given; a group puts it in the navigation like any route. A
    section a view takes is taken from where it normally sits, so it is on
    the screen once.
    """
    model_config = {"extra": "forbid"}

    view: str
    panes: list[str] = Field(min_length=1)

    @field_validator("view")
    @classmethod
    def _name(cls, v: str) -> str:
        if not KEY.match(v):
            raise ValueError("a view is named with lowercase letters and _")
        return v

    @field_validator("panes")
    @classmethod
    def _panes(cls, v: list[str]) -> list[str]:
        for ref in v:
            page, _, pane = ref.partition("/")
            if page == "section":
                if pane not in SECTIONS:
                    raise ValueError(f"{ref!r} is not a section")
            elif page not in PAGES or not ID.match(pane or "!"):
                raise ValueError(f"{ref!r} is not page/pane")
        if len(set(v)) != len(v):
            raise ValueError("a pane is listed twice in one view")
        return v


class NavGroup(BaseModel):
    """Several destinations folded behind one named menu.

    For a bar across the top or the bottom, where ten destinations do not fit
    and the last of them was being cut off. The rail has room and ignores
    these.
    """
    model_config = {"extra": "forbid"}

    group: str

    @field_validator("group")
    @classmethod
    def _name(cls, v: str) -> str:
        if not KEY.match(v):
            raise ValueError("a group is named with lowercase letters and _")
        return v
    # The routes inside it, in the order they should appear in the menu. A
    # route named by no group stays at the top level; a group takes the place
    # of its first member.
    items: list[str] = Field(min_length=1)

    @field_validator("items")
    @classmethod
    def _routes(cls, v: list[str]) -> list[str]:
        for route in v:
            if not ROUTE.match(route):
                raise ValueError(f"{route!r} is not a route")
        if len(set(v)) != len(v):
            raise ValueError("a route is listed twice in one group")
        return v


class Layout(BaseModel):
    """The structural choices a theme may make.

    Every field here is a knob the interface implements. A theme that wants
    to move something no knob covers needs the knob added to the program
    first, in a change that everyone gets; that is deliberate.
    """
    model_config = {"extra": "forbid"}

    # Where the primary navigation goes: a rail down the left, a bar across
    # the top, a floating bar along the bottom, or two rows of tabs across
    # the top — the theme's groups as the first row and the destinations in
    # whichever group is open as the second.
    navigation: Literal["rail", "top", "bottom", "tabs"] = "rail"
    # Where a field's explanation goes: under the field it explains
    # (`inline`), or gathered into a column down the side of its card with
    # the field's name in front of it (`aside`).
    hints: Literal["inline", "aside"] = "inline"
    # What content wider than its column does, a table or the network map:
    # scroll sideways inside it (`scroll`), or take a narrower shape until
    # the column is wide enough again (`fold`): a table becomes a block per
    # row with every column in it, the map an indented outline.
    overflow: Literal["scroll", "fold"] = "scroll"
    # What a horizontal bar does on a screen too narrow to hold it. `none`
    # keeps moving destinations into a menu as room runs out, one at a time,
    # which leaves a phone showing one or two of them beside that menu.
    # `menu` puts all of them behind a single menu button below the phone
    # breakpoint. Ignored by the rail, which is already a menu on a phone,
    # opened by the button in the header.
    collapse: Literal["none", "menu"] = "none"
    # How tightly things are packed. `compact` shortens the rows and the
    # padding inside cards; the stylesheet decides by how much.
    density: Literal["comfortable", "compact"] = "comfortable"
    # Per page, keyed by the page's route name: dashboard, internet, network,
    # clients, profiles, topology, airtime, security, insights, settings.
    pages: dict[str, PagePlan] = Field(default_factory=dict)
    # Destinations folded behind named menus, for a horizontal bar. Ignored by
    # the rail, which has room for all of them.
    nav_groups: list[NavGroup] = Field(default_factory=list)
    # Pages assembled from other pages' panes, reached at /v/<view>.
    views: list[View] = Field(default_factory=list)

    @field_validator("nav_groups")
    @classmethod
    def _one_group_each(cls, v: list[NavGroup]) -> list[NavGroup]:
        """A route belongs to at most one menu, and a menu appears once.

        Both would otherwise draw the same destination twice, in two places,
        with no way to tell which one the reader is looking at.
        """
        names = [g.group for g in v]
        if len(set(names)) != len(names):
            raise ValueError("a navigation group is named twice")
        seen: set[str] = set()
        for g in v:
            for route in g.items:
                if route in seen:
                    raise ValueError(f"{route} is in more than one group")
                seen.add(route)
        return v

    @model_validator(mode="after")
    def _views_exist(self) -> "Layout":
        """A group may name a view only if the theme declares it: a tab that
        goes to /v/something nobody built is a tab to an empty page."""
        declared = {f"/v/{x.view}" for x in self.views}
        for g in self.nav_groups:
            for route in g.items:
                if route.startswith("/v/") and route not in declared:
                    raise ValueError(f"{route} is not one of this theme's views")
        return self

    @field_validator("views")
    @classmethod
    def _one_view_each(cls, v: list[View]) -> list[View]:
        """A view appears once, and a section is taken by one view: two
        claims on the same piece would put it on two pages."""
        names = [x.view for x in v]
        if len(set(names)) != len(names):
            raise ValueError("a view is declared twice")
        sections = [r for x in v for r in x.panes if r.startswith("section/")]
        if len(set(sections)) != len(sections):
            raise ValueError("a section is in more than one view")
        return v

    @field_validator("pages")
    @classmethod
    def _page_names(cls, v: dict[str, PagePlan]) -> dict[str, PagePlan]:
        for name in v:
            if not ID.match(name):
                raise ValueError(f"page name {name!r} is not a route name")
        return v


class Manifest(BaseModel):
    """`theme.json`.

    The title, the description, and `strings` are the words a theme carries,
    and they are here rather than in the string catalogs because a theme is
    self-contained: nothing about a theme lives outside its directory, so a
    theme can be added or removed without the program changing. The cost is
    that they are not translated, which is accepted.
    """
    model_config = {"extra": "forbid"}

    engine: str
    id: str
    version: str
    title: str = Field(min_length=1, max_length=40)
    # One line, shown under the title in the picker.
    description: str = Field(min_length=1, max_length=240)
    screenshots: dict[Literal["light", "dark"], str]
    # The icon the browser puts on its tab, if the theme brings one. The
    # favicon is a <link> in the page's head, which no stylesheet can reach,
    # so a theme that wants its own has to say so here. Omitted means the
    # program's own icon stays.
    favicon: str | None = None
    layout: Layout = Field(default_factory=Layout)
    # The theme's own words for what only it shows: the label of each group
    # and view it declares, `nav_group.<id>` and `view.<id>`, and the two
    # halves of a tab strip's product bar, `product_line` and
    # `product_model`, which is drawn only when the theme names them.
    # Untranslated, like the title: wording one theme uses never goes into
    # the program's catalogs, where every language would have to carry it.
    strings: dict[str, str] = Field(default_factory=dict)

    @field_validator("strings")
    @classmethod
    def _strings(cls, v: dict[str, str]) -> dict[str, str]:
        for key, text in v.items():
            if not (key in ("product_line", "product_model")
                    or re.fullmatch(r"(nav_group|view)\.[a-z][a-z_]{0,31}", key)):
                raise ValueError(f"{key!r} is not a string a theme can name")
            if not text.strip() or "\n" in text or len(text) > 40:
                raise ValueError(f"{key!r} must be one short line")
        return {k: t.strip() for k, t in v.items()}

    @model_validator(mode="after")
    def _labelled(self) -> "Manifest":
        """Every group and view the theme declares needs its label, and a
        label for one it does not declare is a word that is never shown."""
        want = ({f"nav_group.{g.group}" for g in self.layout.nav_groups
                 if g.group not in SHARED_GROUPS}
                | {f"view.{v.view}" for v in self.layout.views})
        have = {k for k in self.strings if k.startswith(("nav_group.", "view."))}
        if missing := sorted(want - have):
            raise ValueError(f"no label for {', '.join(missing)}")
        if extra := sorted(have - want):
            raise ValueError(f"a label for nothing: {', '.join(extra)}")
        return self

    @field_validator("title", "description")
    @classmethod
    def _one_line(cls, v: str) -> str:
        v = v.strip()
        if "\n" in v or not v:
            raise ValueError("must be one line")
        return v

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID.match(v):
            raise ValueError("id must be lowercase letters, digits, - or _")
        return v

    @field_validator("version")
    @classmethod
    def _version(cls, v: str) -> str:
        if not re.fullmatch(r"\d+\.\d+(\.\d+)?", v):
            raise ValueError("version must look like 1.0 or 1.0.2")
        return v

    @field_validator("engine")
    @classmethod
    def _engine(cls, v: str) -> str:
        m = re.fullmatch(r"(\d+)\.(\d+)", v)
        if not m:
            raise ValueError("engine must look like 1.0")
        major, minor = int(m[1]), int(m[2])
        if major != ENGINE[0]:
            raise ValueError(f"built for theme engine {v}, and this Eeronaut has "
                             f"{ENGINE_VERSION}; a different major version is "
                             "not compatible")
        if minor > ENGINE[1]:
            raise ValueError(f"needs theme engine {v}, and this Eeronaut has "
                             f"{ENGINE_VERSION}; update Eeronaut to use it")
        return v

    @field_validator("favicon")
    @classmethod
    def _favicon(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not _safe_relative(v):
            raise ValueError(f"favicon path {v!r} leaves the theme")
        if PurePosixPath(v).suffix.lower() not in FAVICON_TYPES:
            raise ValueError("favicon must be a png, svg, webp, or ico")
        return v

    @field_validator("screenshots")
    @classmethod
    def _shots(cls, v: dict[str, str]) -> dict[str, str]:
        missing = {"light", "dark"} - set(v)
        if missing:
            raise ValueError(f"screenshots missing: {', '.join(sorted(missing))}")
        for name in v.values():
            if not _safe_relative(name):
                raise ValueError(f"screenshot path {name!r} leaves the theme")
        return v


@dataclass(frozen=True)
class Theme:
    manifest: Manifest
    root: Path

    @property
    def id(self) -> str:
        return self.manifest.id


def bundled_dir() -> Path:
    """The themes that ship with the program.

    `app/themes` beside `app/backend` in a checkout, `/app/themes` beside
    `/app/eeronaut` in the container. `EERONAUT_THEMES_DIR` names somewhere
    else outright.
    """
    named = os.environ.get("EERONAUT_THEMES_DIR")
    if named:
        return Path(named)
    here = Path(__file__).resolve()
    for base in (here.parents[3], here.parents[2]):
        if (base / "themes").is_dir():
            return base / "themes"
    return here.parents[3] / "themes"


def added_dir() -> Path:
    """Themes somebody put in the data volume."""
    return settings.data_dir / "themes"


def _safe_relative(name: str) -> bool:
    """A path that stays inside the directory it is joined to.

    Segment by segment rather than by resolving: `resolve()` follows
    symlinks, and a symlink inside a theme pointing out of it would then
    pass. No absolute paths, no `..`, no empty or dot segments, and nothing
    the file system might read as a drive or a stream.
    """
    if not name or name.startswith(("/", "\\")) or "\\" in name or ":" in name:
        return False
    parts = name.split("/")
    return all(p and p not in (".", "..") for p in parts)


# What a stylesheet may not hold: another stylesheet pulled in, script by
# way of an old browser extension, or a reference to anything off the
# server. THEMES.md sets these out as the rules; checked here as well as in
# the tests, because the tests only ever see the themes that ship, and a
# theme somebody installs is the one worth checking.
_CSS_FORBIDDEN = re.compile(
    r"@import|url\(\s*['\"]?\s*(?:https?:|//|data:|javascript:)"
    r"|expression\(|-moz-binding|behavior\s*:", re.I)
_CSS_URL = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)")
# Words. A theme carries none but its own `strings`, and the interface's
# text, the About dialog's above all, is the program's to say: a theme
# shapes how it looks and where it sits, not what it reads. `content` may
# only be empty, as a decoration's is. Read with the comments taken out, so a
# comment can mention it; `justify-content` and the like are other words.
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_CONTENT = re.compile(r"(?<![\w-])content\s*:\s*([^;}]*)", re.I)
_CSS_CONTENT_OK = re.compile(r"\s*(?:\"\"|''|none|normal)\s*(?:!important)?\s*", re.I)
_SVG_FORBIDDEN = re.compile(
    r"<script|<foreignobject|\son\w+\s*=|javascript:|(?:xlink:)?href\s*=\s*['\"]\s*(?:https?:|//)",
    re.I)


def _content_problem(root: Path) -> str | None:
    """Why a theme's files break the rules, or None if they do not."""
    base = root.resolve()
    for f in sorted(root.rglob("*")):
        if not f.is_file():
            continue
        suffix = f.suffix.lower()
        if suffix not in (".css", ".svg"):
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return f"{f.name} is not readable text"
        if suffix == ".svg":
            if hit := _SVG_FORBIDDEN.search(text):
                return f"{f.relative_to(root)} holds {hit.group(0).strip()!r}"
            continue
        if hit := _CSS_FORBIDDEN.search(text):
            return f"{f.relative_to(root)} holds {hit.group(0).strip()!r}"
        for value in _CSS_CONTENT.findall(_CSS_COMMENT.sub("", text)):
            if not _CSS_CONTENT_OK.fullmatch(value):
                return (f"{f.relative_to(root)} puts words on the page "
                        f"(content: {value.strip()[:40]}); a theme's words go in its strings")
        for ref in _CSS_URL.findall(text):
            target = (f.parent / ref.split("?")[0].split("#")[0]).resolve()
            if not target.is_relative_to(base) or not target.is_file():
                return f"{f.relative_to(root)} refers to {ref!r}, which is not in the theme"
    return None


def _read(root: Path) -> Theme | None:
    path = root / MANIFEST
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        m = Manifest.model_validate(raw)
    except (OSError, ValueError, ValidationError) as e:
        log.warning("theme at %s left out: %s", root, e)
        return None
    if m.id != root.name:
        log.warning("theme at %s left out: manifest id %r does not match "
                    "its directory", root, m.id)
        return None
    if not (root / STYLESHEET).is_file():
        log.warning("theme at %s left out: no %s", root, STYLESHEET)
        return None
    for shot in m.screenshots.values():
        if not (root / shot).is_file():
            log.warning("theme at %s left out: screenshot %s missing", root, shot)
            return None
    if m.favicon and not (root / m.favicon).is_file():
        log.warning("theme at %s left out: favicon %s missing", root, m.favicon)
        return None
    if problem := _content_problem(root):
        log.warning("theme at %s left out: %s", root, problem)
        return None
    return Theme(manifest=m, root=root)


def installed() -> dict[str, Theme]:
    """Every theme that validates, by id, bundled ones first.

    Read from disk on each call. Themes change when somebody edits a file,
    not when the program restarts, and the list is asked for once per visit
    to Settings.
    """
    found: dict[str, Theme] = {}
    for base in (bundled_dir(), added_dir()):
        if not base.is_dir():
            continue
        for root in sorted(p for p in base.iterdir() if p.is_dir()):
            if not ID.match(root.name) or root.name in found:
                continue
            theme = _read(root)
            if theme:
                found[theme.id] = theme
    return found


def get(theme_id: str) -> Theme | None:
    if not ID.match(theme_id or ""):
        return None
    for base in (bundled_dir(), added_dir()):
        root = base / theme_id
        if root.is_dir():
            return _read(root)
    return None


def active_id(chosen: str) -> str:
    """The theme to draw, given the one preferences name.

    A theme can be removed from under a preference that names it: somebody
    deletes the directory, or the volume is moved to a build without it.
    Falling back to the default is what makes deleting one theme unable to
    break the interface.
    """
    if chosen and get(chosen):
        return chosen
    return DEFAULT


def file_in(theme: Theme, name: str) -> tuple[Path, str] | None:
    """A servable file inside the theme, with its media type, or None.

    None for a path that leaves the directory, a file that does not exist,
    or a type the theme format does not include.
    """
    if not _safe_relative(name):
        return None
    path = theme.root / name
    kind = SERVABLE.get(path.suffix.lower())
    if kind is None or not path.is_file():
        return None
    return path, kind
