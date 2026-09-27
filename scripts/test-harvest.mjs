// The failure harvest (scripts/harvest-failures.mjs) sorts the right things
// into the right piles. Synthetic chats only — no real data is read.
import { scanChat, harvest, signature, blame } from './harvest-failures.mjs'

let pass = 0, fail = 0
const ok = (c, what) => { if (c) pass++; else { fail++; console.log('  FAIL', what) } }

ok(signature('Error: 404 Not Found from https://x.com/a/123') === signature('Error: 500 Not Found from https://y.org/b'), 'numbers and urls are taken out of a signature')
ok(signature("ENOENT: no such file or directory, open '/Users/tony/a.js'") === signature("ENOENT: no such file or directory, open '/Users/sam/b.js'"), 'paths are taken out of a signature')

const tool = (name, result, extra = {}) => ({ type: 'tool', id: 't', name, args: {}, result, ...extra })
const chat = {
  provider: 'anthropic', model: 'claude-sonnet-5',
  messages: [
    { role: 'user', text: 'fix the login' },
    { role: 'assistant', parts: [
      tool('run_command', 'bash: /usr/local/bin/rg: Bad CPU type in executable\n\n[exit code 126]'),
      tool('run_command', 'FAILED tests/test_x.py\n[exit code 1]'),
      tool('edit_file', 'Error: old_string not found in file'),
      tool('run_command', '', { timedOut: true }),
      { type: 'halt', reason: 'dropped', text: 'The connection to this turn dropped before it finished' }
    ] },
    { role: 'user', text: 'it still doesn’t work, same error' },
    { role: 'assistant', parts: [] }
  ]
}
const found = scanChat(chat, 'test chat')
const kinds = found.map(f => f.kind)
ok(kinds.includes('halt:dropped'), 'a halted turn is found')
ok(kinds.includes('pushback'), 'the person saying it still does not work is found')
ok(kinds.includes('empty-reply'), 'an empty reply is found')
ok(kinds.includes('tool-timeout'), 'a timed-out command is found')
ok(found.filter(f => f.kind === 'tool-error').length === 3, 'three failing tool calls are found')

const byBlame = Object.fromEntries(found.map(f => [f.kind + ':' + (f.tool || '') + ':' + f.sig.slice(0, 30), blame(f)]))
const blameOf = rx => Object.entries(byBlame).find(([k]) => rx.test(k))?.[1]
ok(blameOf(/Bad CPU|exit code N\]$/) === 'environment' || found.some(f => /126/.test(f.excerpt || '') && blame(f) === 'environment'), 'a binary that cannot execute (126) is the environment, not the agent')
ok(found.some(f => /exit code 1\]/.test(f.excerpt || '') && blame(f) === 'work'), 'a failing test while debugging is the agent working, not a fault')
ok(found.some(f => /old_string not found/.test(f.excerpt || '') && blame(f) === 'tool-use'), 'an edit that missed is a tool-use problem')
ok(found.some(f => f.kind === 'halt:dropped' && blame(f) === 'radiant'), 'a dropped turn is Radiant’s')
ok(blame({ kind: 'halt:error', sig: '429: rate limit', excerpt: '429: This request would exceed your account’s rate limit' }) === 'provider', 'a rate limit is the provider’s')

const three = n => ({ provider: 'openai', model: 'gpt-5.6-sol', messages: [{ role: 'user', text: 'go' }, { role: 'assistant', parts: Array.from({ length: n }, () => tool('browser_read', 'Error: Chrome is not allowing JavaScript from Apple Events')) }] })
ok(scanChat(three(3), 'x').some(f => f.kind === 'repeat-failure'), 'the same failure three times in one reply is a repeat')
ok(!scanChat(three(2), 'x').some(f => f.kind === 'repeat-failure'), 'twice is not')

const r = harvest({ chats: [{ chat, where: 'a' }, { chat, where: 'b' }], bench: [{ tag: 'radiant__m', id: 'django__django-1', run: 1, model: 'gpt-5.6-sol', resolved: false, chat: null }] })
const dropped = r.causes.find(c => c.kind === 'halt:dropped')
ok(dropped?.count === 2 && dropped.examples.length === 2, 'the same failure in two chats is one cause, counted twice')
ok(r.causes.some(c => c.kind === 'bench-unresolved' && c.blame === 'work'), 'a benchmark fix that did not pass is counted, as the agent’s work')
ok(r.scanned.chats === 2 && r.scanned.benchRuns === 1, 'it says how much it read')

console.log(`\n${pass}/${pass + fail} passed  ·  real failures sorted into the ones Radiant can fix`)
process.exit(fail ? 1 : 0)
