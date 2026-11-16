import crypto from 'crypto'
import os from 'os'
import { runTurn } from './providers.js'
import {
  loadBoard, updateBoard, notesOf, sectionOf, routeStops, clean, uid,
  layoutPrompt, groupPrompt, itemPrompt, briefPrompt, askPrompt, unpackPrompt,
  readPlan, readAgentReply, lastJsonObject, proposalsFromGrouping, addResult, boardText
} from './whiteboard.js'

/**
 * The whiteboard's agents. Same runTurn as every chat; what is new is that the
 * board starts them, several at once, and nobody is watching.
 *
 * ⚠️ NOTHING HERE CAN ASK YOU. Hand to Radiant, Run and Ask run in the
 * background, so an approval prompt has no one to answer it: requestApproval
 * refuses, and the result card names any tool the agent tried that needed
 * one. The prompt also tells it not to send, write or run anything — the
 * refusal is what makes that true.
 *
 * ⚠️ EVERY AGENT HAS A BUDGET: 4 minutes and 24 tool calls, at most 3 at once,
 * and every run has Stop. A board that fans out over twelve notes must not be
 * a bill nobody saw coming.
 *
 * ⚠️ NO SILENT FALLBACK. If the model picked in Settings cannot be used, the
 * run stops and says so. It is not retried on the default model.
 */

const AGENT_MS = () => Number(process.env.RADIANT_WB_AGENT_MS) || 4 * 60 * 1000
const MAX_TOOL_CALLS = 24
const AT_ONCE = 3

// boardId -> { controller, jobs: Map(noteId -> { state, title, startedAt }), kind, startedAt, error }
const runs = new Map()

export function boardActivity (boardId) {
  const r = runs.get(boardId)
  if (!r) return { running: false, jobs: {} }
  return { running: !r.done, kind: r.kind, error: r.error || null, stop: r.stop || null, jobs: Object.fromEntries(r.jobs) }
}
export function stopBoard (boardId) {
  const r = runs.get(boardId)
  if (!r || r.done) return false
  r.controller.abort()
  return true
}

/** Which model does this kind of work: Settings → Automation → Whiteboard, else Radiant's default. */
export function pickModel (config, kind) {
  const wb = config.settings.whiteboard || {}
  const p = kind === 'plan' ? { provider: wb.planProvider, model: wb.planModel } : { provider: wb.agentProvider, model: wb.agentModel }
  if (p.model) return { provider: p.provider, model: p.model, picked: true }
  return { provider: config.settings.defaultProvider, model: config.settings.defaultModel, picked: false }
}

/** One turn, text back. Tools only when `tools` — planning turns never get any. */
async function turn ({ deps, kind, prompt, tools, signal, title }) {
  const config = deps.loadConfig()
  const who = pickModel(config, kind)
  if (!who.provider || !who.model) throw new Error('No model is set. Pick one in Settings → Automation → Whiteboard, or set a default model.')
  const cred = await deps.credFor(who.provider)
  if (!cred) throw new Error(who.picked ? `The ${kind === 'plan' ? 'planning' : 'agent'} model you picked (${who.model}) cannot be used: not signed in to ${who.provider}. It was not retried on your default model.` : `Not signed in to ${who.provider}.`)
  const session = {
    id: crypto.randomUUID(),
    title: title || 'Whiteboard',
    autoTitle: false,
    hidden: true,
    whiteboard: true,
    provider: who.provider,
    model: who.model,
    cwd: os.homedir(),
    useTools: Boolean(tools),
    computerControl: false,
    createdAt: new Date().toISOString(),
    messages: [{ role: 'user', text: prompt }]
  }
  let text = ''
  const acted = new Set()
  let calls = 0
  const own = new AbortController()
  const sig = AbortSignal.any([signal || own.signal, own.signal, AbortSignal.timeout(AGENT_MS())])
  try {
    await runTurn({
      provider: cred.provider,
      model: who.model,
      apiKey: cred.apiKey,
      getAccessToken: cred.getAccessToken,
      getAccountId: cred.getAccountId,
      session,
      useTools: Boolean(tools),
      computerControl: false,
      persona: '',
      skills: [],
      emit: ev => {
        if (ev.type === 'text_delta') text += ev.text
        else if (ev.type === 'tool_start' && ++calls >= MAX_TOOL_CALLS) own.abort()
      },
      requestApproval: call => { acted.add(call.name); return Promise.resolve(false) },
      signal: sig
    })
  } catch (e) {
    if (signal?.aborted) throw new Error('Stopped.')
    if (!own.signal.aborted && !sig.aborted) throw e
  }
  if (signal?.aborted) throw new Error('Stopped.')
  const limited = own.signal.aborted ? `Stopped after ${MAX_TOOL_CALLS} tool calls.` : sig.aborted ? `Stopped after ${Math.round(AGENT_MS() / 60000)} minutes.` : null
  return { text, acted: [...acted], model: who.picked ? who.model : null, limited }
}

// ---------- planning: no tools, one turn, answer straight back ----------

export async function layoutFromSentence (deps, request, layout) {
  let r = await turn({ deps, kind: 'plan', prompt: layoutPrompt(request, layout), title: 'Whiteboard: lay out' })
  let plan = readPlan(r.text)
  if (!plan.ok) {
    r = await turn({ deps, kind: 'plan', prompt: `${layoutPrompt(request, layout)}\n\nYour previous reply could not be used: ${plan.reason} Reply with the JSON object only.`, title: 'Whiteboard: lay out' })
    plan = readPlan(r.text)
  }
  if (!plan.ok) throw new Error('Radiant could not lay that out. Try saying it another way.')
  if (layout) plan.plan.layout = layout
  return plan.plan
}

export async function groupNotes (deps, boardId) {
  const b = loadBoard(boardId)
  const notes = notesOf(b).filter(n => clean(n.text, 10)).slice(0, 80)
  if (notes.length < 2) throw new Error('Add a few notes first. Radiant groups what is on the board.')
  const aliases = new Map(notes.map((n, i) => [`n${i + 1}`, n.id]))
  const r = await turn({ deps, kind: 'plan', prompt: groupPrompt(b, notes), title: 'Whiteboard: group' })
  const reply = lastJsonObject(r.text, o => Array.isArray(o.groups) || Array.isArray(o.actions))
  if (!reply) throw new Error('Radiant did not come back with groups. Try again.')
  const proposals = proposalsFromGrouping(reply, aliases)
  if (!proposals.length) throw new Error('Radiant found nothing to suggest for these notes.')
  return updateBoard(boardId, (bd, rev) => { bd.proposals.push(...proposals.map(p => ({ ...p, rev }))); return bd })
}

export async function unpackResult (deps, boardId, resultId) {
  const b = loadBoard(boardId)
  const card = b?.items.find(i => i.id === resultId && i.kind === 'result')
  if (!card) throw new Error('That result is gone.')
  const r = await turn({ deps, kind: 'plan', prompt: unpackPrompt(card), title: 'Whiteboard: unpack' })
  const reply = lastJsonObject(r.text, o => Array.isArray(o.notes))
  if (!reply || !reply.notes.length) throw new Error('Radiant could not unpack that result.')
  const proposals = reply.notes.slice(0, 6).filter(n => clean(n.text)).map(n => ({ id: uid('p'), kind: 'note', text: clean(n.text, 200), action: Boolean(n.action), from: resultId, reason: clean(n.reason, 120) || 'A point of the result', state: 'pending', by: 'radiant' }))
  return updateBoard(boardId, (bd, rev) => { bd.proposals.push(...proposals.map(p => ({ ...p, rev }))); return bd })
}

// ---------- agents: in the background, results onto the board ----------

function startRun (boardId, kind) {
  const prev = runs.get(boardId)
  if (prev && !prev.done) throw Object.assign(new Error('Radiant is already working on this board. Stop it first, or wait.'), { status: 409 })
  const r = { controller: new AbortController(), jobs: new Map(), kind, startedAt: Date.now(), done: false }
  runs.set(boardId, r)
  return r
}

async function doNote (deps, r, boardId, noteId, context = '') {
  const b = loadBoard(boardId)
  const note = b?.items.find(i => i.id === noteId)
  if (!note) return null
  r.jobs.set(noteId, { state: 'working', title: clean(note.text, 60), startedAt: Date.now() })
  try {
    const out = await turn({ deps, kind: 'agent', tools: true, prompt: itemPrompt(b, note, context), signal: r.controller.signal, title: `Whiteboard: ${clean(note.text, 50)}` })
    const res = readAgentReply(out.text)
    if (!res) throw new Error(out.limited || 'The agent finished without an answer.')
    if (out.limited) res.text += `\n\n_${out.limited}_`
    updateBoard(boardId, (bd, rev) => addResult(bd, rev, { noteId, ...res, model: out.model || undefined, acted: out.acted }).board)
    r.jobs.set(noteId, { state: 'done', title: res.title })
    return { stop: sectionOf(b, note)?.title || '', ...res }
  } catch (e) {
    r.jobs.set(noteId, { state: 'failed', error: e.message })
    return null
  }
}

/** Run up to AT_ONCE of these at a time. */
async function pool (tasks) {
  const out = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i]() }
  }))
  return out
}

/** Hand one or more notes to Radiant. Returns at once; the board polls activity. */
export function handNotes (deps, boardId, noteIds) {
  const r = startRun(boardId, 'hand')
  pool(noteIds.slice(0, 24).map(id => () => doNote(deps, r, boardId, id)))
    .catch(e => { r.error = e.message })
    .finally(() => { r.done = true })
  return boardActivity(boardId)
}

/**
 * Run the route: stop by stop, the stop's action items in parallel, and what
 * each stop delivered handed to the next. Then one brief at the end of the road.
 */
export function runRoute (deps, boardId) {
  const b = loadBoard(boardId)
  const stops = routeStops(b)
  const plan = stops.map(g => ({ g, notes: notesOf(b).filter(n => n.action && sectionOf(b, n)?.id === g.id) })).filter(s => s.notes.length)
  if (!plan.length) throw Object.assign(new Error('There are no action items on this board yet. Mark a note as an action item first.'), { status: 400 })
  const r = startRun(boardId, 'route')
  ;(async () => {
    const delivered = []
    for (const s of plan) {
      if (r.controller.signal.aborted) break
      r.stop = s.g.id
      const context = delivered.slice(-6).map(d => `- ${d.stop}: ${d.title} — ${clean(d.text, 300)}`).join('\n')
      const got = await pool(s.notes.map(n => () => doNote(deps, r, boardId, n.id, context)))
      delivered.push(...got.filter(Boolean))
    }
    r.stop = null
    if (delivered.length && !r.controller.signal.aborted) {
      r.jobs.set('brief', { state: 'working', title: 'Writing the brief' })
      try {
        const out = await turn({ deps, kind: 'plan', prompt: briefPrompt(loadBoard(boardId), delivered), signal: r.controller.signal, title: 'Whiteboard: brief' })
        const res = readAgentReply(out.text)
        if (res) {
          updateBoard(boardId, (bd, rev) => {
            // at the end of the road: after the last stop, past everything on the board
            const stops = routeStops(bd)
            const anchor = stops[stops.length - 1]
            const { board, card } = addResult(bd, rev, { title: res.title || 'Brief', text: res.text, stamp: 'Brief', model: out.model || undefined })
            if (anchor) {
              card.x = Math.max(...bd.items.filter(i => i.id !== card.id).map(i => i.x + i.w)) + 120
              card.y = anchor.y
              board.links.push({ id: uid('l'), kind: 'road', from: anchor.id, to: card.id, rev })
            }
            board.brief = { text: res.text, at: new Date().toISOString() }
            return board
          })
        }
        r.jobs.set('brief', { state: 'done', title: 'Brief' })
      } catch (e) { r.jobs.set('brief', { state: 'failed', error: e.message }) }
    }
  })().catch(e => { r.error = e.message }).finally(() => { r.done = true })
  return boardActivity(boardId)
}

/** Ask about what is selected. The answer lands as a card beside it. */
export function askBoard (deps, boardId, itemIds, question) {
  const b = loadBoard(boardId)
  const picked = b.items.filter(i => itemIds.includes(i.id))
  const text = picked.length
    ? picked.map(i => i.kind === 'group' ? `Section "${clean(i.title, 80)}":\n${notesOf(b).filter(n => sectionOf(b, n)?.id === i.id).map(n => `- ${clean(n.text, 200)}`).join('\n')}` : `- ${clean(i.text || i.title, 600)}`).join('\n')
    : boardText(b, { ids: false })
  const anchor = picked.sort((a, z) => (z.x + z.w) - (a.x + a.w))[0] || null
  const r = startRun(boardId, 'ask')
  r.jobs.set('ask', { state: 'working', title: clean(question, 60) })
  turn({ deps, kind: 'agent', tools: true, prompt: askPrompt(b, text, question), signal: r.controller.signal, title: `Whiteboard: ${clean(question, 50)}` })
    .then(out => {
      const res = readAgentReply(out.text)
      if (!res) throw new Error(out.limited || 'No answer came back.')
      updateBoard(boardId, (bd, rev) => {
        const { board, card } = addResult(bd, rev, { title: res.title, text: `**${clean(question, 200)}**\n\n${res.text}`, sources: res.sources, model: out.model || undefined, acted: out.acted, stamp: 'Answer' })
        const a = anchor && board.items.find(i => i.id === anchor.id)
        if (a) board.links.push({ id: uid('l'), kind: 'result', from: a.id, to: card.id, rev })
        return board
      })
      r.jobs.set('ask', { state: 'done', title: res.title })
    })
    .catch(e => { r.jobs.set('ask', { state: 'failed', error: e.message }); r.error = e.message })
    .finally(() => { r.done = true })
  return boardActivity(boardId)
}
