import crypto from 'crypto'
import os from 'os'
import { runTurn } from './providers.js'
import { planLayers, checkNodes, nodePrompt, readOutput, runReduce, gateState, leafIds, newLines, lineKeys, normalizeRepeat, tally, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from './graph-rules.js'
import { costOf } from './prices.js'

/**
 * The runner. This is the part Radiant could not do before.
 *
 * ⚠️ EVERY OTHER RUN IN THIS APP IS DRIVEN BY THE CHAT WINDOW — the server says
 * "here is the next turn" and the client streams it, one at a time. That is
 * right for a chat and right for a loop, and it is exactly wrong for a graph,
 * whose entire value is that independent work does not queue. So this drives
 * turns itself, several at once, with nobody watching.
 *
 * It is NOT a second run engine. It calls the same runTurn(); what is new is
 * that more than one of them is in flight. Everything that follows is the
 * consequence of that:
 *
 * ⚠️ NOBODY CAN ANSWER AN APPROVAL PROMPT HERE. Five agents cannot each stop and
 * wait for a click. So requestApproval is not "approve everything" — it FAILS
 * the node, with a message naming what it wanted. A graph that silently granted
 * itself permission to run shell commands, in parallel, unattended, would be the
 * worst thing in this codebase. Turning that off is a deliberate per-graph
 * choice the user makes on screen.
 *
 * ⚠️ A FAILED NODE MUST NOT KILL THE RUN. In a chain, failure cascades: C dies
 * and D never happens. In a graph, failure dies at its node — eight good results
 * still come back while the ninth drops out, and the fan-in downstream is told
 * there is a gap.
 */

// ⚠️ A REAL CEILING, NOT A NOTE. Model calls have no network timeout on purpose
// (server/net.js), so a stalled model hangs a node — and its graph — for good.
// This used to call a method that does not exist on AbortSignal and did nothing.
const maxNodeMs = () => Number(process.env.RADIANT_GRAPH_NODE_MS) || 10 * 60 * 1000

// Live runs, so a second Run press does not start a second copy of the same graph.
const running = new Map()   // graphId -> { controller, run }

export const isRunning = id => running.has(id)
export const liveRun = id => running.get(id)?.run || null
export function stopGraph (id) {
  const r = running.get(id)
  if (!r) return false
  r.controller.abort()
  return true
}

/** One node's turn, in its own session, with nothing else in its context. */
const timedOut = () => `This step ran longer than ${Math.round(maxNodeMs() / 60000) || 1} minutes and was stopped, so the rest of the graph could finish.`

async function runNode ({ graph, node, results, deps, signal, seen, meter }) {
  const { loadConfig, saveSession, agentsStore, getProject, credFor } = deps
  const config = loadConfig()
  const project = graph.projectId ? getProject(graph.projectId) : null
  const agent = node.agentId ? agentsStore.get(node.agentId) : null

  const session = {
    id: crypto.randomUUID(),
    title: `${graph.title} — ${node.title}`,
    autoTitle: false,
    agentId: agent ? agent.id : null,
    projectId: project ? project.id : null,
    // ⚠️ MODEL TIERING IS THE WHOLE ECONOMICS OF THIS. A wide fan-out inherits
    // the session model by default, so twenty cheap lookups bill at the top
    // tier — people find that out on the invoice. Each node names its own.
    provider: node.provider || (agent && agent.provider) || (project && project.provider) || config.settings.defaultProvider || null,
    model: node.model || (agent && agent.model) || (project && project.model) || config.settings.defaultModel,
    cwd: graph.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: node.useTools !== false,
    computerControl: false,
    graphId: graph.id,
    graphNodeId: node.id,
    createdAt: new Date().toISOString(),
    messages: []
  }
  if (!session.model) return { state: 'failed', error: 'No model is set for this step, and there is no default to fall back on.' }
  meter.model = session.model

  const prompt = nodePrompt(graph, node, results, seen)
  session.messages.push({ role: 'user', text: prompt })
  saveSession(session)

  const cred = await credFor(session.provider)
  if (!cred) return { state: 'failed', error: `Not signed in to ${session.provider}.`, sessionId: session.id }

  let text = ''
  let refused = null
  const nodeSignal = AbortSignal.any([signal, AbortSignal.timeout(maxNodeMs())])
  const turn = () => runTurn({
    provider: cred.provider,
    model: session.model,
    apiKey: cred.apiKey,
    getAccessToken: cred.getAccessToken,
    getAccountId: cred.getAccountId,
    session,
    useTools: session.useTools,
    computerControl: false,
    persona: agent?.persona || '',
    skills: [],
    emit: ev => {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'usage') for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) meter[k] += ev[k] || 0
    },
    // See the header: a graph cannot ask. It refuses and says what it wanted.
    requestApproval: graph.autoApprove
      ? null
      : call => { refused = call.name; return Promise.resolve(false) },
    signal: nodeSignal
  })
  let parsed
  let retried = false
  try {
    await turn()
    parsed = readOutput(node, text)
    // ⚠️ VALIDATE, THEN RETRY ONCE — the contract is the point of the node, and
    // a model that fenced its JSON or dropped a key is one sentence away from
    // right. The reason goes back to it verbatim; a second miss is a failure.
    if (!parsed.ok && text.trim() && !refused && !nodeSignal.aborted && (node.fields.length || node.kind === 'route')) {
      retried = true
      session.messages.push({ role: 'user', text: `Your answer could not be used: ${parsed.reason} Reply again, and this time with the JSON only.` })
      text = ''
      await turn()
      parsed = readOutput(node, text)
    }
  } catch (e) {
    if (signal.aborted) return { state: 'failed', error: 'Stopped.', sessionId: session.id }
    if (nodeSignal.aborted) return { state: 'failed', error: timedOut(), sessionId: session.id }
    return { state: 'failed', error: e.message, sessionId: session.id }
  }

  // ⚠️ SAVE THE TRANSCRIPT WHATEVER HAPPENED. A node you cannot open is a node
  // you cannot debug, and "it failed" with no conversation behind it is the
  // thing that makes a parallel run feel like a black box.
  try { saveSession(session) } catch {}
  if (nodeSignal.aborted && !signal.aborted) return { state: 'failed', error: timedOut(), sessionId: session.id }

  if (refused && !text.trim()) {
    return {
      state: 'failed',
      sessionId: session.id,
      error: `This step tried to use ${refused}, and a graph cannot stop to ask you. Either give it work that only reads, or turn on "let this graph act without asking".`
    }
  }

  if (!parsed.ok) return { state: 'failed', error: parsed.reason, sessionId: session.id, output: text.slice(0, 2000), retried }
  return { state: 'done', output: parsed.output, data: parsed.data, sessionId: session.id, retried }
}

const sumRounds = rounds => rounds.reduce((a, r) => ({ tokens: a.tokens + r.tokens, cost: a.cost + r.cost, priced: a.priced && r.priced }), { tokens: 0, cost: 0, priced: true })

/**
 * Run a whole graph. Resolves with the finished run; never throws for a node's
 * sake.
 *
 * ⚠️ A STEP STARTS WHEN ITS OWN INPUTS ARE IN, NOT WHEN ITS WHOLE LAYER IS. The
 * first version ran the graph layer by layer, which made every layer a barrier:
 * one slow step in layer one held back every step in layer two, including the
 * ones that never read it. Barrier latency is wasted time, and a barrier is
 * only earned by a step that genuinely needs everything before it — and that
 * step already says so, in its edges. planLayers still decides whether the
 * graph can run at all (a circle cannot); the order comes from readiness.
 *
 * @param {(run) => void} onProgress called after every node so the UI can watch
 */
export async function runGraph (graph, deps, onProgress = () => {}) {
  const { error } = planLayers(graph.nodes)
  const bad = error || checkNodes(graph.nodes)
  if (bad) return { state: 'failed', error: bad, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), nodes: {} }

  const controller = new AbortController()
  const repeat = normalizeRepeat(graph.repeat)
  const freshNodes = () => Object.fromEntries(graph.nodes.map(n => [n.id, { title: n.title, kind: n.kind, state: 'waiting' }]))
  const run = {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    nodes: freshNodes(),
    ...(repeat ? { rounds: [], found: [] } : {})
  }
  running.set(graph.id, { controller, run })
  const limit = Math.min(MAX_CONCURRENCY, Math.max(1, graph.concurrency || DEFAULT_CONCURRENCY))
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const leaves = leafIds(graph.nodes)

  const meters = {}
  const runOnce = (seenLines) => new Promise(resolve => {
    const pending = new Set(graph.nodes.map(n => n.id))
    const finished = id => ['done', 'failed', 'skipped'].includes(run.nodes[id]?.state)
    let active = 0
    const settle = (id, r, started) => {
      run.nodes[id] = { ...run.nodes[id], ...r, ms: Date.now() - started, finishedAt: new Date().toISOString() }
      onProgress(run)
    }
    const tick = () => {
      if (controller.signal.aborted) pending.clear()
      for (const id of [...pending]) {
        const node = byId.get(id)
        if (!node.dependsOn.every(finished)) continue
        const gate = gateState(node, run.nodes)
        if (gate.state === 'closed') {
          // The branch nobody chose. Not a failure: it was never meant to run.
          pending.delete(id)
          run.nodes[id] = { ...run.nodes[id], state: 'skipped', error: gate.why }
          onProgress(run)
          continue
        }
        if (active >= limit) break
        pending.delete(id)
        active++
        const started = Date.now()
        run.nodes[id] = { ...run.nodes[id], state: 'running', startedAt: new Date().toISOString() }
        onProgress(run)
        const job = node.kind === 'reduce'
          // No model, no session, no wait.
          ? Promise.resolve().then(() => { const red = runReduce(node, run.nodes); return red.ok ? { state: 'done', output: red.output } : { state: 'failed', error: red.reason } })
          : runNode({ graph, node, results: run.nodes, deps, signal: controller.signal, seen: seenLines, meter: (meters[id] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) })
        // What the step spent is kept whether it finished or not: a failed step still billed.
        const spent = () => { const m = meters[id]; return m ? { usage: { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite }, cost: costOf(m, m.model) } : {} }
        job.then(r => settle(id, { ...r, ...spent() }, started), e => settle(id, { state: 'failed', error: e.message, ...spent() }, started))
          .finally(() => { active--; tick() })
      }
      if (!pending.size && active === 0) resolve()
    }
    tick()
  })

  try {
    if (!repeat) {
      await runOnce(null)
    } else {
      // Loop until dry, under the cap. What counts as "found" is what comes out
      // of the leaves — the steps nothing else reads — and it is deduped against
      // EVERYTHING seen, not against what survived.
      const seen = new Set()
      let dry = 0, spentTokens = 0, overBudget = false
      for (let round = 1; round <= repeat.maxRounds; round++) {
        if (round > 1) run.nodes = freshNodes()
        await runOnce([...run.found])
        if (controller.signal.aborted) break
        const fresh = []
        for (const id of leaves) {
          const r = run.nodes[id]
          if (r?.state !== 'done') continue
          for (const l of newLines(r.output, seen)) fresh.push(l)
          for (const k of lineKeys(r.output)) seen.add(k)
        }
        run.found.push(...fresh)
        dry = fresh.length ? 0 : dry + 1
        const spent = tally(run.nodes)
        spentTokens += spent.tokens
        run.rounds.push({ round, newCount: fresh.length, nodes: run.nodes, ...spent })
        run.spent = sumRounds(run.rounds)
        onProgress(run)
        if (dry >= repeat.dryRounds) break
        // Checked between rounds, so a round in flight finishes rather than
        // leaving half its steps unrun; the overshoot is at most one round.
        if (repeat.budgetTokens && spentTokens >= repeat.budgetTokens) { overBudget = true; break }
      }
      run.roundsRun = run.rounds.length
      run.stoppedBecause = controller.signal.aborted ? 'stopped' : dry >= repeat.dryRounds ? 'dry' : overBudget ? 'budget' : 'cap'
    }
    if (!repeat) run.spent = tally(run.nodes)
    if (controller.signal.aborted) { run.state = 'stopped' } else {
      const failed = Object.values(run.nodes).filter(n => n.state === 'failed')
      const ran = Object.values(run.nodes).filter(n => n.state !== 'skipped')
      // ⚠️ SOME FAILURES ARE FINE. The run is only a failure when NOTHING
      // finished; otherwise it is a result with holes in it, which is what
      // containing failure at the node is for. A skipped branch is neither.
      run.state = ran.length && failed.length === ran.length ? 'failed' : 'done'
      if (failed.length) run.error = `${failed.length} of ${ran.length} steps did not finish.`
    }
  } finally {
    run.finishedAt = new Date().toISOString()
    running.delete(graph.id)
    onProgress(run)
  }
  return run
}
