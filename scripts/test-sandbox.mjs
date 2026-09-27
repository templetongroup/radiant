// The agent's shell inside macOS's sandbox (tools.js shellCommand): writes only
// in the project folder (plus temp and package caches), and with "offline" no
// internet except localhost. Off by default; off means exactly as before.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { runTool, setSandbox, sandboxActive } from '../server/tools.js'

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }
if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) { console.log('  (not macOS with sandbox-exec — skipped)'); process.exit(0) }

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-sb-ws-'))
// outside the project, and outside the temp folders the sandbox allows
const outside = path.join(os.homedir(), `.radiant-sandbox-probe-${process.pid}`)
const run = cmd => runTool('run_command', { command: cmd }, ws)
const srv = http.createServer((q, r) => r.end('local ok'))
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const local = `http://127.0.0.1:${srv.address().port}/`

try {
  setSandbox('off')
  ok(!sandboxActive(), 'off is off')
  const w0 = await run(`echo x > "${outside}" && echo wrote`)
  ok(/wrote/.test(w0) && fs.existsSync(outside), 'off: a write outside the project works, exactly as before')
  fs.rmSync(outside, { force: true })

  setSandbox('workspace')
  ok(sandboxActive(), 'the sandbox turns on')
  ok(/hello/.test(await run('echo hello > inside.txt && cat inside.txt')), 'a write inside the project works')
  ok(/done/.test(await run('mkdir -p sub/deep && echo y > sub/deep/f && git init -q && git add -A && git -c user.email=a@b -c user.name=x commit -qm t && echo done')), 'so do folders and git inside the project')
  const w1 = await run(`echo x > "${outside}" && echo wrote`)
  ok(!fs.existsSync(outside) && /Operation not permitted/.test(w1), 'a write outside the project is refused by the OS')
  ok(/allows writes only inside the project folder. Do not retry/.test(w1), 'and the agent is told why, and not to retry')
  ok(/ok/.test(await run('echo t > /tmp/radiant-sb-$$ && rm /tmp/radiant-sb-$$ && echo ok')), 'temp files still work')
  ok(/local ok/.test(await run(`curl -s ${local}`)), 'the network is on in "project folder only"')

  setSandbox('offline')
  const net = await run('curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com; echo " rc=$?"')
  ok(!/200/.test(net), `offline: the internet is blocked (got ${net.trim().slice(0, 60)})`)
  ok(/local ok/.test(await run(`curl -s ${local}`)), 'offline: localhost still answers (dev servers, tests)')
  ok(/project folder/.test(await run(`echo x > "${outside}"`)), 'offline still fences writes')

  setSandbox('workspace')
  const started = await runTool('run_command', { command: `echo bg > "${outside}"; echo finished`, run_in_background: true }, ws)
  const id = /job_[0-9a-f]+/.exec(started)?.[0]
  let out = ''
  for (let i = 0; i < 40 && !/finished/.test(out); i++) { await new Promise(r => setTimeout(r, 100)); out = String(await runTool('job', { id, action: 'output' }, ws).catch(e => String(e))) }
  ok(id && /finished/.test(out) && !fs.existsSync(outside) && /Operation not permitted/.test(out), `a background job runs, and is fenced too (${out.replace(/\s+/g, ' ').slice(0, 80)})`)
} finally {
  setSandbox(null)
  srv.close()
  fs.rmSync(outside, { force: true })
  fs.rmSync(ws, { recursive: true, force: true })
}
console.log(`\n${pass}/${pass + fail} passed  ·  the agent's shell stays inside the project when the sandbox is on`)
process.exit(fail ? 1 : 0)
