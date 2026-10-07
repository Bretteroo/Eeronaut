import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { api, ApiError, lastRead } from '../lib/api'
import {
  AutoHeight, Card, DataTable, EditableText, RowAction, SkeletonRows,
  SubmitButton, Toggle, useNotice, type Column,
} from './primitives'
import { useCapability } from '../lib/capabilities'
import { SubnetAddress, firstFreeAddress, isHostIn,
         type Subnet } from './SubnetAddress'
import { t, tn } from '../i18n'

/* Everything that lets traffic in from the internet, in one place.

   A port forward and an IPv6 pinhole answer the same question, so they are
   listed together rather than in two sections a user has to know to check
   separately. They are not the same thing to eero, though: they live at
   different endpoints, a forward rewrites an address where a pinhole does not,
   and eero's pinhole record has neither a description nor an enabled flag —
   Eeronaut keeps those two itself. See eeronaut/core/notes.py. */

interface Forward {
  url: string; ip?: string; gateway_port?: string; client_port?: string
  protocol?: string; description?: string; enabled?: boolean
}
interface PinholeRow {
  url: string; device: string; port: string; protocol: string
  description?: string; enabled?: boolean
}
interface DeviceRow {
  url: string; mac?: string; nickname?: string | null
  hostname?: string | null; display_name?: string | null; ip?: string | null
}
interface Reservation { url: string; mac?: string; ip?: string; description?: string }

type Rule =
  | { kind: 'forward'; f: Forward }
  | { kind: 'pinhole'; p: PinholeRow }

const FIELD =
  'w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] '
  + 'px-2 py-1.5 text-[13px] outline-none focus:border-[var(--color-accent)]'

/** A select that saves the moment it changes, sized to sit inside a table row. */
const CELL_SELECT =
  'max-w-[13rem] rounded border border-transparent bg-transparent px-1 py-0.5 '
  + 'text-[13px] hover:border-[var(--color-line-strong)] '
  + 'focus:border-[var(--color-accent)] focus:outline-none'

/* The target picker. Fixed width rather than sized to its selection: a select
   is as wide as the option it is showing, so a column of them stepped in and
   out with every device name and the chevrons never lined up. */
const TARGET_SELECT = `${CELL_SELECT} w-[13rem]`

/* The wire value stays `both` — that is what eero's API takes. Only the label
   changes: "Both" begs the question both of *what*, in a row that already has
   a device column and a port column, while "TCP & UDP" is the answer.
   Not translated, and deliberately: these are protocol names, identical in
   every language, and a catalog entry for them would only invite someone to
   translate an acronym. */
const PROTOCOLS = [['tcp', 'TCP'], ['udp', 'UDP'], ['both', 'TCP & UDP']] as const

/** "501-504" -> {low: 501, span: 3}; "500" -> {low: 500, span: 0}. Null when
 *  it is not a port or a well-formed range. eero's own rule, from its app:
 *  "Your port must be a number between 1 to 65535. Port ranges must be
 *  separated with a '-'." */
function parsePorts(text: string): { low: number; span: number } | null {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text.trim())
  if (!m) return null
  const low = Number(m[1])
  const high = m[2] === undefined ? low : Number(m[2])
  if (low < 1 || high > 65535 || high < low) return null
  return { low, span: high - low }
}

const portText = (low: number, span: number) =>
  span ? `${low}-${low + span}` : String(low)

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-[12px] text-[var(--color-ink-3)]">
      {label}
      {children}
    </label>
  )
}

/* One of the two rule kinds. A radio rather than a dropdown because there are
   only two, and the choice governs the rest of the form. */
function KindChoice({ checked, onPick, label, hint, disabled }: {
  checked: boolean; onPick: () => void
  label: string; hint: string; disabled?: boolean
}) {
  return (
    <label
      title={disabled ? hint : undefined}
      className={`toned flex max-w-[19rem] flex-1 items-start gap-2 rounded-md border p-2
                  ${disabled ? 'cursor-not-allowed opacity-45' : 'toned-hover cursor-pointer'}`}
      style={{
        '--btn-line': checked ? 'var(--color-accent)' : 'var(--color-line)',
      } as CSSProperties}
    >
      <input type="radio" name="rulekind" checked={checked} disabled={disabled}
             onChange={onPick} className="mt-0.5 accent-[var(--color-accent)]" />
      <span>
        <span className="block text-[13px] font-medium text-[var(--color-ink)]">{label}</span>
        <span className="block text-[12px] text-[var(--color-ink-3)]">{hint}</span>
      </span>
    </label>
  )
}

/* The internal port of a forward, edited the way the add form asks for it:
   a start you type and an end that follows from the external range.

   A single free-text box let a mismatched range be typed and then silently
   corrected on save, which is a worse experience than not offering the field —
   the value you left is not the value that was written. Here the second field
   exists but cannot be typed into, so the rule is visible before it applies
   rather than after. */
function InternalPortEdit({ value, span, onSave, disabled }: {
  value: string
  /** How many ports past the first the external range covers; 0 for a single
   *  port, in which case there is no second field to show. */
  span: number
  onSave: (v: string) => void
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [start, setStart] = useState(String(parsePorts(value)?.low ?? value))

  useEffect(() => { setStart(String(parsePorts(value)?.low ?? value)) }, [value])

  const low = Number(start)
  const valid = Number.isInteger(low) && low >= 1 && low + span <= 65535
  const next = valid ? portText(low, span) : null

  const commit = () => {
    setEditing(false)
    if (!next || next === value) { setStart(String(parsePorts(value)?.low ?? value)); return }
    onSave(next)
  }

  if (disabled) return <span>{value}</span>
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} data-part="editable"
              className="-mx-1 rounded px-1 text-left hover:bg-[var(--color-accent-wash)]"
              title={t('inbound_access.click_change')}>
        {value}
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={start}
        inputMode="numeric"
        aria-label={t('inbound_access.internal_port')}
        onChange={(e) => setStart(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setStart(String(parsePorts(value)?.low ?? value)); setEditing(false)
          }
        }}
        className="w-16 rounded border bg-[var(--color-surface)] px-1.5 py-0.5 text-[13px]"
        style={{ borderColor: valid ? 'var(--color-accent)' : 'var(--color-bad)' }}
      />
      {span > 0 && (
        <>
          <span aria-hidden="true" className="text-[var(--color-ink-3)]">{t('inbound_access.text')}</span>
          <input
            readOnly tabIndex={-1}
            value={valid ? low + span : ''}
            aria-label={t('inbound_access.internal_range_ends')}
            title={t('inbound_access.set_external_range_both_must')}
            className="w-16 cursor-not-allowed rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[13px] text-[var(--color-ink-3)]"
          />
        </>
      )}
    </span>
  )
}

export function InboundAccess() {
  /* Both `null` until their fetch lands. They were `[]`, which this card
     cannot tell apart from "no rules" — so while the two lists were still
     in the air it rendered "Inbound access (0)" over "Nothing from the
     internet can reach in." On a firewall that is not a placeholder, it is
     a false statement about which ports are open, and the rules it was
     denying arrived a second or two later. */
  /* Opens on the last answer; the read below asks for a new one. */
  const [fwd, setFwd] = useState<Forward[] | null>(
    () => lastRead<Forward[]>('/api/forwards') ?? null)
  const [pinholes, setPinholes] = useState<PinholeRow[] | null>(
    () => lastRead<PinholeRow[]>('/api/pinholes') ?? null)
  const [devices, setDevices] = useState<DeviceRow[]>(
    () => lastRead<DeviceRow[]>('/api/devices') ?? [])
  /* The eeros' own addresses, which no other list here holds: they are not
     clients, and one of them is the gateway at the bottom of the range where
     a free address is offered from. */
  const [nodeIps, setNodeIps] = useState<string[]>([])
  const [res, setRes] = useState<Reservation[]>([])
  /* The LAN subnet, so a reservation can be made here rather than sending
     somebody to another page to make one and come back. */
  const [subnet, setSubnet] = useState<Subnet | null>(null)
  /* The device chosen for a forward, and the address to reserve for it when it
     does not already have one. Held here rather than read off the form on
     submit, because the address control is not a plain input. */
  const [fwdDevice, setFwdDevice] = useState('')
  const [newIp, setNewIp] = useState('')
  const [busy, setBusy] = useState(false)
  const [addRule, setAddRule] = useState(false)
  const [ruleKind, setRuleKind] = useState<'' | 'v4' | 'v6'>('')
  // The internal range has to be as long as the external one, so the two
  // fields cannot be independent: the end of the internal range is computed,
  // never typed. eero enforces the same rule — "Internal and external port
  // ranges must match" — and rejects the write otherwise.
  const [extPorts, setExtPorts] = useState('')
  const [intStart, setIntStart] = useState('')
  /* The internal port follows the external one: the two are the same in
     nearly every forward, and typing 8080 twice is a step that exists only
     because the form has two boxes.

     It follows while the internal box is empty, or while it still holds what
     was last copied into it. Anything else is somebody's own answer and is
     left alone — the whole point of the second box is the case where they
     differ. Tracking "has been typed into" instead was wrong in a way that
     was reported: clearing the box counted as typing, so a new external port
     entered afterward was never copied and the box stayed empty. */
  const mirrored = useRef('')
  const firstOf = (ports: string) => ports.split('-')[0].trim()
  const echoInternal = (ext: string) => {
    setExtPorts(ext)
    setIntStart((current) => {
      // Emptying the external box is the one thing that empties this one:
      // there is no port left to forward to.
      if (!ext.trim()) { mirrored.current = ''; return '' }
      if (current.trim() !== '' && current !== mirrored.current) return current
      mirrored.current = firstOf(ext)
      return mirrored.current
    })
  }
  /* Left empty with an external port set, it goes back to following. Enforced
     on the way out rather than on every keystroke: refilling the box the
     instant it went empty would fight anyone clearing it to type something
     else, so the box may be empty while it is being edited and never after. */
  const fillInternalIfBlank = () => {
    if (intStart.trim() !== '' || !extPorts.trim()) return
    mirrored.current = firstOf(extPorts)
    setIntStart(mirrored.current)
  }

  /* Both forms share the port state, so switching between them has to clear
     it: an external range typed for a forward would otherwise reappear in the
     pinhole form, where it means something different. */
  const pickKind = (kind: '' | 'v4' | 'v6') => {
    setRuleKind(kind); setExtPorts(''); setIntStart('')
    mirrored.current = ''
    setFwdDevice(''); setNewIp('')
  }
  const say = useNotice()
  const pinCap = useCapability('ipv6_pinholes')

  const load = useCallback(() => {
    api.get<Forward[]>('/api/forwards').then((r) => setFwd(r ?? [])).catch(() => setFwd([]))
    api.get<PinholeRow[]>('/api/pinholes')
      .then((r) => setPinholes(r ?? [])).catch(() => setPinholes([]))
    api.get<DeviceRow[]>('/api/devices')
      .then((r) => setDevices(r ?? [])).catch(() => setDevices([]))
    api.get<{ ip_address?: string | null }[]>('/api/eeros')
      .then((r) => setNodeIps((r ?? []).map((e) => e.ip_address ?? '').filter(Boolean)))
      .catch(() => setNodeIps([]))
    api.get<Reservation[]>('/api/reservations')
      .then((r) => setRes(r ?? [])).catch(() => setRes([]))
    api.get<{ lan_subnet?: Subnet }>('/api/network/lan')
      .then((r) => setSubnet(r?.lan_subnet ?? null)).catch(() => setSubnet(null))
  }, [])
  useEffect(load, [load])

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); say.clear()
    try { await fn(); say.ok(ok); load() }
    catch (e) { say.fail(e instanceof ApiError ? e.message : t('inbound_access.did_not_work')) }
    finally { setBusy(false) }
  }

  /* The same as `run`, except a failure comes back out.
     A switch moves the moment it is clicked and holds that position until the
     prop catches up or the promise rejects, so a helper that reports the error
     and swallows it leaves the switch showing a state eero refused. No success
     message either: the switch's own position is the confirmation, and a notice
     above the card pushed every row down to repeat it. */
  async function runSwitch(fn: () => Promise<unknown>) {
    setBusy(true); say.clear()
    try { await fn(); load() }
    catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('inbound_access.did_not_work'))
      throw e
    }
    finally { setBusy(false) }
  }

  /* `display_name` is eero's own name for a device nobody has renamed —
     usually whoever registered the MAC prefix ("Aura Home, Inc."). Left out of
     this chain, a device with no nickname and no hostname was offered as a raw
     MAC while the clients table two tabs over showed it by name. Every other
     picker in the app already reads it; these two did not. A device eero knows
     nothing about still falls through to its MAC, which is what the clients
     table does with it too. */
  const labelOfDevice = (d: DeviceRow) =>
    d.nickname || d.hostname || d.display_name || d.mac || 'device'
  const nameOfDevice = (url: string) => {
    const d = devices.find((x) => x.url === url)
    return d ? labelOfDevice(d) : 'a device'
  }
  // eero returns clients in no order a person would recognize, so every picker
  // sorts by the label it actually shows. localeCompare, not <, so a name
  // starting with a lowercase letter does not sort below every uppercase one.
  const devicesByName = [...devices].sort(
    (a, b) => labelOfDevice(a).localeCompare(labelOfDevice(b)))
  /* A forward stores a literal IPv4 address, so it follows the address rather
     than the device: if the lease moves, the rule points somewhere else. eero
     requires a reservation for that reason, and a device without one would
     only produce a rejection. A pinhole stores the device itself, so it has no
     such requirement and its picker is not filtered.

     Built from the reservations rather than from the devices, because the
     address a forward should name is the reserved one. A device that has not
     renewed its lease yet still holds a different address, and matching on
     that would both hide it from the picker and fail to recognize it in a rule
     that already points at its reservation. */
  /* Every device with a MAC, whether or not it holds a reservation.
     Previously only reserved devices were offered, which on a network with
     none left an empty dropdown and a link to another page — a dead end where
     the task was. A device without a reservation can have one made here. */
  const forwardDevices = devices
    .filter((d) => d.mac)
    .sort((a, b) => labelOfDevice(a).localeCompare(labelOfDevice(b)))

  /** The reservation a device already has, if any. */
  const reservationFor = (mac: string) => res.find(
    (r) => (r.mac ?? '').toLowerCase() === mac.toLowerCase())

  const chosenDevice = forwardDevices.find((d) => d.mac === fwdDevice)
  const chosenRes = fwdDevice ? reservationFor(fwdDevice) : undefined
  /* The address the forward will point at: the existing reservation, or the
     one about to be made. */
  const targetIp = chosenRes?.ip ?? newIp

  const forwardTargets = res
    .filter((r, i, all) => r.ip && all.findIndex((x) => x.ip === r.ip) === i)
    .map((r) => {
      const mac = (r.mac ?? '').toLowerCase()
      const d = mac ? devices.find((x) => (x.mac ?? '').toLowerCase() === mac) : undefined
      return { ip: r.ip as string,
               label: d ? labelOfDevice(d) : (r.description || r.mac || (r.ip as string)) }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  /** What the To cell shows for a rule: the picker's current label, or the
   *  raw value when the rule points at something no picker covers. */
  const targetLabel = (r: Rule) => {
    if (r.kind === 'forward') {
      return forwardTargets.find((t) => t.ip === r.f.ip)?.label
        ?? r.f.ip ?? 'unknown'
    }
    const d = devices.find((x) => x.url === r.p.device)
    return d ? labelOfDevice(d) : t('inbound_access.unknown_device')
  }

  /* eero replaces the whole forward, so an edit resends every field. Toggling
     one off is safer than deleting it: the rule is kept, just inert.

     Editing either port re-derives the other end, because the two ranges have
     to cover the same number of ports. Left alone, widening the external range
     in place would produce a rule eero rejects, and the user would have to
     work out why from an error rather than from the form. */
  /* eero replaces the whole forward on a write, so every field goes with it
     whichever one changed. Split out from `saveForward` so the enable switch can
     send the same body without going through the notice path. */
  const forwardBody = (f: Forward, patch: Partial<Forward>) => ({
    ip: patch.ip ?? f.ip ?? '',
    gateway_port: patch.gateway_port ?? f.gateway_port ?? '',
    client_port: patch.client_port ?? f.client_port ?? '',
    protocol: patch.protocol ?? f.protocol ?? 'tcp',
    description: patch.description ?? f.description ?? '',
    enabled: patch.enabled ?? f.enabled ?? true,
  })

  const saveForward = (f: Forward, patch: Partial<Forward>) => {
    const next = forwardBody(f, patch)
    if (patch.gateway_port !== undefined || patch.client_port !== undefined) {
      const ext = parsePorts(next.gateway_port)
      const int = parsePorts(next.client_port)
      if (!ext) { say.fail(t('inbound_access.check_external_port_range')); return }
      if (!int) { say.fail(t('inbound_access.check_internal_port_range')); return }
      if (int.low + ext.span > 65535) {
        say.fail(t('inbound_access.internal_range_runs_past_port')); return
      }
      next.gateway_port = portText(ext.low, ext.span)
      next.client_port = portText(int.low, ext.span)
    }
    // Enabling and disabling go through the switch in the Enable column now, so
    // this only ever reports an edit.
    run(() => api.put(`/api/forwards?url=${encodeURIComponent(f.url)}`, next),
        t('inbound_access.port_forward_updated'))
  }

  const deleteForward = (f: Forward) => {
    if (!window.confirm(t('inbound_access.delete_port_forward_gateway_port', { gateway_port: f.gateway_port }))) return
    run(() => api.del(`/api/forwards?url=${encodeURIComponent(f.url)}`),
        t('inbound_access.port_forward_deleted'))
  }

  const asPinhole = (ph: PinholeRow, patch: Partial<PinholeRow> = {}) => ({
    device: patch.device ?? ph.device,
    port: patch.port ?? ph.port,
    protocol: patch.protocol ?? ph.protocol,
    description: patch.description ?? ph.description ?? '',
    enabled: patch.enabled ?? ph.enabled ?? true,
  })

  /* Device, port, and protocol are what identifies a pinhole locally, so an
     edit has to say what it used to be as well as what it now is. */
  const savePinhole = (ph: PinholeRow, patch: Partial<PinholeRow>) =>
    run(() => api.put('/api/pinholes', { was: asPinhole(ph), now: asPinhole(ph, patch) }),
        t('inbound_access.pinhole_updated'))

  /* No confirmation on the way down. Disabling closes a hole rather than
     opening one, and it is reversible from the same switch — the prompt was
     asking the user to approve making their network safer. The write itself is
     inline in the Enable column now, so there is no helper here. */

  const deletePinhole = (ph: PinholeRow) => {
    if (!window.confirm(t('inbound_access.delete_pinhole_port_port_rule', { port: ph.port }))) return
    const q = new URLSearchParams({ url: ph.url, device: ph.device,
                                    port: ph.port, protocol: ph.protocol })
    run(() => api.del(`/api/pinholes?${q}`), t('inbound_access.pinhole_deleted'))
  }

  const enabledOf = (r: Rule) => (r.kind === 'forward' ? r.f.enabled : r.p.enabled)

  /* One click, everything shut. Sequential rather than concurrent: eero
     read-modify-writes each list, and firing them together loses all but the
     last write. */
  const disableAll = () => {
    const open = rules.filter(enabledOf)
    if (!open.length) return
    if (!window.confirm(tn('inbound_access.confirm_disable_all', open.length))) return
    run(async () => {
      for (const r of open) {
        if (r.kind === 'forward') {
          await api.put(`/api/forwards?url=${encodeURIComponent(r.f.url)}`, {
            ip: r.f.ip ?? '', gateway_port: r.f.gateway_port ?? '',
            client_port: r.f.client_port ?? '', protocol: r.f.protocol ?? 'tcp',
            description: r.f.description ?? '', enabled: false,
          })
        } else {
          await api.put('/api/pinholes/state', asPinhole(r.p, { enabled: false }))
        }
      }
    }, tn('inbound_access.rules_disabled', open.length))
  }

  const extSpan = parsePorts(extPorts)?.span ?? 0
  const intEnd = Number(intStart) > 0 ? Number(intStart) + extSpan : null

  const listed = fwd !== null && pinholes !== null
  const rules: Rule[] = [
    ...(fwd ?? []).map((f): Rule => ({ kind: 'forward', f })),
    ...(pinholes ?? []).map((p): Rule => ({ kind: 'pinhole', p })),
  ]

  const columns: Column<Rule>[] = [
    { key: 'd', header: t('inbound_access.column_description'), stopsRowClick: true,
      sortValue: (r) => (r.kind === 'forward' ? r.f.description : r.p.description)
        ?.toLowerCase() || null,
      render: (r) => (r.kind === 'forward' ? (
        <EditableText value={r.f.description ?? ''} placeholder={t('inbound_access.add_description')}
                      onSave={(v) => saveForward(r.f, { description: v })} />
      ) : (
        <EditableText value={r.p.description ?? ''} placeholder={t('inbound_access.add_description')}
                      onSave={(v) => savePinhole(r.p, { description: v })} />
      )) },
    { key: 't', header: t('inbound_access.column_type'), sortValue: (r) => r.kind,
      render: (r) => (r.kind === 'forward' ? t('inbound_access.ipv4_forward') : t('inbound_access.ipv6_pinhole')) },
    { key: 'p', header: t('inbound_access.external_ports'), stopsRowClick: true,
      sortValue: (r) => Number(r.kind === 'forward' ? r.f.gateway_port : r.p.port) || null,
      render: (r) => (r.kind === 'forward' ? (
        <EditableText value={r.f.gateway_port ?? ''} placeholder={t('inbound_access.port')}
                      onSave={(v) => saveForward(r.f, { gateway_port: v })} />
      ) : (
        <EditableText value={r.p.port} placeholder={t('inbound_access.port_range')}
                      onSave={(v) => savePinhole(r.p, { port: v })} />
      )) },
    // A forward names an address because it rewrites one; a pinhole names the
    // device because it does not. Both are chosen the same way here, and for a
    // forward the device's current address is what gets written.
    { key: 'i', header: t('inbound_access.column_to'), stopsRowClick: true,
      /* Sorted on the label the cell actually shows. This used to compare an
         IPv4 integer for a forward against a device name for a pinhole — two
         kinds of value in one column, so the order was neither numeric nor
         alphabetical. The select displays a device label for both kinds, and
         that is what sorts. */
      sortValue: (r) => targetLabel(r).toLowerCase(),
      render: (r) => (r.kind === 'forward' ? (
        <select
          className={TARGET_SELECT} disabled={busy} aria-label={t('inbound_access.target_device')}
          value={forwardTargets.some((t) => t.ip === r.f.ip) ? r.f.ip : ''}
          onChange={(e) => saveForward(r.f, { ip: e.target.value })}
        >
          {/* A forward can point at an address no reservation covers — one made
              before the reservation was removed, or from the eero app. It is
              shown as-is rather than silently reassigned to someone else. */}
          {!forwardTargets.some((t) => t.ip === r.f.ip) && (
            <option value="">{r.f.ip ?? 'unknown'}</option>
          )}
          {forwardTargets.map((t) => (
            <option key={t.ip} value={t.ip}>{t.label}</option>
          ))}
        </select>
      ) : (
        <select
          className={TARGET_SELECT} disabled={busy} aria-label={t('inbound_access.target_device')}
          value={devicesByName.some((d) => d.url === r.p.device) ? r.p.device : ''}
          onChange={(e) => savePinhole(r.p, { device: e.target.value })}
        >
          {!devicesByName.some((d) => d.url === r.p.device) && (
            <option value="">{t('inbound_access.unknown_device')}</option>
          )}
          {devicesByName.map((d) => (
            <option key={d.url} value={d.url}>{labelOfDevice(d)}</option>
          ))}
        </select>
      )) },
    { key: 'c', header: t('inbound_access.internal_port'),
      sortValue: (r) => (r.kind === 'forward' ? Number(r.f.client_port) || null : null),
      stopsRowClick: true,
      render: (r) => (r.kind === 'forward' ? (
        <InternalPortEdit
          value={r.f.client_port ?? ''}
          span={parsePorts(r.f.gateway_port ?? '')?.span ?? 0}
          disabled={busy}
          onSave={(v) => saveForward(r.f, { client_port: v })} />
      ) : (
        <span className="text-[var(--color-ink-3)]"
              title={t('inbound_access.pinhole_translates_nothing_so_port')}>
          {t('inbound_access.same')}
        </span>
      )) },
    { key: 'pr', header: t('inbound_access.protocol'), stopsRowClick: true,
      sortValue: (r) => (r.kind === 'forward' ? r.f.protocol ?? null : r.p.protocol),
      render: (r) => (
        <select
          className={CELL_SELECT} disabled={busy} aria-label={t('inbound_access.protocol')}
          value={(r.kind === 'forward' ? r.f.protocol ?? 'tcp' : r.p.protocol)}
          onChange={(e) => (r.kind === 'forward'
            ? saveForward(r.f, { protocol: e.target.value })
            : savePinhole(r.p, { protocol: e.target.value }))}
        >
          {PROTOCOLS.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      ) },
    /* A switch, not a button whose caption flipped between Enabled and
       Disabled. The caption was the only place the state appeared, so the
       column read differently on every row and could not be scanned down; a
       switch carries the state in its position. The header says what the
       column does rather than naming the state, for the same reason. */
    { key: 'e', header: t('inbound_access.column_enable'), stopsRowClick: true,
      align: 'center',
      sortValue: (r) => ((r.kind === 'forward' ? r.f.enabled : r.p.enabled) ? 0 : 1),
      render: (r) => (r.kind === 'forward' ? (
        <Toggle
          checked={Boolean(r.f.enabled)}
          disabled={busy}
          srLabel={t('inbound_access.enable_forward_port',
                     { port: r.f.gateway_port ?? '' })}
          onChange={(v) => runSwitch(
            () => api.put(`/api/forwards?url=${encodeURIComponent(r.f.url)}`,
                          forwardBody(r.f, { enabled: v })))} />
      ) : (
        <Toggle
          checked={Boolean(r.p.enabled)}
          disabled={busy}
          srLabel={t('inbound_access.enable_pinhole_port', { port: r.p.port })}
          onChange={(v) => runSwitch(
            () => api.put('/api/pinholes/state', asPinhole(r.p, { enabled: v })))} />
      )) },
    { key: 'a', header: '', stopsRowClick: true, align: 'center',
      render: (r) => (
        <RowAction tone="bad" disabled={busy} sizeTo="Delete"
                   onClick={() => (r.kind === 'forward'
                     ? deleteForward(r.f) : deletePinhole(r.p))}>
          {t('inbound_access.delete')}
        </RowAction>
      ) },
  ]

  return (
    <Card
      icon="inbound"
      anchor="inbound"
      /* The count rides beside the title rather than inside it, so the
         heading does not rewrite itself when the rules land. */
      title={t('security.inbound_access')}
      count={listed ? rules.length : null}
      className="wide:col-span-2"
      action={
        <RowAction disabled={busy}
                   onClick={() => { setAddRule((v) => !v); pickKind('') }}>
          {addRule ? t('inbound_access.cancel') : t('inbound_access.add_forward_pinhole')}
        </RowAction>
      }
    >
      {say.node}
      <p className="text-[13px] leading-relaxed text-[var(--color-ink-3)]">
        {t('inbound_access.inbound_rules_explained')}
      </p>
      {/* The two kinds, each on its own line with its name in bold. They
          used to be two more sentences at the end of the paragraph above,
          separated by newlines a `<p>` turns into spaces — so the whole
          explanation read as one block and the names of the two things it
          was distinguishing were the least visible words in it. Each name
          carries its own punctuation, because a colon is preceded by a
          space in French and not in English. */}
      <dl className="mt-2 grid gap-1 text-[13px] leading-relaxed text-[var(--color-ink-3)]">
        {([
          ['inbound_access.ipv4_forward_label', 'inbound_access.ipv4_forward_text'],
          ['inbound_access.ipv6_pinhole_label', 'inbound_access.ipv6_pinhole_text'],
        ] as const).map(([label, text]) => (
          <div key={label}>
            <dt className="inline font-semibold text-[var(--color-ink-2)]">
              {t(label)}
            </dt>{' '}
            <dd className="inline">{t(text)}</dd>
          </div>
        ))}
      </dl>

      {addRule && (
        <div className="my-4 grid gap-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3">
          {/* Which kind comes first, because it decides which ports the form
              needs to ask for. Everything else stays out of the way until it
              has been answered. */}
          <fieldset className="grid gap-1.5">
            <legend className="text-[13px] font-medium">
              {t('inbound_access.which_kind_of_rule')}
            </legend>
            <div className="flex flex-wrap gap-2">
              <KindChoice
                checked={ruleKind === 'v4'} onPick={() => pickKind('v4')}
                label={t('inbound_access.ipv4_port_forward')}
                hint={t('inbound_access.redirects_port_your_public_address')} />
              <KindChoice
                checked={ruleKind === 'v6'} onPick={() => pickKind('v6')}
                label={t('inbound_access.ipv6_pinhole')}
                disabled={!pinCap.available}
                hint={pinCap.available
                  ? t('inbound_access.opens_firewall_device_s_own') : pinCap.explanation} />
            </div>
          </fieldset>

          {ruleKind === 'v4' && (
            <form
              className="grid gap-2 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault()
                const f = new FormData(e.currentTarget as HTMLFormElement)
                if (!fwdDevice) { say.fail(t('inbound_access.pick_device')); return }
                const ip = targetIp
                if (!ip || !isHostIn(subnet, ip)) {
                  say.fail(t('inbound_access.address_outside_subnet')); return
                }
                const ext = parsePorts(extPorts)
                if (!ext) { say.fail(t('inbound_access.check_external_port_range')); return }
                /* Blank means the same ports, which is what the label says
                   and what nearly every forward wants. Read here rather than
                   filled into the field on submit: setting state cannot
                   affect the submit that reads it. */
                const start = Number(intStart.trim() || ext.low)
                if (!(start >= 1 && start + ext.span <= 65535)) {
                  say.fail(t('inbound_access.check_internal_port')); return
                }
                /* Two writes when the device has no reservation, in this
                   order: eero will not accept a forward pointing at an
                   address it has not reserved. Reported separately so a
                   reservation that succeeded is not described as a failure
                   just because the forward after it did not — the reservation
                   is real either way and somebody has to know it exists. */
                run(async () => {
                  if (!chosenRes) {
                    await api.post('/api/reservations', {
                      mac: fwdDevice, ip,
                      description: chosenDevice
                        ? labelOfDevice(chosenDevice) : '',
                    }).catch((err) => {
                      throw new ApiError(
                        500, t('inbound_access.reservation_failed_first',
                               { detail: err instanceof ApiError
                                   ? err.message : '' }))
                    })
                  }
                  await api.post('/api/forwards', {
                    ip, gateway_port: portText(ext.low, ext.span),
                    client_port: portText(start, ext.span),
                    protocol: String(f.get('proto')),
                    description: String(f.get('desc')), enabled: true,
                  })
                }, t('inbound_access.port_forward_created'))
                  .then(() => { setAddRule(false); pickKind('') })
              }}
            >
              <Field label={t('inbound_access.description')}>
                <input name="desc" required placeholder={t('inbound_access.what')}
                       aria-label={t('inbound_access.description')} className={FIELD} />
              </Field>
              <Field label={t('inbound_access.device')}>
                {/* Every device, not only the reserved ones. A forward points
                    at a literal address, so an unreserved device needs one —
                    and it can be made here rather than on another page. */}
                <select
                  required className={FIELD} value={fwdDevice}
                  aria-label={t('inbound_access.device')}
                  onChange={(e) => {
                    const mac = e.target.value
                    setFwdDevice(mac)
                    /* Default to reserving the address the device already
                       holds: it is the one thing nothing else on the network
                       is using, and reserving it changes nothing about how the
                       device is reachable today. */
                    const d = forwardDevices.find((x) => x.mac === mac)
                    /* Its own address where it has one, and otherwise an
                       address nothing is known to be using — the same answer
                       the reservations form gives, rather than empty octets. */
                    setNewIp(d?.ip && isHostIn(subnet, d.ip) ? d.ip
                      : firstFreeAddress(subnet, [
                          ...devices.map((x) => x.ip),
                          ...(res ?? []).map((r) => r.ip),
                          ...nodeIps]))
                  }}
                >
                  <option value="">{t('inbound_access.choose_device')}</option>
                  {forwardDevices.map((d) => {
                    /* The reserved address is the useful thing to show, and
                       its absence is the useful thing to show for the rest.
                       Saying "needs a reserved address" instead put an
                       instruction in a list of names, which read as an error
                       beside every unreserved device. */
                    const r = reservationFor(d.mac ?? '')
                    return (
                      <option key={d.mac} value={d.mac ?? ''}>
                        {labelOfDevice(d)}{r?.ip ? ` - ${r.ip}` : ''}
                      </option>
                    )
                  })}
                </select>
              </Field>

              {/* Its own full-width row, slid in rather than appearing, so
                  the form does not jump the height of a control when a device
                  is picked. `AutoHeight` is the same idiom the DNS resolver
                  fields use for the same reason.

                  Nothing in here but the address. A device with a reservation
                  gets no row: its address is already in the option that was
                  just chosen, and printing it twice invites the reader to
                  wonder which one is authoritative. */}
              {/* The right half only, under the device it belongs to.
                  Spanning both columns put the address under the description
                  as much as under the device, which read as a field belonging
                  to the whole form rather than to the choice just made. The
                  left half is deliberately empty: filling it would mean
                  finding something to say there. */}
              <div className="sm:col-start-2">
                <AutoHeight>
                  {fwdDevice && !chosenRes ? (
                    <div className="grid gap-1 pt-1">
                      <span className="text-[12px] text-[var(--color-ink-3)]">
                        {t('inbound_access.reserve_this_address')}
                      </span>
                      <SubnetAddress subnet={subnet} value={newIp}
                                     onChange={setNewIp} disabled={busy} />
                      <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                        {t('inbound_access.reservation_made_with_forward')}
                      </p>
                    </div>
                  ) : null}
                </AutoHeight>
              </div>

              <Field label={t('inbound_access.external_port_range')}>
                <input name="gp" required value={extPorts}
                       onChange={(e) => echoInternal(e.target.value)}
                       pattern="\d{1,5}(-\d{1,5})?"
                       placeholder={t('inbound_access.8080_3478_3480')}
                       title={t('inbound_access.one_port_low_high_range')}
                       aria-label={t('inbound_access.external_port_range')} className={FIELD} />
              </Field>
              <Field label={t('inbound_access.internal_port_range')}>
                <div className="flex items-center gap-2">
                  <input name="cp" value={intStart}
                         onChange={(e) => setIntStart(e.target.value)}
                         onBlur={fillInternalIfBlank}
                         inputMode="numeric" pattern="\d{1,5}"
                         placeholder={extSpan ? t('inbound_access.first_port') : t('inbound_access.listening_device')}
                         aria-label={t('inbound_access.internal_port')} className={FIELD} />
                  {extSpan > 0 && (
                    <>
                      <span aria-hidden="true">{t('inbound_access.text')}</span>
                      <input readOnly tabIndex={-1} value={intEnd ?? ''}
                             aria-label={t('inbound_access.internal_range_ends')}
                             title={t('inbound_access.set_external_range_both_must')}
                             className={`${FIELD} cursor-not-allowed text-[var(--color-ink-3)]`} />
                    </>
                  )}
                </div>
              </Field>
              <Field label={t('inbound_access.protocol')}>
                <select name="proto" aria-label={t('inbound_access.protocol')} className={FIELD}
                        defaultValue="tcp">
                  {PROTOCOLS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton disabled={busy}>{t('inbound_access.add_forward')}</SubmitButton>
              </div>
              <p className="text-[12px] text-[var(--color-ink-3)] sm:col-span-2">
                {t('inbound_access.forward_points_address_not_device')}
              </p>
            </form>
          )}

          {ruleKind === 'v6' && (
            <form
              className="grid gap-2 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault()
                const f = new FormData(e.currentTarget as HTMLFormElement)
                const port = String(f.get('port'))
                const dev = String(f.get('device'))
                if (!dev) { say.fail(t('inbound_access.pick_device')); return }
                if (!window.confirm(t('inbound_access.confirm_open_pinhole',
                      { port, device: nameOfDevice(dev) }))) return
                run(() => api.post('/api/pinholes', {
                  device: dev, port, protocol: String(f.get('protocol')),
                  description: String(f.get('desc')),
                }), t('inbound_access.pinhole_opened'))
                  .then(() => { setAddRule(false); pickKind('') })
              }}
            >
              <Field label={t('inbound_access.description')}>
                <input name="desc" required placeholder={t('inbound_access.what')}
                       aria-label={t('inbound_access.description')} className={FIELD} />
              </Field>
              <Field label={t('inbound_access.device')}>
                <select name="device" required aria-label={t('inbound_access.device')} className={FIELD}>
                  <option value="">{t('inbound_access.choose_device')}</option>
                  {devicesByName.map((d) => (
                    <option key={d.url} value={d.url}>{labelOfDevice(d)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('inbound_access.external_port_range')}>
                <input name="port" required pattern="\d{1,5}(-\d{1,5})?"
                       placeholder={t('inbound_access.443_3000_3002')}
                       title={t('inbound_access.one_port_low_high_range_2')}
                       aria-label={t('inbound_access.external_port_range')} className={FIELD} />
              </Field>
              <Field label={t('inbound_access.protocol')}>
                <select name="protocol" aria-label={t('inbound_access.protocol')} className={FIELD}
                        defaultValue="tcp">
                  {PROTOCOLS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <SubmitButton disabled={busy}>{t('inbound_access.open_pinhole')}</SubmitButton>
              </div>
              <p className="text-[12px] text-[var(--color-ink-3)] sm:col-span-2">
                {t('inbound_access.there_one_port_both_sides')}
              </p>
            </form>
          )}
        </div>
      )}

      <div className="mt-3">
        {/* Skeleton rows rather than the empty state, and they hold the height
            the table will take, so the card does not jump when the rules
            arrive. That jump also moved this card's own Add button out from
            under a click that had already been aimed at it. */}
        {listed ? (
          <DataTable columns={columns} rows={rules}
                     rowKey={(r) => (r.kind === 'forward' ? r.f.url : r.p.url)}
                     defaultSort={{ key: 'p' }}
                     empty={t('inbound_access.nothing_from_internet_can_reach')} />
        ) : (
          <SkeletonRows rows={3} cols={4} />
        )}
      </div>

      {/* The confirmation names the count and what stops working, because
          disabling every rule at once breaks anything that depends on reaching
          in — which is the point, but is worth stating before it happens.
          Nothing is deleted, so it is undone by turning rules back on. */}
      {rules.some(enabledOf) && (
        <div className="mt-4 border-t border-[var(--color-line)] pt-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* A spacer where the explanation was, so the button keeps its
                place under the Enable and Delete columns rather than sliding
                to the left edge of the card. */}
            <span className="min-w-[16rem] flex-1" aria-hidden="true" />
            {/* Wide, and sitting under the Enable and Delete columns, because
                it does what both of those do to every row at once.

                Not red. This one was hand-styled rather than using the button
                primitives, so it kept its red when they lost theirs — and red
                here is worse than most: the thing this button does is close
                every hole in the firewall, which is the safe direction. */}
            <button
              type="button" onClick={disableAll} disabled={busy}
              className="toned w-full shrink-0 rounded border px-3 py-1.5 text-center text-[13px] font-medium disabled:opacity-40 sm:w-[16rem]"
              style={{
                '--btn-line': 'var(--color-line-strong)',
                color: 'var(--color-ink-2)',
              } as CSSProperties}
            >
              {t('inbound_access.disable_all')}
            </button>
          </div>
        </div>
      )}
    </Card>
  )
}
