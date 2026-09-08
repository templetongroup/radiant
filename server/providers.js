import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { resolveSkillDir, usableCwd } from './config.js'
import { fetchRetry, isTransient } from './util.js'
import { TOOL_DEFS, runTool, outsideWorkspace } from './tools.js'
import { COMPUTER_TOOL_DEFS, COMPUTER_TOOL_NAMES, COMPUTER_SAFE, runComputerTool } from './computer-tools.js'
import { boundResult, withBudget, MAX_TOOL_MS, ToolTimeout } from './tool-bounds.js'
import { COPILOT_HEADERS } from './oauth.js'

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
const MAX_ROUNDS = 200

// ⚠️ AND A REAL CEILING ON WHAT A TURN MAY SPEND, because 200 rounds of a
// re-sent conversation is a bill, and a round count never measured the bill
// anyway. One stuck chat cost 25.7 million input tokens across 12 turns.
// Tokens are what runs out; tokens are what is counted.
// ⚠️ AND 2M WAS ALSO TOO LOW, FOR THE SAME REASON THE ROUND CAP WAS. A long
// chat re-sends its whole history every round: Tony's was 135k tokens per
// request, so 2M is fifteen rounds — it would have cut real work off all over
// again, just with a different message. A backstop belongs far out of the way of
// ordinary work; this one is for a turn that has genuinely run away.
const MAX_TURN_TOKENS = Number(process.env.RADIANT_MAX_TURN_TOKENS || 12_000_000)

// Identical consecutive calls. Nudged at 3, 5 and 8 — and if it is STILL making
// the same call after that, it is not going to stop on its own.
const STUCK_AT = 12

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
function systemPrompt (cwd, useTools, model, computerControl, skills, persona, planMode, planAddendum, memory) {
  const personaText = persona ? `\n\n${persona}` : ''
  const planText = planMode
    ? '\n\nPLAN MODE IS ON. Do NOT edit files, create files, or run mutating commands yet. Research the codebase (read/list/grep only), think through the approach, then present a concrete step-by-step plan by calling the exit_plan_mode tool with your plan in markdown. Only after the user approves the plan will you be able to make changes.'
    : ''
  const skillText = (skills && skills.length)
    ? `\n\nActive skills (follow these):\n${skills.map(s => `• ${s.name}: ${s.content}${s.dir && resolveSkillDir(s.dir) ? `\n  Skill folder: ${resolveSkillDir(s.dir)}` : ''}`).join('\n')}`
    : ''
  const stable = `You are a coding agent running inside Radiant, a local coding harness on the user's ${os.type() === 'Darwin' ? 'Mac' : os.type()} (${os.platform()} ${os.release()}). Radiant is the app, not you: you are the model "${model}". If asked what model you are, answer with your actual model name and maker.${personaText}
Workspace directory: ${cwd}
${useTools ? 'You have tools to read, write, and edit files and to run shell commands in the workspace. Use them to investigate before answering and to make changes when asked. Prefer edit_file for small changes and write_file for new files. After making changes, verify them when practical (run the code, run tests).' : 'Tools are disabled for this conversation; answer from knowledge and the conversation only.'}${computerControl ? `
You can also control the computer. browser_* tools drive an automated browser; screen_* tools control the whole desktop. ALWAYS take a screenshot first (browser_screenshot / screen_screenshot) and look at it before clicking or typing — click coordinates are pixel positions read from the most recent screenshot. Work in small steps: screenshot, act, screenshot again to confirm. Prefer browser_* for web tasks.` : ''}
Be direct and concise. Use markdown; fence code blocks with a language tag. When you finish a task, summarize what changed in a sentence or two.${planText}${skillText}`

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

function toAnthropic (messages) {
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
      else if (p.type === 'tool') pendingTools.push(p)
    }
    flush()
    if (blocks.length) out.push({ role: 'assistant', content: blocks })
  }
  return out
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
      else if (p.type === 'tool') pendingTools.push(p)
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

export function foldOldToolResults (messages) {
  const cut = Math.floor((messages.length - KEEP_WHOLE) / FOLD_STEP) * FOLD_STEP
  if (cut <= 0) return messages
  let folded = 0
  const out = messages.map((m, i) => {
    if (i >= cut || !Array.isArray(m.parts)) return m
    let touched = false
    const parts = m.parts.map(p => {
      if (p.type !== 'tool' || typeof p.result !== 'string' || p.result.length <= FOLD_TO) return p
      touched = true
      folded += p.result.length - FOLD_TO
      return {
        ...p,
        result: p.result.slice(0, FOLD_TO) +
          `\n\n[… ${p.result.length - FOLD_TO} more characters from this earlier ${p.name} were trimmed to keep the conversation small. Run it again if you need the rest.]`
      }
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
  const res = await fetch(`${baseUrl}/v1/messages`, {
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
      const totalIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      emit({ type: 'usage', input: totalIn, output: 0 })
    }
    else if (ev.type === 'content_block_start') {
      const b = ev.content_block
      if (b.type === 'text') current = { type: 'text', text: '' }
      else if (b.type === 'thinking') current = { type: 'thinking' }
      else if (b.type === 'tool_use') current = { type: 'tool', id: b.id, name: b.name, json: '' }
      else current = { type: 'skip' }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta
      if (d.type === 'text_delta' && current?.type === 'text') { current.text += d.text; emit({ type: 'text_delta', text: d.text }) }
      else if (d.type === 'thinking_delta') emit({ type: 'thinking_delta', text: d.thinking })
      else if (d.type === 'input_json_delta' && current?.type === 'tool') current.json += d.partial_json
    } else if (ev.type === 'content_block_stop') {
      if (current?.type === 'text' && current.text) parts.push({ type: 'text', text: current.text })
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
  return { parts, stopOnTools: stopReason === 'tool_use' }
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

async function openaiRound ({ baseUrl, apiKey, accessToken, model, messages, tools, toolDefs, extraHeaders, effort, provider, cachingEnabled, emit, signal }) {
  const body = { model, messages, stream: true }
  if (effort && effort !== 'auto') body.reasoning_effort = effort
  if (tools) {
    body.tools = (toolDefs || TOOL_DEFS).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  }
  withOpenRouterClaudeCaching(body, provider, model, cachingEnabled)
  const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) }
  const bearer = accessToken || apiKey
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw await httpErr(res)

  let text = ''
  const calls = [] // by index: {id, name, args:''}
  let finish = null
  for await (const chunk of sseEvents(res)) {
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
  if (text) parts.push({ type: 'text', text })
  for (const c of calls.filter(Boolean)) {
    let args = {}
    try { args = c.args ? JSON.parse(c.args) : {} } catch {}
    parts.push({ type: 'tool', id: c.id, name: c.name, args })
  }
  return { parts, stopOnTools: finish === 'tool_calls' || calls.filter(Boolean).length > 0 }
}

// ---------- ChatGPT subscription: OpenAI Responses API via the Codex backend ----------
// A ChatGPT (Plus/Pro) OAuth token can't call api.openai.com/v1/chat/completions
// (401 "missing scope: model.request"). The Codex CLI routes subscription traffic
// to chatgpt.com/backend-api/codex/responses using the Responses API shape plus a
// ChatGPT-Account-ID header. We mirror that. (Unofficial — same client as Codex.)
const CHATGPT_BASE = 'https://chatgpt.com/backend-api/codex'
const CODEX_CLIENT_VERSION = '0.146.0'
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

function toResponsesInput (messages) {
  const input = []
  for (const m of messages) {
    if (m.role === 'user') {
      const content = [{ type: 'input_text', text: userText(m) }]
      for (const a of imageAttachments(m)) content.push({ type: 'input_image', image_url: `data:${a.mime};base64,${a.dataB64}` })
      input.push({ type: 'message', role: 'user', content })
      continue
    }
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: p.text }] })
      else if (p.type === 'tool') {
        input.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.args || {}) })
        input.push({ type: 'function_call_output', call_id: p.id, output: String(p.result ?? '') })
      }
    }
  }
  return input
}

async function chatgptRound ({ accessToken, accountId, model, messages, system, tools, toolDefs, effort, emit, signal }) {
  // The Codex backend rejects retired ids (gpt-5, gpt-5-codex, gpt-5.1…); remap
  // those to the current default. Live ids (gpt-5.6-sol, gpt-5.5, …) pass through.
  const retired = /codex|^gpt-5$|^gpt-5\.1$|^gpt-4/i.test(model)
  const useModel = (!model || retired) ? CHATGPT_DEFAULT_MODEL : model
  const body = { model: useModel, instructions: system, input: toResponsesInput(messages), store: false, stream: true }
  if (effort && effort !== 'auto') body.reasoning = { effort }
  if (tools) body.tools = (toolDefs || TOOL_DEFS).map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }))
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId || '',
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: crypto.randomUUID(),
    accept: 'text/event-stream'
  }
  const res = await fetchRetry(`${CHATGPT_BASE}/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw await httpErr(res)

  let text = ''
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
        if (ev.item?.type === 'function_call') byItem[ev.item.id] = { id: ev.item.call_id, name: ev.item.name, args: ev.item.arguments || byItem[ev.item.id]?.args || '' }
        break
      case 'response.completed': {
        const u = ev.response?.usage; if (u) emit({ type: 'usage', input: u.input_tokens, output: u.output_tokens }); break
      }
      case 'response.failed': throw new Error(ev.response?.error?.message || 'ChatGPT response failed')
    }
  }
  const parts = []
  if (text) parts.push({ type: 'text', text })
  const calls = Object.values(byItem)
  for (const c of calls) {
    let args = {}; try { args = c.args ? JSON.parse(c.args) : {} } catch {}
    parts.push({ type: 'tool', id: c.id, name: c.name, args })
  }
  return { parts, stopOnTools: calls.length > 0 }
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
  description: 'Render a rich inline widget in the chat instead of (or alongside) plain prose, when structured data would land better than a paragraph. Use it for: a comparison table, a set of key stats/metrics, a before/after code diff, or a decision card offering the user a few choices. Keep it focused — one widget per call, and still write a short sentence of prose around it. Do NOT use it for ordinary explanations that read fine as text.',
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
    chars += (m.text || '').length
    for (const p of m.parts || []) {
      if (p.text) chars += p.text.length
      if (p.result) chars += String(p.result).length
      if (p.args) chars += JSON.stringify(p.args).length
    }
  }
  return Math.round(chars / 4)
}
function isContextError (msg) {
  return /context length|context window|maximum context|too many tokens|prompt is too long|reduce the length|token.{0,4}limit|exceeds? the maximum|input is too long|maximum.{0,20}tokens/i.test(String(msg || ''))
}
function renderForSummary (messages) {
  return messages.map(m => {
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
  try { summary = (await summarize(renderForSummary(older).slice(-50_000))).trim() } catch {}
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

// ---------- the agent loop ----------
export async function runTurn ({ provider, model, apiKey, getAccessToken, getAccountId, session, useTools, computerControl, skills, persona, planAddendum, memory, agentId, groupSpeakerId, groupNames, mcpTools, callMcp, askAgent, peerAgents, planMode, onPlanExit, effort, summarize, autoCompact, autoApproveComputer, cachingEnabled, cacheTtl, emit, requestApproval, requestUserChoice, signal }) {
  // ⚠️ NOT `session.cwd || os.homedir()`. A folder that is set and not here is
  // the case that broke every tool call in the chat — see usableCwd.
  const { dir: cwd, missing: strayCwd } = usableCwd(session.cwd)
  const system = systemPrompt(cwd, useTools, model, computerControl, skills, persona, planMode, planAddendum, memory)
  // proactive compaction before a very long turn
  if (autoCompact && summarize && estimateTokens(session.messages) > PROACTIVE_TOKENS) {
    await compactSession(session, 4, summarize, emit)
  }
  const assistant = { role: 'assistant', model, parts: [] }
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
    // ⚠️ A HALT MUST SURVIVE THE STREAM CLOSING, same as a notice — it is the
    // only thing in the transcript that says the turn is not finished.
    if (ev.type === 'halt') assistant.parts.push({ type: 'halt', reason: ev.reason, text: ev.text })
    emitRaw(ev)
  }
  // After the wrapper, so it is written into the transcript and not just
  // streamed: this is the sentence that explains every odd path in the turn
  // below, and it has to still be there when the turn is read back.
  if (strayCwd) {
    emit({ type: 'notice', text: `This chat's folder is not on this Mac — ${strayCwd} — so it is working in ${cwd} instead. That usually means the chat was started on another Mac; pick a folder for it in the header to make it stick here.` })
  }
  let compacted = false

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
  const toolDefs = [
    ...TOOL_DEFS,
    ...(computerControl ? COMPUTER_TOOL_DEFS : []),
    ...(mcpTools || []),
    ...(canAskAgents ? [askAgentToolDef(peerAgents)] : []),
    SHOW_WIDGET_TOOL,
    ...(requestUserChoice ? [ASK_USER_TOOL] : []),
    ...(planMode ? [EXIT_PLAN_TOOL] : [])
  ].filter(t => !planMode || !planBlocked(t.name))

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
  const REPEAT_NUDGES = { 3: 'stop and re-read the last result — this exact call has produced the same output 3 times', 5: 'you are stuck in a loop (5 identical calls). Change your approach or explain what is blocking you', 8: 'STOP repeating this call (8 times). Do something different or tell the user you are blocked' }
  // per-session stats (folded into session.stats)
  const stats = session.stats || { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 }
  stats.turns += 1
  // ⚠️ THIS COUNTER IS THE SESSION'S WHOLE LIFE, NOT THIS TURN'S. I added a
  // "per turn" ceiling and compared it against the running total, so a chat that
  // had ever spent more than the limit halted INSTANTLY on every turn after —
  // zero tool calls, no work, and "keep going" could never do anything. Tony's
  // chat had 29.8M tokens behind it against a 2M limit: permanently bricked, and
  // strictly worse than the round cap it replaced. Take the mark at the start
  // and measure the difference.
  const tokensBefore = (stats.inTokens || 0) + (stats.outTokens || 0)
  const emitS = ev => { if (ev.type === 'usage') { stats.inTokens += ev.input || 0; stats.outTokens += ev.output || 0 } emit(ev) }
  const finishStats = () => { session.stats = stats; emit({ type: 'stats', stats }) }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // ⚠️ STOP HAD EXACTLY ONE CHECK IN THIS WHOLE FUNCTION, and it sat after the
    // approval prompt. Everywhere else the turn found out it had been cancelled
    // only when the NEXT model request rejected — so pressing Stop while tools
    // were running ran every remaining tool first, and a shell command ran to
    // completion or to its two-minute timeout. Tony: "the stop button does not
    // seem to be doing anything… agent just keeps talking and talking."
    // Aborting returns cleanly rather than throwing: the partial answer is real
    // work and belongs in the transcript.
    if (signal?.aborted) { finishStats(); emit({ type: 'stopped' }); return }
    // The economic backstop. A round count never measured cost; this does.
    if ((stats.inTokens + stats.outTokens) - tokensBefore > MAX_TURN_TOKENS) {
      finishStats()
      emit({
        type: 'halt',
        reason: 'budget',
        text: `This turn has used ${Math.round(((stats.inTokens + stats.outTokens) - tokensBefore) / 1e6 * 10) / 10}M tokens and was stopped before it spent more. Everything above is saved; Continue starts a fresh turn from here, which also costs less because the conversation gets summarized.`
      })
      emit({ type: 'done' })
      return
    }
    emit({ type: 'round_start', round })
    const args = {
      baseUrl: provider.baseUrl,
      apiKey,
      accessToken,
      model,
      provider,
      systemStable: system.stable,
      systemVolatile: system.volatile,
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
    try {
      const reqMsgs = foldOldToolResults(groupSpeakerId ? groupFlatten(session.messages, groupSpeakerId, groupNames || {}) : session.messages)
      result = provider.type === 'anthropic'
        ? await anthropicRound({ ...args, messages: toAnthropic(reqMsgs) })
        : useChatgpt
          ? await chatgptRound({ ...args, system: system.full, accountId, messages: reqMsgs })
          : await openaiRound({ ...args, messages: toOpenAI(reqMsgs, system.full) })
      stats.llmMs += Date.now() - roundStart
    } catch (e) {
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
          args.effort = 'auto'
          emit({ type: 'notice', text: 'This model does not take a thinking level — running at its default.' })
          continue
        }
      // Ran out of context -> summarize older messages and retry this round.
      if (isContextError(e.message) && autoCompact && summarize && !compacted) {
        compacted = true
        const i = session.messages.indexOf(assistant)
        if (i >= 0) session.messages.splice(i, 1)
        const did = await compactSession(session, 4, summarize, emit)
        session.messages.push(assistant)
        if (did) { emit({ type: 'notice', text: 'The conversation was getting long — summarized earlier messages to free up room, and continued.' }); continue }
      }
      throw e
    }

    const toolParts = result.parts.filter(p => p.type === 'tool')
    for (const p of result.parts) {
      if (p.type === 'text') assistant.parts.push(p)
    }
    if (!toolParts.length || !result.stopOnTools) { finishStats(); emit({ type: 'done' }); return }

    const toolLoopStart = Date.now()
    for (const call of toolParts) {
      // A model can ask for several tools in one round. Stop means stop before
      // the next one, not after all of them.
      if (signal?.aborted) { stats.toolMs += Date.now() - toolLoopStart; finishStats(); emit({ type: 'stopped' }); return }
      const part = { type: 'tool', id: call.id, name: call.name, args: call.args }
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
        const bounded = boundResult(call.name, part.result)
        part.result = bounded.text
        if (bounded.truncated) {
          part.truncated = bounded.truncated
          emit({ type: 'notice', text: `${call.name} returned ${bounded.truncated.toLocaleString()} characters more than fits; the middle was dropped.` })
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
        emit({ type: 'tool_result', id: call.id, result: part.result, denied: !approved, hasImage: Boolean(part.resultImage) })
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
      emit({ type: 'tool_result', id: call.id, result: part.result, denied: !approved, hasImage: Boolean(part.resultImage) })
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
        text: `You have used this turn's limit of ${MAX_ROUNDS} rounds of tool use and cannot call any more tools. Do not call a tool. In 2-4 plain sentences tell the user: what you were trying to do, what is actually finished, what is not, and what would unblock it. If you were stuck repeating something that did not work, say so and say why.`
      }
      const msgs = [...session.messages, wrapUp]
      const args = {
        baseUrl: provider.baseUrl, apiKey, accessToken, model, system,
        tools: false, toolDefs: [],
        extraHeaders: provider.id === 'copilot' ? COPILOT_HEADERS : undefined,
        effort, emit: emitS, signal
      }
      const wrapStart = Date.now()
      const said = provider.type === 'anthropic'
        ? await anthropicRound({ ...args, messages: toAnthropic(msgs) })
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
    text: `This turn used its limit of ${MAX_ROUNDS} rounds of tool use and stopped. Nothing is lost — everything above is saved, and Continue picks it up from here.`
  })
  emit({ type: 'done' })
}

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
