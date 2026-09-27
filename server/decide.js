/**
 * Small, fast, typed decisions — Jev, through OpenRouter's decisions endpoint.
 *
 * ⚠️ WHY THIS EXISTS. The harness benchmark (bench/) found one enabled MCP
 * server — Linear — riding on every model call of every chat as 69 tool
 * schemas, 16.6k tokens, whether the message was "close TG-473" or "fix this
 * Django bug". Radiant had no way to know which servers a message needed, so it
 * sent all of them. Jev is a model that does not write text at all: it takes
 * some facts and a multiple-choice question and returns a choice with a
 * calibrated probability, in ~300 ms, for about two thousandths of a cent.
 * Measured 2026-09-18 on nine such questions: nine right. That is the right
 * tool for "does this message need Linear?" — a question a chat model would
 * answer at a thousand times the price and a hundred times the latency.
 *
 * ⚠️ IT IS NEVER ON THE CRITICAL PATH. Every failure — no OpenRouter key, the
 * endpoint down, a timeout, a malformed answer — resolves to `null`, and every
 * caller treats null as "do what Radiant did before": attach everything. A
 * decision model can make the app cheaper; it must never make it work less.
 *
 * ⚠️ THE KEY STAYS HERE. This runs server-side with the OpenRouter key from
 * config; nothing about it reaches the renderer.
 */
import { modelFetch } from './net.js'

// overridable so scripts/test-decide.mjs can point this at a stub
const DECISIONS_URL = process.env.RADIANT_DECISIONS_URL || 'https://openrouter.ai/api/alpha/decisions'
export const DECISION_MODEL = '~typesafe/jev-latest'

/**
 * Ask Jev. `questions` is the endpoint's own shape:
 *   { id: { type: 'noul', instructions, criteria: { true, false } } }
 *   { id: { type: 'choice', instructions, criteria: { option: guidance, … } } }
 * Returns { answers, usage } or null. Never throws.
 */
export async function decide ({ apiKey, state, questions, sessionId, signal, timeoutMs = 4000 }) {
  if (!apiKey || !questions || !Object.keys(questions).length) return null
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const onAbort = () => ctl.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    const res = await modelFetch(DECISIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: DECISION_MODEL, state, questions, ...(sessionId ? { session_id: sessionId } : {}) }),
      signal: ctl.signal
    })
    if (!res.ok) return null
    const json = await res.json()
    if (!json || typeof json.answers !== 'object') return null
    return { answers: json.answers, usage: json.usage || null }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** "list_issues, save_issue, …" → "list issues, save issue, …" — enough for a criterion. */
export function describeServer (server, toolNames) {
  const names = (toolNames || []).map(n => n.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/[_-]+/g, ' ')).slice(0, 14)
  return `${server.name}${names.length ? ' — tools: ' + names.join(', ') + (toolNames.length > 14 ? ', …' : '') : ''}`
}

/**
 * Which MCP servers' tools does THIS message need?
 *
 * Rules, in order:
 *   1. No way to decide (no key, no decide function, nothing enabled) → all.
 *   2. A server whose tools were used earlier in this conversation stays
 *      attached — the agent is mid-task with it, and a follow-up like "and
 *      close it" says nothing a classifier could catch.
 *   3. For the rest, one yes/no question per server. Attach at p ≥ 0.35: a
 *      wrong "no" costs the user a capability, a wrong "yes" costs tokens.
 *   4. Jev unreachable or an answer missing → that server is attached.
 *
 * `toolsByServer` is { serverId: [toolName, …] }; `history` the session's
 * messages. Returns { attach: Set<serverId>, skipped: [server], decided }.
 */
export async function chooseMcpServers ({ message, history = [], servers = [], toolsByServer = {}, decideFn, apiKey, sessionId, signal }) {
  const enabled = servers.filter(s => s.enabled)
  const all = () => ({ attach: new Set(enabled.map(s => s.id)), skipped: [], decided: false })
  if (!enabled.length || !decideFn || !apiKey) return all()

  // 2. already in use here
  const usedIds = new Set()
  for (const m of history) {
    for (const p of (m.parts || [])) {
      const hit = p.type === 'tool' && /^mcp__([^_]+(?:_[^_]+)*)__/.exec(p.name || '')
      if (hit) usedIds.add(hit[1])
    }
  }
  const toAsk = enabled.filter(s => !usedIds.has(s.id))
  if (!toAsk.length) return { attach: new Set(enabled.map(s => s.id)), skipped: [], decided: false }

  const recent = history.filter(m => m.role === 'user').slice(-3).map(m => String(m.text || '').slice(0, 400))
  const questions = {}
  for (const s of toAsk) {
    questions[s.id] = {
      type: 'noul',
      instructions: `Does acting on the user's latest message require the "${s.name}" tools? Only the latest message matters; earlier ones are context.`,
      criteria: {
        true: `The latest message asks for something these tools do: ${describeServer(s, toolsByServer[s.id] || [])}.`,
        false: 'The latest message can be handled with files, the shell, the web, or a plain answer — none of these tools are needed.'
      }
    }
  }
  const out = await decideFn({ apiKey, sessionId, signal, state: { latest_message: String(message || '').slice(0, 2000), earlier_messages: recent }, questions })
  if (!out) return all()

  const attach = new Set(usedIds)
  const skipped = []
  const probs = {}
  for (const s of toAsk) {
    const a = out.answers?.[s.id]
    const p = a && typeof a.noul === 'number' ? a.noul : null
    if (p != null) probs[s.id] = p
    if (p == null || p >= 0.35) attach.add(s.id)
    else skipped.push({ id: s.id, name: s.name, p })
  }
  return { attach, skipped, decided: true, usage: out.usage, probs }
}

/**
 * Which model should answer THIS message: the one the user picked, or a fast
 * one on the same provider?
 *
 * ⚠️ WHY. Most messages in a coding chat are not coding: "what did that
 * error say", "rename it", "and the other file?", "thanks, now commit". Each
 * one waits on the strongest model the user owns — 5–20 s and full price —
 * for an answer a fast model gives in 2 s at a tenth of the cost. Jev reads
 * the message and says "easy" or "hard" in 300 ms; a fast model takes the
 * easy ones. The reply says which model answered, so nothing is hidden.
 *
 * Rules, in order — each is a way routing could make the app worse:
 *   1. No fast model, or it IS the chosen model → keep.
 *   2. Plan mode, a group chat, or an agent with its own model → keep.
 *   3. Mid-task: the previous reply used tools → keep. "And close it" says
 *      nothing a classifier could catch; the big model has the thread.
 *   4. Attachments, a slash command, or a long message (> 4000 chars) → keep.
 *   5. Ask. Jev if there is a key; else `judgeFn` (a cheap model, 1–2 s);
 *      else keep. Route only at p ≥ 0.8 — a wrong "easy" costs the user a
 *      worse answer, a wrong "hard" costs a few seconds.
 *   6. Any failure → keep. Routing can make Radiant faster; it must never
 *      make it answer worse.
 */
export const ROUTE_BAR = 0.8
export async function chooseModel ({ message, attachments = [], history = [], sessionModel, fastModel, planMode, group, agentModel, decideFn, judgeFn, apiKey, sessionId, signal }) {
  const keep = reason => ({ model: sessionModel, routed: false, reason })
  if (!fastModel || fastModel === sessionModel) return keep('no fast model')
  if (planMode || group || agentModel) return keep(planMode ? 'plan mode' : group ? 'group chat' : 'agent model')
  const text = String(message || '')
  if (attachments.length || text.startsWith('/') || text.length > 4000) return keep('attachments, command, or long')
  // 3. the previous assistant reply, before the message just added
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role === 'user' && i === history.length - 1) continue
    if (m.role === 'assistant') { if ((m.parts || []).some(p => p.type === 'tool')) return keep('mid-task'); break }
  }
  const recent = history.filter(m => m.role === 'user').slice(-4, -1).map(m => String(m.text || '').slice(0, 300))
  const state = { latest_message: text.slice(0, 2000), earlier_messages: recent }
  const question = {
    type: 'noul',
    instructions: 'Could a small, fast model (Claude Haiku, GPT mini, Gemini Flash) answer the latest_message well, or does it need the strongest model available? Judge the latest message; earlier ones are context only.',
    criteria: {
      true: 'A short factual question; a quick lookup; a one-line or one-file edit; a wording, naming or formatting change; a question about the conversation so far; a greeting or thanks; a simple command to run and report.',
      false: 'Changes across several files; debugging or diagnosing a failure; design, architecture or trade-off decisions; anything the user calls hard, careful, important or thorough; long documents to write; multi-step reasoning or math; an ambiguous task that needs judgment.'
    }
  }
  let p = null, judge = null
  try {
    if (decideFn && apiKey) {
      const out = await decideFn({ apiKey, sessionId, signal, state, questions: { easy: question } })
      const a = out?.answers?.easy
      if (a && typeof a.noul === 'number') { p = a.noul; judge = 'jev' }
    } else if (judgeFn) {
      const v = await judgeFn(state, question)
      if (typeof v === 'number') { p = v; judge = 'model' }
    }
  } catch { p = null }
  if (p == null) return keep('no judge')
  if (p >= ROUTE_BAR) return { model: fastModel, routed: true, p, judge, reason: 'easy' }
  return { model: sessionModel, routed: false, p, judge, reason: 'hard' }
}

/**
 * Which of the always-on skills does THIS message need?
 *
 * Skills ride in the system prompt, so every always-on skill is on every
 * request of every chat — a house-style guide, a deploy checklist and a
 * PDF-filling procedure all along for "say hi". Same shape as MCP servers:
 * one yes/no per skill, attach at p ≥ 0.35, and STICKY — a skill attached
 * once in a chat stays, so the cached system prefix only ever grows rather
 * than churning from message to message.
 *
 * Only skills that are on for everything are judged. A skill the agent
 * carries or one added to this chat with a slash command was chosen on
 * purpose and always goes. Any failure → all, as before.
 */
export async function chooseSkills ({ message, history = [], skills = [], judged = new Set(), sticky = new Set(), decideFn, apiKey, sessionId, signal }) {
  const all = () => ({ attach: new Set(skills.map(s => s.id)), skipped: [], decided: false })
  const toAsk = skills.filter(s => judged.has(s.id) && !sticky.has(s.id))
  if (!toAsk.length || !decideFn || !apiKey) return all()
  const recent = history.filter(m => m.role === 'user').slice(-3).map(m => String(m.text || '').slice(0, 400))
  const questions = {}
  for (const s of toAsk) {
    questions[s.id] = {
      type: 'noul',
      instructions: `Would the "${s.name}" skill help with the user's latest message? Only the latest message matters; earlier ones are context.`,
      criteria: {
        true: `The latest message is the kind of task this skill is for: ${String(s.description || s.content || '').slice(0, 300)}`,
        false: 'The latest message is unrelated to what this skill covers.'
      }
    }
  }
  const out = await decideFn({ apiKey, sessionId, signal, state: { latest_message: String(message || '').slice(0, 2000), earlier_messages: recent }, questions })
  if (!out) return all()
  const attach = new Set(skills.filter(s => !judged.has(s.id) || sticky.has(s.id)).map(s => s.id))
  const skipped = []
  const probs = {}
  for (const s of toAsk) {
    const a = out.answers?.[s.id]
    const p = a && typeof a.noul === 'number' ? a.noul : null
    if (p != null) probs[s.id] = p
    if (p == null || p >= 0.35) attach.add(s.id)
    else skipped.push({ id: s.id, name: s.name, p })
  }
  return { attach, skipped, decided: true, usage: out.usage, probs }
}

/**
 * After a turn: is any of the housekeeping worth a model call?
 *
 * Three background writers used to run after every turn — a title, a memory
 * distiller, a skill reflection — each a model call, on turns like "thanks".
 * One Jev request answers all three at once (questions run in parallel;
 * the extra ones are nearly free), and only the writers that pass run.
 * Bars: memory 0.3 (a missed fact is worse than a wasted call), skill 0.5,
 * "the heuristic title is already fine" 0.7 (the writer is skipped only when
 * Jev is sure). Unreachable → run everything, as before.
 */
export async function chooseHousekeeping ({ userText, assistantText, toolNames = [], heuristicTitle, wantTitle, wantMemory, wantSkill, decideFn, apiKey, sessionId, signal }) {
  const all = { title: wantTitle, memory: wantMemory, skill: wantSkill, decided: false }
  if (!decideFn || !apiKey || !(wantTitle || wantMemory || wantSkill)) return all
  const questions = {}
  if (wantTitle) questions.title_ok = { type: 'noul', instructions: `Is "${heuristicTitle}" already a good short title for a chat that begins with the user's message — clear about the topic, not cut off mid-thought?`, criteria: { true: 'It reads as a title someone would give the chat.', false: 'It is a truncated fragment, starts with filler, or misses the point.' } }
  // ⚠️ A LESSON ABOUT THE WORK COUNTS AS MUCH AS A FACT ABOUT THE USER.
  // "The build needs -skipPackagePluginValidation", "that page needs a real
  // browser, fetch gets a shell" — AgentRun has its agent write one to three
  // sentences of that after every run and the next run reads them. The
  // memory writer already runs; this asks it to look for the failed-then-
  // worked shape too, so AGENTS.md's sharp edges stop being hand-written.
  if (wantMemory) questions.memory = { type: 'noul', instructions: 'Does this exchange contain something worth remembering in later chats: a NEW durable fact about the user or their project (a preference, decision, name, convention, tool or goal) — OR a lesson about how the work is done here (something that failed and then worked, a flag or step a tool needs, a source that had the answer when another did not)?', criteria: { true: 'A lasting fact is stated or decided, or a reusable lesson about the tools, the build, the environment or the sources shows up.', false: 'Task chatter, a one-off request, an answer that leaves nothing to remember.' } }
  if (wantSkill) questions.skill = { type: 'noul', instructions: 'Does this exchange show a repeatable, multi-step procedure — how to do a recurring kind of task — that would be worth saving as a reusable skill?', criteria: { true: 'A sequence of steps that will recur, or a correction of how something should be done from now on.', false: 'A one-off answer, a single command, a question, or chatter.' } }
  const state = { user_message: String(userText || '').slice(0, 1500), assistant_reply: String(assistantText || '').slice(0, 1500), tools_used: toolNames.slice(0, 20) }
  const out = await decideFn({ apiKey, sessionId, signal, state, questions })
  if (!out) return all
  const p = k => { const a = out.answers?.[k]; return a && typeof a.noul === 'number' ? a.noul : null }
  return {
    title: wantTitle && !(p('title_ok') != null && p('title_ok') >= 0.7),
    memory: wantMemory && (p('memory') == null || p('memory') >= 0.3),
    skill: wantSkill && (p('skill') == null || p('skill') >= 0.5),
    decided: true, usage: out.usage, p: { title_ok: p('title_ok'), memory: p('memory'), skill: p('skill') }
  }
}

/**
 * Auto mode's second opinion: is this command safe to run without asking?
 *
 * The rule list in util.js (commandRisk) knows `rm -rf` and `sudo`; it does
 * not know that `git checkout -- .` throws away uncommitted work, that
 * `curl -d @~/.ssh/id_rsa` is exfiltration, or that `find / -delete` is a
 * catastrophe spelled without rm. Jev reads the command with the folder and
 * the user's own words and answers four questions in one request. Anything
 * at or over 0.5 turns a silent run into a question, with the reason shown.
 *
 * Jev can only ESCALATE here. A command the rules call risky is never waved
 * through on Jev's say-so: a wrong "safe" is the one mistake this cannot
 * afford, and "Auto" was described to the user as rules.
 */
export const RISK_BAR = 0.5
export async function assessCommand ({ command, cwd, userText, decideFn, apiKey, sessionId, signal }) {
  const none = { risk: null, reasons: [], decided: false }
  if (!command || !decideFn || !apiKey) return none
  const questions = {
    destroys: { type: 'noul', instructions: 'Could this command delete, overwrite or discard data that is not easily recovered — files, uncommitted work, a database, a branch, history? Build output, caches and temp files do not count.', criteria: { true: 'It removes, resets, truncates, force-pushes, drops or overwrites something with no easy undo.', false: 'It only reads, builds, tests, lists, or writes to output and temp locations.' } },
    exfiltrates: { type: 'noul', instructions: 'Could this command send local files, keys, tokens, environment variables or other private data to a network destination?', criteria: { true: 'It uploads, posts or pipes local content or secrets to a remote host.', false: 'It stays local, or only downloads, or talks to localhost.' } },
    system: { type: 'noul', instructions: 'Does this command change the machine beyond the project — system settings, global installs, permissions, services, other users, sudo?', criteria: { true: 'It needs elevated rights or changes something outside the project that persists.', false: 'It acts inside the project or the user’s own tooling.' } },
    outside: { type: 'noul', instructions: `Does this command act on paths outside the working folder (${cwd || 'unknown'}) in a way that changes them?`, criteria: { true: 'It writes, moves or deletes outside the working folder.', false: 'It reads outside at most, or stays inside.' } }
  }
  const out = await decideFn({ apiKey, sessionId, signal, state: { command: String(command).slice(0, 2000), working_folder: cwd || '', user_latest_message: String(userText || '').slice(0, 800) }, questions })
  if (!out) return none
  const ps = Object.entries(questions).map(([k]) => [k, out.answers?.[k]?.noul]).filter(([, p]) => typeof p === 'number')
  if (!ps.length) return none
  const labels = { destroys: 'could destroy data', exfiltrates: 'could send private data out', system: 'changes the system', outside: 'changes files outside the project' }
  const reasons = ps.filter(([, p]) => p >= RISK_BAR).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${labels[k]} (${Math.round(p * 100)}%)`)
  return { risk: Math.max(...ps.map(([, p]) => p)), reasons, decided: true, usage: out.usage }
}

/**
 * Does the evidence support what the reply says was done?
 *
 * ⚠️ THE CLAIM IS NOT THE WORK. "Tests pass", "committed and pushed", "the
 * file is created", "verified on the simulator" — a reply can say any of
 * these with nothing in the turn to show it, and the transcript reads as
 * finished. AgentRun's verify clause (Grep.ai, 2026-09) does this per field
 * against cited evidence; here it is per sentence against the turn's own
 * tool calls and outputs. Sentences that look like completion claims are
 * lifted by shape (first person past tense, "tests pass", "is now live"),
 * and Jev answers two things about each in one request: is it really a
 * claim that the assistant itself did or checked something in this turn,
 * and does the evidence support it. A claim at ≥ 0.6 with support < 0.3 is
 * unsupported. Explanations ("this function creates a file") are not
 * claims and are left alone.
 */
const CLAIM_RX = [
  /\b(?:I|I've|I have|we|we've|we have)\b[^.!?\n]{0,80}\b(?:ran|run|created|wrote|written|committed|pushed|installed|deployed|verified|tested|fixed|updated|added|removed|built|released|checked|confirmed|opened|closed|merged|published|uploaded|installed)\b[^.!?\n]*[.!?]?/i,
  /\b(?:tests?|checks?|build|lint|gates?)\s+(?:all\s+)?(?:pass(?:es|ed)?|(?:are|is)\s+(?:passing|green)|succeed(?:s|ed)?)\b[^.!?\n]*[.!?]?/i,
  /\b(?:all|every)\s+\d*\s*(?:tests?|checks?|gates?)\s+(?:pass|passed|green)\b[^.!?\n]*[.!?]?/i,
  /\b(?:is|are|has been|have been)\s+now\s+(?:live|deployed|installed|running|fixed|working|in place|committed|pushed|released)\b[^.!?\n]*[.!?]?/i,
  /\b(?:committed and pushed|pushed to (?:origin|master|main)|no errors|builds? cleanly|works as expected|verified (?:that|on|in))\b[^.!?\n]*[.!?]?/i
]
export function liftClaims (text) {
  const out = []
  const seen = new Set()
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim()
    if (s.length < 12 || s.length > 300) continue
    if (CLAIM_RX.some(rx => rx.test(s)) && !seen.has(s)) { seen.add(s); out.push(s) }
    if (out.length >= 8) break
  }
  return out
}

export async function verifyClaims ({ text, toolParts = [], decideFn, apiKey, sessionId, signal }) {
  const claims = liftClaims(text)
  if (!claims.length || !decideFn || !apiKey) return null
  const evidence = toolParts.slice(-24).map(p => {
    const a = p.args || {}
    const head = p.name === 'run_command' ? a.command : (a.path || a.url || a.query || JSON.stringify(a).slice(0, 120))
    const r = p.denied ? '[denied by user]' : String(p.result ?? '').slice(0, 500)
    return `${p.name}(${String(head || '').slice(0, 160)}) → ${r}`
  })
  const questions = {}
  claims.forEach((c, i) => {
    questions[`claim_${i}`] = { type: 'noul', instructions: `Read claims[${i}]. Is it a statement that the assistant ITSELF completed, ran or verified something during this turn — as opposed to an explanation, a suggestion, a plan, or a description of how code behaves?`, criteria: { true: 'The assistant asserts that it did or checked something.', false: 'It explains, proposes, describes, or talks about the future.' } }
    questions[`ok_${i}`] = { type: 'noul', instructions: `Read claims[${i}] and the evidence — every tool the assistant called this turn and what came back. Does the evidence show the claim is true?`, criteria: { true: 'A tool call and its output in the evidence establish it (a test run that passed, a commit that succeeded, a file written without error).', false: 'Nothing in the evidence shows it, or the evidence contradicts it (an error, a denied call, no such call at all).' } }
  })
  const out = await decideFn({ apiKey, sessionId, signal, state: { claims, evidence: evidence.length ? evidence : ['(no tools were called this turn)'] }, questions })
  if (!out) return null
  const p = k => { const a = out.answers?.[k]; return a && typeof a.noul === 'number' ? a.noul : null }
  const unsupported = []
  claims.forEach((c, i) => {
    const isClaim = p(`claim_${i}`), ok = p(`ok_${i}`)
    if (isClaim != null && ok != null && isClaim >= 0.6 && ok < 0.3) unsupported.push({ claim: c, support: ok })
  })
  return { claims: claims.length, unsupported, usage: out.usage }
}

/**
 * Which earlier tool results does the task no longer need? — relevance
 * trimming (providers.js setAsideStale).
 *
 * ⚠️ WHY. When a chat gets long, Radiant trimmed old tool results by AGE: every
 * result past the last few rounds shrank to 600 characters, the file the whole
 * task hinges on as much as the directory listing nobody will look at again.
 * Then, near the limit, a model wrote a summary — slow, and lossy for
 * everything. Jev can read each old result against the task and say which are
 * dead weight in about a second (the "instant compaction" idea Tony brought
 * from the Jev Engineering guide, 2026-09-27). Only those are set aside; what
 * still matters keeps its place.
 *
 * `candidates` are { key, name, head, excerpt }. Returns { stale: [{ key, p }],
 * kept: [{ key, p }], usage } or null — null changes nothing. `p` is the
 * probability the result is still needed; below STALE_BELOW it is set aside.
 */
export const STALE_BELOW = 0.25

export async function chooseStale ({ task, plan, recent, candidates = [], decideFn, apiKey, sessionId, signal }) {
  if (!candidates.length || !decideFn || !apiKey) return null
  // ⚠️ THE RESULT GOES IN THE QUESTION, NOT IN THE STATE. Measured against the
  // real Jev on one case (2026-09-27): with the results listed in the state and
  // each question pointing at results[i], an unrelated changelog scored 0.53
  // "still needed" beside 0.66 for the file being fixed — no separation. Inline,
  // asked as RELEVANCE, the same four scored 0.94 (the file), 0.96 (the failing
  // test), 0.04 (the changelog), 0.01 (an off-topic search). "Will it still be
  // needed" and "could it be dropped" both separated worse.
  const questions = {}
  candidates.forEach((c, i) => {
    questions[`need_${i}`] = {
      type: 'noul',
      instructions: `Is this earlier tool result relevant to the task described in the state?\n${c.name}(${c.head}) → ${c.excerpt}`,
      criteria: {
        true: 'It is about the thing being fixed or built: the code, the error, the requirement, data the answer will use.',
        false: 'It is unrelated to the task, or only incidental (an off-topic search, docs or files about something else).'
      }
    }
  })
  const out = await decideFn({ apiKey, sessionId, signal, timeoutMs: 8000, state: { task, plan: plan || '(no plan written)', latest_work: recent || '(none yet)' }, questions })
  if (!out) return null
  const stale = [], kept = []
  candidates.forEach((c, i) => {
    const p = out.answers?.[`need_${i}`]?.noul
    if (typeof p !== 'number') return
    ;(p < STALE_BELOW ? stale : kept).push({ key: c.key, p })
  })
  return { stale, kept, usage: out.usage }
}
