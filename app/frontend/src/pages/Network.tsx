import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, lastRead } from '../lib/api'
import { Slot, Page, AutoHeight, Card, Collapsible, Check, DataTable, EASE_OUT, Notice, RebootMark, RowAction, SkeletonCard, SubmitButton, Toggle, type Column, type CardSay } from '../components/primitives'
import { DangerousChange } from '../components/DangerousChange'
import { DynamicDns } from '../components/DynamicDns'
import { WanDiagnosis } from '../components/WanDiagnosis'
import { InternetBackup } from '../components/InternetBackup'
import { Gate, useCapability } from '../lib/capabilities'
import { daysLabel } from '../lib/format'
import { useClock } from '../lib/clock'
import { t, tn, tOr, tx } from '../i18n'
import { confirmReboot } from '../lib/reboot'
import {
  RESOLVERS, aboutFor, cleanLabel, fullName, notesFor, termsOf,
} from '../lib/resolvers'
import { useRevalidate } from '../lib/revalidate'
import { POWER_SAVING_MS } from '../lib/pollRates'
import { useClaimed } from '../lib/theme'
import { SubnetAddress, firstFreeAddress, isHostIn,
         type Subnet } from '../components/SubnetAddress'

interface Wpa3 {
  band_2_4_ghz: string | null; band_5_ghz: string | null; band_6_ghz: string | null
  settable: string[]; modes: string[]
}
interface Wifi {
  name?: string; has_password?: boolean; wpa3?: boolean
  band_steering?: boolean; sqm?: boolean; mlo_mode?: string; thread?: boolean
}
interface Guest { enabled?: boolean; name?: string; has_password?: boolean }
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday',
              'saturday', 'sunday']

/* eero's ceiling for a power-saving schedule name, measured against the API:
   32 characters are accepted and 33 are refused. The backend model carries
   the same number. */
const SCHEDULE_NAME_MAX = 32

interface PowerSchedule {
  id: string; name: string; days?: string[]
  start_time: string; end_time: string; enabled?: boolean
}
interface DeviceRow {
  url: string; mac?: string; nickname?: string | null; hostname?: string | null
  display_name?: string | null; ip?: string | null
}

interface ThreadNet {
  enabled?: boolean; name?: string; channel?: number
  pan_id?: string; xpan_id?: string
  enable_credential_syncing?: boolean; has_credentials?: boolean
}
interface Lan {
  gateway_ip?: string; wan_type?: string; wan_ip?: string; double_nat?: boolean
  isp?: string | null
  wan_mode?: 'dhcp' | 'static' | 'pppoe'
  static_lease?: { ip?: string; mask?: string; router?: string } | null
  pppoe_username?: string | null
  geo?: { city?: string | null; region?: string | null; country?: string | null } | null
  dhcp?: { mode?: string; custom?: Record<string, string> | null }
  mode?: 'automatic' | 'manual' | 'bridge'
  dhcp_custom?: Record<string, string> | null
  dns_mode?: string; dns_v4?: string[]
  dns_caching?: boolean; dns_caching_visible?: boolean
  dns_editable?: boolean
  lan_subnet?: Subnet
  dns_v6_mode?: string; dns_v6?: string[]
  dns?: { mode?: string; custom?: { ips?: string[] }; parent?: { ips?: string[] } }
  ipv6_lease?: { name_servers?: string[] } | null
  ipv6_capable?: boolean
  ipv6_upstream?: boolean; upnp?: boolean; thread?: boolean
  nat_port_randomization?: boolean; ddns?: { enabled?: boolean; subdomain?: string }
  vlan?: string; vlan_capable?: boolean
}
interface Reservation { url: string; mac?: string; ip?: string; description?: string }

/** IPv4 as an integer so .20 sorts before .100. */
const ipKey = (ip?: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip ?? '')
  return m ? m.slice(1).reduce((a, o) => a * 256 + Number(o), 0) : null
}

/* A function, not a constant. Every t() inside a module-level literal
   runs once at import — before any language is in force — so the
   English it returns is frozen there for the life of the page. */
const MODE_LABEL = (): Record<string, string> => ({
  wpa2: t('network.wpa2_only'),
  wpa2_wpa3: t('network.wpa2_wpa3'),
  wpa3: t('network.wpa3_only'),
})
const FIELD =
  'rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-2 text-[13px]'

interface Plan { down_mbps?: number | null; up_mbps?: number | null }

/**
 * The speeds the plan is sold as, kept on the Eeronaut host (eero has no
 * field for them). The Dashboard and Insights draw them as a level across the
 * speed-test charts and say when a reading falls short, so this is where the
 * comparison gets its figures.
 *
 * A form with a Save button rather than two live fields: the figures come off
 * a bill, and somebody typing 1,000 should not have 1, 10 and 100 written on
 * the way there. Empty clears a direction, which is how a plan with no upload
 * figure is recorded.
 */
function ServicePlan({ run, busy }: {
  run: (fn: () => Promise<unknown>, ok: string) => void
  busy: boolean
}) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [down, setDown] = useState('')
  const [up, setUp] = useState('')
  useEffect(() => {
    api.get<Plan>('/api/network/plan').then((p) => {
      setPlan(p ?? {})
      setDown(p?.down_mbps != null ? String(p.down_mbps) : '')
      setUp(p?.up_mbps != null ? String(p.up_mbps) : '')
    }).catch(() => setPlan({}))
  }, [])

  const parse = (raw: string): number | null | undefined => {
    const v = raw.trim()
    if (v === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n > 0 && n <= 100_000 ? n : undefined
  }
  const nextDown = parse(down), nextUp = parse(up)
  const valid = nextDown !== undefined && nextUp !== undefined
  const dirty = plan != null && (
    (nextDown ?? null) !== (plan.down_mbps ?? null)
    || (nextUp ?? null) !== (plan.up_mbps ?? null))

  return (
    /* A rule above rather than below, the way the Dynamic DNS block before it
       is built: this is the last row of the card, and a bottom rule here would
       be a line under nothing. */
    <div className="mt-3 border-t border-[var(--color-line)] pt-3">
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || !dirty) return
          const body = { down_mbps: nextDown ?? null, up_mbps: nextUp ?? null }
          run(async () => { setPlan(await api.put<Plan>('/api/network/plan', body) ?? body) },
              t('network.plan_saved'))
        }}
      >
        <div>
          <span className="micro-label block">{t('network.service_plan')}</span>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {t('network.service_plan_hint')}
          </p>
        </div>
        {/* Three equal columns across the card; a column each on a phone. */}
        <div className="grid items-end gap-3 sm:grid-cols-3">
          {([['down', down, setDown, t('network.plan_download')],
             ['up', up, setUp, t('network.plan_upload')]] as const).map(([k, v, set, label]) => (
            <label key={k} className="min-w-0 text-[12px] text-[var(--color-ink-2)]">
              <span className="micro-label block">{label}</span>
              <span className="mt-1 flex items-baseline gap-1.5">
                <input
                  value={v}
                  onChange={(e) => set(e.target.value)}
                  inputMode="decimal"
                  placeholder="—"
                  aria-label={label}
                  aria-invalid={parse(v) === undefined}
                  disabled={plan == null || busy}
                  className={`w-full min-w-0 tabular-nums ${FIELD}`}
                />
                <span className="text-[12px] text-[var(--color-ink-3)]">{t('dashboard.mbps')}</span>
              </span>
            </label>
          ))}
          <SubmitButton type="submit" disabled={!valid || !dirty || busy} full>
            {t('network.save')}
          </SubmitButton>
        </div>
      </form>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] py-2 last:border-0">
      <span className="micro-label">{label}</span>
      <span className="text-[13px] text-[var(--color-ink)]">{children}</span>
    </div>
  )
}


const PREFIXES = [
  { cidr: '192.168.0.0/16', subnet: '192.168.4.0', mask: '255.255.255.0' },
  { cidr: '10.0.0.0/8', subnet: '10.0.0.0', mask: '255.255.255.0' },
  { cidr: '172.16.0.0/12', subnet: '172.16.0.0', mask: '255.255.255.0' },
]

type Mode = 'automatic' | 'manual' | 'bridge'

function LanMode({ lan, busy, run }: {
  lan: Lan
  busy: boolean
  run: (fn: () => Promise<unknown>, ok: string) => void
}) {
  const current: Mode = lan.mode ?? 'automatic'
  const currentNat = Boolean(lan.nat_port_randomization)
  const [mode, setMode] = useState<Mode>(current)
  const [nat, setNat] = useState(currentNat)
  useEffect(() => { setMode(current); setNat(currentNat) }, [current, currentNat])

  const cust = lan.dhcp_custom ?? {}
  /* Anything the form is holding that the network does not have yet. The
     Apply button follows this rather than the mode alone: with only the mode
     checked, changing the checkbox on a network already in that mode left
     nothing able to commit it. */
  const dirty = mode !== current || nat !== currentNat

  function applyMode(next: Mode, extra?: Record<string, string>) {
    /* One key per mode rather than a sentence assembled from fragments: a
       translator needs the whole warning to move its clauses around, and three
       whole warnings are three ordinary strings. */
    const warn = next === 'bridge' ? t('network.confirm_bridge')
      : next === 'manual' ? t('network.confirm_manual')
      : t('network.confirm_automatic')
    if (!window.confirm(warn)) return
    /* Two endpoints, one commit: the mode and the randomization flag live in
       different places on eero's side, and the form does not care. */
    run(async () => {
      if (next !== current || extra) {
        await api.put('/api/network/mode', { mode: next, ...extra })
      }
      if (nat !== currentNat) {
        await api.put('/api/network/lan', { nat_port_randomization: nat })
      }
    }, next !== current
         ? t('network.lan_mode_set_to', { mode: next })
         : t('network.saved'))
  }

  return (
    <div className="grid gap-3">
      <div>
        {/* No heading. Automatic / Manual / Bridge are the whole vocabulary of
            the choice, and a "Mode" label above them named the control rather
            than telling anyone anything. The group keeps its accessible name,
            which is where that word is still doing work. */}
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('network.lan_mode')}>
          {(['automatic', 'manual', 'bridge'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={busy}
              onClick={() => setMode(m)}
              className={`rounded-md border px-3 py-1.5 text-[13px] font-medium capitalize ${
                mode === m
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
                  : 'border-[var(--color-line-strong)]'}`}
            >
              {m === 'manual' ? t('network.manual_ip') : m}
            </button>
          ))}
          {/* Any of the three, applied, restarts the mesh (the table in
              measured, not assumed), and the commit buttons live inside the
              panel below; the mark sits with the choice so it is seen before
              one is made. */}
          <RebootMark className="ml-auto" />
        </div>
      </div>

      {/* The panel starts below the buttons. It is the pending-until-applied
          part — fields and a commit button — and the three buttons are not
          that: they pick which form you get. Inside the panel they read as the
          first row of a form they actually govern. */}
      <div className="grid gap-3 rounded-md border border-[var(--color-line)]
                      bg-[var(--color-surface-2)] p-3">
      {mode === 'bridge' && (
        <div className="grid gap-3">
          <p className="text-[13px] leading-relaxed text-[var(--color-ink-3)]">
            {t('network.bridge_mode_eeros_do_no')}
          </p>
          {/* Every mode commits with the same button in the same place. The
              three used to be hand-rolled separately — a red outline, a gray
              outline and a filled blue one, at two different heights — so
              which mode you had picked changed what the commit looked like.
              Bridge keeps a color of its own because it is the one that is
              hard to undo; nothing else about it differs. */}
          {/* Bridge has nothing to configure, so once it is on there is no
              such thing as saving changes here — the button becomes a
              statement of fact rather than an action. */}
          <ModeApply
            disabled={busy || current === 'bridge'}
            onClick={() => applyMode('bridge')}
            label={current === 'bridge'
              ? t('network.you_bridge_mode') : MODE_ACTION().bridge}
            title={current === 'bridge'
              ? t('network.bridge_mode_has_nothing_configure') : undefined}
          />
        </div>
      )}

      {mode === 'automatic' && (
        <div className="grid gap-3">
          <NatPortMode value={nat} onChange={setNat} busy={busy} />
          <ModeApply
            disabled={busy || !dirty}
            onClick={() => applyMode('automatic')}
            label={current === 'automatic' ? t('network.save_changes') : MODE_ACTION().automatic}
            title={dirty ? undefined : t('network.nothing_save')}
          />
        </div>
      )}

      {mode === 'manual' && (
        <form
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget as HTMLFormElement)
            applyMode('manual', {
              subnet_ip: String(f.get('subnet_ip')),
              subnet_mask: String(f.get('subnet_mask')),
              start_ip: String(f.get('start_ip')),
              end_ip: String(f.get('end_ip')),
            })
          }}
        >
          <label className="sm:col-span-2 text-[12px] text-[var(--color-ink-2)]">
            {t('network.address_prefix')}
            <select
              className={`mt-1 w-full ${FIELD}`}
              defaultValue={PREFIXES[0].cidr}
              onChange={(e) => {
                const pfx = PREFIXES.find((x) => x.cidr === e.target.value)
                if (!pfx) return
                const form = e.currentTarget.form
                if (!form) return
                ;(form.elements.namedItem('subnet_ip') as HTMLInputElement).value = pfx.subnet
                ;(form.elements.namedItem('subnet_mask') as HTMLInputElement).value = pfx.mask
                ;(form.elements.namedItem('start_ip') as HTMLInputElement).value =
                  pfx.subnet.replace(/\.0$/, '.2')
                ;(form.elements.namedItem('end_ip') as HTMLInputElement).value =
                  pfx.subnet.replace(/\.0$/, '.254')
              }}
            >
              {PREFIXES.map((x) => <option key={x.cidr} value={x.cidr}>{x.cidr}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.subnet_ip')}
            <input name="subnet_ip" required defaultValue={cust.subnet_ip ?? '192.168.4.0'}
              className={`mt-1 w-full ${FIELD}`} /></label>
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.subnet_mask')}
            <input name="subnet_mask" required defaultValue={cust.subnet_mask ?? '255.255.255.0'}
              className={`mt-1 w-full ${FIELD}`} /></label>
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.starting_ip')}
            <input name="start_ip" required defaultValue={cust.start_ip ?? '192.168.4.2'}
              className={`mt-1 w-full ${FIELD}`} /></label>
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.ending_ip')}
            <input name="end_ip" required defaultValue={cust.end_ip ?? '192.168.4.254'}
              className={`mt-1 w-full ${FIELD}`} /></label>
          <div className="sm:col-span-2">
            <NatPortMode value={nat} onChange={setNat} busy={busy} />
          </div>
          {/* Always enabled: unlike the other two, this pane has fields, so
              re-submitting a changed range is a real thing to do even when the
              network is already in this mode. */}
          <div className="sm:col-span-2">
            <ModeApply type="submit" disabled={busy}
                       label={current === 'manual' ? t('network.save_changes') : MODE_ACTION().manual} />
          </div>
        </form>
      )}
      </div>

    </div>
  )
}

/**
 * The uplink VLAN tag.
 *
 * Some providers hand off tagged traffic and the gateway has to tag its uplink
 * to match; eero's own app calls this "Uplink VLAN Tag" and validates 1-4094
 * before sending. Shown only where eero says the network is capable of it.
 *
 * The warning is not boilerplate. A wrong tag stops the gateway talking to the
 * provider at all, and unlike most settings there is no way to undo it from
 * here afterward — the interface is on the far side of the link that just
 * went down. This is also the one write in the app I could not test against
 * live hardware for exactly that reason, so the endpoint re-reads the network
 * and reports whether the tag actually took rather than assuming it did.
 */
function UplinkVlan({ lan, busy, run }: {
  lan: Lan
  busy: boolean
  run: (fn: () => Promise<unknown>, ok: string) => void
}) {
  const current = lan.vlan ?? ''
  const [on, setOn] = useState(Boolean(current))
  const [value, setValue] = useState(current)
  useEffect(() => { setOn(Boolean(current)); setValue(current) }, [current])

  const tag = on ? value.trim() : ''
  const dirty = tag !== current
  const valid = !tag || (/^\d+$/.test(tag) && Number(tag) >= 1 && Number(tag) <= 4094)

  return (
    <div className="border-b border-[var(--color-line)] py-2 last:border-0">
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          /* Two whole warnings, not one assembled from a question plus a
             shared tail. The tail reads as a separate sentence in English and
             has to fuse with the question in other languages. */
          if (!window.confirm(tag
                ? t('network.confirm_vlan_tag', { tag })
                : t('network.confirm_vlan_remove'))) return
          run(() => api.put('/api/network/uplink-vlan', { vlan: tag }),
              tag ? t('network.uplink_tagged_vlan', { tag })
                  : t('network.uplink_vlan_tag_removed'))
        }}
      >
        {/* A dot rather than a switch, because this is a form with a commit
            button: nothing happens until it is pressed. The input only exists
            while the dot is on, which is how eero's own ISP settings screen
            behaves — `enable_vlan_tag_switch` reveals `vlan_tag_input`. */}
        <Check
          label={t('network.uplink_vlan_tag')}
          hint={t('network.only_if_your_provider_requires')}
          checked={on}
          disabled={busy}
          onChange={(v) => { setOn(v); if (!v) setValue('') }}
        />

        {on && (
          /* Indented to the checkbox's label, not to some fraction of it. The
             control is 36px wide with a 12px gap, so the text above starts at
             48px — `pl-7` put this block 20px to the left of it and the field
             looked attached to nothing. */
          <div className="flex flex-wrap items-end gap-2 pl-12">
            <label className="text-[12px] text-[var(--color-ink-2)]">
              <span className="micro-label block">{t('network.vlan_id')}</span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                inputMode="numeric"
                placeholder="1 – 4094"
                aria-label={t('network.vlan_id')}
                aria-invalid={!valid}
                className={`mt-1 w-28 font-mono ${FIELD}`}
              />
            </label>
            <ModeApply
              type="submit"
              disabled={busy || !dirty || !valid || !tag}
              label={current ? t('network.save_changes') : t('network.apply_vlan_tag')}
              title={!valid ? t('network.whole_number_between_1_4094') : dirty ? undefined : t('network.nothing_change')}
            />
          </div>
        )}

        {on && !valid && (
          <p className="pl-7 text-[12px] text-[var(--color-bad-ink,var(--color-bad))]">
            {t('network.vlan_id_not_valid_enter')}
          </p>
        )}

        {!on && current && (
          <div className="pl-7">
            <ModeApply
              type="submit"
              disabled={busy}
              label={t('network.remove_vlan_current', { current: current })}
            />
          </div>
        )}
      </form>
    </div>
  )
}

interface Pause {
  paused: boolean; expires_on?: string | null; six_ghz?: boolean
  /** How many minutes eero gave the pause, known only from the write that
   *  set it: the request names no length and eero publishes none ahead. */
  duration_minutes?: number | null
  /** The length as last learned, kept in the server's preferences so every
   *  browser can say "for N minutes" before a pause is set. */
  pause_minutes?: number | null
}
/** How long eero pauses the radios for. Measured on 15 September 2026 by
 *  setting the flag on a live network and reading the expiry eero attached:
 *  30.00 minutes, to the second. The server keeps the same figure until a
 *  pause says otherwise; this covers the moment before it has answered. */
const PAUSE_MINUTES_DEFAULT = 30
/** Where this browser kept a learned length before the server did. */
const OLD_PAUSE_MINUTES_KEY = 'eeronaut.band-pause.minutes'

/**
 * Temporarily restrict the network to 2.4 GHz.
 *
 * eero calls this a temporary flag rather than a setting, and it behaves like
 * one: the flag carries its own expiry and the radios come back without anyone
 * asking. Nothing in the request names a duration — the server decides — so
 * the countdown here reads the expiry eero returned rather than assuming a
 * length. If eero returns no expiry, the row says the radios are restricted
 * and does not invent a time.
 */
function BandPause({ busy, runIn, say }: {
  busy: boolean
  runIn: (into: CardSay, fn: () => Promise<unknown>, ok: string,
          key?: string) => Promise<void>
  say: CardSay
}) {
  const [st, setSt] = useState<Pause | null>(null)
  const [now, setNow] = useState(() => Date.now())
  /* The pause's length in minutes: whatever eero handed back the last time a
     pause was set, as the server remembers it. eero decides it when the flag
     is written and says nothing about it before, so a pause is the only
     place to read it. */
  const minutes = st?.pause_minutes || PAUSE_MINUTES_DEFAULT

  const load = useCallback(() => {
    api.get<Pause>('/api/network/band-pause').then(setSt).catch(() => setSt(null))
  }, [])
  useEffect(load, [load])
  // The server keeps it now; the browser's old copy is not needed.
  useEffect(() => {
    try { localStorage.removeItem(OLD_PAUSE_MINUTES_KEY) } catch { /* private mode */ }
  }, [])

  /* Ticking only while something is counting down, so an idle page is not
     re-rendering once a second for no reason. */
  const until = st?.expires_on ? new Date(st.expires_on).getTime() : 0
  const live = Boolean(st?.paused) && until > now
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  // When the countdown runs out, the radios are back — ask eero rather than
  // assuming, because the flag is cleared server-side.
  useEffect(() => {
    if (st?.paused && until && until <= now) load()
  }, [st?.paused, until, now, load])

  const bands = st?.six_ghz ? t('network.bands_5_and_6') : t('network.bands_5')
  const left = (() => {
    const ms = until - now
    if (ms <= 0) return null
    const m = Math.floor(ms / 60_000)
    const sec = Math.floor((ms % 60_000) / 1000)
    return `${m}:${String(sec).padStart(2, '0')}`
  })()

  return (
    <div className="flex items-start justify-between gap-3">
      <Toggle
        label={<span className="inline-flex items-center gap-1.5">
          {t('network.pause_bands_for', { bands, minutes })}
          <RebootMark title={t('interrupt.bands', { bands })} />
        </span>}
        hint={t('network.pause_bands_hint', { bands, minutes })}
        checked={Boolean(st?.paused)}
        disabled={busy || st === null}
        /* Through the switch's own `confirm`, which runs before it moves.
           Asked inside `onChange` instead, the switch had already drawn
           itself on by the time the dialog appeared, and a No left it on
           until its optimistic guess timed out eight seconds later. Only on
           the way on: switching off needs no question. */
        confirm={() => Boolean(st?.paused)
          || window.confirm(t('network.pause_bands_temporarily_every_device', { bands, minutes }))}
        onChange={(v) => {
          return runIn(say, async () => {
            await api.put<Pause>('/api/network/band-pause', { paused: v })
          }, v ? t('network.bands_paused', { bands })
               : t('network.radios_restored'), 'band-pause').then(load)
        }}
      />
      {st?.paused && (
        <span className="shrink-0 pt-0.5 text-right">
          {left ? (
            <>
              <span className="micro-label block">{t('network.resumes')}</span>
              <span className="tabular-nums text-[13px] font-semibold
                               text-[var(--color-warn-ink,var(--color-warn))]">{left}</span>
            </>
          ) : (
            <span className="text-[12px] text-[var(--color-warn-ink,var(--color-warn))]">{t('network.restricted')}</span>
          )}
        </span>
      )}
    </div>
  )
}

/* What the commit button calls each mode. The button says what pressing it
   will do rather than leaving a warning above it to explain that the radio
   selection has not taken effect — the label carries that on its own. */
/* A function, not a constant. Every t() inside a module-level literal
   runs once at import — before any language is in force — so the
   English it returns is frozen there for the life of the page. */
const MODE_ACTION = (): Record<Mode, string> => ({
  automatic: t('network.switch_automatic_mode'),
  manual: t('network.switch_manual_ip_mode'),
  bridge: t('network.switch_bridge_mode'),
})
/**
 * The commit button every LAN mode uses.
 *
 * One component so the three panes cannot drift apart again, and left-aligned
 * in all three rather than full-width in one of them.
 */
function ModeApply({ label, onClick, disabled, tone, title, type = 'button' }: {
  label: string
  onClick?: () => void
  disabled?: boolean
  tone?: 'accent' | 'bad'
  title?: string
  type?: 'button' | 'submit'
}) {
  return (
    <SubmitButton type={type} tone={tone} disabled={disabled} title={title}
                  onClick={onClick} className="justify-self-start">
      {label}
    </SubmitButton>
  )
}

/**
 * DNS, as its own pane.
 *
 * It used to be the bottom third of the LAN card, which put a resolver setting
 * under a heading about address ranges and left it competing with the LAN
 * mode's own commit button. It is also the pair that was worst off for
 * consistency: Custom had a proper submit button and ISP had a five-pixel
 * "apply" text link that only appeared when custom was already in force, so
 * the way back was easy to miss entirely. Both branches are forms now, with
 * the same button.
 */
/* Public resolvers, offered as a shortcut for the custom-DNS form.

   Two sources, both read rather than recalled — a wrong digit here silently
   stops the whole network resolving names, and "it looked right" is not a
   standard worth applying to that:

     - Each provider's own published address page, for Cloudflare, AdGuard,
       Quad9 and Google, including the filtering variants.
     - A third-party open-source resolver list for Google, OpenDNS, Level3,
       Comodo and the three Quad9 variants, IPv6 included. Worth knowing which
       is which: the entries in the second group were not cross-checked against
       the operator's own documentation, because those pages could not be
       retrieved at the time, so if one of them is ever doubted it is the one to
       re-verify.

   OpenDNS FamilyShield is deliberately absent: it was in neither source, so
   its addresses are unconfirmed.
   Querying a resolver to check it is no use as verification either — this
   network intercepts DNS and answers locally whatever address you aim at.

   `nested` marks a variant of the entry above it, indented in the list. The
   unindented entry for each provider is its plain resolver, the one that does
   no content filtering; the filtered products hang under it. That puts Quad9's
   9.9.9.10 and AdGuard's 94.140.14.140 at the top level rather than their
   better-known filtered addresses, which is the deliberate trade: the parent is
   the one that only resolves.

   Product names stay in English, like DHCP and PPPoE elsewhere in this pane.
   They are what the provider calls the service, and translating "Family
   protection" would leave someone comparing this against AdGuard's own page
   with two names for one thing. */
/* A mark for one property of a resolver. Same shape and weight as the eero
   Plus mark elsewhere, because it does the same job: a small standing claim
   about the thing beside it, not a control. */
function TermMark({ word }: { word: string }) {
  return (
    <span className="shrink-0 rounded bg-[var(--color-accent-wash)] px-1.5
                     text-[10px] font-semibold uppercase tracking-wide
                     text-[var(--color-accent-ink)]">
      {word}
    </span>
  )
}

/* The resolver picker.

   A listbox rather than a <select>, because an <option> can hold text and
   nothing else and the whole point here is that the properties are marks. The
   keyboard behavior is the one a select has — arrows move, Home and End jump,
   Enter and Space choose, Escape closes — and the pattern is the same one the
   device-type picker and the network switcher already use.

   Nested entries are indented rather than grouped: an optgroup label cannot be
   selected, and the parent here is a resolver in its own right. */
function ResolverPicker({ value, onPick, disabled }: {
  value: string
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const items = [{ id: '', label: t('network.dns_my_own'), nested: false,
                   terms: [] as string[] },
                 ...RESOLVERS.map((r) => ({
                   id: r.id, label: cleanLabel(r), nested: Boolean(r.nested),
                   terms: termsOf(r) }))]
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setActive(Math.max(0, items.findIndex((i) => i.id === value)))
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps

  const current = items.find((i) => i.id === value) ?? items[0]
  const choose = (id: string) => { setOpen(false); if (id !== value) onPick(id) }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault(); setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1) }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(items[active].id) }
  }

  return (
    <div ref={box} className="relative mt-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('network.dns_provider')}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center gap-2 text-left ${FIELD}
                    disabled:opacity-50`}
      >
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        {current.terms.map((w) => <TermMark key={w} word={w} />)}
        <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-[var(--color-ink-3)]"
             fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t('network.dns_provider')}
          tabIndex={-1}
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto
                     rounded-md border border-[var(--color-line)]
                     bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {items.map((it, i) => (
            <li key={it.id || 'custom'}>
              <button
                type="button"
                role="option"
                aria-selected={it.id === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(it.id)}
                className={`flex w-full items-center gap-2 py-1.5 pr-2 text-left
                            text-[13px] ${it.nested ? 'pl-7' : 'pl-2'} ${
                  i === active ? 'bg-[var(--color-surface-2)]' : ''} ${
                  it.id === value ? 'font-semibold' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.terms.map((w) => <TermMark key={w} word={w} />)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A dotted quad with every octet in range.
 *
 *  The same check eero's own app makes before it sends a reservation —
 *  `ValidationUtils.isValidIP4`, which is Android's `Patterns.IP_ADDRESS`.
 *  Format only, like the app: whether the address is inside the subnet is
 *  eero's to answer, and it does, with `error.reservation.ip.invalid`.
 *  Guessing at the subnet here would invent a rule eero already owns and get it wrong on a
 *  network with more than one. */
const isIpv4 = (v: string) => {
  const parts = v.trim().split('.')
  return parts.length === 4 && parts.every(
    (p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/* Bridge mode turns the eeros into access points: they stop routing, so
   everything that is a routing feature stops existing. eero's own list —
   support/articles/what-features-do-i-lose-if-i-put-my-eeros-in-bridge-mode —
   is local DNS caching, Smart Queue Management, Thread, upstream IPv6, custom
   DNS, UPnP, reservations, and port forwarding, and eero Plus features other
   than the partner subscriptions.

   Hidden rather than dimmed, and hidden with a sentence saying why. A dimmed
   switch invites somebody to work out what would un-dim it; there is no answer
   here except leaving bridge mode, so the honest thing is to say that once per
   card and take the controls away. The app's own screens do the same, with a
   `BridgeModeWarningContent` footnote. */
function BridgedNote({ what }: { what: string }) {
  return (
    <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
      {tx('network.bridged_unavailable', { what })}
    </p>
  )
}

function DnsPane({ lan, busy, onDone }: {
  lan: Lan
  busy: boolean
  /** Re-read the network after a write, since `lan` is the page's. */
  onDone: () => void
}) {
  /* This pane renders its own Card, so it cannot be handed the card's notice
     from outside — it makes its own run from the notice the Card gives its
     children. Its own in-flight flag too: a DNS write has no business dimming
     the LAN card, the same argument as the band-security selects. */
  const [saving, setSaving] = useState(false)
  const runHere = (say: CardSay) =>
    async (fn: () => Promise<unknown>) => {
      setSaving(true); say.clear()
      try { await fn(); onDone() }
      catch (e) {
        say.fail(e instanceof ApiError ? e.message : t('network.did_not_work'))
      } finally { setSaving(false) }
    }

  const isCustom = lan.dns_mode === 'custom'
  const [custom, setCustom] = useState(isCustom)
  useEffect(() => { setCustom(isCustom) }, [isCustom])

  /* '' is "I'll use my own", and it is first and the default so the form opens
     in the state it has always been in. Picking a provider replaces the fields
     rather than filling them in: prefilling would invite an edit, and a
     half-edited copy of Quad9's addresses is not Quad9. */
  const [picked, setPicked] = useState('')
  const chosen = RESOLVERS.find((r) => r.id === picked) ?? null

  /* A provider already in force is recognized on the way in, so the pane opens
     showing what the network is actually using instead of defaulting to "my own"
     over the top of somebody else's addresses. */
  /* Seeded from the addresses themselves, not from the array holding them,
     and only while the picker is untouched.

     Both halves were bugs. `lan.dns_v4` is a fresh array on every fetch even
     when the addresses are identical, so this pane's background refresh
     re-ran the effect on a timer and re-seeded the picker from the server.
     Somebody who chose a resolver and paused before submitting watched the
     dropdown drop their choice and go back to Custom on its own, which is the
     one thing a form must never do.

     The touched flag covers the rarer case the string comparison does not: the
     addresses really changing under an unsaved choice, from another tab or
     from eero's own app. Following the server there would be just as wrong.
     Submitting or canceling clears it, so the pane goes back to tracking. */
  const touched = useRef(false)
  const haveV4 = (lan.dns_v4 ?? []).join(',')
  useEffect(() => {
    if (touched.current) return
    const match = RESOLVERS.find((r) => r.v4.join(',') === haveV4)
    setPicked(match ? match.id : '')
  }, [haveV4])

  const v4 = lan.dns_v4 ?? []
  const v6 = lan.dns_v6 ?? []

  /* What the provider itself advertises, in the order it advertises it. The
     two halves come from different places on eero's network object: the IPv4
     pair from the DNS block's parent, the IPv6 pair from the IPv6 lease. The
     app's condition for the IPv6 rows is copied rather than invented — the
     network has to be IPv6-capable, and a blank slot is not a row. Labeled
     from the position eero gave the address, so a first slot that is empty
     does not promote the second one to primary. */
  const ispResolvers = [
    ...(lan.dns?.parent?.ips ?? []).map((ip, i) => ({
      ip, label: i === 0 ? t('network.ipv4_primary')
                : i === 1 ? t('network.ipv4_secondary') : '' })),
    ...(lan.ipv6_capable ? (lan.ipv6_lease?.name_servers ?? []) : []).map((ip, i) => ({
      ip, label: i === 0 ? t('network.ipv6_primary')
                : i === 1 ? t('network.ipv6_secondary') : '' })),
  ].filter((r) => r.ip?.trim())
  const bridged = (lan.mode ?? 'automatic') === 'bridge'
  /* Absent means an older backend that does not send it; an absent answer is
     not a locked one, so the form stays. */
  const lockedByPlus = lan.dns_editable === false

  return (
    <Card icon="dns" title={t('network.dns')} anchor="dns">{(paneSay) => (<>
      {bridged ? (
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('network.eeros_bridge_mode_do_no')}
        </p>
      ) : lockedByPlus ? (
        /* Not a disabled form. eero Plus filtering works by answering DNS at
           eero's resolver, so pointing the network elsewhere would carry the
           filtering off with it, and eero refuses the change while any policy
           is on. It counts policies on profiles too: SafeSearch on one profile
           locks DNS for the whole network, which is why this says every
           feature rather than naming one. */
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('network.dns_locked_by_plus')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('network.dns_mode')}>
            {[[t('network.isp_dns_default'), false],
              [t('network.custom_dns'), true]].map(([label, want]) => (
              <button key={String(label)} type="button" role="radio"
                aria-checked={custom === want} disabled={busy}
                onClick={() => setCustom(want as boolean)}
                className={`rounded-md border px-3 py-1.5 text-[13px] font-medium ${
                  custom === want
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
                    : 'border-[var(--color-line-strong)]'}`}>
                {label}
              </button>
            ))}
            {/* Changing the resolvers restarts the mesh; said here, with the
                choice, as on the LAN pane. */}
            <RebootMark className="ml-auto" />
          </div>

          {!custom ? (
            /* The same tinted panel the custom branch uses. Both branches are
               one group of related things under the two tabs, and only one of
               them looked like it — which made the tabs read as switching
               between a panel and some loose text rather than between two
               forms. */
            <form
              className="mt-3 grid gap-2 rounded-md border border-[var(--color-line)]
                         bg-[var(--color-surface-2)] p-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (!window.confirm(t('network.hand_dns_back_your_provider'))) return
                void runHere(paneSay)(
                  () => api.put('/api/network/dns', { mode: 'automatic' }))
              }}
            >
              <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
                {t('network.resolution_handled_your_provider_whatever')}
              </p>
              {/* Labeled by position, the way eero's own app labels them,
                  and not "in use". These are the addresses the provider
                  advertises on the WAN link, which eero reports whichever
                  mode is in force: on a network running custom DNS they are
                  what switching back would return to, not what is answering
                  now. Reported as a list rather than two fixed slots, so a
                  third address is shown rather than dropped. */}
              {ispResolvers.length > 0 && (
                <dl className="grid gap-1 text-[12px]">
                  {ispResolvers.map(({ ip, label }) => (
                    <div key={ip} className="flex justify-between gap-4">
                      <dt className="text-[var(--color-ink-3)]">{label}</dt>
                      <dd className="ml-auto min-w-0 break-all text-right font-mono">{ip}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {/* Nothing to configure on this branch, so once it is in force
                  the button is a statement rather than an action — the same
                  shape bridge mode takes on the LAN pane. */}
              <SubmitButton
                disabled={busy || saving || !isCustom}
                className="justify-self-start"
                title={isCustom ? undefined : t('network.isp_dns_has_nothing_configure')}
              >
                {isCustom ? t('network.switch_isp_dns') : t('network.you_using_isp_dns')}
              </SubmitButton>
            </form>
          ) : (
            <form
              className="mt-3 grid gap-2 rounded-md border border-[var(--color-line)]
                         bg-[var(--color-surface-2)] p-3"
              onSubmit={(e) => {
                e.preventDefault()
                let ipv4: string[]
                let ipv6: string[]
                if (chosen) {
                  ipv4 = chosen.v4
                  ipv6 = chosen.v6
                } else {
                  const f = new FormData(e.currentTarget as HTMLFormElement)
                  ipv4 = [String(f.get('v4a')), String(f.get('v4b'))].filter((x) => x.trim())
                  ipv6 = [String(f.get('v6a')), String(f.get('v6b'))].filter((x) => x.trim())
                }
                if (!ipv4.length && !ipv6.length) return
                if (!window.confirm(chosen
                  ? t('network.confirm_resolver', { name: fullName(chosen),
                                                    ips: ipv4.join(', ') })
                  : t('network.use_these_dns_servers_if'))) return
                /* Written, so the pane may follow the server again. Cleared
                   before the request rather than after it: on success the
                   server is about to agree with the picker anyway, and on
                   failure the reseed is what shows what the network is really
                   set to. */
                touched.current = false
                void runHere(paneSay)(
                  () => api.put('/api/network/dns', { mode: 'custom', ipv4, ipv6 }))
              }}
            >
              <div className="text-[12px] text-[var(--color-ink-2)]">
                {t('network.dns_provider')}
                {/* "Custom" is always first and always the default. */}
                <ResolverPicker
                  value={picked}
                  onPick={(id) => { touched.current = true; setPicked(id) }}
                  disabled={busy} />
              </div>

              {/* The fields collapse rather than being hidden outright, so the
                  pane does not jump the height of four inputs on a selection.
                  They are unmounted at the end of it, not merely faded: a
                  hidden input still submits, and a stale address left in one
                  would go out with the provider's. */}
              <AutoHeight>
                {chosen ? (
                  <div className="grid gap-1.5">
                    {/* The addresses as a labeled pair rather than a sentence.
                        Two IPv6 addresses inside running prose is a wall to
                        read, and what somebody checks here is whether these
                        are the addresses they expected — which wants a column
                        to scan, not a clause to parse. */}
                    <div className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">
                      <p className="flex flex-wrap items-center gap-2
                                    font-medium text-[var(--color-ink)]">
                        {fullName(chosen)}
                        {termsOf(chosen).map((w) => <TermMark key={w} word={w} />)}
                      </p>
                      {aboutFor(chosen) && (
                        <p className="mt-0.5 text-[var(--color-ink-3)]">
                          {aboutFor(chosen)}
                        </p>
                      )}
                      <dl className="mt-0.5 grid gap-0.5">
                        <div className="flex gap-2">
                          <dt className="w-10 shrink-0 text-[var(--color-ink-3)]">IPv4</dt>
                          <dd className="min-w-0 break-all font-mono">
                            {chosen.v4.join(', ')}
                          </dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="w-10 shrink-0 text-[var(--color-ink-3)]">IPv6</dt>
                          <dd className="min-w-0 break-all font-mono">
                            {chosen.v6.join(', ')}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    {/* What the acronyms in the provider's own name actually
                        mean. "Google Public DNS (ECS, DNSSEC)" is the
                        published label and the right one to keep, but it is two
                        initialisms deep for anyone who has not met them before,
                        and both describe a trade worth understanding first.

                        Only what the provider offers. An earlier version also
                        explained the absence of DNSSEC, which meant a line
                        about it appeared under every provider either way —
                        turning an explanation into boilerplate. */}
                    {notesFor(chosen).length > 0 && (
                      <ul className="grid gap-1 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                        {notesFor(chosen).map((k) => (
                          <li key={String(k)}>
                            {k === 'ecs' ? t('network.explain_ecs')
                              : k === 'filtered' ? t('network.explain_filtered')
                                : t('network.explain_dnssec')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.ipv4_primary')}
                      <input name="v4a" defaultValue={v4[0] ?? ''} placeholder="1.1.1.1"
                        className={`mt-1 w-full font-mono ${FIELD}`} /></label>
                    <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.ipv4_secondary')}
                      <input name="v4b" defaultValue={v4[1] ?? ''} placeholder="1.0.0.1"
                        className={`mt-1 w-full font-mono ${FIELD}`} /></label>
                    <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.ipv6_primary')}
                      <input name="v6a" defaultValue={v6[0] ?? ''} placeholder="2606:4700:4700::1111"
                        className={`mt-1 w-full font-mono ${FIELD}`} /></label>
                    <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.ipv6_secondary')}
                      <input name="v6b" defaultValue={v6[1] ?? ''} placeholder="2606:4700:4700::1001"
                        className={`mt-1 w-full font-mono ${FIELD}`} /></label>
                  </div>
                )}
              </AutoHeight>

              <SubmitButton disabled={busy || saving} className="justify-self-start">
                {isCustom ? t('network.save_changes') : t('network.switch_custom_dns')}
              </SubmitButton>
            </form>
          )}

          {/* Local caching, which is a different question from which resolver
              to use — the eeros answering repeat lookups themselves rather
              than going out for every one. Shown only where eero says the
              network can do it: it wants recent firmware and a routing
              connection mode, and offering a switch that cannot work is worse
              than not offering it.

              Restarts the mesh. eero's own app puts its "Reboot required"
              dialog in front of the same change, in
              `LocalDnsCachingViewModel`. */}
          {lan.dns_caching_visible && (
            <div className="mt-3 border-t border-[var(--color-line)] pt-3">
              <Toggle
                label={<span className="inline-flex items-center gap-1.5">
                  {t('network.dns_caching')}<RebootMark />
                </span>}
                hint={t('network.dns_caching_hint')}
                checked={Boolean(lan.dns_caching)}
                disabled={busy || saving}
                confirm={() => confirmReboot(t('network.dns_caching'))}
                onChange={(v) => runHere(paneSay)(
                  () => api.put('/api/network/dns-caching', { enabled: v }))}
              />
            </div>
          )}
        </>
      )}
    </>)}</Card>
  )
}

/**
 * NAT port randomization, as a checkbox rather than a switch.
 *
 * It sits inside the LAN mode form, and a sliding switch there was making a
 * promise the form does not keep: the slider moved, the write went out
 * immediately, and the Apply button beside it implied otherwise. It is now
 * pending state like every other field in the form, applied when the form is.
 */
/* An action that belongs to the value beside it.

   Rename and Change were orange outlined pills, which put two warning-colored
   controls in a card where nothing is wrong — and they sat next to Reveal,
   which was already a plain blue link doing the same kind of job, so one row
   had two different vocabularies for "act on this". All three are the same
   thing now: a quiet link after the value it acts on. What makes a rename safe
   is the confirmation form it opens, which spells out that devices do not
   follow a rename; the button's color was never doing that work. */
function InlineAction({ onClick, disabled, children, title }: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="shrink-0 rounded text-[13px] text-[var(--color-accent-ink)]
                 underline-offset-2 hover:underline
                 focus-visible:outline focus-visible:outline-2
                 focus-visible:outline-offset-2
                 focus-visible:outline-[var(--color-accent)]
                 disabled:cursor-default disabled:text-[var(--color-ink-3)]
                 disabled:no-underline"
    >
      {children}
    </button>
  )
}

function NatPortMode({ value, onChange, busy }: {
  value: boolean
  onChange: (v: boolean) => void
  busy: boolean
}) {
  return (
    <Check
      label={t('network.nat_port_randomization')}
      hint={t('network.randomizes_outbound_source_ports_slightly')}
      checked={value} disabled={busy} onChange={onChange}
    />
  )
}


type Wan = 'dhcp' | 'static' | 'pppoe'
const WAN_LABEL: Record<Wan, string> = {
  dhcp: 'DHCP', static: t('network.wan_static_ip'), pppoe: 'PPPoE',
}

/* How the gateway gets its address from the provider. The PPPoE fields only
   exist while PPPoE is the selected mode — showing credentials for a protocol
   the connection does not use invites someone to fill them in and take the
   network offline. */
function WanMode({ lan, busy, run }: {
  lan: Lan
  busy: boolean
  run: (fn: () => Promise<unknown>, ok: string) => void
}) {
  const current: Wan = lan.wan_mode ?? 'dhcp'
  const [mode, setMode] = useState<Wan>(current)
  const pppoe = useCapability('pppoe')
  useEffect(() => { setMode(current) }, [current])
  const st = lan.static_lease ?? {}

  const warn = (next: Wan) =>
    t('network.confirm_wan_change', { mode: WAN_LABEL[next] })

  return (
    <div className="border-b border-[var(--color-line)] py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="micro-label">{t('network.connection_type')}</span>
        <div className="flex gap-1" role="radiogroup" aria-label={t('network.connection_type')}>
          {(['dhcp', 'static', 'pppoe'] as Wan[]).map((m) => {
            /* One option of three, so what is refused is the option, not the
               row: a corner mark has nowhere to sit on a radio, and marking
               the row would take DHCP and static down with it. eero reports
               `pppoe` as unsupported on hardware that cannot speak it, and
               this used to offer it anyway. */
            const off = m === 'pppoe' && !pppoe.available
            return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={busy || off}
              title={off ? (pppoe.explanation || t('capabilities.hardware_cannot'))
                         : undefined}
              onClick={() => setMode(m)}
              className={`rounded-md border px-2.5 py-1 text-[12px] font-medium ${
                off ? 'cursor-not-allowed opacity-40 border-[var(--color-line-strong)] text-[var(--color-ink-3)]' :
                mode === m
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
                  : 'border-[var(--color-line-strong)] text-[var(--color-ink-2)]'}`}
            >
              {WAN_LABEL[m]}
            </button>
            )
          })}
        </div>
      </div>

      {/* The selected mode's form in a panel of its own, so the boundary
          between the fields being edited and the rest of the Internet pane is
          visible. Same treatment as the LAN addressing form; the card animates
          its own height, so it grows and shrinks as the forms swap. */}
      <AutoHeight className="mt-2 rounded-md border border-[var(--color-line)]
                             bg-[var(--color-surface-2)] p-3">
      {/* The three commits are one component, as on the LAN pane: this one
          used to be a bespoke red outline button that only appeared when DHCP
          was not already in force, beside two filled ones that always did. */}
      {mode === 'dhcp' && (
        <div>
          <ModeApply
            disabled={busy || current === 'dhcp'}
            onClick={() => {
              if (!window.confirm(warn('dhcp'))) return
              run(() => api.put('/api/network/wan', { mode: 'dhcp' }),
                  t('network.connection_set_dhcp'))
            }}
            label={current === 'dhcp' ? t('network.you_using_dhcp') : t('network.switch_dhcp')}
            title={current === 'dhcp' ? t('network.dhcp_has_nothing_configure') : undefined}
          />
        </div>
      )}

      {mode === 'static' && (
        <form
          className="grid gap-2 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget as HTMLFormElement)
            if (!window.confirm(warn('static'))) return
            run(() => api.put('/api/network/wan', {
              mode: 'static', ip: String(f.get('ip')),
              mask: String(f.get('mask')), router: String(f.get('router')),
            }), t('network.static_addressing_applied'))
          }}
        >
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('clients.ip_address')}
            <input name="ip" required defaultValue={st.ip ?? ''}
              className={`mt-1 w-full font-mono ${FIELD}`} /></label>
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.subnet_mask')}
            <input name="mask" required defaultValue={st.mask ?? ''}
              className={`mt-1 w-full font-mono ${FIELD}`} /></label>
          <label className="text-[12px] text-[var(--color-ink-2)]">{t('network.router')}
            <input name="router" required defaultValue={st.router ?? ''}
              className={`mt-1 w-full font-mono ${FIELD}`} /></label>
          <div className="sm:col-span-3">
            <ModeApply type="submit" disabled={busy}
                       label={current === 'static'
                         ? t('network.save_changes') : t('network.switch_static_ip')} />
          </div>
        </form>
      )}

      {mode === 'pppoe' && (
        <form
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            const f = new FormData(e.currentTarget as HTMLFormElement)
            if (!window.confirm(warn('pppoe'))) return
            run(() => api.put('/api/network/wan', {
              mode: 'pppoe', username: String(f.get('u')),
              password: String(f.get('p')),
            }), t('network.pppoe_applied'))
          }}
        >
          <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)] sm:col-span-2">
            {t('network.some_providers_need_username_password')}
          </p>
          <input name="u" required placeholder={t('network.pppoe_username')}
            aria-label={t('network.pppoe_username')} autoComplete="off"
            defaultValue={lan.pppoe_username ?? ''} className={FIELD} />
          <input name="p" required type="password" placeholder={t('network.pppoe_password')}
            aria-label={t('network.pppoe_password')} autoComplete="new-password" className={FIELD} />
          <div className="sm:col-span-2">
            <ModeApply type="submit" disabled={busy}
                       label={current === 'pppoe'
                         ? t('network.save_changes') : t('network.switch_pppoe')} />
          </div>
        </form>
      )}
      </AutoHeight>
    </div>
  )
}

/**
 * The network's settings, split across two tabs.
 *
 * One component rather than two pages: every pane here reads the same `lan`
 * and `wifi`, writes through the same in-flight bookkeeping and reloads the
 * same way, so splitting the file would have meant two copies of that or a
 * context to share it. The panes are the same panes; only which of them this
 * render draws changes.
 *
 * `internet` is what the connection is and how names are resolved over it —
 * the two things somebody changes when the internet itself is the subject.
 * Everything else is the network this router runs.
 */
export function Network({ show = 'network' }: { show?: 'internet' | 'network' }) {
  /* A theme with a page of its own for dynamic DNS has taken it from here. */
  const ddnsElsewhere = useClaimed('ddns')
  const internetOnly = show === 'internet'
  /* Whichever clock the reader set. These were printing eero's raw "23:00"
     whatever Settings said, which is the exact split `useClock` exists to
     stop: two conventions on one screen. */
  const { clockTime } = useClock()
  /* Opens on the last answer; the read below asks for a new one. */
  const [wifi, setWifi] = useState<Wifi | null>(
    () => lastRead<Wifi>('/api/network/wifi') ?? null)
  const [guest, setGuest] = useState<Guest | null>(
    () => lastRead<Guest>('/api/network/guest') ?? null)
  const [lan, setLan] = useState<Lan | null>(
    () => lastRead<Lan>('/api/network/lan') ?? null)
  const [res, setRes] = useState<Reservation[]>(
    () => lastRead<Reservation[]>('/api/reservations') ?? [])
  const [pw, setPw] = useState<string | null>(null)
  const [err, setErr] = useState('')
  /* One in-flight key per write, not one flag for the page.

     A single page-wide `busy` meant every switch and every commit button
     on nine cards dimmed for the length of any one round trip: turning the
     guest network on grayed out UPnP, Thread, SQM, and the reservation
     form, none of which the write touched. It reads as the page locking
     up, and on a slow reply it lasts long enough to click into.

     The WPA3 selects already worked around this with a private flag of
     their own; this generalizes that instead of repeating it. A control
     answers for its own write and nothing else. */
  const [writing, setWriting] = useState<readonly string[]>([])
  const busyWith = (key: string) => writing.includes(key)
  const [addRes, setAddRes] = useState(false)
  /* Which reservation is open for editing, by url, and the address being
     typed into it. One at a time: two open forms on one table is two places
     to press Save and no way to tell which row you are in. */
  const [editRes, setEditRes] = useState<string | null>(null)
  const [editIp, setEditIp] = useState('')
  /* The add-reservation form is controlled rather than read from FormData on
     submit, because picking a device has to fill the address field. A
     reservation almost always means "keep the address this device already
     has", so typing it out again was work the interface could do — and getting
     one digit wrong produces a reservation eero accepts and the device never
     uses. Still editable: moving a device to a different address is the other
     reason to be in this form. */
  const [resMac, setResMac] = useState('')
  const [resIp, setResIp] = useState('')
  const [editing, setEditing] = useState<'name' | 'password' | 'guest-password' | null>(null)
  const [wpa3, setWpa3] = useState<Wpa3 | null>(
    () => lastRead<Wpa3>('/api/network/wifi/wpa3') ?? null)
  /* The band a select has just been set to, held until the reload catches up.
     The guest card mirrors these values, and without this it sat on the old
     mode for the length of a round trip to eero's cloud — long enough to read
     as "the guest network did not follow", which is the one thing the mirror
     exists to deny. Same approach as Toggle and EditableText. */
  const [wpa3Guess, setWpa3Guess] = useState<Partial<Wpa3>>({})
  const [guestPw, setGuestPw] = useState<string | null>(null)
  const [guestPwErr, setGuestPwErr] = useState<string | null>(null)
  const [wpa3Busy, setWpa3Busy] = useState(false)
  /* Reveal failures are reported in the row, not only in the notice at the top
     of the page. This card is eight panes down; a notice up there is off-screen
     from here, which is how a Reveal that was answering 404 looked to somebody
     using it like "nothing happens at all". */
  const [pwErr, setPwErr] = useState<string | null>(null)
  const wpa3View = wpa3 ? { ...wpa3, ...wpa3Guess } : null
  useEffect(() => { setWpa3Guess({}) }, [wpa3])
  const [power, setPower] = useState<{ enabled: boolean } | null>(null)
  const [schedules, setSchedules] = useState<PowerSchedule[]>([])
  const [addSched, setAddSched] = useState(false)
  /* Whether the schedule section is open. Not a setting eero holds — there
     is no "schedules enabled" flag, only the list — so it is opened by
     whether there is anything in it, and by asking. */
  const [schedOn, setSchedOn] = useState(false)
  const [legacy, setLegacy] = useState<{ enabled: boolean } | null>(null)
  const [thread, setThread] = useState<ThreadNet | null>(null)
  const [creds, setCreds] = useState<Record<string, string> | null>(null)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  /* The eeros' own addresses. They are not clients, so nothing else on this
     page lists them — and the gateway sits at the bottom of the range, which
     is exactly where a reservation is now offered from. Reserving an address
     an eero answers to is the one collision worth spending a request to
     avoid; the call is shared and cached, so it costs little. */
  const [nodeIps, setNodeIps] = useState<string[]>([])

  const loadDevices = useCallback(() => {
    api.get<DeviceRow[]>('/api/devices')
      .then((r) => setDevices(r ?? [])).catch(() => setDevices([]))
    api.get<{ ip_address?: string | null }[]>('/api/eeros')
      .then((r) => setNodeIps((r ?? []).map((e) => e.ip_address ?? '').filter(Boolean)))
      .catch(() => setNodeIps([]))
  }, [])

  /* What the Thread switch has been set to and the network has not confirmed
     yet. The switch itself is optimistic, so without this the panel under it
     stayed open — network name, channel, ids, joining credentials — for the
     length of the write and the re-read that follows, while the switch beside
     it already read off. Reported from use. Cleared by `loadThread`, whichever
     way the write went, so the panel goes back to following the network. */
  const [threadWant, setThreadWant] = useState<boolean | null>(null)

  const loadThread = useCallback(() => {
    setCreds(null)
    api.get<ThreadNet>('/api/network/thread')
      .then((t) => {
        setThread(t)
        /* The pending value goes here and not a moment earlier. Cleared at the
           top of this function, the stale `enabled` won for the length of this
           GET and the panel came back for about 700ms before going again — the
           card measured 240px, 119px, 240px, 119px, which is what "the toggle
           jumps around" was. */
        setThreadWant(null)
        // Shown outright rather than behind a reveal. They are what you need
        // in front of you to join something by hand, and a button guarding a
        // value one click away protected nothing.
        if (t?.has_credentials) {
          api.get<Record<string, string>>('/api/network/thread/credentials')
            .then(setCreds).catch(() => setCreds(null))
        }
      })
      .catch(() => { setThread(null); setThreadWant(null) })
  }, [])

  const loadSchedules = useCallback(() => {
    api.get<PowerSchedule[]>('/api/network/power-saving/schedules')
      .then((r) => setSchedules(r ?? [])).catch(() => setSchedules([]))
  }, [])

  /* A network that already has a schedule opens with the section open.
     Keyed on the count rather than the array, so the poll re-reading the
     same schedules does not spring it open again after somebody closed it. */
  useEffect(() => { if (schedules.length) setSchedOn(true) }, [schedules.length])

  /* Returns the promise: the dynamic DNS control awaits this after flipping
     eero's switch, so that "done" means the page holds the network as it now
     is, not as it was. */
  const reload = () => {
    return Promise.all([
      api.get<Wifi>('/api/network/wifi'),
      api.get<Guest>('/api/network/guest').catch(() => null),
      api.get<Lan>('/api/network/lan'),
      api.get<Reservation[]>('/api/reservations').catch(() => []),
      api.get<Wpa3>('/api/network/wifi/wpa3').catch(() => null),
      api.get<{ enabled: boolean }>('/api/network/power-saving').catch(() => null),
      api.get<{ enabled: boolean }>('/api/network/legacy-mode').catch(() => null),
    ]).then(([w, g, l, r, w3, ps, lg]) => {
      setLegacy(lg)
      setWpa3(w3)
      setPower(ps)
      setWifi(w); setGuest(g); setLan(l); setRes(r ?? [])
    }).catch((e) => setErr(e.message))
  }
  useEffect(() => { void reload() }, [])
  useEffect(() => {
    loadSchedules(); loadThread(); loadDevices()
  }, [loadSchedules, loadThread, loadDevices])

  /* Power saving and its schedules, kept current. eero calls this feature
     "eco efficiency" — `EcoEfficiencyRepository` holds `_powerSavingStatus`
     and `_schedules` and posts `createPowerSavingSchedule` — and refreshes it
     every thirty seconds. Same feature, same rate.

     `reload` carries the enabled flag and `loadSchedules` the windows, so
     both go on the same tick rather than drifting apart on screen. */
  useRevalidate(() => { reload(); loadSchedules() }, POWER_SAVING_MS)


  /* Reports into whichever pane asked. The page kept one notice at the top,
     so a power-saving save was announced eight panes above the switch that
     produced it. `run` still exists for the few writes that belong to the page
     rather than to a pane. */
  async function runIn(into: CardSay, fn: () => Promise<unknown>, ok: string,
                       key = 'page') {
    setWriting((w) => [...w, key]); into.clear()
    try { await fn(); into.ok(ok); reload() }
    catch (e) { into.fail(e instanceof ApiError ? e.message : t('network.did_not_work')) }
    finally {
      // One occurrence, not every: two writes under the same key are
      // possible and the second must not clear the first's.
      setWriting((w) => {
        const i = w.indexOf(key)
        return i < 0 ? w : [...w.slice(0, i), ...w.slice(i + 1)]
      })
    }
  }

  const reservedMacs = new Set(
    res.map((r) => (r.mac ?? '').toLowerCase()).filter(Boolean))
  const reservableDevices = devices.filter(
    (d) => d.mac && !reservedMacs.has(d.mac.toLowerCase()))

  /* eero replaces the whole reservation, so an edit has to resend every
     field; only the changed one comes from the caller. The MAC identifies the
     device and is never editable — changing it would be a different
     reservation, which is what Add is for. */
  const saveReservation = (say: CardSay, r: Reservation,
                           patch: Partial<Reservation>) => {
    const next = {
      mac: r.mac ?? '', ip: patch.ip ?? r.ip ?? '',
      description: patch.description ?? r.description ?? '',
    }
    if (!next.ip.trim()) { say.fail(t('network.reservation_needs_ip_address')); return }
    if (patch.ip && !window.confirm(t('network.move_reservation_ip_device_keeps', { ip: next.ip }))) return
    runIn(say, () => api.put(`/api/reservations?url=${encodeURIComponent(r.url)}`,
                             next), '', 'reservations')
  }

  const deleteReservation = async (say: CardSay, r: Reservation) => {
    /* Forwards on this address go with it. eero cascades the delete on the
       server — verified against the API: a forward on a reserved address was
       gone from the list the moment the reservation was deleted, with no
       separate call. So it has to be said before the click, not discovered
       after it. Fetched here because inbound access lives on the Security tab
       and this page holds no copy of the list. */
    let doomed: string[] = []
    try {
      const all = await api.get<{ ip?: string; gateway_port?: string;
                                  description?: string }[]>('/api/forwards')
      doomed = (all ?? [])
        .filter((f) => f.ip === r.ip)
        .map((f) => `port ${f.gateway_port}${f.description ? ` (${f.description})` : ''}`)
    } catch {
      // Warn in general terms rather than not at all.
    }
    if (!window.confirm(
      t('network.confirm_delete_reservation', { ip: r.ip })
      + '\n\n'
      + (doomed.length
        // Named individually when they are known, because "a port forward will
        // go" is not the same warning as knowing which one.
        ? tn('network.reservation_also_deletes', doomed.length,
             { list: doomed.map((d) => `  ${d}`).join('\n') })
        : t('network.reservation_deletes_any_forward')))) return
    runIn(say, () => api.del(
      `/api/reservations?url=${encodeURIComponent(r.url)}`), '', 'reservations')
  }
  /* Takes the card's own notice, so a refusal appears in the guest card rather
     than at the top of a nine-pane page. */
  /* Both directions restart the mesh. Reported from use, and it is the kind of
     thing this app is supposed to say before it happens rather than after: the
     switch looked like the cheapest one on the page and took the whole network
     with it.

     Asked through `Toggle`'s own `confirm` rather than inside `onChange`, and
     the component's doc comment says why: the switch is optimistic, so a
     caller that asks in `onChange` and then declines has already let the
     switch move. I wrote it the wrong way first and the test for declining
     caught the switch flipping with nothing written behind it.

     `confirm` takes no argument, so the direction comes from what is on screen
     now: clicking flips it, so a switch currently on is about to go off. Off
     costs the guests their access on top of the interruption, and that
     sentence goes in front of the other rather than replacing it.

     Its own sentence rather than the shared restart warning. Measured on live
     hardware on 2026-09-08: the toggle interrupts the connection for fifteen
     to twenty-one seconds while the eeros apply the change, and no node
     leaves green in either direction.
     Nothing restarts, so the restart wording and the five-to-eight-minute
     figure it borrowed were both wrong here. The mark stays: it means "this
     interrupts things", and its title on this switch says how much. The
     question stays too: twenty seconds is still a dropped call. */
  const confirmGuest = () => {
    const turningOff = Boolean(guest?.enabled)
    const extra = turningOff ? t('network.guest_off_disconnects') + '\n\n' : ''
    return window.confirm(extra + t('network.guest_consequence'))
  }
  const toggleGuest = (say: CardSay, on: boolean) =>
    runIn(say, () => api.put('/api/network/guest', { enabled: on }), '', 'guest')

  if (err) return <Notice kind="bad">{err}</Notice>
  /* The placeholder has to stand in for the panes that actually arrive, in the
     layout they arrive in. This said "Wi-Fi" in a single column while the page
     opens with "Internet" in two, so the first pane appeared to be replaced by
     a different one and the whole grid reflowed underneath it. Two pages share
     this component now, and they open on different panes: naming the other
     page's brought the same swap back, LAN standing in for a second and a half
     where DNS was about to be. */
  if (!wifi || !lan) {
    /* The same rule the loaded branch follows at the foot of this function:
       the Internet page brings its own frame and these are panes inside it,
       so a second one here would put two pages on the screen at once — and
       everything keyed on the page, its picture included, would have two
       answers to choose from. */
    const waiting = (<>
      <SkeletonCard icon={internetOnly ? 'internet' : 'lan'}
                    title={t(internetOnly ? 'network.internet' : 'network.lan')} rows={6} />
      <SkeletonCard icon={internetOnly ? 'dns' : 'wifi'}
                    title={t(internetOnly ? 'network.dns' : 'network.wi_fi')} rows={6} />
    </>)
    return internetOnly ? waiting : (
      <Page name="network" columns={2}>{waiting}</Page>
    )
  }

  /* What the Thread switch shows: the pending value while a write is in
     flight, the network's own otherwise. */
  const threadOn = threadWant ?? Boolean(thread?.enabled ?? lan.thread)

  /* One flag for the whole page: bridge mode is a property of the network, not
     of any card, and several cards have to answer to it. */
  const bridged = (lan.mode ?? 'automatic') === 'bridge'

  /* A function of the card's notice rather than a constant, because the row
     actions report failures and those belong in the reservations card. */
  const resCols = (say: CardSay): Column<Reservation>[] => [
    /* Read-only. eero fills this from the client's own name, and a
       reservation is a lease, not a place to rename a device — editing it
       here renamed nothing anywhere else and left two names for one thing.
       Renaming lives where the device does, on Clients. */
    { key: 'd', header: t('network.device'),
      sortValue: (r) => r.description?.toLowerCase() || null,
      render: (r) => r.description
        || <span className="text-[var(--color-ink-3)]">{t('network.unnamed_device')}</span> },
    /* The address opens a form under the row rather than turning into a
       text box. A reservation has to be a host inside the subnet, and free
       text let somebody type an address eero would refuse and find out
       afterward — the add form has enforced the subnet for as long as it
       has existed, and this is the same address. */
    { key: 'i', header: t('network.ip_address'), stopsRowClick: true,
      sortValue: (r) => ipKey(r.ip),
      render: (r) => (
        <button type="button"
                disabled={busyWith('reservations')}
                onClick={() => {
                  setEditRes((cur) => (cur === r.url ? null : r.url))
                  setEditIp(r.ip ?? '')
                }}
                className="group -mx-1 inline-flex items-center gap-1 rounded px-1
                           text-left hover:bg-[var(--color-accent-wash)]"
                title={t('network.edit_reservation_ip')}>
          <span className="underline decoration-[var(--color-line-strong)]
                           decoration-dashed underline-offset-4
                           group-hover:decoration-[var(--color-accent)]">
            {r.ip}
          </span>
          <svg viewBox="0 0 24 24" aria-hidden="true"
               className="size-3 shrink-0 text-[var(--color-ink-3)]
                          group-hover:text-[var(--color-accent)]"
               fill="currentColor">
            <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1
                     1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75
                     3.75 1.83-1.83z" />
          </svg>
        </button>
      ) },
    { key: 'm', header: 'MAC', sortValue: (r) => r.mac ?? null,
      render: (r) => <span className="font-mono text-[12px]">{r.mac}</span> },
    { key: 'a', header: '', stopsRowClick: true, render: (r) => (
        <RowAction tone="bad" disabled={busyWith('reservations')} onClick={() => void deleteReservation(say, r)}>{t('network.delete')}</RowAction>) },
  ]


  const body = (
    <>
      {/* Its own notice. A single notice for the whole page put a failure
          from a pane eight down at the very top, off-screen from the button
          that caused it — which is how a Reveal answering 404 presented as
          "clicking it does nothing". Same idiom the Power and
          Troubleshooting cards below already use. */}
      {internetOnly && (
      <Card icon="internet" title={t('network.internet')} anchor="internet">{(paneSay) => (<>
        {lan.isp && <Row label={t('network.isp')}>{lan.isp}</Row>}
        <WanMode lan={lan} busy={busyWith('wan')}
                 run={(fn, ok) => runIn(paneSay, fn, ok, 'wan')} />
        {/* Directly under the connection type, and outside the three mode
            forms. eero's own ISP settings screen lays it out this way —
            `vlan_tagging_list_container` is the next sibling of
            `wan_type_row`, not a child of it — because one tag applies
            whichever way the gateway gets its address. Putting a copy in each
            form would imply three separate settings. */}
        {/* Marked, not missing. eero reports `vlan` as unsupported on the
            hardware that cannot tag an uplink, and the row used to disappear
            with no indication it had ever existed. */}
        <Gate name="vlan">
          <UplinkVlan lan={lan} busy={busyWith('vlan')}
                      run={(fn, ok) => runIn(paneSay, fn, ok, 'vlan')} />
        </Gate>

        {/* The two switches follow the settings above them, and the read-only
            facts follow both. The four rows used to sit between the VLAN tag
            and these toggles, so the card read as settings, then a report, then
            more settings — and anybody scrolling for the IPv6 switch went past
            it into the address rows and stopped. Everything you can change is
            now in one run, and what you can only read is in a panel of its own
            at the foot of the card. */}
        <div className="border-b border-[var(--color-line)] py-2 last:border-0">
          {/* Restarts the mesh. eero's own app gates this behind its "Reboot
              required" dialog — `Ipv6ViewModel.onIpv6Toggled` — so this is not
              a guess, and it is the change that prompted marking any of them:
              flipping it took the network down for minutes with nothing having
              said it would. */}
          {bridged ? <BridgedNote what={t('network.ipv6_upstream')} /> : (<>
          <Toggle
            label={<span className="inline-flex items-center gap-1.5">
              {t('network.ipv6_upstream')}<RebootMark />
            </span>}
            hint={t('network.requires_your_provider_offer_ipv6')}
            checked={Boolean(lan.ipv6_upstream)} disabled={busyWith('ipv6')}
            confirm={() => confirmReboot(t('network.ipv6_upstream'))}
            onChange={(v) => runIn(paneSay,
              () => api.put('/api/network/lan', { ipv6_upstream: v }), '', 'ipv6')}
          />
          </>)}
        </div>

        {/* Dynamic DNS is not gated any more. eero's own `eero.online` is an
            eero Plus feature and stays marked as one, but every other provider
            in the picker is a third party this app talks to itself — nothing
            about those requires a subscription, so gating the whole feature
            was charging for something eero was not providing. */}
        {!ddnsElsewhere && <DynamicDns
          eeroDdns={lan.ddns}
          onEeroToggle={(on) => api.put('/api/network/ddns', { enabled: on })
            .then(() => reload())}
        />}

        {/* Last in the card: everything above it is about how the line is
            reached and named; this is what it was sold as, a figure off a
            bill rather than a setting on the gateway. It used to be set by
            pressing the reading on the Dashboard, which was hidden and left
            no room to say what the figure was for. */}
        <ServicePlan run={(fn, ok) => runIn(paneSay, fn, ok, 'plan')} busy={busyWith('plan')} />

      </>)}</Card>
      )}

      {!internetOnly && (<>
      <Card icon="lan" title={t('network.lan')} anchor="lan">{(paneSay) => (<>
        {/* The addressing form in a panel of its own. It is a form with fields
            and a commit button; the toggles under it act the moment they are
            flipped. Sitting flush against each other, the boundary between
            "pending until you press Apply" and "already done" was invisible,
            and the checkbox inside the form made that distinction load-bearing. */}
        <AutoHeight>
          <LanMode lan={lan} busy={busyWith('lan-mode')}
                   run={(fn, ok) => runIn(paneSay, fn, ok, 'lan-mode')} />
        </AutoHeight>

        {/* UPnP sits with the LAN's other NAT behavior rather than in a
            miscellany at the bottom of the card: it is the automatic version
            of a port forward, which is the same family of thing as the port
            randomization above it. */}
        <div className="mt-3 border-t border-[var(--color-line)] pt-3">
          {/* eero's own `isUPnpRowEnabled` is `!isConnectionBridged`: opening a
              port on a device that is not doing the forwarding is nothing. */}
          {bridged ? <BridgedNote what={t('network.upnp')} /> : (
          <Toggle
            label={t('network.upnp')} checked={Boolean(lan.upnp)} disabled={busyWith('upnp')}
            hint={t('network.lets_applications_open_their_own')}
            onChange={(v) => runIn(paneSay, () => api.put('/api/network/lan', { upnp: v }),
                                 v ? t('network.upnp_enabled') : t('network.upnp_disabled'), 'upnp')}
          />
          )}
        </div>
        {/* Under UPnP rather than on the Wi-Fi card, where it sat until now:
            queue management shapes everything the gateway routes, wired and
            wireless alike, so it is a fact about the LAN and not about the
            radios. eero's own rule for the row is
            `isSQMCapable(network) && !isConnectionBridged(network)` — shaping
            traffic the eeros no longer route is nothing. The setting still
            lives on eero's Wi-Fi object, which is why it reads from `wifi`. */}
        <Gate name="sqm">
          <div className="mt-3 border-t border-[var(--color-line)] pt-3">
            {bridged ? (
              <BridgedNote what={t('network.smart_queue_management_sqm')} />
            ) : (
            <Toggle
              label={t('network.smart_queue_management_sqm')}
              hint={t('network.reduces_latency_under_load')}
              checked={Boolean(wifi?.sqm)}
              disabled={wifi === null || busyWith('sqm')}
              onChange={(v) => runIn(paneSay, () => api.put('/api/network/wifi/sqm', { enabled: v }),
                                   v ? t('network.smart_queue_management_enabled') : t('network.smart_queue_management_disabled'), 'sqm')}
            />
            )}
          </div>
        </Gate>
      </>)}</Card>
      </>)}

      {internetOnly && (
        <DnsPane lan={lan} busy={busyWith('dns')} onDone={reload} />
      )}

      {!internetOnly && (<>

      <Card icon="wifi" title={t('network.wi_fi')} anchor="wifi">{(paneSay) => (<>
        {editing === 'name' && wifi.name && (
          <div className="mb-3">
            <DangerousChange
              title={t('network.rename_network')}
              description="Renaming changes the SSID. Devices do not follow a
                rename — each one has to join the new name and will not
                reconnect on its own."
              label={t('network.new_network_name')}
              confirmWord={wifi.name}
              submitLabel={t('network.rename_network_2')}
              minLength={1} maxLength={32}
              onSubmit={(v) => api.put('/api/network/wifi/name', { name: v })}
              onDone={() => { setEditing(null); reload() }}
            />
          </div>
        )}
        {editing === 'password' && wifi.name && (
          <div className="mb-3">
            <DangerousChange
              title={t('network.change_wi_fi_password')}
              description="Every wireless device has to be given the new
                password before it can reconnect. Devices you cannot easily
                reach — cameras, sensors, anything without a screen — are the
                ones that make this painful."
              label={t('network.new_password')}
              inputType="password"
              confirmWord={wifi.name}
              submitLabel={t('network.change_password')}
              minLength={8} maxLength={63}
              onSubmit={(v) => api.put('/api/network/wifi/password', { password: v })}
              onDone={() => { setEditing(null); setPw(null); reload() }}
            />
          </div>
        )}
        <Row label={t('network.network_name')}>
          <span className="inline-flex items-center gap-3">
            {wifi.name}
            <InlineAction disabled={busyWith('wifi') || editing !== null}
                          onClick={() => setEditing('name')}>
              {t('network.rename')}
            </InlineAction>
            <RebootMark title={t('interrupt.reconnect_details')} />
          </span>
        </Row>
        {/* Reveal only where there is something to reveal. On an open network
            it called the endpoint, got null back and set null — so the button
            stayed exactly as it was and the click looked like it had missed.
            eero already reports whether a password is set, so the row says so
            and offers to set one instead. Same shape as the guest card, which
            had this right. */}
        <Row label={t('network.password')}>
          <span className="inline-flex items-center gap-3">
            {wifi.has_password === false ? (
              <>
                <span className="text-[var(--color-ink-3)]">{t('network.none_set')}</span>
                <InlineAction disabled={busyWith('wifi') || editing !== null}
                              onClick={() => setEditing('password')}>
                  {t('network.set')}
                </InlineAction>
                <RebootMark title={t('interrupt.reconnect_details')} />
              </>
            ) : (
              <>
                {pw ? (
                  <span className="font-mono">{pw}</span>
                ) : (
                  <InlineAction
                    onClick={() => {
                      setPwErr(null)
                      api.get<{ password: string }>('/api/network/wifi/password')
                        .then((d) => {
                          // A null here means eero disagrees with has_password.
                          // Saying so beats a button that does nothing twice.
                          if (d.password) setPw(d.password)
                          else setPwErr(t('network.no_password_to_reveal'))
                        })
                        .catch((e) => setPwErr(e instanceof ApiError ? e.message
                                                                    : t('network.did_not_work')))
                    }}>
                    {t('network.reveal')}
                  </InlineAction>
                )}
                <InlineAction disabled={busyWith('wifi') || editing !== null}
                              onClick={() => setEditing('password')}>
                  {t('network.change')}
                </InlineAction>
                <RebootMark title={t('interrupt.reconnect_details')} />
              </>
            )}
          </span>
          {pwErr && (
            <p className="mt-1 text-right text-[12px] text-[var(--color-bad-ink,var(--color-bad))]">
              {pwErr}
            </p>
          )}
        </Row>
        <div className="border-b border-[var(--color-line)] py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="micro-label">{t('network.security')}</span>
            {/* The mark goes after the words on the right rather than beside
                the heading: it is about what changing one of these radios
                costs, and the note that they are set one radio at a time is
                the thing it is qualifying. */}
            <span className="inline-flex items-center gap-1.5 text-[12px]
                             text-[var(--color-ink-3)]">
              {t('network.per_radio')}
              <RebootMark title={t('interrupt.band_reconnect')} />
            </span>
          </div>
          {wpa3View ? (
            <div className="mt-2 grid gap-2">
              {([
                ['band_2_4_ghz', 'band.2_4'],
                ['band_5_ghz', 'band.5'],
                ['band_6_ghz', 'band.6'],
              ] as const).map(([key, bandKey]) => {
                // The band's name as the reader's language writes it: "2,4 GHz"
                // in most of Europe.
                const label = t(bandKey)
                const value = wpa3View[key]
                if (!value) return null
                const settable = wpa3View.settable.includes(key)
                return (
                  <label key={key} className="flex items-center justify-between gap-3">
                    <span className="text-[13px]">{label}</span>
                    <select
                      value={value}
                      disabled={!settable || wpa3Busy}
                      aria-label={t('network.security_mode_label', { label: label })}
                      title={settable ? undefined : t('network.six_ghz_requires_wpa3')}
                      onChange={(e) => {
                        const next = e.target.value
                        /* Every change here makes that band's clients
                           reconnect, which is what the mark beside the heading
                           says, so every change asks — not only the move to
                           WPA3 only. That one asked and the others did not,
                           including the move back off WPA3, so the mark
                           promised a question three of four changes never
                           put. Going to WPA3 only keeps its own wording,
                           since locking older hardware out is a different
                           thing from a reconnection. */
                        const ask = next === 'wpa3'
                          ? t('network.set_label_wpa3_only_devices', { label })
                          : t('network.confirm_security_mode',
                              { label, from: MODE_LABEL()[value] ?? value,
                                to: MODE_LABEL()[next] ?? next })
                        if (!window.confirm(ask)) {
                          // Put the select back: it shows the new mode the
                          // moment it is picked, so declining has to undo that.
                          setWpa3Guess((g) => ({ ...g, [key]: value }))
                          return
                        }
                        /* Its own in-flight flag, and no success notice.
                           `run` sets the page-wide `busy`, which dimmed every
                           toggle and every commit button on the card for the
                           length of the round trip — a write to one band has
                           no business graying out SQM. And the select already
                           shows the new mode the moment it is picked, so a
                           notice above the card only repeated it. */
                        setWpa3Guess((g) => ({ ...g, [key]: next }))
                        setWpa3Busy(true)
                        api.put('/api/network/wifi/wpa3', {
                          band_2_4_ghz: key === 'band_2_4_ghz' ? next : wpa3View.band_2_4_ghz,
                          band_5_ghz: key === 'band_5_ghz' ? next : wpa3View.band_5_ghz,
                        })
                          .then(() => reload())
                          .catch((err) => {
                            // Reverted, so the select cannot sit on a mode the
                            // radios never took.
                            setWpa3Guess((g) => {
                              const { [key]: _drop, ...rest } = g
                              return rest
                            })
                            paneSay.fail(err instanceof ApiError ? err.message
                                                                  : t('network.did_not_work'))
                          })
                          .finally(() => setWpa3Busy(false))
                      }}
                      className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[13px] disabled:opacity-50"
                    >
                      {(settable ? wpa3View.modes : [value]).map((m) => (
                        <option key={m} value={m}>{MODE_LABEL()[m] ?? m}</option>
                      ))}
                    </select>
                  </label>
                )
              })}
              <p className="text-[12px] leading-snug text-[var(--color-ink-3)]">
                {t('network.changing_band_s_security_mode')}
              </p>
            </div>
          ) : (
            <p className="mt-1 text-[13px]">{wifi.wpa3 ? t('network.wpa3_enabled') : t('network.wpa3_disabled')}</p>
          )}
        </div>
        <div className="border-b border-[var(--color-line)] py-2">
          <Toggle
            label={t('network.band_steering')}
            hint={t('network.steers_clients_to_best_eero')}
            checked={Boolean(wifi.band_steering)} disabled={busyWith('band-steering')}
            onChange={(v) => runIn(paneSay, () => api.put('/api/network/wifi/band-steering', { enabled: v }),
                                 v ? t('network.band_steering_enabled') : t('network.band_steering_disabled'), 'band-steering')}
          />
        </div>
        <Gate name="mlo_mode">
          {/* The separator its neighbors all carry. Without it this row ran
              straight into the next and the list lost a rule. */}
          <div className="border-b border-[var(--color-line)] py-2">
            <Toggle
              label={<span className="inline-flex items-center gap-1.5">
                {t('network.multi_link_operation')}<RebootMark />
              </span>}
              hint={t('network.lets_capable_clients_use_several')}
              checked={wifi.mlo_mode === 'multi'} disabled={busyWith('mlo')}
              /* It restarts the mesh — eero's own app confirms this one, and
                 measured rather than assumed — and the row has carried
                 the mark all along without ever asking. Turning it on also
                 turns WPA3 on for the bands that join, which is eero's
                 warning and not a thing to discover afterward. */
              confirm={() => confirmReboot(
                t('network.multi_link_operation'),
                wifi.mlo_mode === 'multi' ? undefined : t('network.mlo_enables_wpa3'))}
              onChange={(v) => runIn(paneSay, 
                () => api.put('/api/network/wifi/mlo', { mlo_mode: v ? 'multi' : 'disabled' }),
                v ? t('network.multi_link_operation_enabled') : t('network.multi_link_operation_disabled'), 'mlo')}
            />
          </div>
        </Gate>

        {/* The two radio workarounds, at the foot of the radios' own card.
            They had a Troubleshooting card to themselves, which put "pause
            the 5 GHz radios" a card away from the radios. Not gated together:
            legacy compatibility needs hardware that older eeros do not have,
            and gating both on it once dimmed the band pause on a
            first-generation mesh for a requirement it never had. Only the
            control with the requirement carries the gate. */}
        <div className="mt-3 border-t border-[var(--color-line)] pt-3">
          <BandPause busy={busyWith('band-pause')} runIn={runIn} say={paneSay} />
        </div>
        <div className="mt-3 border-t border-[var(--color-line)] pt-3">
          <Gate name="ac_compat">
            <Toggle
              label={t('network.legacy_802_11a_b_g')}
              hint={t('network.lets_much_older_clients_associate')}
              checked={Boolean(legacy?.enabled)} disabled={busyWith('legacy')}
              onChange={(v) => runIn(paneSay,
                () => api.put('/api/network/legacy-mode', { enabled: v }),
                v ? t('network.legacy_compatibility_enabled') : t('network.legacy_compatibility_disabled'), 'legacy')
                .then(() => setLegacy({ enabled: v }))}
            />
          </Gate>
        </div>
      </>)}</Card>

      <Card icon="guest" title={t('network.guest_network')} anchor="guest">{(paneSay) => (<>
        {guest === null ? (
          <p className="text-[13px] leading-relaxed text-[var(--color-ink-3)]">
            {t('network.guest_not_loaded')}
          </p>
        ) : (<>
        <div className="mb-3">
          <Toggle
            label={<span className="inline-flex items-center gap-1.5">
              {t('network.guest_network_enabled')}
              <RebootMark title={t('interrupt.guest')} />
            </span>}
            hint={t('network.separate_ssid_visitors_isolated_from')}
            checked={Boolean(guest?.enabled)}
            disabled={busyWith('guest')}
            confirm={confirmGuest}
            onChange={(v) => toggleGuest(paneSay, v)}
          />
        </div>
        {/* The same form the primary network's password uses, rather than a
            bare input sitting open on the card. One mechanism for one job: a
            password field permanently on display invited a change nobody had
            decided to make, and the two cards asked for the same thing in two
            different shapes. */}
        {editing === 'guest-password' && (
          <div className="mb-3">
            <DangerousChange
              title={t('network.change_guest_password')}
              label={t('network.new_guest_password')}
              affects="guest"
              inputType="password"
              confirmWord={guest?.name || t('network.guest_network')}
              submitLabel={t('network.change_password')}
              minLength={8} maxLength={63}
              onSubmit={(v) => api.put('/api/network/guest/password', { password: v })}
              onDone={() => { setEditing(null); setGuestPw(null); reload() }}
            />
          </div>
        )}
        <Row label={t('network.guest_network_name')}>{guest?.name || '—'}</Row>
        <Row label={t('network.password')}>
          {guest?.has_password ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-3">
              {guestPw ? (
                <span className="font-mono">{guestPw}</span>
              ) : (
                <InlineAction
                  onClick={() => {
                    setGuestPwErr(null)
                    api.get<{ password: string }>('/api/network/guest/password')
                      .then((d) => {
                        if (d.password) setGuestPw(d.password)
                        else setGuestPwErr(t('network.no_password_to_reveal'))
                      })
                      .catch((e) => setGuestPwErr(e instanceof ApiError ? e.message
                                                                       : t('network.did_not_work')))
                  }}>
                  {t('network.reveal')}
                </InlineAction>
              )}
              <InlineAction disabled={busyWith('guest') || editing !== null}
                            onClick={() => setEditing('guest-password')}>
                {t('network.change')}
              </InlineAction>
              <RebootMark title={t('interrupt.guest_reconnect')} />
              {guestPwErr && (
                <span className="w-full text-right text-[12px] text-[var(--color-bad-ink,var(--color-bad))]">
                  {guestPwErr}
                </span>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-3">
              <span className="text-[var(--color-ink-3)]">{t('network.none_set')}</span>
              <InlineAction disabled={busyWith('guest') || editing !== null}
                            onClick={() => setEditing('guest-password')}>
                {t('network.set')}
              </InlineAction>
              <RebootMark title={t('interrupt.guest_reconnect')} />
            </span>
          )}
        </Row>
        {/* The guest network does not have security settings of its own — eero
            runs it on the same radios with the same modes. Showing the primary
            network's values here, inert, answers the question the blank row
            provoked ("so what is the guest network using?") without implying
            there is a second set to change. They move the moment the ones above
            do, because they are the same values. */}
        <div className="border-b border-[var(--color-line)] py-2 last:border-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="micro-label">{t('network.security')}</span>
            <span className="text-[12px] text-[var(--color-ink-3)]">
              {t('network.copies_primary')}
            </span>
          </div>
          {wpa3View && (
            <div className="mt-2 grid gap-2">
              {([
                ['band_2_4_ghz', '2.4 GHz'],
                ['band_5_ghz', '5 GHz'],
                ['band_6_ghz', '6 GHz'],
              ] as const).map(([key, label]) => {
                const value = wpa3View[key]
                if (!value) return null
                return (
                  /* Text, not a disabled select. A grayed dropdown still looks
                     like a control that ought to work, so it reads as broken
                     rather than as a report — and there is nothing to choose
                     here, only something to know. */
                  <div key={key} className="flex items-center justify-between gap-3">
                    <span className="text-[13px]">{label}</span>
                    <span className="text-[13px] text-[var(--color-ink-2)]"
                          title={t('network.guest_security_follows_primary')}>
                      {MODE_LABEL()[value] ?? value}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        </>)}
      </>)}</Card>

      {/* Thread as its own pane, next to Wi-Fi and the guest network rather
          than tacked onto the bottom of the LAN card. It is a radio the eeros
          run, with its own name, channel, and joining credentials — the same
          kind of thing as the two above it, and nothing at all like an address
          range. Its credentials block alone was taller than the LAN settings
          it was hiding under. */}
      {/* Thread is a radio the older eeros do not have, and eero says so:
          `thread_network` comes back hardware-gated on a network of them. The
          card used to offer the switch regardless, which is a switch that
          cannot do anything. The mark goes in the card's corner, so the gate
          inside it draws none of its own. */}
      <Card icon="thread" title={t('network.thread')} anchor="thread"
            hardware="thread_network">{(paneSay) => (<>
        <Gate name="thread_network" mark={false}><>
        {bridged ? <BridgedNote what={t('network.thread')} /> : (
        <div className="grid gap-3">
          <Toggle
            label={t('network.enable_thread')} checked={threadOn} disabled={busyWith('thread')}
            hint={t('network.low_power_mesh_smart_home')}
            onChange={(v) => {
              // Before the write, so the panel goes with the switch rather
              // than a round trip later.
              setThreadWant(v)
              return runIn(paneSay,
                () => api.put('/api/network/thread', {
                  thread_enable: v,
                  enable_credential_syncing: Boolean(thread?.enable_credential_syncing),
                }),
                v ? t('network.thread_enabled') : t('network.thread_disabled'),
                'thread').then(loadThread)
            }}
          />
          {/* Everything Thread has to say lives in a sub-panel that appears with
              the switch and goes away with it. Off, none of it applies — a
              network name, a channel, and a set of joining credentials for a
              radio that is not running is just noise, and the block was taller
              than the rest of the card.

              Behind a caret, and closed on every load. It is reference
              material — a network name, a channel, two ids, and a set of
              joining credentials — read once when pairing something and not
              again, and open it made the tallest thing on the page out of the
              pane with the least to decide. Closed is not remembered on
              purpose: the credentials are the sort of thing to reveal
              deliberately, not to find already on screen because of a click
              last week. */}
          {/* Follows the switch, not the network's answer about it: on the way
              off the panel goes at once, and on the way on it waits for the
              data it is made of rather than drawing an empty box. */}
          {threadOn && thread?.enabled && (
            /* Indented to the line the switch's own label starts on: the
               switch is 36px wide with 12px beside it, and this box is
               about the setting that switch turns on rather than a second
               thing at the card's edge. */
            <Collapsible title={t('network.thread_details')} boxed
                         className="mb-0 ml-12">
              <dl className="grid gap-1 text-[12px]">
                {([[t('network.thread_network_name'), thread.name],
                   [t('network.thread_channel'), thread.channel],
                   [t('network.thread_pan_id'), thread.pan_id],
                   [t('network.thread_xpan_id'), thread.xpan_id]] as const).map(
                  ([label, value]) => value == null || value === '' ? null : (
                    <div key={label} className="flex justify-between gap-4">
                      <dt className="text-[var(--color-ink-3)]">{label}</dt>
                      <dd className="font-mono">{value}</dd>
                    </div>
                  ))}
              </dl>

              {thread.has_credentials && (
                <div className="mt-3">
                  {/* The heading and the one action that acts on what is
                      below it, on one line. */}
                  <div className="flex items-center justify-between gap-3">
                    <span className="micro-label">{t('network.joining_credentials')}</span>
                    <RowAction
                      onClick={() => {
                        if (!window.confirm(t('network.issue_new_thread_network_key'))) return
                        if (!window.confirm(t('network.last_check_unpairs_every_thread'))) return
                        runIn(paneSay, () => api.post(
                          '/api/network/thread/regenerate?confirm=regenerate'),
                          t('network.new_thread_credentials_issued_re'), 'thread')
                          .then(() => { setCreds(null); loadThread() })
                      }}
                      disabled={busyWith('thread')}
                    >
                      {t('network.regenerate_credentials')}
                    </RowAction>
                  </div>
                  {creds ? (
                    <dl className="mt-1 grid gap-1 text-[12px]">
                      {Object.entries(creds).map(([k, v]) => v ? (
                        <div key={k} className="flex justify-between gap-4">
                          {/* eero's field name is the fallback, de-underscored
                              the way it always was, so a credential eero adds
                              later still reads as words rather than a key. */}
                          <dt className="text-[var(--color-ink-3)]">
                            {tOr(`thread_cred.${k}`, k.replace(/_/g, ' '))}
                          </dt>
                          <dd className="max-w-[60%] break-all text-right font-mono">
                            {v}
                          </dd>
                        </div>
                      ) : null)}
                    </dl>
                  ) : (
                    <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
                      {t('network.could_not_read')}
                    </p>
                  )}
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                    {t('network.anything_holding_these_can_join')}
                  </p>
                </div>
              )}

            </Collapsible>
          )}

          {/* A switch, not reference material, so it stays out of the box the
              caret closes: eero calls it "Keychain Syncing", and it decides
              whether the credentials above are copied into Apple's keychain.
              It sits under the box rather than beside Enable Thread because
              it is about those credentials, and it only applies while Thread
              is on. The label says which keychain, since it is the phone's and
              not the eero account's. */}
          {threadOn && thread?.enabled && (
            <Toggle
              label={t('network.keychain_syncing_mobile_devices')}
              hint={t('network.copies_these_credentials_into_apple')}
              checked={Boolean(thread.enable_credential_syncing)}
              disabled={busyWith('thread-sync')}
              onChange={(v) => runIn(paneSay,
                () => api.put('/api/network/thread', {
                  thread_enable: Boolean(thread.enabled),
                  enable_credential_syncing: v,
                }), t('network.saved'), 'thread-sync').then(loadThread)}
            />
          )}
        </div>
        )}
        </></Gate>
      </>)}</Card>

      {/* The mark goes in the card's own corner rather than on a box drawn
          around the card, so the gate here draws none of its own. */}
      <Card icon="power" title={t('network.power')} anchor="power"
            hardware="power_saving">{(paneSay) => (<>
        <Gate name="power_saving" mark={false}><>
          <Toggle
            label={t('network.power_saving')}
            hint={t('network.lowers_power_draw_when_network')}
            checked={Boolean(power?.enabled)} disabled={busyWith('power')}
            onChange={(v) => runIn(paneSay,
              () => api.put('/api/network/power-saving', { enabled: v }),
              v ? t('network.power_saving_enabled') : t('network.power_saving_disabled'), 'power')}
          />

          <div className="mt-3 border-t border-[var(--color-line)] pt-3">
            {/* A switch rather than a heading with a button beside it. Most
                networks have no schedule and never will, and the offer to
                make one was as prominent as the setting above it. Off, this
                is one line; on, the way to add one arrives. */}
            <Toggle
              label={t('network.schedules')}
              hint={t('network.power_saving_schedule_hint')}
              checked={schedOn}
              disabled={busyWith('schedules')}
              onChange={(v) => { setSchedOn(v); if (!v) setAddSched(false) }}
            />
            {/* Everything the switch governs, in one region: the way to add
                a schedule and the schedules themselves.

                Rows from 0fr to 1fr, which is a height animation that needs
                no measuring. `inert` while closed so nothing inside is a tab
                stop nobody can see. The easing is the one the charts grow on.

                The section opens itself whenever a schedule exists, so the
                only way to reach the closed state with schedules in it is to
                close it deliberately. Closing changes nothing on the network
                — every schedule keeps running, and its own switch is what
                stops it. */}
            <div
              className="grid transition-[grid-template-rows,opacity] duration-300"
              style={{ gridTemplateRows: schedOn ? '1fr' : '0fr',
                       opacity: schedOn ? 1 : 0,
                       transitionTimingFunction: EASE_OUT }}
              inert={!schedOn || undefined}
            >
              <div className="overflow-hidden">
                <div className="flex justify-end pt-2">
                  <RowAction onClick={() => setAddSched((v) => !v)}
                             disabled={busyWith('schedules')}>
                    {addSched ? t('network.cancel') : t('network.add_schedule')}
                  </RowAction>
                </div>
            {/* Indented to the switch's label rather than to the card, so
                the schedules read as belonging to the row above them, each
                with its own switch under the one that governs them all. 48px
                is the switch and its gap — but not on a phone, where 48px of
                the 290 available costs more than the alignment gives and
                pushed the last column off the edge. Nothing at all when there
                are none: a line saying "No schedules" under a switch that is
                off is the pane answering a question its own state already
                answered. */}
            {schedules.length > 0 && (
              <div className="mt-2 overflow-x-auto sm:pl-12">
                <table className="w-full text-[13px]">
                  <tbody>
                    {schedules.map((sc) => (
                      <tr key={sc.id} className="align-middle">
                        {/* First, under the switch that governs the lot. One
                            schedule off is not the same as no schedule, and
                            eero carries the flag per schedule — its own app
                            switches them individually, where this could only
                            delete them. */}
                        <td className="w-9 py-1 pr-3">
                          <Toggle
                            srLabel={sc.name}
                            checked={sc.enabled !== false}
                            disabled={busyWith('schedules')}
                            onChange={(v) => runIn(paneSay, () => api.put(
                              `/api/network/power-saving/schedules/${sc.id}`,
                              { name: sc.name, enabled: v, days: sc.days ?? [],
                                start_time: sc.start_time,
                                end_time: sc.end_time }),
                              t('network.saved'), 'schedules').then(loadSchedules)}
                          />
                        </td>
                        <td className="py-1 pr-3">{sc.name}</td>
                        <td className="py-1 pr-3 tabular-nums text-[var(--color-ink-3)]">
                          {clockTime(sc.start_time)}–{clockTime(sc.end_time)}
                        </td>
                        {/* Weekdays and Weekends rather than five and two day
                            names, by the same formatter the profile schedules
                            use — it was written for this and this was still
                            printing eero's raw list. */}
                        <td className="py-1 pr-3 text-[var(--color-ink-3)]">
                          {daysLabel(sc.days)}
                        </td>
                        <td className="py-1 text-right">
                          <RowAction
                            onClick={() => runIn(paneSay,
                              () => api.del(`/api/network/power-saving/schedules/${sc.id}`),
                              t('network.schedule_removed'), 'schedules').then(loadSchedules)}
                            disabled={busyWith('schedules')}
                          >
                            {t('network.remove')}
                          </RowAction>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {addSched && (
              <form
                className="mt-2 grid gap-2 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const f = new FormData(e.currentTarget as HTMLFormElement)
                  const days = f.getAll('day').map(String)
                  if (!days.length) { paneSay.fail(t('network.pick_least_one_day')); return }
                  runIn(paneSay, () => api.post('/api/network/power-saving/schedules', {
                    name: String(f.get('name')), enabled: true, days,
                    start_time: String(f.get('start')),
                    end_time: String(f.get('end')),
                  }), t('network.schedule_added'), 'schedules').then(() => { setAddSched(false); loadSchedules() })
                }}
              >
                {/* 32, because that is where eero stops: measured against
                    the API, a 32-character name is accepted and a 33 is
                    refused with a bare `error.form.errors`. Held here so the
                    box simply will not take a 33rd character, rather than
                    letting somebody type a name and then be told. */}
                <input name="name" required maxLength={SCHEDULE_NAME_MAX}
                       placeholder={t('network.name')}
                       aria-label={t('network.schedule_name')}
                       className={FIELD} />
                <span className="flex gap-2">
                  <input name="start" type="time" required defaultValue="23:00"
                         aria-label={t('network.start_time')} className={FIELD} />
                  <input name="end" type="time" required defaultValue="06:00"
                         aria-label={t('network.end_time')} className={FIELD} />
                </span>
                <fieldset className="sm:col-span-2">
                  <legend className="micro-label">{t('network.days')}</legend>
                  <span className="mt-1 flex flex-wrap gap-2">
                    {DAYS.map((d) => (
                      <label key={d} className="flex items-center gap-1 text-[12px]">
                        <input type="checkbox" name="day" value={d}
                               className="accent-[var(--color-accent)]" />
                        {t(`day.${d}.short`)}
                      </label>
                    ))}
                  </span>
                </fieldset>
                <SubmitButton disabled={busyWith('schedules')} className="justify-self-start">
                  {t('network.add_schedule')}
                </SubmitButton>
              </form>
            )}
              </div>
            </div>
          </div>
        </></Gate>
      </>)}</Card>

      <Card icon="reservation"
        title={t('network.dhcp_reservations_count', { count: res.length })}
        anchor="reservations"
        className="wide:col-span-2"
        action={
          <RowAction
            onClick={() => {
              setResMac(''); setResIp('')
              setAddRes((v) => !v)
            }}
            disabled={busyWith('reservations')}
          >
            {addRes ? t('network.cancel') : t('network.add_reservation')}
          </RowAction>
        }
      >{(paneSay) => (<>
        {addRes && (
          <form
            className="mb-4 grid gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 sm:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault()
              /* The button is disabled unless the address is a host inside
                 the subnet, so this is the belt to that braces — a keyboard
                 submit, or a subnet that could not be established and left
                 the field free. */
              if (!isIpv4(resIp)) {
                paneSay.fail(t('network.not_an_ip_address'))
                return
              }
              if (!isHostIn(lan.lan_subnet ?? null, resIp)) {
                paneSay.fail(t('network.outside_subnet',
                                { cidr: lan.lan_subnet?.cidr ?? '' }))
                return
              }
              const chosen = reservableDevices.find((d) => d.mac === resMac)
              runIn(paneSay, () => api.post('/api/reservations', {
                mac: resMac, ip: resIp.trim(),
                description: chosen?.nickname || chosen?.hostname
                             || chosen?.display_name || '',
              }), t('network.reservation_created'), 'reservations').then(() => {
                setAddRes(false); setResMac(''); setResIp(''); loadDevices()
              })
            }}
          >
            <select
              name="mac" required aria-label={t('network.device')}
              value={resMac}
              onChange={(e) => {
                const mac = e.target.value
                setResMac(mac)
                /* The device's current address, which is what a reservation
                   normally pins. A client holding no lease has none to offer,
                   and empty octets ask somebody to invent an address and then
                   find out whether it collided — so one nothing is known to
                   be using is offered instead, from the addresses the page
                   already has: every client's current one and every existing
                   reservation. */
                const d = reservableDevices.find((x) => x.mac === mac)
                const held = d?.ip && isHostIn(lan.lan_subnet ?? null, d.ip)
                  ? d.ip : ''
                setResIp(held || firstFreeAddress(
                  lan.lan_subnet ?? null,
                  [...devices.map((x) => x.ip), ...res.map((r) => r.ip),
                   ...nodeIps, lan.gateway_ip]))
              }}
              className={`sm:col-span-2 ${FIELD}`}
            >
              <option value="">{t('network.choose_device')}</option>
              {reservableDevices.map((d) => (
                <option key={d.mac} value={d.mac ?? ''}>
                  {(d.nickname || d.hostname || d.display_name || d.mac)}{d.ip ? ` — ${d.ip}` : ''}
                </option>
              ))}
            </select>
            {/* Shaped like the subnet rather than free text. eero refuses
                anything outside it, so the octets the mask pins are shown and
                the ones it leaves open are offered — see SubnetAddress. */}
            <SubnetAddress subnet={lan.lan_subnet ?? null} value={resIp}
                           onChange={setResIp} disabled={busyWith('reservations')} />
            <SubmitButton disabled={busyWith('reservations') || !isHostIn(lan.lan_subnet ?? null, resIp)}>
              {t('network.add')}
            </SubmitButton>
            <p className="text-[12px] text-[var(--color-ink-3)] sm:col-span-4">
              {t('network.picking_device_fills_address_using')}
            </p>
          </form>
        )}
        <DataTable columns={resCols(paneSay)} rows={res} rowKey={(r) => r.url}
                   defaultSort={{ key: 'i' }}
                   empty={t('network.no_reservations_yet_reservation_pins')}
                   expand={(r) => (editRes !== r.url ? null : (
                     /* The add form's layout and the add form's rules, on the
                        row being changed. Four columns on a wide screen and
                        the same `SubnetAddress`, so the octets the mask pins
                        are fixed and only the ones it leaves open can be
                        typed into. */
                     <form
                       className="mt-1 grid gap-2 rounded-md border border-[var(--color-line)]
                                  bg-[var(--color-surface-2)] p-3 sm:grid-cols-4"
                       onSubmit={(e) => {
                         e.preventDefault()
                         if (!isIpv4(editIp)) {
                           paneSay.fail(t('network.not_an_ip_address')); return
                         }
                         if (!isHostIn(lan.lan_subnet ?? null, editIp)) {
                           paneSay.fail(t('network.outside_subnet',
                             { cidr: lan.lan_subnet?.cidr ?? '' })); return
                         }
                         saveReservation(paneSay, r, { ip: editIp.trim() })
                         setEditRes(null)
                       }}
                     >
                       <span className="text-[13px] sm:col-span-2 sm:self-center">
                         {r.description || r.mac}
                       </span>
                       <SubnetAddress subnet={lan.lan_subnet ?? null} value={editIp}
                                      onChange={setEditIp}
                                      disabled={busyWith('reservations')} />
                       <span className="flex gap-2">
                         <SubmitButton
                           disabled={busyWith('reservations')
                                     || !isHostIn(lan.lan_subnet ?? null, editIp)
                                     || editIp.trim() === (r.ip ?? '')}>
                           {t('network.save')}
                         </SubmitButton>
                         <RowAction onClick={() => setEditRes(null)}>
                           {t('network.cancel')}
                         </RowAction>
                       </span>
                     </form>
                   ))} />
      </>)}</Card>
      </>)}

    </>
  )
  /* The Internet page brings its own frame, with this card as one pane of
     it; the Network page is nothing but these panes, so the frame is here. */
  return internetOnly ? body : <Page name="network" columns={2}>{body}</Page>
}

/**
 * The Internet tab.
 *
 * Three things, two of which do not come from this page's reads at all. They
 * are siblings of the pane rather than children of it for two reasons: an
 * outage fails every cloud read `Network` makes, which would take the
 * diagnosis and the backup switch off the screen at the moment they are
 * wanted; and the error, placeholder, and loaded states are different trees, so
 * a card inside them is unmounted and rebuilt every time the page changes
 * state — which loses a click that lands during one.
 */
export function InternetPage() {
  return (
    <Page name="internet" columns={2}>
      {/* First, because during an outage it is the only question anybody has
          and everything below it is secondary. */}
      <Slot id="wan" wide><WanDiagnosis /></Slot>
      <Network show="internet" />
      {/* Last, because it is what happens when everything above it stops
          working. It reads the saved-network list over the local channel,
          which is why it used to live on the Local control page — but that is
          how one of its reads travels, not what it is about. */}
      <Slot id="backup" wide><InternetBackup /></Slot>
    </Page>
  )
}
