/**
 * Whether the cloud has lost an eero entirely.
 *
 * eero's own `EeroStatus` enum has exactly three values, and the phone app
 * labels them Offline / Online / Connecting:
 *
 *     RED("red")  GREEN("green")  YELLOW("yellow")
 *
 * So anything that is neither online nor mid-join is an eero nothing can talk
 * to. That distinction was missing here, and the consequence was worse than a
 * missing label: the mesh map reported an unreachable eero as "Wired", because
 * "wired" was the fallback for any node with no wireless uplink — and an eero
 * that is off, unplugged, or gone has no wireless uplink either. The map
 * asserted a working cable next to a red dot.
 *
 * Keyed on `status` alone rather than also on `heartbeat_ok`: `status` is what
 * the status dot beside the label already reads, so this way the two can never
 * disagree, and a heartbeat that is briefly late is not the same thing as an
 * eero that is not there.
 */
export function unreachable(e: { status?: string | null }): boolean {
  const s = (e.status ?? '').toLowerCase()
  // No status at all means not loaded yet, which is not a claim either way.
  if (!s) return false
  return s !== 'green' && s !== 'connected' && s !== 'yellow'
}
