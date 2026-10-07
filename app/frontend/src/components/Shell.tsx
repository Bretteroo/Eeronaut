import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Page, SkeletonCard } from './primitives'
import { preloadPage } from '../lib/pages'
import { FOLLOW_EVENT, pageRoute, useClaimed, useTheme, viewParts, type View } from '../lib/theme'
import { AboutDialog } from './AboutDialog'
import { AboutContext } from '../lib/about'
import { CommandSearch } from './CommandSearch'
import { NetworkSwitcher } from './NetworkSwitcher'
import type { Updates } from './FirmwareUpdate'
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
         type ReactNode } from 'react'
import { api } from '../lib/api'
import { currentLanguage, t, tOr } from '../i18n'

/* Inline single-path icons keep the bundle self-contained and the rail crisp
   at 20px, where most icon fonts go muddy. */
const I = {
  dashboard: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
  profiles: 'M12 2a5 5 0 1 0 5 5 5 5 0 0 0-5-5Zm0 12c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5Zm7.5-6.5a3.5 3.5 0 1 0 3.5 3.5 3.5 3.5 0 0 0-3.5-3.5Z',
  clients: 'M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 1a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.3 0-7 1.2-7 3.5V20h7v-2.5c0-.9.5-1.9 1.4-2.7A11 11 0 0 0 8 14Zm8 0c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4Z',
  topology: 'M12 2a3 3 0 0 1 1 5.8V10h5a3 3 0 0 1 3 3v1.2a3 3 0 1 1-2 0V13a1 1 0 0 0-1-1h-5v2.2a3 3 0 1 1-2 0V12H6a1 1 0 0 0-1 1v1.2a3 3 0 1 1-2 0V13a3 3 0 0 1 3-3h5V7.8A3 3 0 0 1 12 2Z',
  internet: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm7.9 9h-3.3a15.3 15.3 0 0 0-1.2-5.3A8 8 0 0 1 19.9 11ZM12 4c.9 1.2 1.9 3.5 2.1 7H9.9C10.1 7.5 11.1 5.2 12 4ZM4.1 13h3.3a15.3 15.3 0 0 0 1.2 5.3A8 8 0 0 1 4.1 13Zm3.3-2H4.1a8 8 0 0 1 4.5-5.3A15.3 15.3 0 0 0 7.4 11ZM12 20c-.9-1.2-1.9-3.5-2.1-7h4.2c-.2 3.5-1.2 5.8-2.1 7Zm3.4-1.7a15.3 15.3 0 0 0 1.2-5.3h3.3a8 8 0 0 1-4.5 5.3Z',
  /* A router, not a second globe: the Internet tab above it took the globe,
     and two of them in a row named neither. */
  network: 'M4 13h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Zm2 3a1.2 1.2 0 1 0 1.2 1.2A1.2 1.2 0 0 0 6 16Zm4 0a1.2 1.2 0 1 0 1.2 1.2A1.2 1.2 0 0 0 10 16Zm2-14a1 1 0 0 1 1 1v8h-2V3a1 1 0 0 1 1-1Zm5.7 1.3a1 1 0 0 1 0 1.4 8 8 0 0 0 0 5.6 1 1 0 1 1-1.4 1.4 10 10 0 0 1 0-8.4 1 1 0 0 1 1.4 0Zm-11.4 0a1 1 0 0 1 1.4 0 1 1 0 0 1 0 1.4 8 8 0 0 0 0 5.6 1 1 0 1 1-1.4 1.4 10 10 0 0 1 0-8.4Z',
  security: 'M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5Zm0 5a2.5 2.5 0 0 1 1 4.8V15a1 1 0 0 1-2 0v-3.2A2.5 2.5 0 0 1 12 7Z',
  insights: 'M4 20h16v2H2V2h2Zm3-3V9h3v8Zm5 0V4h3v13Zm5 0v-6h3v6Z',
  // Concentric arcs: a radio spending airtime.
  airtime: 'M12 18a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm0-5.5a7.5 7.5 0 0 1 5.3 2.2l-1.4 1.4a5.5 5.5 0 0 0-7.8 0l-1.4-1.4A7.5 7.5 0 0 1 12 12.5Zm0-5a12.5 12.5 0 0 1 8.8 3.7l-1.4 1.4a10.5 10.5 0 0 0-14.8 0l-1.4-1.4A12.5 12.5 0 0 1 12 7.5Z',
  local: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 3a7 7 0 0 1 7 7h-2a5 5 0 0 0-5-5Zm0 4a3 3 0 0 1 3 3h-2a1 1 0 0 0-1-1Zm-7 3a7 7 0 0 0 7 7v-2a5 5 0 0 1-5-5Z',
  tests: 'M9 2h6v2h-1v4.2l4.7 8.4A3 3 0 0 1 16 21H8a3 3 0 0 1-2.7-4.4L10 8.2V4H9V2Zm3 10.5-2.6 4.6h5.2L12 12.5Z',
  /* MDI's own `cog`, rather than the approximation that stood in for it:
     the teeth are square and evenly spaced, which reads as a gear at
     20px where the hand-drawn one read as a blob. */
  settings: 'M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z',
  info: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 4.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM10.5 11h3v7h-3Z',
}

/* Icons are single paths on a 24-unit grid unless they say otherwise. */
const VIEWBOX: Partial<Record<keyof typeof I, string>> = {
}

/* Keys rather than strings, and translated at the point of use.
   This array is module-level, so it is built once when the module loads —
   before any provider has put a language in force. Calling t() here captured
   English permanently, which is how the sidebar stayed English while every
   page around it turned Spanish. */
interface Item {
  to: string; label: string; short: string; icon: keyof typeof I
  /** The routes whose data and code this destination needs, when it is not
   *  itself one of them: a theme's view, which is made of other pages. */
  warms?: string[]
  /** The theme's own name for it, in place of the catalog's: a view's
   *  label is one only its theme uses, so it is never in the catalogs. */
  text?: string
}

/** A group's label: the theme's own words for a group only it has, or the
 *  program's for one of the groups any theme may use. */
const groupLabel = (words: Record<string, string>, group: string) =>
  words[`nav_group.${group}`] ?? tOr(`nav_group.${group}`, group)

/** What a destination is called, in full and short. */
const named = (n: Item) => n.text ?? t(n.label)
const short = (n: Item) => n.text ?? t(n.short)
const NAV: Item[] = [
  { to: '/', label: 'nav.dashboard', short: 'nav.dashboard', icon: 'dashboard' },
  /* The connection and the network it serves, straight after the overview:
     they are the two pages somebody opens when something is wrong, and they
     were below four pages about who is on the network and how. */
  { to: '/internet', label: 'nav.internet', short: 'nav.internet', icon: 'internet' },
  { to: '/network', label: 'nav.network', short: 'nav.network', icon: 'network' },
  { to: '/clients', label: 'nav.clients', short: 'nav.clients', icon: 'clients' },
  { to: '/profiles', label: 'nav.profiles', short: 'nav.profiles', icon: 'profiles' },
  { to: '/topology', label: 'nav.topology', short: 'nav.topology', icon: 'topology' },
  { to: '/airtime', label: 'nav.airtime', short: 'nav.airtime', icon: 'airtime' },
  { to: '/security', label: 'nav.security', short: 'nav.security', icon: 'security' },
  { to: '/insights', label: 'nav.insights', short: 'nav.insights', icon: 'insights' },
  { to: '/settings', label: 'nav.settings', short: 'nav.settings', icon: 'settings' },
]


function Icon({ name, className = 'size-5' }: { name: keyof typeof I; className?: string }) {
  return (
    <svg viewBox={VIEWBOX[name] ?? '0 0 24 24'} className={`${className} shrink-0`}
         fill="currentColor" aria-hidden="true">
      <path d={I[name]} />
    </svg>
  )
}


/**
 * Start a new page at the top.
 *
 * The browser restores the scroll position on a real page load; a router that
 * swaps the content underneath one does not, so following a link from halfway
 * down a long page landed halfway down the next one. Reported from use.
 *
 * On the path only. A change to the query string is not a new page: `?pane=`
 * is how search sends somebody to one card on a page they may already be
 * reading, and `usePaneFocus` scrolls that card into view — resetting here
 * would fight it and win. The first render is left alone too, so a link
 * opened straight into a pane still lands on it.
 */
function ScrollToTop() {
  const { pathname } = useLocation()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    window.scrollTo({ top: 0, left: 0 })
  }, [pathname])
  return null
}
/* What a page needs before it is asked for: its first reads, and now its
 * code. Imported at the moment of the hover rather than at the top of this
 * file, so the prefetch table — every page's opening reads — is not part of
 * the chunk the browser loads first. */
function warm(path: string, also?: string[]) {
  for (const route of also ?? [path]) {
    void import('../lib/prefetch').then((m) => m.prefetch(route))
    preloadPage(route)
  }
}

/* The destinations, styled for wherever the theme has put them. Three
   placements share one list and one set of behaviors — prefetch on hover,
   close the drawer on a tap — and differ only in shape: a stacked row in the
   rail, a chip in the top bar, an icon over its word in the bottom bar. */
function BarLink({ item, placement, onPick }: {
  item: Item; placement: 'top' | 'bottom'; onPick: () => void
}) {
  return <Links placement={placement} onPick={onPick} only={item} />
}

function Links({ placement, onPick, only }: {
  placement: 'rail' | 'top' | 'bottom'
  onPick: () => void
  /** One destination rather than all of them, for a bar that places each
   *  itself. The rail still renders the whole list. */
  only?: Item
}) {
  const shape = {
    rail: 'flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] font-medium',
    top: 'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] font-medium',
    bottom: 'flex flex-col items-center gap-0.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-medium',
  }[placement]
  const tone = placement === 'rail'
    ? { on: 'bg-[var(--color-accent)] text-white',
        off: 'text-[var(--color-rail-ink)] hover:bg-[var(--color-rail-hover)] hover:text-white' }
    : placement === 'top'
    ? { on: 'bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]',
        off: 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]' }
    : { on: 'bg-[var(--color-accent)] text-white',
        off: 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]' }
  return (
    <>
      {(only ? [only] : NAV).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={onPick}
          /* Fetched on intent rather than on arrival: by the time a click
             lands, a few hundred milliseconds later, the page usually has
             its data already. */
          onPointerEnter={() => warm(n.to)}
          onFocus={() => warm(n.to)}
          title={named(n)}
          aria-label={named(n)}
          data-part="nav-link"
          className={({ isActive }) =>
            `${shape} transition-colors ${isActive ? tone.on : tone.off}`}
        >
          <Icon name={n.icon} className={placement === 'top' ? 'size-4' : 'size-5'} />
          {/* Always the word. A horizontal bar used to hide these below a
              breakpoint so ten destinations would fit, which cost the words
              at widths where they fitted perfectly well. `HorizontalNav`
              measures instead, and moves whole destinations into a menu when
              they do not fit — so the label can stay. */}
          <span>{short(n)}</span>
        </NavLink>
      ))}
    </>
  )
}

/**
 * Destinations behind a button: a theme's named group, or the overflow.
 *
 * A horizontal bar cannot hold ten destinations at every width, and the two
 * ways out of that are both here. A theme can fold related pages into a named
 * menu — Eerish does, because a marketing-style top bar with ten tabs is not
 * one anybody designs — and whatever still does not fit goes into "More",
 * which is what a bar of fixed height has always done when it runs out of
 * room. Scrolling was not enough on its own: the strip scrolled, but with the
 * scrollbar hidden there was no way to reach what had gone past the edge with
 * a mouse.
 */
function NavMenu({ label, icon, items, drop, placement, onPick, whole = false,
                   trigger = null, extra = null }: {
  label: string
  icon?: keyof typeof I
  items: Item[]
  /** A bottom bar opens upward, because there is nothing below it. */
  drop: 'down' | 'up'
  placement: 'top' | 'bottom'
  onPick: () => void
  /** What to draw in the button instead of the label and the arrow, for the
   *  case where something already on the bar is the way in — the mark, on a
   *  phone, where a second button beside it would be the same button twice. */
  trigger?: { part: string; content: ReactNode; className: string; title?: string } | null
  /** One entry at the foot of the list that goes nowhere: it does something
   *  here instead. About is the only one, and it is in the list because on a
   *  phone the mark it used to open is now what opens this. */
  extra?: { label: string; onPick: () => void } | null
  /** This menu is the navigation, not a part of it: drawn as the three
   *  rules a phone's menu button is drawn as everywhere, with the label
   *  going to the screen reader rather than onto the bar. Nor is it marked
   *  as the place you are — everywhere is in here, so saying so says
   *  nothing. */
  whole?: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const loc = useLocation()
  const here = !whole && items.some((n) => n.to === loc.pathname
    || (n.to !== '/' && loc.pathname.startsWith(`${n.to}/`)))

  /* Closed by anything that means "I am done with this": a click elsewhere,
     Escape, or arriving somewhere. Escape is on the document rather than the
     menu so it works while focus is on the button that opened it. */
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  useEffect(() => { setOpen(false) }, [loc.pathname])

  const shape = placement === 'top'
    ? 'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] font-medium'
    : 'flex flex-col items-center gap-0.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-medium'
  const tone = here
    ? 'bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
    : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]'

  return (
    <div ref={box} data-part="nav-menu" className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-part={trigger ? trigger.part : 'nav-menu-button'}
        data-whole={whole ? '1' : undefined}
        data-here={here ? '1' : undefined}
        aria-label={whole ? label : undefined}
        title={trigger?.title}
        className={trigger ? trigger.className : `${shape} transition-colors ${tone}`}
      >
        {trigger ? trigger.content : whole ? (
          <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
            <path d="M3 6h18v2H3Zm0 5h18v2H3Zm0 5h18v2H3Z" />
          </svg>
        ) : (
          <>
            {icon && <Icon name={icon} className={placement === 'top' ? 'size-4' : 'size-5'} />}
            <span>{label}</span>
            <svg viewBox="0 0 24 24" className="size-3 shrink-0" fill="currentColor" aria-hidden="true">
              <path d={drop === 'up' ? 'M12 8l6 7H6z' : 'M12 16l-6-7h12z'} />
            </svg>
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          data-part="nav-menu-list"
          className={`absolute z-40 min-w-44 rounded-lg border border-[var(--color-line)]
                      bg-[var(--color-surface)] p-1 shadow-xl
                      ${drop === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'}
                      ${/* Anchored to the side the button is nearest, so a
                            menu never opens off the edge of the screen. A
                            bottom bar's menus are at its right end — the
                            overflow is always last — and centring one on its
                            button put it half off a 420px screen. */
                        placement === 'bottom' ? 'right-0' : 'left-0'}`}
        >
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              role="menuitem"
              onClick={() => { setOpen(false); onPick() }}
              onPointerEnter={() => warm(n.to, n.warms)}
              onFocus={() => warm(n.to, n.warms)}
              data-part="nav-link"
              className={({ isActive }) =>
                `flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-2 text-[13px] ${
                  isActive
                    ? 'bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
                    : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]'}`}
            >
              <Icon name={n.icon} className="size-4" />
              <span>{short(n)}</span>
            </NavLink>
          ))}
          {extra && (
            <>
              <hr className="my-1 border-0 border-t border-[var(--color-line)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); extra.onPick() }}
                data-part="nav-menu-action"
                className="flex w-full items-center gap-2 whitespace-nowrap rounded-md
                           px-2.5 py-2 text-left text-[13px] text-[var(--color-ink-2)]
                           hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
              >
                <Icon name="info" className="size-4" />
                <span>{extra.label}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Which page a path is, by the name the pages give themselves. The routes
 *  and the names line up exactly — `/clients` is `clients` — and the root is
 *  the dashboard. */
function pageName(pathname: string): string {
  const name = pathname.replace(/^\/+|\/+$/g, '')
  return name === '' ? 'dashboard' : name
}

/** The mark and the name. The name is dropped on a narrow screen, where the
 *  mark alone is what somebody taps. */
const BRAND_SHAPE = 'flex shrink-0 items-center gap-2 rounded-md pr-2'

function Brand() {
  return (
    <>
      <img src="/logo-64.png" alt="" width={64} height={64}
           className="size-7 object-contain" />
      <span className="hidden text-[14px] font-semibold sm:inline">
        {t('shell.eeronaut')}
      </span>
    </>
  )
}

/**
 * The bar's contents: top-level links, a theme's named menus, and whatever
 * did not fit.
 *
 * Grouping is the theme's declaration and is applied first; the overflow is
 * measured afterward, because how much fits depends on what the grouping
 * left behind. A group takes the place of its first member, so the order a
 * reader learned does not move around underneath them.
 */
type Entry =
  | { kind: 'link'; item: Item }
  | { kind: 'group'; group: string; items: Item[] }

function arrange(groups: { group: string; items: string[] }[]): Entry[] {
  const claimed = new Map<string, string>()
  for (const g of groups) for (const route of g.items) claimed.set(route, g.group)
  const out: Entry[] = []
  const done = new Set<string>()
  for (const n of NAV) {
    const name = claimed.get(n.to)
    if (!name) { out.push({ kind: 'link', item: n }); continue }
    if (done.has(name)) continue
    done.add(name)
    const spec = groups.find((g) => g.group === name)!
    const items = spec.items
      .map((route) => NAV.find((x) => x.to === route))
      .filter((x): x is Item => Boolean(x))
    if (items.length) out.push({ kind: 'group', group: name, items })
  }
  return out
}

/**
 * A bar of destinations that always fits.
 *
 * The strip is rendered whole and then narrowed: while it overflows, the last
 * entry moves into "More". One entry per pass, which converges because the
 * count only ever falls, and it is measured before the browser paints so
 * nothing is seen mid-settle. A resize of the container puts everything back
 * and measures again, so widening the window brings the destinations back out
 * of the menu.
 *
 * Measured rather than decided by a breakpoint because the width of these
 * words is not a constant: this app ships thirteen languages, and "Sendezeit"
 * and "Auswertungen" need room that "Airtime" and "Insights" do not.
 */
/** Whether the window is phone-width, watched rather than read once.
 *
 *  The same breakpoint the rest of the interface calls `md`, which is where
 *  a bar of ten destinations stops being a reasonable thing to draw. */
const PHONE = '(max-width: 767px)'

function usePhone() {
  const [is, setIs] = useState(() => window.matchMedia(PHONE).matches)
  useEffect(() => {
    const q = window.matchMedia(PHONE)
    const read = () => setIs(q.matches)
    read()
    q.addEventListener('change', read)
    return () => q.removeEventListener('change', read)
  }, [])
  return is
}

/** Every destination the bar holds, in the order the bar would draw them:
 *  a group's members where the group sits. */
function allDestinations(groups: { group: string; items: string[] }[]): Item[] {
  return arrange(groups).flatMap((e) => (e.kind === 'link' ? [e.item] : e.items))
}

function HorizontalNav({ placement, groups, folded, onAbout, onPick }: {
  placement: 'top' | 'bottom'
  groups: { group: string; items: string[] }[]
  /** Every destination behind one button, which is what a phone gets when
   *  the theme asks for it. */
  folded: boolean
  /** Opens the About dialog. It goes in the folded menu, where it is the
   *  only way to it: the bar's own About button is desktop-only, and with
   *  the destinations folded away there is nothing else left in the bar. */
  onAbout: () => void
  onPick: () => void
}) {
  const entries = useMemo(() => arrange(groups), [groups])
  const words = useTheme().strings
  const [shown, setShown] = useState(entries.length)
  const strip = useRef<HTMLDivElement>(null)
  const wasWide = useRef(0)
  const lang = currentLanguage()

  // Back to everything whenever what fits could have changed, so the next
  // measurement starts from the top rather than from a narrower answer.
  useEffect(() => { setShown(entries.length) }, [entries.length, lang, placement])

  /* Fit the strip to its room, one destination at a time: after every
     render, if it still overflows, move one more into the menu and render
     again. No dependency list on purpose, since it has to measure again after
     each of those renders. It ends because it only acts while the strip
     overflows and more than one destination is showing, and each pass takes
     one away. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = strip.current
    if (!el || folded) return
    if (el.scrollWidth > el.clientWidth + 1 && shown > 1) setShown((n) => n - 1)
  })

  /* The window, not the strip.
   *
   * A bottom bar is sized by its contents: once a destination moves into the
   * menu the bar gets narrower, and the strip's own width then stops changing
   * no matter how wide the window gets — so watching the strip meant things
   * went into the menu and never came back out. The window is what actually
   * decides how much room there is, for both placements. */
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth === wasWide.current) return
      wasWide.current = window.innerWidth
      setShown(entries.length)
    }
    wasWide.current = window.innerWidth
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [entries.length])

  /* Folded: nothing on the bar, everything in the one menu. Otherwise as
     much as fits, with the remainder behind More. */
  const fits = folded ? [] : entries.slice(0, shown)
  const rest = folded ? entries : entries.slice(shown)
  // Whatever is in the overflow, flattened: a group that did not fit puts its
  // destinations into More rather than nesting a menu inside a menu.
  const spare = rest.flatMap((e) => (e.kind === 'link' ? [e.item] : e.items))
  const drop = placement === 'bottom' ? 'up' : 'down'

  return (
    /* Not clipped. An `overflow` of any kind here would cut off the menus
       that open out of it — measured: the overflow menu rendered at its full
       height and was invisible and unclickable, because a scroll container
       clips its absolutely-positioned children. Nothing needs clipping now
       that the contents are measured to fit. */
    <div ref={strip} data-part="nav-strip"
         className="flex min-w-0 flex-1 items-center gap-0.5">
      {fits.map((e) => (e.kind === 'link'
        ? <BarLink key={e.item.to} item={e.item} placement={placement} onPick={onPick} />
        : <NavMenu key={e.group} label={groupLabel(words, e.group)} items={e.items}
                   drop={drop} placement={placement} onPick={onPick} />))}
      {spare.length > 0 && (
        <NavMenu label={folded ? t('shell.toggle_navigation') : t('nav.more')}
                 items={spare} drop={drop} whole={folded}
                 extra={folded
                   ? { label: t('shell.about_eeronaut'), onPick: onAbout }
                   : null}
                 placement={placement} onPick={onPick} />
      )}
    </div>
  )
}

/** Whether a route is the one on screen, the way the navigation's own links
 *  decide it: the front page only when it is exactly the front page, and
 *  anything else for itself and every page under it. */
function isHere(to: string, pathname: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)
}

/**
 * Two rows of tabs: the theme's sections across the first, and the
 * destinations inside whichever section is open across the second.
 *
 * The way a router's own setup pages were arranged, and the one arrangement
 * of the navigation that says where you are twice — which section, and which
 * page in it. A section is a theme's group; a destination no group claims is
 * a section of its own, with itself as its only page. Pressing a section goes
 * to its first page, as those tabs always did.
 *
 * The open section's name is also drawn by itself as `nav-section`, since the
 * layout this comes from set it large beside the page, and a theme cannot put
 * a word on the screen that the interface did not.
 */
interface Section { key: string; label: string; items: Item[] }

/* In the order the theme declares its groups, then anything no group
   claimed. A bar puts a group where its first member was, because there the
   group is interleaved with plain links whose order a reader already knows;
   here the sections are the whole of the navigation, and their order is the
   theme's to give — the router pages this comes from ran Setup first and
   Status last, which no page order produces.

   A group may hold the theme's views as well as pages. A page some view
   draws on is reached through the view, so it is not a section of its own
   even when no group names it. */
function tabSections(groups: { group: string; items: string[] }[], views: View[],
                     words: Record<string, string>): Section[] {
  const asView = (v: View): Item => ({
    to: `/v/${v.view}`, label: '', short: '', icon: 'settings',
    text: words[`view.${v.view}`] ?? v.view,
    warms: viewParts(v).pages.map(pageRoute),
  })
  const byRoute = (route: string) => {
    const v = views.find((x) => `/v/${x.view}` === route)
    return v ? asView(v) : NAV.find((n) => n.to === route)
  }
  const claimed = new Set(groups.flatMap((g) => g.items))
  for (const v of views) for (const page of viewParts(v).pages) claimed.add(pageRoute(page))
  return [
    ...groups
      .map((g) => ({ key: g.group, label: groupLabel(words, g.group),
                     items: g.items.map(byRoute).filter((x): x is Item => Boolean(x)) }))
      .filter((sec) => sec.items.length > 0),
    ...NAV.filter((n) => !claimed.has(n.to))
      .map((n) => ({ key: n.to, label: short(n), items: [n] })),
  ]
}

function TabStrip({ groups, views, onPick }: {
  groups: { group: string; items: string[] }[]
  views: View[]
  onPick: () => void
}) {
  const { pathname } = useLocation()
  const words = useTheme().strings
  const sections = useMemo(() => tabSections(groups, views, words), [groups, views, words])
  const open = sections.find((sec) => sec.items.some((i) => isHere(i.to, pathname)))
    ?? sections[0]
  return (
    <>
      <div data-part="nav-section" aria-hidden="true">{open?.label}</div>
      {/* The product bar: what the thing is, and its model in a box of its
          own, which is what sat between the maker's band and the tabs on
          those pages. The theme's own words, since no other theme would say
          them, and drawn only when the theme names them. */}
      {(words.product_line || words.product_model) && (
        <div data-part="nav-product" aria-hidden="true" className="flex items-stretch">
          {words.product_line && <span data-part="nav-product-line">{words.product_line}</span>}
          {words.product_model && <span data-part="nav-product-model">{words.product_model}</span>}
        </div>
      )}
      <div data-part="nav-tabs" className="flex flex-wrap items-stretch">
        {sections.map((sec) => (
          <Link key={sec.key} to={sec.items[0].to} onClick={onPick}
                onPointerEnter={() => warm(sec.items[0].to, sec.items[0].warms)}
                onFocus={() => warm(sec.items[0].to, sec.items[0].warms)}
                data-part="nav-tab"
                aria-current={sec === open ? 'true' : undefined}
                className="flex items-center px-3 py-1.5 text-[13px] font-medium">
            {sec.label}
          </Link>
        ))}
      </div>
      {/* The second row is the open section's pages, so it changes with the
          section — which is why it is a list of its own and not a menu: every
          page in the section is on screen at once, as it was on those tabs. */}
      <div data-part="nav-subtabs" className="flex flex-wrap items-center">
        {open?.items.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} onClick={onPick}
                   onPointerEnter={() => warm(item.to, item.warms)}
                   onFocus={() => warm(item.to, item.warms)}
                   data-part="nav-link"
                   className="px-3 py-1 text-[12px]">
            {short(item)}
          </NavLink>
        ))}
      </div>
    </>
  )
}

/* What the eeros are running, where a router's own pages printed their
   firmware version, and the way to the page that upgrades it. Nothing until
   it is known: a label with no version after it says nothing. */
function FirmwareLine() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    api.get<Updates>('/api/network/updates')
      .then((u) => setVersion(u?.current_firmware ?? u?.firmware_versions?.join(', ') ?? null))
      .catch(() => {})
  }, [])
  if (!version) return null
  return (
    <Link to="/settings?pane=firmware" data-part="nav-firmware"
          className="flex shrink-0 items-center px-1.5 py-1 text-[11px]
                     text-[var(--color-ink-3)] hover:underline">
      {t('shell.firmware_version', { version })}
    </Link>
  )
}

export function Shell({ networkName, status, notifications, alert,
                        onSegment = null }:
  { networkName?: string; status?: ReactNode; notifications?: ReactNode
    /* A strip across the bottom of the header. Only the WAN outage warning
       uses it today. Inside the header rather than on the page so it stays
       put while the page scrolls, and so it does not shift the content of
       whichever tab happens to be open. */
    alert?: ReactNode
    onSegment?: boolean | null }) {
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  /* Where the theme put the navigation. The rail is the interface's own
     shape; the other two are what a theme may ask for instead, and each is
     drawn here in full rather than left to the stylesheet, because moving
     ten links from a column to a row is not a thing CSS can be trusted to do
     to markup that was written as a column. */
  const theme = useTheme()
  const layout = theme.layout
  const placement = layout.navigation
  const groups = layout.nav_groups
  /* A phone, and a theme that asked for the bar to become one menu there.
     The hook is called either way: behind `&&` it was called only for a
     theme that asks, so the count of hooks in here changed the moment the
     theme arrived and React threw on the render after it. */
  const phone = usePhone()
  const folded = layout.collapse === 'menu' && phone
  /* A row of navigation across the top, of either kind: the bell and the
     network switcher live in it rather than in the header. */
  const bar = placement === 'top' || placement === 'tabs'
  /* A theme that gave the network switcher a page of its own has taken it
     out of the chrome. */
  const switcherElsewhere = useClaimed('network_switcher')
  // Longest match, not exact: a sub-page like /profiles/12 belongs to Profiles,
  // and an exact-only lookup silently titled every one of them "Dashboard".
  const view = loc.pathname.startsWith('/v/') ? loc.pathname.slice(3) : null
  const title = view !== null
    ? (theme.strings[`view.${view}`] ?? view)
    : t(NAV.filter((n) => n.to === loc.pathname
                      || (n.to !== '/' && loc.pathname.startsWith(`${n.to}/`)))
                   .sort((a, b) => b.to.length - a.to.length)[0]?.label
                   ?? 'nav.dashboard')

  // Read from the server rather than baked into the bundle, so the footer
  // reports the build that is actually answering requests.
  const [version, setVersion] = useState('')
  const [about, setAbout] = useState(false)
  /* Stable, so the pages under the provider do not re-render each time the
     shell does. */
  const openAbout = useCallback(() => setAbout(true), [])
  useEffect(() => {
    api.get<{ version?: string }>('/api/health')
      .then((h) => setVersion(h?.version ?? '')).catch(() => {})
  }, [])

  /* Going where the theme picker asked to go once a theme it switched to is
     drawn; see `followAfterThemeChange`. */
  const navigate = useNavigate()
  useEffect(() => {
    const go = (e: Event) => navigate((e as CustomEvent<string>).detail)
    window.addEventListener(FOLLOW_EVENT, go)
    return () => window.removeEventListener(FOLLOW_EVENT, go)
  }, [navigate])

  /* And every other page's reads, in the background, once this one has what
     it needs. Nobody hovers their way around an app they have just opened,
     so waiting to be aimed at meant the first visit to each page was the one
     visit that had nothing to draw. */
  useEffect(() => {
    void import('../lib/prefetch').then((m) => m.warmAll())
  }, [])

  const versionLine = version ? t('shell.version_n', { n: version }) : t('shell.about')

  return (
    /* `min-h-full`, not `h-full`. With the height pinned to the viewport the
       column holding the header was one viewport tall whatever the page
       weighed, and a sticky element cannot stick past the bottom of its own
       containing block — so on a long page the header scrolled away for good
       once you passed the first screenful. Reported from use on a phone,
       where the pages are longest. The rail is `fixed`, so it does not depend
       on this height either way. */
    <div data-part="shell" className="flex min-h-full">
      {placement === 'rail' && (
      <nav
        /* Scrolls when it does not fit. The rail is a fixed column with a
           logo, twelve destinations, the donate button, and the version line
           in it; on a 720-tall window that is 781 pixels of content, and the
           bottom of it was simply unreachable — the About dialog had no way
           in at all on a 13-inch laptop. */
        data-part="nav"
        data-placement="rail"
        className={`fixed inset-y-0 left-0 z-30 flex w-[var(--rail-w)] flex-col
                    gap-0.5 overflow-y-auto overscroll-contain
                    bg-[var(--color-rail)] px-2 py-3 transition-transform
                    ${open ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
        aria-label={t('shell.primary')}
      >
        <div data-part="nav-brand" className="mb-3 px-1">
          <img src="/logo-256.png" alt="" width={256} height={256}
               className="block w-full object-contain" />
          <div className="mt-1 text-center text-[15px] font-semibold text-white">
            {t('shell.eeronaut')}
          </div>
          <hr className="mt-3 border-0 border-t border-white/15" />
        </div>
        <Links placement="rail" onPick={() => setOpen(false)} />
        {/* About, where the Donate button was: the dialog says what this is,
            who made it, the license and the source, and it is the one place
            that links to support the project. Keyboard focus gets the same
            treatment as hover, or the button would look inert to anyone not
            using a mouse. */}
        <button
          type="button"
          onClick={() => setAbout(true)}
          data-part="nav-about-button"
          className="mt-auto flex items-center justify-center gap-1.5 rounded-md
                     bg-[var(--color-rail-2)] px-2.5 py-1.5 text-[12px] font-medium text-white
                     transition-colors hover:bg-[var(--color-rail-hover)]
                     focus-visible:bg-[var(--color-rail-hover)]"
        >
          <Icon name="info" className="size-3.5" />
          {t('shell.about')}
        </button>
        {/* The version line opens About, which is where anybody looks for it.
            It stays a button when the version has not arrived — the dialog is
            worth reaching even then, and it says so itself. */}
        <div className="pt-2 text-center">
          <button
            type="button"
            onClick={() => setAbout(true)}
            data-part="nav-about"
            className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-rail-ink-dim)]
                       hover:text-[var(--color-rail-ink)] focus-visible:text-[var(--color-rail-ink)]"
          >
            {versionLine}
          </button>
        </div>
      </nav>
      )}

      {/* Outside the rail: the rail slides off-screen on a narrow viewport and
          would take the dialog with it. */}
      <AboutDialog open={about} onClose={() => setAbout(false)} version={version} />

      <ScrollToTop />

      <div className={`flex min-w-0 flex-1 flex-col ${placement === 'rail' ? 'md:ml-[var(--rail-w)]' : ''}`}>
        {/* One sticky region holding the top bar, when there is one, and the
            header: two sticky elements would need the second to know the
            first's height. The outage strip is inside it too, so it stays
            put while the page scrolls under it. */}
        <div className="sticky top-0 z-20 flex flex-col">
        {placement === 'top' && (
          <nav
            data-part="nav"
            data-placement="top"
            aria-label={t('shell.primary')}
            className="flex items-center gap-2 border-b border-[var(--color-line)]
                       bg-[var(--color-surface)] px-3 py-1.5"
          >
            {folded ? (
              /* On a phone the mark is the way into the navigation, and the
                 destinations are all in one list under it. The menu's three
                 rules are drawn inside the mark's own button, to its left,
                 rather than as a second button beside it. About is the last
                 entry of that list, because the mark is what used to open
                 it. */
              <NavMenu
                label={t('shell.toggle_navigation')}
                items={allDestinations(groups)}
                drop="down"
                placement="top"
                whole
                onPick={() => undefined}
                trigger={{ part: 'nav-brand', className: BRAND_SHAPE,
                           title: versionLine,
                           /* The three rules, left of the name, in the same
                              button: the name on its own gave no sign that
                              it opens anything. One control still, so the
                              menu is not two buttons side by side. */
                           content: <>
                             <svg viewBox="0 0 24 24" className="size-5 shrink-0"
                                  fill="currentColor" aria-hidden="true"
                                  data-part="nav-menu-glyph">
                               <path d="M3 6h18v2H3Zm0 5h18v2H3Zm0 5h18v2H3Z" />
                             </svg>
                             <Brand />
                           </> }}
                extra={{ label: t('shell.about_eeronaut'),
                         onPick: () => setAbout(true) }}
              />
            ) : (
              <>
                {/* The name opens About, the way the version line in the rail
                    does: with the navigation moved out of the rail there is no
                    version line, and the name is where somebody looks. */}
                <button type="button" onClick={() => setAbout(true)} data-part="nav-brand"
                        title={versionLine} className={BRAND_SHAPE}>
                  <Brand />
                </button>
                <HorizontalNav placement="top" groups={groups} folded={false}
                               onAbout={() => setAbout(true)}
                               onPick={() => undefined} />
              </>
            )}
            {/* The brand, the destinations, and these are the bar's three
                parts, and each is its own element so a theme can lay them
                out — Eerish makes the row a three-column grid so the
                destinations sit centered on the page rather than centered in
                whatever the other two left over. */}
            <div data-part="nav-extras" className="flex shrink-0 items-center gap-1">
              {notifications}
              {!switcherElsewhere && <NetworkSwitcher current={networkName} currentLocal={onSegment} />}
              <button type="button" onClick={() => setAbout(true)} data-part="nav-about"
                      title={versionLine} aria-label={versionLine}
                      className="flex shrink-0 items-center rounded px-1.5 py-1 text-[11px]
                                 text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">
                <Icon name="info" className="size-4 2xl:hidden" />
                <span className="hidden 2xl:inline">{versionLine}</span>
              </button>
            </div>
          </nav>
        )}
        {placement === 'tabs' && (
          <nav
            data-part="nav"
            data-placement="tabs"
            aria-label={t('shell.primary')}
            className="flex flex-col border-b border-[var(--color-line)]
                       bg-[var(--color-surface)]"
          >
            {/* The first row: the name, and what the top bar carries at its
                trailing end. The version line opens About, as it does in the
                rail, and here it sits where a router's firmware version did. */}
            <div data-part="nav-masthead" className="flex items-center gap-2 px-3 py-1.5">
              {phone ? (
                /* Two rows of tabs do not fit a phone. Everything goes behind
                   the name, the way a top bar folds, with About at the foot. */
                <NavMenu
                  label={t('shell.toggle_navigation')}
                  items={tabSections(groups, layout.views, theme.strings).flatMap((sec) => sec.items)}
                  drop="down"
                  placement="top"
                  whole
                  onPick={() => undefined}
                  trigger={{ part: 'nav-brand', className: BRAND_SHAPE,
                             title: versionLine, content: <Brand /> }}
                  extra={{ label: t('shell.about_eeronaut'),
                           onPick: () => setAbout(true) }}
                />
              ) : (
                /* The maker's mark opens About: with the sections all in
                   tabs there is no front page for it to go back to, and the
                   corner where the version line would be says the
                   firmware's instead. */
                <button type="button" onClick={() => setAbout(true)} data-part="nav-brand"
                        className={BRAND_SHAPE} title={versionLine}
                        aria-label={t('shell.about_eeronaut')}>
                  <Brand />
                </button>
              )}
              <div data-part="nav-extras" className="ml-auto flex shrink-0 items-center gap-1">
                {notifications}
                {!switcherElsewhere && <NetworkSwitcher current={networkName} currentLocal={onSegment} />}
                <FirmwareLine />
              </div>
            </div>
            {!phone && <TabStrip groups={groups} views={layout.views} onPick={() => undefined} />}
          </nav>
        )}
        <header data-part="header"
                className="flex flex-col border-b border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="flex items-center gap-3 px-4 py-2.5">
          {placement === 'rail' && (
          <button
            type="button"
            className="md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('shell.toggle_navigation')}
            aria-expanded={open}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden="true">
              <path d="M3 6h18v2H3Zm0 5h18v2H3Zm0 5h18v2H3Z" />
            </svg>
          </button>
          )}
          {/* With the navigation along the bottom nothing else carries the
              name, so the header does. */}
          {placement === 'bottom' && (
            <div className="flex shrink-0 items-center gap-2">
              {/* Home, not About. With the navigation along the bottom this
                  mark is the only thing in the top corner, which is where a
                  reader expects the way back to the front page; About has
                  its own way in from the bar, and from the bar's menu when
                  the bar is folded to one button. */}
              <NavLink to="/" end data-part="nav-brand"
                       title={t('nav.dashboard')} aria-label={t('nav.dashboard')}
                       className="flex shrink-0 items-center gap-2 rounded-md">
                <Brand />
              </NavLink>
              <span className="text-[var(--color-line-strong)]" aria-hidden="true">/</span>
            </div>
          )}
          {/* The title yields first: it repeats the highlighted nav entry, so
              truncating it costs nothing, while the controls beside it do not
              shrink usefully. Without this the row pushed the page a few
              pixels wider than the viewport on a phone. */}
          <h1 data-part="page-title" className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h1>
          <div className="flex min-w-0 shrink items-center gap-2 text-[12px] text-[var(--color-ink-2)] sm:gap-3">
            {/* Whether eero's cloud is answering. Beside the switcher when
                that is here too, because the two are about the same thing;
                ahead of the search when the switcher has moved up into a top
                bar, so it stays at the leading edge of the row rather than
                floating in the middle of it. */}
            {bar && <span className="hidden sm:inline">{status}</span>}
            <CommandSearch />
            {/* Only when the navigation has not taken it. With a bar across
                the top, that row is the app's chrome and the bell belongs in
                it; with a rail, the header is the only row there is. */}
            {!bar && notifications}
            {!bar && <span className="hidden sm:inline">{status}</span>}
            {!bar && !switcherElsewhere && (
              <NetworkSwitcher current={networkName} currentLocal={onSegment} />
            )}
          </div>
          </div>
          {alert}
        </header>
        </div>

        <main data-part="main"
              /* Room under the last card for the floating bar. Both sizes:
                 `md:p-6` outranks a bare `pb-24` at that width, which is how
                 a desktop page ended under the bar while a phone did not. */
              className={`min-w-0 flex-1 p-4 md:p-6 ${placement === 'bottom' ? 'pb-24 md:pb-24' : ''}`}>
          {/* The pages are separate chunks now, so arriving at one can mean
              a fetch. The frame — nav, header, network switcher — stays put
              while that happens, and the hover that prefetches the page's
              data prefetches its code too, so this is usually not seen. */}
          {/* Named for the page being fetched, so a theme's picture and its
              plan for that page are in force while the code is still on its
              way — the alternative is a band of empty ground that fills in
              a moment later, which is a second change to watch on top of
              the content arriving. */}
          <Suspense fallback={
            <Page name={pageName(loc.pathname)}><SkeletonCard rows={6} /></Page>
          }>
            <AboutContext.Provider value={openAbout}>
              <Outlet />
            </AboutContext.Provider>
          </Suspense>
        </main>
        {/* Under the page with tabs, at the trailing end, where those router
            pages put the maker's mark: the one corner of them that was
            neither navigation nor settings. About, which is where the
            maker's mark leads. */}
        {placement === 'tabs' && (
          <footer data-part="nav-foot" className="flex justify-end">
            <button type="button" onClick={() => setAbout(true)}
                    data-part="nav-about-button"
                    className="flex shrink-0 items-center gap-1.5 px-2 py-1
                               text-[12px] font-medium text-[var(--color-ink-2)]">
              <Icon name="info" className="size-3.5" />
              <span>{t('shell.about')}</span>
            </button>
          </footer>
        )}
      </div>

      {placement === 'bottom' && (
        <nav
          data-part="nav"
          data-placement="bottom"
          aria-label={t('shell.primary')}
          /* Floating, centered, and no wider than the screen: on a phone the
             strip inside scrolls sideways and the bar keeps its edges. */
          className="fixed bottom-3 left-1/2 z-30 flex max-w-[calc(100vw-1.5rem)]
                     -translate-x-1/2 items-center gap-1 rounded-full border
                     border-[var(--color-line)] bg-[var(--color-surface)] p-1 shadow-lg"
        >
          <HorizontalNav placement="bottom" groups={groups} folded={folded}
                         onAbout={() => setAbout(true)}
                         onPick={() => undefined} />
          {/* About only, and only where there is room: on a phone the bar
              is the ten destinations and nothing else, and the name in the
              header opens About there. No donate button in this bar; the
              About dialog carries the link. */}
          <span className="mx-0.5 hidden h-6 w-px shrink-0 bg-[var(--color-line)] md:block"
                aria-hidden="true" />
          <button type="button" onClick={() => setAbout(true)} data-part="nav-about"
                  title={versionLine} aria-label={versionLine}
                  className="hidden shrink-0 rounded-full p-2 text-[var(--color-ink-3)]
                             hover:text-[var(--color-ink)] md:flex">
            <Icon name="info" className="size-4" />
          </button>
        </nav>
      )}

      {placement === 'rail' && open && (
        <button
          type="button"
          aria-label={t('shell.close_navigation')}
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  )
}
