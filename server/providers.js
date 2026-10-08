import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { resolveSkillDir, usableCwd } from './config.js'
import { fetchRetry, isTransient } from './util.js'
import { TOOL_DEFS, runTool, outsideWorkspace, archiveResult, ARCHIVE_MIN } from './tools.js'
import { commandRisk } from './util.js'
import { COMPUTER_TOOL_DEFS, COMPUTER_TOOL_NAMES, COMPUTER_SAFE, runComputerTool } from './computer-tools.js'
import { boundResult, withBudget, MAX_TOOL_MS, ToolTimeout } from './tool-bounds.js'
import { COPILOT_HEADERS } from './oauth.js'
import { contextWindow } from './context-windows.js'
import { modelFetch } from './net.js'

// ⚠️ OLLAMA LOADS A MODEL WITH A CONTEXT OF ITS OWN CHOOSING and truncates
// any prompt that exceeds it FROM THE FRONT — the system prompt and the tool
// definitions go first — without an error. The loaded size is readable from
// /api/ps once the model is up, so a turn on a local model can fold before
// the truncation instead of after. Cached a minute; a miss is null, never a
// guess.
const ollamaCtxCache = new Map()

/** A local Ollama, whose context is Ollama's choice rather than the model's. */
export function isOllama (provider) {
  return Boolean(provider && provider.type === 'openai' && /:11434\b/.test(provider.baseUrl || ''))
}

// ⚠️ OLLAMA SIZES THE CONTEXT FROM THE MACHINE'S MEMORY, NOT THE CHAT'S NEEDS:
// under 24 GiB it loads 4k, 24-48 GiB 32k, and 48 GiB or more **256k**. On a
// 48 GB Mac that made Devstral reserve a 262144-token KV cache and balloon to
// 59 GB. Radiant does not (and through the OpenAI-compatible /v1 endpoint
// cannot) ask for a size — but it DID treat whatever Ollama reported as the
// point to start trimming, so a local chat was allowed to grow toward a
// quarter of a million tokens, re-sent in full every round. That is glacial
// long before it is fatal. See LOCAL_CONTEXT_DEFAULT.
export const LOCAL_CONTEXT_DEFAULT = 32_768

async function ollamaContext (provider, model) {
  if (!isOllama(provider)) return null
  const key = `${provider.baseUrl}|${model}`
  const hit = ollamaCtxCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.ctx
  try {
    const origin = provider.baseUrl.replace(/\/v1\/?$/, '')
    const ps = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(1500) }).then(r => r.json())
    const m = (ps.models || []).find(x => x.name === model || x.model === model)
    const ctx = m?.context_length ? Number(m.context_length) : null
    ollamaCtxCache.set(key, { at: Date.now(), ctx })
    return ctx
  } catch { return null }
}
import { voiceAsText } from './voice-text.js'

// ⚠️ THIS WAS 30, AND 30 IS SMALLER THAN AN ORDINARY JOB. Tony asked Radiant to
// pull a page of skills and install them; the turn that was actually doing it
// spent 14 fetch_url and 13 write_file calls — 27 of its 30 rounds on the work
// itself — and was cut off mid-install. Three turns before it had gone the same
// way, one of them spending 20 rounds just reading files. "why does it keep
// stopping. This is fucking ridiculous."
//
// A round cap is a backstop against an agent looping forever. It is NOT a work
// budget, and using it as one stops real work at an arbitrary line. The thing
// that actually catches a stuck agent is right below this: identical calls,
// counted. That existed the whole time and only ever printed a nudge.
//
// So the backstop moves out of the way of real work, and the detector that
// knows the difference between "working" and "stuck" gets teeth.
//
// ⚠️ AND 200 WAS STILL TOO LOW FOR A REAL BUILD. Other harnesses do not chop a
// task at a round count at all — they run the loop to completion, compact the
// context as they go, and stop only on a runaway signal or a spend budget. A
// user scaffolding a whole app kept hitting this wall at 200 and it read as
// failure (Tony: "how can a user build anything"). So this is now a far-out
// backstop against a truly endless loop, NOT the thing that ends ordinary work:
// the thrash-breaker stops the bad case, and the per-turn spend budget below is
// the real ceiling on cost.
const MAX_ROUNDS = Number(process.env.RADIANT_MAX_ROUNDS || 1000)

// ⚠️ AND A REAL CEILING ON WHAT A TURN MAY SPEND, because 200 rounds of a
// re-sent conversation is a bill, and a round count never measured the bill
// anyway. One stuck chat cost 25.7 million input tokens across 12 turns.
// Tokens are what runs out; tokens are what is counted.
// ⚠️ AND 2M WAS ALSO TOO LOW, FOR THE SAME REASON THE ROUND CAP WAS. A long
// chat re-sends its whole history every round: Tony's was 135k tokens per
// request, so 2M is fifteen rounds — it would have cut real work off all over
// again, just with a different message. A backstop belongs far out of the way of
// ordinary work; this one is for a turn that has genuinely run away.
const DEFAULT_TURN_TOKENS = Number(process.env.RADIANT_MAX_TURN_TOKENS || 15_000_000)

// Identical consecutive calls. Nudged at 3, 5 and 8 — and if it is STILL making
// the same call after that, it is not going to stop on its own.
const STUCK_AT = 12
// ⚠️ THE IDENTICAL-CALL BREAKER ABOVE MISSES A THRASH. An agent stuck on a
// broken build or a dependency mismatch does not repeat one command — it VARIES
// it every round (install, reinstall, downgrade, `npm view`, trace) and fails
// every time, so the signature changes each round and STUCK_AT never fires. One
// such turn ran 194 rounds and spent 12M tokens before only the token ceiling
// stopped it (Tony). So: watch a rolling window of recent shell commands, and
// when almost all of them are FAILING, halt and surface it — a turn that cannot
// get a command to succeed is not making progress, whatever it types next.
const CMD_WINDOW = 16          // how many recent commands we look at
const CMD_FAIL_HALT = 13       // this many failures in the window → stop
const CMD_FAIL_NUDGE = 6       // this many of the last 8 → one reminder first

// Split into a STABLE half (identical across turns unless the user explicitly
// reconfigures the session — persona, skills, cwd, tool/plan/computer-control
// toggles) and a VOLATILE half (recomputed fresh from the CURRENT turn's input,
// so it is essentially guaranteed to differ every request): retrieved memory
// facts (relevantFacts() is scored against this turn's user text — see
// server/memory.js) and the lead-model plan addendum (regenerated per turn when
// an agent has a plannerModel). Putting volatile content in the system array
// AFTER a cache_control-marked stable block keeps the marked prefix byte-
// identical across turns without touching the volatile content's visibility —
// see the claude-api skill's shared/prompt-caching.md, "Architectural guidance"
// + "Multi-turn conversations". A stable-half change (e.g. the user flips
// planMode or edits skills) is a one-time cache miss, not a per-turn one — that
// tradeoff is deliberate, not the bug this split fixes.
function systemPrompt (cwd, useTools, model, computerControl, skills, persona, planMode, planAddendum, memory, readOnly, projectRules) {
  const personaText = persona ? `\n\n${persona}` : ''
  const planText = planMode
    // Plain words, not capitals (Cursor's harness audit, 2026-09-27): capable
    // models follow a description, and emphasis makes literal ones overcautious.
    // The tools that change things are removed in plan mode anyway (planBlocked).
    ? '\n\nPlan mode is on: this turn is for research and a plan, not changes. The tools that write files or run changing commands are not available until the user approves. Read and search the codebase, think through the approach, then call exit_plan_mode with a concrete step-by-step plan in markdown.'
    : ''
  const skillText = (skills && skills.length)
    ? `\n\nActive skills (follow these):\n${skills.map(s => `• ${s.name}: ${s.content}${s.dir && resolveSkillDir(s.dir) ? `\n  Skill folder: ${resolveSkillDir(s.dir)}` : ''}`).join('\n')}`
    : ''
  // The workspace's own standing instructions (AGENTS.md/CLAUDE.md/.clinerules).
  const rulesText = (projectRules && projectRules.text)
    ? `\n\nProject rules — the standing instructions for this workspace, from ${projectRules.files.join(', ')}. Follow them for work in this project:\n${projectRules.text}${projectRules.truncated ? '\n\n[the rules were longer than fits here and were trimmed; read the file in full if you need the rest]' : ''}`
    : ''
  const stable = `You are a coding agent running inside Radiant, a local coding harness on the user's ${os.type() === 'Darwin' ? 'Mac' : os.type()} (${os.platform()} ${os.release()}). Radiant is the app, not you: you are the model "${model}". If asked what model you are, answer with your actual model name and maker.${personaText}
Workspace directory: ${cwd}
${useTools && readOnly ? 'You have tools to read files and to run read-only shell commands (ls, cat, grep, find, git log/show/diff, wc…) in the workspace. You cannot write, edit, delete or install anything, and a command that would is refused. Read what the question needs and no more.' : useTools ? 'You have tools to read, write, and edit files and to run shell commands in the workspace. Use them to investigate before answering and to make changes when asked. Prefer edit_file for small changes and write_file for new files. After making changes, verify them when practical (run the code, run tests) — and when you already know the command you will run right after an edit, pass it as that edit\'s `then` so both come back at once. A trimmed earlier result can be read back exactly with recall.' : 'Tools are disabled for this conversation; answer from knowledge and the conversation only.'}${computerControl ? `
You can also control the computer. browser_* tools drive an automated browser; screen_* tools control the whole desktop. Click coordinates are pixel positions in the most recent screenshot, so take one (browser_screenshot / screen_screenshot) before clicking or typing, and another after acting to confirm what happened. Prefer browser_* for web tasks.` : ''}
Be direct and concise. Use markdown; fence code blocks with a language tag. When you finish a task, summarize what changed in a sentence or two.${planText}${rulesText}${skillText}`

  const planAddendumText = planAddendum ? `\n\n${planAddendum}` : ''
  const memoryText = (memory && memory.length)
    ? `\n\nWhat you remember about this user and their projects (from past sessions — use it when relevant, don't recite it):\n${memory.map(f => `• ${f}`).join('\n')}`
    : ''
  const volatile = `${planAddendumText}${memoryText}`

  return { stable, volatile, full: stable + volatile }
}

// Very rough token estimate (chars/4) used only to decide whether the stable
// system prefix clears a model's minimum cacheable length — see
// shared/prompt-caching.md's per-model minimum table (512-4096 tokens,
// non-monotonic across generations). Radiant supports arbitrary/rolling model
// ids across many Anthropic-compatible endpoints, so there's no reliable way to
// look up an exact per-model number here; 1024 is a conservative mid-table
// default that a real coding-agent system prompt (identity + tool
// instructions + persona/skills) almost always clears anyway.
const MIN_CACHEABLE_TOKENS = 1024
function roughTokens (text) { return Math.round((text || '').length / 4) }

// ---------- internal message format -> provider wire formats ----------
// session.messages: [{role:'user', text, attachments} | {role:'assistant', parts:[{type:'text',text}|{type:'tool',id,name,args,result}]}]
// attachment: { name, mime, dataB64, kind:'image'|'text' }

// text-file attachments get inlined into the prompt; images stay as data.
function userText (m) {
  let t = m.text || ''
  for (const a of m.attachments || []) {
    if (a.kind === 'text') {
      const body = Buffer.from(a.dataB64, 'base64').toString('utf8')
      t += `\n\n--- attached file: ${a.name} ---\n${body}`
    }
  }
  return t
}
const imageAttachments = m => (m.attachments || []).filter(a => a.kind === 'image')

const messageText = m => (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim()

// In a group chat every agent's reply is stored as an assistant message. When it's
// agent X's turn, the OTHER agents' replies must be shown to X as user-role input
// (name-tagged) — otherwise the request ends on an assistant message and models
// reject it ("must end with a user message" / no assistant prefill).
function groupFlatten (messages, speakerId, names) {
  return messages.map(m => {
    if (m.role === 'assistant' && m.agentId && m.agentId !== speakerId) {
      const t = messageText(m)
      return t ? { role: 'user', text: `[${names[m.agentId] || 'Agent'}]: ${t}` } : null
    }
    return m
  }).filter(Boolean)
}

// ⚠️ REASONING GOES BACK, OR THE MODEL STARTS EVERY STEP OVER. The model's
// thinking was streamed to the screen and thrown away, so each tool step began
// without the plan it had just worked out — Cursor measured a reasoning model
// 30% worse on a coding benchmark that way (Tony, 2026-09-27). Worse on
// Claude: with a thinking level set, Anthropic REFUSES the next step of a
// tool-using turn unless the signed thinking block comes back with it, and the
// "does not take a thinking level" fallback then switched thinking off —
// silently, after the first tool call. Only the same model's reasoning is
// sent (a signature is not portable), and only when thinking is on.
// RADIANT_REASONING_CARRY=off turns the carry-over off — for the benchmark's
// A/B (bench-harness --tag), never a user setting.
const CARRY_REASONING = () => process.env.RADIANT_REASONING_CARRY !== 'off'
function toAnthropic (messages, { model = null, thinking = false } = {}) {
  const out = []
  for (const m of messages) {
    if (m.role === 'user') {
      const content = []
      const txt = userText(m)
      if (txt) content.push({ type: 'text', text: txt })
      for (const a of imageAttachments(m)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.dataB64 } })
      }
      out.push({ role: 'user', content: content.length ? content : [{ type: 'text', text: '(empty)' }] })
      continue
    }
    let blocks = []
    let pendingTools = []
    const flush = () => {
      if (pendingTools.length) {
        out.push({ role: 'assistant', content: [...blocks, ...pendingTools.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args }))] })
        out.push({
          role: 'user',
          content: pendingTools.map(t => {
            const c = [{ type: 'text', text: String(t.result ?? '') }]
            if (t.resultImage) c.push({ type: 'image', source: { type: 'base64', media_type: t.resultImage.mime, data: t.resultImage.dataB64 } })
            return { type: 'tool_result', tool_use_id: t.id, content: c }
          })
        })
        blocks = []; pendingTools = []
      }
    }
    for (const p of m.parts) {
      if (p.type === 'text') { flush(); if (p.text) blocks.push({ type: 'text', text: p.text }) }
      else if (p.type === 'reasoning') { if (thinking && CARRY_REASONING() && p.provider === 'anthropic' && p.model === model) { flush(); blocks.push(p.block) } }
      else if (p.type === 'tool') { if (!sameRound(pendingTools, p)) flush(); pendingTools.push(p) }
    }
    flush()
    if (blocks.length) out.push({ role: 'assistant', content: blocks })
  }
  return out
}

/**
 * ⚠️ ONE MODEL CALL, ONE ASSISTANT MESSAGE. Every tool call of a turn used to
 * be folded into a single assistant message with a single user message of
 * results — so on round three the request carried assistant:[A, B] where round
 * two had sent assistant:[A]. The bytes at that position changed, the prompt
 * cache matched nothing past the system prompt, and the whole conversation
 * was WRITTEN to cache at 1.25× every round and never read: the harness
 * benchmark measured 7% cached on a Claude subscription against Claude
 * Code's 93%, and Radiant cost four times as much for the same answers. Tool
 * parts carry the round they were made in; calls from the same round were
 * genuinely parallel and stay together, and a new round starts a new message,
 * so each request is the previous one plus a tail. Parts without a round (old
 * sessions) each get their own message, which is always valid.
 */
function sameRound (pending, p) {
  if (!pending.length) return true
  const r = pending[0].round
  return r != null && p.round === r
}

function toOpenAI (messages, system) {
  const out = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      const imgs = imageAttachments(m)
      if (imgs.length) {
        const content = [{ type: 'text', text: userText(m) }]
        for (const a of imgs) content.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.dataB64}` } })
        out.push({ role: 'user', content })
      } else {
        out.push({ role: 'user', content: userText(m) })
      }
      continue
    }
    let text = ''
    let pendingTools = []
    const flush = () => {
      if (pendingTools.length) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: pendingTools.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }))
        })
        for (const t of pendingTools) out.push({ role: 'tool', tool_call_id: t.id, content: String(t.result ?? '') })
        // OpenAI tool results can't carry images; surface any screenshots as a
        // follow-up user message so vision models can see them
        const imgs = pendingTools.filter(t => t.resultImage)
        if (imgs.length) {
          out.push({ role: 'user', content: imgs.map(t => ({ type: 'image_url', image_url: { url: `data:${t.resultImage.mime};base64,${t.resultImage.dataB64}` } })) })
        }
        text = ''; pendingTools = []
      }
    }
    for (const p of m.parts) {
      if (p.type === 'text') { flush(); text += p.text || '' }
      else if (p.type === 'tool') { if (!sameRound(pendingTools, p)) flush(); pendingTools.push(p) }
    }
    flush()
    if (text) out.push({ role: 'assistant', content: text })
  }
  return out
}

// Turn a provider HTTP error body into a short, actionable message.
async function httpErr (res) {
  let raw = ''
  try { raw = await res.text() } catch {}
  let msg = raw
  try { msg = JSON.parse(raw).error?.message || msg } catch {}
  if (/missing_scope|model\.request|insufficient permissions/i.test(raw)) {
    return new Error(`${res.status}: This API key is restricted and can't call models. Create a new key with default (full) permissions — or ensure the "model.request" scope and a Writer/Owner role — then paste it in Settings → Providers.`)
  }
  if (res.status === 401) return new Error(`401: Authentication failed — check the API key (or re-sign-in) for this provider in Settings → Providers.`)
  if (res.status === 402 || /insufficient|quota|billing|credit/i.test(raw)) return new Error(`${res.status}: ${msg} — this usually means the account is out of credit/quota.`)
  // ⚠️ OPENROUTER ANSWERS 404 FOR TWO UNRELATED THINGS AND NAMES NEITHER. Its
  // own wording — "No endpoints available matching your guardrail restrictions
  // and data policy" — never says the account is the reason, so it reads like a
  // dead model. It isn't: free and experimental models are served only by
  // providers that require prompt logging, so an account that denies logging
  // has nothing left to route to. The other 404 really is an unknown model id.
  if (res.status === 404 && /openrouter\.ai/.test(res.url || '')) {
    if (/data policy|guardrail|privacy/i.test(raw)) {
      return new Error(`404: Every provider for this model wants to log your prompts, and your OpenRouter privacy settings don't allow that — so there is no endpoint left to send this to. Free and experimental models are nearly always like this. Allow it at https://openrouter.ai/settings/privacy, or pick a paid model to keep your prompts private.`)
    }
    if (/no endpoints/i.test(raw)) {
      return new Error(`404: OpenRouter has no provider serving this model right now — the id may be retired or misspelled. Pick a different model.`)
    }
  }
  return new Error(`${res.status}: ${msg || 'request failed'}`)
}

// ---------- SSE line reader ----------
async function * sseEvents (response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      try { yield JSON.parse(data) } catch { /* partial or keepalive */ }
    }
  }
}


// ⚠️ A TOOL RESULT IS NEEDED FOR THE NEXT ROUND OR TWO, NOT FOREVER. Measured on
// a real chat of Tony's: 540,000 characters, of which 98% were tool results and
// 1,739 characters were things he actually typed. fetch_url alone was half of
// it — five raw GitHub API responses of 43k, 33k, 33k, 33k and 22k characters,
// kept whole and re-sent on EVERY round. 135k tokens a request, 30 rounds a
// turn, 29.8M tokens over the chat. "how can this chat be so long. i barely did
// anything."
//
// So old results are folded down on the way OUT to the model. Storage is
// untouched and the transcript still shows everything — this changes what the
// request carries, not what happened. Recent results stay whole, because that
// is the window where the agent is still working with them.
// ⚠️ AND THE BOUNDARY MUST NOT MOVE EVERY ROUND, because prompt caching (#3)
// matches on an exact BYTE PREFIX. A boundary of `length - KEEP_WHOLE` advances
// by one on every round, so a message sent whole in round N is sent trimmed in
// round N+7 — the prefix diverges there, and the automatic message-tail
// breakpoint finds nothing to read. Folding would then be paying 1.25x to
// rewrite the cache every round to save characters it had already cached at
// 0.1x, which is worse than not folding at all.
//
// Quantizing the boundary to a step fixes it: the folded prefix is byte-
// identical for STEP consecutive rounds, so the cache is written once and read
// for the rest of them. The cost is keeping up to KEEP_WHOLE + STEP - 1 messages
// whole instead of exactly KEEP_WHOLE, which is a longer verbatim window for the
// agent and not a regression.
const KEEP_WHOLE = 6          // the last N messages keep their results verbatim
const FOLD_STEP = 8           // ...and the boundary only moves every N messages
const FOLD_TO = 600           // how much of an older result survives
// ⚠️ THE MESSAGE COUNT NEVER MOVES DURING A TURN. All of the above folds by
// message, and an agentic turn is ONE message: thirty rounds of read_file and
// run_command land in the same assistant.parts, every one of them re-sent whole
// on every round. Tony's chat died at 259,445 tokens on a 256,000 model with
// THREE messages in it — the per-message fold had nothing to fold, and
// compaction, which also counts messages, declined too. So results are also
// folded by ROUND inside a message: the last KEEP_ROUNDS rounds stay whole and
// the boundary is quantized like the message one, for the same caching reason.
const KEEP_ROUNDS = 4
const ROUND_STEP = 4

// ⚠️ RELEVANCE, NOT JUST AGE (decide.js chooseStale). Past RELEVANCE_AT of the
// model's window, Jev reads the older results against the task and the ones it
// calls dead weight are set aside to one line — before the age fold, the hard
// fold and the summary ever have to run. The verdict is stored on the part, so
// each result is judged once and the prompt changes once: the cache survives.
const RELEVANCE_AT = 0.5          // share of the window before Jev is asked
const RELEVANCE_FALLBACK = 60_000 // tokens, when the window is not known
const RELEVANCE_MIN = 400         // results smaller than this are not worth a question
const RELEVANCE_BATCH = 40        // results judged per request (oldest first)
const RELEVANCE_EVERY = 6         // new candidates needed before asking again

function stubPart (p) {
  const a = p.args || {}
  const head = String(a.command || a.path || a.file_path || a.url || a.query || a.pattern || '').slice(0, 100)
  if (p.stale === 'superseded') return { ...p, result: `[Replaced: a later, identical ${p.name}${head ? ` (${head})` : ''} below has the current output.]` }
  return {
    ...p,
    result: `[Set aside: this earlier ${p.name}${head ? ` (${head})` : ''} was judged no longer needed for the task. ${p.archive?.id ? `recall(id: "${p.archive.id}") reads it back if it is.` : 'Run it again if you need it.'}]`
  }
}

function foldPart (p) {
  if (p.type === 'tool' && p.stale && typeof p.result === 'string') return stubPart(p)
  if (p.type !== 'tool' || typeof p.result !== 'string' || p.result.length <= FOLD_TO) return p
  // ⚠️ KEEP THE TAIL TOO, AND POINT AT THE ARCHIVE. A result folded to its
  // first 600 characters loses the line that mattered — the exit code, the
  // last assertion — and "run it again" is another round and not always safe.
  // With the full text kept on disk (archiveResult), the excerpt is complete
  // head and tail lines and the exact original is one recall away.
  if (p.archive?.id) {
    const head = p.result.slice(0, Math.floor(FOLD_TO * 0.6)).replace(/[^\n]*$/, '')
    const tail = p.result.slice(-Math.floor(FOLD_TO * 0.4)).replace(/^[^\n]*\n/, '')
    return {
      ...p,
      result: `${head}\n\n[… trimmed: ${p.archive.lines} lines, ${p.archive.size} bytes in all. The exact output is kept — recall(id: "${p.archive.id}") reads it back by page, or with find.]\n\n${tail}`
    }
  }
  return {
    ...p,
    result: p.result.slice(0, FOLD_TO) +
      `\n\n[… ${p.result.length - FOLD_TO} more characters from this earlier ${p.name} were trimmed to keep the conversation small. Run it again if you need the rest.]`
  }
}

// `hard` is the emergency setting for a request the provider has just refused:
// every result folds except the current round's, whatever the quantization
// would have kept — the cache is already lost on a rejected request.
export function foldOldToolResults (messages, { hard = false } = {}) {
  const cut = Math.floor((messages.length - KEEP_WHOLE) / FOLD_STEP) * FOLD_STEP
  let folded = 0
  const out = messages.map((m, i) => {
    if (!Array.isArray(m.parts)) return m
    const wholeMessage = hard ? i < messages.length - 1 : i < cut
    let lastRound = -1
    for (const p of m.parts) if (p.type === 'tool' && Number.isInteger(p.round) && p.round > lastRound) lastRound = p.round
    const cutRound = hard
      ? lastRound
      : Math.floor((lastRound + 1 - KEEP_ROUNDS) / ROUND_STEP) * ROUND_STEP
    let touched = false
    const parts = m.parts.map(p => {
      const old = p.stale || wholeMessage || (Number.isInteger(p.round) && p.round < cutRound)
      if (!old) return p
      const q = foldPart(p)
      if (q !== p) { touched = true; folded += Math.max(1, p.result.length - q.result.length) }
      return q
    })
    return touched ? { ...m, parts } : m
  })
  return folded ? out : messages
}

// ---------- single API round, streaming; returns {parts, stopOnTools} ----------
// ⚠️ ONE SLIDER, THREE DIFFERENT PARAMETERS. Radiant never asked for a thinking
// level at all — it rendered whatever reasoning came back and let every model run
// at its provider's default, so there was nothing to display and nothing to
// change. Tony: "when i pick a model like gpt 5.6 sol how do i know what thinking
// level it is. can we make a slider?"
//
// The three APIs disagree on the shape:
//   Anthropic          thinking: { type: 'enabled', budget_tokens: N }   (a BUDGET)
//   OpenAI-compatible  reasoning_effort: 'low' | 'medium' | 'high'
//   Responses/Codex    reasoning: { effort: 'low' | 'medium' | 'high' }
//
// ⚠️ 'auto' MEANS SEND NOTHING. It is the default, and it reproduces today's
// behaviour byte for byte — so a model that does not do reasoning, or a provider
// that rejects the parameter, is untouched unless the user deliberately asks for
// a level. Anything else would break working chats to add a control.
export const EFFORTS = ['auto', 'low', 'medium', 'high']

// Anthropic budgets, in tokens. Minimum accepted is 1024; the reply needs room of
// its own, so max_tokens is raised alongside rather than eaten into.
const THINK_BUDGET = { low: 2048, medium: 6144, high: 12288 }

async function anthropicRound ({ baseUrl, apiKey, accessToken, model, messages, systemStable, systemVolatile, tools, toolDefs, effort, cachingEnabled, cacheTtl, emit, signal }) {
  // Subscription (OAuth) requests must present as Claude Code: the first system
  // block is the CLI's identity, auth is Bearer, and the oauth beta is set.
  const CLAUDE_CODE_ID = "You are Claude Code, Anthropic's official CLI for Claude."
  // Prompt caching, on by default (Settings → caching toggle) but skippable —
  // some Anthropic-compatible baseUrls reject cache_control, and single-shot
  // (non-conversational) turns get zero benefit from a cache write.
  // ⚠️ ONLY THE STABLE HALF GETS THE MARKER. Anthropic renders tools -> system
  // -> messages, so a breakpoint on the last block of the stable system text
  // caches tool definitions too. The volatile half (memory / plan addendum —
  // see systemPrompt()'s comment) is appended as a SEPARATE, unmarked system
  // block after it: still sent every turn, but its churn can't invalidate the
  // marked prefix before it. System must be block form (not a bare string) for
  // cache_control to attach.
  // Anthropic renders tools BEFORE system, and a breakpoint on the last system
  // block caches both together — so the minimum-cacheable-length check has to
  // count tool definitions too, not just the (often short on its own) stable
  // system text. Measuring systemStable alone under-counts the real prefix and
  // wrongly skips caching on a normal tool-using turn.
  const toolDefsForBody = tools ? (toolDefs || TOOL_DEFS).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : null
  const prefixTokens = roughTokens(systemStable) + (toolDefsForBody ? roughTokens(JSON.stringify(toolDefsForBody)) : 0)
  const useCaching = cachingEnabled !== false && prefixTokens >= MIN_CACHEABLE_TOKENS
  const cacheControl = useCaching ? { type: 'ephemeral', ...(cacheTtl === '1h' ? { ttl: '1h' } : {}) } : null
  const sys = accessToken ? [{ type: 'text', text: CLAUDE_CODE_ID }] : []
  sys.push(cacheControl
    ? { type: 'text', text: systemStable, cache_control: cacheControl }
    : { type: 'text', text: systemStable })
  if (systemVolatile) sys.push({ type: 'text', text: systemVolatile })
  const body = { model, max_tokens: 8192, system: sys, messages, stream: true }
  // ⚠️ RAISE max_tokens WITH THE BUDGET, do not carve the budget out of it — the
  // thinking budget and the visible reply share this number, so a 12k budget under
  // an 8k cap would leave nothing to answer with (and Anthropic rejects a budget
  // that is not strictly smaller than max_tokens).
  if (THINK_BUDGET[effort]) {
    body.thinking = { type: 'enabled', budget_tokens: THINK_BUDGET[effort] }
    body.max_tokens = 8192 + THINK_BUDGET[effort]
  }
  if (toolDefsForBody) body.tools = toolDefsForBody
  // Top-level automatic caching covers the growing conversation tail: Anthropic
  // places (and walks forward) its own breakpoint on the last cacheable message
  // block, which is the documented default for multi-turn conversations and
  // avoids hand-tracking positions against the 20-block lookback window
  // ourselves (shared/prompt-caching.md, "Automatic vs explicit breakpoints" +
  // "The robust combination for agent loops"). Composes with the explicit
  // system-block marker above (2 of the 4 available breakpoint slots used).
  if (useCaching && messages.length) body.cache_control = cacheControl
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
    headers['anthropic-beta'] = ['oauth-2025-04-20', 'claude-code-20250219', ...(cacheTtl === '1h' ? ['extended-cache-ttl-2025-04-11'] : [])].join(',')
  } else {
    headers['x-api-key'] = apiKey
    if (cacheTtl === '1h') headers['anthropic-beta'] = 'extended-cache-ttl-2025-04-11'
  }
  if (process.env.RADIANT_USAGE_DEBUG) console.error('[anthropic req]', JSON.stringify({ model, prefixTokens, useCaching, cachingEnabled, sysBlocks: sys.map(b => ({ len: b.text.length, cc: !!b.cache_control })), topCC: !!body.cache_control, tools: (body.tools || []).length, msgs: body.messages.length, thinking: body.thinking, output_config: body.output_config }))
  const res = await modelFetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw await httpErr(res)

  const parts = []
  let current = null // {type:'text',text} or {type:'tool',id,name,json}
  let stopReason = null
  for await (const ev of sseEvents(res)) {
    if (ev.type === 'message_start' && ev.message?.usage) {
      // With caching on, `input_tokens` is only the uncached remainder — cached
      // reads/writes land in separate fields. Sum all three so the context-window
      // gauge still reflects the true prompt size, not just what was billed fresh.
      const u = ev.message.usage
      if (process.env.RADIANT_USAGE_DEBUG) console.error('[anthropic usage]', JSON.stringify(u))
      const totalIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      // ⚠️ AND SAY HOW MUCH OF IT WAS CACHED. The OpenAI path reported
      // cacheRead and this one did not, so on a Claude subscription — the
      // provider Tony actually uses — the "% cached" readout never appeared
      // and nobody could tell a working cache from a burning one. The split is
      // also what a cost needs: a cached read is a tenth the price of a fresh
      // token and a cache write a quarter more, so "input" alone cannot be
      // priced. scripts/bench-harness.mjs prices from these three numbers.
      emit({
        type: 'usage', input: totalIn, output: 0,
        ...(u.cache_read_input_tokens ? { cacheRead: u.cache_read_input_tokens } : {}),
        ...(u.cache_creation_input_tokens ? { cacheWrite: u.cache_creation_input_tokens } : {})
      })
    }
    else if (ev.type === 'content_block_start') {
      const b = ev.content_block
      if (b.type === 'text') current = { type: 'text', text: '' }
      // Kept whole, signature and all: the next step of a tool-using turn must
      // send it back (see the REASONING note at toAnthropic).
      else if (b.type === 'thinking') current = { type: 'thinking', thinking: '', signature: '' }
      else if (b.type === 'redacted_thinking') current = { type: 'redacted', data: b.data }
      else if (b.type === 'tool_use') current = { type: 'tool', id: b.id, name: b.name, json: '' }
      else current = { type: 'skip' }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta
      if (d.type === 'text_delta' && current?.type === 'text') { current.text += d.text; emit({ type: 'text_delta', text: d.text }) }
      else if (d.type === 'thinking_delta') { if (current?.type === 'thinking') current.thinking += d.thinking; emit({ type: 'thinking_delta', text: d.thinking }) }
      else if (d.type === 'signature_delta' && current?.type === 'thinking') current.signature = d.signature
      else if (d.type === 'input_json_delta' && current?.type === 'tool') current.json += d.partial_json
    } else if (ev.type === 'content_block_stop') {
      if (current?.type === 'text' && current.text) parts.push({ type: 'text', text: current.text })
      else if (current?.type === 'thinking' && current.signature) parts.push({ type: 'reasoning', provider: 'anthropic', model, block: { type: 'thinking', thinking: current.thinking, signature: current.signature } })
      else if (current?.type === 'redacted' && current.data) parts.push({ type: 'reasoning', provider: 'anthropic', model, block: { type: 'redacted_thinking', data: current.data } })
      else if (current?.type === 'tool') {
        let args = {}
        try { args = current.json ? JSON.parse(current.json) : {} } catch {}
        parts.push({ type: 'tool', id: current.id, name: current.name, args })
      }
      current = null
    } else if (ev.type === 'message_delta') {
      stopReason = ev.delta?.stop_reason || stopReason
      if (ev.usage) emit({ type: 'usage', output: ev.usage.output_tokens })
    } else if (ev.type === 'error') {
      throw new Error(ev.error?.message || 'stream error')
    }
  }
  return { parts, stopOnTools: stopReason === 'tool_use', finish: stopReason === 'max_tokens' ? 'length' : stopReason }
}

// OpenRouter passes Anthropic-style cache_control breakpoints through to Claude
// models routed via Anthropic on its /chat/completions endpoint (confirmed against
// OpenRouter's current docs, "Explicit per-block cache_control breakpoints work
// across all Anthropic-compatible providers"). Mirrors PR #3's two-breakpoint
// pattern: mark the system prefix and the tail message. OpenAI itself and every
// other openaiRound-routed provider (plain OpenAI, Ollama, LM Studio, Copilot,
// xAI, etc.) get NO markers here — OpenAI's own caching is automatic/implicit and
// needs no client marker (see openaiRound's usage-observability comment below),
// and other providers may reject an unrecognized `cache_control` field outright.
function withOpenRouterClaudeCaching (body, provider, model, cachingEnabled) {
  // ⚠️ THE SETTING HAS TO REACH EVERY PATH IT CLAIMS TO GOVERN. Settings offers
  // one switch called "Prompt caching (Claude models)", and OpenRouter's Claude
  // models are Claude models. Reading cachingEnabled in anthropicRound alone
  // would leave this path caching after the user turned caching off — a switch
  // that governs one provider and silently not another is worse than no switch,
  // because the user cannot tell which half they got.
  if (cachingEnabled === false) return
  if (provider?.id !== 'openrouter' || !/claude/i.test(model || '')) return
  const ephemeral = { type: 'ephemeral' }
  const asBlock = content => typeof content === 'string'
    ? [{ type: 'text', text: content, cache_control: ephemeral }]
    : content
  const sys = body.messages.find(m => m.role === 'system')
  if (sys) sys.content = asBlock(sys.content)
  const last = body.messages[body.messages.length - 1]
  if (last && last !== sys && typeof last.content === 'string') last.content = asBlock(last.content)
}

// ⚠️ A STREAM WITHOUT USAGE IS A TURN THAT CANNOT SEE ITS OWN SIZE. Ollama,
// OpenAI and OpenRouter send prompt_tokens on a streamed reply only when asked
// with stream_options.include_usage — so for every local model lastPrompt
// stayed 0, the 85% hard-fold never fired, the gauge showed nothing, and a
// chat could grow past the model's context in silence. Providers that reject
// the field (a 400 naming it) are remembered and asked without it.
const noStreamOptions = new Set()

// Models that answered a thinking level with a 400: provider:model. Asked without it from then on.
const noEffort = new Set()

async function openaiRound ({ baseUrl, apiKey, accessToken, model, messages, tools, toolDefs, extraHeaders, effort, provider, cachingEnabled, emit, signal }) {
  const body = { model, messages, stream: true }
  if (!noStreamOptions.has(provider?.id)) body.stream_options = { include_usage: true }
  if (effort && effort !== 'auto') body.reasoning_effort = effort
  if (tools) {
    body.tools = (toolDefs || TOOL_DEFS).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  }
  withOpenRouterClaudeCaching(body, provider, model, cachingEnabled)
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) }
  const bearer = accessToken || apiKey
  if (bearer) headers.authorization = `Bearer ${bearer}`
  let res = await modelFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok && res.status === 400 && body.stream_options) {
    const raw = await res.clone().text().catch(() => '')
    if (/stream_options/i.test(raw)) {
      noStreamOptions.add(provider?.id)
      delete body.stream_options
      res = await modelFetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal })
    }
  }
  if (!res.ok) throw await httpErr(res)

  let text = ''
  const calls = [] // by index: {id, name, args:''}
  let finish = null
  let servedBy = null // a router (Jev Router, openrouter/auto) names the model it chose on each chunk
  for await (const chunk of sseEvents(res)) {
    if (!servedBy && chunk.model) servedBy = chunk.model
    const choice = chunk.choices?.[0]
    if (chunk.usage) {
      // Unlike Anthropic, OpenAI-family cached_tokens is a SUBSET of prompt_tokens,
      // not additive — prompt_tokens already reflects the true prefix size, so
      // there is no under-reporting bug here for the ContextGauge to fix (that was
      // Anthropic-specific, see anthropicRound). cacheRead is surfaced separately,
      // purely for a future cache-hit-rate indicator, and is a no-op if the
      // provider doesn't send prompt_tokens_details (most non-OpenAI/OpenRouter
      // openaiRound providers won't).
      const cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens
      emit({ type: 'usage', input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, ...(cacheRead ? { cacheRead } : {}) })
    }
    if (!choice) continue
    const d = choice.delta || {}
    const reasoning = d.reasoning_content ?? d.reasoning
    if (reasoning) emit({ type: 'thinking_delta', text: reasoning })
    if (d.content) { text += d.content; emit({ type: 'text_delta', text: d.content }) }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? 0
      calls[i] = calls[i] || { id: tc.id || `call_${i}_${calls.length}`, name: '', args: '' }
      if (tc.id) calls[i].id = tc.id
      if (tc.function?.name) calls[i].name += tc.function.name
      if (tc.function?.arguments) calls[i].args += tc.function.arguments
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  const parts = []
  let live = calls.filter(Boolean)
  // ⚠️ A LOCAL MODEL CAN WRITE ITS TOOL CALL AS TEXT. A chat template without
  // tool support — common on community quants — makes the model emit
  // <tool_call>{"name":…,"arguments":…}</tool_call> inside content. Radiant
  // used to show that as prose and end the turn: work stopped, nothing said.
  if (!live.length && text && /<tool_call>/i.test(text)) {
    const inline = parseInlineToolCalls(text)
    if (inline.length) { live = inline; text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim() }
  }
  if (text) parts.push({ type: 'text', text })
  for (const c of live) {
    let args = {}
    try { args = c.args ? JSON.parse(c.args) : {} } catch {}
    parts.push({ type: 'tool', id: c.id, name: c.name, args })
  }
  return { parts, stopOnTools: finish === 'tool_calls' || live.length > 0, finish, ...(model === JEV_ROUTER && servedBy && servedBy !== model ? { servedBy } : {}) }
}

/**
 * Ask Jev which older tool results the task no longer needs, and set those
 * aside (p.stale). Candidates: results big enough to matter, not yet judged,
 * outside the current reply's last KEEP_ROUNDS rounds. Never throws, never
 * blocks the turn on a failure — a null answer leaves everything as it was.
 */
export async function setAsideStale ({ session, assistant, round, judgeRelevance, emit }) {
  // ⚠️ SUPERSEDED NEEDS NO JUDGE. The same file read again, the same command run
  // again: the earlier copy is out of date by definition, and the code can see
  // that exactly. Only an identical call counts — a read of a different range
  // or a different command is not a newer copy of anything.
  const lastCall = new Map()
  const tools = []
  for (const m of session.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.parts)) continue
    for (const p of m.parts) if (p.type === 'tool' && /^(read_file|run_command)$/.test(p.name)) tools.push(p)
  }
  for (const p of tools) lastCall.set(`${p.name}:${JSON.stringify(p.args || {})}`, p)
  let superseded = 0, supersededChars = 0
  for (const p of tools) {
    if (p.stale || typeof p.result !== 'string' || p.result.length < RELEVANCE_MIN) continue
    if (lastCall.get(`${p.name}:${JSON.stringify(p.args || {})}`) !== p) { p.stale = 'superseded'; superseded++; supersededChars += p.result.length }
  }
  const candidates = []
  for (const m of session.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      if (p.type !== 'tool' || p.relevance != null || p.stale || typeof p.result !== 'string' || p.result.length < RELEVANCE_MIN) continue
      if (m === assistant && Number.isInteger(p.round) && p.round >= round - KEEP_ROUNDS) continue
      candidates.push(p)
    }
  }
  const said = (n, chars, how) => n && emit({ type: 'notice', text: `Set aside ${n} earlier tool result${n === 1 ? '' : 's'} ${how} — about ${Math.max(1, Math.round(chars / 4000))}k tokens lighter. ${n === 1 ? 'It stays' : 'They stay'} in the chat; the agent can read ${n === 1 ? 'it' : 'them'} back if needed.` })
  if (candidates.length < RELEVANCE_EVERY) {
    said(superseded, supersededChars, 'that a later, identical call replaced')
    return superseded ? { judged: 0, stale: 0, superseded, chars: supersededChars, ms: 0 } : null
  }
  const batch = candidates.slice(0, RELEVANCE_BATCH)
  // The goal is usually the FIRST thing asked; the latest message is often "keep going".
  const asks = session.messages.filter(m => m.role === 'user' && m.text).map(m => m.text)
  const task = asks.length > 1 && asks[asks.length - 1] !== asks[0] ? `${asks[0].slice(0, 1000)}\n\nLatest: ${asks[asks.length - 1].slice(0, 500)}` : (asks[0] || '')
  const plan = (session.todos || []).map(t => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'} ${t.content}`).join('\n')
  const recent = assistant.parts.filter(p => p.type === 'text').map(p => p.text).join('\n').slice(-800)
  const t0 = Date.now()
  let out = null
  try {
    out = await judgeRelevance({
      task: task.slice(0, 1500),
      plan,
      recent,
      candidates: batch.map((p, i) => {
        const a = p.args || {}
        const r = p.result
        return { key: i, name: p.name, head: String(a.command || a.path || a.file_path || a.url || a.query || a.pattern || JSON.stringify(a)).slice(0, 140), excerpt: r.length > 700 ? `${r.slice(0, 450)} … ${r.slice(-200)}` : r }
      })
    })
  } catch { out = null }
  if (!out) {
    said(superseded, supersededChars, 'that a later, identical call replaced')
    return superseded ? { judged: 0, stale: 0, superseded, chars: supersededChars, ms: 0 } : null
  }
  let chars = 0
  for (const v of out.kept) batch[v.key].relevance = Math.round(v.p * 100) / 100
  for (const v of out.stale) {
    const p = batch[v.key]
    p.relevance = Math.round(v.p * 100) / 100
    p.stale = true
    chars += p.result.length
  }
  said(out.stale.length + superseded, chars + supersededChars, `this task no longer needs (decided in ${((Date.now() - t0) / 1000).toFixed(1)} s)`)
  return { judged: batch.length, stale: out.stale.length, superseded, chars: chars + supersededChars, ms: Date.now() - t0 }
}

/**
 * Set aside whole earlier exchanges — a request and the replies to it — that
 * Jev judges unrelated to the current task (m.setAside on every message in
 * it). They stay in the saved chat and on screen; they are not sent. The first
 * request (the goal, or a compaction summary) and the last KEEP_TURNS_RECENT
 * messages are never candidates, and an exchange is only taken whole, so a
 * tool call is never separated from its result. Returns { dropped, chars } or
 * null. Never throws.
 */
const KEEP_TURNS_RECENT = 4
export async function setAsideTurns ({ session, assistant, judgeRelevance, emit }) {
  const live = session.messages.filter(m => !m.setAside && m !== assistant)
  let cutoff = live.length - KEEP_TURNS_RECENT
  while (cutoff > 0 && live[cutoff]?.role !== 'user') cutoff--   // end on an exchange boundary
  const groups = []
  for (const m of live.slice(0, Math.max(cutoff, 0))) {
    if (m.role === 'user') groups.push([m])
    else if (groups.length) groups[groups.length - 1].push(m)
  }
  const candidates = groups.slice(1).filter(g => g[0].relevance == null)
  if (candidates.length < 1) return null
  const asks = live.filter(m => m.role === 'user' && m.text).map(m => m.text)
  const latest = asks[asks.length - 1] || ''
  const task = asks[0] && asks[0] !== latest ? `${latest.slice(0, 1000)}\n\n(The conversation began with: ${asks[0].slice(0, 400)})` : latest.slice(0, 1400)
  const excerpt = g => {
    const said = g.slice(1).flatMap(m => (m.parts || []).filter(p => p.type === 'text').map(p => p.text)).join(' ').replace(/\s+/g, ' ')
    const tools = [...new Set(g.slice(1).flatMap(m => (m.parts || []).filter(p => p.type === 'tool').map(p => p.name)))]
    return `Request: ${String(g[0].text || '').replace(/\s+/g, ' ').slice(0, 400)}\nReply: ${said.slice(0, 500) || '(tools only)'}${tools.length ? `\nTools used: ${tools.slice(0, 10).join(', ')}` : ''}`
  }
  const t0 = Date.now()
  let out = null
  try {
    out = await judgeRelevance({ task, plan: (session.todos || []).map(t => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n'), recent: '', subject: 'exchange', candidates: candidates.slice(0, RELEVANCE_BATCH).map((g, i) => ({ key: i, name: 'exchange', head: '', excerpt: excerpt(g) })) })
  } catch { out = null }
  if (!out) return null
  let chars = 0
  for (const v of out.kept) candidates[v.key][0].relevance = Math.round(v.p * 100) / 100
  for (const v of out.stale) {
    const g = candidates[v.key]
    g[0].relevance = Math.round(v.p * 100) / 100
    for (const m of g) { m.setAside = true; chars += JSON.stringify(m).length }
  }
  if (out.stale.length) {
    emit({ type: 'notice', text: `Set aside ${out.stale.length} earlier exchange${out.stale.length === 1 ? '' : 's'} about something other than the current task — about ${Math.max(1, Math.round(chars / 4000))}k tokens, decided in ${((Date.now() - t0) / 1000).toFixed(1)} s — instead of summarizing the conversation. ${out.stale.length === 1 ? 'It stays' : 'They stay'} in the chat; ${out.stale.length === 1 ? 'it is' : 'they are'} just not sent to the model.` })
  }
  return { dropped: out.stale.length, judged: candidates.length, chars, ms: Date.now() - t0 }
}

/** <tool_call>{"name":"x","arguments":{...}}</tool_call> blocks in text → calls. */
export function parseInlineToolCalls (text) {
  const out = []
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let m, i = 0
  while ((m = re.exec(text))) {
    try {
      const j = JSON.parse(m[1])
      const name = j.name || j.function?.name
      if (!name) continue
      const args = j.arguments ?? j.parameters ?? j.function?.arguments ?? {}
      out.push({ id: `inline_${Date.now()}_${i++}`, name, args: typeof args === 'string' ? args : JSON.stringify(args) })
    } catch {}
  }
  return out
}

// ---------- ChatGPT subscription: OpenAI Responses API via the Codex backend ----------
// A ChatGPT (Plus/Pro) OAuth token can't call api.openai.com/v1/chat/completions
// (401 "missing scope: model.request"). The Codex CLI routes subscription traffic
// to chatgpt.com/backend-api/codex/responses using the Responses API shape plus a
// ChatGPT-Account-ID header. We mirror that. (Unofficial — same client as Codex.)
// overridable so scripts/test-caching.mjs can point this path at a stub
const CHATGPT_BASE = process.env.RADIANT_CHATGPT_BASE || 'https://chatgpt.com/backend-api/codex'
// The Codex backend gates model visibility by client_version. Keep this current;
// an override lets deployments pick up newer models before the next release.
const CODEX_CLIENT_VERSION = process.env.RADIANT_CODEX_CLIENT_VERSION || '0.160.1'
const CHATGPT_DEFAULT_MODEL = 'gpt-5.6-sol'

// Live model list for a ChatGPT subscription (the Codex backend renames models
// often — gpt-5-codex/gpt-5 are retired; current ids are gpt-5.6-sol etc.).
async function chatgptModels (accessToken, accountId) {
  try {
    const r = await fetchRetry(`${CHATGPT_BASE}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: { authorization: `Bearer ${accessToken}`, 'chatgpt-account-id': accountId || '', originator: 'codex_cli_rs', 'openai-beta': 'responses=experimental', accept: 'application/json' },
      signal: AbortSignal.timeout(6000)
    })
    if (!r.ok) return null
    const data = await r.json()
    const list = (data.models || []).filter(m => m.supported_in_api && m.visibility === 'list').map(m => ({ id: m.slug, label: m.display_name || m.slug }))
    return list.length ? list : null
  } catch { return null }
}

function toResponsesInput (messages, model = null) {
  const input = []
  for (const m of messages) {
    if (m.role === 'user') {
      const content = [{ type: 'input_text', text: userText(m) }]
      for (const a of imageAttachments(m)) content.push({ type: 'input_image', image_url: `data:${a.mime};base64,${a.dataB64}` })
      input.push({ type: 'message', role: 'user', content })
      continue
    }
    for (const p of m.parts) {
      // the same model's encrypted reasoning, in the place it was produced (see toAnthropic)
      if (p.type === 'reasoning') { if (p.provider === 'codex' && p.model === model && CARRY_REASONING()) input.push(p.item) }
      else if (p.type === 'text' && p.text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: p.text }] })
      else if (p.type === 'tool') {
        input.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.args || {}) })
        input.push({ type: 'function_call_output', call_id: p.id, output: String(p.result ?? '') })
      }
    }
  }
  return input
}

async function chatgptRound ({ accessToken, accountId, model, messages, system, tools, toolDefs, effort, emit, signal, cacheKey }) {
  // The Codex backend rejects retired ids (gpt-5, gpt-5-codex, gpt-5.1…); remap
  // those to the current default. Live ids (gpt-5.6-sol, gpt-5.5, …) pass through.
  const retired = /codex|^gpt-5$|^gpt-5\.1$|^gpt-4/i.test(model)
  const useModel = (!model || retired) ? CHATGPT_DEFAULT_MODEL : model
  // ⚠️ THE PROMPT CACHE WAS NEVER HIT. OpenAI routes a request to the cache
  // by prompt_cache_key (and the session_id header), and this sent a NEW
  // random session_id on every round with no cache key at all — so an
  // identical 17k-token prefix was billed fresh every single call. The
  // harness benchmark's first Radiant attempt read 286k input tokens, 0
  // cached, on a 13-round task. Codex CLI sends one id per conversation;
  // so does this now. (The usage log that found it: RADIANT_USAGE_DEBUG=1.)
  // include: the reasoning comes back encrypted (store is false), so the next
  // step can send it — what Codex CLI does.
  const body = { model: useModel, instructions: system, input: toResponsesInput(messages, useModel), store: false, stream: true, include: ['reasoning.encrypted_content'], ...(cacheKey ? { prompt_cache_key: cacheKey } : {}) }
  if (effort && effort !== 'auto') body.reasoning = { effort }
  if (tools) body.tools = (toolDefs || TOOL_DEFS).map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }))
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId || '',
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: cacheKey || crypto.randomUUID(),
    accept: 'text/event-stream'
  }
  if (process.env.RADIANT_USAGE_DEBUG) console.error('[req]', 'tools', body.tools ? body.tools.length : 0, 'toolBytes', JSON.stringify(body.tools || []).length, 'instrBytes', String(system).length, 'names', (body.tools||[]).map(t=>t.name).join(','))
  const res = await fetchRetry(`${CHATGPT_BASE}/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw await httpErr(res)

  let text = ''
  const reasoning = [] // encrypted reasoning items, in order
  const byItem = {} // output_item id -> { id: call_id, name, args }
  for await (const ev of sseEvents(res)) {
    switch (ev.type) {
      case 'response.output_text.delta': text += ev.delta || ''; emit({ type: 'text_delta', text: ev.delta || '' }); break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': emit({ type: 'thinking_delta', text: ev.delta || '' }); break
      case 'response.output_item.added':
        if (ev.item?.type === 'function_call') byItem[ev.item.id] = { id: ev.item.call_id, name: ev.item.name || '', args: ev.item.arguments || '' }
        break
      case 'response.function_call_arguments.delta': {
        const c = byItem[ev.item_id]; if (c) c.args += ev.delta || ''; break
      }
      case 'response.output_item.done':
        if (ev.item?.type === 'reasoning' && ev.item.encrypted_content) {
          reasoning.push({ type: 'reasoning', provider: 'codex', model: useModel, item: { type: 'reasoning', summary: ev.item.summary || [], encrypted_content: ev.item.encrypted_content } })
        }
        if (ev.item?.type === 'function_call') byItem[ev.item.id] = { id: ev.item.call_id, name: ev.item.name, args: ev.item.arguments || byItem[ev.item.id]?.args || '' }
        break
      case 'response.completed': {
        // ⚠️ THE CACHED SHARE, HERE TOO. The Responses API reports it under
        // input_tokens_details.cached_tokens; without it a ChatGPT sign-in
        // showed no "% cached" and priced every token as fresh — the
        // benchmark's first Radiant attempt read 313k in, 0 cached.
        const u = ev.response?.usage
        if (u && process.env.RADIANT_USAGE_DEBUG) console.error('[usage]', JSON.stringify(u))
        if (u) emit({ type: 'usage', input: u.input_tokens, output: u.output_tokens, ...(u.input_tokens_details?.cached_tokens ? { cacheRead: u.input_tokens_details.cached_tokens } : {}) })
        break
      }
      case 'response.failed': throw new Error(ev.response?.error?.message || 'ChatGPT response failed')
    }
  }
  const parts = [...reasoning]
  if (text) parts.push({ type: 'text', text })
  const calls = Object.values(byItem)
  for (const c of calls) {
    let args = {}; try { args = c.args ? JSON.parse(c.args) : {} } catch {}
    parts.push({ type: 'tool', id: c.id, name: c.name, args })
  }
  return { parts, stopOnTools: calls.length > 0, finish: null }
}

// Tool that lets one agent consult another. Injected only when peers exist.
function askAgentToolDef (peers) {
  return {
    name: 'ask_agent',
    description: `Consult another Radiant agent and get their answer back as text. Use it for a second opinion or to delegate a sub-question to a specialist, then incorporate their reply. Available agents:\n${peers.map(p => `- ${p.name}: ${p.blurb}`).join('\n')}`,
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the agent to consult (one of the listed agents)' },
        question: { type: 'string', description: 'The question or task to hand that agent — include the context they need, they cannot see this conversation.' }
      },
      required: ['agent', 'question']
    }
  }
}

// Tool that fans research out to read-only subagents. Injected only when the
// caller supplies a `research` callback (index.js), never inside a subagent.
//
// ⚠️ THE MAIN AGENT'S CONTEXT IS THE EXPENSIVE THING. Answering "where is X
// handled and why" means reading a dozen files, and every one of them then rides
// along in every later round of the turn, at flagship prices. A subagent reads
// them in its own context on the cheap model and hands back a paragraph and a
// list of paths; only that comes home. Cline's idea, approved for TG-514.
// The task board, from inside a chat — the agent-side half of the kanban
// (Hermes gives its workers the same powers as fourteen kanban_* tools). ONE
// tool with an action, because every schema rides on every model call.
const BOARD_TOOL = {
  name: 'task_board',
  description: "Radiant's task board (kanban). Actions: list — every task with its id, title, column, priority and what it waits on. show — one task's description, comments and links. create — add a task (title, detail, priority, labels, blockedBy); use it to split work into subtasks or record follow-ups; a new task waits in Queued for the user to start it. comment — add a comment to a task (defaults to the task this chat belongs to): report progress, a decision, or what you need. link — make a task wait on others (blockedBy). The run sets Working / Needs you / Review by itself; only the user can mark a task Done.",
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'show', 'create', 'comment', 'link'] },
      id: { type: 'string', description: 'Task id (show, comment, link). Omit to mean this chat\'s own task.' },
      title: { type: 'string' },
      detail: { type: 'string', description: 'Markdown description (create).' },
      priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] },
      labels: { type: 'array', items: { type: 'string' } },
      blockedBy: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must be Done first (create, link).' },
      text: { type: 'string', description: 'The comment (comment).' }
    },
    required: ['action']
  }
}

const RESEARCH_TOOL = {
  name: 'research',
  description: 'Hand one or more focused questions about the codebase to parallel read-only research subagents. Each runs in its own context on a fast model, reads files and runs read-only commands (grep, git log, ls…), and returns an answer plus the files that matter and why. Use it when answering would mean reading many files you do not need to keep — "where is X handled", "how does Y flow from A to B", "which files touch Z" — and ask several independent questions in one call so they run at once. Subagents cannot change anything and cannot see this conversation, so put the context they need in the question.',
  input_schema: {
    type: 'object',
    properties: {
      questions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, description: 'One to five self-contained questions. Each gets its own subagent; independent questions run in parallel.' }
    },
    required: ['questions']
  }
}
// What a research subagent may call. Everything else is refused at dispatch as
// well as left out of the schema — the plan-mode lesson: a schema is not a gate.
const READ_ONLY_TOOLS = new Set(['read_file', 'run_command', 'recall'])

const ASK_USER_TOOL = {
  name: 'ask_user',
  description: 'Ask the user a question and pause until they answer. Use this when a decision is genuinely theirs (ambiguous requirements, a fork with real tradeoffs) rather than guessing. Prefer offering a few concrete options.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'A few concrete choices (optional). The user may also type their own answer.' }
    },
    required: ['question']
  }
}

const SHOW_WIDGET_TOOL = {
  name: 'show_widget',
  description: 'Render a rich inline widget in the chat instead of (or alongside) plain prose, when structured data would land better than a paragraph. Use it for: a comparison table, a set of key stats/metrics, a before/after code diff, or a decision card offering the user a few choices. Keep it focused — one widget per call, and still write a short sentence of prose around it. Ordinary explanations that read fine as text stay as text.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['stats', 'table', 'diff', 'choices'], description: 'stats = metric cards; table = rows/columns; diff = before/after code; choices = a decision card (clicking a choice sends it back as the user\'s answer).' },
      title: { type: 'string', description: 'Optional heading for the widget.' },
      // stats
      stats: { type: 'array', description: 'For kind=stats: metric cards.', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, delta: { type: 'string', description: 'Optional change, e.g. "+12%"' }, tone: { type: 'string', enum: ['neutral', 'positive', 'caution', 'negative'] } }, required: ['label', 'value'] } },
      // table
      columns: { type: 'array', description: 'For kind=table: column headers.', items: { type: 'string' } },
      rows: { type: 'array', description: 'For kind=table: each row is an array of cell strings matching columns.', items: { type: 'array', items: { type: 'string' } } },
      // diff
      language: { type: 'string', description: 'For kind=diff: language hint, e.g. "js".' },
      before: { type: 'string', description: 'For kind=diff: the original code.' },
      after: { type: 'string', description: 'For kind=diff: the changed code.' },
      // choices
      question: { type: 'string', description: 'For kind=choices: the prompt shown above the options.' },
      options: { type: 'array', description: 'For kind=choices: the selectable answers.', items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string', description: 'Optional one-line explanation.' }, tone: { type: 'string', enum: ['neutral', 'positive', 'caution', 'negative'] } }, required: ['label'] } }
    },
    required: ['kind']
  }
}

const EXIT_PLAN_TOOL = {
  name: 'exit_plan_mode',
  description: 'Call this when your plan is ready, to present it to the user for approval. Pass the full plan as markdown. If approved, plan mode turns off and you may start making changes; if not, incorporate their feedback and keep planning.',
  input_schema: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The step-by-step plan, in markdown' } },
    required: ['plan']
  }
}

// ---------- auto-compaction ----------
// Long sessions eventually exceed a model's context window. When that happens (or
// proactively past a high estimate) we summarize the older messages into one
// checkpoint and keep the most recent few verbatim, so the session can continue.
const PROACTIVE_TOKENS = 180_000 // rough safety net for huge-context models
function estimateTokens (messages) {
  let chars = 0
  for (const m of messages) {
    if (m.setAside) continue   // an exchange set aside is not sent at all
    chars += (m.text || '').length
    for (const p of m.parts || []) {
      if (p.text) chars += p.text.length
      // a result set aside by relevance (p.stale) is sent as one line, not whole
      if (p.result) chars += p.stale ? 160 : String(p.result).length
      if (p.args) chars += JSON.stringify(p.args).length
      if (p.type === 'reasoning') chars += JSON.stringify(p.block || p.item || '').length
    }
  }
  return Math.round(chars / 4)
}
// ⚠️ EVERY PROVIDER SAYS IT DIFFERENTLY, AND ONE THAT IS NOT MATCHED HERE ENDS
// THE CHAT. xAI's "This model's maximum prompt length is 256000 but the request
// contains 259445 tokens" matched nothing in the first list — "maximum" and
// "tokens" sit 60 characters apart — so instead of compacting, the turn died and
// Tony read raw JSON: `400: {"code":"invalid-argument", ...}`. Every phrasing
// below is one a real provider has sent; test-turn-context.mjs pins them.
function isContextError (msg) {
  return /context length|context window|maximum context|too many tokens|prompt is too long|reduce the length|token.{0,4}limit|exceeds? the maximum|input is too long|maximum.{0,20}tokens|maximum prompt length|prompt length|request contains \d+ tokens|input token count|too long/i.test(String(msg || ''))
}
export { isContextError, toAnthropic, toResponsesInput }
function renderForSummary (messages) {
  return voiceAsText(messages).map(m => {
    if (m.role === 'user') return `User: ${m.text || ''}`
    const parts = (m.parts || []).map(p => {
      if (p.type === 'text') return p.text
      if (p.type === 'tool') return `[used ${p.name}(${JSON.stringify(p.args || {}).slice(0, 120)}) → ${String(p.result || '').slice(0, 200)}]`
      return ''
    }).filter(Boolean).join('\n')
    return `Assistant: ${parts}`
  }).join('\n\n')
}
async function compactSession (session, keepRecent, summarize, emit) {
  const msgs = session.messages
  if (msgs.length <= keepRecent + 2) return false
  const older = msgs.slice(0, msgs.length - keepRecent)
  const recent = msgs.slice(msgs.length - keepRecent)
  let summary = ''
  try { summary = (await summarize(renderForSummary(older.filter(m => !m.setAside)).slice(-50_000))).trim() } catch {}
  if (!summary) return false
  session.messages = [
    { role: 'user', text: `[Summary of the earlier conversation — the full history was compacted to save context. Continue from here.]\n\n${summary}`, compacted: true },
    ...recent
  ]
  emit({ type: 'compacted', summarized: older.length, kept: recent.length })
  return true
}

// Tools plan mode must not offer: the two that write files, the one that runs a
// shell, and every computer tool that is not purely a view. MCP tools stay —
// they are behind the approval gate, and research is what plan mode is for.
const PLAN_BLOCKED = new Set(['write_file', 'edit_file', 'run_command'])
function planBlocked (name) {
  if (PLAN_BLOCKED.has(name)) return true
  return COMPUTER_TOOL_NAMES.has(name) && !COMPUTER_SAFE.has(name)
}

// Did this tool call run a shell command, and did that command fail? Only
// run_command and a fused write/edit `then` actually run a shell; everything
// else returns false so it does not count toward the thrash window.
export const CMD_FAIL_RX = /\[exit code [1-9]|\[command timed out|\[could not run it|npm ERR!|\bERESOLVE\b|\bELIFECYCLE\b|command not found|\bTraceback \(most recent|\bpanic:|\bfatal:|error TS\d|\bBuild failed\b|\bTest failed\b/i
function commandOutcome (name, args, result) {
  const ranShell = name === 'run_command' ||
    ((name === 'write_file' || name === 'edit_file') && /\n--- then: /.test(String(result || '')))
  if (!ranShell) return null              // not a command: does not count
  return CMD_FAIL_RX.test(String(result || ''))   // true = failed
}

// Why a research subagent may not make this call — or null when it may. The
// command allowlist is util.js's commandRisk, the same judgement Auto mode uses
// to run a command without asking; a read that leaves the workspace is refused
// because a subagent has no approval prompt to fall back on.
function readOnlyRefusal (call, cwd) {
  if (!READ_ONLY_TOOLS.has(call.name)) return `${call.name} is not available to a research subagent. You can only read_file, recall, and run read-only commands.`
  if (call.name === 'run_command') {
    if (call.args?.run_in_background) return 'Background jobs are not available to a research subagent. Run the command in the foreground, or narrow it.'
    if (commandRisk(call.args?.command) !== 'low') return `Not run: that command could change something, and a research subagent is read-only. Use read-only commands (ls, cat, head, grep, rg, find, wc, git log/show/diff/status) or read_file.`
  }
  if (call.name === 'read_file' && outsideWorkspace(call.args?.path, cwd)) return `Not read: ${call.args?.path} is outside the workspace (${cwd}), and a research subagent stays inside it.`
  return null
}

// ---------- the agent loop ----------
export async function runTurn ({ provider, model, routed, verifyClaims, apiKey, getAccessToken, getAccountId, session, useTools, computerControl, skills, persona, planAddendum, memory, agentId, groupSpeakerId, groupNames, mcpTools, callMcp, askAgent, peerAgents, research, board, judgeRelevance, readOnly, maxRounds, turnTokenBudget, projectRules, planMode, onPlanExit, effort, summarize, autoCompact, localContext, autoApproveComputer, cachingEnabled, cacheTtl, emit, requestApproval, requestUserChoice, signal }) {
  if (effort && effort !== 'auto' && noEffort.has(`${provider?.id}:${model}`)) effort = 'auto'
  // ⚠️ NOT `session.cwd || os.homedir()`. A folder that is set and not here is
  // the case that broke every tool call in the chat — see usableCwd.
  const { dir: cwd, missing: strayCwd } = usableCwd(session.cwd)
  const system = systemPrompt(cwd, useTools, model, computerControl, skills, persona, planMode, planAddendum, memory, readOnly, projectRules)
  // proactive compaction before a very long turn
  const earlyNotices = []
  if (estimateTokens(session.messages) > PROACTIVE_TOKENS) {
    // Set aside unrelated earlier exchanges first; summarize only if that was not enough.
    // Its notice is held until the reply exists below, so it is saved with it.
    if (judgeRelevance) await setAsideTurns({ session, assistant: null, judgeRelevance, emit: ev => earlyNotices.push(ev) })
    if (autoCompact && summarize && estimateTokens(session.messages) > PROACTIVE_TOKENS) await compactSession(session, 4, summarize, emit)
  }
  const assistant = { role: 'assistant', model, parts: [], ...(routed ? { routed } : {}) }
  if (agentId) assistant.agentId = agentId
  session.messages.push(assistant)

  // ⚠️ A NOTICE THAT IS ONLY STREAMED IS A NOTICE NOBODY READS. Notices were
  // emitted and never written into the message, so the client showed one for as
  // long as the turn lasted and then wiped it: when the stream closes it clears the
  // live message and refetches the saved session, which never had the notice in it.
  //
  // "Stopped after 30 tool rounds." is emitted immediately before `done`, so it
  // existed for a few milliseconds and was gone. Tony: "sessions also seem to just
  // stop with no warning." That IS the warning — it just never survived to be read.
  // Same for "this model does not support tools" and the compaction note.
  const emitRaw = emit
  emit = ev => {
    if (ev.type === 'notice' && ev.text) assistant.parts.push({ type: 'notice', text: ev.text })
    // the provider's own count for the round, written on the record that sent it
    if (ev.type === 'usage' && assistant.sent?.length) {
      const r = assistant.sent[assistant.sent.length - 1]
      if (ev.input) r.input = ev.input
      if (ev.output) r.output = ev.output
      if (ev.cacheRead) r.cacheRead = ev.cacheRead
      if (ev.cacheWrite) r.cacheWrite = ev.cacheWrite
    }
    // ⚠️ A HALT MUST SURVIVE THE STREAM CLOSING, same as a notice — it is the
    // only thing in the transcript that says the turn is not finished.
    if (ev.type === 'halt') assistant.parts.push({ type: 'halt', reason: ev.reason, text: ev.text })
    emitRaw(ev)
  }
  // the set-aside note from before the reply existed, saved with it now
  for (const ev of earlyNotices) emit(ev)

  // After the wrapper, so it is written into the transcript and not just
  // streamed: this is the sentence that explains every odd path in the turn
  // below, and it has to still be there when the turn is read back.
  if (strayCwd) {
    emit({ type: 'notice', text: `This chat's folder is not on this Mac — ${strayCwd} — so it is working in ${cwd} instead. That usually means the chat was started on another Mac; pick a folder for it in the header to make it stick here.` })
  }
  let compacted = false
  // ⚠️ THE PROVIDER ALREADY TOLD US HOW BIG THE LAST REQUEST WAS. usage.input on
  // every round is the real prompt size in the model's own tokens — not chars/4,
  // which under-counted Tony's code-heavy chat by a third and let the proactive
  // net above sleep through 259k. Once it nears the model's window, fold hard
  // for the rest of the turn rather than wait to be refused.
  let lastPrompt = 0
  let hardFold = false
  let lastJudgedRound = -99
  let turnsSetAside = false
  // A local model's window is whatever Ollama loaded it with — ask, rather
  // than guess from the name. See ollamaContext().
  //
  // ⚠️ TWO DIFFERENT NUMBERS, AND CONFLATING THEM MAKES IT WORSE. `reported`
  // is what the model is loaded with and is what costs the memory; `window_`
  // is how much of it Radiant will fill before it starts trimming. Raising
  // Radiant's does not change Ollama's reservation, and vice versa — so when
  // the cap bites, the notice names both places.
  let reported = contextWindow(model) || (await ollamaContext(provider, model))
  const localCap = isOllama(provider) && localContext !== 0 ? (localContext || LOCAL_CONTEXT_DEFAULT) : 0
  const capOf = n => (n && localCap && n > localCap ? localCap : n)
  let window_ = capOf(reported)
  // ⚠️ AN EMPTY ROUND MUST NOT END THE TURN IN SILENCE. A model that returns
  // nothing — no text, no tool call — after a round of tool results used to
  // hit the "no tools → done" exit and the chat simply stopped, mid-work, with
  // nothing said. Tony, with a reviewer watching: "models just failing silently
  // and stopping mid chat." One nudge, then a halt that says why.
  let emptyRounds = 0
  let nudge = ''
  let claimNudged = false   // the reply-vs-evidence check gets one correction round

  const accessToken = getAccessToken ? await getAccessToken() : null
  const accountId = getAccountId ? await getAccountId() : null
  // ChatGPT subscription (OAuth, no API key) must use the Responses/Codex backend
  const useChatgpt = provider.id === 'openai' && accessToken && !apiKey
  const canAskAgents = askAgent && peerAgents && peerAgents.length
  // ⚠️ PLAN MODE WAS A SENTENCE, NOT A GATE. It added exit_plan_mode and told the
  // model not to change anything, but removed nothing — write_file and edit_file
  // stayed in the schema, and until the approval fix above they had no prompt
  // behind them either. The one promise plan mode makes to someone who turned it
  // on precisely because they did not trust the task was enforced by prose. Now
  // the tools are not offered, and the dispatch below refuses them a second time.
  const toolDefs = (readOnly ? TOOL_DEFS.filter(t => READ_ONLY_TOOLS.has(t.name)) : [
    ...TOOL_DEFS,
    ...(computerControl ? COMPUTER_TOOL_DEFS : []),
    ...(mcpTools || []),
    ...(canAskAgents ? [askAgentToolDef(peerAgents)] : []),
    ...(research ? [RESEARCH_TOOL] : []),
    ...(board ? [BOARD_TOOL] : []),
    SHOW_WIDGET_TOOL,
    ...(requestUserChoice ? [ASK_USER_TOOL] : []),
    ...(planMode ? [EXIT_PLAN_TOOL] : [])
  ]).filter(t => !planMode || !planBlocked(t.name))

  let toolsEnabled = useTools
  // loop-breaker: nudge (never block) when the model repeats an identical call
  let lastSig = null
  let repeatCount = 0
  // ⚠️ THE REPEAT-BREAKER BELOW ONLY CATCHES IDENTICAL CALLS, AND ask_user IS
  // NEVER IDENTICAL. Its signature includes the question text, so a model that
  // keeps asking — each time slightly differently — resets repeatCount every
  // round and the breaker never fires. It is also the one tool that makes no
  // progress, so a run of them is pure churn: Tony's chat "seems to be stuck in
  // ask user loop" with no way out but stopping the turn.
  //
  // Counted by tool name instead of by arguments, and escalating to a refusal:
  // at some point the honest answer is that asking again is not an option.
  let askStreak = 0
  // Recent shell-command outcomes (true = failed), newest last. Only real
  // commands count — a read or a grep while debugging is not progress and not
  // failure, so it neither fills nor clears this.
  const cmdOutcomes = []
  let thrashNudged = false
  const REPEAT_NUDGES = { 3: 'stop and re-read the last result — this exact call has produced the same output 3 times', 5: 'you are stuck in a loop (5 identical calls). Change your approach or explain what is blocking you', 8: 'STOP repeating this call (8 times). Do something different or tell the user you are blocked' }
  // per-session stats (folded into session.stats)
  // ⚠️ cachedIn IS THE DIFFERENCE BETWEEN A BILL AND A PANIC. An agentic turn
  // re-sends the whole conversation every round — that is how the loop works,
  // not a leak — so a 155k chat legitimately reports millions of input tokens
  // over 18 turns. What decides whether that is expensive is how much of it the
  // provider served from its prompt cache, which costs a fraction. The number
  // was being READ off the stream (prompt_tokens_details.cached_tokens) and
  // thrown away, so the app showed a frightening total it could not explain and
  // nobody could tell a working cache from a burning one. Tony: "that will kill
  // this product if its burning tokens for no reason." Count it and show it.
  // Created ON the session, not beside it, so a subagent or housekeeping call
  // that adds to session.stats mid-turn adds to the same object this turn saves.
  const stats = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
  if (typeof stats.cachedIn !== 'number') stats.cachedIn = 0
  if (typeof stats.cacheWrite !== 'number') stats.cacheWrite = 0
  stats.turns += 1
  // ⚠️ THIS COUNTER IS THE SESSION'S WHOLE LIFE, NOT THIS TURN'S. I added a
  // "per turn" ceiling and compared it against the running total, so a chat that
  // had ever spent more than the limit halted INSTANTLY on every turn after —
  // zero tool calls, no work, and "keep going" could never do anything. Tony's
  // chat had 29.8M tokens behind it against a 2M limit: permanently bricked, and
  // strictly worse than the round cap it replaced. Take the mark at the start
  // and measure the difference.
  // ⚠️ BUDGET ON REAL COST, NOT RAW TOKENS. An agentic turn re-sends the whole
  // conversation every round, and the provider serves almost all of it from
  // cache — a real build ran to 15.1M tokens that was 92% CACHE READS, which
  // cost about a tenth of fresh tokens. Budgeting on the raw 15.1M paused a
  // cheap, working build at a frightening-looking number (Tony: "embarrassing").
  // So the budget counts BILLABLE tokens: uncached input + output, the part that
  // costs near full price. Cache reads — the bulk of a long turn — barely count,
  // so a normal build finishes and only a genuinely expensive turn pauses.
  const inBefore = stats.inTokens || 0
  const outBefore = stats.outTokens || 0
  const cachedBefore = stats.cachedIn || 0
  const billableUsed = () => ((stats.inTokens - inBefore) - (stats.cachedIn - cachedBefore)) + (stats.outTokens - outBefore)
  // The real ceiling: a spend budget the user sets (Settings → Models → Long
  // builds), measured in billable tokens. 0 or negative means no budget.
  const tokenBudget = Number.isFinite(turnTokenBudget) ? turnTokenBudget : DEFAULT_TURN_TOKENS
  // the window rides with usage so the gauge can draw a local model it has no table row for
  // ⚠️ WHAT THIS ROUND HAS STREAMED SO FAR, kept here and not only inside the
  // round: Stop aborts the fetch, the round throws before it returns its parts,
  // and the reply the user just watched arrive vanished on reload.
  let roundText = ''
  const emitS = ev => { if (ev.type === 'text_delta') roundText += ev.text || ''; if (ev.type === 'usage') { stats.inTokens += ev.input || 0; stats.outTokens += ev.output || 0; stats.cachedIn += ev.cacheRead || 0; stats.cacheWrite += ev.cacheWrite || 0; if (ev.input) lastPrompt = ev.input; if (window_) ev = { ...ev, window: window_ } } emit(ev) }
  const finishStats = () => { session.stats = stats; emit({ type: 'stats', stats }) }
  const roundCap = Math.min(maxRounds || MAX_ROUNDS, MAX_ROUNDS)
  for (let round = 0; round < roundCap; round++) {
    // ⚠️ STOP HAD EXACTLY ONE CHECK IN THIS WHOLE FUNCTION, and it sat after the
    // approval prompt. Everywhere else the turn found out it had been cancelled
    // only when the NEXT model request rejected — so pressing Stop while tools
    // were running ran every remaining tool first, and a shell command ran to
    // completion or to its two-minute timeout. Tony: "the stop button does not
    // seem to be doing anything… agent just keeps talking and talking."
    // Aborting returns cleanly rather than throwing: the partial answer is real
    // work and belongs in the transcript.
    if (signal?.aborted) { finishStats(); emit({ type: 'stopped' }); return }
    // The real ceiling: the spend budget. A round count never measured cost;
    // this does. A build runs to completion unless it reaches the number the
    // user set, then it pauses and asks — never a surprise, never a wall at an
    // arbitrary round count.
    if (tokenBudget > 0 && billableUsed() > tokenBudget) {
      const rawM = Math.round(((stats.inTokens + stats.outTokens) - (inBefore + outBefore)) / 1e6 * 10) / 10
      const billM = Math.round(billableUsed() / 1e6 * 100) / 100
      finishStats()
      emit({
        type: 'halt',
        reason: 'budget',
        text: `This turn reached your spend budget — about ${billM}M tokens of real cost (${rawM}M in total, but most of that was served from cache and barely costs anything). It paused rather than keep spending without asking; nothing is lost. Press Continue to keep going, or change the per-turn budget in Settings → Models → Long builds.`
      })
      emit({ type: 'done' })
      return
    }
    emit({ type: 'round_start', round })
    // Ollama only reports a model's context once it is loaded, i.e. after the first round.
    if (!window_ && round > 0) { reported = await ollamaContext(provider, model); window_ = capOf(reported) }
    if (!hardFold && window_ && lastPrompt > window_ * 0.85) {
      hardFold = true
      const k = n => `${Math.round(n / 1000)}k`
      emit({ type: 'notice', text: localCap && reported > window_
        ? `This chat reached the ${k(window_)} working limit Radiant uses for local models (${lastPrompt ? k(lastPrompt) + ' used; ' : ''}${model} is loaded in Ollama with ${k(reported)}). Older tool results are trimmed from here on so it can keep going. To let local chats use more, raise "Local model context" in Settings → Models — that is separate from how much memory Ollama reserves, which is Ollama's own Settings → Context length.`
        : `The conversation is close to ${model}'s limit (${k(lastPrompt)} of ${k(window_)} tokens) — older tool results are trimmed from here on so it can keep going.` })
    }
    const args = {
      baseUrl: provider.baseUrl,
      apiKey,
      accessToken,
      model,
      provider,
      systemStable: system.stable,
      systemVolatile: nudge ? `${system.volatile}\n\n${nudge}` : system.volatile,
      cachingEnabled,
      cacheTtl,
      tools: toolsEnabled,
      toolDefs,
      extraHeaders: provider.id === 'copilot' ? COPILOT_HEADERS : undefined,
        effort,
      emit: emitS,
      signal
    }
    let result
    const roundStart = Date.now()
    roundText = ''
    try {
      // a saved voice conversation reads as user text; toAnthropic would choke on its role
      if (judgeRelevance && !signal?.aborted && round - lastJudgedRound >= 2 && lastPrompt > (window_ ? window_ * RELEVANCE_AT : RELEVANCE_FALLBACK)) {
        lastJudgedRound = round
        await setAsideStale({ session, assistant, round, judgeRelevance, emit })
      }
      const liveMsgs = session.messages.filter(m => !m.setAside)
      const reqMsgs = foldOldToolResults(voiceAsText(groupSpeakerId ? groupFlatten(liveMsgs, groupSpeakerId, groupNames || {}) : liveMsgs), { hard: hardFold })
      // ⚠️ MODEL-VISIBLE MEANS LOGGED. Everything this round sends is written
      // down beside the reply — which model, how much system text (and a hash
      // of it), which tools, how many messages, whether old results were
      // trimmed — so "what did the model actually see?" is answered from the
      // transcript, not by rerunning the chat. The cache-splitting bug of
      // 2026-09-18 cost Claude users 90% of their cache for weeks and took a
      // 90-run benchmark to notice; a per-round record shows it in one chat
      // (a system hash that changes between rounds, or a message count that
      // does not grow by one). Never a part: parts go to the model, this does not.
      const sent = {
        round, at: Date.now(), provider: provider.id, model,
        api: provider.type === 'anthropic' ? 'messages' : useChatgpt ? 'responses' : 'chat',
        systemChars: (system.stable || '').length + (system.volatile || '').length,
        systemSha: crypto.createHash('sha1').update(system.stable || '').digest('hex').slice(0, 10),
        volatileChars: (system.volatile || '').length + (nudge ? nudge.length + 2 : 0),
        tools: toolsEnabled ? (toolDefs || []).map(t => t.name || t.function?.name).filter(Boolean) : [],
        messages: reqMsgs.length,
        items: reqMsgs.reduce((n, m) => n + (m.parts ? m.parts.length : 1), 0),
        estTokens: estimateTokens(reqMsgs) + roughTokens(system.stable || '') + roughTokens(system.volatile || '') + (toolsEnabled && toolDefs ? roughTokens(JSON.stringify(toolDefs)) : 0),
        trimmed: Boolean(hardFold)
      }
      if (round === 0 && (system.stable || '').length <= 65536) sent.systemText = system.stable
      ;(assistant.sent || (assistant.sent = [])).push(sent)
      result = provider.type === 'anthropic'
        ? await anthropicRound({ ...args, messages: toAnthropic(reqMsgs, { model, thinking: Boolean(THINK_BUDGET[args.effort]) }) })
        : useChatgpt
          ? await chatgptRound({ ...args, system: nudge ? `${system.full}\n\n${nudge}` : system.full, accountId, messages: reqMsgs, cacheKey: session.id })
          : await openaiRound({ ...args, messages: toOpenAI(reqMsgs, nudge ? `${system.full}\n\n${nudge}` : system.full) })
      stats.llmMs += Date.now() - roundStart
    } catch (e) {
      // Stopped mid-reply: keep what already streamed, end like any other Stop.
      if (signal?.aborted) {
        if (roundText.trim()) assistant.parts.push({ type: 'text', text: roundText })
        finishStats(); emit({ type: 'stopped' }); return
      }
      // Model doesn't support tools (common with local models) -> retry once without them.
      if (toolsEnabled && round === 0 && /tool/i.test(e.message) && /support|invalid|unknown|400/i.test(e.message)) {
        toolsEnabled = false
        emit({ type: 'notice', text: 'This model does not support tools — continuing in chat-only mode.' })
        continue
      }
        // ⚠️ AND A LEVEL THE MODEL CANNOT DO MUST NOT END THE TURN. Only some
        // models reason, and the ones that do not reject the parameter outright.
        // Dropping it and retrying keeps a wrong slider position from breaking a
        // chat — the same shape as the tools fallback above, for the same reason.
        if (args.effort && args.effort !== 'auto' && round === 0 &&
            /reasoning|thinking|effort|budget/i.test(e.message) && /support|invalid|unknown|400/i.test(e.message)) {
          // ⚠️ THE OUTER `effort`, NOT args.effort. `args` is built again at the top
          // of every round from `effort`, so setting only args.effort was undone by
          // the `continue` — the retry sent the same rejected level and the turn
          // died (xAI: "Model grok-4.20-0309-non-reasoning does not support
          // parameter reasoningEffort", four times in a row). Remembered per
          // model, so the next turn does not spend a round finding out again.
          noEffort.add(`${provider?.id}:${model}`)
          effort = 'auto'
          emit({ type: 'notice', text: 'This model does not take a thinking level — running at its default.' })
          continue
        }
      // Ran out of context. First the cheap move — fold every tool result but
      // this round's and resend — then summarize older messages, then give up
      // in a sentence rather than the provider's JSON.
      if (isContextError(e.message)) {
        if (!hardFold) {
          hardFold = true
          emit({ type: 'notice', text: `The conversation outgrew ${model}'s limit — trimmed older tool results and continued.` })
          continue
        }
        // ⚠️ BEFORE THE SUMMARY, THE EXCHANGES THAT ARE ABOUT SOMETHING ELSE.
        // A summary is slow, loses detail, and rewrites the saved chat for good.
        // Earlier requests unrelated to the current task are set aside instead —
        // kept in the chat, not sent — and only if that is not enough does the
        // summary run. (decide.js chooseStale, subject 'exchange'.)
        if (judgeRelevance && !turnsSetAside) {
          turnsSetAside = true
          const r = await setAsideTurns({ session, assistant, judgeRelevance, emit })
          if (r?.dropped) continue
        }
        if (autoCompact && summarize && !compacted) {
          compacted = true
          const i = session.messages.indexOf(assistant)
          if (i >= 0) session.messages.splice(i, 1)
          const did = await compactSession(session, 4, summarize, emit)
          session.messages.push(assistant)
          if (did) { emit({ type: 'notice', text: 'The conversation was getting long — summarized earlier messages to free up room, and continued.' }); continue }
        }
        throw new Error(`The conversation is too long for ${model}${window_ ? ` (it takes about ${Math.round(window_ / 1000)}k tokens)` : ''}, even after trimming older tool results${compacted ? ' and summarizing' : ''}. Start a new chat for the next step${autoCompact ? '' : ', or turn on auto-compact in Settings → Automation'}.`)
      }
      throw e
    }

    const toolParts = result.parts.filter(p => p.type === 'tool')
    for (const p of result.parts) {
      if (p.type === 'text') assistant.parts.push(p)
      else if (p.type === 'reasoning') assistant.parts.push({ ...p, round })
    }
    // ⚠️ SAY WHO ANSWERED. Jev Router hands the message to a model of its
    // choosing; the reply is labeled with that model, not only "jev-router".
    if (result.servedBy) { assistant.servedBy = result.servedBy; emit({ type: 'served_by', model: result.servedBy }) }
    // Cut off by the output cap: what arrived is kept, and the chat is told
    // it is not the whole reply rather than left to look finished.
    if (result.finish === 'length') emit({ type: 'notice', text: 'The model hit its output limit mid-reply — what it wrote is kept, but it did not finish. Say "continue" to get the rest.' })
    if (!result.parts.length) {
      // nothing to add after the reply-vs-evidence nudge is an answer, not a fault
      if (claimNudged) { finishStats(); emit({ type: 'done' }); return }
      emptyRounds++
      if (emptyRounds === 1 && round < MAX_ROUNDS - 1) {
        nudge = '[Your previous response was empty. Continue the work you were doing: call the next tool you need, or say what you did and what remains. Do not return an empty response.]'
        emit({ type: 'notice', text: 'The model returned nothing — asked it to continue.' })
        continue
      }
      finishStats()
      emit({
        type: 'halt',
        reason: 'empty',
        text: `${model} returned nothing twice in a row${lastPrompt && window_ ? ` at ${Math.round(lastPrompt / 1000)}k of ${Math.round(window_ / 1000)}k tokens` : ''}. That usually means the model ran out of context or its chat template broke on the tool results. Everything above is saved; press Continue to ask again, or switch to another model.`
      })
      emit({ type: 'done' })
      return
    }
    emptyRounds = 0; nudge = ''
    if (!toolParts.length || !result.stopOnTools) {
      // ⚠️ THE REPLY IS CHECKED AGAINST THE TURN. What it says was done has
      // to be visible in the tools it ran (decide.js verifyClaims). A claim
      // nothing supports is written under the reply, and the model gets one
      // round to do the thing or correct itself. Never on the phone, never
      // without a key: verifyClaims is null then.
      if (verifyClaims && !signal?.aborted) {
        try {
          const text = assistant.parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
          const v = await verifyClaims({ text, toolParts: assistant.parts.filter(p => p.type === 'tool') })
          if (v?.unsupported?.length) {
            const list = v.unsupported.map(u => `“${u.claim.length > 120 ? u.claim.slice(0, 117) + '…' : u.claim}”`).join(' · ')
            emit({ type: 'notice', text: `Not shown by anything in this turn: ${list}` })
            if (!claimNudged && round < MAX_ROUNDS - 1) {
              claimNudged = true
              nudge = `[Your reply claims: ${v.unsupported.map(u => u.claim).join(' | ')} — but no tool call in this turn shows it. Either do it now with the tools and report the real result, or correct the reply to say what actually happened. Do not repeat an unsupported claim.]`
              continue
            }
          }
        } catch {}
      }
      finishStats(); emit({ type: 'done' }); return
    }

    const toolLoopStart = Date.now()
    for (const call of toolParts) {
      // A model can ask for several tools in one round. Stop means stop before
      // the next one, not after all of them.
      if (signal?.aborted) { stats.toolMs += Date.now() - toolLoopStart; finishStats(); emit({ type: 'stopped' }); return }
      const part = { type: 'tool', id: call.id, name: call.name, args: call.args, round }
      assistant.parts.push(part)
      emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args })
      const isComputer = COMPUTER_TOOL_NAMES.has(call.name)
      const isMcp = call.name.startsWith('mcp__')
      // ⚠️ THE GATE USED TO COVER run_command AND NOTHING ELSE THAT WRITES.
      // write_file and edit_file put bytes on disk at any absolute path with no
      // prompt at all, so the shell gate was a front door beside an open window:
      // ~/.zshrc, a LaunchAgent, or .git/hooks/pre-commit reached the same place
      // without one. Writes always ask now, and a READ that leaves the workspace
      // asks too — read_file plus fetch_url was a complete, un-prompted path from
      // ~/.radiant/config.json (every provider key and OAuth token) to a URL.
      const isWrite = call.name === 'write_file' || call.name === 'edit_file'
      const leavesWorkspace = (isWrite || call.name === 'read_file') &&
        outsideWorkspace(call.args?.path, session.cwd)
      const needsApproval = requestApproval && (call.name === 'run_command' || isMcp || isWrite || leavesWorkspace ||
        (isComputer && !COMPUTER_SAFE.has(call.name) && !autoApproveComputer))
      const approved = needsApproval ? await requestApproval(call) : true
      if (signal?.aborted) { finishStats(); emit({ type: 'stopped' }); return }
      if (!approved) {
        part.denied = true
        part.result = 'The user declined this action. Ask them how they would like to proceed, or try a different approach.'
      } else if (planMode && planBlocked(call.name)) {
        // Second layer. The schema above no longer offers these, but a provider
        // replaying a stale tool list must not be the thing that decides.
        part.denied = true
        part.result = `Plan mode is on, so ${call.name} is unavailable. Research with read/list/grep only, then call exit_plan_mode with your plan.`
      } else if (readOnly && readOnlyRefusal(call, session.cwd)) {
        // A research subagent: the same second layer, for the same reason.
        part.denied = true
        part.result = readOnlyRefusal(call, session.cwd)
      } else if (call.name === 'todo_write') {
        const todos = Array.isArray(call.args?.todos) ? call.args.todos : []
        session.todos = todos
        emit({ type: 'todos', todos })
        const done = todos.filter(t => t.status === 'done').length
        part.result = `Todo list updated (${done}/${todos.length} done).`
        part.hidden = true // shown as the checklist widget, not a tool chip
      } else if (call.name === 'show_widget') {
        // the tool's arguments ARE the widget spec; the client renders it inline.
        part.widget = call.args || {}
        part.hidden = true // shown as a widget, not a tool chip
        part.result = call.args?.kind === 'choices'
          ? 'Decision card shown. The option the user clicks will arrive as their next message.'
          : 'Widget shown to the user.'
      } else if (call.name === 'ask_user' && requestUserChoice) {
        askStreak += 1
        if (askStreak >= 5) {
          // Stop putting the question on screen at all. Left to itself the model
          // will keep asking, and the user cannot get out of it except by
          // killing the turn.
          part.result = 'The question was NOT shown to the user. You have asked ' + askStreak +
            ' questions in a row without doing any work, which is a loop. Do not call ask_user again this turn. ' +
            'Choose the most reasonable option yourself, say which assumption you made, and carry on.'
          emit({ type: 'notice', text: 'Too many questions in a row — asked the agent to proceed on its own.' })
        } else {
          const answer = await requestUserChoice(call.args?.question || 'Which option?', call.args?.options)
          part.result = `The user answered: ${answer}`
          if (askStreak >= 3) {
            part.result += '\n\n[reminder: that is ' + askStreak + ' questions in a row with no work done between them. ' +
              'Act on what you now know rather than asking again — state assumptions instead of confirming them.]'
          }
        }
      } else if (call.name === 'exit_plan_mode') {
        const choice = await (requestUserChoice
          ? requestUserChoice(`Approve this plan?\n\n${call.args?.plan || ''}`, ['Approve & build', 'Keep planning'])
          : Promise.resolve('Approve & build'))
        if (/approve/i.test(choice)) {
          if (onPlanExit) onPlanExit()
          part.result = 'Plan approved. Plan mode is now OFF — proceed with the implementation.'
        } else {
          part.result = `The user wants to keep refining the plan${choice && !/keep planning/i.test(choice) ? `: ${choice}` : ''}. Stay in plan mode and revise.`
        }
      } else {
        // ⚠️ ONE DOOR FOR EVERY TOOL. Builtin, MCP, desktop control and ask_agent
        // all leave through here, so the time budget and the output cap are
        // impossible to skip. They used to be per-implementation, which meant
        // three of twelve builtins truncated and MCP results were unbounded.
        try {
          await withBudget(call.name, MAX_TOOL_MS, async () => {
            if (call.name === 'ask_agent') {
              emit({ type: 'notice', text: `Consulting ${call.args?.agent || 'another agent'}…` })
              part.result = await askAgent(call.args?.agent, call.args?.question)
            } else if (call.name === 'task_board' && board) {
              part.result = board(call.args || {})
            } else if (call.name === 'research' && research) {
              const r = await research(call.args?.questions)
              part.result = r.text
              // per-subagent model, tokens and time — saved on the part so the
              // transcript can show what each question cost
              part.subagents = r.subagents
            } else if (isMcp) {
              part.result = callMcp ? await callMcp(call.name, call.args) : 'MCP tool unavailable.'
            } else if (isComputer) {
              const r = await runComputerTool(call.name, call.args)
              part.result = r.content
              if (r.image) part.resultImage = r.image
            } else {
              part.result = await runTool(call.name, call.args, cwd, signal)
            }
          })
        } catch (e) {
          if (e instanceof ToolTimeout) { part.result = e.message; part.timedOut = true }
          else throw e
        }
        // ⚠️ THE NOTICE IS A FIELD, NOT A SUFFIX. Glued onto the text, it leaves
        // the model guessing where the tool's output stops and ours starts, and
        // anything reading the result programmatically has to parse our
        // commentary out of the data first.
        // Anything big is kept in full on disk BEFORE it is bounded, so the
        // middle that bounding drops is not gone — it is one recall away.
        if (call.name !== 'recall' && typeof part.result === 'string' && part.result.length > ARCHIVE_MIN) {
          const a = archiveResult(part.result)
          if (a) part.archive = a
        }
        const bounded = boundResult(call.name, part.result)
        part.result = bounded.text
        if (bounded.truncated) {
          part.truncated = bounded.truncated
          if (part.archive) part.result += `\n\n[the middle was dropped here; recall(id: "${part.archive.id}") has all ${part.archive.lines} lines]`
          emit({ type: 'notice', text: `${call.name} returned ${bounded.truncated.toLocaleString()} characters more than fits; the middle was dropped${part.archive ? ', and the whole thing is kept for recall' : ''}.` })
        }
      }
      // loop-breaker: append an escalating reminder on identical consecutive calls
      if (call.name !== 'ask_user') askStreak = 0
      const sig = call.name + ':' + JSON.stringify(call.args)
      repeatCount = sig === lastSig ? repeatCount + 1 : 1
      lastSig = sig
      if (REPEAT_NUDGES[repeatCount]) part.result = `[reminder: ${REPEAT_NUDGES[repeatCount]}]\n\n${part.result ?? ''}`
      // ⚠️ THE NUDGE WAS THE WHOLE ENFORCEMENT, AND A NUDGE IS A SUGGESTION. An
      // agent that has made the identical call twelve times has been told three
      // times to stop and has not. This is what a runaway actually looks like —
      // not "used a lot of rounds getting work done".
      if (repeatCount >= STUCK_AT) {
        emit({ type: 'tool_result', id: call.id, result: part.result, denied: !approved, hasImage: Boolean(part.resultImage), ...(part.subagents ? { subagents: part.subagents } : {}) })
        stats.toolMs += Date.now() - toolLoopStart
        finishStats()
        emit({
          type: 'halt',
          reason: 'stuck',
          text: `The agent called ${call.name} the same way ${repeatCount} times in a row and was not getting anywhere, so the turn was stopped. Everything above is saved. Continue picks it up, but it is worth telling it to try something different.`
        })
        emit({ type: 'done' })
        return
      }
      // thrash-breaker: a run of shell commands that keep failing (varying each
      // time, so STUCK_AT never sees it) is a turn that cannot make progress.
      const outcome = commandOutcome(call.name, call.args, part.result)
      if (outcome !== null) {
        cmdOutcomes.push(outcome)
        if (cmdOutcomes.length > CMD_WINDOW) cmdOutcomes.shift()
        const fails = cmdOutcomes.filter(Boolean).length
        const last8Fails = cmdOutcomes.slice(-8).filter(Boolean).length
        if (cmdOutcomes.length >= CMD_WINDOW && fails >= CMD_FAIL_HALT) {
          emit({ type: 'tool_result', id: call.id, result: part.result, denied: !approved, hasImage: Boolean(part.resultImage) })
          stats.toolMs += Date.now() - toolLoopStart
          finishStats()
          emit({
            type: 'halt',
            reason: 'stuck',
            text: `The last ${cmdOutcomes.length} commands this turn mostly failed (${fails} of them), so the turn was stopped rather than keep trying variations that do not work — usually a broken build, a version mismatch, or a missing tool. Everything above is saved. It is worth looking at the last error yourself and telling it the fix, then pressing Continue.`
          })
          emit({ type: 'done' })
          return
        }
        // one reminder before the halt, when failures start to pile up
        if (!thrashNudged && cmdOutcomes.length >= 8 && last8Fails >= CMD_FAIL_NUDGE) {
          thrashNudged = true
          part.result = `[reminder: your recent commands keep failing. Stop trying variations — read the last error closely, and if you cannot get a command to succeed, say plainly what is broken and what would unblock it instead of trying again.]\n\n${part.result ?? ''}`
        }
      }
      emit({ type: 'tool_result', id: call.id, result: part.result, denied: !approved, hasImage: Boolean(part.resultImage), ...(part.subagents ? { subagents: part.subagents } : {}) })
    }
    stats.toolMs += Date.now() - toolLoopStart
    if (signal?.aborted) { finishStats(); emit({ type: 'stopped' }); return }
  }
  // ⚠️ THE LIMIT USED TO END THE TURN MID-AIR, AND THE ONLY TRACE WAS AN ITALIC
  // GREY LINE. Tony, looking at a chat that had just done this: "the chat has
  // failed again. with no warning. why is this happening. how can a user rely on
  // this app if chats just stop with no warning and no explanation." He is right
  // — "Stopped after 30 tool rounds." is 12px, faint, italic, and it landed at
  // the bottom of thirty-five tool chips. It is also not an explanation: it says
  // what the code did, not what the agent was doing, what got done, or what to
  // do next.
  //
  // So the last thing a spent turn does is ASK. One more call with the tools
  // taken away — it cannot loop again, that is the point — for a plain account
  // of where it got to. That reply is the explanation, in the agent's own words,
  // about this specific piece of work. Then the halt, which the client renders
  // as a real block with a Continue button rather than a whisper.
  if (!signal?.aborted) {
    try {
      const wrapUp = {
        role: 'user',
        text: `This is an unusually long turn (${MAX_ROUNDS} rounds of tool use) and it has reached the backstop. Do not call a tool. In 2-4 plain sentences tell the user what is finished, what is left, and what to say to keep going — Continue will resume.`
      }
      const msgs = [...session.messages.filter(m => !m.setAside), wrapUp]
      const args = {
        baseUrl: provider.baseUrl, apiKey, accessToken, model, system,
        tools: false, toolDefs: [],
        extraHeaders: provider.id === 'copilot' ? COPILOT_HEADERS : undefined,
        effort, emit: emitS, signal
      }
      const wrapStart = Date.now()
      const said = provider.type === 'anthropic'
        ? await anthropicRound({ ...args, messages: toAnthropic(msgs, { model, thinking: Boolean(THINK_BUDGET[args.effort]) }) })
        : useChatgpt
          ? await chatgptRound({ ...args, accountId, messages: msgs })
          : await openaiRound({ ...args, messages: toOpenAI(msgs, system) })
      stats.llmMs += Date.now() - wrapStart
      for (const p of said.parts) if (p.type === 'text') assistant.parts.push(p)
    } catch (e) {
      // ⚠️ NEVER LET THE EXPLANATION BE THE THING THAT FAILS. Whatever went
      // wrong here, the halt below still has to reach the user — that is the
      // entire bug being fixed.
      console.warn('[radiant] wrap-up after the round limit failed:', e.message)
    }
  }
  finishStats()
  emit({
    type: 'halt',
    reason: 'rounds',
    text: `This turn ran ${MAX_ROUNDS} rounds of tool use — the far-out backstop against an endless loop — and paused. Nothing is lost; Continue picks it up. If a build legitimately needs this many steps it is fine to keep going.`
  })
  emit({ type: 'done' })
}

// OpenRouter's Jev Router: send it the message and it picks the model and
// reasoning effort itself (TypeSafe's Jev, the same model decide.js asks).
export const JEV_ROUTER = 'typesafe/jev-router'

// Fallback model lists for subscription sign-ins whose model endpoints aren't
// reachable with an OAuth token (e.g. ChatGPT). Keeps the picker usable.
const SUBSCRIPTION_MODELS = {
  anthropic: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
  // Fallback only. The real ChatGPT-subscription model list is fetched live from
  // the Codex backend (chatgptModels); it uses rolling codenames like gpt-5.6-sol
  // and rejects the old gpt-5 / gpt-5-codex ids outright.
  openai: ['gpt-5.6-sol']
}

// ---------- model listing ----------
// apiKey OR accessToken (OAuth subscription). For OAuth, auth is Bearer.
export async function listModels (provider, apiKey, accessToken, accountId) {
  // ChatGPT subscription: fetch the live Codex model list (rolling codenames)
  if (provider.id === 'openai' && accessToken && !apiKey) {
    return (await chatgptModels(accessToken, accountId)) || fallback(provider, accessToken, apiKey)
  }
  try {
    if (provider.type === 'anthropic') {
      const headers = { 'anthropic-version': '2023-06-01' }
      if (accessToken) { headers.authorization = `Bearer ${accessToken}`; headers['anthropic-beta'] = 'oauth-2025-04-20' }
      else headers['x-api-key'] = apiKey
      const res = await fetch(`${provider.baseUrl}/v1/models?limit=100`, { headers, signal: AbortSignal.timeout(6000) })
      if (!res.ok) return fallback(provider, accessToken, apiKey)
      const data = await res.json()
      const list = (data.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }))
      return list.length ? list : fallback(provider, accessToken)
    }
    const headers = provider.id === 'copilot' ? { ...COPILOT_HEADERS } : {}
    const bearer = accessToken || apiKey
    if (bearer) headers.authorization = `Bearer ${bearer}`
    const res = await fetch(`${provider.baseUrl}/models`, { headers, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return fallback(provider, accessToken, apiKey)
    const data = await res.json()
    const list = (data.data || []).map(m => ({ id: m.id, label: m.name || m.id }))
    return list.length ? list : fallback(provider, accessToken)
  } catch {
    return fallback(provider, accessToken, apiKey)
  }
}

// shown if a key provider's /models call fails but a key is present
const KEY_FALLBACK_MODELS = {
  nousresearch: ['Hermes-4-405B', 'Hermes-4-70B', 'Hermes-4.3-36B'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
  // MiniMax documents an OpenAI-shaped /v1/models, but it has been reported
  // 404ing in the wild — and a provider that lists nothing looks broken rather
  // than unlisted. These are the ids its own docs name.
  minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2']
}

function fallback (provider, accessToken, apiKey) {
  if (accessToken && SUBSCRIPTION_MODELS[provider.id]) {
    return SUBSCRIPTION_MODELS[provider.id].map(id => ({ id, label: id }))
  }
  if (apiKey && KEY_FALLBACK_MODELS[provider.id]) {
    return KEY_FALLBACK_MODELS[provider.id].map(id => ({ id, label: id }))
  }
  return []
}
