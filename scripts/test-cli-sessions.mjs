// Listing and importing the sessions Claude Code and Codex have saved on this Mac.
//
// Every file here is made up for the test, in the same shape the real tools
// write, inside a throwaway HOME. This script never reads a real
// ~/.claude or ~/.codex, and nothing a person said to either tool is copied
// into it.
//
// Part 1 calls the readers directly. Part 2 starts a real Radiant server (own
// port, own HOME, never 5834) and drives the routes, including the opt-in
// setting and the rule that another device cannot read this Mac's history
// unless it is allowed.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'radiant-cli-sessions-'))
const home = join(root, 'home'); mkdirSync(home)
let pass = 0, fail = 0
const ok = (n, c, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${extra}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const jl = recs => recs.map(r => JSON.stringify(r)).join('\n') + '\n'
const at = (file, secondsAgo) => { const t = new Date(Date.now() - secondsAgo * 1000); utimesSync(file, t, t) }

// ------------------------------------------------------------------ Claude fixtures
const CL = home + '/.claude/projects'
const projA = join(CL, '-tmp-proj-a'); mkdirSync(projA, { recursive: true })
const projB = join(CL, '-tmp-proj-b'); mkdirSync(projB, { recursive: true })
const ID = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', side: '44444444-4444-4444-8444-444444444444', empty: '55555555-5555-4555-8555-555555555555', link: '66666666-6666-4666-8666-666666666666', odd: '6738b4eb-b1c0-5b9d-8f13-bfa1ea3df752' }
const base = (sid, extra = {}) => ({ isSidechain: false, userType: 'external', cwd: '/tmp/proj-a', sessionId: sid, gitBranch: 'main', version: '2.0.0', ...extra })
const user = (sid, text, ts, extra) => ({ type: 'user', ...base(sid, extra), timestamp: ts, uuid: 'u' + Math.random(), message: { role: 'user', content: text } })
const asst = (sid, blocks, ts, model = 'claude-test-1') => ({ type: 'assistant', ...base(sid), timestamp: ts, uuid: 'a' + Math.random(), message: { id: 'msg' + Math.random(), role: 'assistant', model, content: blocks, usage: { input_tokens: 1, output_tokens: 1 } } })
const result = (sid, toolId, content, ts, isError = false) => ({ type: 'user', ...base(sid), timestamp: ts, uuid: 'r' + Math.random(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }] } })
const BIG = 'line of output\n'.repeat(3000) // ~42 KB, well past the cap

writeFileSync(join(projA, ID.a + '.jsonl'), jl([
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T10:00:00Z', sessionId: ID.a, content: 'x' },
  user(ID.a, 'Please add a login page to the app', '2026-10-01T10:00:01Z'),
  { type: 'ai-title', aiTitle: 'Login page work', sessionId: ID.a },
  { type: 'attachment', ...base(ID.a), attachment: { type: 'hook_success' }, uuid: 'att1' },
  asst(ID.a, [{ type: 'thinking', thinking: 'secret thoughts', signature: 'sig' }], '2026-10-01T10:00:02Z'),
  asst(ID.a, [{ type: 'text', text: 'Let me look at the project.' }], '2026-10-01T10:00:03Z'),
  asst(ID.a, [{ type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'ls -la' } }], '2026-10-01T10:00:04Z'),
  result(ID.a, 'toolu_a1', BIG, '2026-10-01T10:00:05Z'),
  asst(ID.a, [{ type: 'tool_use', id: 'toolu_a2', name: 'Read', input: { file_path: '/tmp/proj-a/app.js' } }], '2026-10-01T10:00:06Z'),
  result(ID.a, 'toolu_a2', [{ type: 'text', text: 'const app = 1' }], '2026-10-01T10:00:07Z'),
  asst(ID.a, [{ type: 'text', text: 'I added the page.' }], '2026-10-01T10:00:08Z'),
  { ...user(ID.a, '<local-command-stdout>noise</local-command-stdout>', '2026-10-01T10:00:09Z') },
  { ...user(ID.a, 'meta wrapper', '2026-10-01T10:00:09Z', { isMeta: true }) },
  user(ID.a, 'Now make the button blue', '2026-10-01T10:01:00Z'),
  asst(ID.a, [{ type: 'tool_use', id: 'toolu_a3', name: 'Edit', input: { file_path: '/tmp/proj-a/app.css', old_string: 'a', new_string: 'b' } }], '2026-10-01T10:01:01Z'),
  result(ID.a, 'toolu_a3', 'The file was updated', '2026-10-01T10:01:02Z'),
  asst(ID.a, [{ type: 'text', text: 'Done, it is blue.' }], '2026-10-01T10:01:03Z'),
  { type: 'custom-title', customTitle: 'My login task', sessionId: ID.a },
  { type: 'last-prompt', lastPrompt: 'Now make the button blue', sessionId: ID.a }
]))
writeFileSync(join(projA, ID.b + '.jsonl'), jl([
  user(ID.b, 'Fix the flaky test in billing', '2026-10-02T10:00:00Z'),
  asst(ID.b, [{ type: 'text', text: 'Looking.' }], '2026-10-02T10:00:01Z', 'claude-test-2'),
  { type: 'ai-title', aiTitle: 'Billing test fix', sessionId: ID.b }
]))
writeFileSync(join(projB, ID.c + '.jsonl'), jl([
  user(ID.c, 'x'.repeat(200) + ' long first message', '2026-09-30T10:00:00Z', { cwd: '/tmp/proj-b', gitBranch: 'dev' }),
  asst(ID.c, [{ type: 'text', text: 'ok' }], '2026-09-30T10:00:01Z')
]))
writeFileSync(join(projB, ID.side + '.jsonl'), jl([ // a sub-agent's private transcript
  user(ID.side, 'sub-agent prompt that must not be listed', '2026-10-03T10:00:00Z', { isSidechain: true }),
  asst(ID.side, [{ type: 'text', text: 'x' }], '2026-10-03T10:00:01Z')
]))
writeFileSync(join(projB, ID.empty + '.jsonl'), jl([ // opened and abandoned: nothing was ever said
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-03T10:00:00Z', sessionId: ID.empty, content: 'x' },
  { type: 'attachment', ...base(ID.empty), attachment: { type: 'hook_success' }, uuid: 'att2' }
]))
writeFileSync(join(projB, ID.odd + '.jsonl'), jl([ // an id whose third group starts with 5, as real ones do
  user(ID.odd, 'An id with a five in it', '2026-09-29T10:00:00Z', { cwd: '/tmp/proj-b' })
]))
// a session outside the folder, linked in: must be invisible and unreadable
const outside = join(root, 'outside'); mkdirSync(outside)
writeFileSync(join(outside, ID.link + '.jsonl'), jl([user(ID.link, 'secret outside the folder', '2026-10-04T10:00:00Z')]))
symlinkSync(join(outside, ID.link + '.jsonl'), join(projA, ID.link + '.jsonl'))
symlinkSync(outside, join(CL, '-linked-dir'))
at(join(projA, ID.a + '.jsonl'), 3000); at(join(projA, ID.b + '.jsonl'), 1000); at(join(projB, ID.c + '.jsonl'), 9000); at(join(projB, ID.odd + '.jsonl'), 12000)
at(join(projB, ID.side + '.jsonl'), 100); at(join(projB, ID.empty + '.jsonl'), 100)

// ------------------------------------------------------------------ Codex fixtures
const CX = home + '/.codex/sessions/2026/10/15'; mkdirSync(CX, { recursive: true })
const CID = { main: '0198aaaa-1111-7111-8111-111111111111', sub: '0198aaaa-2222-7222-8222-222222222222', empty: '0198aaaa-3333-7333-8333-333333333333', big: '0198aaaa-4444-7444-8444-444444444444' }
const cmeta = (id, extra = {}) => ({ timestamp: '2026-10-15T10:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-10-15T10:00:00Z', cwd: '/tmp/proj-x', originator: 'codex_cli', cli_version: '0.1.0', source: 'cli', thread_source: 'user', base_instructions: { text: 'x'.repeat(5000) }, ...extra } })
const cmsg = (role, text, kinds, extra = {}) => ({ timestamp: '2026-10-15T10:00:01Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }], ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } : {}), ...extra } })
writeFileSync(join(CX, `rollout-2026-10-15T10-00-00-${CID.main}.jsonl`), jl([
  cmeta(CID.main),
  { timestamp: 't', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-test-1', cwd: '/tmp/proj-x' } } },
  cmsg('developer', 'developer instructions', ['generic.developer_instructions']),
  cmsg('user', '<environment_context>cwd</environment_context>', ['agents_md.instructions', 'environments.environment_context']),
  { timestamp: 't', type: 'world_state', payload: { state: { agents_md: { text: 'y'.repeat(3000) } } } },
  { timestamp: 't', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-test-1', cwd: '/tmp/proj-x' } },
  cmsg('user', 'Rename the config option to something clearer', ['user.text']),
  { timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage' } } },
  { timestamp: 't', type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'zzz' } },
  cmsg('assistant', 'I will search for it.', ['unknown'], { phase: 'commentary' }),
  { timestamp: 't', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'grep -rn option .' }), call_id: 'call_1' } },
  { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify({ output: 'src/a.js:1: option', metadata: { exit_code: 0 } }) } },
  { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_2', input: 'echo hi', status: 'completed' } },
  { timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: BIG }] } },
  { timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: {} } },
  cmsg('assistant', 'Renamed it everywhere.', ['unknown'], { phase: 'final_answer' }),
  cmsg('user', 'Thanks, now add a test', ['user.text']),
  cmsg('assistant', 'Added.', ['unknown'], { phase: 'final_answer' })
]))
writeFileSync(join(CX, `rollout-2026-10-15T11-00-00-${CID.sub}.jsonl`), jl([
  cmeta(CID.sub, { thread_source: 'subagent', source: { subagent: { thread_spawn: {} } } }),
  cmsg('user', 'sub-agent task that must not be listed', ['user.text'])
]))
writeFileSync(join(CX, `rollout-2026-10-15T12-00-00-${CID.empty}.jsonl`), jl([cmeta(CID.empty)]))
// 450 exchanges: more than the cap, so the import must say it kept only the end
const many = [cmeta(CID.big, { cwd: '/tmp/proj-big' })]
for (let i = 0; i < 450; i++) { many.push(cmsg('user', `question ${i}`, ['user.text'])); many.push(cmsg('assistant', `answer ${i}`, ['unknown'], { phase: 'final_answer' })) }
writeFileSync(join(CX, `rollout-2026-10-15T13-00-00-${CID.big}.jsonl`), jl(many))
at(join(CX, `rollout-2026-10-15T10-00-00-${CID.main}.jsonl`), 500)
at(join(CX, `rollout-2026-10-15T13-00-00-${CID.big}.jsonl`), 2000)

// ================================================================== Part 1: the readers
process.env.HOME = home
delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME
const { listCliSessions, readCliSession, validCliId } = await import('../server/cli-agents.js')

{
  const all = await listCliSessions({ limit: 50 })
  const ids = all.map(s => s.id)
  ok('list: both tools are listed, newest first', all.length === 6 && all.every((s, i) => i === 0 || all[i - 1].updatedAt >= s.updatedAt), `${all.length}: ${all.map(s => s.tool + ':' + s.title).join(' | ')}`)
  ok('list: the order is by last change', ids.join() === [CID.main, ID.b, CID.big, ID.a, ID.c, ID.odd].join(), ids.join())
  ok('list: sidechains, sub-agent threads, empty sessions and links are all left out', ![ID.side, ID.empty, ID.link, CID.sub, CID.empty].some(x => ids.includes(x)))
  const byId = Object.fromEntries(all.map(s => [s.id, s]))
  ok('list: a custom title beats an AI title beats the first message', byId[ID.a].title === 'My login task' && byId[ID.b].title === 'Billing test fix')
  ok('list: with no titles, the first real message, trimmed to 80', byId[ID.c].title.length === 80 && byId[ID.c].title.startsWith('xxxx'))
  ok('list: a Codex title is the first thing the person typed, not the injected context', byId[CID.main].title === 'Rename the config option to something clearer', byId[CID.main].title)
  ok('list: cwd, branch and model come through', byId[ID.a].cwd === '/tmp/proj-a' && byId[ID.a].gitBranch === 'main' && byId[ID.a].model === 'claude-test-1' && byId[CID.main].cwd === '/tmp/proj-x' && byId[CID.main].model === 'gpt-test-1')
  ok('list: summaries carry size and a message count', byId[ID.a].sizeBytes > 500 && byId[ID.a].messageCount === 5 && byId[CID.main].messageCount === 5, `${byId[ID.a].messageCount} ${byId[CID.main].messageCount}`)
  ok('list: startedAt and updatedAt are ISO dates', /^2026-10-01T10:00:0/.test(byId[ID.a].startedAt) && !Number.isNaN(Date.parse(byId[ID.a].updatedAt)))
  ok('list: every row has the same fields', all.every(s => ['tool', 'id', 'cwd', 'title', 'gitBranch', 'model', 'startedAt', 'updatedAt', 'messageCount', 'sizeBytes'].every(k => k in s)))
  ok('list: nothing from inside a conversation leaks into a summary', !JSON.stringify(all).includes('secret thoughts') && !JSON.stringify(all).includes('secret outside the folder'))

  const onlyClaude = await listCliSessions({ tool: 'claude-code' })
  ok('list: the tool filter', onlyClaude.length === 4 && onlyClaude.every(s => s.tool === 'claude-code'))
  ok('list: the limit', (await listCliSessions({ limit: 2 })).length === 2)
  ok('list: a search matches title or folder', (await listCliSessions({ q: 'BILLING' })).map(s => s.id).join() === ID.b && (await listCliSessions({ q: 'proj-b' })).length === 3)
  ok('list: "since" drops older sessions', (await listCliSessions({ since: new Date(Date.now() - 1500 * 1000).toISOString() })).length === 2)
  const again = await listCliSessions({ limit: 50 })
  ok('list: a second call (from the cache) gives the same answer', JSON.stringify(again) === JSON.stringify(all))
}

{
  const t = await readCliSession({ tool: 'claude-code', id: ID.a })
  const m = t.messages
  ok('read claude: user and assistant turns alternate, one assistant message per turn', m.map(x => x.role).join() === 'user,assistant,user,assistant', m.map(x => x.role).join())
  ok('read claude: noise (local-command output, meta, attachments, thinking) is dropped', !JSON.stringify(m).includes('noise') && !JSON.stringify(m).includes('meta wrapper') && !JSON.stringify(m).includes('secret thoughts'))
  ok('read claude: the prompts are the person\'s words', m[0].text === 'Please add a login page to the app' && m[2].text === 'Now make the button blue')
  const a = m[1].parts
  ok('read claude: consecutive assistant records are merged', a.map(p => p.type + ':' + (p.name || '')).join() === 'text:,tool:run_command,tool:read_file,text:', a.map(p => p.type + ':' + (p.name || '')).join())
  ok('read claude: a tool call is paired with its result', a[2].result === 'const app = 1' && a[2].args.path === '/tmp/proj-a/app.js')
  ok('read claude: a huge result is cut down and says so', a[1].result.length < 9000 && a[1].truncated > 30000, `${a[1].result.length} ${a[1].truncated}`)
  ok('read claude: the head and the tail of a cut result both survive', a[1].result.startsWith('line of output') && a[1].result.endsWith('line of output\n'.slice(0, -1)) || a[1].result.trimEnd().endsWith('line of output'))
  ok('read claude: an edit becomes edit_file', m[3].parts[0].name === 'edit_file' && m[3].parts[0].result === 'The file was updated')
  ok('read claude: the assistant message knows its model', m[1].model === 'claude-test-1')
  ok('read claude: metadata', t.cwd === '/tmp/proj-a' && t.title === 'My login task' && t.gitBranch === 'main' && t.truncated === false)

  const c = await readCliSession({ tool: 'codex', id: CID.main })
  const cm = c.messages
  ok('read codex: only the person\'s own words are user messages', cm.filter(x => x.role === 'user').map(x => x.text).join('|') === 'Rename the config option to something clearer|Thanks, now add a test', cm.filter(x => x.role === 'user').map(x => x.text).join('|'))
  ok('read codex: roles alternate', cm.map(x => x.role).join() === 'user,assistant,user,assistant')
  const cp = cm[1].parts
  ok('read codex: text, commands and results in order', cp.map(p => p.type + ':' + (p.name || '')).join() === 'text:,tool:run_command,tool:run_command,text:', cp.map(p => p.type + ':' + (p.name || '')).join())
  ok('read codex: a function call is paired with its (JSON-wrapped) output', cp[1].args.command === 'grep -rn option .' && cp[1].result === 'src/a.js:1: option')
  ok('read codex: a custom tool call and a huge output are paired and cut', cp[2].args.command === 'echo hi' && cp[2].truncated > 30000 && cp[2].result.length < 9000)
  ok('read codex: no reasoning, no developer text, no token records', !JSON.stringify(cm).includes('developer instructions') && !JSON.stringify(cm).includes('zzz') && !JSON.stringify(cm).includes('<environment_context>'))
  ok('read codex: metadata', c.cwd === '/tmp/proj-x' && c.model === 'gpt-test-1' && cm[1].model === 'gpt-test-1')

  const big = await readCliSession({ tool: 'codex', id: CID.big })
  ok('read: a long session keeps the last 400 messages and says it cut the rest', big.messages.length === 400 && big.truncated === true && big.totalMessages === 900, `${big.messages.length} ${big.totalMessages}`)
  ok('read: the kept part starts with a person speaking and ends at the end', big.messages[0].role === 'user' && big.messages.at(-1).parts[0].text === 'answer 449' && big.messages[0].text === 'question 250', big.messages[0].text)
}

{
  const refuses = async (label, tool, id) => { try { await readCliSession({ tool, id }); ok(label, false, 'did not throw') } catch (e) { ok(label, true) ; return e.message } }
  await refuses('path: ../ in an id is refused', 'claude-code', '../../../../etc/passwd')
  await refuses('path: an encoded traversal is refused', 'claude-code', '..%2f..%2fsecret')
  await refuses('path: a slash in a Codex id is refused', 'codex', '../' + CID.main)
  await refuses('path: a Codex id that is not a uuid is refused', 'codex', 'rollout-2026-10-15T10-00-00')
  await refuses('path: a null byte is refused', 'claude-code', ID.a + '\0.jsonl')
  await refuses('path: an unknown tool is refused', 'bash', ID.a)
  const miss = await refuses('path: a well-formed id that does not exist is "not found"', 'claude-code', '99999999-9999-4999-8999-999999999999')
  ok('path: and says so plainly', /not found/.test(miss || ''))
  await refuses('symlink: a session file linked in from outside is not readable', 'claude-code', ID.link)
  ok('ids: the shapes accepted', validCliId('claude-code', ID.odd) && validCliId('codex', CID.main) && !validCliId('codex', ID.a.slice(0, 20)) && !validCliId('claude-code', 'abc') && !validCliId('claude-code', 5))
}

// ================================================================== Part 2: the routes
const PORT = 5861
const fakeBin = join(root, 'bin'); mkdirSync(fakeBin)
for (const [name, ver] of [['claude', '9.9.9 (Claude Code)'], ['codex', 'codex-cli 9.9.9']]) {
  writeFileSync(join(fakeBin, name), `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log(${JSON.stringify(ver)})\nelse if (process.argv.includes('--help')) console.log("  --model <model>  alias for the latest model (e.g. 'opus' or 'sonnet')")\n`)
  chmodSync(join(fakeBin, name), 0o755)
}
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOME: home, RADIANT_PORT: String(PORT), RADIANT_DIR: '', RADIANT_TOKEN: 'test-token-123', CLAUDE_BIN: join(fakeBin, 'claude'), CODEX_BIN: join(fakeBin, 'codex') },
  stdio: 'ignore'
})
const stopServer = () => { try { server.kill() } catch {} }
process.on('exit', stopServer)
const B = `http://127.0.0.1:${PORT}`
let up = false
for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(B + '/api/version')).ok } catch {} ; if (!up) await sleep(250) }
if (!up) { console.log('  the test server never came up'); stopServer(); process.exit(1) }

// A request from this Mac's own process, and one that came through a proxy
// (a phone over Tailscale): the same address, but not "local", so it needs the token.
const REMOTE = { 'x-forwarded-for': '100.64.1.2', 'x-radiant-token': 'test-token-123' }
const call = async (m, p, b, headers = {}) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: b ? JSON.stringify(b) : undefined })
  return { status: r.status, body: await r.json().catch(() => null) }
}

{
  // off by default
  const d1 = await call('GET', '/api/cli-sessions')
  ok('routes: listing is refused until the person turns it on', d1.status === 403 && /turned off/.test(d1.body?.error) && d1.body.code === 'cli-agents-disabled', JSON.stringify(d1))
  const d2 = await call('POST', '/api/cli-sessions/import', { tool: 'claude-code', id: ID.a })
  ok('routes: importing is refused too', d2.status === 403)
  const info0 = await call('GET', '/api/cli-agents')
  ok('routes: the tools list says what is installed and that the feature is off', info0.status === 200 && info0.body.enabled === false && info0.body.usable === false && info0.body.agents.every(a => a.available && a.version === '9.9.9') && info0.body.providers.length === 0, JSON.stringify(info0.body))
  ok('routes: the shared config says off by default', (await call('GET', '/api/config')).body.settings.cliAgents.enabled === false)

  // a device on the network cannot switch it on
  const sneaky = await call('PUT', '/api/settings', { cliAgents: { enabled: true, allowRemote: true } }, REMOTE)
  ok('routes: a remote device cannot turn the feature on', sneaky.status === 200 && sneaky.body.settings.cliAgents.enabled === false, JSON.stringify(sneaky.body?.settings?.cliAgents))

  // the Mac turns it on
  const on = await call('PUT', '/api/settings', { cliAgents: { enabled: true } })
  ok('routes: the Mac can turn it on, and allowRemote stays off', on.body.settings.cliAgents.enabled === true && on.body.settings.cliAgents.allowRemote === false)
  const junk = await call('PUT', '/api/settings', { cliAgents: { enabled: 'yes', allowRemote: 1 } })
  ok('routes: only a real true counts', junk.body.settings.cliAgents.enabled === true /* unchanged */ && junk.body.settings.cliAgents.allowRemote === false)
  ok('routes: the machine file has it, the synced config does not', /"enabled": true/.test(readFileSync(join(home, '.radiant-machine.json'), 'utf8')) && !(existsSync(join(home, '.radiant', 'config.json')) && /cliAgents/.test(readFileSync(join(home, '.radiant', 'config.json'), 'utf8'))))

  const list = await call('GET', '/api/cli-sessions')
  ok('routes: listing works once on', list.status === 200 && list.body.sessions.length === 6 && list.body.sessions.every(s => s.imported === false && s.radiantId === null), JSON.stringify(list.body).slice(0, 200))
  ok('routes: the filters work', (await call('GET', '/api/cli-sessions?tool=codex')).body.sessions.length === 2 && (await call('GET', '/api/cli-sessions?q=billing')).body.sessions.length === 1 && (await call('GET', '/api/cli-sessions?limit=1')).body.sessions.length === 1)
  ok('routes: a bad tool is a 400', (await call('GET', '/api/cli-sessions?tool=rm')).status === 400)

  // another device: refused until allowed
  const rem = await call('GET', '/api/cli-sessions', null, REMOTE)
  ok('routes: another device is refused even when the feature is on', rem.status === 403 && rem.body.code === 'cli-agents-remote' && /keeps its Claude Code and Codex sessions to itself/.test(rem.body.error), JSON.stringify(rem))
  ok('routes: and cannot import', (await call('POST', '/api/cli-sessions/import', { tool: 'claude-code', id: ID.a }, REMOTE)).status === 403)
  ok('routes: and is told, not shown, the models', (await call('GET', '/api/models', null, REMOTE)).body.every(m => !m.cli))
  ok('routes: nobody gets in without the token either', (await call('GET', '/api/cli-sessions', null, { 'x-forwarded-for': '100.64.1.2' })).status === 401)
  await call('PUT', '/api/settings', { cliAgents: { allowRemote: true } })
  const rem2 = await call('GET', '/api/cli-sessions', null, REMOTE)
  ok('routes: once the Mac allows it, the other device can list', rem2.status === 200 && rem2.body.sessions.length === 6)
  await call('PUT', '/api/settings', { cliAgents: { allowRemote: false } })
  ok('routes: and turning it off again closes it', (await call('GET', '/api/cli-sessions', null, REMOTE)).status === 403)

  // import
  const bad = await call('POST', '/api/cli-sessions/import', { tool: 'claude-code', id: '../../etc/passwd' })
  ok('import: a traversal id is a 400, not a read', bad.status === 400 && !JSON.stringify(bad.body).includes('root:'), JSON.stringify(bad))
  ok('import: a linked-in session is not found', (await call('POST', '/api/cli-sessions/import', { tool: 'claude-code', id: ID.link })).status === 404)
  ok('import: a made-up tool is a 400', (await call('POST', '/api/cli-sessions/import', { tool: 'zsh', id: ID.a })).status === 400)
  ok('import: a missing session is a 404', (await call('POST', '/api/cli-sessions/import', { tool: 'codex', id: '0198aaaa-9999-7999-8999-999999999999' })).status === 404)

  const imp = await call('POST', '/api/cli-sessions/import', { tool: 'claude-code', id: ID.a })
  const s = imp.body
  ok('import: creates a chat with the title, folder, messages and the CLI id', imp.status === 200 && s.title === 'My login task' && s.cwd === '/tmp/proj-a' && s.messages.length === 4 && s.cli.id === ID.a && s.cli.tool === 'claude-code', JSON.stringify(s).slice(0, 300))
  ok('import: the chat runs through the tool', s.provider === 'claude-code' && s.model === 'claude-test-1' && s.autoTitle === false)
  const stored = await call('GET', '/api/sessions/' + s.id)
  ok('import: it is saved like any chat', stored.status === 200 && stored.body.messages.length === 4)
  const imp2 = await call('POST', '/api/cli-sessions/import', { tool: 'claude-code', id: ID.a })
  ok('import: doing it twice returns the same chat', imp2.body.id === s.id)
  const sidebar = (await call('GET', '/api/sessions')).body
  ok('import: the sidebar shows exactly one, tagged with its CLI id', sidebar.filter(x => x.cli?.id === ID.a).length === 1)
  const after = await call('GET', '/api/cli-sessions')
  const row = after.body.sessions.find(x => x.id === ID.a)
  ok('list: the imported one is marked, with the Radiant chat id', row.imported === true && row.radiantId === s.id, JSON.stringify(row))
  ok('list: the others are not', after.body.sessions.filter(x => x.imported).length === 1)

  const cimp = await call('POST', '/api/cli-sessions/import', { tool: 'codex', id: CID.big })
  ok('import: a long session says it was cut', cimp.status === 200 && cimp.body.messages.length === 400 && cimp.body.cliImport.truncated === true && cimp.body.cliImport.total === 900, JSON.stringify(cimp.body.cliImport))
  ok('import: a Codex chat has its provider', cimp.body.provider === 'codex' && cimp.body.cwd === '/tmp/proj-big')

  // the model menu stays clean until asked: sessions work, models are absent
  ok('models: not listed while "show in the model menu" is off, though sessions work', (await call('GET', '/api/models')).body.every(m => !m.cli))
  await call('PUT', '/api/settings', { cliAgents: { showModels: true } })
  const models = (await call('GET', '/api/models')).body
  ok('models: offered once on and installed', models.some(m => m.provider === 'claude-code' && m.cli === true && m.id === 'sonnet') && models.some(m => m.provider === 'codex' && m.providerName === 'Codex (subscription)'))
  await call('PUT', '/api/settings', { cliAgents: { showModels: false } })
  ok('models: gone again when the menu switch is turned off', (await call('GET', '/api/models')).body.every(m => !m.cli))
  await call('PUT', '/api/settings', { cliAgents: { showModels: true } })
  await call('PUT', '/api/settings', { cliAgents: { enabled: false } })
  ok('models: and gone again when turned off', (await call('GET', '/api/models')).body.every(m => !m.cli))
  ok('listing is refused again once turned off', (await call('GET', '/api/cli-sessions')).status === 403)
}

stopServer()
try { rmSync(root, { recursive: true, force: true }) } catch {}
console.log(`cli sessions: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
