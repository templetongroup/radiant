// The Chrome pane may only claim what the server can know.
//
// ⚠️ IT SAID "NOT INSTALLED YET" TO SOMEONE WHO HAD JUST INSTALLED IT. Radiant
// never learns whether the extension is installed; it learns whether a socket is
// open. This drives chrome-ext.js with a fake socket and checks that the status
// it reports distinguishes never-seen / seen-earlier / connected, carries the
// version the extension answered with, and that the pane's wording never uses
// the word "installed" for the disconnected states.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { attachExtension, extensionStatus } from '../server/chrome-ext.js'

let pass = 0, fail = 0
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('  FAIL', what) } }

class FakeWs extends EventEmitter {
  constructor () { super(); this.readyState = 1; this.sent = [] }
  send (raw) {
    const m = JSON.parse(raw); this.sent.push(m)
    // answer like sw.js does
    setTimeout(() => this.emit('message', Buffer.from(JSON.stringify({ id: m.id, ok: true, result: { ok: true, version: '0.6.231' } }))), 5)
  }
  close () { this.readyState = 3; this.emit('close') }
}

const s0 = extensionStatus()
ok(s0.connected === false && s0.lastSeenAt === null && s0.version === null, 'before anything connects: nothing claimed')

const ws = new FakeWs()
attachExtension(ws)
await new Promise(r => setTimeout(r, 40))
const s1 = extensionStatus()
ok(s1.connected === true, 'connected while the socket is open')
ok(s1.version === '0.6.231', `version comes from the ping reply (got ${s1.version})`)
ok(ws.sent.length >= 1 && ws.sent[0].op === 'ping', 'the server pings on attach')

ws.close()
const s2 = extensionStatus()
ok(s2.connected === false, 'not connected once the socket closes')
ok(typeof s2.lastSeenAt === 'string' && s2.version === '0.6.231', 'remembers when it was last here and which version')

// the pane: three states, and the disconnected ones never say "installed"
const src = fs.readFileSync(new URL('../src/components/Settings.jsx', import.meta.url), 'utf8')
const block = src.slice(src.indexOf('function BrowserBridgeBlock'), src.indexOf('/**\n * The pairing link'))
const rendered = block.replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // strip comments; only what a person sees
ok(!/Not installed/.test(rendered), 'the pane never says "Not installed"')
ok(/Not connected/.test(block), 'the pane says "Not connected"')
ok(/was connected at/.test(block), 'the pane says when it was last connected')
ok(/nothing has connected since Radiant started/.test(block), 'the pane says when nothing ever has')
ok(/!on && !seen && \(/.test(block), 'the store button is not offered to someone whose extension was connected earlier')

console.log(`\n${pass}/${pass + fail} passed  ·  the Chrome pane claims only what the server knows`)
process.exit(fail ? 1 : 0)
