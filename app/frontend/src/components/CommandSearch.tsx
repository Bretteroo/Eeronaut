import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { preloadAllPages } from '../lib/pages'
import { searchFeatures, type Feature } from '../lib/features'
import { t } from '../i18n'

/* A search-anything box in the spirit of UniFi's global search: press the key,
   type a name or address, jump to the thing.

   It indexes three kinds of thing. Clients and eeros answer "where is that
   device". Features answer "where do I change that setting", which is the
   question a nine-tab interface actually raises and which this box used to
   have no answer for — typing "DHCP" returned nothing at all. Features come
   first in the list: someone who types a protocol name wants the pane, and
   someone who types a device name will not collide with one. */

interface Device {
  url: string; mac?: string; ip?: string
  nickname?: string | null; hostname?: string | null
  display_name?: string | null; manufacturer?: string | null
  connected?: boolean
}
interface Eero {
  url: string; location?: string; serial?: string; model?: string
}
type Hit =
  | { kind: 'client'; id: string; title: string; sub: string; mac: string
      on: boolean; d: Device }
  | { kind: 'eero'; id: string; title: string; sub: string }
  | { kind: 'feature'; id: string; title: string; sub: string; f: Feature }

export function CommandSearch() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [devices, setDevices] = useState<Device[]>([])
  const [eeros, setEeros] = useState<Eero[]>([])
  const input = useRef<HTMLInputElement>(null)
  const nav = useNavigate()

  /* Escape closes it; nothing opens it but the button. It used to open on
     Cmd/Ctrl-K and on a bare "/", which took those keys from the browser and
     from anything else on the page for a box that is one click away. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* Every page's code, the moment the search opens: whatever is picked will
     go to one of them, and a page whose code is still on its way draws the
     shell's placeholder first. The background warm-up fetches the same files
     once the browser is idle, which can be seconds after a page loads, and
     the jump from a client picked here to its drawer waited on that. */
  useEffect(() => { if (open) preloadAllPages() }, [open])

  // Load the index the first time it is opened, then keep it.
  useEffect(() => {
    if (!open || devices.length || eeros.length) return
    api.get<Device[]>('/api/devices').then((d) => setDevices(d ?? [])).catch(() => {})
    api.get<Eero[]>('/api/eeros').then((e) => setEeros(e ?? [])).catch(() => {})
  }, [open, devices.length, eeros.length])

  useEffect(() => {
    if (open) { setQ(''); setActive(0); setTimeout(() => input.current?.focus(), 0) }
  }, [open])

  const hits: Hit[] = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const clientHits: Hit[] = devices
      .filter((d) => [d.nickname, d.hostname, d.display_name, d.ip, d.mac, d.manufacturer]
        .some((v) => v?.toLowerCase().includes(needle)))
      .slice(0, 8)
      .map((d) => ({
        kind: 'client', id: d.url,
        title: d.nickname || d.hostname || d.display_name || d.mac || 'client',
        sub: [d.ip, d.mac].filter(Boolean).join(' · '),
        mac: d.mac ?? '', on: !!d.connected, d,
      }))
    const eeroHits: Hit[] = eeros
      .filter((e) => [e.location, e.serial, e.model]
        .some((v) => v?.toLowerCase().includes(needle)))
      .slice(0, 4)
      .map((e) => ({
        kind: 'eero', id: e.url,
        title: e.location || e.serial || 'eero',
        sub: e.model || 'eero',
      }))
    const featureHits: Hit[] = searchFeatures(needle).map((f) => ({
      kind: 'feature', id: `f:${f.path}:${f.pane ?? ''}`,
      // Both are catalog keys; the registry is module-level.
      title: t(f.title), sub: t(f.where), f,
    }))
    return [...featureHits, ...clientHits, ...eeroHits]
  }, [q, devices, eeros])

  useEffect(() => { setActive(0) }, [q])

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        /* Wider than the word it holds. A search box the size of its label
           reads as a button that happens to say "Search"; one with room in
           it reads as somewhere to type. It still collapses to the glyph
           alone below the `sm` breakpoint, where the bar has no room to
           give. */
        data-part="search"
        className="flex items-center gap-2 rounded-md border border-[var(--color-line)] px-2 py-1 text-[12px] text-[var(--color-ink-3)] hover:border-[var(--color-line-strong)] sm:w-56 lg:w-72"
        aria-label={t('command_search.search_settings_clients_eeros')}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
          <path d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
        </svg>
        <span className="hidden sm:inline">{t('command_search.search')}</span>
      </button>
    )
  }

  function choose(h: Hit) {
    /* Closed in the same update as the jump, not before it. The router draws
       the new page in the background and keeps the old one up until it is
       ready, which for Clients with a hundred rows and a drawer is a tenth of
       a second; closing the box first showed the old page, bare, for that
       long. Now the box stays until the page it chose replaces it. */
    startTransition(() => { setOpen(false); go(h) })
  }

  function go(h: Hit) {
    /* The client goes with the jump. Clients otherwise has to fetch its list
       before it can tell which row `?focus=` names, and the drawer waits on
       that — which is what made picking a device here feel slower than
       clicking the same device on the page itself. The list this box already
       holds is the same list, so it is handed over and the drawer opens in
       the same paint as the page. */
    if (h.kind === 'client') {
      nav(`/clients?focus=${encodeURIComponent(h.mac)}`, { state: { client: h.d } })
    } else if (h.kind === 'feature') {
      // The pane, not just the page: `?pane=` is what makes the card scroll
      // itself into view and flash on arrival.
      nav(h.f.pane ? `${h.f.path}?pane=${h.f.pane}` : h.f.path)
    } else nav('/topology')
  }

  /* `role="dialog"` is on the wrapper rather than on the panel, because the
     wrapper is what holds the label. It covers the whole viewport, so it is
     not what a theme should paint: `data-part="modal"` below is. */
  return (
    <div data-part="overlay"
         className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
         role="dialog" aria-modal="true" aria-label={t('command_search.search')}>
      <button type="button" aria-label={t('command_search.close_search')}
              data-part="scrim"
              className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
      <div data-part="modal"
           className="relative z-10 w-[min(560px,92vw)] overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
            if (e.key === 'Enter' && hits[active]) choose(hits[active])
          }}
          placeholder={t('command_search.search_settings_clients_eeros_2')}
          aria-label={t('command_search.search_settings_clients_eeros')}
          className="w-full border-b border-[var(--color-line)] bg-transparent px-4 py-3 text-[15px] outline-none"
        />
        <ul className="max-h-[50vh] overflow-y-auto">
          {hits.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(h)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                  i === active ? 'bg-[var(--color-surface-2)]' : ''}`}
              >
                <span className={`inline-block size-2 shrink-0 rounded-full ${
                  h.kind === 'feature' ? 'bg-[var(--color-ink-3)]'
                  : h.kind === 'eero' ? 'bg-[var(--color-accent)]'
                  : h.on ? 'bg-[var(--color-ok)]' : 'bg-[var(--color-line-strong)]'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{h.title}</span>
                  {h.sub && (
                    <span className="block truncate text-[12px] text-[var(--color-ink-3)]">
                      {h.sub}
                    </span>
                  )}
                </span>
                <span className="text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">
                  {h.kind === 'feature' ? 'setting' : h.kind}
                </span>
              </button>
            </li>
          ))}
          {q.trim() && !hits.length && (
            <li className="px-4 py-6 text-center text-[13px] text-[var(--color-ink-3)]">
              {t('command_search.nothing_matches', { q })}
            </li>
          )}
          {!q.trim() && (
            <li className="px-4 py-6 text-center text-[13px] text-[var(--color-ink-3)]">
              {t('command_search.type_setting_client_name_ip')}
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
