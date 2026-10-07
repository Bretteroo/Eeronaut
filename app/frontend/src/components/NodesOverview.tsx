import { useEffect, useMemo, useRef, useState } from 'react'
import { accessoryStateHelp, nodeStateHelp } from '../lib/nodeHelp'
import { hasKnownUplink, uplinkName } from '../lib/mesh'
import { api, lastRead } from '../lib/api'
import { warmAccessoryDetails, warmNodeDetails } from '../lib/prefetch'
import { nodeStatusLabel, signalIssue } from '../lib/nodeStatusLabel'
import { Card, DataTable, Notice, StatusDot, type Column, SkeletonRows, useFold } from './primitives'
import { Pick } from './RadioAnalytics'
import { NodePanel, hasNightlightLamp, type NodeSummary } from './NodePanel'
import { EeroIcon, SignalIcon } from './DeviceIcon'
import { LinkBadge, Stem } from './meshLines'
import { SignalPanel } from './SignalPanel'
import { PlusSash } from '../lib/capabilities'
import { duration, since as uptime, meshRadioLabel } from '../lib/format'
import { t, tn } from '../i18n'
import { unreachable } from '../lib/nodes'
import { useRevalidate } from '../lib/revalidate'
import { nodeState, useWatchInterval } from '../lib/nodeState'

/* One row per eero and a mesh tree drawn from the same list, in the spirit of
   UniFi's device topology and device table. Everything here comes from
   /api/eeros, which already carries per-node client counts, uptime, power and
   the wireless-uplink pointer, so no per-node fetch is needed to draw it. */

interface Eero extends NodeSummary {
  connected_wireless_clients_count?: number
  connected_wired_clients_count?: number
  last_reboot?: string | null
  /** Set when eero's reboot time for this node cannot be true — see the
   *  backend's `reboot_claim_is_stale`. The node keeps the figure eero can
   *  still stand behind, which is how long it has been talking to the cloud. */
  reboot_time_stale?: boolean
  uptime?: { since_last_reboot_s?: number | null
             since_cloud_connection_s?: number | null } | null
  power_info?: { power_source?: string | null } | null
  wireless_upstream_node?: { node_or_proxied_node_id?: string | null
                             primary_mesh_radio?: string | null } | null
  ethernet_status?: { statuses?: { hasCarrier?: boolean; speed?: string
                                   isLeafWiredToUpstream?: boolean }[] } | null
  accessories?: { dsn?: string; model?: string; issue?: string | null
                  /* eero's name for the actual product. `model` is "eero
                     Signal" for both the 4G and the 5G, so it names the line
                     rather than the device; the backend resolves this from the
                     model number and falls back to `model` for anything it does
                     not recognize. */
                  product?: string | null
                  registered?: boolean; status_key?: string
                  status_label?: string
                  /* eero's fault code, which picks the translation of
                     `issue`. */
                  configuration_status?: string | null
                  properties?: { type?: string } }[] | null
}

/* How far a row sits from the gateway, in pixels. Small on a phone, where
   the name column is most of the width and a deep mesh would push a name off
   the edge. */
const indent = (depth?: number) => Math.min(3, depth ?? 0) * 14

/** The line up to the eero a row hangs off. */
function Elbow() {
  return (
    <span className="shrink-0 text-[var(--color-line-strong)]"
          aria-hidden="true">└</span>
  )
}

type Accessory = NonNullable<Eero['accessories']>[number]
interface Row extends Eero { accessory?: Accessory; parent?: string
                             depth?: number }

/** A reading that does not apply to this kind of row, said plainly rather than
 *  shown as a zero that would look like a measurement. */
const Blank = () => <span className="text-[var(--color-ink-3)]">—</span>

const upSeconds = (e: Eero) =>
  e.uptime?.since_last_reboot_s ?? e.uptime?.since_cloud_connection_s ?? null

const idOf = (e: Eero) => e.url.replace(/\/$/, '').split('/').pop() ?? ''


/** How a leaf reaches the network: a wireless uplink (with radio), a wired
 *  backhaul, or — for the gateway — the internet itself. */
function backhaul(e: Eero): {
  kind: 'wan' | 'wired' | 'wireless' | 'down'; label: string
} {
  // First, because it overrides both of the others — including the gateway's
  // "Internet", which is not true of a gateway nothing can reach.
  if (unreachable(e)) return { kind: 'down', label: t('nodes_overview.unavailable') }
  if (e.gateway) return { kind: 'wan', label: t('nodes_overview.internet') }
  if (e.wireless_upstream_node) {
    const radio = meshRadioLabel(e.wireless_upstream_node.primary_mesh_radio)
    return {
      kind: 'wireless',
      label: radio ? t('nodes_overview.wireless_radio', { radio })
                   : t('nodes_overview.wireless'),
    }
  }
  return { kind: 'wired', label: t('device_tree.wired') }
}

/* Which view the card opens on, remembered per browser. */
const VIEW_KEY = 'eeronaut.mesh-view'
type View = 'diagram' | 'list'
function savedView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'diagram' }
  catch { return 'diagram' }
}

/**
 * The eeros on the network, as one card with two views: the mesh diagram,
 * which shows how they connect, and the table, which says more about each.
 * They were two cards saying much the same thing one above the other; a
 * toggle in the header switches between them. Both views share the one
 * fetch and the two detail drawers.
 */
export function NodesOverview() {
  /* `view` is what the toggle says; `drawn` is what the card holds. They part
     for the length of a switch: the card closes on the old view, and only
     once it is shut does the new one go in and the card open again. Both
     movements are the card body's own height animation (`AutoHeight`), so
     nothing here races it: the body is held at zero height with the old view
     still drawn, and the card glides down clipping it, then grows to fit the
     new one. */
  const [view, setViewState] = useState<View>(savedView)
  const [drawn, setDrawn] = useState<View>(view)
  const [closing, setClosing] = useState(false)
  const swap = useRef(0)
  useEffect(() => () => clearTimeout(swap.current), [])
  const setView = (v: View) => {
    if (v === view) return
    setViewState(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* private mode */ }
    clearTimeout(swap.current)
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDrawn(v); setClosing(false); return
    }
    setClosing(true)
    // The body's height transition is 280ms; the swap waits for it to end.
    swap.current = window.setTimeout(() => { setDrawn(v); setClosing(false) }, 300)
  }
  /* Opens on the last list; `load` below asks for the current one. */
  const [eeros, setEeros] = useState<Eero[]>(
    () => lastRead<Eero[]>('/api/eeros') ?? [])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState<Eero | null>(null)
  const [signal, setSignal] = useState<{ dsn: string; name?: string } | null>(null)
  const [err, setErr] = useState('')

  const load = () => api.get<Eero[]>('/api/eeros')
    .then((e) => setEeros(e ?? []))
    .catch((e) => setErr(e.message))
    .finally(() => setLoaded(true))
  useEffect(() => { void load() }, [])

  /* Every drawer's contents, eeros' and Signals', fetched once the list is
     in and before anybody opens one. A detail is four reads of eero's
     cloud; opened cold it left the panel drawn and everything below the LED
     rows arriving a second and a half later. */
  useEffect(() => {
    if (!eeros.length) return
    warmNodeDetails(eeros.filter(hasNightlightLamp).map(idOf))
    warmAccessoryDetails(eeros.flatMap((e) => (e.accessories ?? []).map((a) => a.dsn ?? ''))
      .filter(Boolean))
  }, [eeros])

  /* This asked the server once and then never again, so a node that finished
     rebooting kept its orange "connecting" dot until somebody reloaded the
     page — the diagram said the mesh was still coming back long after it had.

     The cadence rule lives in lib/nodeState now, and it changed: it used to
     watch closely only while a node was yellow, which missed the case it was
     for. A restarting eero reports red or leaves the list, and red was being
     treated as settled. See watchInterval. */
  useRevalidate(load, useWatchInterval(eeros))

  const columns: Column<Row>[] = [
    {
      key: 'name', header: 'eero', stopsRowClick: false,
      sortValue: (e) => (e.location || e.serial || '').toLowerCase(),
      /* `order-last md:order-none` on both names: on a phone this table falls
         back to one line per column with the value right-aligned, so whatever
         comes last in the row lands against the right edge. With the name
         anywhere but last it floated mid-row with a gap after it, and a long
         one wrapped to two lines. Desktop keeps source order, where names line
         up in a column and anything leading would ragged them. */
      render: (e) => e.accessory ? (
        <span className="flex items-center gap-2"
              style={{ paddingLeft: indent(e.depth) }}>
          <Elbow />
          <span className="hidden md:inline-flex">
            <SignalIcon size={26} issue={signalIssue(e.accessory)} />
          </span>
          <StatusDot state={e.accessory.issue ? 'warn'
                            : e.accessory.registered ? 'ok' : 'idle'} 
                     title={accessoryStateHelp(e.accessory) ?? undefined} />
          <span className="order-last font-medium md:order-none">{e.location}</span>
        </span>
      ) : (
        <span className="flex items-center gap-2"
              style={{ paddingLeft: indent(e.depth) }}>
          {/* A leaf sits under the eero it reaches the network through, with
              a line up to it. The indent is the relationship; the elbow is
              what stops two indented rows in a row reading as one list with
              a wide margin. */}
          {(e.depth ?? 0) > 0 && <Elbow />}
          {/* The same glyph the Dashboard draws. A model name in a cell is a
              string to read; the silhouette is recognizable at a glance, and
              tells a Beacon from a Pro without either being spelled out. */}
          <span className="hidden md:inline-flex">
            <EeroIcon model={e.model} size={26} />
          </span>
          {/* The word as well as the color. A dot alone says an eero is not
              well and not what it is doing, and "Restarting" is the difference
              between waiting two minutes and going to look at it. This table
              is the dashboard's eero list now, which is where that used to be
              said. */}
          <StatusDot state={nodeState(e)} label={nodeStatusLabel(e)}
                     title={nodeStateHelp(e) ?? undefined} />
          <span className="order-last font-medium md:order-none">{e.location || e.serial}</span>
          {e.gateway && (
            /* `order-first` on mobile: ahead of the glyph, not merely ahead of
               the name. Which eero holds the internet connection is the first
               thing worth knowing about a row, and on a phone the row is read
               right to left from the name. */
            <span className="order-first rounded bg-[var(--color-accent-wash)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-ink)] md:order-none">
              {t('nodes_overview.gateway')}
            </span>
          )}
        </span>
      ),
    },
    { key: 'model', header: t('client_detail.model'), sortValue: (e) => e.model ?? '',
      render: (e) => e.model ?? '—' },
    {
      key: 'link', header: t('nodes_overview.column_backhaul'),
      /* A Signal's link is the USB-C port it plugs into, the same thing its
         badge on the mesh diagram says. Which eero that is shows in the
         table's own indentation, under its parent row. */
      sortValue: (e) => (e.accessory ? 'usb' : backhaul(e).kind),
      render: (e) => (
        <span className="text-[var(--color-ink-2)]">
          {e.accessory ? t('nodes_overview.usb_c') : backhaul(e).label}
        </span>
      ),
    },
    {
      key: 'clients', header: t('nav.clients'),
      sortValue: (e) => (e.connected_clients_count ?? 0),
      render: (e) => e.accessory ? <Blank /> : (
        <span className="tabular-nums">
          {e.connected_clients_count ?? 0}
          <span className="ml-1 text-[12px] text-[var(--color-ink-3)]">
            ({e.connected_wireless_clients_count ?? 0}w/{e.connected_wired_clients_count ?? 0}e)
          </span>
        </span>
      ),
    },
    // eero does not always know when a node last rebooted — it reports null for
    // one of these four — but it does know how long the node has been talking
    // to the cloud. That is a different measurement, so it is labeled as one
    // rather than passed off as uptime.
    { key: 'up', header: t('nodes_overview.column_uptime'),
      sortValue: (e) => upSeconds(e) ?? -1,
      render: (e) => {
        if (e.accessory) return <Blank />
        const boot = e.uptime?.since_last_reboot_s
        if (typeof boot === 'number') {
          return <span className="tabular-nums">{duration(boot)}</span>
        }
        const conn = e.uptime?.since_cloud_connection_s
        if (typeof conn === 'number') {
          return (
            <span className="tabular-nums text-[var(--color-ink-3)]"
                  title={e.reboot_time_stale
                    ? t('nodes_overview.reboot_time_cannot_be_right')
                    : t('nodes_overview.eero_reports_no_reboot_time')}>
              {t('nodes_overview.connected_for', { duration: duration(conn) })}
            </span>
          )
        }
        return <span className="tabular-nums">{uptime(e.last_reboot)}</span>
      } },
    { key: 'power', header: t('nodes_overview.power'), sortValue: (e) => e.power_info?.power_source ?? '',
      render: (e) => e.accessory ? <Blank /> : (e.power_info?.power_source ?? '—') },
    { key: 'fw', header: t('nodes_overview.column_firmware'), sortValue: (e) => e.os_version ?? '',
      render: (e) => e.accessory ? <Blank />
        : <span className="font-mono text-[12px]">{e.os_version ?? '—'}</span> },
  ]

  /* The list is the mesh: the gateway first, each leaf under the eero it
     reaches the network through, and an eero Signal under the eero it plugs
     into. A flat list in whatever order eero returned them said nothing about
     which node depends on which, and that is most of what somebody opens this
     for.

     Anything whose named uplink is not in the list falls to the gateway — a
     node that cannot be placed still has to be drawn — and a cycle cannot
     outlive the `seen` set, so a mesh eero reports oddly cannot loop here. */
  const rows: Row[] = useMemo(() => {
    const kids = new Map<string, Eero[]>()
    const gw = eeros.find((e) => e.gateway) ?? null
    for (const e of eeros) {
      if (e.gateway) continue
      const parent = hasKnownUplink(e, eeros)
        ? (uplinkName(e) as string) : (gw?.location ?? '')
      kids.set(parent, [...(kids.get(parent) ?? []), e])
    }
    const out: Row[] = []
    const seen = new Set<string>()
    const walk = (e: Eero, depth: number) => {
      if (seen.has(e.url)) return
      seen.add(e.url)
      out.push({ ...e, depth })
      for (const a of e.accessories ?? []) {
        out.push({
          url: `${e.url}#${a.dsn ?? 'accessory'}`,
          location: a.product || a.model || 'eero Signal',
          model: a.product || a.model,
          status: a.issue ? 'yellow' : a.registered ? 'green' : '',
          accessory: a, parent: e.location, depth: depth + 1,
        })
      }
      for (const k of kids.get(e.location ?? '') ?? []) walk(k, depth + 1)
    }
    if (gw) walk(gw, 0)
    // Anything the walk never reached, so nothing is silently dropped.
    for (const e of eeros) walk(e, 0)
    return out
  }, [eeros])

  return (
    <>
      <Card icon="map" title={t('nodes_overview.eero_mesh')} anchor="mesh"
            count={loaded ? rows.length : null}
            action={
              <div className="flex gap-1" role="group"
                   aria-label={t('nodes_overview.view')}>
                <Pick on={view === 'diagram'} onClick={() => setView('diagram')}>
                  {t('nodes_overview.view_diagram')}
                </Pick>
                <Pick on={view === 'list'} onClick={() => setView('list')}>
                  {t('nodes_overview.view_list')}
                </Pick>
              </div>
            }>
        <div style={closing ? { height: 0 } : undefined}
             inert={closing ? true : undefined}>
        {err ? (
          <Notice kind="bad">{err}</Notice>
        ) : drawn === 'diagram' ? (
          <MeshTree eeros={eeros} loaded={loaded} onPick={setOpen}
                    onPickAccessory={(dsn, name) => setSignal({ dsn, name })} />
        ) : (
          <DataTable
            loading={!loaded}
            columns={columns}
            rows={rows}
            rowKey={idOf}
            onRowClick={(r) => {
              if (r.accessory?.dsn) setSignal({ dsn: r.accessory.dsn, name: r.accessory.model })
              else if (!r.accessory) setOpen(r)
            }}
            /* Hardware, but useless without the subscription that carries its
               cellular plan, so it is marked like any other Plus feature. The
               mark belongs to the whole row: inline in the name column it
               competed with the name for the same line. */
            /* A row per device on a phone, not a card per device listing
               every column down the screen. Eight columns stacked made each
               eero a page of its own and the list a thing to scroll rather
               than read. The glyph, the name, the model, and the firmware fit
               on one line, which is what somebody is checking a phone for;
               the rest is a tap away in the drawer. */
            mobileRow={(r) => (
              <>
                <span className="shrink-0" style={{ paddingLeft: indent(r.depth) }} />
                {(r.depth ?? 0) > 0 && <Elbow />}
                {r.accessory
                  ? <SignalIcon size={20} issue={signalIssue(r.accessory)} />
                  : <EeroIcon model={r.model} size={20} />}
                <StatusDot state={r.accessory
                  ? (r.accessory.issue ? 'warn' : r.accessory.registered ? 'ok' : 'idle')
                  : nodeState(r)} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {r.location || r.serial}
                </span>
                <span className="shrink-0 truncate text-[11px] text-[var(--color-ink-3)]">
                  {r.model ?? ''}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--color-ink-3)]">
                  {r.accessory ? '' : (r.os_version ?? '')}
                </span>
              </>
            )}
            rowMark={(r) => (r.accessory
              ? <PlusSash name="cellular_backup" size={26} />
              : null)}
            empty={t('nodes_overview.eero_returned_no_nodes_network')}
          />
        )}
        </div>
      </Card>
      <NodePanel node={open} onClose={() => setOpen(null)} onChanged={load} />
      <SignalPanel dsn={signal?.dsn ?? null} fallbackName={signal?.name}
                   onClose={() => setSignal(null)} />
    </>
  )
}

/* A compact tree: the gateway on top, everything that meshes off it below,
   each link labeled with how the child connects. eero networks are shallow,
   so a two-tier layout reads better than a force-directed graph and needs no
   layout engine. */
function MeshTree({ eeros, loaded, onPick, onPickAccessory }:
  { eeros: Eero[]
    /* Whether the fetch has finished. Without it an empty list means both
       "still loading" and "no nodes", and this card returned null during the
       load — so the Devices card below took the top of the page and was then
       pushed down when this one appeared. */
    loaded: boolean
    onPick: (e: Eero) => void
    onPickAccessory: (dsn: string, name?: string) => void }) {
  /* Children keyed by the name of the eero they mesh to. eero's uplink block
     reports a node id that matches nothing else on the eero object, so keying
     by that put every wirelessly-meshed node under a parent that did not
     exist; the name in the same block is what actually resolves. Anything
     whose named parent is not in the list falls to the gateway, because a node
     that cannot be placed still has to be drawn. */
  const scroller = useRef<HTMLDivElement | null>(null)
  const fold = useFold(scroller, undefined, eeros.length)
  const { gateway, byUplink } = useMemo(() => {
    const gw = eeros.find((e) => e.gateway) ?? null
    const map = new Map<string, Eero[]>()
    for (const e of eeros) {
      if (e.gateway) continue
      const parent = hasKnownUplink(e, eeros)
        ? (uplinkName(e) as string)
        : (gw?.location ?? '')
      const arr = map.get(parent) ?? []
      arr.push(e)
      map.set(parent, arr)
    }
    return { gateway: gw, byUplink: map }
  }, [eeros])

  if (!gateway) {
    return loaded
      ? <p className="py-2 text-[13px] text-[var(--color-ink-3)]">
          {t('nodes_overview.eero_returned_no_nodes_network')}
        </p>
      : <SkeletonRows rows={3} cols={2} />
  }
  // Children that hang directly off the gateway (wired or wireless to it),
  // plus any whose named uplink we could not match, so nothing is dropped.
  // Children of the gateway, then everything else. A node that meshes to
  // another leaf is drawn beneath that leaf by Branch, so it must not also
  // appear here — `rest` is only what nothing has claimed.
  const direct = byUplink.get(gateway.location ?? '') ?? []
  const claimed = new Set<Eero>(direct)
  for (const [, kids] of byUplink) for (const k of kids) claimed.add(k)
  const rest = eeros.filter((e) => !e.gateway && !claimed.has(e))

  const Chip = ({ e }: { e: Eero }) => {
    const b = backhaul(e)
    return (
      <button
        type="button"
        onClick={() => onPick(e)}
        /* A box you can press rather than a control: a theme that gives its
           buttons one shape would otherwise draw this eero as a lozenge. */
        data-part="tile"
        /* One fixed width for every card in the tree — eero or Signal — so the
           columns are even. Letting a column take the width of whatever hung
           in it put a wider Signal card under one eero and shifted that whole
           column, so the gaps between siblings came out unequal. */
        className="flex w-36 flex-col items-center gap-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-center hover:border-[var(--color-accent)]"
      >
        <EeroIcon model={e.model} size={26} />
        <span className="flex max-w-full items-center gap-1.5">
          <StatusDot state={nodeState(e)} title={nodeStateHelp(e) ?? undefined} />
          <span className="truncate text-[13px] font-medium">{e.location || e.serial}</span>
        </span>
        <span className="max-w-full truncate text-[11px] text-[var(--color-ink-3)]">{e.model}</span>
        {/* The gateway has no backhaul line, because what it connects to is the
            internet. This says which node it is, in the slot the others use
            for how they get back to it. */}
        {e.gateway && b.kind !== 'down' && (
          <span className="rounded bg-[var(--color-accent-wash)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-ink)]">
            {t('nodes_overview.gateway')}
          </span>
        )}
        {(!e.gateway || b.kind === 'down') && (
          <span className="text-[11px]"
                style={{ color: b.kind === 'down' ? 'var(--color-bad)'
                  : b.kind === 'wireless'
                    ? 'var(--color-accent)' : 'var(--color-ink-3)' }}>
            {b.label}
          </span>
        )}
        <span className="text-[11px] text-[var(--color-ink-3)]">
          {tn('nodes_overview.client_count', e.connected_clients_count ?? 0)}
        </span>
      </button>
    )
  }

  /* An eero Signal is not a node of its own: it plugs into one eero and has no
     children. Drawing it beneath that eero is what says which one it is
     attached to, and matches how the phone app lists it. */
  /* Every line is the network's blue and moves; the kind of link is said by
     the badge riding it. Both pieces are shared with the Topology page's map,
     in meshLines.tsx, so the two diagrams draw a link the same way. Only a
     line to a node nothing can reach is different: gray and still. */
  /* 3px, not 1px. A hairline carries almost no color: at one device pixel
     the green and the blue were nearly indistinguishable, which defeats the
     point of coloring them at all.

     The kind of link rides the line as well as coloring it: a plug for a
     cable, the mesh's own bars for a radio link, each in a small squircle of
     the raised surface with the network's blue edge, so the stem reads as passing
     behind a badge rather than a gap. Color alone made wired and
     wireless a matter of telling green from blue; the glyph says it outright
     and the bars add how good the radio link is. A node nothing can reach
     gets a gray stem and no glyph, since whatever it linked over is carrying
     nothing now. */
  const Uplink = ({ e }: { e: Eero }) => {
    const b = backhaul(e)
    const kind = b.kind === 'down' ? 'down' : b.kind === 'wireless' ? 'wireless' : 'wired'
    /* The badge sits at the midpoint of the whole connection, equidistant
       from the eero above and the one below: the parent's stem and this
       child's are the same length, so that point is where the two meet — on
       the rail when there are siblings, on the joint when there are not.
       Centered on the stem's top edge rather than in the stem, which put it
       midway down the lower half only. */
    return (
      <div className="relative h-14 w-full">
        <Stem dir="v" still={kind === 'down'}
              className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2" />
        {kind !== 'down' && (
          <span className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
            <LinkBadge kind={kind} bars={e.mesh_quality_bars} title={b.label} />
          </span>
        )}
      </div>
    )
  }

  /* The horizontal rail that joins a parent to its children.
     Every node drew its own vertical stem, but nothing connected those stems to
     each other or to the eero above them, so a four-node mesh read as four
     unrelated stubs under a chip. The rail is the part that makes it a tree.

     Neutral, not green or blue. It spans children whose uplinks are different
     kinds — one wired, one meshed — and a single line can only be one color, so
     the rail carries structure and the colored stem under it carries the kind.
     That is the same reason the stems were per-node in the first place.

     Ends at the outermost children's centers rather than running past them:
     `left: 50%` on the first cell and `right: 50%` on the last. The cells pad
     instead of using a flex gap, because a gap is dead space the rail cannot
     cross and the line came out dashed. */
  const KidRow = ({ kids }: { kids: Eero[] }) => (
    <>
      {/* The same length as the stems below the rail, so the rail sits midway
          between the ranks rather than hugging the parent. */}
      <Stem dir="v" className="relative h-14 w-[3px]" />
      <div className="flex flex-wrap items-start justify-center">
        {kids.map((k, i) => (
          <div key={idOf(k)} className="relative px-1.5">
            {kids.length > 1 && (
              <div className="mesh-stem mesh-stem-h absolute top-0 h-[3px] rounded-full" aria-hidden
                   style={{ left: i === 0 ? '50%' : 0,
                            right: i === kids.length - 1 ? '50%' : 0 }} />
            )}
            <Branch e={k} />
          </div>
        ))}
      </div>
    </>
  )

  const Branch = ({ e }: { e: Eero }) => {
    const kids = e.gateway ? [] : (byUplink.get(e.location ?? '') ?? [])
    return (
    <div className="flex flex-col items-center">
      {!e.gateway && <Uplink e={e} />}
      <Chip e={e} />
      {(e.accessories ?? []).map((a, i) => (
        <div key={`${idOf(e)}-acc-${i}`} className="flex flex-col items-center">
          {/* A Signal plugs into its eero over USB-C, so its stem carries
              that port rather than an Ethernet plug. */}
          <div className="relative flex h-14 w-full items-center justify-center">
            <Stem dir="v" className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2" />
            <LinkBadge kind="usb" title={t('nodes_overview.usb_c')} />
          </div>
          <button
            type="button"
            onClick={() => a.dsn && onPickAccessory(a.dsn, a.product || a.model)}
            disabled={!a.dsn}
            data-part="tile"
            className="flex w-36 items-center gap-2 rounded-lg border border-dashed border-[var(--color-line)] px-2 py-1.5 text-left hover:border-[var(--color-accent)] disabled:cursor-default"
          >
            <SignalIcon size={22} issue={signalIssue(a)} />
            <span className="flex min-w-0 flex-col items-start">
              <span className="flex items-center gap-1.5">
                <StatusDot state={a.issue ? 'warn' : a.registered ? 'ok' : 'warn'}
                           title={accessoryStateHelp(a) ?? undefined} />
                <span className="text-[12px] font-medium">
              {a.product || a.model || t('nodes_overview.accessory_fallback')}
            </span>
              </span>
              <span className="text-[11px] text-[var(--color-ink-3)]">
                {nodeStatusLabel(a) ?? (a.issue ? signalIssue(a)
                  : a.properties?.type === 'cellular_backup' ? t('nodes_overview.cellular_backup') : t('nodes_overview.accessory'))}
              </span>
            </span>
          </button>
        </div>
      ))}
      {/* A node that meshes to this one rather than to the gateway is drawn
          beneath it, so the picture matches the path traffic actually takes. */}
      {kids.length > 0 && <KidRow kids={kids} />}
    </div>
    )
  }

  return (
    <>
      {/* Scrolling and centering have to be on separate elements. With both on
          one, content wider than the box overflows equally to left and right,
          and the left half is unreachable: scrollLeft cannot go negative, so
          the first node is simply cut off. The inner box is as wide as its
          content and at least as wide as the container, so it centers when
          there is room and scrolls from its true left edge when there is not. */}
      <div ref={scroller} className="overflow-x-auto py-2">
        {/* Folded, on a theme that asks for it, the box is only as wide as
            the card, so a row of eeros too long for it wraps onto a second. */}
        <div className={`flex ${fold ? 'w-full' : 'w-max min-w-full'} flex-col items-center`}>
        <Branch e={gateway} />
        {[...direct, ...rest].length > 0 && (
          <KidRow kids={[...direct, ...rest]} />
        )}
        </div>
      </div>
    </>
  )
}
