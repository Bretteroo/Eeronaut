import { t } from '../i18n'
import { unreachable } from './nodes'
import { nodeState } from './nodeState'
import { signalIssue } from './nodeStatusLabel'

/**
 * What a node's state means, in a sentence, for hover text and the drawer.
 *
 * One source for every place that shows a state — the dashboard strip, the
 * eeros list, the mesh diagram, the node drawer — so they cannot disagree
 * about what "Connecting…" or "Issue" is. Null for a state that needs no
 * explaining: online, power saving, backup ready.
 */
export function nodeStateHelp(e: { status?: string | null; status_key?: string | null }): string | null {
  if (unreachable(e)) return t('node_panel.unreachable_alert')
  const key = e.status_key ?? ''
  if (key === 'restarting') return t('node_state_help.restarting')
  if (key === 'updating') return t('node_state_help.updating')
  if (key === 'connecting') return t('node_state_help.connecting')
  if (key === 'issue' || nodeState(e) === 'warn') return t('node_state_help.issue')
  return null
}

/** eero's fault codes for a modem that hears no network; the backend's
 *  ACCESSORY_NO_SIGNAL. */
const NO_RECEPTION = new Set(['no_connection', 'no_signal'])

/** The same for an eero Signal, whose states are its own. */
export function accessoryStateHelp(a: {
  issue?: string | null; status_key?: string | null; registered?: boolean
  configuration_status?: string | null
}): string | null {
  /* No reception is the one fault with something to try: the modem hears no
     network where it is, and the cure is somewhere else. The others are
     eero's or the carrier's to fix. */
  if (a.issue && NO_RECEPTION.has((a.configuration_status ?? '').toLowerCase())) {
    return t('node_state_help.signal_no_reception', { issue: signalIssue(a) })
  }
  if (a.issue) return t('node_state_help.signal_issue', { issue: signalIssue(a) })
  /* Both before the registration check: a Signal setting itself up or taking
     an install is registered to nothing for a while, which is not the same
     as one that cannot register at all. Each carries a sentence, and that is
     what puts the amber mark on it rather than the tick that would say the
     device is ready. */
  if (a.status_key === 'configuring') return t('node_state_help.signal_configuring')
  if (a.status_key === 'updating') return t('node_state_help.signal_updating')
  if (a.status_key === 'connecting' || a.registered === false) {
    return t('node_state_help.signal_unregistered')
  }
  return null
}
