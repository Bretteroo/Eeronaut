import { useCallback, useEffect, useState } from 'react'
import { accessoryStateHelp } from '../lib/nodeHelp'
import { api, lastRead } from '../lib/api'
import { nodeStatusLabel } from '../lib/nodeStatusLabel'
import { Drawer, Notice, SignalBars, SkeletonRows } from './primitives'
import { useRevalidate } from '../lib/revalidate'
import { ACCESSORY_MS } from '../lib/pollRates'
import { SignalIcon } from './DeviceIcon'
import { PlusRow } from '../lib/capabilities'
import { gbFromKb as gbOf, day } from '../lib/format'
import { useClock } from '../lib/clock'
import { fromScore } from '../lib/signal'
import { t } from '../i18n'

/* Everything eero knows about an eero Signal, in one place.

   eero files a Signal under the eero it plugs into, and the detail used to be
   shown there — which put a device's own information inside a different
   device's panel. It is fetched here by its serial instead, so the Signal owns
   what it reports and the eero's panel is about the eero.

   The SIM's ICCID and the modem's IMEI/IMSI/EID are dropped server-side: they
   identify the subscriber, not the hardware's health. */

interface Detail {
  model?: string | null
  /** eero's product name — "eero Signal 5G" rather than the bare "eero
   *  Signal" both variants report as their model. */
  product?: string | null
  /** eero's fault code, which decides the advice in the warning. */
  configuration_status?: string | null
  model_number?: string | null
  variant?: string | null
  serial?: string | null
  fcc_id?: string | null
  ic_id?: string | null
  imei?: string | null
  issue?: string | null
  status_key?: string | null
  status_label?: string | null
  registered?: boolean
  carrier?: string | null
  signal_score?: number | null
  provider?: string | null
  status?: string | null
  used_kb?: number | null
  max_kb?: number | null
  unlimited?: boolean
  cycle_end?: string | null
  node?: string | null
  joined?: string | null
}

/** Nothing to do: the drawer is shut, so there is nothing to refresh. */
const NOOP = () => {}

/**
 * `usb-c-port` from Material Design Icons, inlined.
 *
 * Inlined rather than pulled in as a dependency: the project ships no icon
 * package, every other glyph here is a path in the source, and one icon is
 * not worth a package plus a build step. MDI's icons are Apache-2.0, and the
 * path is theirs verbatim rather than redrawn.
 */
function UsbCPortIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0"
         fill="var(--color-ok)" aria-hidden="true">
      <path d="M6 12H18C18.55 12 19 12.45 19 13C19 13.55 18.55 14 18 14H6C5.45 14 5 13.55 5 13C5 12.45 5.45 12 6 12M6 10C4.34 10 3 11.34 3 13C3 14.66 4.34 16 6 16H18C19.66 16 21 14.66 21 13C21 11.34 19.66 10 18 10H6M6 8H18C20.76 8 23 10.24 23 13C23 15.76 20.76 18 18 18H6C3.24 18 1 15.76 1 13C1 10.24 3.24 8 6 8Z" />
    </svg>
  )
}

function Row({ label, children, mono = false }:
  { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] py-2 last:border-0">
      <span className="micro-label">{label}</span>
      <span className={`text-right text-[13px] ${mono ? 'font-mono text-[12px]' : ''}`}>
        {children}
      </span>
    </div>
  )
}

/** What this accessory's panel said last time, if anything. */
function kept(dsn: string | null) {
  return (dsn ? lastRead<Detail>(`/api/accessories/${encodeURIComponent(dsn)}`) : null) ?? null
}

export function SignalPanel({ dsn, fallbackName, onClose }: {
  dsn: string | null
  fallbackName?: string
  onClose: () => void
}) {
  const { when } = useClock()
  /* Opens on the last answer for this accessory. */
  const [d, setD] = useState<Detail | null>(() => kept(dsn))
  const [err, setErr] = useState('')

  /* Split in two on purpose. The first clears the panel when the drawer
     opens on a different accessory — otherwise the old Signal's readings sit
     there under the new one's name. The refresh must not clear anything, or
     every tick would blank the panel and redraw it. */
  useEffect(() => { setD(kept(dsn)); setErr('') }, [dsn])

  const load = useCallback(() => {
    if (!dsn) return
    api.get<Detail>(`/api/accessories/${encodeURIComponent(dsn)}`)
      .then(setD).catch((e) => setErr(e.message))
  }, [dsn])

  useEffect(() => { void load() }, [load])
  /* A Signal's signal strength and registration move on their own, and this
     drawer is open precisely because somebody is watching them. Three
     seconds is eero's own rate for its proxied-nodes screen. Tied to the
     drawer, so it stops when the drawer closes. */
  useRevalidate(dsn ? load : NOOP, ACCESSORY_MS)

  return (
    <Drawer open={Boolean(dsn)} onClose={onClose}
            title={d?.product || d?.model || fallbackName || 'eero Signal'}>
      {err && <Notice kind="bad">{err}</Notice>}
      {!d && !err && (
        <SkeletonRows rows={5} cols={2} />
      )}
      {d && (
        <div>
          <PlusRow name="cellular_backup">
            <div className="mb-4 flex items-center gap-3">
              <SignalIcon size={44} />
              <div>
                <div className="text-[14px] font-medium">
                  {d.product || d.model || 'eero Signal'}
                </div>
                <div className="text-[12px] text-[var(--color-ink-3)]">
                  {d.variant
                    ? t('signal_panel.variant_cellular_backup',
                        { variant: d.variant })
                    : t('signal_panel.cellular_backup')}
                </div>
              </div>
            </div>
          </PlusRow>

          {/* The fault, and what it means for the backup — or that the SIM has
              not registered yet. The same sentence the dashboard shows on
              hover, so the two cannot disagree. */}
          {accessoryStateHelp(d) && (
            <p role="alert"
               className="mb-3 rounded border border-[var(--color-warn)] px-3 py-2 text-[13px] text-[var(--color-warn)]">
              {accessoryStateHelp(d)}
            </p>
          )}

          <h3 className="mb-1 text-[13px] font-semibold">{t('signal_panel.status')}</h3>
          <Row label={t('signal_panel.state')}>{nodeStatusLabel(d) ?? d.status ?? '—'}</Row>
          {/* No signal is a reading, not a missing value: empty bars say the
              modem is attached and finding nothing, which is exactly the state
              this Signal is in. A dash would look like the field failed. */}
          <Row label={t('signal_panel.signal')}>
            <SignalBars value={fromScore(d.signal_score)} />
          </Row>
          <Row label={t('signal_panel.registered')}>{d.registered ? t('signal_panel.yes') : t('signal_panel.no')}</Row>
          <Row label={t('signal_panel.attached')}>{d.node ?? '—'}</Row>
          {d.joined && <Row label={t('signal_panel.joined')}>{when(d.joined)}</Row>}

          {/* How it is attached, which is the question the cellular rows
              below cannot answer. A Signal is not a mesh node: it hangs off
              one eero by cable, so the eero named as attached above is the
              one it is plugged into. Somebody wondering why backup
              stopped working is usually looking for this. */}
          <h3 className="mt-5 mb-1 text-[13px] font-semibold">
            {t('signal_panel.connectivity')}
          </h3>
          <Row label={t('signal_panel.uplink')}>
            <span className="inline-flex items-center gap-1.5">
              {/* Green because a plugged-in cable is the working state, and
                  this row has no other way to say so — there is no reading
                  here to go red, only the fact of the port. */}
              <UsbCPortIcon />
              {/* Which eero it is plugged into, not just the kind of cable.
                  "USB-C" alone answered a question nobody was asking; the
                  useful fact is that this Signal depends on that one eero. */}
              {d.node
                ? t('signal_panel.node_over_usb_c', { node: d.node })
                : t('signal_panel.usb_c_unattached')}
            </span>
          </Row>

          <h3 className="mt-5 mb-1 text-[13px] font-semibold">{t('signal_panel.cellular')}</h3>
          {/* eero reports "unknown" for the carrier whenever the modem is not
              attached to a network, which the server turns into no value. It
              is not the same as the accessory being unregistered — that is the
              row above — so it is left blank rather than explained wrongly. */}
          <Row label={t('signal_panel.carrier')}>{d.carrier ?? '—'}</Row>
          {d.provider && <Row label={t('signal_panel.plan')}>{d.provider}</Row>}
          {d.status && <Row label={t('signal_panel.backup')}>{d.status}</Row>}
          {d.used_kb != null && (
            <Row label={t('signal_panel.data_cycle')}>
              {d.unlimited || !d.max_kb
                ? t('signal_panel.gb_used', { gb: gbOf(d.used_kb) })
                : t('signal_panel.gb_of_gb',
                   { used: gbOf(d.used_kb), max: gbOf(d.max_kb) })}
            </Row>
          )}
          {d.cycle_end && <Row label={t('signal_panel.cycle_ends')}>{day(d.cycle_end)}</Row>}

          <h3 className="mt-5 mb-1 text-[13px] font-semibold">{t('signal_panel.hardware')}</h3>
          {d.model_number && <Row label={t('signal_panel.model')} mono>{d.model_number}</Row>}
          {/* The serial from the underside of the case, which is what a
              warranty claim or a support conversation asks for. */}
          {d.serial && <Row label={t('signal_panel.serial')} mono>{d.serial}</Row>}
          {/* The modem's own identifier, beside the other numbers printed on
              the case. The SIM's ICCID, IMSI, and EID are not here and are not
              served anywhere: those identify the subscription rather than the
              device. */}
          {d.imei && <Row label={t('signal_panel.imei')} mono>{d.imei}</Row>}
          {d.fcc_id && <Row label={t('signal_panel.fcc_id')} mono>{d.fcc_id}</Row>}
          {d.ic_id && <Row label={t('signal_panel.ic_id')} mono>{d.ic_id}</Row>}

          <p className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {t('signal_panel.keeps_network_online_over_cellular')}
          </p>
        </div>
      )}
    </Drawer>
  )
}
