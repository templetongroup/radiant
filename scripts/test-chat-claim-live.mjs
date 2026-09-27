// Two sends to one chat at the same moment: one runs, the other is told no.
//
// ⚠️ The "a turn is already running" check and the line that recorded the turn
// were separated by the skill and MCP choices, which wait on the network. A
// second send in that gap — phone and Mac on one chat, or a retried request —
// passed the check too; two turns ran on two copies of the chat and whichever
// saved last erased the other's whole turn. This slows the skill choice down
// on purpose and sends twice at once.
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)) }) })

const prov = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm1' }] })) }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n'); res.end()
  })
})
// the decisions endpoint answers slowly — that delay is the window
const jev = http.createServer((req, res) => { setTimeout(() => { res.writeHead(500); res.end() }, 800) })
const [pp, pj, pr] = [await freePort(), await freePort(), await freePort()]
await new Promise(r => prov.listen(pp, r))
await new Promise(r => jev.listen(pj, r))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-claim-'))
fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
fs.mkdirSync(path.join(dir, 'skills'), { recursive: true })
fs.writeFileSync(path.join(dir, 'skills', 's1.json'), JSON.stringify({ id: 's1', name: 'A skill', description: 'something', body: 'do it well', enabled: true }))
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-ws-'))
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ providers: [{ id: 'fakeco', name: 'FakeCo', type: 'openai', baseUrl: `http://127.0.0.1:${pp}/v1`, auth: 'key', removable: true }], keys: { fakeco: 'k', openrouter: 'or-test' }, oauth: {}, accounts: {}, activeAccount: {}, settings: { autoCompact: false, approvalMode: 'off', fastLane: false, routing: false } }))
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, RADIANT_PORT: String(pr), RADIANT_DIR: dir, OPENROUTER_API_KEY: '', RADIANT_DECISIONS_URL: `http://127.0.0.1:${pj}/decisions` }, stdio: ['ignore', 'pipe', 'pipe'] })
srv.stderr.on('data', d => { const t = String(d); if (/Error|error:|throw|at /.test(t)) process.stderr.write('  [server] ' + t) })
try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${pr}/api/config`)).ok } catch {} if (!up) await sleep(250) }
  ok(up, 'server up')
  const s = await (await fetch(`http://127.0.0.1:${pr}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'fakeco', model: 'm1', useTools: false, cwd: ws }) })).json()
  const send = text => fetch(`http://127.0.0.1:${pr}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, content: { text } }) }).then(async r => ({ status: r.status, body: await r.text() }))
  const [a, b] = await Promise.all([send('first'), send('second')])
  const statuses = [a.status, b.status].sort()
  ok(statuses[0] === 200 && statuses[1] === 409, `one send runs and the other is refused (got ${a.status}, ${b.status})`)
  const saved = await (await fetch(`http://127.0.0.1:${pr}/api/sessions/${s.id}`)).json()
  ok(saved.messages.filter(m => m.role === 'user').length === 1, `the chat holds one turn, not two racing copies (${saved.messages.filter(m => m.role === 'user').length} user messages)`)
  // and the claim is released: the next send runs
  const c = await send('third')
  ok(c.status === 200, `after the turn ends, the chat takes a new message (got ${c.status})`)
  // ---- one message, one reply: the same message named twice runs once ----
  const sendId = (text, messageId) => fetch(`http://127.0.0.1:${pr}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, content: { text }, messageId }) }).then(async r => ({ status: r.status, body: await r.text() }))
  const [d1, d2] = await Promise.all([sendId('deploy it', 'msg-abc'), sendId('deploy it', 'msg-abc')])
  const dup = [d1, d2].find(r => r.status === 409)
  ok([d1.status, d2.status].sort().join() === '200,409' && /"duplicate":true/.test(dup?.body || ''), `the same message sent twice at once runs once, and the second is named a duplicate (got ${d1.status}, ${d2.status})`)
  const late = await sendId('deploy it', 'msg-abc')
  ok(late.status === 409 && /"duplicate":true/.test(late.body), `the same message arriving again after its reply is still refused (got ${late.status})`)
  const after = await (await fetch(`http://127.0.0.1:${pr}/api/sessions/${s.id}`)).json()
  ok(after.messages.filter(m => m.role === 'user' && m.id === 'msg-abc').length === 1, 'the chat holds it once, with its name')
  const fresh = await sendId('deploy it', 'msg-def')
  ok(fresh.status === 200, `the same words with a new name are a new message (got ${fresh.status})`)
  const junk = await sendId('hi', 'bad id with spaces!')
  ok(junk.status === 200, `a malformed name is ignored, not refused (got ${junk.status})`)
  // a refused send that never started (no provider) does not leave the chat claimed
  const s2 = await (await fetch(`http://127.0.0.1:${pr}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'nope', model: 'm1', cwd: ws }) })).json()
  const bad = () => fetch(`http://127.0.0.1:${pr}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s2.id, content: { text: 'x' } }) }).then(r => r.status)
  const [x1, x2] = [await bad(), await bad()]
  ok(x1 === 400 && x2 === 400, `a send refused before it starts does not lock the chat (got ${x1}, ${x2})`)
} finally {
  srv.kill(); prov.close(); jev.close(); await sleep(200)
  for (const d of [dir, ws]) fs.rmSync(d, { recursive: true, force: true })
}
console.log(`\n${pass}/${pass + fail} passed  ·  one chat runs one turn at a time, and one message gets one reply`)
process.exit(fail ? 1 : 0)
