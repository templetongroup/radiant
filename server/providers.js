import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { SKILLS_ROOT } from './config.js'
import { fetchRetry, isTransient } from './util.js'
import { TOOL_DEFS, runTool } from './tools.js'
import { COMPUTER_TOOL_DEFS, COMPUTER_TOOL_NAMES, COMPUTER_SAFE, runComputerTool } from './computer-tools.js'
import { COPILOT_HEADERS } from './oauth.js'

const MAX_ROUNDS = 30

function systemPrompt (cwd, useTools, model, computerControl, skills, persona, planMode, memory) {
  const personaText = persona ? `\n\n${persona}` : ''
  const memoryText = (memory && memory.length)
    ? `\n\nWhat you remember about this user and their projects (from past sessions — use it when relevant, don't recite it):\n${memory.map(f => `• ${f}`).join('\n')}`
    : ''
  const planText = planMode
    ? '\n\nPLAN MODE IS ON. Do NOT edit files, create files, or run mutating commands yet. Research the codebase (read/list/grep only), think through the approach, then present a concrete step-by-step plan by calling the exit_plan_mode tool with your plan in markdown. Only after the user approves the plan will you be able to make changes.'
    : ''
  const skillText = (skills && skills.length)
    ? `\n\nActive skills (follow these):\n${skills.map(s => `• ${s.name}: ${s.content}${s.dir ? `\n  Skill folder: ${path.join(SKILLS_ROOT, s.dir)}` : ''}`).join('\n')}`
    : ''
  return `You are a coding agent running inside Radiant, a local coding harness on the user's ${os.type() === 'Darwin' ? 'Mac' : os.type()} (${os.platform()} ${os.release()}). Radiant is the app, not you: you are the model "${model}". If asked what model you are, answer with your actual model name and maker.${personaText}
Workspace directory: ${cwd}
${useTools ? 'You have tools to read, write, and edit files and to run shell commands in the workspace. Use them to investigate before answering and to make changes when asked. Prefer edit_file for small changes and write_file for new files. After making changes, verify them when practical (run the code, run tests).' : 'Tools are disabled for this conversation; answer from knowledge and the conversation only.'}${computerControl ? `
You can also control the computer. browser_* tools drive an automated browser; screen_* tools control the whole desktop. ALWAYS take a screenshot first (browser_screenshot / screen_screenshot) and look at it before clicking or typing — click coordinates are pixel positions read from the most recent screenshot. Work in small steps: screenshot, act, screenshot again to confirm. Prefer browser_* for web tasks.` : ''}
Be direct and concise. Use markdown; fence code blocks with a language tag. When you finish a task, summarize what changed in a sentence or two.${planText}${skillText}${memoryText}`
}

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

// ---------- single API round, streaming; returns {parts, stopOnTools} ----------
async function anthropicRound ({ baseUrl, apiKey, accessToken, model, messages, system, tools, toolDefs, emit, signal }) {
  // Subscription (OAuth) requests must present as Claude Code: the first system
  // block is the CLI's identity, auth is Bearer, and the oauth beta is set.
  const CLAUDE_CODE_ID = "You are Claude Code, Anthropic's official CLI for Claude."
  const sys = accessToken
    ? [{ type: 'text', text: CLAUDE_CODE_ID }, { type: 'text', text: system }]
    : system
  const body = { model, max_tokens: 8192, system: sys, messages, stream: true }
  if (tools) body.tools = (toolDefs || TOOL_DEFS).map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
    headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219'
  } else {
    headers['x-api-key'] = apiKey
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
    if (ev.type === 'message_start' && ev.message?.usage) emit({ type: 'usage', input: ev.message.usage.input_tokens, output: 0 })
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

async function openaiRound ({ baseUrl, apiKey, accessToken, model, messages, tools, toolDefs, extraHeaders, emit, signal }) {
  const body = { model, messages, stream: true }
  if (tools) {
    body.tools = (toolDefs || TOOL_DEFS).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  }
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
    if (chunk.usage) emit({ type: 'usage', input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens })
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

async function chatgptRound ({ accessToken, accountId, model, messages, system, tools, toolDefs, emit, signal }) {
  // The Codex backend rejects retired ids (gpt-5, gpt-5-codex, gpt-5.1…); remap
  // those to the current default. Live ids (gpt-5.6-sol, gpt-5.5, …) pass through.
  const retired = /codex|^gpt-5$|^gpt-5\.1$|^gpt-4/i.test(model)
  const useModel = (!model || retired) ? CHATGPT_DEFAULT_MODEL : model
  const body = { model: useModel, instructions: system, input: toResponsesInput(messages), store: false, stream: true }
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

// ---------- the agent loop ----------
export async function runTurn ({ provider, model, apiKey, getAccessToken, getAccountId, session, useTools, computerControl, skills, persona, memory, agentId, groupSpeakerId, groupNames, mcpTools, callMcp, askAgent, peerAgents, planMode, onPlanExit, summarize, autoCompact, autoApproveComputer, emit, requestApproval, requestUserChoice, signal }) {
  const cwd = session.cwd || os.homedir()
  const system = systemPrompt(cwd, useTools, model, computerControl, skills, persona, planMode, memory)
  // proactive compaction before a very long turn
  if (autoCompact && summarize && estimateTokens(session.messages) > PROACTIVE_TOKENS) {
    await compactSession(session, 4, summarize, emit)
  }
  const assistant = { role: 'assistant', model, parts: [] }
  if (agentId) assistant.agentId = agentId
  session.messages.push(assistant)
  let compacted = false

  const accessToken = getAccessToken ? await getAccessToken() : null
  const accountId = getAccountId ? await getAccountId() : null
  // ChatGPT subscription (OAuth, no API key) must use the Responses/Codex backend
  const useChatgpt = provider.id === 'openai' && accessToken && !apiKey
  const canAskAgents = askAgent && peerAgents && peerAgents.length
  const toolDefs = [
    ...TOOL_DEFS,
    ...(computerControl ? COMPUTER_TOOL_DEFS : []),
    ...(mcpTools || []),
    ...(canAskAgents ? [askAgentToolDef(peerAgents)] : []),
    SHOW_WIDGET_TOOL,
    ...(requestUserChoice ? [ASK_USER_TOOL] : []),
    ...(planMode ? [EXIT_PLAN_TOOL] : [])
  ]

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
  const emitS = ev => { if (ev.type === 'usage') { stats.inTokens += ev.input || 0; stats.outTokens += ev.output || 0 } emit(ev) }
  const finishStats = () => { session.stats = stats; emit({ type: 'stats', stats }) }
  for (let round = 0; round < MAX_ROUNDS; round++) {
    emit({ type: 'round_start', round })
    const args = {
      baseUrl: provider.baseUrl,
      apiKey,
      accessToken,
      model,
      system,
      tools: toolsEnabled,
      toolDefs,
      extraHeaders: provider.id === 'copilot' ? COPILOT_HEADERS : undefined,
      emit: emitS,
      signal
    }
    let result
    const roundStart = Date.now()
    try {
      const reqMsgs = groupSpeakerId ? groupFlatten(session.messages, groupSpeakerId, groupNames || {}) : session.messages
      result = provider.type === 'anthropic'
        ? await anthropicRound({ ...args, messages: toAnthropic(reqMsgs) })
        : useChatgpt
          ? await chatgptRound({ ...args, accountId, messages: reqMsgs })
          : await openaiRound({ ...args, messages: toOpenAI(reqMsgs, system) })
      stats.llmMs += Date.now() - roundStart
    } catch (e) {
      // Model doesn't support tools (common with local models) -> retry once without them.
      if (toolsEnabled && round === 0 && /tool/i.test(e.message) && /support|invalid|unknown|400/i.test(e.message)) {
        toolsEnabled = false
        emit({ type: 'notice', text: 'This model does not support tools — continuing in chat-only mode.' })
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
      const part = { type: 'tool', id: call.id, name: call.name, args: call.args }
      assistant.parts.push(part)
      emit({ type: 'tool_start', id: call.id, name: call.name, args: call.args })
      const isComputer = COMPUTER_TOOL_NAMES.has(call.name)
      const isMcp = call.name.startsWith('mcp__')
      const needsApproval = requestApproval && (call.name === 'run_command' || isMcp || (isComputer && !COMPUTER_SAFE.has(call.name) && !autoApproveComputer))
      const approved = needsApproval ? await requestApproval(call) : true
      if (signal.aborted) return
      if (!approved) {
        part.denied = true
        part.result = 'The user declined this action. Ask them how they would like to proceed, or try a different approach.'
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
      } else if (call.name === 'ask_agent') {
        emit({ type: 'notice', text: `Consulting ${call.args?.agent || 'another agent'}…` })
        part.result = await askAgent(call.args?.agent, call.args?.question)
      } else if (isMcp) {
        part.result = callMcp ? await callMcp(call.name, call.args) : 'MCP tool unavailable.'
      } else if (isComputer) {
        const r = await runComputerTool(call.name, call.args)
        part.result = r.content
        if (r.image) part.resultImage = r.image
      } else {
        part.result = await runTool(call.name, call.args, cwd)
      }
      // loop-breaker: append an escalating reminder on identical consecutive calls
      if (call.name !== 'ask_user') askStreak = 0
      const sig = call.name + ':' + JSON.stringify(call.args)
      repeatCount = sig === lastSig ? repeatCount + 1 : 1
      lastSig = sig
      if (REPEAT_NUDGES[repeatCount]) part.result = `[reminder: ${REPEAT_NUDGES[repeatCount]}]\n\n${part.result ?? ''}`
      emit({ type: 'tool_result', id: call.id, result: part.result, denied: !approved, hasImage: Boolean(part.resultImage) })
    }
    stats.toolMs += Date.now() - toolLoopStart
  }
  finishStats()
  emit({ type: 'notice', text: `Stopped after ${MAX_ROUNDS} tool rounds.` })
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
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
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
