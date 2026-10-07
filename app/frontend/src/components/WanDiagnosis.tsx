import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, lastRead } from '../lib/api'
import { WAN_DIAGNOSIS_MS } from '../lib/pollRates'
import { Card, Notice, SkeletonRows, StatusDot } from './primitives'
import { ColumnChart } from './charts'
import { SpeedTestProgress, SpeedTestRun } from './SpeedTestRun'
import { rungFor, WAN_TYPE, type NetStatus } from '../lib/wan'
import { bytes as gb, shortDay } from '../lib/format'
import { t } from '../i18n'

/**
 * The connection, live: what it is doing now and what it has been doing.
 *
 * Two sources, and the pane works with either. eero's cloud says whether the
 * network is connected, over what, and from which address, and answers for any
 * network on the account. The gateway itself says *where* a failure is —
 * `NodeStatus.wan_ts` carries eero's own WANState, a ladder walking outwards
 * from the WAN port, and the rung it stops on is the difference between a
 * modem, an ISP, and a resolver. That one only answers on this network's own
 * segment, so it is an enhancement rather than a requirement: without it the
 * pane still reports, it just cannot point at the rung.
 *
 * No Check now button and no refresh line. It polls, which is what "live"
 * means; a button that says "check" implies the rest of the time it is not.
 * And no score: eero publishes nothing that would support one, and a number
 * this app invented would be the app's opinion wearing a measurement's
 * clothes.
 */

/** How long, in words, since a timestamp. Recomputed every second. */
function useSince(iso: string | null | undefined) {
  /* The clock in state, not read during render.
     This kept a counter purely to force a re-render and then called
     `Date.now()` in the render itself, which makes the render impure: the
     same inputs give a different answer a second later. Holding the time
     instead is the same shape Network.tsx already uses for its own ticker,
     and it is one piece of state rather than two things that have to agree. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!iso) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [iso])
  if (!iso) return null
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b
                    border-[var(--color-line)] py-1.5 last:border-0">
      <span className="micro-label">{label}</span>
      <span className="text-right text-[13px] tabular-nums">{children}</span>
    </div>
  )
}

interface Cloud {
  status?: string | null
  health?: { internet?: { status?: string; isp_up?: boolean } }
  wan_type?: string | null
  ip_settings?: { public_ip?: string | null; double_nat?: boolean }
}
interface Lan { wan_ip?: string | null; wan_type?: string | null; isp?: string | null }
interface SpeedTest { date: string; down_mbps: number | null; up_mbps: number | null }
interface Speed { latest?: SpeedTest | null; tests: SpeedTest[] }
interface Usage {
  series: Record<string, { total_bytes: number | null
                           points: { t: string; bytes: number | null }[] }>
}

export function WanDiagnosis() {
  const [d, setD] = useState<NetStatus | null>(
    () => lastRead<NetStatus>('/api/local/network-status') ?? null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  /* Opens on the last answers; the reads below ask for new ones. */
  const [cloud, setCloud] = useState<Cloud | null>(
    () => lastRead<Cloud>('/api/network') ?? null)
  const [lan, setLan] = useState<Lan | null>(
    () => lastRead<Lan>('/api/network/lan') ?? null)
  const [speed, setSpeed] = useState<Speed | null>(null)
  const [testing, setTesting] = useState(false)
  const reloadSpeed = useCallback(() =>
    api.get<Speed>('/api/insights/speedtests?limit=1')
      .then((r) => { setSpeed(r); return (r?.latest ?? r?.tests?.[0])?.date ?? null })
      .catch(() => null), [])
  const [usage, setUsage] = useState<Usage | null>(null)
  const wasDown = useRef<boolean | null>(null)
  const [recovered, setRecovered] = useState(false)

  /* The cloud view, which answers for any network on the account rather than
     only the one this machine is sitting on. */
  const [cloudDone, setCloudDone] = useState(false)
  const loadCloud = useCallback(() => {
    api.get<Lan>('/api/network/lan').then(setLan).catch(() => {})
    return api.get<Cloud>('/api/network').then(setCloud).catch(() => {})
      .finally(() => setCloudDone(true))
  }, [])

  const load = useCallback(() => {
    return api.get<NetStatus>('/api/local/network-status')
      .then((r) => {
        setD(r); setErr('')
        const now = r.wan?.interfaces?.[0]?.state
        const down = Boolean(now && now !== 'ONLINE')
        // Announced rather than left to be noticed: the whole reason this is
        // on screen is that somebody is watching it waiting for a change.
        if (wasDown.current === true && !down) setRecovered(true)
        wasDown.current = down
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message
                                                 : t('wan_diagnosis.no_eero_answered')))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { void load(); loadCloud() }, [load, loadCloud])

  /* The history behind the state: what the line has actually delivered, and
     how much has gone over it. Both are cloud reads and both are slow-moving,
     so they are fetched once rather than on the live tick. */
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    void reloadSpeed()
    api.get<Usage>(`/api/insights/usage?days=7&timezone=${encodeURIComponent(tz)}`)
      .then(setUsage).catch(() => {})
  }, [reloadSpeed])
  /* Five seconds, which is eero's own
     `WanTroubleshootingViewModelKt.LOCAL_SESSION_UPDATE_INTERVAL`. Ours is
     one read of the local session per tick — `/api/local/network-status`,
     straight to the gateway — which is what that constant paces. Its service
     loop runs at two, a different shape.

     This was ten, which is slower than eero on the one screen somebody
     watches through an outage. It costs eero's service nothing either way:
     the local plane never leaves the house. */
  useEffect(() => {
    const t = setInterval(() => { void load(); loadCloud() }, WAN_DIAGNOSIS_MS)
    return () => clearInterval(t)
  }, [load, loadCloud])

  const wan = d?.wan ?? null
  const iface = wan?.interfaces?.[0] ?? null
  const rung = rungFor(iface?.state)
  const since = useSince(iface?.offline_since)

  /* Two opinions about the same question, and they are not equal. The gateway
     is authoritative and knows the rung; the cloud only knows whether it is
     being reached, which is still the answer on a network this machine cannot
     talk to directly. The gateway wins where it answered. */
  const cloudUp = (cloud?.health?.internet?.status ?? cloud?.status) === 'connected'
  const localDown = Boolean(iface && iface.state !== 'ONLINE')
  const down = iface ? localDown : cloud ? !cloudUp : false
  const known = Boolean(iface || cloud)
  const tone = iface ? rung.tone : down ? 'bad' : 'ok'
  const headline = iface ? rung.short
    : down ? t('wan_diagnosis.not_connected') : t('wan_diagnosis.connected')

  const wanType = lan?.wan_type ?? cloud?.wan_type ?? wan?.type ?? null
  const address = iface?.ipv4 ?? lan?.wan_ip ?? cloud?.ip_settings?.public_ip ?? null

  /* The most recent speed test, as two rows beside the connection's other
     facts. A chart of the last twenty sat to the right of them and repeated
     the Dashboard's strips and the Insights history; the one number somebody
     checking the connection wants is the latest. */
  const latest = speed?.latest ?? speed?.tests?.[0] ?? null
  const mbps = (v: number | null | undefined) =>
    typeof v === 'number' ? t('wan_diagnosis.mbps', { n: Math.round(v).toLocaleString() }) : '—'

  const down7 = usage?.series?.download?.points ?? []
  const up7 = usage?.series?.upload?.points ?? []
  const days = down7.map((p) => shortDay(p.t))

  return (
    <Card icon="internet" title={t('wan_diagnosis.internet_connection')} anchor="wan"
          action={known ? (say) => (
            <SpeedTestRun latest={latest?.date ?? null} reload={reloadSpeed}
                          onRunning={setTesting} say={say} />
          ) : undefined}>
      {testing && <SpeedTestProgress />}
      {recovered && (
        <div className="mb-3">
          <Notice kind="ok">{t('wan_diagnosis.connection_came_back')}</Notice>
        </div>
      )}

      {!known && loading && <SkeletonRows rows={4} cols={2} />}

      {known && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,15rem)_1fr]">
          {/* The state, said once and large. */}
          <div>
            <div className="flex items-center gap-2">
              <span className="grid size-3.5 place-items-center">
                <StatusDot state={tone} />
              </span>
              {/* In the page's own ink, not in the status color. A dot is
                  a fill and is tuned to be seen; the same value as 22px type
                  is 2.1:1 on white in two of the four themes, which is a
                  headline nobody with less than perfect sight can read. The
                  dot beside it carries the color, and the words say the
                  state in words. */}
              <span className="text-[22px] font-semibold leading-tight text-[var(--color-ink)]">
                {headline}
              </span>
            </div>
            {down && rung.blame && (
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
                {rung.blame}
              </p>
            )}
            {down && since && (
              <p className="mt-2 text-[13px]">
                <span className="micro-label">{t('wan_diagnosis.down')}</span>
                <span className="ml-2 font-semibold tabular-nums">{since}</span>
              </p>
            )}

            <div className="mt-3">
              {lan?.isp && <Row label={t('network.isp')}>{lan.isp}</Row>}
              <Row label={t('wan_diagnosis.connection')}>
                {wanType
                  ? (WAN_TYPE[wanType] ? t(WAN_TYPE[wanType]) : wanType)
                  : '—'}
                {wan?.type && wan.type !== 'wired' && (
                  <span className="ml-2 rounded bg-[var(--color-accent-wash)] px-1.5
                                   py-0.5 text-[11px] font-semibold
                                   text-[var(--color-accent-ink)]">
                    {t('wan_diagnosis.failed_over')}
                  </span>
                )}
              </Row>
              <Row label={t('wan_diagnosis.wan_address')}>
                <span className="font-mono text-[12px]">{address ?? '—'}</span>
              </Row>
              {/* Right under the address it qualifies: a second NAT means that
                  address is not the one the internet sees. */}
              {cloud?.ip_settings?.double_nat && (
                <Row label={t('wan_diagnosis.double_nat')}>{t('wan_diagnosis.yes')}</Row>
              )}
              {/* The readings dim while a new test runs, since they are
                  about to be replaced. */}
              <div className={testing ? 'opacity-50' : ''}>
                <Row label={t('wan_diagnosis.download_speed')}>{mbps(latest?.down_mbps)}</Row>
                <Row label={t('wan_diagnosis.upload_speed')}>{mbps(latest?.up_mbps)}</Row>
              </div>
            </div>

          </div>

          {/* What the line has actually been doing. */}
          <div className="grid gap-4">
            <div>
              <span className="micro-label">{t('wan_diagnosis.transferred_week')}</span>
              <ColumnChart
                categories={days}
                series={[
                  { name: t('insights.download'), color: 'var(--series-1)',
                    values: down7.map((p) => p.bytes ?? 0) },
                  { name: t('insights.upload'), color: 'var(--series-2)',
                    values: up7.map((p) => p.bytes ?? 0) },
                ]}
                format={gb} height={120} axisWidth={46}
                label={t('wan_diagnosis.transferred_week')}
                loading={usage === null}
                empty={t('wan_diagnosis.nothing_measured_yet')} />
            </div>
          </div>
        </div>
      )}

      {/* The ladder, only when there is a fault and a gateway that named it. */}
      {down && iface && rung.next.length > 0 && (
        <div className="mt-4 border-t border-[var(--color-line)] pt-3">
          <p className="micro-label mb-1">{t('wan_diagnosis.what_try_order')}</p>
          <ol className="grid gap-1 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {rung.next.map((step, i) => (
              <li key={i} className="flex gap-2">
                <span className="tabular-nums text-[var(--color-ink-3)]">{i + 1}.</span>
                <span className="min-w-0">{step}</span>
              </li>
            ))}
          </ol>
          {(iface.state === 'NO_DNS' || iface.state === 'DNS_UNREACHABLE') && (
            <p className="mt-2 text-[13px]">
              <Link to="/internet?pane=dns" className="link">
                {t('wan_diagnosis.set_custom_dns')}
              </Link>
            </p>
          )}
          {iface.state === 'AUTH_FAILED' && (
            <p className="mt-2 text-[13px]">
              <Link to="/internet?pane=internet" className="link">
                {t('wan_diagnosis.check_pppoe')}
              </Link>
            </p>
          )}
        </div>
      )}

      {/* An error from the local read is not a failure of this pane any more:
          the cloud answered, and the rung is the only thing missing. */}
      {/* Only once both have been tried. The local plane failing is the
          ordinary case off the segment and the cloud usually answers for it a
          moment later, so complaining while that answer is still in flight put
          a red notice on screen and took it away again — which is alarming
          about a network that turned out to be fine. */}
      {err && cloudDone && !cloud && (
        <Notice kind="bad">{err} {t('wan_diagnosis.reads_gateway_directly')}</Notice>
      )}
    </Card>
  )
}
