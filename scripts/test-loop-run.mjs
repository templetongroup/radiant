// The loop runner's server side, exercised against a Radiant this script starts.
//
// ⚠️ THE PUMP IS THE RISKIEST CODE IN THE FEATURE and none of it is reachable
// from the pure tests in test-loops.mjs: which step runs next, whether a fresh
// session is made for a retry, whether the attempt cap actually stops anything.
// All of that is decided from the transcript on disk, which means it can be
// tested by writing the transcript — no model, no key, no network.
//
// ⚠️ AND NOT ON PORT 5834. Radiant.app owns that whenever it is open, so a gate
// pointed there runs against the INSTALLED build and writes into Tony's real
// chats. Own server, own data directory — same rule as test-tasks.mjs.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'radiant-looprun-'))
const PORT = 5851
const B = `http://127.0.0.1:${PORT}`
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) },
  stdio: 'ignore'
})
const stop = () => { try { server.kill() } catch {}; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', stop)
let ready = false
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(B + '/api/version'); if (r.ok && (await r.json())?.version) { ready = true; break } } catch {}
  await new Promise(r => setTimeout(r, 250))
}
if (!ready) { console.log('  the test server never came up'); stop(); process.exit(1) }

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const j = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return r.json().catch(() => null)
}
/** Put words in the agent's mouth: what the turn would have written. */
const say = (sid, text) => {
  const f = join(dir, 'sessions', sid + '.json')
  const s = JSON.parse(readFileSync(f, 'utf8'))
  s.messages.push({ role: 'assistant', parts: [{ type: 'text', text }] })
  writeFileSync(f, JSON.stringify(s, null, 2))
}

// ── one loop, one failed check, one retry, one pass ─────────────────────────
const loop = await j('POST', '/api/loops', {
  title: 'Ship the parser',
  cwd: '/tmp',
  steps: [
    { title: 'Write it', check: 'the tests pass', maxAttempts: 2 },
    { title: 'Tidy up' }                       // deliberately unchecked
  ]
})
await j('POST', `/api/loops/${loop.id}/start`)

let a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('the first advance hands back work', a.action === 'work', a.action)
ok('the work prompt states the finish condition', a.prompt.includes('the tests pass'))
ok('and does not yet mention a failure', !/previous attempt/i.test(a.prompt))
const s1 = a.sessionId

say(s1, 'Done, I wrote the parser.')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('after the turn it asks for a check', a.action === 'check', a.action)
ok('the check runs where the work is', a.sessionId === s1)

say(s1, 'I looked at the suite.\nVERDICT: FAIL — the tests were never run')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('a failed check retries the step', a.action === 'work', a.action)
ok('the retry carries the reason', /the tests were never run/.test(a.prompt))
// ⚠️ A RETRY GETS A FRESH CONVERSATION. Reusing the session left the failed
// attempt in context and the model treated its own earlier answer as settled.
ok('the retry gets a fresh conversation', a.sessionId !== s1)
ok('the attempt count moved on', a.loop.steps[0].attempts === 2, String(a.loop.steps[0].attempts))

say(a.sessionId, 'Ran them this time.')
a = await j('POST', `/api/loops/${loop.id}/advance`)
say(a.sessionId, 'VERDICT: PASS')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('a passing check moves to the next step', a.action === 'work' && /Step 2 of 2/.test(a.prompt), a.action)
ok('the first step is recorded as passed', a.loop.steps[0].state === 'passed', a.loop.steps[0].state)

say(a.sessionId, 'Tidied.')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('an unchecked step finishes when its turn ends', a.action === 'done', a.action)
ok('and the loop is done', a.loop.state === 'done', a.loop.state)

// ── a step that can never pass has to stop ──────────────────────────────────
const l2 = await j('POST', '/api/loops', { title: 'Impossible', steps: [{ title: 'Do it', check: 'never', maxAttempts: 2 }] })
await j('POST', `/api/loops/${l2.id}/start`)
let tries = 0, ended = null
for (let i = 0; i < 12 && !ended; i++) {
  const r = await j('POST', `/api/loops/${l2.id}/advance`)
  if (r.action === 'work') { tries++; say(r.sessionId, 'tried'); continue }
  if (r.action === 'check') { say(r.sessionId, 'VERDICT: FAIL — still no'); continue }
  ended = r
}
ok('a step that cannot pass stops', ended?.action === 'failed', ended?.action)
ok('after exactly the attempts it was allowed', tries === 2, String(tries))
ok('and the step says why', /still no/.test(ended?.loop.steps[0].lastFail || ''), ended?.loop.steps[0].lastFail)

// ── a check that says it cannot be done stops at once ──────────────────────
// The a16z trace: the agent saw the wall on try 5 and was sent back 14 times.
const lb = await j('POST', '/api/loops', { title: 'Unreachable', steps: [{ title: 'Hit 100', check: 'score is 100', maxAttempts: 5 }] })
await j('POST', `/api/loops/${lb.id}/start`)
let rb = await j('POST', `/api/loops/${lb.id}/advance`); say(rb.sessionId, 'optimised everything I can reach')
rb = await j('POST', `/api/loops/${lb.id}/advance`); say(rb.sessionId, 'VERDICT: BLOCKED — the server adds 2 s of latency the code cannot change')
rb = await j('POST', `/api/loops/${lb.id}/advance`)
ok('a blocked check ends the run', rb.action === 'failed', rb.action)
ok('on the first attempt, not the fifth', rb.loop.steps[0].attempts === 1, String(rb.loop.steps[0].attempts))
ok('the step is marked blocked, with the reason', rb.loop.steps[0].blocked === true && /latency/.test(rb.loop.steps[0].lastFail), rb.loop.steps[0].lastFail)
ok('the loop carries the reason', /latency/.test(rb.loop.blockedReason || ''))
await j('POST', `/api/loops/${lb.id}/start`)
rb = await j('POST', `/api/loops/${lb.id}/advance`)
ok('running again clears it', !rb.loop.blockedReason && !rb.loop.steps[0].blocked)

// ⚠️ A CHECK THAT ANSWERS NEITHER WORD IS NOT A PASS. This is the failure that
// would make the whole layer worthless: the one case where the check did not
// happen is the one where it must not report the step done.
const l3 = await j('POST', '/api/loops', { title: 'Mumbles', steps: [{ title: 'Do it', check: 'x', maxAttempts: 1 }] })
await j('POST', `/api/loops/${l3.id}/start`)
let r3 = await j('POST', `/api/loops/${l3.id}/advance`); say(r3.sessionId, 'did it')
r3 = await j('POST', `/api/loops/${l3.id}/advance`); say(r3.sessionId, 'Looks fine to me!')
r3 = await j('POST', `/api/loops/${l3.id}/advance`)
ok('a check that never says PASS or FAIL is not a pass', r3.action === 'failed', r3.action)

// ── a run in flight is not editable ─────────────────────────────────────────
// Rewriting the steps leaves the index pointing at a step that no longer exists
// and the attempt counts belonging to prompts that are gone.
const l4 = await j('POST', '/api/loops', { title: 'Busy', steps: [{ title: 'a' }, { title: 'b' }] })
await j('POST', `/api/loops/${l4.id}/start`)
const edit = await j('PATCH', `/api/loops/${l4.id}`, { steps: [{ title: 'c' }] })
ok('a running loop refuses a step rewrite', Boolean(edit.error), JSON.stringify(edit).slice(0, 80))
await j('POST', `/api/loops/${l4.id}/stop`)
const edit2 = await j('PATCH', `/api/loops/${l4.id}`, { steps: [{ title: 'c' }] })
ok('and accepts it once stopped', edit2.steps?.length === 1 && edit2.steps[0].title === 'c')
// A loop with no steps could never run and could never be fixed from the UI.
const empty = await j('POST', '/api/loops', { title: 'Nothing', steps: [] })
ok('a loop with no steps is refused', Boolean(empty.error))
// An advance on a loop nobody started must not start one.
const idle = await j('POST', `/api/loops/${l4.id}/advance`)
ok('advancing a loop that is not running does nothing', idle.action === 'idle', idle.action)

// ── a command check settles a step without spending a model turn ───────────
//
// ⚠️ THIS IS THE WHOLE POINT OF THE DETERMINISTIC HALF. Before it, a step whose
// condition was "npm test exits 0" was decided by ASKING A MODEL whether npm
// test had exited 0 — the app recommending something a program could evaluate
// and then guessing at it. If this ever returns 'check', the command is being
// treated as advice.
const c1 = await j('POST', '/api/loops', {
  title: 'Deterministic', cwd: '/tmp',
  steps: [{ title: 'Do it', checkCommand: 'true' }, { title: 'And again', checkCommand: 'true' }]
})
await j('POST', `/api/loops/${c1.id}/start`)
let ca = await j('POST', `/api/loops/${c1.id}/advance`)
ok('a command-checked step still runs its work turn', ca.action === 'work', ca.action)
ok('and the work prompt names the command it will be held to', ca.prompt.includes('true'))
say(ca.sessionId, 'Done.')
ca = await j('POST', `/api/loops/${c1.id}/advance`)
ok('a passing command settles the step with no model check at all', ca.action === 'work', ca.action)
ok('and moves to the next step', ca.stepId === c1.steps[1].id)
say(ca.sessionId, 'Done.')
ca = await j('POST', `/api/loops/${c1.id}/advance`)
ok('the last passing command finishes the loop', ca.action === 'done', ca.action)

// ── a failing command retries, carrying its own output as the evidence ─────
const c2 = await j('POST', '/api/loops', {
  title: 'Red', cwd: '/tmp',
  steps: [{ title: 'Make it green', checkCommand: 'echo "expected 302, got 200" >&2; exit 3', maxAttempts: 2 }]
})
await j('POST', `/api/loops/${c2.id}/start`)
let cb = await j('POST', `/api/loops/${c2.id}/advance`)
say(cb.sessionId, 'I think that is fine.')
cb = await j('POST', `/api/loops/${c2.id}/advance`)
// ⚠️ 'work', NOT 'check'. A failing command must never buy a model turn to
// confirm what the shell already said.
ok('a failing command goes straight back to the work', cb.action === 'work', cb.action)
ok('the retry says what exit code it got', cb.prompt.includes('exited 3'), cb.prompt?.slice(0, 200))
ok('the retry carries the command output as evidence', cb.prompt.includes('expected 302, got 200'))
// ⚠️ AND IT IS SCOPED. Without this line the returned step grows: the agent
// opens the file, notices two adjacent problems and fixes those too, turning one
// known failure into several unverified ones.
ok('the retry is scoped to the step that failed', cb.prompt.includes('SCOPE:'))
say(cb.sessionId, 'Tried again.')
cb = await j('POST', `/api/loops/${c2.id}/advance`)
ok('a command that will not pass stops the loop at the cap', cb.action === 'failed', cb.action)
ok('and the step records what the command said',
   (cb.loop.steps[0].lastFail || '').includes('expected 302, got 200'))

// ── a command that cannot run is not a command that said no ───────────────
const c3 = await j('POST', '/api/loops', {
  title: 'Typo', cwd: '/tmp',
  steps: [{ title: 'Check it', checkCommand: 'nnpm test', maxAttempts: 1 }]
})
await j('POST', `/api/loops/${c3.id}/start`)
let cc = await j('POST', `/api/loops/${c3.id}/advance`)
say(cc.sessionId, 'Done.')
cc = await j('POST', `/api/loops/${c3.id}/advance`)
ok('a command that does not exist fails the step', cc.action === 'failed', cc.action)
// Through a shell that is exit 127, so it reads as a command that ran and said
// no — the honest thing is that the user still sees the shell's own words.
ok('and the reason quotes the shell', /not found|127/.test(cc.loop.steps[0].lastFail || ''),
   cc.loop.steps[0].lastFail)

// ── the goal check: every step passing is not the goal being met ───────────
//
// ⚠️ THE CEILING OF A STEP-WISE LOOP, EXERCISED. Each step here passes its own
// check on every pass. Only the goal check can see that the run still did not
// achieve anything, and only sending it back makes that a loop rather than a
// report.
const g1 = await j('POST', '/api/loops', {
  title: 'Reach the goal', cwd: '/tmp',
  steps: [{ title: 'Work' }],
  goalCommand: 'exit 1',
  maxPasses: 2
})
ok('a goal command is stored', g1.goalCommand === 'exit 1')
ok('and the pass count with it', g1.maxPasses === 2 && g1.pass === 1)
await j('POST', `/api/loops/${g1.id}/start`)
let ga = await j('POST', `/api/loops/${g1.id}/advance`)
say(ga.sessionId, 'Did the work.')
ga = await j('POST', `/api/loops/${g1.id}/advance`)
ok('a failed goal sends the run back to step one', ga.action === 'work', ga.action)
ok('and counts it as a second pass', ga.loop.pass === 2, String(ga.loop.pass))
ok('the second pass knows the goal was missed', ga.prompt.includes('pass 2 of 2'), ga.prompt?.slice(0, 300))
say(ga.sessionId, 'Did the work again.')
ga = await j('POST', `/api/loops/${g1.id}/advance`)
// ⚠️ THE CAP IS THE POINT. A goal that keeps failing must stop, or a loop that
// can never succeed runs until the money is gone.
ok('a goal that cannot be met stops at the pass cap', ga.action === 'failed', ga.action)
ok('and the loop records why it stopped', Boolean(ga.loop.lastGoalFail))
ok('with no failed STEP to blame, because none of them failed',
   !ga.loop.steps.some(x => x.state === 'failed'))

// ── a goal judged by an agent ──────────────────────────────────────────────
const g2 = await j('POST', '/api/loops', {
  title: 'Judged goal', cwd: '/tmp',
  steps: [{ title: 'Work' }],
  goalCheck: 'the report exists and has rows in it'
})
await j('POST', `/api/loops/${g2.id}/start`)
let gb = await j('POST', `/api/loops/${g2.id}/advance`)
say(gb.sessionId, 'Wrote it.')
gb = await j('POST', `/api/loops/${g2.id}/advance`)
ok('the goal check runs as its own turn', gb.action === 'check' && gb.goal === true, gb.action)
ok('in its own conversation, not the step\'s', gb.sessionId !== g2.steps[0].sessionId)
ok('and it is told not to re-judge the steps', /already passed/i.test(gb.prompt))
say(gb.sessionId, 'VERDICT: PASS')
gb = await j('POST', `/api/loops/${g2.id}/advance`)
ok('a passing goal finishes the loop', gb.action === 'done', gb.action)

// ── schedules are computed, never stored stale ─────────────────────────────
const sch = await j('POST', '/api/loops', {
  title: 'Hourly', steps: [{ title: 'a' }], schedule: { everyMinutes: 60 }
})
ok('a schedule is stored', sch.schedule?.everyMinutes === 60)
const listed = (await j('GET', '/api/loops')).find(l => l.id === sch.id)
ok('the list says when it runs next', typeof listed.nextRunAt === 'string')
// ⚠️ NOT DUE THE INSTANT IT IS SAVED. Asking for "hourly" and getting a run
// immediately reads as a bug, and is what counting from createdAt would do.
ok('and it is not due the moment you save it', listed.due === false)
const off = await j('PATCH', `/api/loops/${sch.id}`, { schedule: null })
ok('a schedule can be switched off', off.schedule === null)
const back = (await j('GET', '/api/loops')).find(l => l.id === sch.id)
ok('and then it is never due', back.due === false && back.nextRunAt === null)

stop()
console.log(`\n${pass}/${pass + fail} passed  ·  the loop retries what fails and stops when it cannot pass`)
process.exit(fail ? 1 : 0)
