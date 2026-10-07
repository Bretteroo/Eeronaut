import { useEffect, useLayoutEffect, useRef } from 'react'
import { t } from '../i18n'
import { AppUpdateNotice } from './AppUpdate'

/**
 * About Eeronaut.
 *
 * A centered modal rather than the `Drawer` used elsewhere: a drawer is for
 * detail attached to a row you are looking at, and this is attached to
 * nothing. It is short enough not to scroll and reads better as a card.
 *
 * Everything here is drawn from theme tokens, never a literal color, so it
 * follows light, dark, and system without a second set of rules. The rail this
 * opens from is dark in every theme; the dialog is not part of the rail.
 *
 * It names the license and links to the source. Section 13 of AGPL-3.0-only
 * says anyone who reaches a running instance over a network is owed the
 * corresponding source, and this dialog is where such a person would look.
 */
export const SOURCE_URL = 'https://github.com/Bretteroo/Eeronaut'

/* What a theme may not do to this dialog: hide its words.

   A theme shapes the About dialog the way it shapes everything else: its
   colors, type, spacing, and arrangement are the theme's. Its words are not.
   The theme validator already refuses a stylesheet that adds words (any
   `content` but an empty one); this is the other half. Each piece of text,
   the panel, and the overlay holding it are checked as the dialog opens, and
   anything a stylesheet has hidden is put back with an inline !important,
   which outranks a stylesheet's own. */
/** The feature list's bullets wear the color the links at the foot of the
 *  dialog are drawn in. Read from the link itself rather than named here,
 *  because themes give links their own color and the two should agree in
 *  every one. */
function matchBulletsToLinks(panel: HTMLElement) {
  const link = panel.querySelector<HTMLElement>('a.link')
  const list = panel.querySelector<HTMLElement>('[data-part="about-features"]')
  if (link && list) list.style.setProperty('--about-bullet', getComputedStyle(link).color)
}

function keepWordsShowing(panel: HTMLElement) {
  const overlay = panel.parentElement
  const box = panel.getBoundingClientRect()
  const els = [overlay, panel, ...panel.querySelectorAll<HTMLElement>('[data-about-text]')]
    .filter((e): e is HTMLElement => !!e)
  for (const el of els) {
    const s = getComputedStyle(el)
    const set = (prop: string, value: string) => el.style.setProperty(prop, value, 'important')
    if (s.display === 'none') set('display', 'revert')
    if (s.visibility !== 'visible') set('visibility', 'visible')
    if (Number(s.opacity) < 0.6) set('opacity', '1')
    if (parseFloat(s.fontSize) < 10) set('font-size', '12px')
    const alpha = s.color.match(/rgba?\([^)]*,\s*([\d.]+)\)/)
    if (s.color === 'transparent' || (alpha && Number(alpha[1]) < 0.5)) {
      set('color', 'var(--color-ink-2)')
    }
    if (el !== overlay && el !== panel) {
      // Moved out of the panel, or squeezed to nothing.
      const r = el.getBoundingClientRect()
      const outside = r.right < box.left || r.left > box.right
        || r.bottom < box.top || r.top > box.bottom
      if (outside || r.width < 1 || r.height < 1) {
        set('position', 'static'); set('transform', 'none')
        set('width', 'auto'); set('height', 'auto'); set('overflow', 'visible')
        set('clip-path', 'none'); set('text-indent', '0')
      }
    }
  }
}
export function AboutDialog({
  open, onClose, version,
}: { open: boolean; onClose: () => void; version: string }) {
  const panel = useRef<HTMLDivElement | null>(null)
  const restoreTo = useRef<Element | null>(null)

  /* Same contract as Drawer: focus moves in on open and back to whatever
     opened it on close, so a keyboard user is not dropped at the top of the
     document. Escape closes. */
  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      ;(restoreTo.current as HTMLElement | null)?.focus?.()
    }
  }, [open, onClose])

  /* Before the first paint, and again a frame later for anything still
     settling, such as a theme's fonts. */
  useLayoutEffect(() => {
    if (!open || !panel.current) return
    const el = panel.current
    keepWordsShowing(el)
    matchBulletsToLinks(el)
    const id = requestAnimationFrame(() => { keepWordsShowing(el); matchBulletsToLinks(el) })
    return () => cancelAnimationFrame(id)
  }, [open])

  if (!open) return null

  return (
    <div data-part="overlay" className="fixed inset-0 z-40 grid place-items-center p-4">
      <button type="button" aria-label={t('about.close')} onClick={onClose}
              data-part="scrim" className="absolute inset-0 bg-black/40" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        data-part="modal"
        className="relative w-full max-w-[456px] rounded-lg border
                   border-[var(--color-line)] bg-[var(--color-surface)]
                   p-6 text-center shadow-xl outline-none"
      >
        {/* Closing is the corner's ×, Escape, or a click outside: the page's
            own words end with the line under the support button. */}
        <button type="button" onClick={onClose} aria-label={t('about.close')}
                data-part="modal-close"
                className="absolute right-2 top-2 rounded p-1.5 text-[var(--color-ink-3)]
                           hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]">
          <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
            <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z" />
          </svg>
        </button>
        {/* The wordmark carries the name, so it is the heading, and `alt`
            is where the name lives for anything that cannot see it. Marked
            as words like the rest, so a theme cannot hide it. Intrinsic
            size, so the box is reserved before the image arrives. */}
        <h2 data-about-text id="about-title" className="leading-none">
          <img data-about-text src="/wordmark-512.png" alt={t('about.eeronaut')}
               srcSet="/wordmark-512.png 1x, /wordmark-1024.png 2x"
               width={512} height={178}
               className="mx-auto h-auto w-full max-w-[20rem]
                          drop-shadow-[0_3px_6px_rgba(0,0,0,0.22)]" />
        </h2>

        {/* An empty version means /api/health has not answered. Saying so is
            better than a heading with a blank space after it, and it is the
            same server this whole page depends on, so it is worth knowing. */}
        <p data-about-text className="mt-1 text-[13px] font-semibold tabular-nums text-[var(--color-ink-3)]">
          {version ? t('about.version_n', { n: version }) : t('about.version_unknown')}
        </p>
        <AppUpdateNotice className="mt-1" />

        <p data-about-text className="mt-4 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('about.what_it_is')}
        </p>

        {/* What it does, in a few lines. A list centered as a block with its
            items left-aligned, so the bullets line up. */}
        <ul data-about-text data-part="about-features"
            className="mx-auto mt-3 inline-block list-disc pl-5 text-left text-[13px]
                       leading-relaxed text-[var(--color-ink-2)]
                       marker:text-[var(--about-bullet,var(--color-accent))]">
          {[t('about.feature_themes'), t('about.feature_topology'),
            t('about.feature_radio'), t('about.feature_dns'),
            t('about.feature_more')].map((line) => <li key={line}>{line}</li>)}
        </ul>

        <p data-about-text className="mt-4 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('about.support_hint')}
        </p>
        <a
          href="https://ko-fi.com/bretteroo"
          target="_blank"
          rel="noreferrer"
          data-part="support-button"
          data-about-text
          /* A blue button with a light gradient and a faint highlight along
             its top edge, the same in every theme. Not the theme's accent:
             white on it fell to 2.6:1 in some dark modes, where themes
             lighten the accent. White on this blue is 4.8:1 at its lightest
             and deeper on hover. Its own part rather than `link-button`,
             which every theme draws as a quiet outlined button. On hover it
             lifts 2px and its shadow deepens, and a press sets it back down;
             the lift is skipped for anyone who asked for less motion. */
          className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-md
                     bg-[linear-gradient(to_bottom,#2b6de0,#1d4ed8)] px-3 py-2
                     text-[13px] font-medium text-white
                     shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_5px_rgba(0,0,0,0.22)]
                     hover:bg-[linear-gradient(to_bottom,#2563eb,#1a47c4)]
                     focus-visible:bg-[linear-gradient(to_bottom,#2563eb,#1a47c4)]
                     transition-[translate,box-shadow] duration-150 ease-out
                     motion-safe:hover:-translate-y-0.5
                     hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_4px_10px_rgba(29,78,216,0.35)]
                     motion-safe:active:translate-y-0
                     active:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_5px_rgba(0,0,0,0.22)]"
        >
          {/* The one link to support the project anywhere in the interface.
              Decorative: the words beside it already say what it is. */}
          <svg viewBox="0 0 24 24" className="size-3.5 shrink-0"
               fill="currentColor" aria-hidden="true">
            <path d="M12 21s-7.5-4.6-9.3-9A5 5 0 0 1 12 7a5 5 0 0 1 9.3 5c-1.8 4.4-9.3 9-9.3 9Z" />
          </svg>
          {t('about.support')}
        </a>

        {/* The part that matters legally and to anybody wondering whether this
            came from eero. It did not. */}
        <p data-about-text className="mt-4 whitespace-pre-line text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {t('about.not_affiliated')}
        </p>
        {/* Two lines, as the string has them, then a rule between eero's
            name and Eeronaut's own: its license and where its source is. */}
        <hr className="mt-4 border-0 border-t border-[var(--color-line)]" />

        {/* Free software, said plainly. AGPL-3.0-only asks that people who meet
            a program over a network be told what they are entitled to, and the
            first thing they are entitled to know is which license it is. */}
        <p data-about-text className="mt-4 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {/* The license's name kept on one line: it broke at its own hyphen,
              "AGPL-3.0-" on one line and "only" on the next. */}
          {t('about.license').split(/(AGPL-3\.0-only)/).map((part, i) =>
            part === 'AGPL-3.0-only'
              ? <span key={i} className="whitespace-nowrap">{part}</span>
              : part)}
        </p>

        {/* Where the source is, as section 13 of the license asks, and the
            licenses of what Eeronaut is built from, written at build time beside
            the app (vite.config.ts). */}
        <p data-about-text className="mt-3 text-[12px] text-[var(--color-ink-3)]">
          <a data-about-text href={SOURCE_URL} target="_blank" rel="noreferrer" className="link">
            {t('about.source')}
          </a>
          <span aria-hidden="true" className="mx-2">|</span>
          <a data-about-text href="/THIRD-PARTY-NOTICES.txt" target="_blank" rel="noreferrer"
             className="link">{t('about.third_party')}</a>
        </p>

      </div>
    </div>
  )
}
