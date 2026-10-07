/**
 * Translation.
 *
 * Deliberately small and dependency-free. The app needs three things — look a
 * string up, put values into it, and put *elements* into it — and a library
 * would bring a plural engine, a loader, a namespace system, and a date
 * formatter that this app either has already or does not want.
 *
 * ## For translators
 *
 * Every string lives in `en-US.json`, one per line, keyed by where it appears.
 * A translation is a copy of that file with the values replaced. Keys are
 * never translated. Anything in braces — `{name}`, `{count}`, `{link}` — is a
 * hole the app fills in, so it has to survive translation, but it can move
 * anywhere in the sentence. That last part is the point: Spanish and English
 * do not agree on word order, and a sentence assembled by concatenation
 * cannot be fixed by a translator. One of these can.
 *
 * A key you have no translation for is fine. It falls back to English, so a
 * half-finished catalog gives a half-translated interface rather than a screen
 * of dotted identifiers.
 *
 * ## Why elements go in braces too
 *
 * Around 150 sentences here have a link or a bold phrase inside them. Nesting
 * markup in the catalog would mean translators editing JSX; splitting the
 * sentence around the markup would mean translating fragments with no context
 * and no way to reorder them. So the element is a hole like any other, and its
 * own text is its own key:
 *
 *     "profile_filters.turned_on_every_profile": "Turned on for every profile by {link}.",
 *     "profile_filters.network_wide_ad_blocking": "network-wide ad blocking"
 *
 * The translator sees two ordinary strings and can put `{link}` wherever the
 * grammar wants it.
 *
 * ## Why `t` is a plain function and not a hook
 *
 * Because a third of the strings in this app are not inside a component when
 * they are written: table columns are module-level arrays, chart axis
 * formatters are helpers, and confirmation text is built in an event handler.
 * A hook cannot be called from any of those, and threading one through would
 * have meant restructuring code that has nothing wrong with it.
 *
 * The catalog therefore lives in a module variable that `I18nProvider` sets
 * from its props before rendering children, and the provider keys its subtree
 * on the language so a change remounts everything below it. The variable is
 * derived entirely from that prop, so it cannot drift.
 */
import { useEffect, useState, type ReactNode } from 'react'
import source from './en-US.json'
import { LOCALES, SOURCE, TAGS, canonical, fallbacks, negotiate }
  from './locales'

/* The source language ships in the first script the browser loads; the
 * others arrive when somebody is reading in them.
 *
 * Each catalog is about 1,500 strings and a hundred kilobytes, and all of
 * them were once in the one file every visitor downloaded — most of it for a
 * language any given reader is not using. The source stays static because it is
 * also the fallback for a key a translation has not caught up with, so `look`
 * below has to reach it without waiting for anything.
 *
 * Keyed by canonical tag. A contributor adds one file, one line here, and one
 * entry in `locales.ts`. */
const LOADERS: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  'cs-CZ': () => import('./cs-CZ.json'),
  'da-DK': () => import('./da-DK.json'),
  'de-DE': () => import('./de-DE.json'),
  'es-ES': () => import('./es-ES.json'),
  'fr-FR': () => import('./fr-FR.json'),
  'it-IT': () => import('./it-IT.json'),
  'hu-HU': () => import('./hu-HU.json'),
  'nl-NL': () => import('./nl-NL.json'),
  'nb-NO': () => import('./nb-NO.json'),
  'pl-PL': () => import('./pl-PL.json'),
  'pt-BR': () => import('./pt-BR.json'),
  'pt-PT': () => import('./pt-PT.json'),
  'fi-FI': () => import('./fi-FI.json'),
  'sv-SE': () => import('./sv-SE.json'),
  'uk-UA': () => import('./uk-UA.json'),
  'ja-JP': () => import('./ja-JP.json'),
  'ko-KR': () => import('./ko-KR.json'),
  'zh-CN': () => import('./zh-CN.json'),
  'zh-TW': () => import('./zh-TW.json'),
}

/** Every catalog in hand, by canonical tag. */
export const CATALOGS: Record<string, Record<string, string>> = { [SOURCE]: source }

/** Fetch a catalog if it is not already here. Resolves either way.
 *
 *  Fetches the whole fallback chain, not just the tag: a locale that borrows
 *  from a more general one cannot fall back to it if it was never loaded. */
export async function loadCatalog(tag: string): Promise<void> {
  await Promise.all(fallbacks(tag).map(async (t) => {
    if (CATALOGS[t] || !LOADERS[t]) return
    try {
      CATALOGS[t] = (await LOADERS[t]()).default
    } catch {
      /* Left absent, so everything falls back to the source rather than
         breaking. A catalog that cannot be fetched is a worse page in one
         language, not a broken app. */
    }
  }))
}

/** What the language selector offers. Endonyms — a language names itself. */
export const LANGUAGES: { tag: string; name: string }[] =
  LOCALES.map(({ tag, name }) => ({ tag, name }))

/**
 * The catalogs to read a tag through, nearest first.
 *
 * A list rather than one catalog, because a key missing from a translation
 * should come from the next most specific thing that has it and only reach
 * the source language last. Absent catalogs are skipped, so this works while
 * a fetch is still in flight.
 */
export function catalogsFor(tag: string): Record<string, string>[] {
  const chain = fallbacks(tag).map((t) => CATALOGS[t]).filter(Boolean)
  return chain.length ? chain : [CATALOGS[SOURCE]]
}

/** The browser's preference, reduced to a locale this app ships. */
export function browserLanguage(): string {
  const list = (typeof navigator === 'undefined' ? [] : navigator.languages)
    ?? [navigator.language]
  return negotiate(list.filter(Boolean))
}

/** Resolve the stored pref — which may be "auto" — to a locale we ship.
 *
 *  A stored tag is matched rather than trusted: it can be hand-edited, and it
 *  can name a locale a later build dropped. */
export const resolveLanguage = (pref: string | undefined | null): string =>
  !pref || pref === 'auto' ? browserLanguage() : negotiate([pref])

let active: Record<string, string>[] = [CATALOGS[SOURCE]]
let activeTag = SOURCE

/** The language in force, for anything that needs to format by locale. */
export const currentLanguage = (): string => activeTag

function look(key: string): string {
  for (const c of active) {
    const hit = c[key]
    if (hit !== undefined) return hit
  }
  return CATALOGS[SOURCE][key] ?? key
}

/**
 * A translated string.
 *
 * `vars` fill `{name}` holes. A hole with no value keeps its braces rather
 * than vanishing: a missing value is a caller bug, and a sentence with a
 * silent gap is far harder to spot than one still reading `{name}`.
 */
export function t(
  key: string,
  vars?: Record<string, string | number | null | undefined>,
): string {
  const s = look(key)
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] == null ? whole : String(vars[name]))
}

/** A translated string that may have elements in its holes. */
export function tx(
  key: string,
  vars?: Record<string, string | number | ReactNode>,
): ReactNode {
  const template = look(key)
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  const re = /\{(\w+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    if (m.index > last) out.push(template.slice(last, m.index))
    const v = vars?.[m[1]]
    out.push(v === undefined
      ? m[0]
      : <span key={`h${i++}`} style={{ display: 'contents' }}>{v as ReactNode}</span>)
    last = m.index + m[0].length
  }
  if (last < template.length) out.push(template.slice(last))
  return <>{out}</>
}

/**
 * A translation, or a fallback when there is no key for it.
 *
 * For text the server names. The notification preferences are the case: the
 * API returns an event key and an English label, and the key is stable while
 * the label is only a default. Translating from the key keeps the backend out
 * of the catalog business, and the server's label covers an event eero adds
 * that this app has never heard of.
 */
export function tOr(key: string, fallback: string): string {
  for (const c of active) {
    const hit = c[key]
    if (hit !== undefined) return hit
  }
  return CATALOGS[SOURCE][key] ?? fallback
}

/** The CLDR plural category a count falls in, in the language in force. */
const plurals = new Map<string, Intl.PluralRules>()
function category(count: number): string {
  let rules = plurals.get(activeTag)
  if (!rules) {
    try { rules = new Intl.PluralRules(activeTag) } catch { rules = new Intl.PluralRules(SOURCE) }
    plurals.set(activeTag, rules)
  }
  return rules.select(count)
}

/**
 * A count and a string that agrees with it.
 *
 * Twelve places in this app build a plural by sticking an "s" on the end
 * conditionally, which works in English and in almost nothing else. Spanish
 * happens to be regular here too, but the noun still has to agree in gender
 * with its article, and "1 red" against "3 redes" is not a suffix decision a
 * caller can make on a translator's behalf.
 *
 * So a plural is a set of keys, one per plural category the language has,
 * and the caller passes the count. English, Spanish, and most of the others
 * here have two, `.one` and `.other`; Czech, Polish, and Ukrainian also have
 * `.few` and `.many`; Japanese, Korean, and Chinese use `.other` alone. Which
 * category a count falls in is the browser's `Intl.PluralRules` for the
 * language in force, which carries CLDR's rules for every one of them.
 *
 * The source has `.one` and `.other` for every plural. A catalog adds the
 * other categories its language needs; a category it does not carry reads
 * `.other`, which is the form every language has.
 */
export function tn(
  key: string,
  count: number,
  vars?: Record<string, string | number | null | undefined>,
): string {
  const wanted = `${key}.${category(count)}`
  const has = active.some((c) => c[wanted] !== undefined)
  return t(has ? wanted : `${key}.other`, { ...vars, count })
}

/**
 * Puts a language in force for everything below it.
 *
 * The assignment happens in the component body, which runs before any child
 * renders, so the first paint below is already in the right language. `key`
 * remounts that subtree when the language changes, which is what makes the
 * plain-function `t` above reactive without every call site subscribing.
 */
export function I18nProvider({ lang, children }: { lang: string; children: ReactNode }) {
  const tag = canonical(lang) || SOURCE
  active = catalogsFor(tag)
  activeTag = tag
  /* The catalog may still be on its way. Until it lands `catalogsFor` hands
     back the source language, which is what the fallback is for; the state
     below changes when it arrives, and the `key` takes the subtree with it. The fetch is
     started here rather than in the effect so it is already in flight during
     the first paint. */
  const [, arrived] = useState(0)
  const ready = fallbacks(tag).every((t) => CATALOGS[t] || !TAGS.includes(t))
  useEffect(() => {
    if (ready) return
    let live = true
    void loadCatalog(tag).then(() => { if (live) arrived((n) => n + 1) })
    return () => { live = false }
  }, [tag, ready])
  return <div key={`${tag}${ready ? '' : ':src'}`} className="contents">{children}</div>
}
