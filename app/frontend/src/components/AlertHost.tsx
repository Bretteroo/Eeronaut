import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { onAlert, type Alert } from '../lib/alerts'
import { t } from '../i18n'

const TONE: Record<string, string> = {
  info: 'border-[var(--color-accent)]',
  good: 'border-[var(--color-ok)]',
  warn: 'border-[var(--color-warn)]',
  bad: 'border-[var(--color-bad)]',
}

/* Mounted once at the app root. Renders raised alerts as a stack of toasts in
   the corner, each dismissible and auto-clearing after a while. */
export function AlertHost() {
  const [alerts, setAlerts] = useState<Alert[]>([])

  useEffect(() => onAlert((a) => {
    setAlerts((cur) => [...cur, a].slice(-4))
    window.setTimeout(() => {
      setAlerts((cur) => cur.filter((x) => x.id !== a.id))
    }, 8000)
  }), [])

  if (!alerts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,92vw)] flex-col gap-2"
         role="region" aria-label={t('alert_host.alerts')} aria-live="polite">
      {alerts.map((a) => (
        <div key={a.id}
             className={`pointer-events-auto rounded-lg border-l-4 bg-[var(--color-surface)] p-3 shadow-xl ${TONE[a.tone ?? 'info']}`}>
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-semibold">{a.title}</p>
            <button type="button" aria-label={t('alert_host.dismiss')}
              onClick={() => setAlerts((cur) => cur.filter((x) => x.id !== a.id))}
              className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">×</button>
          </div>
          {(a.body || a.link) && (
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
              {a.body}
              {a.link && <>{a.body ? ' ' : ''}<Link to={a.link.to} className="link"
                onClick={() => setAlerts((cur) => cur.filter((x) => x.id !== a.id))}>
                {a.link.label}</Link></>}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
