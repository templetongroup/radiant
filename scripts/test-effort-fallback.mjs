// A model that rejects the thinking level must not end the turn: Radiant drops the
// level, retries, and remembers — xAI's grok-4.20-…-non-reasoning answered every
// request that carried reasoning_effort with a 400, and the old fallback set the
// level to "auto" on a copy that the next round rebuilt, so the retry failed too.
import http from 'node:http'
import { runTurn } from '../server/providers.js'

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }

const seen = []
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const j = JSON.parse(b); seen.push({ model: j.model, effort: j.reasoning_effort })
    if ('reasoning_effort' in j && /non-reasoning/.test(j.model)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ code: 'invalid-argument', error: `Model ${j.model} does not support parameter reasoningEffort.` }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); res.end()
  })
})
await new Promise(r => srv.listen(0, r))
const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`

async function turn (model, effort) {
  seen.length = 0
  const events = []
  const session = { id: 's-' + Math.random(), cwd: '/tmp', messages: [{ role: 'user', text: 'hi' }] }
  let threw = null
  try { await runTurn({ provider: { id: 'xai', type: 'openai', baseUrl }, model, apiKey: 'k', session, useTools: true, effort, cachingEnabled: false, emit: e => events.push(e), requestApproval: async () => true, signal: AbortSignal.timeout(15000) }) } catch (e) { threw = e }
  const reply = session.messages.at(-1)?.parts?.filter(p => p.type === 'text').map(p => p.text).join('') || ''
  return { events, threw, reply, requests: [...seen] }
}

const first = await turn('grok-4.20-0309-non-reasoning', 'high')
ok(!first.threw, `the turn does not die on the 400 (${first.threw?.message?.slice(0, 80)})`)
ok(first.reply === 'hello', 'and it is answered')
ok(first.requests.length === 2 && first.requests[0].effort === 'high' && first.requests[1].effort === undefined, 'the retry drops the level instead of resending it')
ok(first.events.some(e => e.type === 'notice' && /thinking level/.test(e.text)), 'and says so')

const second = await turn('grok-4.20-0309-non-reasoning', 'medium')
ok(second.requests.length === 1 && second.requests[0].effort === undefined, 'next turn: the model is not asked with a level again (one request, not two)')
ok(second.reply === 'hello', 'and it answers')

const other = await turn('grok-4.20-0309-reasoning', 'low')
ok(other.requests.length === 1 && other.requests[0].effort === 'low', 'a model that does take a level still gets it')
srv.close()
console.log(`\n${pass}/${pass + fail} passed  ·  a model that rejects a thinking level is asked again without it, and remembered`)
process.exit(fail ? 1 : 0)
