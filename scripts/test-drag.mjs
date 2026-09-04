/**
 * Can the window still be moved?
 *
 * ⚠️ 0.6.234 SHIPPED A WINDOW THAT COULD NOT BE DRAGGED. titleBarStyle
 * 'hiddenInset' deletes the title bar and hands its space to the page, and HTML
 * is not draggable unless it says -webkit-app-region: drag. The app said it
 * exactly once, on the floating HUD; the main window said it nowhere. The
 * change was "verified" with a screenshot — which shows you a title bar and
 * tells you nothing about whether it behaves like one. Tony: "how the fuck
 * could you ship a redesign of the top bar with no dragging."
 *
 * This asserts the COMPUTED value on the REAL rendered DOM, not the source, and
 * it checks both halves. The second half is the one that bites: a drag region
 * swallows clicks, so a button inside one that is not exempted does not merely
 * fail to drag — it stops working altogether. Adding a control to any of these
 * bars without a no-drag rule breaks it, and this is what says so.
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'

const PORT = 5877
let pass = 0, fail = 0
const results = []
const ok = (name, cond) => { cond ? pass++ : (fail++, results.push(`  FAIL ${name}`)) }

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_PORT: String(PORT), NODE_ENV: 'production' },
  stdio: 'ignore'
})
const die = async code => { server.kill(); process.exit(code) }
process.on('exit', () => server.kill())

const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(base)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForSelector('.app', { timeout: 15000 }).catch(() => {})

const region = sel => page.evaluate(s => {
  const el = document.querySelector(s)
  return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : null
}, sel)

// ── the handles: every strip that touches the window's top edge ──────────────
// .topbar appears only with a session open, .main-drag only without one, so at
// least one of the two must always be present and draggable.
const main = await Promise.all(['.topbar', '.main-drag'].map(region))
ok('the main pane offers a drag handle (.topbar or .main-drag)', main.includes('drag'))
ok('the sidebar brand is a drag handle', await region('.brand') === 'drag')

// ── the exemptions: nothing clickable may sit inside a drag region ───────────
const swallowed = await page.evaluate(() => {
  const bars = ['.topbar', '.brand', '.right-tabs', '.main-drag']
  const bad = []
  for (const bar of bars) {
    const root = document.querySelector(bar)
    if (!root || getComputedStyle(root).getPropertyValue('-webkit-app-region') !== 'drag') continue
    for (const el of root.querySelectorAll('button, a, input, select, textarea, [role="button"], [data-tip]')) {
      if (getComputedStyle(el).getPropertyValue('-webkit-app-region') !== 'no-drag') {
        bad.push(`${bar} > ${el.tagName.toLowerCase()}.${el.className || '(no class)'}`)
      }
    }
  }
  return bad
})
ok(`no control is swallowed by a drag region${swallowed.length ? ' — ' + swallowed.join(', ') : ''}`, swallowed.length === 0)

// ── and the HUD, which has no title bar of any kind ──────────────────────────
// ⚠️ A FRESH PAGE, not page.goto with a different hash — same-document hash
// navigation does not re-run the SPA's route pick, so the first attempt at this
// was still looking at the main window and reported a false failure.
const hud = await browser.newPage({ viewport: { width: 320, height: 420 } })
await hud.goto(`${base}/#hud`, { waitUntil: 'networkidle' })
await hud.waitForSelector('.hud-head', { timeout: 10000 }).catch(() => {})
const hudRegion = await hud.evaluate(() => {
  const el = document.querySelector('.hud-head')
  return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : null
})
ok('the HUD header is still a drag handle', hudRegion === 'drag')

await browser.close()
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  the window can still be moved`)
await die(fail ? 1 : 0)
