/**
 * eero's WAN state ladder, and what each rung means.
 *
 * `NodeStatus.wan_ts` reports a WANState that walks the connection outwards
 * from the WAN port. The rung it stops on is the difference between "the
 * modem is dead" and "my ISP is down", so it is worth saying in words.
 *
 * Shared rather than owned by the diagnosis pane: the header alert names the
 * same fault, and two copies of this wording would disagree within a release.
 */
import type { State } from '../components/primitives'
import { t } from '../i18n'

export interface WanIf {
  state: string
  ipv4: string | null
  ipv6: string | null
  ifname: string | null
  offline_since: string | null
}

export interface Wan {
  type: string
  interfaces: WanIf[]
  routes: { gateway: string | null; interface: string | null
            destination: string | null }[]
  serial?: string
  role?: string | null
}

export interface NetStatus {
  source_location?: string | null
  wan: Wan | null
  nodes: { serial: string; wan_v4: string; lan_v4: string }[]
}

export interface Rung {
  tone: State
  /** Enough on its own in a one-line alert. */
  short: string
  /** Whose fault it is. Empty when there is no fault. */
  blame: string
  next: string[]
}


export const WAN_TYPE: Record<string, string> = {
  wired: 'wan.type_wired',
  lte: 'wan.type_lte',
  backup_ap: 'wan.type_backup_ap',
}

/** Tone per rung. The words live in the catalog; only the severity is code. */
const TONE: Record<string, State> = {
  NO_LINK: 'bad', NO_IP: 'bad', NO_GATEWAY: 'bad',
  GATEWAY_UNREACHABLE: 'bad', AUTH_FAILED: 'bad',
  NO_DNS: 'warn', DNS_UNREACHABLE: 'warn', WALLED: 'warn', UNKNOWN: 'warn',
  ONLINE: 'ok',
}

/** How many numbered suggestions each rung has, so the lookup knows to stop. */
const STEPS: Record<string, number> = {
  NO_LINK: 3, NO_IP: 3, NO_GATEWAY: 2, GATEWAY_UNREACHABLE: 2,
  NO_DNS: 1, DNS_UNREACHABLE: 1, WALLED: 2, AUTH_FAILED: 2,
  ONLINE: 0, UNKNOWN: 1,
}

/**
 * The rung, in the reader's language.
 *
 * Built on each call rather than held in a module-level table. The table came
 * first and was the bug: its strings were evaluated once at import, before any
 * language was in force, so the whole outage diagnosis stayed English however
 * the interface was set. This file is also a `.ts`, which is why the string
 * extractor never saw it — it only globbed `.tsx`.
 */
export const rungFor = (state: string | undefined | null): Rung => {
  const key = state && TONE[state] ? state : 'UNKNOWN'
  const low = key.toLowerCase()
  return {
    tone: TONE[key],
    short: t(`wan.${low}.short`),
    blame: key === 'ONLINE' ? '' : t(`wan.${low}.blame`),
    next: Array.from({ length: STEPS[key] ?? 0 },
                     (_, i) => t(`wan.${low}.next${i + 1}`)),
  }
}

/** Whether a reported state is a fault. `UNKNOWN` is not: it means "not yet". */
export const isOutage = (state: string | undefined | null): boolean =>
  Boolean(state && state !== 'ONLINE' && state !== 'UNKNOWN')
