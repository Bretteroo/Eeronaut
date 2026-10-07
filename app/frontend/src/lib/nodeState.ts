import { useEffect, useRef, useState } from 'react'
import type { State } from '../components/primitives'

/**
 * eero's color for a node, as this interface's own vocabulary.
 *
 * Defined once. It was written out twice — in Dashboard and in NodesOverview —
 * and the two copies had already drifted apart on `connected`, so one screen
 * could call a node healthy while the other called it broken.
 */
export const nodeState = (e: { status?: string | null }): State =>
  e.status === 'green' || e.status === 'connected' ? 'ok'
  : e.status === 'yellow' ? 'warn'
  : e.status ? 'bad' : 'idle'

/**
 * How often to ask eero how the nodes are doing.
 *
 * Ten seconds normally. Five for the first ten minutes after a node goes
 * off-normal, then back to ten.
 *
 * Ten is eero's own number for this screen:
 * `HomeFragmentService.getNetworkAndEeros` calls
 * `pollCurrentNetworkWithDataSource(session, false, 10L)`, and nothing in
 * eero's app varies its interval by node state at all — a flat rate per
 * screen. So ten is the rate eero's client considers reasonable against
 * eero's own service.
 *
 * Five is faster than eero, on purpose, because a node that is restarting or
 * has just dropped is the one somebody is watching and ten seconds of
 * staleness on a changing state reads as a page that has stopped working.
 *
 * The ten-minute limit is what makes that affordable. Two earlier versions
 * were both wrong. Watching only yellow missed a node that had really
 * vanished — the case worth hearing about soonest. Watching anything
 * off-normal with no time limit meant a node unplugged a month ago was polled
 * every five seconds for as long as a tab stayed open, which is the state a
 * node on one of the test accounts had been in for weeks; it also doubled the
 * browser suite's runtime, from nine minutes to seventeen, on the same set of
 * tests.
 *
 * A restart resolves in about five minutes, measured, so ten covers every
 * real transition twice over and then stops.
 */
export const WATCH_MS = 10_000
export const WATCH_BUSY_MS = 5_000
export const FAST_WINDOW_MS = 10 * 60_000

/**
 * The interval to poll at, given what the nodes are doing and for how long.
 *
 * Needs to remember when things went wrong, so it is a hook rather than the
 * pure function this used to be. The clock is only read while something is
 * off-normal; a settled mesh forgets, so a node that drops again later gets
 * a fresh ten minutes rather than inheriting an expired window.
 */
export function useWatchInterval(nodes: { status?: string | null }[]): number {
  const busy = nodes.some((n) => nodeState(n) !== 'ok')
  const since = useRef<number | null>(null)
  const [fast, setFast] = useState(false)

  /* The clock is read in an effect, not during render.
     This mutated the ref and called `Date.now()` inline, which renders
     impurely: React may discard a render and run it again, and this one left
     a timestamp behind when it did. A clock is an external system, which is
     what effects are for.
     
     The timeout is a bonus rather than a workaround. Deciding inline meant
     the window's expiry was noticed on the next poll, whenever that was;
     firing at the boundary means the rate drops exactly when it should. */
  useEffect(() => {
    if (!busy) {
      since.current = null
      setFast(false)
      return
    }
    since.current ??= Date.now()
    const left = FAST_WINDOW_MS - (Date.now() - since.current)
    if (left <= 0) {
      setFast(false)
      return
    }
    setFast(true)
    const t = window.setTimeout(() => setFast(false), left)
    return () => window.clearTimeout(t)
  }, [busy])

  return fast ? WATCH_BUSY_MS : WATCH_MS
}
