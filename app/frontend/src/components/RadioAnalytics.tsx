import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, lastRead } from '../lib/api'
import { Card, Notice, SkeletonRows } from './primitives'
import { PlusWhy, usePlusGate } from '../lib/capabilities'
import { LineChart, type Series } from './charts'
import { useClock } from '../lib/clock'
import { t } from '../i18n'

/* The eero app's Wi-Fi radio analytics: per-eero, per-band airtime over time,
   the channel each radio is on, and the moments eero moved a radio to a new
   channel on its own. This is cloud data (channel_utilization), so unlike the
   live topology it does not need local control — it works from anywhere. */

interface Radio {
  node: string; band: string; channel: number; frequency_mhz: number
  minutes_busy?: number
  busy_now: number | null; busy_avg: number | null; busy_peak: number | null
  series: { t: number; busy: number | null; noise: number | null }[]
  channel_changes: { t: number; from: number; to: number }[]
}
interface Util { hours: number; covers_hours: number; radios: Radio[] }

/* eero keeps about two days of this and no more — measured across five
   windows, and its own app refuses to page back past 48 hours — so a week or
   a month would draw the same two days under a label saying otherwise. These
   are the windows there is data for, and the granularity the backend derives
   from each matches what eero's app asks for: a minute for the short ones,
   five for the day. */
const SPANS = [{ h: 1, key: '1h' }, { h: 6, key: '6h' },
               { h: 24, key: '24h' }]

/* The three radios a reader thinks in, which is not the same as the list of
   bands eero reports. An eero Pro splits 5 GHz into a low and a high radio and
   names them separately, so "5 GHz" here means all of them. */
export const BANDS = [{ key: '2.4', label: 'band.2_4' },
               { key: '5', label: 'band.5' },
               { key: '6', label: 'band.6' }]
export const bandKey = (b: string) =>
  b.startsWith('2') ? '2.4' : b.startsWith('6') ? '6' : '5'

/** The index of the sample nearest a moment, for placing a mark on a chart
 *  whose x axis is the sample list rather than time. */
const nearestIndex = (times: number[], at: number) => {
  let best = 0
  for (let i = 1; i < times.length; i++) {
    if (Math.abs(times[i] - at) < Math.abs(times[best] - at)) best = i
  }
  return best
}

/* Tone by band, matching the survey chips: 2.4 amber, 6 accent, 5 blue. */
export const bandTone = (b: string) =>
  b.startsWith('2') ? 'var(--series-2)' : b.startsWith('6') ? 'var(--color-accent)' : 'var(--series-1)'

/* The band's name in its tag: the tone's text color, since a series color is
   picked for a 2px line and several are under 4.5:1 as 11px words. */
const bandInk = (b: string) =>
  b.startsWith('2') ? 'var(--series-2-ink, var(--series-2))'
    : b.startsWith('6') ? 'var(--color-accent-ink)'
    : 'var(--series-1-ink, var(--series-1))'

/** The shared look of the two filter groups in this card's header. */
export function Pick({ on, onClick, children }:
  { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`cursor-pointer rounded border px-2 py-0.5 text-[12px] font-medium ${
        on ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
           : 'border-[var(--color-line-strong)] text-[var(--color-ink-3)]'}`}>
      {children}
    </button>
  )
}

/* The window this card opens on, named for the same reason. */
const DEFAULT_HOURS = 24

export function RadioAnalytics() {
  const { when } = useClock()
  const cap = usePlusGate('channel_utilization')
  const needsPlus = cap.needsPlus
  const [hours, setHours] = useState(DEFAULT_HOURS)
  /* Null for every band, which is where this starts: the question "is one of
     my bands congested" is asked by comparing them, and only then by looking
     at one. Pressing the band you are already on clears it. */
  const [band, setBand] = useState<string | null>(null)
  /* Opens on the last answer; the read below asks for a new one. */
  const [util, setUtil] = useState<Util | null>(
    () => lastRead<Util>(`/api/network/channel-utilization?hours=${DEFAULT_HOURS}`) ?? null)
  const [err, setErr] = useState('')

  const radios = useMemo(
    () => (util?.radios ?? []).filter((r) => !band || bandKey(r.band) === band),
    [util, band])
  /* Which of the three to offer. A network with no 6 GHz radio should not be
     shown a button that empties the card. */
  const present = useMemo(() => new Set<string>(
    (util?.radios ?? []).map((r) => bandKey(r.band))), [util])

  // Point mapping is the expensive part, so it happens once per dataset.
  const charts = useMemo(() => radios.map((r) => ({
    r,
    series: [{
      name: `${r.node} · ${r.band}`,
      color: bandTone(r.band),
      /* eero's timestamps are already milliseconds. This multiplied them by a
         thousand, which put every point about fifty thousand years out — and
         because the label carries no year, a day of airtime came back reading
         "Nov 3", "May 21", "Dec 8" across a 24-hour chart. */
      points: r.series.map((p) => ({ t: when(p.t), v: p.busy ?? 0 })),
    }] as Series[],
  /* `when` is in here on purpose: it formats every point and it changes with
     the 12/24-hour preference, so leaving it out kept the old labels on the
     chart after somebody switched. */
  })), [radios, when])

  useEffect(() => {
    setUtil(null); setErr('')
    // Not until the capability map is in. An empty map reads as "nothing is
    // gated", so without this the first render fetched a whole card of radio
    // history on a network with no subscription to it.
    if (!cap.ready || needsPlus) return
    api.get<Util>(`/api/network/channel-utilization?hours=${hours}`)
      .then(setUtil).catch((e) => setErr(e.message))
  }, [hours, needsPlus, cap.ready])

  /* eero keeps about two days of this and no more, whatever window is asked
     for: a month and a week come back as the same two days. Saying so is the
     only honest way to offer the longer spans — the alternative is a chart
     captioned "30 days" showing two. */
  const short = util && util.covers_hours > 0
    && util.covers_hours < util.hours * 0.9

  if (cap.hidden) return null
  return (
    <Card icon="radio"
      anchor="airtime"
      title={t('radio_analytics.radio_analytics')}
      plus="channel_utilization"
      action={
        /* Nothing to filter or to choose a window of when there is no history
           to show. The mark is in the card's corner either way. */
        needsPlus ? null :
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1" role="group"
               aria-label={t('radio_analytics.band')}>
            {BANDS.filter((b) => present.has(b.key)).map((b) => (
              <Pick key={b.key} on={band === b.key}
                    onClick={() => setBand(band === b.key ? null : b.key)}>
                {t(b.label)}
              </Pick>
            ))}
          </div>
          <div className="flex gap-1" role="group"
               aria-label={t('radio_analytics.time_span')}>
            {SPANS.map((s) => (
              <Pick key={s.h} on={hours === s.h}
                onClick={() => {
                  if (s.h === hours) return
                  // Drop the charts in the same update as the selection.
                  // Without this the click re-renders every existing chart
                  // before the browser can paint the new highlight, and the
                  // button looks dead for as long as that takes.
                  setUtil(null)
                  setHours(s.h)
                }}>
                {t(`duration_short.${s.key}`)}
              </Pick>
            ))}
          </div>
        </div>
      }
    >
      {/* Dimmed like every other locked pane. There are no charts to gray out
          here — nothing is fetched without the entitlement — so it is the
          explanation that carries the treatment, or the pane reads as simply
          empty rather than as unavailable. */}
      {/* One sentence or the other, never both. Describing how to read charts
          that are not there is an instruction nobody on this network can
          follow; what a locked card owes the reader is why it is locked. */}
      {needsPlus ? (
        <PlusWhy>{t('radio_analytics.per_radio_airtime_history_part')}</PlusWhy>
      ) : (
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--color-ink-3)]">
          {t('radio_analytics.airtime_used_each_radio_over')}
        </p>
      )}
      {err && <Notice kind="bad">{err}</Notice>}
      {short && (
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {t('radio_analytics.eero_keeps_this_long',
             { hours: Math.round(util!.covers_hours) })}
        </p>
      )}
      {!util && !err && !needsPlus && (
        <SkeletonRows rows={4} cols={2} label={t('radio_analytics.loading_radio_analytics')} />
      )}
      {util && !util.radios.length && (
        <p className="text-[13px] text-[var(--color-ink-3)]">
          {t('radio_analytics.no_radio_history_reported_period')}
        </p>
      )}
      {util && util.radios.length > 0 && !radios.length && (
        <p className="text-[13px] text-[var(--color-ink-3)]">
          {t('radio_analytics.no_radios_on_this_band')}
        </p>
      )}
      <div className="grid gap-4">
        {charts.map(({ r, series }, i) => {
          return (
            <div key={`${r.node}-${r.band}-${i}`}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium">
                  {r.node}
                  <span className="ml-2 rounded px-1.5 text-[11px] font-semibold"
                        style={{ color: bandInk(r.band), border: `1px solid ${bandTone(r.band)}` }}>
                    {r.band}
                  </span>
                  <span className="ml-2 text-[12px] text-[var(--color-ink-3)]">
                    {t('radio.channel_n', { channel: r.channel })}
                  </span>
                </span>
                <span className="text-[12px] tabular-nums text-[var(--color-ink-2)]">
                  {t('radio.now_avg_peak', {
                    now: r.busy_now ?? '—', avg: r.busy_avg ?? '—',
                    peak: r.busy_peak ?? '—',
                  })}
                </span>
              </div>
              {/* Each change in words, where "1 change" used to stand on its
                  own with nothing on the chart and nothing to say what it was.
                  eero's own analytics carries these as acs_events with a from
                  and a to channel, so this is what its subscribers see too. */}
              {r.channel_changes.length > 0 && (
                <ul className="mb-1 text-[12px] text-[var(--color-warn-ink,var(--color-warn))]">
                  {r.channel_changes.map((ch) => (
                    <li key={ch.t} data-channel-change>
                      {t('radio_analytics.channel_change_line',
                         { from: ch.from, to: ch.to, when: when(ch.t) })}
                    </li>
                  ))}
                </ul>
              )}
              <LineChart
                series={series}
                height={120}
                format={(v) => `${Math.round(v)}%`}
                /* The change drawn where it happened: the nearest sample to
                   its moment, since the x axis is the sample list. */
                marks={r.channel_changes.map((ch) => ({
                  at: nearestIndex(r.series.map((pt) => pt.t), ch.t),
                  label: t('radio_analytics.channel_change_mark', { from: ch.from, to: ch.to }),
                }))}
                label={t('radio_analytics.airtime_node_band_over_last', { node: r.node, band: r.band, hours: util?.hours })}
              />
            </div>
          )
        })}
      </div>
    </Card>
  )
}
