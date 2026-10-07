import { useEffect, useState } from 'react'
import { api, freshReads, ApiError } from '../lib/api'
import { useClock } from '../lib/clock'
import { SubmitButton, type CardSay } from './primitives'
import { t } from '../i18n'

/**
 * Running a speed test, and when the last one ran.
 *
 * Drawn in the Internet connection card's header, at the right, where every
 * card keeps its own controls: when the latest reading was taken, then the
 * button that takes a new one. It sat in the card's narrow left column
 * before, the one control on the page that was not in a header, and had to
 * be squeezed to fit there.
 *
 * `latest` is the date of the newest test the card is showing, and `reload`
 * reads the tests again and answers with the newest date. The card keeps its
 * own readings; this only asks it to refresh them, says through `onRunning`
 * when they are about to change, and reports a failure in the card's notice.
 * No notice when it works: the new reading and the button coming back say
 * that.
 */
export function SpeedTestRun({ latest, reload, onRunning, say }: {
  latest: string | null
  reload: () => Promise<string | null>
  onRunning?: (running: boolean) => void
  say: CardSay
}) {
  const { whenShort } = useClock()
  const [running, setRunningState] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const setRunning = (v: boolean) => { setRunningState(v); onRunning?.(v) }

  // Seconds since the test started. eero reports nothing at all while one is
  // in flight, so this is the only true progress there is — a percentage would
  // be inventing a number.
  useEffect(() => {
    if (!running) { setElapsed(0); return }
    const id = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running])

  async function run() {
    setRunning(true); say.clear()
    const before = latest
    try {
      await api.post('/api/speedtests/run', {})
    } catch (e) {
      setRunning(false)
      say.fail(e instanceof ApiError ? e.message : t('dashboard.did_not_work'))
      return
    }
    // eero files the result when the test finishes, so the only way to know it
    // is done is that a newer one has appeared. Give up after a couple of
    // minutes rather than polling for ever; the result still lands on its own.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const now = await freshReads(() => reload())
      if (now && now !== before) { setRunning(false); return }
    }
    setRunning(false)
    say.fail(t('dashboard.test_taking_longer_than_expected'))
  }

  const note = running ? t('dashboard.running_seconds', { seconds: elapsed })
    : latest ? t('speed_test.last_run', { when: whenShort(latest) })
      : t('dashboard.never_run')
  return (
    <div data-part="speed-test-run" className="flex min-w-0 items-center justify-end gap-3">
      {/* Not on a phone: beside the card's title and the button there is no
          room for it, and it cut the title short. The button's hover text
          carries it there. */}
      <p className="hidden min-w-0 text-right text-[12px] font-normal tabular-nums
                    text-[var(--color-ink-3)] sm:block">
        {note}
      </p>
      <SubmitButton type="button" compact disabled={running} onClick={() => void run()}
                    title={note} className="shrink-0 whitespace-nowrap">
        {running ? t('dashboard.testing') : t('dashboard.run_test')}
      </SubmitButton>
    </div>
  )
}

/** While a test runs, at the top of the card: a bar that says "working"
 *  without pretending to know how far along it is, and why the readings
 *  below have dimmed. */
export function SpeedTestProgress() {
  return (
    <div className="mb-4">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-line)]"
           role="progressbar" aria-label={t('dashboard.speed_test_progress')}>
        <div className="bar-indeterminate h-full w-1/3 rounded-full"
             style={{ background: 'var(--color-accent)' }} />
      </div>
      <p className="mt-1.5 text-[12px] text-[var(--color-ink-3)]">
        {t('speed_test.measuring')}
      </p>
    </div>
  )
}
