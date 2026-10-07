import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api'
import type { Capability, CapabilityReason, Prefs } from './api'
import { t } from '../i18n'

interface CapCtx {
  caps: Record<string, Capability>
  /** Whether the capability map has been read yet.
   *
   *  An unknown capability is treated as available, which is right for a name
   *  eero does not gate and wrong for every name in an empty map. Before the
   *  first read lands the map *is* empty, so a pane that fetches on mount
   *  fetched once as though it were entitled — which is how a network without
   *  eero Plus was served a card of radio analytics for the second it took
   *  the map to arrive. Anything that gates a fetch waits for this. */
  capsReady: boolean
  prefs: Prefs
  premiumActive: boolean
  /** Whether eero's cloud is answering. null before the first attempt lands.
   *  Lives here rather than in its own provider because it is the same kind of
   *  fact as `premiumActive`: app-wide, read from one place, and consulted by
   *  controls deciding whether they can work right now. */
  cloudOk: boolean | null
}

const Ctx = createContext<CapCtx>({
  caps: {},
  capsReady: false,
  premiumActive: false,
  cloudOk: null,
  prefs: {
    hide_subscription_gated: false,
    hide_capability_limited: false,
    hide_plus_badges: false,
    appearance: 'system',
    theme: '',
    clock_24h: false,
    language: 'auto',
  },
})

export const CapabilityProvider = Ctx.Provider
export const useCapabilities = () => useContext(Ctx)

/** Reasons the user has chosen to hide entirely rather than gray out. */
function isHidden(reason: CapabilityReason | null, prefs: Prefs): boolean {
  if (!reason) return false
  if (reason === 'subscription') return prefs.hide_subscription_gated
  if (reason === 'hardware' || reason === 'firmware')
    return prefs.hide_capability_limited
  return false
}

export function usePremiumActive() {
  return useCapabilities().premiumActive
}

export function useCapability(name: string) {
  const { caps, prefs } = useCapabilities()
  const cap = caps[name]
  // An unknown capability is treated as available: the map only lists things
  // eero gates, so absence means "not gated", not "forbidden".
  if (!cap) return { available: true, hidden: false, explanation: '', reason: null }
  return {
    available: cap.available,
    hidden: !cap.available && isHidden(cap.reason, prefs),
    explanation: cap.explanation,
    reason: cap.reason,
  }
}

/**
 * A subscription gate, for sections that gray themselves rather than using
 * `Gate`. Returns `needsPlus` and `hidden` together deliberately: the two were
 * worked out separately at four call sites and every one of them forgot the
 * second, so the hide-these-features setting did nothing there.
 */
export function usePlusGate(name: string) {
  const cap = useCapability(name)
  const { capsReady } = useCapabilities()
  return {
    ...cap,
    ready: capsReady,
    needsPlus: !cap.available && cap.reason === 'subscription',
  }
}

/**
 * Wraps a feature that eero may gate. Unavailable features stay in place,
 * grayed and inert, with the real reason attached — a hardware limitation is
 * never presented as a subscription limitation. If the user has opted to hide
 * that class of reason, the feature is removed from the layout entirely.
 */
export function Gate({ name, children, mark = true }: {
  name: string
  children: ReactNode
  /** Whether this draws its own hardware mark. Off where the host already has
   *  a corner for it — a card takes the sash through its `hardware` prop, and
   *  two marks on one pane would be saying it twice. */
  mark?: boolean
}) {
  const { available, hidden, explanation, reason } = useCapability(name)
  const premiumActive = usePremiumActive()
  /* Two different questions. Whether this is the hardware's doing decides
     what is said; whether *this* region draws the mark decides where it is
     drawn. Conflating them put the old pill back on the one pane whose card
     already carries the sash. */
  const hardware = useHardwareVisible(name)
  const hw = hardware && mark
  if (hidden) return null
  if (available) return <>{children}</>
  const needsPlus = reason === 'subscription' && !premiumActive
  return (
    /* A sash needs a corner, and an inline gated region has none — so one that
       carries the hardware mark takes a hairline border and a radius, which
       also does the work of saying which part of the pane is meant. */
    <div className={`select-none ${hw
          ? 'relative rounded-md border border-[var(--color-line)] p-3 pr-10' : ''}`}
         aria-disabled="true" title={explanation}>
      {/* The reason sits above the content and outside the dimmed layer: above
          because it is what explains everything below it and reading it after
          the fact is backwards, and outside because CSS opacity cannot be
          turned back up on a child.

          Nothing about eero Plus is said here. A subscription gate is marked
          by the sash on the feature's own corner, which reads the same on a
          subscribed network — saying it in both places produced the mark
          twice on the same control. */}
      {/* The chip is for the reasons that are neither a subscription nor the
          hardware — bridged mode, a role, a region, a rollout. Those have no
          mark of their own and the sentence is all there is to say. A
          subscription gets the eero Plus sash and the hardware gets the gray
          one, both in the corner this wrapper now provides. */}
      {!needsPlus && !hardware && explanation && (
        <div className="mb-1"><GateReasonChip explanation={explanation} /></div>
      )}
      {/* `inert`, not `pointer-events: none`. The second one takes the mouse
          away and leaves the keyboard: every switch inside a gated pane was
          still reachable by Tab and still wrote when pressed. */}
      <div className="dimmed" inert>{children}</div>
      {/* Outside the inert region, never inside it: `inert` cannot be undone
          by a descendant, and a mark whose whole job is to be clicked for an
          explanation must not be the one thing that cannot be. */}
      {hw && <HardwareSash name={name} size={28} />}
      <span className="sr-only">
        {needsPlus ? t('capabilities.eero_plus_required') : t('capabilities.unavailable')}{explanation}
      </span>
    </div>
  )
}


/**
 * Whether this network has eero Plus, stated plainly.
 *
 * Green when it does, gray when it does not, and only the gray one is a
 * control: "not detected" is the case where someone might want to know what
 * they are missing, so it opens the same explanation the locked badges do.
 * Unaffected by the hide-marks setting — this is the thing that says what that
 * setting is about, so hiding it would leave the switch unexplained.
 */
export function PlusStatus({ className = '', plain = false }:
  { className?: string
    /** Report only. Without a subscription the badge is normally a button
     *  that opens the eero Plus dialog, which is not a thing to offer from
     *  inside that dialog. */
    plain?: boolean }) {
  const premiumActive = usePremiumActive()
  const [asking, setAsking] = useState(false)
  /* Which tier, not just whether there is one. eero sells two — eero Plus and
     eero Plus 100 — and the account's `tier` field distinguishes them, so
     saying only "detected" left a Plus 100 subscriber reading the same
     sentence as a Plus subscriber. Fails soft: no tier from the API and the
     badge says what it always said. */
  const [tier, setTier] = useState<{ tier_name?: string } | null>(null)
  useEffect(() => {
    if (!premiumActive) return
    api.get<{ tier_name?: string }>('/api/network/entitlement')
      .then(setTier).catch(() => setTier(null))
  }, [premiumActive])

  const named = tier?.tier_name
  const label = premiumActive
    ? t('capabilities.named_detected', { name: named || 'eero Plus' })
    : t('capabilities.eero_plus_not_detected')
  const inner = (
    <>
      <span className="inline-block size-2 shrink-0 rounded-full" aria-hidden="true"
            style={{ background: premiumActive ? 'var(--color-ok)' : 'var(--color-idle)' }} />
      {label}
    </>
  )
  const base = `inline-flex items-center gap-2 rounded-full border px-2.5 py-1
                text-[12px] font-medium ${className}`
  if (premiumActive) {
    return (
      /* A part, because a theme may well want to make more of this than a
         hollow outline: it is the one place the interface says a paid tier
         is in force. `data-active` distinguishes the two states without a
         stylesheet having to know which element each one is. */
      <span data-part="plus-status" data-active="1" className={base}
            style={{ borderColor: 'var(--color-ok)', color: 'var(--color-ok)' }}>
        {inner}
      </span>
    )
  }
  if (plain) {
    return (
      <span data-part="plus-status" className={base}
            style={{ borderColor: 'var(--color-line-strong)',
                     color: 'var(--color-ink-3)' }}>
        {inner}
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        data-part="plus-status"
        onClick={() => setAsking(true)}
        title={t('capabilities.what_eero_plus_adds_how')}
        className={`${base} border-[var(--color-line-strong)] text-[var(--color-ink-3)]
                    hover:border-[var(--color-ink-3)] hover:text-[var(--color-ink-2)]`}
      >
        {inner}
      </button>
      {asking && <PlusDialog onClose={() => setAsking(false)}
                             about="subscription" />}
    </>
  )
}

/** What the badge explains when it is clicked, and the ways out of it.
 *
 *  Two readings, because it is opened from two places. A badge on a feature is
 *  asking "why can I not use this", and the way out includes turning the
 *  notices off — which lives on the Settings page. The indicator on that page
 *  is asking "what is eero Plus", and offering to send someone to the page
 *  they are already looking at would be absurd, so that route is dropped and
 *  the answer describes the product instead.
 */
function PlusDialog({ onClose, about = 'feature' }:
  { onClose: () => void; about?: 'feature' | 'subscription' | 'included' }) {
  const nav = useNavigate()
  const aboutFeature = about === 'feature'
  /* The third reading, for a network that has the subscription. Neither of
     the others fits: one tells you the feature is out of reach and the other
     explains what eero Plus is to somebody without it, and both end at a
     Subscribe button that a subscriber has already pressed. */
  const included = about === 'included'
  /* Rendered into the body rather than where it was opened. A mark can sit in
     a monospace table cell or inside an uppercase micro-label, and a dialog
     that is a DOM child of one inherits its type — which is why this read in a
     different font on Clients than on Profiles. Fixed positioning was never
     the problem; inheritance was. */
  return createPortal((
    <div data-part="overlay"
         className="fixed inset-0 z-50 grid place-items-center p-4 font-sans
                    text-[13px] font-normal normal-case tracking-normal
                    text-[var(--color-ink)]"
         role="dialog" aria-modal="true" aria-labelledby="plus-dialog-title"
    /* Nothing that happens in here reaches what opened it. A portal puts the
       dialog in the body, but React sends its events up the tree the element
       was written in — so pressing Close inside this sent a click to the
       table row the sash sits in, and the row opened its drawer as the dialog
       went away. Reported from the eero devices card, where closing the mark
       on an eero Signal opened that Signal's panel. */
    onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={t('capabilities.close')}
              data-part="scrim"
              className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div data-part="modal"
           className="relative z-10 w-[min(540px,92vw)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-2xl">
        {/* The badge from the Settings page, at the end of the title's row:
            the dialog explains a subscription, and whether this network has
            one is the first thing to know. Reporting only — without one the
            badge is normally the button that opens this very dialog. */}
        {/* Baselines, not boxes: the badge's own words sit on the line the
            title's do, which is what reads as aligned. A title long enough
            to wrap keeps the badge on its first line. */}
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="plus-dialog-title" className="text-[15px] font-semibold">
            {included ? t('capabilities.part_eero_plus')
              : aboutFeature ? t('capabilities.eero_plus_required_2')
              : t('capabilities.eero_plus_not_detected')}
          </h2>
          <PlusStatus plain className="shrink-0" />
        </div>
        {included ? (<>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {t('capabilities.feature_included_in_plus')}
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {t('capabilities.can_hide_plus_marks')}
          </p>
        </>) : aboutFeature ? (<>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {t('capabilities.feature_needs_subscription')}
          </p>
          {/* The two ways out, named before the buttons that do them, so the
              row below reads as the answer to the line above it rather than
              as three unexplained choices. */}
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {t('capabilities.tired_of_these_notices')}
          </p>
          <ul className="mt-1 list-disc pl-5 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            <li>{t('capabilities.subscribe_to_eero_plus')}</li>
            <li>{t('capabilities.hide_all_plus_features')}</li>
          </ul>
        </>) : (
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {t('capabilities.what_eero_plus_is')}
          </p>
        )}
        {/* One line where they fit, and a second line where they do not. The
            row used to scroll instead, which on a phone left the third
            button off the edge with nothing to say it was there — two
            buttons and a sliver of a third reads as a broken dialog, not as
            something to swipe. */}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {/* "Got it", not "Cancel". Nothing is being canceled — the dialog
              explains something, and the button acknowledges it. */}
          <button type="button" onClick={onClose}
            className="shrink-0 cursor-pointer whitespace-nowrap rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px] font-medium">
            {t('capabilities.got_it')}
          </button>
          {/* The two that do something share one color; Cancel is the only
              one that does nothing, so it is the only neutral one. */}
          {/* A subscriber has nothing to unlock, so the one thing this dialog
              can do for them is turn the marks off. Same pane as the locked
              reading sends to, named for what it means to somebody who is
              already paying. */}
          {included && (
            <button type="button"
              onClick={() => { onClose(); nav('/settings?pane=filters') }}
              className="shrink-0 cursor-pointer whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white">
              {t('capabilities.hide_plus_reminders')}
            </button>
          )}
          {aboutFeature && (
            <button type="button"
              /* To the pane, not to the page. Settings is nine cards long and
                 the switch this offers is on one of them; `?pane=` scrolls it
                 into view and flashes it, which is the difference between
                 being sent somewhere and being sent to the thing. */
              onClick={() => { onClose(); nav('/settings?pane=filters') }}
              className="shrink-0 cursor-pointer whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white">
              {t('capabilities.hide_disabled_features')}
            </button>
          )}
          <a href="https://account.eero.com/" target="_blank" rel="noreferrer noopener"
            onClick={onClose} data-part="link-button"
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white">
            {included ? t('capabilities.manage_subscription')
                      : t('capabilities.subscribe_to_eero_plus')}
            <LeavesApp />
            <span className="sr-only">{t('capabilities.opens_eero_s_site_new')}</span>
          </a>
        </div>
      </div>
    </div>
  ), document.body)
}

export function GateReasonChip({ explanation }: { explanation: string }) {
  if (!explanation) return null
  return (
    <span
      data-reason-chip
      className="inline-flex items-center gap-1 rounded-full border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink-3)]"
      title={explanation}
    >
      <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden="true">
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2Zm0-4h-2V7h2Z" />
      </svg>
      {explanation}
    </span>
  )
}

export function ReasonBadge({ name }: { name: string }) {
  const { available, explanation } = useCapability(name)
  if (available || !explanation) return null
  return (
    <span className="ml-2 rounded border border-[var(--color-line-strong)] bg-[var(--color-canvas)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-ink-3)]">
      {explanation}
    </span>
  )
}


/**
 * Whether a mark belongs on this capability, and which of the two it is.
 *
 * Two states, because there are two things to say. A feature the network has
 * is marked in the accent color, so a subscriber can see what they are paying
 * for; one it is not entitled to is marked in gray and opens the explanation,
 * rather than lighting up something that cannot be used. Either can be turned off
 * wholesale in Settings.
 *
 * Shared by every presentation of the mark, so no two of them can disagree
 * about when it appears or about which state a network is in.
 */
function usePlusState(name: string | string[]) {
  const { caps, prefs } = useCapabilities()
  const premiumActive = usePremiumActive()
  // A list where one mark speaks for a whole pane. Network-wide protection
  // holds two Plus toggles and needs one badge, not one each.
  const names = Array.isArray(name) ? name : [name]
  const found = names.map((n) => caps[n]).filter(Boolean)
  // Absent from the map is not proof of anything either way, so nothing is
  // claimed about a capability that never arrived.
  const show = !prefs.hide_plus_badges && found.some((c) => c.plus)
  // "Required" wins: if any part of what this marks is out of reach, the mark
  // says so rather than implying the whole thing is included.
  const locked = found.some(
    (c) => c.plus && !c.available && c.reason === 'subscription') && !premiumActive
  return { show, locked }
}

/**
 * The "+", bold and leaning.
 *
 * Our own artwork, not eero's. The Android app ships the Plus badge as a
 * vector and lifting it would be borrowing a trademark to say "this costs
 * money", which is a different claim from the one this mark makes. A plain
 * plus, thickened and skewed twelve degrees, gives the italic weight the sash
 * was drawn around without any of that.
 */
function PlusGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={color}
         aria-hidden="true">
      {/* Skewed about the middle: skewX alone would walk the glyph right as it
          leans, so the translate puts it back where it started. */}
      <path transform="translate(2.55) skewX(-12)"
            d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z" />
    </svg>
  )
}

/** The mark on a control that leaves the app, said before it is pressed. */
function LeavesApp() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor"
         aria-hidden="true">
      <path d="M5 5h6v2H7v10h10v-4h2v6H5V5z" />
      <path d="M13 3h8v8h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H13V3z" />
    </svg>
  )
}

/**
 * The shape both corner marks share: a right triangle across the top-right
 * corner, with its glyph upright inside it and a button under the whole thing.
 *
 * Extracted rather than copied. There are two of these now — one for what a
 * subscription would unlock, one for what this hardware cannot do — and they
 * have to agree on shape, size, spacing, and position or they read as two
 * unrelated decorations rather than as one vocabulary with two words in it.
 */
function Sash({ attr, state, fill, ink, size, className = '', title, say, glyph,
                onOpen }: {
  /** The data attribute tests and styles find this kind of mark by. */
  attr: string
  state: string
  fill: string
  ink: string
  size: number
  className?: string
  title: string
  /** What a screen reader hears; the colors are the only visible difference
   *  between the states, so this is not optional. */
  say: string
  glyph: (size: number, color: string) => ReactNode
  onOpen: () => void
}) {
  return (
    /* The clip is the wrapper's job, so the host does not need
       `overflow: hidden` — which on a card would cut off the menus that open
       inside it. */
    <span
      {...{ [attr]: state }}
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
      style={{ borderRadius: 'inherit' }}
    >
      <button
        type="button"
        data-part="sash"
        onClick={(e) => { e.stopPropagation(); onOpen() }}
        title={title}
        /* The global focus ring is an outline, and the clip that makes the
           triangle cuts outlines off with everything else outside it. An inset
           shadow is painted inside the box, so what survives the clip is a
           thick rule down the two edges the sash keeps. */
        className="pointer-events-auto absolute right-0 top-0 cursor-pointer
                   focus-visible:outline-none
                   focus-visible:shadow-[inset_0_0_0_3px_var(--color-ink)]"
        style={{ width: size, height: size, background: fill,
                 clipPath: 'polygon(0 0, 100% 0, 100% 100%)' }}
      >
        <span className="absolute flex"
              style={{ top: size * 0.1, right: size * 0.12 }}>
          {glyph(size * 0.42, ink)}
        </span>
        <span className="sr-only">{say}</span>
      </button>
    </span>
  )
}

/**
 * Material Design Icons' `cancel` — a circle with a bar through it
 * (Pictogrammers, Apache-2.0). Not a cross: a cross reads as "close this", and
 * this mark is not something you dismiss. The prohibition sign is the one that
 * says the thing cannot be done here.
 */
function CancelGlyph({ size, color }: { size: number; color: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={color}
         aria-hidden="true">
      <path d="M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M4 12C4 7.6 7.6 4 12 4C13.8 4 15.5 4.6 16.8 5.7L5.7 16.8C4.6 15.5 4 13.8 4 12M12 20C10.2 20 8.5 19.4 7.2 18.3L18.3 7.2C19.4 8.5 20 10.2 20 12C20 16.4 16.4 20 12 20Z" />
    </svg>
  )
}

/**
 * The mark for a feature this network's eeros cannot do.
 *
 * Deliberately a different word from the eero Plus sash, in the same shape. A
 * subscription is something you can go and buy for the hardware you own; a
 * hardware limit is not, and telling somebody to subscribe to fix it would
 * waste their money. Gray, with the prohibition sign rather than the plus.
 *
 * It answers to the same setting the old chip did — Feature filters' "hide
 * features your hardware or firmware cannot do" — because `useCapability`
 * reports such a feature as hidden and this returns nothing for it.
 */
export function HardwareSash({ name, size = 34, className = '' }: {
  name: string
  size?: number
  className?: string
}) {
  const { available, hidden, reason, explanation } = useCapability(name)
  const [asking, setAsking] = useState(false)
  const applies = !available && (reason === 'hardware' || reason === 'firmware')
  if (!applies || hidden) return null
  return (
    <>
      <Sash attr="data-hardware-mark" state={reason} size={size}
            className={className}
            fill="var(--color-line-strong)" ink="var(--color-ink-2)"
            title={explanation || t('capabilities.hardware_cannot')}
            say={t('capabilities.hardware_cannot')}
            glyph={(s, c) => <CancelGlyph size={s} color={c} />}
            onOpen={() => setAsking(true)} />
      {asking && <HardwareDialog explanation={explanation}
                                 onClose={() => setAsking(false)} />}
    </>
  )
}

/** Whether a hardware mark would be drawn for this capability, so a wrapper
 *  can leave out its own spacing when nothing is going in the corner. */
export function useHardwareVisible(name: string | string[]): boolean {
  const { caps, prefs } = useCapabilities()
  const names = Array.isArray(name) ? name : [name]
  return names.some((n) => {
    const cap = caps[n]
    if (!cap || cap.available) return false
    if (cap.reason !== 'hardware' && cap.reason !== 'firmware') return false
    return !prefs.hide_capability_limited
  })
}

/**
 * Why a feature is grayed out when the reason is the hardware.
 *
 * Three ways out, and the third is the only one that would actually change the
 * answer — which is why it is here and why it is honest about being paid for.
 */
function HardwareDialog({ onClose, explanation }:
  { onClose: () => void; explanation: string }) {
  const nav = useNavigate()
  /* The affiliate tag travels in the URL rather than being appended by
     whatever opens it, so it cannot be dropped on the way out. */
  const store = 'https://www.amazon.com/stores/page/'
    + 'FC890135-A1A9-499D-91A1-860E8614C254?tag=eeronaut-20'
  return createPortal((
    <div data-part="overlay"
         className="fixed inset-0 z-50 grid place-items-center p-4 font-sans
                    text-[13px] font-normal normal-case tracking-normal
                    text-[var(--color-ink)]"
         role="dialog" aria-modal="true" aria-labelledby="hardware-dialog-title"
    /* Nothing that happens in here reaches what opened it. A portal puts the
       dialog in the body, but React sends its events up the tree the element
       was written in — so pressing Close inside this sent a click to the
       table row the sash sits in, and the row opened its drawer as the dialog
       went away. Reported from the eero devices card, where closing the mark
       on an eero Signal opened that Signal's panel. */
    onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={t('capabilities.close')}
              data-part="scrim"
              className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div data-part="modal"
           className="relative z-10 w-[min(540px,92vw)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-2xl">
        <h2 id="hardware-dialog-title" className="text-[15px] font-semibold">
          {t('capabilities.hardware_cannot')}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('capabilities.hardware_explained')}
        </p>
        {/* eero's own words for this particular capability, where it gave
            any. Kept separate from the sentence above so the general
            explanation does not have to be written around it. */}
        {explanation && (
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {explanation}
          </p>
        )}
        <div className="mt-4 flex items-start justify-end gap-2 overflow-x-auto">
          <button type="button" onClick={onClose}
            className="shrink-0 cursor-pointer whitespace-nowrap rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px] font-medium">
            {t('capabilities.got_it')}
          </button>
          <button type="button"
            /* To the pane, not the page: Settings is nine cards long and the
               switch this offers is on one of them. */
            onClick={() => { onClose(); nav('/settings?pane=filters') }}
            className="shrink-0 cursor-pointer whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white">
            {t('capabilities.hide_disabled_features')}
          </button>
          {/* The disclosure sits under the button it is about, not at the
              bottom of the dialog: it qualifies this link and nothing else. */}
          <span className="flex shrink-0 flex-col items-center gap-1">
            <a href={store} target="_blank" rel="noreferrer noopener sponsored"
               onClick={onClose} data-part="link-button"
               className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white">
              {t('capabilities.upgrade_eeros')}
              <LeavesApp />
            </a>
            <span className="text-[11px] text-[var(--color-ink-3)]">
              {t('capabilities.affiliate_link')}
            </span>
          </span>
        </div>
      </div>
    </div>
  ), document.body)
}

/**
 * The eero Plus mark: a diagonal sash across the top-right corner of whatever
 * it belongs to.
 *
 * It replaced a pill that carried the words "eero Plus required". The pill was
 * a paragraph's worth of horizontal room on every gated pane, row, and tile,
 * and on the narrow ones it pushed the content it was describing into a
 * second line. The sash takes a corner nothing else wants and costs the
 * content no width at all.
 *
 * What it gives up is words, so the two states differ by color: accent for a
 * feature this network has, gray for one it cannot reach. Both carry the
 * sentence in `title` and in text only a screen reader sees, and the locked
 * one is a button — the explanation of what eero Plus is has to stay reachable
 * from the feature that is asking for it.
 *
 * Its host must be positioned and should have a radius: the sash fills the
 * corner by clipping itself to `inherit`, so on a square-cornered row it reads
 * as a notch and on a card it follows the card. Give the host right padding
 * too, or the sash lands on top of the content's last line.
 */
export function PlusSash({ name, size = 34, className = '' }: {
  name: string | string[]
  /** The length of the sash's legs, in pixels. 34 on a card, around 26 on a
   *  row, smaller on anything the size of a tab. */
  size?: number
  className?: string
}) {
  const { show, locked } = usePlusState(name)
  const [asking, setAsking] = useState(false)
  if (!show) return null

  /* Blue for a feature this network has, gray for one it does not. The
     subscription is the thing being marked, so the mark is lit where it is
     paid for and dull where it is out of reach. */
  const fill = locked ? 'var(--color-line-strong)' : 'var(--color-accent)'
  const ink = locked ? 'var(--color-ink-2)' : '#fff'
  const box = {
    width: size, height: size, background: fill,
    clipPath: 'polygon(0 0, 100% 0, 100% 100%)',
  }
  /* Not rotated with the sash. A "+" turned 45 degrees is an "×", and an × on
     a locked feature reads as "closed" — the opposite of the invitation the
     mark is making. The sash is the diagonal; the glyph stays upright. */
  const inside = (
    <>
      <span className="absolute flex"
            style={{ top: size * 0.1, right: size * 0.12 }}>
        <PlusGlyph size={size * 0.42} color={ink} />
      </span>
      <span className="sr-only">
        {locked ? t('capabilities.eero_plus_required')
                : t('capabilities.part_eero_plus')}
      </span>
    </>
  )

  return (
    <>
      {/* The clip is the wrapper's job, so the host does not need
          `overflow: hidden` — which on a card would cut off the menus that
          open inside it. */}
      <span
        data-plus-mark={locked ? 'locked' : 'included'}
        className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
        style={{ borderRadius: 'inherit' }}
      >
        <button
          type="button"
          data-part="sash"
          /* Both states, because both raise a question. Locked asks why this
             cannot be used; included asks what the mark means on something
             that works — and "you are paying for this" is an answer worth
             being able to get to. */
          onClick={(e) => { e.stopPropagation(); setAsking(true) }}
          title={locked ? t('capabilities.feature_needs_eero_plus_subscription')
                        : t('capabilities.part_eero_plus')}
          /* The global focus ring is an outline, and the clip that makes
             the triangle cuts outlines off with everything else outside it.
             An inset shadow is painted inside the box, so what survives the
             clip is a thick rule down the two edges the sash keeps. */
          className="pointer-events-auto absolute right-0 top-0 cursor-pointer
                     focus-visible:outline-none
                     focus-visible:shadow-[inset_0_0_0_3px_var(--color-ink)]"
          style={box}
        >
          {inside}
        </button>
      </span>
      {asking && (
        <PlusDialog about={locked ? 'feature' : 'included'}
                    onClose={() => setAsking(false)} />
      )}
    </>
  )
}


/**
 * The same mark, inline, for a row whose corner is already taken.
 *
 * A label-and-control row has its control at the right-hand end, which is
 * exactly where a corner sash lands — and a box drawn around one row to give
 * the sash a corner made that row the odd one out in a drawer of flush rows.
 * This is the sash's own shape at label size, set beside the name instead.
 */
export function PlusTick({ name, size = 14 }: {
  name: string | string[]
  size?: number
}) {
  const { show, locked } = usePlusState(name)
  const [asking, setAsking] = useState(false)
  if (!show) return null
  const fill = locked ? 'var(--color-line-strong)' : 'var(--color-accent)'
  const ink = locked ? 'var(--color-ink-2)' : '#fff'
  return (
    <>
      {/* The clip is on the shape inside, not on the button. A triangle this
          small has almost no middle, and clipping the button itself left the
          hit area to the upper-right half of fourteen pixels — a target that
          takes aim to press. The button is the whole square; only the paint
          is a triangle. */}
      <button
        type="button"
        data-part="sash"
        data-plus-mark={locked ? 'locked' : 'included'}
        onClick={(e) => { e.stopPropagation(); setAsking(true) }}
        title={locked ? t('capabilities.feature_needs_eero_plus_subscription')
                      : t('capabilities.part_eero_plus')}
        className="relative inline-block shrink-0 cursor-pointer align-middle
                   focus-visible:outline focus-visible:outline-2
                   focus-visible:outline-offset-1"
        style={{ width: size, height: size }}
      >
        <span className="absolute inset-0 rounded-[2px]"
              style={{ background: fill,
                       clipPath: 'polygon(0 0, 100% 0, 100% 100%)' }} />
        <span className="absolute flex"
              style={{ top: size * 0.06, right: size * 0.1 }}>
          <PlusGlyph size={size * 0.5} color={ink} />
        </span>
        <span className="sr-only">
          {locked ? t('capabilities.eero_plus_required')
                  : t('capabilities.part_eero_plus')}
        </span>
      </button>
      {asking && (
        <PlusDialog about={locked ? 'feature' : 'included'}
                    onClose={() => setAsking(false)} />
      )}
    </>
  )
}

/**
 * A region that can be read but not used, because this network is not entitled
 * to what is in it.
 *
 * `inert` rather than `pointer-events: none`, which is what these panes used
 * to do: it takes the mouse away and leaves the keyboard, so a subscription
 * feature was one Tab and one Space away from being changed by somebody who
 * was being shown it as an advertisement. Inert takes the whole subtree out of
 * the tab order and out of the accessibility tree, so keep the sentence that
 * explains the state outside it — the sash says "eero Plus required" in text
 * only a screen reader sees, and the pane's own description belongs above
 * rather than inside.
 */
export function PlusLock({ locked, children, className = '' }: {
  locked: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`${locked ? 'dimmed' : ''} ${className}`}
         inert={locked || undefined}>
      {children}
    </div>
  )
}

/**
 * Why a whole card is locked, in one sentence, dressed the same everywhere.
 *
 * Every gated card wrote this line itself and no two wrote it alike: some
 * dimmed it and some did not, some used the secondary ink and some the
 * tertiary, some wrapped relaxed and some snug. Read down a page they looked
 * like four different kinds of unavailable rather than one.
 *
 * Dimmed, because that is what every other locked thing in the app is, and
 * the sentence is the only thing in the card when there is nothing to gray
 * out behind it. Secondary ink rather than tertiary: `dimmed` already lowers
 * it once, and lowering it twice made the one readable thing on a locked card
 * the faintest.
 */
export function PlusWhy({ children }: { children: ReactNode }) {
  return (
    <p className="dimmed text-[13px] leading-relaxed text-[var(--color-ink-2)]">
      {children}
    </p>
  )
}

/** Whether a mark would render for this capability, so a wrapper can leave out
 *  its own spacing — or its border — when nothing is going in the corner. */
export function usePlusVisible(name: string | string[]): boolean {
  const { caps, prefs } = useCapabilities()
  const names = Array.isArray(name) ? name : [name]
  return !prefs.hide_plus_badges && names.some((n) => caps[n]?.plus)
}

/**
 * One gated control inside a pane that is otherwise available.
 *
 * A corner needs something to be the corner of. The row this marks is
 * typically a label and a switch with no edges of its own, so the mark brings
 * a box with it: a hairline border and a radius, drawn only when there is a
 * mark to hang on it, which also does the work of saying which row is meant.
 */
export function PlusRow({ name, children }:
  { name: string | string[]; children: ReactNode }) {
  if (!usePlusVisible(name)) return <>{children}</>
  return (
    <div className="relative rounded-md border border-[var(--color-line)] p-3 pr-10">
      {children}
      <PlusSash name={name} size={28} />
    </div>
  )
}

/**
 * Whether a control that has to reach eero's cloud can work right now.
 *
 * Returns the reason too, so a caller does not have to write the sentence
 * again at every button. Deliberately optimistic before the first answer
 * arrives: graying every cloud control for the first second of every page load
 * would be worse than the occasional failed click.
 */
export function useCloud(): { ok: boolean; why: string | undefined } {
  const { cloudOk } = useCapabilities()
  if (cloudOk === false) {
    return { ok: false,
             why: t('capabilities.needs_cloud_not_answering') }
  }
  return { ok: true, why: undefined }
}
