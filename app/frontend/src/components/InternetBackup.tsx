import { useCallback, useEffect, useRef, useState } from 'react'
import { api, freshReads, ApiError } from '../lib/api'
import { Card, SubmitButton, Toggle, type CardSay } from './primitives'
import { usePlusGate, useCloud, PlusLock } from '../lib/capabilities'
import { t, tn } from '../i18n'

/**
 * What keeps the network up when the line does not.
 *
 * Two unrelated mechanisms share the name: an eero Signal's cellular plan, and
 * the hotspot list the eeros fall back to over Wi-Fi. Both are here because
 * somebody looking for "backup" is not thinking about which of the two they
 * have.
 *
 * It sat on the Local control page because the saved-network list is read over
 * the local gRPC channel. That is an implementation detail of one of the reads,
 * not what the pane is about: this is the connection to the internet, so it
 * belongs with the rest of the connection. Only the saved-network list needs
 * the local channel, and it says so when the channel is not up.
 *
 * The i18n keys still carry the `local_control.` prefix. They are catalog keys,
 * not paths, and renaming them would rewrite three translation files to say the
 * same words.
 */

interface BackupCred { id: string; ssid: string; enabled: boolean; has_password: boolean }
interface BackupAps { enabled: boolean; credentials: BackupCred[] }
interface Discovery {
  status: string
  /** False once eero has settled on an answer. */
  running: boolean
  ssids: { ssid: string; rssi: number | null }[]
}

const BK_FIELD =
  'rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] ' +
  'px-2 py-1.5 text-[13px]'

export function InternetBackup() {
  const capBackup = usePlusGate('internet_backup')
  const backupNeedsPlus = capBackup.needsPlus
  const [backup, setBackup] = useState<BackupAps | null>(null)
  /* The master switch and the Signal's state, which live on the network rather
     than on the local channel the saved-network list comes from. */
  const [bi, setBi] = useState<{
    enabled: boolean
    cellular?: { present: boolean; model?: string | null; status?: string | null }
  } | null>(null)
  /* The found network somebody has picked to add, with its name in the box
     for them to change or keep. Nothing else opens the form: typing a
     hotspot's name by hand was a way to misspell it. */
  const [chosen, setChosen] = useState<string | null>(null)
  /* The saved network whose password is being changed, if any. */
  const [pwFor, setPwFor] = useState<string | null>(null)
  /* Saved networks on their way out: confirmed for deletion, not yet gone
     from the list the eero serves. Drawn gray and inert until then. */
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [found, setFound] = useState<{ ssid: string; rssi: number | null }[]>([])
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  /** Whether the local channel is up, which is what the saved-network list is
   *  read over. Everything else here comes from eero's cloud. */
  const [localUsable, setLocalUsable] = useState(false)
  /* Three of the controls go through eero's cloud. With the WAN down they
     cannot work, and a button that fails on click is worse than one that says
     why up front. */
  const cloud = useCloud()

  /* Whether the saved networks are worth showing at all.
     They are the detail of the hotspot switch, not a setting beside it: eero
     only tries them when that switch is armed, so with it off the panel
     describes something that cannot happen. Hidden rather than dimmed, since
     what would bring it back is the switch immediately above it and that
     switch is already saying so. */
  const savedShown = !backupNeedsPlus && Boolean(bi?.enabled)

  /* Arming hotspot backup is the one thing here somebody actually *does*
     during an outage — and it was the one control that could not be done
     during one. The switch wrote through /api/network/backup-internet, which
     is eero's cloud, on the far side of the link that just failed.
     `EnableBackupAps` is the same arm/disarm over the local gRPC channel, so
     the hardware can be told directly.

     Cloud first while the cloud is up, because that is the path this has
     always taken and the one whose behavior is known. Straight to local when
     it is known to be down, rather than waiting out a timeout first. */
  const armBackup = useCallback(async (enabled: boolean) => {
    const local = () => api.put('/api/local/backup-aps/enabled', { enabled })
    if (!cloud.ok) return local()
    try {
      return await api.put('/api/network/backup-internet', { enabled })
    } catch (e) {
      // The cloud may have dropped between the last read and this click.
      try { return await local() } catch { throw e }
    }
  }, [cloud.ok])

  const loadBackupInternet = useCallback(() => {
    api.get<{ enabled: boolean; cellular?: { present: boolean } }>(
      '/api/network/backup-internet').then(setBi).catch(() => setBi(null))
  }, [])

  /* Re-read the saved list until it shows a change, or give up quietly.

     Adding and removing go to eero's cloud; the list is read from the eero
     itself, which is the right source during an outage but hears about the
     change a few seconds later. One read straight after a save came back with
     the old list, and a hotspot that had just been added was not there. */
  /* Which settle is current. Two moves in quick succession start two of
     these; only the newest may draw, or the first could land eero's answer to
     the first move on top of the second. */
  const settleSeq = useRef(0)
  const settleBackup = useCallback(async (done: (b: BackupAps) => boolean) => {
    const mine = ++settleSeq.current
    let last: BackupAps | null = null
    for (let i = 0; i < 8; i++) {
      try {
        const b = await freshReads(() => api.get<BackupAps>('/api/local/backup-aps'))
        if (mine !== settleSeq.current) return
        last = b
        /* Shown only once it agrees: a stale answer shown in the meantime
           would put the old list back over the one the click already drew. */
        if (done(b)) { setBackup(b); return }
      } catch { /* the next read may answer */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (last && mine === settleSeq.current) setBackup(last)   // eero's word, if it never caught up
  }, [])

  /** Swap two saved networks, drawing the new order before eero confirms it.
   *  The arrows are not disabled while the write is out: each press posts
   *  the whole order as it now stands, so a quick second press is a second
   *  full order rather than a lost one, and waiting two or three seconds for
   *  eero between presses bought nothing. */
  const moveCredential = (say: CardSay, from: number, to: number) => {
    if (!backup || to < 0 || to >= backup.credentials.length) return
    const ids = backup.credentials.map((x) => x.id)
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    setBackup({ ...backup,
                credentials: ids.map((id) => backup.credentials.find((x) => x.id === id)!) })
    run(say, 'bkorder',
        () => api.post('/api/local/backup-aps/order', { rearranged_ids: ids }),
        t('local_control.order_saved'))
      .then(() => settleBackup((b) => b.credentials.map((x) => x.id).join() === ids.join()))
  }

  const loadBackup = useCallback(() => {
    api.get<BackupAps>('/api/local/backup-aps').then(setBackup).catch(() => {})
    api.get<Discovery>('/api/local/backup-aps/discover')
      .then((r) => setFound(r?.ssids ?? []))
      .catch(() => setFound([]))
  }, [])

  /* Not gated on the local channel. The saved-network list is read over it,
     but the hotspot switch and the Signal's state come from eero's cloud —
     gating them together meant that on any network where local control had not
     come up, the master switch sat disabled and the cellular row never
     appeared at all. */
  useEffect(loadBackupInternet, [loadBackupInternet])

  /* Local control enrolls in the background on first load, so a single read
     on mount would leave the saved-network list permanently empty on any page
     opened during that. Re-read until it is up, then stop. */
  useEffect(() => {
    let alive = true
    const read = () => api.get<{ usable?: boolean }>('/api/local/status')
      .then((r) => { if (alive) setLocalUsable(Boolean(r?.usable)) })
      .catch(() => { if (alive) setLocalUsable(false) })
    void read()
    if (localUsable) return
    const id = setInterval(() => void read(), 6000)
    return () => { alive = false; clearInterval(id) }
  }, [localUsable])

  /* Read at once as well as when the local channel reports itself up. The
     status read is the slow part of a cold load, about three seconds, and the
     list is usually readable before it answers. A read that fails because the
     channel is not up yet costs nothing and is made again when it is. */
  useEffect(() => { loadBackup() }, [loadBackup])
  useEffect(() => {
    if (!localUsable) return
    loadBackup()
  }, [localUsable, loadBackup])

  async function run(say: CardSay, key: string,
                     fn: () => Promise<unknown>, ok: string) {
    setBusy(key); say.clear()
    try { await fn(); say.ok(ok) }
    catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('local_control.did_not_work'))
    } finally { setBusy(null) }
  }

  /* Starting a scan only starts it. eero reports `in_progress` for around ten
     seconds and then `success`, so the button waits for that rather than
     claiming results would turn up on their own — which they never did, since
     nothing re-read them. */
  async function scanBackupNetworks(say: CardSay) {
    setScanning(true); say.clear()
    try {
      await api.post('/api/local/backup-aps/discover')
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const r = await freshReads(() => api.get<Discovery>('/api/local/backup-aps/discover'))
          .catch(() => null)
        if (!r) continue
        setFound(r.ssids ?? [])
        if (!r.running) {
          const n = (r.ssids ?? []).length
          say.ok(n ? tn('local_control.found_networks', n)
                   : t('local_control.no_nearby_networks_found'))
          return
        }
      }
      say.fail(t('local_control.scan_taking_longer_than_expected'))
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('local_control.scan_did_not_start'))
    } finally { setScanning(false) }
  }

  if (capBackup.hidden) return null

  return (
    <Card icon="internet" title={t('local_control.internet_backup')} anchor="backup"
          plus="internet_backup">
      {(say) => (<>
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('local_control.backup_intro')}
        </p>

        {bi?.cellular?.present && (
          <div className="mb-3 border-b border-[var(--color-line)] pb-3">
            <Toggle
              label={t('local_control.cellular_backup_model', { model: bi.cellular.model || 'eero Signal' })}
              hint={t('local_control.takes_over_automatically_when_connection')}
              checked
              disabled
              /* No control exists, so there is nothing for this to do. It is
                 shown rather than hidden because the Signal is doing real
                 work and a pane about backup that omits it would be lying by
                 omission. */
              onChange={() => {}}
            />
            <p className="mt-1 pl-12 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              {bi.cellular.status === 'off'
                ? t('local_control.cellular_standing_by')
                : t('local_control.cellular_active')}
            </p>
          </div>
        )}

        {/* The master arm/disarm. Saved networks are only tried when this
            is on, so a list of them with no way to see whether the feature is
            armed was half the setting.

            The separator belongs to what follows it. Disarmed there is
            nothing below, and the rule then closed off a card with empty
            space under it. */}
        <PlusLock locked={backupNeedsPlus} className="mb-3">
          <Toggle
            label={t('local_control.hotspot_backup')}
            /* Why, not how. The ordinary hint ends by describing the list of
               saved networks, and that list is not drawn without the
               subscription — so a locked card was explaining how to use a
               control nobody on this network can see. */
            hint={backupNeedsPlus
                  ? t('local_control.hotspot_backup_part_eero_plus')
                  : t('local_control.use_backup_connection_keep_network')}
            checked={Boolean(bi?.enabled)}
            /* Both, because they say different things. Without the
               subscription the switch cannot work at all; without an answer
               from eero yet, it does not know what it would be switching
               from. */
            disabled={backupNeedsPlus || Boolean(busy) || (bi === null && cloud.ok)}
            /* The switch moves at once and the panel under it follows in the
               same frame. It used to wait for the write and then for a
               re-read of eero's answer, two cloud round trips, before
               `bi.enabled` changed — long enough that pressing it looked
               like nothing had happened. eero's answer is still read back,
               and a refused write puts the switch back where it was. */
            onChange={async (v) => {
              const before = bi
              setBi((cur) => (cur ? { ...cur, enabled: v } : cur))
              setBusy('bi'); say.clear()
              try {
                await armBackup(v)
                say.ok(v ? t('local_control.hotspot_backup_armed')
                         : t('local_control.hotspot_backup_disarmed'))
              } catch (e) {
                setBi(before)
                say.fail(e instanceof ApiError ? e.message : t('local_control.did_not_work'))
              } finally { setBusy(null) }
              loadBackupInternet()
            }}
          />

          {/* The saved networks and what to do with them, as the detail of
              the switch above: a panel indented under its label, in the
              switch's own block, so it reads as part of that setting rather
              than a third one at the level of the two above it. It used to
              stand below a rule of its own. Same treatment the Thread
              credentials and the LAN addressing form get on the Network
              page. */}
          {savedShown && (
            <div data-backup-detail className="mt-2 ml-12">
              {backup ? (
              <div className="rounded-md border border-[var(--color-line)]
                              bg-[var(--color-surface-2)] p-3">
                <div className="mb-3 border-b border-[var(--color-line)] pb-2">
                  <span className="micro-label">{t('local_control.backup_use')}</span>
                </div>
                {backup.credentials.length ? (
                  <ul className="grid gap-1">
                    {backup.credentials.map((c, i) => (
                      <li key={c.id}
                          data-leaving={leaving.has(c.id) ? '1' : undefined}
                          aria-busy={leaving.has(c.id) || undefined}
                          className={`flex flex-wrap items-center justify-between gap-2 py-1 text-[13px]
                                      transition-opacity duration-200 ${
                                        leaving.has(c.id) ? 'pointer-events-none opacity-40' : ''}`}>
                        <span>{c.ssid}</span>
                        <span className="flex items-center gap-3 text-[var(--color-ink-3)]">
                          {/* No "enabled": every network in this list is. The
                              password is a control, since that is the one thing
                              about a saved hotspot that changes. */}
                          <button type="button"
                            aria-expanded={pwFor === c.id}
                            title={t('local_control.change_password_title')}
                            onClick={() => setPwFor(pwFor === c.id ? null : c.id)}
                            className="text-[12px] font-medium text-[var(--color-ink-2)]
                                       underline-offset-2 hover:underline">
                            {c.has_password ? t('local_control.password_set')
                                            : t('local_control.set_password')}
                          </button>
                          {/* Up and down as glyphs: the words took more room
                              than the list. Absent entirely on a list of one,
                              where both would be permanently disabled — a
                              control that can never do anything is furniture,
                              not an option somebody has yet to earn. */}
                          {backup.credentials.length > 1 && (
                          <span className="flex items-center gap-0.5">
                            <button type="button"
                              disabled={i === 0}
                              title={t('local_control.try_network_before_others')}
                              aria-label={t('local_control.move_ssid_up_list', { ssid: c.ssid })}
                              onClick={() => moveCredential(say, i, i - 1)}
                              className="rounded p-0.5 text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] disabled:opacity-30">
                              <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
                                <path d="M6 2.5 10.5 9h-9z" />
                              </svg>
                            </button>
                            <button type="button"
                              disabled={i === backup.credentials.length - 1}
                              title={t('local_control.try_network_after_others')}
                              aria-label={t('local_control.move_ssid_down_list', { ssid: c.ssid })}
                              onClick={() => moveCredential(say, i, i + 1)}
                              className="rounded p-0.5 text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] disabled:opacity-30">
                              <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
                                <path d="M6 9.5 1.5 3h9z" />
                              </svg>
                            </button>
                          </span>
                          )}
                          <button type="button" disabled={busy === 'bk' + c.id}
                            onClick={async () => {
                              if (!window.confirm(t('local_control.remove_ssid_backup_if_your', { ssid: c.ssid }))) return
                              /* Gray from the moment of the yes: the write and
                                 the re-read behind it take several seconds, and
                                 a row that looked untouched for that long
                                 invited a second press. */
                              setLeaving((l) => new Set(l).add(c.id))
                              try {
                                await run(say, 'bk' + c.id,
                                  () => api.del(`/api/local/backup-aps/networks/${c.id}`),
                                  t('local_control.ssid_removed', { ssid: c.ssid }))
                                await settleBackup(
                                  (b) => !b.credentials.some((x) => x.id === c.id))
                              } finally {
                                setLeaving((l) => { const n = new Set(l); n.delete(c.id); return n })
                              }
                            }}
                            className="text-[12px] font-medium text-[var(--color-ink-2)]
                                       underline-offset-2 hover:underline disabled:opacity-40">
                            {t('local_control.remove')}
                          </button>
                        </span>
                        {pwFor === c.id && (
                          <form
                            className="flex basis-full flex-wrap items-center gap-2 pb-1"
                            onSubmit={(e) => {
                              e.preventDefault()
                              const f = new FormData(e.currentTarget as HTMLFormElement)
                              run(say, 'bkpw' + c.id, () => api.put(
                                `/api/local/backup-aps/networks/${c.id}`,
                                { ssid: c.ssid, password: String(f.get('pw') || '') }),
                                t('local_control.password_saved')).then(() => {
                                  setPwFor(null)
                                  void settleBackup(() => true)
                                })
                            }}
                          >
                            <input name="pw" type="password" autoComplete="new-password"
                                   placeholder={t('local_control.password_if_any')}
                                   aria-label={t('local_control.new_password_for', { ssid: c.ssid })}
                                   className={`${BK_FIELD} flex-1`} />
                            <SubmitButton disabled={busy === 'bkpw' + c.id}>
                              {t('local_control.save_password')}
                            </SubmitButton>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-[var(--color-ink-3)]">
                    {t('local_control.no_backup_networks_configured')}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-3">
                  <button type="button" disabled={scanning}
                    onClick={() => void scanBackupNetworks(say)}
                    className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[12px] font-medium disabled:opacity-40">
                    {scanning ? t('local_control.scanning') : t('local_control.scan_networks')}
                  </button>
                </div>

                {found.length > 0 && (
                  <div className="mt-2">
                    <span className="micro-label">
                      {t('local_control.found_nearby', { count: found.length })}
                    </span>
                    {/* Strongest first: a backup is only useful if the eero can
                        actually hear it. */}
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {[...found]
                        .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
                        .map((f) => (
                          <li key={f.ssid}>
                            {/* Pressing one opens the form below with its
                                name filled in; the one picked stays marked
                                while the form is open. */}
                            <button type="button"
                              aria-pressed={chosen === f.ssid}
                              title={t('local_control.add_backup_network')}
                              onClick={() => setChosen(f.ssid)}
                              className={`rounded border px-2 py-0.5 text-[12px] ${
                                chosen === f.ssid
                                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
                                  : 'border-transparent bg-[var(--color-surface)] hover:border-[var(--color-line-strong)]'}`}>
                              {f.ssid}
                              {f.rssi != null && (
                                <span className="ml-1 text-[var(--color-ink-3)]">{f.rssi}</span>
                              )}
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                {chosen !== null && (
                  <form
                    className="mt-2 grid gap-2 sm:grid-cols-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const f = new FormData(e.currentTarget as HTMLFormElement)
                      run(say, 'bkadd', () => api.post('/api/local/backup-aps/networks', {
                        ssid: chosen.trim(),
                        password: String(f.get('pw') || '') || undefined,
                      }), t('local_control.backup_network_added')).then(() => {
                        const added = chosen.trim()
                        setChosen(null)
                        void settleBackup((b) => b.credentials.some((x) => x.ssid === added))
                      })
                    }}
                  >
                    <input name="ssid" required maxLength={32} placeholder={t('local_control.network_name')}
                           value={chosen} onChange={(e) => setChosen(e.target.value)}
                           aria-label={t('local_control.backup_network_name')} className={BK_FIELD} />
                    <input name="pw" type="password" placeholder={t('local_control.password_if_any')}
                           aria-label={t('local_control.backup_network_password')} autoComplete="new-password"
                           className={BK_FIELD} />
                    <SubmitButton disabled={busy === 'bkadd'} className="justify-self-start sm:col-span-2">
                      {t('local_control.add_backup_network')}
                    </SubmitButton>
                  </form>
                )}
              </div>
              ) : (
                <p className="text-[13px] text-[var(--color-ink-3)]">{t('local_control.not_loaded')}</p>
              )}
            </div>
          )}
        </PlusLock>

        {backupNeedsPlus && (
          <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
            {t('local_control.backup_internet_part_eero_plus')}
          </p>
        )}
      </>)}
    </Card>
  )
}
