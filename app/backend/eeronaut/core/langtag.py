"""BCP 47 language tags, checked for shape and written one way.

The interface language is stored as a tag, and a tag arrives from three
places: a language picker, a browser's `Accept-Language`, and whoever edits
`settings.json` by hand. Those disagree about case — `pt-br`, `PT-BR`, `pt_BR`
are all the same tag and none of them compares equal to the others — so the
shape is decided here, once, on the way in.

Deliberately not checked against the catalogs that ship. The frontend owns
that list and falls back to English for a tag it has no catalog for, so a
contributor adding a language edits one place rather than two, and a tag for
a language that was dropped degrades instead of failing validation.
"""
from __future__ import annotations

import re

# language[-script][-region][-variant…][-extension…][-privateuse]
#
# Loose on purpose: enough to tell a tag from a path or a sentence, not a
# registry lookup. `i-klingon` and other grandfathered tags are not accepted,
# and nothing that matters here is one.
SHAPE = re.compile(
    r"""^
    (?:[A-Za-z]{2,3}|[A-Za-z]{5,8})     # language
    (?:-[A-Za-z]{4})?                   # script
    (?:-(?:[A-Za-z]{2}|\d{3}))?         # region
    (?:-(?:[A-Za-z\d]{5,8}|\d[A-Za-z\d]{3}))*   # variants
    (?:-[A-WY-Za-wy-z\d](?:-[A-Za-z\d]{2,8})+)* # extensions
    (?:-[Xx](?:-[A-Za-z\d]{1,8})+)?     # private use
    $""",
    re.X,
)


def canonical(tag: str) -> str:
    """The conventional case for a tag: `en`, `pt-BR`, `zh-Hant`.

    Case carries no meaning in a tag, so this is cosmetic in the way that
    matters: two spellings of the same tag become one string, and everything
    downstream can compare them.
    """
    parts = [p for p in str(tag or "").strip().replace("_", "-").split("-") if p]
    out = []
    for i, p in enumerate(parts):
        if i == 0:
            out.append(p.lower())
        elif len(p) == 4 and p.isalpha():
            out.append(p.title())
        elif len(p) == 2 and p.isalpha():
            out.append(p.upper())
        else:
            out.append(p.lower())
    return "-".join(out)


def valid(tag: str) -> bool:
    return bool(SHAPE.match(str(tag or "").replace("_", "-")))
