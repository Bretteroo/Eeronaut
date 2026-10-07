import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { api, lastRead } from '../lib/api'
import { Page } from '../lib/pages'
import { pageRoute, useTheme, viewParts } from '../lib/theme'
import { Card } from './primitives'
import { DynamicDns } from './DynamicDns'
import { NetworkSwitcher } from './NetworkSwitcher'
import { Notifications } from './Notifications'
import { t } from '../i18n'

/**
 * A page a theme put together out of other pages' panes.
 *
 * Every page it draws on is mounted whole, exactly as at its own route, and
 * the view's stylesheet hides the panes it did not name (see `layoutCss`).
 * Mounting whole pages rather than lifting cards out of them is the point:
 * a card depends on the reads, the notices and the busy flags of the page it
 * belongs to, and a copy taken out of that would be a second implementation
 * of it that could disagree with the first.
 */
export function ViewAt({ prefs, onPrefs, networkName, onSegment }: {
  prefs: unknown
  onPrefs: unknown
  networkName?: string
  onSegment: boolean | null
}) {
  const { view: id } = useParams()
  const { layout } = useTheme()
  const view = layout.views.find((v) => v.view === id)
  /* A view belongs to one theme. Changing theme with one open, or following
     a link from another theme's view, lands on the dashboard rather than on
     an empty frame. */
  if (!view) return <Navigate to="/" replace />
  const { pages, sections } = viewParts(view)
  return (
    <div data-view={view.view} data-part="page" className="grid gap-4">
      {pages.map((page) => {
        const Component = Page[pageRoute(page)]
        if (!Component) return null
        return page === 'settings'
          ? <Component key={page} prefs={prefs} onPrefs={onPrefs} />
          : <Component key={page} />
      })}
      {sections.map((name) => (
        <div key={name} data-section={name} className="grid min-w-0">
          {name === 'ddns' && <DdnsSection />}
          {name === 'notifications' && <Notifications as="card" />}
          {name === 'network_switcher' && (
            <Card icon="internet" title={t('section.network_switcher')}>
              <NetworkSwitcher current={networkName} currentLocal={onSegment} />
            </Card>
          )}
        </div>
      ))}
    </div>
  )
}

interface Lan { ddns?: { enabled?: boolean; subdomain?: string } }

/* Dynamic DNS on a card of its own. At home it is the last row of the
   Internet card, which has the network object in hand already; here it has
   to read it, from the cache the Internet card left if there is one. */
function DdnsSection() {
  const [lan, setLan] = useState<Lan | null>(() => lastRead<Lan>('/api/network/lan') ?? null)
  const reload = () => api.get<Lan>('/api/network/lan').then(setLan).catch(() => {})
  useEffect(() => { void reload() }, [])
  return (
    <Card icon="dns" title={t('network.dynamic_dns')} anchor="ddns">
      <DynamicDns alone eeroDdns={lan?.ddns}
                  onEeroToggle={(on) => api.put('/api/network/ddns', { enabled: on })
                    .then(() => reload())} />
    </Card>
  )
}
