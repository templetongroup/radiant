/**
 * Presses the Dictate button. That is the whole point.
 *
 * ⚠️ THE ENDPOINT WORKING IS NOT THE FEATURE WORKING. Dictation shipped in 0.6.223
 * having been proved end to end with curl against the packaged, notarized app —
 * {"type":"ready","onDevice":true} and real transcribed audio — and having had its
 * button confirmed to render. Nobody clicked it. The click built its URL with
 * getServer(), which returns an OBJECT, so the browser requested
 * "[object Object]/api/dictate", never reached the server, and EventSource reported
 * the only thing it can report. Tony, first press: "as soon as i clicked the mic, it
 * got 'Lost the connection to dictation.' are you even testing these features?"
 *
 * So this test drives a real browser against a real server and presses the button.
 * It does NOT assert that the microphone opens: the helper is killed by TCC unless
 * its parent is Radiant.app, and this server is spawned by node. What it asserts is
 * everything between the click and the helper — that the request is well-formed,
 * reaches /api/dictate, and comes back as an event stream. That is exactly the span
 * that broke, and it needs no microphone, no permission prompt and nobody talking.
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chromium } from 'playwright-core'

const PORT = 5937
const dir = mkdtempSync(join(tmpdir(), 'radiant-dictate-'))
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }

const server = spawn(process.execPath, ['server/index.js'],
  { env: { ...process.env, RADIANT_PORT: String(PORT), RADIANT_DIR: dir }, stdio: 'ignore' })

const base = `http://127.0.0.1:${PORT}`
const up = async () => { try { return (await fetch(base + '/api/system')).ok } catch { return false } }
for (let i = 0; i < 40 && !(await up()); i++) await new Promise(r => setTimeout(r, 250))

let browser
try {
  await fetch(base + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Dictate click' })
  })

  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })

  const requested = []
  page.on('request', r => { if (r.url().includes('dictate')) requested.push(r.url()) })
  const responses = []
  page.on('response', r => { if (r.url().includes('/api/dictate')) responses.push({ url: r.url(), status: r.status() }) })

  await page.goto(base + '/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const row = page.locator('.session-item').first()
  if (await row.count()) { await row.click(); await page.waitForTimeout(1200) }

  const btn = page.locator('button.is-dictate')
  ok(await btn.count() > 0, 'the Dictate button is on screen')

  await btn.first().click()
  await page.waitForTimeout(2500)

  // The bug: a URL built from an object never resolves to the server at all.
  ok(requested.length > 0, 'clicking it actually issues a request')
  ok(requested.every(u => !u.includes('object%20Object') && !u.includes('[object')),
     'the request URL is a real URL, not a stringified object — got ' + JSON.stringify(requested))
  ok(requested.some(u => u.endsWith('/api/dictate')), 'it requests /api/dictate — got ' + JSON.stringify(requested))
  ok(responses.some(r => r.status === 200),
     'the server answers 200 (an event stream), not 404 — got ' + JSON.stringify(responses))

  const note = page.locator('.composer-note')
  const noteText = await note.count() ? (await note.first().innerText()).trim() : ''
  ok(!/Lost the connection/i.test(noteText),
     'no "Lost the connection" — that message means the request never landed. Composer said: ' + JSON.stringify(noteText))
} finally {
  if (browser) await browser.close().catch(() => {})
  server.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
}

console.log(`  ${pass}/${pass + fail} passed  ·  the button was pressed, not just rendered`)
process.exit(fail ? 1 : 0)
