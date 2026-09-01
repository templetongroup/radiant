// Removing a built-in agent, and putting it back.
//
// Tony: "i feel like the agents menu is too cluttered. should we maybe not auto
// insert the group of agents there and just let people add the ones they need?"
//
// Not seeding them would not have helped him — his are already installed, and a
// first run with no agents makes the library harder to find, not easier. The
// actual problem was that the fourteen defaults could not be removed at all:
// DELETE answered 400 "built-in agents cannot be deleted".
//
// ⚠️ OWN SERVER, OWN DATA DIRECTORY. Radiant.app holds 5834 whenever it is open.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'radiant-agents-'))
const PORT = 5857
const B = `http://127.0.0.1:${PORT}`
let server = spawn('node', ['server/index.js'], { env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) }, stdio: 'ignore' })
const stop = () => { try { server.kill() } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', stop)

const up = async () => {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(B + '/api/config'); if (r.ok && (await r.json())?.agents) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}
const g = async p => (await fetch(B + p)).json()

let pass = 0, fail = 0
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${x}`) } }

if (!await up()) { console.log('  the test server never came up'); stop(); process.exit(1) }
// The store is seeded on first load; give it the moment that takes.
await new Promise(r => setTimeout(r, 1500))

const seeded = await g('/api/config')
ok('built-in agents are seeded', seeded.agents.length > 5, `${seeded.agents.length}`)
ok('and none is marked removed to begin with', (seeded.removedAgents || []).length === 0)

const del = await fetch(B + '/api/agents/agent-finance', { method: 'DELETE' })
const after = await del.json()
// This used to be a 400. A default you cannot remove is permanent furniture.
ok('a built-in can be removed', del.status === 200)
ok('and it leaves the list', !after.agents.some(a => a.id === 'agent-finance'))
ok('the removal is recorded, so it can be offered back',
   (after.removedAgents || []).includes('agent-finance'))

// ⚠️ THE REMOVAL MUST SURVIVE A RESTART, or "remove" is a five-minute illusion.
server.kill()
await new Promise(r => setTimeout(r, 600))
server = spawn('node', ['server/index.js'], { env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) }, stdio: 'ignore' })
if (!await up()) { console.log('  the server did not come back'); stop(); process.exit(1) }
await new Promise(r => setTimeout(r, 1500))

const restarted = await g('/api/config')
ok('the removal survives a restart', !restarted.agents.some(a => a.id === 'agent-finance'))
ok('and is still listed as removed', (restarted.removedAgents || []).includes('agent-finance'))

// ⚠️ AND IT MUST BE UNDOABLE. Agents live in their own files, so clearing the
// record is not enough — the agent has to be written back from its definition.
// The first version of restore only edited the record and silently restored
// nothing.
const res = await fetch(B + '/api/agents/restore/agent-finance', { method: 'POST' })
const back = await res.json()
ok('a removed built-in can be restored', res.status === 200)
ok('and it really comes back', back.agents.some(a => a.id === 'agent-finance'))
ok('with the record cleared', !(back.removedAgents || []).includes('agent-finance'))


// ── the editor's layout ─────────────────────────────────────────────────────
// Tony, with a screenshot: "this layout is also incrediblt jumbled and clunky.
// skills piled up and buttons too close to other text."
{
  const fs = await import('node:fs')
  const css = fs.readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const jsx = fs.readFileSync('src/components/Settings.jsx', 'utf8')

  // A wrapping flex row of differently sized items is not a list — it lands
  // three or four per line at ragged intervals.
  const skills = /\.agent-skills \{([^}]*)\}/.exec(css)?.[1] || ''
  ok('skills are a grid, not a wrapping flex row', /display:\s*grid/.test(skills))
  ok('and the columns are sized, so names line up', /grid-template-columns/.test(skills))
  // The badge must keep its own space or it pushes the next name along.
  ok('the "all agents" badge is pinned right', /\.skill-global-tag \{[^}]*margin-left:\s*auto/.test(css))
  // Buttons sat 10px under the last checkbox.
  const actions = /\.agent-editor-actions \{([^}]*)\}/.exec(css)?.[1] || ''
  ok('the action row is separated from the fields', /border-top/.test(actions) && /margin-top/.test(actions))
  ok('and the editor uses it', /className='row agent-editor-actions'/.test(jsx))
  // Tools and computer control are permissions, not skills.
  ok('capabilities sit apart from the skill grid', /\.agent-caps \{[^}]*border-top/.test(css))
}

console.log(`\n  ${pass}/${pass + fail} passed  ·  its own data directory, not yours`)
stop()
process.exit(fail ? 1 : 0)
