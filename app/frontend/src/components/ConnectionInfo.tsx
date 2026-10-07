import { useEffect, useState } from 'react'
import { api, lastRead } from '../lib/api'
import { t } from '../i18n'
import { Card, SkeletonRows, StatusDot } from './primitives'
import { resolverFor } from '../lib/resolvers'

/**
 * What the ISP handed down: the connection, the public address, the resolvers
 * in force, the gateway, whether there are two NATs, and where the address
 * geolocates.
 *
 * Moved here from the Network page's Internet card. It reads better on the
 * dashboard than it did there for the reason the panel's own note gives: none
 * of it can be changed from this app, so it was the one group on a page of
 * controls that answered questions instead of asking them.
 *
 * It fetches for itself rather than taking `lan` as a prop, so the dashboard
 * does not have to know what a LAN document is to show a public address.
 */
interface Lan {
  wan_ip?: string; wan_type?: string; gateway_ip?: string; double_nat?: boolean
  dns?: {
    mode?: string
    custom?: { ips?: string[] } | null
    parent?: { ips?: string[] } | null
  } | null
  geo?: { city?: string | null; region?: string | null; country?: string | null
          isp?: string | null } | null
}

/* RFC1918 and friends. A resolver inside your own network is somebody running
   their own filtering resolver, which is worth acknowledging rather than
   reporting as a bare address. */
const isPrivate = (ip: string) =>
  /^10\./.test(ip)
  || /^192\.168\./.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  || /^127\./.test(ip)
  || /^169\.254\./.test(ip)
  || /^f[cd]/i.test(ip)          // fc00::/7, unique-local IPv6
  || ip === '::1'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div data-part="info-row"
         className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] py-2 last:border-0">
      <span data-part="info-label" className="micro-label">{label}</span>
      <span data-part="info-value" className="text-[13px] text-[var(--color-ink)]">{children}</span>
    </div>
  )
}

interface EeroDdns { enabled?: boolean; subdomain?: string | null }
interface ThirdPartyDdns { provider?: string; enabled?: boolean; name?: string }

export function ConnectionInfo() {
  /* Opens on the last answer; the effect below asks for a new one. */
  const [lan, setLan] = useState<Lan | null>(
    () => lastRead<Lan>('/api/network/lan') ?? null)
  /* Two sources for one row. eero's own name lives on the network document
     and is reserved whether or not it is on; a third-party name lives in this
     app's own config. They are exclusive by construction — the DDNS card
     turns one off before turning the other on — so at most one is publishing
     and that is the one to show. */
  const [eeroDdns, setEeroDdns] = useState<EeroDdns | null>(
    () => lastRead<EeroDdns>('/api/network/ddns') ?? null)
  const [thirdParty, setThirdParty] = useState<ThirdPartyDdns | null>(
    () => lastRead<ThirdPartyDdns>('/api/ddns') ?? null)
  useEffect(() => {
    api.get<Lan>('/api/network/lan').then(setLan).catch(() => setLan(null))
    api.get<EeroDdns>('/api/network/ddns').then(setEeroDdns).catch(() => setEeroDdns(null))
    api.get<ThirdPartyDdns>('/api/ddns').then(setThirdParty).catch(() => setThirdParty(null))
  }, [])
  const ddnsHost = eeroDdns?.enabled ? (eeroDdns.subdomain ?? null)
    : thirdParty?.enabled ? (thirdParty.name || null)
    : null
  /* On, but with no name to show: FreeDNS without its optional hostname.
     The provider's id stood in for the name here and read as one. */
  const ddnsUnnamed = !ddnsHost && !eeroDdns?.enabled && Boolean(thirdParty?.enabled)

  /* The resolvers in force, de-duplicated: eero repeats a single custom server
     across both slots, so the raw list repeats the same address twice. */
  const dnsServers = [...new Set(
    (lan?.dns?.mode === 'custom' ? lan?.dns?.custom?.ips : lan?.dns?.parent?.ips)
    ?? lan?.dns?.parent?.ips ?? [])]
  const dnsIsLocal = dnsServers.length > 0 && dnsServers.every(isPrivate)

  return (
    <Card icon="internet" title={t('network.current_connection_info')} anchor="connection">
      {() => (lan === null
        ? <SkeletonRows rows={7} cols={2} />
        : <div className="mt-1">
    {/* First, because it is the one line that decides whether the rest
    of them mean anything. `wan_ip` is the plainest evidence the
    app has here without reaching for the local plane: an address
    from upstream means the gateway got one. */}
    <Row label={t('network.connection_status')}>
    <span className="inline-flex items-center gap-1.5">
    <StatusDot state={lan.wan_ip ? 'ok' : 'bad'} />
    {lan.wan_ip
    ? (lan.wan_type
    ? t('network.connected_over', { how: lan.wan_type })
    : t('network.connected'))
    : t('network.no_address_from_upstream')}
    </span>
    </Row>
    <Row label={t('network.public_address')}>
    <span className="font-mono text-[12px]">{lan.wan_ip ?? '—'}</span>
    </Row>
    {/* Which resolver the network is actually handing out — the custom
    one if it is set, otherwise the ISP's. Worth stating next to the
    addresses: a network that resolves nothing looks identical to a
    network that is down, and this is the line that tells them
    apart. */}
    <Row label={t('network.dns_servers')}>
    {/* The tag leads, because it qualifies the addresses after it:
    read left to right it says "local" and then the address, rather than
    making you reach the end to find out what kind of address you
    just read. */}
    {/* Baseline, not center. The tag is 11px and the addresses are
    12px mono, so centering the two left the tag riding a pixel
    high against a row of digits — which on a line of figures is
    exactly where it shows. */}
    <span className="inline-flex flex-wrap items-baseline justify-end gap-2">
    {/* Which resolver, not what kind of address. "local" told you
    the addresses were inside the network, which the addresses
    themselves already say; the name is the thing you cannot
    read off them. The praise for running your own survives as
    the tooltip, since a private address that matches no known
    provider is somebody's own resolver. */}
    <span
    title={dnsIsLocal ? t('network.own_dns_server_praise') : undefined}
    className={`shrink-0 rounded bg-[var(--color-accent-wash)]
    px-1.5 text-[11px] font-semibold
    text-[var(--color-accent-ink)]
    ${dnsIsLocal ? 'cursor-help' : ''}`}
    >
    {resolverFor(lan.dns?.mode, dnsServers)}
    </span>
    <span className="font-mono text-[12px]">
    {dnsServers.length ? dnsServers.join(', ') : '—'}
    </span>
    </span>
    </Row>
    {/* "none" is a real answer here, not a missing one: most networks
        publish no name, and an em dash would read as the row having
        failed to load. */}
    <Row label={t('network.ddns_hostname')}>
      {ddnsHost
        ? <span className="font-mono text-[12px]">{ddnsHost}</span>
        : <span className="text-[var(--color-ink-3)]">
            {ddnsUnnamed ? t('network.ddns_unnamed') : t('network.ddns_none')}
          </span>}
    </Row>
    <Row label={t('network.gateway')}>
    <span className="font-mono text-[12px]">{lan.gateway_ip ?? '—'}</span>
    </Row>
    <Row label={t('network.double_nat')}>
    {lan.double_nat ? t('network.detected') : t('network.no')}
    </Row>
    {/* Who the WAN address belongs to, by the same lookup that places it.
        Worth having next to the address: a bare address says nothing, and
        the provider's name says who to ring. */}
    {lan.geo?.isp && (
      <Row label={t('network.isp')}>{lan.geo.isp}</Row>
    )}
    {lan.geo && (lan.geo.city || lan.geo.region) && (
    <Row label={t('network.appears')}>
    {[lan.geo.city, lan.geo.region, lan.geo.country].filter(Boolean).join(', ')}
    </Row>
    )}
          </div>
      )}
    </Card>
  )
}
