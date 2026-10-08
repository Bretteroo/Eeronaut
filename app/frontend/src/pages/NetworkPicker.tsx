import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { t } from '../i18n'

/* The account can own several networks and the app scopes to one at a time, so
   after sign-in, before anything network-specific loads, one gets chosen. It
   chooses itself when the answer is plain: the account has one network, or
   exactly one has its eeros on this machine's segment (found by mDNS). Only
   otherwise is the user asked. */

interface Net {
  url: string
  name?: string
  status?: string
  premium_status?: string
  gateway_ip?: string
  on_segment?: boolean | null
}

export function NetworkPicker({ onDone }: { onDone: () => void }) {
  const [nets, setNets] = useState<Net[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')

  // `fallback` is the list to ask with if a choice made on the user's behalf
  // fails, so a refused pick still leaves them something to click.
  async function choose(url: string, fallback?: Net[]) {
    setBusy(url); setErr('')
    try {
      await api.post('/api/networks/select', { url })
      onDone()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('network_picker.could_not_select_network'))
      setBusy('')
      if (fallback) setNets(fallback)
    }
  }

  useEffect(() => {
    api.get<Net[]>('/api/networks')
      .then((list) => {
        const rows = list ?? []
        const here = rows.filter((n) => n.on_segment === true)
        const plain = rows.length === 1 ? rows[0] : here.length === 1 ? here[0] : null
        if (plain) void choose(plain.url, rows)           // nothing to decide
        else setNets(rows)
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message : t('network_picker.could_not_load_networks')))
    /* Once, on mount. `choose` is listed nowhere because this asks the
       question once and answers it: when the choice is plain it picks and
       navigates away, and re-running it would re-pick. The list stays unset
       meanwhile, so the page reads "loading" rather than flashing a question
       it is about to answer.
*/
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid min-h-full place-items-center bg-[var(--color-canvas)] p-6">
      <div className="w-[min(460px,92vw)]">
        <div className="mb-5 flex items-center gap-2">
          <img src="/logo-64.png" alt="" width={32} height={32} className="size-8 shrink-0 object-contain" />
          {nets && <h1 className="text-[17px] font-semibold">{t('network_picker.choose_network')}</h1>}
        </div>

        {err && (
          <p role="alert" className="mb-3 text-[13px] text-[var(--color-bad-ink,var(--color-bad))]">{err}</p>
        )}

        {!nets ? (
          <p className="text-[13px] text-[var(--color-ink-3)]">{t('network_picker.loading_your_networks')}</p>
        ) : nets.length === 0 ? (
          <p className="text-[13px] text-[var(--color-ink-3)]">
            {t('network_picker.account_has_no_networks')}
          </p>
        ) : (
          <ul className="grid gap-2">
            {nets.map((n) => (
              <li key={n.url}>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void choose(n.url)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-left hover:border-[var(--color-accent)] disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium">
                      {n.name || t('network_picker.unnamed_network')}
                    </span>
                    <span className="block text-[12px] text-[var(--color-ink-3)]">
                      {[n.status, n.premium_status === 'active' ? 'eero Plus' : null]
                        .filter(Boolean).join(' · ') || n.gateway_ip}
                    </span>
                  </span>
                  <span className="text-[12px] text-[var(--color-ink-3)]">
                    {busy === n.url ? t('network_picker.opening') : t('network_picker.manage')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
