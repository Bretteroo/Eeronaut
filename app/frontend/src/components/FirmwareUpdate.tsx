import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { Notice, ReleaseNotesLink, SubmitButton } from './primitives'
import { useClock } from '../lib/clock'
import { t, tx } from '../i18n'

/**
 * The pending firmware update, and the one button that installs it.
 *
 * `POST /api/network/updates/start` has existed since the endpoint sweep and
 * nothing ever called it: the interface could tell you an update was waiting
 * and could move the window it would install in, but had no way to say "now".
 *
 * Shared between Settings and the Dashboard rather than written twice, because
 * the two have to agree about three things that are easy to get subtly
 * different — whether an update exists, whether eero will accept an immediate
 * one, and what the confirmation warns about.
 */

export interface Updates {
  has_update: boolean
  preferred_update_hour?: number | null
  can_update_now?: boolean | null
  target_firmware?: string | null
  last_update_started?: string | null
  /** What is running now. Null while the eeros disagree, which happens
   *  partway through a rolling update; `firmware_versions` has them all. */
  current_firmware?: string | null
  firmware_versions?: string[]
}

/** Reads the update state, and re-reads it after starting one. */
export function useUpdates() {
  const [updates, setUpdates] = useState<Updates | null>(null)
  const load = useCallback(() =>
    api.get<Updates>('/api/network/updates')
      .then(setUpdates).catch(() => setUpdates(null)), [])
  useEffect(() => { void load() }, [load])
  return { updates, reload: load }
}

/**
 * Start it now.
 *
 * Confirmed rather than immediate, and the confirmation is blunt: this reboots
 * every eero on the network at once. It is the most disruptive thing this
 * interface can do from a single click, more so than rebooting one node,
 * because there is no node left serving clients while it happens.
 *
 * `can_update_now` is eero's own answer to whether an immediate install is
 * possible; when it says no the button is disabled rather than hidden, so the
 * update is still visibly pending.
 */
export function UpdateNowButton({ updates, onDone, tone = 'accent' }: {
  updates: Updates | null
  onDone?: (message: string, ok: boolean) => void
  tone?: 'accent' | 'bad'
}) {
  const [busy, setBusy] = useState(false)
  if (!updates?.has_update) return null
  const blocked = updates.can_update_now === false

  return (
    <SubmitButton
      type="button"
      tone={tone}
      disabled={busy || blocked}
      title={blocked ? t('firmware.eero_will_not_start_one_now') : undefined}
      onClick={async () => {
        if (!window.confirm(t('firmware.install_now_confirm',
                              { version: updates.target_firmware ?? '' }))) return
        setBusy(true)
        try {
          await api.post('/api/network/updates/start', {})
          onDone?.(t('firmware.update_started'), true)
        } catch (e) {
          onDone?.(e instanceof ApiError ? e.message
                                         : t('firmware.could_not_start_update'), false)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? t('firmware.starting') : t('firmware.update_now')}
    </SubmitButton>
  )
}

/**
 * The dashboard notice.
 *
 * Says when the update will happen on its own, which is the part somebody
 * actually wants: an update they did not ask for that reboots the house at
 * some unstated hour is worth knowing the hour of. The window is eero's
 * `preferred_update_hour`, printed in whichever clock format is set, so this
 * agrees with the control on Settings that changes it.
 *
 * Renders nothing when there is no update. A dashboard panel that says
 * "everything is current" is a panel earning its space by saying nothing.
 */
export function FirmwareNotice() {
  const { updates, reload } = useUpdates()
  const { hourWindow } = useClock()
  const [said, setSaid] = useState<{ text: string; ok: boolean } | null>(null)

  if (!updates?.has_update) return null
  const hour = updates.preferred_update_hour

  return (
    /* A panel rather than a line of bold amber text.
       It was a `Notice`, which is the right primitive for a sentence and the
       wrong one for this: a title, a schedule, a link, and a button all went
       into one bold warning-colored run, so the eye had nothing to land on
       and the whole thing read as shouting.

       Now it is a container. A washed ground and a warn-colored edge say
       "notice" without coloring the words; the words themselves go back to
       ink, in a heading and a detail line, and the button sits at the end of
       the row where an action belongs. `col-span-full` survives from the
       `Notice` it replaced, for the same reason: this gets dropped into
       multi-column grids and must span them rather than taking a cell. */
    <div className="col-span-full mb-4">
      {/* A live region: it appears when the update check answers, a second or
          two after the page has settled, so a reader that has moved on is
          told rather than having to find it again. It was a `Notice`, which
          carried the role; the panel that replaced it dropped the role along
          with the styling. */}
      {/* The wash is laid over the card color rather than used alone. Every
          theme's wash is a translucent tint, and in a theme that puts a
          photograph behind the top of the dashboard (Eerish, Sailing) the
          picture showed through the words. The row is centered, so the
          button sits level with the middle of the two lines. */}
      <div role="status"
           className="flex flex-wrap items-center gap-3 rounded-lg border
                      border-l-[3px] border-[var(--color-line)]
                      border-l-[var(--color-warn)] p-3 sm:p-4"
           style={{ background: 'linear-gradient(var(--color-warn-wash), var(--color-warn-wash)), var(--color-surface)' }}>
        {/* Decorative: the heading beside it already says what this is. The
            chip takes the surface color so it reads as sitting on the wash
            in either theme rather than vanishing into it. */}
        <span aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center
                         rounded-full bg-[var(--color-surface)]"
              style={{ color: 'var(--color-warn)' }}>
          <svg viewBox="0 0 24 24" className="size-4" fill="currentColor">
            <path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.7 1.4-1.4L12 13.6V3z
                     M4 19h16v2H4z" />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-[var(--color-ink)]">
            {updates.target_firmware
              ? t('firmware.version_available', { version: updates.target_firmware })
              : t('firmware.update_available')}
            {/* Straight after the sentence that names the version: what is in
                it is the question anybody reading a version number asks next,
                so the answer sits where the question is asked. */}
            {' '}<ReleaseNotesLink className="text-[13px] font-normal" />
          </p>
          {/* The window itself is the link to change it. A separate "Change the
              window" after the sentence said twice what the time already said
              once; pressing the time is what somebody who wants a different
              one reaches for. */}
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {typeof hour === 'number'
              ? tx('firmware.installed_automatically_at', {
                  time: <Link to="/settings?pane=firmware" className="link"
                              title={t('firmware.change_window_title')}>{hourWindow(hour)}</Link> })
              : tx('firmware.installed_automatically_unknown', {
                  window: <Link to="/settings?pane=firmware" className="link"
                                title={t('firmware.change_window_title')}>{t('firmware.your_update_window')}</Link> })}
          </p>
        </div>

        <span className="shrink-0">
          <UpdateNowButton
            updates={updates}
            onDone={(text, ok) => { setSaid({ text, ok }); void reload() }}
          />
        </span>
      </div>
      {said && (
        <div className="mt-2">
          <Notice kind={said.ok ? 'ok' : 'bad'}>{said.text}</Notice>
        </div>
      )}
    </div>
  )
}
