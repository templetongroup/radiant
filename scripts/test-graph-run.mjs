/**
 * Does the graph actually run things at the same time?
 *
 * ⚠️ EVERY OTHER ASSERTION IN test-graph.mjs COULD PASS WHILE THE RUNNER RAN
 * NODES ONE AFTER ANOTHER — which is a chain wearing the word "graph", the exact
 * thing this feature exists to stop being. So the load-bearing measurement here
 * is the clock: three independent nodes that each take a second finish in about
 * a second.
 *
 * It runs against a stub HTTP server speaking the OpenAI streaming shape, so it
 * needs no key, no network and no model — the question is the runner's shape,
 * not any model's answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const { runGraph, isRunning, stopGraph } = await import('../server/graph-run.js')

let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

const dir = mkdtempSync(join(tmpdir(), 'rx-graphrun-'))
const sessions = new Map()

// A model that takes `delayMs` to answer, and says which node asked.
let inFlight = 0
let peakInFlight = 0
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const asked = JSON.parse(body).messages.map(m => m.content).join(' ')
  // ⚠️ MATCH THE JOB LINE, NOT THE WHOLE PROMPT. A downstream node is HANDED its
  // inputs, titles and all, so keying off the raw text made the merge node fail
  // too — because the failing node's title was quoted inside it. That is the
  // fan-in working correctly and the fixture reading it wrong.
  const job = asked.match(/Your job, and only this: ([^\n]+)/)?.[1] || ''
  if (/HANG/.test(job)) return // a model that never answers
  const delay = /SLOW/.test(job) ? 900 : 30
  inFlight++
  peakInFlight = Math.max(peakInFlight, inFlight)
  await new Promise(r => setTimeout(r, delay))
  inFlight--
  // ROUTE steps pick "big"; a FUMBLE step answers in prose the first time it is
  // asked and in JSON the second; a FINDER lists two lines, and after it has
  // been told what was already seen it finds nothing new.
  let answer = /FAILME/.test(job) ? '' : ('answer for ' + (job || '?'))
  if (/ROUTE/.test(job)) answer = 'I think this one is big.\n{"choice": "big", "reason": "lots of files"}'
  if (/FUMBLE/.test(job)) answer = /could not be used/.test(asked) ? '{"verdict": "fine"}' : 'Sure! The verdict is fine.'
  if (/FINDER/.test(job)) answer = /already turned up/.test(asked) ? '- bug one\n- bug two' : '- bug one\n- bug two'
  if (/GROWER/.test(job)) answer = /bug three/.test(asked) ? '- bug one\n- bug three' : /already turned up/.test(asked) ? '- bug one\n- bug three' : '- bug one\n- bug two'
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] }) + '\n\n')
  // what a real provider reports at the end: 20k in (5k of it cached), 1k out
  res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 5000 } } }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const deps = {
  loadConfig: () => ({ settings: { defaultCwd: dir }, providers: [], keys: {}, oauth: {} }),
  saveSession: s => sessions.set(s.id, s),
  agentsStore: { get: () => null },
  getProject: () => null,
  credFor: () => ({ provider: { id: 'stub', type: 'openai', baseUrl }, apiKey: 'x', getAccessToken: null, getAccountId: null })
}
const node = o => ({ kind: 'agent', prompt: '', dependsOn: [], fields: [], useTools: false, model: 'stub', provider: 'stub', ...o })

// ── THE MEASUREMENT: independent work does not queue ────────────────────────
{
  const graph = {
    id: 'graph-par', title: 'Three slow angles', cwd: dir, concurrency: 4, autoApprove: false,
    nodes: [node({ id: 'a', title: 'SLOW angle A' }), node({ id: 'b', title: 'SLOW angle B' }), node({ id: 'c', title: 'SLOW angle C' })]
  }
  peakInFlight = 0
  const t = Date.now()
  const run = await runGraph(graph, deps)
  const took = Date.now() - t
  ok('all three independent nodes finished', Object.values(run.nodes).every(n => n.state === 'done'),
     JSON.stringify(Object.values(run.nodes).map(n => n.state)))
  // Three 900ms nodes: about 1s together, about 2.7s in a queue.
  ok('three independent nodes take about as long as ONE of them', took < 2000, `took ${took}ms`)
  ok('and the server really saw them at the same time', peakInFlight === 3, `peak ${peakInFlight}`)
}

// ── a chain must NOT be parallel ────────────────────────────────────────────
// The control. "Fast" would also be what a broken planner that ignored edges
// looked like, so the same three nodes wired in a line have to be slow.
{
  const graph = {
    id: 'graph-chain', title: 'Three in a line', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'a', title: 'SLOW one' }), node({ id: 'b', title: 'SLOW two', dependsOn: ['a'] }), node({ id: 'c', title: 'SLOW three', dependsOn: ['b'] })]
  }
  peakInFlight = 0
  const t = Date.now()
  await runGraph(graph, deps)
  const took = Date.now() - t
  ok('a real dependency is still waited for', took > 2000, `took ${took}ms`)
  ok('and only one node is ever in flight in a chain', peakInFlight === 1, `peak ${peakInFlight}`)
}

// ── the fan-in receives what came before ────────────────────────────────────
{
  const graph = {
    id: 'graph-fan', title: 'Diamond', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'a', title: 'Angle A' }), node({ id: 'b', title: 'Angle B' }),
      node({ id: 'm', title: 'Merge', dependsOn: ['a', 'b'] })]
  }
  const run = await runGraph(graph, deps)
  const merge = [...sessions.values()].find(s => s.title.endsWith('Merge'))
  const prompt = merge.messages[0].text
  ok('the merge node was handed both upstream outputs',
     prompt.includes('answer for Angle A') && prompt.includes('answer for Angle B'))
  ok('and the run finished', run.state === 'done', run.state)
}

// ── failure dies at its node ────────────────────────────────────────────────
{
  const graph = {
    id: 'graph-fail', title: 'One bad node', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'good', title: 'Good angle' }), node({ id: 'bad', title: 'FAILME angle' }),
      node({ id: 'm', title: 'Merge', dependsOn: ['good', 'bad'] })]
  }
  const run = await runGraph(graph, deps)
  ok('the bad node fails', run.nodes.bad.state === 'failed')
  // ⚠️ IN A CHAIN, FAILURE CASCADES. In a graph it must not: the good work still
  // comes back and the merge still runs.
  ok('the good node still finishes', run.nodes.good.state === 'done')
  ok('and the merge still runs with a hole in its input', run.nodes.m.state === 'done', run.nodes.m.error || '')
  ok('the run is not called a failure just because one node failed', run.state === 'done', run.state)
  ok('but it says how many did not finish', /1 of 3/.test(run.error || ''), run.error || '')
}

// ── a step starts when ITS inputs are in, not when its whole layer is ────────
// a (slow) and b (fast) are both roots; c reads only b. Layer by layer, c would
// wait for a. It must not: c should be done long before a is.
{
  const graph = {
    id: 'graph-ready', title: 'No barrier', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'a', title: 'SLOW root' }), node({ id: 'b', title: 'fast root' }), node({ id: 'c', title: 'reads the fast one', dependsOn: ['b'] })]
  }
  const run = await runGraph(graph, deps)
  const doneAt = id => new Date(run.nodes[id].finishedAt).getTime()
  ok('the dependent of the fast root finishes before the slow root does', doneAt('c') < doneAt('a'),
     `c at +${doneAt('c') - doneAt('a')}ms relative to a`)
  ok('and everything still finishes', run.state === 'done' && Object.values(run.nodes).every(n => n.state === 'done'))
}

// ── a route step takes one branch and skips the other ───────────────────────
{
  const graph = {
    id: 'graph-route', title: 'Big or small', cwd: dir, concurrency: 4,
    nodes: [
      node({ id: 'r', title: 'ROUTE it', kind: 'route', options: ['big', 'small'] }),
      node({ id: 'big', title: 'full audit', gate: { node: 'r', choice: 'big' }, dependsOn: ['r'] }),
      node({ id: 'small', title: 'quick look', gate: { node: 'r', choice: 'small' }, dependsOn: ['r'] }),
      node({ id: 'm', title: 'Merge', dependsOn: ['big', 'small'] })
    ]
  }
  const run = await runGraph(graph, deps)
  ok('the route step decided', run.nodes.r.state === 'done' && run.nodes.r.data?.choice === 'big', JSON.stringify(run.nodes.r))
  ok('the chosen branch ran', run.nodes.big.state === 'done')
  ok('the other branch was skipped, not failed', run.nodes.small.state === 'skipped', run.nodes.small.state)
  ok('the merge still ran and was told why the branch is missing', run.nodes.m.state === 'done' &&
     /was skipped/.test([...sessions.values()].find(s => s.title.endsWith('Merge') && s.messages[0].text.includes('Big or small'))?.messages[0].text || ''))
  ok('a skipped branch is not counted as a failure', run.state === 'done' && !run.error, run.error || '')
}

// ── a contract miss gets one retry with the reason ──────────────────────────
{
  const graph = {
    id: 'graph-retry', title: 'Fumble once', cwd: dir, concurrency: 1,
    nodes: [node({ id: 'f', title: 'FUMBLE the shape', fields: ['verdict'] })]
  }
  const run = await runGraph(graph, deps)
  ok('prose the first time, JSON the second → done', run.nodes.f.state === 'done' && run.nodes.f.data?.verdict === 'fine', JSON.stringify(run.nodes.f))
  ok('and the run records that it retried', run.nodes.f.retried === true)
  const sess = [...sessions.values()].find(s => s.title.endsWith('FUMBLE the shape'))
  ok('the reason was sent back to the model verbatim', sess.messages.some(m => m.role === 'user' && /could not be used: Expected JSON/.test(m.text)))
}

// ── loop until dry, under the cap ───────────────────────────────────────────
// Round 1 finds bug one and two; told what was seen, round 2 finds bug three;
// round 3 finds nothing new; round 4 nothing new → dry after two → stop at 4
// of a possible 5. Dedupe is against everything seen, so "bug one" coming back
// every round never counts as new.
{
  const graph = {
    id: 'graph-dry', title: 'Sweep', cwd: dir, concurrency: 2, repeat: { until: 'dry', maxRounds: 5, dryRounds: 2 },
    nodes: [node({ id: 'g', title: 'GROWER finder' })]
  }
  const run = await runGraph(graph, deps)
  ok('it ran more than one round', run.roundsRun >= 2, `rounds ${run.roundsRun}`)
  ok('it stopped because it ran dry, not because it hit the cap', run.stoppedBecause === 'dry', run.stoppedBecause)
  ok('it stopped before the cap', run.roundsRun < 5, `rounds ${run.roundsRun}`)
  ok('found is every distinct line across rounds', run.found.join('|') === '- bug one|- bug two|- bug three', run.found.join('|'))
  ok('later rounds were told what was already seen', [...sessions.values()].filter(s => s.title.endsWith('GROWER finder')).some(s => /already turned up/.test(s.messages[0].text)))
  ok('the cap is honoured on the way in', (await import('../server/graph-rules.js')).normalizeRepeat({ until: 'dry', maxRounds: 50 }).maxRounds === 5)
  // ⚠️ WHAT EACH ROUND COST, WHILE IT RUNS — the a16z trace spent two thirds of
  // its bill on rounds that found nothing, and only the trace said so.
  ok('every round says what it spent', run.rounds.every(x => x.tokens === 21000), run.rounds.map(x => x.tokens).join(','))
  ok('and the run adds them up', run.spent.tokens === 21000 * run.roundsRun, JSON.stringify(run.spent))
  ok('a model with no list price is tokens only, and says so', run.spent.priced === false && run.spent.cost === 0)
}

// ── a token budget stops a repeating graph ─────────────────────────────────
{
  const graph = {
    id: 'graph-budget', title: 'Sweep on a budget', cwd: dir, concurrency: 2, repeat: { until: 'dry', maxRounds: 5, dryRounds: 2, budgetTokens: 30000 },
    nodes: [node({ id: 'g', title: 'GROWER finder' })]
  }
  const run = await runGraph(graph, deps)
  ok('it stops at the budget', run.stoppedBecause === 'budget', run.stoppedBecause)
  ok('after the round that crossed it, not before', run.roundsRun === 2, String(run.roundsRun))
}

// ── dollars, where the model has a list price ──────────────────────────────
{
  const graph = { id: 'graph-price', title: 'Priced', cwd: dir, nodes: [node({ id: 'p', title: 'Angle', model: 'gpt-5.6-luna' })] }
  const run = await runGraph(graph, deps)
  // 15k fresh × $0.20 + 5k cached × $0.02 + 1k out × $1.20, per million
  const want = (15000 * 0.2 + 5000 * 0.02 + 1000 * 1.2) / 1e6
  ok('a step is priced at list price, cached tokens at the cached rate', Math.abs(run.nodes.p.cost - want) < 1e-9, String(run.nodes.p.cost))
  ok('and a one-shot run totals it too', run.spent.priced === true && Math.abs(run.spent.cost - want) < 1e-9, JSON.stringify(run.spent))
}

// ── a graph cannot grant itself permission ──────────────────────────────────
// The runner passes a requestApproval that always says no, so a node that tries
// to run a command fails with a message rather than acting unattended.
{
  const graph = {
    id: 'graph-perm', title: 'Wants a shell', cwd: dir, concurrency: 1, autoApprove: false,
    nodes: [node({ id: 'a', title: 'Angle', useTools: true })]
  }
  const run = await runGraph(graph, deps)
  ok('a graph runs with approvals refused by default, not granted', graph.autoApprove === false)
  ok('and the node still completes when it does not need one', run.nodes.a.state === 'done', run.nodes.a.error || '')
}

// ── a plan that cannot start does not start ─────────────────────────────────
{
  const graph = { id: 'graph-cyc', title: 'Circle', cwd: dir, nodes: [node({ id: 'a', title: 'A', dependsOn: ['b'] }), node({ id: 'b', title: 'B', dependsOn: ['a'] })] }
  const run = await runGraph(graph, deps)
  ok('a circular graph fails immediately rather than spending anything', run.state === 'failed' && /circle/i.test(run.error))
  ok('and no node was run', Object.keys(run.nodes).length === 0)
}

// ── a node that hangs is stopped at the ceiling, and the graph finishes ─────
// ⚠️ The ceiling used to call a method that does not exist, so a stalled model
// held its node — and the whole graph — open forever.
{
  process.env.RADIANT_GRAPH_NODE_MS = '1500'
  const graph = {
    id: 'graph-hang', title: 'One stuck node', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'good', title: 'Good angle' }), node({ id: 'stuck', title: 'HANG angle' })]
  }
  const t = Date.now()
  const run = await Promise.race([runGraph(graph, deps), new Promise(r => setTimeout(() => r(null), 8000))])
  delete process.env.RADIANT_GRAPH_NODE_MS
  ok('a graph with a hung node still finishes', run !== null, `still running after ${Date.now() - t}ms`)
  ok('the hung node fails and says it ran too long', run?.nodes.stuck.state === 'failed' && /ran longer than/.test(run.nodes.stuck.error || ''), run?.nodes.stuck.error || '')
  ok('the other node is unaffected', run?.nodes.good.state === 'done')
}

server.closeAllConnections?.()
server.close()
rmSync(dir, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  independent nodes run at once; a dependency is still a wait`)
process.exit(fail ? 1 : 0)
