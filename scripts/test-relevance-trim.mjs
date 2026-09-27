// Relevance trimming (providers.js setAsideStale + decide.js chooseStale):
// Jev decides which older tool results a task no longer needs, and only those
// are set aside. Unit half runs with a scripted judge; pass --live to also ask
// the real Jev (needs an OpenRouter key in ~/.radiant config).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setAsideStale, setAsideTurns, foldOldToolResults, runTurn } from '../server/providers.js'
import http from 'node:http'
import { chooseStale, decide, STALE_BELOW } from '../server/decide.js'

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }

const big = (label, n = 900) => `${label}\n` + 'x'.repeat(n)
const tool = (name, args, result, round) => ({ type: 'tool', id: `${name}-${round}`, name, args, result, round })

function session () {
  const earlier = { role: 'assistant', parts: [
    tool('run_command', { command: 'ls -R' }, big('src/ lib/ test/ docs/ … a whole directory listing'), 0),
    tool('read_file', { path: 'src/auth.js' }, big('export function login() { /* the code being fixed */ }'), 1),
    tool('run_command', { command: 'echo ok' }, 'ok', 2) // too small to be worth a question
  ] }
  const current = { role: 'assistant', parts: [
    tool('web_search', { query: 'unrelated library docs' }, big('results about a library we did not use'), 0),
    tool('read_file', { path: 'README.md' }, big('# Project readme'), 1),
    tool('run_command', { command: 'npm test' }, big('FAIL login redirect loop'), 2),
    tool('read_file', { path: 'package.json' }, big('{ "name": "app" }'), 3),
    tool('run_command', { command: 'git log' }, big('commit history'), 4),
    tool('read_file', { path: 'src/session.js' }, big('session code'), 5),
    tool('read_file', { path: 'src/recent.js' }, big('this round is too recent to judge'), 9)
  ] }
  return { s: { messages: [{ role: 'user', text: 'Fix the login redirect loop in src/auth.js' }, earlier, { role: 'user', text: 'keep going' }, current], todos: [{ content: 'fix login', status: 'in_progress' }] }, current }
}

// ── the scripted judge: everything with "listing", "unrelated", "readme" or "history" is dead weight
{
  const { s, current } = session()
  const asked = []
  const notices = []
  const judge = async ({ task, plan, candidates }) => {
    asked.push({ task, plan, candidates })
    const stale = [], kept = []
    const dead = c => /listing|unrelated|readme|history/i.test(`${c.head} ${c.excerpt}`)
    for (const c of candidates) (dead(c) ? stale : kept).push({ key: c.key, p: dead(c) ? 0.08 : 0.9 })
    return { stale, kept }
  }
  const r = await setAsideStale({ session: s, assistant: current, round: 10, judgeRelevance: judge, emit: ev => notices.push(ev) })
  ok(r && r.judged === 8, `eight results are judged: big enough, not already judged, not in the last rounds (got ${r?.judged})`)
  const names = asked[0].candidates.map(c => c.head)
  ok(!names.includes('echo ok'), 'a result too small to matter is not asked about')
  ok(!names.includes('src/recent.js'), 'a result from the last few rounds is not asked about')
  ok(/login redirect loop/.test(asked[0].task) && /Latest: keep going/.test(asked[0].task) && /\[>\] fix login/.test(asked[0].plan), 'Jev is given the original request, the latest one, and the plan')
  const stale = s.messages.flatMap(m => m.parts || []).filter(p => p.stale).map(p => p.args.command || p.args.path || p.args.query)
  ok(JSON.stringify(stale.sort()) === JSON.stringify(['README.md', 'git log', 'ls -R', 'unrelated library docs'].sort()), `exactly the dead weight is set aside (got ${stale.join(', ')})`)
  ok(s.messages.flatMap(m => m.parts || []).filter(p => p.relevance != null).length === 8, 'every judged result keeps its verdict, so it is never asked about twice')
  ok(notices.length === 1 && /Set aside 4 earlier tool results this task no longer needs/.test(notices[0].text), 'the chat is told what was set aside')

  const folded = foldOldToolResults(s.messages)
  const all = folded.flatMap(m => m.parts || [])
  const listing = all.find(p => p.args?.command === 'ls -R')
  const auth = all.find(p => p.args?.path === 'src/auth.js')
  ok(/^\[Set aside: this earlier run_command \(ls -R\)/.test(listing.result), 'a set-aside result is sent as one line')
  ok(auth.result.includes('the code being fixed'), 'a result still needed keeps its content')
  ok(s.messages[1].parts[0].result.startsWith('src/ lib/'), 'the stored chat keeps the full result — only the request is lighter')

  const again = await setAsideStale({ session: s, assistant: current, round: 11, judgeRelevance: judge, emit: () => {} })
  ok(again === null && asked.length === 1, 'with nothing new to judge, Jev is not asked again')

  const { s: s2, current: c2 } = session()
  const down = await setAsideStale({ session: s2, assistant: c2, round: 10, judgeRelevance: async () => null, emit: () => {} })
  ok(down === null && !s2.messages.flatMap(m => m.parts || []).some(p => p.stale || p.relevance != null), 'Jev unreachable: nothing changes')
  const threw = await setAsideStale({ session: s2, assistant: c2, round: 10, judgeRelevance: async () => { throw new Error('boom') }, emit: () => {} })
  ok(threw === null, 'a judge that throws does not break the turn')
}

// ── the same call made again replaces the earlier copy, with no judge at all
{
  const early = tool('read_file', { path: 'src/a.js' }, big('old version of a.js'), 0)
  const late = tool('read_file', { path: 'src/a.js' }, big('new version of a.js'), 3)
  const other = tool('read_file', { path: 'src/a.js', offset: 40 }, big('a different range'), 4)
  const test1 = tool('run_command', { command: 'npm test' }, big('3 failed'), 1)
  const test2 = tool('run_command', { command: 'npm test' }, big('all passed'), 5)
  const cur = { role: 'assistant', parts: [early, test1, late, other, test2] }
  const s = { messages: [{ role: 'user', text: 'fix a.js' }, cur] }
  const notices = []
  let asked = 0
  const r = await setAsideStale({ session: s, assistant: cur, round: 20, judgeRelevance: async () => { asked++; return null }, emit: ev => notices.push(ev) })
  ok(early.stale === 'superseded' && test1.stale === 'superseded', 'an earlier read of the same file and an earlier identical test run are replaced')
  ok(!late.stale && !other.stale && !test2.stale, 'the latest copy stays, and a different range is not a copy')
  ok(asked === 0 && r?.superseded === 2, 'that needs no question to Jev')
  ok(/that a later, identical call replaced/.test(notices[0]?.text || ''), 'and the chat is told')
  ok(/^\[Replaced: a later, identical read_file \(src\/a\.js\)/.test(foldOldToolResults(s.messages)[1].parts[0].result), 'a replaced result is sent as one line saying so')
}

// ── whole exchanges about something else are set aside before any summary
{
  const u = text => ({ role: 'user', text })
  const a = (text, tools = []) => ({ role: 'assistant', parts: [...tools.map((n, i) => tool(n, { path: 'x' }, big('r'), i)), { type: 'text', text }] })
  const msgs = [
    u('Build the invoice export for the billing page'), a('Started on the CSV export', ['read_file']),
    u('Unrelated: what is a good name for my cat?'), a('How about Pixel or Mochi?'),
    u('Also, write me a haiku about autumn'), a('Leaves drift on cold wind…'),
    u('Back to the export: add the tax column'), a('Added the tax column', ['edit_file']),
    u('Now make the export include refunds'), a('Working on refunds', ['read_file', 'run_command'])
  ]
  const s = { messages: msgs.map(m => ({ ...m })) }
  let asked = null
  const judge = async ({ subject, task, candidates }) => {
    asked = { subject, task, candidates }
    const stale = [], kept = []
    for (const c of candidates) (/cat|haiku/i.test(c.excerpt) ? stale : kept).push({ key: c.key, p: /cat|haiku/i.test(c.excerpt) ? 0.05 : 0.92 })
    return { stale, kept }
  }
  const notes = []
  const r = await setAsideTurns({ session: s, assistant: null, judgeRelevance: judge, emit: e => notes.push(e.text) })
  ok(asked?.subject === 'exchange', 'Jev is asked about exchanges, not tool results')
  ok(asked.candidates.length === 2, `the first request and the last four messages are never candidates (asked about ${asked.candidates.length})`)
  ok(/refunds/.test(asked.task) && /invoice export/.test(asked.task), 'the task is the latest request, with how the conversation began')
  ok(r?.dropped === 2, `the cat and the haiku are set aside (got ${r?.dropped})`)
  const aside = s.messages.filter(m => m.setAside).map(m => m.text || m.parts?.at(-1)?.text)
  ok(aside.length === 4 && aside.every(t => /cat|Pixel|haiku|Leaves/.test(t)), 'each set aside whole: the request and its reply')
  ok(s.messages.length === 10, 'nothing is deleted from the saved chat')
  ok(/instead of summarizing/.test(notes[0] || ''), 'the chat is told, and why')
  ok(s.messages.slice(0, 2).every(m => !m.setAside) && s.messages.slice(-4).every(m => !m.setAside), 'the goal and the recent work stay')
  const again = await setAsideTurns({ session: s, assistant: null, judgeRelevance: judge, emit: () => {} })
  ok(again === null, 'exchanges already judged are not asked about again')
  const odd = { messages: [u('goal'), a('ok'), u('side'), a('r1'), a('r2 still going'), u('latest'), a('now')] }
  let got = null
  await setAsideTurns({ session: odd, assistant: null, judgeRelevance: async ({ candidates }) => { got = candidates; return { stale: [], kept: [] } }, emit: () => {} })
  ok(got === null || got.every(c => !/latest/.test(c.excerpt)), 'an exchange that runs into the recent messages is never split')
}

// ── end to end: a model that says "too long" gets the unrelated exchanges set aside, not a summary
{
  const bodies = []
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      bodies.push(b)
      if (/good name for my cat/.test(b)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'prompt is too long: 213456 tokens > 200000 maximum' } })) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Refunds are in the export now.' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n'); res.end()
    })
  })
  await new Promise(r => srv.listen(0, r))
  const port = srv.address().port
  const session = { id: 'e2e', cwd: os.tmpdir(), messages: [
    { role: 'user', text: 'Build the invoice export for the billing page' }, { role: 'assistant', parts: [{ type: 'text', text: 'Started the CSV export.' }] },
    { role: 'user', text: 'Unrelated: what is a good name for my cat?' }, { role: 'assistant', parts: [{ type: 'text', text: 'Pixel or Mochi.' }] },
    { role: 'user', text: 'Back to the export: add the tax column' }, { role: 'assistant', parts: [{ type: 'text', text: 'Added.' }] },
    { role: 'user', text: 'Sort the rows by date' }, { role: 'assistant', parts: [{ type: 'text', text: 'Sorted.' }] },
    { role: 'user', text: 'Now include refunds' }
  ] }
  let summarized = 0
  const events = []
  await runTurn({
    provider: { id: 'fakeco', type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` }, model: 'm1', apiKey: 'k', session, useTools: false,
    autoCompact: true, summarize: async () => { summarized++; return 'a summary' },
    judgeRelevance: async ({ candidates }) => ({ stale: candidates.filter(c => /cat/.test(c.excerpt)).map(c => ({ key: c.key, p: 0.05 })), kept: candidates.filter(c => !/cat/.test(c.excerpt)).map(c => ({ key: c.key, p: 0.9 })) }),
    emit: e => events.push(e), signal: AbortSignal.timeout(20000)
  })
  srv.close()
  const reply = session.messages.at(-1).parts?.find(p => p.type === 'text')?.text
  ok(reply === 'Refunds are in the export now.', `the turn goes on to answer (got ${JSON.stringify(reply)})`)
  ok(summarized === 0 && !events.some(e => e.type === 'compacted'), 'no summary was written')
  ok(events.some(e => e.type === 'notice' && /instead of summarizing/.test(e.text)), 'the chat says an exchange was set aside instead')
  ok(!/good name for my cat/.test(bodies.at(-1)) && /Build the invoice export/.test(bodies.at(-1)), 'the request that worked left out the cat, and kept the goal')
  ok(session.messages.some(m => m.setAside && /cat/.test(m.text || '')), 'the exchange is still in the saved chat, marked set aside')
}

// ── chooseStale turns Jev's answers into verdicts
{
  const fake = async ({ questions, state }) => ({ answers: Object.fromEntries(Object.keys(questions).map((k, i) => [k, { noul: i === 0 ? 0.1 : 0.8 }])), usage: {}, state })
  const r = await chooseStale({ task: 't', candidates: [{ key: 'a', name: 'x', head: 'h', excerpt: 'e' }, { key: 'b', name: 'y', head: 'h', excerpt: 'e' }], decideFn: fake, apiKey: 'k' })
  ok(r.stale.length === 1 && r.stale[0].key === 'a' && r.kept[0].key === 'b', `below ${STALE_BELOW} is set aside, above is kept`)
  ok(await chooseStale({ task: 't', candidates: [], decideFn: fake, apiKey: 'k' }) === null, 'no candidates, no request')
  ok(await chooseStale({ task: 't', candidates: [{ key: 'a' }], decideFn: fake, apiKey: '' }) === null, 'no key, no request')
}

// ── the real Jev, on a realistic case
if (process.argv.includes('--live')) {
  let key = process.env.OPENROUTER_API_KEY
  try { key ||= JSON.parse(fs.readFileSync(path.join(os.homedir(), '.radiant', 'config.json'), 'utf8')).keys?.openrouter } catch {}
  if (!key) { console.log('  (live: no OpenRouter key — skipped)') } else {
    const t0 = Date.now()
    const r = await chooseStale({
      task: 'Fix the bug where logging in redirects forever between /login and /dashboard. The cause is in src/auth.js.',
      plan: '[x] reproduce the loop\n[>] fix the redirect check in src/auth.js\n[ ] run the tests',
      recent: 'The loop comes from requireAuth() redirecting when session.user is undefined right after login. Fixing the check now.',
      candidates: [
        { key: 'listing', name: 'run_command', head: 'ls -R', excerpt: 'src/\n  auth.js\n  session.js\n  routes/\nnode_modules/ …\ndocs/\n  CHANGELOG.md\ntest/\n  auth.test.js' },
        { key: 'auth', name: 'read_file', head: 'src/auth.js', excerpt: 'export function requireAuth(req, res, next) {\n  if (!req.session.user) return res.redirect("/login")\n  next()\n}\nexport function login(req, res) {\n  req.session.userId = user.id\n  res.redirect("/dashboard")\n}' },
        { key: 'changelog', name: 'read_file', head: 'docs/CHANGELOG.md', excerpt: '## 1.4.0\n- New dark theme\n- Faster image uploads\n## 1.3.2\n- Fixed a typo in the footer' },
        { key: 'failing', name: 'run_command', head: 'npm test -- auth', excerpt: 'FAIL test/auth.test.js\n  ✕ logs in without a redirect loop (redirected 20 times)\nTests: 1 failed, 11 passed' },
        { key: 'search', name: 'web_search', head: 'best css grid tutorial', excerpt: '1. CSS Grid guide … 2. Learn grid in 5 minutes …' }
      ],
      decideFn: decide,
      apiKey: key
    })
    const turns = await chooseStale({
      subject: 'exchange',
      task: 'Now make the invoice export include refunds.\n\n(The conversation began with: Build the invoice CSV export for the billing page)',
      candidates: [
        { key: 'tax', name: 'exchange', head: '', excerpt: 'Request: Back to the export: add the tax column\nReply: Added a tax column to exportInvoices() and a test for it.\nTools used: read_file, edit_file, run_command' },
        { key: 'cat', name: 'exchange', head: '', excerpt: 'Request: Unrelated: what is a good name for my cat?\nReply: How about Pixel or Mochi?' },
        { key: 'haiku', name: 'exchange', head: '', excerpt: 'Request: Write me a haiku about autumn\nReply: Leaves drift on cold wind…' },
        { key: 'schema', name: 'exchange', head: '', excerpt: 'Request: What columns does the invoices table have?\nReply: id, customer_id, amount, tax, status, refunded_at.\nTools used: run_command' }
      ],
      decideFn: decide,
      apiKey: key
    })
    if (turns) {
      const q = k => [...turns.stale, ...turns.kept].find(v => v.key === k)?.p?.toFixed(2)
      console.log(`  live Jev, exchanges: tax column ${q('tax')}, invoices schema ${q('schema')}, cat name ${q('cat')}, haiku ${q('haiku')}`)
      const st = turns.stale.map(v => v.key)
      ok(st.includes('cat') && st.includes('haiku') && !st.includes('tax') && !st.includes('schema'), 'live: the off-topic exchanges go, the ones the task builds on stay')
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (!r) { console.log('  (live: Jev did not answer — skipped)') } else {
      const staleKeys = r.stale.map(v => v.key)
      const p = k => [...r.stale, ...r.kept].find(v => v.key === k)?.p?.toFixed(2)
      console.log(`  live Jev (${secs} s): listing ${p('listing')}, auth.js ${p('auth')}, changelog ${p('changelog')}, failing test ${p('failing')}, off-topic search ${p('search')}`)
      ok(!staleKeys.includes('auth') && !staleKeys.includes('failing'), 'live: the file being fixed and the failing test are kept')
      ok(staleKeys.includes('changelog') && staleKeys.includes('search'), 'live: an unrelated changelog and an off-topic search are set aside')
    }
  }
}

console.log(`\n${pass}/${pass + fail} passed  ·  old tool results are kept or set aside by whether the task still needs them`)
process.exit(fail ? 1 : 0)
