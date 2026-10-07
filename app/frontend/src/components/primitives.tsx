import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo,
         useRef, useState, useSyncExternalStore,
         type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CableDataIcon } from './DeviceIcon'
import { useLocation } from 'react-router-dom'
import { currentLanguage, t } from '../i18n'
import { HardwareSash, PlusSash, useCapability } from '../lib/capabilities'
import { BARS, tone as signalTone } from '../lib/signal'
import { useTheme } from '../lib/theme'

/* ------------------------------------------------------------ the controls

   One height for everything you can type in or press in a form: 32px, set
   rather than inferred, because a border and a line box add up differently
   in a select, an input, and a button and the three came out 32, 38 and 34
   on the same row of the same card. One radius and one type size with it.

   `FIELD` is a select or a text input. `ACTION` is a button that is not the
   form's commit — Change password, Light, Check for updates. The commit
   itself is `SubmitButton`, which is the same shape filled in. `INLINE` is
   for a button that belongs inside a sentence or at the end of a row and
   should read as a word rather than as a box.
*/
export const FIELD =
  'h-8 rounded-md border border-[var(--color-line-strong)] '
  + 'bg-[var(--color-surface)] px-2 text-[13px]'

/** A field standing alone in a column rather than inline in a row of them.
 *  One width, so a stack of menus down a card has a straight edge instead of
 *  each one taking the width of whatever happens to be in it. */
export const FIELD_WIDE = `${FIELD} w-full sm:w-72`

export const ACTION =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border '
  + 'border-[var(--color-line-strong)] px-3 text-[13px] font-medium '
  + 'text-[var(--color-ink-2)] transition-colors '
  + 'hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)] '
  + 'disabled:opacity-50'

/* Text that acts as a link takes `--color-accent-ink`, which is what the
 * token contract calls it: the accent is "anything pressable" and its ink is
 * "its text". Several of these were painted in the accent itself, which is a
 * fill color — tuned to carry white words rather than to be read as words on
 * a card. In two of the four themes that measured 4.0:1 and under against
 * the surface behind it.
 */
export const INLINE =
  'text-[13px] font-medium text-[var(--color-accent-ink)] underline-offset-2 '
  + 'hover:underline disabled:opacity-40 disabled:hover:no-underline'

/* The help column of the card a control is in, when the theme has asked for
 * one; null otherwise, which is every theme that has not. */
const HelpColumn = createContext<HTMLElement | null>(null)

/**
 * A control's explanation, where the theme wants it.
 *
 * Under the control by default. With `layout.hints` set to `aside`, the card
 * draws a column down its side and each explanation is sent there instead,
 * with the name of the thing it explains in front of it — the arrangement of
 * a router's setup pages, where the help ran down the right of every screen.
 * Sent by portal rather than collected into state: the explanation stays the
 * child of the control that owns it, so it changes when that does, and
 * nothing has to be registered and unregistered as controls come and go.
 */
function HintSlot({ term, inline, children }: {
  term?: ReactNode
  /** How it is drawn when it stays with its control. */
  inline: ReactNode
  children: ReactNode
}) {
  const column = useContext(HelpColumn)
  if (!column) return <>{inline}</>
  return createPortal(
    <p data-part="help-entry">
      {term && <b data-part="help-term">{term}: </b>}
      {children}
    </p>,
    column)
}

/**
 * One label and one control, laid out the same way every time.
 *
 * The label is a column of its own and the control is the column beside it,
 * so a card of these reads down two straight edges with one gutter between
 * them. Settings had three shapes for the same pairing — label above the
 * control, label left with the value pushed to the far right, and control
 * left with the label after it — which is what "the controls don't feel
 * aligned" was.
 *
 * The control sits in a band as tall as a field, so a switch or a line of
 * text centers on the line a menu's own text sits on instead of floating at
 * the top of the row. Under `sm` the two stack: a 176px label column and a
 * menu do not both fit a phone.
 */
export function Field({
  label, hint, htmlFor, stack = false, children, className = '',
}: {
  label: ReactNode
  hint?: ReactNode
  /** When the label belongs to one select or input, by id. */
  htmlFor?: string
  /** For content that is a list or several lines rather than a control: it
   *  is placed in the column as it comes, without the field's own band. */
  stack?: boolean
  children: ReactNode
  className?: string
}) {
  const inner = stack
    ? children
    : <div className="flex min-h-8 flex-wrap items-center gap-2">{children}</div>
  return (
    <div data-part="field"
         className={`grid gap-x-4 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)] ${className}`}>
      {htmlFor
        ? <label htmlFor={htmlFor} data-part="field-label"
                 className="micro-label sm:leading-8">{label}</label>
        : <span data-part="field-label"
                className="micro-label sm:leading-8">{label}</span>}
      <div className="min-w-0">
        {inner}
        {hint && (
          <HintSlot term={label} inline={
            <p data-part="hint"
               className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              {hint}
            </p>}>
            {hint}
          </HintSlot>
        )}
      </div>
    </div>
  )
}

export type State = 'ok' | 'warn' | 'bad' | 'idle'

const DOT: Record<State, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  idle: 'var(--color-idle)',
}

export function StatusDot({ state, label, icon, title }: {
  state: State
  label?: string
  /** A sentence about the state, for hover: what "Connecting…" means here. */
  title?: string
  /* A shape instead of the dot. Paused is not a degree of health — it is a
     thing somebody chose to do — and a colored dot puts it on the same scale
     as offline and unreachable. The pause bars say "held", and say it without
     relying on color, which the dot cannot do at 8px in grayscale. */
  icon?: 'pause'
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${title ? 'cursor-help' : ''}`} title={title}>
      {icon === 'pause' ? (
        <svg viewBox="0 0 24 24" className="size-3 shrink-0"
             fill="var(--color-ink)" aria-hidden="true">
          <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
        </svg>
      ) : (
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ background: DOT[state] }}
          aria-hidden="true"
        />
      )}
      {label && <span>{label}</span>}
    </span>
  )
}

/**
 * The mark on a control that restarts the mesh.
 *
 * Changing some settings makes the eeros restart, and the network is gone for
 * a minute or two while they do. Nothing said so, which is how somebody
 * flipping a switch loses their connection with no warning and no idea which
 * of the things they touched did it.
 *
 * Identical whether the restart is certain or only suspected. Which of those
 * it is belongs in the confirmation, where there is room for a sentence — two
 * different glyphs would ask somebody to learn a code from a shape eight
 * pixels wide, and the useful signal at a glance is the same either way: this
 * one costs you the network.
 *
 * `title` rather than a tooltip component, matching every other hint in this
 * file, and the glyph is `aria-hidden` with the words in the title so it is not
 * announced twice.
 */
export function RebootMark({ className = '', title }: {
  className?: string
  /** What the interruption is. The mark itself only says "this interrupts
   *  things"; the default title is the restart case, and a control that costs
   *  less than a restart says so here rather than borrowing the word. */
  title?: string
}) {
  const label = title ?? t('reboot.required')
  return (
    <span
      title={label}
      data-part="reboot-mark"
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border
                  border-[var(--color-line-strong)] px-1.5 py-0.5 text-[11px]
                  font-medium text-[var(--color-ink-3)] ${className}`}
    >
      <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden="true">
        <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * A gray block standing in for content that has not arrived.
 *
 * Shaped like what replaces it, so the page does not jump when it does. The
 * pulse is the only motion — a shimmer sweeping across a dozen of these at
 * once is more distracting than the wait it covers.
 */
/** A bar standing in for a line of text.
 *
 *  Its height is in ems, so it is the size of the words it is holding space
 *  for: a theme that sets its prose at 18px gets a taller bar than one that
 *  sets it at 13, without either of them saying so. It was 12 pixels
 *  whatever it stood in, which is why a themed page jumped when the real
 *  content arrived. */
export function Skeleton({ w = '100%', h = '0.8em', className = '', rounded = 'rounded' }: {
  w?: number | string
  h?: number | string
  className?: string
  rounded?: string
}) {
  return (
    <span aria-hidden="true"
          className={`skeleton block ${rounded} ${className}`}
          style={{ width: w, height: h }} />
  )
}

/**
 * Placeholder rows for a table or list that is still loading.
 *
 * `aria-busy` on a live region rather than a visible "Loading…": a screen
 * reader gets told the region is busy, and nobody has to read a row of gray
 * bars aloud.
 */
export function SkeletonRows({ rows = 5, cols = 1, label = t('primitives.loading') }: {
  rows?: number
  cols?: number
  label?: string
}) {
  /* Uneven widths, because a stack of identical bars reads as a rendering
     fault rather than as text that has not loaded. Two sets: a label is a
     word or two and a value is longer or shorter depending on what it is, so
     a row of one wide bar and one stub of the same width every time was a
     shape nothing on any page actually has. */
  const labels = ['38%', '30%', '45%', '27%', '41%', '34%', '48%']
  const values = ['32%', '47%', '23%', '39%', '28%', '44%', '35%']
  return (
    /* Sized as the rows it stands in for are sized. A card's body can be set
       larger than its rows — Eerish sets its prose at 16 while a label and
       value row stays at 13 — so taking the body's own size made every
       placeholder row four pixels taller than the row that replaced it, and
       a six-row card grew as it filled. The bars and the line boxes around
       them are all in ems of this. */
    <div role="status" aria-busy="true" aria-label={label} className="grid text-[13px]">
      {Array.from({ length: rows }, (_, r) => (
        /* A row of the real thing: the same rule under it, the same padding
           around it, and a line box's worth of height whatever type the
           theme is set in. The rows were an even stack of bars with a gap
           between them, which is a rhythm no list on any page has — six of
           them came out 24px short of the six rows they were standing in
           for, so the card grew as it filled. */
        <div key={r}
             className="flex items-center justify-between gap-4 border-b
                        border-[var(--color-line)] py-2 last:border-0"
             style={{ minHeight: 'calc(1lh + 1rem + 1px)' }}>
          {cols === 1 ? (
            /* Prose, not a list of values: one bar taking most of the width,
               a long line and a short one as any paragraph has. */
            <Skeleton w={['86%', '94%', '72%', '90%', '67%'][r % 5]} />
          ) : cols === 2 ? (<>
            {/* Smaller than the value beside it: these labels are set in the
                interface's micro type, which is a couple of points down from
                what they label. */}
            <Skeleton w={labels[r % labels.length]} h="0.65em" className="shrink-0" />
            <Skeleton w={values[r % values.length]} className="shrink-0" />
          </>) : (
            /* A table. Every column gets a bar, the first one wider — the
               thing a row is about is nearly always named in it. */
            Array.from({ length: cols }, (_, c) => (
              <span key={c} className={c === 0 ? 'min-w-0 flex-[2]' : 'min-w-0 flex-1'}>
                <Skeleton w={c === 0 ? labels[r % labels.length]
                                     : values[(r + c) % values.length]} />
              </span>
            ))
          )}
        </div>
      ))}
    </div>
  )
}

/** A whole card's worth of placeholder, for a page that has nothing yet.
 *
 *  A real `Card`, not a copy of one. It used to hand-roll the section, the
 *  header and the title, at the sizes the interface's own look happens to
 *  use — so under a theme that draws cards with more padding and a larger
 *  heading, the placeholder was a different shape and a different type from
 *  the thing it was standing in for, and the page changed twice: once when
 *  the words arrived and once because the box around them moved. */
export function SkeletonCard({ title, rows = 4, icon }: {
  title?: ReactNode
  rows?: number
  /** The glyph the real card carries. Without it the title sat a glyph's
   *  width to the left of where it would be, and slid right when the card
   *  arrived. */
  icon?: CardIcon
}) {
  return (
    <Card title={title ?? <Skeleton w="9rem" />} placeholder={!title} icon={icon}
          glyphPlaceholder={!icon}>
      <SkeletonRows rows={rows} cols={2} />
    </Card>
  )
}

/**
 * A box whose height follows its content instead of snapping to it.
 *
 * Exported as well as used by `Card`, because a card animating its own height
 * is not enough on its own: a sub-panel inside it that swaps one form for
 * another still snaps, and the visible jump is the sub-panel's, not the
 * card's. Nesting these is fine — the inner one settles first and the outer
 * one follows it.
 *
 * Switching the LAN between automatic, manual, and bridge swaps three forms of
 * very different heights, and the card jumped by a couple of hundred pixels
 * each time, taking everything below it up or down the page. Applied to every
 * card rather than just that one: the same jump happens whenever a pane gains
 * or loses rows.
 *
 * Two details matter. The first measurement is adopted without animating —
 * the element is already that tall, so transitioning to it would be a
 * transition from nothing. And the overflow is only clipped while a change is
 * in flight: cards contain listboxes and pickers that open past their edges,
 * and clipping permanently would cut those off. The clip is lifted on a timer
 * rather than on `transitionend`, because a change that happens to be
 * zero-height fires no such event and the clip would never come off.
 */
export function AutoHeight({ children, className = '', part }: {
  children: ReactNode
  className?: string
  /** The `data-part` a theme addresses this element by, when it is one. */
  part?: string
}) {
  const inner = useRef<HTMLDivElement | null>(null)
  const [h, setH] = useState<number | null>(null)
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    const el = inner.current
    if (!el) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    /* One target per frame.

       Swapping the contents — the LAN card's three modes, say — measures twice
       in quick succession: once as the outgoing form leaves and again once the
       incoming one has laid out. Both were applied, so the transition started
       toward the first height and was retargeted part-way there. Measured
       frame by frame that came out as 150ms of almost no movement followed by a
       plunge: 481, 481, ... 480, 479, 477, ... 462, then 455, 442, 418, 388 —
       which is what "jerky" was. Coalescing to the last measurement in a frame
       gives the animation a single destination.

       The border box, not the content box: `contentRect` excludes padding, so
       the wrapper was sized 32px shorter than what it wraps, clipping it and
       leaving the height chasing a target it could never settle on. */
    let queued = 0
    let last: number | null = null
    const ro = new ResizeObserver(([e]) => {
      last = Math.round(
        e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight)
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        const next = last
        if (next === null) return
        // Sub-pixel settling — a select's own metrics, a font landing — is not
        // a resize worth animating, and each one restarted the transition.
        setH((prev) => (prev !== null && Math.abs(prev - next) < 2 ? prev : next))
      })
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (queued) cancelAnimationFrame(queued) }
  }, [])

  useEffect(() => {
    if (h === null) return
    setMoving(true)
    const t = setTimeout(() => setMoving(false), 360)
    return () => clearTimeout(t)
  }, [h])

  /* Content arriving where a placeholder was fades up instead of appearing
     between one frame and the next.

     The box was already gliding to its new height, so the only thing left
     that snapped was what was inside it: a card's worth of gray bars
     replaced by a card's worth of words, in a single frame, while the box
     around them was still moving. Running every render rather than on a
     dependency, because what it watches for is a change in the DOM below
     it — the placeholder's `aria-busy` going away — and nothing here holds
     that as state. */
  const wasBusy = useRef(false)
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const busy = !!el.querySelector('[aria-busy="true"]')
    if (wasBusy.current && !busy
        && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      // Set on the element rather than as a class: React owns this div's
      // className and would drop one added from outside on its next render.
      el.style.animation = 'content-arrive 240ms ease-out'
      const done = () => { el.style.animation = '' }
      el.addEventListener('animationend', done, { once: true })
    }
    wasBusy.current = busy
  })

  return (
    <div
      data-part={part}
      style={{
        height: h ?? undefined,
        /* Decelerating, not ease-in-out. The symmetric curve spent its first
           third barely moving, which on a pane that is about to change size
           reads as a hesitation — and paired with the retargeting above it was
           a stall followed by a snap. Starting at speed and easing into the
           new height reads as one movement. */
        transition: 'height 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        willChange: moving ? 'height' : undefined,
        overflow: moving ? 'hidden' : undefined,
      }}
    >
      <div ref={inner} className={className}>{children}</div>
    </div>
  )
}

/**
 * Whether this pane is the one the URL is pointing at.
 *
 * Scrolls it into view once and flashes it for a moment. The flash matters
 * more than the scroll: on a page of nine panes, arriving at the right scroll
 * position still leaves the reader hunting for which one they were sent to.
 */
function usePaneFocus(anchor?: string) {
  const [found, setFound] = useState(false)
  const { search } = useLocation()
  const want = new URLSearchParams(search).get('pane')
  useEffect(() => {
    if (!anchor || want !== anchor) { setFound(false); return }
    // After paint, so the pane has its real position: several of these grow
    // as their data lands.
    const t = window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({
        block: 'center', behavior: 'smooth' })
      setFound(true)
    }, 150)
    const off = window.setTimeout(() => setFound(false), 2400)
    return () => { clearTimeout(t); clearTimeout(off) }
  }, [anchor, want])
  return found
}

export interface CardSay {
  ok: (m: string) => void
  fail: (m: string) => void
  clear: () => void
}


/* A mark for a card's heading, drawn in the same weight as everything else on
   the card: one or two strokes, in the muted ink so the words stay first.
   Named by what the card is about rather than by what the shape is, so a card
   that changes appearance keeps its meaning.

   A card says which one it wants; a card that says nothing gets nothing,
   which is what the test cards do. */
export type CardIcon =
  | 'dashboard' | 'speed' | 'eero' | 'clients' | 'profile' | 'filter'
  | 'map' | 'radio' | 'airtime' | 'matter' | 'thread' | 'wifi' | 'guest'
  | 'dns' | 'lan' | 'internet' | 'power' | 'shield' | 'inbound' | 'domains'
  | 'chart' | 'history' | 'health' | 'settings' | 'display' | 'bell' | 'key'
  | 'backup' | 'usage' | 'local' | 'upload' | 'download' | 'clock'
  | 'reservation' | 'ports' | 'troubleshoot' | 'concentration'

/* Every mark is strokes on a 24 grid, drawn for Eeronaut. */
const CARD_ICON: Record<CardIcon, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>,
  speed: <><path d="M12 13l5-4" /><path d="M4 18a9 9 0 1116 0" /></>,
  eero: <rect x="3" y="7" width="18" height="10" rx="3" />,
  clients: <><rect x="2" y="4" width="14" height="10" rx="1.5" /><path d="M6 18h6" /><rect x="17" y="8" width="5" height="10" rx="1" /></>,
  profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0114 0" /></>,
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />,
  map: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5M7 17l4-5M17 17l-4-5" /></>,
  radio: <><circle cx="12" cy="12" r="2" /><path d="M7.5 7.5a6 6 0 000 9M16.5 7.5a6 6 0 010 9" /><path d="M4.5 4.5a10 10 0 000 15M19.5 4.5a10 10 0 010 15" /></>,
  airtime: <><path d="M3 20h18" /><path d="M6 20v-6M11 20V8M16 20v-9M21 20V5" /></>,
  matter: <><path d="M12 3l7 4v10l-7 4-7-4V7z" /><path d="M12 12l7-4M12 12v9M12 12L5 8" /></>,
  /* Thread: a ring with a T whose bar loops over into its own stem, which
     runs down to the ring's edge. Drawn for Eeronaut in the same strokes as
     the rest; it nods to the Thread Group's logo without being it, since
     the logo is theirs and is not ours to ship. */
  thread: <><circle cx="12" cy="12" r="9" /><path d="M7.5 10h6.5a2.5 2.5 0 1 0 -2.5 -2.5V21" /></>,
  wifi: <><path d="M4 9a13 13 0 0116 0" /><path d="M7.5 12.5a8 8 0 019 0" /><path d="M11 16.5a3 3 0 012 0" /><circle cx="12" cy="19" r="0.6" fill="currentColor" /></>,
  guest: <><circle cx="9" cy="8" r="3" /><path d="M3 19a6 6 0 0112 0" /><path d="M17 8h5M19.5 5.5v5" /></>,
  dns: <><path d="M12 3v18" /><path d="M5 6h11l3 2.5-3 2.5H5z" /><path d="M19 13H8l-3 2.5 3 2.5h11z" /></>,
  lan: <><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M12 4v9M7 8l5-4 5 4" /></>,
  internet: <><circle cx="12" cy="12" r="9" /><path d="M3.5 9h17M3.5 15h17M12 3c-3 4-3 14 0 18M12 3c3 4 3 14 0 18" /></>,
  /* A leaf, not a power symbol: the card is about using less, and eero's own
     name for it is power saving. */
  power: <><path d="M4 20c0-8 5-13 16-14 1 10-4 15-12 15H4z" /><path d="M9 16c2.5-3 5-4.5 8-5.5" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  inbound: <><path d="M3 12h12" /><path d="M11 8l4 4-4 4" /><rect x="17" y="4" width="4" height="16" rx="1.5" /></>,
  domains: <><path d="M4 6h16M4 12h10M4 18h13" /><circle cx="19" cy="12" r="1.6" /></>,
  chart: <><path d="M3 20h18" /><path d="M6 16l4-5 4 3 5-7" /></>,
  history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  health: <><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></>,
  display: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  bell: <><path d="M6 16V10a6 6 0 1112 0v6l2 3H4z" /><path d="M10 21h4" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v4M20 12v3" /></>,
  backup: <><path d="M12 3v10" /><path d="M8 9l4 4 4-4" /><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></>,
  usage: <><path d="M12 3a9 9 0 109 9h-9z" /><path d="M14 3.5A9 9 0 0120.5 10H14z" /></>,
  local: <><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M9 20h6M12 16v4" /><circle cx="12" cy="10.5" r="2" /></>,
  upload: <><path d="M12 20V6" /><path d="M6 12l6-6 6 6" /></>,
  download: <><path d="M12 4v14" /><path d="M6 12l6 6 6-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>,
  reservation: <><path d="M5 4h14v16l-7-4-7 4z" /></>,
  ports: <><rect x="3" y="8" width="18" height="8" rx="1.5" /><path d="M7 8V6M12 8V6M17 8V6M7 16v2M12 16v2M17 16v2" /></>,
  troubleshoot: <><path d="M9.5 14.5L4 20l1 1 5.5-5.5" /><path d="M14 3a5 5 0 00-4.6 7l-1 1 3.6 3.6 1-1A5 5 0 1014 3z" /></>,
  concentration: <><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /></>,
}

export function CardGlyph({ name }: { name: CardIcon }) {
  return (
    <svg viewBox="0 0 24 24"
         className="size-4 shrink-0 text-[var(--color-ink-3)]"
         fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
         aria-hidden="true">
      {CARD_ICON[name]}
    </svg>
  )
}

/**
 * A pane.
 *
 * Carries its own notice slot at the top of its body. A single notice for a
 * whole page reported a power-saving save at the top of the Network tab, eight
 * panes above the switch that had just been flipped, where nobody looking at
 * the switch would ever see it. Where a result belongs is next to the control
 * that produced it.
 *
 * Panes that write take `children` as a function and are handed their own
 * notice, so a pane does not have to become its own component to get one.
 */
export function Card({
  title, action, children, className = '', anchor, icon, plus, hardware, count,
  placeholder = false, glyphPlaceholder = false,
}: {
  title?: ReactNode
  /** The title is a stand-in for one not known yet, a gray bar. Drawn in
   *  the title's place and shape but not as a heading: a heading with no
   *  words in it is announced as an empty heading, and is what a page's
   *  headings were read as while its code was still arriving. */
  placeholder?: boolean
  /** A gray square where the glyph goes, for a stand-in that does not know
   *  which card it is standing in for: the title then starts where a real
   *  one would. */
  glyphPlaceholder?: boolean
  /** How many things the card is about, once that is known. It goes in a chip
   *  beside the title rather than into the title itself: a heading that reads
   *  "Clients" and then rewrites to "Clients (12)" a second later is the page
   *  reflowing under somebody who has started reading it. The chip holds its
   *  space from the first paint and fills in. `null` while loading. */
  count?: number | null
  /** A mark to the left of the title, saying what the card is about before
   *  the words do. Omitted where a card has nothing to say with one. */
  icon?: CardIcon
  /** The capability, or capabilities, that make this pane an eero Plus
   *  feature. Draws the sash in the card's own corner — the one place in a
   *  header that the card's own controls can never want. */
  plus?: string | string[]
  /** The capability whose absence is the hardware's doing rather than a
   *  subscription's. Draws the gray sash in the same corner. The two are
   *  deliberately different marks: one is something you could go and buy for
   *  the eeros you own, and the other is not. */
  hardware?: string
  /** A stable name for this pane, so search can land on it. When the URL
   *  carries `?pane=<anchor>` the card scrolls itself into view and flashes,
   *  which is the difference between "it is on the Network tab" and "it is
   *  this one". Stable across renames: the title can change, this should not. */
  anchor?: string
  /** A function here gets the pane's notice, for an action button that writes:
   *  the header sits outside `children`, so a button up there could not reach
   *  the notice its result belongs in. */
  action?: ReactNode | ((say: CardSay) => ReactNode)
  children: ReactNode | ((say: CardSay) => ReactNode)
  className?: string
}) {
  const say = useNotice()
  const found = usePaneFocus(anchor)
  const Title = placeholder ? 'div' : 'h2'
  const aside = useTheme().layout.hints === 'aside'
  /* The column's element, once it exists: the controls inside the body need
     it to send their explanations to, and it is not there until the card has
     rendered once. A callback ref into state gives them one more render with
     it in hand, and only on a theme that asked for the column. */
  const [column, setColumn] = useState<HTMLElement | null>(null)
  /* A card whose whole reason for existing is one capability goes when that
     capability is hidden. `Gate` already removes the contents, which left a
     titled card with nothing in it — worse than either showing it or not. */
  const gone = useCapability(hardware ?? '').hidden && Boolean(hardware)
  if (gone) return null
  const body = (
    <AutoHeight className="p-4" part="card-body">
      {say.node && <div className="mb-3">{say.node}</div>}
      {typeof children === 'function' ? children(say) : children}
    </AutoHeight>
  )
  return (
    <section
      id={anchor}
      data-pane={anchor}
      data-part="card"
      /* How a theme's page plan addresses this card: the same name search
         uses. A card with no anchor cannot be moved or hidden by a theme,
         which is a reason to give one to every card that is a pane. */
      data-slot={anchor}
      /* Positioned only when something is going in the corner. `relative` on
         every card would make each one the containing block for whatever its
         contents position absolutely, which is a change to menus and popovers
         that have nothing to do with this. */
      className={`card ${plus || hardware ? 'relative' : ''} ${className} ${found ? 'pane-found' : ''}`}
    >
      {plus && <PlusSash name={plus} />}
      {hardware && <HardwareSash name={hardware} />}
      {(title || action) && (
        /* Extra room on the right when the sash is there: it lies over the
           corner, and a header's own controls sit exactly under it — the
           period picker on Security activity and the time spans on Radio
           analytics both ended up beneath one. */
        <header data-part="card-header"
                className={`flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3 ${
          plus || hardware ? 'pr-11' : ''}`}>
          <Title data-part="card-title"
              className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-[var(--color-ink)]">
            {icon ? <CardGlyph name={icon} />
              : glyphPlaceholder && <Skeleton w="1rem" h="1rem" className="shrink-0" />}
            <span className="min-w-0 truncate">{title}</span>
            {count !== undefined && (
              <span data-count aria-hidden={count === null}
                    className={`shrink-0 rounded bg-[var(--color-surface-2)] px-1.5
                                text-[12px] font-normal tabular-nums
                                text-[var(--color-ink-2)] transition-opacity duration-200
                                ${count === null ? 'opacity-0' : 'opacity-100'}`}>
                {count ?? '\u00a0\u00a0'}
              </span>
            )}
          </Title>
          {typeof action === 'function' ? action(say) : action}
        </header>
      )}
      {aside ? (
        /* The body and the help column side by side, the column taking
           whatever explanations the controls in the body send it. It is
           there on every card whether or not anything is sent, as it was on
           every one of those setup pages: a column that came and went from
           card to card would be the layout shifting under the reader. */
        <div data-part="card-columns"
             className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_var(--help-w,minmax(12rem,28%))]">
          <HelpColumn.Provider value={column}>{body}</HelpColumn.Provider>
          <aside ref={setColumn} data-part="card-help" className="p-4" />
        </div>
      ) : body}
    </section>
  )
}

/**
 * Whether something too wide for its column should take its narrower shape,
 * for a theme whose layout asks for that (`overflow: 'fold'`); always false
 * otherwise, and the thing scrolls sideways as it always has.
 *
 * `wide` is the element holding the wide shape, which must be the one that
 * would scroll: it is too wide when its content is wider than it. How wide
 * that was is kept, since the wide shape is not drawn while folded, and it
 * comes back once `narrow` (or `wide` again, when the narrow shape is drawn
 * inside the same element) is at least that wide. Nothing is decided where
 * the element is not drawn at all, as a table is not on a phone.
 */
export function useFold(wide: RefObject<HTMLElement | null>,
                        narrow?: RefObject<HTMLElement | null>,
                        content?: unknown): boolean {
  const foldable = useTheme().layout.overflow === 'fold'
  const [need, setNeed] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!foldable) return
    const el = need === null ? wide.current : (narrow ?? wide).current
    if (!el) return
    const check = () => {
      if (!el.clientWidth) return
      if (need === null) {
        if (el.scrollWidth > el.clientWidth + 1) setNeed(el.scrollWidth)
      } else if (el.clientWidth >= need) setNeed(null)
    }
    check()
    const watch = new ResizeObserver(check)
    watch.observe(el)
    return () => watch.disconnect()
  }, [foldable, need, wide, narrow, content])
  return foldable && need !== null
}

/**
 * A page: a grid of panes.
 *
 * The grid is what a theme's page plan works on. Every direct child carries
 * `data-slot` — a Card through its anchor, anything else through `Slot` —
 * and the plan reorders, hides, or resizes them with `order`, `display` and
 * `grid-column` on those children and nothing else; see `layoutCss`. That is
 * why a pane has to be a direct child: a card nested in a wrapper of its own
 * is out of the plan's reach.
 *
 * `columns` is the page's own wide-screen layout. On a two-column page a
 * pane is half a row unless it says `wide:col-span-2`, and a plan's `wide` and
 * `narrow` are how a theme changes its mind about either.
 */
export function Page({ name, columns = 1, className = '', children }: {
  /** The route name a theme's plan keys on: dashboard, network, settings... */
  name: string
  columns?: 1 | 2
  className?: string
  children: ReactNode
}) {
  /* Before the paint, not after: the stylesheet has to see both names in
     the same frame the new page arrives in, or it cross-fades from the
     picture two pages back for one frame. */
  useLayoutEffect(() => { leaving(name) }, [name])
  return (
    <div data-part="page" data-page={name}
         className={`grid gap-4 ${columns === 2 ? 'wide:grid-cols-2' : ''} ${className}`}>
      {children}
    </div>
  )
}

/* Which page you were on before this one, on <html> as `data-page-prev`.
 *
 * A stylesheet can see the page it is drawing, since the page names itself,
 * but not the one before it — and anything that hands over from one page's
 * look to the next needs both at once. Eerish's photographs cross-fade on
 * this: the outgoing one is painted under the incoming one, which cannot be
 * done from the route alone. Absent until the second page, so a theme can
 * tell a first paint from a move and not animate the arrival. */
let was: string | null = null
function leaving(now: string) {
  if (now === was) return
  const root = document.documentElement
  if (was === null) delete root.dataset.pagePrev
  else root.dataset.pagePrev = was
  was = now
}

/**
 * A pane that is not itself a Card, named so a theme's page plan can reach
 * it: a component that draws its own card, a notice, a strip of tiles.
 */
export function Slot({ id, wide = false, children }: {
  id: string
  /** The whole row on a two-column page. */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div data-slot={id} className={`grid min-w-0 ${wide ? 'wide:col-span-2' : ''}`}>
      {children}
    </div>
  )
}

/**
 * Count a figure up to its new value rather than snapping to it.
 *
 * Only for a number that replaced another number — the first value a tile
 * shows arrives with the page and counting up from zero would be inventing a
 * history it does not have. Skipped under prefers-reduced-motion, and skipped
 * for anything that is not a finite number, which is most of what Stat is
 * given.
 */
function useCountUp(target: number | null, ms = 420) {
  const [shown, setShown] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (target === null) { setShown(null); return }
    const start = from.current
    from.current = target
    if (start === null || start === target
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(target)
      return
    }
    let raf = 0
    let t0 = 0
    const tick = (t: number) => {
      if (!t0) t0 = t
      // Same easing curve the charts grow on, so a tile and the chart under
      // it settle together.
      const p = Math.min((t - t0) / ms, 1)
      const e = 1 - (1 - p) ** 3
      setShown(start + (target - start) * e)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return shown
}

/**
 * A figure that counts to its new value when it changes.
 *
 * For a number that a control can change under the reader — a period switch,
 * a filter — where a snap looks like a glitch and the eye misses that anything
 * moved at all.
 */
export function CountUp({ value, format = (v) => Math.round(v).toLocaleString(currentLanguage()) }: {
  value: number | null
  format?: (v: number) => string
}) {
  const shown = useCountUp(Number.isFinite(value as number) ? value : null)
  return <>{shown === null ? '—' : format(shown)}</>
}

export function Stat({
  label, value, sub, state,
}: { label: ReactNode; value: ReactNode; sub?: ReactNode; state?: State }) {
  /* Counting applies only when the tile was handed a bare number. Anything
     else — an element, a formatted string, a dash — is rendered as given. */
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null
  const counted = useCountUp(numeric)
  const shown = numeric !== null && counted !== null
    ? Math.round(counted).toLocaleString(currentLanguage())
    : value
  return (
    <div data-part="stat" className="card px-4 py-3">
      <div className="micro-label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-[var(--color-ink)]">
          {shown}
        </span>
        {state && <StatusDot state={state} />}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-[var(--color-ink-3)]">{sub}</div>}
    </div>
  )
}

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  /** Columns marked secondary collapse away first on narrow viewports. */
  secondary?: boolean
  numeric?: boolean
  /** Horizontal alignment for the header and its cells together, so the
   *  heading always sits over what it labels. `numeric` implies right. */
  align?: 'left' | 'center' | 'right'
  /** Set on cells holding their own controls, so a click there does not also
   *  trigger the row's own click handler. */
  stopsRowClick?: boolean
  /** Comparable value for sorting. Omit to leave the column unsortable.
   *  Return null for "no value" - those always sort last, in both directions,
   *  because a missing reading is not smaller than a real one. */
  sortValue?: (row: T) => string | number | null
}

/**
 * Dense table on wide viewports; stacked cards below the breakpoint, so a
 * phone never has to scroll a table sideways.
 */
/**
 * Sort direction as filled triangles.
 *
 * Glyphs first, and they were too small to read: an arrow at 11px in the
 * header's own type is a few pixels of hairline, and its weight changes with
 * whatever font the browser resolves. A path is the same shape and the same
 * weight everywhere, and can be sized independently of the label beside it.
 *
 * Sorted shows one triangle pointing the way the column runs. Unsorted shows
 * both, faintly — that is what says the column can be sorted at all, and
 * dropping it would make a sortable header indistinguishable from a plain one.
 */
function SortMark({ dir }: { dir: 'asc' | 'desc' | null }) {
  return (
    <svg viewBox="0 0 8 11" aria-hidden="true" fill="currentColor"
         className="h-[11px] w-2 shrink-0">
      {dir !== 'desc' && (
        <path d="M4 0.5 7.6 4.6H0.4z" opacity={dir === 'asc' ? 1 : 0.5} />
      )}
      {dir !== 'asc' && (
        <path d="M4 10.5 0.4 6.4h7.2z" opacity={dir === 'desc' ? 1 : 0.5} />
      )}
    </svg>
  )
}

/** The easing everything in the app grows on.
 *
 *  The same curve as `GROW_EASE` in charts, written out here rather than
 *  imported from it: charts is a chunk of its own and this is a string.
 */
export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'

/* A row that opens under another row, and slides both ways.
 *
 * Appearing and vanishing outright is the same jump the table was trying to
 * avoid: the rows below jump down by the height of a form and back up again.
 * Rows from 0fr to 1fr animates a height without measuring one, and the two
 * frames before the first flip are what give the browser a starting height
 * to animate from — set both in the same frame and there is nothing to
 * transition between.
 *
 * `inert` whenever it is not fully open, so a form on its way out is not a
 * tab stop and a half-open one cannot be submitted.
 */
function ExpandedRow({ open, cols, children }: {
  open: boolean
  cols: number
  children: ReactNode
}) {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    if (!open) { setGrown(false); return }
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setGrown(true))
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [open])

  const body = (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-300"
      style={{ gridTemplateRows: grown ? '1fr' : '0fr',
               opacity: grown ? 1 : 0,
               transitionTimingFunction: EASE_OUT }}
      inert={grown ? undefined : true}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )

  if (!cols) return body
  return (
    <tr className={grown ? 'border-b border-[var(--color-line)] last:border-0' : ''}>
      <td colSpan={cols} className="px-3 align-top">{body}</td>
    </tr>
  )
}

export function DataTable<T>({
  columns, rows, rowKey, empty, onRowClick,
  mobileRow,
  rowMark,
  expand,
  defaultSort,
  loading = false,
  highlight, onRowHover,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  empty?: string
  onRowClick?: (row: T) => void
  /** Narrow-screen presentation for one row, on a single line. Without it the
   *  row is stacked as a card listing every column, which is right for a
   *  handful of rows and unreadable for a long list. */
  mobileRow?: (row: T) => ReactNode
  /** A mark for the whole row rather than for any one column — the eero Plus
   *  sash on an accessory, say. Drawn in the row's top-right corner: the last
   *  cell on the wide table, the card's own corner on a phone. Inline in the
   *  first column it competed with that column's own content for the same
   *  line. */
  rowMark?: (row: T) => ReactNode
  /** Something to open underneath one row, across the full width — a form
   *  for editing what that row shows. Return null for the rows that are not
   *  open. A form in a cell has one column's worth of room, which is how you
   *  get a four-field form rendered as a column of slivers; given the row
   *  below it, it can be laid out the same way the card's own add form is. */
  expand?: (row: T) => ReactNode
  /** Column key to sort by initially. */
  defaultSort?: { key: string; dir?: 'asc' | 'desc' }
  /** The rows have not arrived yet. An empty list then means "not yet", not
   *  "none", and saying "No clients match that filter" to somebody whose
   *  clients are still loading is the table answering a question it has not
   *  heard. Draws the skeleton instead. */
  loading?: boolean
  /** Which row is the one being pointed at somewhere else — a shape in the
   *  chart above, say. Drawn in the same wash the pointer draws, so the
   *  two readings of one thing look like one thing. */
  highlight?: (row: T) => boolean
  /** The row under the pointer, for the other half of that link. Null on the
   *  way out. */
  onRowHover?: (row: T | null) => void
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(
    defaultSort ? { key: defaultSort.key, dir: defaultSort.dir ?? 'asc' } : null)

  /* What was in the row that just closed. Without it there is nothing left
     to slide away — the caller stops returning content the moment Save or
     Cancel is pressed, and a row that is already gone cannot animate.
     Dropped once the animation has had time to finish, so at most one stale
     form is ever mounted, inert and at zero height. */
  const [closing, setClosing] = useState<{ key: string; node: ReactNode } | null>(null)
  const [prevOpen, setPrevOpen] = useState<string | null>(null)
  const liveNode = useRef<ReactNode>(null)

  /* Which row the caller says is open, and holding on to the last one so it
     has something to slide away.

     Worked out during the render rather than in an effect. An effect runs
     after the commit, so the row was already gone from the page by the time
     it could be held — measured: the height went 76, absent, 0, with the
     animation running against nothing. Adjusting state during a render is
     React's own answer to "something changed since last time"; it
     re-renders before painting, so the row never leaves. */
  const openNow = expand
    ? rows.map((r) => [rowKey(r), expand(r)] as const).find(([, n]) => n) ?? null
    : null
  const openKey = openNow?.[0] ?? null
  // A cache, not state: it is rebuilt from the caller on every render, and
  // is only ever read on the one render where the row has just closed. The
  // lint rule against touching a ref in a render guards against a stale
  // read; this one is written on every render it could be read on, so it is
  // always the previous render's content, which is exactly what is wanted.
  // eslint-disable-next-line react/refs
  if (openNow) liveNode.current = openNow[1]
  if (openKey !== prevOpen) {
    setPrevOpen(openKey)
    // eslint-disable-next-line react/refs
    const held = liveNode.current
    setClosing(openKey === null && prevOpen !== null
      ? { key: prevOpen, node: held } : null)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(null), 400)
    return () => clearTimeout(timer)
  }, [closing])

  const openFor = (key: string): { node: ReactNode; open: boolean } | null => {
    // Live while open, so the form goes on responding to what is typed into
    // it; the frozen copy is only for the way out.
    if (openNow?.[0] === key) return { node: openNow[1], open: true }
    if (closing?.key === key) return { node: closing.node, open: false }
    return null
  }

  const view = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a)
      const bv = col.sortValue!(b)
      // Missing values sink to the bottom whichever way the column is sorted.
      if (av === null && bv === null) return 0
      if (av === null) return 1
      if (bv === null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv), undefined,
                                      { numeric: true, sensitivity: 'base' }) * dir
    })
  }, [rows, columns, sort])

  function toggle(key: string) {
    // ascending -> descending -> back to the data's natural order
    setSort((s) => s?.key === key
      ? (s.dir === 'asc' ? { key, dir: 'desc' } : null)
      : { key, dir: 'asc' })
  }

  /* Folded into a list because it did not fit its column, for a theme that
     asks for that rather than a table that scrolls sideways. */
  const wide = useRef<HTMLDivElement>(null)
  const narrow = useRef<HTMLUListElement>(null)
  const folded = useFold(wide, narrow, rows)

  /* A list of the rows rather than a table: each row on one line when the
     caller has a way to draw it on one (`line`), and otherwise a block per
     row listing every column. */
  const stack = (line: ((row: T) => ReactNode) | undefined, cls: string,
                 ref?: RefObject<HTMLUListElement | null>, compact = false) => (
      <ul ref={ref} className={`${cls} ${line ? '' : 'space-y-2'}`}>
        {view.map((r) => {
        /* The padding belongs to the row with the mark on it, not to every
           row in the table: reserving it on all of them pulled every value in
           the list forty pixels off the right edge it is aligned to. */
        const mark = rowMark?.(r)
        /* A folded row holds controls of its own, and a button holding
           buttons is announced as one control with the rest lost inside it.
           So there the row's heading is the button, and the rest of the row
           still answers a pointer. */
        const whole = onRowClick && !compact
        return (
          <li
            key={rowKey(r)}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            onMouseEnter={onRowHover ? () => onRowHover(r) : undefined}
            onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
            onKeyDown={whole ? (e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onRowClick(r)
              }
            } : undefined}
            role={whole ? 'button' : undefined}
            tabIndex={whole ? 0 : undefined}
            className={`${mark ? 'relative' : ''} ${line
              ? 'flex items-center gap-3 border-b border-[var(--color-line)] px-1 py-2 last:border-0'
              : `card flex flex-col p-3 ${mark ? 'pr-10' : ''}`} ${onRowClick
              ? 'cursor-pointer active:bg-[var(--color-surface-2)] '
                + 'focus-visible:outline focus-visible:outline-2 '
                + 'focus-visible:outline-[var(--color-accent)]'
              : ''} ${highlight?.(r) ? 'bg-[var(--color-accent-wash)]' : ''}`}
          >
            {mark}
            {/* A folded table on a wide screen: the first column as the row's
                heading and the rest beside each other under it, name and
                value, wrapping as they need to. One line per column was a
                hundred clients at nine lines each. */}
            {compact && !line ? (<>
              {onRowClick ? (
                <button type="button" data-part="table-fold-head"
                        onClick={(e) => { e.stopPropagation(); onRowClick(r) }}
                        className="self-start text-left text-[13px] font-medium">
                  {columns[0]?.render(r)}
                </button>
              ) : (
                <div className="text-[13px] font-medium">{columns[0]?.render(r)}</div>
              )}
              <div data-part="table-fold" className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1">
                {columns.slice(1).map((c) => (
                  <span key={c.key}
                        onClick={c.stopsRowClick ? (e) => e.stopPropagation() : undefined}
                        className="inline-flex items-center gap-1.5 text-[13px]">
                    <span className="micro-label">{c.header}</span>
                    {c.render(r)}
                  </span>
                ))}
              </div>
            </>) : line ? line(r) : columns.map((c) => (
              <div
                key={c.key}
                onClick={c.stopsRowClick ? (e) => e.stopPropagation() : undefined}
                className="flex items-center justify-between gap-3 py-0.5 text-[13px]"
              >
                <span className="micro-label shrink-0">{c.header}</span>
                <span className="min-w-0 text-right">{c.render(r)}</span>
              </div>
            ))}
            {/* Inside the card here rather than in a row of its own: on a
                phone each row already is a block, so what opens belongs to
                it. */}
            {(() => {
              const open = openFor(rowKey(r))
              return open && (
                <ExpandedRow open={open.open} cols={0}>{open.node}</ExpandedRow>
              )
            })()}
          </li>
        )})}
        {!view.length && (
          <li className="py-6 text-center text-[13px] text-[var(--color-ink-3)]">
            {empty ?? t('primitives.nothing_to_show')}
          </li>
        )}
      </ul>
  )

  if (!rows.length) {
    return loading
      ? <SkeletonRows rows={4} cols={Math.min(columns.length, 4)} />
      : (
        <p className="py-8 text-center text-[13px] text-[var(--color-ink-3)]">
          {empty ?? t('primitives.nothing_to_show')}
        </p>
      )
  }
  /* One density. This was a setting, and the tighter of the two was what
     everybody wanted: the looser one only ever meant fewer rows on screen. */
  const pad = 'py-1.5'
  return (
    <>
      <div ref={wide} data-part="table"
           className={`table-scroll ${folded ? 'hidden' : 'hidden md:block'}`}>
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--color-line)]">
              {columns.map((c) => {
                const active = sort?.key === c.key
                const align = c.align === 'center' ? 'text-center'
                  : c.align === 'right' || c.numeric ? 'text-right' : ''
                if (!c.sortValue) {
                  return (
                    <th key={c.key} scope="col"
                        className={`micro-label px-3 pb-2 font-semibold ${align}`}>
                      {c.header}
                    </th>
                  )
                }
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`micro-label px-3 pb-2 font-semibold ${align}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.key)}
                      title={active
                        ? t(sort!.dir === 'asc' ? 'primitives.sorted_by_ascending'
                                                : 'primitives.sorted_by_descending',
                            { column: String(c.header) })
                        : t('primitives.sort_by', { column: String(c.header) })}
                      /* `group` so the arrow can respond to the header being
                         hovered rather than only to itself: the arrow is a few
                         pixels wide and the pointer is rarely on it. */
                      data-active={active ? '1' : '0'}
                      className={`micro-label sortable group inline-flex items-center
                                  gap-1 rounded transition-colors
                                  ${c.numeric ? 'flex-row-reverse' : ''}`}
                    >
                      {c.header}
                      <span aria-hidden="true"
                            className={`flex transition-colors ${active
                              ? 'text-[var(--color-accent)]'
                              : 'text-[var(--color-line-strong)] group-hover:text-[var(--color-ink-3)]'}`}>
                        <SortMark dir={active ? sort!.dir : null} />
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => {
            const open = openFor(rowKey(r))
            return (
            <Fragment key={rowKey(r)}>
              <tr
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onMouseEnter={onRowHover ? () => onRowHover(r) : undefined}
                onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
                className={`border-b border-[var(--color-line)] row-hover ${
                  open ? '' : 'last:border-0'} ${
                  onRowClick ? 'cursor-pointer' : ''} ${
                  highlight?.(r) ? 'bg-[var(--color-accent-wash)]' : ''}`}
              >
                {columns.map((c, i) => {
                  /* A `tr` is a poor host for an absolutely positioned child,
                     so the corner is the last cell's — which is the row's own
                     right edge, the cell running to the table's border. */
                  const last = i === columns.length - 1
                  return (
                  <td
                    key={c.key}
                    onClick={c.stopsRowClick ? (e) => e.stopPropagation() : undefined}
                    className={`px-3 ${pad} align-middle text-[13px] ${
                      last && rowMark ? 'relative' : ''} ${
                      c.align === 'center' ? 'text-center'
                      : c.align === 'right' ? 'text-right'
                      : c.numeric ? 'text-right tabular-nums' : ''}`}
                  >
                    {c.render(r)}
                    {last && rowMark?.(r)}
                  </td>
                )})}
              </tr>
              {open && (
                <ExpandedRow open={open.open} cols={columns.length}>
                  <div className="pb-3">{open.node}</div>
                </ExpandedRow>
              )}
            </Fragment>
          )})}
          </tbody>
        </table>
      </div>

      {/* The narrow-screen view is a separate rendering of the same rows, so
          it has to carry the row interaction too. Without this, tapping a row
          on a phone did nothing at all and anything reachable only from the
          detail panel — changing a client's type, editing its address — was
          simply unavailable on mobile. */}
      {folded && (<>
        {/* Sorting, which the column headings did, as a row of its own. */}
        <div data-part="table-sort" className="mb-2 hidden flex-wrap items-center gap-1.5 md:flex">
          {columns.filter((c) => c.sortValue).map((c) => {
            const active = sort?.key === c.key
            return (
              <button key={c.key} type="button" onClick={() => toggle(c.key)}
                      aria-pressed={active}
                      title={active
                        ? t(sort!.dir === 'asc' ? 'primitives.sorted_by_ascending'
                                                : 'primitives.sorted_by_descending',
                            { column: String(c.header) })
                        : t('primitives.sort_by', { column: String(c.header) })}
                      className="micro-label inline-flex items-center gap-1 rounded border
                                 border-[var(--color-line)] px-2 py-1">
                {c.header}
                <SortMark dir={active ? sort!.dir : null} />
              </button>
            )
          })}
        </div>
        {stack(undefined, 'hidden md:block', narrow, true)}
      </>)}
      {stack(mobileRow, 'md:hidden')}
    </>
  )
}

export function Toggle({
  checked, onChange, label, srLabel, disabled, hint, confirm,
}: {
  checked: boolean
  /** May return a promise. When it does, a rejection reverts the switch —
   *  which is the only way an optimistic control can stay honest. */
  onChange: (v: boolean) => void | Promise<unknown>
  /** Shown beside the switch. Omit where the name is already on the row.
   *  A node rather than a string, so a label can carry a badge beside it. */
  label?: ReactNode
  /** The name for assistive technology when no visible label is wanted — a
   *  switch with neither reads as an unlabelled control. */
  srLabel?: string
  disabled?: boolean
  /** A node, not a string: a hint that names somewhere else in the app
   *  should be able to link to it rather than describe the route. */
  hint?: ReactNode
  /** Asked before the switch moves. Returning false calls the whole thing off.
   *
   *  Before the flip rather than after, because this switch is optimistic: a
   *  caller that asks in its own `onChange` and then declines has already let
   *  the switch move, and nothing puts it back until the prop catches up or
   *  the eight-second timeout fires. Somebody who answered "no" would watch
   *  the control sit there claiming they said yes. */
  confirm?: () => boolean
}) {
  /* The switch moves on click, before the write lands.
     Every one of these is a round trip to eero's cloud, so waiting for the
     answer meant a visible pause on every flip and no sign the click had
     registered. The optimistic position is held until the prop catches up,
     dropped if the write is rejected, and abandoned after a timeout so a
     request that never resolves cannot leave the switch lying about the
     network's state indefinitely. */
  const [guess, setGuess] = useState<boolean | null>(null)
  const shown = guess ?? checked

  useEffect(() => { setGuess(null) }, [checked])
  useEffect(() => {
    if (guess === null) return
    const t = setTimeout(() => setGuess(null), 8000)
    return () => clearTimeout(t)
  }, [guess])

  function flip() {
    const next = !shown
    if (confirm && !confirm()) return
    setGuess(next)
    try {
      const r = onChange(next)
      // A caller that reports failure gets the switch put back immediately;
      // one that returns nothing falls back to the prop and the timeout.
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        void (r as Promise<unknown>).catch(() => setGuess(null))
      }
    } catch {
      setGuess(null)
    }
  }

  return (
    /* The switch dims; its name and its hint do not. Dimming the whole label
       took the hint down with it, and the hint is where a held-on control
       explains itself — on the profile ad-block switch that includes the link
       to the setting doing the holding, which at 45% opacity sat around 2:1
       against the card. Words are what the row has to say, and they stay
       readable whether or not the control they describe can be touched.
       `.dimmed` in index.css: opacity does not compose, so it goes on the
       switch alone and never on an ancestor of anything else. */
    /* `inline-flex` when there is nothing beside the switch, `flex` when there
       is. A bare switch is what a table cell holds, and `flex` is block-level:
       it filled the cell, so the column's `text-center` had nothing inline to
       center and the switch sat against the left edge. Invisible in a narrow
       column and obvious on a wide screen, which is where it was reported from
       — the enable column of the inbound access table.

       The row layout still matters whenever a label or hint is present, so
       that case is untouched. `mt-0.5` goes with it: it exists to line the
       switch up with the first line of a label, and against nothing it is
       half a step of drift the cell's own `align-middle` did not ask for. */
    <label data-part="toggle"
           className={`${label || hint ? 'flex' : 'inline-flex'} items-start gap-3 ${
      disabled ? '' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        disabled={disabled}
        onClick={flip}
        aria-label={label ? undefined : srLabel}
        className={`toned h-5 w-9 shrink-0 rounded-full border transition-colors
                    ${label || hint ? 'mt-0.5' : ''} ${disabled ? 'dimmed' : ''}`}
        style={{
          background: shown ? 'var(--color-accent)' : 'var(--color-line-strong)',
          '--btn-line': shown ? 'var(--color-accent)' : 'var(--color-line-strong)',
        } as CSSProperties}
      >
        <span
          className="block size-4 rounded-full bg-white transition-transform"
          style={{ transform: `translateX(${shown ? '17px' : '1px'})` }}
        />
      </button>
      {(label || hint) && (
        <span>
          {label && <span data-part="control-label"
                          className="text-[13px] text-[var(--color-ink)]">{label}</span>}
          {hint && (
            <HintSlot term={label} inline={
              <span data-part="hint"
                    className="mt-0.5 block text-[12px] leading-snug text-[var(--color-ink-3)]">
                {hint}
              </span>}>
              {hint}
            </HintSlot>
          )}
        </span>
      )}
    </label>
  )
}

/**
 * A dot, for a control that only takes effect when a form is submitted.
 *
 * The sliding switch says "this happens now", and every switch in this app does
 * exactly that. Inside a form with its own submit button that promise is false:
 * flipping the slider changes nothing until the button is pressed. This shares
 * the switch's proportions, label, and hint layout so the two read as one
 * family — same size, same blue — and its shape says the change is pending
 * rather than already done.
 */
export function Check({
  checked, onChange, label, srLabel, disabled, hint, name,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  srLabel?: string
  disabled?: boolean
  /** A node, not a string: a hint that names somewhere else in the app
   *  should be able to link to it rather than describe the route. */
  hint?: ReactNode
  /** Included in the form's data, for a form read through FormData. */
  name?: string
}) {
  return (
    // Dimmed in pieces, for the same reason the switch above is.
    <label className={`flex items-start gap-3 ${disabled ? '' : 'cursor-pointer'}`}>
      {/* A rounded square, 16px, the same size as the knob inside the switch,
          so a pending control and an immediate one match in size and color and
          only the shape says which is which. It was a circle for that reason
          and went too far: a filled circle is what a radio button looks like,
          and the Uplink VLAN tag row read as one of a set of choices rather
          than a thing you switch on. A squircle keeps the family resemblance
          to the switch while still being unmistakably a checkbox.

          The dot is 16px but its box is 36px, matching the switch's track, and
          it is centered in it. Where a Check and a Toggle stack in one column —
          the Uplink VLAN tag above IPv6 upstream, for one — the narrower
          control pulled its own label 20px left of the labels under it and sat
          off to one side of the switches. Same gutter, same left edge for every
          row's text. */}
      <span className={`relative mt-0.5 flex h-5 w-9 shrink-0 items-center
                        justify-center ${disabled ? 'dimmed' : ''}`}>
        <input
          type="checkbox"
          name={name}
          checked={checked}
          disabled={disabled}
          aria-label={label ? undefined : srLabel}
          onChange={(e) => onChange(e.target.checked)}
          className="peer size-4 shrink-0 appearance-none rounded-[5px] border
                     bg-[var(--color-surface)] transition-colors
                     checked:bg-[var(--color-accent)]"
          style={{ '--btn-line': checked
            ? 'var(--color-accent)' : 'var(--color-line-strong)' } as CSSProperties}
        />
        {/* A tick when filled. On the circle this was a white dot in the
            middle, borrowing the switch's white knob; on a squircle a centered
            dot reads as decoration, and a tick is what a checkbox is expected
            to put there. */}
        <svg aria-hidden="true" viewBox="0 0 24 24"
             className="pointer-events-none absolute size-3 text-white opacity-0
                        peer-checked:opacity-100"
             fill="none" stroke="currentColor" strokeWidth={3.5}
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5 10 17.5 19 7" />
        </svg>
      </span>
      {(label || hint) && (
        <span>
          {label && <span data-part="control-label"
                          className="text-[13px] text-[var(--color-ink)]">{label}</span>}
          {hint && (
            <HintSlot term={label} inline={
              <span data-part="hint"
                    className="mt-0.5 block text-[12px] leading-snug text-[var(--color-ink-3)]">
                {hint}
              </span>}>
              {hint}
            </HintSlot>
          )}
        </span>
      )}
    </label>
  )
}

/** Inline rename. Commits on Enter or blur, reverts on Escape. */
export function EditableText({
  value, onSave, placeholder = t('primitives.unnamed'), disabled,
}: {
  value: string
  onSave: (v: string) => Promise<void> | void
  placeholder?: string
  disabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  /* The name that was just submitted, held until the `value` prop agrees.
     Without it the rename flashed through three states: the new name grayed
     out while the write was in flight, then the OLD name in full ink the
     instant the write resolved — because the caller's refetch had not landed
     yet and `value` was still the old one — and then the new name again. The
     middle frame was the worst kind of wrong, since it looked like the rename
     had been rejected. Same approach as Toggle: show the submitted value
     straight away and let the prop overtake it quietly. */
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => setDraft(value), [value])

  // The prop caught up, so the local override has nothing left to do. Also
  // released on a timer, so a caller that never refetches cannot leave this
  // showing a name the network may not have taken.
  useEffect(() => {
    if (saved === null) return
    if (value === saved) { setSaved(null); return }
    const t = setTimeout(() => setSaved(null), 8000)
    return () => clearTimeout(t)
  }, [value, saved])

  async function commit() {
    const next = draft.trim()
    setEditing(false)
    if (next === value || !next) { setDraft(value); return }
    setSaved(next)
    try {
      await onSave(next)
    } catch {
      // Reverted here; the caller reports why. Leaving the new name up after a
      // refusal would be the same lie the old grayed state told, inverted.
      setSaved(null)
      setDraft(value)
    }
  }

  const shown = saved ?? value
  if (disabled) return <span>{shown || placeholder}</span>
  if (!editing) {
    return (
      /* A pencil, and an underline under the words. Without them this is text
         that happens to respond to a click, and the only sign of it was a
         wash that appears once the pointer is already on it — no sign at all
         on a touch screen, and none to somebody wondering whether a network
         with no nickname can be given one. */
      <button type="button" onClick={() => setEditing(true)} data-part="editable"
              className="group -mx-1 inline-flex items-center gap-1 rounded px-1
                         text-left hover:bg-[var(--color-accent-wash)]"
              title={t('primitives.click_rename')}>
        <span className="underline decoration-[var(--color-line-strong)]
                         decoration-dashed underline-offset-4
                         group-hover:decoration-[var(--color-accent)]">
          {shown || <span className="text-[var(--color-ink-3)]">{placeholder}</span>}
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
    )
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') { setDraft(value); setEditing(false) }
      }}
      className="w-full max-w-48 rounded border border-[var(--color-accent)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[13px]"
    />
  )
}

/**
 * A section that starts closed, with its size in the heading.
 *
 * Used where a panel holds several long lists: showing all of them at once
 * buries whatever the reader came for. The count is the whole point of the
 * closed state — it says whether opening is worth it — so it is omitted at
 * zero rather than rendered as "(0)", which reads as a broken counter.
 */
export function Collapsible({ title, count, badge, defaultOpen = false,
                             boxed = false, className = '', children }: {
  title: string
  count?: number
  badge?: ReactNode
  defaultOpen?: boolean
  /** Draw it as a tinted box, for a group that sits inside another section and
   *  needs to read as a thing of its own rather than a further heading. */
  boxed?: boolean
  className?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`${boxed
      ? 'mb-4 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-1.5'
      : 'mb-5'} ${className}`}>
      <h3 className="text-[13px] font-semibold">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 py-1 text-left"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"
               className={`size-3.5 shrink-0 text-[var(--color-ink-3)] transition-transform
                           ${open ? 'rotate-90' : ''}`}
               fill="currentColor">
            <path d="M9 5l7 7-7 7z" />
          </svg>
          <span className="flex-1">
            {title}{count ? ` (${count})` : ''}
          </span>
          {badge}
        </button>
      </h3>
      {open && <div className={boxed ? 'pb-1' : undefined}>{children}</div>}
    </section>
  )
}

/**
 * A horizontal tab strip.
 *
 * For a panel whose sections are alternatives rather than a list to read
 * through: only one is wanted at a time, so a disclosure per section is a
 * click to reach what a tab reaches directly. Arrow keys move between tabs,
 * which is what the pattern requires and what a row of plain buttons lacks.
 */
/**
 * Which edges of a scrolling strip have more beyond them.
 *
 * A hard cut at the container's edge reads as a rendering fault — the last
 * item looks truncated and nothing says it can be scrolled to. A fade on the
 * side that actually has more reads as "keep going", and a strip that fits is
 * left alone so nothing is dimmed for no reason. Returns the class to put on
 * the strip; the gradients themselves are in index.css.
 *
 * Used by the tab strips and by the horizontal navigation bars, which is what
 * this was pulled out of Tabs for: a top bar with ten destinations overflowed
 * on a laptop and the last of them was simply gone, with the scrollbar hidden
 * and no fade to say otherwise.
 */
export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  /** Anything that changes how wide the strip's contents are. */
  watch?: unknown,
): string {
  const [more, setMore] = useState({ left: false, right: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setMore({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    })
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    // The children decide the scroll width, so a child resizing — a label
    // appearing at a wider viewport — has to be watched too.
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => { el.removeEventListener('scroll', read); ro.disconnect() }
  }, [ref, watch])
  return more.left && more.right ? 'fade-x'
    : more.right ? 'fade-r' : more.left ? 'fade-l' : ''
}

export function Tabs<T extends string>({ tabs, active, onPick, className = '' }: {
  tabs: { id: T; label: string; badge?: ReactNode }[]
  active: T
  onPick: (id: T) => void
  className?: string
}) {
  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === active)
    const next = tabs[(i + delta + tabs.length) % tabs.length]
    if (next) onPick(next.id)
  }
  // A strip too wide for its container scrolls rather than being cut off. On a
  // phone the profile filters ran to 578px inside a 390px screen, which put two
  // of its five tabs somewhere no finger could reach. Scrolling the selected one
  // into view keeps arrow keys and a fresh page landing somewhere visible.
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = strip.current?.querySelector('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const fade = useEdgeFade(strip, tabs.length)

  return (
    <div
      ref={strip}
      role="tablist"
      data-part="tabs"
      className={`no-bar ${fade} flex gap-1 overflow-x-auto border-b
                  border-[var(--color-line)] ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
        if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onPick(t.id)}
            className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-[13px] font-medium ${
              on
                ? 'border-[var(--color-accent)] text-[var(--color-accent-ink)]'
                : 'border-transparent text-[var(--color-ink-3)] hover:text-[var(--color-ink)]'}`}
          >
            {t.label}
            {t.badge}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The result of an action, said the same way everywhere.
 *
 * Success and failure are distinguished by color *and* by an icon, because
 * color alone is not a distinction for a colorblind reader or a grayscale
 * screen. `role` follows the kind: a failure interrupts assistive technology,
 * a success is announced politely.
 */
export function Notice({ kind, children, className = '', ...rest }: {
  /* `warn` was added for the pending-firmware notice, which is neither: an
     update waiting to install is not an error and not a success, and painting
     it red made a routine state look like a fault. It gets the same triangle
     as `bad` — the shape says "read this", the color says how much. */
  kind: 'ok' | 'bad' | 'warn'
  children: ReactNode
  className?: string
  /** Data attributes, so a test can find one notice among others. */
  [data: `data-${string}`]: string | boolean | undefined
}) {
  const ok = kind === 'ok'
  const color = ok ? 'ok' : kind === 'warn' ? 'warn' : 'bad'
  return (
    <p
      {...rest}
      data-part="notice"
      /* A warning is announced politely rather than interrupting: `alert` is
         for something that just went wrong, and this has been true, quietly,
         since whenever eero published the firmware. */
      role={kind === 'bad' ? 'alert' : 'status'}
      /* col-span-full so a notice dropped into a multi-column grid spans the
         row instead of taking the first cell and shunting every card along.
         grid-column only applies to grid items, so this is inert everywhere
         else — which is what makes it safe to put here rather than remembering
         it at each of the dozen call sites. */
      className={`col-span-full flex items-start gap-1.5 text-[13px]
                  font-semibold ${className}`}
      style={{ color: `var(--color-${color})` }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
           className="mt-0.5 size-4 shrink-0" fill="currentColor">
        {ok
          ? <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
          : <>
              <path d="M12 2 23 21H1L12 2Z" />
              <path d="M11 9h2v6h-2zm0 7h2v2h-2z" fill="var(--color-surface)" />
            </>}
      </svg>
      <span>{children}</span>
    </p>
  )
}

/** What a page holds while it reports how an action went. */
export interface NoticeState { kind: 'ok' | 'bad'; text: string }

/**
 * State for a Notice, with the two ways of setting it named so a caller cannot
 * report a failure in the color of a success by accident.
 */
export function useNotice() {
  const [notice, set] = useState<NoticeState | null>(null)
  return {
    notice,
    /* Accepted and dropped.

       Nothing in the app announces success any more. A write that worked is
       the normal case, and the interface already shows it: the switch is over,
       the name is on the row, the value is in the field. A banner saying so as
       well is a second copy of a fact nobody doubted — and where it appeared
       above a list it pushed every row down to deliver it, so the thing you had
       just clicked moved out from under the cursor.

       Kept as a function rather than removed so the twenty-odd call sites can
       go on passing what they were passing. They read as documentation of what
       just happened, which is worth something; what is not worth anything is
       putting it on screen. A failure is the only outcome the interface cannot
       show on its own, and that is what `fail` is for. */
    ok: (_text?: string) => set(null),
    fail: (text: string) => set({ kind: 'bad', text }),
    clear: () => set(null),
    /** Rendered where the page wants it, or nothing when there is no news. */
    node: notice
      ? <Notice kind={notice.kind}>{notice.text}</Notice>
      : null,
  }
}

/**
 * The button that commits a form.
 *
 * One appearance for every one of them. They had drifted into ten different
 * looks — accent-filled, outlined gray, outlined amber, outlined red — which
 * made the color read as a signal it was not: a red Apply on a WAN form said
 * "danger" while an identical Apply elsewhere said nothing. Whether a change
 * is risky is the confirmation's job to say, in words, not the button's to
 * imply in color.
 */
export function SubmitButton({
  children, disabled, className = '', full = false, onClick,
  type = 'submit', tone = 'accent', title, compact = false,
}: {
  children: ReactNode
  disabled?: boolean
  className?: string
  /** Spans its container, for a form whose fields already do. */
  full?: boolean
  onClick?: () => void
  type?: 'submit' | 'button'
  /** `bad` for an action whose result is hard to undo — switching the LAN to
   *  bridge mode, for one. Same shape, size, and weight as the default, because
   *  a form's commit button should not change its geometry with its
   *  consequences; only its color says this one is different. Three panes
   *  used to hand-roll their own buttons for exactly this and ended up with
   *  three different sizes. */
  tone?: 'accent' | 'bad'
  title?: string
  /** Half height, for a button that sits on a line of small text rather
   *  than under a form: the Dashboard's "Run test", beside when the last
   *  test ran. */
  compact?: boolean
}) {
  /* `bad` is drawn quiet rather than red. Red is the interface's word for
     something being wrong, and a Reboot button sitting in a drawer somebody
     opened out of curiosity is not that — painting it red put an alarm on every
     eero on the network, permanently, and left nothing louder for a real fault.
     So a consequential action gets a restrained outline: it reads as separate
     from the accent-colored commit buttons without shouting. What makes it safe
     is the confirmation, which says in words what will happen. */
  const bg = tone === 'bad' ? 'transparent' : 'var(--color-accent)'
  const over = tone === 'bad'
    ? 'var(--color-surface-2)'
    : 'var(--color-accent-ink)'
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      data-part="submit"
      style={{ '--sb-bg': bg, '--sb-over': over } as CSSProperties}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md
                  bg-[var(--sb-bg)] ${compact
                    ? 'h-4 rounded-[4px] px-2 text-[11px] leading-none'
                    : 'h-8 px-3 text-[13px]'}
                  font-medium transition-colors hover:bg-[var(--sb-over)]
                  disabled:opacity-50
                  ${tone === 'bad'
                    ? 'border border-[var(--color-line-strong)] text-[var(--color-ink-2)]'
                    : 'text-white'}
                  ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  )
}

/** Small inline button used inside table rows. */
export function RowAction({
  onClick, children, tone = 'neutral', disabled, title, sizeTo, reserved,
}: {
  onClick: () => void
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
  disabled?: boolean
  title?: string
  /** The longest label this button can ever show. A button whose caption
   *  toggles (Pause/Resume, Block/Unblock) otherwise changes width with the
   *  row's state, so the column's edges never line up. Reserving the widest
   *  caption as a hidden sizing layer keeps the width constant and measures
   *  it in the real font, which a ch or rem guess cannot do. */
  sizeTo?: string
  /** Keep the space, drop the control. For an action that does not apply to
   *  this row at all — deleting the profile eero owns — where a disabled
   *  button would still invite a click and removing it outright would shift
   *  every button to its left. Rendered as an inert span from the same
   *  classes, so the box cannot drift from the real button's. */
  reserved?: boolean
}) {
  /* `bad` is deliberately not red here either — see SubmitButton. A column of
     red Delete buttons made a settings table look like a list of faults. */
  const color = tone === 'bad' ? 'var(--color-line-strong)'
    : tone === 'warn' ? 'var(--color-warn)'
    : tone === 'ok' ? 'var(--color-ok)'
    : tone === 'accent' ? 'var(--color-accent)' : 'var(--color-line-strong)'
  const ink = tone === 'neutral' || tone === 'bad' ? 'var(--color-ink-2)' : color
  const shape = `shrink-0 rounded border px-2 py-0.5 text-center text-[12px]
                 font-medium ${sizeTo ? 'relative' : ''}`
  const inner = sizeTo ? (
    <>
      <span aria-hidden="true" className="invisible block">{sizeTo}</span>
      <span className="absolute inset-0 grid place-items-center">{children}</span>
    </>
  ) : children
  if (reserved) {
    return (
      <span aria-hidden="true" className={`invisible ${shape}`}>{inner}</span>
    )
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      data-part="row-action"
      className={`toned ${shape} disabled:opacity-40`}
      style={{ '--btn-line': color, color: ink } as CSSProperties}>
      {inner}
    </button>
  )
}

/**
 * Signal strength as filled bars, with the exact figure on hover.
 *
 * Magnitude is carried by how many bars are filled, so color is a reinforcement
 * rather than the only encoding — the reading survives colorblindness and
 * grayscale printing. The dBm value stays available via the title and is
 * exposed to assistive technology through the label.
 */
/**
 * A wired link.
 *
 * No speed is shown. eero reports its own port's rate on every client behind
 * that port, so on a network with a switch a dozen clients all claim the same
 * figure; it describes the eero-to-switch link, not any client's. The mark is
 * the app's one cable glyph, shared with the network diagrams and the node
 * drawer, so a wired link looks the same wherever it is drawn.
 */
export function WiredLink() {
  return (
    <span className="inline-flex items-center align-middle"
          role="img" aria-label={t('primitives.wired')}>
      <CableDataIcon size={16} className="shrink-0" />
    </span>
  )
}

/* How many device pixels a CSS pixel is, kept current through zoom and
 * moves between screens. One listener for every meter on the page: a
 * clients table draws sixty of them. */
const dprListeners = new Set<() => void>()
let dprQuery: MediaQueryList | null = null
function dprChanged() {
  armDpr()
  dprListeners.forEach((l) => l())
}
function armDpr() {
  dprQuery?.removeEventListener('change', dprChanged)
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprQuery.addEventListener('change', dprChanged)
}
function watchDpr(changed: () => void) {
  if (!dprListeners.size) armDpr()
  dprListeners.add(changed)
  return () => {
    dprListeners.delete(changed)
    if (!dprListeners.size) {
      dprQuery?.removeEventListener('change', dprChanged)
      dprQuery = null
    }
  }
}
const readDpr = () => window.devicePixelRatio || 1

/* A length in CSS pixels, rounded to a whole number of device pixels.

   At a scale of 1.25 or 1.5 a 3px bar is 3.75 or 4.5 device pixels, and the
   browser rounds each bar's edges separately: measured, the four came out
   4, 4, 4, 3 at 1.25 and 4, 5, 4, 5 at 1.5, which is the uneven thickness.
   With every width and gap a whole number of device pixels, all the edges
   share one fraction, round the same way, and the bars match. */
const snap = (css: number, dpr: number) => Math.max(1, Math.round(css * dpr)) / dpr

/**
 * A signal meter: four bars, filled from a value this component does not
 * derive.
 *
 * It used to take eero's rating and an RSSI and decide between them itself,
 * with a `bars` prop so two callers could ask for five. Both of those were
 * ways for one screen to disagree with another about the same link — see
 * `lib/signal.ts`, which now does the deciding for everybody.
 */
export function SignalBars({ value, dbm = null, reading = 'inline' }:
  { /** 0 to BARS, or null when nothing is known — which is not zero bars. */
    value: number | null
    /** RSSI, for the readout only. Never for the bar count. */
    dbm?: number | null
    /** Where the dBm figure goes. `inline` reveals it beside the bars on
     *  hover; `beside` does the same without keeping room for it, so a
     *  centered column centers the bars rather than the bars and a blank;
     *  `tooltip` keeps it in the title only, for a column that has to stay a
     *  fixed width because other rows put a different mark there; `none`
     *  drops both, for a place that already prints the figure and would
     *  otherwise say it twice. */
    reading?: 'inline' | 'beside' | 'tooltip' | 'none' }) {
  const dpr = useSyncExternalStore(watchDpr, readDpr, () => 1)
  if (value === null) {
    return <span className="text-[var(--color-ink-3)]" title={t('primitives.wired_unknown')}>—</span>
  }
  const filled = Math.max(0, Math.min(BARS, value))
  const color = signalTone(filled)

  // eero's own words for each step, so the reading matches the phone app.
  // Read as a fraction of the scale rather than as an absolute count.
  const share = filled / BARS
  const quality =
    share >= 1 ? t('signal.strong') : share >= 0.7 ? t('signal.good') :
    share >= 0.45 ? t('signal.okay') : share > 0 ? t('signal.poor')
                                                 : t('signal.none')

  return (
    // The reading is revealed inline on hover or keyboard focus rather than by
    // a native title tooltip, which is slow to appear and cannot be styled.
    // title stays as a fallback; aria-label carries it for assistive tech.
    // Deliberately not focusable: one tab stop per row would add dozens of
    // stops to the table for information the aria-label already conveys to
    // assistive technology without focus.
    <span
      className={`group inline-flex items-center gap-1.5 align-baseline${
        reading === 'beside' ? ' relative' : ''}`}
      title={reading === 'none' ? undefined
             : dbm === null ? quality : `${dbm} dBm — ${quality}`}
      aria-label={dbm === null ? t('signal.aria', { quality })
                               : t('signal.aria_dbm', { quality, dbm })}
      role="img"
    >
      <span className="inline-flex items-end" style={{ gap: snap(2, dpr) }}>
        {Array.from({ length: BARS }, (_, i) => (
          <span
            key={i}
            className="rounded-[1px]"
            style={{
              width: snap(3, dpr),
              height: snap(5 + i * 3, dpr),
              background: i < filled ? color : 'var(--color-line)',
            }}
          />
        ))}
      </span>
      {(reading === 'inline' || reading === 'beside') && (
        <span className={`whitespace-nowrap tabular-nums text-[11px] text-[var(--color-ink-3)] opacity-0 transition-opacity group-hover:opacity-100${
          reading === 'beside' ? ' pointer-events-none absolute left-full ml-1.5' : ''}`}>
          {dbm === null ? '' : `${dbm} dBm`}
        </span>
      )}
    </span>
  )
}


/**
 * Slide-over panel. Closes on Escape or backdrop click, moves focus into the
 * panel on open and returns it to the trigger on close, so keyboard users are
 * not dropped back at the top of the document.
 */
/* Holding the page still while a panel is over it.
 *
 * `overflow: hidden` on the body is the usual answer and it is not enough:
 * iOS Safari scrolls the page anyway, and a scroll that runs off the end of
 * the panel chains to whatever is behind it, so flicking through a client's
 * details moves the table underneath. Taking the body out of flow is what
 * actually stops both. A fixed body reports a scroll position of zero, so the
 * offset is remembered and put back on the way out, and the width the
 * scrollbar was using is replaced with padding so the page does not jump
 * sideways as it locks.
 *
 * Counted rather than a boolean: a panel can open over a panel, and the first
 * one to close must not unlock the page under the second.
 */
let locks = 0
let releaseLock: (() => void) | null = null

function lockPage() {
  if (locks++) return
  const body = document.body
  const y = window.scrollY
  const gap = window.innerWidth - document.documentElement.clientWidth
  const was = {
    position: body.style.position, top: body.style.top,
    width: body.style.width, paddingRight: body.style.paddingRight,
  }
  body.style.position = 'fixed'
  body.style.top = `-${y}px`
  body.style.width = '100%'
  if (gap > 0) body.style.paddingRight = `${gap}px`
  releaseLock = () => {
    body.style.position = was.position
    body.style.top = was.top
    body.style.width = was.width
    body.style.paddingRight = was.paddingRight
    window.scrollTo(0, y)
  }
}

function unlockPage() {
  locks = Math.max(0, locks - 1)
  if (locks) return
  releaseLock?.()
  releaseLock = null
}

export function Drawer({
  open, onClose, title, size = 'default', children,
}: {
  open: boolean; onClose: () => void; title: ReactNode
  /** `wide` for a panel with sections and tables in it rather than a list of
   *  label-and-value rows. The filters panel outgrew 440px once, which is why
   *  it spent a while as a page. */
  size?: 'default' | 'wide'
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement | null>(null)
  const restoreTo = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      ;(restoreTo.current as HTMLElement | null)?.focus?.({ preventScroll: true })
    }
  }, [open, onClose])

  /* Separate from the effect above so that it keys on `open` alone: a new
     `onClose` each render would otherwise unlock and relock the page,
     scrolling it back each time.

     A layout effect, so the page is pinned in the same frame the drawer first
     paints. As a plain effect it ran a frame later, and pinning the body lays
     the whole page out again: on a phone that frame came through with only
     the fixed background painted, which in Sailing is the sea, a flash after
     the drawer had appeared. Its cleanup now runs before the focus goes back,
     which is why that focus does not scroll. */
  useLayoutEffect(() => {
    if (!open) return
    lockPage()
    return unlockPage
  }, [open])

  if (!open) return null
  /* Into <body>, not where it is used. The drawers open from inside cards,
     and a card body fades its contents in (`content-arrive`, from opacity 0)
     whenever a placeholder inside it is replaced, the drawer's own included.
     A fixed panel still takes its ancestors' opacity, so the whole drawer
     went transparent and faded back, with the page and the theme's picture
     showing through, every time something in it refreshed. */
  return createPortal(
    <div data-part="drawer" className="fixed inset-0 z-40">
      <button type="button" aria-label={t('primitives.close_panel')} onClick={onClose}
              data-part="scrim" className="absolute inset-0 bg-black/30" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : t('primitives.details')}
        data-part="drawer-panel"
        className={`absolute inset-y-0 right-0 flex w-full flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)] shadow-xl outline-none ${
          size === 'wide' ? 'max-w-[680px]' : 'max-w-[440px]'}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
          <h2 className="min-w-0 text-[15px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('primitives.close')}
                  className="shrink-0 rounded p-1 text-[var(--color-ink-3)] hover:bg-[var(--color-canvas)]">
            <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
              <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4L10.6 10.6l6.3-6.3z" />
            </svg>
          </button>
        </header>
        {/* `overscroll-contain` so reaching the end of the panel does not
            hand the scroll to the page behind it. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** eero's release notes: what changed in the firmware being talked about.
 *
 *  Wherever the app says an update is coming or has landed, this is the one
 *  thing somebody wants next and eero's own notification does not carry it.
 *  It is one component rather than three copies so the three places saying
 *  it — the dashboard's notice, the firmware row in Settings, and every
 *  firmware line in the bell drawer — cannot end up pointing at different
 *  pages or wording it differently.
 *
 *  `stopPropagation` because one of those three sits inside a row that
 *  acknowledges the notification when clicked, and following a link should not
 *  also mark it read behind your back. It costs nothing in the other two.
 */
export function ReleaseNotesLink({ className = '' }: { className?: string }) {
  return (
    <a
      href="https://eero.com/support/articles/eero-software-release-notes"
      target="_blank" rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className={`link ${className}`}
    >
      {t('notifications.whats_new')}
    </a>
  )
}
