/**
 * Every time the interface prints, in one clock format.
 *
 * The formatters in `format.ts` stay pure and take the format as an argument;
 * this binds that argument to the setting once, so no call site chooses. That
 * is the whole point: before this existed the app ran three conventions at the
 * same time — schedules and firmware windows hard-coded to 12-hour, the
 * Insights hour axis hard-coded to 24, and anything going through a
 * locale-formatted date following whatever the browser preferred. Two of those
 * could disagree on a single screen.
 *
 * Read from the capability context rather than a prop, because the context
 * already carries prefs to every component and threading a format through the
 * column definitions of five tables would guarantee one gets missed.
 */
import { useMemo } from 'react'
import { useCapabilities } from './capabilities'
import { clockHour, clockTime, hourWindow, when, whenShort } from './format'

export function useClock() {
  const { prefs } = useCapabilities()
  const h24 = prefs.clock_24h
  return useMemo(() => ({
    h24,
    /** "3 Feb, 14:05" or "3 Feb, 2:05 PM". */
    when: (v: string | number | null | undefined) => when(v, h24),
    /** "9/30/26 2:23 AM" or "30.9.26 02:23", as the language writes it. */
    whenShort: (v: string | number | null | undefined) => whenShort(v, h24),
    /** A whole hour: "13:00" or "1:00 PM". */
    clockHour: (h: number) => clockHour(h, h24),
    /** A "HH:MM" string from eero, reformatted. */
    clockTime: (v: string | null | undefined) => clockTime(v, h24),
    /** The one-hour window eero offers for firmware updates. */
    hourWindow: (h: number) => hourWindow(h, h24),
    /**
     * An axis label for an hour bucket.
     *
     * Shorter than `clockHour`: 24 of these share one axis, so the 12-hour
     * form drops the ":00" and keeps only the meridiem — "2p" rather than
     * "2:00 PM", which at that width rendered as "2:00 …".
     */
    hourAxis: (h: number) => {
      const hour = ((h % 24) + 24) % 24
      if (h24) return `${String(hour).padStart(2, '0')}:00`
      const twelve = hour % 12 === 0 ? 12 : hour % 12
      return `${twelve}${hour < 12 ? 'a' : 'p'}`
    },
  }), [h24])
}
