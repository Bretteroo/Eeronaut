import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import { daysLabel } from '../lib/format'
import { Card, Check, RowAction, SubmitButton, useNotice,
         type CardSay } from './primitives'
import { useClock } from '../lib/clock'
import { t } from '../i18n'
import type { FilterProfile } from './ProfileFilters'

/**
 * When a profile loses the internet, on a repeating weekly window.
 *
 * It was the fifth tab of the Filters pane, which is where it does not
 * belong: the other four decide what a profile may reach, and this one
 * decides when it may reach anything at all. Its own button on the profile
 * card, and its own page.
 *
 * The catalog keys still carry the `profile_filters.` prefix from where the
 * form used to live. They are keys, not paths, and renaming them would rewrite
 * three translation files to say the same words.
 */

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday',
              'friday', 'saturday', 'sunday'] as const

export function ProfileSchedule({ profile, onChanged, bare = false }: {
  profile: FilterProfile | null
  onChanged: () => void
  /** Without the card around it, for a drawer that brings its own header. */
  bare?: boolean
}) {
  const { clockTime } = useClock()
  const own = useNotice()
  const [busy, setBusy] = useState('')
  const [clearedSchedules, setClearedSchedules] = useState(false)
  /** Days ticked on the unsubmitted new-schedule form. */
  const [newDays, setNewDays] = useState<string[]>([])

  if (!profile) return null

  // What the list shows: empty while a Remove all is in flight.
  const schedules = clearedSchedules ? [] : profile.schedules

  const inner = (say: CardSay) => {
        /** Returns whether it worked, so a form clears only on success. */
        const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
          setBusy(key); say.clear()
          try { await fn(); say.ok(ok); onChanged(); return true }
          catch (e) {
            say.fail(e instanceof ApiError ? e.message : t('profile_filters.did_not_work'))
            return false
          } finally { setBusy('') }
        }

        const removeAll = async () => {
          const all = profile.schedules
          if (!window.confirm(t('profile_filters.remove_all_length_scheduled_pauses',
                                { length: all.length, name: profile.name }))) return
          setBusy('sched'); say.clear()
          /* Emptied as soon as it is confirmed rather than after a call per
             schedule. If one fails the reload below puts the survivors back,
             so the screen never claims something is gone that is not. */
          setClearedSchedules(true)
          let done = 0
          try {
            for (const s of all) {
              await api.del(`/api/profiles/schedules?url=${encodeURIComponent(s.url)}`)
              done += 1
            }
            say.ok(t('profile_filters.done_scheduled_pauses_removed', { done }))
          } catch (e) {
            const why = e instanceof ApiError
              ? e.message : t('profile_filters.something_went_wrong')
            say.fail(done
              ? t('profile_filters.removed_of_then_stopped',
                  { done, total: all.length, reason: why })
              : (e instanceof ApiError ? e.message : t('profile_filters.did_not_work')))
          } finally {
            setBusy('')
            setClearedSchedules(false)
            onChanged()
          }
        }

    return (<>
          <p className="mb-3 text-[12px] leading-snug text-[var(--color-ink-3)]">
            {t('profile_filters.recurring_window_when_profile_loses')}
          </p>
          <form
            className="mb-3 grid gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2"
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget as HTMLFormElement)
              const days = DAYS.filter((d) => newDays.includes(d))
              if (!days.length) { say.fail(t('profile_filters.pick_least_one_day')); return }
              const form = e.currentTarget as HTMLFormElement
              void run('sched', () => api.post(
                `/api/profiles/schedules?url=${encodeURIComponent(profile.url)}`,
                { name: String(f.get('sname')
                               || t('profile_filters.scheduled_pause_fallback')),
                  days, start: String(f.get('start')), end: String(f.get('end')),
                  enabled: true }),
                t('profile_filters.schedule_added'))
                // Emptied only on the way out, so a failed add leaves what was
                // typed where it was typed.
                .then((ok) => { if (ok) { form.reset(); setNewDays([]) } })
            }}
          >
            <input name="sname" placeholder={t('profile_filters.name_example_bedtime')}
              aria-label={t('profile_filters.schedule_name')}
              className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]" />
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {DAYS.map((d) => (
                <Check key={d} name={d} checked={newDays.includes(d)}
                       label={t(`day.${d}.short`)}
                       onChange={(v) => setNewDays((xs) =>
                         v ? [...xs, d] : xs.filter((x) => x !== d))} />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input name="start" type="time" required defaultValue="21:00"
                aria-label={t('profile_filters.pause_from')}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]" />
              <span className="text-[12px] text-[var(--color-ink-3)]">{t('profile_filters.to')}</span>
              <input name="end" type="time" required defaultValue="07:00"
                aria-label={t('profile_filters.pause_until')}
                className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]" />
              <SubmitButton disabled={Boolean(busy)} className="ml-auto">
                {t('profile_filters.add')}
              </SubmitButton>
            </div>
          </form>
          {schedules.length > 0 && (
            <ul className="grid gap-1">
              {schedules.map((s) => (
                <li key={s.url}
                    className="flex items-center gap-2 border-b border-[var(--color-line)] py-1 text-[13px] last:border-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {s.name || t('profile_filters.scheduled_pause_fallback')}
                    </span>
                    {/* Which days it falls on — a window without them reads as
                        a one-off rather than something recurring. */}
                    <span className="block truncate text-[12px] text-[var(--color-ink-3)]">
                      {daysLabel(s.days) || t('profile_filters.no_days_set')}
                    </span>
                  </span>
                  {/* Fixed width so every row's times line up under each
                      other rather than shifting with the name beside them. */}
                  <span className="w-44 shrink-0 text-center tabular-nums text-[var(--color-ink-3)]">
                    {s.start && s.end
                      ? `${clockTime(s.start)} - ${clockTime(s.end)}`
                      : ''}
                    {s.enabled ? '' : ' (off)'}
                  </span>
                  <RowAction tone="bad" disabled={Boolean(busy)}
                    onClick={() => run('sched',
                      () => api.del(`/api/profiles/schedules?url=${encodeURIComponent(s.url)}`),
                      t('profile_filters.schedule_removed'))}>
                    {t('profile_filters.remove')}
                  </RowAction>
                </li>
              ))}
            </ul>
          )}

          {/* Only worth offering once there is more than one to clear; with a
              single schedule it is the same click as the Remove beside it. */}
          {schedules.length > 1 && (
            <div className="mt-2 flex justify-end border-t border-[var(--color-line)] pt-2">
              <RowAction tone="bad" disabled={Boolean(busy)}
                onClick={() => void removeAll()}>
                {t('profile_filters.remove_all')}
              </RowAction>
            </div>
          )}
        </>)
  }

  if (bare) {
    return (<>
      {own.node && <div className="mb-3">{own.node}</div>}
      {inner(own)}
    </>)
  }
  return (
    <Card icon="clock" title={t('profile_filters.scheduled_pauses')} anchor="schedule">
      {inner}
    </Card>
  )
}
