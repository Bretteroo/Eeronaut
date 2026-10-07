import { useEffect, useState } from 'react'
import { api, ApiError, lastRead, type Capability } from '../lib/api'
import { Page, Card, Notice, SkeletonCard, Toggle, type CardSay } from '../components/primitives'
import { InboundAccess } from '../components/InboundAccess'
import { SecurityActivity } from '../components/SecurityActivity'
import { DomainList } from '../components/DomainList'
import { useCapabilities, GateReasonChip, PlusWhy } from '../lib/capabilities'
import { t, tx } from '../i18n'

interface Overview {
  premium_status?: string
  dns_provider?: string
  policies_enabled?: boolean
  block_malware?: boolean
  ad_block?: { enabled?: boolean; profiles?: unknown[] }
  advanced_content_filters?: unknown
  capabilities: Record<string, Capability>
}

interface DomainRule { domain: string; network_wide: boolean; profiles: string[] }
interface DomainLists { blocked?: DomainRule[]; allowed?: DomainRule[] }

/* cleanDomain, readDomains, and DomainList moved to components/DomainList.tsx
   when the profile filters page grew wide enough to use the same control. */

/* A function, not a constant: a module-level string is built before any
   language is in force. */
const lockedWhyText = () => t('security.editing_lists_part_eero_plus')

export function Security() {
  const { prefs } = useCapabilities()
  /* What this page said the last time it was looked at, until it answers
     again. Nothing here is current and nothing treats it as current — the
     effect below asks the server for all of it as the page mounts — but it
     is what was on the screen a moment ago, which is a better thing to
     arrive on than an outline of it. */
  const [ov, setOv] = useState<Overview | null>(
    () => lastRead<Overview>('/api/security/overview') ?? null)
  const [lists, setLists] = useState<DomainLists>(
    () => lastRead<DomainLists>('/api/security/domains') ?? {})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = () => {
    api.get<DomainLists>('/api/security/domains').then(setLists).catch(() => {})
    api.get<Overview>('/api/security/overview').then(setOv).catch(() => {})
  }

  /* Returns whether it worked. A caller that holds unsaved input needs to
     know: the domain box stops following the server while it has typing in it,
     and clearing that on a failed write would discard what the user just
     entered along with their chance to retry it. */
  async function runIn(into: CardSay, fn: () => Promise<unknown>,
                       ok: string | null): Promise<boolean> {
    setBusy(true); into.clear()
    // `ok` is null where the form reports its own outcome. The domain lists
    // print "Saved" beside their own button the moment the box matches the
    // server, so a notice above the card said it twice.
    try { await fn(); if (ok) into.ok(ok); reload(); return true }
    catch (e) {
      into.fail(e instanceof ApiError ? e.message : t('security.did_not_work'))
      return false
    }
    finally { setBusy(false) }
  }

  /* eero takes one domain per call, so a block edit becomes a run of them.
     Sequential rather than concurrent: the list is read-modify-written on
     eero's side, and firing them together loses all but the last. */
  const applyDomains = (into: CardSay, kind: 'blocked' | 'allowed',
                        add: string[], remove: string[],
                        onProgress: (done: number, total: number) => void) =>
    runIn(into, async () => {
      const total = add.length + remove.length
      let done = 0
      for (const domain of add) {
        await api.put(`/api/security/domains/${kind}`, { domain, keep_profiles: true })
        onProgress(++done, total)
      }
      for (const domain of remove) {
        await api.del(
          `/api/security/domains/${kind}?domain=${encodeURIComponent(domain)}`)
        onProgress(++done, total)
      }
    }, null)

  useEffect(() => {
    api.get<Overview>('/api/security/overview').then(setOv).catch((e) => setErr(e.message))
    api.get<DomainLists>('/api/security/domains').then(setLists).catch(() => {})
  }, [])

  if (err) return <Notice kind="bad">{err}</Notice>
  /* The page, not a stand-in for it: same name, same grid, so nothing
     reflows when the content arrives and everything a theme hangs off the
     page — its picture, its plan for the panes — is already in force while
     the page is still loading. */
  if (!ov) return (
    <Page name="security" columns={2}>
      {/* The two the page opens on, named as they will be named: the second
          was inbound access, which is the third card down. A placeholder
          standing where a different card is about to be is worse than a
          blank one. */}
      <SkeletonCard icon="shield" title={t('security.network_wide_protection')} rows={3} />
      <SkeletonCard icon="shield" title={t('insights.security_activity')} rows={4} />
    </Page>
  )

  const c = ov.capabilities ?? {}

  /* Whether a card should be absent rather than dimmed.
     The rows inside the protection card already checked this individually, so
     with the setting on it rendered an empty card with a title and an eero Plus
     badge — the one thing the setting exists to prevent. The lists card did not
     check at all and only dimmed itself. A card is dropped when every
     capability it exists to expose is subscription-gated and unavailable. */
  const hiddenByPref = (...names: string[]) =>
    prefs.hide_subscription_gated
    && names.every((n) => c[n] && !c[n].available && c[n].reason === 'subscription')
  /* Domain rules belong to eero Plus, so without it the lists are read-only.
     The existing rules stay visible: seeing what is already in force is not
     the paid part, and hiding it would only make the network harder to
     understand. */
  const listsLocked = Boolean(
    (c.dnsfilter_blocklist && !c.dnsfilter_blocklist.available
     && c.dnsfilter_blocklist.reason === 'subscription')
    || (c.dnsfilter_allowlist && !c.dnsfilter_allowlist.available
        && c.dnsfilter_allowlist.reason === 'subscription'))

  return (
    <Page name="security" columns={2}>
      {/* One mark for the card, beside its title: both toggles below are Plus,
          so a badge on each said the same thing twice. */}
      {!hiddenByPref('ad_block', 'dnsfilter_threat_categories') && (
      <Card icon="shield" title={t('security.network_wide_protection')} anchor="protection"
            plus={['ad_block', 'dnsfilter_threat_categories']}>
        {(paneSay) => (<>{(() => {
          const cap = c.ad_block
          const available = cap?.available ?? true
          if (!available && cap?.reason === 'subscription' && prefs.hide_subscription_gated) return null
          return (
            <div className="border-b border-[var(--color-line)] py-3 last:border-0">
              {/* Above the dimmed layer and before what it explains. Inside it
                  the badge was washed out by the same opacity that grays the
                  control, which is the one thing on a disabled row that has to
                  stay readable. */}
              {!available && cap?.reason !== 'subscription' && (
                <div className="mb-1.5 flex justify-end">
                  <GateReasonChip explanation={cap?.explanation ?? ''} />
                </div>
              )}
              {/* No wrapper opacity here: a disabled Toggle already dims
                  itself, and the two multiplied to 0.23 — darker than every
                  other locked thing in the app. One layer, one value. */}
              <div>
                <Toggle
                  label={t('security.ad_blocking')}
                  hint={t('security.blocks_advertising_tracking_domains_dns')}
                  checked={Boolean(ov.ad_block?.enabled)}
                  disabled={!available || busy}
                  onChange={(v) => runIn(paneSay, () => api.put('/api/security/adblock',
                                                     { enabled: v, profiles: [] }),
                                       v ? t('security.ad_blocking_enabled') : t('security.ad_blocking_disabled'))}
                />
              </div>
            </div>
          )
        })()}
        {(() => {
          const cap = c.dnsfilter_threat_categories ?? c.advanced_security
          const available = cap?.available ?? true
          if (!available && cap?.reason === 'subscription' && prefs.hide_subscription_gated) return null
          return (
            <div className="border-b border-[var(--color-line)] py-3 last:border-0">
              {!available && cap?.reason !== 'subscription' && (
                <div className="mb-1.5 flex justify-end">
                  <GateReasonChip explanation={cap?.explanation ?? ''} />
                </div>
              )}
              {/* No wrapper opacity here: a disabled Toggle already dims
                  itself, and the two multiplied to 0.23 — darker than every
                  other locked thing in the app. One layer, one value. */}
              <div>
                <Toggle
                  label={t('security.advanced_security')}
                  hint={t('security.blocks_domains_known_host_malware')}
                  checked={Boolean(ov.block_malware)}
                  disabled={!available || busy}
                  onChange={(v) => runIn(paneSay, () => api.put('/api/security/advanced-security',
                                                     { enabled: v }),
                                       v ? t('security.advanced_security_enabled') : t('security.advanced_security_disabled'))}
                />
              </div>
            </div>
          )
        })()}</>)}
      </Card>
      )}

      {/* Forwards and pinholes sit here rather than with the rest of the
          network settings: what they change is the firewall, and the cost of
          getting one wrong is a device exposed to the whole internet. */}
      {/* Directly after the two switches it is the report on. */}
      <SecurityActivity />

      <InboundAccess />

      {!hiddenByPref('dnsfilter_blocklist', 'dnsfilter_allowlist') && (
      <Card icon="domains"
        title={t('security.domain_rules')}
        anchor="domains"
        className="wide:col-span-2"
        plus={['dnsfilter_blocklist', 'dnsfilter_allowlist']}
      >
        {(paneSay) => (<>
        {/* Dimmed as a whole when the lists cannot be edited, the same way the
            protection toggles are. Disabling the controls alone left the pane
            looking usable, so it read as broken rather than as locked. */}
        {listsLocked && <PlusWhy>{lockedWhyText()}</PlusWhy>}
        <div className={listsLocked ? 'dimmed' : ''}>
        {/* eero's own Domain Guidelines, restated where the rules are typed:
            people reach for *.example.com first, and the refusal alone does
            not tell them what to type instead. */}
        {/* What the lists cover, before the lists: it is the first thing to
            know about them, and at the foot of the card it was read after
            somebody had already decided what to type. */}
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {t('security.these_rules_apply_every_profile')}
        </p>
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {tx('security.domain_rules_explained', {
            domain: <span className="font-mono">example.com</span>,
            sub: <span className="font-mono">shop.example.com</span>,
            tld: <span className="font-mono">org</span>,
            wildcard: (
              <span className="font-mono">{t('security.example_com')}</span>
            ),
          })}
        </p>
        <div className="grid gap-5 md:grid-cols-2">
          <DomainList title={t('security.blocked')} kind="blocked" busy={busy}
                      items={(lists.blocked ?? []).map((d) => d.domain)}
                      partial={(lists.blocked ?? []).filter((d) => !d.network_wide)}
                      empty={t('security.nothing_blocked_network_wide_blocks')}
                      locked={listsLocked} lockedWhy={lockedWhyText()}
                      onApply={(kind, add, rm, prog) =>
                        applyDomains(paneSay, kind, add, rm, prog)} />
          <DomainList title={t('security.allowed')} kind="allowed" busy={busy}
                      items={(lists.allowed ?? []).map((d) => d.domain)}
                      partial={(lists.allowed ?? []).filter((d) => !d.network_wide)}
                      empty={t('security.nothing_allow_list_entries_here')}
                      locked={listsLocked} lockedWhy={lockedWhyText()}
                      onApply={(kind, add, rm, prog) =>
                        applyDomains(paneSay, kind, add, rm, prog)} />
        </div>
        </div>
        </>)}
      </Card>
      )}
    </Page>
  )
}
