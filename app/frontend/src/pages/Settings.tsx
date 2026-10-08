import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, lastRead, type Prefs } from '../lib/api'
import { ACTION, FIELD, FIELD_WIDE, Field, Page, Card, EditableText, ReleaseNotesLink, SkeletonCard, SkeletonRows, SubmitButton, Toggle, useNotice, type CardSay } from '../components/primitives'
import { usePremiumActive, PlusStatus, PlusTick, useCapability } from '../lib/capabilities'
import { useClock } from '../lib/clock'
import { copyText } from '../lib/clipboard'
import { t, tOr, LANGUAGES } from '../i18n'
import { UpdateNowButton, type Updates } from '../components/FirmwareUpdate'
import { ThemePicker } from '../components/ThemePicker'
import { AppUpdateNotice } from '../components/AppUpdate'
import { useOpenAbout } from '../lib/about'

/** Every zone the browser knows, sorted, computed once.
 *
 *  `Intl.supportedValuesOf` is the platform's own copy of the IANA database,
 *  so it stays current without this repo shipping a list that rots. Falls
 *  back to whatever the network already reports if a browser lacks it, which
 *  leaves the field usable rather than empty.
 */
let ZONES: string[] | null = null
const zones = (): string[] => {
  if (ZONES) return ZONES
  try {
    ZONES = Intl.supportedValuesOf('timeZone')
  } catch {
    ZONES = []
  }
  return ZONES
}

interface Invite {
  id: string | null
  role: string | null
  status: string | null
  expires_at: string | null
  url: string | null
}

interface Identity {
  nickname: string | null
  name: string | null
  timezone: string | null
  /** What eero worked out from the connection, so the interface can say
   *  whether the zone in force is that guess or somebody's choice. */
  timezone_from_geo: string | null
  geo: { city: string | null; region: string | null; country: string | null }
}

interface VersionInfo {
  latest: string | null
  current: string
  update_available: boolean
  stale: boolean
  source: string
  /** Unix seconds. The server has always sent this; it just was not shown. */
  checked_at?: number | null
}

interface NotifPref { key: string; label: string; enabled: boolean }

interface SimpleSetup {
  auto_setup?: boolean
  auto_setup_mode?: string | null
}

/* The notification rows, as eero's own app groups them.
 *
 * eero's API is ten independent booleans; the app shows seven rows, two of
 * which carry a control rather than a second switch. The keys are eero's, the
 * grouping is the app's, and the labels were read off its own strings —
 * `notification_permission_updates`, `notification_network_status`,
 * `new_device_notifications_title` and the rest — rather than invented here.
 *
 * Two of eero's booleans are deliberately absent, because the app does not
 * show them either: a blocked port, and the weekly eero Plus summary. The PUT
 * merges rather than replaces, so leaving them out of this list leaves them
 * alone rather than turning them off.
 */
const NOTIF_ROWS: {
  id: string
  /** The eero switch this row turns on and off. */
  key: string
  /** A second key narrowing what the first one alerts about. */
  alt?: string
  /** The capability that makes this row an eero Plus feature. */
  plus?: string
  /** Whether the row carries the reporting frequency. */
  cadence?: boolean
}[] = [
  { id: 'permissions', key: 'permissions.updates' },
  { id: 'network_status', key: 'backup.internet.status.change' },
  { id: 'new_devices', key: 'device.new', alt: 'device.restrict.new.private' },
  { id: 'update_early', key: 'network.scheduledUpdate.earlyNotification' },
  { id: 'update_late', key: 'network.scheduledUpdate.lateNotification' },
  { id: 'update_done', key: 'network.updated' },
  { id: 'data_usage', key: 'network.dataUsageReport', plus: 'historical_usage',
    cadence: true },
]

export function Settings({ prefs: appPrefs, onPrefs }:
  { prefs: Prefs; onPrefs: (p: Prefs) => void }) {
  const [prefs, setPrefs] = useState<Prefs | null>(appPrefs)
  /* The app's copy is the one to follow, and this page does not fetch its
     own. It used to, on mount, and hand the answer up to the app. Changing
     the language remounts everything under the language, this page
     included, and that read went out ahead of the save: it came back with
     the language being left, from the read cache or from the server, and put
     it back. Every change landed one behind. Following the app's copy also
     covers arriving here before the app's own first read has landed. */
  useEffect(() => { setPrefs(appPrefs) }, [appPrefs])
  const { when, clockHour, hourWindow } = useClock()
  const premiumActive = usePremiumActive()
  const [cadence, setCadence] = useState('none')
  const openAbout = useOpenAbout()
  const [changingPw, setChangingPw] = useState(false)
  const [savingPw, setSavingPw] = useState(false)
  const pwSay = useNotice()

  useEffect(() => {
    api.get<{ cadence?: string }>('/api/insights/report-settings')
      .then((r) => setCadence(r?.cadence ?? 'none')).catch(() => {})
  }, [])
  const [ver, setVer] = useState<VersionInfo | null>(null)
  /* This program's own version, for the line at the foot of the Eeronaut
     card; the shell asks the same question, so the answer is usually cached. */
  const [appVersion, setAppVersion] = useState(
    () => lastRead<{ version?: string }>('/api/health')?.version ?? '')
  /* The eero app version this program presents to eero, which it keeps
     current by itself; shown as E-APK at the foot of the Eeronaut card. */
  const [presented, setPresented] = useState('')
  /* Null until eero answers: an empty list is "this network offers none",
     which is a different thing from "not asked yet", and the pane said the
     first while it meant the second.

     Seeded from the read cache, so coming back to this page draws the rows
     rather than an outline of them. The answer was already in hand — the
     promise that carries it just resolves a tick after the first render,
     and the card spent that tick showing seven skeleton rows. */
  const [prefsRows, setPrefsRows] = useState<NotifPref[] | null>(
    () => lastRead<{ preferences: NotifPref[] }>(
      '/api/notifications/preferences')?.preferences ?? null)
  /* The Eeronaut column's switches, seeded the same way and for the same
     reason. It started as an empty object, so every visit drew all seven
     switches off and then slid the ones that were on across a moment
     later. Null until known, and the rows wait for it. */
  const [webNotif, setWebNotif] = useState<Record<string, boolean> | null>(
    () => lastRead<{ preferences: Record<string, boolean> }>(
      '/api/settings/web-notifications')?.preferences ?? null)
  const [savingPrefs, setSavingPrefs] = useState(false)
  const [savingCadence, setSavingCadence] = useState(false)
  const [members, setMembers] = useState<{ members: { name: string | null; role: string | null; is_you: boolean }[] } | null>(null)
  /* eero Simple Setup, moved here from a card of its own on the Network page.
     It belongs with the network's nickname, its update window, and who may
     administer it: all of those are standing policy about what may change this
     network without somebody doing it now, which is exactly what "a new wired
     eero may enroll itself" is. The Network page next door is plumbing. */
  const [simple, setSimple] = useState<SimpleSetup | null>(null)
  const [savingSimple, setSavingSimple] = useState(false)
  /* eero's "Nickname & location": a label the owner types and the zone the
     network reports its own time in. `nickname` is not the Wi-Fi name — that
     is `name` — and the zone is not cosmetic, so both are shown with what
     they affect rather than as bare fields. */
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  /* The link eero hands back when an invite is made. Held in state rather
     than only listed below, because it is the one thing somebody needs right
     now and the list does not always carry it back. */
  const [fresh, setFresh] = useState<Invite | null>(null)
  const [inviting, setInviting] = useState(false)

  /* Only an owner can invite, and eero refuses anybody else — so the control
     is shown to owners rather than offered to everyone and then rejected.
     `/api/members` already works out which member is you, from eero's own
     `is_me` user tag. */
  const isOwner = (members?.members ?? []).some(
    (m) => m.is_you && (m.role ?? '').toLowerCase() === 'owner')

  const loadInvites = useCallback(() => {
    api.get<{ invites: Invite[] }>('/api/network/admins/invites')
      .then((r) => setInvites(r?.invites ?? [])).catch(() => setInvites([]))
  }, [])

  /* An expired invite is a link that no longer does anything, so it is not
     listed. It is not withdrawn either: eero keeps listing it and answers a
     withdrawal with 404, so trying sent a failing write on every visit, and
     every write empties the read cache the other pages open on.

     eero says `expired` when it lists one, but an invite can also run out
     while the page is open. `now` moves on when the soonest one does, so
     the list and the fresh link both drop it on time. */
  const [now, setNow] = useState(() => Date.now())
  const expired = (i: Invite, at: number) => i.status === 'expired'
    || (!!i.expires_at && Date.parse(i.expires_at) <= at)
  const liveInvites = invites.filter((i) => !expired(i, now))
  useEffect(() => {
    const at = Date.now()
    if (fresh && expired(fresh, at)) setFresh(null)
    const next = [...invites, ...(fresh ? [fresh] : [])]
      .filter((i) => !expired(i, at) && i.expires_at)
      .map((i) => Date.parse(i.expires_at!) - at)
      .filter((ms) => ms > 0)
    if (!next.length) return
    const id = window.setTimeout(() => setNow(Date.now()),
                                 Math.min(Math.min(...next) + 1000, 2 ** 31 - 1))
    return () => window.clearTimeout(id)
  }, [invites, fresh, now])   // eslint-disable-line react-hooks/exhaustive-deps
  /* Opens on the last answer. Until it has one this select is disabled, and
     a disabled control is drawn at half strength — so on every load the
     update window was a faint row that read as broken rather than as
     loading. */
  const [updates, setUpdates] = useState<Updates | null>(
    () => lastRead<Updates>('/api/network/updates') ?? null)
  /* Re-read after starting an update: has_update and can_update_now both
     change, and a row still offering t('firmware.update_now') after one has begun invites
     a second press. */
  const reloadUpdates = useCallback(() =>
    api.get<Updates>('/api/network/updates')
      .then(setUpdates).catch(() => {}), [])

  /* The page's opening reads, once. `onPrefs` comes from the parent and the
     two loaders are rebuilt per render, so listing them would refetch
     everything on every render — and `onPrefs` sets state in the parent,
     which renders this again. */
  useEffect(() => {
    api.get<{ client_version: string }>('/api/settings/client')
      .then((c) => setPresented(c.client_version)).catch(() => {})
    api.get<VersionInfo>('/api/settings/client/latest').then(setVer).catch(() => {})
    api.get<{ version?: string }>('/api/health')
      .then((h) => setAppVersion(h?.version ?? '')).catch(() => {})
    api.get<typeof members>('/api/members').then(setMembers).catch(() => {})
    api.get<SimpleSetup>('/api/network/simple-setup').then(setSimple).catch(() => {})
    api.get<Identity>('/api/network/identity').then(setIdentity).catch(() => {})
    loadInvites()
    void reloadUpdates()
    api.get<{ preferences: NotifPref[] }>('/api/notifications/preferences')
      .then((r) => setPrefsRows(r?.preferences ?? [])).catch(() => {})
    api.get<{ preferences: Record<string, boolean> }>('/api/settings/web-notifications')
      .then((r) => setWebNotif(r?.preferences ?? {})).catch(() => setWebNotif((w) => w ?? {}))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  /* eero's switches by key, which is what the rows read. `prefsRows` is the
     list as it arrived; this is the state of it. */
  const sent = Object.fromEntries((prefsRows ?? []).map((r) => [r.key, r.enabled]))
  /* The usage report is an eero Plus feature, so its row is marked and its
     controls do nothing without the subscription. */
  const usageCap = useCapability('historical_usage')
  const usageAllowed = usageCap.available

  /** Write the reporting frequency, and show what eero stored rather than
   *  what was picked.
   *
   *  eero answers the write with the settings as they now stand, so that is
   *  what the menu ends up reading — a write it silently declined would show
   *  as the old value coming back rather than as the new one sticking. */
  async function saveCadence(v: string, say: CardSay) {
    const was = cadence
    setCadence(v)
    /* Held while the write is out, the same as the switches: the menu grays
       for the round trip, which is how the row says it is doing something. */
    setSavingCadence(true)
    try {
      const r = await api.put<{ cadence?: string }>(
        '/api/insights/report-settings', { cadence: v })
      if (r?.cadence) setCadence(r.cadence)
    } catch {
      setCadence(was)
      say.fail(t('settings.could_not_save_report_setting'))
    } finally { setSavingCadence(false) }
  }

  /** Write one or more of eero's switches, putting them back if it fails. */
  async function setSent2(patch: Record<string, boolean>, say: CardSay) {
    const before = prefsRows
    setPrefsRows((rs) => (rs ?? []).map((r) => (
      r.key in patch ? { ...r, enabled: patch[r.key] } : r)))
    setSavingPrefs(true)
    try {
      await api.put('/api/notifications/preferences', { preferences: patch })
    } catch {
      setPrefsRows(before)
      say.fail(t('settings.could_not_save_notification_setting'))
    } finally { setSavingPrefs(false) }
  }

  /* One write at a time, in the order they were made. Each carries the whole
     set of preferences, and two sent together can land in either order: a
     switch flipped on and back off again left the server holding "on" when
     the second write finished first, while the page said "off". */
  const writing = useRef<Promise<unknown>>(Promise.resolve())
  async function update(patch: Partial<Prefs>) {
    if (!prefs) return
    const next = { ...prefs, ...patch }
    setPrefs(next)
    onPrefs(next)                 // so theme (and other app-wide prefs) apply at once
    const write = writing.current.catch(() => {})
      .then(() => api.put('/api/settings/prefs', next))
    writing.current = write
    await write
  }

  if (!prefs) return (
    <Page name="settings"><SkeletonCard rows={6} /></Page>
  )

  /* The clock's label says which way it is set, so the field and the
     switch's own accessible name are the same words. */
  const clockLabel = prefs.clock_24h ? t('settings.clock_24h') : t('settings.clock_12h')

  return (
    /* One column, full width. Two columns were tried: these cards are of
       very different heights — a language menu beside the whole of
       Operations — so the pairs left ragged holes down the page, and every
       card that wanted the width had to say so. The Dashboard and Insights
       keep their two, where the panes are of a size.

       The 768px cap this page used to carry is gone either way: on anything
       wider than a laptop it left a narrow column against an empty
       half-screen, with the notifications table the thing being squeezed. */
    <Page name="settings">
      <Card icon="bell" title={t('settings.notifications')} anchor="notifications">{(paneSay) => (<>
        {prefsRows === null || webNotif === null ? (
          <SkeletonRows rows={7} cols={3} />
        ) : prefsRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[12px] text-[var(--color-ink-3)]">
                  <th className="py-1 pr-3 font-medium">{t('settings.event')}</th>
                  <th className="px-2 py-1 text-center font-medium">{t('settings.mobile_app')}</th>
                  {/* The interface's own name, from the one string that
                      holds it: this column is the alerts that appear here
                      rather than on a phone. */}
                  <th className="px-2 py-1 text-center font-medium">{t('shell.eeronaut')}</th>
                  {/* The marks column. Unheaded on purpose: it says nothing
                      about the rows that have no mark, and a heading over a
                      mostly-empty column reads as a third thing to set. */}
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {NOTIF_ROWS.map((row) => {
                  const on = Boolean(sent[row.key])
                  const here = Boolean(webNotif?.[row.key])
                  const label = t(`notif_row.${row.id}`)
                  /* A row whose event needs a subscription is off entirely
                     without one: eero will not send it, and this app has
                     nothing to show, so neither switch is a real choice. */
                  const locked = Boolean(row.plus) && !usageAllowed
                  /* A frequency only means something if the event is going
                     somewhere. With both switches off it is a setting for a
                     message nobody receives, so it is shown and grayed rather
                     than removed — taking it away moved the row's contents
                     about every time a switch was pressed. */
                  const quiet = locked || (!on && !here)
                  return (
                  /* One height for every row, whatever is in it. Three of
                     the seven carry a menu and the rest do not, so the rows
                     came out two different heights down the card — and a
                     theme that gives its menus more room than the markup
                     asked for made the difference worse. */
                  <tr key={row.id}
                      className={`h-12 border-b border-[var(--color-line)] last:border-0${
                        locked ? ' text-[var(--color-ink-3)]' : ''}`}>
                    <td className="py-1 pr-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <span>{label}</span>
                        {/* Which new devices, rather than a second switch.
                            The second key narrows the first rather than
                            replacing it, so both answers leave the alert on:
                            eero refuses `device.new` off with the narrowing on
                            — 400 on every change the menu made. */}
                        {row.alt && (
                          <select
                            aria-label={t('notif_row.new_devices_which')}
                            value={sent[row.alt] ? 'unknown' : 'all'}
                            disabled={savingPrefs || quiet}
                            onChange={(e) => void setSent2(
                              { [row.key]: true,
                                [row.alt!]: e.target.value === 'unknown' }, paneSay)}
                            className={`${FIELD} disabled:opacity-50`}
                          >
                            <option value="all">{t('notif_row.devices_all')}</option>
                            <option value="unknown">{t('notif_row.devices_unknown')}</option>
                          </select>
                        )}
                        {row.cadence && (
                          <select
                            aria-label={t('settings.send_usage_summary')}
                            value={cadence === 'none' ? 'weekly' : cadence}
                            disabled={savingCadence || quiet}
                            onChange={(e) => void saveCadence(e.target.value, paneSay)}
                            className={`${FIELD} disabled:opacity-50`}
                          >
                            <option value="weekly">{t('settings.weekly')}</option>
                            <option value="monthly">{t('settings.monthly')}</option>
                          </select>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <Toggle
                        srLabel={t('settings.event_on_mobile_app', { event: label })}
                        checked={on}
                        disabled={savingPrefs || locked}
                        onChange={(v) => {
                          /* Off takes both, since the narrowing key cannot
                             stand without the switch it narrows; on restores
                             the broader answer, which is what somebody
                             switching it on is asking for. */
                          const patch: Record<string, boolean> = row.alt
                            ? { [row.key]: v, [row.alt]: false }
                            : { [row.key]: v }
                          void setSent2(patch, paneSay)
                          /* The report has a frequency as well as a switch, and
                             eero keeps them apart. Off means none, so the two
                             cannot drift into saying different things. */
                          if (row.cadence) {
                            void saveCadence(
                              v ? (cadence === 'none' ? 'weekly' : cadence) : 'none',
                              paneSay)
                          }
                        }} />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <Toggle
                        srLabel={t('settings.event_in_web_interface', { event: label })}
                        checked={here}
                        disabled={locked}
                        onChange={async (v) => {
                          const before = webNotif
                          const next = { ...webNotif, [row.key]: v }
                          setWebNotif(next)
                          try { await api.put('/api/settings/web-notifications', { preferences: next }) }
                          catch { setWebNotif(before); paneSay.fail(t('settings.could_not_save')) }
                        }} />
                    </td>
                    {/* At the end of the row rather than against the label: it
                        is about what the two switches can do, and it was
                        pushing the frequency out of line beside the text. */}
                    <td className="py-1 pl-1 text-right align-middle">
                      {row.plus && <PlusTick name={row.plus} />}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-[var(--color-ink-3)]">{t('settings.not_available_network')}</p>
        )}

        </>)}
      </Card>

      {/* The theme and the appearance, and nothing else: they are one
          question and the preview is the biggest thing on the page. The
          clock and the language used to be in here under headings of their
          own, which made a card of three unrelated settings with a large
          picture across the middle of it. */}
      <Card icon="display" title={t('settings.display')} anchor="display">
        <ThemePicker prefs={prefs} onApply={update} />
      </Card>

      {/* One card over both, because they are one question between them: how
          this interface prints a time. The zone used to live on the network
          pane, two pages from the clock format. */}
      <Card icon="clock" title={t('settings.date_and_time')} anchor="time">{(paneSay) => (<>
        <div className="grid gap-4">
          {/* One setting for every time the interface prints. Before it
              existed the app ran three conventions at once: schedules and
              firmware windows were 12-hour, the Insights hour axis was
              24-hour, and anything formatted through a locale followed the
              browser. */}
          <Field label={clockLabel}
                 hint={t('settings.times_read_example', { example: clockHour(13) })}>
            <Toggle srLabel={clockLabel} checked={prefs.clock_24h}
                    onChange={(v) => update({ clock_24h: v })} />
          </Field>
          <Field
            label={t('settings.time_zone')}
            htmlFor="tz"
            /* Said with the control, not after it: somebody about to change
               this is entitled to know it moves their schedules. */
            hint={<>
              {t('settings.time_zone_drives_schedules')}
              {identity?.timezone_from_geo
                && identity.timezone_from_geo !== identity.timezone && (
                <>{' '}{t('settings.time_zone_from_connection',
                          { zone: identity.timezone_from_geo })}</>
              )}
            </>}
          >
            {/* The browser's own list rather than a copy in this repo. There
                are 417 zones and the IANA database changes; a hardcoded list
                would be wrong within a year and nobody would notice. */}
            <select
              id="tz"
              value={identity?.timezone ?? ''}
              disabled={!identity}
              onChange={async (e) => {
                const zone = e.target.value
                try {
                  const got = await api.put<{ timezone: string | null }>(
                    '/api/network/timezone', { timezone: zone })
                  setIdentity((i) => i && { ...i, timezone: got.timezone })
                  paneSay.ok(t('settings.time_zone_saved'))
                } catch (err) {
                  paneSay.fail(err instanceof ApiError ? err.message
                                                      : t('settings.did_not_work'))
                }
              }}
              className={FIELD_WIDE}
            >
              {!identity?.timezone && <option value="">—</option>}
              {zones().map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
        </div>
      </>)}</Card>

      {/* Its own card rather than a heading at the foot of another one. The
          browser's language is the default, and for the reason that matters
          here: somebody who cannot read the interface cannot find this
          control either, so where it sits is not what rescues them — the
          interface has to be readable before anyone comes looking. */}
      <Card icon="internet" title={t('settings.language')} anchor="language">
        {/* A select, not a row of buttons like the theme: theme has three
            options and will always have three; languages grow every time
            somebody contributes one, and a row that reflows to a second line
            as the project succeeds is the wrong control. A select also says
            "one of these" without needing aria-pressed on each. */}
        <Field label={t('settings.interface')} htmlFor="lang">
          <select
            id="lang"
            value={prefs.language}
            onChange={(e) => update({ language: e.target.value })}
            className={FIELD_WIDE}
          >
            <option value="auto">{t('settings.language_auto')}</option>
            {LANGUAGES.map((l) => (
              /* The endonym, and tagged with `lang` so a screen reader
                 pronounces "Magyar" as Hungarian rather than as English. */
              <option key={l.tag} value={l.tag} lang={l.tag}>{l.name}</option>
            ))}
          </select>
        </Field>
      </Card>

      {/* "Network" was the wrong word beside a page whose next-door tab is
          also called Network and is about plumbing. What is in this card is
          who may change the network, what it is called, and when it changes
          itself. */}
      <Card icon="settings" title={t('settings.operations')} anchor="network">{(paneSay) => (<>
        <div className="grid gap-4 text-[13px]">
          <Field label={t('settings.network_nickname')}
                 hint={t('settings.network_nickname_hint')}>
            {/* Empty reads as "there is nothing here" rather than "press
                this to add one", and `EditableText` on its own gives no
                sign that the words are a control. The placeholder is the
                invitation. */}
            <EditableText
              placeholder={t('settings.network_nickname_add')}
              value={identity?.nickname ?? ''}
              onSave={async (v) => {
                const got = await api.put<{ nickname: string | null }>(
                  '/api/network/nickname', { nickname: v })
                setIdentity((i) => i && { ...i, nickname: got.nickname })
                paneSay.ok(t('settings.nickname_saved'))
              }}
            />
          </Field>


          <Field label={t('settings.people_access')} stack>
            <ul className="grid gap-1 py-1">
              {(members?.members ?? []).map((m, i) => (
                <li key={`${m.name}-${i}`} className="flex justify-between gap-3">
                  <span>{m.name ?? t('settings.unnamed')}{m.is_you && ' (you)'}</span>
                  <span className="text-[var(--color-ink-3)]">{m.role ? tOr(`role.${m.role}`, m.role) : ''}</span>
                </li>
              ))}
              {!members?.members?.length && (
                <li className="text-[var(--color-ink-3)]">{t('settings.not_available')}</li>
              )}
            </ul>
          </Field>

          {/* Invites sit under the people they will become, and only an owner
              sees them at all: eero refuses an invite from anybody else, so
              to an admin the whole section is a list they cannot act on and a
              button that would be rejected. Admin is the only role offered,
              which is also all eero's own app offers here: the API accepts
              `owner` too, and that transfers the network rather than adding a
              helper. */}
          {isOwner && (
          <Field label={t('settings.pending_invites')}
                 hint={isOwner ? t('settings.invite_admin_hint')
                               : t('settings.admins_owner_only')}
                 stack>
            <div className="grid gap-2">
              {isOwner && (
                <span className="flex min-h-8 flex-wrap items-center gap-3">
                  {liveInvites.some((i) => i.status === 'pending') && (
                    <button type="button"
                      onClick={async () => {
                        if (!window.confirm(t('settings.confirm_cancel_all'))) return
                        try {
                          await api.post('/api/network/admins/invites/cancel-pending', {})
                          setFresh(null); loadInvites()
                        } catch (err) {
                          paneSay.fail(err instanceof ApiError ? err.message
                                                              : t('settings.did_not_work'))
                        }
                      }}
                      className="text-[12px] font-medium text-[var(--color-accent-ink)]">
                      {t('settings.cancel_all_pending')}
                    </button>
                  )}
                  <button type="button" disabled={inviting}
                    onClick={async () => {
                      setInviting(true); paneSay.clear()
                      try {
                        const got = await api.post<Invite>(
                          '/api/network/admins/invites', {})
                        setFresh(got); loadInvites()
                      } catch (err) {
                        paneSay.fail(err instanceof ApiError ? err.message
                                                            : t('settings.did_not_work'))
                      } finally { setInviting(false) }
                    }}
                    className={ACTION}>
                    {t('settings.invite_an_admin')}
                  </button>
                </span>
              )}
            {/* The link, once, right after it is made. eero returns it on
                creation and does not always carry it in the list afterward,
                so this is the moment it is available and the interface says
                so rather than leaving somebody to find it. */}
            {fresh?.url && (
              <div className="mb-2 rounded-md border border-[var(--color-line)]
                              bg-[var(--color-surface-2)] p-2">
                <p className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">
                  {t('settings.invite_link_ready')}
                </p>
                {/* When it stops working, said here rather than only in the
                    list below: this is the moment somebody is deciding who to
                    send it to. */}
                {fresh.expires_at && (
                  <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                    {t('settings.invite_expires_on', { when: when(fresh.expires_at) })}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 break-all font-mono text-[11px]">
                    {fresh.url}
                  </code>
                  <button type="button"
                    onClick={async () => {
                      /* `navigator.clipboard` exists only in a secure context,
                         and this app's normal home is plain HTTP on a LAN — so
                         the call threw and the catch swallowed it, leaving a
                         button that did nothing without saying so. */
                      if (await copyText(fresh.url ?? '')) {
                        paneSay.ok(t('settings.link_copied'))
                      } else {
                        paneSay.fail(t('settings.link_not_copied'))
                      }
                    }}
                    className="shrink-0 text-[12px] font-medium text-[var(--color-accent-ink)]">
                    {t('settings.copy_link')}
                  </button>
                </div>
              </div>
            )}

            <ul className="grid gap-1">
              {liveInvites.map((inv) => (
                <li key={inv.id ?? ''}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                  <span className="text-[var(--color-ink-3)]">
                    {t('settings.invite_pending')}
                    {inv.expires_at && <>{' · '}{when(inv.expires_at)}</>}
                  </span>
                  {isOwner && inv.id && (
                    <button type="button"
                      onClick={async () => {
                        if (!window.confirm(t('settings.confirm_cancel_invite'))) return
                        try {
                          await api.del(
                            `/api/network/admins/invites/${encodeURIComponent(inv.id!)}`)
                          if (fresh?.id === inv.id) setFresh(null)
                          loadInvites()
                        } catch (err) {
                          paneSay.fail(err instanceof ApiError ? err.message
                                                              : t('settings.did_not_work'))
                        }
                      }}
                      className="text-[12px] font-medium text-[var(--color-accent-ink)]">
                      {t('settings.cancel_invite')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            </div>
          </Field>
          )}
          {/* Only when eero reports the mode. `capabilities.simple_setup` is
              the Amazon feature and does not gate this one. */}
          {simple?.auto_setup_mode != null && (
            <Field
              label={t('settings.simple_setup')}
              /* The Bluetooth caveat is only true while this is off. With it
                 on, a wired eero does set itself up and no phone is
                 involved; what still needs the app is one joining over
                 Wi-Fi, because that is provisioned over BLE. Saying "you
                 still need the phone app" in both states would be wrong in
                 one of them. */
              hint={simple.auto_setup
                ? t('settings.simple_setup_hint_on')
                : t('settings.simple_setup_hint_off')}
            >
              <Toggle
                srLabel={t('settings.simple_setup')}
                checked={Boolean(simple.auto_setup)}
                disabled={savingSimple}
                onChange={async (on) => {
                  setSavingSimple(true); paneSay.clear()
                  try {
                    await api.put('/api/network/auto-setup', { enabled: on })
                    setSimple(await api.get<SimpleSetup>('/api/network/simple-setup'))
                  } catch (e) {
                    paneSay.fail(e instanceof ApiError ? e.message
                                                       : t('settings.did_not_work'))
                    throw e
                  } finally { setSavingSimple(false) }
                }}
              />
            </Field>
          )}

        </div>
        </>)}
      </Card>

      {/* Its own card: the version, what is waiting, and when an update is
          allowed to restart the network. It sat in Operations with the
          nickname and the invites, which made one card of six unrelated
          things. */}
      <Card icon="history" title={t('settings.firmware')} anchor="firmware">{(paneSay) => (<>
        <div className="grid gap-4">
          <Field label={t('settings.firmware')} stack>
            {/* What is on the eeros, whether or not anything is waiting. This
                row used to say "Up to date" and leave the version to be
                hunted for in a node's drawer, and said only the pending
                version when there was one — so the number on screen was
                never the number running.

                The button is on this row rather than under the window below
                it: the window is when an update happens on its own, and
                "now" is the answer to a different question. */}
            <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[12px]">
                  {updates
                    ? (updates.current_firmware
                       ?? (updates.firmware_versions?.length
                           ? updates.firmware_versions.join(', ')
                           : '—'))
                    : '—'}
                </span>
                <span className="text-[var(--color-ink-3)]">
                  {updates
                    ? (updates.has_update
                        ? (updates.target_firmware
                            ? t('settings.firmware_update_to',
                                { version: updates.target_firmware })
                            : t('firmware.update_available'))
                        : t('settings.up_to_date'))
                    : ''}
                </span>
              </span>
              {/* Only when there is a version to read about. With nothing
                  pending the notes describe firmware already installed,
                  which is not what this row is for. */}
              {updates?.has_update && <ReleaseNotesLink />}
              <UpdateNowButton
                updates={updates}
                onDone={(text, ok) => {
                  if (ok) paneSay.ok(text); else paneSay.fail(text)
                  void reloadUpdates()
                }}
              />
            </div>
          </Field>
          <Field label={t('settings.install_updates_between')}
                 htmlFor="win"
                 hint={t('settings.installing_firmware_restarts_every_eero')}>
            {/* Controlled, and empty until the network has answered. As
                `defaultValue` this showed 2 AM on every load whatever the
                network held: the select mounts before this pane's own fetch
                lands, and React ignores a `defaultValue` that changes after
                that. On a network set to 4 AM it said 2 AM here while the
                dashboard's notice said 4, and the dashboard was right.
                Nothing had been written — the select only writes on change —
                so it was misreporting rather than mis-setting, which is the
                harder kind to notice. */}
            <select
              id="win"
              value={updates ? String(updates.preferred_update_hour ?? '') : ''}
              disabled={!updates}
              aria-label={t('settings.install_updates_between')}
              onChange={async (e) => {
                const hour = Number(e.target.value)
                const before = updates
                // Shown at once, and put back if the write is refused.
                setUpdates((u) => u && { ...u, preferred_update_hour: hour })
                try {
                  await api.put('/api/network/updates/window', { hour })
                  paneSay.ok(t('settings.update_window_saved'))
                  void reloadUpdates()
                } catch (err) {
                  setUpdates(before)
                  paneSay.fail(err instanceof ApiError ? err.message
                                                       : t('settings.did_not_work'))
                }
              }}
              className={`${FIELD_WIDE} disabled:opacity-50`}
            >
              {/* A placeholder only while there is nothing to show, and only
                  when eero reports no hour at all — never as a 24th choice. */}
              {(!updates || updates.preferred_update_hour == null) && (
                <option value="">{'\u2014'}</option>
              )}
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{hourWindow(h)}</option>
              ))}
            </select>
          </Field>
        </div>
      </>)}</Card>

      <Card icon="filter" title={t('settings.feature_filters')} anchor="filters">
        <div className="mb-3"><PlusStatus /></div>
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('settings.some_features_unavailable_given_network')}
        </p>
        <div className="grid gap-3">
          {/* A subscriber and a non-subscriber are not asking the same
              question. One is looking at marks on features they already pay
              for; the other is looking at features they cannot use. Offering
              both switches to everyone meant each person read one setting that
              could do nothing for them. Which case applies is said once, by
              the indicator above, so the switch itself does not repeat it. */}
          {premiumActive ? (
            <Toggle
              label={t('settings.hide_icons_indicate_which_features')}
              hint={t('settings.hide_plus_marks_hint')}
              checked={prefs.hide_plus_badges}
              onChange={(v) => update({ hide_plus_badges: v })}
            />
          ) : (
            <Toggle
              label={t('settings.hide_all_features_which_only')}
              hint={t('settings.hide_plus_features_hint')}
              checked={prefs.hide_subscription_gated}
              onChange={(v) => update({ hide_subscription_gated: v })}
            />
          )}
          <Toggle
            label={t('settings.hide_features_your_hardware_firmware')}
            hint={t('settings.off_default_because_knowing_capability')}
            checked={prefs.hide_capability_limited}
            onChange={(v) => update({ hide_capability_limited: v })}
          />
        </div>
      </Card>

      <Card icon="key" title={t('settings.interface_access')} anchor="access">
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('settings.interface_has_its_own_password')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={openAbout} className={ACTION}
                  data-part="settings-about">
            {t('shell.about_eeronaut')}
          </button>
          <button
            type="button"
            onClick={() => { setChangingPw((v) => !v); pwSay.clear() }}
            className={ACTION}
          >
            {changingPw ? t('settings.cancel') : t('settings.change_password')}
          </button>
          <button
            type="button"
            onClick={async () => {
              await api.post('/api/app/logout').catch(() => {})
              window.location.reload()
            }}
            className={ACTION}
          >
            {t('settings.sign_out_of_interface')}
          </button>
        </div>

        {changingPw && (
          <form
            className="mt-3 grid gap-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget as HTMLFormElement)
              const next = String(f.get('next'))
              if (next !== String(f.get('confirm'))) {
                pwSay.fail(t('settings.two_new_passwords_do_not')); return
              }
              setSavingPw(true); pwSay.clear()
              try {
                await api.post('/api/app/password',
                               { current: String(f.get('current')), new: next })
                pwSay.ok(t('settings.password_changed_any_other_browser'))
                setChangingPw(false)
              } catch (err) {
                pwSay.fail(err instanceof ApiError ? err.message : t('settings.did_not_work'))
              } finally { setSavingPw(false) }
            }}
          >
            <Field label={t('settings.current_password')} htmlFor="pw-current">
              <input id="pw-current" name="current" type="password" required
                     autoComplete="current-password" className={FIELD_WIDE} />
            </Field>
            <Field label={t('settings.new_password')} htmlFor="pw-next">
              <input id="pw-next" name="next" type="password" required minLength={8}
                     autoComplete="new-password" className={FIELD_WIDE} />
            </Field>
            <Field label={t('settings.repeat_new_password')} htmlFor="pw-confirm">
              <input id="pw-confirm" name="confirm" type="password" required minLength={8}
                     autoComplete="new-password" className={FIELD_WIDE} />
            </Field>
            <SubmitButton disabled={savingPw} className="justify-self-start">
              {savingPw ? t('settings.changing') : t('settings.change_password')}
            </SubmitButton>
            <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              {t('settings.least_8_characters_there_no')}
            </p>
          </form>
        )}
        {pwSay.node && <div className="mt-3">{pwSay.node}</div>}
        {/* The versions somebody reporting a problem is asked for: this
            program's, the eeros' firmware, the newest eero app on Google Play
            (G-APK) and the eero app version this program presents to eero
            (E-APK), which follows the first once a day. A dash for any not
            known yet. */}
        <AppUpdateNotice className="mt-4" />
        <p data-part="versions" className="mt-4 text-[11px] tabular-nums text-[var(--color-ink-3)]">
          {t('settings.versions_line', {
            eeronaut: appVersion || '\u2014',
            eero: updates?.current_firmware ?? updates?.firmware_versions?.join(', ') ?? '\u2014',
            gapk: ver?.latest ?? '\u2014',
            eapk: presented || '\u2014',
          })}
        </p>
      </Card>
    </Page>
  )
}
