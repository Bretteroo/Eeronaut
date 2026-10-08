import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api, lastRead } from '../lib/api'
import { nodeStatusLabel, signalIssue } from '../lib/nodeStatusLabel'
import { FirmwareNotice } from '../components/FirmwareUpdate'
import { NodesOverview } from '../components/NodesOverview'
import { ConnectionInfo } from '../components/ConnectionInfo'
import { Slot, Page, Card, Notice, SkeletonRows, Stat } from '../components/primitives'
import { clientBars } from '../lib/signal'
import { PlusWhy, usePlusGate } from '../lib/capabilities'
import { type NodeSummary } from '../components/NodePanel'
import { EeroIcon, SignalIcon } from '../components/DeviceIcon'
import { bytes, bytesTile, shortDay } from '../lib/format'
import { useClock } from '../lib/clock'
import { useWatchInterval } from '../lib/nodeState'
import { hasKnownUplink, uplinkName } from '../lib/mesh'
import { accessoryStateHelp, nodeStateHelp } from '../lib/nodeHelp'
import { unreachable } from '../lib/nodes'
import { ColumnChart, Donut, PeriodPicker, Sparkbars } from '../components/charts'
import { useRevalidate } from '../lib/revalidate'
import { t } from '../i18n'

type Eero = NodeSummary
interface Device {
  url: string; connected?: boolean; wireless?: boolean
  connectivity?: { score_bars?: number | null; signal?: string | null } | null
}

/* Which of eero's bands a connected wireless client's signal falls in, from
   the same two inputs the Clients table draws its bars from: eero's own 1-5
   score first, the dBm reading if there is no score. On the four-bar scale
   the table draws, three or four is good, two is okay, less is poor — the
   words eero's app uses for its 4, 3 and 2. Null for a wired client, for one
   that is offline (eero freezes the last reading rather than clearing it) and
   for one that has never reported a signal, none of which belong in a picture
   of how well the Wi-Fi is reaching people. */
function signalBand(d: Device): 'good' | 'okay' | 'poor' | null {
  if (!d.wireless || !d.connected) return null
  const m = /-?\d+/.exec(d.connectivity?.signal ?? '')
  const dbm = m && Number(m[0]) < 0 ? Number(m[0]) : null
  const bars = clientBars({ rating: d.connectivity?.score_bars, dbm })
  if (bars === null) return null
  return bars >= 3 ? 'good' : bars === 2 ? 'okay' : 'poor'
}

/** "0.3 of 130 GB" — the cellular plan's usage this cycle. eero reports these
 *  in kilobytes. */

/** Placeholder while a figure is still being fetched. Deliberately not a
 *  zero or an "Offline": an unknown value must not read as a known bad one. */
/* eero's own words for a state — "connected", "standing by", "not responding"
   — arrive as data. They are stable enough to key on, with eero's English as
   the fallback for a state it invents later. */

interface SpeedTest { date?: string | null; down_mbps?: number | null; up_mbps?: number | null }
interface Speeds { latest?: SpeedTest | null; count?: number; tests?: SpeedTest[] }

/** How many tests the strip beside each reading shows. */
const RECENT_TESTS = 10

/** What the provider sells, in Mbps; null where nobody has said. eero has no
 *  field for it, so it lives on the Eeronaut host, per network. */
interface Plan { down_mbps?: number | null; up_mbps?: number | null }

/* A reading counts as short of the plan below this share of it. Providers
   sell "up to", and a test that lands a few percent under the figure on the
   bill is a normal test, not a shortfall; alerting on every one of those
   would teach the reader to ignore the alert. A tenth under is where a
   reading stops being noise about the plan and starts being news about it. */
const SHORTFALL_RATIO = 0.9

/** True when a reading falls short of the plan it is measured against. */
const short = (actual: number | null | undefined, plan: number | null | undefined) =>
  actual != null && plan != null && actual < plan * SHORTFALL_RATIO

/* The last ten tests, oldest first, padded on the left with empty slots on a
   network that has not run ten yet, so the strip keeps its width and the
   newest test is always the rightmost bar. Tests rather than days: eero runs
   its own about every other day and the user adds more whenever they press
   Run test, so a calendar left most days empty and squeezed a busy afternoon
   into one bar. */
function recentTests(tests: SpeedTest[] | undefined): (SpeedTest | null)[] {
  const newestFirst = (tests ?? []).slice(0, RECENT_TESTS)
  const pad = Array.from({ length: RECENT_TESTS - newestFirst.length }, () => null)
  return [...pad, ...newestFirst.reverse()]
}

/* The last speed test, and a way to take another.

   A test saturates the WAN for its duration, so the button says so before it
   is pressed rather than after. eero runs the test on the gateway and files
   the result asynchronously, which is why finishing means polling for a newer
   date rather than reading a response. */
/* "Network at a glance": the readings somebody wants in one look, in one
   card. It was the speed test alone, and the numbers that belong beside it —
   how many clients are on, how many are known, whether the eeros are well —
   were four separate tiles in a strip above. A strip of tiles is a list of
   figures; this is a picture of the network. */
function GlanceCard({ eeros, devices }: { eeros: Eero[]; devices: Device[] }) {
  const online = devices.filter((d) => d.connected).length
  const wireless = devices.filter((d) => d.connected && d.wireless).length
  const bands = devices.map(signalBand)
  const signal = {
    good: bands.filter((b) => b === 'good').length,
    okay: bands.filter((b) => b === 'okay').length,
    poor: bands.filter((b) => b === 'poor').length,
  }
  const { when } = useClock()
  /* Opens on the last answer; the read below asks for a new one. */
  const [speeds, setSpeeds] = useState<Speeds | null>(
    () => lastRead<Speeds>(`/api/insights/speedtests?limit=${RECENT_TESTS}`) ?? null)
  const [plan, setPlan] = useState<Plan>({})
  const load = () => api.get<Speeds>(`/api/insights/speedtests?limit=${RECENT_TESTS}`)
    .then(setSpeeds)
    .catch(() => {})
  useEffect(() => { void load() }, [])
  useEffect(() => {
    api.get<Plan>('/api/network/plan').then((p) => setPlan(p ?? {})).catch(() => {})
  }, [])



  const latest = speeds?.latest ?? null
  const recent = recentTests(speeds?.tests)

  /* One decision for both tiles: alongside only if every tile has room for
     its reading, the gap, and its strip on one line. Measured, not guessed:
     the readings change width with the figures, and a fixed breakpoint
     either wraps tiles with room to spare or lets the suffix run into the
     bars. Re-measured on resize and whenever the figures change. */
  const tilesRef = useRef<HTMLDivElement>(null)
  const [alongside, setAlongside] = useState(true)
  useLayoutEffect(() => {
    const root = tilesRef.current
    if (!root) return
    const measure = () => {
      const tiles = [...root.querySelectorAll<HTMLElement>('[data-tile]')]
      const fits = tiles.every((tile) => {
        const reading = tile.querySelector<HTMLElement>('[data-reading]')
        const strip = tile.querySelector<HTMLElement>('[data-history]')
        if (!reading || !strip) return true
        const pad = 20                                   // px-2.5 both sides
        const gap = 8                                    // the grid's gap-2
        return tile.clientWidth - pad >= reading.offsetWidth + gap + strip.offsetWidth
      })
      setAlongside(fits)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(root)
    return () => ro.disconnect()
  }, [latest?.down_mbps, latest?.up_mbps, plan.down_mbps, plan.up_mbps])
  /* One line per direction that is short, judged on the latest test — the
     same reading the big number shows, so the alert and the figure beside it
     can never disagree. */
  const shortfalls = [
    short(latest?.down_mbps, plan.down_mbps)
      ? t('dashboard.below_plan_download',
          { actual: Math.round(latest!.down_mbps!), plan: plan.down_mbps!.toLocaleString() })
      : null,
    short(latest?.up_mbps, plan.up_mbps)
      ? t('dashboard.below_plan_upload',
          { actual: Math.round(latest!.up_mbps!), plan: plan.up_mbps!.toLocaleString() })
      : null,
  ].filter((s): s is string => s !== null)
  const history = (pick: (s: SpeedTest) => number | null | undefined, label: string,
                   color: string, paid: number | null | undefined) => (
    <Sparkbars
      label={label} color={color}
      /* The level paid for, across the strip, so each reading is seen against
         it rather than only against its neighbors. */
      line={paid ? { value: paid,
                     title: t('charts.paid_for_mbps', { n: paid.toLocaleString() }) }
                 : null}
      values={recent.map((s) => (s ? pick(s) ?? null : null))}
      /* Date and time, since two tests can land on one afternoon. A padding
         slot has nothing to say and gets no tooltip. */
      tips={recent.map((s) => {
        const v = s ? pick(s) : null
        return s && v != null
          ? t('dashboard.test_reading', { when: when(s.date), mbps: Math.round(v) })
          : ''
      })} />
  )

  return (
    <Card icon="speed" title={t('dashboard.at_a_glance')} anchor="glance">
      {/* Short of the plan: said above the readings it is about, in the
          warning tone rather than red, since a slow line is a grievance and
          not a fault in the network. One reading can be off, so the alert
          says to test again before acting on it. */}
      {shortfalls.length > 0 && (
        <Notice kind="warn" className="mb-3" data-below-plan>
          {shortfalls.map((line) => <span key={line} className="block">{line}</span>)}
          <span className="block text-[var(--color-ink-3)]">
            {t('dashboard.below_plan_hint')}
          </span>
        </Notice>
      )}
      {/* Two readings, side by side at any size. The test that produces
          them is run from the Internet page, under the connection it
          measures. */}
      <div ref={tilesRef} className="grid grid-cols-2 items-stretch gap-3">
        <SpeedReading label={t('dashboard.download_speed')} mbps={latest?.down_mbps}
                      alongside={alongside} plan={plan.down_mbps ?? null}
                      isShort={short(latest?.down_mbps, plan.down_mbps)}
                      history={history((s) => s.down_mbps, t('dashboard.download_recent'),
                                       'var(--series-1)', plan.down_mbps)} />
        <SpeedReading label={t('dashboard.upload_speed')} mbps={latest?.up_mbps}
                      alongside={alongside} plan={plan.up_mbps ?? null}
                      isShort={short(latest?.up_mbps, plan.up_mbps)}
                      history={history((s) => s.up_mbps, t('dashboard.upload_recent'),
                                       'var(--series-2)', plan.up_mbps)} />
      </div>

      {/* Three readings of the clients: how many are known, how many are on,
          and how well the wireless ones are being reached. Each is a heading,
          a ring and a legend. With the heading to the left of the ring the
          three need about 880px between them, which this half-width card only
          has on a wide monitor; below that the heading moves above its ring.
          A container query, because it is this card's width that decides, not
          the window's.

          How many stand side by side is the same question, so it is answered
          the same way: as many 175px columns as fit — a ring with its legend
          measures about 165 — which is three on a wide monitor, two on a
          laptop and one on a phone. It was three whenever
          the window was over 640px wide however narrow the card was, and a
          ring with its legend does not go in 102px — the readings were
          clipped at every width below about 1550, including the one this was
          designed at. */}
      <div className="mt-4 grid gap-4 border-t border-[var(--color-line)] pt-4
                      @container [grid-template-columns:repeat(auto-fit,minmax(175px,1fr))]">
        {/* Online against offline. Offline is not a fault — most of what a
            house knows about is asleep — so it gets the neutral rather than a
            second hue implying a second kind of thing, and certainly not a
            status color. */}
        <div className={READING}>
          <span className={READING_HEAD}>
            {t('dashboard.known_clients')}
          </span>
          <Donut legend="right"
          label={t('dashboard.known')}
          caption={t('dashboard.clients_known_caption',
                     { online, offline: devices.length - online })}
          slices={[
            { name: t('dashboard.online_lower'), value: online,
              color: 'var(--series-1)' },
            { name: t('dashboard.offline_lower'), value: devices.length - online,
              color: 'var(--color-idle)' },
          ]} />
        </div>
        {/* Wireless against wired: two kinds of attachment, neither better
            than the other, so the validated categorical pair. */}
        <div className={READING}>
          <span className={READING_HEAD}>
            {t('dashboard.client_connections')}
          </span>
          <Donut legend="right"
          label={t('dashboard.on_now')}
          caption={t('dashboard.clients_online_caption',
                     { wireless, wired: online - wireless })}
          slices={[
            { name: t('dashboard.wireless'), value: wireless,
              color: 'var(--series-1)' },
            { name: t('dashboard.wired'), value: online - wireless,
              color: 'var(--series-2)' },
          ]} />
        </div>
        {/* How well the Wi-Fi reaches the clients on it, in eero's own bands.
            Ordinal, so one hue stepped from dark (good) to light (poor) rather
            than three hues, and not the status colors: a far-off thermostat
            on one bar is normal for a house, not an alarm. The figure in the
            hole is how many clients the picture is of, which is fewer than
            the wireless count when some have not reported a signal. */}
        <div className={READING}>
          <span className={READING_HEAD}>
            {t('dashboard.wireless_client_reception')}
          </span>
          <Donut legend="right"
          label={t('dashboard.wifi')}
          caption={t('dashboard.signal_caption', signal)}
          slices={[
            { name: t('dashboard.signal_good'), value: signal.good,
              color: 'var(--signal-good)' },
            { name: t('dashboard.signal_okay'), value: signal.okay,
              color: 'var(--signal-okay)' },
            { name: t('dashboard.signal_poor'), value: signal.poor,
              color: 'var(--signal-poor)' },
          ]} />
        </div>
      </div>

      {/* One line across the foot of the card: every eero, each carrying its
          own verdict. Full width rather than in a column, because it is a
          roll-call — the eye runs along it and stops at whichever mark is not
          a tick. */}
      <EeroStrip eeros={eeros} />
    </Card>
  )
}

/* The eeros as a tree, flattened for a list: the gateway first, then each
   eero under the one it reaches the network through, indented by how far from
   the gateway it sits. A wireless leaf names its uplink; a wired one does not
   say which port it is cabled to, so it hangs off the gateway, which is the
   same rule the mesh diagram draws by. A leaf whose named uplink is not in the
   list falls to the gateway too, so nothing is dropped. Children in name
   order, so the list is stable between refreshes. */
type TreeRow = {
  e: Eero; depth: number
  /** How this eero reaches its parent. */
  link: 'wan' | 'wired' | 'wireless' | 'down'
  parent: string | null
}

function hierarchy(eeros: Eero[]): TreeRow[] {
  const gw = eeros.find((e) => e.gateway) ?? null
  const kids = new Map<string, Eero[]>()
  for (const e of eeros) {
    if (e === gw) continue
    const parent = hasKnownUplink(e, eeros) ? (uplinkName(e) as string) : (gw?.location ?? '')
    kids.set(parent, [...(kids.get(parent) ?? []), e])
  }
  const byName = (a: Eero, b: Eero) => (a.location ?? '').localeCompare(b.location ?? '')
  const rows: TreeRow[] = []
  const seen = new Set<Eero>()
  const walk = (e: Eero, depth: number, parent: string | null) => {
    if (seen.has(e)) return           // a cycle in eero's own data; draw it once
    seen.add(e)
    const link = unreachable(e) ? 'down' : e.gateway ? 'wan'
      : e.wireless_upstream_node ? 'wireless' : 'wired'
    rows.push({ e, depth, link, parent })
    for (const k of [...(kids.get(e.location ?? '') ?? [])].sort(byName)) {
      walk(k, depth + 1, e.location ?? null)
    }
  }
  if (gw) walk(gw, 0, null)
  // Anything nothing claimed: no gateway in the list, or a parent name that
  // matches an eero which is itself unreachable through the walk.
  for (const e of [...eeros].sort(byName)) if (!seen.has(e)) walk(e, gw ? 1 : 0, gw?.location ?? null)
  return rows
}

/* The arrow on a child row: down from the eero above and right into this
   one, the way the internet actually flows — the gateway feeds the leaves, and
   a leaf feeds whatever meshes to it. Green for a cable and blue for Wi-Fi,
   the same code the mesh diagram's lines use; gray when the eero is not
   reachable, since whatever it used to link over is not carrying anything
   now. The title says which and to what. */

/* Every eero on one line, each with its own verdict, and every eero Signal
   beside the eero it plugs into.

   A count of healthy nodes made the reader do arithmetic to find out whether
   the number they were looking at was all of them. A row of marks with a tick
   on each answers that without counting, and the eye stops at whichever mark
   is not a tick. A cross names the device and what eero calls the state it is
   in, right there, because somebody who has to go looking for the explanation
   has already lost the reassurance.

   The Signal is on the line because it is part of the network's readiness: a
   backup that is not registered is a promise the network cannot keep, and a
   strip that said all was well while the Signal sat unready was saying less
   than it seemed to. Its verdict is the one the eeros list already draws —
   a fault eero reports, or no registration, is a cross. */
type Verdict = 'ok' | 'warn' | 'bad'
type StripItem = {
  key: string; kind: 'eero' | 'signal'; name: string
  /** The eero's model, for its own glyph; nothing for a Signal. */
  model?: string | null
  state: string | undefined
  /** Well, in a state that passes (restarting, updating, joining, or a
   *  Signal without registration yet), or not reachable at all. */
  verdict: Verdict
  /** What the fault or the state is, for whoever hovers. The same sentence the
   *  device's drawer shows under Connectivity, where there is one. */
  why: string | null
}

/* The sentences come from lib/nodeHelp, the same ones the eeros list, the
   mesh diagram and the drawers use, so hovering any of them says the same. */
function eeroVerdict(e: Eero): { verdict: Verdict; why: string | null } {
  const why = nodeStateHelp(e)
  if (unreachable(e)) return { verdict: 'bad', why }
  return { verdict: why ? 'warn' : 'ok', why }
}

function signalVerdict(a: NonNullable<Eero['accessories']>[number]): { verdict: Verdict; why: string | null } {
  const why = accessoryStateHelp(a)
  if (a.issue) return { verdict: 'bad', why }
  return { verdict: why ? 'warn' : 'ok', why }
}

function stripItems(eeros: Eero[]): StripItem[] {
  /* In the same order as the eeros list below: the gateway first, then each
     leaf under its uplink, so the row and the list agree about the network. */
  return hierarchy(eeros).map((r) => r.e).flatMap((e) => [
    { key: e.url, kind: 'eero' as const, name: e.location ?? '', model: e.model,
      state: nodeStatusLabel(e), ...eeroVerdict(e) },
    ...(e.accessories ?? [])
      .filter((a) => a.properties?.type === 'cellular_backup')
      .map((a, i) => ({
        key: `${e.url}-signal-${a.dsn ?? i}`, kind: 'signal' as const,
        name: a.product || a.model || t('dashboard.column_accessory'),
        state: signalIssue(a) ?? nodeStatusLabel(a),
        ...signalVerdict(a),
      })),
  ])
}

const VERDICT_COLOR: Record<Verdict, string> = {
  ok: 'var(--color-ok)', warn: 'var(--color-warn)', bad: 'var(--color-bad)',
}
/* The same, for the words under a device. A status color is chosen as a
   mark, and as 11px text several themes' amber and red are too light to
   read; a theme that says nothing keeps the mark's own color. */
const VERDICT_INK: Record<Verdict, string> = {
  ok: 'var(--color-ok-ink, var(--color-ok))',
  warn: 'var(--color-warn-ink, var(--color-warn))',
  bad: 'var(--color-bad-ink, var(--color-bad))',
}

function EeroStrip({ eeros }: { eeros: Eero[] }) {
  const items = stripItems(eeros)
  if (!items.length) return null
  return (
    <div className="mt-4 border-t border-[var(--color-line)] pt-3">
      {/* One equal column per device, so the row is the network laid out
          evenly whatever the count, and each device's name sits under its
          glyph. A device that is not well says what it is doing under its
          name, and hovering it explains — in the same words its drawer uses.
          Nothing is said when everything is well: a row of ticks is the
          sentence. */}
      <ul className="grid gap-x-2 gap-y-1"
          style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((i) => (
          <li key={i.key} data-strip={i.kind} data-verdict={i.verdict}
              className="flex min-w-0 flex-col items-center text-center"
              title={i.why ?? [i.name, i.state].filter(Boolean).join(' \u00b7 ')}>
            <span className="relative inline-grid place-items-center">
              {/* Each device's own glyph — a Pro 7 looks like a Pro 7, as it
                  does in the mesh diagram — in the strip's gray rather than the
                  accent, and without the glyph's caution mark: the verdict chip
                  says it, and one mark per device is enough. */}
              {i.kind === 'eero'
                ? <EeroIcon model={i.model} size={28} className="text-[var(--color-ink-3)]" />
                : <SignalIcon size={28} className="text-[var(--color-ink-3)]" />}
              {/* The verdict as a shape and not only a color, on a chip of
                  the card's own surface so it reads against the glyph: a tick,
                  an amber mark for a state that passes on its own, a cross for
                  a device nothing can reach. */}
              <span className="absolute -bottom-1 -right-1 grid size-3.5
                               place-items-center rounded-full
                               bg-[var(--color-surface)]">
                <svg viewBox="0 0 24 24" className="size-3" fill="none"
                     stroke={VERDICT_COLOR[i.verdict]}
                     strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                     aria-hidden="true">
                  {i.verdict === 'ok' ? <path d="M5 13l4 4L19 7" />
                    : i.verdict === 'warn' ? <><path d="M12 4v10" /><path d="M12 19.5v.5" /></>
                    : <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>}
                </svg>
              </span>
            </span>
            <span data-strip-name
                  className="mt-1.5 w-full truncate text-[12px] leading-snug text-[var(--color-ink-2)]">
              {i.name}
            </span>
            {i.verdict !== 'ok' && (
              <span data-strip-state
                    className="w-full truncate text-[11px] leading-snug"
                    style={{ color: VERDICT_INK[i.verdict] }}>
                {i.state ?? t('dashboard.not_reporting')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/* One reading in the clients row: heading beside the ring when the card is
   wide enough for three of them that way, above it otherwise. Centered in its
   column either way, so the three sit evenly across the card rather than
   each hugging the left of its third. */
const READING = 'flex items-center justify-center gap-4 @max-[879px]:flex-col @max-[879px]:gap-2'
const READING_HEAD = 'micro-label w-20 shrink-0 leading-snug @max-[879px]:w-auto @max-[879px]:text-center'

/**
 * The latest reading, with its recent history drawn small on the right.
 *
 * The number is a button: pressing it opens a field beside it for the speed
 * the household pays for, which is the one figure that turns a reading into a
 * verdict. Leaving the field saves it; Escape puts things back; emptying it
 * clears the figure. Once set, the reading shows "600 / 1,000 Mbps".
 */
function SpeedReading({ label, mbps, history, plan, isShort, alongside }: {
  label: string; mbps?: number | null; history?: ReactNode
  /** Whether the strip sits beside the reading or under it. Decided by the
   *  card for both tiles at once, from what the wider reading needs. */
  alongside: boolean
  /** What the provider sells, in Mbps, or null. Set on the Internet card;
   *  shown here beside the reading it is compared against. */
  plan: number | null
  /** The reading falls short of the plan; the suffix takes the warning tone
   *  so the comparison itself shows it, not only the notice above. */
  isShort?: boolean
}) {
  const shown = plan == null ? null
    : plan.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return (
    /* Where the strip goes is not this tile's decision. Each tile used to
       wrap on its own, so "1195 / 1,000 Mbps" pushed its strip below while
       "76 / 35 Mbps" beside it kept its strip alongside, and the two read as
       two designs. A fixed width was tried next and wrapped tiles with room
       to spare. The card measures what the wider reading needs against the
       tile's width and tells both tiles the same answer. */
    <div data-tile className="rounded-md border border-[var(--color-line)] px-2.5 py-2">
      <div className={`grid gap-2 ${alongside ? 'grid-cols-[minmax(0,1fr)_auto] items-center' : ''}`}>
      <div className="min-w-0">
        <div className="micro-label">{label}</div>
        {/* Shrink-to-fit, so its width is the text's width and can be
            measured; as a block it was as wide as its column, which made the
            card think no tile ever had room. */}
        <div data-reading className="mt-0.5 inline-flex w-max items-baseline gap-1 whitespace-nowrap">
          <span className="text-2xl font-semibold tabular-nums text-[var(--color-ink)]">
            {mbps == null ? '—' : Math.round(mbps)}
          </span>
          {shown != null ? (
            <span data-plan data-short={isShort ? '1' : undefined}
                  title={t('dashboard.plan_paid_for')}
                  className="whitespace-nowrap text-[12px] tabular-nums"
                  style={{ color: isShort ? 'var(--color-warn)' : 'var(--color-ink-3)' }}>
              {t('dashboard.plan_suffix', { mbps: shown })}
            </span>
          ) : (
            <span className="text-[12px] text-[var(--color-ink-3)]">{t('dashboard.mbps')}</span>
          )}
        </div>
      </div>
      {history && <span data-history className="inline-flex w-max">{history}</span>}
      </div>
    </div>
  )
}

export function Dashboard() {
  /* Opens on the last answer; the read below asks for a new one. */
  const [eeros, setEeros] = useState<Eero[]>(
    () => lastRead<Eero[]>('/api/eeros') ?? [])
  const [devices, setDevices] = useState<Device[]>(
    () => lastRead<Device[]>('/api/devices') ?? [])
  const [err, setErr] = useState('')
  // Nothing is known until the first fetch lands. Rendering the stats from
  // empty state claimed the internet was down and the network had no eeros,
  // which was simply false — so hold a neutral placeholder until the data is
  // actually in.

  const load = useCallback(() => Promise.all([
    api.get<Eero[]>('/api/eeros'),
    api.get<Device[]>('/api/devices'),
  ])
    /* `/api/network` came out with the Internet tile that read it: the only
       things it supplied were the online verdict and the WAN type, both of
       which the connection card next door reports from its own read. One
       fewer request per page view. */
    .then(([e, d]) => {
      setEeros(e ?? []); setDevices(d ?? [])
    })
    .catch((e) => setErr(e.message)), [])

  useEffect(() => { void load() }, [load])

  /* The dots on this page reported whatever was true when it loaded. An eero
     restarting takes about five minutes, so the first screen somebody looks
     at was the one most likely to be lying about it. Fast while anything is
     not green — see watchInterval. */
  useRevalidate(load, useWatchInterval(eeros))

  if (err) return <Notice kind="bad">{err}</Notice>


  return (
    /* One two-column grid rather than a stack with a pair inside it, so every
       pane is a direct child and a theme's page plan can reach each one. */
    <Page name="dashboard" columns={2}>
      {/* Above everything: an update that reboots the whole
          network at an hour nobody was told is worth telling. */}
      <Slot id="firmware" wide><FirmwareNotice /></Slot>

      {/* The two questions somebody opens this page to answer: what the
          connection is, and how fast it is. Paired across the top because
          they are halves of the same subject and each is narrow enough that a
          full-width card wasted the right-hand two thirds of a wide screen.

          `xl` is where the rest of the app splits into two columns, so this
          stacks on anything narrower rather than inventing its own breakpoint.

          The firmware notice stays above them. It is a warning that the whole
          network is about to restart at an hour nobody chose, and a card is
          not a reason to push that down the page. */}
      <ConnectionInfo />
      <GlanceCard eeros={eeros} devices={devices} />
      {/* No health card between here and the mesh. eero's verdict and a
          composed score used to sit in one; what they said is already on this
          page in its parts — the connection card, the eero strip, the client
          reception ring — and the reader was being asked to take in the same
          news twice. The read went with the eero list that used it: the
          dashboard makes two calls on arrival now rather than three. */}

      {/* The eeros, as one card: the mesh diagram, which shows how they
          connect, or the table, which says more about each, switched from
          the card's header. They were two cards one above the other saying
          much the same thing. */}
      <Slot id="mesh" wide><NodesOverview /></Slot>

      {/* Not inside `Gate`, for the same reason as Dynamic DNS on the Network
          page: the mark would be dimmed along with the card it is explaining.
          The card reads the capability itself and leaves the layout when the
          reader has asked for features they cannot use to be left out. */}
      <DataUsage />

    </Page>
  )
}

interface DashUsage {
  series: Record<string, { total_bytes: number
                           points: { t: string; bytes: number }[] }>
}

/**
 * What the network has moved this week, on the overview page.
 *
 * This card was a placeholder from the first commit: a sentence saying usage
 * history would appear once a reporting period had elapsed, over a card that
 * asked eero for nothing and so was never going to show any. The feed was
 * there the whole time — it is the one the Insights page draws.
 *
 * A summary rather than a second copy of that page: two totals and the days
 * behind them, a month of them unless another span is picked. No table and no
 * per-device breakdown; the card on Insights is for the question this one
 * only raises.
 */
function DataUsage() {
  const cap = usePlusGate('historical_usage')
  const available = cap.available
  const { hourAxis } = useClock()
  /* A month to begin with, which is the span a data cap or a bill is
     counted over. The picker still offers a day and a week. */
  const [days, setDays] = useState(30)
  const [usage, setUsage] = useState<DashUsage | null>(null)
  /* The old window stays on screen while the new one loads, and the chart
     shrinks its bars rather than emptying the card — the same `pending`
     behavior every other chart in the app has when its period changes. */
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    /* Not until the capability map is in. An unknown capability reads as
       available, and every name is unknown until that read lands — so without
       this the card fetched a week of history once, on a network with no
       subscription to it, before finding out. */
    if (!cap.ready || !available) return
    let live = true
    setPending(true)
    /* The reader's own timezone, for the same reason the client drawer sends
       it: without it eero cuts the days at UTC midnight while the axis prints
       each bucket's local date, and west of UTC every bar sits a day early.

       And a day is asked for by the hour. Asked for by the day it is one
       bucket, which is a chart with a single column in it and nothing to
       compare that column against. */
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    api.get<DashUsage>(`/api/insights/usage?days=${days}`
      + (days === 1 ? '&cadence=hourly' : '')
      + `&timezone=${encodeURIComponent(tz)}`)
      .then((u) => { if (live) { setUsage(u); setFailed(false) } })
      .catch(() => { if (live) setFailed(true) })
      .finally(() => { if (live) setPending(false) })
    return () => { live = false }
  }, [available, cap.ready, days])

  const down = usage?.series?.download
  const up = usage?.series?.upload
  const points = down?.points ?? up?.points ?? []
  /* Hours within a day, dates across a week or a month. Labeling twenty-four
     hourly buckets with their date prints the same date on all of them. */
  const stamp = (at: string) =>
    days === 1 ? hourAxis(new Date(at).getHours()) : shortDay(at)
  const window = days === 1 ? t('insights.last_24_hours')
                            : t('insights.last_n_days', { days })

  if (cap.hidden) return null
  return (
    <Card icon="usage" title={t('dashboard.data_usage')}
          anchor="usage" className="wide:col-span-2"
          plus="historical_usage"
          action={available
            ? <PeriodPicker days={days} onPick={setDays} />
            : undefined}>
      {!available ? (
        <PlusWhy>{t('dashboard.usage_history_is_part_of_plus')}</PlusWhy>
      ) : failed ? (
        <p className="text-[13px] text-[var(--color-ink-3)]">
          {t('dashboard.usage_not_available')}
        </p>
      ) : !usage ? (
        <SkeletonRows rows={2} cols={2} label={t('dashboard.loading_data_usage')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <div className="grid content-start gap-3">
            <Stat label={t('dashboard.download')}
                  value={bytesTile(down?.total_bytes).value}
                  sub={bytesTile(down?.total_bytes).unit} />
            <Stat label={t('dashboard.upload')}
                  value={bytesTile(up?.total_bytes).value}
                  sub={bytesTile(up?.total_bytes).unit} />
          </div>
          <ColumnChart
            categories={points.map((p) => stamp(p.t))}
            series={[
              { name: t('dashboard.download'), color: 'var(--series-1)',
                values: (down?.points ?? []).map((p) => p.bytes) },
              { name: t('dashboard.upload'), color: 'var(--series-2)',
                values: (up?.points ?? []).map((p) => p.bytes) },
            ].filter((x) => x.values.length)}
            format={bytes}
            height={150}
            axisWidth={52}
            pending={pending}
            label={t('dashboard.download_upload_over', { window })}
            empty={t('dashboard.no_usage_recorded_yet')} />
        </div>
      )}
    </Card>
  )
}

