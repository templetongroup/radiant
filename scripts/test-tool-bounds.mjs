/**
 * Every tool result is bounded, every tool call has a time budget, and the
 * permanent roster stays small.
 *
 * ⚠️ THESE THREE ARE THE SAME ARGUMENT. A tool definition taxes every request
 * whether or not it is used; an unbounded result taxes the one request that
 * returns a web page; an uncapped call taxes the whole turn. All three were
 * left to each implementation, and all three had the coverage that always
 * produces: three of twelve tools truncated, two of twelve had a time limit.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { TOOL_DEFS, runTool, aliasCall } = await import('../server/tools.js')
const { boundResult, withBudget, ToolTimeout, MAX_RESULT_CHARS } = await import('../server/tool-bounds.js')

let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

// ── the roster is a budget ──────────────────────────────────────────────────
// ⚠️ A NUMBER, NOT A PRINCIPLE. "Keep the roster small" in a comment is what
// twelve tools looked like on the way to twenty. Raising this is a decision
// someone has to make on purpose, with the cost in front of them.
const tokens = Math.round(JSON.stringify(TOOL_DEFS).length / 3.7)
ok('the permanent roster stays at or under 10 tools', TOOL_DEFS.length <= 10, `${TOOL_DEFS.length} tools`)
ok('and under 1200 tokens of schema on every request', tokens <= 1200, `${tokens} tokens`)
ok('the three job schemas are one', TOOL_DEFS.filter(t => t.name.startsWith('job')).length === 1,
   TOOL_DEFS.filter(t => t.name.startsWith('job')).map(t => t.name).join(','))
ok('list_dir no longer costs a schema', !TOOL_DEFS.some(t => t.name === 'list_dir'))
ok('every tool still has a description and a schema',
   TOOL_DEFS.every(t => t.name && t.description && t.input_schema))

// ── the dialect stays charitable ────────────────────────────────────────────
// ⚠️ SHRINKING THE ROSTER WITHOUT THIS JUST MOVES THE COST. Models are trained
// on other harnesses' names and will call list_dir whether or not we advertise
// it; refusing trades tokens saved on the schema for tokens burnt on a retry.
ok('an unadvertised job_kill is repaired into job(kill)',
   JSON.stringify(aliasCall('job_kill', { id: 'j1' })) === JSON.stringify(['job', { id: 'j1', action: 'kill' }]))
ok('job_list too', aliasCall('job_list', {})[1].action === 'list')
ok('and ls maps to a directory listing', aliasCall('ls', { path: '.' })[0] === 'list_dir')
ok('a tool we really have is left alone', aliasCall('read_file', { path: 'x' })[0] === 'read_file')

const dir = mkdtempSync(join(tmpdir(), 'rx-bounds-'))
mkdirSync(join(dir, 'sub'), { recursive: true })
writeFileSync(join(dir, 'a.txt'), 'hello\n')
ok('list_dir still works through the alias',
   (await runTool('ls', { path: dir }, dir)).includes('a.txt'))
// A directory is a resource; reading one lists it, which is why list_dir left.
const asRead = await runTool('read_file', { path: dir }, dir)
ok('reading a directory lists it instead of failing', asRead.includes('a.txt') && asRead.includes('sub/'), asRead.slice(0, 80))
ok('reading a file still reads it', (await runTool('read_file', { path: join(dir, 'a.txt') }, dir)).includes('hello'))
{
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'long.txt'), Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n'))
  const out = (await runTool('read_file', { path: join(dir, 'long.txt') }, dir)).split('\n')
  ok('the first line of a read is numbered', out[0] === '1\tline 1')
  ok('then every tenth line', out[9] === '10\tline 10' && out[19] === '20\tline 20')
  ok('the rest keep a tab and no number (3-5 tokens saved a line)', out[4] === '\tline 5' && out[24] === '\tline 25')
  const mid = (await runTool('read_file', { path: join(dir, 'long.txt'), offset: 13, limit: 5 }, dir)).split('\n')
  ok('a read that starts mid-file numbers its first line', mid[0] === '13\tline 13' && mid[1] === '\tline 14')
}

// ── results are bounded, and the notice is not in the data ──────────────────
{
  const big = 'x'.repeat(MAX_RESULT_CHARS * 2)
  const r = boundResult('fetch_url', big)
  ok('an oversized result is cut down', r.text.length < big.length)
  ok('and it reports how much went', r.truncated === big.length - MAX_RESULT_CHARS)
  // ⚠️ HEAD AND TAIL, NOT JUST THE HEAD. A command result whose exit line was cut
  // off is worse than useless: the model reads a successful-looking prefix and
  // concludes it worked.
  const withEnd = 'START' + 'y'.repeat(MAX_RESULT_CHARS * 2) + 'EXIT 1'
  const r2 = boundResult('run_command', withEnd)
  ok('the beginning survives', r2.text.startsWith('START'))
  ok('and so does the end, where the exit code lives', r2.text.endsWith('EXIT 1'))
  const small = 'fine'
  ok('a small result is untouched', boundResult('x', small).text === small && boundResult('x', small).truncated === 0)
  ok('a null result does not throw', boundResult('x', null).text === '')
}

// ── every tool call has a time budget ───────────────────────────────────────
{
  const t = Date.now()
  let err = null
  try { await withBudget('hangs', 250, () => new Promise(() => {})) } catch (e) { err = e }
  ok('a call that never returns is given up on', err instanceof ToolTimeout, String(err))
  ok('quickly', Date.now() - t < 2000, `${Date.now() - t}ms`)
  ok('and the message says it may still be running', /still be running/.test(err.message))
  ok('a call that finishes in time is not disturbed',
     (await withBudget('quick', 5000, async () => 'done')) === 'done')
}

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  ${TOOL_DEFS.length} tools ≈ ${tokens} tokens per request; every result bounded, every call budgeted`)
process.exit(fail ? 1 : 0)
