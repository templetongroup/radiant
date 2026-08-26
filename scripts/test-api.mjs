#!/usr/bin/env node
// End-to-end checks against a real server on a throwaway data directory.
//
// ⚠️ THIS EXISTS BECAUSE EYEBALLING DID NOT WORK. On 2026-08-26 roughly twenty
// releases went out in a day, many fixing a regression in the one before, and
// every one of them was "verified" by looking at something adjacent to the
// thing that broke. Each case below is a path that actually broke, or that a
// change touched and nobody exercised.
import { spawn } from 'child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const home = mkdtempSync(path.join(tmpdir(), 'radiant-api-'))
const data = path.join(home, 'data')
mkdirSync(data, { recursive: true })
writeFileSync(path.join(data, 'config.json'), JSON.stringify({ settings: { themeId: 'violet' } }))
writeFileSync(path.join(home, '.radiant-location'), data)

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
server.stdout.on('data', d => { log += d })
server.stderr.on('data', d => { log += d })

const deadline = Date.now() + 30000
let port = null
while (!port && Date.now() < deadline) {
  const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(log)
  if (m) port = m[1]; else await new Promise(r => setTimeout(r, 200))
}
if (!port) { console.error('server never started:\n' + log); process.exit(1) }
const base = `http://127.0.0.1:${port}`

const results = []
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text, headers: res.headers }
}
const check = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail || '' })
  } catch (e) {
    results.push({ name, ok: false, detail: e.message })
  }
}
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const ok = (cond, what) => { if (!cond) throw new Error(what) }

// ---- the paths that broke today -------------------------------------------

await check('API responses are not cacheable', async () => {
  const r = await api('GET', '/api/version')
  ok(/no-store/.test(r.headers.get('cache-control') || ''), 'missing no-store on /api/version')
  return r.headers.get('cache-control')
})

await check('projects live in their own files', async () => {
  const a = await api('POST', '/api/projects', { name: 'Alpha' })
  const b = await api('POST', '/api/projects', { name: 'Beta' })
  ok(a.status === 200 && b.status === 200, 'create failed')
  const list = (await api('GET', '/api/projects')).json
  eq(list.map(p => p.name).sort(), ['Alpha', 'Beta'], 'project list')
  ok(readdirSync(path.join(data, 'projects')).length === 2, 'expected 2 project files')
  return '2 files'
})

await check('project rename and delete persist', async () => {
  const list = (await api('GET', '/api/projects')).json
  const id = list.find(p => p.name === 'Beta').id
  await api('PATCH', `/api/projects/${id}`, { name: 'Beta renamed' })
  const after = (await api('GET', '/api/projects')).json
  ok(after.some(p => p.name === 'Beta renamed'), 'rename did not persist')
  await api('DELETE', `/api/projects/${id}`)
  const gone = (await api('GET', '/api/projects')).json
  ok(!gone.some(p => p.id === id), 'delete did not persist')
  return 'renamed + deleted'
})

await check('agents live in their own files', async () => {
  const before = (await api('GET', '/api/config')).json.agents.length
  const made = await api('POST', '/api/agents', { name: 'Test agent' })
  ok(made.status === 200, 'create failed: ' + made.text.slice(0, 120))
  const cfg = (await api('GET', '/api/config')).json
  ok(cfg.agents.length === before + 1, 'agent not listed')
  ok(readdirSync(path.join(data, 'agents')).length === cfg.agents.length, 'file count mismatch')
  return `${cfg.agents.length} agents, one file each`
})

await check('agent edit and delete persist', async () => {
  const cfg = (await api('GET', '/api/config')).json
  const a = cfg.agents.find(x => x.name === 'Test agent')
  ok(a, 'test agent missing')
  await api('PATCH', `/api/agents/${a.id}`, { name: 'Renamed agent', persona: 'careful' })
  const after = (await api('GET', '/api/config')).json.agents.find(x => x.id === a.id)
  eq(after.name, 'Renamed agent', 'agent rename')
  eq(after.persona, 'careful', 'agent persona')
  await api('DELETE', `/api/agents/${a.id}`)
  const gone = (await api('GET', '/api/config')).json.agents.some(x => x.id === a.id)
  ok(!gone, 'agent delete did not persist')
  return 'renamed + deleted'
})

await check('skills and recipes round-trip', async () => {
  const sk = await api('POST', '/api/skills', { name: 'Test skill', content: 'do the thing' })
  ok(sk.status === 200, 'skill create failed: ' + sk.text.slice(0, 120))
  const rc = await api('POST', '/api/recipes', { name: 'Test recipe', template: 'hello' })
  ok(rc.status === 200, 'recipe create failed: ' + rc.text.slice(0, 120))
  const cfg = (await api('GET', '/api/config')).json
  ok(cfg.skills.some(s => s.name === 'Test skill'), 'skill missing')
  ok(cfg.recipes.some(r => r.name === 'Test recipe'), 'recipe missing')
  return 'created and listed'
})

await check('shared config.json never carries per-record data', async () => {
  const raw = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8'))
  const leaked = ['agents', 'skills', 'recipes', 'projects'].filter(k => k in raw)
  ok(leaked.length === 0, 'leaked into the shared file: ' + leaked.join(', '))
  return 'clean'
})

await check('machine-local settings stay out of the shared file', async () => {
  await api('PUT', '/api/settings', { defaultModel: 'local-only-model', themeId: 'ocean' })
  const served = (await api('GET', '/api/config')).json.settings
  eq(served.defaultModel, 'local-only-model', 'machine setting not served')
  eq(served.themeId, 'ocean', 'shared setting not served')
  const raw = JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8'))
  ok(!('defaultModel' in raw.settings), 'defaultModel leaked into the shared file')
  eq(raw.settings.themeId, 'ocean', 'shared setting not written')
  return 'split correctly'
})

await check('sessions create, list and fork without touching the original', async () => {
  const s = (await api('POST', '/api/sessions', { title: 'Original' })).json
  const full = { ...s, messages: [
    { role: 'user', text: 'one' }, { role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
    { role: 'user', text: 'three' }, { role: 'assistant', parts: [{ type: 'text', text: 'four' }] }
  ] }
  writeFileSync(path.join(data, 'sessions', s.id + '.json'), JSON.stringify(full))
  const fork = (await api('POST', `/api/sessions/${s.id}/fork`, { index: 1 })).json
  ok(fork.id !== s.id, 'fork reused the id')
  eq(fork.messages.length, 2, 'fork message count')
  ok(/\(branch\)$/.test(fork.title), 'fork title: ' + fork.title)
  const original = (await api('GET', `/api/sessions/${s.id}`)).json
  eq(original.messages.length, 4, 'original was modified')
  return 'branch of 2, original of 4'
})

await check('ChatGPT export imports the thread actually seen', async () => {
  const conv = {
    title: 'From ChatGPT', create_time: 1700000000, update_time: 1700003600, current_node: 'd',
    mapping: {
      root: { id: 'root', parent: null, children: ['a'], message: null },
      a: { id: 'a', parent: 'root', children: ['b', 'b2'], message: { author: { role: 'user' }, content: { parts: ['q'] } } },
      b2: { id: 'b2', parent: 'a', children: [], message: { author: { role: 'assistant' }, content: { parts: ['ABANDONED'] } } },
      b: { id: 'b', parent: 'a', children: ['c'], message: { author: { role: 'assistant' }, content: { parts: ['kept'] } } },
      c: { id: 'c', parent: 'b', children: ['d'], message: { author: { role: 'system' }, content: { parts: ['sys'] } } },
      d: { id: 'd', parent: 'c', children: [], message: { author: { role: 'user' }, content: { parts: ['last'] } } }
    }
  }
  const r = await api('POST', '/api/chats/import', [conv])
  ok(r.json?.added === 1, 'import failed: ' + r.text.slice(0, 160))
  const list = (await api('GET', '/api/sessions')).json
  const imported = list.find(x => x.title === 'From ChatGPT')
  ok(imported, 'imported chat not listed')
  const full = (await api('GET', `/api/sessions/${imported.id}`)).json
  const texts = full.messages.map(m => m.text || m.parts?.map(p => p.text).join(''))
  eq(texts, ['q', 'kept', 'last'], 'linearised thread')
  ok(imported.updatedAt.startsWith('2023-11'), 'original date not kept: ' + imported.updatedAt)
  return 'branch dropped, dates kept'
})

await check('import can never overwrite an existing chat', async () => {
  const existing = (await api('GET', '/api/sessions')).json[0]
  const r = await api('POST', '/api/chats/import', { chats: [{ id: existing.id, title: 'Impostor', messages: [{ role: 'user', text: 'x' }] }] })
  ok(r.json?.added === 1, 'import failed')
  const after = (await api('GET', `/api/sessions/${existing.id}`)).json
  ok(after.title !== 'Impostor', 'an import overwrote an existing chat')
  return 'id was minted fresh'
})

await check('the agent can read the web', async () => {
  const { runTool } = await import('../server/tools.js')
  const page = await runTool('fetch_url', { url: 'https://example.com', max_chars: 400 }, home)
  ok(/Example Domain/i.test(page), 'fetch_url returned nothing useful')
  ok(/untrusted content/i.test(page), 'fetched content was not marked untrusted')
  return 'fetch_url works and is marked untrusted'
})

await check('data folder status reports honestly', async () => {
  const st = (await api('GET', '/api/data-dir')).json
  eq(st.active, data, 'active folder')
  eq(st.syncing, true, 'syncing flag')
  eq(st.unreachable, false, 'unreachable flag')
  return 'active + syncing'
})

// ---- report ----------------------------------------------------------------
server.kill('SIGKILL')
const failed = results.filter(r => !r.ok)
console.log('')
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
