import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import { SubmitButton } from '../components/primitives'
import { t } from '../i18n'

export interface AccessState {
  configured: boolean
  signed_in: boolean
  locked_for: number
  /** The theme in force, named here because this is the one thing the
   *  interface can ask before anyone has signed in, and this screen is
   *  themed too. */
  theme: string
}

/**
 * The gate in front of everything. Distinct from signing in to eero: this
 * proves the browser may talk to this server at all, which matters because the
 * API can reboot hardware and reveal the Wi-Fi password.
 */
export function AppAccess({ state, onDone }:
  { state: AccessState; onDone: () => void }) {
  const setup = !state.configured
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (setup && pw !== confirm) { setError(t('app_access.passwords_do_not_match')); return }
    setBusy(true); setError('')
    try {
      await api.post(setup ? '/api/app/setup' : '/api/app/login', { password: pw })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('app_access.something_went_wrong'))
    } finally { setBusy(false) }
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm">
        {/* The wordmark carries the name, so there is no text beside it. This
            is the first screen anybody sees — the interface password comes
            before the eero sign-in — so it gets the same mark as the one
            behind it rather than the old logo-and-label pair. `alt` is where
            the name lives now: an image of a word is not a word to anything
            that cannot see it. */}
        <div className="mb-6 flex justify-center">
          <img src="/wordmark-512.png" alt="Eeronaut"
               srcSet="/wordmark-512.png 1x, /wordmark-1024.png 2x"
               width={512} height={178}
               className="h-auto w-full max-w-[19rem]" />
        </div>

        <form onSubmit={submit} className="card p-5">
          <h1 className="text-[15px] font-semibold">
            {setup ? t('app_access.choose_password') : t('app_access.enter_your_password')}
          </h1>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-ink-3)]">
            {setup
              ? t('app_access.protects_interface_itself_anyone_who') : t('app_access.interface_password_not_your_eero')}
          </p>

          <label htmlFor="pw" className="micro-label mt-4 block">{t('app_access.password')}</label>
          <input
            id="pw" type="password" required autoFocus
            autoComplete={setup ? 'new-password' : 'current-password'}
            minLength={setup ? 8 : undefined}
            value={pw} onChange={(e) => setPw(e.target.value)}
            className="mt-1.5 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
          />

          {setup && (
            <>
              <label htmlFor="pw2" className="micro-label mt-3 block">{t('app_access.confirm_password')}</label>
              <input
                id="pw2" type="password" required autoComplete="new-password" minLength={8}
                value={confirm} onChange={(e) => setConfirm(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
              />
              <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
                {t('app_access.least_8_characters_stored_only')}
              </p>
            </>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded border border-[var(--color-bad)] px-3 py-2 text-[13px] text-[var(--color-bad)]">
              {error}
            </p>
          )}

          <SubmitButton disabled={busy} full className="mt-4">
            {busy ? t('app_access.working') : setup ? t('app_access.set_password') : t('app_access.sign')}
          </SubmitButton>

          {/* Only when there is a password to have lost. On first run the form
              above is setting one, and there is nothing to recover from. */}
          {!setup && <LostPassword />}
        </form>
      </div>
    </div>
  )
}

/**
 * What to do about a forgotten interface password.
 *
 * There is no reset link to click and no email to send one to: this password
 * is a scrypt hash in a file on the machine the server runs on, and nothing
 * about the eero account can unlock it. So the honest answer is the shell
 * commands that clear it, said here rather than left in a README nobody has
 * open at the moment they are locked out.
 *
 * Closed until asked for. It is a wall of shell for a case most people never
 * hit, and it sits under the button everybody else is pressing.
 */
function LostPassword() {
  const [open, setOpen] = useState(false)
  const id = 'lost-password'
  return (
    <div className="mt-3 text-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="text-[12px] text-[var(--color-ink-3)] underline-offset-2
                   hover:text-[var(--color-ink)] hover:underline"
      >
        {t('app_access.lost_password')}
      </button>

      {open && (
        <div id={id}
             className="mt-3 rounded-md border border-[var(--color-line)]
                        bg-[var(--color-surface-2)] p-3 text-left text-[12px]
                        leading-relaxed text-[var(--color-ink-2)]">
          <p>{t('app_access.lost_intro')}</p>

          <p className="micro-label mt-3">{t('app_access.lost_docker')}</p>
          <Steps>
            <Step n={1} say={t('app_access.lost_docker_1')}>
              {'cd /path/to/eeronaut\ndocker compose exec eeronaut rm /data/appauth.json'}
            </Step>
            <Step n={2} say={t('app_access.lost_docker_2')}>
              {'docker compose restart eeronaut'}
            </Step>
            <Step n={3} say={t('app_access.lost_reload')} />
          </Steps>

          <p className="micro-label mt-3">{t('app_access.lost_source')}</p>
          <Steps>
            {/* The README's install: a systemd service with its data in
                /var/lib/eeronaut, owned by the service's own user. These
                were a terminal's steps, for a server started by hand. */}
            <Step n={1} say={t('app_access.lost_source_1')}>
              {'sudo rm /var/lib/eeronaut/appauth.json'}
            </Step>
            <Step n={2} say={t('app_access.lost_source_2')}>
              {'sudo systemctl restart eeronaut'}
            </Step>
            <Step n={3} say={t('app_access.lost_reload')} />
          </Steps>

          <p className="micro-label mt-3">{t('app_access.lost_env')}</p>
          <p>{t('app_access.lost_env_body')}</p>

          <p className="mt-3">{t('app_access.lost_nothing_else')}</p>
        </div>
      )}
    </div>
  )
}

/** The steps, numbered, because this is a procedure and not a list of facts
 *  — somebody reading it is typing along. */
function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="mt-1 grid gap-2">{children}</ol>
}

/** One step: what it does, then what to type for it. */
function Step({ n, say, children }:
  { n: number; say: string; children?: string }) {
  return (
    <li className="grid gap-1">
      <span className="flex gap-2">
        <span className="tabular-nums text-[var(--color-ink-3)]">{n}.</span>
        <span className="min-w-0">{say}</span>
      </span>
      {children && <Shell>{children}</Shell>}
    </li>
  )
}

/** A command to type, in a box that can be copied out of. */
function Shell({ children }: { children: string }) {
  return (
    /* Wrapped rather than scrolled. The card is 384px wide and these are
       long enough to run off it; a command with its end out of sight is one
       somebody types wrong. Wrapping is visual only — what gets copied still
       has its newlines where they were written. */
    <pre className="mt-1 whitespace-pre-wrap break-words rounded
                    border border-[var(--color-line)] bg-[var(--color-surface)]
                    px-2 py-1.5 font-mono text-[11px]
                    text-[var(--color-ink)]">{children}</pre>
  )
}
