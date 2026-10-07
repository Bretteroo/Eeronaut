import { useEffect, useMemo, useRef, useState } from 'react'
import { api, lastRead } from '../lib/api'
import { Card, DataTable, SkeletonRows, type Column } from './primitives'
import { PlusWhy, usePlusGate } from '../lib/capabilities'
import { AXIS_TYPE, AXIS_Y, AXIS_W, GROW_EASE, GROW_MS, useGrowIn } from './charts'
import { t } from '../i18n'

/* Where this network's radios sit on the air, band by band.

   The question it answers is one eero's own app will not: have two of your
   eeros landed on the same channel. They often have — eero picks channels per
   node and nothing tells you when two nodes pick alike — and on 2.4 GHz, where
   only three channels do not overlap, two eeros stacked on channel 1 are
   competing with each other for air that is already scarce.

   Drawn rather than tabulated because overlap is a shape. A table of channel
   numbers says 1, 1, 44, 44; the same figures as arcs say it at a glance, and
   a 160 MHz channel sprawling across a stretch of the 5 GHz band looks like
   what it is.

   Each arc is the real width of air a radio holds: centered on the channel's
   center frequency, as wide as the channel width eero reports, as tall as the
   airtime that channel is using. Height is airtime rather than transmit power
   on purpose — tx_power is all but constant across a network's radios, so a
   chart drawn from it would be a row of identical humps.

   This is not a site survey and cannot become one. A running eero reports a
   neighbor's name and signal and nothing else — no channel, no width — so
   nothing here can be drawn for the networks around you. The detailed scan
   that carries a frequency is served only while a node is in setup mode.

   Built to the same rules as the charts in `charts.tsx`, which is where the
   type and the gutter come from. Two of those rules matter most here. The
   viewBox is the element's measured width, so one unit is one pixel and
   nothing is stretched. And no text lives inside the SVG: labels are HTML
   positioned over the plot, because text in a stretched viewBox renders at a
   different size from every other chart's and distorts with the box. */

interface Radio {
  band: string | null
  raw_band: string | null
  channel: number | null
  center_freq_mhz: number | null
  width: number | null
  busyness: number | null
  clients: number | null
  tx_power: number | null
}
interface Node { location: string; serial: string; radios: Radio[] }
type Row = Radio & { node: string; color: string }

/* Each band's own stretch of air, and the channels worth a tick.

   The span is the band's usable channels rather than its formal edges: 6 GHz
   runs to 7125 MHz on paper, and drawing to there left every arc squeezed
   into a corner with a third of the plot empty. Fixed all the same, so a
   radio at one end of a band looks like it is at one end — an axis that
   moves with the data cannot show that. */
const BANDS: { key: string; label: string; lo: number; hi: number
               ticks: number[]; note: string }[] = [
  { key: '2.4', label: 'band.2_4', lo: 2401, hi: 2483,
    /* Every other channel, evenly spaced. An earlier list slipped 6 in
       between 5 and 7 because 1, 6 and 11 are the non-overlapping ones — and
       an axis with one tick closer to its neighbor than the rest reads as a
       mistake, whatever the reason for it. */
    ticks: [1, 3, 5, 7, 9, 11, 13], note: 'radio_channels.note_24' },
  { key: '5', label: 'band.5', lo: 5170, hi: 5835,
    ticks: [36, 52, 64, 100, 116, 132, 149, 165], note: 'radio_channels.note_5' },
  { key: '6', label: 'band.6', lo: 5945, hi: 7115,
    ticks: [1, 37, 69, 101, 133, 165, 197, 229], note: 'radio_channels.note_6' },
]

/* Six steps alternating blue and teal, light and dark, so any two
   neighboring arcs differ in both. The palette is this narrow on purpose:
   warm colors mean trouble everywhere else in the app, and an arc that is
   merely a different radio must not read as a warning. Assigned in a fixed
   order and never cycled — a seventh radio reuses the last color, and its
   label is what tells it apart. */
const INK = ['#006fff', '#10a5a0', '#6aa5ff', '#0b6b66', '#0b4f9e', '#63c9c4']

const HEIGHT = 150

/** Which of the three bands a radio is on, from eero's own band name. */
function bandKey(raw: string | null, label: string | null): string | null {
  const s = `${raw ?? ''} ${label ?? ''}`.toLowerCase()
  if (s.includes('6')) return '6'
  if (s.includes('2_4') || s.includes('2.4')) return '2.4'
  if (s.includes('5')) return '5'
  return null
}

/* The stretch a radio actually holds, from the primary channel eero names.

   eero reports the center of the *primary* 20 MHz channel and nothing about
   where the wider block around it sits. Centering the reported width on that
   center is wrong, and wrong outwards: a 160 MHz channel on primary 44 came
   out at 5140-5300 when the block is really 5170-5330, which put its left
   foot 30 MHz outside the band and drew it over the edge of the chart.

   The block is recoverable, because 802.11 aligns them. Channels step every
   20 MHz from a fixed first edge — 5170 on 5 GHz, 5945 on 6 — and a block of
   width W begins on a multiple of W from there. So the block containing a
   primary channel is the one its low edge falls in.

   2.4 GHz has no such grid and its channels overlap by design, so a channel
   there is its own 20 MHz and nothing is inferred. */
const BAND_BASE: Record<string, number | null> = { '2.4': null, '5': 5170, '6': 5945 }

function blockMhz(band: string, center: number, width: number): [number, number] {
  const base = BAND_BASE[band]
  if (base == null || width <= 20) return [center - width / 2, center + width / 2]
  const i = Math.floor((center - 10 - base) / width)
  return [base + i * width, base + (i + 1) * width]
}

/** A channel's center, for ticks that may have no radio on them. */
function tickMhz(band: string, ch: number): number {
  if (band === '2.4') return 2407 + 5 * ch
  if (band === '6') return 5950 + 5 * ch
  return 5000 + 5 * ch
}

export function RadioChannels() {
  const cap = usePlusGate('channel_utilization')
  /* Opens on the last answer; the read below asks for a new one. */
  const [nodes, setNodes] = useState<Node[] | null>(
    () => lastRead<Node[]>('/api/eeros/radios') ?? null)
  const [band, setBand] = useState<string | null>(null)

  useEffect(() => {
    if (!cap.ready || cap.needsPlus) return
    api.get<Node[]>('/api/eeros/radios').then(setNodes).catch(() => setNodes([]))
  }, [cap.ready, cap.needsPlus])

  /* Every radio, flattened, with the eero carrying it and a color of its own.
     Colored across the whole network rather than per band, so an eero keeps
     its color as the toggle moves. */
  const all: Row[] = useMemo(() => {
    const out: Row[] = []
    ;(nodes ?? []).forEach((n, i) => {
      for (const r of n.radios) out.push({ ...r, node: n.location, color: INK[i % INK.length] })
    })
    return out
  }, [nodes])

  const present = useMemo(() => BANDS.filter(
    (b) => all.some((r) => bandKey(r.raw_band, r.band) === b.key)), [all])
  const shown = present.find((b) => b.key === band) ?? present[0] ?? null
  /* Memoized so it is the same array until the band or the radios change:
     `marks` below is keyed on it, and a fresh filter on every render made
     that memo recompute every time. */
  const rows = useMemo(() => (shown
    ? all.filter((r) => bandKey(r.raw_band, r.band) === shown.key)
    : []), [all, shown])

  /* The axis tops out at a round number above the tallest arc, like every
     other chart here, rather than at the tallest arc itself — a plot whose
     highest value always touches the ceiling cannot show a quiet band. */
  const peak = Math.max(...rows.map((r) => r.busyness ?? 0), 0)
  /* Fifths rather than quarters, so the middle tick is a whole number. A
     ceiling of 25 gave a midpoint of 12.5% and 75 gave 37.5%, which is a
     fussy thing to read on an axis whose values are all integers. */
  const top = [20, 40, 60, 80, 100].find((v) => peak <= v) ?? 100
  const ticks = [0, top / 2, top]

  /* One SVG unit is one CSS pixel, so nothing in the drawing is stretched. */
  const box = useRef<HTMLDivElement | null>(null)
  const [W, setW] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width)
      if (w > 0) setW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* Which arc is being pointed at, so the row it belongs to can say so — and
     the other way round. The chart and the table are two readings of the same
     six radios, and until they were linked, matching one to the other meant
     reading a channel number off a label and hunting for it below. */
  const [lit, setLit] = useState<string | null>(null)
  const idOf = (r: Row) => `${r.node}-${r.channel}`

  const [fig, grown] = useGrowIn<HTMLElement>()
  /* Redrawn from nothing when the band changes, the way the bar charts drop
     their bars and grow the new ones rather than sliding one shape into
     another.

     Two frames, not a timer. The arcs have to be painted at zero once before
     the transition to their real height means anything, and a timeout raced
     the paint: sometimes the browser had not drawn the zero state when the
     second state arrived, and the arcs simply appeared at full size. A frame
     is the thing being waited for, so it is the thing to wait on. */
  const [readyFor, setReadyFor] = useState<string | null>(null)
  useEffect(() => {
    const band = shown?.key ?? null
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReadyFor(band))
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [shown?.key, nodes])
  /* Which band the arcs on screen have grown for, rather than a flag saying
     they have grown. The flag was cleared in the effect above, which runs
     after the browser has painted — so pressing 6 GHz drew that band's arcs
     at full height for a frame, then dropped them and grew them again, and
     what you saw depended on how fast those frames came: usually a jump into
     place, occasionally a shrink and a regrow. Comparing against the band
     instead makes the zero state part of the render that introduces the new
     arcs, so their first paint is the flat one every time. */
  const show = grown && readyFor === (shown?.key ?? null)

  /* What the axis spans: the band's own stretch, widened where an arc needs
     more than it.

     The span is the band's rather than a fit to the data, so that a radio at
     one end of a band looks like it is at one end — an axis that moves with
     whatever is on it cannot show that. But a channel near the end of a band
     reaches past it: 160 MHz centered on channel 44 runs from 5140 and 5 GHz
     starts at 5170, so that arc's left foot was cut off at the axis, and
     half a hump reads as a drawing error whatever it means. So the span
     gives way to an arc by exactly as much as the arc needs, and is the
     band's everywhere else. */
  const feet = shown ? rows.flatMap((r) => {
    const c = r.center_freq_mhz
    if (!c) return []
    const half = (r.width ?? 20) / 2
    return [c - half, c + half]
  }) : []
  const span = shown
    ? { lo: Math.min(shown.lo, ...feet), hi: Math.max(shown.hi, ...feet) }
    : { lo: 0, hi: 1 }

  const x = (mhz: number) => ((mhz - span.lo) / (span.hi - span.lo)) * W

  /* Each arc's geometry, worked out once. The arc and the name over it have
     now drifted apart twice — first because they read different flags for the
     height, then because the arc moved to the block while the label stayed on
     the primary channel, which showed up the moment a channel was wider than
     20 MHz. They read one answer now, and there is nowhere for a third
     opinion to come from. */
  /* The channels the axis marks: the band's regular spacing, plus every
     channel a radio is actually on.

     Without the second half the picture and the table could not be read
     together. The table says a radio is on channel 44; the axis had 36 and 52
     and nothing between, and the arc — correctly centered on the 160 MHz block
     that channel sits in, which is not centered on the channel — peaked
     between the two. Everything was right and it read as wrong, because
     nothing on the axis said where 44 was. A regular tick within half a step
     of a radio's own gives way to it rather than crowding it. */
  const marks = useMemo(() => {
    if (!shown) return [] as { ch: number; live: boolean }[]
    const live = [...new Set(rows.map((r) => r.channel).filter(
      (c): c is number => typeof c === 'number'))]
    const step = shown.ticks.length > 1 ? shown.ticks[1] - shown.ticks[0] : 8
    const kept = shown.ticks.filter(
      (c) => !live.some((l) => Math.abs(l - c) < step / 2))
    return [...kept.map((ch) => ({ ch, live: false })),
            ...live.map((ch) => ({ ch, live: true }))]
      .sort((a, b) => a.ch - b.ch)
  }, [shown, rows])

  /* Every arc is a symmetrical hump, as wide as the radio's channel and
     centered on that channel — the same shape at every width, in every band,
     with its top over the tick it belongs to.
   *
   * It is drawn on the channel rather than on the 802.11 block the channel
   * sits in. The block is where the air really is, and the table's own
   * frequency column still reports it; but a block wider than 20 MHz is not
   * centered on its primary channel, so drawing the block puts the top of
   * the hump somewhere that is not the number under it — 160 MHz on primary
   * 44 holds 5170 to 5330 and tops out at 5250, a quarter of the way to the
   * next tick. Leaning the arc to fix that made the shape lopsided instead.
   * The picture is about which radios sit on top of each other and how much
   * air each is using; for that, a symmetrical hump on the channel reads
   * true and a 30 MHz offset does not. A wide channel near the end of a
   * band can now reach past the axis, and is cut there, which says "off the
   * end" as plainly as anything else could. */
  const drawn = rows.map((r, i) => {
    const center = r.center_freq_mhz ?? 0
    /* A radio that reports no width falls back to 20 MHz, the narrowest any
       of them runs: it understates the sprawl rather than inventing it. */
    const half = (r.width ?? 20) / 2
    const [flo, fhi] = [center - half, center + half]
    return {
      r, i, flo, fhi,
      left: x(flo),
      right: x(fhi),
      peak: x(center),
      share: top > 0 ? Math.min(1, (r.busyness ?? 0) / top) : 0,
    }
  })

  const cols: Column<Row>[] = [
    { key: 'e', header: 'eero', sortValue: (r) => r.node,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-full"
                style={{ background: r.color }} aria-hidden="true" />
          {r.node}
        </span>
      ) },
    { key: 'c', header: t('radio_channels.channel'), numeric: true,
      sortValue: (r) => r.channel, render: (r) => r.channel ?? '—' },
    /* The block the radio holds, worked out from the primary channel by the
       alignment 802.11 gives it — not the center plus or minus half the
       width, which is wrong by up to 70 MHz on a wide channel.

       So this column and the arc above it do not agree to the megahertz on
       a wide channel, and that is on purpose: the number is the frequencies
       the radio really occupies, and the arc is a symmetrical hump over the
       channel those frequencies belong to. Reading the exact edges off a
       drawing 600 pixels wide was never the point of it; the column is
       where that question is answered. */
    { key: 'f', header: t('radio_channels.range'), numeric: true,
      sortValue: (r) => r.center_freq_mhz,
      render: (r) => {
        if (!r.center_freq_mhz || !shown) return '—'
        const [lo, hi] = blockMhz(shown.key, r.center_freq_mhz, r.width ?? 20)
        return t('radio_channels.mhz_to', { lo: Math.round(lo), hi: Math.round(hi) })
      } },
    { key: 'w', header: t('radio_channels.width'), numeric: true,
      sortValue: (r) => r.width,
      render: (r) => (r.width ? t('radio_channels.n_mhz', { n: r.width }) : '—') },
    { key: 'u', header: t('radio_channels.airtime'), numeric: true,
      sortValue: (r) => r.busyness,
      render: (r) => (typeof r.busyness === 'number' ? `${r.busyness}%` : '—') },
    { key: 'n', header: t('nav.clients'), numeric: true,
      sortValue: (r) => r.clients, render: (r) => r.clients ?? '—' },
  ]

  if (cap.hidden) return null

  return (
    <Card icon="radio" title={t('radio_channels.title')} anchor="channels"
          plus="channel_utilization"
          action={cap.needsPlus || present.length < 2 ? undefined : (
            <div className="flex gap-1" role="group"
                 aria-label={t('radio_channels.band')}>
              {present.map((b) => (
                <button key={b.key} type="button"
                  onClick={() => setBand(b.key)}
                  aria-pressed={shown?.key === b.key}
                  className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                    shown?.key === b.key
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent-ink)]'
                      : 'border-[var(--color-line-strong)] text-[var(--color-ink-2)]'}`}>
                  {t(b.label)}
                </button>
              ))}
            </div>
          )}>
      {cap.needsPlus ? (
        <PlusWhy>{t('radio_channels.part_eero_plus')}</PlusWhy>
      ) : nodes === null ? (
        <SkeletonRows rows={4} cols={3} label={t('radio_channels.loading')} />
      ) : !shown ? (
        <p className="text-[13px] text-[var(--color-ink-3)]">
          {t('radio_channels.no_radios')}
        </p>
      ) : (<>
        <figure ref={fig as React.Ref<HTMLElement>} className="m-0"
                data-grown={show ? '1' : '0'} data-band={shown.key}>
          <div className="flex gap-2" style={{ height: HEIGHT }}>
            {/* Bottom-up, so the first tick is the baseline. */}
            <div className={`flex flex-col-reverse justify-between py-[2px] ${AXIS_Y}`}
                 style={{ width: AXIS_W }}>
              {ticks.map((v, i) => <span key={i}>{`${v}%`}</span>)}
            </div>
            <div className="relative min-w-0 flex-1" ref={box}>
              {ticks.map((_, i) => (
                <span key={i} aria-hidden="true"
                      className="absolute inset-x-0 border-t border-[var(--color-line)]"
                      style={{ bottom: `${(i / (ticks.length - 1)) * 100}%` }} />
              ))}
              {/* A rule at each labeled channel, so an arc can be read back
                  to the channel it is on. */}
              {marks.map(({ ch, live }) => (
                <span key={ch} aria-hidden="true"
                      className={`absolute inset-y-0 border-l ${
                        live ? 'border-[var(--color-line-strong)]'
                             : 'border-dashed border-[var(--color-line)]'}`}
                      style={{ left: `${(x(tickMhz(shown.key, ch)) / W) * 100}%` }} />
              ))}

              <svg viewBox={`0 0 ${W} ${HEIGHT}`} className="absolute inset-0 size-full"
                   /* Mapped straight onto the element rather than fitted and
                      centered. With the default the drawing is letterboxed
                      whenever the measured width has not caught up with the
                      real one, which shifts every arc horizontally — lining
                      up in the middle of the plot and drifting further out
                      the nearer an arc is to an edge. The labels are placed
                      as percentages of the same box and so never moved,
                      which is what made the mismatch visible. `LineChart`
                      carries the same attribute for the same reason. */
                   preserveAspectRatio="none"
                   /* Only the arcs take the pointer; the box between them is
                      not a target. */
                   pointerEvents="none"
                   /* Clipped, not spilling. Every block computed above lies
                      inside its band by construction, so this only ever
                      catches a width eero reports that nothing here expects —
                      and a shape cut at the axis says "off the end" where one
                      drawn across the card says nothing. */
                   style={{ overflow: 'hidden' }} role="img"
                   aria-label={t('radio_channels.chart_caption', { band: t(shown.label) })}>
                {drawn.map(({ r, i, left, right, peak, share }) => {
                  /* Drawn full height and scaled from the baseline, so it
                     grows and shrinks exactly the way a bar does — one
                     transform, transitioned, rather than a new path.

                     One quadratic, which is a parabola: it rises from the
                     baseline at an angle and comes down at the same one.
                     Two cubics meeting at the top drew the same peak with
                     flat feet, and a hump that leaves the axis horizontally
                     reads as a plateau with the ends smeared out rather
                     than as an arc. The control point is twice the height
                     because a quadratic passes half way to it. */
                  const curve = `M ${left} ${HEIGHT} Q ${peak} ${-HEIGHT} ${right} ${HEIGHT}`
                  const rise = {
                    transformOrigin: `0px ${HEIGHT}px`,
                    transform: `scaleY(${show ? share : 0})`,
                    transition: `transform ${GROW_MS}ms ${GROW_EASE}`,
                  }
                  return (
                    <g key={`${r.node}-${r.channel}-${i}`}
                       onMouseEnter={() => setLit(idOf(r))}
                       onMouseLeave={() => setLit(null)}
                       /* The filled body is what the pointer can land on: a
                          stroke alone is two pixels of target, and the empty
                          space under an arc still belongs to it. */
                       style={{ pointerEvents: 'auto' }}>
                      {/* Two paths, because the closed one is what can be
                          filled and the open one is what should be stroked.
                          One path doing both drew a line along the baseline
                          under every arc, which is the axis's job. */}
                      <path d={`${curve} Z`} fill={r.color}
                            fillOpacity={lit === idOf(r) ? 0.38 : 0.2}
                            stroke="none" style={rise} />
                      <path d={curve} fill="none" stroke={r.color}
                            strokeWidth={1.5} strokeLinejoin="round"
                            /* Without this the stroke is scaled with the
                               shape: a 4% arc squashed to a twenty-fifth of
                               its height had a stroke a twenty-fifth as
                               thick, which is no stroke at all. It is why
                               the 6 GHz arcs looked like fills with no
                               outline. */
                            vectorEffect="non-scaling-stroke" style={rise} />
                    </g>
                  )
                })}
              </svg>

              {/* Names as HTML, over the plot rather than inside the viewBox. */}
              {drawn.map(({ r, i, peak, share }) => {
                return (
                  <span key={`${r.node}-${i}`}
                    className="pointer-events-none absolute -translate-x-1/2
                               whitespace-nowrap text-[10px] font-medium"
                    style={{
                      left: `${(peak / W) * 100}%`,
                      /* On the apex, which is where the arc actually peaks:
                         the curve is drawn to the top of the plot and scaled
                         down, so its high point sits at the same share of the
                         height the arc was scaled to. Offset by the type's
                         own height so the word sits above the line rather
                         than across it. */
                      bottom: `calc(${Math.min(92, share * 100)}% + 2px)`,
                      color: r.color,
                      opacity: show ? 1 : 0,
                      transition: `opacity ${GROW_MS}ms ${GROW_EASE}`,
                    }}>{r.channel ? `${r.node} · ${r.channel}` : r.node}</span>
                )
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <span style={{ width: AXIS_W }} aria-hidden="true" />
            <div className="relative min-w-0 flex-1" style={{ height: 16 }}>
              {marks.map(({ ch, live }) => (
                <span key={ch}
                      className={`absolute -translate-x-1/2 pt-1 tabular-nums ${AXIS_TYPE} ${
                        live ? 'font-semibold text-[var(--color-ink-2)]' : ''}`}
                      style={{ left: `${(x(tickMhz(shown.key, ch)) / W) * 100}%` }}>
                  {ch}
                </span>
              ))}
            </div>
          </div>
          <figcaption className={`mt-1 flex justify-between ${AXIS_TYPE}`}>
            <span>{t('radio_channels.y_axis')}</span>
            <span>{t('radio_channels.x_axis')}</span>
          </figcaption>
        </figure>

        <div className="mt-3">
          <DataTable columns={cols} rows={rows} defaultSort={{ key: 'c' }}
                     rowKey={idOf}
                     highlight={(r) => lit === idOf(r)}
                     onRowHover={(r) => setLit(r ? idOf(r) : null)}
                     empty={t('radio_channels.none_on_band')} />
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {t(shown.note)}
        </p>
      </>)}
    </Card>
  )
}
