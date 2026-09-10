#!/usr/bin/env node
/**
 * The screenshots in the README, made by running the app.
 *
 * ⚠️ THE OLD ONES WERE TAKEN BY HAND AND WENT STALE. Two images, captured once
 * in September, showing a build several versions old and a task board that was
 * completely EMPTY — five labelled columns and nothing in them. A reviewer on
 * YouTube said so: a board with no cards does not show what a board is for, it
 * shows an app nobody uses. There was no way to retake them short of doing the
 * whole thing by hand again, so nobody did.
 *
 * This is that, as a command. `npm run screenshots`.
 *
 * ⚠️ IT NEVER TOUCHES YOUR DATA. The server runs against a throwaway directory
 * seeded below — the fixtures are invented, and the point of inventing them is
 * that a screenshot has to show the thing working, not the thing empty.
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'screenshots')
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

// ── fixtures ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'radiant-shots-'))
const w = (sub, id, o) => { mkdirSync(join(dir, sub), { recursive: true }); writeFileSync(join(dir, sub, id + '.json'), JSON.stringify(o, null, 2)) }
const ago = m => new Date(Date.now() - m * 60000).toISOString()
const N = (id, title, o = {}) => ({
  id, title, kind: 'agent', prompt: '', dependsOn: [], model: 'grok-4.6', provider: 'xai',
  agentId: null, fields: [], reduceOp: 'concat', useTools: true, ...o
})


;[['p-radiant', 'Radiant'], ['p-site', 'Website']].forEach(([id, name], i) =>
  w('projects', id, { id, name, cwd: `/Users/you/Projects/${name.toLowerCase()}`, createdAt: ago(9000 - i * 100) }))

// ⚠️ EVERY COLUMN GETS A CARD. An empty column reads as a broken feature, and
// "Needs you" empty is the one that matters most — it is the column that
// explains why the board exists at all.
const TASKS = [
  ['queued', 'Add a --json flag to the CLI so CI can parse the output', 'Every consumer is grepping stdout today.'],
  ['queued', 'Cache the model catalogue between launches', 'Cold start hits Hugging Face every time.'],
  ['working', 'Port the settings pane to the new form primitives', 'Half the fields still use the old inputs.'],
  ['working', 'Trace why the graph runner leaks one worker per run', ''],
  ['blocked', 'Sign the notarized build with the new Developer ID', 'Waiting on the certificate from Apple.'],
  ['review', 'Rewrite the retry logic to back off per provider', 'Ready for a read — the tests cover the 429 path.'],
  ['done', 'Move session writes to write-then-rename', 'Shipped in 0.8.3.'],
  ['done', 'Detect a second copy of Radiant on a shared folder', 'Shipped in 0.8.4.']
]
TASKS.forEach(([state, title, detail], i) => w('tasks', 't' + i, {
  id: 't' + i, title, detail, state, createdAt: ago(600 - i * 40), updatedAt: ago(300 - i * 20),
  model: ['claude-opus-5', 'grok-4.6', 'gpt-5.6'][i % 3], provider: ['anthropic', 'xai', 'openai'][i % 3]
}))

w('loops', 'l1', {
  id: 'l1', title: 'Keep the docs in step with the code', state: 'idle',
  createdAt: ago(900), updatedAt: ago(120),
  goal: 'Every exported function in server/ has a comment that matches what it does.',
  steps: [
    { id: 's1', title: 'Find functions whose comment and body disagree', check: 'npm run lint:docs', checkKind: 'command', attempts: 3 },
    { id: 's2', title: 'Rewrite the ones that are wrong', check: 'The comment describes behaviour a reader could observe.', checkKind: 'agent', attempts: 2 },
    { id: 's3', title: 'Re-run the gate', check: 'npm test', checkKind: 'command', attempts: 2 }
  ]
})

w('graphs', 'g1', {
  id: 'g1', title: 'Audit every route for a missing auth check', state: 'idle',
  createdAt: ago(800), updatedAt: ago(90),
  // ⚠️ `dependsOn`, NOT `deps` — and every field blankNode() defines. A fixture
  // that is the wrong shape does not fail the capture, it captures the failure.
  nodes: [
    N('n1', 'Read every route file', { prompt: 'List each HTTP handler and the file it lives in.' }),
    N('n2', 'List the unauthenticated ones', { prompt: 'Which handlers never call the auth middleware?' }),
    N('n3', 'Check each against the middleware', { prompt: 'For each handler, say whether the middleware actually covers it.' }),
    N('n4', 'Merge and de-duplicate', { kind: 'reduce', reduceOp: 'dedupe', dependsOn: ['n1', 'n2', 'n3'] }),
    N('n5', 'Try to disprove each finding', { kind: 'verify', model: 'claude-opus-5', dependsOn: ['n4'] }),
    N('n6', 'Write the report', { prompt: 'Write it up, worst first.', model: 'claude-opus-5', dependsOn: ['n5'] })
  ]
})

const m = (role, text) => role === 'user' ? { role, text } : { role, parts: [{ type: 'text', text }] }
;[
  ['Trace the leaked worker in the graph runner', 'p-radiant', 'anthropic', 'claude-opus-5', 12,
    'Every graph run leaves one worker behind. Find out why.',
    'Found it. `pool()` resolves when the last task settles, but the worker created for a refused approval is never released — the refusal path returns before the `finally`. One line.'],
  ['Why is the build 40 MB bigger?', 'p-radiant', 'xai', 'grok-4.6', 34,
    'The dmg went from 124 to 164 MB between 0.7.9 and 0.8.0. What went in?',
    'The skills folder. It ships 274 entries as extraResources now; it was 31 before.'],
  ['Rewrite the download page copy', 'p-site', 'openai', 'gpt-5.6', 120,
    'The hero paragraph is three sentences of nothing. Make it say what the thing does.',
    'Rewritten. It leads with "runs models on your own machine" instead of "reimagines your workflow".']
].forEach(([title, projectId, provider, model, mins, u, a], i) => w('sessions', 's' + i, {
  id: 's' + i, title, projectId, provider, model, cwd: '/Users/you/Projects/radiant', useTools: true,
  messages: [m('user', u), m('assistant', a)], createdAt: ago(mins + 60), updatedAt: ago(mins)
}))

// ── run it ──────────────────────────────────────────────────────────────────
const PORT = await freePort()
const server = spawn('node', ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, RADIANT_PORT: String(PORT), RADIANT_DIR: dir, NODE_ENV: 'production' }, stdio: 'ignore'
})
const done = code => { server.kill(); try { rmSync(dir, { recursive: true, force: true }) } catch {} ; process.exit(code) }
process.on('exit', () => server.kill())

const base = `http://127.0.0.1:${PORT}`
let up = false
for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(base)).ok } catch {} ; if (!up) await new Promise(r => setTimeout(r, 250)) }
if (!up) { console.error('the server never came up'); done(1) }

const browser = await chromium.launch({ channel: 'chrome', headless: true })
// ⚠️ 2x, BECAUSE THESE ARE READ ON RETINA SCREENS. A 1x capture scaled to 900px
// wide in the README is visibly soft, which is what "looks a bit cheap" means.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
await page.addInitScript(() => { window.radiantNative = window.radiantNative || { toggleHud: () => {}, pickFolder: async () => null, openExternal: () => {} } })
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForSelector('.sidebar', { timeout: 20000 })

mkdirSync(OUT, { recursive: true })
const tab = async name => {
  await page.evaluate(n => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === n); if (b) b.click() }, name)
  await page.waitForTimeout(1400)
}
const shot = async (file, note) => {
  await page.screenshot({ path: join(OUT, file) })
  console.log(`  ${file.padEnd(16)} ${note}`)
}

console.log('capturing:')
// Chat, with a real conversation open
await page.evaluate(() => { const r = document.querySelector('.sess-row, .session-row, [class*="sess"]'); if (r) r.click() })
await page.waitForTimeout(1600)
await shot('chat.png', 'a conversation, the composer and the model picker')

await tab('Task');  await shot('tasks.png', 'the board with cards in all five columns')

// ⚠️ THE LIST VIEW SHOWS A ROW, NOT THE FEATURE. Loop and Graph both open on a
// list, and a screenshot of "Audit every route · Not run yet · 6 steps" tells a
// reader nothing about what a loop or a graph IS. Open the editor, where the
// steps and the dependencies are actually visible — same reason the board needed
// cards in it.
const openEditor = async () => {
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Edit'); if (b) b.click() })
  await page.waitForTimeout(1800)
}
await tab('Loop');  await openEditor(); await shot('loop.png', 'a loop: steps, and the check each has to pass')
await tab('Graph'); await openEditor(); await shot('graph.png', 'a graph: fan-out, a merge, and a skeptic')

// ⚠️ SETTINGS IS A MODAL, SO WHATEVER IS BEHIND IT IS IN THE SHOT. Captured
// straight after the graph editor it framed a half-filled form through the
// backdrop, which reads as clutter rather than as depth. Go back to Chat first.
await tab('Chat')
await page.waitForTimeout(800)
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Settings/.test(x.textContent)); if (b) b.click() })
await page.waitForTimeout(1200)
await page.evaluate(() => { const b = [...document.querySelectorAll('button,a')].find(x => x.textContent.trim() === 'Models'); if (b) b.click() })
await page.waitForTimeout(1800)
await shot('models.png', 'the model list in Settings')

await browser.close()
console.log(`\nwrote ${OUT}`)
done(0)
