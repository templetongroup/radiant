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
import fs, { mkdtempSync, rmSync } from 'node:fs'
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

// ⚠️ OFFERED BACK AS ITSELF, NOT AS A ROBOT WITH AN UNSLUGGED ID. The library had
// only the id list, so it drew every removed agent with the generic bot icon, a
// name derived from the id ("agent-devops" -> "Devops") and one shared sentence.
// You were asked to restore something you could not recognise. Tony: "there
// should be an option to restore the original, pre-defined ones ... with their
// original icons and agent descriptions."
{
  const def = (after.removedAgentDefs || []).find(d => d.id === 'agent-finance')
  ok('the full definition comes back with it', Boolean(def))
  ok('with its real name', def?.name === 'Finance', def?.name)
  ok('its own icon, not the generic one', Boolean(def?.icon) && def.icon !== 'bot', def?.icon)
  ok('and the text it is described by', (def?.persona || '').length > 20)
}

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


// ── the confirm that ate the click ──────────────────────────────────────────
// Tony, twice: "im removing agents in settings and nothings happening", then
// "agents are sstill not removing from the list when I click remove." Driven in
// a browser with confirm forced true, the code path was fine — 13 → 12,
// recorded, editor closed. The native dialog was the entire failure. This app
// has been burned by one before: window.prompt is a no-op here, which is why
// the folder picker is native code.
{
  const fs = await import('node:fs')
  // ⚠️ STRIP COMMENTS. The rule is explained in a comment that NAMES
  // window.confirm, so reading the raw source fails on correct code — the third
  // time this exact trap has bitten in one session.
  const strip = t => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const settings = strip(fs.readFileSync('src/components/Settings.jsx', 'utf8'))
  const css = fs.readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const sidebar = strip(fs.readFileSync('src/components/Sidebar.jsx', 'utf8'))

  const editor = settings.slice(settings.indexOf('function AgentEditor'), settings.indexOf('function AgentsPane'))
  ok('removing an agent does not depend on a native dialog', !/window\.confirm/.test(editor))
  ok('it asks in our own UI instead', /confirm-inline/.test(editor) && /setConfirmRemove/.test(editor))
  // An armed delete that stays armed is a trap for the next stray click.
  // ⚠️ IT MUST NOT TIME OUT. A four-second disarm is less time than it takes to
  // read the sentence it puts on screen, so the prompt reverted to a plain
  // Remove button and the second click RE-ARMED it. Tony: "Yes, but the second
  // click does nothing." It did something — the wrong thing, invisibly.
  // ⚠️ DO NOT WRITE /setTimeout\([^)]*X/. `[^)]*` stops at the ')' inside `() =>`,
  // so it never matches an arrow callback — it has silently passed on broken
  // code FOUR times in one session. Ask whether the two words appear near each
  // other instead.
  {
    const timers = [...editor.matchAll(/setTimeout/g)].map(m => editor.slice(m.index, m.index + 120))
    ok('the confirm does not disarm on a timer', !timers.some(t => /setConfirmRemove/.test(t)))
  }
  ok('and Keep is how you back out', /setConfirmRemove\(false\)[\s\S]{0,120}Keep/.test(editor))


  // ⚠️ REMOVE SITS WITH THE OTHER BUTTONS, and the row holds the taller state's
  // height. Tony: "move the remove button next the otehrs on the left. make sure
  // to make room for when it expands on click." It was alone on the far right,
  // and arming it grew the row so everything below jumped at the exact moment
  // you were aiming at the second click.
  ok('Remove is not pushed to the far right', !/marginLeft: 'auto'[\s\S]{0,200}setConfirmRemove/.test(settings))
  {
    const actions = /\.agent-editor-actions \{([^}]*)\}/.exec(css)?.[1] || ''
    ok('the action row reserves its expanded height', /min-height/.test(actions))
    ok('and wraps rather than overflowing', /flex-wrap:\s*wrap/.test(actions))
  }
  const row = sidebar.slice(sidebar.indexOf("className='session-actions'"), sidebar.indexOf('</div>', sidebar.indexOf('Delete permanently')))
  ok('deleting an archived chat does not either', !/window\.confirm/.test(row))
  ok('it arms on the first click', /armedDelete === s\.id/.test(row))
  {
    const timers = [...sidebar.matchAll(/setTimeout/g)].map(m => sidebar.slice(m.index, m.index + 120))
    ok('and that arm does not time out either', !timers.some(t => /setArmedDelete/.test(t)))
  }
  ok('and shows that it is armed', /is-armed/.test(row))
}

// ⚠️ A REMOVAL MUST OUTLIVE A STALE WRITER. This is the bug that made every
// earlier fix look like it had not worked. saveConfig writes a whole in-memory
// snapshot from any of two dozen callers, so one holding a config from before a
// removal wiped removedAgents -- and the next launch re-seeded every built-in
// file the tombstone was protecting. Tony's folder is in iCloud and shared with
// a second Mac, where "one writer, the server" is not true: his config.json kept
// removedProviders and removedSkills but had lost removedAgents, and 51 minutes
// later all thirteen built-in agents were written back. "I just created a single
// new agent and all of the previous pre-installed agents just reappeared."
{
  // config.js resolves RADIANT_DIR when it is first imported, and this process
  // has never imported it -- the server under test runs in a child. Point it at
  // the same throwaway directory before the import, never at a real one.
  process.env.RADIANT_DIR = dir
  const { readFileSync } = await import('node:fs')
  const cfgmod = await import('../server/config.js')
  const tomb = () => {
    try { return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).removedAgents || [] }
    catch { return [] }
  }
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

  const live = cfgmod.loadConfig()
  live.removedAgents = ['agent-reviewer']
  cfgmod.saveConfig(live)
  ok('a removal is written down', tomb().includes('agent-reviewer'))

  const stale = cfgmod.loadConfig()
  delete stale.removedAgents
  cfgmod.saveConfig(stale)
  ok('and a writer that predates it cannot wipe it', tomb().includes('agent-reviewer'), JSON.stringify(tomb()))

  const two = cfgmod.loadConfig()
  two.removedAgents = ['agent-docs']
  cfgmod.saveConfig(two)
  ok('two machines each deleting keep both deletions',
     same(tomb(), ['agent-docs', 'agent-reviewer']), JSON.stringify(tomb()))

  // The one case that must subtract. Without `forgetting`, the union would put
  // the id straight back and Restore would silently do nothing.
  const back = cfgmod.loadConfig()
  back.removedAgents = back.removedAgents.filter(x => x !== 'agent-reviewer')
  cfgmod.saveConfig(back, { forgetting: ['agent-reviewer'] })
  ok('an explicit restore still clears it', same(tomb(), ['agent-docs']), JSON.stringify(tomb()))
}

// ⚠️ NO FLAT MODEL LIST ANYWHERE. Radiant carries hundreds of models, so a plain
// <select> of all of them is unusable — and it kept reappearing in new screens
// after the chat picker was built. Tony, on the agent editor: "the model list is
// again endless. anywhere there's a model list we need to be able to collapse it
// by provider." One shared ModelPicker, so a screen cannot opt out by accident.
{
  const files = ['src/components/Settings.jsx', 'src/components/ComparePanel.jsx', 'src/components/TaskBoard.jsx']
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    // The catalogue of every provider's models — NOT `data.models`, which is the
    // quantize converter's list of local models to convert. That one is a single
    // provider with a size and quant per row; grouping it by provider would put
    // everything under one heading and help nobody.
    ok(`${f.split('/').pop()} lists no models in a flat <select>`,
       !/[^.\w]models\.map\(m => <option/.test(src))
  }
  const set = fs.readFileSync('src/components/Settings.jsx', 'utf8')
  ok('the agent editor uses the shared picker', /<ModelPicker/.test(set))
  ok('and both of its model fields do', (set.match(/<ModelPicker/g) || []).length >= 3)
  // A <select> got its "none" row free from an empty <option>. The picker has to
  // be told, or swapping it in silently deletes "no model".
  ok('picking nothing is still possible', /clearLabel=/.test(set))
  const chat = fs.readFileSync('src/components/Chat.jsx', 'utf8')
  ok('the picker honours a clear row', /clearLabel && !searching/.test(chat))
  ok('and clearing sends null, not a model', /onPick\(null\)/.test(chat))
  const css = fs.readFileSync('src/styles.css', 'utf8')
  // .model-menu has no position of its own; every host supplies one.
  ok('the form-field host positions the menu', /\.model-pick-field \.model-menu \{[^}]*position:\s*absolute/s.test(css))
}

{
  const set = fs.readFileSync('src/components/Settings.jsx', 'utf8')
  ok('the library renders the definitions, not the bare ids', /removedAgentDefs \|\| \[\]\)\.map\(def =>/.test(set))
  ok("each card shows that agent's own icon", /AGENT_ICONS\[def\.icon\]/.test(set))
  ok('and its own name', /className='tmpl-name'>\{def\.name\}/.test(set))
  // Thirteen built-ins is thirteen clicks without this.
  ok('all of them can be put back at once', /tmpl-restore-all/.test(set))
}

// ⚠️ DEVICES MUST SAY WHICH STATE YOU ARE IN BEFORE IT OFFERS A CHOICE. It used
// to show two permanently-expanded roles — "This Mac does the work" and "This Mac
// is a window onto another" — and never said which one was true, so reading your
// own setup meant reading both and inferring. Tony: "its my product and i dont
// 100% understand how this works or how my setup is structured."
{
  const dfs = await import('node:fs')
  const set = dfs.readFileSync('src/components/Settings.jsx', 'utf8')
  ok('there is a status line stating the current state', /className=\{'dev-now'/.test(set))
  ok('and it names the machine, not "another Mac"', /window onto \{hostName/.test(set))
  ok('the two states are cards', /dev-choices/.test(set) && /dev-card-title/.test(set))
  ok('and the one you are in is marked', /dev-badge'>Current/.test(set))
  ok('each card is marked from the same fact', (set.match(/is-current/g) || []).length >= 2)

  const dcss = dfs.readFileSync('src/styles.css', 'utf8')
  ok('the current card is ringed, not filled', /\.dev-card\.is-current \{[^}]*box-shadow/s.test(dcss))
  // A .hint inside a card inherits the global size and outgrows the card's own
  // subtitle, which reads as two unrelated blocks instead of one card.
  ok('card body text is scaled to the card', /\.dev-card-body \.hint \{[^}]*font-size/s.test(dcss))
}

console.log(`\n  ${pass}/${pass + fail} passed  ·  its own data directory, not yours`)
stop()
process.exit(fail ? 1 : 0)
