import path from 'path'

// Browser control via Playwright driving the system Chrome (channel: 'chrome',
// so there's no bundled-chromium download). One shared browser + page per
// server; the agent sees the page through screenshots.

let pw = null
let browser = null
let context = null
let page = null

// Rolling capture of the site's XHR/fetch (JSON) traffic — the raw material for
// deriving a reusable HTTP client from a website's hidden API.
let captured = []
const SENSITIVE = /^(cookie|authorization|x-csrf-token|x-xsrf-token|x-api-key|set-cookie)$/i
function attachCapture (p) {
  p.on('requestfinished', async req => {
    try {
      const rt = req.resourceType()
      if (rt !== 'xhr' && rt !== 'fetch') return
      const resp = await req.response()
      const ct = (resp && resp.headers()['content-type']) || ''
      if (!/json|graphql|text\/plain/i.test(ct)) return // API-ish only
      let sample = null
      try { sample = (await resp.text()).slice(0, 1500) } catch {}
      captured.push({
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        postData: (req.postData() || '').slice(0, 1500) || null,
        status: resp ? resp.status() : null,
        contentType: ct,
        responseSample: sample,
        at: Date.now()
      })
      if (captured.length > 120) captured.shift()
    } catch {}
  })
}

// ⚠️ ATTACH TO THE USER'S OWN CHROME FIRST, AND ONLY LAUNCH IF WE CANNOT.
// pw.launch starts a BRAND NEW Chrome on a throwaway profile: no extensions, no
// tabs, signed in to nothing. An agent asked to "look at my open page" saw an
// empty stranger's browser, and — having no better explanation — blamed macOS
// permissions. Tony: "im in a chat and the agent is saying it cant control my
// active chrome because of settings but Radiant has access in privacy and disk
// access." It was never permissions; Screen Recording and Accessibility govern the
// DESKTOP tools, not this.
//
// Chrome exposes itself for control only when started with --remote-debugging-port,
// so this connects if that is on and falls back to launching if it is not. The
// fallback is the old behaviour exactly, so nothing gets worse for anyone who has
// not turned it on.
export const CDP_PORT = Number(process.env.RADIANT_CHROME_PORT || 9222)

// What the UI shows, and what the agent is told when a page is not what it expected.
export let mode = 'none'   // 'attached' → the user's Chrome | 'launched' → our own

async function tryAttach () {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(700) })
    if (!r.ok) return null
  } catch { return null }              // nothing listening: not an error, just off
  try {
    const b = await pw.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
    const ctx = b.contexts()[0]
    if (!ctx) { await b.close(); return null }
    // ⚠️ USE THE TAB THAT IS ALREADY THERE. Opening a new one lands on about:blank
    // and loses the thing the user is pointing at — which is the whole reason for
    // attaching rather than launching.
    const existing = ctx.pages().filter(p => !p.url().startsWith('devtools://'))
    return { b, ctx, p: existing[existing.length - 1] || await ctx.newPage() }
  } catch { return null }
}

async function ensure () {
  if (page && !page.isClosed()) return page
  if (!pw) pw = (await import('playwright-core')).chromium
  if (!browser) {
    const attached = await tryAttach()
    if (attached) {
      browser = attached.b; context = attached.ctx; page = attached.p; mode = 'attached'
      attachCapture(page)
      return page
    }
    browser = await pw.launch({ channel: 'chrome', headless: false, args: ['--no-first-run', '--no-default-browser-check'] })
    mode = 'launched'
  }
  context = context || await browser.newContext({ viewport: { width: 1280, height: 800 } })
  page = await context.newPage()
  attachCapture(page)
  return page
}

/** Is the user's own Chrome reachable right now? For the UI, without connecting. */
export async function chromeReachable () {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(700) })
    if (!r.ok) return null
    const v = await r.json()
    return { port: CDP_PORT, browser: v.Browser || 'Chrome' }
  } catch { return null }
}

export const browserAvailable = async () => {
  try {
    if (!pw) pw = (await import('playwright-core')).chromium
    return true
  } catch { return false }
}

async function shot (p) {
  const buf = await p.screenshot({ type: 'png' })
  return { dataB64: buf.toString('base64'), mime: 'image/png' }
}

export const web = {
  async navigate (url) {
    const p = await ensure()
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await p.waitForTimeout(600)
    return { url: p.url(), title: await p.title() }
  },
  async screenshot () {
    const p = await ensure()
    return shot(p)
  },
  async click (x, y) {
    const p = await ensure()
    await p.mouse.click(x, y)
    await p.waitForTimeout(400)
    return { ok: true }
  },
  async type (text) {
    const p = await ensure()
    await p.keyboard.type(text, { delay: 15 })
    return { ok: true }
  },
  async key (spec) {
    const p = await ensure()
    // map "cmd+c" -> "Meta+c", "return" -> "Enter"
    const norm = spec.split('+').map(s => {
      const k = s.trim().toLowerCase()
      return ({ cmd: 'Meta', command: 'Meta', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[k]) || (k.length === 1 ? k : s)
    }).join('+')
    await p.keyboard.press(norm)
    await p.waitForTimeout(300)
    return { ok: true }
  },
  async scroll (dy) {
    const p = await ensure()
    await p.mouse.wheel(0, -dy)
    await p.waitForTimeout(300)
    return { ok: true }
  },
  async readText () {
    const p = await ensure()
    const text = await p.evaluate(() => document.body.innerText.slice(0, 12000))
    return { url: p.url(), title: await p.title(), text }
  },
  // The XHR/fetch (JSON) calls the current page made — a website's hidden API.
  async getNetwork (filter) {
    await ensure()
    const f = (filter || '').toLowerCase()
    const hits = captured.filter(c => !f || c.url.toLowerCase().includes(f))
    const seen = new Set(); const out = []
    for (let i = hits.length - 1; i >= 0; i--) { // newest first, dedupe by method+path
      const key = hits[i].method + ' ' + hits[i].url.split('?')[0]
      if (seen.has(key)) continue; seen.add(key); out.push(hits[i])
    }
    return out.slice(0, 25)
  },
  clearNetwork () { captured = []; return { ok: true } },
  // Design Mode: the user hovers/clicks an element in the real Chrome window; we
  // capture its markup, curated computed styles, and a cropped screenshot.
  async pickElement () {
    const p = await ensure()
    await p.bringToFront().catch(() => {})
    const pick = await p.evaluate(() => new Promise(resolve => {
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4c8dff;background:rgba(76,141,255,.15);border-radius:2px'
      const label = document.createElement('div')
      label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#4c8dff;color:#fff;font:12px/1.4 system-ui;padding:2px 6px;border-radius:4px;white-space:nowrap'
      const tip = document.createElement('div')
      tip.textContent = 'Design Mode — click an element to capture it (Esc to cancel)'
      tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:50%;bottom:16px;transform:translateX(-50%);background:#111;color:#fff;font:13px/1.4 system-ui;padding:6px 12px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.4)'
      document.body.append(box, label, tip)
      let hovered = null
      const move = e => {
        const el = document.elementFromPoint(e.clientX, e.clientY)
        if (!el || el === box || el === label || el === tip) return
        hovered = el
        const r = el.getBoundingClientRect()
        Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
        const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).join('.') : ''
        label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls
        Object.assign(label.style, { left: r.left + 'px', top: Math.max(0, r.top - 22) + 'px' })
      }
      const cleanup = () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); box.remove(); label.remove(); tip.remove() }
      const click = e => {
        e.preventDefault(); e.stopPropagation()
        const el = hovered; if (!el) return
        cleanup()
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
        const props = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'opacity']
        const css = {}; for (const k of props) { const v = cs.getPropertyValue(k); if (v && v !== 'none' && v !== 'normal' && v !== 'auto') css[k] = v }
        resolve({ outerHTML: el.outerHTML.slice(0, 8000), css, rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }, tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 300) })
      }
      const key = e => { if (e.key === 'Escape') { cleanup(); resolve(null) } }
      document.addEventListener('mousemove', move, true)
      document.addEventListener('click', click, true)
      document.addEventListener('keydown', key, true)
    }))
    if (!pick) return null
    let screenshot = null
    try {
      const vw = 1280, vh = 800
      const r = pick.rect
      const clip = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, vw - Math.max(0, r.x)), height: Math.min(r.height, vh - Math.max(0, r.y)) }
      const buf = (clip.width > 4 && clip.height > 4) ? await p.screenshot({ clip }) : await p.screenshot()
      screenshot = { dataB64: buf.toString('base64'), mime: 'image/png' }
    } catch {}
    return { ...pick, screenshot, url: p.url() }
  },
  async close () {
    try { await browser?.close() } catch {}
    browser = context = page = null
    return { ok: true }
  }
}
