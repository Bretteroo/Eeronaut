import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { pushAlert } from '../lib/alerts'
import { t } from '../i18n'

/* Whether a newer Eeronaut has been released. The server looks once a day
   (core/app_update.py); this reads its answer, once per visit. */

export interface AppUpdate {
  current: string
  latest: string | null
  url: string | null
  available: boolean
}

let asked: Promise<AppUpdate | null> | null = null
const ask = () => (asked ??= api.get<AppUpdate>('/api/settings/app-update').catch(() => null))

export function useAppUpdate(): AppUpdate | null {
  const [u, setU] = useState<AppUpdate | null>(null)
  useEffect(() => { void ask().then(setU) }, [])
  return u
}

/** One line saying a new version is out, linking to its notes. Nothing at
 *  all when there is none. */
export function AppUpdateNotice({ className = '' }: { className?: string }) {
  const u = useAppUpdate()
  if (!u?.available || !u.latest) return null
  return (
    <p data-part="app-update" className={`text-[12px] text-[var(--color-ink-2)] ${className}`}>
      {t('app_update.available', { version: u.latest })}
      {u.url && <>{' '}<a href={u.url} target="_blank" rel="noreferrer"
                          className="link">{t('app_update.whats_new')}</a></>}
    </p>
  )
}

const SEEN = 'eeronaut.app-update.alerted'

/** Says so once per new version, as an alert, then leaves it to Settings and
 *  About. Which version was last announced is this browser's to remember. */
export function AppUpdateAlert() {
  const u = useAppUpdate()
  useEffect(() => {
    if (!u?.available || !u.latest) return
    let seen: string | null = null
    try { seen = localStorage.getItem(SEEN) } catch { /* private mode */ }
    if (seen === u.latest) return
    try { localStorage.setItem(SEEN, u.latest) } catch { /* private mode */ }
    pushAlert({
      title: t('app_update.available', { version: u.latest }),
      body: t('app_update.running', { current: u.current }),
      link: { label: t('app_update.details'), to: '/settings?pane=access' },
    })
  }, [u])
  return null
}
