// Running a chat turn through Claude Code and Codex, against fake `claude` and
// `codex` programs that print what the real ones print.
//
// Part 1 drives runCliTurn directly: the events it emits, the parts it keeps, the
// resume id, a failing exit, a program that goes quiet, and Stop killing the
// process. Part 2 drives a real Radiant server (own port, own HOME, never 5834)
// through POST /api/chat, so the whole path from the browser's request to the
// saved chat is exercised, including the settings gate.
//
// The real tools are never run here. scripts/test-cli-run.mjs is safe to run
// any time, offline, on any machine.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'radiant-cli-run-'))
const bin = join(root, 'bin'); mkdirSync(bin)
let pass = 0, fail = 0
const ok = (n, c, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${extra}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(25) } return false }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

// ---------------------------------------------------------------------------
// The fake tool. One file, installed twice; its name says which tool it plays.
// The scenario is named in the prompt ("scenario:fail"), which it reads from
// stdin exactly as the real ones do. It records what it was asked in args.json
// in its working directory.
// ---------------------------------------------------------------------------
const FAKE = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
const out = o => process.stdout.write(JSON.stringify(o) + '\n')
if (args.includes('--version')) { console.log(tool === 'claude' ? '9.9.9 (Claude Code)' : 'codex-cli 9.9.9'); process.exit(0) }
if (args.includes('--help')) { console.log("  --model <model>  Model. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')\n  --permission-prompts <target>  Who answers permission prompts"); process.exit(0) }
let input = ''
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  const scenario = (/scenario:(\w+)/.exec(input) || [])[1] || 'ok'
  const leaked = Object.keys(process.env).filter(k => /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_TEST)$/.test(k))
  fs.writeFileSync('args.json', JSON.stringify({ args, prompt: input, pid: process.pid, leaked }))
  const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const sleepForever = () => setInterval(() => {}, 1000)
  if (scenario === 'sleep' || scenario === 'stubborn') {
    if (scenario === 'stubborn') process.on('SIGTERM', () => fs.writeFileSync('term.txt', 'ignored'))
    else process.on('SIGTERM', () => { fs.writeFileSync('term.txt', 'got it'); process.exit(0) })
    fs.writeFileSync('ready.txt', '1')
    if (tool === 'claude') out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-fake-1' })
    else out({ type: 'thread.started', thread_id: '0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })
    return sleepForever()
  }
  if (scenario === 'partial' && tool === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-fake-1' })
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'mp', role: 'assistant' } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an ans' } } })
    process.on('SIGTERM', () => process.exit(0))
    fs.writeFileSync('ready.txt', '1')
    return sleepForever()
  }
  if (scenario === 'hang') { if (tool === 'claude') out({ type: 'system', subtype: 'init', session_id: SID }); return sleepForever() }
  if (scenario === 'fail') { console.error('boom: the tool exploded\nsecond line'); process.exit(2) }
  if (scenario === 'gone') { console.error('Error: thread/resume: thread/resume failed: no rollout found for thread id 0198 (code -32600)'); process.exit(1) }

  if (tool === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-fake-1', permissionMode: 'plan' })
    if (scenario === 'authfail') {
      out({ type: 'assistant', is_api_error_message: true, message: { id: 'e1', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] } })
      out({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired', session_id: SID, usage: { input_tokens: 0, output_tokens: 0 } })
      process.exit(1)
    }
    // message 1: live text, then a Read and a Bash call (the Bash one is refused)
    if (scenario !== 'nostream') {
      out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', role: 'assistant' } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: "I'll " } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'look.' } } })
    }
    const usage1 = { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 }
    out({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'text', text: "I'll look." }], usage: usage1 } })
    out({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/a.txt' } }], usage: usage1 } })
    out({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }], usage: usage1 } })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }] } })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: "Claude requested permissions to use Bash, but you haven't granted it yet.", is_error: true }] } })
    // a sub-agent's inner chatter must not appear
    out({ type: 'assistant', parent_tool_use_id: 'toolu_9', message: { id: 'sub', role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT SECRET' }] } })
    // message 2: the answer
    if (scenario !== 'nostream') {
      out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', role: 'assistant' } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done: ok.' } } })
    }
    out({ type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-fake-1', content: [{ type: 'text', text: 'Done: ok.' }], usage: { input_tokens: 4, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 9 } } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Done: ok.', session_id: SID, total_cost_usd: 0.01, permission_denials: [{ tool_name: 'Bash' }], usage: { input_tokens: 7, cache_read_input_tokens: 300, cache_creation_input_tokens: 5, output_tokens: 16 } })
    return
  }
  // codex
  out({ type: 'thread.started', thread_id: '0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })
  out({ type: 'item.completed', item: { id: 'item_w', type: 'error', message: 'Under-development features enabled: chronicle. To suppress this warning...' } })
  out({ type: 'turn.started' })
  if (scenario === 'codexfail') {
    out({ type: 'error', message: 'Reconnecting... 1/5' })
    out({ type: 'turn.failed', error: { message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-x' model is not supported when using Codex with a ChatGPT account." } }) } })
    process.exit(1)
  }
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls -la', aggregated_output: '', exit_code: null, status: 'in_progress' } })
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls -la', aggregated_output: 'a.txt', exit_code: 0, status: 'completed' } })
  out({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } })
  out({ type: 'item.completed', item: { id: 'item_3', type: 'file_change', changes: [{ path: '/x/b.txt', kind: 'update' }], status: 'completed' } })
  out({ type: 'item.completed', item: { id: 'item_4', type: 'reasoning', text: 'thinking about it' } })
  out({ type: 'item.completed', item: { id: 'item_5', type: 'agent_message', text: 'All done.' } })
  out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 } })
})
`
for (const name of ['claude', 'codex']) { writeFileSync(join(bin, name), FAKE); chmodSync(join(bin, name), 0o755) }
process.env.CLAUDE_BIN = join(bin, 'claude')
process.env.CODEX_BIN = join(bin, 'codex')
process.env.RADIANT_CLI_IDLE_MS = '600'
process.env.RADIANT_CLI_KILL_MS = '400'
// things the child must never inherit (an API key would switch a subscription tool to metered billing)
process.env.ANTHROPIC_API_KEY = 'sk-test-not-real'
process.env.OPENAI_API_KEY = 'sk-test-not-real'
process.env.CLAUDE_CODE_TEST = '1'

const { runCliTurn, cliPermissionFor, detectCliAgents, cliModelsFor } = await import('../server/cli-agents.js')

const work = () => { const d = mkdtempSync(join(root, 'w-')); return d }
const argsOf = d => JSON.parse(readFileSync(join(d, 'args.json'), 'utf8'))
const run = async (o) => { const events = []; const r = await runCliTurn({ emit: e => events.push(e), ...o }); return { r, events, types: events.map(e => e.type) } }

// ---------------------------------------------------------------- detection
{
  const a = await detectCliAgents({ fresh: true })
  const c = a.find(x => x.id === 'claude-code'), x = a.find(y => y.id === 'codex')
  ok('detect finds the claude fake', c?.available && c.version === '9.9.9', JSON.stringify(c))
  ok('detect finds the codex fake', x?.available && x.version === '9.9.9', JSON.stringify(x))
  const m = await cliModelsFor('claude-code')
  ok('models: default plus the aliases the tool lists', m[0].id === 'default' && ['opus', 'sonnet', 'haiku', 'fable'].every(id => m.some(y => y.id === id)), JSON.stringify(m))
}

// ---------------------------------------------------------------- permission mapping
ok('claude: Ask each is read-only plan mode', cliPermissionFor('claude-code', 'ask') === 'plan')
ok('claude: Auto approve accepts edits', cliPermissionFor('claude-code', 'auto') === 'acceptEdits')
ok('claude: Allow all bypasses', cliPermissionFor('claude-code', 'off') === 'bypassPermissions')
ok('claude: an unknown setting is the safe one', cliPermissionFor('claude-code', undefined) === 'plan' && cliPermissionFor('claude-code', 'yolo') === 'plan')
ok('codex: ask / auto / off', cliPermissionFor('codex', 'ask') === 'read-only' && cliPermissionFor('codex', 'auto') === 'workspace-write' && cliPermissionFor('codex', 'off') === 'danger-full-access')

// ---------------------------------------------------------------- claude: a full turn
{
  const cwd = work()
  const { r, events, types } = await run({ tool: 'claude-code', text: 'scenario:ok please look', cwd, model: 'sonnet', permissionMode: 'ask', effort: 'high' })
  ok('claude: no error', r.error === null, r.error)
  ok('claude: the id to resume is kept', r.cliSessionId === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', r.cliSessionId)
  ok('claude: the model the tool used is reported', r.model === 'claude-fake-1')
  const streamed = events.filter(e => e.type === 'text_delta').map(e => e.text).join('')
  ok('claude: text streamed live, once (no repeat from the final message)', streamed === "I'll look.Done: ok.", JSON.stringify(streamed))
  ok('claude: thinking is passed on live', events.some(e => e.type === 'thinking_delta' && e.text === 'hmm '))
  ok('claude: a sub-agent\'s inner text is not shown', !JSON.stringify(events).includes('SUBAGENT SECRET') && !JSON.stringify(r.parts).includes('SUBAGENT SECRET'))
  const tools = r.parts.filter(p => p.type === 'tool')
  ok('claude: two tool parts, named the way Radiant names them', tools.length === 2 && tools[0].name === 'read_file' && tools[0].args.path === '/x/a.txt' && tools[1].name === 'run_command' && tools[1].args.command === 'ls', JSON.stringify(tools))
  ok('claude: a tool result is filled in', tools[0].result === 'file contents')
  ok('claude: a refused tool is marked denied', tools[1].denied === true)
  ok('claude: tool_start precedes its tool_result', types.indexOf('tool_start') < types.indexOf('tool_result'))
  ok('claude: parts are text, tool, tool, text, notice in order', r.parts.map(p => p.type).join() === 'text,tool,tool,text,notice', r.parts.map(p => p.type).join())
  ok('claude: refusals are explained in the chat', r.parts.at(-1).type === 'notice' && /Bash/.test(r.parts.at(-1).text) && /Ask each/.test(r.parts.at(-1).text))
  ok('claude: usage totals include cache reads and writes', r.usage.input === 312 && r.usage.output === 16 && r.usage.cacheRead === 300 && r.usage.cacheWrite === 5, JSON.stringify(r.usage))
  const u = events.find(e => e.type === 'usage')
  ok('claude: one usage event, sized for the context gauge (last prompt)', events.filter(e => e.type === 'usage').length === 1 && u.input === 204 && u.output === 16 && u.cacheRead === 300, JSON.stringify(u))
  const a = argsOf(cwd)
  ok('claude: runs headless with streaming JSON', ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'].every(f => a.args.includes(f)), a.args.join(' '))
  ok('claude: Ask each means plan mode, and prompts are declined not awaited', a.args[a.args.indexOf('--permission-mode') + 1] === 'plan' && a.args.includes('--permission-prompts'))
  ok('claude: the model and effort are passed', a.args[a.args.indexOf('--model') + 1] === 'sonnet' && a.args[a.args.indexOf('--effort') + 1] === 'high')
  ok('claude: a first turn does not resume', !a.args.includes('--resume'))
  ok('claude: the prompt arrives on stdin, not argv', a.prompt.includes('please look') && !a.args.some(x => x.includes('please look')))
  ok('claude: API keys and a parent session\'s variables are not inherited', a.leaked.length === 0, JSON.stringify(a.leaked))

  // the next message resumes the same conversation, and Allow all is asked for
  const cont = await run({ tool: 'claude-code', text: 'scenario:ok again', cwd, resumeId: r.cliSessionId, permissionMode: 'off' })
  const b = argsOf(cwd)
  ok('claude: the next turn resumes with the stored id', b.args[b.args.indexOf('--resume') + 1] === r.cliSessionId, b.args.join(' '))
  ok('claude: Allow all bypasses permissions', b.args[b.args.indexOf('--permission-mode') + 1] === 'bypassPermissions')
  ok('claude: a resumed turn runs cleanly', cont.r.error === null)
  const auto = await run({ tool: 'claude-code', text: 'scenario:ok', cwd, permissionMode: 'auto', model: 'default' })
  const c2 = argsOf(cwd)
  ok('claude: Auto approve accepts edits; "default" passes no --model', c2.args[c2.args.indexOf('--permission-mode') + 1] === 'acceptEdits' && !c2.args.includes('--model') && auto.r.error === null)
  const bad = await run({ tool: 'claude-code', text: 'scenario:ok', cwd, model: '--dangerously-skip-permissions' })
  ok('claude: a model name cannot smuggle in a flag', !argsOf(cwd).args.includes('--dangerously-skip-permissions') && bad.r.error === null)
}

// an older tool that sends only whole messages still shows its text
{
  const { r, events } = await run({ tool: 'claude-code', text: 'scenario:nostream', cwd: work() })
  ok('claude (no partial messages): the full text is emitted once', events.filter(e => e.type === 'text_delta').map(e => e.text).join('') === "I'll look.Done: ok.", JSON.stringify(events.filter(e => e.type === 'text_delta')))
  ok('claude (no partial messages): parts are the same', r.parts.filter(p => p.type === 'text').length === 2)
}

// ---------------------------------------------------------------- failures are sentences
{
  const f = await run({ tool: 'claude-code', text: 'scenario:fail', cwd: work() })
  ok('failure: a non-zero exit becomes a readable error', /Claude Code stopped with an error/.test(f.r.error) && /boom: the tool exploded/.test(f.r.error), f.r.error)
  ok('failure: nothing is thrown, no parts invented', f.r.parts.length === 0 && f.r.exitCode === 2)
  const a = await run({ tool: 'claude-code', text: 'scenario:authfail', cwd: work() })
  ok('failure: an expired login says how to sign in again', /not signed in/.test(a.r.error) && /claude/.test(a.r.error), a.r.error)
  ok('failure: the API error text is not kept as if it were a reply', !a.r.parts.some(p => p.type === 'text'), JSON.stringify(a.r.parts))
  const gone = await run({ tool: 'codex', text: 'scenario:gone', cwd: work(), resumeId: '0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })
  ok('failure: a conversation the tool no longer has is explained', /could not find that conversation/.test(gone.r.error), gone.r.error)
  const cx = await run({ tool: 'codex', text: 'scenario:codexfail', cwd: work() })
  ok('failure: codex turn.failed carries the real reason, unwrapped', /model is not supported/.test(cx.r.error) && !/"type":"error"/.test(cx.r.error) && /model picker/.test(cx.r.error), cx.r.error)
  ok('failure: codex "Reconnecting" is a notice, not the end', cx.events.some(e => e.type === 'notice' && /Reconnecting/.test(e.text)))
  const lost = await run({ tool: 'claude-code', text: 'x', cwd: join(root, 'no-such-folder'), resumeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
  ok('a resumed chat whose folder is gone says so', /not on this Mac/.test(lost.r.error), lost.r.error)
}

// ---------------------------------------------------------------- codex: a full turn
{
  const cwd = work()
  const { r, events, types } = await run({ tool: 'codex', text: 'scenario:ok', cwd, model: 'gpt-test', permissionMode: 'auto', effort: 'low' })
  ok('codex: no error', r.error === null, r.error)
  ok('codex: the thread id is kept to resume', r.cliSessionId === '0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')
  ok('codex: parts are tool, tool, tool, text', r.parts.map(p => p.type + ':' + (p.name || '')).join() === 'tool:run_command,tool:run_command,tool:edit_file,text:', r.parts.map(p => p.type + ':' + (p.name || '')).join())
  ok('codex: a command result is filled in, a failing one is marked', r.parts[0].result === 'a.txt' && r.parts[1].error === true && /exit code 1/.test(r.parts[1].result))
  ok('codex: a file change names the file', r.parts[2].args.path === '/x/b.txt' && /b\.txt/.test(r.parts[2].result))
  ok('codex: reasoning is shown live', events.some(e => e.type === 'thinking_delta'))
  ok('codex: the tool\'s own config warning is not shown as a notice', !events.some(e => e.type === 'notice'))
  ok('codex: a command is announced before its result', types.indexOf('tool_start') < types.indexOf('tool_result'))
  ok('codex: usage is the prompt size with the cached part split out', r.usage.input === 1000 && r.usage.cacheRead === 400 && r.usage.output === 50, JSON.stringify(r.usage))
  const a = argsOf(cwd)
  ok('codex: exec --json with the sandbox for Auto approve and never asking', a.args[0] === 'exec' && a.args.includes('--json') && a.args.includes('sandbox_mode="workspace-write"') && a.args.includes('approval_policy="never"'), a.args.join(' '))
  ok('codex: model and effort are passed', a.args[a.args.indexOf('-m') + 1] === 'gpt-test' && a.args.includes('model_reasoning_effort="low"'))
  ok('codex: the prompt is read from stdin', a.args.at(-1) === '-' && a.prompt.includes('scenario:ok'))
  ok('codex: no keys inherited', a.leaked.length === 0, JSON.stringify(a.leaked))
  await run({ tool: 'codex', text: 'scenario:ok', cwd, resumeId: r.cliSessionId, permissionMode: 'ask' })
  const b = argsOf(cwd)
  const at = b.args.indexOf('resume')
  ok('codex: the next turn is `exec ... resume <id> -`', at > 0 && b.args[at + 1] === r.cliSessionId && b.args.at(-1) === '-' && b.args.indexOf('--json') < at, b.args.join(' '))
  ok('codex: Ask each is a read-only sandbox, also on resume', b.args.includes('sandbox_mode="read-only"'))
  await run({ tool: 'codex', text: 'scenario:ok', cwd, permissionMode: 'off' })
  ok('codex: Allow all is the full-access sandbox', argsOf(cwd).args.includes('sandbox_mode="danger-full-access"'))
}

// ---------------------------------------------------------------- a program that goes quiet
{
  const cwd = work()
  const t0 = Date.now()
  const { r, events } = await run({ tool: 'claude-code', text: 'scenario:hang', cwd })
  ok('idle: ends on its own after the quiet period', r.timedOut === true && Date.now() - t0 < 5000, `${Date.now() - t0} ms`)
  ok('idle: says so in words', /went quiet/.test(r.error) && /Send another message/.test(r.error), r.error)
  ok('idle: the child is gone', !alive(argsOf(cwd).pid))
  ok('idle: the session id it had announced is still kept', r.cliSessionId === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  void events
}

// ---------------------------------------------------------------- Stop
for (const tool of ['claude-code', 'codex']) {
  const cwd = work()
  const ac = new AbortController()
  const p = run({ tool, text: 'scenario:sleep', cwd, signal: ac.signal })
  ok(`stop (${tool}): the tool started`, await waitFor(() => existsSync(join(cwd, 'ready.txt'))))
  const pid = argsOf(cwd).pid
  ok(`stop (${tool}): it is running`, alive(pid))
  ac.abort()
  const { r } = await p
  ok(`stop (${tool}): reports aborted, not an error`, r.aborted === true && r.error === null, JSON.stringify({ a: r.aborted, e: r.error }))
  ok(`stop (${tool}): the tool was sent SIGTERM and exited`, existsSync(join(cwd, 'term.txt')) && readFileSync(join(cwd, 'term.txt'), 'utf8') === 'got it')
  ok(`stop (${tool}): the process is dead`, await waitFor(() => !alive(pid), 2000))
}
{
  // a tool that ignores SIGTERM is killed anyway after the grace period
  const cwd = work()
  const ac = new AbortController()
  const t0 = Date.now()
  const p = run({ tool: 'claude-code', text: 'scenario:stubborn', cwd, signal: ac.signal })
  await waitFor(() => existsSync(join(cwd, 'ready.txt')))
  const pid = argsOf(cwd).pid
  ac.abort()
  const { r } = await p
  ok('stop: a tool that ignores SIGTERM is killed (SIGKILL) after the grace period', r.aborted && !alive(pid) && Date.now() - t0 >= 350 && Date.now() - t0 < 4000, `${Date.now() - t0} ms`)
  ok('stop: it did get SIGTERM first', existsSync(join(cwd, 'term.txt')))
}
{
  // work half-streamed when Stop is pressed is kept, like a Radiant turn keeps it
  const cwd = work()
  const ac = new AbortController()
  const p = run({ tool: 'claude-code', text: 'scenario:partial', cwd, signal: ac.signal })
  await waitFor(() => existsSync(join(cwd, 'ready.txt')))
  await sleep(100)
  ac.abort()
  const { r, events } = await p
  ok('stop: the half-written reply is saved as a text part', r.parts.length === 1 && r.parts[0].type === 'text' && r.parts[0].text === 'Half an ans', JSON.stringify(r.parts))
  ok('stop: and it was shown while it streamed', events.some(e => e.type === 'text_delta' && e.text === 'Half an ans'))
  const before = await run({ tool: 'claude-code', text: 'x', cwd: work(), signal: AbortSignal.abort() })
  ok('stop: an already-stopped turn never starts the tool', before.r.aborted === true && before.events.length === 0)
}

// ---------------------------------------------------------------- Part 2: through a real server
const PORT = 5862
const home = mkdtempSync(join(root, 'home-'))
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOME: home, RADIANT_PORT: String(PORT), RADIANT_DIR: '', RADIANT_CLI_IDLE_MS: '30000' },
  stdio: 'ignore'
})
const stopServer = () => { try { server.kill() } catch {} }
process.on('exit', stopServer)
const B = `http://127.0.0.1:${PORT}`
let up = false
for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(B + '/api/version')).ok } catch {} ; if (!up) await sleep(250) }
if (!up) { console.log('  the test server never came up'); stopServer(); process.exit(1) }
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) } }
const chat = async (sessionId, text, { signal } = {}) => {
  const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, content: text }), signal })
  if (r.status !== 200) return { status: r.status, body: await r.json().catch(() => null), events: [] }
  const events = []
  let buf = ''
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read().catch(() => ({ done: true }))
    if (done) break
    buf += dec.decode(value)
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f.startsWith('data: ')) { try { events.push(JSON.parse(f.slice(6))) } catch {} } }
  }
  return { status: 200, events }
}

{
  const cwd = work()
  const s = (await j('POST', '/api/sessions', { provider: 'claude-code', model: 'sonnet', cwd })).body
  const off = await chat(s.id, 'scenario:ok hello')
  ok('server: a CLI chat is refused while the setting is off', off.status === 403 && /turned off/.test(off.body?.error), JSON.stringify(off.body))
  ok('server: and the refused message left no running turn behind', (await j('GET', '/api/config')).status === 200)
  const models0 = (await j('GET', '/api/models')).body
  ok('server: no CLI models are offered while it is off', Array.isArray(models0) && !models0.some(m => m.cli))

  const set = await j('PUT', '/api/settings', { cliAgents: { enabled: true } })
  ok('server: the setting saves', set.body?.settings?.cliAgents?.enabled === true, JSON.stringify(set.body?.settings?.cliAgents))
  ok('server: it is kept in the machine file, not the synced config', !existsSync(join(home, '.radiant', 'config.json')) || !/cliAgents/.test(readFileSync(join(home, '.radiant', 'config.json'), 'utf8')))
  ok('server: the machine file has it', /"enabled": true/.test(readFileSync(join(home, '.radiant-machine.json'), 'utf8')))

  ok('server: enabled alone does not put them in the model menu', !(await j('GET', '/api/models')).body.some(m => m.cli))
  await j('PUT', '/api/settings', { cliAgents: { showModels: true } })
  const models = (await j('GET', '/api/models')).body
  ok('server: Claude Code and Codex appear as providers of models', models.some(m => m.provider === 'claude-code' && m.providerName === 'Claude Code (subscription)' && m.cli && m.id === 'opus') && models.some(m => m.provider === 'codex' && m.id === 'default'), JSON.stringify(models.filter(m => m.cli).slice(0, 3)))
  const info = (await j('GET', '/api/cli-agents')).body
  ok('server: /api/cli-agents reports the tools and the setting', info.enabled === true && info.usable === true && info.agents.length === 2 && info.providers.length === 2, JSON.stringify(info).slice(0, 300))

  const first = await chat(s.id, 'scenario:ok hello there')
  const types = first.events.map(e => e.type)
  ok('server: chat streams text, tools, usage, done, closed', first.status === 200 && types.includes('text_delta') && types.includes('tool_start') && types.includes('tool_result') && types.includes('usage') && types.at(-2) === 'done' && types.at(-1) === 'closed', types.join())
  ok('server: and a title from the first message', first.events.some(e => e.type === 'title' && /hello there/.test(e.title)))
  let saved = (await j('GET', '/api/sessions/' + s.id)).body
  const lastA = saved.messages.at(-1)
  ok('server: the user message and the reply are saved', saved.messages.length === 2 && saved.messages[0].role === 'user' && lastA.role === 'assistant', JSON.stringify(saved.messages.map(m => m.role)))
  ok('server: the reply keeps its parts, model and source', lastA.parts.some(p => p.type === 'text' && p.text === 'Done: ok.') && lastA.parts.some(p => p.type === 'tool' && p.name === 'read_file' && p.result === 'file contents') && lastA.model === 'claude-fake-1' && lastA.via === 'claude-code')
  ok('server: Ask each is explained once, in the transcript', lastA.parts[0].type === 'notice' && /read-only/.test(lastA.parts[0].text))
  ok('server: the id to resume is stored on the chat', saved.cli?.id === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' && saved.cli.tool === 'claude-code', JSON.stringify(saved.cli))
  ok('server: usage is counted into the chat\'s stats', saved.stats?.turns === 1 && saved.stats.inTokens === 312 && saved.stats.outTokens === 16 && saved.stats.cachedIn === 300, JSON.stringify(saved.stats))

  const second = await chat(s.id, 'scenario:ok and again')
  ok('server: the second message resumes the same conversation', argsOf(cwd).args[argsOf(cwd).args.indexOf('--resume') + 1] === 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  saved = (await j('GET', '/api/sessions/' + s.id)).body
  ok('server: and the permission explanation is not repeated', second.status === 200 && saved.messages.length === 4 && saved.messages[3].parts[0].type !== 'notice', JSON.stringify(saved.messages[3]?.parts?.[0]))
  const dup = await fetch(B + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, content: 'x', messageId: 'm-1' }) }); await dup.text()
  const dup2 = await fetch(B + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.id, content: 'x', messageId: 'm-1' }) })
  ok('server: the same message sent twice is answered once', dup2.status === 409)

  // a failing tool becomes a saved, visible halt
  const fl = await chat(s.id, 'scenario:fail now')
  saved = (await j('GET', '/api/sessions/' + s.id)).body
  ok('server: a failing tool is a visible error event', fl.events.some(e => e.type === 'error' && /boom/.test(e.message)) && fl.events.some(e => e.type === 'halt'))
  ok('server: and the failure is in the saved transcript', saved.messages.at(-1).parts.some(p => p.type === 'halt' && /boom/.test(p.text)))

  // Stop: close the connection mid-turn
  const ac = new AbortController()
  const slow = chat(s.id, 'scenario:sleep', { signal: ac.signal }).catch(() => null)
  await waitFor(() => existsSync(join(cwd, 'ready.txt')))
  const pid = argsOf(cwd).pid
  ac.abort()
  await slow
  ok('server: closing the connection kills the tool', await waitFor(() => !alive(pid), 3000))
  await sleep(300)
  saved = (await j('GET', '/api/sessions/' + s.id)).body
  ok('server: the stopped turn is recorded as stopped', saved.messages.at(-1).parts.some(p => (p.type === 'notice' && p.text === 'Stopped.') || p.type === 'halt'), JSON.stringify(saved.messages.at(-1).parts))
  const again = await chat(s.id, 'scenario:ok after stop')
  ok('server: the chat is usable again after a stop', again.status === 200 && again.events.some(e => e.type === 'done'), String(again.status))

  // Codex through the server
  const cs = (await j('POST', '/api/sessions', { provider: 'codex', model: 'default', cwd: work() })).body
  const cx = await chat(cs.id, 'scenario:ok codex please')
  const csaved = (await j('GET', '/api/sessions/' + cs.id)).body
  ok('server: a Codex chat stores its thread id and its parts', cx.status === 200 && csaved.cli?.id === '0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' && csaved.messages.at(-1).parts.some(p => p.type === 'text' && p.text === 'All done.'), JSON.stringify(csaved.cli))
  await chat(cs.id, 'scenario:ok codex again')
  ok('server: the Codex chat resumes its thread', argsOf(csaved.cwd).args.includes('resume') && argsOf(csaved.cwd).args.includes('0198aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'))

  // Allow all in Radiant's own setting reaches the tool
  await j('PUT', '/api/settings', { approvalMode: 'off' })
  await chat(s.id, 'scenario:ok full power')
  ok('server: Radiant\'s Allow all becomes bypassPermissions', argsOf(cwd).args[argsOf(cwd).args.indexOf('--permission-mode') + 1] === 'bypassPermissions')
  await j('PUT', '/api/settings', { approvalMode: 'ask' })

  // a chat on a normal provider is untouched by all this
  const plain = (await j('POST', '/api/sessions', { provider: 'openai', model: 'x', cwd })).body
  const pr = await chat(plain.id, 'hi')
  ok('server: a chat on a normal provider still gets the normal answer (no key, no CLI)', pr.status === 400 && /API key|sign-in|Pick a model/.test(pr.body?.error || ''), JSON.stringify(pr.body))
}

stopServer()
try { rmSync(root, { recursive: true, force: true }) } catch {}
console.log(`cli run: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
