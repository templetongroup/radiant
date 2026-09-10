/**
 * Nothing added to the app may rearrange it.
 *
 * ⚠️ `.app` IS `display: flex` — A ROW OF SIDEBAR + MAIN. A full-width notice
 * added as a plain child does not sit above the app; it becomes a THIRD COLUMN.
 * That shipped in 0.8.4: the two-Macs warning took the left of the window, shoved
 * the sidebar across to the right, and its first line landed underneath the
 * traffic lights. The app looked broken, and the thing that broke it was a div
 * with no positioning.
 *
 * ⚠️ AND IT IS INVISIBLE TO EVERY OTHER GATE, because the banner only renders
 * when a second copy of Radiant is running against the same folder — a state no
 * test creates. So this one puts the element there itself and MEASURES, which is
 * the only way to catch a layout regression in something conditionally rendered.
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const freePort = () => new Promise(r => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) })
})
const PORT = await freePort()
let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

const dataDir = mkdtempSync(join(tmpdir(), 'radiant-layout-'))
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_PORT: String(PORT), RADIANT_DIR: dataDir, NODE_ENV: 'production' }, stdio: 'ignore'
})
process.on('exit', () => server.kill())
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 60; i++) { try { if ((await fetch(base)).ok) break } catch {} ; await new Promise(r => setTimeout(r, 250)) }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.addInitScript(() => {
  window.radiantNative = window.radiantNative || { toggleHud: () => {}, pickFolder: async () => null, openExternal: () => {} }
})
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForSelector('.sidebar', { timeout: 15000 })

const box = sel => page.evaluate(s => {
  const el = document.querySelector(s); if (!el) return null
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}, sel)

const before = await box('.sidebar')
ok('the sidebar is on the left to begin with', before && before.x < 20, JSON.stringify(before))

// Put the real banner in, exactly as App.jsx renders it.
await page.evaluate(() => {
  const d = document.createElement('div')
  d.className = 'share-warn'
  d.setAttribute('role', 'status')
  d.textContent = "Radiant is also open on Tony's Home MBA, using this same folder. Two copies writing at once can overwrite each other's work — quit one of them, or use Settings → Devices to work from the other over the network instead."
  document.querySelector('.app').prepend(d)
})
await page.waitForTimeout(120)

const after = await box('.sidebar')
const warn = await box('.share-warn')

// ⚠️ THE ASSERTION THAT WOULD HAVE CAUGHT 0.8.4.
ok('the sidebar does not move when the warning appears',
   after && before && after.x === before.x, `${before?.x} -> ${after?.x}`)
ok('and it keeps its width', after && before && after.w === before.w, `${before?.w} -> ${after?.w}`)
ok('the warning spans the window rather than taking a column',
   warn && warn.w >= 1280 - 2, JSON.stringify(warn))

// ⚠️ AND IT MUST STAY OFF THE TRAFFIC LIGHTS. The top 38px is the drag region;
// every element ever floated there has broken something.
ok('the warning is nowhere near the traffic lights', warn && warn.y > 100, `y=${warn?.y}`)
ok('it sits at the bottom of the window', warn && (warn.y + warn.h) >= 795, JSON.stringify(warn))

// It must not cover the thing you type into.
const composer = await box('.composer')
ok('the composer is not underneath it',
   !composer || composer.y + composer.h <= warn.y + 1, `composer ends ${composer && composer.y + composer.h}, warning starts ${warn?.y}`)

// And it must not swallow clicks the way the old top strip did.
const atWarn = await page.evaluate(() => {
  const w = document.querySelector('.share-warn').getBoundingClientRect()
  const el = document.elementFromPoint(w.x + w.width / 2, w.y + w.height / 2)
  return el ? el.className || el.tagName : null
})
ok('a click in the strip lands on the strip, not on something under it',
   String(atWarn).includes('share-warn'), String(atWarn))

await browser.close(); server.kill()
try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a notice does not rearrange the app`)
process.exit(fail ? 1 : 0)
