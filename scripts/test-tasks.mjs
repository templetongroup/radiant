// The board's server side, exercised against a Radiant this script starts.
//
// ⚠️ IT MUST NOT USE PORT 5834. Radiant.app owns that whenever it is open, so a
// gate pointed there runs against the INSTALLED build and writes into the user's
// real chats — every run of this file used to leave a "Board smoke test" chat in
// Tony's sidebar, and one run reported the board missing entirely because it was
// talking to a release that predated it. Own server, own data directory, same as
// test-sessions.mjs.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'radiant-tasks-'))
const PORT = 5848
const B = `http://127.0.0.1:${PORT}`
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) },
  stdio: 'ignore'
})
const stop = () => { try { server.kill() } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', stop)
// Wait for a real answer, not merely for fetch to stop throwing.
let ready = false
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(B + '/api/version')
    if (r.ok && (await r.json())?.version) { ready = true; break }
  } catch { /* not listening yet */ }
  await new Promise(r => setTimeout(r, 250))
}
if (!ready) { console.log('  the test server never came up'); stop(); process.exit(1) }
let pass = 0, fail = 0
const ok = (n, c, extra='') => { if (c) { pass++ } else { fail++; console.log(`  FAIL ${n} ${extra}`) } }
const j = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) }
}

// create
const made = await j('POST', '/api/tasks', { title: 'Board smoke test', detail: 'do a thing', model: 'gpt-x' })
ok('a task can be created', made.status === 200 && made.body?.id, JSON.stringify(made.body))
const id = made.body?.id
ok('it starts queued', made.body?.state === 'queued')
ok('it remembers the model chosen', made.body?.model === 'gpt-x')

// a title is required
const blank = await j('POST', '/api/tasks', { title: '   ' })
ok('a blank title is refused', blank.status === 400)

// list
const list = await j('GET', '/api/tasks')
ok('it appears on the board', Array.isArray(list.body) && list.body.some(t => t.id === id))

// ⚠️ the rule that matters: a person cannot drag a card into a state the run owns
const cheat = await j('PATCH', `/api/tasks/${id}`, { state: 'working', byUser: true })
ok('a person cannot drag a card to Working', cheat.status === 409, `got ${cheat.status}`)
const cheat2 = await j('PATCH', `/api/tasks/${id}`, { state: 'review', byUser: true })
ok('nor to Review', cheat2.status === 409)
const okDone = await j('PATCH', `/api/tasks/${id}`, { state: 'done', byUser: true })
ok('but may accept it into Done', okDone.status === 200 && okDone.body.state === 'done')
const okBack = await j('PATCH', `/api/tasks/${id}`, { state: 'queued', byUser: true })
ok('and may park it back in Queued', okBack.status === 200)

// unknown states are refused rather than stored
const junk = await j('PATCH', `/api/tasks/${id}`, { state: 'nonsense' })
ok('an unknown state is refused', junk.status === 400)

// start: creates a session, links it, moves to working
const started = await j('POST', `/api/tasks/${id}/start`)
ok('starting returns a session', started.status === 200 && started.body?.sessionId, JSON.stringify(started.body))
ok('and the card is now Working', started.body?.task?.state === 'working')
ok('and the prompt carries the goal and the detail',
   started.body?.prompt?.includes('Board smoke test') && started.body?.prompt?.includes('do a thing'))
const sid = started.body?.sessionId
const sess = await j('GET', `/api/sessions/${sid}`)
ok('the session exists and points back at the task', sess.body?.taskId === id, JSON.stringify(sess.body).slice(0,120))
ok('the session keeps the task title', sess.body?.title === 'Board smoke test')

// starting again resumes rather than orphaning the first conversation
const again = await j('POST', `/api/tasks/${id}/start`)
ok('starting again resumes the same session', again.body?.resumed === true && again.body?.sessionId === sid)

// cleanup
await j('DELETE', `/api/tasks/${id}`)
const gone = await j('GET', '/api/tasks')
ok('it can be deleted', !gone.body.some(t => t.id === id))


// ── the run owns the middle columns ──────────────────────────────────────────
// The reflector cannot be driven from here without running a real model, so its
// rules are asserted from the source. Both exist because they were wrong live:
// a question filed the card under Review, beside finished work.
{
  const src = await import('node:fs').then(m => m.readFileSync('server/index.js', 'utf8'))
  const fn = src.slice(src.indexOf('function reflectTaskState'), src.indexOf('function reflectTaskState') + 1800)
  ok('an agent question blocks the card, like an approval',
     /question_request/.test(fn) && /approval_request' \|\| ev\.type === 'question_request'/.test(fn))
  ok("and the `done` that follows a question cannot overwrite the block",
     /if \(task\.state === 'blocked'\) return/.test(fn))
  ok('only the run sets working/blocked/review — the routes refuse a person',
     /That column is set by the run, not by hand/.test(src))
}


// ── one picker, not two ──────────────────────────────────────────────────────
// The board first shipped a flat <select> holding every model. Tony: "that model
// list is overwhelming. it needs to have the same collapsible list as the model
// list in the chat window." With OpenRouter alone at 424 entries and the agent
// library at 142, a flat list was never browsable.
{
  const fs = await import('node:fs')
  const board = fs.readFileSync('src/components/TaskBoard.jsx', 'utf8')
  const chat = fs.readFileSync('src/components/Chat.jsx', 'utf8')
  const css = fs.readFileSync('src/styles.css', 'utf8')

  ok('the board uses the chat picker rather than its own',
     /import \{ ModelPicker \} from '\.\/Chat\.jsx'/.test(board) && /<ModelPicker/.test(board))
  ok('and there is no flat select left in it', !/<select/.test(board))
  ok('the picker is exported so there is one copy', /export function ModelPicker/.test(chat))
  ok('agents are offered through the same grouped list',
     /providerName: 'Agents'/.test(board))
  // ⚠️ .model-menu carries no position of its own — only `.composer-box
  // .model-menu` gives it one. Outside the composer it falls into normal flow
  // and lands on top of the form, which is what happened.
  ok('the menu is positioned where the board puts it',
     /\.tb-who-pick \.model-menu \{[^}]*position: absolute/s.test(css))
}


// ── steering ────────────────────────────────────────────────────────────────
// Tony: "we should have a steer option next to the Queued text so an agent can
// be steered to the new message." Steering only means something once something
// is running — a queued card has nothing to redirect.
{
  const fs = await import('node:fs')
  const board = fs.readFileSync('src/components/TaskBoard.jsx', 'utf8')
  const app = fs.readFileSync('src/App.jsx', 'utf8')

  ok('steer is offered only while a task is running or blocked',
     /canSteer = task\.state === 'working' \|\| task\.state === 'blocked'/.test(board))
  ok('and the button is gated on it', /\{canSteer &&[\s\S]{0,200}Steer/.test(board))
  ok('the card takes a message rather than just opening the chat', /tb-steer-input/.test(board))
  // ⚠️ ONE DELIVERY PATH. A server-side steer queue would be a second way for a
  // message to reach an agent, and two is how they drift apart.
  ok('steering reuses the pending-prompt queue', /kind: 'steer'/.test(app))
  // A steer arrives at a task already running; a failed START is what belongs
  // back in Queued. Sending a steered task back would undo real work.
  ok("a failed steer does not send the card back to Queued",
     /if \(kind !== 'steer'\) api\.patchTask\(taskId, \{ state: 'queued' \}\)/.test(app))
}


// ── the HUD ─────────────────────────────────────────────────────────────────
// Tony: "How about a HUD mode like Hermes Mac app has?" — a small window that
// floats above other apps showing what the agents are doing.
{
  const fs = await import('node:fs')
  const hud = fs.readFileSync('src/components/Hud.jsx', 'utf8')
  const main = fs.readFileSync('electron/main.cjs', 'utf8')
  const entry = fs.readFileSync('src/main.jsx', 'utf8')

  // Only what is happening NOW. A HUD listing everything is a second sidebar.
  ok('the HUD shows only running and blocked tasks',
     /state === 'working' \|\| t\.state === 'blocked'/.test(hud))
  ok('and blocked sorts first, being the only row that needs you',
     /ORDER = \{ blocked: 0, working: 1 \}/.test(hud))
  // An empty panel reads as "nothing running", which is a claim — so a lost
  // connection has to say so rather than look idle.
  ok('a lost connection is shown, not mistaken for idle', /hud-err/.test(hud) && /setErr/.test(hud))

  ok('it is its own route, not the whole app', /route === 'hud'/.test(entry))
  ok('the window floats above other apps', /setAlwaysOnTop\(true, 'floating'\)/.test(main))
  ok('and is visible over full-screen apps', /visibleOnFullScreenUI: true/.test(main))
  // ⚠️ window-all-closed quits Radiant and the embedded server dies with it, so
  // a HUD outliving the main window would hold a dead app open.
  // Read the handler's BODY rather than pattern-matching across it: `[^)]*`
  // stops at the ')' inside `() =>`, which is how this check first failed on
  // correct code — the same trap as regexing a JSX tag.
  {
    const at = main.indexOf("win.on('closed'")
    const body = at === -1 ? '' : main.slice(at, at + 220)
    ok('the HUD closes with the main window', /hudWin/.test(body) && /close\(\)/.test(body))
  }
  ok('a hotkey is registered and released on quit',
     /globalShortcut\.register/.test(main) && /globalShortcut\.unregisterAll/.test(main))
  // The HUD owns no conversations; it asks the main window to open one.
  ok('clicking a row asks the main window to open the chat', /rad:hud-open/.test(main))
}

console.log(`\n  ${pass}/${pass + fail} passed`)
stop()
process.exit(fail ? 1 : 0)
