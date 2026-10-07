"""The installed themes, and the files inside each.

Open to anyone who can reach the port, like the health check: the sign-in
screen is themed too, and it has to load its stylesheet before there is a
session. Nothing here says anything about the network or the account — a
theme is a stylesheet, some pictures, and a manifest that names its own knobs.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..core import themes
from ..core.prefs import Prefs

router = APIRouter(prefix="/api/themes", tags=["themes"])

# The program's own tab icon, used when the active theme brings none. It is
# part of the built interface rather than of any theme, so it is read from
# where the build puts it.
OWN_ICON = Path(__file__).resolve().parents[1] / "static" / "favicon-180.png"

# Reachable without naming a theme, so the page's <link rel="icon"> can be a
# fixed href. One segment, so it cannot collide with the two-segment file
# route below however a theme is named.
ACTIVE_ICON = "/active-favicon"


class ThemeInfo(BaseModel):
    id: str
    version: str
    title: str
    description: str
    # Paths the browser can fetch, not the names inside the manifest.
    screenshots: dict[str, str]
    # Null when the theme brings no icon of its own, in which case the
    # program's own stays on the tab.
    favicon: str | None
    layout: themes.Layout
    strings: dict[str, str]


def _info(t: themes.Theme) -> ThemeInfo:
    return ThemeInfo(
        id=t.id,
        version=t.manifest.version,
        title=t.manifest.title,
        description=t.manifest.description,
        screenshots={side: f"/api/themes/{t.id}/{name}"
                     for side, name in t.manifest.screenshots.items()},
        favicon=(f"/api/themes/{t.id}/{t.manifest.favicon}"
                 if t.manifest.favicon else None),
        layout=t.manifest.layout,
        strings=t.manifest.strings,
    )


class ThemeList(BaseModel):
    active: str
    default: str
    themes: list[ThemeInfo]


@router.get("", response_model=ThemeList)
async def list_themes() -> ThemeList:
    found = themes.installed()
    return ThemeList(
        active=themes.active_id(Prefs.load().theme),
        default=themes.DEFAULT,
        themes=[_info(t) for t in found.values()],
    )


@router.get(ACTIVE_ICON)
async def active_favicon() -> FileResponse:
    """The tab icon of whichever theme is switched on.

    The page asks for this one href, so the first icon the browser fetches
    is already the right one. Resolving the theme in the browser instead
    means the tab wears the program's own icon until the theme list arrives,
    which reads as the icon changing under you on every reload.
    """
    theme = themes.get(themes.active_id(Prefs.load().theme))
    hit = (themes.file_in(theme, theme.manifest.favicon)
           if theme and theme.manifest.favicon else None)
    if hit:
        path, kind = hit
    elif OWN_ICON.is_file():
        path, kind = OWN_ICON, "image/png"
    else:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no icon")
    # Revalidated every load: the answer changes when the theme changes,
    # and it is one small file.
    return FileResponse(path, media_type=kind,
                        headers={"Cache-Control": "no-cache"})


@router.get("/{theme_id}/{name:path}")
async def theme_file(theme_id: str, name: str) -> FileResponse:
    """One file from one theme.

    404 for everything that is not a servable file inside that theme's own
    directory, including a valid path with an extension the theme format
    does not include. 404 rather than 403 for the ones that try to leave:
    there is nothing there to be forbidden from.
    """
    theme = themes.get(theme_id)
    hit = theme and themes.file_in(theme, name)
    if not hit:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such theme file")
    path, kind = hit
    # `no-cache` is "ask every time", not "never cache": the browser keeps
    # the file and revalidates it against its modification time, so an
    # edited stylesheet shows up on the next load and an unchanged one
    # costs a 304.
    return FileResponse(path, media_type=kind,
                        headers={"Cache-Control": "no-cache"})
