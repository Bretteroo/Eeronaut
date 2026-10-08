import { useEffect, useState } from 'react'
import { SubmitButton } from './primitives'
import { t, tn } from '../i18n'

/* One domain per line, edited as a block rather than added one at a time.

   The list is usually pasted in from somewhere else and changed in batches, so
   a single-line box with an Add button meant one round trip per domain and no
   way to see what was already there while typing. Apply diffs the box against
   the live list and sends only what actually changed.

   Shared by the network-wide lists on Security and the per-profile lists on a
   profile's filters page. Those started as two different controls — a bulk
   editor with a progress bar on one, a row-at-a-time add box on the other —
   because the profile lists lived in a narrow drawer where a ten-line textarea
   did not fit. The drawer is a full-width page now, so the reason is gone and
   the weaker of the two controls with it. */
export interface DomainScope { domain: string; profiles: string[] }

/* What eero will accept as a domain rule, and what to do with the rest.

   Pasted lists carry blank lines, a scheme and path on each entry, stray
   wildcards, and the occasional sentence. Sending those through produced one
   error per bad line and no rules at all, which is a poor trade for a list
   that was mostly fine. They are cleaned where cleaning is unambiguous and
   dropped where it is not — and the dropped ones are named, because silently
   discarding what someone typed is worse than refusing it. */
export function cleanDomain(line: string): string | null {
  let d = line.trim().toLowerCase()
  if (!d || d.startsWith('#')) return null
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')   // scheme
  d = d.split('/')[0].split('?')[0].split('#')[0]  // path, query, fragment
  d = d.split('@').pop() ?? ''                     // user@host, or an address
  d = d.replace(/:\d+$/, '')                       // port
  d = d.replace(/^\*\./, '')                       // a wildcard covers the
  d = d.replace(/\.$/, '')                          // base domain already
  if (!d) return null
  // An address is not a domain, and eero's list is DNS-level only.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.includes(':')) return null
  if (d.length > 253) return null
  const labels = d.split('.')
  const ok = labels.every((l) =>
    l.length >= 1 && l.length <= 63
    && /^[a-z0-9-]+$/.test(l)
    && !l.startsWith('-') && !l.endsWith('-'))
  return ok ? d : null
}

/** The list as typed, split into what will be sent and what was thrown out. */
export function readDomains(text: string): { clean: string[]; dropped: string[] } {
  const clean: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue          // blank lines are not a complaint
    const d = cleanDomain(line)
    if (!d) { dropped.push(line.trim()); continue }
    if (seen.has(d)) continue
    seen.add(d)
    clean.push(d)
  }
  return { clean, dropped }
}

export function DomainList({
  title, kind, items, empty, busy, locked = false, lockedWhy = '',
  partial = [], onApply,
}: {
  title: string
  kind: 'blocked' | 'allowed'
  items: string[]
  empty: string
  busy: boolean
  /** Set when this network is not entitled to the lists, which belong to eero
   *  Plus. Both the box and the button go inert; the API layer declines the
   *  write as well, since a gate only in the interface is not a gate. */
  locked?: boolean
  lockedWhy?: string
  /** Domains that apply to some profiles rather than the whole network. The
   *  plain-text box cannot express that, so it is stated underneath. Empty for
   *  a per-profile list, where every entry is scoped to that profile already. */
  partial?: DomainScope[]
  onApply: (kind: 'blocked' | 'allowed', add: string[], remove: string[],
            onProgress: (done: number, total: number) => void) => Promise<boolean>
}) {
  const asText = items.join('\n')
  const [draft, setDraft] = useState(asText)
  const [edited, setEdited] = useState(false)
  /* What the box should read once the server has caught up with an Update
     that just succeeded. Set on success and cleared when the list from the
     server next changes. Without it the box snapped back to the list from
     before the write for the beat between "saved" and the page's re-read
     landing, so a domain just added vanished and then came back — reported
     from use as a hiccup on every add and remove. */
  const [awaiting, setAwaiting] = useState<string | null>(null)
  // Follow the server while the box is untouched, so another change to the
  // list shows up here; stop following the moment there is unsaved typing,
  // because overwriting that would throw away the user's work.
  useEffect(() => { if (!edited) setDraft(asText) }, [asText, edited])
  // The re-read after a successful Update has landed: adopt the server's
  // list, whatever eero made of the domains, and go back to following it.
  useEffect(() => {
    if (awaiting === null) return
    setDraft(asText); setEdited(false); setAwaiting(null)
  }, [asText])   // eslint-disable-line react-hooks/exhaustive-deps

  const { clean: wanted, dropped } = readDomains(draft)
  const add = wanted.filter((d) => !items.includes(d))
  const remove = items.filter((d) => !wanted.includes(d))
  const changed = add.length > 0 || remove.length > 0
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Grow with the content and stop at ten lines, after which it scrolls.
  const rows = Math.min(10, Math.max(4, draft.split('\n').length))

  return (
    <div>
      <span className="micro-label">{title} ({items.length})</span>
      <form
        className="mt-2 grid gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (locked || !changed) return
          if (remove.length && !window.confirm(
            tn(kind === 'blocked' ? 'domains.confirm_remove_blocked'
                                  : 'domains.confirm_remove_allowed', remove.length)
            + `\n\n${remove.join('\n')}`)) return
          setProgress({ done: 0, total: add.length + remove.length })
          try {
            const ok = await onApply(kind, add, remove,
                                     (done, total) => setProgress({ done, total }))
            if (ok) {
              /* Keep showing what was just applied until the server's list
                 changes; if it already reads that way, there is nothing to
                 wait for. */
              const expected = wanted.join('\n')
              if (expected === asText) setEdited(false)
              else { setDraft(expected); setAwaiting(expected) }
            }
          } finally { setProgress(null) }
        }}
      >
        <textarea
          value={draft}
          rows={rows}
          disabled={locked}
          title={locked ? lockedWhy : undefined}
          onChange={(e) => { setDraft(e.target.value); setEdited(true) }}
          placeholder={`example.com\nshop.example.org`}
          aria-label={t(kind === 'blocked' ? 'security.domains_blocked_one_per_line'
                                           : 'security.domains_allowed_one_per_line')}
          spellCheck={false}
          className={`max-h-[15rem] min-w-0 resize-y overflow-y-auto rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-[12px] leading-relaxed ${
            locked ? 'cursor-not-allowed' : ''}`}
        />
        <div className="flex items-center gap-3">
          <SubmitButton disabled={busy || locked || !changed}>
            {t('client_detail.update')}
          </SubmitButton>
          {/* Nothing while locked. The card says why once, at the top, in
              the same words and the same weight every other locked card
              uses; repeating it here in tertiary ink inside an already
              dimmed block made the faintest text on the page the one
              carrying the explanation. */}
          <span className="text-[12px] tabular-nums text-[var(--color-ink-3)]">
            {locked ? null
              : progress
              ? t('security.applying_of', { done: progress.done, total: progress.total })
              : !changed ? (items.length ? t('security.saved') : empty)
                : [add.length && t('security.n_to_add', { count: add.length }),
                   remove.length && t('security.n_to_remove', { count: remove.length })]
                  .filter(Boolean).join(t('security.change_join'))}
          </span>
        </div>

        {/* eero takes one domain per call, so a pasted list is a run of them.
            Without this the box simply sat there for several seconds after
            Update and looked like it had not registered the click. */}
        {progress && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
               role="progressbar" aria-label={t('security.applying_domain_changes')}
               aria-valuenow={progress.done} aria-valuemin={0}
               aria-valuemax={progress.total}>
            <div className="h-full rounded-full transition-[width] duration-200"
                 style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                          background: 'var(--color-accent)' }} />
          </div>
        )}

        {dropped.length > 0 && (
          <p className="text-[12px] leading-relaxed text-[var(--color-warn-ink,var(--color-warn))]">
            {tn('domains.dropped', dropped.length)}{' '}
            <span className="font-mono">{dropped.slice(0, 6).join(', ')}</span>
            {dropped.length > 6
              && t('domains.and_n_more', { count: dropped.length - 6 })}.
          </p>
        )}
      </form>
      {partial.length > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          {t('domains.not_network_wide')}{' '}
          {partial.map((d) => tn('domains.scope_profiles', d.profiles.length,
                                 { domain: d.domain })).join(', ')}.{' '}
          {t('domains.removing_here_removes_everywhere')}
        </p>
      )}
    </div>
  )
}
