/**
 * The locales this app ships, and how a preference becomes one of them.
 *
 * Tags are BCP 47, language and region: `es-ES`, `pt-BR`, `zh-TW`. A reader
 * whose own region is not among them still gets their language: `es-MX` and
 * `fr-CA` are matched to `es-ES` and `fr-FR` by `match` below, which falls back
 * to any locale in the same language before it falls back to English.
 *
 * Portuguese and Chinese each ship twice, because the difference is real:
 * Brazilian and European Portuguese differ in vocabulary and address, and
 * `zh-CN` is written in simplified characters where `zh-TW` is traditional.
 * The script forms (`zh-Hans`, `zh-Hant`) and the other Chinese regions are
 * mapped in ALIASES, as are the Norwegian tags a browser may send for
 * Bokmål.
 */

/** A locale with a catalog in this repository. */
export interface Locale {
  /** The canonical BCP 47 tag. This is what gets stored. */
  tag: string
  /** What the language calls itself, which is what the picker shows. */
  name: string
  /** For anything written in English about the language: docs, logs, tests. */
  english: string
}

/* English first because it is the source and the fallback; the rest in the
   order their own names sort, Latin script first, which is the order a reader
   scans for theirs. Brazilian Portuguese is before European because a bare
   `pt` lands on the first Portuguese here, and Brazil has the more readers.
   A locale belongs here only once its catalog does: an entry with no file
   would offer a language in the picker and then show English. */
export const LOCALES: Locale[] = [
  { tag: 'en-US', name: 'English (US)', english: 'English (United States)' },
  { tag: 'cs-CZ', name: 'Čeština', english: 'Czech' },
  { tag: 'da-DK', name: 'Dansk', english: 'Danish' },
  { tag: 'de-DE', name: 'Deutsch', english: 'German' },
  { tag: 'es-ES', name: 'Español', english: 'Spanish' },
  { tag: 'fr-FR', name: 'Français', english: 'French' },
  { tag: 'it-IT', name: 'Italiano', english: 'Italian' },
  { tag: 'hu-HU', name: 'Magyar', english: 'Hungarian' },
  { tag: 'nl-NL', name: 'Nederlands', english: 'Dutch' },
  { tag: 'nb-NO', name: 'Norsk bokmål', english: 'Norwegian Bokmål' },
  { tag: 'pl-PL', name: 'Polski', english: 'Polish' },
  { tag: 'pt-BR', name: 'Português (Brasil)', english: 'Portuguese (Brazil)' },
  { tag: 'pt-PT', name: 'Português (Portugal)', english: 'Portuguese (Portugal)' },
  { tag: 'fi-FI', name: 'Suomi', english: 'Finnish' },
  { tag: 'sv-SE', name: 'Svenska', english: 'Swedish' },
  { tag: 'uk-UA', name: 'Українська', english: 'Ukrainian' },
  { tag: 'ja-JP', name: '日本語', english: 'Japanese' },
  { tag: 'ko-KR', name: '한국어', english: 'Korean' },
  { tag: 'zh-CN', name: '简体中文', english: 'Chinese (Simplified)' },
  { tag: 'zh-TW', name: '繁體中文', english: 'Chinese (Traditional)' },
]

/** The tag everything falls back to: the source language. */
export const SOURCE = 'en-US'

export const TAGS: string[] = LOCALES.map((l) => l.tag)

/** Tags somebody may reasonably send that mean one of ours.
 *
 *  Only where a plain subtag walk would get it wrong. `fr-CA` needs no entry
 *  because the same-language fallback in `match` finds `fr-FR`; `zh-HK` does,
 *  because the same-language fallback would pick whichever Chinese comes
 *  first, and simplified and traditional are different characters. */
const ALIASES: Record<string, string> = {
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-my': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  // Bare Chinese: simplified has by far the more readers, and a reader of
  // traditional can pick theirs from the list.
  zh: 'zh-CN',
  // Norwegian: browsers send `no`, `nb` or, for a Nynorsk reader, `nn`, who is
  // better served by Bokmål than by English.
  no: 'nb-NO',
  nn: 'nb-NO',
}

/**
 * A tag in canonical shape: `en`, `en-US`, `zh-Hans`, `zh-Hant-HK`.
 *
 * Case in a tag carries no meaning — `EN-us` and `en-US` are the same tag —
 * but a stored preference that is sometimes one and sometimes the other makes
 * every comparison a place to get it wrong. So case is decided here, once,
 * by the conventional shape: language lowercase, script titlecase, region
 * uppercase. Underscores are accepted because POSIX locale names use them and
 * somebody will paste one in.
 */
export function canonical(tag: string): string {
  const parts = String(tag ?? '').trim().replace(/_/g, '-').split('-').filter(Boolean)
  if (!parts.length) return ''
  return parts
    .map((p, i) => {
      if (i === 0) return p.toLowerCase()
      if (p.length === 4) return p[0].toUpperCase() + p.slice(1).toLowerCase()
      if (p.length === 2 || (p.length === 3 && /^\d+$/.test(p))) return p.toUpperCase()
      return p.toLowerCase()
    })
    .join('-')
}

/** The primary language of a tag: `pt` for `pt-BR`. */
export const primary = (tag: string): string => canonical(tag).split('-')[0]

/**
 * The shipped locale a requested tag should be read in, or null.
 *
 * Narrowing, in the order a reader would want:
 *
 *   1. the tag itself, and its alias if it has one
 *   2. dropping subtags from the right, so `fr-CA-x-foo` reaches `fr`
 *   3. any locale in the same language, so `es-MX` reaches `es-ES` rather
 *      than falling all the way to English: a Mexican reader is better
 *      served by Spain's Spanish than by none
 */
export function match(requested: string): string | null {
  const want = canonical(requested)
  if (!want) return null
  const alias = ALIASES[want.toLowerCase()]
  if (alias && TAGS.includes(alias)) return alias

  const parts = want.split('-')
  for (let n = parts.length; n > 0; n--) {
    const probe = parts.slice(0, n).join('-')
    const hit = TAGS.find((t) => t.toLowerCase() === probe.toLowerCase())
    if (hit) return hit
    const aliased = ALIASES[probe.toLowerCase()]
    if (aliased && TAGS.includes(aliased)) return aliased
  }

  const lang = parts[0]
  return TAGS.find((t) => primary(t) === lang) ?? null
}

/**
 * The best locale for a list of preferences, in order.
 *
 * Every preference is tried in full before moving to the next, so somebody
 * who asks for `es-MX` then `en` gets Spanish rather than English: their
 * first choice can be served, if imperfectly, and that is what ordering the
 * list means.
 */
export function negotiate(preferences: readonly string[]): string {
  for (const p of preferences) {
    const hit = match(p)
    if (hit) return hit
  }
  return SOURCE
}

/** The chain to read a key through: the locale, then anything more general
 *  it can borrow from, then the source. `zh-TW` borrows nothing from
 *  `zh-CN`, nor `pt-PT` from `pt-BR`: different characters, different
 *  words, so only exact ancestors count. */
export function fallbacks(tag: string): string[] {
  const chain: string[] = []
  const parts = canonical(tag).split('-')
  for (let n = parts.length; n > 0; n--) {
    const probe = parts.slice(0, n).join('-')
    const hit = TAGS.find((t) => t.toLowerCase() === probe.toLowerCase())
    if (hit && !chain.includes(hit)) chain.push(hit)
  }
  if (!chain.includes(SOURCE)) chain.push(SOURCE)
  return chain
}
