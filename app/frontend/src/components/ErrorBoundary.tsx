import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'

interface Props { children: ReactNode; onReset?: () => void }
interface State { error: Error | null }

/**
 * Keeps one bad response from taking the whole interface down.
 *
 * This is not decoration: the app renders data from an undocumented API whose
 * shapes vary by endpoint, firmware, and entitlement. A field that is an object
 * on one network and null on another should cost you a panel, not the page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Left in deliberately: without it the only record of a render failure is
    // a blank page, which is the hardest kind of bug to report.
    console.error('Interface error:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="w-full max-w-md">
          <div className="card p-5">
            <h1 className="text-[15px] font-semibold">{t('error_boundary.something_page_broke')}</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-ink-2)]">
              {t('error_boundary.rest_interface_unaffected_usually_means')}
            </p>
            <pre className="mt-3 max-h-40 overflow-auto rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2 text-[11px] text-[var(--color-ink-2)]">
              {error.message || String(error)}
            </pre>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => { this.setState({ error: null }); this.props.onReset?.() }}
                className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-[13px] font-medium text-white"
              >
                {t('error_boundary.try_again')}
              </button>
              <a href="/" data-part="link-button"
                 className="rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] font-medium text-[var(--color-ink-2)]">
                {t('error_boundary.back_to_dashboard')}
              </a>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
