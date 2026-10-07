import { useState } from 'react'
import { api, ApiError, type AuthState } from '../lib/api'
import { SubmitButton } from '../components/primitives'
import { t } from '../i18n'

export function Login({ onDone, auth }: { onDone: () => void; auth?: AuthState | null }) {
  /* Where a sign-in stands on the server, not only in this tab. A reload, or
     a second tab, while the code is on its way used to land on the email form
     again, and sending from there issued a new code that made the one
     already arriving useless. */
  const [stage, setStage] = useState<'login' | 'code'>(
    auth?.awaiting_code ? 'code' : 'login')
  const [login, setLogin] = useState(auth?.login ?? '')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(false)
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (stage === 'login') {
        await api.post<AuthState>('/api/auth/login', { login, remember })
        setStage('code')
      } else {
        await api.post<AuthState>('/api/auth/verify', { code })
        onDone()
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.something_went_wrong'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        {/* The wordmark carries the name, so there is no text beside it.
            `alt` is where the name lives now: an image of a word is not a
            word to anything that cannot see it. */}
        <div className="mb-6 flex justify-center">
          {/* Intrinsic size, so the box is reserved before the image
              arrives and the form below it does not jump. The transparent
              margin was trimmed off the export, which is where 178 comes
              from — the source was 2079x756 with padding. */}
          <img src="/wordmark-512.png" alt="Eeronaut"
               srcSet="/wordmark-512.png 1x, /wordmark-1024.png 2x"
               width={512} height={178}
               className="h-auto w-full max-w-[19rem]" />
        </div>

        <form onSubmit={submit} className="card p-5">
          {stage === 'login' ? (
            <>
              <label htmlFor="login" className="micro-label">
                {t('login.email_mobile_number')}
              </label>
              <input
                id="login"
                type="text"
                autoComplete="username"
                inputMode="email"
                required
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                placeholder={t('login.you_example_com')}
              />
              <p className="mt-2 text-[12px] leading-snug text-[var(--color-ink-3)]">
                {t('login.eero_will_send_verification_code')}
              </p>
              <label className="mt-3 flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="size-4 accent-[var(--color-accent)]"
                />
                {t('login.stay_signed_in')}
              </label>
              {remember && (
                <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-ink-3)]">
                  {t('login.session_encrypted_rest_anyone_access')}
                </p>
              )}
            </>
          ) : (
            <>
              <label htmlFor="code" className="micro-label">{t('login.verification_code')}</label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="mt-1.5 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-center text-[18px] tracking-[0.4em] tabular-nums"
                placeholder="000000"
              />
              {/* Silent success is indistinguishable from silent failure, and
                  a code that never arrives is exactly when someone presses
                  this. Say what happened either way. */}
              <button
                type="button"
                disabled={resending}
                onClick={async () => {
                  setResending(true); setResent('')
                  try {
                    await api.post('/api/auth/resend')
                    setResent(t('login.new_code_on_its_way'))
                  } catch (e) {
                    setResent(e instanceof ApiError
                      ? t('login.could_not_resend_reason', { reason: e.message })
                      : t('login.could_not_resend_code'))
                  } finally { setResending(false) }
                }}
                className="mt-2 text-[12px] text-[var(--color-accent-ink)] underline-offset-2 hover:underline disabled:opacity-50"
              >
                {resending ? t('login.sending') : t('login.send_another_code')}
              </button>
              {resent && (
                <p role="status" className="mt-1 text-[12px] text-[var(--color-ink-2)]">
                  {resent}
                </p>
              )}
              {/* Back to the first step, for a typo in the address or the
                  wrong account: a reload now lands here rather than there. */}
              <button type="button"
                      onClick={() => { setStage('login'); setCode(''); setResent(''); setError('') }}
                      className="mt-2 block text-[12px] text-[var(--color-accent-ink)] underline-offset-2 hover:underline">
                {t('login.use_different_login')}
              </button>
            </>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded border border-[var(--color-bad)] bg-[var(--color-accent-wash)] px-3 py-2 text-[13px] text-[var(--color-bad)]">
              {error}
            </p>
          )}

          <SubmitButton disabled={busy} full className="mt-4 py-2 text-[14px]">
            {busy ? t('login.working') : stage === 'login' ? t('login.continue') : t('login.sign')}
          </SubmitButton>
        </form>
      </div>
    </div>
  )
}
