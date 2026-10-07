import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, lastRead } from '../lib/api'
import { Card, Notice, SkeletonRows } from './primitives'
import { useRevalidate } from '../lib/revalidate'
import { CLIENTS_MS } from '../lib/pollRates'
import { bandOf } from '../lib/format'
import { clientBars, strengthTone } from '../lib/signal'
import { BANDS, bandKey, bandTone } from './RadioAnalytics'
import { t, tn } from '../i18n'

/* Where the wireless clients are, right now, for every network.

   This is the Airtime page's one card for a network without eero Plus, and
   it is built only from facts eero's own app shows a non-subscriber about
   each device: which eero it is connected to, which band, how strong the
   link is in the app's four words, and whether it is a Wi-Fi 7 client using
   more than one link at once. Adding those up per band is presentation, not
   new information. What the app shows only inside the feature it sells —
   a radio's channel, width, transmit power, and airtime — is not here; that
   is the card below this one, marked.

   The words are eero's (Strong, Good, Okay, Poor); the split is Eeronaut's,
   made on eero's own bar rating for the link rather than on dBm, the same
   rating the app draws as bars. */

interface Device {
  connected?: boolean; wireless?: boolean
  source?: { location?: string | null } | null
  connectivity?: { score_bars?: number | null; signal?: string | null
                   frequency?: number | null } | null
  multi_link_interfaces?: unknown[] | null
}

const STRENGTHS = ['strong', 'good', 'okay', 'poor'] as const
type Strength = typeof STRENGTHS[number]

/** eero's word for a link, from its own four-bar rating of it. */
function strengthOf(d: Device): Strength | null {
  const dbm = Number.parseInt(d.connectivity?.signal ?? '', 10)
  const bars = clientBars({ rating: d.connectivity?.score_bars ?? null,
                            dbm: Number.isFinite(dbm) ? dbm : null })
  if (bars == null) return null
  return bars >= 4 ? 'strong' : bars === 3 ? 'good' : bars === 2 ? 'okay' : 'poor'
}

/** The Wi-Fi channel a client's frequency is: the same fact eero's app
 *  shows as "5180 MHz", in the units a channel plan is written in. The
 *  inverse of the backend's `_channel_mhz`. */
function channelOf(mhz: number): number {
  if (mhz < 3000) return Math.round((mhz - 2407) / 5)
  if (mhz < 5925) return Math.round((mhz - 5000) / 5)
  return Math.round((mhz - 5950) / 5)
}

/** The bars the word stands for, so its color is the signal palette's. */
const STRENGTH_BARS: Record<Strength, number> = { strong: 4, good: 3, okay: 2, poor: 1 }

export function ClientsByBand() {
  /* Opens on the last answer; the read below asks for a new one. */
  const [devices, setDevices] = useState<Device[] | null>(
    () => lastRead<Device[]>('/api/devices') ?? null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    api.get<Device[]>('/api/devices')
      .then((d) => { setDevices(d ?? []); setErr('') })
      .catch((e) => setErr(e.message))
  }, [])
  useEffect(() => { load() }, [load])
  /* Clients come and go; eero's own app re-reads its device list every ten
     seconds, and so does this. */
  useRevalidate(load, CLIENTS_MS)

  const wireless = useMemo(
    () => (devices ?? []).filter((d) => d.connected && d.wireless
                                        && bandOf(d.connectivity?.frequency)),
    [devices])

  /* One column per band that has a client on it, in the order a reader
     thinks of them. */
  const columns = useMemo(() => BANDS.map((b) => {
    const on = wireless.filter((d) => bandKey(bandOf(d.connectivity?.frequency)!) === b.key)
    const spread = Object.fromEntries(STRENGTHS.map((s) => [s, 0])) as Record<Strength, number>
    let unread = 0
    for (const d of on) {
      const s = strengthOf(d)
      if (s) spread[s]++; else unread++
    }
    const byEero = new Map<string, number>()
    for (const d of on) {
      const name = d.source?.location || t('clients_by_band.unknown_eero')
      byEero.set(name, (byEero.get(name) ?? 0) + 1)
    }
    /* The channels clients are connected on, from their own frequencies —
       not the radios' assignments, which the app shows only inside the
       feature it sells. In channel order, with how many are on each. */
    const byChannel = new Map<number, { mhz: number; n: number }>()
    for (const d of on) {
      const mhz = d.connectivity!.frequency!
      const ch = channelOf(mhz)
      byChannel.set(ch, { mhz, n: (byChannel.get(ch)?.n ?? 0) + 1 })
    }
    return { ...b, on, spread, unread,
             eeros: [...byEero.entries()].sort((a, c) => c[1] - a[1]),
             channels: [...byChannel.entries()].sort((a, c) => a[0] - c[0]) }
  }).filter((c) => c.on.length > 0), [wireless])

  const mlo = wireless.filter((d) => Array.isArray(d.multi_link_interfaces)
                                     && d.multi_link_interfaces.length > 0).length

  /* No band filter here, though the analytics card has one: the columns are
     the bands, side by side, and hiding two of them to look at one answered
     nothing that reading across did not. */
  return (
    <Card icon="clients" title={t('clients_by_band.title')} anchor="clients-by-band">
      {err && <Notice kind="bad">{err}</Notice>}
      {devices === null && !err && (
        <SkeletonRows rows={3} cols={3} label={t('clients_by_band.loading')} />
      )}
      {devices !== null && wireless.length === 0 && (
        <p className="text-[13px] text-[var(--color-ink-3)]">{t('clients_by_band.none')}</p>
      )}
      {columns.length > 0 && (
        /* As many across as fit, rather than three only past a window width.
           The breakpoints were the viewport's, so a card two thirds of the
           way across a wide screen still counted as a narrow window and
           stacked its bands two-up with a column of empty space beside
           them. What decides this is how much room the card has. */
        <div className="grid gap-4
                        [grid-template-columns:repeat(auto-fit,minmax(11.5rem,1fr))]">
          {columns.map((c) => (
            <section key={c.key} data-band-col={c.key}
                     className="rounded-md border border-[var(--color-line)] p-3">
              <h3 className="flex items-center gap-2 text-[13px] font-semibold">
                <span aria-hidden="true" className="inline-block size-2 rounded-full"
                      style={{ background: bandTone(c.key) }} />
                {t(c.label)}
              </h3>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">{c.on.length}</span>
                <span className="text-[12px] text-[var(--color-ink-3)]">
                  {tn('clients_by_band.wireless_clients', c.on.length)}
                </span>
              </div>

              {/* How well they are being reached: one bar, four shares, in
                  eero's words. Color from the signal palette, so a Poor
                  share is the same red a poor client's bars are. */}
              <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
                   role="img" aria-label={t('clients_by_band.strength_spread', { band: t(c.label) })}>
                {STRENGTHS.map((s) => c.spread[s] > 0 && (
                  <span key={s} data-strength={s}
                        style={{ width: `${(c.spread[s] / c.on.length) * 100}%`,
                                 background: strengthTone(STRENGTH_BARS[s]) }} />
                ))}
              </div>
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-[var(--color-ink-2)]">
                {STRENGTHS.filter((s) => c.spread[s] > 0).map((s) => (
                  <li key={s} className="inline-flex items-center gap-1 tabular-nums">
                    <span aria-hidden="true" className="inline-block size-1.5 rounded-full"
                          style={{ background: strengthTone(STRENGTH_BARS[s]) }} />
                    {t(`clients_by_band.${s}`)} {c.spread[s]}
                  </li>
                ))}
                {c.unread > 0 && (
                  <li className="tabular-nums text-[var(--color-ink-3)]">
                    {t('clients_by_band.no_reading')} {c.unread}
                  </li>
                )}
              </ul>

              {/* The channels they are on, as chips, each with its count. */}
              <div className="mt-3 border-t border-[var(--color-line)] pt-2">
                <span className="micro-label">{t('clients_by_band.channels')}</span>
                <ul className="mt-1 flex flex-wrap gap-1.5" data-channels>
                  {c.channels.map(([ch, { mhz, n }]) => (
                    <li key={ch} data-channel={ch}
                        title={tn('clients_by_band.channel_title', n, { channel: ch, mhz })}
                        className="rounded bg-[var(--color-surface-2)] px-2 py-0.5 text-[12px] tabular-nums">
                      {ch}
                      <span className="ml-1 text-[var(--color-ink-3)]">×{n}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Which eeros are carrying them, busiest first. */}
              <ul className="mt-3 grid gap-0.5 border-t border-[var(--color-line)] pt-2 text-[13px]">
                {c.eeros.map(([name, n]) => (
                  <li key={name} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">{name}</span>
                    <span className="tabular-nums text-[var(--color-ink-2)]">{n}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {/* The MLO note is the only footnote left, so it appears only when
          there is one to make rather than as the tail of a longer line. */}
      {devices !== null && mlo > 0 && (
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {tn('clients_by_band.mlo_clients', mlo)}
        </p>
      )}
    </Card>
  )
}
