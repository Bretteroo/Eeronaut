import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import { useRevalidate } from '../lib/revalidate'
import { NETWORKS_MS } from '../lib/pollRates'
import { t } from '../i18n'

/* Switch which network the interface is managing, without signing out. The
   account can own several; picking one here selects it server-side and reloads
   so every page re-fetches against the new network. */

interface Net {
  url: string; name?: string; premium_status?: string
  /** What the owner called this network, which is not its Wi-Fi name. Most
   *  networks have none. */
  nickname_label?: string | null
  // true when this machine shares a segment with that network's eeros.
  on_segment?: boolean | null
}

/**
 * How a network is named here: the nickname somebody chose, with the Wi-Fi
 * name after it, and just the Wi-Fi name when there is no nickname.
 *
 * Both come from their own fields rather than being taken apart from a
 * display string, and an absent nickname leaves no empty brackets behind.
 */
function netLabel(n: { name?: string; nickname_label?: string | null }): string {
  const wifi = (n.name ?? '').trim()
  const nick = (n.nickname_label ?? '').trim()
  if (!nick) return wifi
  if (!wifi || nick === wifi) return nick || wifi
  return `${nick} (${wifi})`
}

/* A house for the network you are on, a globe for the ones you are not. The
   distinction matters: only the local one can be reached directly, so the
   local-control features work there and nowhere else. */
function PlaceIcon({ local }: { local: boolean | null | undefined }) {
  const title = local === true ? t('network_switcher.network') : local === false ? t('network_switcher.remote_network') : t('network_switcher.cannot_tell_whether_network_reachable')
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="currentColor"
         role="img" aria-label={title}>
      <title>{title}</title>
      {local === true ? (
        <path d="M12 3 2 12h3v8h6v-5h2v5h6v-8h3L12 3Z" />
      ) : local === false ? (
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm7.9 9h-3.1a15 15 0 0 0-1.2-5.2A8 8 0 0 1 19.9 11ZM12 4c.9 1.3 1.6 3.6 1.8 7h-3.6C10.4 7.6 11.1 5.3 12 4ZM4.1 11a8 8 0 0 1 4.3-5.2A15 15 0 0 0 7.2 11Zm0 2h3.1a15 15 0 0 0 1.2 5.2A8 8 0 0 1 4.1 13ZM12 20c-.9-1.3-1.6-3.6-1.8-7h3.6c-.2 3.4-.9 5.7-1.8 7Zm3.6-1.8a15 15 0 0 0 1.2-5.2h3.1a8 8 0 0 1-4.3 5.2Z" />
      ) : (
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2Zm0-4h-2V7h2Z" />
      )}
    </svg>
  )
}

const CACHE_KEY = 'eeronaut:networks'

const PICKED_KEY = 'eeronaut.switching-to'

export function NetworkSwitcher(
  { current, currentLocal }:
  { current?: string; currentLocal?: boolean | null },
) {
  /* The list was fetched when the menu opened, so every open paid for a round
     trip to eero before showing anything. It is small, changes rarely, and is
     the same on every page, so it is remembered between visits and drawn from
     that immediately while a fresh copy is fetched behind it. */
  const [nets, setNets] = useState<Net[]>(() => {
    try {
      const saved = localStorage.getItem(CACHE_KEY)
      const parsed = saved ? JSON.parse(saved) : null
      return Array.isArray(parsed) ? (parsed as Net[]) : []
    } catch { return [] }
  })
  /* Alphabetical, whatever order eero returns them in. A menu you reach for by
     name is scanned, not read, and eero's order is neither meaningful nor
     stable across accounts. `localeCompare` so accented names file where a
     reader expects rather than after Z.

     By the label, which is what a reader scans — not by `name`, which is the
     Wi-Fi name underneath it. A nickname puts itself first in the label, so
     sorting on the other field filed a renamed network under a word that is
     not the one on screen, and the menu stopped being in any order at all. */
  const shown = [...nets].sort((a, b) =>
    netLabel(a).localeCompare(netLabel(b), undefined, { sensitivity: 'base' }))

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const loc = useLocation()

  const load = useCallback(() => {
    api.get<Net[]>('/api/networks').then((n) => {
      const list = n ?? []
      setNets(list)
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)) } catch { /* full or blocked */ }
    }).catch(() => { /* the cached list stands */ })
  }, [])

  useEffect(() => { void load() }, [load])
  /* The account's networks change when one is added or somebody is invited
     to one, which is rare — thirty seconds, the rate eero's own
     manage-networks screen uses. */
  useRevalidate(load, NETWORKS_MS)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  /* Cleared as soon as the real name arrives, so a stale stash cannot outlive
     one page load — if a switch fails, the next load reads the server's answer
     and this goes away. */
  const [picked, setPicked] = useState<string | null>(() => {
    try { return sessionStorage.getItem(PICKED_KEY) } catch { return null }
  })
  useEffect(() => {
    if (!current) return
    setPicked(null)
    try { sessionStorage.removeItem(PICKED_KEY) } catch { /* private mode */ }
  }, [current])

  /* The network being shown, found once: the button needs its nickname and its
     segment, and those were two separate searches for the same row.

     Right after a switch, `current` is not known yet and `picked` stands in
     for it. It is looked up in the remembered list like `current` would be,
     so the label is the full "Nickname (Wi-Fi name)" from the first frame.
     Printed bare, it showed only the Wi-Fi name until the page's own read
     landed, and the nickname popped in half a second later. */
  const here = nets.find((n) => n.name === (current || picked))

  async function pick(url: string, name?: string) {
    if (name && name === current) { setOpen(false); return }
    setBusy(true)
    /* The name you just picked, kept across the reload.

       Switching does a full page load, so between the click and the new page
       having fetched its own network there is a window with nothing to show —
       and the label fell back to the word "Network", which reads as having
       lost the selection rather than as still loading. Stashed in
       sessionStorage because the component that shows it is a different
       instance on the other side of the reload; sessionStorage rather than
       localStorage so it dies with the tab and cannot outlive the switch. */
    if (name) {
      setPicked(name)
      try { sessionStorage.setItem(PICKED_KEY, name) } catch { /* private mode */ }
    }
    try {
      await api.post('/api/networks/select', { url })
      /* Land on the same page, on the other network: switching networks to
         compare the same screen is the whole point of the menu, and being
         thrown back to the dashboard each time meant navigating there again.

         The query string is dropped. It carries things like ?focus=<mac>,
         which names a client of the network being left.

         A page the new network cannot show needs no special case here: the
         route guards send /matter and /local to the dashboard when this
         machine is not on that network's segment, and an unknown path goes
         there too. A full reload rather than a client-side navigation, because
         every fetch on the page is scoped to the network that just changed. */
      window.location.assign(loc.pathname)
    } catch {
      setBusy(false)
    }
  }

  /* One network is not a choice. The name and the place icon are worth having
     either way — which network this is, and whether it can be reached
     directly — so they stay; the caret and the menu go, since a list offering
     only the thing already on screen is a control that does nothing. The list
     comes back by itself if somebody is invited to a second network. */
  const only = nets.length === 1

  if (only) {
    return (
      <span data-testid="network-switcher" data-single
            data-part="network-switcher"
            className="flex items-center gap-1.5 rounded border border-transparent px-2 py-1 font-medium">
        <PlaceIcon local={here?.on_segment ?? currentLocal} />
        {(here ? netLabel(here) : current || picked) || t('client_detail.network')}
      </span>
    )
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        data-part="network-switcher"
        className="flex items-center gap-1.5 rounded border border-[var(--color-line)] px-2 py-1 font-medium hover:border-[var(--color-line-strong)] disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        /* The tests reach for this by name otherwise, and its name is the
           network's — which ties them to whichever account they run against
           and puts a real network name in the repository. */
        data-testid="network-switcher"
      >
        <PlaceIcon local={here?.on_segment ?? currentLocal} />
        {(here ? netLabel(here) : current || picked) || t('client_detail.network')}
        <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-40 mt-1 max-h-72 w-56 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] py-1 shadow-xl"
        >
          {!nets.length && (
            <li className="px-3 py-2 text-[12px] text-[var(--color-ink-3)]">{t('network_switcher.loading')}</li>
          )}
          {shown.map((n) => {
            const active = n.name === current
            return (
              <li key={n.url} role="option" aria-selected={active}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pick(n.url, n.name)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-[var(--color-surface-2)] ${
                    active ? 'font-semibold' : ''}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <PlaceIcon local={n.on_segment} />
                    <span className="min-w-0 truncate">{netLabel(n) || t('network_switcher.unnamed')}</span>
                  </span>
                  {active && (
                    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-[var(--color-accent)]" fill="currentColor" aria-hidden="true">
                      <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
