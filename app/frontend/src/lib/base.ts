/* Eeronaut's page below someone else's path: Home Assistant's ingress.

   Home Assistant shows an app's page through its own proxy, at
   /api/hassio_ingress/<token>/ on Home Assistant's address. Everything
   Eeronaut names with a leading slash (/api/network, /logo-64.png, a theme's
   stylesheet, the live status stream) would then go to Home Assistant's own
   /api and fail. The backend names the prefix in an `eeronaut-base` meta tag
   when a request came that way (core/ingress.py), and this module puts it in
   front of every such URL as the browser is handed it: fetches, the event
   stream, src and href however they are set, and url() in an inline style.
   So no page, and no theme, has to know.

   Without the tag, which is every copy not inside Home Assistant, nothing
   here is installed. */

const meta = typeof document === 'undefined'
  ? null : document.querySelector('meta[name="eeronaut-base"]')

/** The path Eeronaut's page is served under, without a trailing slash, or ''. */
export const BASE = (meta?.getAttribute('content') || '').replace(/\/+$/, '')

/** `url` with the base in front, when it names a path on Eeronaut's root. */
export function withBase<T>(url: T): T {
  if (!BASE || typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return url
  if (url === BASE || url.startsWith(`${BASE}/`) || url.startsWith(`${BASE}?`)) return url
  return (BASE + url) as T
}

// url("/...") or url(/...) inside a CSS value.
const CSS_URL = /url\(\s*(['"]?)(\/(?!\/)[^'")]*)\1\s*\)/g
const withBaseCss = <T,>(value: T): T => (typeof value === 'string' && value.includes('url(')
  ? value.replace(CSS_URL, (_, quote, url) => `url(${quote}${withBase(url)}${quote})`) as T
  : value)

// Replace a property's setter on the first prototype in the chain that has it.
function wrapSetter(proto: object, name: string, wrap: (v: unknown) => unknown) {
  let owner: object | null = proto
  while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) owner = Object.getPrototypeOf(owner)
  const desc = owner && Object.getOwnPropertyDescriptor(owner, name)
  if (!owner || !desc?.set || !desc.configurable) return
  const set = desc.set
  Object.defineProperty(owner, name, {
    ...desc,
    set(value: unknown) { set.call(this, wrap(value)) },
  })
}

const URL_ATTRS = new Set(['src', 'srcset', 'href', 'poster', 'action', 'formaction', 'data'])

// A srcset is a list of URLs, each followed by its size.
const withBaseSrcset = (value: unknown) => (typeof value === 'string'
  ? value.split(',').map((part) => part.replace(/^(\s*)(\S+)/, (_, space, url) => space + withBase(url))).join(',')
  : value)

function install() {
  const fetchRaw = window.fetch.bind(window)
  window.fetch = (input, init) => fetchRaw(typeof input === 'string' ? withBase(input) : input, init)

  const Source = window.EventSource
  window.EventSource = class extends Source {
    constructor(url: string | URL, init?: EventSourceInit) { super(withBase(url), init) }
  }

  const open = XMLHttpRequest.prototype.open as (...args: unknown[]) => void
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    args[1] = withBase(args[1])
    return open.apply(this, args)
  } as typeof XMLHttpRequest.prototype.open

  const windowOpen = window.open
  window.open = function (this: Window, url?: string | URL, ...rest: [string?, string?]) {
    return windowOpen.call(this, withBase(url), ...rest)
  }

  const setAttribute = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name: string, value: string) {
    const key = String(name).toLowerCase()
    if (key === 'srcset') value = withBaseSrcset(value) as string
    else if (URL_ATTRS.has(key)) value = withBase(value)
    else if (key === 'style') value = withBaseCss(value)
    return setAttribute.call(this, name, value)
  }

  for (const [Type, names] of [
    [HTMLImageElement, ['src']],
    [HTMLMediaElement, ['src']],
    [HTMLVideoElement, ['poster']],
    [HTMLSourceElement, ['src']],
    [HTMLIFrameElement, ['src']],
    [HTMLAnchorElement, ['href']],
    [HTMLLinkElement, ['href']],
    [HTMLFormElement, ['action']],
  ] as const) {
    for (const name of names) wrapSetter(Type.prototype, name, withBase)
  }
  wrapSetter(HTMLImageElement.prototype, 'srcset', withBaseSrcset)
  wrapSetter(HTMLSourceElement.prototype, 'srcset', withBaseSrcset)

  // Inline styles: React sets ordinary properties by name and custom ones
  // (--x) through setProperty.
  const style = document.documentElement.style
  for (const name of ['background', 'backgroundImage', 'maskImage', 'webkitMaskImage',
    'listStyleImage', 'borderImage', 'borderImageSource', 'content', 'cursor']) {
    wrapSetter(style, name, withBaseCss)
  }
  let declaration: object | null = Object.getPrototypeOf(style)
  while (declaration && !Object.prototype.hasOwnProperty.call(declaration, 'setProperty')) {
    declaration = Object.getPrototypeOf(declaration)
  }
  if (declaration) {
    const target = declaration as CSSStyleDeclaration
    const setProperty = target.setProperty
    target.setProperty = function (name: string, value: string | null, priority?: string) {
      return setProperty.call(this, name, withBaseCss(value), priority)
    }
  }
  wrapSetter(style, 'cssText', withBaseCss)
}

if (BASE && typeof window !== 'undefined') install()
