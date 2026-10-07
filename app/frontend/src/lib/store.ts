/**
 * What the last answers were, kept between visits.
 *
 * The read cache in `api` lives in memory, so it empties every time the page
 * is reloaded or the tab is closed: the first paint of a session has nothing
 * to draw and every pane starts as a placeholder. This is the same cache
 * written down. On the next load the answers are back before the first
 * request goes out, and a page can open on what it said last time while the
 * real answer is on its way.
 *
 * Deliberately not a substitute for asking. Nothing here is ever served as
 * though it were current: `api.get` still goes to the network for anything
 * older than its own thirty seconds, and what is kept here is only what a
 * pane opens on. A write empties it along with the memory cache, so nobody
 * is ever shown the state from before their own change.
 */

/* One key per read rather than one key holding all of them. A single blob
   would be rewritten in full on every answer — a hundred kilobytes of device
   list rewritten because a toggle somewhere returned — and localStorage
   writes block the main thread. */
const PREFIX = 'eeronaut.read.'

/* Big enough for the lists this app actually reads and small enough that one
   pathological answer cannot fill the origin's whole allowance. */
const MAX_ENTRY = 192 * 1024

/* Older than this and it is not worth showing even for the second before the
   real answer lands. A day covers "I had this open yesterday"; a week would
   start putting last week's network on the screen. */
const KEEP_MS = 24 * 60 * 60 * 1000

/* Not kept, whatever else is.
 *
 * The session's own state carries who is signed in. It is cheap to read and
 * would be the one thing in here that outlives a sign-out, since a sign-out
 * is a write and empties everything else. */
const NEVER = /^\/api\/(app|auth)\b/

export interface Kept { at: number; data: unknown }

/** The store, or nothing at all where the browser refuses one — a private
 *  window with site data off throws on the property itself, not on the call. */
function store(): Storage | null {
  try { return window.localStorage } catch { return null }
}

/**
 * Everything kept that is still worth having, and a clear-out of what is not.
 *
 * Called once as `api` loads, before anything has been asked for.
 */
export function keptReads(): Map<string, Kept> {
  const out = new Map<string, Kept>()
  const s = store()
  if (!s) return out
  const stale: string[] = []
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i)
    if (!key?.startsWith(PREFIX)) continue
    try {
      const kept = JSON.parse(s.getItem(key) ?? '') as Kept
      if (typeof kept?.at !== 'number' || Date.now() - kept.at > KEEP_MS) {
        stale.push(key)
        continue
      }
      out.set(key.slice(PREFIX.length), kept)
    } catch {
      // Written by an older version of this, or truncated by a quota failure
      // part way through. Either way it is not an answer.
      stale.push(key)
    }
  }
  for (const key of stale) s.removeItem(key)
  return out
}

/* Answers waiting to be written down.
 *
 * A read is not worth a blocking write the moment it lands — the page is
 * usually rendering off the back of it. They queue and go out together when
 * the browser has nothing better to do. */
const pending = new Map<string, Kept>()
let flushing = 0

function flush() {
  flushing = 0
  const s = store()
  if (!s) { pending.clear(); return }
  for (const [path, kept] of pending) {
    const body = JSON.stringify(kept)
    if (body.length > MAX_ENTRY) continue
    try {
      s.setItem(PREFIX + path, body)
    } catch {
      /* Out of room. Drop the oldest half of what is kept and try this one
         again; if it still will not go, the store is somebody else's problem
         and this read simply is not kept. */
      if (evictOldest(s)) { try { s.setItem(PREFIX + path, body) } catch { /* no room */ } }
    }
  }
  pending.clear()
}

/** Half of what is kept, oldest first. Returns whether anything went. */
function evictOldest(s: Storage): boolean {
  const ages: { key: string; at: number }[] = []
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i)
    if (!key?.startsWith(PREFIX)) continue
    try { ages.push({ key, at: (JSON.parse(s.getItem(key) ?? '') as Kept).at ?? 0 }) }
    catch { ages.push({ key, at: 0 }) }
  }
  if (!ages.length) return false
  ages.sort((a, b) => a.at - b.at)
  for (const { key } of ages.slice(0, Math.max(1, Math.ceil(ages.length / 2)))) {
    s.removeItem(key)
  }
  return true
}

/** Keep what a GET returned, for the next time this app is opened. */
export function keep(path: string, kept: Kept) {
  if (NEVER.test(path)) return
  pending.set(path, kept)
  if (flushing) return
  const idle = (window as unknown as {
    requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number
  }).requestIdleCallback
  flushing = idle ? idle(flush, { timeout: 2000 }) : window.setTimeout(flush, 400)
}

/* And whatever is still queued when the page goes away.
 *
 * The queue waits for the browser to be idle, which a page being reloaded or
 * closed never becomes: without this, the answers from the last few seconds
 * of a visit — which are the ones the next visit would most want — were the
 * ones that never got written down. `pagehide` rather than `unload`, which
 * browsers no longer fire reliably, and the hidden case as well for a tab
 * that is switched away from and then killed. */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush() })
}

/** Forget the lot. A write empties this the same way it empties the cache in
 *  memory, and signing out and switching networks are both writes. */
export function dropKept() {
  pending.clear()
  const s = store()
  if (!s) return
  const mine: string[] = []
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i)
    if (key?.startsWith(PREFIX)) mine.push(key)
  }
  for (const key of mine) s.removeItem(key)
}
