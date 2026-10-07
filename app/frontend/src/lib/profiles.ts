import { useEffect, useState } from 'react'
import { api } from './api'

/* The profile list, fetched once and shared.
 *
 * Every client sidebar needs it to offer the profile dropdown. Fetching it per
 * sidebar meant the control rendered with only the current profile in it and
 * then grew when the real names arrived, which is a visible jolt on a panel
 * the user just opened. One cached copy, warmed before any sidebar exists,
 * removes the wait; reserving the width of the longest name removes the jump
 * on the very first fetch, when there is nothing cached to be quick about.
 */

export interface ProfileRef { url: string; name: string }

let cache: ProfileRef[] | null = null
let inFlight: Promise<ProfileRef[]> | null = null
const listeners = new Set<(p: ProfileRef[]) => void>()

function load(): Promise<ProfileRef[]> {
  if (cache) return Promise.resolve(cache)
  // Several sidebars opening at once share one request rather than racing.
  inFlight ??= api.get<ProfileRef[]>('/api/profiles')
    .then((p) => {
      cache = p ?? []
      listeners.forEach((fn) => fn(cache!))
      return cache
    })
    .catch(() => [])
    .finally(() => { inFlight = null })
  return inFlight
}

/** Warm the cache before anything needs it. Safe to call repeatedly. */
export function prefetchProfiles(): void { void load() }

/** Drop the cache after something changes a profile. */
export function invalidateProfiles(): void {
  cache = null
  void load()
}

export function useProfiles(): ProfileRef[] {
  const [profiles, setProfiles] = useState<ProfileRef[]>(cache ?? [])
  useEffect(() => {
    let alive = true
    void load().then((p) => { if (alive) setProfiles(p) })
    const fn = (p: ProfileRef[]) => { if (alive) setProfiles(p) }
    listeners.add(fn)
    return () => { alive = false; listeners.delete(fn) }
  }, [])
  return profiles
}
