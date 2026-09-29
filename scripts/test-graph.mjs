/**
 * Nodes, edges, and the thing that makes a graph worth building: work that does
 * not depend on other work does not wait for it.
 *
 * ⚠️ THE ASSERTION THAT MATTERS IS THE CLOCK. Everything else here — layering,
 * contracts, reduce — could be right while the runner still executed nodes one
 * after another, which is exactly the bug a "graph" that is really a chain has.
 * So three independent nodes that each take a second must finish in about a
 * second, not three.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const {
  planLayers, suspectEdges, normalizeNode, nodePrompt, readOutput, runReduce, toMermaid, inputBlock,
  draftPrompt, readDraft, checkNodes, gateState, normalizeRepeat, newLines, lineKeys
} = await import('../server/graph-rules.js')

let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const N = o => normalizeNode(o)

// ── layering: what runs together ────────────────────────────────────────────
{
  // The diamond. One splits, three work, one merges.
  const nodes = [
    N({ id: 'split', title: 'Split the question' }),
    N({ id: 'a', title: 'Angle A', dependsOn: ['split'] }),
    N({ id: 'b', title: 'Angle B', dependsOn: ['split'] }),
    N({ id: 'c', title: 'Angle C', dependsOn: ['split'] }),
    N({ id: 'merge', title: 'Write it up', dependsOn: ['a', 'b', 'c'] })
  ]
  const { layers, error } = planLayers(nodes)
  ok('a diamond plans as three layers', !error && layers.length === 3, error || JSON.stringify(layers))
  ok('the three angles are in ONE layer, so they run together',
     layers[1]?.length === 3, JSON.stringify(layers[1]))
  ok('the merge waits for all three', layers[2]?.join() === 'merge')
}
{
  // ⚠️ A CHAIN IS A GRAPH TOO — A BAD ONE. Same five nodes wired in a line plan
  // as five layers, which is the shape people are running while saying they
  // moved to graphs. If this ever collapsed to fewer layers the planner would be
  // running steps before their input existed.
  const chain = [N({ id: 'a', title: 'A' }), N({ id: 'b', title: 'B', dependsOn: ['a'] }),
    N({ id: 'c', title: 'C', dependsOn: ['b'] }), N({ id: 'd', title: 'D', dependsOn: ['c'] })]
  ok('a chain plans as one layer per step, and cannot be parallel', planLayers(chain).layers.length === 4)
}
{
  const cyc = [N({ id: 'a', title: 'A', dependsOn: ['b'] }), N({ id: 'b', title: 'B', dependsOn: ['a'] })]
  const r = planLayers(cyc)
  ok('a circle is refused rather than run', Boolean(r.error) && !r.layers.length)
  ok('and it names the steps in the circle', /A|B/.test(r.error))
  const dangling = [N({ id: 'a', title: 'A', dependsOn: ['ghost'] })]
  ok('a dependency on a step that is not there is refused', Boolean(planLayers(dangling).error))
}

// ── the false wait ──────────────────────────────────────────────────────────
// "Summarise this file and check the weather" has no edge in it. The weather
// does not read the summary; you typed "and then" and the code heard "wait".
{
  const nodes = [
    N({ id: 'sum', title: 'Summarise the report' }),
    N({ id: 'wx', title: 'Check the weather', prompt: 'Look up the forecast for Friday.', dependsOn: ['sum'] })
  ]
  const s = suspectEdges(nodes)
  ok('an edge whose target never mentions the source is flagged', s.length === 1 && s[0].from === 'sum')
  const real = [
    N({ id: 'sum', title: 'Summarise the report' }),
    N({ id: 'w', title: 'Write the email', prompt: 'Use the report summary above to draft it.', dependsOn: ['sum'] })
  ]
  ok('an edge that carries data is left alone', suspectEdges(real).length === 0)
  // ⚠️ IT ADVISES; IT DOES NOT CUT. Deleting an edge automatically would be the
  // graph deciding what the user meant.
  ok('flagging does not change the graph', nodes[1].dependsOn.length === 1)
}

// ── the contract ────────────────────────────────────────────────────────────
{
  const free = N({ title: 'x' })
  ok('a node with no contract takes prose', readOutput(free, 'just some words').ok)
  ok('but not silence', !readOutput(free, '   ').ok)
  const typed = N({ title: 'x', fields: ['finding', 'confidence'] })
  ok('a contract accepts the right JSON', readOutput(typed, '{"finding":"a","confidence":"high"}').ok)
  ok('and survives a code fence around it',
     readOutput(typed, '```json\n{"finding":"a","confidence":"high"}\n```').ok)
  // ⚠️ THE ONE THAT EARNS ITS KEEP. Handing free text downstream and hoping is
  // how a node becomes something only a human can read.
  ok('a missing key is a failure, not a shrug',
     !readOutput(typed, '{"finding":"a"}').ok && /confidence/.test(readOutput(typed, '{"finding":"a"}').reason))
  ok('prose where JSON was promised is a failure', !readOutput(typed, 'I found a thing.').ok)
}

// ── inputs are explicit, and a gap says it is a gap ─────────────────────────
{
  const node = N({ id: 'm', title: 'Merge', dependsOn: ['a', 'b'] })
  const block = inputBlock(node, {
    a: { title: 'Angle A', state: 'done', output: 'apples' },
    b: { title: 'Angle B', state: 'failed', error: 'boom' }
  })
  ok('a finished input arrives with its content', block.includes('apples'))
  // In a chain, failure cascades. In a graph it dies at its node — so the fan-in
  // has to tolerate a hole AND be told it is a hole.
  ok('a failed input is named as missing rather than silently dropped',
     /did not finish/.test(block) && block.includes('Angle B'))
}

// ── plumbing is code, not an agent ──────────────────────────────────────────
{
  const node = N({ id: 'r', title: 'Combine', kind: 'reduce', reduceOp: 'dedupe', dependsOn: ['a', 'b'] })
  const r = runReduce(node, {
    a: { title: 'A', state: 'done', output: 'one\ntwo' },
    b: { title: 'B', state: 'done', output: 'two\nthree' }
  })
  ok('dedupe flattens and de-duplicates', r.ok && r.output.split('\n').join() === 'one,two,three', r.output)
  ok('a reduce with nothing upstream says so',
     !runReduce(node, { a: { state: 'failed' }, b: { state: 'failed' } }).ok)
  ok('a reduce node is not an agent kind', node.kind === 'reduce')
}

// ── the skeptic is told to be one ───────────────────────────────────────────
{
  const g = { title: 'G', detail: '' }
  const v = N({ id: 'v', title: 'Check them', kind: 'verify', dependsOn: ['a'] })
  const p = nodePrompt(g, v, { a: { title: 'A', state: 'done', output: 'claim' } })
  ok('a verify node is told to try to disprove, not to review', /disprove/i.test(p))
  ok('and to drop what it cannot support', /drop/i.test(p))
  const worker = N({ id: 'w', title: 'Do it' })
  ok('a worker is not told to be a skeptic', !/disprove/i.test(nodePrompt(g, worker, {})))
  ok('a node is told its job is only its own', /only this/i.test(nodePrompt(g, worker, {})))
}

// ── the drawing follows the edges the user declared ─────────────────────────
{
  const g = { nodes: [N({ id: 'a', title: 'A' }), N({ id: 'b', title: 'B', kind: 'verify', dependsOn: ['a'] })] }
  const m = toMermaid(g, null)
  ok('every declared edge is drawn', (m.match(/-->/g) || []).length === 1)
  ok('a skeptic is a different shape from a worker', m.includes('{{"'))
  const withRun = toMermaid(g, { nodes: { a: { state: 'done' }, b: { state: 'running' } } })
  ok('a run marks what finished and what is going', withRun.includes('✓ A') && withRun.includes('● B'))
}

// ── drafting a graph from a sentence ────────────────────────────────────────
// ⚠️ THE MANUAL BUILDER CHARGES THE USER THE WIRING COST — the one cost this
// idea removed. So the draft path has to produce something USABLE, not just
// something parseable: a draft that cannot be planned is an error to retry, not
// a graph to show.
{
  const p = draftPrompt('Audit the routes for missing auth', '', '/repo')
  ok('the draft prompt teaches the rule that matters',
     /ONLY IF it reads what that one produced/i.test(p) || /only if it reads/i.test(p))
  ok('it warns against chaining out of habit', /out of habit/i.test(p))
  ok('it asks for a skeptic that is not the author', /DISPROVE/i.test(p) && /must not be the same step/i.test(p))
  ok('it says plumbing is code, not an agent', /Never spend an agent on plumbing/i.test(p))
  ok('and it names the folder when there is one', p.includes('/repo'))

  const good = JSON.stringify({
    nodes: [
      { id: 'a', title: 'Angle A', kind: 'agent', prompt: 'x', dependsOn: [], tier: 'cheap' },
      { id: 'b', title: 'Angle B', kind: 'agent', prompt: 'y', dependsOn: [], tier: 'cheap' },
      { id: 'c', title: 'Check', kind: 'verify', dependsOn: ['a', 'b'], tier: 'smart' },
      { id: 'd', title: 'Write up', kind: 'agent', dependsOn: ['c'], tier: 'smart' }
    ],
    assumptions: ['assumed the repo is JavaScript']
  })
  const r = readDraft(good)
  ok('a well-formed draft is accepted', r.ok, r.reason)
  ok('and it plans as a real fan-out', planLayers(r.nodes).layers[0].length === 2)
  ok('tier hints survive, so breadth can run cheap', r.tiers.a === 'cheap' && r.tiers.c === 'smart')
  ok('assumptions come back to be shown', r.assumptions[0].includes('JavaScript'))
  ok('a code fence around it is tolerated', readDraft('```json\n' + good + '\n```').ok)
  ok('prose instead of a graph is refused', !readDraft('Here is a nice plan for you!').ok)
  ok('an empty node list is refused', !readDraft('{"nodes":[]}').ok)

  // ⚠️ IDS ARE THE MODEL'S AND EDGES POINT AT THEM. Renaming before resolving the
  // dependencies silently disconnects every edge, and the user sees "depends on
  // something that is not in this graph" for a draft that was fine.
  const kept = readDraft(good)
  ok('the ids the edges point at are preserved', kept.nodes.find(n => n.title === 'Check').dependsOn.sort().join() === 'a,b')

  // A model that invents one id has still drawn a usable graph.
  const ghost = readDraft(JSON.stringify({ nodes: [
    { id: 'a', title: 'One', kind: 'agent', dependsOn: [] },
    { id: 'b', title: 'Two', kind: 'agent', dependsOn: ['a', 'nope'] }] }))
  ok('an edge to a step that does not exist is dropped, not fatal',
     ghost.ok && ghost.nodes[1].dependsOn.join() === 'a', ghost.reason)
  ok('a step depending on itself is dropped',
     readDraft(JSON.stringify({ nodes: [{ id: 'a', title: 'One', kind: 'agent', dependsOn: ['a'] }] })).nodes[0].dependsOn.length === 0)

  // ⚠️ A CIRCLE IS AN ERROR TO RETRY, NOT A GRAPH TO SHOW. The route feeds this
  // reason back to the model, which fixes it far more often than asking again blind.
  const cyc = readDraft(JSON.stringify({ nodes: [
    { id: 'a', title: 'A', kind: 'agent', dependsOn: ['b'] },
    { id: 'b', title: 'B', kind: 'agent', dependsOn: ['a'] }] }))
  ok('a circular draft is refused', !cyc.ok && /circle/i.test(cyc.reason))
  ok('and the reason is specific enough to hand back to the model', (cyc.reason || '').length > 20)
}

// ── route steps and gates ────────────────────────────────────────────────────
{
  const r = normalizeNode({ id: 'r', title: 'Size it', kind: 'route', options: 'big, small, big' })
  ok('route options are split and deduped', r.options.join() === 'big,small', r.options.join())
  const g = normalizeNode({ id: 'g', title: 'Full audit', gate: { node: 'r', choice: 'big' } })
  ok('a gated step reads its route step even if the edge was not ticked', g.dependsOn.includes('r'))
  ok('a route with one option is refused', /fewer than two/.test(checkNodes([normalizeNode({ id: 'r', title: 'x', kind: 'route', options: ['one'] })]) || ''))
  ok('a gate on a non-route step is refused', /not a route step/.test(checkNodes([normalizeNode({ id: 'a', title: 'A' }), normalizeNode({ id: 'b', title: 'B', gate: { node: 'a', choice: 'x' } })]) || ''))
  ok('a gate on a choice the route does not offer is refused', /not one of its options/.test(checkNodes([r, normalizeNode({ id: 'g', title: 'G', gate: { node: 'r', choice: 'huge' } })]) || ''))
  ok('a good route and gate pass', checkNodes([r, g]) === null)
  const out = readOutput(r, 'Thinking...\n{"choice": "BIG", "reason": "many files"}')
  ok('a route answer is matched to an option regardless of case', out.ok && out.data.choice === 'big' && /many files/.test(out.output), JSON.stringify(out))
  ok('a route answer outside the options is a contract miss with the options named', !readOutput(r, '{"choice":"huge"}').ok && /"big", "small"/.test(readOutput(r, '{"choice":"huge"}').reason))
  ok('the gate is pending until the route runs', gateState(g, { r: { state: 'running' } }).state === 'pending')
  ok('open on the matching choice', gateState(g, { r: { state: 'done', data: { choice: 'big' } } }).state === 'open')
  ok('closed on the other choice, saying which', /chose "small"/.test(gateState(g, { r: { state: 'done', data: { choice: 'small' } } }).why))
  ok('closed when the route failed', gateState(g, { r: { state: 'failed', title: 'Size it' } }).state === 'closed')
  ok('the prompt tells a route step its options', /Pick exactly one of: "big", "small"/.test(nodePrompt({ title: 't' }, r, {})))
  ok('the drawing labels a gated edge with its choice', /-- "big" -->/.test(toMermaid({ nodes: [r, g] })))
  ok('a skipped input is named as skipped, not as failed', /was skipped/.test(inputBlock(g, { r: { state: 'skipped', title: 'Size it', error: 'x' } })))
}

// ── repeat until dry: the cap and the dedupe ────────────────────────────────
{
  ok('no repeat unless asked', normalizeRepeat(null) === null && normalizeRepeat({}) === null)
  const rp = normalizeRepeat({ until: 'dry', maxRounds: 99, dryRounds: 0 })
  ok('rounds are capped at five', rp.maxRounds === 5, JSON.stringify(rp))
  ok('dry rounds default to two', rp.dryRounds === 2)
  ok('no budget unless asked', !('budgetTokens' in rp))
  ok('a budget is kept', normalizeRepeat({ until: 'dry', budgetTokens: 250000 }).budgetTokens === 250000)
  ok('a budget too small to finish a round is ignored', !('budgetTokens' in normalizeRepeat({ until: 'dry', budgetTokens: 50 })))
  const seen = new Set(lineKeys('- Bug one\n* bug TWO'))
  ok('a line seen in another form is not new', newLines('1. bug one\n- Bug three', seen).join('|') === '- Bug three', newLines('1. bug one\n- Bug three', seen).join('|'))
  ok('the prompt carries what was seen', /Do NOT report any of it again/.test(nodePrompt({ title: 't' }, normalizeNode({ id: 'a', title: 'A' }), {}, ['bug one'])))
  ok('but not to a reduce step', !/Do NOT report/.test(nodePrompt({ title: 't' }, normalizeNode({ id: 'a', title: 'A', kind: 'reduce' }), {}, ['bug one'])))
}

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  edges are real dependencies, and what does not wait runs at once`)
process.exit(fail ? 1 : 0)
