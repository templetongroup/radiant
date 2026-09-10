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


// ⚠️ SPLITTING ON THE AT-RULE IS NOT READING A BLOCK. Cutting the stylesheet at
// every "@media (prefers-reduced-motion" leaves each piece running to the NEXT
// one, so a segment swallows all the ordinary CSS after its own closing brace —
// and a search for .hud-dot then matches a block that does not contain it. This
// counts braces, which is the only way to know where a block ends.
function reducedMotionBlocks (css) {
  const out = []
  const needle = '@media (prefers-reduced-motion'
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    const open = css.indexOf('{', i)
    if (open === -1) continue
    let depth = 0
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}' && --depth === 0) { out.push(css.slice(open, j + 1)); break }
    }
  }
  return out
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


// ── a picker inside a form must not submit it ───────────────────────────────
// ⚠️ A <button> WITH NO type IS A SUBMIT BUTTON. ModelPicker's five buttons had
// no type, and it is rendered inside the New task <form> — so clicking "Pick a
// model" submitted the form and created the task there and then, before you had
// picked anything. Measured in the running app: one click, one task called
// whatever was half-typed in the title. The loop composer has two of these, so
// it inherited the same bug the day it was written.
{
  const fs = await import('node:fs')
  const chat = fs.readFileSync('src/components/Chat.jsx', 'utf8')
  const start = chat.indexOf('export function ModelPicker')
  const block = start === -1 ? '' : chat.slice(start, start + 6000)
  const buttons = block.split('<button').slice(1)
  ok('ModelPicker has buttons to check', buttons.length >= 5, String(buttons.length))
  ok('every button in the model picker declares type="button"',
     buttons.every(b => /^[^>]*type='button'/.test(b)),
     buttons.filter(b => !/^[^>]*type='button'/.test(b)).length + ' without a type')
  // The two places it is rendered inside a form.
  const board = fs.readFileSync('src/components/TaskBoard.jsx', 'utf8')
  ok('the task composer really is a form (so the above matters)',
     /<form className='tb-compose'/.test(board) && /<ModelPicker/.test(board))

  // ⚠️ AND THE SAME CLASS OF BUG, ONE LEVEL SUBTLER. The loop walkthrough had a
  // Next button and a submit button swapped by a ternary in the same slot, so
  // React reused the DOM node: the click landed on Next, the handler advanced
  // the stage, React flipped THAT ELEMENT's type to "submit", and the browser
  // then ran the submit default action. Pressing Next on the steps skipped the
  // review and created the loop. One button, always type='button'.
  const lb = fs.readFileSync('src/components/LoopBoard.jsx', 'utf8')
  ok('the walkthrough has no submit button to swap in', !/type='submit'/.test(lb))
  ok('and its one advance button always declares type="button"',
     /onClick=\{advance\}/.test(lb) && /type='button'\n\s+className='rx-btn rx-btn-go'/.test(lb))
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
     /kind !== 'steer'[\s\S]{0,40}api\.patchTask\(taskId, \{ state: 'queued' \}\)/.test(app))
  // Not every held prompt is a task. The Graph view sends one into a brand-new
  // chat, which has no card behind it — patching task `undefined` was a 404 that
  // nothing looked at.
  ok('and a held prompt with no task does not patch one',
     /if \(taskId && kind !== 'steer'\)/.test(app))
}


// ── the HUD ─────────────────────────────────────────────────────────────────
// Tony: "How about a HUD mode like Hermes Mac app has?" — a small window that
// floats above other apps showing what the agents are doing.
{
  const fs = await import('node:fs')
  const nfs = await import('node:fs')
  const hud = nfs.readFileSync('src/components/Hud.jsx', 'utf8')
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


// ── the visual pass ─────────────────────────────────────────────────────────
// Colour is spent on ONE thing — the state that needs a person. Everything else
// gets depth. Two rules here exist because breaking them is silent:
{
  const fs = await import('node:fs')
  const css = fs.readFileSync('src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const board = fs.readFileSync('src/components/TaskBoard.jsx', 'utf8')

  // ⚠️ nth-child(3) is only "Needs you" until somebody reorders COLUMNS.
  // This check used to name ONE positional selector (`.tb-col:nth-child(3) .tb-card`)
  // and so reported green while the COLUMN itself was styled by position. Ban the
  // whole shape instead of the one instance that happened to exist.
  ok('the blocked accent is keyed to state, not column position',
     /\.tb-card\.is-blocked/.test(css) && !/\.tb-col:nth-child\(/.test(css))
  ok('and the column is reached by its id', /\.tb-col-blocked/.test(css))
  ok('the column carries its id as a class', /'tb-col tb-col-' \+ col\.id/.test(board))

  // ⚠️ AN EMPTY COLUMN MUST NOT GLOW. "Needs you" lit up whether or not anything
  // was waiting, so the one signal on the board that means "stop and look" was on
  // permanently — and a signal that is always on is not a signal. Tony, seeing it
  // over an empty column: "why is there blue highlight on Needs You?"
  ok('the column only lights up when something is in it',
     /\.tb-col-blocked\.has-work \{/.test(css) && !/\.tb-col-blocked \{/.test(css))
  ok('and has-work is set from the count, not guessed',
     /byColumn\[col\.id\]\.length \? ' has-work'/.test(board))
  ok('and the card carries its state as a class', /'tb-card is-' \+ task\.state/.test(board))
  // A blocked card has three buttons and a time in a ~210px column.
  ok('the card footer wraps rather than crushing its buttons',
     /\.tb-card-foot \{[^}]*flex-wrap:\s*wrap/s.test(css))
  // Motion is decoration; colour and depth carry the meaning and must survive.
  // Read the block's body rather than pattern-matching across it — the keyframe
  // is DEFINED above, so looking for its name inside the guard fails on correct
  // code. Third time today a regex over source has done that.
  {
    // ⚠️ FIND THE BLOCK BY WHAT IS IN IT, NOT BY BEING LAST. This took
    // lastIndexOf and broke the moment any new reduce-motion rule was appended
    // to the stylesheet — it was then reading a stranger's block and reporting
    // the HUD's motion as unguarded. That is the same positional assumption the
    // comment above warns about, one line up. There are two dozen of these
    // blocks; the one that matters here is whichever one names .hud-dot.
    const body = reducedMotionBlocks(css).find(b => b.includes('.hud-dot')) || ''
    ok('every moving part is dropped under Reduce Motion',
       /\.hud-dot \{[^}]*animation:\s*none/.test(body) && /transform:\s*none/.test(body))
  }
}

// ⚠️ THE HUD MUST COUNT A RUNNING CHAT. It asked only for board tasks, so an
// agent streaming in a chat — the most common thing anyone has running — left it
// reading "Nothing running." Tony, with a turn mid-flight on screen: "HUD mode
// shows nothing running even though there clearly is." /api/sessions already
// flags a live turn per session; the HUD simply never asked.
{
  const nfs = await import('node:fs')
  const hud = nfs.readFileSync('src/components/Hud.jsx', 'utf8')
  ok('the HUD asks about chats as well as tasks', /api\.listSessions\(\)/.test(hud))
  ok('and both are fetched together', /Promise\.all\(\[api\.listTasks\(\), api\.listSessions\(\)\]\)/.test(hud))
  ok('it keeps only the sessions with a live turn', /\.filter\(s => s\.active\)/.test(hud))
  ok('a running chat can be opened from the HUD', /sessionId: s\.id/.test(hud))

  const srv = nfs.readFileSync('server/index.js', 'utf8')
  ok('the server marks which sessions are running', /active: activeTurns\.has\(s\.id\)/.test(srv))

  // Nine tooltips carry authored line breaks; centring made every one ragged.
  const css2 = nfs.readFileSync('src/styles.css', 'utf8')
  const tip = /\[data-tip\]:hover::after \{([\s\S]*?)\}/.exec(css2)?.[1] || ''
  ok('tooltips are left-aligned, not centred', /text-align:\s*left/.test(tip))
}

// ⚠️ COMPUTER CONTROL ACTS ON THE SERVER'S MAC. providers.js -> computer-tools.js
// -> computer.js execFiles the native helper IN THE SERVER PROCESS, so the mouse
// that moves, the keys that get typed and the screen that is captured belong to
// the machine running Radiant — not the one you are typing into. Nothing in the
// UI said so. Tony: "if the devmbp is the host machine and im working on another
// Mac and i want to use computer control will it act on the devmbp or the machine
// im typing into?"
{
  const rf = await import('node:fs')
  const chat = rf.readFileSync('src/components/Chat.jsx', 'utf8')
  ok('the composer knows it may be driving another Mac', /const onAnotherMac = Boolean\(getServer\(\)\.base\)/.test(chat))
  // ⚠️ THE PROPERTY IS "THE PILL SAYS WHICH MACHINE", NOT "A .pill-where SPAN
  // EXISTS". The toggles became icon-only when the model name stopped fitting
  // beside them, so the host moved into the pill's clipped label — still the
  // button's accessible name, still read aloud, just no longer painted. Asserting
  // the class would have failed for a change that kept the property intact, which
  // is the failure mode of testing the mechanism instead of the promise.
  ok('and the computer pill still names it, in its accessible label',
     /pill-label'>computer \{session\.computerControl \? 'on' : 'off'\}[\s\S]{0,120}serverHost/.test(chat))
  ok('the tooltip names it too', /desktop of ' \+ \(onAnotherMac \? serverHost/.test(chat))

  const cfg = rf.readFileSync('server/config.js', 'utf8')
  ok('the server tells every screen its own name', /serverHost: serverHost\(\)/.test(cfg))

  // The chain that makes this true — if any link moves, re-check the wording.
  const ct = rf.readFileSync('server/computer-tools.js', 'utf8')
  ok('desktop tools still run server-side', /from '\.\/computer\.js'/.test(ct))
}

console.log(`\n  ${pass}/${pass + fail} passed`)
stop()
process.exit(fail ? 1 : 0)
