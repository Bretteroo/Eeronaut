// Theme tabs: swap the screenshot and its description.
const THEMES = {
  harbor: {
    name: 'Harbor', pages: 'Dashboard in front, with Clients, Airtime, Security, and Topology behind it',
    desc: 'The original Eeronaut theme: a dark rail, white cards, and a clear blue for anything you can press.',
  },
  eerish: {
    name: 'Eerish', pages: 'Dashboard in front, with Clients, Airtime, Security, and Topology behind it',
    desc: 'White space, large type, photography, and eero\u2019s blue, with the navigation across the top.',
  },
  'liquid-glass': {
    name: 'Liquid Glass', pages: 'Dashboard in front, with Clients, Airtime, Security, and Topology behind it',
    desc: 'Frosted, translucent panels over a soft gradient, with the navigation floating along the bottom.',
  },
  sailing: {
    name: 'Sailing', pages: 'Dashboard in front, with Clients, Airtime, Security, and Topology behind it',
    desc: 'White decks and brass over photographs of deep water.',
  },
  winksys: {
    name: 'Winksys', pages: 'router status in front, with Local Network, Wireless, Firewall, and Basic Setup behind it',
    desc: 'A tribute to the router pages of the early 2000s, indigo bars and all. Included for laughs, not recommended.',
  },
}

const tabs = [...document.querySelectorAll('.tabs [role="tab"]')]
const modes = [...document.querySelectorAll('.mode [data-mode]')]
const img = document.getElementById('theme-img')
const desc = document.getElementById('theme-desc')
let theme = 'harbor'
let mode = 'light'

const frame = img.parentElement
const still = window.matchMedia('(prefers-reduced-motion: reduce)')
let showing = 0

function show() {
  const base = `assets/shots/spread-${theme}-${mode}`
  const srcset = `${base}-1600.webp 1600w, ${base}.webp 3200w`
  const alt = `The ${THEMES[theme].name} theme, ${mode}: the ${THEMES[theme].pages}`
  const turn = ++showing

  desc.classList.add('fading')
  setTimeout(() => {
    if (turn !== showing) return
    desc.textContent = THEMES[theme].desc
    desc.classList.remove('fading')
  }, still.matches ? 0 : 250)

  // The new picture is laid over whatever is showing and faded in, on top of
  // any fade still running, so a quick run of clicks blends from each picture
  // to the next. Once the newest is fully shown it becomes the picture, and
  // the layers go.
  const next = document.createElement('img')
  next.className = 'incoming'
  next.sizes = img.sizes
  next.srcset = srcset
  next.src = `${base}.webp`
  next.alt = ''
  frame.appendChild(next)
  const settle = () => {
    if (turn !== showing) return
    img.srcset = srcset
    img.src = `${base}.webp`
    img.alt = alt
    for (const layer of frame.querySelectorAll('.incoming')) layer.remove()
  }
  next.decode().catch(() => {}).finally(() => {
    if (turn !== showing) return
    if (still.matches) return settle()
    // A picture already in the cache is ready at once. Its see-through start
    // has to be drawn before it is told to show, or there is nothing to fade
    // from and it simply appears.
    next.getBoundingClientRect()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      next.classList.add('shown')
      next.addEventListener('transitionend', settle, { once: true })
      setTimeout(settle, 700)
    }))
  })
}

function select(tab, focus) {
  theme = tab.dataset.theme
  for (const t of tabs) {
    const on = t === tab
    t.setAttribute('aria-selected', String(on))
    t.tabIndex = on ? 0 : -1
  }
  if (focus) tab.focus()
  show()
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => select(tab, false))
  tab.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    select(tabs[(i + step + tabs.length) % tabs.length], true)
  })
})

for (const b of modes) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode
    for (const m of modes) m.setAttribute('aria-pressed', String(m === b))
    show()
  })
}

// Copy buttons.
for (const btn of document.querySelectorAll('.copy')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy)
      btn.textContent = 'Copied'
    } catch {
      btn.textContent = 'Press Ctrl+C'
    }
    setTimeout(() => { btn.textContent = 'Copy' }, 1600)
  })
}


// On a phone the network map is wider than the screen and scrolls sideways.
// Start it in the middle, where the gateway is, rather than at its left edge.
const map = document.querySelector('.frame.map')
if (map) {
  const center = () => { map.scrollLeft = (map.scrollWidth - map.clientWidth) / 2 }
  const img = map.querySelector('img')
  if (img.complete) center(); else img.addEventListener('load', center, { once: true })
}

// The hero buttons wrap onto two lines on a narrow screen. Whether they have
// is only known from where they landed, so it is measured, and the class
// centers them when they did.
const cta = document.querySelector('.cta')
if (cta) {
  const check = () => {
    const [a, b] = cta.children
    cta.classList.remove('stacked')
    if (b && b.offsetTop > a.offsetTop) cta.classList.add('stacked')
  }
  new ResizeObserver(check).observe(cta)
  check()
}

// The FAQ answers slide open and shut. <details> on its own snaps, so the
// click is taken over and the answer's height animated instead.
for (const d of document.querySelectorAll('.faq details')) {
  const summary = d.querySelector('summary')
  const body = d.querySelector('.faq-body')
  let running = null
  let wanted = d.open
  summary.addEventListener('click', (e) => {
    if (still.matches) return
    e.preventDefault()
    wanted = !wanted
    // From wherever it is now, so a second click mid-slide turns it around.
    const now = body.getBoundingClientRect().height
    if (running) running.cancel()
    d.open = true
    const to = wanted ? body.scrollHeight : 0
    running = body.animate(
      [{ height: `${now}px`, opacity: wanted ? 0.4 : 1 }, { height: `${to}px`, opacity: wanted ? 1 : 0 }],
      { duration: 280, easing: 'ease' })
    running.onfinish = () => {
      if (!wanted) d.open = false
      running = null
    }
  })
}

// Reveal things as they scroll into view, once each. Cards in a row are
// staggered by their place in it.
const revealing = [...document.querySelectorAll('[data-reveal], [data-stagger]')]
for (const list of document.querySelectorAll('[data-stagger]')) {
  ;[...list.children].forEach((el, i) => el.style.setProperty('--delay', `${(i % 4) * 0.08}s`))
}
if ('IntersectionObserver' in window && !still.matches) {
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('shown')
      seen.unobserve(e.target)
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 })
  for (const el of revealing) seen.observe(el)
} else {
  for (const el of revealing) el.classList.add('shown')
}

// The hero screenshot keeps its tilt but drifts upward a little as the hero
// scrolls away, which gives the top of the page some depth.
const heroFrame = document.querySelector('.hero-shot .frame')
if (heroFrame && !still.matches && window.matchMedia('(min-width: 901px)').matches) {
  let ticking = false
  addEventListener('scroll', () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(() => {
      const y = Math.min(scrollY, 900)
      heroFrame.style.transform = `perspective(1600px) rotateY(${-6 + y * 0.004}deg) rotateX(2deg) translateY(${y * -0.08}px)`
      ticking = false
    })
  }, { passive: true })
}
