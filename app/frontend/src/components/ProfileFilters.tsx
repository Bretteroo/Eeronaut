import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import {
  Card, Collapsible, RowAction, Tabs, Toggle, useNotice,
} from './primitives'
import { usePlusGate, PlusLock, PlusTick, PlusWhy } from '../lib/capabilities'
import { DomainList } from './DomainList'
import { t, tOr, tx } from '../i18n'

/* Everything that filters one profile, in the order the eero app presents it:
   ad blocking, blocked apps, content filters, then the per-site lists.

   Content filters are shown the way the app shows them — four preset levels
   over the same ten policies, any of which can then be changed individually.
   The presets are not hard-coded: eero serves them from
   /safe_filter_levels, so a level eero re-tunes arrives with the data. */

export interface FilterProfile {
  url: string
  name: string
  /** eero owns this one and names it itself. The name is left exactly as
   *  eero sends it, in every language: eero's own app does the same — 56
   *  localized string tables and not one of them holds a value for it, and
   *  `ProfileRef.isUnassigned()` matches on URL, not on text. Diverging here
   *  would confuse anyone reading the two apps side by side. */
  unassigned?: boolean
  ad_block: boolean
  /** Whether the network-wide switch is what turned ad blocking on here. */
  ad_block_network?: boolean
  /** This profile's own site lists, separate from the network-wide ones. */
  sites?: { blocked: string[]; allowed: string[] }
  filters: { key: string; on: boolean }[]
  blocked_applications: string[]
  schedules: { url: string; name: string | null; enabled: boolean
               days: string[] | null; start: string | null
               end: string | null }[]
}

interface Level {
  id: string
  title: string
  description: string
  dns_policies: Record<string, boolean>
}
/** One filter, named and explained by eero rather than by this app. */
interface CatFilter {
  dns_policy: string
  title: string
  description?: string | null
}
interface Category { id?: number; title: string; filters: CatFilter[] }
interface Levels { levels?: Level[]; categories?: Category[] }


/* eero's own names for its content filters, translated.
 *
 * `/safe_filter_levels` returns the same strings the phone app shows, in
 * English. Each carries a stable identifier — `pre_teen_id`, `safe_search_enabled`,
 * `mature` — so they can be keyed on that and fall back to whatever eero sent
 * for a level or policy added since this app was last read against it. The
 * names follow eero's; the descriptions are written for Eeronaut, and eero's
 * own text appears only for a level or filter the catalog does not know.
 */
const levelTitle = (l: Level) => tOr(`filter_level.${l.id}`, l.title)
const levelDesc = (l: Level) => tOr(`filter_level.${l.id}.desc`, l.description)
const categoryTitle = (c: Category) => tOr(`filter_cat.${c.id ?? c.title}`, c.title)
const filterTitle = (f: CatFilter) => tOr(`filter_policy.${f.dns_policy}`, f.title)
const filterDesc = (f: CatFilter) =>
  tOr(`filter_policy.${f.dns_policy}.desc`, f.description ?? '')

const idOf = (p: { url: string }) => p.url.replace(/\/$/, '').split('/').pop() ?? ''

/**
 * One profile's blocked and allowed sites.
 *
 * The same bulk editor the network-wide lists on Security use. This was a
 * row-at-a-time add box with a Remove button per entry, because the page was a
 * narrow drawer and a ten-line textarea did not fit in it. The page is
 * full-width now, and the add box was the weaker control in every other
 * respect: a pasted list had to be entered one line at a time, there was no way
 * to see the whole list while editing it, and eero's one-domain-per-call API
 * was just as much of a queue either way — only without a progress bar to admit
 * it.
 *
 * No `partial` list: every entry here is scoped to this profile already, which
 * is the distinction that note exists to draw on the network-wide lists.
 */
function ProfileSites({ profile, busy, onRun }: {
  profile: FilterProfile
  busy: boolean
  onRun: (fn: () => Promise<unknown>, ok: string | null) => Promise<boolean>
}) {
  /* eero takes one domain per call here too, and rewrites the profile set
     behind each one, so these go out sequentially rather than together —
     concurrent writes to the same list lose all but the last. */
  const apply = (kind: 'blocked' | 'allowed', add: string[], remove: string[],
                 onProgress: (done: number, total: number) => void) =>
    onRun(async () => {
      const total = add.length + remove.length
      let done = 0
      for (const domain of add) {
        await api.put(`/api/profiles/${idOf(profile)}/sites`,
                      { domain, allow: kind === 'allowed', remove: false })
        onProgress(++done, total)
      }
      for (const domain of remove) {
        await api.put(`/api/profiles/${idOf(profile)}/sites`,
                      { domain, allow: kind === 'allowed', remove: true })
        onProgress(++done, total)
      }
    }, null)

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <DomainList title={t('profile_filters.blocked')} kind="blocked" busy={busy}
                  items={profile.sites?.blocked ?? []}
                  empty={t('profile_filters.nothing_blocked_for_this_profile')}
                  onApply={apply} />
      <DomainList title={t('profile_filters.allowed')} kind="allowed" busy={busy}
                  items={profile.sites?.allowed ?? []}
                  empty={t('profile_filters.nothing_allowed_for_this_profile')}
                  onApply={apply} />
    </div>
  )
}

/** Whether a profile's policies already match a preset exactly.
 *
 *  More than one preset can match: eero ships "Most Restrictive" and
 *  "Restrictive" with byte-identical policy sets, and stores no record of
 *  which was chosen. So a profile in that state really is both, and
 *  picking the first match would light up the wrong row for anyone who chose
 *  the second.
 */
function matches(level: Level, on: Set<string>): boolean {
  return Object.entries(level.dns_policies)
    .every(([k, want]) => on.has(k) === want)
}

interface AppEntry { name: string; label: string; categories: string[] }
interface AppsPayload { applications?: string[]; available?: AppEntry[] }

function BlockedApps({ profile, onChanged }: {
  profile: { id?: string; url: string }
  /** Told after a change, so the profile row behind the drawer can restate
   *  whether anything is restricted. Without it the list kept the counts it
   *  was loaded with and only caught up on a page reload. */
  onChanged: () => void
}) {
  const [data, setData] = useState<AppsPayload | null>(null)
  const [busy, setBusy] = useState(false)
  const say = useNotice()
  const id = profile.id ?? profile.url.replace(/\/$/, '').split('/').pop() ?? ''

  useEffect(() => {
    setData(null)
    api.get<AppsPayload>(`/api/profiles/${id}/apps`)
      .then(setData).catch(() => setData({ applications: [], available: [] }))
  }, [id])

  const blocked = data?.applications ?? []
  const available = data?.available ?? []

  async function toggle(app: string, on: boolean) {
    const next = on ? [...blocked, app] : blocked.filter((a) => a !== app)
    setBusy(true); say.clear()
    try {
      await api.put(`/api/profiles/${id}/apps`, { applications: next })
      setData({ ...data, applications: next })
      say.ok(t(on ? 'profile_filters.app_blocked'
                 : 'profile_filters.app_unblocked', { app }))
      onChanged()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('profile_filters.could_not_save'))
    } finally { setBusy(false) }
  }

  const capApps = usePlusGate('block_apps')
  const appsNeedPlus = !capApps.available && capApps.reason === 'subscription'
  if (capApps.hidden) return null

  return (
    <div>
      <p className="mb-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
        {t('profile_filters.blocking_works_refusing_service_s')}
      </p>
      {/* Why it is dimmed, in the words every other locked pane uses. A
          `PlusLock` alone leaves a grayed, inert list and a mark in a corner
          somewhere above, which says the feature is unavailable without ever
          saying so. */}
      {appsNeedPlus && <PlusWhy>{t('capabilities.feature_needs_subscription')}</PlusWhy>}
      {available.length ? (
        <PlusLock locked={appsNeedPlus}>
        <ul className="grid gap-1">
          {available.map((app) => (
            <li key={app.name}
                className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] py-1 text-[13px] last:border-0">
              <span className="min-w-0 truncate">{app.label}</span>
              {/* Writes on the spot, so it is a switch. The square boxes here
                  were the last controls on the page that committed immediately
                  without looking like it. */}
              <Toggle
                disabled={busy}
                srLabel={t('profile_filters.block_app', { app: app.label })}
                checked={blocked.includes(app.name)}
                onChange={(v) => toggle(app.name, v)}
              />
            </li>
          ))}
        </ul>
        </PlusLock>
      ) : blocked.length ? (
        /* The list eero would offer did not load, so what is showing is what
           this profile already blocks. Unblocking is still a write. */
        <PlusLock locked={appsNeedPlus}>
        <ul className="grid gap-1">
          {blocked.map((app) => (
            <li key={app}
                className="flex items-center justify-between border-b border-[var(--color-line)] py-1 text-[13px] last:border-0">
              <span className="min-w-0 truncate">
                {available.find((a) => a.name === app)?.label
                  ?? app.replace(/[_-]/g, ' ')}
              </span>
              <RowAction onClick={() => toggle(app, false)} disabled={busy}>
                {t('clients.unblock')}
              </RowAction>
            </li>
          ))}
        </ul>
        </PlusLock>
      ) : (
        <p className="text-[13px] text-[var(--color-ink-3)]">
          {data ? t('profile_filters.nothing_blocked_profile') : t('profile_filters.loading')}
        </p>
      )}
      {say.node && <div className="mt-2">{say.node}</div>}
    </div>
  )
}

/**
 * Everything you can set on one profile.
 *
 * A page rather than a drawer. It began as three tabs in a 440px panel and
 * grew to five once ad blocking and the site lists moved here from Security —
 * at which point the strip ran off the right edge and took its own tabs with
 * it. Five sections with lists and forms in them is a page.
 */
export function ProfileFilters({ profile, onChanged, bare = false }: {
  profile: FilterProfile | null
  onChanged: () => void
  /** Without the card around it, for a drawer that brings its own header. */
  bare?: boolean
}) {
  const [levels, setLevels] = useState<Level[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [busy, setBusy] = useState('')
  // Which section is showing. Reset per profile so opening a
  // different one does not land on whatever was last looked at.
  const [tab, setTab] = useState<
    'apps' | 'filters' | 'ads' | 'sites'>('apps')
  const [picked, setPicked] = useState<string | null>(null)
  const say = useNotice()
  const capFilters = usePlusGate('content_filters')
  const capAds = usePlusGate('ad_block')
  const capSites = usePlusGate('dnsfilter_blocklist')
  const capApps = usePlusGate('block_apps')

  useEffect(() => {
    if (!profile) return
    api.get<Levels>('/api/security/filter-levels')
      .then((d) => { setLevels(d?.levels ?? []); setCategories(d?.categories ?? []) })
      .catch(() => {})
  }, [profile?.url])   // eslint-disable-line react-hooks/exhaustive-deps


  if (!profile) return null

  /* The tabs carry no mark of their own. A plus small enough to fit on a tab
     had to drop the words and carry its meaning in a tooltip, which is a worse
     mark than the app uses anywhere else. It sits full size directly under the
     strip instead — close enough to the tab that it clearly belongs to it, and
     legible. */
  /* The four content controls eero scopes to a profile, plus pauses. Ad
     blocking and the site lists were network-wide only, which is half of how
     eero models them: every profile carries its own copy, and the network-wide
     switch on Security is a convenience that sets all of them at once. */
  const tabs = [
    ...(capApps.hidden ? [] : [{ id: 'apps', label: t('profile_filters.blocked_apps') }]),
    ...(capFilters.hidden ? [] : [{ id: 'filters', label: t('profile_filters.content_filters') }]),
    ...(capAds.hidden ? [] : [{ id: 'ads', label: t('profile_filters.ad_blocking') }]),
    ...(capSites.hidden ? [] : [{ id: 'sites', label: t('profile_filters.blocked_sites') }]),
  ]
  // If the tab that was open has just been hidden, fall to the first one left
  // rather than showing a strip with nothing selected.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id

  const id = idOf(profile)
  const on = new Set(profile.filters.filter((f) => f.on).map((f) => f.key))
  const matching = levels.filter((l) => matches(l, on))
  // Where several presets describe the same state, the one just clicked is the
  // one to show as current. That memory is per-session only, because the
  // server has nothing to remember it with.
  const active = matching.find((l) => l.id === picked) ?? matching[0]
  // Two presets can describe the same state. Marking both "current" is
  // accurate but reads as a fault, so one is marked and the overlap is stated
  // once underneath instead.
  const ambiguous = matching.length > 1

  const runProfile = (fn: () => Promise<unknown>, ok: string | null) =>
    run('profile', fn, ok)

  /** Returns whether it worked, so a caller can clear a form only on success. */
  // `ok` is null where the form reports its own outcome — the domain lists
  // print "Saved" beside their own button, so a notice above said it twice.
  async function run(key: string, fn: () => Promise<unknown>, ok: string | null) {
    setBusy(key); say.clear()
    try { await fn(); if (ok) say.ok(ok); onChanged(); return true }
    catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('profile_filters.did_not_work'))
      return false
    }
    finally { setBusy('') }
  }

  const writeFilters = (filters: Record<string, boolean>, ok: string) =>
    run('filters', () => api.put(`/api/profiles/${id}/content-filters`, { filters }), ok)

  /* The pane is one card with a tab strip, and each tab is a different
     feature: one gated, the next not. So the mark follows the open tab rather
     than the card, and the corner is empty on the tab that is free. */
  const tabPlus: Record<string, string | string[]> = {
    apps: 'block_apps',
    filters: 'content_filters',
    ads: 'ad_block',
    sites: ['dnsfilter_blocklist', 'dnsfilter_allowlist'],
  }

  const body = (<>
      {say.node && <div className="mb-3">{say.node}</div>}

      {/* A hidden feature loses its tab as well as its panel. Leaving the tab
          in place meant the setting removed the contents and left a heading
          that opened onto nothing. Scheduled pauses is not part of eero Plus,
          so it is always here — which is also why the tab strip never empties. */}
      <Tabs
        tabs={tabs}
        active={activeTab}
        onPick={(t) => setTab(t as typeof tab)}
        className="mb-3"
      />

      {activeTab === 'apps' && <BlockedApps profile={profile} onChanged={onChanged} />}

      {activeTab === 'filters' && (
        <>
        {/* Outside the lock: what the tab is for is worth reading whether or
            not this network can act on it, and an inert subtree is invisible
            to a screen reader. */}
        <p className="mb-3 text-[12px] leading-snug text-[var(--color-ink-3)]">
          {t('profile_filters.categories_apply_every_device_profile')}
        </p>
        {capFilters.needsPlus && <PlusWhy>{t('capabilities.feature_needs_subscription')}</PlusWhy>}
        <PlusLock locked={capFilters.needsPlus}>

          {levels.length > 0 && (
            <Collapsible title={t('profile_filters.filter_presets')} boxed>
              <p className="mb-2 text-[12px] leading-snug text-[var(--color-ink-3)]">
                {t('profile_filters.starting_point_sets_every_filter')}
              </p>
              <ul className="grid gap-1">
                {levels.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setPicked(l.id)
                        void writeFilters(l.dns_policies,
                                          t('profile_filters.filter_level_set_title', { title: levelTitle(l) }))
                      }}
                      className={`w-full rounded-md border px-2 py-1.5 text-left ${
                        active?.id === l.id
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
                          : 'border-[var(--color-line)]'}`}
                    >
                      <span className="flex items-center gap-2 text-[13px] font-medium">
                        {levelTitle(l)}
                        {active?.id === l.id && (
                          <span className="text-[11px] font-semibold text-[var(--color-accent-ink)]">
                            {t('profile_filters.current')}
                          </span>
                        )}
                      </span>
                      <span className="block text-[12px] leading-snug text-[var(--color-ink-3)]">
                        {levelDesc(l)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!active && (
                <p className="mt-1 text-[12px] text-[var(--color-ink-3)]">
                  {t('profile_filters.profile_s_filters_do_not')}
                </p>
              )}
              {ambiguous && (
                <p className="mt-1 text-[12px] leading-snug text-[var(--color-ink-3)]">
                  {t('profile_filters.levels_identical', {
                    levels: matching.map(levelTitle)
                      .join(t('profile_filters.and_join')),
                  })}
                </p>
              )}
            </Collapsible>
          )}

          {categories.map((cat) => (
            <div key={cat.title} className="mb-3 last:mb-0">
              <div className="micro-label mb-1">{categoryTitle(cat)}</div>
              <ul className="grid gap-1">
                {cat.filters.map((f) => (
                  <li key={f.dns_policy}
                      className="flex items-start justify-between gap-3 border-b border-[var(--color-line)] py-1.5 last:border-0">
                    <span className="min-w-0">
                      <span className="block text-[13px]">{filterTitle(f)}</span>
                      {/* Ours, from the catalog, for every filter we know;
                          eero's own text only for one it adds later. */}
                      {filterDesc(f) && (
                        <span className="block text-[12px] leading-snug text-[var(--color-ink-3)]">
                          {filterDesc(f)}
                        </span>
                      )}
                    </span>
                    {/* The name is already stated on the left, so the switch
                        carries it only for assistive technology. */}
                    <Toggle
                      checked={on.has(f.dns_policy)}
                      disabled={Boolean(busy)}
                      srLabel={filterTitle(f)}
                      onChange={(v) => writeFilters(
                        { [f.dns_policy]: v },
                        t(v ? 'profile_filters.filter_enabled'
                            : 'profile_filters.filter_disabled',
                          { filter: filterTitle(f) }))}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </PlusLock>
        </>
      )}


      {activeTab === 'ads' && (<>
        {capAds.needsPlus && <PlusWhy>{t('capabilities.feature_needs_subscription')}</PlusWhy>}
        <PlusLock locked={capAds.needsPlus}>
          {/* Held on, not merely reported on, when the network-wide switch is
              in force. eero refuses the write outright — `409
              error.network.adblock.enabled`, verified against the live API —
              so a switch that looked usable here would only ever produce an
              error. The network-wide setting is the one to change. */}
          <Toggle
            label={t('profile_filters.block_ads_profile')}
            hint={profile.ad_block_network
              /* Straight to the switch that is holding this one on, not to
                 the tab it lives on. `?pane=` scrolls that card into view and
                 flashes it, so the sentence ends where the fix is rather than
                 describing where to look for it. */
              ? tx('profile_filters.ad_block_held_by_network', {
                  link: (
                    <Link to="/security?pane=protection" className="link">
                      {t('profile_filters.network_wide_ad_blocking')}
                    </Link>
                  ),
                })
              : t('profile_filters.blocks_advertising_tracking_domains_dns')}
            checked={Boolean(profile.ad_block)}
            disabled={Boolean(busy) || capAds.needsPlus
                      || Boolean(profile.ad_block_network)}
            onChange={(v) => runProfile(
              () => api.put(`/api/profiles/${idOf(profile)}/adblock`, { enabled: v }),
              v ? t('profile_filters.ad_blocking_profile') : t('profile_filters.ad_blocking_off_profile'))}
          />
        </PlusLock>
      </>)}

      {activeTab === 'sites' && (<>
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {t('profile_filters.sites_blocked_allowed_devices_profile')}
        </p>
        {capSites.needsPlus && <PlusWhy>{t('capabilities.feature_needs_subscription')}</PlusWhy>}
        <PlusLock locked={capSites.needsPlus}>
          <ProfileSites
            profile={profile}
            busy={Boolean(busy)}
            onRun={runProfile}
          />
        </PlusLock>
      </>)}
  </>)

  if (bare) {
    /* The mark has no card corner to sit in, so it goes where the drawer's
       own header leaves room: above the strip, at its right. */
    return (
      /* The mark on the tab strip's own line, at its right — there is no card
         corner to put a sash in here, and a line of its own above the strip
         left it floating over nothing. */
      <div className="relative">
        {tabPlus[activeTab] && (
          <span className="absolute right-0 top-1 z-10">
            <PlusTick name={tabPlus[activeTab]} size={16} />
          </span>
        )}
        {body}
      </div>
    )
  }
  return (
    <Card icon="filter" title={t('profile_filters.filters')} anchor="filters"
          plus={tabPlus[activeTab]}>
      {body}
    </Card>
  )
}
