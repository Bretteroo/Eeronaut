import { CableDataIcon, UsbCIcon } from './DeviceIcon'
import { SignalBars } from './primitives'
import { meshBars } from '../lib/signal'

/* The lines and link badges the network diagrams share — the eero Mesh on
   the dashboard and the network map on Topology — so the two draw a link the
   same way. The line is the network's blue with traffic drifting both ways
   (see .mesh-stem in index.css); the kind of link is said by the glyph riding
   it rather than by color. */

export type LinkKind = 'wired' | 'wireless' | 'usb'

/** A line in a diagram. `still` for a link carrying nothing: gray, no motion. */
export function Stem({ dir, still = false, className = '' }:
  { dir: 'v' | 'h'; still?: boolean; className?: string }) {
  return (
    <div aria-hidden
         className={`${still ? 'mesh-stem-down' : `mesh-stem mesh-stem-${dir}`} rounded-full ${className}`} />
  )
}

/**
 * The kind of link, as a glyph in a small squircle of the raised surface with
 * the network's blue edge, riding the line: a data cable for a wired link, the
 * mesh's own signal bars for a radio link, a USB-C port for a Signal on its
 * eero.
 *
 * The badge is wider than the widest thing that goes in it, with room to
 * spare. The bars are 18px across and 14px tall at the size they are drawn
 * everywhere else in the app, and they used to be squeezed into a 24px badge
 * by a 0.7 transform — which put 3px bars on 2.1px and 2px gaps on 1.4px, so
 * every edge landed between pixels and the diagram showed a smear leaning
 * against the right-hand border rather than bars. The badge grew instead, the
 * bars are drawn at their own size, and there is no transform.
 *
 * Sized to the four-bar meter. It was 36px when the mesh meter still drew five
 * bars; keeping that after the meters were standardized left the glyph
 * floating in the middle of a box half again its size.
 */
export function LinkBadge({ kind, bars, title }:
  { kind: LinkKind; bars?: number | null; title: string }) {
  return (
    <span data-link-glyph={kind} title={title}
          className="relative grid size-[32px] place-items-center rounded-[10px]
                     border border-[var(--color-accent)] bg-[var(--color-surface-2)]">
      {kind === 'wired' ? <CableDataIcon size={20} title={title} />
        : kind === 'usb' ? <UsbCIcon size={18} title={title} />
        : <SignalBars value={meshBars(bars)} reading="none" />}
    </span>
  )
}
