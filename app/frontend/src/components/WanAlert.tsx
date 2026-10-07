import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { isOutage, rungFor, type NetStatus, type WanIf } from '../lib/wan'
import { t } from '../i18n'

/**
 * Whether the internet is down, asked of the hardware rather than inferred.
 *
 * Deliberately not the same question as "did a cloud call fail". A cloud read
 * can fail because eero's own service is having a bad day, and an outage can
 * be underway while a cached page still looks fine. The gateway knows, and it
 * is reachable over the local network precisely when the internet is not.
 *
 * Silent when it cannot tell. If no eero answers, this returns null rather
 * than guessing an outage — a false alarm about the internet being down is
 * worse than no alarm, because the first thing it costs is trust in the alarm.
 */
export function useWanOutage(): WanIf | null {
  const [iface, setIface] = useState<WanIf | null>(null)
  const stop = useRef(false)

  useEffect(() => {
    stop.current = false
    const read = () => api.get<NetStatus>('/api/local/network-status')
      .then((r) => {
        if (stop.current) return
        const i = r.wan?.interfaces?.[0] ?? null
        setIface(i && isOutage(i.state) ? i : null)
      })
      .catch(() => { if (!stop.current) setIface(null) })
    void read()
    // Half a minute app-wide. The diagnosis pane polls faster while it is
    // open, which is where someone is actively watching for a change; this
    // one only has to notice, and it runs on every page.
    const t = setInterval(read, 30_000)
    return () => { stop.current = true; clearInterval(t) }
  }, [])

  return iface
}

/**
 * The outage strip across the top of every page.
 *
 * Sits inside the header rather than on the page body so it survives
 * scrolling and does not move the content it warns about. It only appears
 * during an outage, so the header is its normal height the rest of the time.
 */
export function WanAlert({ iface }: { iface: WanIf | null }) {
  if (!iface) return null
  const rung = rungFor(iface.state)
  const bad = rung.tone === 'bad'
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-[13px]"
      style={{
        borderColor: `var(--color-${bad ? 'bad' : 'warn'})`,
        // A wash rather than a solid fill: this sits under the header row on
        // every page, and a saturated bar there reads as a modal error the
        // page cannot continue past.
        background: `color-mix(in oklab, var(--color-${bad ? 'bad' : 'warn'}) 12%, var(--color-surface))`,
      }}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <svg viewBox="0 0 24 24" className="size-4"
             fill={`var(--color-${bad ? 'bad' : 'warn'})`} aria-hidden="true">
          <path d="M12 2 1 21h22L12 2Zm1 14h-2v2h2Zm0-6h-2v4h2Z" />
        </svg>
      </span>
      <span className="min-w-0 font-semibold text-[var(--color-ink)]">
        {bad ? t('wan_alert.no_internet') : t('wan_alert.internet_problem')}
      </span>
      <span className="min-w-0 flex-1 text-[var(--color-ink-2)]">
        {rung.short}
      </span>
      <Link to="/internet?pane=wan" className="link shrink-0 font-medium">
        {t('wan_alert.whats_wrong')}
      </Link>
    </div>
  )
}
