#!/usr/bin/env node
// Boot the built app and assert the window actually renders.
//
// ⚠️ A BUILD THAT COMPILES CAN STILL BE A WHITE SCREEN. Twice in one day a
// renderer change shipped past `vite build` and blanked the entire app at
// runtime: `<Icon name='folder'/>` (Icon is a map, not a component) and
// `api.getServer()` (a named export, not a member of the default object).
// Neither is a syntax error, so nothing caught them but Tony.
import { spawn, execSync } from 'child_process'
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const app = process.argv[2] || 'release/mac-arm64/Radiant.app'
const bin = path.join(app, 'Contents/MacOS/Radiant')
const port = 9310 + (process.pid % 50)
const home = mkdtempSync(path.join(tmpdir(), 'radiant-smoke-'))

const child = spawn(bin, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, HOME: home }, stdio: 'ignore', detached: true
})
const cleanup = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} ; try { child.kill('SIGKILL') } catch {} }
const fail = m => { console.error(`\n✗ smoke test failed: ${m}`); cleanup(); process.exit(1) }

const deadline = Date.now() + 60000
let browser = null
while (!browser && Date.now() < deadline) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { await new Promise(r => setTimeout(r, 1000)) }
}
if (!browser) fail('the app never opened a debuggable window')

const ctx = browser.contexts()[0]
let page = null
while (!page && Date.now() < deadline) {
  page = ctx.pages().find(p => p.url().startsWith('http'))
  if (!page) await new Promise(r => setTimeout(r, 1000))
}
if (!page) fail('no window loaded a page')

const errors = []
page.on('pageerror', e => errors.push(e.message))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

try {
  await page.waitForSelector('.sidebar', { timeout: 40000 })
} catch {
  fail(`the main window rendered nothing${errors.length ? ` — first error: ${errors[0].slice(0, 200)}` : ''}`)
}
await page.waitForTimeout(2500)

const fatal = errors.filter(e => /is not a function|is not defined|Cannot read|undefined is not/.test(e))
if (fatal.length) fail(`renderer threw: ${fatal[0].slice(0, 200)}`)

console.log('✓ smoke test: the app opens and the window renders')
cleanup()
process.exit(0)
