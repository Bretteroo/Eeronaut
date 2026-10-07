import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, lastRead } from '../lib/api'
import { Slot, Page, Card, Notice, SkeletonRows, Stat } from '../components/primitives'
import { BarList, ColumnChart, Donut, Legend, LineChart, type Series,
         PeriodPicker, LONG_PERIODS } from '../components/charts'
import { bytes as gb, shortDay } from '../lib/format'
import { useClock } from '../lib/clock'
import { t, tn, tOr, tx } from '../i18n'


interface SpeedTest { date: string; down_mbps: number | null; up_mbps: number | null }
interface Speed {
  count: number; latest: SpeedTest | null
  best_down: number | null; best_up: number | null
  median_down: number | null; median_up: number | null
  tests: SpeedTest[]
}

interface Plan { down_mbps?: number | null; up_mbps?: number | null }

/** The paid-for level as the charts draw it, or nothing when none is set. */
const paidLine = (mbps: number | null | undefined) =>
  mbps ? { value: mbps, label: t('charts.paid_for_mbps', { n: mbps.toLocaleString() }) } : null

/** The unit under a reading, with the paid-for figure when there is one. */
const paidSub = (mbps: number | null | undefined) =>
  mbps ? t('dashboard.plan_suffix', { mbps: mbps.toLocaleString() }) : t('dashboard.mbps')
interface UsagePoint { t: string; bytes: number }
interface Usage {
  series: Record<string, { total_bytes: number; points: UsagePoint[] }>
}
/** eero's own word for how a client is attached, translated where it is
 *  shown. `tOr` rather than `t`: the value is eero's enum, and a third one it
 *  adds should read as eero's word rather than as a blank cell. */
const connectionWord = (c: string | null | undefined) =>
  c ? tOr(`connection_type.${c}`, c) : undefined

interface UsageDevice {
  name: string; mac: string; connection: string | null
  download: number; upload: number; total: number
}
interface Breakdown {
  download: number; upload: number; device_count: number; devices: UsageDevice[]
}
const mbps = (v: number) => `${Math.round(v)}`
/* With the unit, for a chart axis and its tooltip. One formatter for both, so
   a bar's reading and the scale it is measured against cannot end up quoted in
   different terms. */
const mbpsUnit = (v: number) => `${Math.round(v)} Mbps`
/* A function, not a constant. Every t() inside a module-level literal
   runs once at import — before any language is in force — so the
   English it returns is frozen there for the life of the page. */
/* ------------------------------------------------------------------ periods */


/** The window a card is showing, in words, for its caption. */
const periodWord = (d: number) =>
  d === 1 ? t('insights.last_24_hours')
          : t('insights.last_n_days', { days: d })

/**
 * A card's own 24h/7d/30d control, sized for a card header.
 *
 * One per card rather than one for the page: the questions these cards answer
 * do not share a natural window. Which client downloaded most is a question
 * about a month; when the network is busy is a question about a week; whether
 * something is uploading right now is a question about today. A single control
 * forced all of them to agree.
 */

interface Store<T> {
  data: Record<number, T | undefined>
  /** Windows whose request came back an error. Without this a failed switch
   *  left the card in its pending state for good: marks at zero, labels faded
   *  out, and nothing on the way to bring them back. */
  failed: Record<number, true>
  want: (days: number) => void
}

/**
 * One request per period, shared by every card asking for that period.
 *
 * Six cards with their own selectors would otherwise fetch the same window
 * six times over as soon as two of them agreed on it. Kept in component state
 * rather than a module-level cache because switching networks reloads the
 * page, so there is nothing to invalidate by hand.
 */
function useStore<T>(get: (days: number) => Promise<T>,
                     onError?: (e: unknown) => void): Store<T> {
  const [data, setData] = useState<Record<number, T | undefined>>({})
  const [failed, setFailed] = useState<Record<number, true>>({})
  const asked = useRef(new Set<number>())
  const want = useCallback((days: number) => {
    if (asked.current.has(days)) return
    asked.current.add(days)
    setFailed((prev) => {
      if (!prev[days]) return prev
      const next = { ...prev }
      delete next[days]
      return next
    })
    get(days)
      .then((v) => setData((prev) => ({ ...prev, [days]: v })))
      // Forgotten in `asked` so picking this window again retries, and
      // recorded in `failed` so the card can say so meanwhile.
      .catch((e) => {
        asked.current.delete(days)
        setFailed((prev) => ({ ...prev, [days]: true }))
        onError?.(e)
      })
  }, [get, onError])
  return useMemo(() => ({ data, failed, want }), [data, failed, want])
}

/* How long the marks are held at zero after a period is picked.
   Just past the charts' own shrink, which runs at 260ms, so the marks have
   reached the baseline before the new values are handed over. Set from a
   frame-by-frame trace rather than by feel: at the reveal duration the bars
   bottomed out around ten pixels and started climbing again from there. */
const COLLAPSE_MS = 300

/**
 * A card's period state, its data for that period, and its control.
 *
 * Two things are going on here.
 *
 * Switching period used to leave the card with nothing to render, so it
 * collapsed to a placeholder and everything below it jumped up the page, then
 * jumped back when the data landed. Holding the last window that loaded means
 * the card keeps its exact height throughout.
 *
 * And the shrink-then-grow is driven by the act of picking, not by whether a
 * request is in flight. Every window is cached after its first fetch, and both
 * 24h and 7d are fetched when the page loads — so switching between the two
 * had nothing to wait for and swapped instantly, while a first visit to 30d
 * animated. Same control, two different behaviors, depending on nothing the
 * reader can see. The collapse now runs on every pick and the data waits for
 * it, so the transition is the same every time.
 */
function usePeriod<T>(store: Store<T>, initial = 7) {
  const [days, setDays] = useState<number>(initial)
  const [collapsed, setCollapsed] = useState(false)
  const { want } = store
  useEffect(() => { want(days) }, [want, days])

  useEffect(() => {
    if (!collapsed) return
    const t = setTimeout(() => setCollapsed(false), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [collapsed])

  const pick = (d: number) => {
    if (d === days) return
    setCollapsed(true)
    setDays(d)
  }

  const fresh = store.data[days] ?? null
  const broke = Boolean(store.failed[days])
  /* The old rows stay on screen for the whole collapse, so the marks have
     something to shrink from. Handing over the new data at the moment of the
     click would replace them at zero width with nothing to animate, and the
     new labels would be the ones seen fading out.

     State, not a ref. This read and wrote a ref during render, which is
     unsafe for the same reason `useWatchInterval` was: React may discard a
     render and run it again, and a ref written during the discarded one keeps
     the write. Setting state during render is different — React re-runs the
     render before committing, which is exactly the sanctioned way to derive
     one value from another. `insights-hold.spec.ts` pins the behavior this
     protects, and was written before this changed. */
  const [held, setHeld] = useState<T | null>(null)
  if (fresh && !collapsed && held !== fresh) setHeld(fresh)

  const pending = !broke && (collapsed || !fresh) && held !== null
  const value = broke ? null : (pending ? held : (fresh ?? held))
  /* The first load, before anything has ever arrived. `pending` is for a
     window being changed and needs a previous answer to hold; this is the
     case where there is none, and a pane that says "nothing recorded" here is
     answering a question it has not heard back on. */
  const loading = !broke && !fresh && held === null

  return {
    days,
    value,
    loading,
    /** The marks belong at the baseline: either the collapse is still being
     *  held or the window has not arrived. False on first load, where there is
     *  no shape to preserve and the skeleton is the honest thing to show, and
     *  false on failure, where waiting is over and the marks would otherwise
     *  stay at zero for good. */
    pending,
    failed: broke,
    picker: <PeriodPicker days={days} onPick={pick} /> as ReactNode,
    caption: periodWord(days),
  }
}

/* ------------------------------------------------------- derived from a window */

const topBy = (bd: Breakdown | null, key: 'download' | 'upload') =>
  [...(bd?.devices ?? [])]
    .sort((a, b) => b[key] - a[key])
    .filter((d) => d[key] > 0)
    .slice(0, 10)

/* How concentrated the traffic is. A network where three devices account for
   most of it behaves very differently from one where fifty share it evenly,
   and the difference decides whether "the internet is slow" has a single
   cause worth looking at. */
function concentrationOf(bd: Breakdown | null) {
  if (!bd || !bd.devices.length) return null
  const total = bd.download + bd.upload
  if (total <= 0) return null
  let acc = 0
  let n = 0
  for (const d of bd.devices) {
    if (acc / total >= 0.8) break
    acc += d.total
    n += 1
  }
  /* The bytes as well as the counts: the card draws the share rather than
     only stating it, and a ring needs two magnitudes. */
  return { devices: n, share: Math.round((acc / total) * 100),
           of: bd.device_count, top: acc, rest: Math.max(0, total - acc) }
}

/* Devices that send more than they receive. Usually a backup client, a camera
   uploading footage, or something seeding — and usually a surprise, because
   nothing else in the interface surfaces it. */
const uploadHeavyOf = (bd: Breakdown | null) =>
  (bd?.devices ?? [])
    .filter((d) => d.upload > d.download && d.upload > 0)
    .sort((a, b) => b.upload - a.upload)

/* The window the speed history opens on. Named because the opening state
   has to ask for the same one. */
const DEFAULT_SPEED_DAYS = 30

export function Insights() {
  /* Opens on the last answer; the read below asks for a new one. */
  const [speed, setSpeed] = useState<Speed | null>(
    () => lastRead<Speed>(`/api/insights/speedtests?days=${DEFAULT_SPEED_DAYS}`) ?? null)
  const [err, setErr] = useState('')
  /* The hour axis used to be hard-coded to 24-hour while the rest of the app
     printed 12-hour, which is one of the mismatches this setting exists to
     end. `hourAxis` is the short form — 24 labels share one axis. */
  const { clockHour, hourAxis } = useClock()

  /* A window rather than a count. eero returns at most 100 tests however it
     is asked — measured at limit=1000 and again over a year — so the old
     hundred was never a way to reach further back, and a period is the
     question this card is actually asking. Six months of them is 92 on the
     network this was built against, which is well inside that ceiling. */
  const [speedDays, setSpeedDays] = useState(DEFAULT_SPEED_DAYS)
  const [speedPending, setSpeedPending] = useState(false)
  /* The speed paid for, kept on the Eeronaut host (eero has no field
     for it) and set on the Dashboard. Read here so the history can be
     judged against it, in the same figures the Dashboard shows. */
  const [plan, setPlan] = useState<Plan>({})
  useEffect(() => {
    api.get<Plan>('/api/network/plan').then((p) => setPlan(p ?? {})).catch(() => {})
  }, [])
  useEffect(() => {
    let live = true
    setSpeedPending(true)
    api.get<Speed>(`/api/insights/speedtests?days=${speedDays}`)
      .then((v) => { if (live) setSpeed(v) })
      .catch(() => { if (live) setSpeed(null) })
      .finally(() => { if (live) setSpeedPending(false) })
    return () => { live = false }
  }, [speedDays])
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  /* A 24-hour window asked for daily buckets, which is one bucket — and a line
     chart with a single point has nothing to draw a line between, so the card
     came back empty on a network that had moved plenty. One day is asked for by
     the hour instead, which is the only cadence that says anything about it. */
  const getUsage = useCallback((d: number) =>
    api.get<Usage>(`/api/insights/usage?days=${d}`
      + (d === 1 ? '&cadence=hourly' : '')
      + `&timezone=${encodeURIComponent(tz)}`),
    [tz])
  const getBreakdown = useCallback((d: number) =>
    api.get<Breakdown>(
      `/api/insights/usage/breakdown?days=${d}&top=12&timezone=${encodeURIComponent(tz)}`),
    [tz])
  const getHourly = useCallback((d: number) =>
    api.get<Usage>(
      `/api/insights/usage?days=${d}&cadence=hourly&timezone=${encodeURIComponent(tz)}`),
    [tz])
  const onUsageError = useCallback((e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t('insights.could_not_load_usage')), [])

  const usageStore = useStore(getUsage, onUsageError)
  const bdStore = useStore(getBreakdown)
  const hourlyStore = useStore(getHourly)

  /* Each card keeps its own window. Defaults differ where the question does:
     "is something uploading right now" is a question about today, and the
     traffic chart is most legible over a week. */
  const transferred = usePeriod(usageStore, 7)
  const downloaders = usePeriod(bdStore, 7)
  const uploaders = usePeriod(bdStore, 7)
  const heaviest = usePeriod(bdStore, 7)
  const concentrated = usePeriod(bdStore, 7)
  const senders = usePeriod(bdStore, 1)
  /* A week by default: one day of hourly buckets is a single reading per hour,
     which shows yesterday rather than a habit. The control still offers it,
     and the caption below changes to say which of the two you are looking
     at. */
  const clock = usePeriod(hourlyStore, 7)

  /* `shortDay`, not a locale date. The column charts have always labeled
     their axis "Aug 31" while the line charts printed "8/24/2026", so two
     charts on the same page disagreed about how to write a date. The short
     form is also the one that fits an axis slot. */
  const stamp = (t: string) => transferred.days === 1
    ? clockHour(new Date(t).getHours())
    : shortDay(t)

  /* The axis follows the cadence: hours for a day, dates for a week or a
     month. Labeling hourly buckets with their date printed the same date on
     all twenty-four of them. */

  const usageSeries: Series[] = transferred.value ? [
    { name: t('dashboard.download'), color: 'var(--series-1)',
      points: (transferred.value.series.download?.points ?? [])
        .map((p) => ({ t: stamp(p.t), v: p.bytes })) },
    { name: t('dashboard.upload'), color: 'var(--series-2)',
      points: (transferred.value.series.upload?.points ?? [])
        .map((p) => ({ t: stamp(p.t), v: p.bytes })) },
  ].filter((s) => s.points.length) : []

  /* Traffic by hour of the day, averaged across a week.
     eero returns absolute hour buckets; grouping them by local hour and taking
     the mean says "this is what a typical 9pm looks like here", which is the
     question worth asking — when is the network busy, and therefore when is it
     safe to schedule something heavy. A single day's buckets would answer only
     "what happened yesterday". */
  const byHour = (() => {
    const down = clock.value?.series.download?.points ?? []
    const up = clock.value?.series.upload?.points ?? []
    if (!down.length && !up.length) return null
    const sum = (pts: UsagePoint[]) => {
      const tot = Array(24).fill(0)
      const cnt = Array(24).fill(0)
      for (const p of pts) {
        const h = new Date(p.t).getHours()
        if (Number.isNaN(h)) continue
        tot[h] += p.bytes || 0
        cnt[h] += 1
      }
      return tot.map((t, i) => (cnt[i] ? t / cnt[i] : null))
    }
    return { down: sum(down), up: sum(up) }
  })()

  const busiest = byHour
    ? byHour.down.reduce<{ h: number; v: number }>(
        (best, v, h) => ((v ?? 0) > best.v ? { h, v: v ?? 0 } : best), { h: 0, v: 0 })
    : null

  const concentration = concentrationOf(concentrated.value)
  const uploadHeavy = uploadHeavyOf(senders.value)
  const topDown = topBy(downloaders.value, 'download')
  const topUp = topBy(uploaders.value, 'upload')

  /* Speed tests oldest-first, which is the direction time runs. eero returns
     newest first, and a chart that reads right to left is a chart nobody can
     read. */
  const runs = [...(speed?.tests ?? [])].reverse()

  return (
    <Page name="insights" columns={2}>
      {err && <Notice kind="bad">{err}</Notice>}

      <Slot id="speeds" wide>
      {speed?.latest && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {/* Numbers rather than pre-formatted strings, so the tiles count
              to a new reading instead of snapping to it. */}
          {/* "/ 1,000 Mbps" under the reading, the same words the Dashboard
              puts beside its own, so the two pages say it one way. */}
          <Stat label={t('insights.latest_download')} value={speed.latest.down_mbps ?? 0}
                sub={paidSub(plan.down_mbps)} />
          <Stat label={t('insights.latest_upload')} value={speed.latest.up_mbps ?? 0}
                sub={paidSub(plan.up_mbps)} />
          <Stat label={t('insights.median_download')} value={speed.median_down ?? 0}
                sub={t('insights.best_mbps', { n: mbps(speed.best_down ?? 0) })} />
          <Stat label={t('insights.median_upload')} value={speed.median_up ?? 0}
                sub={t('insights.best_mbps', { n: mbps(speed.best_up ?? 0) })} />
        </div>
      )}
      </Slot>

      <Card icon="chart" title={t('insights.data_transferred')}
        anchor="transferred" className="wide:col-span-2" action={transferred.picker}>
        <Legend series={usageSeries} />
        <LineChart series={usageSeries} format={gb} pending={transferred.pending} loading={transferred.loading}
          label={t('insights.download_upload_over_caption', { caption: transferred.caption })} />
      </Card>

      {/* One bar per test, not a line. A speed test is a discrete measurement
          taken once a day or so; a line between two of them draws a speed the
          connection never had.

          Download and upload get a chart each rather than sharing one. On this
          connection they differ by roughly forty times, and on a shared scale
          the upload bars collapsed to a couple of pixels — present, but
          unreadable, which is the failure a second y-axis is usually invented
          to paper over. Two scales, two charts, no axis lying about either. */}
      <Card icon="speed"
        title={t('insights.speed_test_history')}
        anchor="speedtests" className="wide:col-span-2"
        action={
          <span className="flex items-center gap-3">
            {speed?.count ? (
              <span className="text-[12px] text-[var(--color-ink-3)]">
                {tn('insights.tests_oldest_on_left', speed.count)}
              </span>
            ) : null}
            <PeriodPicker days={speedDays} onPick={setSpeedDays}
                          periods={LONG_PERIODS} />
          </span>}
      >
        {speed === null ? (
          /* Not "no tests": nothing has come back yet. */
          <SkeletonRows rows={3} cols={2} />
        ) : !runs.length ? (
          /* A window can be empty without anything being wrong — eero runs
             these on its own schedule, and a quiet week is a quiet week. The
             table said so and the charts drew nothing at all. */
          <p className="text-[13px] leading-relaxed text-[var(--color-ink-3)]">
            {t('insights.no_speed_tests_recorded_eero')}
          </p>
        ) : (
          <div className="grid gap-4">
            <div>
              <span className="micro-label">{t('insights.download')}</span>
              <ColumnChart
                categories={runs.map((t) => shortDay(t.date))}
                series={[{ name: t('dashboard.download'), color: 'var(--series-1)',
                           values: runs.map((t) => t.down_mbps) }]}
                format={mbpsUnit} axisWidth={62} maxBars={40} height={160}
                line={paidLine(plan.down_mbps)}
                label={t('insights.download_from_each_speed_test')} />
            </div>
            <div>
              <span className="micro-label">{t('insights.upload')}</span>
              <ColumnChart
                categories={runs.map((t) => shortDay(t.date))}
                series={[{ name: t('dashboard.upload'), color: 'var(--series-2)',
                           values: runs.map((t) => t.up_mbps) }]}
                format={mbpsUnit} axisWidth={62} maxBars={40} height={120}
                pending={speedPending}
                line={paidLine(plan.up_mbps)}
                label={t('insights.upload_from_each_speed_test')} />
            </div>
          </div>
        )}
      </Card>

      {/* Down and up in separate cards rather than one chart: the two differ by
          more than an order of magnitude here, and a shared scale would flatten
          upload to nothing. */}
        <Card icon="download" title={t('insights.biggest_downloaders')} anchor="downloaders"
              action={downloaders.picker}>
          <BarList
            rows={topDown.map((d) => ({
              label: d.name, value: d.download,
              note: connectionWord(d.connection),
            }))}
            format={gb} pending={downloaders.pending} loading={downloaders.loading}
            empty={t('insights.no_download_recorded_window_try')} />
        </Card>

        <Card icon="upload" title={t('insights.biggest_uploaders')} anchor="uploaders"
              action={uploaders.picker}>
          <BarList
            rows={topUp.map((d) => ({
              label: d.name, value: d.upload,
              note: connectionWord(d.connection),
            }))}
            format={gb} color="var(--series-2)" pending={uploaders.pending} loading={uploaders.loading}
            empty={t('insights.no_upload_recorded_window_try')} />
        </Card>

      {byHour && (
        <Card icon="clock" anchor="hours" className="wide:col-span-2"
          title={t('insights.hourly_traffic_averages')}
          action={<span className="flex items-center gap-2">
                    {busiest && busiest.v > 0 && (
                      <span className="text-[12px] text-[var(--color-ink-3)]">
                        {t('insights.busiest_around', { time: clockHour(busiest.h) })}
                      </span>
                    )}
                    {clock.picker}
                  </span>}
        >
          <ColumnChart
            categories={Array.from({ length: 24 }, (_, h) => hourAxis(h))}
            series={[
              { name: t('dashboard.download'), color: 'var(--series-1)', values: byHour.down },
              { name: t('dashboard.upload'), color: 'var(--series-2)', values: byHour.up },
            ]}
            format={gb}
            height={170}
            pending={clock.pending} loading={clock.loading}
            label={clock.days === 1
              ? t('insights.traffic_hour_over_last_24')
              : t('insights.average_traffic_by_hour_over', { caption: clock.caption })} />
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {clock.days === 1 ? (
              <>{t('insights.each_hour_last_day')}</>
            ) : (
              <>{t('insights.average_hour_across',
                    { caption: clock.caption })}</>
            )}
          </p>
        </Card>
      )}

      {/* The upload pane is always here. A network where nothing sends more
          than it receives is the ordinary case, and a pane that vanishes on
          the ordinary case reads as a fault in the page — and moves the two
          cards beside it about as clients cross the line either way. */}
          {concentration && (
            <Card icon="concentration" title={t('insights.how_concentrated_traffic')}
                  anchor="concentration" action={concentrated.picker}>
              <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
                {tx(concentration.devices === 1
                      ? 'insights.concentration_one'
                      : 'insights.concentration_many', {
                      devices: <strong>{concentration.devices}</strong>,
                      share: <strong>{concentration.share}%</strong>,
                      caption: concentrated.caption,
                      of: concentration.of,
                    })}
              </p>
              {/* The same fact as a shape. Every other card in this row draws
                  its figures and this one only stated them, which made it
                  read as a caption that had lost its chart. Two parts of one
                  whole, so the ring is full and carries no track. */}
              <div className="mt-3">
                <Donut legend="right" size={92}
                  label={t('insights.of_traffic')}
                  total={concentration.share}
                  caption={t('insights.concentration_caption',
                             { devices: concentration.devices,
                               share: concentration.share })}
                  slices={[
                    { name: tn('insights.busiest_clients', concentration.devices),
                      value: concentration.top, color: 'var(--series-1)' },
                    { name: t('insights.everything_else'),
                      value: concentration.rest, color: 'var(--color-idle)' },
                  ]} />
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                {t('insights.network_where_handful_clients_dominate')}
              </p>
            </Card>
          )}
          <Card icon="upload" title={t('insights.sending_more_than_receiving')} anchor="senders"
                action={senders.picker}>
            <BarList
              rows={uploadHeavy.slice(0, 8).map((d) => ({
                label: d.name, value: d.upload,
                note: t('insights.n_down', { amount: gb(d.download) }),
              }))}
              format={gb} color="var(--series-2)" pending={senders.pending} loading={senders.loading}
              empty={t('insights.nothing_sent_more_than_received')} />
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                {t('insights.uploading_more_than_downloads_usually')}
              </p>
          </Card>

      <Card icon="usage"
        anchor="heaviest" className="wide:col-span-2"
        title={t('insights.heaviest_clients')}
        count={heaviest.value ? heaviest.value.device_count : null}
        action={heaviest.picker}
      >
        <BarList
          rows={(heaviest.value?.devices ?? []).map((d) => ({
            label: d.name, value: d.total,
            note: connectionWord(d.connection),
          }))}
          format={gb} pending={heaviest.pending} loading={heaviest.loading}
          empty={t('insights.no_per_client_usage_window')} />
        {/* Only when there is something to describe. On a window that came
            back empty this read "the twelve busiest clients of the 0 eero
            saw", which is a sentence about nothing. */}
        {Boolean(heaviest.value?.devices.length) && (
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {t('insights.heaviest_explained',
               { caption: heaviest.caption,
                 count: heaviest.value?.device_count ?? 0 })}
          </p>
        )}
      </Card>

    </Page>
  )
}
