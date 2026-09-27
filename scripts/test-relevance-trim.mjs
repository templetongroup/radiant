// Relevance trimming (providers.js setAsideStale + decide.js chooseStale):
// Jev decides which older tool results a task no longer needs, and only those
// are set aside. Unit half runs with a scripted judge; pass --live to also ask
// the real Jev (needs an OpenRouter key in ~/.radiant config).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setAsideStale, foldOldToolResults } from '../server/providers.js'
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
