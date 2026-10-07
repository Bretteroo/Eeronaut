import { useEffect, useState } from 'react'
import { api, lastRead, ApiError } from '../lib/api'
import {
  Drawer, EditableText, Notice, SignalBars, SkeletonRows, StatusDot,
  SubmitButton, Toggle,
  useNotice,
  type State,
} from './primitives'
import { CableDataIcon, EeroIcon } from './DeviceIcon'
import { useClock } from '../lib/clock'
import { t } from '../i18n'
import { unreachable } from '../lib/nodes'
import { nodeStateHelp } from '../lib/nodeHelp'
import { meshBars } from '../lib/signal'

export interface NodeSummary {
  url: string
  location?: string
  serial?: string
  model?: string
  status?: string
  gateway?: boolean
  os_version?: string
  ip_address?: string
  mac_address?: string
  connected_clients_count?: number
  connected_wired_clients_count?: number
  mesh_quality_bars?: number
  status_key?: string
  status_label?: string
  led_on?: boolean
  led_brightness?: number
  nightlight?: unknown
  // Raw accessories as eero returns them on the node: the Signal is an
  // accessory of an eero, not an eero of its own.
  accessories?: Accessory[] | null
  /** Which eero this one meshes to over Wi-Fi, by name, with the radio it
   *  uses. Absent on the gateway and on a wired leaf. See lib/mesh.ts for why
   *  the name and not the id is what resolves. */
  wireless_upstream_node?: {
    name?: string | null
    primary_mesh_radio?: string | null
    node_or_proxied_node_id?: string | number | null
  } | null
}

/** An eero Signal, as the node list carries it. The identifiers eero puts on
 *  the raw object are stripped server-side, so nothing here can leak a SIM. */
export interface Accessory {
  dsn?: string
  model?: string
  /** eero's name for the actual product. Both the 4G and the 5G Signal report
   *  `model` as a bare "eero Signal", which names the line rather than the
   *  device; the backend resolves this from the model number, which is the only
   *  field that separates them, and falls back to `model` when it does not
   *  recognize one. */
  product?: string | null
  name?: string
  registered?: boolean
  issue?: string | null
  status_key?: string
  status_label?: string
  variant?: string | null
  joined?: string | null
  configuration_status?: string | null
  cellular?: { bars?: number | null; carrier?: string | null
               status?: string | null } | null
  properties?: { type?: string } | null
}

interface Port {
  name: string; connected: boolean | null; speed_mbps: number | null
  role: string; uplink: boolean; poe: unknown; mac: string | null
  peer?: { name: string; kind?: string | null; is_gateway?: boolean
           port?: string | null; count?: number | null } | null
  neighbor: unknown; tx_bytes: number | null; rx_bytes: number | null
}
interface NodeDetail {
  model_number?: string; last_reboot?: string | null; gateway?: boolean
  clients?: { wireless?: number | null; wired?: number | null; total?: number | null }
  mesh?: { wireless_uplink?: boolean; uplink_node_id?: string | null
           uplink_name?: string | null
           uplink_radio?: string | null; quality_bars?: number | null }
  power?: { source?: string | null; provides_poe?: boolean }
  ports?: Port[]
  bssids?: { band: string | null; bssid: string | null }[]
  accessories?: {
    model?: string; model_number?: string | null; variant?: string | null
    issue?: string | null
    fcc_id?: string | null; ic_id?: string | null
    kind?: string; registered?: boolean
    carrier?: string | null; signal_score?: number | null; status?: string | null
    provider?: string | null
    used_kb?: number | null; max_kb?: number | null; unlimited?: boolean
    cycle_end?: string | null
  }[]
}
interface Schedule { enabled: boolean; on: string; off: string }
interface Nightlight {
  enabled: boolean
  brightness_percentage?: number | null
  schedule?: Schedule | null
}


const idOf = (n: NodeSummary) => n.url.replace(/\/$/, '').split('/').pop() ?? ''

/** Whether this eero has an ambient nightlight, by eero's own rule: the cloud
 *  populates the `nightlight` object only for models that carry the lamp. A
 *  node with the field absent or null does not have one. */
export function hasNightlightLamp(n: Pick<NodeSummary, 'nightlight'>): boolean {
  return n.nightlight != null
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--color-line)] py-2 last:border-0">
      <span className="text-[13px] text-[var(--color-ink-2)]">{label}</span>
      <span className="text-right text-[13px] font-medium">{children}</span>
    </div>
  )
}

export function NodePanel(
  { node, onClose, onChanged }:
  { node: NodeSummary | null; onClose: () => void; onChanged?: () => void },
) {
  const { when } = useClock()
  const [detail, setDetail] = useState<NodeDetail | null>(
    () => (node ? lastRead<NodeDetail>(`/api/eeros/${idOf(node)}/detail`) ?? null : null))
  const [nl, setNl] = useState<Nightlight | null>(null)
  const [busy, setBusy] = useState(false)
  const [led, setLed_] = useState(false)
  const say = useNotice()

  // The nightlight lives only on models that physically have one (the Beacon).
  // eero's own app gates the control on `nightlight != null` — its cloud fills
  // the object in for those models and leaves it null otherwise — so this uses
  // the same rule rather than a hardware list that could fall behind new
  // models. hasNightlightLamp is defined once, below, so the rule has a name.
  const hasNightlight = !!node && hasNightlightLamp(node)

  /* Read from the cache first, in the same breath as the render rather than a
     promise later. The table warms every eero's detail as it loads (see
     `warmNodeDetails`), so by the time somebody opens one the answer is
     usually here — and going through `api.get` alone would still cost a frame
     with nothing in it, which is the flash this is avoiding. */
  useEffect(() => {
    if (!node) { setDetail(null); return }
    const path = `/api/eeros/${idOf(node)}/detail`
    const warm = lastRead<NodeDetail>(path) ?? null
    setDetail(warm)
    api.get<NodeDetail>(path)
      .then(setDetail)
      // A failed refresh leaves what was already there. Clearing it would
      // take a panel that is drawn and correct and blank it.
      .catch(() => { if (!warm) setDetail(null) })
  }, [node])

  /* Keyed on the node, not on `say`. The card's notice object is rebuilt
     every render, so listing it would clear the notice and refetch on every
     render — including the render its own success message causes.
*/
  useEffect(() => {
    setNl(null); say.clear()
    if (!node || !hasNightlight) return
    api.get<Nightlight>(`/api/eeros/${idOf(node)}/nightlight`)
      .then(setNl).catch(() => say.fail(t('node_panel.could_not_read_nightlight_settings')))
  }, [node, hasNightlight])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return null
  const id = idOf(node)
  const state: State =
    node.status === 'green' || node.status === 'connected' ? 'ok'
    : node.status === 'yellow' ? 'warn' : node.status ? 'bad' : 'idle'

  const down = unreachable(node)
  /* The sentence for an amber state — restarting, updating, joining, or a
     yellow light with nothing more specific — shown where the unreachable
     alert would be, and as the hover on the status dot in the header. */
  const help = down ? null : nodeStateHelp(node)

  async function setLed(choice: string) {
    setLed_(true); say.clear()
    try {
      await api.put(`/api/eeros/${id}/led`,
                    choice === 'off' ? { on: false }
                                     : { on: true, brightness: Number(choice) })
      onChanged?.()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('node_panel.light_failed'))
    } finally { setLed_(false) }
  }

  /* Which physical unit is this one? The names are chosen by whoever set the
     network up and a house can easily hold three identical white boxes, so
     the answer is to make one of them blink. eero's own app calls it
     identify; it cycles the LED blue and white for ten seconds and stops by
     itself, which is why this needs no confirmation and no way to cancel. */
  async function identify() {
    setLed_(true); say.clear()
    try {
      await api.post(`/api/eeros/${node!.serial}/identify`, {})
      say.ok(t('node_panel.identifying', {
        name: node!.location || node!.serial || 'eero' }))
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('node_panel.identify_failed'))
    } finally { setLed_(false) }
  }

  /* Both of these are hard to undo, so both go through a confirmation that
     names the eero and says what happens. `window.confirm` rather than a
     bespoke modal: it is what the bridge-mode and VLAN-tag changes already use,
     and a second dialog style for the same job would be worse than a plain
     one. */
  async function rebootNode() {
    const name = node!.location || node!.serial || 'eero'
    /* The gateway is a different question from a leaf, and the numbers are not
       close. A leaf came back in 1m56s measured, and only its own clients
       noticed. Rebooting the gateway drops the whole network. Telling somebody
       "about two minutes" before they take their internet away would be the
       wrong half of the truth. */
    const key = node!.gateway ? 'node_panel.confirm_reboot_gateway'
                              : 'node_panel.confirm_reboot'
    if (!window.confirm(t(key, { name }))) return
    setBusy(true); say.clear()
    try {
      await api.post(`/api/eeros/${id}/reboot`, { confirm: id })
      say.ok(t('node_panel.rebooting', { name }))
      onChanged?.()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('node_panel.reboot_failed'))
    } finally { setBusy(false) }
  }

  async function removeNode() {
    const name = node!.location || node!.serial || 'eero'
    if (!window.confirm(t('node_panel.confirm_remove', { name }))) return
    setBusy(true); say.clear()
    try {
      await api.del(`/api/eeros/${id}?confirm=${encodeURIComponent(id)}`)
      onChanged?.()
      onClose()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('node_panel.remove_failed'))
    } finally { setBusy(false) }
  }

  async function save(next: Nightlight) {
    setBusy(true); say.clear()
    try {
      const saved = await api.put<Nightlight>(`/api/eeros/${id}/nightlight`, {
        enabled: next.enabled,
        brightness_percentage: next.brightness_percentage ?? undefined,
        schedule: next.schedule ?? undefined,
      })
      setNl(saved ?? next)
      say.ok(t('node_panel.nightlight_saved'))
      onChanged?.()
    } catch (e) {
      say.fail(e instanceof ApiError ? `Failed: ${e.message}` : t('node_panel.failed'))
    } finally { setBusy(false) }
  }

  const sched: Schedule = nl?.schedule ?? { enabled: false, on: '20:00', off: '06:00' }

  /* The backhaul port, found by who is on the other end rather than by eero's
     `uplink` flag — which is false on every port of every node on a wired mesh,
     so the first version of this row never rendered at all. A leaf's backhaul
     is the port whose peer is another eero; `role` is "wan" there because from
     the leaf's point of view that is where the internet comes from. On the
     gateway the WAN port peers with a modem rather than an eero, so this stays
     empty and the row does not appear. */
  const wiredUplink = detail?.ports?.find(
    (x) => x.connected && x.peer?.kind === 'eero')

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <EeroIcon model={node.model} size={22} />
          <StatusDot state={state} title={help ?? (down ? t('node_panel.unreachable_short') : undefined)} />
          {/* The name is the control. An eero's name is where in the house it
              sits, which is the fact most likely to be wrong — the ones eero
              suggests during setup are guesses, and furniture moves. eero
              calls the field `location`; everything else in the app reads it
              as the eero's name, and so does this.

              Editable in the header rather than as a row below, because the
              name at the top is the one somebody is looking at when they
              decide it is wrong. Same control the network nickname uses, so
              both renames behave alike. */}
          <EditableText
            value={node.location ?? ''}
            placeholder={node.serial || 'eero'}
            disabled={busy}
            onSave={async (v) => {
              await api.put(`/api/eeros/${id}/name`, { location: v })
              /* The list this drawer was opened from holds the old name, and
                 the drawer's own header reads from it. Refetching is what
                 makes the change stick when the panel is closed and opened
                 again rather than only until then. */
              onChanged?.()
            }}
          />
        </span>
      }
    >
      <div className="grid gap-4">
        <section>
          <Row label={t('node_panel.model')}>{node.model || '—'}</Row>
          <Row label={t('node_panel.role')}>{node.gateway ? t('node_panel.gateway') : t('node_panel.leaf')}</Row>
          <Row label={t('node_panel.firmware')}>
            <span className="font-mono text-[12px]">{node.os_version || '—'}</span>
          </Row>
          <Row label={t('node_panel.serial')}>
            <span className="font-mono text-[12px]">{node.serial || '—'}</span>
          </Row>
          <Row label={t('node_panel.ip_address')}>
            <span className="font-mono text-[12px]">{node.ip_address || '—'}</span>
          </Row>
          <Row label={t('node_panel.clients')}>
            {node.connected_clients_count ?? 0}
            {node.connected_wired_clients_count != null && (
              <span className="ml-1 font-normal text-[var(--color-ink-3)]">
                {t('node_panel.n_wired', { n: node.connected_wired_clients_count })}
              </span>
            )}
          </Row>
          {/* Reading the light and changing it were two places for one fact:
              the drawer printed its state and the Local page held the only
              control, so anyone here to turn a light off had to go and find
              it. The steps are eero's own (off / 25 / 50 / 100), and the value
              is derived rather than held in state so a failed write reverts to
              what the eero actually reports on the next read. */}
          <Row label={t('node_panel.status_light')}>
            <select
              disabled={led || down}
              title={down ? t('node_panel.unreachable_short') : undefined}
              value={node.led_on === false ? 'off'
                     : String(node.led_brightness ?? 100)}
              onChange={(e) => setLed(e.target.value)}
              className="rounded border border-[var(--color-line-strong)]
                         bg-[var(--color-surface)] px-1.5 py-0.5 text-[12px]
                         disabled:opacity-50"
            >
              <option value="off">{t('node_panel.led_off')}</option>
              <option value="25">{t('node_panel.led_at', { pct: 25 })}</option>
              <option value="50">{t('node_panel.led_at', { pct: 50 })}</option>
              <option value="100">{t('node_panel.led_at', { pct: 100 })}</option>
            </select>
          </Row>
          {/* Beside the brightness, because it is the other thing the light
              does and the row above is where somebody already is when they
              cannot tell which eero they are looking at. Needs the serial
              rather than the node id: eero's route for it is by serial. */}
          {node.serial && (
            <Row label={t('node_panel.which_one_is_this')}>
              <button type="button" disabled={led || down}
                onClick={identify}
                title={down ? t('node_panel.unreachable_short') : undefined}
                className="rounded border border-[var(--color-line-strong)] px-2.5
                           py-1 text-[13px] font-medium disabled:opacity-50">
                {t('node_panel.blink_its_light')}
              </button>
            </Row>
          )}
        </section>

        {/* An unreachable eero reports no ports and no uplink, so the section
            used to vanish at exactly the moment somebody opened the drawer to
            find out why. Absence of data is the finding here, and it is worth
            a sentence rather than a gap. */}
        {/* An amber state with no ports or uplink to show yet — an eero mid-
            restart reports neither — still gets its sentence, in a section of
            its own so the heading is not lost with the data. */}
        {!down && help && !(detail && (detail.ports?.length || detail.mesh?.wireless_uplink)) && (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold">{t('node_panel.connectivity')}</h3>
            <Notice kind="warn">{help}</Notice>
          </section>
        )}
        {down ? (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold">{t('node_panel.connectivity')}</h3>
            <Notice kind="bad">{t('node_panel.unreachable_alert')}</Notice>
          </section>
        ) : detail && (detail.ports?.length || detail.mesh?.wireless_uplink) ? (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold">{t('node_panel.connectivity')}</h3>
            {help && <Notice kind="warn" className="mb-2">{help}</Notice>}
            {detail.mesh?.wireless_uplink && (
              /* "Current primary": a leaf holds live mesh links to every other
                 eero at once, and this is only the one it is routing through
                 right now. Calling it "the" wireless uplink implied a fixed
                 topology that eero does not have.

                 Named, not merely confirmed. "Wireless uplink: yes" answers a
                 question nobody asked — the panel is already open on a leaf.
                 Which eero it reaches is the fact that decides where to move
                 something, so the peer's name is the value and the label stays
                 a constant heading. The bars are a glyph for the same reason
                 the client list uses one: "4/5 bars" is a number to convert,
                 and the shape is read at a glance. */
              <Row label={<span className="inline-flex items-baseline gap-1">
                {t('node_panel.wireless_uplink')}{' '}
                {/* "(current primary)" is the qualifier and the hover target
                    both: it already tells you the value is not fixed, so a "?"
                    beside it was a second affordance for the same sentence.
                    The dotted underline is what says there is more to read. A
                    `title` rather than a popover — one paragraph, no
                    interaction needed, and the app uses hover text for every
                    other qualifier. */}
                <span
                  title={t('node_panel.truemesh_hint')}
                  className="cursor-help text-[var(--color-ink-3)] underline
                             decoration-dotted underline-offset-2"
                >
                  {t('node_panel.current_primary')}
                </span>
              </span>}>
                <span className="inline-flex items-center gap-2">
                  {/* Peer and band as one phrase, because either alone is
                      half an answer: the name says where traffic goes, the
                      band says how good the trip is. */}
                  <span className="text-[var(--color-ink-2)]">
                    {detail.mesh.uplink_name && detail.mesh.uplink_radio
                      ? t('node_panel.peer_over_radio', {
                          name: detail.mesh.uplink_name,
                          radio: detail.mesh.uplink_radio })
                      : detail.mesh.uplink_name
                        ? detail.mesh.uplink_name
                        : detail.mesh.uplink_radio
                          ? t('node_panel.over_radio', { radio: detail.mesh.uplink_radio })
                          : ''}
                  </span>
                  {detail.mesh.quality_bars != null && (
                    <SignalBars value={meshBars(detail.mesh.quality_bars)}
                                reading="tooltip" />
                  )}
                </span>
              </Row>
            )}

            {/* The wired equivalent. eero marks the port that faces the rest of
                the network, and that port knows both its peer and the speed it
                negotiated — which is the pair worth showing, since a gigabit
                backhaul that came up at 100 Mbit is a real and quiet fault. */}
            {wiredUplink && (
              <Row label={t('node_panel.ethernet_uplink')}>
                {/* Same shape as the wireless row above it: the label names the
                    kind of link, the value names the peer and how good the link
                    to it is. The two rows had drifted into different splits and
                    read like they came from different screens. */}
                <span className="inline-flex items-center gap-2">
                  <span className="text-[var(--color-ink-2)] tabular-nums">
                    {wiredUplink.peer?.name && wiredUplink.speed_mbps != null
                      ? t('node_panel.peer_at_speed', {
                          name: wiredUplink.peer.name,
                          speed: wiredUplink.speed_mbps })
                      : wiredUplink.peer?.name
                        ? wiredUplink.peer.name
                        : wiredUplink.speed_mbps != null
                          ? t('node_panel.mbit', { speed: wiredUplink.speed_mbps })
                          : ''}
                  </span>
                  <CableDataIcon title={t('node_panel.wired_link')} />
                </span>
              </Row>
            )}
            {detail.power?.provides_poe && (
              <Row label={t('node_panel.poe')}>{t('node_panel.powering_a_device')}</Row>
            )}
            {!!detail.ports?.length && (
              <div className="mt-2">
                <span className="micro-label">{t('node_panel.ports')}</span>
                <ul className="mt-1 grid gap-1">
                  {detail.ports.map((pt) => (
                    <li key={pt.name}
                        className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${
                          pt.connected
                            ? 'bg-[var(--color-ok)]'
                            : pt.connected === false
                              ? 'bg-[var(--color-line-strong)]'
                              : 'bg-[var(--color-warn)]'}`} />
                        <span className="font-mono text-[12px]">
                          {t('node_panel.port_name', { name: pt.name })}
                        </span>
                        {/* eero marks whichever port reaches the rest of the
                            network as the WAN port, so on a leaf that label
                            describes a wired backhaul, not the internet. Where
                            it can see what is on the far end, name that. */}
                        {pt.peer ? (
                          <span
                            className="rounded bg-[var(--color-accent-wash)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-ink)]"
                            title={pt.peer.kind === 'switch'
                              ? t('node_panel.port_bridging',
                                   { count: pt.peer.count })
                              : undefined}
                          >
                            {pt.peer.is_gateway ? t('node_panel.ethernet_backhaul') : pt.peer.name}
                          </span>
                        ) : pt.role === 'wan' && (
                          <span className="rounded bg-[var(--color-accent-wash)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-ink)]">
                            {/* On the gateway this is the port to the ISP; on a
                                leaf it is whatever eero could not identify. */}
                            {detail.gateway ? t('node_panel.modem') : t('node_panel.wan')}
                          </span>
                        )}
                        {pt.uplink && (
                          <span className="text-[11px] text-[var(--color-ink-3)]">{t('node_panel.uplink')}</span>
                        )}
                      </span>
                      <span className="text-[12px] text-[var(--color-ink-3)]">
                        {pt.connected
                          ? (pt.speed_mbps != null
                              ? (pt.speed_mbps >= 1000
                                  ? `${pt.speed_mbps / 1000} Gbps` : `${pt.speed_mbps} Mbps`)
                              : 'connected')
                          : pt.connected === false ? 'nothing connected' : '—'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ) : null}

        {detail && (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold">{t('node_panel.facts')}</h3>
            {detail.clients && (detail.clients.wireless != null || detail.clients.wired != null) && (
              <Row label={t('node_panel.clients')}>
                {t('node_panel.wireless_and_wired', {
                  wireless: detail.clients.wireless ?? 0,
                  wired: detail.clients.wired ?? 0,
                })}
              </Row>
            )}
            {detail.last_reboot && (
              <Row label={t('node_panel.last_rebooted')}>
                {when(detail.last_reboot)}
              </Row>
            )}
            {detail.power?.source && <Row label={t('node_panel.powered')}>{detail.power.source}</Row>}
            {detail.model_number && (
              <Row label={t('node_panel.model_number')}>
                <span className="font-mono text-[12px]">{detail.model_number}</span>
              </Row>
            )}
            {!!detail.bssids?.length && (
              <div className="pt-1">
                <span className="micro-label">{t('node_panel.broadcasting')}</span>
                <ul className="mt-1 grid gap-0.5">
                  {detail.bssids.map((b) => (
                    <li key={b.bssid} className="flex justify-between text-[12px]">
                      <span className="text-[var(--color-ink-3)]">{b.band}</span>
                      <span className="font-mono">{b.bssid}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {hasNightlight && (
          <section>
            <h3 className="mb-1 text-[13px] font-semibold">{t('node_panel.nightlight_2')}</h3>
            <p className="mb-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              {t('node_panel.downward_lamp_beacon_separate_from')}
            </p>
            {nl ? (
              <>
                <Toggle
                  label={t('node_panel.nightlight')}
                  checked={nl.enabled}
                  disabled={busy}
                  onChange={(v) => save({ ...nl, enabled: v })}
                />
                <label className="mt-3 block text-[12px] text-[var(--color-ink-2)]">
                  {t('node_panel.brightness')}
                  <input
                    type="range" min={0} max={100} step={5}
                    disabled={busy || !nl.enabled}
                    value={nl.brightness_percentage ?? 50}
                    onChange={(e) => setNl({
                      ...nl, brightness_percentage: Number(e.target.value),
                    })}
                    onMouseUp={() => save(nl)}
                    onTouchEnd={() => save(nl)}
                    onKeyUp={(e) => { if (e.key.startsWith('Arrow')) save(nl) }}
                    className="mt-1 w-full accent-[var(--color-accent)]"
                  />
                  <span className="tabular-nums">
                    {nl.brightness_percentage ?? 50}%
                  </span>
                </label>

                <form
                  className="mt-3 grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const f = new FormData(e.currentTarget as HTMLFormElement)
                    save({ ...nl, schedule: {
                      enabled: f.get('sched') === 'on',
                      on: String(f.get('on')), off: String(f.get('off')),
                    } })
                  }}
                >
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" name="sched" defaultChecked={sched.enabled}
                           className="accent-[var(--color-accent)]" />
                    {t('node_panel.run_on_a_schedule')}
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-[12px] text-[var(--color-ink-2)]">
                      {t('node_panel.on_at')}{' '}
                      <input type="time" name="on" defaultValue={sched.on}
                             className="rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]" />
                    </label>
                    <label className="text-[12px] text-[var(--color-ink-2)]">
                      {t('node_panel.off_at')}{' '}
                      <input type="time" name="off" defaultValue={sched.off}
                             className="rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px]" />
                    </label>
                  </div>
                  <SubmitButton disabled={busy} className="justify-self-start">
                    {t('node_panel.save_schedule')}
                  </SubmitButton>
                </form>
              </>
            ) : (
              <SkeletonRows rows={4} cols={2} />
            )}
          </section>
        )}

        {/* Last, and separated: everything above reports or adjusts, and
            these two do not. Reboot drops every client on this eero for about
            a minute; removing it takes it off the network entirely. The gateway
            cannot be removed — eero's own screen for this is RemoveLeafEero,
            and deleting the eero that holds the internet connection leaves no
            network to add it back through. */}
        <section className="mt-2 border-t border-[var(--color-line)] pt-3">
          <div className="flex flex-wrap justify-end gap-2">
            <SubmitButton type="button" tone="bad" disabled={busy}
                          onClick={rebootNode}>
              {t('node_panel.reboot')}
            </SubmitButton>
            <SubmitButton type="button" tone="bad" disabled={busy || node.gateway}
                          title={node.gateway ? t('node_panel.gateway_stays') : undefined}
                          onClick={removeNode}>
              {t('node_panel.remove')}
            </SubmitButton>
          </div>
          {node.gateway && (
            <p className="mt-1.5 text-right text-[12px] text-[var(--color-ink-3)]">
              {t('node_panel.gateway_stays')}
            </p>
          )}
        </section>

        {say.node}
      </div>
    </Drawer>
  )
}
