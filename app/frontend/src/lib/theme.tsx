import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'

/* Themes.
 *
 * A theme is a directory the server hands out under /api/themes/<id>/: a
 * stylesheet, two screenshots, a manifest, and whatever pictures or fonts the
 * stylesheet needs. It holds no code, and no words but its own (`strings`).
 * What it may say about the
 * interface's structure is what the manifest's `layout` declares — where the
 * navigation goes, how tightly things sit, and per page which panes appear,
 * in what order and at what width. Those are knobs this file turns; a theme
 * cannot reach past them.
 *
 * The stylesheet works by setting the tokens `index.css` names and, for
 * anything more, by styling elements through the `data-part` attribute every
 * structural element carries. Both are contracts the interface keeps.
 */

export type Navigation = 'rail' | 'top' | 'bottom' | 'tabs'
export type Hints = 'inline' | 'aside'
export type Overflow = 'scroll' | 'fold'
export type Density = 'comfortable' | 'compact'
export type Collapse = 'none' | 'menu'

export interface PagePlan {
  order: string[]
  hidden: string[]
  wide: string[]
  narrow: string[]
}

/** Destinations folded behind one named menu, for a horizontal bar. The
 *  label is the program's for the few groups any theme may use (connection,
 *  devices, activity), and otherwise the theme's own, `nav_group.<group>` in
 *  its `strings`, which is never in the catalogs. */
export interface NavGroup {
  group: string
  items: string[]
}

/** One page a theme assembles out of other pages' panes, at `/v/<view>`.
 *  Each pane is `page/pane`, a pane of a real page, or `section/<name>`, one
 *  of the few things that are not a pane anywhere (the network picker, which
 *  lives in the header) or are a part of one (dynamic DNS, a field of the
 *  Internet card). A section a view names is taken out of where it was, so
 *  it is on screen once. */
export interface View {
  view: string
  panes: string[]
}

export interface Layout {
  navigation: Navigation
  /** What a horizontal bar does on a phone: keep folding destinations into
   *  a menu one at a time (`none`), or put all of them behind one menu
   *  button below the breakpoint (`menu`). */
  collapse: Collapse
  density: Density
  pages: Record<string, PagePlan>
  nav_groups: NavGroup[]
  /** Where a field's explanation goes: under the field (`inline`), or
   *  gathered into a column down the side of its card (`aside`). */
  hints: Hints
  /** What content wider than its column does, a table or the network map:
   *  scroll sideways inside it, or fold into a narrower shape until it fits
   *  again. See `useFold`. */
  overflow: Overflow
  views: View[]
}

export interface ThemeInfo {
  id: string
  version: string
  /** The theme's own words, from its manifest, untranslated like the
   *  rest of what only a theme says. */
  title: string
  description: string
  /** Paths the browser can fetch, one per appearance. */
  screenshots: { light: string; dark: string }
  /** The theme's own tab icon, or null to keep the program's. */
  favicon: string | null
  layout: Layout
  /** The theme's own words for what only it shows: its groups' and views'
   *  labels and a tab strip's product bar. Untranslated, as the title is. */
  strings?: Record<string, string>
}

export interface ThemeList {
  active: string
  default: string
  themes: ThemeInfo[]
}

export const RAIL: Layout = {
  navigation: 'rail', collapse: 'none', density: 'comfortable', pages: {},
  nav_groups: [], hints: 'inline', overflow: 'scroll', views: [],
}

interface Active {
  id: string; layout: Layout; favicon: string | null
  strings: Record<string, string>
}

const Ctx = createContext<Active>({ id: '', layout: RAIL, favicon: null, strings: {} })

/** The theme in force: its id and the structural choices it made. */
export const useTheme = () => useContext(Ctx)

/** Only what the server would have accepted as a pane or page name. The
 *  server validates manifests, so this is belt and braces — but the names go
 *  into a stylesheet, and that is not a place to trust anything. */
const NAME = /^[a-z][a-z0-9_-]{0,31}$/

/** The CSS that puts a theme's page plans into effect.
 *
 *  Each page is a grid and each pane a direct child of it carrying
 *  `data-slot`; `order`, `display`, and `grid-column` on those children are
 *  the whole mechanism. Panes the plan does not name keep `order: 0`, so
 *  named ones (negative) come first in the order given and the rest follow
 *  in the page's own. An unlayered rule beats a utility class of any
 *  specificity, which is what lets `narrow` undo a page's own `col-span`. */
/* The one pane no theme places. A firmware update restarts every eero at an
   hour most people never chose, so when one is waiting it is the first thing
   on the dashboard whatever the theme's plan says: first, across the whole
   row, and not hidden. The card draws nothing when there is no update, so
   this costs no space the rest of the time. Written after the theme's own
   rules, which it therefore overrides. */
const FIRMWARE_FIRST = 'order:-1000;grid-column:1 / -1;display:grid'

export function layoutCss(layout: Layout): string {
  const out: string[] = []
  for (const [page, plan] of Object.entries(layout.pages)) {
    if (!NAME.test(page)) continue
    const at = (pane: string) => `[data-page="${page}"] > [data-slot="${pane}"]`
    const ok = (names: string[]) => names.filter((n) => NAME.test(n))
    ok(plan.order).forEach((pane, i, all) =>
      out.push(`${at(pane)}{order:${i - all.length}}`))
    for (const pane of ok(plan.hidden)) out.push(`${at(pane)}{display:none}`)
    for (const pane of ok(plan.wide)) out.push(`${at(pane)}{grid-column:1 / -1}`)
    for (const pane of ok(plan.narrow)) out.push(`${at(pane)}{grid-column:auto}`)
  }
  out.push(`[data-page="dashboard"] > [data-slot="firmware"]{${FIRMWARE_FIRST}}`)
  for (const view of layout.views) out.push(...viewCss(view))
  return out.join('\n')
}

/** The route a page is at, from the name it gives itself. */
export const pageRoute = (page: string) => (page === 'dashboard' ? '/' : `/${page}`)

/** A view's panes, split: the real pages it draws on, in the order they are
 *  first named, and the sections. */
export function viewParts(view: View) {
  const pages: string[] = []
  const sections: string[] = []
  for (const ref of view.panes) {
    const [page, pane] = ref.split('/')
    if (!NAME.test(page) || !NAME.test(pane ?? '')) continue
    if (page === 'section') sections.push(pane)
    else if (!pages.includes(page)) pages.push(page)
  }
  return { pages, sections }
}

/** The view a page's panes are shown in, if the theme has put them in one:
 *  the view holding the pane asked for, else the first one drawing on the
 *  page at all. */
export function viewFor(views: View[], page: string, pane: string | null): View | undefined {
  const hosts = views.filter((v) => v.panes.some((ref) => ref.startsWith(`${page}/`)))
  return hosts.find((v) => pane !== null && v.panes.includes(`${page}/${pane}`)) ?? hosts[0]
}

/** Whether some view has taken this section, so its home should not draw it. */
export function useClaimed(section: string): boolean {
  const { layout } = useTheme()
  return layout.views.some((v) => v.panes.includes(`section/${section}`))
}

/** The CSS that makes a view out of whole pages.
 *
 *  A view mounts every page it draws on, each as it always is, and hides
 *  what it did not ask for. The pages give up their own grids to the view's
 *  (`display: contents`), so its panes are one column in the order the view
 *  names them whichever page they came from. Every pane is the full width of
 *  that column: a pane a two-column page spans across would otherwise open a
 *  second column the view never has. */
function viewCss(view: View): string[] {
  if (!NAME.test(view.view)) return []
  const v = `[data-view="${view.view}"]`
  const out = [`${v} > [data-page]{display:contents}`,
               `${v} [data-slot]{grid-column:1 / -1}`]
  const { pages } = viewParts(view)
  for (const page of pages) {
    const names = view.panes
      .filter((ref) => ref.startsWith(`${page}/`))
      .map((ref) => ref.split('/')[1])
    // A view built from the dashboard shows its firmware notice whether it
    // named it or not, and first (FIRMWARE_FIRST).
    if (page === 'dashboard' && !names.includes('firmware')) names.push('firmware')
    const keep = names.map((n) => `:not([data-slot="${n}"])`).join('')
    out.push(`${v} > [data-page="${page}"] > *${keep}{display:none}`)
  }
  view.panes.forEach((ref, i) => {
    const [page, pane] = ref.split('/')
    if (!NAME.test(page) || !NAME.test(pane ?? '')) return
    out.push(page === 'section'
      ? `${v} > [data-section="${pane}"]{order:${i}}`
      : `${v} > [data-page="${page}"] > [data-slot="${pane}"]{order:${i}}`)
  })
  if (pages.includes('dashboard')) {
    out.push(`${v} > [data-page="dashboard"] > [data-slot="firmware"]{${FIRMWARE_FIRST}}`)
  }
  return out
}

const LINK = 'eeronaut-theme'
const LAYOUT = 'eeronaut-layout'

/* The theme most recently asked for. Two loads can be in flight at once —
   the access state names one theme and the preferences, read a moment
   later, name another — and whichever finishes second must not tidy away
   the winner's sheet. Only the load for the theme still wanted may remove
   the others; a load that has been overtaken removes its own sheet instead. */
let wanted = ''

/** Put a theme's stylesheet in force, resolving once it has applied.
 *
 *  The new sheet is added beside the old one and the old one removed only
 *  after the new has loaded, so a switch never shows the gray fallback in
 *  between. A sheet that fails to load resolves too: the fallback tokens in
 *  `index.css` are legible, and a missing theme is the server's to report. */
function applyStylesheet(id: string): Promise<void> {
  wanted = id
  return new Promise((done) => {
    const href = `/api/themes/${encodeURIComponent(id)}/theme.css`
    const have = document.querySelector<HTMLLinkElement>(`link[data-${LINK}="${id}"]`)
    if (have) { done(); return }
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset[camel(LINK)] = id
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (wanted === id) {
        document.querySelectorAll<HTMLLinkElement>(`link[data-${LINK}]`)
          .forEach((l) => { if (l !== link) l.remove() })
      } else {
        link.remove()
      }
      done()
    }
    link.addEventListener('load', finish, { once: true })
    link.addEventListener('error', finish, { once: true })
    document.head.appendChild(link)
    // A sheet the browser never reports on — blocked, or a server that
    // hangs — must not hold the whole interface hostage.
    window.setTimeout(finish, 4000)
  })
}

const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())

/* The icon links the page shipped with, remembered before anything replaces
   them so choosing a theme without one puts the program's own icon back.
   Captured once, lazily, because this module is imported before the head has
   necessarily been parsed in every environment. */
const ICON_SELECTOR = 'link[rel~="icon"], link[rel="apple-touch-icon"]'

/** Ask for the active theme's tab icon again.
 *
 *  The favicon is a <link> in the head, so unlike everything else a theme
 *  changes it cannot be reached from a stylesheet. The document already
 *  points at an endpoint that serves whichever theme is switched on, so
 *  there is no icon to swap in on load — only a stale one to replace when
 *  the theme changes while the page stays open, which the query does by
 *  making the href a URL the browser has not fetched yet. */
function applyFavicon(id: string) {
  const href = `/api/themes/active-favicon?theme=${encodeURIComponent(id)}`
  document.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR)
    .forEach((l) => { l.href = href })
}

function applyLayout(id: string, layout: Layout) {
  const root = document.documentElement
  root.dataset.themeId = id
  root.dataset.nav = layout.navigation
  root.dataset.density = layout.density
  let style = document.getElementById(LAYOUT) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = LAYOUT
    document.head.appendChild(style)
  }
  style.textContent = layoutCss(layout)
}

/** Find the theme in the list, or the list's default, or a bare rail. */
function pick(list: ThemeList | null, id: string): Active {
  const found = list?.themes.find((t) => t.id === id)
    ?? list?.themes.find((t) => t.id === list.default)
  // Merged over the defaults rather than taken whole: a theme written for an
  // older build has no `nav_groups`, and reading one off `undefined` is a
  // blank interface rather than a missing menu.
  return found
    ? { id: found.id, layout: { ...RAIL, ...found.layout },
        favicon: found.favicon ?? null, strings: found.strings ?? {} }
    : { id, layout: RAIL, favicon: null, strings: {} }
}

/**
 * Holds the interface until its theme is on the page.
 *
 * `id` is what the server says is in force — read off the access state, the
 * first thing the interface asks for, so the sign-in screen is themed too.
 * Nothing renders until the stylesheet has loaded: the alternative is a
 * flash of the gray fallback on every load, which would make the fallback
 * look like part of the design.
 *
 * A later change of `id` — somebody pressed Apply in Settings — swaps the
 * stylesheet under the running interface and re-stamps the layout, with the
 * children left mounted. The one structural knob that is React's to honor,
 * where the navigation goes, re-renders from context.
 */
/* Where to go once a theme that is being switched to is in force.

   Themes need not share pages: Winksys shows the theme picker in a view of
   its own, and every other theme on the Settings page. Switching from one to
   the other from the picker left somebody on a page the new theme did not
   have, which sent them to the dashboard, a long way from the menu they had
   just used. So the picker names where to go, and it happens once the new
   theme is actually drawn: any earlier and the address would be resolved
   against the theme being left. An event, because this provider sits
   outside the router that does the going (`Shell` listens). */
let follow: { page: string; pane: string } | null = null
export const FOLLOW_EVENT = 'eeronaut:follow-theme'
/** Go to this page's pane once the theme being switched to is in force,
 *  wherever that theme keeps it: in a view of its own, or on the page. */
export function followAfterThemeChange(page: string, pane: string) { follow = { page, pane } }

export function ThemeProvider({ id, children }: { id: string; children: ReactNode }) {
  const [active, setActive] = useState<Active | null>(null)

  /* After the children's effects, which is after anything they did about the
     change themselves (a view that the new theme lacks sends itself home),
     so this has the last word. */
  useEffect(() => {
    if (!active || !follow) return
    const { page, pane } = follow
    follow = null
    /* The address in the new theme's own terms, worked out here rather than
       left to the page's redirect: a redirect and this navigation landing in
       the same moment canceled each other, and the page stayed where it was
       while the theme changed around it. */
    const view = viewFor(active.layout.views, page, pane)
    const to = view ? `/v/${view.view}?pane=${pane}` : `${pageRoute(page)}?pane=${pane}`
    window.dispatchEvent(new CustomEvent(FOLLOW_EVENT, { detail: to }))
  }, [active])

  useEffect(() => {
    let live = true
    void (async () => {
      const list = await api.get<ThemeList>('/api/themes').catch(() => null)
      const next = pick(list, id)
      await applyStylesheet(next.id)
      if (!live) return
      applyLayout(next.id, next.layout)
      applyFavicon(next.id)
      setActive(next)
    })()
    return () => { live = false }
  }, [id])

  if (!active) return null
  return <Ctx.Provider value={active}>{children}</Ctx.Provider>
}
