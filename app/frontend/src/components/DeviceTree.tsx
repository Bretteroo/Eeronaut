import { useEffect, useMemo, useRef, useState } from 'react'
import { CableDataIcon } from './DeviceIcon'
import { hasKnownUplink, meshesTo } from '../lib/mesh'
import { api } from '../lib/api'
import { Card, Drawer, SignalBars, StatusDot, useFold } from './primitives'
import { clientBars } from '../lib/signal'
import { LinkBadge, Stem } from './meshLines'
import { EeroIcon } from './DeviceIcon'
import { ClientDetail } from './ClientDetail'
import { DeviceIcon } from './DeviceIcon'
import { t, tn } from '../i18n'

/* An org-chart of the network: the internet at the root, the gateway eero
   beneath it, the mesh eeros beneath that, and every client grouped under the
   eero it is actually connected to — the view UniFi calls the topology map.
   Clients come from /api/devices, which carries `source` (the eero each one is
   on); eeros come from /api/eeros. Each eero is collapsible because a busy
   network has far too many clients to show flat.

   Where several wired clients arrive on one eero port, something is bridging
   them onto it, and they are drawn under a switch node rather than hanging off
   the eero directly. The node is unnamed on purpose: a switch is often not a
   client at all (an unmanaged one takes no DHCP lease and eero never sees it),
   and where it is, nothing distinguishes it from the devices behind it. So the
   drawing states the switch exists — which is certain — without claiming to
   know which box it is. */

interface Eero {
  url: string; location?: string; serial?: string; model?: string
  gateway?: boolean; status?: string
  // Which eero and which of its ports this one is cabled to. eero reports it
  // from the leaf's side only — the gateway does not list its neighbors.
  ethernet_status?: {
    statuses?: {
      port_name?: string | null
      neighbor?: { metadata?: { url?: string | null
                                port_name?: string | null } | null } | null
    }[] | null
  } | null
  wireless_upstream_node?: {
    name?: string | null
    node_or_proxied_node_id?: string | number | null
  } | null
  /** eero's 1-5 rating of the mesh link, drawn on the line to this eero. */
  mesh_quality_bars?: number | null
}
interface Device {
  url: string; nickname?: string | null; hostname?: string | null
  display_name?: string | null; mac?: string | null; ip?: string | null
  connected?: boolean; wireless?: boolean; device_type?: string | null
  connectivity?: {
    signal?: string | null; score_bars?: number | null
    ethernet_status?: { port_name?: string | null } | null
  } | null
  source?: { url?: string | null } | null
}

/** A switch eero cannot see, inferred from what arrives on one of its ports.
 *
 *  Two independent signals, either of which is conclusive: more than one wired
 *  client on the port, or more than one eero cabled to it. A physical port
 *  carries one device, so anything else means something is bridging them. */
interface Switch {
  id: string
  host: string          // the eero whose port this is
  port: string
  clients: Device[]
  eeros: Eero[]
}

/** eero's own diagnosis of the WAN, which is what the root node reports. */
interface Health {
  internet?: string | null
  isp_up?: boolean | null
}

/** A node in the drawing: an eero, or a switch beneath one. */
interface Node {
  key: string
  kind: 'eero' | 'switch'
  eero?: Eero
  sw?: Switch
  clients: Device[]
  children: Node[]
  /** How this node reaches its parent, which is what colors the line. */
  link?: 'wired' | 'wireless' | 'unknown'
}

/** eero reports signal as "-67 dBm"; the bars want the number. */
const dbmOf = (s?: string | null): number | null => {
  const m = s ? /-?\d+/.exec(s) : null
  const n = m ? Number(m[0]) : null
  // A wired client reports 0 dBm, which is not a signal reading.
  return n === null || n === 0 ? null : n
}

/* The cable, for a client that arrived over one: the same mark the diagram's
   lines and the Clients table use, opposite the signal meter a wireless client
   gets. Green because a cabled client is the best case — nothing to degrade. */
function RJ45() {
  return <CableDataIcon size={16} title={t('device_tree.wired')} className="shrink-0" />
}

/* A switch, in the weight the eero glyphs are drawn at.
   Composition follows Material Design Icons' `server-network-outline` — a rack
   unit with port marks, dropping onto a bus that runs out both sides — but the
   geometry is redrawn rather than copied. MDI's outline icons are filled paths
   that trace a roughly 2-unit border on a 24 grid, about 8% of the icon's
   width; the eero glyphs are filled paths tracing a 1-unit border on a 32 grid,
   about 3%. Dropping MDI's path in beside them put a mark of nearly three times
   the weight in the same column, and a filled outline cannot be thinned — the
   thickness is the geometry. So this is stroked instead, at a width chosen to
   sit level with the eeros beside it. */
function SwitchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-[var(--color-accent)]"
         fill="none" stroke="currentColor" strokeWidth={0.75}
         strokeLinecap="round" strokeLinejoin="round"
         role="img" aria-label={t('device_tree.network_switch')}>
      <title>{t('device_tree.network_switch')}</title>
      {/* The unit, and the ports along its face. */}
      <rect x="2.6" y="5.4" width="18.8" height="7.2" rx="1.2" />
      <rect x="5" y="8" width="2.2" height="2.2" rx="0.4" />
      <path d="M9.6 8v2.2" />
      {/* Down onto the bus, and the bus out to both edges. */}
      <path d="M12 12.6v2.3" />
      <rect x="10" y="14.9" width="4" height="4.2" rx="0.9" />
      <path d="M2.6 17H10M14 17h7.4" />
    </svg>
  )
}

const eeroId = (u?: string | null) => (u ?? '').replace(/\/$/, '').split('/').pop() ?? ''

export function DeviceTree() {
  const [eeros, setEeros] = useState<Eero[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  /* Whether the client list has answered, which an empty list cannot say:
     a network with no clients answers with one. */
  const [devicesIn, setDevicesIn] = useState(false)
  const [health, setHealth] = useState<Health | null>(null)
  /* Collapsed state, keyed by node — an entry only exists for a node somebody
     has closed. The map opens fully, because a topology map that has to be
     unfolded one eero at a time is not showing the topology: the point of the
     page is seeing where everything sits at once, and every visit started with
     that hidden. Recording the exception rather than the rule also means a node
     that appears later is open like the rest, with no key list to keep in step
     with the tree. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<Device | null>(null)

  /* Where the map opens, on a viewport too narrow to hold it.
     The box is as wide as the widest rank — several screens across on a phone —
     and a scroll container starts at its left edge, so the map opened on
     whichever eero happened to be leftmost with the internet and the gateway
     off past the right of the screen. Centering puts the root where the eye
     starts.

     Once only, and above the early return so the hook count cannot change
     between renders: this is where the map opens, not where it stays, and
     re-centering later would yank the view back mid-read. */
  const scroller = useRef<HTMLDivElement | null>(null)
  const centered = useRef(false)
  /* Too wide for its column, on a theme that would rather the map took a
     narrower shape than scrolled: the outline below. */
  const outline = useFold(scroller, undefined, eeros.length + devices.length)
  /* Not until the client list has answered as well: clients hang under the
     eeros and widen the ranks, so centering on the eeros alone left the map
     opening off to one side once they arrived. Answered, not non-empty: a
     network with no clients still centers its internet and eeros. */
  useEffect(() => {
    const el = scroller.current
    if (!el || centered.current || !eeros.length || !devicesIn) return
    if (el.scrollWidth <= el.clientWidth) return   // it fits; nothing to center
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
    centered.current = true
  }, [eeros, devices, devicesIn])

  useEffect(() => {
    api.get<Eero[]>('/api/eeros').then((e) => setEeros(e ?? [])).catch(() => {})
    api.get<Device[]>('/api/devices').then((d) => setDevices(d ?? [])).catch(() => {})
      .finally(() => setDevicesIn(true))
    api.get<Health>('/api/network/health').then(setHealth).catch(() => setHealth(null))
  }, [])

  const byName = (a: Device, b: Device) =>
    // Sorted by what the row actually shows, which includes display_name;
    // without it those rows sorted as blanks and the list read as unsorted.
    (a.nickname || a.hostname || a.display_name || a.mac || '')
      .localeCompare(b.nickname || b.hostname || b.display_name || b.mac || '')

  const tree = useMemo(() => {
    const gateway = eeros.find((e) => e.gateway) ?? null

    /** The eero and port a wired eero is cabled to, from its own report. */
    const uplinkOf = (e: Eero): { host: string; port: string } | null => {
      for (const st of e.ethernet_status?.statuses ?? []) {
        const m = st.neighbor?.metadata
        if (m?.url && m.port_name) {
          return { host: eeroId(m.url), port: String(m.port_name) }
        }
      }
      return null
    }

    // Everything attached to each (eero, port): wired clients and cabled eeros.
    const onPort = new Map<string, { clients: Device[]; eeros: Eero[] }>()
    const slot = (host: string, port: string) => {
      const k = `${host}:${port}`
      if (!onPort.has(k)) onPort.set(k, { clients: [], eeros: [] })
      return onPort.get(k)!
    }
    const clientsOf = new Map<string, Device[]>()
    for (const d of devices) {
      if (!d.connected) continue
      const host = eeroId(d.source?.url)
      const port = d.connectivity?.ethernet_status?.port_name
      if (!d.wireless && port) slot(host, String(port)).clients.push(d)
      else {
        const arr = clientsOf.get(host) ?? []
        arr.push(d)
        clientsOf.set(host, arr)
      }
    }
    const uplinks = new Map<string, { host: string; port: string } | null>()
    for (const e of eeros) {
      const up = e.gateway ? null : uplinkOf(e)
      uplinks.set(eeroId(e.url), up)
      if (up) slot(up.host, up.port).eeros.push(e)
    }

    // A port with more than one thing on it is a switch. One thing is just
    // that thing, cabled straight into the port.
    const switches = new Map<string, Switch>()
    for (const [k, v] of onPort) {
      const [host, port] = k.split(':')
      if (v.clients.length + v.eeros.length > 1) {
        switches.set(k, { id: k, host, port, clients: v.clients.sort(byName),
                          eeros: v.eeros })
      } else {
        // Straight into the eero: fold its client back in with the wireless
        // ones so it still appears under that eero.
        for (const d of v.clients) {
          const arr = clientsOf.get(host) ?? []
          arr.push(d)
          clientsOf.set(host, arr)
        }
      }
    }

    const nodeForEero = (e: Eero, link: Node['link'] = 'unknown'): Node => {
      const id = eeroId(e.url)
      const kids: Node[] = []
      // Switches on this eero's own ports.
      for (const sw of switches.values()) {
        if (sw.host === id) kids.push(nodeForSwitch(sw))
      }
      // eeros cabled straight into one of its ports, and any that reach it
      // wirelessly.
      for (const other of eeros) {
        if (other === e) continue
        const up = uplinks.get(eeroId(other.url))
        const cabledHere = up && up.host === id && !switches.has(`${id}:${up.port}`)
        // Meshed here if it names this eero as its uplink; and, so that no node
        // is ever dropped, one whose uplink names an eero not in the list hangs
        // off the gateway rather than nowhere.
        const meshedHere = !up && (hasKnownUplink(other, eeros)
          ? meshesTo(other, e)
          : Boolean(e.gateway))
        if (cabledHere || meshedHere) {
          kids.push(nodeForEero(other, cabledHere ? 'wired' : 'wireless'))
        }
      }
      return { key: `e:${id}`, kind: 'eero', eero: e, link,
               clients: (clientsOf.get(id) ?? []).sort(byName), children: kids }
    }

    // A switch is cabling, so it and everything hanging off it is wired.
    const nodeForSwitch = (sw: Switch): Node => ({
      key: `s:${sw.id}`, kind: 'switch', sw, clients: sw.clients, link: 'wired',
      children: sw.eeros.map((e) => nodeForEero(e, 'wired')),
    })

    return gateway ? nodeForEero(gateway)
      : (eeros[0] ? nodeForEero(eeros[0]) : null)
  }, [eeros, devices])

  if (!eeros.length || !tree) return null

  function ClientRow({ d }: { d: Device }) {
    return (
      <li className="border-b border-[var(--color-line)] last:border-0">
        <button
          type="button"
          onClick={() => setPicked(d)}
          data-part="map-client"
          className="flex w-full items-center gap-2 py-1 text-left text-[13px] hover:bg-[var(--color-surface-2)]"
        >
          {/* Both marks occupy the same fixed width, so the columns after them
              line up whatever mix of wired and wireless clients there is. */}
          <span className="flex w-5 shrink-0 justify-center">
            {d.wireless
              ? <SignalBars value={clientBars({
                              rating: d.connectivity?.score_bars,
                              dbm: dbmOf(d.connectivity?.signal) })}
                            dbm={dbmOf(d.connectivity?.signal)}
                            reading="tooltip" />
              : <RJ45 />}
          </span>
          <DeviceIcon type={d.device_type} size={16} />
          <span className="min-w-0 flex-1 truncate">
            {d.nickname || d.hostname || d.display_name || d.mac}
          </span>
        </button>
      </li>
    )
  }

  function NodeCard({ n }: { n: Node }) {
    const open = !collapsed[n.key]
    const e = n.eero
    const state = !e ? 'ok'
      : e.status === 'green' || e.status === 'connected' ? 'ok'
      : e.status === 'yellow' ? 'warn' : e.status ? 'bad' : 'idle'
    const count = n.clients.length
    return (
      <div className="rounded-lg border border-[var(--color-line)]">
        <button
          type="button"
          onClick={() => setCollapsed((x) => ({ ...x, [n.key]: !x[n.key] }))}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2
                     text-left transition-colors hover:bg-[var(--color-surface-2)]"
          title={n.kind === 'switch'
            ? t('device_tree.switch_bridging', {
                count: n.sw!.clients.length + n.sw!.eeros.length,
                port: n.sw!.port,
              })
            : undefined}
        >
          <span className="flex min-w-0 items-center gap-2">
            {/* The model's own glyph ahead of the dot, so a row says what the
                hardware is before it says how it is doing — the same order the
                mesh card on the Dashboard uses. A switch has no eero glyph
                because it is not an eero; the switch glyph stands in for
                both the hardware and its state. */}
            {n.kind === 'switch' ? <SwitchIcon /> : (
              <>
                <EeroIcon model={e!.model} size={20} />
                <StatusDot state={state} />
              </>
            )}
            <span className="truncate text-[13px] font-medium">
              {n.kind === 'switch' ? t('device_tree.network_switch') : (e!.location || e!.serial)}
            </span>
            {e?.gateway && (
              <span className="shrink-0 rounded bg-[var(--color-accent-wash)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-ink)]">
                {t('device_tree.gateway')}
              </span>
            )}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[12px] text-[var(--color-ink-3)]">
            {tn('device_tree.clients', count)}
            <span className="ml-1">{open ? '\u25be' : '\u25b8'}</span>
          </span>
        </button>
        {open && (
          <ul className="border-t border-[var(--color-line)] px-3 py-2">
            {count === 0 && (
              <li className="py-1 text-[12px] text-[var(--color-ink-3)]">
                {t('device_tree.nothing_connected_here')}
              </li>
            )}
            {n.clients.map((d) => <ClientRow key={d.url} d={d} />)}
          </ul>
        )}
      </div>
    )
  }

  /* eero reports the WAN as `internet.status` with an `isp_up` flag beside it.
     Both have to agree before it is called up: the status can read connected
     while the provider itself is unreachable. */
  const internet = (() => {
    if (!health || health.internet == null) {
      return { state: 'unknown' as const, title: t('device_tree.checking_connection') }
    }
    const up = health.internet === 'connected' && health.isp_up !== false
    return up
      ? { state: 'up' as const, title: t('app.connected') }
      : {
          state: 'down' as const,
          title: health.isp_up === false
            ? t('device_tree.your_provider_not_reachable')
            // eero's own word for the state was passed in here, so every
            // language read "Internet disconnected" in English.
            : t(health.internet === 'rebooting' ? 'device_tree.gateway_restarting'
                                                : 'device_tree.internet_not_connected'),
        }
  })()

  /* The same lines and badges as the dashboard's mesh diagram, from
     meshLines.tsx: every line the network's blue with traffic drifting both
     ways, and the kind of link — cable or radio — said by the badge on the
     drop line into each child, which is the line that *is* the link. The
     rail joining siblings is layout rather than a connection, but it moves
     too, so the picture reads as one live thing. */
  /* The same length as the drop lines below a rail, so a rail sits midway
     between ranks and the line shows above and below a badge. */
  const Line = () => <Stem dir="v" className="relative h-14 w-[3px]" />

  /** One level and everything beneath it. */
  /* One node and everything under it.
     Children are laid out as a centered wrapping row rather than a fixed grid:
     a grid gives every level the same column count, so a lone child sits in
     the first column while the line joining it to its parent runs down the
     middle. Wrapping keeps one child centered under its parent and lets five
     spread across the width. */
  function Branch({ n }: { n: Node }) {
    return (
      <div className="flex flex-col items-center">
        {/* Every card is the same fixed width at every depth, so a row of
            children reads as one rank. Letting them grow meant three siblings
            widened until only two fit and the third wrapped onto its own
            line, which looked like a broken level rather than a full one. */}
        <div className="w-72 shrink-0"><NodeCard n={n} /></div>
        {n.children.length > 0 && (
          <>
            <Line />
            {/* No wrapping: the rail is drawn across one row, and the card
                scrolls sideways instead of breaking the row in two. */}
            <div className="flex flex-nowrap items-start justify-center">
              {n.children.map((c, i) => {
                const first = i === 0
                const last = i === n.children.length - 1
                const only = n.children.length === 1
                return (
                  <div key={c.key} className="relative px-2 pt-14">
                    {!only && (
                      <span
                        aria-hidden="true"
                        className="mesh-stem mesh-stem-h absolute top-0 h-[3px] rounded-full"
                        style={{
                          left: first ? '50%' : 0,
                          right: last ? '50%' : 0,
                        }}
                      />
                    )}
                    <Stem dir="v" still={!c.link || c.link === 'unknown'}
                          className="absolute left-1/2 top-0 h-14 w-[3px] -translate-x-1/2" />
                    {/* The kind of link, on the line, at the midpoint between
                        parent and child: on the rail, since the stems above
                        and below it match. A switch is cabling, so its badge
                        is the cable; a meshed eero gets its own rating as
                        bars. */}
                    {c.link && c.link !== 'unknown' && (
                      <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
                        <LinkBadge kind={c.link} bars={c.eero?.mesh_quality_bars}
                                   title={c.link === 'wired' ? t('device_tree.wired')
                                                             : t('node_panel.wireless_uplink')} />
                      </span>
                    )}
                    <Branch n={c} />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    )
  }

  /* The same tree as an outline, each node's children listed under it and
     indented, for a column too narrow for the tree laid out across: one
     line down the left from each parent, a short one across to each child,
     and the link's badge on that. How far each level
     is indented is `--outline-indent`, for a theme with less room. */
  function Outline({ n }: { n: Node }) {
    return (
      <div className="min-w-0">
        <NodeCard n={n} />
        {n.children.length > 0 && (
          <ul data-part="map-outline" className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 pl-[var(--outline-indent,4rem)]">
            {n.children.map((c, i) => {
              const last = i === n.children.length - 1
              const still = !c.link || c.link === 'unknown'
              return (
                <li key={c.key} className="relative min-w-0">
                  {/* Down from the one above to this child's own line, and on
                      past it to the next child unless this is the last. */}
                  <Stem dir="v" still={still}
                        className={`absolute left-[calc(1.25rem-var(--outline-indent,4rem))] -top-3 w-[3px] ${last ? 'h-[2.1rem]' : '-bottom-3'}`} />
                  <Stem dir="h" still={still}
                        className="absolute left-[calc(1.25rem-var(--outline-indent,4rem))] top-[1.35rem] h-[3px] w-[calc(var(--outline-indent,4rem)-1.25rem)]" />
                  {c.link && c.link !== 'unknown' && (
                    <span className="absolute left-[calc(1.25rem-var(--outline-indent,4rem))] top-[1.45rem] z-10 -translate-x-1/2 -translate-y-1/2">
                      <LinkBadge kind={c.link} bars={c.eero?.mesh_quality_bars}
                                 title={c.link === 'wired' ? t('device_tree.wired')
                                                           : t('node_panel.wireless_uplink')} />
                    </span>
                  )}
                  <Outline n={c} />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }

  return (
    <Card icon="map" title={t('device_tree.network_map')} anchor="map">
      <div ref={scroller} className="overflow-x-auto">
        {/* w-max so the box is as wide as the tree and scrolls from its left
            edge; min-w-full so it still centers when the tree fits. */}
        <div className={`flex flex-col ${outline ? 'w-full items-start' : 'w-max min-w-full items-center'}`}>
          {/* The root reports the state of the connection it stands for, using
              eero's own diagnosis rather than anything measured here. Until it
              answers, neither claim is made: drawing an unknown WAN as a fault
              is exactly the bug the dashboard once had. */}
          <div className="flex items-center gap-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] px-3 py-1.5 text-[13px] font-medium"
               title={internet.title}>
            {internet.state === 'unknown' ? (
              <span className="size-2 rounded-full bg-[var(--color-line-strong)]"
                    aria-hidden="true" />
            ) : internet.state === 'up' ? (
              <svg viewBox="0 0 24 24" className="size-4 text-[var(--color-ok)]"
                   fill="currentColor" role="img" aria-label={t('device_tree.internet_up')}>
                <title>{internet.title}</title>
                <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1.2 14.2 6.4-6.4-1.4-1.4-5 5-2.6-2.6-1.4 1.4Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-4 text-[var(--color-bad)]"
                   fill="currentColor" role="img" aria-label={t('device_tree.internet_down')}>
                <title>{internet.title}</title>
                <path d="M12 2 23 21H1L12 2Z" />
                <path d="M11 9h2v6h-2zm0 7h2v2h-2z" fill="var(--color-surface)" />
              </svg>
            )}
            {t('device_tree.internet')}
          </div>
          {/* In the outline the root line runs down the left, under the
              Internet's own mark, rather than down the middle. */}
          <div className={outline ? 'ml-5' : ''}><Line /></div>
          {outline
            ? <div className="w-full max-w-xl"><Outline n={tree} /></div>
            : <Branch n={tree} />}
        </div>
      </div>
      <Drawer
        open={Boolean(picked)}
        onClose={() => setPicked(null)}
        title={picked?.nickname || picked?.hostname || picked?.display_name
               || picked?.mac || t('device_tree.client')}
      >
        {picked?.mac && <ClientDetail mac={picked.mac} />}
      </Drawer>
    </Card>
  )
}
