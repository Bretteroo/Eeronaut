import { useEffect, useState } from 'react'
import { api, type Prefs } from '../lib/api'
import { followAfterThemeChange, useTheme, type ThemeList } from '../lib/theme'
import { ACTION, FIELD, SubmitButton } from './primitives'
import { t } from '../i18n'

type Appearance = Prefs['appearance']

/** Whether the operating system is asking for dark, right now. */
const systemDark = () =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/**
 * Choose a theme and an appearance, and see them before committing.
 *
 * Both choices are held here until Apply is pressed. They used to take
 * effect on the press — Light, Dark, System, and the interface changed under
 * the finger — which is right for a switch and wrong for a preview: the
 * point of a screenshot is to look at a theme without wearing it. So the
 * buttons and the dropdown change the picture and the words beside it, and
 * only Apply changes the interface. The screenshot shows the appearance
 * chosen; for System that is whichever the operating system wants today.
 *
 * Titles and descriptions are the theme's own, from its manifest. They are
 * the one text a theme carries and the one text here the catalogs do not
 * translate: a theme is self-contained, and nothing about one lives outside
 * its directory.
 */
export function ThemePicker({ prefs, onApply }: {
  prefs: Prefs
  onApply: (patch: Partial<Prefs>) => Promise<void>
}) {
  const [list, setList] = useState<ThemeList | null>(null)
  const [theme, setTheme] = useState(prefs.theme)
  const [appearance, setAppearance] = useState<Appearance>(prefs.appearance)
  const [busy, setBusy] = useState(false)
  /* Whether a choice has been made here that is not yet applied. */
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    api.get<ThemeList>('/api/themes').then(setList).catch(() => {})
  }, [])
  /* Follow what is saved when it arrives or changes elsewhere, so the
     picker never claims a pending change it does not have — unless a
     choice is pending. The page mounts with default preferences and the
     real ones land a moment later; a press in between was undone by their
     arrival, which read as the button not working. */
  useEffect(() => { if (!touched) setTheme(prefs.theme) }, [prefs.theme, touched])
  useEffect(() => { if (!touched) setAppearance(prefs.appearance) }, [prefs.appearance, touched])

  const shown = list?.themes.find((th) => th.id === theme)
    ?? list?.themes.find((th) => th.id === list.active)
  const side: 'light' | 'dark' =
    appearance === 'system' ? (systemDark() ? 'dark' : 'light') : appearance
  const dirty = Boolean(list) && (theme !== prefs.theme || appearance !== prefs.appearance)

  const current = useTheme().id
  async function apply() {
    setBusy(true)
    /* A different theme may keep this menu somewhere else; come back to it
       wherever that is. Only for a change of theme, since the same theme in
       another appearance leaves every page where it was. */
    if (theme && theme !== current) followAfterThemeChange('settings', 'display')
    try { await onApply({ theme, appearance }); setTouched(false) }
    finally { setBusy(false) }
  }

  return (
    <div data-part="theme-picker" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {/* As wide as the picture under it. The menu names the theme and
            the picture shows it, and the two reading as one column beats ten
            characters of menu floating over a 288px preview. The same 18rem
            the figure's first column takes below, and never wider than the
            card on a phone, where the figure is one column and this is the
            width of that. */}
        <label className="grid w-full max-w-[18rem] gap-1">
          <span className="micro-label">{t('settings.theme')}</span>
          <select
            value={shown?.id ?? theme}
            disabled={!list}
            onChange={(e) => { setTheme(e.target.value); setTouched(true) }}
            className={`${FIELD} w-full`}
          >
            {(list?.themes ?? []).map((th) => (
              <option key={th.id} value={th.id}>{th.title}</option>
            ))}
          </select>
        </label>
        <div role="group" aria-label={t('settings.appearance')}
             className="flex flex-wrap gap-2">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => { setAppearance(mode); setTouched(true) }}
              aria-pressed={appearance === mode}
              className={`${ACTION} ${
                appearance === mode
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)] hover:bg-[var(--color-accent-wash)] hover:text-[var(--color-accent-ink)]'
                  : ''
              }`}
            >
              {t(`settings.theme_${mode}`)}
            </button>
          ))}
        </div>
        <SubmitButton onClick={() => void apply()} disabled={!dirty || busy}>
          {t('settings.apply_theme')}
        </SubmitButton>
      </div>

      {/* Beside each other when the card has room for the picture and a
          caption beside it, measured on the card rather than the window: a
          theme with a narrow form column left the caption a sliver. */}
      {shown && (
        <div className="@container">
        <figure data-theme-preview={shown.id} data-theme-side={side}
                className="grid gap-2 @min-[30rem]:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] @min-[30rem]:gap-4">
          {/* Sized before it arrives, so the card does not grow as the
              picture lands or shrink when the appearance flips it. Every
              theme's screenshots are the same shape. */}
          <img
            src={shown.screenshots[side]}
            alt={t('settings.theme_preview_alt',
                   { theme: shown.title, mode: t(`settings.theme_${side}`) })}
            width={1280} height={800}
            className="aspect-[16/10] w-full rounded-md border border-[var(--color-line)]
                       bg-[var(--color-surface-2)] object-cover"
          />
          <figcaption className="min-w-0 self-center">
            <div className="flex flex-wrap items-baseline gap-2">
              <span data-theme-title className="text-[13px] font-semibold text-[var(--color-ink)]">
                {shown.title}
              </span>
              <span data-theme-version
                    className="rounded bg-[var(--color-surface-2)] px-1.5 text-[11px]
                               tabular-nums text-[var(--color-ink-3)]">
                {t('settings.theme_version', { v: shown.version })}
              </span>
            </div>
            <p data-theme-description
               className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              {shown.description}
            </p>
          </figcaption>
        </figure>
        </div>
      )}
    </div>
  )
}
