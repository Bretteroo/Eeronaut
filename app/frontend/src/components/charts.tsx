import { useCallback, useEffect, useId, useMemo, useRef, useState,
         type CSSProperties, type ReactNode } from 'react'
import { t } from '../i18n'

/** The empty state both charts show. Two places said this in identical prose,
    which is two places to keep in step and two strings to translate. */
const nothingRecorded = () =>
  `${t('charts.nothing_recorded_period')} ${t('charts.short_window_hint')}`

export interface Point { t: string; v: number }
export interface Series { name: string; color: string; points: Point[] }

/* Axis label typography, and nothing else.
   Axis labels used to be SVG text inside the plot's own viewBox, which is
   stretched to the element's width — so they rendered at a different size from
   every other chart's labels, and were distorted horizontally whenever the
   measured width had not caught up with the real one. They are HTML now, and
   every chart takes its type from here so matching is a property of the markup
   rather than something to keep in step by hand.

   Type only, deliberately. The first version of this bundled the layout in
   too, and one of the strings carried `relative` — applied to a label that
   needed `absolute`, which put every x label back into normal flow and spilled
   the last two off the right of the plot. */
export const AXIS_TYPE = 'text-[10px] text-[var(--color-ink-3)]'
/** The y gutter. Fixed per chart so its own labels line up; widened by the
 *  caller when the values carry a unit — "1000 Mbps" does not fit in 44px and
 *  came out clipped. */
export const AXIS_Y = `shrink-0 text-right tabular-nums ${AXIS_TYPE}`
export const AXIS_W = 44

function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / mag) * mag
}

/* Long enough to read as growth, short enough that the figures are not kept
   waiting. The stagger is capped rather than per-mark, so a forty-bar chart
   finishes in the same time as a five-bar one. */
/* Exported with useGrowIn so a chart drawn elsewhere settles on the same
   clock as the ones here. */
export const GROW_MS = 650
export const GROW_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
export const STAGGER_MS = 260

/* Coming down is quicker than going up, and unstaggered.
   The 650ms reveal is right for a chart arriving on screen for the first time.
   Reused for the shrink half of a period switch it made the whole exchange
   feel sluggish, and — measured frame by frame — the bars only reached about
   ten pixels before the new values were handed over, so they never actually
   returned to the baseline. A stagger on the way down is worse still: the last
   bar starts moving after the first has already finished. */
export const SHRINK_MS = 260

/**
 * Grow marks from zero the first time the chart comes into view.
 *
 * Exported for charts drawn outside this file — the airtime sparkline, for
 * one — so every chart in the app enters the same way.
 *
 * A chart already at full height when it scrolls past reads as a picture; one
 * that rises as you reach it reads as a measurement being taken. One-shot, so
 * scrolling back over it does not replay the animation, and skipped outright
 * when the reader has asked for less motion — in which case the marks are
 * drawn at full size from the start rather than never drawn at all.
 */
export function useGrowIn<T extends Element>() {
  const [grown, setGrown] = useState(false)
  const io = useRef<IntersectionObserver | null>(null)
  /* A callback ref rather than an effect over a ref object. Every chart here
     returns a placeholder before its data arrives, so the element to observe
     does not exist on the render that an effect would run after — the observer
     attached to nothing and no chart ever grew. This attaches whenever the
     node appears, however late that is. */
  const ref = useCallback((el: T | null) => {
    io.current?.disconnect()
    if (!el) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setGrown(true)
      return
    }
    /* Waits for the whole chart to be on screen, not the first pixel of it.
       A chart that starts growing while half of it is still below the fold has
       finished by the time you can see it, which is the animation happening
       where nobody is looking.

       Ratio rather than a bare threshold, because a threshold only fires on
       the crossing and a chart taller than the viewport can never reach 1 —
       that case takes as much of itself as will fit instead. 0.98 rather than
       1 because subpixel layout keeps a fully visible element just under. */
    io.current = new IntersectionObserver(([e]) => {
      const tallerThanView = e.boundingClientRect.height > window.innerHeight * 0.9
      if (e.intersectionRatio >= 0.98
          || (tallerThanView && e.intersectionRatio > 0.5)) {
        setGrown(true)
        io.current?.disconnect()
      }
    }, { threshold: [0, 0.5, 0.75, 0.9, 0.98, 1] })
    io.current.observe(el)
  }, [])
  useEffect(() => () => io.current?.disconnect(), [])
  return [ref, grown] as const
}

/**
 * Time-series line chart.
 *
 * One y-axis by construction: it takes a single scale for every series it is
 * given. Two measures of different magnitude belong in two of these, not in one
 * chart with two axes.
 */
/** A chart's space, held while its data is still coming.
 *
 *  Not the empty message: "Nothing recorded for this period" is an answer,
 *  and a pane that has not heard back has no answer to give. Keeping the
 *  height means the card does not resize when the figures land, which is
 *  what made these panes appear to snap into place.
 */
function ChartHolder({ height }: { height: number }) {
  return (
    <div aria-hidden="true" className="w-full animate-pulse rounded"
         style={{ height, background: 'var(--color-surface-2)' }} />
  )
}

export function LineChart({
  series, height = 200, format, label, pending, empty, axisWidth = AXIS_W, marks,
  loading = false, yTicks = 5, emptyPlot = false,
}: {
  series: Series[]
  height?: number
  format: (v: number) => string
  label: string
  /** The data on screen is the previous window's and a new one is loading.
   *  The marks drop to the baseline and rise again into the new values, which
   *  keeps the card's height fixed instead of collapsing it to a one-line
   *  placeholder and shoving the page around. */
  pending?: boolean
  /** Why there is nothing to draw. The default says only that there is
   *  nothing, which leaves the reader to guess whether it is broken. */
  empty?: ReactNode
  /** Nothing has arrived yet, so the space is held rather than answered. */
  loading?: boolean
  /** With nothing to draw, draw the empty plot rather than say so. For a
   *  chart that fills in front of the reader: the axes are there from the
   *  first paint and the line simply appears on them, instead of a sentence
   *  being replaced by a chart that then grows out of the floor. */
  emptyPlot?: boolean
  /** Width of the y-axis gutter in px. Widen it when the labels carry a unit. */
  axisWidth?: number
  /** How many gridlines, counting the baseline. Five is right for a chart
   *  given its own row; a short one stacks them close enough that the labels
   *  crowd, so it asks for three. */
  yTicks?: number
  /** Moments to mark on the x axis, by point index, each with a few words:
   *  a channel change, say. Drawn as a dotted upright with the words at its
   *  top, so the event sits where it happened rather than being counted in a
   *  caption. */
  marks?: { at: number; label: string }[]
}) {
  const id = useId()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const [fig, grown] = useGrowIn<HTMLElement>()
  const [hover, setHover] = useState<number | null>(null)
  // The viewBox is sized to the element's real width so one SVG unit is one
  // CSS pixel. A fixed width stretched to fit distorted every label with it,
  // which is what squashed the y-axis text; matching the two leaves the type
  // undistorted and still maps the crosshair straight onto the pointer.
  const [measured, setMeasured] = useState(720)
  const W = measured
  const H = height

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      if (w > 0) setMeasured(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { max, count, paths, times } = useMemo(() => {
    const count = Math.max(...series.map((s) => s.points.length), 0)
    const max = niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v))))
    // The plot is its own box now, so the scales span it edge to edge.
    const x = (i: number) => (count <= 1 ? 0 : (i / (count - 1)) * W)
    const y = (v: number) => (1 - v / max) * H
    const paths = series.map((s) => ({
      ...s,
      d: s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '),
      xy: s.points.map((p, i) => [x(i), y(p.v)] as const),
    }))
    return { max, count, paths, times: series[0]?.points.map((p) => p.t) ?? [] }
    // W belongs here now that it is measured: without it the line keeps
    // the scale it had at the previous width and drifts off the plot.
  }, [series, H, W])

  if (!count && !emptyPlot) {
    return loading ? <ChartHolder height={height} /> : (
      <p className="py-8 text-center text-[13px] leading-relaxed
                    text-[var(--color-ink-3)]">
        {empty ?? nothingRecorded()}
      </p>
    )
  }

  // The same five ColumnChart uses, so a line chart and a column chart stacked
  // on one page have gridlines at the same fractions.
  const ticks = Array.from({ length: Math.max(2, yTicks) },
                           (_, i) => (max * i) / (Math.max(2, yTicks) - 1))
  // One label per ~140px of width, first and last always, and never more than
  // there are points to label.
  const xTicks = (() => {
    if (count <= 1) return count ? [0] : []
    const want = Math.max(2, Math.min(count, Math.floor(W / 140)))
    const step = (count - 1) / (want - 1)
    return Array.from({ length: want }, (_, k) => Math.round(k * step))
      .filter((v, k, a) => a.indexOf(v) === k)
  })()
  const xOf = (i: number) => (count <= 1 ? 0 : (i / (count - 1)) * W)

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || !count) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round((px / W) * (count - 1))
    setHover(Math.max(0, Math.min(count - 1, i)))
  }

  return (
    <figure className="m-0" ref={fig} data-grown={grown ? '1' : '0'}>
      {/* No legend here: every caller of this chart renders its own above it,
          which ColumnChart's callers do not. */}
      <div className="flex gap-2" style={{ height }}>
        {/* Bottom-up, so the first tick is the baseline. */}
        <div className={`flex flex-col-reverse justify-between py-[2px] ${AXIS_Y}`}
             style={{ width: axisWidth }}>
          {ticks.map((t, i) => <span key={i}>{format(t)}</span>)}
        </div>
        <div className="relative min-w-0 flex-1" ref={box}>
          {/* Recessive gridlines: reference, not content. Positioned against
              the same box the plot is drawn in, so they line up with the
              series without either knowing about the other. */}
          {ticks.map((_, i) => (
            <span key={i} aria-hidden="true"
                  className="absolute inset-x-0 border-t border-[var(--color-line)]"
                  style={{ bottom: `${(i / (ticks.length - 1)) * 100}%` }} />
          ))}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            /* Mapped straight onto the element rather than fitted and centered:
               with the default the drawing is letterboxed and the crosshair
               only lines up with the pointer at the middle of the chart. No
               text lives in here any more, so the stretch that used to distort
               the labels has nothing left to distort. */
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
            style={{ overflow: 'visible' }}
            role="img"
            aria-label={label}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {(marks ?? []).filter((m) => m.at >= 0 && m.at < count).map((m, k) => (
              <line key={`mark-${k}`} data-chart-mark
                    x1={xOf(m.at)} x2={xOf(m.at)} y1={0} y2={H}
                    stroke="var(--color-warn)" strokeWidth={1} strokeDasharray="2 3" />
            ))}
            {hover !== null && (
              <line x1={xOf(hover)} x2={xOf(hover)} y1={0} y2={H}
                    stroke="var(--color-line-strong)" strokeWidth={1}
                    vectorEffect="non-scaling-stroke" />
            )}

            {/* Scaled about the zero line, so the series rises off the axis
                rather than fading in. Every stroke here asks for a
                non-scaling stroke, which keeps a 2px line 2px while the
                transform is part way through. */}
            <g style={{
                 transform: grown && !pending ? 'scaleY(1)' : 'scaleY(0)',
                 transformOrigin: `0px ${H}px`,
                 transition:
                   `transform ${pending ? SHRINK_MS : GROW_MS}ms ${GROW_EASE}`,
               }}>
              {paths.map((sr) => (
                <path key={sr.name} d={sr.d} fill="none" stroke={sr.color}
                      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke" />
              ))}

            </g>
          </svg>

          {/* Markers as HTML rather than SVG circles. The plot's viewBox is
              mapped straight onto the element, which stretches one axis
              against the other — a circle in there comes out an oval, by
              however much the two differ. Positioned as a percentage of the
              same box the line is drawn in, so they stay on it.

              The ring is the surface color so overlapping points stay
              separable, per the mark spec. */}
          {hover !== null && paths.map((sr) => {
            const v = sr.points[hover]?.v
            if (v == null) return null
            return (
              <span
                key={sr.name}
                aria-hidden="true"
                className="pointer-events-none absolute size-[9px] rounded-full"
                style={{
                  left: `${(count <= 1 ? 0 : hover / (count - 1)) * 100}%`,
                  top: `${(1 - v / max) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  background: sr.color,
                  boxShadow: '0 0 0 2px var(--color-surface)',
                }}
              />
            )
          })}

          {hover !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-md border
                         border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5
                         text-[12px] shadow-sm"
              style={{ left: `${Math.min(78, Math.max(2, (xOf(hover) / W) * 100))}%` }}
            >
              {/* Points carry a ready-made label from the caller — parsing it
                  back into a Date produced "Invalid Date" on every chart. */}
              <div className="text-[var(--color-ink-3)]">{times[hover]}</div>
              {paths.map((sr) => (
                <div key={sr.name} className="flex items-center gap-2">
                  <span className="inline-block size-2 rounded-full"
                        style={{ background: sr.color }} />
                  <span className="text-[var(--color-ink-2)]">{sr.name}</span>
                  <span className="ml-auto tabular-nums text-[var(--color-ink)]">
                    {format(sr.points[hover]?.v ?? 0)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Fixed height with absolutely placed labels inside, so one can spill
          sideways without the row collapsing onto whatever follows. Same
          construction as ColumnChart's axis. */}
      <div className="mt-1 flex h-4 gap-2">
        <span className="shrink-0" style={{ width: axisWidth }} />
        <div className="relative min-w-0 flex-1">
          {xTicks.map((i) => {
            const last = i === count - 1
            return (
              <span key={i}
                    className={`absolute whitespace-nowrap ${AXIS_TYPE}`}
                    style={{
                      left: `${(count <= 1 ? 0 : i / (count - 1)) * 100}%`,
                      // The end labels are pulled inside the plot rather than
                      // centered on their tick, which would hang half of each
                      // over the edge.
                      transform: i === 0 ? 'none'
                        : last ? 'translateX(-100%)' : 'translateX(-50%)',
                    }}>
                {times[i]}
              </span>
            )
          })}
        </div>
      </div>
      <figcaption className="sr-only" id={id}>{label}</figcaption>
    </figure>
  )
}

/** Legend. Present whenever there are two or more series. */
export function Legend({ series }: { series: { name: string; color: string }[] }) {
  if (series.length < 2) return null
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
      {series.map((s) => (
        <li key={s.name} className="flex items-center gap-1.5 text-[12px] text-[var(--color-ink-2)]">
          <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
          {s.name}
        </li>
      ))}
    </ul>
  )
}

/** The windows most charts in the app offer. */
export const PERIODS = [1, 7, 30] as const
/** What the speed test history offers instead: its readings are occasional
 *  events rather than buckets, so a day of them is often one point and six
 *  months is still a readable number of bars. */
export const LONG_PERIODS = [7, 30, 180] as const

/** A window's own short name. 180 days is six months to everyone who is not
 *  counting, and one day is the last 24 hours. */
function periodLabel(d: number): string {
  const key = d === 1 ? '24h' : d === 180 ? '6mo' : `${d}d`
  return t(`duration_short.${key}`)
}

/**
 * 24h / 7d / 30d.
 *
 * Lives here rather than on the Insights page because the client drawer's
 * usage chart needs the same control, and a second one built to match would
 * drift from this one the first time either changed.
 */
export function PeriodPicker({ days, onPick, disabled = false,
                               periods = PERIODS }: {
  days: number; onPick: (d: number) => void
  /** Which windows to offer. One control, because a reader should not have to
   *  learn two; different lists, because the questions differ. */
  periods?: readonly number[]
  /** For a card whose data is behind a subscription this network does not
   *  have. The control stays visible — it says what the card would offer —
   *  but pressing it can only ask eero a question it will refuse. */
  disabled?: boolean
}) {
  return (
    <span className="flex items-center gap-1" role="group" aria-label={t('insights.period')}>
      {periods.map((d) => (
        <button key={d} type="button" onClick={() => onPick(d)}
          aria-pressed={days === d} disabled={disabled}
          className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
            disabled ? 'cursor-not-allowed opacity-40' : ''} ${
            days === d
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
              : 'border-[var(--color-line-strong)] text-[var(--color-ink-3)]'}`}>
          {periodLabel(d)}
        </button>
      ))}
    </span>
  )
}

/** Ranked horizontal bars. Magnitude comparison, one hue, longest first. */
export function BarList({
  rows, format, color = 'var(--series-1)', pending, empty, loading = false,
}: {
  rows: { label: string; value: number; note?: ReactNode }[]
  format: (v: number) => string
  color?: string
  /** See LineChart: hold the shape, drop the bars, regrow into new data. */
  pending?: boolean
  /** Why the list is empty. Without this an empty list rendered as an empty
   *  `ul` — nothing at all, which reads as a broken card rather than as a
   *  window with nothing in it. */
  empty?: ReactNode
  /** Nothing has arrived yet, so the space is held rather than answered. */
  loading?: boolean
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  const [list, grown] = useGrowIn<HTMLUListElement>()
  /* Text is faded rather than recolored toward white. On a light card the two
     look the same, which is what was asked for; on a dark one, fading to a
     literal white would flash the labels brighter before they left. Fading to
     nothing lands on whatever surface the card is actually painted, so the
     effect reads the same in both themes.

     Quicker than the bars: the labels have further to travel visually and
     nothing to measure against, so they clear out ahead of the marks and the
     new set is already legible as the bars arrive. */
  const fade: CSSProperties = {
    opacity: pending ? 0 : 1,
    transition: 'opacity 220ms ease',
  }
  if (!rows.length) {
    return loading ? <ChartHolder height={96} /> : (
      <p className="py-6 text-center text-[13px] leading-relaxed
                    text-[var(--color-ink-3)]">
        {empty ?? t('charts.nothing_recorded_period')}
      </p>
    )
  }
  return (
    /* Two columns declared here and adopted by each row through subgrid, so
       every value shares one column width. Each row used to be its own grid,
       which sized its value column to its own number — the widest row set the
       bar length and the rest were left short. A fixed min-width papered over
       that at the cost of a wide gap between every bar and its figure. */
    <ul className="grid gap-1.5" ref={list} data-grown={grown ? '1' : '0'}
        style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
      {/* Keyed by position alone, for two reasons. Labels are not unique —
          seven phones all called "iphone" is normal on a real network, and a
          duplicate key drops rows. And the element has to survive a change of
          data: a bar that shrinks to zero and grows into a new value is one
          DOM node transitioning twice, where a keyed-by-label list would
          replace it and the new bar would appear at full width with nothing to
          animate from. */}
      {rows.map((r, i) => (
        <li key={i}
            className="col-span-full grid items-center gap-2"
            style={{ gridTemplateColumns: 'subgrid' }}>
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2" style={fade}>
              <span className="truncate text-[13px]">{r.label}</span>
              {r.note && <span className="shrink-0 text-[11px] text-[var(--color-ink-3)]">{r.note}</span>}
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]">
              {/* 4px rounded data-end, anchored to the baseline. */}
              <div className="h-full rounded-full"
                   style={{
                     width: grown && !pending ? `${(r.value / max) * 100}%` : 0,
                     background: color,
                     transition: `width ${pending ? SHRINK_MS : GROW_MS}ms ${GROW_EASE}`,
                     transitionDelay: pending
                       ? '0ms' : `${Math.min(i * 35, STAGGER_MS)}ms`,
                   }} />
            </div>
          </div>
          {/* No min-width: the shared subgrid column is already as wide as
              the longest figure in the list and no wider. */}
          {/* The figure goes with its bar: a number that stayed put while its
              bar shrank to nothing would be reporting a length that is no
              longer on screen. */}
          <span className="text-right tabular-nums text-[13px] text-[var(--color-ink-2)]"
                style={fade}>
            {format(r.value)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Vertical bars over an ordered category axis — one bar per period, or two
 * side by side when there are two series.
 *
 * Separate from LineChart because the reading is different: a line invites you
 * to interpolate between points, which is wrong for a speed test taken once a
 * day or for a bucket that aggregates an hour. Discrete measurements get
 * discrete marks.
 *
 * One scale for every series, as with LineChart. Two measures of different
 * magnitude belong in two charts.
 */
export function ColumnChart({
  categories, series, format, height = 180, label, maxBars, pending, empty,
  axisWidth = AXIS_W, line, loading = false,
}: {
  /** Bucket labels, oldest first. Every series must be the same length. */
  categories: string[]
  series: { name: string; color: string; values: (number | null)[] }[]
  format: (v: number) => string
  height?: number
  /** What the chart shows, for anyone not looking at it. */
  label: string
  /** Keep only the most recent N buckets. Bars thinner than about 3px stop
   *  being readable, so a long history is trimmed rather than squeezed. */
  maxBars?: number
  /** See LineChart: hold the shape, drop the bars, regrow into new data. */
  pending?: boolean
  /** Why there is nothing to draw. */
  empty?: ReactNode
  /** Nothing has arrived yet, so the space is held rather than answered. */
  loading?: boolean
  /** Width of the y-axis gutter in px. Widen it when the labels carry a unit. */
  axisWidth?: number
  /** A level to draw across the plot, labeled: the speed paid for, so every
   *  test reads as above or below it. Folded into the scale so it is always
   *  inside the plot, whatever the tests did. */
  line?: { value: number; label: string; color?: string } | null
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [plot, grown] = useGrowIn<HTMLDivElement>()
  /* Changing the window replaces most of these columns, and a column that
     mounts already at its final height has nothing to transition from: it
     appears, fully grown, in a single frame. React reuses whichever ones keep
     the same label — a few, by coincidence — so the chart half-animated and
     half-snapped, and on a real change of window it snapped entirely.

     So the heights are pinned at zero for one painted frame whenever the
     shape of the data changes, and released a frame later: the zero has to be
     painted before the change to the real height counts as a change.

     The pinning happens *during the render* that brings the new data in, not
     in an effect afterward. Effects run after the browser has painted, so an
     effect that zeroes the bars is a frame too late — the new columns have
     already been drawn at full height by then. That was survivable while the
     data arrived in two commits, because the first of them still had `pending`
     set and drew zeros anyway; switch windows fast enough that the response
     and the end of the pending state land in one commit and the mask is gone.
     Measured at a hundred per cent of final height on the first frame, with
     this component's own flag still reading settled.

     Setting state during a render of the same component is React's own answer
     to "adjust state when the props change": it re-renders immediately,
     before anything reaches the screen. */
  const shapeOf = (c: string[], sr: { name: string }[]) =>
    `${c.join('\u0000')}|${sr.map((x) => x.name).join('\u0000')}`
  const shape = shapeOf(categories, series)

  /* What is on screen, which is not always what the props say.
   *
   * The columns are keyed by their label, so a new dataset replaces them
   * wholesale — and a node that is removed does not animate anywhere, it is
   * simply gone. Growing was fixed by making the arrivals start at zero;
   * leaving needs the opposite, because there is nothing left to animate once
   * React has taken the old nodes away. Measured: every bar at the offending
   * frame was a node that had not existed the frame before.
   *
   * So new props are held here until the bars that are up have gone down. The
   * swap is driven by the height transition ending, not by a clock — a clock
   * would be wrong the moment the duration changed, and would still be a guess
   * on a machine that dropped frames. */
  const [held, setHeld] = useState({ categories, series })
  /* The newest props, kept for the moment the bars land. Written in an effect
     rather than during the render: a render that writes is a render with a
     side effect, and this is only ever read from a transition handler, which
     cannot run before the effects of the render it belongs to. */
  const wanted = useRef({ categories, series })
  useEffect(() => { wanted.current = { categories, series } })
  const leaving = shapeOf(held.categories, held.series) !== shape

  const [settled, setSettled] = useState(false)
  const [drawn, setDrawn] = useState(shape)
  if (!leaving && drawn !== shape) {
    setDrawn(shape)
    setSettled(false)
  }
  useEffect(() => {
    if (leaving) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setSettled(true))
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [shape, leaving])

  const swap = useCallback(() => setHeld(wanted.current), [])

  const { cats, cols } = useMemo(() => {
    const keep = maxBars && held.categories.length > maxBars
      ? held.categories.length - maxBars : 0
    return {
      cats: held.categories.slice(keep),
      cols: held.series.map((s) => ({ ...s, values: s.values.slice(keep) })),
    }
  }, [held, maxBars])

  const max = niceMax(Math.max(
    0, ...cols.flatMap((s) => s.values.map((v) => v ?? 0)), line?.value ?? 0))
  const n = cats.length

  /* Whether there was anything on screen to animate away, as of the render
     before this one.
     
     It has to be the previous value, not this one. The card zeroes the bars
     through `pending` while it fetches, so by the time the new data arrives
     the bars are already down and asking "are any up?" of the current render
     answers no — after which nothing would ever transition, no swap would
     ever fire, and the chart would hold the old window for good. That is
     exactly what happened: the charts stopped redrawing after one switch.
     
     The two effects are in this order deliberately. The first reads the ref
     and so sees the previous render's answer; the second updates it for the
     next one. */
  const wasUp = useRef(false)
  useEffect(() => {
    if (!leaving) return
    // No transition will ever end for a reader who has asked for none, or for
    // bars that were already down. Swap straight away rather than waiting for
    // an event that is not coming.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (still || !wasUp.current) swap()
  }, [leaving, swap])
  useEffect(() => {
    wasUp.current = grown && settled && !pending && !leaving
      && cols.some((s) => s.values.some((v) => (v ?? 0) > 0))
  })
  if (!n) {
    return loading ? <ChartHolder height={height} /> : (
      <p className="py-6 text-center text-[13px] leading-relaxed
                    text-[var(--color-ink-3)]">
        {empty ?? nothingRecorded()}
      </p>
    )
  }

  // Ticks come from the same nice maximum the bars are scaled against, so a
  // bar can never overshoot the top gridline.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f)
  // Label every bucket when there is room, otherwise a handful, so the axis
  // never turns into a smear.
  const every = Math.max(1, Math.ceil(n / 8))

  return (
    /* data-grown is what the browser tests read: measuring bar heights meant
       guessing which divs were bars, and a stray inline `line-height`
       elsewhere in the chart matched the same selector. */
    <figure className="m-0" data-grown={grown && settled ? '1' : '0'}>
      {cols.length > 1 && <Legend series={cols} />}
      <div className="flex gap-2" style={{ height }}>
        <div className={`flex flex-col-reverse justify-between py-[2px] ${AXIS_Y}`}
             style={{ width: axisWidth }}>
          {ticks.map((t, i) => <span key={i}>{format(t)}</span>)}
        </div>
        <div className="relative min-w-0 flex-1" ref={plot}>
          {/* Recessive gridlines, behind the marks. */}
          {ticks.map((_, i) => (
            <span key={i} aria-hidden="true"
                  className="absolute inset-x-0 border-t border-[var(--color-line)]"
                  style={{ bottom: `${(i / (ticks.length - 1)) * 100}%` }} />
          ))}
          {/* The level paid for, in the series' own color so it reads as
              belonging to these bars and not to the axes: ink was tried and
              looked like a gridline. A shadow beneath separates it from a bar
              that reaches the same height, and shows only where there is a
              bar to catch it. Its label sits on the line at the right, on a
              patch of surface so the bar behind does not run through the
              words. */}
          {line && (
            <span className="pointer-events-none absolute inset-x-0 z-[1] h-0"
                  style={{ bottom: `${(line.value / max) * 100}%` }}>
              {/* Dotted, as a gradient rather than a dotted border: the shadow
                  has to follow the dots, and a box-shadow follows the box,
                  which would put a solid dark line under a dotted one.
                  drop-shadow follows what is painted. The label is a sibling,
                  not a child, so the filter does not shadow it too. */}
              <span data-plan-line aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-px"
                    style={{ backgroundImage: `repeating-linear-gradient(90deg, ${
                               line.color ?? cols[0]?.color ?? 'var(--color-ink-2)'} 0 2px, transparent 2px 5px)`,
                             filter: 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45))' }} />
              {/* The words take the page's ink and the rule beside them
                  takes the series color. A caption painted in a series color
                  is a series color asked to do a text color's job: at 10px
                  on a white card, two of the four themes' blues measure
                  under 4:1. */}
              <span className="absolute right-0 bottom-0.5 rounded-sm bg-[var(--color-surface)]
                               px-1 text-[10px] font-medium leading-tight
                               text-[var(--color-ink-2)]">
                {line.label}
              </span>
            </span>
          )}
          <div className="absolute inset-0 flex items-end gap-[2px]"
               /* The bars land, and the new data takes their place. Bubbles
                  from whichever bar finishes last, which is the one that
                  decides when the chart is empty. */
               onTransitionEnd={(e) => {
                 if (leaving && e.propertyName === 'height') swap()
               }}>
            {cats.map((c, i) => (
              <div
                key={`${c}-${i}`}
                className="group relative flex h-full min-w-0 flex-1 items-end justify-center gap-[2px]"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {cols.map((s) => {
                  const v = s.values[i]
                  return (
                    <div
                      key={s.name}
                      /* 4px rounded data-end anchored to the baseline: square
                         at the bottom, rounded only at the top. */
                      className="min-w-0 flex-1 rounded-t-[4px]"
                      style={{
                        height: v == null || !grown || pending || !settled
                          || leaving
                          ? 0 : `${Math.max(v / max, 0.004) * 100}%`,
                        // Left to right across the axis, which is the
                        // direction the categories already run in.
                        transition:
                          `height ${pending ? SHRINK_MS : GROW_MS}ms ${GROW_EASE}`,
                        transitionDelay: pending
                          ? '0ms' : `${(i / Math.max(n - 1, 1)) * STAGGER_MS}ms`,
                        background: s.color,
                        opacity: hover == null || hover === i ? 1 : 0.45,
                        // Thin marks. Left to fill the slot, bars end up wide
                        // enough that a 2px gap between them reads as one
                        // filled area rather than separate measurements.
                        maxWidth: 16,
                      }}
                    />
                  )
                })}
                {hover === i && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1
                                  -translate-x-1/2 whitespace-nowrap rounded-md border
                                  border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1
                                  text-[11px] shadow-lg">
                    <div className="font-medium">{c}</div>
                    {cols.map((s) => (
                      <div key={s.name} className="flex items-center gap-1.5">
                        <span className="inline-block size-2 shrink-0 rounded-full"
                              style={{ background: s.color }} />
                        <span className="text-[var(--color-ink-3)]">{s.name}</span>
                        <span className="tabular-nums">
                          {s.values[i] == null ? '—' : format(s.values[i] as number)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Fixed height: the labels inside are absolutely placed so they can
          spill sideways, which leaves this row with no content to give it a
          height, and it collapsed onto whatever followed the chart. */}
      <div className="mt-1 flex h-4 gap-2">
        <span className="shrink-0" style={{ width: axisWidth }} />
        <div className="flex min-w-0 flex-1 gap-[2px]">
          {cats.map((c, i) => (
            <span key={`${c}-${i}`}
                  className={`relative min-w-0 flex-1 text-center ${AXIS_TYPE}`}>
              {i % every === 0 && (
                /* Absolutely placed so it can spill into the blank slots on
                   either side. Inside its own slot it was one bar wide and
                   every date came out as "Aug …". */
                <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">
                  {c}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  )
}

/**
 * A two-or-more slice donut, for a part-to-whole small enough to read at a
 * glance.
 *
 * A donut rather than a solid pie: the hole is where the total goes, which is
 * the number somebody wants first, with the split as the reason for it.
 *
 * Redrawn once after the first version was called awful, and it was. A thick
 * ring on a small radius reads as a clumsy washer rather than a chart; the
 * gray track behind it was visible in the gaps and implied a remainder that
 * does not exist, since two slices of a whole always fill the circle; and the
 * legend crowded the ring's right shoulder. So: a thinner ring on a bigger
 * radius, no track when the slices already account for everything, and the
 * legend under the ring where it has room to breathe.
 *
 * Rules carried from the rest of the charts rather than reinvented: identity
 * never rests on color alone, so every slice is named beside its own count;
 * labels wear text tokens while the swatch carries the hue; and a 2px gap of
 * the card's own surface sits between neighboring arcs so two fills never
 * touch.
 *
 * Colors are the caller's business, because the job differs. Two kinds of
 * thing that merely differ want the validated categorical pair; a split where
 * one side is simply "not here" wants a neutral for that side rather than a
 * second hue implying a second kind.
 */
export function Donut({ slices, label, total, caption, size = 92, legend = 'below' }: {
  slices: { name: string; value: number; color: string }[]
  /** Where the legend sits. Below by default; beside the ring where the
   *  caller has the width for it and wants the ring to lead. */
  legend?: 'below' | 'right'
  /** Sits under the total, inside the hole. */
  label?: string
  /** The figure in the hole. Defaults to the sum of the slices. */
  total?: number
  /** Read out to assistive technology in place of the arcs. */
  caption?: string
  size?: number
}) {
  const sum = slices.reduce((a, s) => a + s.value, 0)
  const shown = total ?? sum
  /* The arcs sweep out from nothing the first time the ring is on screen,
     like every other chart here. Until then each arc has zero length and the
     figure in the hole stands alone. */
  const [ring, grown] = useGrowIn<HTMLSpanElement>()
  const r = 27
  const c = 2 * Math.PI * r
  const live = slices.filter((s) => s.value > 0)
  /* 2px of the card's surface between arcs, in the viewBox's own units. */
  const gap = live.length > 1 ? (2 / size) * 64 : 0

  /* Offsets come from a running sum computed per slice rather than by
     mutating a counter from inside `map`. Same arithmetic, and it leaves no
     variable being written during a render that React may discard and re-run,
     which is what the immutability lint is for. */
  const arcs = live.map((s, i) => {
    const before = live.slice(0, i).reduce((a, x) => a + x.value, 0)
    const frac = sum > 0 ? s.value / sum : 0
    return {
      ...s,
      len: Math.max(0, frac * c - gap),
      off: -(sum > 0 ? (before / sum) * c : 0),
    }
  })

  /* `right` keeps the legend beside the ring. In a narrow container — one
     column on a phone — three of these stacked had their rings at three
     different x positions, because each ring-and-legend pair was centered as
     a block and the legends differ in width. There the pair becomes two equal
     halves of the container: the ring ends at the center line and the legend
     starts from it, so every ring sits at the same x and the column reads as
     one. Judged by the nearest container rather than the window, since the
     caller's row is what decides. Equal halves unless half is narrower than
     the ring or the legend, when that half takes what it needs rather than
     letting the ring spill past its box. */
  return (
    <div className={legend === 'right'
      ? 'flex items-center gap-3 @max-[420px]:grid @max-[420px]:w-full @max-[420px]:grid-cols-[repeat(2,minmax(max-content,1fr))]'
      : 'flex flex-col items-center gap-2'}>
      <span ref={ring} data-grown={grown ? '1' : '0'}
            className="relative inline-grid shrink-0 place-items-center @max-[420px]:justify-self-end">
        <svg viewBox="0 0 64 64" width={size} height={size} className="-rotate-90"
             role="img" aria-label={caption}>
          {/* Only when the slices leave something unaccounted for. Two parts
              of a whole always fill the circle, and a track showing through
              the gaps invited the reader to look for a third thing. */}
          {sum === 0 && (
            <circle cx="32" cy="32" r={r} fill="none"
                    stroke="var(--color-line)" strokeWidth="5" />
          )}
          {arcs.map((a, i) => (
            <circle key={a.name} cx="32" cy="32" r={r} fill="none"
                    stroke={a.color} strokeWidth="5" strokeLinecap="butt"
                    style={{
                      /* As a style rather than an attribute so the transition
                         has a CSS property to run on. */
                      strokeDasharray: grown ? `${a.len} ${c - a.len}` : `0 ${c}`,
                      strokeDashoffset: a.off,
                      transition: `stroke-dasharray ${GROW_MS}ms ${GROW_EASE}`,
                      transitionDelay: `${i * 90}ms`,
                    }} />
          ))}
        </svg>
        <span className="absolute grid place-items-center">
          <span className="text-[20px] font-semibold leading-none tabular-nums
                           text-[var(--color-ink)]">
            {shown.toLocaleString()}
          </span>
          {label && (
            <span className="mt-0.5 text-[10px] uppercase tracking-wide
                             text-[var(--color-ink-3)]">
              {label}
            </span>
          )}
        </span>
      </span>
      <ul className={legend === 'right'
        ? 'grid gap-1 @max-[420px]:justify-self-start'
        : 'flex flex-wrap justify-center gap-x-3 gap-y-0.5'}>
        {slices.map((s) => (
          <li key={s.name}
              className="flex items-center gap-1.5 text-[12px] text-[var(--color-ink-3)]">
            <span className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: s.value > 0 ? s.color : 'var(--color-line)' }} />
            <span className="tabular-nums font-medium text-[var(--color-ink)]">
              {s.value.toLocaleString()}
            </span>
            {s.name}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A reading's recent history in a box the size of a word.
 *
 * One slot per period, oldest on the left, scaled to its own maximum: this
 * sits beside a single figure and only has to show the shape of the last few
 * of them. A slot with nothing measured keeps its place and gets a mark on
 * the baseline, because a bar of zero height would read as a measurement of
 * zero, and the row would otherwise shift left whenever one went unmeasured.
 *
 * Hovering a slot shows its period and value at once, in the same tooltip the
 * column chart uses. The browser's own title tooltip was tried first and took
 * a second to appear, which on a six-pixel bar reads as nothing happening.
 */
export function Sparkbars({ values, tips, label, color = 'var(--color-accent)', height = 28,
                            line }: {
  /** One entry per slot, oldest first; null where nothing was measured. */
  values: (number | null)[]
  /** One per slot, shown on hover: the period and its value, or that there
   *  was none. */
  tips: string[]
  /** What the strip shows, for anyone not looking at it. */
  label: string
  color?: string
  height?: number
  /** A level to draw across the strip: the speed paid for, so each bar reads
   *  as above or below it. Part of the scale, so it is always on the strip
   *  and never clipped off the top when every reading falls short. */
  line?: { value: number; title: string } | null
}) {
  const [box, grown] = useGrowIn<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  /* With a line, the scale is stretched a little past the largest value, so
     a plan nobody is reaching draws a few pixels below the strip's top edge
     rather than on it: on the edge it read as a border, not a level. */
  const peak = Math.max(0, ...values.map((v) => v ?? 0), line?.value ?? 0)
  const max = line ? peak / 0.86 : peak
  const n = values.length
  return (
    <div ref={box} data-grown={grown ? '1' : '0'} role="img" aria-label={label}
         /* Its own width: in a grid cell it would stretch to the cell, and the
            plan line with it, far past the last bar. */
         className="relative flex w-max shrink-0 items-end gap-[2px]" style={{ height }}
         onMouseLeave={() => setHover(null)}>
      {/* In the strip's own color, over the bars, with a shadow beneath: the
          shadow is what separates it from a bar that reaches the same height,
          and it is only visible where a bar is there to catch it. Ink was
          tried and read as an axis. */}
      {line && max > 0 && (
        <span data-plan-line aria-hidden="true" title={line.title}
              className="pointer-events-none absolute inset-x-0 z-[1] h-px"
              /* Dotted, the same way as the history charts: a gradient under a
                 drop-shadow, so the shadow follows the dots. */
              style={{ bottom: `${(line.value / max) * 100}%`,
                       backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 2px, transparent 2px 5px)`,
                       filter: 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45))' }} />
      )}
      {values.map((v, i) => (
        /* The whole slot is the hit target, baseline to top, not just the bar
           in it: the bars are thin and the short ones are very short. */
        <span key={`${tips[i]}-${i}`} data-tip={tips[i]}
              className="relative flex h-full w-[7px] cursor-default items-end"
              onMouseEnter={() => setHover(i)}>
          {v == null || max === 0
            ? <span data-empty className="block h-[2px] w-full rounded-full bg-[var(--color-line)]" />
            : <span data-bar className="block w-full rounded-t-[2px]"
                    style={{
                      height: grown ? `${Math.max(v / max, 0.06) * 100}%` : 0,
                      background: color,
                      opacity: hover == null || hover === i ? 1 : 0.45,
                      transition: `height ${GROW_MS}ms ${GROW_EASE}, opacity 120ms`,
                      transitionDelay: `${(i / Math.max(n - 1, 1)) * STAGGER_MS}ms, 0ms`,
                    }} />}
        </span>
      ))}
      {hover != null && tips[hover] && (
        <div role="tooltip"
             className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5
                        -translate-x-1/2 whitespace-nowrap rounded-md border
                        border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1
                        text-[11px] tabular-nums shadow-lg">
          {tips[hover]}
        </div>
      )}
    </div>
  )
}
