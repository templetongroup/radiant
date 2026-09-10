// A long agentic turn must not die at the model's context limit.
//
// ⚠️ THE CHAT THAT DIED HAD THREE MESSAGES IN IT. Every safety net counted
// messages — fold by message, compact by message — and an agentic turn is one
// message that grows by a round of tool results every few seconds. Tony's
// grok-build chat reached 259,445 tokens on a 256,000 model inside a single
// assistant message; xAI's refusal matched none of the phrasings the retry
// looked for; he got `400: {"code":"invalid-argument", ...}` and a dead turn.
import { foldOldToolResults, isContextError } from '../server/providers.js'

let pass = 0, fail = 0
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('  FAIL', what) } }
const size = msgs => JSON.stringify(msgs).length

// ── every refusal a real provider has sent must be recognised ──────────────
const refusals = [
  ['xAI', `400: {"code":"invalid-argument","error":"This model's maximum prompt length is 256000 but the request contains 259445 tokens."}`],
  ['Anthropic', 'prompt is too long: 213456 tokens > 200000 maximum'],
  ['OpenAI', "This model's maximum context length is 128000 tokens. However, your messages resulted in 130012 tokens."],
  ['Gemini', 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).'],
  ['OpenRouter', 'This endpoint\'s maximum context length is 131072 tokens. However, you requested about 140000 tokens'],
  ['Ollama', 'the input length exceeds the context window'],
  ['DeepSeek', 'This model\'s maximum context length is 65536 tokens. However, you requested 70000 tokens (60000 in the messages, 10000 in the completion). Please reduce the length of the messages or completion.']
]
for (const [who, msg] of refusals) ok(isContextError(msg), `${who}'s refusal is recognised: ${msg.slice(0, 60)}`)
ok(!isContextError('401: invalid api key'), 'an auth error is not mistaken for one')
ok(!isContextError('The model produced no output'), 'nor an empty reply')

// ── one message, thirty rounds: the shape of the chat that died ─────────────
const big = n => 'x'.repeat(n)
const turn = rounds => ({
  role: 'assistant',
  parts: Array.from({ length: rounds }, (_, r) => ({ type: 'tool', id: `t${r}`, name: 'read_file', args: { path: `f${r}` }, result: big(8000), round: r }))
})
const session = [{ role: 'user', text: 'do the thing' }, turn(30)]
const whole = size(session)
const folded = foldOldToolResults(session)
ok(folded !== session, 'a thirty-round message is folded even though the message count is tiny')
ok(size(folded) < whole * 0.35, `and it gets a lot smaller (${size(folded)} of ${whole})`)
const keptWhole = folded[1].parts.filter(p => p.result.length === 8000).map(p => p.round)
ok(keptWhole.length >= 4 && keptWhole.includes(29) && keptWhole.includes(26), `the last rounds stay whole (whole: ${keptWhole.join(',')})`)
ok(!keptWhole.includes(0), 'the first round does not')
ok(/trimmed to keep the conversation small/.test(folded[1].parts[0].result), 'a folded result says so, and how to get it back')

// the boundary is quantized: consecutive rounds send the same prefix
const a = foldOldToolResults([session[0], turn(9)])[1].parts.filter(p => p.result.length === 8000).length
const b = foldOldToolResults([session[0], turn(10)])[1].parts.filter(p => p.result.length === 8000).length
const c = foldOldToolResults([session[0], turn(11)])[1].parts.filter(p => p.result.length === 8000).length
ok(a === 5 && b === 6 && c === 7, `between steps the whole window grows instead of sliding (${a},${b},${c})`)
const d = foldOldToolResults([session[0], turn(12)])[1].parts.filter(p => p.result.length === 8000).length
ok(d === 4, `and snaps back at the step (${d})`)

// a short turn is untouched
const short = [session[0], turn(3)]
ok(foldOldToolResults(short) === short, 'three rounds are sent whole')

// ── hard: the request was refused; keep only what the model just asked for ──
const hard = foldOldToolResults(session, { hard: true })
const hardWhole = hard[1].parts.filter(p => p.result.length === 8000).map(p => p.round)
ok(hardWhole.length === 1 && hardWhole[0] === 29, `hard keeps only the current round (${hardWhole.join(',')})`)
const older = [{ role: 'user', text: 'a' }, turn(2), { role: 'user', text: 'b' }, turn(30)]
const hard2 = foldOldToolResults(older, { hard: true })
ok(hard2[1].parts.every(p => p.result.length < 8000), 'and folds every result in earlier messages, however recent')
// untagged parts from a transcript older than this change are never trusted whole in hard mode
const legacy = [{ role: 'user', text: 'a' }, { role: 'assistant', parts: [{ type: 'tool', id: 'x', name: 'read_file', args: {}, result: big(8000) }] }, { role: 'user', text: 'b' }, turn(5)]
ok(foldOldToolResults(legacy, { hard: true })[1].parts[0].result.length < 8000, 'legacy untagged results in earlier messages fold too')

console.log(`\n${pass}/${pass + fail} passed  ·  a long turn is trimmed, not killed`)
process.exit(fail ? 1 : 0)
