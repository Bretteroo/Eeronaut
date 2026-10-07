import { tOr } from '../i18n'

/**
 * What an eero or a Signal is doing, in the reader's language.
 *
 * The backend works the state out from the fields eero reports and sends
 * both a key and its English. The key is what gets translated; the English is
 * the fallback for a state added to the API after this release, which is
 * `tOr`'s whole purpose.
 *
 * This existed as raw English before. `status_label` went straight to the
 * screen, so "Restarting" and "Backup ready" were untranslatable — and
 * invisible to the scanner that finds untranslated strings, because that
 * reads frontend source and these were composed server-side. The live-status
 * work made it worse than cosmetic: "Restarting" is what somebody reads for
 * the five minutes their network is down.
 */
export const nodeStatusLabel = (n: {
  status_key?: string | null
  status_label?: string | null
}): string | undefined => {
  if (n.status_key) return tOr(`node_state.${n.status_key}`, n.status_label ?? n.status_key)
  return n.status_label ?? undefined
}

/**
 * What is wrong with a Signal, in the reader's language, or null when nothing
 * is. The same arrangement as above: eero's fault code is the key, and the
 * backend's English label is the fallback for a code this release has not
 * met.
 */
export const signalIssue = (a: {
  issue?: string | null
  configuration_status?: string | null
}): string | null => {
  if (!a.issue) return null
  const code = (a.configuration_status ?? '').trim().toLowerCase()
  return code ? tOr(`signal_issue.${code}`, a.issue) : a.issue
}
