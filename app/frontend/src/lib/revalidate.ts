import { useEffect, useRef } from 'react'
import { freshReads } from './api'

/**
 * Keep a page in step with changes made somewhere else.
 *
 * eero's state is shared: the same network is being edited from the phone app,
 * and a schedule added there is invisible here until something asks the server
 * again. So refetch when the tab comes back to the front, and on a slow timer
 * while it is being looked at. Nothing polls in a background tab, which would
 * be traffic nobody is reading.
 */
export function useRevalidate(load: () => void, everyMs = 30_000) {
  /* The latest `load`, without it being a dependency of the timer.
     Callers pass a fresh closure every render, so depending on it directly
     would tear down and rebuild the interval on every render and the timer
     would never actually fire.

     Assigned in an effect rather than during render. Writing a ref while
     rendering leaves the write behind even if React discards that render,
     which is the same unsafety that `useWatchInterval` had. */
  const fn = useRef(load)
  useEffect(() => { fn.current = load }, [load])

  useEffect(() => {
    /* A poll is a request for what the value is now, so it is never served
       from the read cache. */
    const refresh = () => { if (!document.hidden) freshReads(() => fn.current()) }
    const timer = setInterval(refresh, everyMs)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [everyMs])
}
