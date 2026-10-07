import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { api, ApiError, freshReads, type AuthState, type Capability, type Prefs } from './lib/api'
import { CapabilityProvider } from './lib/capabilities'
import { Shell } from './components/Shell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ViewAt } from './components/ViewAt'
import { Notifications } from './components/Notifications'
import { AlertHost } from './components/AlertHost'
import { StatusDot } from './components/primitives'
import { WanAlert, useWanOutage } from './components/WanAlert'
import { I18nProvider, resolveLanguage } from './i18n'
import { Page } from './lib/pages'
import { Login } from './pages/Login'
import { NetworkPicker } from './pages/NetworkPicker'
import { AppAccess, type AccessState } from './pages/AppAccess'
import { ThemeProvider, useClaimed, useTheme, viewFor } from './lib/theme'
import { t } from './i18n'
import { AppUpdateAlert } from './components/AppUpdate'

const DEFAULT_PREFS: Prefs = {
  hide_subscription_gated: false,
  hide_capability_limited: false,
  hide_plus_badges: false,
  appearance: 'system',
  theme: '',
  clock_24h: false,
  language: 'auto',
}

interface NetworkSummary { name?: string; premium_status?: string }


/**
 * Whether eero's cloud is answering.
 *
 * Worth its own component because it is the first thing looked at when the
 * internet goes down, and because the honest answer has three values: yes, no,
 * and not yet. It used to be a hardcoded "Connected", which during an outage
 * said the opposite of the truth directly above nine tabs that had all quietly
 * stopped working.
 */
/* A route element that is whichever page belongs to that path.
 * The pages are split into their own chunks, so what a route holds is not a
 * component but a promise of one; this is the one place that knows it. */
function PageAt({ path, ...rest }: { path: string } & Record<string, unknown>) {
  const Component = Page[path]
  /* A theme that shows this page's panes in views of its own has no page
     here: a link to it, from search or from another page, goes to the view
     holding the pane it names, and the pane focuses itself there as it
     would have here. */
  const { layout } = useTheme()
  const { search } = useLocation()
  const page = path === '/' ? 'dashboard' : path.slice(1)
  const to = viewFor(layout.views, page, new URLSearchParams(search).get('pane'))
  if (to) return <Navigate to={`/v/${to.view}${search}`} replace />
  return <Component {...rest} />
}

/* The bell, unless the theme gave notifications a page of their own. Then
   the feed is still read here, out of sight, so new items raise their alerts
   on every page and not only on that one. */
function Bell() {
  return <Notifications as={useClaimed('notifications') ? 'quiet' : 'bell'} />
}

function CloudStatus({ ok }: { ok: boolean | null }) {
  if (ok === null) return <StatusDot state="idle" label={t('app.connecting')} />
  if (ok) return <StatusDot state="ok" label={t('app.connected')} />
  return (
    <Link
      to="/internet?pane=wan"
      className="flex items-center gap-2 hover:text-[var(--color-ink)]"
      title={t('app.eero_s_cloud_not_answering')}
    >
      <StatusDot state="bad" label={t('app.cloud_unreachable')} />
    </Link>
  )
}

/**
 * Ask the server whether this browser is signed in, tolerating a server that
 * is not there for a moment.
 *
 * A refused answer is an answer and is returned as one. A connection that
 * never lands is not: it is tried a few times over a couple of seconds before
 * giving up, because the most common cause is a server that is restarting.
 */
async function readAccess(): Promise<AccessState | null> {
  for (let i = 0; i < 4; i++) {
    try {
      /* Never from the read cache. Whether this browser is signed in is the
         one question in the app whose answer from thirty seconds ago is
         worth nothing: this is asked precisely because something has just
         come back 401, and being handed the state from before that is how a
         session that has actually ended goes on looking live. */
      return await freshReads(() => api.get<AccessState>('/api/app/state'))
    } catch (e) {
      // A status code means the server answered; only a transport failure is
      // worth waiting out.
      if (e instanceof ApiError) return null
      await new Promise((go) => setTimeout(go, 400 * (i + 1)))
    }
  }
  return null
}

export default function App() {
  const [access, setAccess] = useState<AccessState | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [caps, setCaps] = useState<Record<string, Capability>>({})
  /* Whether that read has happened, either way. Before it has, the map is
     empty and every name in it reads as ungated — see `capsReady`. */
  const [capsReady, setCapsReady] = useState(false)
  const [net, setNet] = useState<NetworkSummary | null>(null)
  // Whether this machine is on the same segment as the selected network's
  // eeros. The local pages only work there, so they are hidden elsewhere.
  // Seeded from the last known answer for this network so the nav does not
  // flicker while the mDNS sweep runs.
  const [onSegment, setOnSegment] = useState<boolean | null>(null)
  /* Whether eero's cloud is answering. null until the first attempt lands.
     The header used to say t('app.connected') unconditionally, which is wrong in the
     one situation where the header matters: with the WAN down, every cloud
     read fails and the app claimed to be connected anyway. */
  const [cloud, setCloud] = useState<boolean | null>(null)
  /* Asked of the gateway, not inferred from a failed cloud call: the two are
     different faults and only one of them is the user's internet. */
  const outage = useWanOutage()
  /* Whether the server has ever answered the access question. Until it has,
     there is no previous answer worth keeping over a failure. */
  const seenAccess = useRef(false)
  const again = useRef(0)
  const reload = useRef<(() => Promise<void>) | null>(null)

  /* Which call of loadSession is the newest. Two can overlap: one set off by a
     401 while a sign-in is still being checked, one by the sign-in finishing.
     Only the newest may set anything, or an answer from before the sign-in
     that happened to arrive last would put the password screen back. */
  const sessionRun = useRef(0)
  const loadSession = useCallback(async () => {
    const run = ++sessionRun.current
    /* The interface gate comes first: until it passes, every other call is 401
       and there is nothing useful to ask for.

       A server that does not answer is not a server saying no. This used to
       treat any failure here as "not signed in", so a restart under an open
       page — a reload during development, a container coming back up, a
       moment of dropped Wi-Fi — threw the reader out to the password screen
       with a session that was still perfectly good. It is asked again, and if
       it still cannot be reached the last answer stands. */
    const acc = await readAccess()
    if (run !== sessionRun.current) return
    if (!acc) {
      if (!seenAccess.current) {
        // Nothing has ever been read, so there is nothing to keep. The sign-in
        // screen is the only honest thing to show, and it retries on submit.
        setAccess({ configured: true, signed_in: false, locked_for: 0, theme: '' })
      } else {
        again.current = window.setTimeout(() => void reload.current?.(), 3000)
      }
      return
    }
    seenAccess.current = true
    setAccess(acc)
    if (!acc.signed_in) { setAuth(null); return }

    // Live for the same reason as the access read above.
    const state = await freshReads(() => api.get<AuthState>('/api/auth/state'))
      .catch(() => null)
    if (run !== sessionRun.current) return
    setAuth(state ?? { authenticated: false, awaiting_code: false, login: '', remembered: false, network_url: '' })
    if (!state?.authenticated) return
    // Installation-wide, so the network picker is in the chosen theme and
    // language too.
    api.get<Prefs>('/api/settings/prefs').then(setPrefs).catch(() => {})
    /* Nothing network-scoped until a network is chosen. Asked for before the
       picker, the network and its capabilities both came back 409, which
       left the cloud marked unreachable and an empty capability map marked
       ready: the first Dashboard after the pick showed "Cloud unreachable"
       and every eero Plus feature as available. The picker calls this again
       once a network is picked. */
    if (!state.network_url) return
    api.get<NetworkSummary>('/api/network').then((n) => {
      setNet(n)
      setCloud(true)
      const memo = localStorage.getItem(`eeronaut:onSegment:${n?.name ?? ''}`)
      if (memo !== null) setOnSegment(memo === '1')
    }).catch(() => setCloud(false))
    api.get<Record<string, Capability>>('/api/network/capabilities')
      .then(setCaps).catch(() => {}).finally(() => setCapsReady(true))
    // The sweep takes a moment, so this lands after the memo above and
    // corrects it if the machine has moved networks.
    api.get<{ on_segment: boolean | null; network_name?: string }>('/api/local/status')
      .then((st) => {
        setOnSegment(st.on_segment)
        if (st.on_segment !== null && st.network_name) {
          localStorage.setItem(`eeronaut:onSegment:${st.network_name}`,
                               st.on_segment ? '1' : '0')
        }
      })
      .catch(() => {})
    // Local control should just work; enroll quietly in the background rather
    // than making the user turn it on. No-op once an identity exists.
    api.post('/api/local/ensure').catch(() => {})
  }, [])

  /* So the retry above can call the current one without the callback having to
     name itself. In an effect rather than in the render: a ref written during
     render is a render with a side effect, and this one is only ever read from
     a timer that cannot fire before the first effect has run. */
  useEffect(() => { reload.current = loadSession }, [loadSession])
  useEffect(() => () => window.clearTimeout(again.current), [])

  useEffect(() => { void loadSession() }, [loadSession])

  // A 401 from anywhere re-checks access, so an expired session surfaces as a
  // sign-in prompt instead of a page that silently stops working.
  useEffect(() => {
    const onUnauth = () => { void loadSession() }
    window.addEventListener('eeronaut:unauthenticated', onUnauth)
    return () => window.removeEventListener('eeronaut:unauthenticated', onUnauth)
  }, [loadSession])

  useEffect(() => {
    const root = document.documentElement
    // Only 'system' defers to the OS; light and dark are stamped explicitly so
    // the choice wins over prefers-color-scheme in both directions.
    if (prefs.appearance === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', prefs.appearance)
  }, [prefs.appearance])

  if (!access) return null
  /* Every screen is themed, the sign-in ones included, so the provider goes
     around all of them. The theme is the access state's until preferences
     have been read, which is after sign-in; from then on it is whatever
     Settings last applied. Both name the same installation-wide choice. */
  /* The language goes around every screen too. It used to start inside the
     signed-in tree, so the password, the eero sign-in, and the network
     picker were in English whatever the browser asked for, though every
     catalog translates them. Before sign-in the preference is `auto`, which
     is the browser's language. */
  return (
    <ThemeProvider id={prefs.theme || access.theme}>
      <I18nProvider lang={resolveLanguage(prefs.language)}>
        {gated()}
      </I18nProvider>
    </ThemeProvider>
  )

  function gated() {
  if (!access!.signed_in) {
    return <AppAccess state={access!} onDone={() => void loadSession()} />
  }
  if (!auth) return null
  if (!auth.authenticated) return <Login auth={auth} onDone={() => void loadSession()} />
  // Signed in but no network chosen yet: the account may own several, and every
  // network-scoped call 409s until one is picked.
  if (!auth.network_url) return <NetworkPicker onDone={() => void loadSession()} />

  return (
    <CapabilityProvider value={{ caps, capsReady, prefs, cloudOk: cloud,
                              premiumActive: net?.premium_status === 'active' }}>
      <ErrorBoundary onReset={() => void loadSession()}>
      <BrowserRouter>
        {/* Inside the router: an alert can carry a link. */}
        <AlertHost />
        <AppUpdateAlert />
        <Routes>
          <Route
            element={
              <Shell
                onSegment={onSegment}
                networkName={net?.name}
                status={<CloudStatus ok={cloud} />}
                alert={<WanAlert iface={outage} />}
                notifications={<Bell />}
              />
            }
          >
            <Route index element={<PageAt path="/" />} />
            <Route path="/clients" element={<PageAt path="/clients" />} />
            <Route path="/profiles" element={<PageAt path="/profiles" />} />
            <Route path="/topology" element={<PageAt path="/topology" />} />
            <Route path="/airtime" element={<PageAt path="/airtime" />} />
            {/* Reachable only from the network being viewed: the device list
                is built by listening on this server's own LAN, so from
                anywhere else it could only report somewhere else. */}
            <Route path="/internet" element={<PageAt path="/internet" />} />
            <Route path="/network" element={<PageAt path="/network" />} />
            <Route path="/security" element={<PageAt path="/security" />} />
            <Route path="/insights" element={<PageAt path="/insights" />} />
            <Route path="/settings"
                   element={<PageAt path="/settings" prefs={prefs} onPrefs={setPrefs} />} />
            {/* A theme's own pages, made of other pages' panes. */}
            <Route path="/v/:view"
                   element={<ViewAt prefs={prefs} onPrefs={setPrefs}
                                    networkName={net?.name} onSegment={onSegment} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </ErrorBoundary>
    </CapabilityProvider>
  )
  }
}
