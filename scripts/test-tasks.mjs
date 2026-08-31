// The board's server side, exercised against a running Radiant.
const B = 'http://127.0.0.1:5834'
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

console.log(`\n  ${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
