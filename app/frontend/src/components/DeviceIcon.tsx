import { DEVICE_ICONS, EERO_ICONS, GENERIC_EERO } from '../lib/deviceIcons'

/* Renders the glyph for a device type or an eero node, from lib/deviceIcons:
   Tabler Icons for device types and outlines drawn for Eeronaut for the eeros.
   They use currentColor, so they take the surrounding text color. Unknown
   types fall back to the generic device glyph. */

const FALLBACK = DEVICE_ICONS.generic
  ?? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>'

export function DeviceIcon(
  { type, size = 20, className = '' }:
  { type?: string | null; size?: number; className?: string },
) {
  const svg = (type && DEVICE_ICONS[type]) || FALLBACK
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, display: 'inline-block', lineHeight: 0 }}
      className={`shrink-0 text-[var(--color-ink-2)] [&>svg]:h-full [&>svg]:w-full ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/* eero names its hardware internally (merci, eden, jupiter), and the glyphs are
   filed under those names. The API only reports the product name, so this maps
   between them. Taken from the app's own setup strings (v3_setup_eero_*), so
   the pairing is eero's rather than a guess.

   Longest names first: "eero Pro 6E" must not match the "eero Pro 6" rule. */
const MODEL_CODENAMES: [string, string][] = [
  ['eero outdoor 7', 'snowbird'],
  ['eero poe gateway', 'crane'],
  ['eero pro 6e', 'trieste'],
  ['eero max 7', 'jupiter'],
  ['eero poe 6', 'hornbill'],
  ['eero poe 7', 'novo'],
  ['eero pro 6', 'eden'],
  ['eero pro 7', 'merci'],
  ['eero beacon', 'piccino'],
  ['eero pro', 'unico'],
  ['eero 6+', 'firefly'],
  ['eero 6', 'andytown'],
  ['eero 7', 'patria'],
]

function eeroGlyph(model?: string | null): string {
  const name = (model ?? '').trim().toLowerCase()
  if (name) {
    for (const [product, codename] of MODEL_CODENAMES) {
      if (name.startsWith(product) && EERO_ICONS[codename]) {
        return EERO_ICONS[codename]
      }
    }
  }
  return GENERIC_EERO
}

const cautionSize = (size: number) =>
  Math.max(10, Math.min(size * 0.5, 20))

/** A glyph, optionally carrying a caution mark.
 *
 *  The mark belongs to whichever device has the fault. An eero Signal with no
 *  cellular connection is the Signal's problem, not the eero it plugs into, so
 *  the eero it hangs off stays unmarked. */
function Glyph({ svg, size, className = '', issue }:
  { svg: string; size: number; className?: string; issue?: string | null }) {
  const glyph = (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, display: 'inline-block', lineHeight: 0 }}
      className={`shrink-0 text-[var(--color-accent)] [&>svg]:h-full [&>svg]:w-full ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
  if (!issue) return glyph
  return (
    <span className="relative inline-block shrink-0" title={issue}
          style={{ width: size, height: size, lineHeight: 0 }}>
      {glyph}
      <svg viewBox="0 0 24 24" role="img" aria-label={issue}
           className="absolute -bottom-0.5 -right-0.5 text-[var(--color-warn)]"
           // Half the glyph reads right on a small icon but dominates a large
           // one, so the mark stops growing once it is big enough to see.
           style={{ width: cautionSize(size), height: cautionSize(size) }}
           fill="currentColor">
        <title>{issue}</title>
        {/* A filled triangle on the surface color so it reads against the
            glyph underneath, as the eero app draws it. */}
        <path d="M12 2 23 21H1L12 2Z" stroke="var(--color-surface)" strokeWidth="2"
              strokeLinejoin="round" paintOrder="stroke" />
        <path d="M11 9h2v6h-2zm0 7h2v2h-2z" fill="var(--color-surface)" />
      </svg>
    </span>
  )
}

export function EeroIcon(
  { model, size = 22, className = '', issue }:
  { model?: string | null; size?: number; className?: string
    issue?: string | null },
) {
  return <Glyph svg={eeroGlyph(model)} size={size} className={className}
                issue={issue} />
}

/** The eero Signal, which eero files internally as "retrograde". */
export function SignalIcon({ size = 18, className = '', issue }:
  { size?: number; className?: string; issue?: string | null }) {
  return <Glyph svg={EERO_ICONS.retrograde ?? GENERIC_EERO} size={size}
                className={className} issue={issue} />
}


/**
 * A USB-C port, for the link between an eero and the eero Signal plugged
 * into it. The outline is Material Design Icons' `usb-c-port`
 * (Pictogrammers, Apache-2.0), inlined rather than pulled in as a dependency
 * for the sake of one shape. Drawn at the plug's height so the two sit alike
 * on the mesh diagram's stems.
 */
export function UsbCIcon({ size = 14, className = '', title }:
  { size?: number; className?: string; title?: string }) {
  return (
    /* Green, like the data cable beside it on the same diagrams. Both mark a
       physical connection that is up; the blue this used to wear read as the
       network's accent rather than as a link's state, so the two glyphs on one
       line said different things about the same kind of fact. */
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}
         role="img" aria-label={title} style={{ color: 'var(--color-ok)' }}
         fill="currentColor">
      {title && <title>{title}</title>}
      <path d="M6 12H18C18.55 12 19 12.45 19 13C19 13.55 18.55 14 18 14H6C5.45 14 5 13.55 5 13C5 12.45 5.45 12 6 12M6 10C4.34 10 3 11.34 3 13C3 14.66 4.34 16 6 16H18C19.66 16 21 14.66 21 13C21 11.34 19.66 10 18 10H6M6 8H18C20.76 8 23 10.24 23 13C23 15.76 20.76 18 18 18H6C3.24 18 1 15.76 1 13C1 10.24 3.24 8 6 8Z" />
    </svg>
  )
}


/**
 * A data cable: the app's one mark for a wired link, on the network diagrams'
 * lines, in the node drawer's uplink row and beside a cabled client. Material
 * Design Icons' `cable-data` (Pictogrammers, Apache-2.0), inlined for the same
 * reason as the USB-C port above. Green, as the app draws every wired mark.
 */
export function CableDataIcon({ size = 14, className = '', title }:
  { size?: number; className?: string; title?: string }) {
  return (
    /* Named by its title where it stands alone; decorative where a wrapper
       already names the mark, as the Clients table's does. */
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}
         role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}
         aria-label={title} style={{ color: 'var(--color-ok)' }}
         fill="currentColor">
      {title && <title>{title}</title>}
      <path d="M7.05 3.5C5.68 4.88 5.68 7.1 7.05 8.47L15.54 16.95C16.12 17.54 16.12 18.5 15.54 19.07C14.95 19.66 14 19.66 13.41 19.07L9.17 14.83L10.23 13.77L6.7 10.23L6.34 10.59L4.93 9.17C4.54 8.78 3.91 8.78 3.5 9.17L2.1 10.59C1.71 11 1.71 11.61 2.1 12L3.5 13.41L3.16 13.77L6.7 17.3L7.76 16.24L12 20.5C13.37 21.85 15.58 21.85 16.95 20.5C18.32 19.12 18.32 16.9 16.95 15.54L8.46 7.05C7.88 6.46 7.88 5.5 8.46 4.93C9.05 4.34 10 4.34 10.59 4.93L14.83 9.17L13.77 10.23L17.3 13.77L17.66 13.41L19.07 14.83C19.46 15.22 20.1 15.22 20.5 14.83L21.9 13.41C22.29 13 22.29 12.39 21.9 12L20.5 10.59L20.84 10.23L17.3 6.7L16.24 7.76L12 3.5C10.63 2.15 8.42 2.15 7.05 3.5M2.81 11.29L4.22 9.88L5.64 11.29L4.22 12.71M18.36 12.71L19.78 11.29L21.19 12.71L19.78 14.12Z" />
    </svg>
  )
}
