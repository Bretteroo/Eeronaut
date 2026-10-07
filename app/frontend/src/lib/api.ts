import { keptReads, keep, dropKept } from './store'

export class ApiError extends Error {
  status: number
  upstream?: number

  constructor(status: number, message: string, upstream?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.upstream = upstream
  }
}

/**
 * A server's `detail` as a sentence.
 *
 * Most of ours are already strings. A validation failure is not: FastAPI
 * answers with a list of `{loc, msg, type}`, and handing that to a notice
 * printed "[object Object]" — reported from use when a pinhole's description
 * was refused. The field name is worth keeping, since it is the whole content
 * of "which box was wrong".
 */
function readDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const said = detail.map((d) => {
      const row = d as { loc?: unknown[]; msg?: string }
      const field = Array.isArray(row.loc)
        ? row.loc.filter((p) => typeof p === 'string' && p !== 'body').join('.')
        : ''
      const msg = row.msg ?? ''
      return field && msg ? `${field}: ${msg}` : (msg || field || '')
    }).filter(Boolean)
    if (said.length) return said.join('; ')
  }
  if (detail && typeof detail === 'object') {
    const msg = (detail as { msg?: unknown }).msg
    if (typeof msg === 'string') return msg
  }
  return undefined
}

/* A write that changes nothing anybody reads.
 *
 * `local/ensure` is the app asking on every start-up whether a local identity
 * is in place, and it is a no-op when one is. It is a POST because enrolling
 * is a POST — and being a POST it emptied the read cache on the way into
 * every single load, which threw away everything the last visit had written
 * down before the first page could be drawn from it. The one time it does
 * enroll, the local panes it affects read for themselves as they mount.
 *
 * `notification-state/claim` is the bell asking, every five minutes, which
 * notifications are new enough to alert on. It records ids only it reads.
 */
const PLUMBING = /^\/api\/(local\/ensure|settings\/notification-state\/claim)\b/

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  /* A write invalidates anything in flight. Sharing a GET is only safe while
     nothing has changed underneath it: a caller that writes and then reads
     expects to see its own write, and joining a request that left before it
     would hand back the state from before. `notifications` caught this — it
     marks a notification read and re-reads, and got the pre-write list. The
     promises are not canceled, only unshared, so a reader already waiting on
     one still gets its answer. */
  const write = Boolean(init?.method && init.method !== 'GET' && !PLUMBING.test(path))
  const unshare = () => {
    inFlight.clear()
    // And what those reads returned: a caller that writes and then reads
    // expects to see its own write.
    forgetReads()
    void import('./prefetch').then((m) => m.forgetPrefetched())
  }
  if (write) unshare()

  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  /* And again once it has landed. A read that set off while the write was
     still on its way saw the state from before it, and a caller reading
     after the write would otherwise join that one. Signing in is where it
     showed: pressing Sign in starts the pages loading, one of them asks
     whether the interface is signed in while the password is still being
     checked, and the check after sign-in joined that question and was told
     no. Whether the page moved on then depended on which answer came back
     last, so it sometimes sat on the password screen with the password
     accepted. */
  if (write) unshare()
  if (res.status === 401) {
    // Either the interface session lapsed or eero rejected ours. Both mean the
    // page cannot recover on its own, so bounce to a re-check rather than
    // showing an interface whose every request quietly fails.
    window.dispatchEvent(new CustomEvent('eeronaut:unauthenticated'))
  }
  if (!res.ok) {
    let detail = res.statusText
    let upstream: number | undefined
    try {
      const body = await res.json()
      detail = readDetail(body.detail) ?? detail
      upstream = body.upstream_status
    } catch {
      /* response had no JSON body; the status text stands */
    }
    throw new ApiError(res.status, detail, upstream)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/**
 * GETs already in flight, so identical ones share a single request.
 *
 * Six components read `/api/eeros` independently — the dashboard, the mesh
 * tree, the health panel, the command search, and two others — and now that
 * the page polls, each tick asked for the same list six times and re-rendered
 * six trees off six identical answers. The backend caches reads for five
 * seconds, so most of that was already being served from memory: the cost was
 * the browser's, not eero's, and it showed up as four tests timing out under
 * a full suite run that had gone from ten minutes to twelve and a half.
 *
 * Only while in flight, and only for GETs. This is not a cache: the moment a
 * response arrives the entry is dropped, so the next call goes to the network
 * and nothing here can serve a stale answer. Writes are never shared —
 * two identical PUTs are two intentions.
 */
const inFlight = new Map<string, Promise<unknown>>()

/* What each GET last returned, and when.
 *
 * Every page began from nothing and waited on the network, so every
 * navigation drew skeletons and then replaced them — an app that is always a
 * beat behind you. A read this recent is served from here instead, so going
 * back to a page you were just on is immediate and shows the thing you were
 * just looking at rather than an outline of it.
 *
 * It is not a substitute for freshness. The entry is refreshed in the
 * background as it is served, so the next visit is current as well as
 * immediate; anything that polls keeps polling; and any write empties the
 * cache outright, because a reader that has just changed something must not
 * be handed the state from before it.
 */
const FRESH_MS = 30_000
const fresh = new Map<string, { at: number; data: unknown; kept?: true }>()

/* And what they returned the last time this app was open.
 *
 * Read from the store as this module loads, before anything has asked for
 * anything, so the first paint of a session has the same answers in hand
 * that the last one ended with. They arrive with the time they were
 * originally fetched, which is what keeps them out of `api.get`: an answer
 * from yesterday is not a fresh read and is never served as one. It is there
 * for `lastRead`, which is how a pane opens on what it said last time while
 * the real answer is on its way. */
for (const [path, was] of keptReads()) fresh.set(path, { ...was, kept: true })

/* Reads made inside this scope go to the network.
 *
 * Polling exists because the value changes, so a poll served from the cache
 * is a poll that does nothing — the live rate meters stopped moving when the
 * cache went in. The scope is synchronous, which is all it needs to be: a
 * loader calls `api.get` as it runs, and the cache is consulted at that
 * moment.
 */
let liveDepth = 0

export function freshReads<T>(fn: () => T): T {
  liveDepth++
  try { return fn() } finally { liveDepth-- }
}

/** Forget everything read so far. */
export function forgetReads() {
  fresh.clear()
  dropKept()
}

/** Put an answer into the read cache as though a GET had returned it.
 *
 *  For the case where one request answers several: a batch endpoint hands
 *  back what a dozen individual reads would have, and seeding them here means
 *  the components that ask for them individually are already served. Nothing
 *  else changes — the entry ages and is cleared by a write like any other.
 */
export function seed(path: string, data: unknown) {
  fresh.set(path, { at: Date.now(), data })
}

/**
 * What a GET last returned, however long ago that was.
 *
 * For a pane's opening state, and nothing else. It is not current and is not
 * offered as current: the caller is a component that reads the same path as
 * it mounts, so what this returns is on the screen for as long as that read
 * takes and is then replaced by the real thing. What it buys is the
 * difference between arriving on a page and reading it, and arriving on a
 * page and watching an outline of it.
 *
 * The answer may be from this session or from the last one — the store hands
 * yesterday's back at startup — so nothing that must be true at the moment it
 * is read should come from here.
 */
export function lastRead<T>(path: string): T | undefined {
  return fresh.get(path)?.data as T | undefined
}

function sharedGet<T>(path: string, { revalidate = true } = {}): Promise<T> {
  const hit = fresh.get(path)
  /* `kept` is the mark of an answer that came back from the store rather than
     from this session's own network. It never stands in for a read, however
     recent its timestamp says it is: reload a page you were just looking at
     and every entry is seconds old, so without this the first read of the new
     document was served from the last document's answers and the page sat on
     them until something polled. Only `lastRead` sees these, and only as the
     thing a pane opens on while its own read is in flight. */
  if (hit && !hit.kept && liveDepth === 0 && Date.now() - hit.at <= FRESH_MS) {
    // Served now, and refreshed behind the answer so the next one is current
    // too. A failure here is not the caller's problem: they already have an
    // answer, and the stale entry stands until something better arrives.
    if (revalidate && !inFlight.has(path)) void sharedGet<T>(path, { revalidate: false })
      .catch(() => {})
    return Promise.resolve(hit.data as T)
  }
  const running = inFlight.get(path)
  if (running) return running as Promise<T>
  const p = request<T>(path)
    .then((d) => {
      const kept = { at: Date.now(), data: d }
      fresh.set(path, kept)
      keep(path, kept)
      return d
    })
    .finally(() => { inFlight.delete(path) })
  inFlight.set(path, p)
  return p
}

export const api = {
  get: <T,>(p: string) => sharedGet<T>(p),
  post: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T,>(p: string, body?: unknown) =>
    request<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T,>(p: string) => request<T>(p, { method: 'DELETE' }),
  /** A raw body — an image, say — with its own content type in place of the
   *  JSON one every other call sends. */
  putBlob: <T,>(p: string, body: Blob, type: string) =>
    request<T>(p, { method: 'PUT', body, headers: { 'Content-Type': type } }),
}

export interface AuthState {
  authenticated: boolean
  awaiting_code: boolean
  login: string
  remembered: boolean
  network_url: string
}

export interface Prefs {
  hide_subscription_gated: boolean
  hide_capability_limited: boolean
  hide_plus_badges: boolean
  /** Light or dark. 'system' follows the operating system; the other two are
   *  explicit and win over it in both directions. */
  appearance: 'system' | 'light' | 'dark'
  /** Which theme draws the interface, by the id of its directory. The server
   *  only accepts an installed one, and reports the default in place of a
   *  stored id whose theme has since been removed. */
  theme: string
  /** True for a 24-hour clock. Every time the interface prints goes through
   *  `useClock`, so this is the only place the choice is made. */
  clock_24h: boolean
  /** Interface language. "auto" follows the browser; anything else is an
   *  explicit override. A tag with no catalog falls back to English rather
   *  than failing, so a hand-edited value cannot break the interface. */
  language: string
}

export type CapabilityReason =
  | 'subscription' | 'hardware' | 'firmware' | 'mobile_app'
  | 'network_mode' | 'role' | 'region' | 'rollout' | 'other'

export interface Capability {
  name: string
  available: boolean
  reason: CapabilityReason | null
  explanation: string
  /** Whether the feature belongs to eero Plus, which is a different question
   *  from whether it is available: on a subscribed network a Plus feature is
   *  available and carries no reason. */
  plus: boolean
  unmet: string[]
  mobile_gate_only: boolean
}
