import { useEffect, useState } from 'react'
import { api, lastRead } from '../lib/api'
import { BarList, Donut, PeriodPicker } from './charts'
import { Card, SkeletonRows } from './primitives'
import { PlusWhy, usePlusGate, usePremiumActive } from '../lib/capabilities'
import { t } from '../i18n'

/**
 * What the DNS-layer filtering actually stopped, on the page that switches it
 * on.
 *
 * It used to be the last card on Insights, four figures in a row of tiles.
 * Insights is where you go to read the network's habits; this is the report
 * card for the two switches directly above it, and it belongs beside them.
 *
 * The ring is the part that answers the question at a glance — of everything
 * the resolver looked at, how much did it refuse — and the bars underneath say
 * what kind. Two colors, which are the two the palette has validated; a third
 * hue for a third category would have to be re-checked for contrast and
 * color-vision separation rather than picked here.
 */

interface Slice { supported: boolean; total: number | null }
interface Sec { types: Record<string, Slice> }

/* eero's own names for the four counters, translated. Built on call rather
   than at import, which happens before any language is in force. */
const LABEL = (): Record<string, string> => ({
  inspected: t('insights.requests_inspected'),
  blocked: t('insights.threats_blocked'),
  adblock: t('insights.ads_blocked'),
  filtered: t('insights.content_filtered'),
})

const STOPPED = ['blocked', 'adblock', 'filtered'] as const

/* The window the card opens on. Named because the opening state below
   has to ask for the same one. */
const DEFAULT_DAYS = 7

export function SecurityActivity() {
  const premium = usePremiumActive()
  const cap = usePlusGate('historical_insights')
  const [days, setDays] = useState(DEFAULT_DAYS)
  /* Opens on the last answer for this window; the effect asks for a new one. */
  const [data, setData] = useState<Sec | null>(
    () => lastRead<Sec>(`/api/insights/security?days=${DEFAULT_DAYS}`) ?? null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    /* Nothing to ask for without the subscription: eero answers this one with
       403 premium.user_not_subscribed, so every press of the period buttons
       bought a refusal. They are disabled for the same reason. */
    if (!cap.ready || cap.needsPlus) return
    let live = true
    setPending(true)
    api.get<Sec>(`/api/insights/security?days=${days}`)
      .then((d) => { if (live) setData(d) })
      .catch(() => { if (live) setData(null) })
      .finally(() => { if (live) setPending(false) })
    return () => { live = false }
  }, [days, cap.ready, cap.needsPlus])

  const types = data?.types ?? {}
  const totalOf = (k: string) =>
    types[k]?.supported ? (types[k]?.total ?? 0) : 0
  const stopped = STOPPED.reduce((a, k) => a + totalOf(k), 0)
  const inspected = totalOf('inspected')
  /* Only a ring where there is a whole for the slices to be part of, and only
     where a slice was actually cut: a ring reading "0 stopped" around a single
     full-circle arc is a picture of nothing happening, which the count below
     says better. */
  const ring = Boolean(types.inspected?.supported && inspected >= stopped
                       && stopped > 0)

  /* The hide-these-features setting takes the whole card, not just its mark:
     a pane that exists only for a subscription feature is exactly what that
     setting is for, and an empty card with a title is what it prevents. */
  if (cap.hidden) return null

  const rows = STOPPED
    .filter((k) => types[k]?.supported)
    .map((k) => ({ label: LABEL()[k] ?? k, value: totalOf(k) }))
    .sort((a, b) => b.value - a.value)

  return (
    <Card icon="shield" title={t('insights.security_activity')} anchor="activity"
          plus="historical_insights"
          /* Absent while locked, not disabled. A window picker on a card
             with no history to window is furniture. */
          action={cap.needsPlus ? undefined
                  : <PeriodPicker days={days} onPick={setDays} />}>
      {!premium && !data ? (
        <PlusWhy>{t('insights.security_activity_threats_content_blocked')}</PlusWhy>
      ) : !data ? (
        <SkeletonRows rows={4} cols={2} />
      ) : (<>
        {ring && (
          <div className="mb-4 flex justify-center">
            <Donut
              legend="right"
              size={104}
              label={t('security.stopped')}
              total={stopped}
              caption={t('security.stopped_of_inspected',
                         { stopped: stopped.toLocaleString(),
                           inspected: inspected.toLocaleString() })}
              slices={[
                { name: t('security.stopped'), value: stopped,
                  color: 'var(--series-1)' },
                { name: t('security.let_through'),
                  value: Math.max(0, inspected - stopped),
                  color: 'var(--series-2)' },
              ]}
            />
          </div>
        )}
        <BarList
          rows={rows}
          pending={pending}
          color="var(--series-2)"
          format={(v) => v.toLocaleString()}
          empty={t('security.nothing_stopped_window')}
        />
        {/* The denominator, when there is no ring to carry it. */}
        {!ring && types.inspected?.supported && (
          <p className="mt-3 text-[12px] text-[var(--color-ink-3)]">
            {t('security.requests_inspected_count',
                 { count: inspected.toLocaleString() })}
          </p>
        )}
      </>)}
    </Card>
  )
}
