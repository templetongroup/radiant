// The model's reasoning is kept and sent back on the next step of a turn —
// for Claude (signed thinking blocks) and a ChatGPT sign-in (encrypted
// reasoning items). Fake servers behave like the real ones: the Claude one
// refuses a tool step whose signed thinking is missing, as Anthropic does.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const codexServer = http.createServer()
await new Promise(r => codexServer.listen(0, r))
process.env.RADIANT_CHATGPT_BASE = `http://127.0.0.1:${codexServer.address().port}`
const { runTurn, toAnthropic, toResponsesInput } = await import('../server/providers.js')

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }
const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`); res.end() }

// ── conversion rules ─────────────────────────────────────────────────────────
{
  const think = { type: 'reasoning', provider: 'anthropic', model: 'claude-x', round: 0, block: { type: 'thinking', thinking: 'plan: read the file', signature: 'sig-1' } }
  const msgs = [{ role: 'user', text: 'go' }, { role: 'assistant', parts: [think, { type: 'text', text: 'Reading it.' }, { type: 'tool', id: 't1', name: 'read_file', args: { path: 'a' }, result: 'x', round: 0 }] }]
  const on = toAnthropic(msgs, { model: 'claude-x', thinking: true })
  ok(JSON.stringify(on[1].content.map(b => b.type)) === '["thinking","text","tool_use"]', 'Claude: the signed thinking goes back first, before the text and the tool call')
  ok(on[1].content[0].signature === 'sig-1', 'with its signature')
  ok(!toAnthropic(msgs, { model: 'claude-y', thinking: true })[1].content.some(b => b.type === 'thinking'), 'another model never gets it (a signature is not portable)')
  ok(!toAnthropic(msgs, { model: 'claude-x', thinking: false })[1].content.some(b => b.type === 'thinking'), 'and it is not sent when thinking is off')

  const item = { type: 'reasoning', summary: [], encrypted_content: 'enc-1' }
  const cm = [{ role: 'user', text: 'go' }, { role: 'assistant', parts: [{ type: 'reasoning', provider: 'codex', model: 'gpt-x', item }, { type: 'tool', id: 'c1', name: 'read_file', args: {}, result: 'x' }] }]
  const inp = toResponsesInput(cm, 'gpt-x')
  ok(JSON.stringify(inp.map(i => i.type)) === '["message","reasoning","function_call","function_call_output"]', 'ChatGPT: the encrypted reasoning goes back in place, before the call it led to')
  ok(!toResponsesInput(cm, 'gpt-other').some(i => i.type === 'reasoning'), 'another model never gets it')
}

// ── Claude, end to end: a thinking level set, a tool-using turn ────────────────
{
  const bodies = []
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b)
      bodies.push(body)
      const last = body.messages.at(-1)
      if (last.role === 'user' && Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result')) {
        // Anthropic's rule, enforced: the assistant turn with the tool_use must start with the thinking block
        const asst = body.messages.at(-2)
        if (body.thinking && asst.content[0]?.type !== 'thinking') {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`. When `thinking` is enabled, a final `assistant` message must start with a thinking block.' } }))
        }
        return sse(res, [
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The file says hello.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' }
        ])
      }
      sse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should read hello.txt first.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-abc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'hello.txt' }) } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' }
      ])
    })
  })
  await new Promise(r => srv.listen(0, r))
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-think-'))
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello')
  const session = { id: 'think', cwd: ws, messages: [{ role: 'user', text: 'What does hello.txt say?' }] }
  const events = []
  await runTurn({ provider: { id: 'anthropic', type: 'anthropic', baseUrl: `http://127.0.0.1:${srv.address().port}` }, model: 'claude-x', apiKey: 'k', session, useTools: true, effort: 'low', cachingEnabled: false, emit: e => events.push(e), requestApproval: async () => true, signal: AbortSignal.timeout(20000) })
  srv.close(); fs.rmSync(ws, { recursive: true, force: true })
  const reply = session.messages.at(-1).parts.filter(p => p.type === 'text').map(p => p.text).join('')
  ok(/hello/.test(reply), `the turn finishes after the tool step (got ${JSON.stringify(reply)})`)
  ok(!events.some(e => e.type === 'notice' && /does not take a thinking level/.test(e.text)), 'thinking is not switched off after the first tool call')
  ok(bodies.length === 2 && bodies[1].thinking && bodies[1].messages[1].content[0].type === 'thinking' && bodies[1].messages[1].content[0].signature === 'SIG-abc', 'the second step carried the signed thinking back')
  ok(session.messages.at(-1).parts.some(p => p.type === 'reasoning' && p.block.signature === 'SIG-abc'), 'the reasoning is kept with the reply')
}

// ── ChatGPT sign-in, end to end ───────────────────────────────────────────────
{
  const bodies = []
  codexServer.on('request', (req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (req.url.includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [] })) }
      const body = JSON.parse(b)
      bodies.push(body)
      if (body.input.some(i => i.type === 'function_call_output')) {
        return sse(res, [
          { type: 'response.output_text.delta', delta: 'It says hello.' },
          { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } }
        ])
      }
      sse(res, [
        { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC-xyz' } },
        { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } },
        { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 8 } } }
      ])
    })
  })
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'radiant-codex-'))
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello')
  const session = { id: 'codex', cwd: ws, messages: [{ role: 'user', text: 'What does hello.txt say?' }] }
  await runTurn({ provider: { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1' }, model: 'gpt-5.6-sol', accessToken: 'tok', getAccessToken: async () => 'tok', getAccountId: async () => 'acct', session, useTools: true, cachingEnabled: false, emit: () => {}, requestApproval: async () => true, signal: AbortSignal.timeout(20000) })
  codexServer.close(); fs.rmSync(ws, { recursive: true, force: true })
  ok(bodies[0]?.include?.includes('reasoning.encrypted_content'), 'the encrypted reasoning is asked for')
  const second = bodies[1]?.input || []
  const ri = second.findIndex(i => i.type === 'reasoning'), fi = second.findIndex(i => i.type === 'function_call')
  ok(ri >= 0 && second[ri].encrypted_content === 'ENC-xyz' && ri < fi, 'the second step carried it back, before the call it led to')
  ok(ri >= 0 && !('id' in second[ri]), 'without its id (nothing is stored server-side)')
  ok(/hello/.test(session.messages.at(-1).parts.filter(p => p.type === 'text').map(p => p.text).join('')), 'and the turn finishes')
}

console.log(`\n${pass}/${pass + fail} passed  ·  the model's reasoning carries from one step to the next`)
process.exit(fail ? 1 : 0)
