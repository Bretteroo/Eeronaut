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

/* Mounted once at the app root. Shows the most recent alert as a toast in the
   corner, dismissible and auto-clearing after a while. A new alert replaces the
   one showing rather than stacking above it. */
export function AlertHost() {
  const [alert, setAlert] = useState<Alert | null>(null)
  const dismiss = (id: string) => setAlert((cur) => (cur?.id === id ? null : cur))

  useEffect(() => onAlert((a) => {
    setAlert(a)
    window.setTimeout(() => dismiss(a.id), 8000)
  }), [])

  if (!alert) return null
  const a = alert
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,92vw)] flex-col gap-2"
         role="region" aria-label={t('alert_host.alerts')} aria-live="polite">
      <div key={a.id}
           className={`pointer-events-auto rounded-lg border-l-4 bg-[var(--color-surface)] p-3 shadow-xl ${TONE[a.tone ?? 'info']}`}>
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-semibold">{a.title}</p>
          <button type="button" aria-label={t('alert_host.dismiss')}
            onClick={() => dismiss(a.id)}
            className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)]">×</button>
        </div>
        {a.body && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
            {a.body}
          </p>
        )}
        {/* Under the body rather than run on after it, the way the
            notifications drawer shows the same link. */}
        {a.link && (
          <p className="mt-0.5 text-[12px] leading-relaxed">
            <Link to={a.link.to} className="link" onClick={() => dismiss(a.id)}>
              {a.link.label}</Link>
          </p>
        )}
      </div>
    </div>
  )
}
