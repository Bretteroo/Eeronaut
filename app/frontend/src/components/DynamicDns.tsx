import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { AutoHeight, SubmitButton, useNotice } from './primitives'
import { PlusSash, useCapability } from '../lib/capabilities'
import { useClock } from '../lib/clock'
import { t, tOr } from '../i18n'

/* Dynamic DNS, across two quite different things wearing one control.

   `eero.online` is eero's own: it is an eero Plus feature, eero does the
   updating, and there is nothing to configure beyond turning it on. Every other
   entry is a third-party provider that eero knows nothing about — this app
   holds the credentials and does the updating itself, which is why those are
   not gated. Only the eero option is, and it is the only one that carries a
   Plus mark.

   That asymmetry is the whole reason this is a listbox rather than a select: an
   <option> cannot hold a Plus mark, and it cannot be dimmed with an
   explanation of why it is out of reach. */

interface Field {
  name: string
  label: string
  secret: boolean
  placeholder: string
  hint: string
  /** Not needed to publish, and not reported missing when empty. */
  optional?: boolean
}
interface Provider {
  id: string
  name: string
  kind: string
  note: string
  ipv6: boolean
  fields: Field[]
}
/** Why a change was turned down, when the setup before it was kept. */
type Rejection = Pick<DdnsStatus, 'result' | 'detail' | 'detail_key' | 'detail_args'>

export interface DdnsStatus {
  last_published: string
  last_attempt: number
  last_success: number
  result: string
  detail: string
  /** Set when `detail` is this app's own sentence rather than a provider's
      reply, and so is ours to translate. */
  detail_key: string
  detail_args: Record<string, string>
  /** Whether the name resolves here, which is a different question from
      whether the provider accepted the update. One of: "" (not looked up
      yet), match, mismatch, missing, unchecked (the lookup did not
      complete), unknowable (the provider never names the record). */
  resolve_state: string
  resolved_ip: string
  resolved_at: number
  wan_ip: string
}
interface Config {
  provider: string
  enabled: boolean
  /** The name being published, by the provider's own rule. Empty for FreeDNS,
      which never names the record it updates. */
  name?: string
  fields: Record<string, string>
  secrets_set: string[]
  missing: string[]
  status: DdnsStatus
}

/** A saved provider this release no longer offers. Read as Off, since that is
 *  what it amounts to: the backend has nothing to publish through. Unknown
 *  until the list arrives, so the saved pick is not flashed away first. */
const retired = (id: string, provs: Provider[] | null) =>
  provs !== null && !provs.some((p) => p.id === id)

/** eero's own option, which is not one of the third-party providers. */
const EERO = 'eero.online'
const OFF = ''

/* What each outcome means on screen. The vocabulary is the backend's, and the
   split that matters is whether it is the user's to fix: `auth`, `notfound` and
   `blocked` are, and the updater stops retrying them until something changes.
   Anything else is either fine or will be tried again on its own. */
const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle'> = {
  ok: 'ok', nochange: 'ok',
  auth: 'bad', notfound: 'bad', blocked: 'bad',
  provider: 'warn', transport: 'warn', nosession: 'warn',
  pending: 'idle', unconfigured: 'idle',
}

const DOT: Record<string, string> = {
  ok: 'var(--color-ok)', warn: 'var(--color-warn)',
  bad: 'var(--color-bad)', idle: 'var(--color-line-strong)',
}

/** The "does this name point here" line. Silent unless it has something to
    say — see the note at the call site for which cases those are. */
/** Three dots that take turns, for work with no progress to report. Still for
 *  anyone who has asked for less motion. Hidden from screen readers, which
 *  hear the word before them. */
function Dots() {
  return (
    <span aria-hidden="true" className="working-dots">
      <span>.</span><span>.</span><span>.</span>
    </span>
  )
}

function ResolveLine({ st, name }: { st?: DdnsStatus; name: string }) {
  const state = st?.resolve_state
  if (!state || state === 'unchecked' || state === 'unknowable') return null
  const tone = state === 'match' ? 'ok' : state === 'mismatch' ? 'warn' : 'bad'
  const text = state === 'match' ? t('ddns.resolves_here', { name })
    : state === 'mismatch'
      ? t('ddns.resolves_elsewhere', { name, ip: st?.resolved_ip ?? '' })
      : t('ddns.does_not_resolve', { name })
  return (
    <div className="mt-1 flex items-baseline gap-1.5 text-[12px]">
      <span aria-hidden="true"
            className="mt-[3px] inline-block size-2 shrink-0 self-start rounded-full"
            style={{ background: DOT[tone] }} />
      <span className="text-[var(--color-ink-3)]">{text}</span>
    </div>
  )
}

/** What to show under the status line.

    A provider's own reply text is passed straight through — it is not ours to
    translate, and paraphrasing it would hide what the provider actually said.
    Only sentences this app wrote carry a key, and only those get translated. */
function detailText(st: DdnsStatus, prov: Provider | null): string {
  if (!st.detail_key) return st.detail
  if (st.detail_key === 'ddns_detail.needs') {
    // The backend sends field names rather than labels: the labels it holds are
    // English, and this side already has each provider's in the right language.
    const names = (st.detail_args?.names ?? '').split(',').filter(Boolean)
    if (!names.length || !tOr('ddns_detail.needs', '')) return st.detail
    const labels = names.map((n) => {
      const f = prov?.fields.find((x) => x.name === n)
      return tOr(`ddns_field.${prov?.id}.${n}`, f?.label ?? n)
    })
    return t('ddns_detail.needs', { names: labels.join(', ') })
  }
  return tOr(st.detail_key, st.detail)
}

/* No `busy` prop, deliberately. The card passes one down to everything else in
   it, because those controls all write to the same network object and a second
   write while the first is in flight is worth preventing. This one does not:
   third-party dynamic DNS is stored by this app, not by eero, so it has nothing
   to collide with. Taking the card's flag anyway meant toggling IPv6 upstream
   dimmed the provider picker, which reads as the picker being unavailable for
   a reason nobody can see. Its own `saving` covers its own writes. */
export function DynamicDns({ eeroDdns, onEeroToggle, alone = false }: {
  /** eero's own dynamic DNS, as the network object reports it. */
  eeroDdns?: { enabled?: boolean; subdomain?: string }
  onEeroToggle: (on: boolean) => Promise<unknown>
  /** The whole of a card rather than the last row of one, so there is no
   *  rule above it to divide it from the rows it would otherwise follow. */
  alone?: boolean
}) {
  const { when } = useClock()
  const plus = useCapability('ddns_enabled')
  const say = useNotice()
  /* `null` until the fetch lands, which `[]` cannot say: an empty array
     reads as "loaded, no providers" and the picker opened on it. */
  const [provs, setProvs] = useState<Provider[] | null>(null)
  const [sending, setSending] = useState(false)
  /* A change the provider turned down while the setup before it kept
     working. Said once, above the status line, and not stored: the stored
     setup is the working one, so after a reload there is nothing to say. */
  const [rejected, setRejected] = useState<Rejection | null>(null)
  const [cfg, setCfg] = useState<Config | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  const load = () => api.get<Config>('/api/ddns').then(setCfg).catch(() => {})

  useEffect(() => {
    api.get<Provider[]>('/api/ddns/providers').then((p) => setProvs(p ?? []))
      .catch(() => setProvs([]))
    void load()
  }, [])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  /* What is in force, unless something has been picked and not yet saved. eero's
     own switch and the third-party record are separate pieces of state, so the
     selection is derived from both rather than held in one place that could
     disagree with the network. */
  const inForce = eeroDdns?.enabled ? EERO
    : (cfg?.provider && cfg.enabled && !retired(cfg.provider, provs) ? cfg.provider : OFF)
  const selected = picked ?? inForce
  const prov = provs?.find((p) => p.id === selected) ?? null

  /* A pick that has been written stays the selection until what is in force
     catches up with it, and is dropped then rather than the moment the write
     returns. Dropping it early was a visible flicker: picking Off with
     eero.online on read Off, then eero.online with "Published at" again, then
     Off — because the page's re-read of the network had not landed yet and the
     stale switch won for a beat. Only a failed write drops the pick early, so
     the control goes back to telling the truth. */
  useEffect(() => {
    if (picked !== null && !saving && picked === inForce) setPicked(null)
  }, [picked, saving, inForce])

  const seeded = useRef<string | null>(null)
  const typed = useRef<string | null>(null)

  useEffect(() => {
    // Start the form from what is stored, and blank the secrets — they are
    // never sent to the browser, so an empty box means "leave it alone".
    //
    // Only ever seeded once per selection, and not until the stored config has
    // arrived. Keying this on the config instead meant a slow GET landing after
    // somebody had started typing would blank what they had typed: the config
    // going from "not loaded" to "loaded, nothing configured" looks like a
    // change, so the form reset itself out from under them.
    if (cfg === null) return
    // Nor until the provider list has: without it the stored provider has no
    // fields to fill, the form was seeded empty, and nothing seeded it again.
    if (provs === null) return
    if (seeded.current === selected) return
    // Somebody is already filling this in. Their typing outranks the stored
    // values; seeding now would throw the lot away.
    if (typed.current === selected) { seeded.current = selected; return }
    seeded.current = selected
    if (!prov) { setDraft({}); return }
    /* Only the stored provider's own values. Several providers share field
       names — No-IP, Dynu, and FreeDNS all have a hostname — and seeding by
       name filled another provider's form with the one in use, ready to be
       sent to the wrong service. */
    const mine = cfg.provider === prov.id
    const base: Record<string, string> = {}
    for (const f of prov.fields) {
      base[f.name] = f.secret || !mine ? '' : (cfg.fields?.[f.name] ?? '')
    }
    setDraft(base)
  }, [selected, cfg, provs])   // eslint-disable-line react-hooks/exhaustive-deps

  const items = [
    { id: OFF, name: t('ddns.off'), gated: false },
    { id: EERO, name: EERO, gated: true },
    ...(provs ?? []).map((p) => ({ id: p.id, name: p.name, gated: false })),
  ]
  const label = items.find((i) => i.id === selected)?.name ?? t('ddns.off')
  const eeroLocked = !plus.available

  async function choose(id: string) {
    if (id === EERO && eeroLocked) return       // gated; the mark says why
    setOpen(false)
    say.clear()
    if (id === selected) return
    setPicked(id); setRejected(null)
    /* Only Off applies on the spot: it is one action with nothing to look at
       first. eero.online used to apply the same way, and picking it from the
       list switched a publicly resolvable name on with no confirmation and
       nothing shown. It behaves like the other providers now — the pick shows
       the name that would go live, and Connect is what makes it so. */
    if (id === OFF) {
      setSaving(true)
      try {
        if (eeroDdns?.enabled) await onEeroToggle(false)
        await api.put('/api/ddns', { provider: '', enabled: false, fields: {} })
        await load()
      } catch (e) {
        setPicked(null)
        say.fail(e instanceof ApiError ? e.message : t('ddns.did_not_work'))
      } finally { setSaving(false) }
    }
  }

  /* Connect, for eero.online. A third party is never left publishing beside
     it: two things publishing two names would both claim to be "the" name. */
  async function connectEero() {
    setSaving(true); say.clear()
    try {
      await api.put('/api/ddns', { provider: '', enabled: false, fields: {} })
      await onEeroToggle(true)
      await load()
    } catch (e) {
      setPicked(null)
      say.fail(e instanceof ApiError ? e.message : t('ddns.did_not_work'))
    } finally { setSaving(false) }
  }

  async function save() {
    if (!prov) return
    setSaving(true); setSending(true); say.clear()
    try {
      // eero's own and a third party are mutually exclusive: two things
      // publishing to two different names would both claim to be "the" name
      // for this network.
      if (eeroDdns?.enabled) await onEeroToggle(false)
      setRejected(null)
      // Saved and published in one request, so the status line reports
      // something real rather than "pending" until the watcher next wakes.
      // A change the provider rejects is not kept when the setup before it
      // was working; the rejection comes back once, in `rejected`.
      const got = await api.post<Config & { rejected?: Rejection | null }>(
        '/api/ddns/apply', { provider: prov.id, enabled: true, fields: draft })
      if (got.rejected) {
        // What was typed stays, so it can be corrected; the stored setup it
        // was checked against is the working one, which is what `got` holds.
        seeded.current = selected
        setRejected(got.rejected)
      } else {
        // Drop the typed secrets from the form.
        seeded.current = null; typed.current = null
      }
      setCfg(got)
    } catch (e) {
      setPicked(null)
      say.fail(e instanceof ApiError ? e.message : t('ddns.did_not_work'))
    } finally { setSaving(false); setSending(false) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault(); setOpen(true)
        setActive(Math.max(0, items.findIndex((i) => i.id === selected)))
      }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1) }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); void choose(items[active].id)
    }
  }

  /* Whether the form says something other than what is stored. A secret is
     never sent to the browser, so any secret typed at all is a change. */
  const inUse = Boolean(prov && cfg?.provider === prov.id && cfg.enabled)
  const edited = Boolean(prov?.fields.some((f) => {
    const v = draft[f.name] ?? ''
    return f.secret ? v !== '' : v !== (cfg?.fields?.[f.name] ?? '')
  }))

  const st = cfg?.status
  const third = selected !== EERO
  /* Saved and on its way to the provider: from Connect or Update now until
     the reply, or saved and not yet sent. "Not published yet" was true and
     said nothing about whether anything was happening. */
  const publishing = third && (sending || (st?.result === 'pending' && Boolean(cfg?.enabled)))
  /* The provider took the update. Said as the name being active, straight
     away, rather than waiting ten minutes for the look-up; the look-up only
     speaks up if it disagrees, and then "active" would be untrue. */
  const published = third && !publishing
    && (st?.result === 'ok' || st?.result === 'nochange')
  const resolveBad = st?.resolve_state === 'mismatch' || st?.resolve_state === 'missing'
  /* eero.online on, with its name: the same line as a third party's live
     name, green and bold. Its tone came from the third-party status, which
     is blank while eero's is the one in use, so it was gray. eero reports no
     publish time, so there is no "Last published" after it. */
  const eeroLive = selected === EERO && Boolean(eeroDdns?.enabled && eeroDdns?.subdomain)
  const nameLive = (published && !resolveBad) || eeroLive
  const tone = eeroLive ? 'ok'
    : publishing ? 'idle' : TONE[st?.result ?? 'unconfigured'] ?? 'idle'
  const showStatus = selected !== OFF

  return (
    <div className={alone ? '' : 'border-t border-[var(--color-line)] pt-3'}>
      {say.node && <div className="mb-2">{say.node}</div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Alone, the card's title already says it. */}
          {!alone && <div className="text-[13px] text-[var(--color-ink)]">
            {t('network.dynamic_dns')}
          </div>}
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-ink-3)]">
            {t('ddns.gives_a_name_that_follows')}
          </p>
        </div>

        <div ref={box} className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={t('ddns.provider')}
            /* Not openable until the provider list is in hand. Opening early
               showed a two-item menu — Off and eero.online — with every real
               provider missing, and nothing about it looked like loading, so
               the honest answer is to not offer it yet. It is disabled for
               however long one GET takes.

               This is also what the browser suite was tripping over: four
               different tests in ddns.spec.ts failed across full runs and
               passed alone, each waiting on an option the app had not been
               given yet. A test-side wait was the wrong place to fix it —
               a person clicking quickly saw the same empty menu. */
            disabled={saving || provs === null}
            onClick={() => {
              setOpen((v) => !v)
              setActive(Math.max(0, items.findIndex((i) => i.id === selected)))
            }}
            onKeyDown={onKeyDown}
            className="flex min-w-[11rem] items-center justify-between gap-2
                       rounded-md border border-[var(--color-line-strong)]
                       bg-[var(--color-surface)] px-2 py-1 text-left text-[13px]
                       disabled:opacity-50"
          >
            <span className="min-w-0 truncate">{label}</span>
            <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-[var(--color-ink-3)]"
                 fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
          </button>
          {open && (
            <ul
              role="listbox"
              aria-label={t('ddns.provider')}
              tabIndex={-1}
              className="absolute right-0 z-30 mt-1 max-h-72 w-64 overflow-y-auto
                         rounded-md border border-[var(--color-line)]
                         bg-[var(--color-surface)] py-1 shadow-lg"
            >
              {items.map((it, i) => {
                const locked = it.gated && eeroLocked
                return (
                  <li key={it.id || 'off'} className="relative">
                    <button
                      type="button"
                      role="option"
                      aria-selected={it.id === selected}
                      aria-disabled={locked}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => void choose(it.id)}
                      title={locked ? t('ddns.eero_online_needs_plus') : undefined}
                      className={`flex w-full items-center gap-2 px-2
                                  py-1.5 text-left text-[13px] ${
                        it.gated ? 'pr-7' : ''} ${
                        i === active && !locked ? 'bg-[var(--color-surface-2)]' : ''} ${
                        it.id === selected ? 'font-semibold' : ''} ${
                        locked ? 'cursor-default opacity-50' : ''}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{it.name}</span>
                    </button>
                    {/* Only eero's own option is gated, so only it is marked.
                        Everything else on this list works without a
                        subscription, and marking them would say otherwise.
                        Outside the option, not inside it: the mark is a button
                        and an option is not a place to nest one. */}
                    {it.gated && <PlusSash name="ddns_enabled" size={20} />}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>

      {/* The provider's own form, in a panel of its own. Built from what the
          backend says the provider needs, so the fields cannot drift out of
          step with the client that sends them. */}
      <AutoHeight>
        {/* eero.online, picked but not yet on. The same panel shape as a
            provider's form, holding the one thing there is to show: the name
            eero has already reserved for this network, which exists whether or
            not publishing is on. Connect is what turns it on. */}
        {selected === EERO && picked === EERO && !eeroDdns?.enabled ? (
          <form
            className="mt-3 grid gap-2 rounded-md border border-[var(--color-line)]
                       bg-[var(--color-surface-2)] p-3"
            onSubmit={(e) => { e.preventDefault(); void connectEero() }}
          >
            <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
              {t('ddns.eero_would_publish_note')}
            </p>
            <div className="text-[12px] text-[var(--color-ink-2)]">
              {t('ddns.hostname')}
              <div className="mt-1 font-mono text-[13px] text-[var(--color-ink)]">
                {eeroDdns?.subdomain ?? '\u2014'}
              </div>
            </div>
            <div>
              <SubmitButton disabled={saving || !eeroDdns?.subdomain}>
                {t('ddns.connect')}
              </SubmitButton>
            </div>
          </form>
        ) : prov ? (
          <form
            className="mt-3 grid gap-2 rounded-md border border-[var(--color-line)]
                       bg-[var(--color-surface-2)] p-3"
            onSubmit={(e) => { e.preventDefault(); void save() }}
          >
            {prov.note && (
              <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                {tOr(`ddns_note.${prov.id}`, prov.note)}
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {prov.fields.map((f) => (
                <label key={f.name} className="text-[12px] text-[var(--color-ink-2)]">
                  {tOr(`ddns_field.${prov.id}.${f.name}`, f.label)}
                  {f.optional && (
                    <span className="text-[var(--color-ink-3)]"> {t('ddns.optional')}</span>
                  )}
                  <input
                    value={draft[f.name] ?? ''}
                    onChange={(e) => {
                      typed.current = selected
                      setDraft((d) => ({ ...d, [f.name]: e.target.value }))
                    }}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete={f.secret ? 'new-password' : 'off'}
                    placeholder={cfg?.provider === prov.id
                      && cfg.secrets_set?.includes(f.name)
                      ? t('ddns.unchanged') : f.placeholder}
                    aria-label={tOr(`ddns_field.${prov.id}.${f.name}`, f.label)}
                    className="mt-1 w-full rounded-md border
                               border-[var(--color-line-strong)]
                               bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
                  />
                  {f.hint && (
                    <span className="mt-0.5 block text-[11px] leading-snug
                                     text-[var(--color-ink-3)]">
                      {tOr(`ddns_hint.${prov.id}.${f.name}`, f.hint)}
                    </span>
                  )}
                </label>
              ))}
            </div>
            {!prov.ipv6 && (
              <p className="text-[12px] text-[var(--color-ink-3)]">
                {t('ddns.ipv4_only')}
              </p>
            )}
            {/* One button. Connect for a provider not yet in use; for the one in
                use, Save while the form matches what is stored, which has
                nothing to do and is disabled, and Update now once something
                has been typed, since saving publishes straight away. */}
            <div>
              <SubmitButton disabled={saving || (inUse && !edited)}>
                {!inUse ? t('ddns.connect')
                  : edited ? t('ddns.update_now') : t('ddns.save')}
              </SubmitButton>
            </div>
          </form>
        ) : null}
      </AutoHeight>

      {/* One line, always in the same place: whether the name is actually
          pointing at this network. Everything above it is configuration; this
          is the only part that says whether it worked. */}
      {showStatus && third && rejected && !publishing && (
        <div role="alert" className="mt-2 flex items-baseline gap-1.5 text-[12px]">
          <span aria-hidden="true"
                className="mt-[3px] inline-block size-2 shrink-0 self-start rounded-full"
                style={{ background: DOT[TONE[rejected.result] ?? 'bad'] }} />
          <span>
            <span className="font-medium text-[var(--color-ink-2)]">
              {tOr(`ddns.state.${rejected.result}`, rejected.result)}.
            </span>{' '}
            <span className="text-[var(--color-ink-3)]">
              {detailText({ ...(st as DdnsStatus), ...rejected }, prov)}
            </span>
          </span>
        </div>
      )}
      {showStatus && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2 text-[12px]">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true"
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: DOT[tone] }} />
            <span role="status"
                  className={`text-[var(--color-ink-2)] ${nameLive ? 'font-semibold' : 'font-medium'}`}>
              {/* eero.online is active only once eero is actually publishing.
                  With it picked but not yet connected, an earlier version
                  claimed the name was live while the Connect button beside it
                  said otherwise. FreeDNS never names its record unless told,
                  so there it can be just "Active." A published name the
                  look-up disagrees with says nothing here: the line under
                  this one says what is wrong. */}
              {publishing ? <>{t('ddns.publishing_now')}<Dots /></>
                : eeroLive ? t('ddns.is_active', { name: eeroDdns?.subdomain ?? '' })
                : nameLive ? (cfg?.name ? t('ddns.is_active', { name: cfg.name })
                                        : t('ddns.active'))
                : published ? null
                : selected === EERO
                ? (!eeroDdns?.enabled
                    ? tOr('ddns.state.unconfigured', '')
                    : t('ddns.state.eero_on'))
                : tOr(`ddns.state.${st?.result ?? 'unconfigured'}`,
                      st?.result ?? '')}
            </span>
          </span>
          {third && !publishing && st?.detail && (
            <span className="text-[var(--color-ink-3)]">{detailText(st, prov)}</span>
          )}
          {third && !publishing && st?.last_published && st.last_success ? (
            <span className="text-[var(--color-ink-3)]">
              {t('ddns.last_published', {
                when: when(new Date(st.last_success * 1000).toISOString()) })}
            </span>
          ) : null}
        </div>
      )}

      {/* Whether the name actually resolves here, which is not what the line
          above says. A provider can accept every update and reply that all is
          well while the name has stopped resolving — a No-IP hostname
          suspended for want of a confirmation click does exactly that. So this
          is reported separately rather than folded into the update's verdict,
          because they can disagree and the disagreement is the useful part.

          Only the cases worth a reader's attention appear. A lookup this
          machine could not complete says nothing: that is our failure, not the
          provider's, and printing it would blame the wrong thing. */}
      {showStatus && third && cfg?.name && !publishing && !nameLive && (
        <ResolveLine st={st} name={cfg.name} />
      )}
    </div>
  )
}
