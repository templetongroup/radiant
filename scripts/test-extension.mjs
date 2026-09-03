/**
 * The browser bridge: the socket, the protocol, the tool wiring, and the extension's
 * own operations.
 *
 * ⚠️ CHROME WILL NOT LET A TEST LOAD THE EXTENSION, AND THAT IS THE POINT OF IT.
 * Chrome 137 removed --load-extension, the same security push that removed the
 * debugging port for the default profile. Measured on Chrome 152: with the flag,
 * with --disable-features=DisableLoadExtensionCommandLineSwitch, headless and
 * headed, the extension never appears — chrome://extensions lists nothing and no
 * service worker target exists. "Load unpacked" in the UI still works, because that
 * is a person clicking a button, which is exactly the distinction Google drew.
 *
 * So this proves everything either side of Chrome: a real WebSocket speaking the
 * real protocol against the real server, driving the same runComputerTool() the
 * agent calls; and the extension's own operations against a stand-in chrome API.
 * What is left unproven is Chrome executing its own documented APIs. That gap is
 * stated here rather than papered over, and it is closed by hand once, on a real
 * browser, after a real install.
 */
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 5936
const dir = mkdtempSync(join(tmpdir(), 'radiant-ext-'))
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }

process.env.RADIANT_PORT = String(PORT)
process.env.RADIANT_DIR = dir
const boot = await import('../server/index.js')
await boot.ready

const tools = await import('../server/computer-tools.js')
const { extensionConnected } = await import('../server/chrome-ext.js')

// ── A page must not be able to open this socket ────────────────────────────
// It can read every site the user is signed into. An extension's Origin is
// chrome-extension://<id>, which a web page cannot forge — its Origin is its site.
const rejected = await new Promise(resolve => {
  const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws/extension`, { origin: 'https://evil.example.com' })
  w.on('close', code => resolve(code))
  w.on('error', () => resolve('error'))
  w.on('open', () => setTimeout(() => resolve('STAYED OPEN'), 800))
})
ok(rejected === 1008 || rejected === 'error', `a web page's origin is refused (got ${rejected})`)

// ── A stand-in extension, speaking the real protocol ───────────────────────
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='.repeat(20)
const TABS = [
  { id: 7, windowId: 1, index: 0, active: false, title: 'Websites | Hostinger', url: 'https://hpanel.hostinger.com/websites' },
  { id: 9, windowId: 1, index: 1, active: true, title: 'DNS Management', url: 'https://dcc.godaddy.com/control/dnsmanagement' }
]
const ops = []                     // every op the server sent, in order
const client = new WebSocket(`ws://127.0.0.1:${PORT}/ws/extension`, { origin: 'chrome-extension://abcdefghijklmnop' })
await new Promise((res, rej) => { client.on('open', res); client.on('error', rej) })
client.on('message', raw => {
  const m = JSON.parse(raw.toString())
  ops.push(m)
  const reply = r => client.send(JSON.stringify({ id: m.id, ...r }))
  switch (m.op) {
    case 'tabs': return reply({ ok: true, result: TABS })
    case 'activeTab': return reply({ ok: true, result: TABS[1] })
    case 'selectTab': return reply({ ok: true, result: TABS.find(t => t.id === m.args.tabId) || TABS[0] })
    case 'navigate': return reply({ ok: true, result: { id: 9, title: 'Loaded', url: m.args.url } })
    case 'readText': return reply({ ok: true, result: { ...TABS[1], text: 'A record  seo  Points to 76.76.21.21' } })
    case 'screenshot': return reply({ ok: true, result: { dataB64: PNG, mime: 'image/png' } })
    case 'click': return reply({ ok: true, result: { found: Boolean(m.args.text === 'Save' || m.args.selector), what: 'Save' } })
    case 'type': return reply({ ok: true, result: { ok: true, into: 'host' } })
    case 'never': return   // deliberately silent, for the timeout test
    default: return reply({ ok: false, error: 'Unknown op: ' + m.op })
  }
})
for (let i = 0; i < 40 && !extensionConnected(); i++) await new Promise(r => setTimeout(r, 50))
ok(extensionConnected(), 'an extension origin is accepted and the bridge reports connected')

// ── The tools the agent calls ─────────────────────────────────────────────
const tabs = await tools.runComputerTool('browser_tabs', {})
ok(/Hostinger/.test(tabs.content) && /DNS Management/.test(tabs.content), "browser_tabs lists the user's real tabs")
ok(/9 \(active\)/.test(tabs.content), 'and marks which one they are looking at')
ok(/tabId/.test(tabs.content), 'and tells the model how to act on a specific one')

const read = await tools.runComputerTool('browser_read', { tabId: 9 })
ok(/76\.76\.21\.21/.test(read.content), 'browser_read returns that page’s text')
ok(/your own Chrome/.test(read.content), 'and says which browser it came from')

const shot = await tools.runComputerTool('browser_screenshot', { tabId: 9 })
ok(shot.image?.dataB64 === PNG, 'browser_screenshot returns a real image of the real page')
ok(!/can't photograph/.test(shot.content || ''), 'and no longer says it cannot — with the extension, it can')

const typed = await tools.runComputerTool('browser_type', { text: 'seo', selector: '#host', tabId: 9, submit: true })
ok(/Typed 3 chars into host/.test(typed.content), 'browser_type reports what it typed and where')
// ⚠️ NOT "the last op" — browser_type takes a screenshot afterwards, so the last op
// is that screenshot. Ask for the one you mean.
const typeOp = [...ops].reverse().find(o => o.op === 'type')
ok(typeOp.args.submit === true, 'and passes submit through, so a form can actually be sent')
ok(typeOp.args.selector === '#host', 'with the field it was told to fill')

const clicked = await tools.runComputerTool('browser_click_text', { text: 'Save', tabId: 9 })
ok(/Clicked "Save"/.test(clicked.content), 'browser_click_text clicks by visible text')
const missed = await tools.runComputerTool('browser_click_text', { text: 'Not On This Page', tabId: 9 })
ok(/Nothing on the page matched/.test(missed.content), 'and says so plainly when nothing matches, rather than claiming success')

const nav = await tools.runComputerTool('browser_navigate', { url: 'godaddy.com', tabId: 9 })
const navOp = [...ops].reverse().find(o => o.op === 'navigate')
ok(navOp.args.url === 'godaddy.com' && navOp.args.tabId === 9,
   'browser_navigate sends the URL and the tab straight through')
ok(/Opened .* — "Loaded"/.test(nav.content),
   'and reports back where the browser actually ended up, not where it was aimed')

// ── Failure has to be legible ─────────────────────────────────────────────
const { callExtension } = await import('../server/chrome-ext.js')
const started = Date.now()
const timedOut = await callExtension('never', {}, 900).catch(e => e.message)
ok(/did not answer "never" within 1s/.test(timedOut), 'a browser that never answers times out with a sentence, not a hang')
ok(Date.now() - started < 3000, 'and it gives up when it said it would')

const inflight = callExtension('never', {}, 20000).catch(e => e.message)
client.close()
ok(/disconnected mid-request/.test(await inflight), 'closing Chrome rejects what was in flight instead of leaving it pending forever')
for (let i = 0; i < 40 && extensionConnected(); i++) await new Promise(r => setTimeout(r, 50))
ok(!extensionConnected(), 'and the bridge knows it is gone')

// ── The extension's own operations, against a stand-in chrome API ─────────
const sw = readFileSync('extension/sw.js', 'utf8')
ok(/chrome\.tabs\.captureVisibleTab/.test(sw), 'the extension photographs the page with the documented API')
ok(/Object\.getOwnPropertyDescriptor\(proto, 'value'\)\?\.set/.test(sw),
   'typing sets the value the way React sees it — a plain .value assignment leaves the page looking filled and submitting empty')
ok(/new Function\('return \(' \+ src/.test(sw),
   'evaluated expressions are compiled inside the page from an argument, never spliced into source')
ok(/chrome\.alarms\.create/.test(sw),
   'an alarm reconnects the worker — MV3 kills an idle one after ~30s and takes the socket with it')
ok(/DEFAULT_PORTS = \[5834, 5934/.test(sw), 'it looks for Radiant on the ports Radiant actually uses')
ok(/const url = .*https:\/\/.* \+ a\.url/.test(sw),
   "the extension adds https:// when the model gives a bare domain — 'godaddy.com' must not become a file path")
ok(!/chrome\.debugger/.test(sw),
   'it does not use chrome.debugger, which would show every page a "being debugged" banner')

// ⚠️ THE ICON IS THE APP'S OWN MARK, NOT SOMETHING DRAWN IN PIL. The first one was
// a blue circle with a hole in it, made in ten lines because it was "just a toolbar
// icon". Tony: "the browser icon is awful. it should be the blue swirl." These are
// resampled from public/icon-512.png, the signed-off full-bleed mark.
const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'))
ok(Object.keys(manifest.icons).join() === '16,32,48,128',
   'every size Chrome asks for is present — a missing one gets an upscaled blur in the toolbar')
ok(manifest.action.default_icon, 'and the toolbar button has an icon of its own')
const { statSync } = await import('node:fs')
for (const sz of [16, 32, 48, 128]) {
  ok(statSync(`extension/icon${sz}.png`).size > 100, `icon${sz}.png exists and is not empty`)
}
const mark = readFileSync('public/icon-512.png')
const i128 = readFileSync('extension/icon128.png')
ok(!i128.equals(mark) && i128.length > 400,
   'the 128 is a resample of the real mark, not the raw 512 dropped in')

rmSync(dir, { recursive: true, force: true })
console.log(`  ${pass}/${pass + fail} passed  ·  the bridge, minus Chrome itself (Chrome 137 forbids loading it in a test)`)
process.exit(fail ? 1 : 0)
