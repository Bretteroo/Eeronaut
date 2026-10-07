# Themes

A theme is a directory. It changes how Eeronaut looks and, within limits
this document spells out, how it is laid out. It contains no code, and no
words but the few only it would say.

Your own themes go in a `themes/` folder inside Eeronaut's data folder, one
directory per theme. With the recommended `docker-compose.yml` that is
`~/.config/eeronaut/themes/`; without Docker, following the README, it is
`/var/lib/eeronaut/themes/`. See
[Installing your own theme](#installing-your-own-theme) below. The themes
that ship with Eeronaut are in `app/themes/` in this repository, and copying
one of them under a new name is the easiest way to start.

```
~/.config/eeronaut/themes/mytheme/
  theme.json           what the theme is and which knobs it turns
  theme.css            the look
  screenshot-light.png a picture of it, 1280 x 800
  screenshot-dark.png  the same in dark
  fonts/               optional, with each font's license beside it
  assets/              optional images the stylesheet refers to,
                       and a favicon if the theme brings one
```

Five ship with Eeronaut: Harbor, the default; Liquid Glass; Eerish;
Sailing; and Winksys. Each is complete on its own. Nothing in one refers to a file in another, and
deleting any of them leaves the rest working. An installation whose chosen
theme has gone falls back to Harbor.

## The rules

**No code.** The server hands out only these file types from a theme
directory: `css`, `json`, `png`, `jpg`, `jpeg`, `webp`, `gif`, `svg`, `ico`,
`woff`, `woff2`, `txt`. A script in a theme directory is not served, whatever
it is named. An SVG may not hold a `<script>` or `<foreignObject>` element, an
`on*=` attribute, a `javascript:` address or a link off the server. A
stylesheet may not `@import`, may not `url()` anything outside its own
directory or anything that is not there, and may not use `expression()`,
`-moz-binding`, `behavior:` or any other historical way of running code from
CSS. These are checked when the theme is read: a theme that breaks one is
left out of the list, with a line in the server log naming the file.

**No words.** A theme's only words are its own `strings`. A stylesheet may
not put text on the page: `content` may be empty, `none`, or `normal`, as a
decoration's is, and nothing else, which is checked with the rules above. The
About Eeronaut dialog in particular is the program's to say: a theme designs
and arranges it like anything else, but its words are fixed, and the dialog
puts back any of them a stylesheet hides.

**Its own words, and only its own.** Every word the interface shows
whatever theme is worn comes from the string catalogs, and a theme cannot
change one. What only one theme would say lives in that theme's manifest
and never in the catalogs: its title and one-line description, and the
`strings` it names (below). A theme is self-contained, so nothing about one
may live outside its directory, and that outweighs translation. They are
shown as written, in every language.

**Self-contained.** Every `url()` in `theme.css` is a relative path to a file
inside the same theme directory. Fonts a theme ships come with their license
file beside them. Eerish, Liquid Glass, and Sailing ship fonts under the SIL
Open Font License, with the license text in each `fonts/` directory; Harbor
and Winksys use the system's own.

**Two appearances.** Every theme defines a light and a dark palette, and each
gets a screenshot. The interface stamps `data-theme="light"` or
`data-theme="dark"` on `<html>` when someone has chosen; with neither, the
operating system's preference applies through `prefers-color-scheme`. The
pattern Harbor uses is the one to copy:

```css
:root { /* light */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark */ } }
:root[data-theme="dark"] { /* dark, again */ }
```

**A way to About Eeronaut.** As a courtesy, every theme should leave the
reader a visible way into the About Eeronaut dialog. It is where the version,
the license, the link to the source, and the support link live, and the one
place the program is credited to the people who made it. A theme has no code
and cannot add a link, but every layout already draws one, and only a
stylesheet can take it away: `nav-about`, the version line, in the rail and
in a top or bottom bar, and `nav-brand`, the mark, which opens About in a top
bar and a tab strip. Restyle them however you like, but don't hide every one
of them.

## The theme engine

Everything a theme is built against is one contract, and it has a version of
its own, separate from Eeronaut's: the manifest's fields, the parts a
stylesheet can style, the tokens it can set, and the rules about what its CSS
may do. An Eeronaut release that changes none of that leaves the engine
version alone, so a theme does not need checking against every release.

A theme names the engine it was built for in its manifest, as `"engine":
"1.0"`, and loads when the major versions match and its minor is no newer
than Eeronaut's:

- A minor release only adds: a new part, a new manifest field, a new token.
  A theme built for 1.0 still loads on 1.3.
- A theme built for 1.3 is refused on 1.0, since it may use something 1.0
  does not have. The server log says to update Eeronaut.
- A major release breaks something a theme may rely on, a part renamed or
  removed, and a theme built for 1.x is refused on 2.0 rather than drawn
  half right.

Build against the newest engine whose features you use, not the newest there
is: a theme that needs nothing past 1.0 should say 1.0, and it then loads on
every 1.x. The engine this Eeronaut runs is in `/api/health`, as
`theme_engine`.

| Engine | Eeronaut | What changed |
|---|---|---|
| 1.0 | 1.0.0 | The first: the manifest, parts, tokens, and rules in this file. |

## The manifest

```json
{
  "engine": "1.0",
  "id": "harbor",
  "version": "1.0.0",
  "title": "Harbor",
  "description": "One line, shown under the title in the picker.",
  "screenshots": { "light": "screenshot-light.png", "dark": "screenshot-dark.png" },
  "favicon": "assets/favicon.png",
  "layout": {
    "navigation": "rail",
    "density": "comfortable",
    "pages": {
      "dashboard": { "order": ["mesh", "connection"], "hidden": ["usage"],
                     "wide": ["glance"], "narrow": [] }
    }
  }
}
```

`engine` is the version of the theme engine the theme was built for; see
below. `id` must match the directory
name: 2 to 32 lowercase letters, digits, `-`, and `_`, starting with a letter.
`version` is the theme's own, `1.0` or `1.0.2`. The themes that ship with
Eeronaut carry Eeronaut's own version, since they change with it. `title` is up to 40
characters and `description` one line of up to 240; both are required.
`screenshots` names both pictures, and they, and `theme.css`, have to be in
the directory.

`strings` is optional: the theme's words for what only it shows, one line
of up to 40 characters each. The keys a theme may use are `nav_group.<name>`
for each group it declares other than the three shared ones, `view.<name>` for each view, and `product_line`
and `product_model` for a tab strip's product bar. Every group and view needs
its label, and a label for one the theme does not declare is refused.

```json
"strings": {
  "product_line": "Wireless Broadband Router",
  "nav_group.setup": "Setup",
  "view.basic_setup": "Basic Setup"
}
```

`favicon` is optional and is the one thing a theme changes that a stylesheet
cannot reach: the tab icon is a `<link>` in the page's head, so the theme has
to name it here and the interface swaps the link when the theme loads. A
`png`, `svg`, `webp`, or `ico` inside the theme; leave it out and the
program's own icon stays. Make it square — a tab icon is drawn in a square
box, and a tall picture is letterboxed or squashed depending on the browser.
Anything the manifest format does not name is refused, and a theme
that does not validate is left out of the list with a line in the server log
saying why; the others are unaffected.

## What a theme can change

### Tokens

`app/frontend/src/index.css` names every color, radius, and font the interface
reads, with gray fallbacks. A theme sets them on `:root`. Setting all of them
restyles the whole interface; setting some restyles that much.

| Token | Paints |
|---|---|
| `--color-canvas` | the page behind the cards |
| `--color-surface`, `--color-surface-2` | cards; a raised area inside a card |
| `--color-line`, `--color-line-strong` | rules and borders; borders that need to be seen |
| `--color-ink`, `--color-ink-2`, `--color-ink-3` | text; secondary text; captions and labels |
| `--color-accent`, `--color-accent-ink`, `--color-accent-deep` | anything pressable; its text; pressed |
| `--color-accent-wash` | a tint of the accent, for selected rows and chips |
| `--color-ok`, `--color-warn`, `--color-bad`, `--color-idle` | status. Red means something is wrong |
| `--color-warn-wash` | a tint of warn, for the firmware panel |
| `--color-rail`, `--color-rail-hover`, `--color-rail-ink`, `--color-rail-2`, `--color-rail-ink-dim` | the navigation rail, when there is one |
| `--series-1`, `--series-2` | chart series: download, upload. Choose them as a pair that can be told apart in both appearances, including by a color-blind reader, and keep them away from red and orange, which read as trouble |
| `--signal-good`, `--signal-okay`, `--signal-poor` | one hue stepped light to dark |
| `--radius-card` | the corner of a card |
| `--font-sans` | the type |

Three more set sizes rather than colors, and have defaults a theme only
changes when its layout needs to:

| Token | Sets | Default |
|---|---|---|
| `--rail-w` | the width of the navigation rail | `172px` |
| `--help-w` | the width of the help column, with `hints: "aside"` | `minmax(12rem, 28%)` |
| `--outline-indent` | how far a folded map indents each level, with `overflow: "fold"` | `4rem` |

A theme that raises type sizes should raise the parts that are sentences —
`card-title`, `page-title`, a card body's paragraphs, `hint` — and leave
tables, controls, and `.micro-label` alone. This app puts a hundred clients
in one table, where a marketing page's body size costs a third of the rows
on a screen. Eerish is the worked example.

### Parts

Every structural element carries a `data-part` attribute, and a theme may
style it. These are a contract: the names stay put across releases.

`shell`, `nav` (with `data-placement` of `rail`, `top`, `bottom`, or `tabs`),
`nav-masthead`, `nav-section`, `nav-product`, `nav-product-line`,
`nav-product-model`, `nav-tabs`, `nav-tab`, `nav-subtabs`, `nav-firmware`,
`nav-foot` (the parts of a tab strip), `card-columns`, `card-help`, `help-entry`,
`help-term` (a help column's), `reboot-mark`, `avatar` (a profile's face),
`editable` (a name that edits in place), `profile-list` and `card-button`
(the profiles and the buttons across each), `map-client` (a client on the
network map), `map-outline` (a level of the map folded into an outline),
`table-sort` and `table-fold` (a folded table's sort buttons and a row's
columns), `info-row`, `info-label`, `info-value` (a reading and its name),
`nav-extras` (the bell and the network switcher beside the navigation),
`search`, `plus-status` (the eero Plus subscription mark), `table-fold-head`
(a folded row's heading, which opens it), `versions` (the version line under
the Eeronaut card in Settings),
`nav-brand`, `nav-menu-glyph` (the three rules in a folded top bar's mark),
`nav-link`, `nav-about` (the version line, which opens About),
`nav-about-button` (an About button: in the rail, or in `nav-foot`), `header`, `page-title`,
`main`, `page` (with `data-page` naming the route), `card`, `card-header`,
`card-title`, `card-body`, `stat`, `table`, `toggle`, `tabs`, `notice`,
`submit`, `row-action`, `link-button`, `select-ghost`, `tile`, `sash`,
`network-switcher`, `field`, `field-label`, `control-label`, `hint`,
`overlay`, `scrim`,
`modal`, `drawer`, `drawer-panel`, `nav-strip`, `nav-menu`,
`nav-menu-button`, `nav-menu-list`, `nav-menu-action`, `theme-picker`.

Anything that floats over the page is three parts, and which one you paint
matters. `overlay` is the full-viewport wrapper and must stay transparent;
`scrim` is the layer that dims the page behind; `modal` and `drawer-panel`
are the panels themselves, and are what a theme gives a background, a blur,
or a shadow. Do not style by `role="dialog"`: it sits on the wrapper for
some dialogs and on the panel for others, so a rule keyed on it frosts the
whole screen. A panel must also be opaque: it sits over tables of live data,
and anything showing through lands behind its words.

`link-button` is a link drawn as a button, like the two that lead to eero's
own site. It is a separate part because a theme that shapes `button` reaches
none of them, and a control that misses one radius is the one thing on screen
with a different corner. The About dialog's Support Eeronaut button is
`support-button`, a blue gradient with white text in every theme so it stands
out; a theme can round its corners to match, but its colors are chosen to read
in every appearance.

`field` is one label and one control laid out as a pair: the label in a
column of its own, the control in the column beside it, the hint under the
control. A form built of these reads down two straight edges, and a theme
that wants a different label column changes one rule rather than every row.
`field-label` is the label half.

`tile` is a box you can press — an eero in the mesh diagram. It is a button
in the markup and a box on the page, so a theme that shapes `button` should
leave this one alone. `sash` is the eero Plus or hardware mark: a corner cut
off a card, clipped to that card's radius by the wrapper around it, so the
mark itself takes no radius of its own.

`select-ghost` is an invisible copy of a select's widest option, which is
how that select keeps one width whichever option is chosen. Give it the same
padding and type you give `select` — in the same rule, so they cannot drift —
or the select ends up narrower than the name it has to show.

`<html>` carries `data-theme-id`, `data-nav`, and `data-density`, so a
stylesheet can say `[data-density="compact"] [data-part="card-body"] { padding: 10px }`.

It also carries `data-page-prev`: the page you were on before this one, for
anything that hands over from one page's look to the next. It is absent on
the first page of a visit, which is how a stylesheet tells an arrival from a
move and declines to animate the arrival. Eerish uses it to cross-fade its
photographs — the outgoing one painted under the incoming one, which the
current route alone cannot say.

Be careful what starts a stacking context. A drawer is fixed to the window
and has to come out over the header; if a rule gives `[data-part="page"]` or
anything above it a `z-index`, the drawer is trapped inside that stack and
the header paints over its top. Layers behind a page's content belong at
negative depth, which leaves the content needing none of its own.

### Layout

`layout.navigation` puts the primary navigation in a rail down the left
(`rail`), a bar across the top (`top`), a floating bar along the bottom
(`bottom`), or two rows of tabs across the top (`tabs`). The interface draws
each of the four; the stylesheet styles the one it asked for.

A tab strip is the theme's groups as sections along the first row and the
pages of whichever section is open along the second, the way a router's own
setup pages were arranged. A destination no group claims is a section of its
own. Sections run in the order the theme declares its groups — unlike a bar,
where a group takes its first member's place, because here the sections are
the whole navigation and there are no plain links whose order a reader
already knows. Pressing a section goes to its first page. The strip is five
parts: `nav-masthead`, the first row, carrying the name (which opens About),
the bell, the network, and `nav-firmware`, the eeros' firmware version as a
link to the page that upgrades it; `nav-section`, the
open section's name drawn by itself, for a layout that sets it large beside
the page; `nav-product`, a bar naming what the thing is and its model in
`nav-product-line` and `nav-product-model`, drawn only when the theme names
them in its `strings`; `nav-tabs` holding a `nav-tab`
per section, the open one carrying
`aria-current`; and `nav-subtabs`, the open section's pages as `nav-link`s.
About is under the page instead, in `nav-foot` at its trailing end.
Below 768px the tabs fold behind the name, as a folded top bar does. Winksys
is the worked example.

`layout.collapse` is what a horizontal bar does on a phone. `none`, the
default, keeps moving destinations into a menu one at a time as room runs
out, which on a phone leaves one destination beside a menu holding the rest.
`menu` puts all of them behind a single button below 768px:

```json
"layout": { "navigation": "top", "collapse": "menu" }
```

In a top bar that button is the mark — `nav-brand`, which carries
`data-whole` while it is standing in for the navigation, so a stylesheet can
tell and lay the bar out differently. It draws three rules, `nav-menu-glyph`,
to the left of the name, so it reads as a menu. There is no strip of destinations on
the bar at that width, and the last entry of the menu is About, since the
mark is what used to open it. In a bottom bar the button is a menu of its
own, drawn with three rules across it. The rail ignores the field: it is
already a menu on a phone, opened from the header.

`layout.nav_groups` folds destinations behind named menus, for a bar across
the top or the bottom. Ten destinations do not fit a horizontal bar at every
width, and the last of them was being cut off:

```json
"nav_groups": [
  { "group": "connection", "items": ["/internet", "/network"] },
  { "group": "devices",    "items": ["/clients", "/profiles", "/topology"] },
  { "group": "activity",   "items": ["/airtime", "/insights", "/security"] }
]
```

A group takes the place of its first member, so the order a reader learned
does not move; anything named by no group stays where it was. A route may
belong to at most one group, and a group may appear once — both would draw
the same destination twice with no way to tell which you are looking at.

Three groups are shared: `connection`, `devices`, and `activity`, a grouping
of Eeronaut's own pages by what they are about that any theme may use. Their
labels are the program's, translated with everything else, and a theme
neither names them nor may change them. Any other group is the theme's own:
its name is the theme's choice, in lowercase letters and `_`, and its label
is the theme's words, `nav_group.<name>` in `strings`, without which the
manifest is refused. The rail ignores
groups; it has room.

Whatever still does not fit goes into a **More** menu, measured rather than
guessed at a breakpoint: this app ships in many languages and "Sendezeit"
needs room that "Airtime" does not. That happens for any horizontal bar with
no declaration at all, so a theme that groups nothing still never cuts a
destination off.

`layout.hints` is where a control's explanation goes: under the control
(`inline`, the default) or gathered into a column down the side of its card
(`aside`). With `aside` every card's body sits in `card-columns` beside a
`card-help` column, and each explanation the controls in the body carry is
drawn there as a `help-entry`, with the control's own label in front of it as
a `help-term`. The column is on every card whether or not anything is sent to
it, so it does not come and go from one card to the next. The label is drawn
a second time, which copies any mark it carries — a stylesheet will usually
want to hide `[data-part="help-term"] [data-part="reboot-mark"]` and any
button inside a term, which is what Winksys does. Explanations outside a
card, in a drawer say, stay where they are.

`layout.overflow` is what content wider than its column does: `scroll`, the
default, scrolls it sideways inside the column, and `fold` gives it a
narrower shape until the column is wide enough again. A folded table is a
block per row, the first column as its heading and every other column
beside each other under it, with the sorting the headings did as a row of
buttons above (`table-sort`); the network map becomes an outline, each
node's children indented under it (`map-outline`). Whether it fits is
measured, not guessed from the window, so the same table folds in one
theme's narrow column and not in another's wide one. Winksys folds.

`layout.density` is `comfortable` or `compact`. It stamps `data-density` on
`<html>` and does nothing else by itself; the stylesheet decides what compact
means.

`layout.pages` says, per page, which panes appear and how. Pages are named by
route: `dashboard`, `internet`, `network`, `clients`, `profiles`, `topology`,
`airtime`, `security`, `insights`, `settings`. Panes are named by the anchor
each card already has for search, which is what `?pane=` in the address bar
carries. Per page:

- `order`: panes in the order they should appear. Anything not named follows,
  in the page's own order.
- `hidden`: panes left out of the page.
- `wide`: panes that take a full row on a wide screen.
- `narrow`: panes that take half a row on a wide screen.

One pane is not the theme's to place. When a firmware update is waiting,
the dashboard's `firmware` notice is the first thing on the page, across the
whole row, whatever the plan says: naming it in `order`, `hidden`, or
`narrow` has no effect. An update restarts every eero at an hour most people
never chose, and no look is worth pushing that down the page. The notice
draws nothing when there is no update. A view that takes panes from the
dashboard shows it first too, named or not.

A pane named here that the page does not have does nothing. The interface
puts these into effect with `order`, `display`, and `grid-column` on the
page's grid children, and a stylesheet could do the same by hand against
`[data-page="dashboard"] > [data-slot="usage"]`; the manifest is the
declared, validated way.

Pane names today:

| Page | Panes |
|---|---|
| dashboard | `firmware`, `connection`, `glance`, `mesh`, `usage` |
| internet | `wan`, `internet`, `dns`, `backup` |
| network | `lan`, `wifi`, `guest`, `thread`, `power`, `reservations` |
| clients | `clients` |
| profiles | `profiles` |
| topology | `map` |
| airtime | `clients-by-band`, `channels`, `airtime` |
| security | `protection`, `activity`, `inbound`, `domains` |
| insights | `speeds`, `transferred`, `speedtests`, `downloaders`, `uploaders`, `hours`, `concentration`, `senders`, `heaviest` |
| settings | `notifications`, `display`, `time`, `language`, `network`, `firmware`, `filters`, `access` |

`layout.views` builds pages of the theme's own out of other pages' panes.
Each view has a name, in lowercase letters and `_`, and a list of `panes`, each either
`page/pane` from the table above or `section/<name>`, and it is drawn at
`/v/<name>` with its panes in one column in the order given. A group in
`nav_groups` can then name `/v/<name>` like any route, and its label is
`view.<name>` in the theme's `strings`, which it must have. Winksys uses this to lay Eeronaut out the way
that router's own pages were.

Sections are the few things that are not a pane anywhere, or are part of
one. A section a view names is taken out of where it lived, so it is on the
screen once:

| Section | Where it lives otherwise |
|---|---|
| `ddns` | the last row of the Internet card |
| `network_switcher` | the header, or the top bar |
| `notifications` | the bell; with the bell gone the feed is still read, so alerts still arrive |

A page any view draws on is no longer a page of its own under that theme.
Its route, `?pane=` included, goes to the view holding that pane, or else to
the first view drawing on that page, so a link from search still lands on
the card it named. A route no view draws on, `/insights` in Winksys, stays
as it is. The manifest is refused if a view is named twice, if a section
appears in two views, or if a group names a view the theme does not
declare.

A theme that wants to move something no knob covers needs the knob added to
Eeronaut first, in a change everyone gets. That is the point of knobs.

## Screenshots

Each theme has two, `screenshot-light.png` and `screenshot-dark.png`, shown in
the picker. The bundled ones are 1280 by 800; make yours at least 800 by 500,
of the theme applied in each appearance. They go wherever the theme goes, so
take them of something you don't mind showing: a network's name, its clients,
and its addresses are all on the dashboard. The bundled ones are of a network
made up for the purpose.

## Choosing a theme

Settings, Display: the theme dropdown, the Light, Dark, and System buttons, and
a preview. Nothing changes until Apply is pressed. The choice is saved on the
server for the installation, like the other display preferences, and the
sign-in screen wears it too.

## Installing your own theme

Put the theme's directory in the `themes/` folder inside the data folder:
`~/.config/eeronaut/themes/` with the recommended `docker-compose.yml`, or
`/var/lib/eeronaut/themes/` without Docker. Create the folder if it is not
there. Either data folder belongs to the account Eeronaut runs as rather than
to you, so copying into it takes `sudo`: for example,
`sudo cp -r mytheme /var/lib/eeronaut/themes/`. The directory's name must match the manifest's `id`. Eeronaut
reads the folder afresh each time Settings is opened, so there is nothing to
restart or rebuild: open Settings, Display, and the theme is in the list. There is no upload in the interface yet. A theme
added this way that shares an id with a bundled one is ignored: what ships
cannot be shadowed. One that does not validate is left out, with the reason
in the server log.
