import { api, seed } from './api'
import { preloadPage } from './pages'

/* What each page asks for first.
 *
 * Fetched when somebody shows they are going there — a pointer over the nav
 * entry, or the keyboard landing on it — so the data is usually in hand
 * before the click is. The answers land in the read cache, which is what the
 * page itself reads from, so arriving is immediate rather than a skeleton
 * and a wait.
 *
 * Only the reads a page cannot draw without. Fetching everything a page
 * eventually wants would trade one page's wait for every other page's
 * traffic, and these are somebody's eeros, not a CDN.
 */
const FIRST: Record<string, string[]> = {
  '/': ['/api/eeros', '/api/devices', '/api/network/health',
        '/api/insights/speedtests?limit=10', '/api/network/plan'],
  '/clients': ['/api/devices', '/api/profiles'],
  '/profiles': ['/api/profiles', '/api/devices'],
  '/topology': ['/api/eeros', '/api/eeros/radios', '/api/local/status',
                '/api/local/topology/detail'],
  '/airtime': ['/api/devices', '/api/network/capabilities'],
  /* The two heaviest first paints in the app, and the two that were worst to
     arrive on: Internet draws the connection, DNS, backup, Thread, and power
     panes and Security the whole filtering stack, each pane its own read.
     Listed in full rather than sampled — a page is only as quick as its
     slowest pane, so leaving three out leaves the skeleton in. */
  '/internet': ['/api/network', '/api/network/lan', '/api/local/network-status',
                '/api/insights/speedtests?limit=1', '/api/network/thread',
                '/api/network/thread/credentials', '/api/network/backup-internet',
                '/api/network/power-saving', '/api/network/power-saving/schedules',
                '/api/network/wifi', '/api/network/wifi/wpa3', '/api/network/guest',
                '/api/network/legacy-mode', '/api/reservations', '/api/ddns',
                '/api/ddns/providers', '/api/network/plan', '/api/local/backup-aps'],
  '/network': ['/api/network/lan', '/api/network/wifi', '/api/network/guest',
               '/api/reservations', '/api/network/wifi/wpa3',
               '/api/network/power-saving', '/api/network/legacy-mode',
               '/api/network/thread', '/api/ddns'],
  '/security': ['/api/security/overview', '/api/security/domains', '/api/forwards',
                '/api/pinholes', '/api/reservations', '/api/network/lan',
                '/api/devices', '/api/eeros'],
  '/insights': ['/api/insights/speedtests?days=30'],
  '/settings': ['/api/settings/prefs', '/api/members',
                '/api/notifications/preferences'],
}

/** Already asked for, so hovering along a nav does not ask again. */
const asked = new Set<string>()

export function prefetch(path: string) {
  if (asked.has(path)) return
  asked.add(path)
  for (const url of FIRST[path] ?? []) {
    // Failures are not this function's business: the page will ask again and
    // report it properly. This is only about being early.
    void api.get(url).catch(() => {})
  }
}

/** After a write, what was prefetched is as stale as anything else. */
export function forgetPrefetched() {
  asked.clear()
  /* And the app goes and gets it again, so the next page somebody opens is
     one it can draw. A write empties the read cache outright, which without
     this would put a placeholder back on every page in the app until each
     was visited again — the one thing all of this exists to avoid. */
  warmAll()
}

/* Everything, in the background, so no page in the app is ever the first
 * time it is opened.
 *
 * `prefetch` above is the same idea aimed by a pointer: it fetches a page's
 * reads when somebody looks like they are going there. This does not wait to
 * be aimed. The whole app is about sixty reads, nearly all of them served
 * from the backend's own five-second cache by the time the second page asks,
 * and they go out a few at a time while the browser is idle rather than in
 * one burst that would compete with the page somebody is actually reading.
 *
 * Paced rather than parallel for eero's sake, not the browser's: these are
 * somebody's own eeros answering through their own cloud account, and forty
 * simultaneous requests is not a reasonable thing to do to them.
 */
const AT_ONCE = 4
const REWARM_MS = 20_000
let warmedAt = 0

/** When the browser has nothing better to do, or soon, whichever is first. */
function whenIdle(fn: () => void, timeout = 2000) {
  const idle = (window as unknown as {
    requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number
  }).requestIdleCallback
  if (idle) idle(fn, { timeout })
  else window.setTimeout(fn, Math.min(timeout, 600))
}

export function warmAll() {
  if (Date.now() - warmedAt < REWARM_MS) return
  warmedAt = Date.now()

  /* The order pages are usually wanted in, and the page somebody is on is
     not in it: they are already looking at it, and whatever it needed was
     asked for before this ran. */
  const pages = Object.keys(FIRST)
    .filter((path) => path !== window.location.pathname)
  const queue: string[] = []
  for (const path of pages) {
    asked.add(path)
    for (const url of FIRST[path]) if (!queue.includes(url)) queue.push(url)
  }

  const next = () => {
    const batch = queue.splice(0, AT_ONCE)
    if (!batch.length) return
    void Promise.all(batch.map((url) => api.get(url).catch(() => {})))
      .then(() => whenIdle(next, 800))
  }
  whenIdle(() => {
    // The code as well as the data: a page with its answers in hand still
    // shows the shell's own placeholder while its chunk is fetched.
    for (const path of pages) preloadPage(path)
    next()
  }, 2500)
}

/* Every eero's drawer, before anybody opens one.
 *
 * A detail is four reads of eero's cloud and took 2.4 seconds to come back,
 * so opening an eero drew the panel and then filled everything below the LED
 * rows in a second and a half later. Asking node by node would have been five
 * of those; `/api/eeros/details` is one request that does the three
 * network-wide reads once and hands back the lot, and each answer is filed
 * under the address the drawer itself asks for.
 *
 * Nightlights are per-node and only Beacons have one, so on a network without
 * a Beacon this costs nothing at all.
 */
export function warmNodeDetails(nightlightIds: string[] = []) {
  const all = '/api/eeros/details'
  if (asked.has(all)) return
  asked.add(all)
  void api.get<{ id?: string | null }[]>(all)
    .then((list) => {
      for (const d of list ?? []) {
        if (d?.id) seed(`/api/eeros/${d.id}/detail`, d)
      }
    })
    .catch(() => { asked.delete(all) })
  for (const id of nightlightIds) {
    void api.get(`/api/eeros/${id}/nightlight`).catch(() => {})
  }
}

/* Every eero Signal's drawer, the same way.

   A Signal's panel reads `/api/accessories/{dsn}` and opens on whatever that
   read last answered. Nothing had asked it before the drawer did, so every
   other row in the eero table opened full and a Signal's opened empty and
   filled in once its own read came back. One read per Signal, and most
   networks have none or one. */
export function warmAccessoryDetails(dsns: string[]) {
  for (const dsn of dsns) {
    const path = `/api/accessories/${encodeURIComponent(dsn)}`
    if (asked.has(path)) continue
    asked.add(path)
    void api.get(path).catch(() => { asked.delete(path) })
  }
}
