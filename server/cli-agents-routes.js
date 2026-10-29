// The HTTP side of server/cli-agents.js: list and import Claude Code / Codex
// sessions, offer them as models, and run a chat turn through them.
//
// ⚠️ OFF UNTIL THE PERSON TURNS IT ON, AND PRIVATE TO THIS MAC UNTIL THEY SAY
// OTHERWISE. These routes read the whole history of what someone has asked two
// other coding tools, including every file those tools opened. So every route
// below, the chat branch included, answers 403 unless settings.cliAgents.enabled
// is true; and a request from another device (a phone on the tailnet, anything
// that is not this Mac's own window) is refused unless settings.cliAgents
// .allowRemote is also true. The setting lives in MACHINE_KEYS (config.js): it
// describes THIS Mac's history, and a synced folder must not switch it on for a
// second Mac nobody opted in.

import os from 'node:os'
import {
  CLI_TOOLS, isCliTool, validCliId, detectCliAgents, listCliSessions, readCliSession,
  runCliTurn, cliModelsFor, cliPermissionFor
} from './cli-agents.js'

/** The settings object, always complete: anything but a literal true is off. */
export function normalizeCliSettings (patch, base = {}) {
  const pick = k => (typeof patch?.[k] === 'boolean' ? patch[k] : base?.[k] === true)
  return { enabled: pick('enabled'), allowRemote: pick('allowRemote'), showModels: pick('showModels') }
}

const SSE = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
const shortTool = tool => (tool === 'codex' ? 'cx' : 'cc')
// One Radiant chat per saved session, and the id says which: importing twice
// (a double click, two windows) lands on the same file instead of a copy.
export const importedSessionId = (tool, id) => `cli-${shortTool(tool)}-${String(id).toLowerCase()}`

const PERMISSION_NOTE = {
  ask: label => `${label} is working read-only here. Radiant's permission setting is "Ask each", and there is nobody to answer a question while ${label} works in the background, so it can look but not change anything. Switch to Auto approve to let it edit files.`,
  auto: label => `${label} may edit files in this folder (Radiant's setting is "Auto approve"). Anything that would need your say-so is declined instead of asked.`,
  off: label => `${label} may do anything on this Mac without asking (Radiant's setting is "Allow all").`
}

/**
 * deps: {
 *   getCliSettings: () => raw settings.cliAgents (read fresh from the machine file),
 *   loadSession, saveSession, listSessions,
 *   isLocalRequest: req => true only for this Mac's own window/process
 * }
 * Returns helpers the rest of the server uses: handles, refusal, modelEntries, chat.
 */
export function registerCliAgentRoutes (app, deps) {
  const { getCliSettings, loadSession, saveSession, listSessions, isLocalRequest } = deps
  const settings = () => normalizeCliSettings(getCliSettings())

  /** null when the request may use the feature, else { status, error, code } to send back. */
  const refusal = req => {
    const s = settings()
    if (!s.enabled) return { status: 403, code: 'cli-agents-disabled', error: 'Using Claude Code and Codex sessions is turned off. Turn it on in Settings on this Mac first.' }
    if (!isLocalRequest(req) && !s.allowRemote) return { status: 403, code: 'cli-agents-remote', error: "This Mac keeps its Claude Code and Codex sessions to itself. To use them from this device, allow it in Settings on the Mac." }
    return null
  }
  const gate = (req, res, next) => {
    const r = refusal(req)
    return r ? res.status(r.status).json({ error: r.error, code: r.code }) : next()
  }

  /** Models for the picker: only tools that are installed, and only when this request may use them. */
  const modelEntries = async req => {
    // the sessions browser works without these; the model menu only lists them when asked
    if (refusal(req) || !settings().showModels) return []
    const out = []
    for (const a of await detectCliAgents()) {
      if (!a.available) continue
      const spec = CLI_TOOLS[a.id]
      for (const m of await cliModelsFor(a.id)) out.push({ id: m.id, label: m.label, provider: a.id, providerName: spec.providerName, cli: true })
    }
    return out
  }

  // ---- what is installed (harmless to show: names and versions, no history) ----
  app.get('/api/cli-agents', async (req, res) => {
    const s = settings()
    const agents = await detectCliAgents({ fresh: req.query.fresh === '1' })
    const usable = !refusal(req)
    const providers = []
    if (usable) {
      for (const a of agents) {
        if (a.available) providers.push({ id: a.id, name: CLI_TOOLS[a.id].providerName, cli: true, models: await cliModelsFor(a.id) })
      }
    }
    res.json({ enabled: s.enabled, allowRemote: s.allowRemote, usable, remote: !isLocalRequest(req), agents, providers })
  })

  // ---- the saved sessions on this Mac ----
  app.get('/api/cli-sessions', gate, async (req, res) => {
    const tool = req.query.tool ? String(req.query.tool) : undefined
    if (tool && !isCliTool(tool)) return res.status(400).json({ error: 'tool must be claude-code or codex.' })
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 50))
    try {
      const found = await listCliSessions({ tool, limit, q: req.query.q ? String(req.query.q) : undefined, since: req.query.since ? String(req.query.since) : undefined })
      // Which of these Radiant already holds: a chat that carries the same CLI id.
      const have = new Map()
      try { for (const s of listSessions()) if (s.cli?.id) have.set(`${s.cli.tool}:${String(s.cli.id).toLowerCase()}`, s.id) } catch {}
      res.json({ sessions: found.map(s => { const rid = have.get(`${s.tool}:${s.id.toLowerCase()}`) || null; return { ...s, imported: Boolean(rid), radiantId: rid } }) })
    } catch (e) { res.status(500).json({ error: `Could not read the saved sessions: ${e.message}` }) }
  })

  // ---- turn one into a Radiant chat (or hand back the chat that already exists) ----
  app.post('/api/cli-sessions/import', gate, async (req, res) => {
    const { tool, id } = req.body || {}
    if (!isCliTool(tool)) return res.status(400).json({ error: 'tool must be claude-code or codex.' })
    if (!validCliId(tool, id)) return res.status(400).json({ error: 'That is not a session id.' })
    const rid = importedSessionId(tool, id)
    let existing = loadSession(rid)
    if (!existing) {
      try {
        const hit = listSessions().find(s => s.cli?.tool === tool && String(s.cli.id).toLowerCase() === id.toLowerCase())
        if (hit) existing = loadSession(hit.id)
      } catch {}
    }
    if (existing) return res.json(existing)
    let t
    try { t = await readCliSession({ tool, id }) } catch (e) {
      return res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message })
    }
    const session = {
      id: rid,
      title: t.title || 'Imported session',
      autoTitle: false, // the tool already named it; do not rename it from the first message
      agentId: null,
      group: false,
      projectId: null,
      provider: tool,
      model: t.model || null,
      cwd: t.cwd || os.homedir(),
      useTools: true,
      computerControl: false,
      createdAt: t.startedAt || new Date().toISOString(),
      messages: t.messages,
      cli: { tool, id: id.toLowerCase(), importedAt: new Date().toISOString(), ...(t.gitBranch ? { gitBranch: t.gitBranch } : {}) },
      cliImport: { total: t.totalMessages, kept: t.messages.length, truncated: t.truncated }
    }
    saveSession(session)
    res.json(session)
  })

  /** True when this chat runs through one of the tools rather than a Radiant provider. */
  const handles = session => isCliTool(session?.provider)

  /**
   * The /api/chat branch for a chat whose provider is claude-code or codex.
   * Shaped like the Hermes relay: same event stream, same transcript rules.
   *
   * ⚠️ RADIANT'S OWN TOOLS, SKILLS, MEMORY AND JEV DO NOT APPLY HERE. The tool
   * is the agent: it has its own model, its own tools and its own idea of what
   * to remember. Radiant carries the message in, shows what comes back, and
   * keeps the transcript — nothing else touches the turn.
   *
   * ctx: { session, content, messageId, controller, approvalMode, activeTurns,
   *        reflectTaskState, saveTurnSession, startHeartbeat, recordTurnFailure, recordTurnStopped }
   */
  async function chat (req, res, ctx) {
    const { session, content, messageId, controller, approvalMode, activeTurns, reflectTaskState, saveTurnSession, startHeartbeat, recordTurnFailure, recordTurnStopped } = ctx
    const sessionId = session.id
    const tool = session.provider
    const spec = CLI_TOOLS[tool]
    const refuse = (status, error, code) => { activeTurns.delete(sessionId); return res.status(status).json({ error, ...(code ? { code } : {}) }) }

    const r0 = refusal(req)
    if (r0) return refuse(r0.status, r0.error, r0.code)
    const installed = (await detectCliAgents()).find(a => a.id === tool)
    if (!installed?.available) return refuse(400, `${spec.label} is not installed on this Mac. ${spec.install}`, 'cli-agents-missing')

    res.writeHead(200, SSE)
    const emit = ev => { reflectTaskState(sessionId, ev); res.write(`data: ${JSON.stringify(ev)}\n\n`) }
    const text = typeof content === 'string' ? content : (content?.text || '')
    const attachments = (typeof content === 'object' && content?.attachments) || []
    session.messages.push({ role: 'user', text, attachments, ...(messageId ? { id: messageId } : {}) })
    if (session.messages.length === 1 && session.autoTitle !== false) {
      session.title = text.length > 48 ? text.slice(0, 48) + '…' : (text || 'New session')
      session.autoTitle = true
      emit({ type: 'title', title: session.title })
    }
    saveTurnSession(session)
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    const stopHeartbeat = startHeartbeat(res)

    const assistant = { role: 'assistant', parts: [], via: tool }
    session.messages.push(assistant)

    // A long turn is saved as it goes (at most every 5 s), so a crash or a quit
    // keeps what the tool had already done instead of losing the whole reply.
    let savedAt = Date.now()
    const tick = ev => {
      emit(ev)
      if ((ev.type === 'tool_result' || ev.type === 'text_delta') && Date.now() - savedAt > 5000) { savedAt = Date.now(); try { saveTurnSession(session) } catch {} }
    }

    const level = approvalMode === 'off' ? 'off' : approvalMode === 'auto' ? 'auto' : 'ask'
    if (session.cli?.notedLevel !== level) {
      const note = PERMISSION_NOTE[level](spec.label)
      assistant.parts.push({ type: 'notice', text: note }); emit({ type: 'notice', text: note })
    }
    if (attachments.length) {
      const note = `Attachments are not sent to ${spec.label} from Radiant yet. Only the text of your message went.`
      assistant.parts.push({ type: 'notice', text: note }); emit({ type: 'notice', text: note })
    }

    // Resume only the conversation this tool started; one from the other tool means nothing here.
    const resumeId = session.cli?.tool === tool ? session.cli.id : null
    const t0 = Date.now()
    try {
      const r = await runCliTurn({
        tool, text, cwd: session.cwd, resumeId, model: session.model, permissionMode: level,
        effort: session.effort && session.effort !== 'auto' ? session.effort : undefined,
        emit: tick, signal: controller.signal, parts: assistant.parts
      })
      session.cli = { ...(session.cli || {}), tool, id: r.cliSessionId || resumeId, notedLevel: level }
      if (r.model) assistant.model = r.model
      else if (session.model && session.model !== 'default') assistant.model = session.model
      const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
      st.turns += 1
      st.inTokens += r.usage.input; st.outTokens += r.usage.output
      st.cachedIn = (st.cachedIn || 0) + r.usage.cacheRead; st.cacheWrite = (st.cacheWrite || 0) + r.usage.cacheWrite
      st.llmMs += Date.now() - t0
      emit({ type: 'stats', stats: st })
      if (r.error && !controller.signal.aborted) recordTurnFailure(session, emit, r.error)
      else if (!controller.signal.aborted) emit({ type: 'done' })
    } catch (e) {
      if (!controller.signal.aborted) recordTurnFailure(session, emit, e.message)
    } finally {
      stopHeartbeat()
      if (controller.signal.aborted) recordTurnStopped(session, { byUser: Boolean(activeTurns.get(sessionId)?.stoppedByUser) })
      activeTurns.delete(sessionId)
      saveTurnSession(session)
      emit({ type: 'closed' })
      res.end()
    }
  }

  return { handles, refusal, modelEntries, chat, permissionFor: cliPermissionFor }
}
