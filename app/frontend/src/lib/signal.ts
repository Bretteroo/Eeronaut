/* How strong a signal is, decided once.
 *
 * Four bars, everywhere. That is what eero's own app draws — its cellular
 * strength icons come in five files, 0/25/50/75/100, which is four steps and
 * an empty one — and Eeronaut drew four in most places and five in the two
 * that showed a mesh uplink.
 *
 * ## Which number to believe
 *
 * eero publishes a rating of its own for every kind of link, and Eeronaut also
 * knows how to derive one from RSSI. They are not the same measurement and
 * they do not agree. Measured across the 57 wireless clients on the network
 * this was built against:
 *
 *     eero's rating   RSSI      bars from the rating   bars from the RSSI
 *     5               -73 dBm   4                      1
 *     4               -81 dBm   3                      0
 *     5               -60 dBm   4                      3
 *
 * eero rates a link on more than its RSSI — the negotiated rate and the band
 * matter too — so a client sitting at -73 dBm on a clean 5 GHz radio really is
 * doing fine, and the phone app says so. Where eero has rated something, that
 * rating is the answer. The thresholds below are for links it has not rated,
 * and nothing else.
 *
 * Getting this wrong is what made the Topology map and the client drawer
 * disagree about the same device: the map passed eero's rating and the drawer
 * passed only the dBm, so one showed four green bars and the other two orange
 * ones. There is one way in here now, and it takes the whole record rather
 * than whichever field a call site remembered.
 *
 * ## eero's scales
 *
 * Two of them, which is the other half of the trap:
 *
 *   `score_bars`        a client's link       1-5
 *   `mesh_quality_bars` an eero's uplink      1-5
 *   `signal_score`      a cellular accessory  0-4
 *
 * All three are observed live, not guessed: `score_bars` came back 3, 4 and 5
 * across 57 clients; `mesh_quality_bars` came back 2 through 5 across three
 * networks; `signal_score` is documented 0-4 where the backend reads it.
 */

/** The one scale. Every bar meter in the app draws this many. */
export const BARS = 4

const clamp = (n: number) => Math.max(0, Math.min(BARS, n))

/** eero's 1-5 rating — a client link or a mesh uplink — as 0-4. */
export function fromRating(rating: number | null | undefined): number | null {
  return typeof rating === 'number' ? clamp(rating - 1) : null
}

/** eero's 0-4 rating, which is what a cellular accessory reports. */
export function fromScore(score: number | null | undefined): number | null {
  return typeof score === 'number' ? clamp(score) : null
}

/**
 * From RSSI alone. The fallback, for a link eero has not rated.
 *
 * Deliberately not used where a rating exists: these thresholds disagree with
 * eero by up to three bars on a real client.
 */
export function fromDbm(dbm: number | null | undefined): number | null {
  if (typeof dbm !== 'number') return null
  return dbm >= -50 ? 4 : dbm >= -60 ? 3 : dbm >= -70 ? 2 : dbm >= -80 ? 1 : 0
}

/** What eero reports about one client's link, in whatever shape it arrived. */
export interface LinkReading {
  /** eero's own 1-5 rating for the link. */
  rating?: number | null
  /** RSSI, for the fallback and for the hover readout. */
  dbm?: number | null
}

/**
 * A client's signal: eero's rating where there is one, RSSI where there is
 * not, and null when there is neither — which is not the same as zero bars and
 * must not be drawn as one.
 */
export function clientBars(link: LinkReading | null | undefined): number | null {
  if (!link) return null
  return fromRating(link.rating) ?? fromDbm(link.dbm)
}

/** An eero's uplink to the rest of the mesh. eero's 1-5, like a client's. */
export function meshBars(quality: number | null | undefined): number | null {
  return fromRating(quality)
}

/**
 * A sortable number for a signal column.
 *
 * Bars dominate and the dBm breaks ties inside a band, so a run of four-bar
 * clients still reads strongest-first. The dBm term cannot reach the next band
 * because a plausible RSSI range is nowhere near 100 wide.
 *
 * Exported so a column sorts by exactly what it draws. The clients table once
 * sorted on RSSI while drawing eero's rating, and on a 63-client network that
 * put eight rows visibly out of order.
 */
export function sortValue(link: LinkReading | null | undefined): number | null {
  const bars = clientBars(link)
  if (bars === null) return null
  return bars * 100 + Math.max(0, Math.min(99, 100 + (link?.dbm ?? -100)))
}

/** The color a meter is drawn in, by how full it is. */
/**
 * The four words eero gives a link, in four colors.
 *
 * `tone` below is a three-step scale — fine for bars, where how many of them
 * are lit is what separates one reading from the next and the color is only
 * the mood. A card that names all four words and colors them by that scale
 * draws Strong and Good in exactly the same green, which is the strength
 * spread on the Airtime page saying two different things in one color.
 *
 * So Good is that green carried part of the way toward the warning color:
 * still plainly the good end of the scale, and plainly not Strong.
 */
export function strengthTone(bars: number): string {
  return bars >= 4 ? 'var(--color-ok)'
       : bars === 3 ? 'color-mix(in oklab, var(--color-ok) 58%, var(--color-warn))'
       : bars === 2 ? 'var(--color-warn)'
       : 'var(--color-bad)'
}

export function tone(bars: number): string {
  const share = bars / BARS
  return share >= 0.7 ? 'var(--color-ok)'
       : share >= 0.45 ? 'var(--color-warn)' : 'var(--color-bad)'
}
