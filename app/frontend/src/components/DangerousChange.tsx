import { useEffect, useId, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { SubmitButton } from './primitives'
import { t, tn, tx } from '../i18n'

interface Impact {
  wireless_clients: number
  wired_clients: number
  notable: string[]
  /** The guest network's own count, and whether it is even switched on. */
  guest?: { enabled: boolean; wireless_clients: number; notable: string[] }
}

/**
 * A change that disconnects people, gated behind a deliberate confirmation.
 *
 * The pattern is borrowed from destructive actions elsewhere: state the real
 * consequence with a real number, then require the user to type the network's
 * current name. Typing something specific cannot happen by accident, which a
 * second "are you sure" button can.
 */
export function DangerousChange({
  title, description, label, inputType = 'text', confirmWord, submitLabel,
  minLength, maxLength, affects = 'wifi', onSubmit, onDone,
}: {
  title: string
  /** Optional: the guest password form's said nothing the impact line below
   *  it does not, and two sentences making the same point read as padding. */
  description?: string
  label: string
  inputType?: 'text' | 'password'
  /** Which network the change drops. The guest password costs the guests and
   *  nobody else, and with the guest network off it costs nothing — this form
   *  used to quote the main network's client count whatever it was changing. */
  affects?: 'wifi' | 'guest'
  /** Typed verbatim to confirm — normally the current network name. */
  confirmWord: string
  submitLabel: string
  minLength?: number
  maxLength?: number
  onSubmit: (value: string) => Promise<unknown>
  onDone: () => void
}) {
  const [value, setValue] = useState('')
  const [typed, setTyped] = useState('')
  const [impact, setImpact] = useState<Impact | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Labels must be programmatically associated with their inputs, or assistive
  // technology announces an unlabelled field on the most consequential form in
  // the application.
  const valueId = useId()
  const confirmId = useId()

  useEffect(() => {
    api.get<Impact>('/api/network/wifi/impact').then(setImpact).catch(() => {})
  }, [])

  const confirmed = typed.trim() === confirmWord
  const valid = value.length >= (minLength ?? 1) &&
                (maxLength === undefined || value.length <= maxLength)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!confirmed || !valid) return
    setBusy(true); setError('')
    try { await onSubmit(value); onDone() }
    catch (err) { setError(err instanceof ApiError ? err.message : t('dangerous_change.did_not_work')) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit}
          className="rounded-md border border-[var(--color-warn)] bg-[var(--color-surface-2)] p-3">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {description && (
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
          {description}
        </p>
      )}

      {impact && affects === 'wifi' && (
        <p className="mt-2 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[12px] leading-relaxed">
          {tn('dangerous_change.clients_will_disconnect',
              impact.wireless_clients)}{' '}
          {impact.wired_clients > 0
            && tn('dangerous_change.wired_unaffected', impact.wired_clients)}
          {' '}{t('dangerous_change.this_interface_over_wifi')}
        </p>
      )}

      {/* Nothing at all with the guest network off: there is no cost to
          state, and a line saying so is one more thing to read on a form
          somebody is already part way through. */}
      {impact?.guest?.enabled && affects === 'guest' && (
        <p className="mt-2 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5 text-[12px] leading-relaxed">
          {tn('dangerous_change.guests_will_disconnect',
              impact.guest.wireless_clients)}
        </p>
      )}

      <label htmlFor={valueId} className="micro-label mt-3 block">{label}</label>
      <input
        id={valueId}
        type={inputType}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        minLength={minLength}
        maxLength={maxLength}
        autoComplete="off"
        className="mt-1.5 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-2 text-[13px]"
      />

      <label htmlFor={confirmId} className="micro-label mt-3 block">
        {tx('dangerous_change.type_word_to_confirm', {
          word: <span className="font-mono normal-case">{confirmWord}</span>,
        })}
      </label>
      <input
        id={confirmId}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        className="mt-1.5 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-2 font-mono text-[13px]"
      />

      {error && (
        <p role="alert" className="mt-2 text-[12px] text-[var(--color-bad)]">{error}</p>
      )}

      <div className="mt-3 flex gap-2">
        <SubmitButton disabled={!confirmed || !valid || busy}>
          {busy ? t('dangerous_change.applying') : submitLabel}
        </SubmitButton>
        <button type="button" onClick={onDone}
          className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] font-medium text-[var(--color-ink-2)]">
          {t('dangerous_change.cancel')}
        </button>
      </div>
    </form>
  )
}
