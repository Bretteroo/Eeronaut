/* Dates go through the interface language, not the browser's. `undefined` as
   the locale means "whatever the browser prefers", which is how the app ended
   up printing "Sep 1" inside an otherwise Hungarian page: the two settings are
   independent, and the one the reader chose is the one that should win. */
import { t, currentLanguage } from '../i18n'
import { SOURCE } from '../i18n/locales'
/* Value formatting, in one place.

   Bands and hardware constants are laboured over server-side; these are the
   client-side equivalents. They live here because the same value was being
   formatted independently in several components and the copies drifted — the
   node panel and radio analytics disagreed about what a 2.4 GHz band is
   called, and two files carried byte formatters that were identical until one
   of them changed.

   Every function tolerates missing and malformed input. eero returns nulls,
   empty strings and epoch-zero for "never", and an unguarded Date renders
   those as "Invalid Date" or "12/31/1969" — both of which have been shown to
   the user. */

const DASH = '—'

/** A Date, or null when the value cannot sensibly be shown as a time.
 *  Epoch-zero counts as unusable: eero means "never", not 1970. */
function asDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = new Date(value)
  const t = d.getTime()
  if (Number.isNaN(t) || t <= 0) return null
  return d
}

/**
 * "3 Feb, 14:05" — a moment, to the minute.
 *
 * The clock format is passed in rather than left to the browser locale. Left
 * to the locale, this function disagreed with the schedule and update-window
 * formatters below — which were hard-coded to 12-hour — and with the Insights
 * hour axis, which was hard-coded to 24. Three conventions on one screen.
 *
 * Prefer `useClock()` at call sites: it supplies this argument from the
 * setting, so no caller has to remember to.
 */
export function when(value: string | number | null | undefined,
                     h24 = false): string {
  const d = asDate(value)
  return d ? d.toLocaleString(currentLanguage(), {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: !h24,
  }) : DASH
}

/**
 * "9/30/26 2:23 AM" — a moment, to the minute, in the fewest characters:
 * the date in the reader's own numeric form, then the time. For a line of
 * small text beside a button, where `when`'s month name does not fit.
 *
 * Formatted as two parts and joined with a space rather than in one call,
 * which puts a comma between them in English.
 */
export function whenShort(value: string | number | null | undefined,
                          h24 = false): string {
  const d = asDate(value)
  if (!d) return DASH
  const lang = currentLanguage()
  const date = d.toLocaleDateString(lang, { year: '2-digit', month: 'numeric', day: 'numeric' })
  const time = d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit', hour12: !h24 })
  return `${date} ${time}`
}

/** "3 Feb 2026" — a calendar day, no time. For a field, not an axis. */
export function day(value: string | number | null | undefined): string {
  const d = asDate(value)
  return d ? d.toLocaleDateString(currentLanguage()) : DASH
}

/**
 * "31 Aug" — a calendar day, short, for a chart axis.
 *
 * A label on an axis has one slot and a locale date does not fit in it, which
 * is how the line charts ended up printing "8/24/2026" next to column charts
 * printing "Aug 31" on the same page. Every axis uses this.
 */
export function shortDay(value: string | number | null | undefined): string {
  const d = asDate(value)
  return d
    ? d.toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric' })
    : DASH
}

/** How long ago, coarsely: "3d 4h", "12m" in English. Future and bad values
 *  give a dash. */
export function since(value: string | number | null | undefined): string {
  const d = asDate(value)
  if (!d) return DASH
  const ms = Date.now() - d.getTime()
  if (ms < 0) return DASH
  return duration(Math.floor(ms / 1000))
}

/** The same shape as `since`, from a duration in seconds rather than a date. */
export function duration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return DASH
  }
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  if (days > 0) return `${unit(days, 'day')} ${unit(hours, 'hour')}`
  const mins = Math.floor((seconds % 3_600) / 60)
  return hours > 0 ? `${unit(hours, 'hour')} ${unit(mins, 'minute')}` : unit(mins, 'minute')
}

/* A count of days, hours, or minutes in the interface language: "3d" and "12m"
   in English, "3 Tg." and "12 Min." in German, "3 日" and "12 分" in Japanese.
   English takes the narrow form, which is what it always showed; the others
   the short one, because CLDR's narrow form is still "3d" in Japanese. The
   letters used to be written out here, so every language read "3d 4h". */
const units = new Map<string, Intl.NumberFormat>()
function unit(n: number, u: 'day' | 'hour' | 'minute'): string {
  const key = `${currentLanguage()}|${u}`
  let f = units.get(key)
  if (!f) {
    try {
      const english = currentLanguage().startsWith('en')
      f = new Intl.NumberFormat(currentLanguage(),
        { style: 'unit', unit: u, unitDisplay: english ? 'narrow' : 'short' })
    } catch {
      f = new Intl.NumberFormat(SOURCE, { style: 'unit', unit: u, unitDisplay: 'narrow' })
    }
    units.set(key, f)
  }
  return f.format(n)
}

/**
 * The Wi-Fi band a channel frequency belongs to.
 *
 * eero reports the channel center in MHz (2412, 5220, 6775) rather than a band
 * name, so the mapping lives here once instead of at each place that needs it.
 */
/**
 * The radio a mesh link runs on, in the words the rest of the app uses.
 *
 * eero names this one by frequency rather than by band: a node with a single
 * 5 GHz radio reports "5GHz", but the original eero Pro splits 5 GHz into two
 * radios and reports the lower one as "5.2GHz" — real, and not a band anyone
 * has ever seen written on a router. Elsewhere the same radios are called
 * `band_5GHz_low` and `band_5GHz_high`, which the backend already prints as
 * "5 GHz (low)" and "5 GHz (high)". This says the same thing here.
 *
 * Anything unrecognized is passed through: a band eero adds later should read
 * as whatever eero calls it, not disappear.
 */
export function meshRadioLabel(radio: string | null | undefined): string | null {
  if (!radio) return null
  const key = String(radio).trim().toLowerCase().replace(/\s+/g, '')
  if (key === '2.4ghz' || key === '2_4ghz') return '2.4 GHz'
  if (key === '5ghz') return '5 GHz'
  if (key === '5.2ghz' || key === '5ghz_low') return '5 GHz (low)'
  if (key === '5.8ghz' || key === '5.7ghz' || key === '5ghz_high') return '5 GHz (high)'
  if (key === '6ghz') return '6 GHz'
  return String(radio).trim()
}

export function bandOf(mhz: number | null | undefined): string | null {
  if (typeof mhz !== 'number' || mhz <= 0) return null
  if (mhz < 3000) return '2.4 GHz'
  if (mhz < 5925) return '5 GHz'
  return '6 GHz'
}

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday',
                   'friday', 'saturday', 'sunday']

/**
 * Which days a recurring window falls on, said the short way.
 *
 * eero returns capitalized full names in no guaranteed order, and a list of
 * seven of those is longer than the row it has to fit in.
 */
/**
 * Which days a schedule covers, in words.
 *
 * The shorthands are translated, and so are the day names: "Mon, Wed" is an
 * English convention twice over, once in the abbreviation and once in the
 * comma. Hungarian abbreviates differently and Spanish lowercases its days, so
 * neither can be reached by slicing three letters off an English name — which
 * is what this did.
 */
export function daysLabel(days: string[] | null | undefined): string {
  const set = new Set((days ?? []).map((d) => d.trim().toLowerCase())
                                  .filter((d) => DAY_ORDER.includes(d)))
  if (!set.size) return ''
  if (set.size === 7) return t('day.every_day')
  const weekdays = DAY_ORDER.slice(0, 5)
  const weekend = DAY_ORDER.slice(5)
  if (set.size === 5 && weekdays.every((d) => set.has(d))) return t('day.weekdays')
  if (set.size === 2 && weekend.every((d) => set.has(d))) return t('day.weekends')
  // Kept in week order rather than the order eero happened to send.
  return DAY_ORDER.filter((d) => set.has(d))
    .map((d) => t(`day.${d}.short`))
    .join(t('day.separator'))
}


/** A clock hour: 0 -> "12:00 AM" or "00:00", 13 -> "1:00 PM" or "13:00". */
export function clockHour(h: number, h24 = false): string {
  const hour = ((h % 24) + 24) % 24
  if (h24) return `${String(hour).padStart(2, '0')}:00`
  const suffix = hour < 12 ? 'AM' : 'PM'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:00 ${suffix}`
}

/**
 * A "HH:MM" clock string: "21:00" -> "9:00 PM" or "21:00".
 *
 * Tolerant of a seconds field, which eero includes on some schedules, and
 * returns the input untouched if it is not a time at all rather than
 * inventing one.
 */
export function clockTime(value: string | null | undefined,
                          h24 = false): string {
  const m = /^(\d{1,2}):(\d{2})/.exec((value ?? '').trim())
  if (!m) return value ?? ''
  const h = Number(m[1])
  if (!Number.isFinite(h) || h > 23) return value ?? ''
  if (h24) return `${String(h).padStart(2, '0')}:${m[2]}`
  const suffix = h < 12 ? 'AM' : 'PM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}:${m[2]} ${suffix}`
}

/** The one-hour window starting at `h`, as eero presents its update slot. */
export function hourWindow(h: number, h24 = false): string {
  return `${clockHour(h, h24)} - ${clockHour(h + 1, h24)}`
}

/**
 * Bytes in the units people read them in — eero's units, which are binary
 * ones under decimal names.
 *
 * This divided by powers of a thousand, which is what "GB" means and is the
 * defensible reading of a transfer figure. eero's app divides by powers of
 * 1024 and writes GB anyway, so the same September day read 4.3 GB here and
 * 4.2 GB there: the same bytes, seven per cent apart, with no way for anyone
 * holding both screens to tell which was wrong. Matching eero is worth more
 * than being right about SI here, because the number is eero's to begin with
 * and the comparison is the thing people actually do.
 */
const BYTE_UNITS = [
  { at: 1024 ** 4, unit: 'TB', dp: 2 },
  { at: 1024 ** 3, unit: 'GB', dp: 1 },
  { at: 1024 ** 2, unit: 'MB', dp: 0 },
  { at: 1024, unit: 'kB', dp: 0 },
  { at: 1, unit: 'B', dp: 0 },
]

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH
  const b = Math.max(0, n)
  const u = BYTE_UNITS.find((x) => b >= x.at) ?? BYTE_UNITS[BYTE_UNITS.length - 1]
  return `${(b / u.at).toFixed(u.dp)} ${u.unit}`
}

/**
 * The same figure for a stat tile: the number and its unit, separately,
 * in the largest unit the figure still reads as two digits in.
 *
 * A tile counts up to a bare number and rounds it, which is right for a
 * speed and wrong for a total: 1.4 GB in GB is a tile reading "1". In MB it
 * reads 1,434, which is the same fact with the resolution left in. Each
 * figure picks its own unit, because a unit chosen for its neighbor is how
 * a small upload ends up quoted as "0 GB".
 */
export function bytesTile(n: number | null | undefined):
  { value: number; unit: string } {
  if (n === null || n === undefined || Number.isNaN(n)) return { value: 0, unit: 'B' }
  const b = Math.max(0, n)
  const u = BYTE_UNITS.find((x) => b / x.at >= 10)
    ?? BYTE_UNITS[BYTE_UNITS.length - 1]
  return { value: b / u.at, unit: u.unit }
}

/** Cellular plans are quoted in kilobytes rather than bytes: a 130 GB plan
 *  reports 136,314,880 kB. Binary units, like everything else eero writes
 *  as GB. */
export function gbFromKb(kb: number | null | undefined): string {
  if (kb === null || kb === undefined || Number.isNaN(kb)) return DASH
  const gb = Math.max(0, kb) / 1_048_576
  return gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)
}
