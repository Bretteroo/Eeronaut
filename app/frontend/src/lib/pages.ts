/* eslint-disable @typescript-eslint/no-explicit-any */
import { lazy, type ComponentType } from 'react'

/* The pages, loaded when somebody goes to one.
 *
 * The whole interface was a single 1,056 KB script: a phone on Wi-Fi fetched
 * and parsed every page in the app — Insights' charts, the Security filtering
 * stack, the Settings forms — before it could draw the dashboard. Split by
 * route, the first load carries the shell and the page being asked for, and
 * the other nine arrive as they are wanted.
 *
 * A split only helps if the pieces arrive before they are needed, which is
 * what `prefetch` is already doing for each page's data. It warms the code
 * from the same hover, so by the time the click lands the chunk is usually
 * in the browser's cache and the switch is as immediate as it was when
 * everything was in one file.
 *
 * The `.then` on each line is because these are named exports and `lazy`
 * wants a module whose default export is the component. Renaming ten exports
 * to suit it would be the tail wagging the dog.
 */
type Load = () => Promise<{ default: ComponentType<any> }>

const LOADERS: Record<string, Load> = {
  '/': () => import('../pages/Dashboard').then((m) => ({ default: m.Dashboard })),
  '/clients': () => import('../pages/Clients').then((m) => ({ default: m.Clients })),
  '/profiles': () => import('../pages/Profiles').then((m) => ({ default: m.Profiles })),
  '/topology': () => import('../pages/Topology').then((m) => ({ default: m.Topology })),
  '/airtime': () => import('../pages/Airtime').then((m) => ({ default: m.Airtime })),
  // Two pages out of one module: the Internet tab and the Network tab were
  // one page until the panes were split between them, and they still share
  // most of what they draw.
  '/internet': () => import('../pages/Network').then((m) => ({ default: m.InternetPage })),
  '/network': () => import('../pages/Network').then((m) => ({ default: m.Network })),
  '/security': () => import('../pages/Security').then((m) => ({ default: m.Security })),
  '/insights': () => import('../pages/Insights').then((m) => ({ default: m.Insights })),
  '/settings': () => import('../pages/Settings').then((m) => ({ default: m.Settings })),
}

/* A page whose code is no longer on the server.
 *
 * Every build names its chunks by their contents and deletes the ones before
 * them, so a tab left open across an upgrade asks for a file that is not
 * there any more: the page never arrives, and the browser says "error
 * loading dynamically imported module". Nothing is wrong with the tab except
 * that it is holding an old index.html, which names chunks that have been
 * replaced — so the answer is to fetch the new one.
 *
 * Once, not in a loop. A reload that lands on a server which still cannot
 * serve the page means something else is wrong, and reloading again would
 * hide it behind a flicker; after the first attempt the error is allowed
 * through to the error boundary. The mark is a timestamp rather than a flag
 * so that a tab open across two upgrades gets one reload for each: a loop
 * happens in seconds, an upgrade does not.
 *
 * Only the lazy loader is wrapped, not `preloadPage`. A page is preloaded
 * from a hover, and a page that reloads itself because the pointer passed
 * over a link is worse than the error it is fixing.
 */
const RELOADED = 'eeronaut-chunk-reload'
const LOOP_MS = 10_000

function reloadedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOADED) ?? 0)
    return Date.now() - at < LOOP_MS
  } catch { return false }   // no sessionStorage: reload, and take the loop
}

/* Whether this document is being left. Going to another address cancels
   whatever the page was still fetching, a chunk included, and the chunk's
   failure then looks exactly like one that is gone from the server. Taken
   for an upgrade, it reloaded the page being left, which canceled the
   navigation that was leaving it: the click to go elsewhere put you back
   where you were. Cleared again if the browser brings the page back from
   its cache. */
let leaving = false
addEventListener('beforeunload', () => { leaving = true })
addEventListener('pagehide', () => { leaving = true })
addEventListener('pageshow', () => { leaving = false })

/* Never settles: the document is on its way out, and resolving with
   anything would draw it with a page that is about to disappear. */
const never = () => new Promise<{ default: ComponentType<any> }>(() => {})

/* Whether the chunk named in a failed import is still on the server. It is
   when the request failed for some other reason, a dropped connection say,
   and then reloading is no answer: the same build would be asked for the
   same file. Unknown counts as gone, which is what reloading is for. */
async function stillThere(err: unknown): Promise<boolean> {
  const url = /https?:\/\/\S+?\.js/.exec(String(err))?.[0]
  if (!url) return false
  const res = await fetch(url, { method: 'HEAD', cache: 'no-store' }).catch(() => null)
  return Boolean(res?.ok)
}

function afterUpgrade(load: Load): Load {
  return () => load().catch(async (first: unknown) => {
    let err = first
    if (leaving) return never()
    /* A failure with the file still there: once more. The browser may hold
       on to a failed import and refuse the second try as well, and then the
       only way to ask again is a fresh document, as for an upgrade. */
    if (await stillThere(err)) {
      try { return await load() } catch (again) { err = again }
    }
    if (leaving) return never()
    if (reloadedRecently()) throw err
    try { sessionStorage.setItem(RELOADED, String(Date.now())) } catch { /* fine */ }
    window.location.reload()
    return never()
  })
}

/* Pages whose code has arrived, by path.
 *
 * `lazy` asks its loader for a promise, and a promise answers a turn later
 * even when the module is already in hand — so a page that had been fetched
 * in the background still suspended on the way in, and the router held the
 * previous page on screen for that turn: a tenth of a second of the old page
 * at the new address, with whatever was meant to open alongside the new one
 * (a client's drawer, picked from the search) waiting on it. Given something
 * that answers at once, `lazy` takes the module in the same render. */
type Mod = { default: ComponentType<any> }
const arrived: Record<string, Mod> = {}
const now = (mod: Mod) => ({ then: (done: (m: Mod) => void) => { done(mod); return now(mod) } })

function remember(path: string, load: Load): Load {
  return () => load().then((mod) => { arrived[path] = mod; return mod })
}

export const Page: Record<string, ComponentType<any>> = Object.fromEntries(
  Object.entries(LOADERS).map(([path, load]) => [path, lazy(() => (
    arrived[path] ? now(arrived[path]) as unknown as Promise<Mod>
                  : afterUpgrade(remember(path, load))()
  ))]),
)

/** Fetch a page's code before somebody asks for it. Safe to call repeatedly:
 *  the browser resolves the same module once. */
export function preloadAllPages() {
  for (const path of Object.keys(LOADERS)) preloadPage(path)
}

export function preloadPage(path: string) {
  const load = LOADERS[path]
  if (load && !arrived[path]) void remember(path, load)().catch(() => {})
}
