import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, lastRead } from '../lib/api'
import { ProfileFilters, type FilterProfile } from '../components/ProfileFilters'
import { ProfileSchedule } from '../components/ProfileSchedule'
import { useRevalidate } from '../lib/revalidate'
import { invalidateProfiles } from '../lib/profiles'
import { Page, Card, Drawer, EditableText, Notice, RowAction, SkeletonCard, StatusDot, SubmitButton, useNotice } from '../components/primitives'
import { t, tn, tx } from '../i18n'
import type { CSSProperties, ReactNode } from 'react'

interface Filter { key: string; label: string; on: boolean }
interface PDevice { url: string; mac: string; name: string; connected: boolean }
interface Schedule {
  url: string; name: string | null; enabled: boolean
  days: string[] | null; start: string | null; end: string | null
}
interface AllDevice {
  url: string; mac?: string | null
  nickname?: string | null; hostname?: string | null; display_name?: string | null
  profile?: { name?: string | null } | null
}

/** Every client belongs to a profile, so naming the one it is in only helps
 *  where that profile means something. "Unassigned" is eero's word for not
 *  being in one, and printing it against half the list is noise. */
const heldBy = (d: AllDevice) => {
  const name = d.profile?.name
  return name && name.toLowerCase() !== 'unassigned' ? name : ''
}

/** Profiles carry no id of their own; it is the tail of their URL. */
const idOfProfile = (p: { url: string }) =>
  p.url.replace(/\/$/, '').split('/').pop() ?? ''

interface Profile {
  url: string; name: string; paused: boolean; state: string | null
  paused_by_schedule: boolean; default: boolean; unassigned: boolean
  device_count: number; devices_online: number; devices: PDevice[]
  filters: Filter[]; filters_configured: boolean
  ad_block: boolean; blocked_applications: string[]
  schedules: Schedule[]
  sites?: { blocked?: string[]; allowed?: string[] } | null
  /** A photo stored on this machine for the card, and a number that changes
   *  when it does, so the browser fetches the new one. eero knows nothing of
   *  either. */
  has_photo?: boolean; photo_version?: number | null
}

/** The cards in a stable order: Unassigned first, since it is where every
 *  client starts and the one card that is about the network rather than a
 *  person, then the people alphabetically. eero returns profiles in creation
 *  order, which is no order a reader can predict. */
const ordered = (rows: Profile[]) => [...rows].sort((a, b) =>
  a.unassigned !== b.unassigned ? (a.unassigned ? -1 : 1)
    : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

/** How many things this profile filters right now: content categories on,
 *  apps blocked, sites blocked, and ad blocking if it is on. Not schedules —
 *  a pause is not a filter. */
const activeFilters = (p: Profile) =>
  p.filters.filter((f) => f.on).length
  + (p.blocked_applications?.length ?? 0)
  + (p.sites?.blocked?.length ?? 0)
  + (p.ad_block ? 1 : 0)

/** "AL" for "Ada Lovelace", "A" for "Ada", "?" for nothing. The first letter
 *  of the first two words, by code point rather than by UTF-16 unit so a name
 *  that starts with an emoji does not get half of it. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
  const letters = words.map((w) => [...w][0]?.toLocaleUpperCase() ?? '').join('')
  return letters || '?'
}

/**
 * Crop the middle square out of a picture and shrink it to `size` pixels.
 *
 * Done here rather than on the server so a 12-megapixel phone photo crosses
 * the wire as a few tens of kilobytes, and so whatever the camera wrote into
 * the file — where it was taken, when, on what — never leaves this browser.
 * `createImageBitmap` applies the orientation the camera recorded, which is
 * how a portrait shot arrives the right way up. Rejects for a file the
 * browser cannot decode, HEIC among them.
 */
async function squareThumbnail(file: Blob, size = 256): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  try {
    const side = Math.min(bmp.width, bmp.height)
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const g = canvas.getContext('2d')
    if (!g) throw new Error('no canvas')
    g.imageSmoothingQuality = 'high'
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side,
                0, 0, size, size)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))),
                    'image/jpeg', 0.86))
  } finally {
    bmp.close()
  }
}

/* The marks on the card's buttons. Drawn here rather than pulled from an icon
   set: seven shapes, each a couple of strokes, and nothing else in the app
   needs them. Stroke-based and in currentColor, so they take the button's
   tone. */
type GlyphName = 'devices' | 'filters' | 'schedule' | 'pause' | 'play'
                 | 'trash' | 'camera'
function Glyph({ name, size = 14 }: { name: GlyphName; size?: number }) {
  const path = {
    devices: <><rect x="2" y="4" width="14" height="10" rx="1.5" /><path d="M6 18h6" />
                <rect x="17" y="8" width="5" height="10" rx="1" /></>,
    filters: <path d="M3 5h18l-7 8v6l-4-2v-4L3 5z" />,
    schedule: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>,
    pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
    play: <path d="M8 5l11 7-11 7z" />,
    trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" />
              <path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" /><path d="M9 7V4h6v3" /></>,
    camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  }[name]
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="2.2"
         strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {path}
    </svg>
  )
}

/* A card's button: a mark and a word, filling its cell of the card's grid so
   the two of them line up whatever their captions say. Tall enough to be the
   card's main controls, which they are. */
function CardButton({ glyph, tone = 'neutral', onClick, disabled, title, children }: {
  glyph: GlyphName
  tone?: 'neutral' | 'accent'
  onClick: () => void
  disabled?: boolean
  title?: string
  children: ReactNode
}) {
  const color = tone === 'accent' ? 'var(--color-accent)' : 'var(--color-line-strong)'
  const ink = tone === 'neutral' ? 'var(--color-ink-2)' : color
  return (
    /* Wraps rather than spilling: in a card too narrow for the glyph and the
       word side by side, the glyph goes above the word, and the word never
       runs out past the button's edge. */
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      data-part="card-button"
      className="toned flex w-full min-w-0 flex-wrap items-center justify-center gap-x-2
                 gap-y-1 rounded border px-3 py-2.5 text-center text-[13px] font-medium
                 disabled:opacity-40"
      style={{ '--btn-line': color, color: ink } as CSSProperties}>
      <Glyph name={glyph} size={15} />
      <span className="inline-flex min-w-0 items-center gap-1.5">{children}</span>
    </button>
  )
}

/**
 * The face on the card.
 *
 * eero has no picture for a profile, so until somebody adds one this is the
 * name's initials. Clicking it picks a file; the picture is cropped and shrunk
 * in the browser and stored on this machine, never sent to eero. Once there is
 * a photo, clicking it asks — upload a new one, or remove it — in a small menu
 * rather than a cross in the corner that removed on a mis-click. Unassigned is
 * not a person — it is where clients wait — so it gets a mark for devices and
 * no way to give it a face.
 */
function Avatar({ p, busy, onPick, onRemove }: {
  p: Profile; busy: boolean
  onPick: (file: File) => void; onRemove: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLSpanElement>(null)
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  if (p.unassigned) {
    return (
      <span data-part="avatar"
            className="grid size-14 shrink-0 place-items-center rounded-full
                       bg-[var(--color-surface-2)] text-[var(--color-ink-3)]">
        <Glyph name="devices" size={22} />
      </span>
    )
  }
  const label = p.has_photo
    ? t('profiles.photo_options', { name: p.name })
    : t('profiles.add_photo', { name: p.name })
  return (
    <span ref={box} className="relative shrink-0">
      <button type="button" disabled={busy} data-part="avatar"
        onClick={() => (p.has_photo ? setMenu((v) => !v) : input.current?.click())}
        title={label} aria-label={label}
        aria-haspopup={p.has_photo ? 'menu' : undefined}
        aria-expanded={p.has_photo ? menu : undefined}
        className="group relative block size-14 overflow-hidden rounded-full border
                   border-[var(--color-line)] bg-[var(--color-accent-wash)]
                   disabled:opacity-60">
        {p.has_photo ? (
          <img src={`/api/profiles/${idOfProfile(p)}/photo?v=${p.photo_version ?? 0}`}
               alt={t('profiles.photo_of', { name: p.name })}
               className="size-full object-cover" />
        ) : (
          <span data-initials
                className="grid size-full place-items-center text-[18px] font-semibold
                           text-[var(--color-accent-ink)]">
            {initialsOf(p.name)}
          </span>
        )}
        {/* The camera shows on hover and focus: the face is the picture, and a
            permanent badge on every card would say "upload" louder than the
            person's name. */}
        <span className="absolute inset-x-0 bottom-0 grid h-5 place-items-center
                         bg-black/45 text-white opacity-0 transition-opacity
                         group-hover:opacity-100 group-focus-visible:opacity-100">
          <Glyph name="camera" size={12} />
        </span>
      </button>
      <input ref={input} type="file" accept="image/*" hidden
             onChange={(e) => {
               const f = e.target.files?.[0]
               e.target.value = ''    // so choosing the same file again fires
               if (f) onPick(f)
             }} />
      {menu && (
        <div role="menu" aria-label={label}
             className="absolute left-0 top-full z-20 mt-1 w-48 rounded-md border
                        border-[var(--color-line)] bg-[var(--color-surface)] py-1 shadow-lg">
          <button type="button" role="menuitem"
                  onClick={() => { setMenu(false); input.current?.click() }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]
                             hover:bg-[var(--color-surface-2)]">
            <Glyph name="camera" /> {t('profiles.upload_new_photo')}
          </button>
          <button type="button" role="menuitem"
                  onClick={() => { setMenu(false); onRemove() }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]
                             hover:bg-[var(--color-surface-2)]">
            <Glyph name="trash" /> {t('profiles.remove_photo')}
          </button>
        </div>
      )}
    </span>
  )
}


/**
 * Choose a client to add to a profile.
 *
 * A native select can hold nothing but text, and the profile a client is
 * already in is worth showing as the same badge used everywhere else rather
 * than as "(name)" in the middle of a sentence. So this is a listbox, with the
 * keyboard behavior a select would have given for free written out.
 */
/** What a device row shows, and therefore what it sorts by.
 *
 *  One function for both, because they had drifted: the picker rendered
 *  `display_name` where the sort key did not look at it, so those rows sorted
 *  by MAC and the list read as unsorted. */
const labelOfDevice = (d: { nickname?: string | null; hostname?: string | null
                            display_name?: string | null
                            mac?: string | null; name?: string | null }) =>
  d.name || d.nickname || d.hostname || d.display_name || d.mac || 'device'

function AddDevicePicker({ devices, disabled, onPick }: {
  devices: AllDevice[]
  disabled?: boolean
  onPick: (d: AllDevice) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  // eero returns clients in no order a person would recognize. Sorted by the
  // label the row actually shows, and with localeCompare so a lowercase name
  // does not sort below every uppercase one.
  const sorted = [...devices].sort(
    (a, b) => labelOfDevice(a).localeCompare(labelOfDevice(b)))

  useEffect(() => {
    if (!open) return
    setActive(0)
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const choose = (d: AllDevice) => { setOpen(false); onPick(d) }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault(); setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, sorted.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    if (e.key === 'End') { e.preventDefault(); setActive(sorted.length - 1) }
    if ((e.key === 'Enter' || e.key === ' ') && sorted[active]) {
      e.preventDefault(); choose(sorted[active])
    }
  }

  if (!sorted.length) {
    return (
      <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
        {t('profiles.every_client_already_profile')}
      </p>
    )
  }

  return (
    <div ref={box} className="relative mt-2">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 text-left text-[13px] disabled:opacity-50"
      >
        <span>{t('profiles.add_device')}</span>
        <svg viewBox="0 0 24 24" className="size-3 text-[var(--color-ink-3)]"
             fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t('profiles.device_add')}
          tabIndex={-1}
          className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {sorted.map((d, i) => (
            <li key={d.mac}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(d)}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] ${
                  i === active ? 'bg-[var(--color-surface-2)]' : ''}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {labelOfDevice(d)}
                </span>
                {heldBy(d) && (
                  <span className="shrink-0 rounded bg-[var(--color-accent-wash)] px-1.5 text-[11px] font-semibold text-[var(--color-accent-ink)]">
                    {heldBy(d)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Profiles() {
  /* Opens on the last answer; the read below asks for a new one. */
  const [rows, setRows] = useState<Profile[] | null>(
    () => lastRead<Profile[]>('/api/profiles') ?? null)
  /* Both panels are drawers again. They were pages for a while, because the
     filters pane had five sections in a 440px panel and the tab strip ran off
     its own container; the schedule is its own thing now and the drawer the
     filters open in is wider, so the reason has gone away. */
  const [filtersUrl, setFiltersUrl] = useState<string | null>(null)
  const [scheduleUrl, setScheduleUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const say = useNotice()
  const drawerSay = useNotice()
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // The drawer holds the profile's URL, not a copy of it. Holding the object
  // meant every refresh left the panel rendering the version captured when it
  // was opened — adding a device updated the list behind it while the panel
  // still said the profile had none.
  const [openUrl, setOpenUrl] = useState<string | null>(null)
  const open = rows?.find((p) => p.url === openUrl) ?? null
  const forFilters = rows?.find((p) => p.url === filtersUrl) ?? null
  const forSchedule = rows?.find((p) => p.url === scheduleUrl) ?? null
  const [allDevices, setAllDevices] = useState<AllDevice[]>(
    () => lastRead<AllDevice[]>('/api/devices') ?? [])

  const load = useCallback(() => {
    api.get<AllDevice[]>('/api/devices')
      .then((d) => setAllDevices(d ?? [])).catch(() => {})
    // Returned so a caller can wait for the server's own answer before
    // dropping an optimistic override.
    return api.get<Profile[]>('/api/profiles')
      .then((d) => { setRows(d ?? []); invalidateProfiles() })
      .catch((e) => setErr(e instanceof ApiError ? e.message : t('profiles.could_not_load_profiles')))
  }, [])
  useEffect(() => { void load() }, [load])
  // A message about one profile should not greet you inside another.
  useEffect(() => { drawerSay.clear() }, [openUrl])   // eslint-disable-line react-hooks/exhaustive-deps
  useRevalidate(load)

  /** Same as `run`, but reports inside the drawer rather than on the page
   *  behind it. */
  async function runHere(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); drawerSay.clear()
    try { await fn(); drawerSay.ok(ok); await load() }
    catch (e) {
      drawerSay.fail(e instanceof ApiError ? e.message : t('profiles.did_not_work'))
    } finally { setBusy(null) }
  }

  async function run(key: string, fn: () => Promise<unknown>, ok: string | null) {
    setBusy(key); say.clear()
    try { await fn(); if (ok) say.ok(ok); load() }
    catch (e) { say.fail(e instanceof ApiError ? e.message : t('profiles.did_not_work')) }
    finally { setBusy(null) }
  }

  /** Take every device out of a profile at once. eero has no bulk call, so it
   *  is one per device; a failure part-way is reported as one rather than
   *  claiming the whole thing worked. */
  async function removeAllDevices(p: Profile) {
    const all = p.devices
    if (!window.confirm(t('profiles.remove_all_length_devices_from', { length: all.length, name: p.name }))) return
    setBusy(p.url); drawerSay.clear()
    let done = 0
    try {
      for (const d of all) {
        await api.del(`/api/profiles/${idOfProfile(p)}/devices/${d.mac}`)
        done += 1
      }
      drawerSay.ok(t('profiles.done_devices_removed_from_name', { done: done, name: p.name }))
    } catch (e) {
      const why = e instanceof ApiError
        ? e.message : t('profiles.something_went_wrong')
      drawerSay.fail(done
        ? t('profiles.removed_of_then_stopped',
            { done, total: all.length, reason: why })
        : (e instanceof ApiError ? e.message : t('profiles.did_not_work')))
    } finally {
      setBusy(null)
      void load()
    }
  }

  /* Pause and resume show their result the moment the control is pressed and
     hold it until the list has been re-read, so the glyph flips at once and
     does not flip back for the beat before the server's answer lands. Its own
     bookkeeping rather than `busy`: a pause in flight used to dim Delete on
     the card and New profile in the header, which had nothing to do with it,
     and disabling the control itself made its hover state snap off and on. */
  const [pausing, setPausing] = useState<Record<string, boolean>>({})
  async function togglePause(p: Profile) {
    if (p.url in pausing) return            // one change per profile at a time
    const next = !p.paused
    setPausing((m) => ({ ...m, [p.url]: next }))
    say.clear()
    try {
      await api.put(`/api/profiles?url=${encodeURIComponent(p.url)}`, { paused: next })
      await load()
    } catch (e) {
      say.fail(e instanceof ApiError ? e.message : t('profiles.did_not_work'))
    } finally {
      setPausing((m) => { const { [p.url]: _gone, ...rest } = m; return rest })
    }
  }

  const rename = (p: Profile, name: string) =>
    run(p.url, () => api.put(`/api/profiles?url=${encodeURIComponent(p.url)}`, { name }),
        // No confirmation: the new name is already on the row, which says it
        // landed better than a sentence repeating it — and the notice appeared
        // above the list and shifted every row down to do so.
        null)

  function remove(p: Profile) {
    if (!window.confirm(tn('profiles.confirm_delete', p.device_count,
                            { name: p.name }))) return
    run(p.url, () => api.del(`/api/profiles?url=${encodeURIComponent(p.url)}`),
        t('profiles.name_deleted', { name: p.name }))
  }

  /* The picture is checked and shrunk here before anything is sent; the two
     things that can go wrong on this side each get their own sentence. No
     notice on success — the face appearing on the card is the confirmation. */
  async function setPhoto(p: Profile, file: File) {
    say.clear()
    if (file.size > 10 * 1024 * 1024) { say.fail(t('profiles.photo_too_large')); return }
    let small: Blob
    try { small = await squareThumbnail(file) }
    catch { say.fail(t('profiles.not_an_image')); return }
    await run(p.url,
              () => api.putBlob(`/api/profiles/${idOfProfile(p)}/photo`, small, 'image/jpeg'),
              null)
  }
  const dropPhoto = (p: Profile) =>
    run(p.url, () => api.del(`/api/profiles/${idOfProfile(p)}/photo`), null)

  if (err) return <Notice kind="bad">{err}</Notice>
  if (!rows) return (
    <Page name="profiles">
      <SkeletonCard icon="profile" title={t('profiles.profiles')} rows={4} />
    </Page>
  )

  return (
    <Page name="profiles">
      <Card icon="profile"
        title={t('nav.profiles')}
        count={rows.length}
        anchor="profiles"
        action={
          <RowAction onClick={() => setCreating((v) => !v)} disabled={busy === 'new'}>
            {creating ? t('profiles.cancel') : t('profiles.new_profile')}
          </RowAction>
        }
      >
        <p className="mb-3 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          {t('profiles.profile_groups_person_s_devices')}
        </p>

        {creating && (
          <form
            className="mb-4 flex flex-wrap gap-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3"
            onSubmit={(e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget as HTMLFormElement)
              run('new', () => api.post('/api/profiles', {
                name: String(f.get('name')), device_urls: [], paused: false,
              }), t('profiles.profile_created')).then(() => setCreating(false))
            }}
          >
            <input name="name" required placeholder={t('profiles.name_example_kids')}
              className="min-w-0 flex-1 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-2 text-[13px]" />
            <SubmitButton disabled={Boolean(busy)}>
              {t('profiles.create')}
            </SubmitButton>
            <p className="w-full text-[12px] text-[var(--color-ink-3)]">
              {t('profiles.devices_assigned_afterwards_from_profile')}
            </p>
          </form>
        )}

        {say.node}

        {rows.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-[var(--color-ink-3)]">
            {t('profiles.no_profiles_yet')}
          </p>
        ) : (
          <ul data-part="profile-list" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ordered(rows).map((p) => {
              // Whether this profile restricts anything at all. The count of
              // what it restricts is not useful at a glance — one blocked app
              // and nine content categories are both just "restricted" until
              // you open it — so the button is colored rather than numbered.
              const restricted = p.filters.some((f) => f.on)
                || (p.blocked_applications?.length ?? 0) > 0
              const isBusy = busy === p.url
              const filtering = activeFilters(p)
              /* What the card shows while a pause or resume is in flight. */
              const paused = pausing[p.url] ?? p.paused
              return (
                /* A card per person: the face, the name, and the state up top
                   with the pause control in the corner, the two things you
                   open — devices and filters — as tall buttons under them, and
                   Delete as a plain word at the foot, where a mis-click is
                   least likely and a real intention still finds it. */
                <li key={p.url}
                    className="flex flex-col gap-3 rounded-md border border-[var(--color-line)] p-3">
                  <div className="flex items-start gap-3">
                    <Avatar p={p} busy={isBusy}
                            onPick={(f) => void setPhoto(p, f)}
                            onRemove={() => void dropPhoto(p)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                          {/* eero creates and owns Unassigned; renaming it would
                              leave the catch-all under a name nothing else uses. */}
                          <EditableText
                            value={p.name}
                            placeholder={t('profiles.unnamed_profile')}
                            disabled={p.unassigned}
                            onSave={(v) => rename(p, v)} />
                        </span>
                        {p.default && (
                          <span className="shrink-0 rounded bg-[var(--color-accent-wash)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--color-accent-ink)]">
                            {t('profiles.default')}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--color-ink-3)]">
                        <StatusDot state={paused ? 'warn' : 'ok'}
                          label={paused ? (p.paused_by_schedule ? t('profiles.paused_schedule') : t('profiles.paused')) : t('profiles.active')} />
                        <span>
                          {p.device_count
                            ? tn('profiles.device_summary', p.device_count,
                                 { count: p.device_count, online: p.devices_online })
                            : t('profiles.no_devices')}
                        </span>
                      </div>
                    </div>
                    {/* Pause and resume as one round control: the pause bars
                        while the profile is active, a play triangle while it
                        is paused. The dot beside the name says which state it
                        is in; the button says what pressing it does. */}
                    <button type="button" data-pause-toggle
                      aria-label={paused ? t('profiles.resume_name', { name: p.name })
                                         : t('profiles.pause_name', { name: p.name })}
                      aria-pressed={paused}
                      aria-busy={p.url in pausing}
                      title={p.paused_by_schedule
                        ? t('profiles.profile_paused_one_its_schedules')
                        : paused ? t('profiles.resume_name', { name: p.name })
                                 : t('profiles.pause_name', { name: p.name })}
                      disabled={p.paused_by_schedule}
                      onClick={() => void togglePause(p)}
                      className="pp-toggle toned grid size-8 shrink-0 place-items-center rounded-full
                                 border text-[var(--color-ink-2)] disabled:opacity-40"
                      style={{ '--btn-line': 'var(--color-line-strong)' } as CSSProperties}>
                      {/* Keyed on the state, so the glyph is a fresh element
                          each time it changes and its pop-in plays. */}
                      <span key={paused ? 'play' : 'pause'} className="pp-pop inline-grid">
                        <Glyph name={paused ? 'play' : 'pause'} size={14} />
                      </span>
                    </button>
                  </div>
                  {/* Three things you open, in the order somebody reaches for
                      them: who is in the profile, what it may reach, and when
                      it may reach anything at all. */}
                  <div className="grid grid-cols-3 gap-2">
                    <CardButton glyph="devices" onClick={() => setOpenUrl(p.url)}>
                      {t('profiles.devices')}
                    </CardButton>
                    <CardButton glyph="filters"
                      tone={restricted ? 'accent' : 'neutral'}
                      title={filtering
                        ? tn('profiles.filters_active', filtering, { count: filtering })
                        : restricted
                          ? t('profiles.profile_restricts_something')
                          : t('profiles.nothing_restricted_profile')}
                      onClick={() => setFiltersUrl(p.url)}>
                      {t('profile_detail.filters')}
                      {/* How many things it filters, when it filters anything:
                          the count is what tells one restricted profile from
                          another without opening either. */}
                      {filtering > 0 && (
                        <span data-filter-count
                              className="rounded-full bg-[var(--color-accent)] px-1.5 text-[11px]
                                         font-semibold leading-[18px] text-white">
                          {filtering}
                        </span>
                      )}
                    </CardButton>
                    <CardButton glyph="schedule"
                      tone={p.schedules.length ? 'accent' : 'neutral'}
                      title={p.schedules.length
                        ? tn('profiles.schedules_set', p.schedules.length,
                             { count: p.schedules.length })
                        : t('profiles.nothing_scheduled_profile')}
                      onClick={() => setScheduleUrl(p.url)}>
                      {t('profiles.schedule')}
                      {p.schedules.length > 0 && (
                        <span data-schedule-count
                              className="rounded-full bg-[var(--color-accent)] px-1.5 text-[11px]
                                         font-semibold leading-[18px] text-white">
                          {p.schedules.length}
                        </span>
                      )}
                    </CardButton>
                  </div>
                  {/* eero owns Unassigned and there is no call to delete it, so
                      it has no Delete at all. */}
                  {!p.unassigned && (
                    <div className="mt-auto flex justify-end">
                      <button type="button"
                        disabled={isBusy || p.default}
                        title={p.default
                          ? t('profiles.default_profile_cannot_deleted') : undefined}
                        onClick={() => remove(p)}
                        className="text-[12px] text-[var(--color-ink-3)] underline-offset-2
                                   hover:text-[var(--color-ink)] hover:underline
                                   disabled:cursor-default disabled:opacity-40 disabled:no-underline">
                        {t('profiles.delete')}
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <p className="mt-3 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {tx('profiles.every_client_belongs', {
            unassigned: <strong className="font-semibold">
                          {t('profiles.unassigned')}
                        </strong>,
          })}
        </p>
      </Card>

      {/* Wide, because what is in it is sections and lists rather than a
          column of label-and-value rows. */}
      <Drawer open={Boolean(forFilters)} size="wide"
              onClose={() => setFiltersUrl(null)}
              title={forFilters
                ? `${forFilters.name} · ${t('profile_detail.filters')}`
                : t('profile_detail.filters')}>
        <ProfileFilters profile={forFilters as FilterProfile | null} bare
                        onChanged={() => { void load() }} />
      </Drawer>

      <Drawer open={Boolean(forSchedule)} onClose={() => setScheduleUrl(null)}
              title={forSchedule
                ? `${forSchedule.name} · ${t('profile_filters.scheduled_pauses')}`
                : t('profile_filters.scheduled_pauses')}>
        <ProfileSchedule profile={forSchedule as FilterProfile | null} bare
                         onChanged={() => { void load() }} />
      </Drawer>

      <Drawer open={Boolean(open)} onClose={() => setOpenUrl(null)}
              title={open?.name ?? t('client_detail.profile')}>
        {open && (
          <div>
            {drawerSay.node && <div className="mb-3">{drawerSay.node}</div>}
            <h3 className="mb-2 text-[13px] font-semibold">{t('profiles.devices')}</h3>

            {/* A device belongs to at most one profile, so the choices are
                the clients not already under this one. */}
            <AddDevicePicker
              devices={allDevices.filter((d) => {
                if (!d.mac) return false
                if (open.devices.some((x) => x.mac === d.mac)) return false
                /* eero's two answers about which profile a client is in can
                   disagree. On the test network the Unassigned profile listed
                   83 of 90 clients while three of the missing ones named
                   Unassigned as their own profile — so they were offered as
                   something to add to the profile they were already in.
                   Either source saying so is enough to mean "already here". */
                const held = (d.profile?.name ?? '').trim().toLowerCase()
                return !held || held !== open.name.trim().toLowerCase()
              })}
              disabled={Boolean(busy)}
              onPick={(d) => runHere('devices',
                () => api.put(
                  `/api/profiles/${idOfProfile(open)}/devices/${d.mac}`, {}),
                // The same label the picker showed, not a third spelling of
                // it. This one omitted `name` and `display_name`, so choosing
                // a device that only has those reported its MAC back instead
                // of the name that had just been clicked.
                t('profiles.device_added_to',
                  { device: labelOfDevice(d), profile: open.name }))}
            />

            {open.devices.length ? (
              <ul className="grid gap-1">
                {[...open.devices]
                  .sort((a, b) => labelOfDevice(a).localeCompare(labelOfDevice(b)))
                  .map((d) => (
                  <li key={d.url}
                      className="flex items-center gap-2 border-b border-[var(--color-line)] py-1 last:border-0">
                    <StatusDot state={d.connected ? 'ok' : 'idle'} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{d.name}</span>
                    {!open.unassigned && (
                      <RowAction
                        disabled={Boolean(busy)}
                        onClick={() => runHere('devices',
                          () => api.del(
                            `/api/profiles/${idOfProfile(open)}/devices/${d.mac}`),
                          t('profiles.device_removed_from',
                { device: d.name, profile: open.name }))}
                      >
                        {t('profiles.remove')}
                      </RowAction>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-[var(--color-ink-3)]">
                {t('profiles.no_devices_assigned_profile')}
              </p>
            )}

            {/* Worth offering only once there is more than one to clear;
                with a single device it is the Remove already beside it. */}
            {!open.unassigned && open.devices.length > 1 && (
              <div className="mt-2 flex justify-end border-t border-[var(--color-line)] pt-2">
                <RowAction tone="bad" disabled={Boolean(busy)}
                  onClick={() => void removeAllDevices(open)}>
                  {t('profiles.remove_all')}
                </RowAction>
              </div>
            )}

          </div>
        )}
      </Drawer>

    </Page>
  )
}
