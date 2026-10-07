import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { Card, Drawer, ReleaseNotesLink } from './primitives'
import { pushAlert } from '../lib/alerts'
import { useClock } from '../lib/clock'
import { isOutage, rungFor } from '../lib/wan'
import { t } from '../i18n'

interface Item {
  id: string | number | null; title: string | null; body: string | null
  category: string | null; created: string | null; read: boolean
  /** For a new-device notification, the device's MAC, which opens its
   *  drawer on the Clients page. */
  device_mac?: string | null
  /** Attached by the backend to the newest outage notification, and only
   *  while a backup is actually carrying the network. eero's own text says
   *  neither which backup took over nor what the outage was. */
  backup?: { active: 'cellular' | 'hotspot' | 'unknown'; model: string | null
             wan_state: string | null; wan_type: string | null }
}
interface Feed { has_unread: boolean; count: number; notifications: Item[] }

/* Read state is Eeronaut's own, because eero's is not usable for this.

   Every notification comes back with `read: false` — on the network this was
   written against, all 66 of them, while the feed's own `has_unread` said
   false. So there is no per-item read flag to write back to, and anything that
   shows which ones are new has to be the app's own record. (Each does carry a
   `uuid`, which the server hands on as `id`; the dismissed set below predates
   finding it and keys on category and time, which works as well.)

   `created` is an ISO timestamp down to the nanosecond, so category plus created
   identifies an item well enough to remember having dismissed it. A watermark
   covers "mark all read" in one value rather than accumulating a key per
   notification forever.

   The watermark starts when the network is first chosen rather than at zero:
   a fresh install has no way to know which of eero's backlog you have already
   read on your phone, and opening the drawer to 66 blue dots would be a worse
   guess than none.

   All of it is kept on the server, per network (notifications-<network>.json),
   so every browser agrees. It used to be in each browser's local storage, where
   a second browser or a cleared cache showed everything unread again. These are
   those old keys, read once to carry a browser's history across. */
const OLD_KEYS = {
  read_at: 'eeronaut.notif.read-at',
  dismissed: 'eeronaut.notif.dismissed',
  alerted: 'eeronaut.notif.alerted',
}

interface NotifState { read_at: string; dismissed: string[]; backlog_seen: boolean }

const keyOf = (n: Item) => `${n.category ?? ''}|${n.created ?? ''}`

/** The server's record, after handing it this browser's old one if the
 *  server has none yet. The old keys are removed once they have been taken. */
async function readState(): Promise<NotifState | null> {
  const st = await api.get<NotifState>('/api/settings/notification-state').catch(() => null)
  if (!st || st.backlog_seen) return st
  let old: Record<string, unknown> | null = null
  try {
    const at = localStorage.getItem(OLD_KEYS.read_at)
    const dismissed = localStorage.getItem(OLD_KEYS.dismissed)
    const alerted = localStorage.getItem(OLD_KEYS.alerted)
    if (at !== null || dismissed !== null || alerted !== null) {
      old = { read_at: at, dismissed: dismissed ? JSON.parse(dismissed) : null,
              alerted: alerted ? JSON.parse(alerted) : null }
    }
  } catch { /* private mode, or a value that is not JSON */ }
  if (!old) return st
  const taken = await api.put<NotifState>('/api/settings/notification-state', old)
    .catch(() => null)
  if (!taken) return st
  try {
    for (const k of [...Object.values(OLD_KEYS), 'eeronaut:seenNotif']) localStorage.removeItem(k)
  } catch { /* private mode */ }
  return taken
}

/**
 * The two things eero's outage notification leaves out: which backup is
 * carrying the network, and what the primary is actually doing.
 *
 * Only rendered while it is still true — the backend attaches this to the
 * newest outage notification and only while a backup is up, because an outage
 * that ended left no record of which backup ran.
 */
function BackupDetail({ backup }: { backup: NonNullable<Item['backup']> }) {
  const which = backup.active === 'cellular'
    ? t('notifications.backup_cellular', { model: backup.model || 'eero Signal' })
    : backup.active === 'hotspot'
      ? t('notifications.backup_hotspot')
      : t('notifications.backup_unknown')
  // The same words the connection diagnosis uses for the same state.
  const cause = isOutage(backup.wan_state)
    ? rungFor(backup.wan_state).short : null
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]
                  text-[var(--color-ink-2)]">
      <span className="rounded bg-[var(--color-accent-wash)] px-1.5 py-0.5
                       font-semibold text-[var(--color-accent-ink)]">
        {which}
      </span>
      {cause && <span>{t('notifications.outage_cause', { cause })}</span>}
    </p>
  )
}


/** Where a new-device notification's "See details" goes: the Clients page
 *  with that device's drawer open, the way search opens one. */
const detailsOf = (n: Item): string | null =>
  n.device_mac && (n.category === 'device.new' || n.category === 'device.restrict.new.private')
    ? `/clients?focus=${encodeURIComponent(n.device_mac)}` : null

/** Whether this notification is about a firmware update, by eero's own
 *  categories: one before it installs, one when it is due, one after. The
 *  release notes answer the same question for all three. */
const isFirmware = (n: Item) => {
  const cat = (n.category || '').toLowerCase()
  return cat.includes('scheduledupdate') || cat === 'network.updated'
}

/** Network notifications from eero: firmware, outages, new devices. */
export function Notifications({ as = 'bell' }: {
  /** A bell that opens the list in a drawer; the list as a card of its own,
   *  for a theme that gave notifications a page; or nothing on screen at
   *  all, still reading the feed so new items still raise their alerts
   *  while the page holding the list is not open. */
  as?: 'bell' | 'card' | 'quiet'
}) {
  const { when } = useClock()
  const [feed, setFeed] = useState<Feed | null>(null)
  const [open, setOpen] = useState(false)
  /* Null until the server answers, and nothing counts as unread meanwhile:
     guessing before then would light the bell for a moment on every load. */
  const [state, setState] = useState<NotifState | null>(null)
  const dismissed = new Set(state?.dismissed ?? [])

  const isUnread = (n: Item) =>
    state !== null && Boolean(n.created) && n.created! > state.read_at
    && !dismissed.has(keyOf(n))

  const unread = (feed?.notifications ?? []).filter(isUnread).length

  function dismiss(n: Item) {
    const item = keyOf(n)
    setState((st) => st && { ...st, dismissed: [...st.dismissed, item] })
    void api.post<NotifState>('/api/settings/notification-state/dismiss', { item })
      .then(setState).catch(() => {})
  }

  async function markAllRead() {
    setState((st) => st && { ...st, read_at: new Date().toISOString(), dismissed: [] })
    const st = await api.post<NotifState>('/api/settings/notification-state/read-all')
      .catch(() => null)
    if (st) setState(st)
    // Told to eero as well, so the phone app agrees about the bell.
    await api.post('/api/notifications/read').catch(() => {})
    void load()
  }

  const load = async () => {
    const [f, web, st] = await Promise.all([
      api.get<Feed>('/api/notifications').catch(() => null),
      api.get<{ preferences: Record<string, boolean> }>('/api/settings/web-notifications')
        .catch(() => ({ preferences: {} })),
      readState(),
    ])
    if (st) setState(st)
    if (!f) return
    /* New items as alerts here, for the events switched on in the Eeronaut
       column, once each.

       Matched on the category exactly: eero files each item under the same
       key its notification switch has (`device.new`, `network.updated`,
       `network.scheduledUpdate.lateNotification`...). It used to compare the
       first word of the key, so turning on one update reminder alerted on
       every `network.` event there was.

       And identified by eero's `uuid`, which the server passes through as
       `id`. The field was read as `id` from eero directly, which eero never
       sends, so every item was skipped as unidentifiable and no alert of
       any kind was ever raised. */
    const on = new Set(Object.entries(web?.preferences ?? {})
      .filter(([, v]) => v).map(([k]) => k))
    // The narrower new-device alert is the same row as the broad one.
    const rowOf = (cat: string) => (cat === 'device.restrict.new.private' ? 'device.new' : cat)
    /* The server says which items are new, so two open tabs cannot both
       alert on one. On the first look it records what is already there and
       says nothing is: a backlog of a hundred items is not a hundred new
       events. */
    const ids = f.notifications.map((n) => String(n.id ?? '')).filter(Boolean)
    const claimed = await api.post<{ new: string[] }>(
      '/api/settings/notification-state/claim', { ids }).catch(() => null)
    const fresh = new Set(claimed?.new ?? [])
    for (const n of f.notifications) {
      if (!fresh.has(String(n.id ?? '')) || !on.has(rowOf(n.category ?? ''))) continue
      const to = detailsOf(n)
      pushAlert({
        title: n.title || t('notifications.network_notification'),
        body: n.body || undefined,
        tone: 'info',
        link: to ? { label: t('notifications.see_details'), to } : undefined,
      })
    }
    setFeed(f)
  }
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  const markAll = unread > 0 && (
    <button
      type="button"
      onClick={() => void markAllRead()}
      className="rounded text-[13px] font-normal text-[var(--color-accent-ink)]
                 underline-offset-2 hover:underline
                 focus-visible:outline focus-visible:outline-2
                 focus-visible:outline-offset-2
                 focus-visible:outline-[var(--color-accent)]"
    >
      {t('notifications.mark_all_read', { count: unread })}
    </button>
  )

  if (as === 'quiet') return null
  if (as === 'card') {
    return (
      <Card icon="bell" title={t('notifications.notifications')} anchor="feed"
            action={markAll || undefined}>
        {feed ? list() : null}
      </Card>
    )
  }
  if (!feed) return null

  return (
    <>
      <button
        type="button"
        /* Opening no longer marks everything read. Reading the list and
           acknowledging each item are different acts, and collapsing them meant
           a glance at the bell wiped the only record of what was new. */
        onClick={() => setOpen(true)}
        className="relative rounded p-1 text-[var(--color-ink-3)] hover:text-[var(--color-ink-2)]"
        aria-label={unread ? t('notifications.notifications_unread') : t('notifications.notifications')}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
          <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1Z" />
        </svg>
        {unread > 0 && (
          /* Two elements: a dot that stays put, and a ring that pulses out of
             it. Animating the dot itself would either move the layout or make
             the thing you are trying to read pulse under you. The ring is
             absolutely placed and scales, so nothing reflows and the work is
             on the compositor. It stops existing with the dot. */
          <span className="absolute right-0.5 top-0.5 size-2">
            <span className="notif-pulse absolute inset-0 rounded-full
                             bg-[var(--color-accent)]" aria-hidden="true" />
            <span className="absolute inset-0 rounded-full bg-[var(--color-accent)]" />
          </span>
        )}
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t('notifications.notifications')}
            {markAll}
          </span>
        }
      >
        {list()}
      </Drawer>
    </>
  )

  function list() {
    if (!feed) return null
    return feed.notifications.length === 0 ? (
          <p className="text-[13px] text-[var(--color-ink-3)]">{t('notifications.nothing_recent')}</p>
        ) : (
          <ul className="grid gap-3">
            {feed.notifications.map((n, i) => (
              <li key={String(n.id ?? keyOf(n) ?? i)}
                  className="flex items-start gap-2 border-b border-[var(--color-line)]
                             pb-3 last:border-0">
                {/* The dot is the acknowledgement, so it is the control: click
                    it and that one is read. Reserved space when it is absent so
                    the text of read and unread items lines up in a column. */}
                {isUnread(n) ? (
                  <button
                    type="button"
                    onClick={() => dismiss(n)}
                    title={t('notifications.mark_read')}
                    aria-label={t('notifications.mark_read_item',
                                  { title: n.title || t('notifications.network_notification') })}
                    className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--color-accent)]
                               hover:ring-2 hover:ring-[var(--color-accent-wash)]
                               focus-visible:outline focus-visible:outline-2
                               focus-visible:outline-offset-2
                               focus-visible:outline-[var(--color-accent)]"
                  />
                ) : (
                  <span aria-hidden="true" className="mt-1.5 size-2 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                {n.title && <p className="text-[13px] font-medium">{n.title}</p>}
                {(n.body || detailsOf(n)) && (
                  <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
                    {n.body}
                    {/* A new device's notification ends by opening that
                        device, where its name, maker, and address are. */}
                    {detailsOf(n) && <>{n.body ? ' ' : ''}<Link to={detailsOf(n)!}
                      className="link" onClick={() => setOpen(false)}>
                      {t('notifications.see_details')}</Link></>}
                  </p>
                )}
                {n.backup && <BackupDetail backup={n.backup} />}
                {/* Only on the notifications actually about a firmware
                    update, and only ever a link. */}
                {isFirmware(n) && (
                  <ReleaseNotesLink className="mt-1 inline-block text-[12px] font-medium" />
                )}
                {n.created && (
                  <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">
                    {when(n.created)}
                  </p>
                )}
                </div>
              </li>
            ))}
          </ul>
        )
  }
}
