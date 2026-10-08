import { useEffect, useMemo, useRef, useState } from 'react'
import { api, freshReads, lastRead, ApiError } from '../lib/api'
import { DEVICE_TYPE_LABELS, SELECTABLE_DEVICE_TYPES } from '../lib/deviceTypes'
import {
  EditableText, Notice, RowAction, SignalBars, StatusDot, Toggle, useNotice,
  SkeletonRows, type State,
} from './primitives'
import { BarList, LineChart, Legend, PeriodPicker, SHRINK_MS,
         type Series } from './charts'
import { DeviceIcon } from './DeviceIcon'
import { bytes as gb, duration, shortDay } from '../lib/format'
import { useProfiles } from '../lib/profiles'
import { Gate, PlusSash, PlusTick, useCapability, usePlusVisible } from '../lib/capabilities'
import { currentLanguage } from '../i18n'
import { useClock } from '../lib/clock'
import { LIVE_RATE_MS } from '../lib/pollRates'
import { clientBars } from '../lib/signal'
import { t, tOr } from '../i18n'

/* Forty-five seconds of live rate, at eero's own five seconds a sample. The
   same window eero's app shows, and short enough that the line is about right
   now rather than about the last few minutes — which is the next chart down's
   job. */
const LIVE_POINTS = 10

/* Megabits per second, twice, because an axis and a readout want different
   things from the same number.

   The range is wide: a thermostat publishes 0.0002 and a television pulls 80.
   The axis labels gridlines, so it prints what the gridline is worth however
   small — 0.25 has to read as 0.25 and not as 0.3, or the label contradicts
   the line it sits on. The readout is a figure somebody is watching move, so
   it follows eero's own rule (`DeviceUsageUseCase.createMbpsDisplayString`):
   a whole number above ten, one decimal below it, and a floor rather than a
   string of zeros for a client that is barely talking. */
const mbitAxis = (v: number) =>
  v >= 10 ? String(Math.round(v)) : v === 0 ? '0' : String(Number(v.toFixed(2)))

const mbit = (v: number) =>
  v === 0 ? '0' : v < 0.1 ? '<0.1'
  : v < 10 ? v.toFixed(1) : String(Math.round(v))

/* eero's four per-device insight types. The keys are eero's; the labels are
   the same ones the network-wide Security activity card uses, so a reader sees
   one vocabulary in both places. */
const SECURITY_ROWS: [string, string][] = [
  ['inspected', 'insights.requests_inspected'],
  ['blocked', 'insights.threats_blocked'],
  ['adblock', 'insights.ads_blocked'],
  ['filtered', 'insights.content_filtered'],
]

interface Detail {
  mac: string; name: string | null; nickname: string | null; hostname: string | null
  make: string | null; manufacturer: string | null
  model: string | null; model_inferred: boolean; device_type: string | null
  ip: string | null; ipv6: V6In[]; connected: boolean; wireless: boolean
  reserved_ip?: string | null; reservation_url?: string | null; has_reservation?: boolean
  paused: boolean; guest: boolean; ssid: string | null
  allow_on_backup: boolean
  first_active: string | null; last_active: string | null; profile: string | null
  connected_to: { location: string | null; model: string | null; is_gateway: boolean }
  radio: {
    band: string | null; frequency_mhz: number | null; bssid: string | null
    signal_dbm: string | null; snr_db: number | null
    rx_bitrate: string | null; tx_bitrate: string | null
    tx_retry_pct: number | null; score_bars: number | null
  } | null
  throughput: { down_mbps: number | null; up_mbps: number | null }
}
interface Rate {
  down_mbps: number | null; up_mbps: number | null
  reported: boolean; connected: boolean
}
interface Usage {
  series: Record<string, { total_bytes: number; points: { t: string; bytes: number }[] }>
}



const dbm = (s: string | null) => {
  const m = s ? /-?\d+/.exec(s) : null
  return m ? Number(m[0]) : null
}

function Row({ label, hint, children }:
  { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] py-2 last:border-0">
      <span className="micro-label">
        {label}
        {/* A qualifier describes the field, so it belongs with the field name
            rather than trailing the value it qualifies. */}
        {hint && <span className="ml-1.5 inline-flex items-center gap-1.5 normal-case
                                  text-[11px] font-normal text-[var(--color-ink-3)]">
                   {hint}
                 </span>}
      </span>
      <span className="text-right text-[13px] text-[var(--color-ink)]">{children}</span>
    </div>
  )
}

/**
 * Whether this address is pinned or handed out, with the difference on hover.
 *
 * Rendered inside the row's label rather than in its hint slot, which is
 * deliberately lower-case and lighter — the qualifier belongs to the field
 * name and reads as part of it, the same way the IPv6 rows carry their scope.
 */
function LeaseWord({ reserved }: { reserved?: boolean }) {
  return (
    <span
      title={reserved
        ? t('client_detail.reserved_explained')
        : t('client_detail.dynamic_explained')}
      className="cursor-help underline decoration-dotted underline-offset-2"
    >
      {t(reserved ? 'client_detail.reserved_tag' : 'client_detail.dynamic_tag')}
    </span>
  )
}

/** A value eero inferred rather than one the client reported. Marked, because
 *  a fingerprinted guess and a self-reported fact are not the same claim. */
function Guessed({ value, inferred }: { value: string | null; inferred: boolean }) {
  if (!value) return <>—</>
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {value}
      {inferred && (
        <span className="text-[11px] text-[var(--color-ink-3)]" title={t('client_detail.inferred_eero_from_device_s')}>
          {t('client_detail.inferred')}
        </span>
      )}
    </span>
  )
}

/* Either shape. The endpoint sends objects; a browser still running a bundle
   from before that change sends nothing at all, but the reverse — a new bundle
   reading an older payload of bare strings — rendered an empty row for every
   address, because `a.address` on a string is undefined. Accepting both costs
   one function and means a stale tab degrades to unlabelled addresses rather
   than to blank lines. */
type V6In = string | { address?: string; scope?: string }
interface V6 { address: string; scope: string }

function asV6(list: V6In[] | null | undefined): V6[] {
  return (list ?? []).map((a) => {
    if (typeof a === 'string') return { address: a, scope: '' }
    return { address: a?.address ?? '', scope: a?.scope ?? '' }
  }).filter((a) => a.address)
}

/* What each kind of address is for, in the order that answers "which one do I
   actually want" fastest. A client holding several is normal in IPv6 rather
   than a fault, and the reason differs per address — so the row says which
   kind it is and carries the explanation as a tooltip on that word. The
   explanations used to be printed under each row, which made a three-address
   client four times taller than the fields around it. */
/* A function, not a constant. Every t() inside a module-level literal
   runs once at import — before any language is in force — so the
   English it returns is frozen there for the life of the page. */
const V6_GROUPS = (): { scope: string; label: string; hint: string }[] => [
  /* One key per hint, not a translated opening glued to an English tail. An
     earlier pass keyed only the first fragment of each of these and left the
     rest concatenated, so every hint rendered half in one language and half in
     the other — which is worse than leaving it all English, because it looks
     like a data error rather than a missing translation. */
  { scope: 'global', label: t('client_detail.v6_global'),
    hint: t('client_detail.v6_global_hint') },
  { scope: 'ula', label: t('client_detail.v6_ula'),
    hint: t('client_detail.v6_ula_hint') },
  { scope: 'link', label: t('client_detail.v6_link'),
    hint: t('client_detail.v6_link_hint') },
]

/** One row per address, a line high, labeled with the kind it is. */
function Ipv6Rows({ list: raw }: { list: V6In[] }) {
  const list = asV6(raw)
  if (!list.length) return null
  const rank = (scope: string) => {
    const i = V6_GROUPS().findIndex((g) => g.scope === scope)
    return i === -1 ? V6_GROUPS().length : i
  }
  // Grouped by kind, then by address, so the same device lists them the same
  // way twice.
  const sorted = [...list].sort((a, b) =>
    rank(a.scope) - rank(b.scope) || a.address.localeCompare(b.address))
  return (
    <>
      {sorted.map((a) => {
        const g = V6_GROUPS().find((x) => x.scope === a.scope)
        return (
          <Row
            key={a.address}
            label={g ? (
              <>
                IPv6{' · '}
                <span title={g.hint}
                      className="cursor-help underline decoration-dotted
                                 underline-offset-2">
                  {g.label}
                </span>
              </>
            ) : 'IPv6'}
          >
            <span className="font-mono text-[11px]">{a.address}</span>
          </Row>
        )
      })}
    </>
  )
}

function Section({ title, mark, plus, children }: {
  title: string
  /** A control for the section, beside its heading — a period picker, say. */
  mark?: React.ReactNode
  /** The capability that makes this section an eero Plus feature. `Gate` dims
   *  and explains, but it draws no mark of its own, and a gated section
   *  without one looks merely grayed rather than paid-for.
   *
   *  A sash needs a corner, and a drawer section has none — so a marked
   *  section takes a border and a radius it would not otherwise have. */
  plus?: string | string[]
  children: React.ReactNode
}) {
  const marked = usePlusVisible(plus ?? [])
  return (
    <section className={`mb-5 ${marked
      ? 'relative rounded-md border border-[var(--color-line)] p-3 pr-10' : ''}`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {mark}
      </div>
      {children}
      {plus && <PlusSash name={plus} size={28} />}
    </section>
  )
}



/**
 * eero's own name for a type, translated.
 *
 * The parameter used to be called `t`, which shadowed the translate function
 * imported into this file — so the fix had to rename it before it could use
 * it. Two fallbacks, in order: the English label from `DEVICE_TYPE_LABELS` for
 * a type nobody has translated yet, then a title-cased slug for one eero has
 * added since the app was last read against it.
 */
export function prettyType(type: string | null | undefined): string {
  if (!type) return t('client_detail.type_unknown')
  const english = DEVICE_TYPE_LABELS[type]
    ?? type.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return tOr(`device_type.${type}`, english)
}

export function ClientDetail({ mac, onChanged }:
  { mac: string; onChanged?: () => void }) {
  const { when, hourAxis } = useClock()
  // The select and its icon show the chosen type straight away rather than
  // waiting for the detail to be re-fetched; null means "whatever the server
  // last told us". Reset when a different client is opened.
  const [typePick, setTypePick] = useState<string | null>(null)
  const typeSay = useNotice()
  const pauseSay = useNotice()
  const backupSay = useNotice()
  /* Read here rather than left to `Gate`, because the row and the section
     these belong to are now outside their gates — see the two of them below.
     Only `hidden` is wanted: whether the reader has asked for features they
     cannot use to be left out of the layout altogether. */
  const backupGate = useCapability('internet_backup')
  const securityGate = useCapability('advanced_security')
  /* The chart's own window. Deliberately not the Insights page's `usePeriod`,
     which carries a prefetch store and a collapse animation this one has no
     use for — the drawer holds a single series for a single client and can
     simply refetch. `pending` keeps the line from snapping to zero and back
     while the new window loads, which is the behavior every other chart in
     the app has. */
  /* The live rate, polled while this client's drawer is open and only then.
     eero publishes nothing until it is asked to, so the reading is carried
     with whether eero reported at all and the last real one is kept rather
     than being overwritten by a zero that means nothing.

     Kept as a series, not a figure. A bar that grows and shrinks says what
     the client is doing this second and nothing about the second before it,
     so a download that started and stopped while somebody was reading the
     rest of the panel left no trace. Five minutes of it at eero's own five
     seconds a sample. */
  const [rate, setRate] = useState<{ down: number; up: number; at: number } | null>(null)
  const [history, setHistory] =
    useState<{ at: number; down: number; up: number }[]>([])
  const [reported, setReported] = useState(true)
  /* The clock in state rather than read during render: `Date.now()` in a
     render makes the same inputs give a different answer a second later. The
     poll below bumps it, which is also the only moment the age can change in
     a way anybody is watching. */
  const [now, setNow] = useState(() => Date.now())
  const [usageDays, setUsageDays] = useState(7)
  const [usagePending, setUsagePending] = useState(false)
  const [security, setSecurity] =
    useState<Record<string, number | null> | null>(null)
  /* Opens on what this client's drawer said last time. The read below asks
     again straight away; this is only what stands there while it does. */
  const [d, setD] = useState<Detail | null>(
    () => lastRead<Detail>(`/api/devices/${mac}/detail`) ?? null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)

  /* A fresh scale per client: the peak of the last one says nothing about
     this one, and inheriting it leaves the new meters pinned near zero. */
  useEffect(() => {
    setRate(null); setHistory([]); setReported(true); setNow(Date.now())
  }, [mac])

  /* Clearing is a different event from fetching, and they were the same
     effect. Every toggle calls `reload()`, which bumped `tick`, which ran this
     and blanked `d` — and `d` being null renders the whole drawer as a
     skeleton. So flipping a switch flashed the entire panel and rebuilt it.
     Now only a change of *client* clears: the old client's name, addresses and
     usage would be wrong to keep on screen. A refresh of the same client keeps
     what is there and swaps in the new values when they land. */
  useEffect(() => {
    setTypePick(null); typeSay.clear()
    setD(lastRead<Detail>(`/api/devices/${mac}/detail`) ?? null)
    setUsage(null); setSecurity(null); setErr('')
  }, [mac])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true
    api.get<Detail>(`/api/devices/${mac}/detail`)
      .then((got) => { if (live) setD(got) })
      .catch((e) => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [mac, tick])

  /* The meters' own poll, separate from the detail read above: it runs only
     while a drawer is open on this client, and a failure is ignored rather
     than shown — a rate that could not be read this second is not an error
     worth a notice. */
  useEffect(() => {
    if (!mac) return
    let live = true
    const read = () => api.get<Rate>(`/api/devices/${mac}/rate`)
      .then((got) => {
        if (!live) return
        setNow(Date.now())
        setReported(Boolean(got.reported))
        if (!got.reported) return
        const down = got.down_mbps ?? 0
        const up = got.up_mbps ?? 0
        const at = Date.now()
        setRate({ down, up, at })
        setHistory((h) => [...h, { at, down, up }].slice(-LIVE_POINTS))
      })
      .catch(() => {})
    void read()
    const timer = setInterval(() => freshReads(() => void read()), LIVE_RATE_MS)
    return () => { live = false; clearInterval(timer) }
  }, [mac])

  useEffect(() => {
    let live = true
    api.get<{ types: Record<string, number | null> }>(
      `/api/insights/device/${mac}/security?days=7`)
      .then((r) => { if (live) setSecurity(r?.types ?? {}) })
      // An empty object, not null: null means "still loading" to the render
      // below, and a network without eero Plus would skeleton forever.
      .catch(() => { if (live) setSecurity({}) })
    return () => { live = false }
  }, [mac])

  /* The usage on screen, for the effect below to know whether there is a
     chart to shrink. Kept in a ref so the fetch does not re-run on it. */
  const usageShown = useRef<Usage | null>(null)
  useEffect(() => { usageShown.current = usage }, [usage])

  useEffect(() => {
    let live = true
    let hold = 0
    setUsagePending(true)
    /* Switching the window shrinks the line before the new one rises, and
       the chart only does that while `pending` is on screen. A window read in
       the last half minute comes back from the cache at once, `pending` went
       on and off inside one frame, and the new line snapped into place, so
       the same toggle animated one time and not the next. With a chart up,
       the new data waits at least as long as the shrink takes. */
    const started = performance.now()
    const minimum = usageShown.current ? SHRINK_MS : 0
    const land = (apply: () => void) => {
      const wait = Math.max(0, minimum - (performance.now() - started))
      hold = window.setTimeout(() => {
        if (!live) return
        apply()
        setUsagePending(false)
      }, wait)
    }
    /* In this reader's timezone, which is what the axis labels the buckets
       in. Left to its default the backend cut the days at UTC midnight and
       the chart then printed each bucket under the local date of that
       instant — so west of UTC every bar sat one day early, and a day's
       figures were somebody else's. The Insights page always passed it; this
       one did not. */
    const url = `/api/insights/device/${mac}/usage`
      + `?days=${usageDays}&cadence=${usageDays === 1 ? 'hourly' : 'daily'}`
      + `&timezone=${encodeURIComponent(
           Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}`
    api.get<Usage>(url)
      .then((u) => { if (live) land(() => setUsage(u)) })
      .catch(() => { if (live) land(() => setUsage(null)) })
    return () => { live = false; clearTimeout(hold) }
  }, [mac, usageDays])

  /* One line each, side by side, the way eero's app puts them. Labeled by
     age rather than by clock time: the question a live chart answers is "how
     long ago", and a column of wall-clock seconds is arithmetic the reader
     has to do. */
  const liveSeries: Series[] = useMemo(() => {
    const label = (at: number) => {
      const s = Math.round((now - at) / 1000)
      return s < 5 ? t('client_detail.rate_now') : t('client_detail.rate_ago', { s })
    }
    return [
      { name: t('client_detail.receiving'), color: 'var(--series-1)',
        points: history.map((h) => ({ t: label(h.at), v: h.down })) },
      { name: t('client_detail.sending'), color: 'var(--series-2)',
        points: history.map((h) => ({ t: label(h.at), v: h.up })) },
    ]
  }, [history, now])

  /* Both guards after every hook, which is not a style preference.
     The error guard sat between two `useEffect` calls, so a failed fetch
     returned early and the second effect was never called — React sees a
     different number of hooks than the render before and treats that as
     fatal. It only bites on the error path, which is why it survived: the
     drawer works until something goes wrong, and then it breaks in a way
     that has nothing to do with the thing that went wrong.

     oxlint had been reporting it as an error the whole time. I found it by
     grouping the lint output on the word "warning", which skipped every line
     that said "error". */
  if (err) return <Notice kind="bad">{err}</Notice>
  if (!d) return <div className="p-4"><SkeletonRows rows={8} cols={2} /></div>

  /* Associated but with no IPv4 lease: on the network at layer 2, unable to
     reach anything above it. Amber rather than green, and named rather than
     called Online — see the same test on the client list. */
  const noLease = d.connected && !(d.reserved_ip || d.ip)
  const state: State = d.paused || noLease ? 'warn'
    : d.connected ? 'ok' : 'idle'
  // eero reports `unknown_computer` but does not offer it; its picker shows
  // those clients as Desktop, so this one does too.
  const rawType = typePick ?? d.device_type ?? 'generic'
  const currentType = rawType === 'unknown_computer' ? 'desktop_computer' : rawType
  /* An axis label matched to the cadence. The chart asked for hourly points on
     the 24h window but kept labeling them by day, so all 24 read the same
     word — which looks like a broken axis rather than a fine-grained one. */
  const axisLabel = (iso: string) =>
    usageDays === 1 ? hourAxis(new Date(iso).getHours()) : shortDay(iso)

  /* How old the last reading eero actually published is. Only shown while
     there is no current one, which is when its age is the useful fact. */
  const rateNote = !reported && rate
    ? t('client_detail.rate_last_reported',
        { ago: duration(Math.max(1, Math.round((now - rate.at) / 1000))) })
    : undefined


  const usageSeries: Series[] = usage ? [
    { name: t('dashboard.download'), color: 'var(--series-1)',
      points: (usage.series.download?.points ?? [])
        .map((p) => ({ t: axisLabel(p.t), v: p.bytes })) },
    { name: t('dashboard.upload'), color: 'var(--series-2)',
      points: (usage.series.upload?.points ?? [])
        .map((p) => ({ t: axisLabel(p.t), v: p.bytes })) },
  ].filter((s) => s.points.length) : []

  return (
    <div>
      <Section title={t('client_detail.status')}>
        <Row label={t('client_detail.state')}>
          <StatusDot
            state={state}
            icon={d.paused ? 'pause' : undefined}
            label={d.paused ? t('profiles.paused')
              : noLease ? t('client_detail.online_no_ipv4_lease') : d.connected ? t('client_detail.online') : t('client_detail.offline')} />
        </Row>
        {/* A switch, not a button: pausing takes effect the moment it moves,
            which is the rule the rest of the app follows for switches. It sits
            in the status section because pausing is a state of the client, not
            an action filed away with rename and reserve. */}
        <Row label={t('clients.pause_internet_access')}>
          <Toggle
            checked={Boolean(d.paused)}
            srLabel={t('clients.pause_internet_access')}
            /* No success message. The switch moving *is* the confirmation —
               a notice that says "Paused." under a switch that now reads
               paused tells the reader something they can already see, and two
               of them stacked in a drawer this dense is noise. Failures still
               speak, because a switch that silently reverts is a mystery. */
            onChange={(v) => pauseSay.clear() ?? api
              .put(`/api/devices/${mac}/pause`, { paused: v })
              .then(() => { reload(); onChanged?.() })
              .catch((e) => {
                pauseSay.fail(e instanceof ApiError
                  ? e.message : t('clients.did_not_work'))
                throw e          // reverts the switch
              })}
          />
        </Row>
        {pauseSay.node && <div className="mb-2">{pauseSay.node}</div>}
        {/* eero stores this as `secondary_wan_deny_access`; the backend does
            the inversion so the switch reads the way the label does. Gated:
            backup internet is part of eero Plus, and a switch that cannot do
            anything should say why rather than fail on click.

            The gate is around the switch, not around the row. It makes what
            it holds `inert`, and `inert` cannot be undone by a descendant —
            so with the row inside it the Plus mark on the label was inert
            too, and the one mark whose whole job is to be clicked for an
            explanation was the one thing in the drawer that could not be. */}
        {!backupGate.hidden && (
          <>
          <Row label={t('client_detail.allow_on_backup')}
               hint={<PlusTick name="internet_backup" />}>
            <Gate name="internet_backup">
            <Toggle
              /* `!== false`, not `Boolean(...)`. A missing field then reads
                 as allowed — eero's own default — instead of as denied. The
                 first version used Boolean(), so when the backend was serving
                 a build that predated the field, every device showed the
                 switch off while the phone app showed it on. */
              checked={d.allow_on_backup !== false}
              srLabel={t('client_detail.allow_on_backup')}
              onChange={(v) => api
                .put(`/api/devices/${mac}/backup-access`, { allow: v })
                .then(() => { backupSay.clear(); reload() })
                .catch((e) => {
                  backupSay.fail(e instanceof ApiError
                    ? e.message : t('clients.did_not_work'))
                  throw e
                })}
            />
            </Gate>
          </Row>
          {backupSay.node && <div className="mb-2">{backupSay.node}</div>}
          </>
        )}
        <Row label={t('client_detail.connection')}>
          {d.wireless ? `Wi-Fi${d.radio?.band ? ` · ${d.radio.band}` : ''}` : t('device_tree.wired')}
        </Row>
        <Row label={t('client_detail.connected')}>
          {d.connected_to.location ?? '—'}
          {d.connected_to.is_gateway && (
            <span className="ml-1.5 rounded bg-[var(--color-accent-wash)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-accent-ink)]">
              {t('client_detail.gateway')}
            </span>
          )}
        </Row>
        {d.ssid && <Row label={t('client_detail.network')}>{d.ssid}</Row>}
        <Row label={t('client_detail.profile')}>
          <ProfilePicker mac={mac} current={d.profile} onDone={() => {
            reload(); onChanged?.()
          }} />
        </Row>
        {d.guest && <Row label={t('client_detail.guest')}>{t('client_detail.yes')}</Row>}
      </Section>

      {d.radio && (
        <Section title={t('client_detail.radio')}>
          <Row label={t('client_detail.signal')}>
            <span className="inline-flex items-center gap-2">
              {/* The figure is printed beside the bars, so revealing it on
                  hover as well would state it twice. */}
              <SignalBars value={clientBars({ rating: d.radio.score_bars,
                                              dbm: dbm(d.radio.signal_dbm) })}
                          dbm={dbm(d.radio.signal_dbm)} reading="none" />
              <span className="tabular-nums text-[var(--color-ink-2)]">
                {/* eero sends this already carrying its unit ("-58 dBm"). */}
                {d.radio.signal_dbm ?? '—'}
              </span>
            </span>
          </Row>
          {d.radio.snr_db != null && (
            <Row label={t('client_detail.signal_noise')}>{d.radio.snr_db} dB</Row>
          )}
          {d.radio.rx_bitrate && <Row label={t('client_detail.receive_rate')}>{d.radio.rx_bitrate}</Row>}
          {d.radio.tx_bitrate && <Row label={t('client_detail.transmit_rate')}>{d.radio.tx_bitrate}</Row>}
          {d.radio.tx_retry_pct != null && (
            <Row label={t('client_detail.transmit_retries')}>
              <span className={d.radio.tx_retry_pct > 20
                ? 'text-[var(--color-warn-ink,var(--color-warn))]' : undefined}>
                {d.radio.tx_retry_pct}%
              </span>
            </Row>
          )}
          {d.radio.frequency_mhz && <Row label={t('client_detail.frequency')}>{d.radio.frequency_mhz} MHz</Row>}
          {d.radio.bssid && (
            <Row label={t('client_detail.radio_bssid')}>
              <span className="font-mono text-[12px]">{d.radio.bssid}</span>
            </Row>
          )}
          {d.radio.tx_retry_pct != null && d.radio.tx_retry_pct > 20 && (
            <p className="mt-2 text-[12px] leading-snug text-[var(--color-ink-3)]">
              {t('client_detail.high_retry_rate_usually_means')}
            </p>
          )}
        </Section>
      )}

      <Section title={t('client_detail.addresses')}>
        {/* The lease state is a qualifier on the field, so it sits beside the
            field name with its explanation as a tooltip — the same shape the
            IPv6 rows use. It replaces a blue "Reserved" badge on the value
            side, which said the same thing twice as far along the row as it
            could get from the word it qualified. */}
        <Row label={<>IPv4{' · '}<LeaseWord reserved={d.has_reservation} /></>}>
          {/* Release to the left of the address: it acts on the reservation
              the address is holding, and reads as a prefix to it rather than
              as another thing in the row. */}
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            {d.has_reservation && <ReservationNote d={d} onDone={reload} />}
            <IpControl d={d} mac={mac} onDone={reload} />
          </span>
        </Row>
        <Row label={t('client_detail.mac')}><span className="font-mono text-[12px]">{d.mac}</span></Row>
        <Ipv6Rows list={d.ipv6} />
      </Section>

      <Section title={t('client_detail.identity')}>
        <Row label={t('client_detail.name')}>
          <EditableText
            value={d.nickname || d.hostname || d.name || ''}
            placeholder={t('client_detail.unnamed_device')}
            onSave={async (v) => {
              await api.put(`/api/devices/${mac}`, { nickname: v })
              reload(); onChanged?.()
            }}
          />
        </Row>
        <Row label={t('client_detail.hostname')}>{d.hostname ?? '—'}</Row>
        {/* Two different things, as the eero app shows them: the brand, and
            whoever registered the MAC prefix. */}
        <Row label={t('client_detail.make')}>{d.make ?? '—'}</Row>
        <Row label={t('client_detail.manufacturer')}>{d.manufacturer ?? '—'}</Row>
        <Row label={t('client_detail.model')}>
          <Guessed value={d.model} inferred={d.model_inferred} />
        </Row>
        <Row label={t('client_detail.type')}>
          <span className="inline-flex items-center gap-2">
            <TypePicker
              value={currentType}
              onPick={(v) => {
                const previous = currentType
                setTypePick(v)          // icon and label change immediately
                typeSay.clear()
                api.put(`/api/devices/${mac}`, { device_type: v })
                  // The table behind the drawer draws its own icon from its
                  // own copy of the list, so it has to be told. Every other
                  // write in here already did; this one did not, and the row
                  // kept the old icon until the page was reloaded.
                  .then(() => onChanged?.())
                  .catch(() => {        // put it back if eero refused
                    setTypePick(previous)
                    typeSay.fail(t('client_detail.could_not_save_type'))
                  })
              }}
            />
          </span>
          {typeSay.node && (
            <span className="ml-2">{typeSay.node}</span>
          )}
        </Row>
        <Row label={t('client_detail.first_seen')}>{when(d.first_active)}</Row>
        <Row label={t('client_detail.last_active')}>{when(d.last_active)}</Row>

      </Section>

      {/* Above the history, because it is the question somebody opens a client
          for while they are watching it: not what it used yesterday, what it
          is doing now. */}
      {d.connected && (
        <Section title={t('client_detail.now')}>
          {/* Two plots rather than two lines in one. They are the same unit
              but not the same measurement, and a client that pulls eighty
              down while pushing one up flattens the upload against the floor
              of a shared scale. Side by side, each on its own.

              Drawn empty from the first paint rather than after the first
              reading, so the panel does not replace a sentence with a chart
              and then grow that chart out of the floor while somebody is
              already reading it. */}
          <div data-live-rates className="grid gap-3 sm:grid-cols-2">
            {liveSeries.map((sr, i) => (
              <div key={sr.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="micro-label">{sr.name}</span>
                  <span className="tabular-nums text-[13px] font-semibold">
                    {reported && rate ? (<>
                      {mbit(i === 0 ? rate.down : rate.up)}
                      <span className="ml-1 text-[11px] font-normal
                                       text-[var(--color-ink-3)]">
                        {t('charts.mbps')}
                      </span>
                    </>) : (
                      <span className="text-[12px] font-normal
                                       text-[var(--color-ink-3)]">
                        {t('charts.no_reading')}
                      </span>
                    )}
                  </span>
                </div>
                {/* Three gridlines, not five: at this height five of them
                    stack their labels on top of one another. */}
                <LineChart series={[sr]} format={mbitAxis} height={70}
                           yTicks={3} axisWidth={34} emptyPlot
                           label={t('client_detail.live_rate_chart',
                                    { what: sr.name })} />
              </div>
            ))}
          </div>
          {/* Only when something is wrong with the reading. The line that used
              to sit here said where the figures come from, on every client,
              forever — which is a thing to read once and then read past. */}
          {(rateNote || !reported) && (
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              {rateNote ?? t('client_detail.live_rates_waiting')}
            </p>
          )}
        </Section>
      )}

      <Section
        title={t('client_detail.data_transferred_window',
                 { window: t(`period.${usageDays}`) })}
        mark={<PeriodPicker days={usageDays} onPick={setUsageDays} />}>
        {usageSeries.length ? (
          <>
            <Legend series={usageSeries} />
            <LineChart series={usageSeries} format={gb} height={140}
                       pending={usagePending}
                       label={t('client_detail.data_transferred_over_window',
                                { window: t(`period.${usageDays}`) })} />
            <div className="mt-2 flex gap-4 text-[12px] text-[var(--color-ink-3)]">
              <span>{t('client_detail.total_down',
                       { total: gb(usage?.series.download?.total_bytes ?? 0) })}</span>
              <span>{t('client_detail.total_up',
                       { total: gb(usage?.series.upload?.total_bytes ?? 0) })}</span>
            </div>
          </>
        ) : (
          <p className="text-[13px] text-[var(--color-ink-3)]">
            {t('client_detail.no_usage_recorded_client')}
          </p>
        )}
      </Section>

      {/* Last, and gated. Per-device security counts come from eero's
          insights, which is an eero Plus feature — the same four figures the
          Security activity card on Insights shows, scoped to this client.
          A ranked bar list rather than four stat tiles: the interesting thing
          is which category dominates for this device, and four numbers in a
          row make that a subtraction problem. */}
      {/* Same shape as the backup switch above, and for the same reason: the
          sash is in the section's corner, and a section inside the gate is a
          section whose sash cannot be clicked. */}
      {!securityGate.hidden && (
        <Section title={t('client_detail.security_privacy')}
                 plus="advanced_security">
        <Gate name="advanced_security">
          {security === null ? (
            <SkeletonRows rows={4} cols={2} />
          ) : (
            <BarList
              rows={SECURITY_ROWS.map(([key, label]) => ({
                label: t(label), value: security[key] ?? 0,
              })).sort((a, b) => b.value - a.value)}
              format={(v) => v.toLocaleString(currentLanguage())}
              color="var(--color-ok)"
              empty={t('client_detail.no_security_activity')} />
          )}
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {t('client_detail.security_privacy_hint')}
          </p>
        </Gate>
        </Section>
      )}
    </div>
  )
}


/* The IPv4 row: shows whether the address is a fixed DHCP reservation or a
   lease that can change, and lets you set or clear the reservation inline.
   Editing a dynamic address is how you pin it — eero has no separate "make
   static" action; a reservation for the current or a chosen address is the
   mechanism. */
/** The reservation marker and the action that undoes it, shown with the field
 *  name because both describe the address rather than being part of it. */
/** Move a client between profiles.
 *
 *  eero has no way to clear the field — a device always belongs to exactly one
 *  profile — so leaving one means joining "Unassigned", which is a real
 *  profile on every network and is offered here like any other.
 */
function ProfilePicker({ mac, current, onDone }:
  { mac: string; current: string | null; onDone: () => void }) {
  const profiles = useProfiles()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const idOf = (url: string) => url.replace(/\/$/, '').split('/').pop() ?? ''
  const now = profiles.find((p) => p.name === current)

  async function move(url: string) {
    const target = profiles.find((p) => p.url === url)
    if (!target) return
    setBusy(true); setErr('')
    try {
      await api.put(`/api/profiles/${idOf(url)}/devices/${mac}`, {})
      onDone()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('client_detail.could_not_move'))
    } finally { setBusy(false) }
  }

  // Render the control straight away, holding the client's current profile as
  // its only option until the list arrives. Falling back to plain text meant
  // the row visibly changed shape a moment after the panel opened.
  const options = profiles.length
    ? profiles
    : [{ url: '', name: current ?? t('client_detail.unassigned') }]
  // Every name the control can show, each of them once.
  const names = [...new Set([...options.map((p) => p.name),
                             current ?? t('client_detail.unassigned')])]
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-grid">
        {/* The select sizes itself to the widest name rather than to the one
            chosen, so picking a different profile does not move the row.
            Every name is drawn invisibly in the same grid cell and the cell
            is as wide as the widest of them — as the browser actually draws
            them, not as the longest by character count, which is what this
            used to compare. "Unassigned" is ten characters and wider than
            plenty of eleven-character names, so it was the one that did not
            fit.

            Each copy is a part, because a theme that gives selects its own
            padding and type has to give these the same or the select ends up
            smaller than its own text. */}
        {names.map((name) => (
          /* The margin is the slack. The select lies over this cell and
             carries a border of its own, so a cell sized to the text exactly
             leaves the select's own box a border narrower than the name in
             it — and a theme's `padding` rule reaches these copies but not
             their margins, which is why the room is made here. */
          <span key={name} aria-hidden="true" data-part="select-ghost"
                className="invisible col-start-1 row-start-1 me-1 whitespace-pre
                           px-2 py-1 pr-8 text-[13px]">
            {name}
          </span>
        ))}
      <select
        value={now?.url ?? ''}
        disabled={busy || !profiles.length}
        aria-label={t('client_detail.profile')}
        onChange={(e) => void move(e.target.value)}
        className="absolute inset-0 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
      >
        {!now && <option value="">{current ?? t('client_detail.unassigned')}</option>}
        {options.map((p) => (
          <option key={p.url} value={p.url}>{p.name}</option>
        ))}
      </select>
      </span>
      {err && <span className="text-[11px] text-[var(--color-bad-ink,var(--color-bad))]">{err}</span>}
    </span>
  )
}

function ReservationNote({ d, onDone }:
  { d: Detail; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const say = useNotice()

  async function clear() {
    if (!d.reservation_url) return
    const addr = d.reserved_ip || d.ip

    /* Any forward on this address goes with the reservation. eero deletes them
       server-side — verified against the API: a forward created on a reserved
       address was gone from the list the moment the reservation was deleted,
       with no separate call. Naming them is the difference between a warning
       and a surprise, so they are counted first. eero's own app does the same,
       though it only says "any ports" without saying which. */
    let doomed: string[] = []
    try {
      const all = await api.get<{ ip?: string; gateway_port?: string;
                                 description?: string }[]>('/api/forwards')
      doomed = (all ?? [])
        .filter((f) => f.ip === addr)
        .map((f) => `port ${f.gateway_port}${f.description ? ` (${f.description})` : ''}`)
    } catch {
      // If the list cannot be read, warn in general terms rather than not at all.
      doomed = []
    }

    const consequence = doomed.length
      ? `\n\nThis also deletes ${doomed.length === 1 ? 'the port forward' : 'the port forwards'} `
        + `on that address:\n  ${doomed.join('\n  ')}\n\neero removes them with the `
        + `reservation; they are not disabled and cannot be recovered.`
      : `\n\nAny port forward on that address would be deleted along with it.`

    if (!window.confirm(t('client_detail.release_reservation_addr_name_keeps', { addr: addr, name: d.name || 'This device', consequence: consequence }))) return
    setBusy(true); say.clear()
    try {
      await api.del(`/api/reservations?url=${encodeURIComponent(d.reservation_url)}`)
      onDone()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('client_detail.could_not_clear'))
    } finally { setBusy(false) }
  }

  return (
    <>
      <RowAction tone="bad" disabled={busy} onClick={() => void clear()}
                 title={t('client_detail.give_address_back_dhcp_pool')}>
        {t('client_detail.release')}
      </RowAction>
      {say.node}
    </>
  )
}

function IpControl(
  { d, mac, onDone }:
  { d: Detail; mac: string; onDone: () => void },
) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(d.reserved_ip || d.ip || '')
  const [busy, setBusy] = useState(false)
  const say = useNotice()

  async function save() {
    const ip = value.trim()
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { say.fail(t('client_detail.enter_valid_ipv4_address')); return }
    setBusy(true); say.clear()
    try {
      await api.post('/api/reservations', { mac, ip, description: d.name || '' })
      setEditing(false); onDone()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('client_detail.could_not_set'))
    } finally { setBusy(false) }
  }


  if (editing) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={t('client_detail.reserved_ipv4_address')}
          className="w-32 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[12px]"
        />
        <button type="button" disabled={busy} onClick={() => void save()}
          className="rounded border border-[var(--color-accent)] px-2 py-1 text-[12px] font-medium text-[var(--color-accent)] disabled:opacity-50">
          {busy ? t('client_detail.saving') : d.has_reservation ? t('client_detail.update') : t('client_detail.reserve')}
        </button>
        <button type="button" disabled={busy} onClick={() => { setEditing(false); setValue(d.reserved_ip || d.ip || '') }}
          className="text-[12px] text-[var(--color-ink-3)]">
            {t('client_detail.cancel')}
          </button>
        {say.node && <span className="w-full">{say.node}</span>}
      </span>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={d.has_reservation ? t('client_detail.reserved_click_change') : (d.reserved_ip || d.ip)
            ? t('client_detail.click_reserve_address') : t('client_detail.client_holds_no_ipv4_lease')}
        className={`text-[12px] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)] ${
          (d.reserved_ip || d.ip) ? 'font-mono' : 'text-[var(--color-ink-3)]'}`}
      >
        {d.reserved_ip || d.ip || 'no lease'}
      </button>
      {say.node && <span className="w-full">{say.node}</span>}
    </span>
  )
}

/**
 * The device-type chooser, showing each type's glyph beside its name.
 *
 * A native select cannot hold anything but text, and the glyph is the fastest
 * way to find the right entry in a list of forty-four, so this is a listbox
 * built by hand. Keyboard behavior is the part a select gives you for free
 * and the part most often dropped when one is replaced, so it is written out:
 * arrows move, Enter and Space choose, Escape closes, Home and End jump.
 */
function TypePicker({ value, onPick }:
  { value: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)

  // A type eero set but does not offer still needs an entry, or the control
  // would sit blank on that client.
  const options = SELECTABLE_DEVICE_TYPES.includes(value)
    ? SELECTABLE_DEVICE_TYPES
    : [value, ...SELECTABLE_DEVICE_TYPES]

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, options.indexOf(value)))
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps

  function choose(v: string) { setOpen(false); if (v !== value) onPick(v) }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault(); setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, options.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1) }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(options[active]) }
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('client_detail.device_type')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className="flex items-center gap-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]"
      >
        <DeviceIcon type={value} size={18} />
        <span>{prettyType(value)}</span>
        <svg viewBox="0 0 24 24" className="size-3 text-[var(--color-ink-3)]"
             fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t('client_detail.device_type')}
          tabIndex={-1}
          className="absolute right-0 z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {options.map((opt, i) => (
            <li key={opt}>
              <button
                type="button"
                role="option"
                aria-selected={opt === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(opt)}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] ${
                  i === active ? 'bg-[var(--color-surface-2)]' : ''} ${
                  opt === value ? 'font-semibold' : ''}`}
              >
                <DeviceIcon type={opt} size={18} />
                <span className="min-w-0 flex-1 truncate">{prettyType(opt)}</span>
                {opt === value && (
                  <svg viewBox="0 0 24 24" className="size-3.5 text-[var(--color-accent)]"
                       fill="currentColor" aria-hidden="true">
                    <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
