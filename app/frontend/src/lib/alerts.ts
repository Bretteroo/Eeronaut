/* A tiny in-app alert bus. Anything in the app can raise an alert; the
   AlertHost mounted once at the root renders them as dismissible toasts. This
   is what "web interface notifications" surface through, and app-originated
   events (a failed write, a node dropping) can use it too. */

export interface Alert {
  id: string
  title: string
  body?: string
  tone?: 'info' | 'good' | 'warn' | 'bad'
  /** A link at the end of the body, to where the alert is about. */
  link?: { label: string; to: string }
}

const EVENT = 'eeronaut:alert'
let seq = 0

export function pushAlert(a: Omit<Alert, 'id'>): void {
  const detail: Alert = { id: `a${Date.now()}_${seq++}`, tone: 'info', ...a }
  window.dispatchEvent(new CustomEvent<Alert>(EVENT, { detail }))
}

export function onAlert(cb: (a: Alert) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<Alert>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
