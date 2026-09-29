#!/usr/bin/env node
/**
 * The harness tax, measured on Radiant.
 *
 * Arena's HarnessTax paper (2026-09-16) ran the same model through Claude
 * Code, Codex CLI and Pi on the same SWE-bench Lite tasks and found the
 * harness moved cost by up to 5× while moving success by ±2%. Radiant is a
 * harness, so this is the same experiment with Radiant as one of the rows:
 * same tasks, same model, same prompt, same turn cap, and every row graded by
 * swebench's own test lists and grading code.
 *
 *   node scripts/bench-harness.mjs plan  [--n 30]
 *   node scripts/bench-harness.mjs run   --harness radiant|claude|codex --model <id> [--runs 3] [--n 30] [--only a,b]
 *   node scripts/bench-harness.mjs grade --harness radiant --model <id>
 *   node scripts/bench-harness.mjs report
 *
 * ⚠️ WHAT IS HELD EQUAL, AND WHAT IS NOT.
 *   · Tasks: 30 drawn from the natively gradable 239 (see bench/grade_native.py)
 *     in a fixed seeded order, each one first proven with the dataset's own
 *     fix. The paper drew from all 300; the scientific-Python repos need
 *     compiled old versions this Mac cannot build, so they are out.
 *   · Working copy: the repo at the task's base commit with the project's own
 *     dependencies installed in .venv — so every harness can run the tests,
 *     as the paper's containers let them.
 *   · Prompt: identical text, below. Neither hints nor the test patch.
 *   · Cap: 100 model calls per attempt ("turns" in the paper's sense).
 *   · Effort: each harness's `high`.
 *   · Cost: list price for the model, applied to every harness's own token
 *     counts — uncached input, cache writes, cache reads and output priced
 *     separately, which is why Radiant had to start reporting the split.
 *   · NOT equal: Claude Code and Radiant both read this Mac's user
 *     configuration (Tony's CLAUDE.md and memory respectively). Neither is
 *     told anything about SWE-bench. It is the harness "as installed".
 *
 * ⚠️ A RUN IS RESUMABLE. Every attempt writes its own JSON the moment it ends;
 * rerunning skips what exists. Kill it whenever.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const BENCH = path.join(ROOT, 'bench')
const PY = path.join(BENCH, '.venv', 'bin', 'python')
const GRADER = path.join(BENCH, 'grade_native.py')
const GIT = '/usr/bin/git'   // /usr/local/bin/git is an Intel binary on this Mac
const RESULTS = path.join(BENCH, 'results')
const MAX_TURNS = 100
const DATA_FILE = path.join(BENCH, 'data', 'swe-bench-lite.json')
// the 300-task test split, 4.4 MB, fetched once from Hugging Face and not committed
async function fetchDataset () {
  if (fs.existsSync(DATA_FILE)) return
  const rows = []
  for (const off of [0, 100, 200]) {
    const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Lite&config=default&split=test&offset=${off}&length=100`)
    if (!r.ok) throw new Error('dataset fetch ' + r.status)
    rows.push(...(await r.json()).rows.map(x => x.row))
  }
  if (rows.length !== 300) throw new Error(`expected 300 rows, got ${rows.length}`)
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows))
  console.log('fetched SWE-bench Lite: 300 tasks')
}
await fetchDataset()
const DATASET = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
const BY_ID = Object.fromEntries(DATASET.map(r => [r.instance_id, r]))

import { priceOf } from '../server/prices.js'
const cost = (u, model) => {
  const p = priceOf(model)
  if (!p) return null
  return ((u.uncached || 0) * p.in + (u.cacheWrite || 0) * p.cacheWrite + (u.cacheRead || 0) * p.cacheRead + (u.out || 0) * p.out) / 1e6
}

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt }
const N = Number(opt('n', 30))
const RUNS = Number(opt('runs', 3))

// ── the prompt every harness gets ────────────────────────────────────────
const prompt = inst => `You are working in a checkout of the ${inst.repo} repository at commit ${inst.base_commit.slice(0, 12)}. The project's dependencies are installed in a virtualenv at ./.venv (use ./.venv/bin/python to run anything).

The repository has this issue:

<issue>
${inst.problem_statement.trim()}
</issue>

Fix the issue by changing the source code in this repository. Do not modify or add tests, and do not commit. When the fix is complete, stop.`

// ── the plan: which tasks, in what order ──────────────────────────────────
function plan () {
  const order = JSON.parse(fs.readFileSync(path.join(BENCH, 'data', 'sample-order.json'), 'utf8')).order
  const goldPath = path.join(BENCH, 'data', 'gold-check.json')
  const gold = fs.existsSync(goldPath) ? JSON.parse(fs.readFileSync(goldPath, 'utf8')) : {}
  const chosen = [], dropped = []
  for (const id of order) {
    if (chosen.length >= N) break
    if (!(id in gold)) { console.log(`gold check missing for ${id} — run grade_native.py --gold first`); continue }
    if (gold[id].resolved) chosen.push(id); else dropped.push(id)
  }
  const out = { n: N, seed: 2026, tasks: chosen, droppedByGoldCheck: dropped, made: new Date().toISOString() }
  fs.writeFileSync(path.join(BENCH, 'plan.json'), JSON.stringify(out, null, 1))
  console.log(`${chosen.length} tasks planned; ${dropped.length} dropped because the reference fix does not grade natively: ${dropped.join(', ') || 'none'}`)
  const repos = {}
  for (const id of chosen) repos[BY_ID[id].repo] = (repos[BY_ID[id].repo] || 0) + 1
  console.log('by repo:', JSON.stringify(repos))
  return out
}
const loadPlan = () => JSON.parse(fs.readFileSync(path.join(BENCH, 'plan.json'), 'utf8'))

// ── a working copy for one attempt ────────────────────────────────────────
function prepare (id, dest) {
  const out = execFileSync(PY, [GRADER, '--prepare', id, dest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  return JSON.parse(out.trim().split('\n').pop())
}
function patchOf (dir) {
  execFileSync(GIT, ['-C', dir, 'add', '-A', '--', '.'], { stdio: 'ignore' })
  const diff = execFileSync(GIT, ['-C', dir, 'diff', '--cached', '--no-color', '--', '.', ':(exclude).venv', ':(exclude)*.pyc', ':(exclude)__pycache__'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return diff
}

// ── Radiant ───────────────────────────────────────────────────────────────
let radiant = null   // { base, proc }
async function radiantServer () {
  if (radiant) return radiant.base
  // ⚠️ NEVER THE APP ON 5834. The packaged Radiant is whatever release Tony
  // installed; this measures the CHECKOUT. The first smoke run quietly used
  // the app and reported zero cache hits from code that had just been fixed.
  // A second server on the same data directory is a supported case (see
  // test-two-macs) and it picks its own port when 5834 is taken.
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    // ⚠️ THE HOST IN THAT LINE IS NOT ALWAYS 127.0.0.1. With sharing switched
    // on the server binds 0.0.0.0 and says so; matching the loopback address
    // literally made every attempt wait 30s, give up, and leave the server it
    // had just spawned running — seven strays after one pass.
    const m = /listening on http:\/\/[^:\s]+:(\d+)/.exec(log)
    if (m) { radiant = { base: `http://127.0.0.1:${m[1]}`, proc }; return radiant.base }
    await new Promise(r => setTimeout(r, 200))
  }
  proc.kill()
  throw new Error('Radiant server never started:\n' + log.slice(-800))
}
// ⚠️ RETRY THE CONNECTION, NOT THE TURN. Four harness runs and their graders
// share this Mac, and a request to Radiant's own server occasionally fails to
// connect at all — recorded as "fetch failed" with no rounds, which reads like
// the harness attempted the task and produced nothing. Seven of one run's
// first thirty-five. A connection error before any work is not a result.
const api = async (base, method, p, body) => {
  let last
  for (let tryNo = 1; tryNo <= 4; tryNo++) {
    try {
      const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      const text = await res.text()
      try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: null, text } }
    } catch (e) {
      last = e
      await new Promise(r => setTimeout(r, 1000 * tryNo))
    }
  }
  throw last
}

async function runRadiant (inst, workdir, model, provider, mcp) {
  const base = await radiantServer()
  // mcp:false is the coding harness on its own; mcp:true is Radiant exactly as
  // installed on this Mac, every enabled MCP server's schemas included
  const s = await api(base, 'POST', '/api/sessions', { title: `bench ${inst.instance_id}`, cwd: workdir, provider, model, useTools: true, computerControl: false, mcp })
  if (s.status !== 200) throw new Error('session: ' + JSON.stringify(s.json || s.text))
  const sid = s.json.id
  await api(base, 'PATCH', `/api/sessions/${sid}`, { effort: 'high', autoTitle: false })
  const ctl = new AbortController()
  let rounds = 0, halted = null, err = null
  const t0 = Date.now()
  try {
    let res
    for (let tryNo = 1; ; tryNo++) {
      try { res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: sid, content: prompt(inst) }), signal: ctl.signal }); break }
      catch (e) { if (tryNo >= 3 || ctl.signal.aborted) throw e; await new Promise(r => setTimeout(r, 1000 * tryNo)) }
    }
    if (!res.ok) throw new Error('chat: ' + res.status + ' ' + await res.text())
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    outer: while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
        const line = chunk.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        let ev; try { ev = JSON.parse(line.slice(6)) } catch { continue }
        if (ev.type === 'round_start') {
          rounds++
          // ⚠️ THE CAP. Closing the stream is how a client stops a Radiant
          // turn; the server aborts the turn and records it as stopped.
          if (rounds > MAX_TURNS) { halted = 'turn cap'; ctl.abort(); break outer }
        } else if (ev.type === 'approval_request') {
          await api(base, 'POST', '/api/approve', { id: ev.id, approved: true })
        } else if (ev.type === 'question_request') {
          await api(base, 'POST', '/api/answer-question', { id: ev.id, answer: 'Use your best judgment and continue.' })
        } else if (ev.type === 'halt') {
          halted = ev.reason || 'halt'
        } else if (ev.type === 'error') {
          err = ev.text || ev.message || 'error'
        } else if (ev.type === 'closed') {
          break outer
        }
      }
    }
  } catch (e) {
    if (!ctl.signal.aborted) err = e.message
  }
  const wallMs = Date.now() - t0
  // the session's stats are the source of truth, written when the turn ends
  await new Promise(r => setTimeout(r, 500))
  const sess = await api(base, 'GET', `/api/sessions/${sid}`)
  const st = sess.json?.stats || {}
  const usage = {
    total_in: st.inTokens || 0,
    cacheRead: st.cachedIn || 0,
    cacheWrite: st.cacheWrite || 0,
    uncached: Math.max(0, (st.inTokens || 0) - (st.cachedIn || 0) - (st.cacheWrite || 0)),
    out: st.outTokens || 0,
    bg: { in: st.bgIn || 0, out: st.bgOut || 0, calls: st.bgCalls || 0 }
  }
  const trace = await api(base, 'GET', `/api/sessions/${sid}/export`)
  await api(base, 'DELETE', `/api/sessions/${sid}`)
  return { rounds: Math.min(rounds, MAX_TURNS), usage, wallMs, halted, error: err, trace: trace.json || trace.text || null }
}

// ── Claude Code ───────────────────────────────────────────────────────────
function runClaude (inst, workdir, model) {
  const t0 = Date.now()
  // ⚠️ RUN IT IN A CLEAN ENVIRONMENT. This benchmark is itself launched from a
  // Claude Code session, whose environment carries CLAUDE_CODE_* wiring and an
  // ANTHROPIC_BASE_URL pointing at the host session — a nested `claude -p`
  // inherits those and dies with "OAuth session expired and could not be
  // refreshed" while the same command works in the user's own shell. Keep only
  // what any shell has.
  const clean = {}
  for (const k of ['HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']) {
    if (process.env[k]) clean[k] = process.env[k]
  }
  clean.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const r = spawnSyncCapture('claude', [
    '-p', prompt(inst), '--output-format', 'json', '--max-turns', String(MAX_TURNS),
    '--effort', 'high', '--model', model, '--dangerously-skip-permissions'
  ], { cwd: workdir, env: clean })
  const wallMs = Date.now() - t0
  let j = null
  try { j = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()) } catch {}
  const u = j?.usage || {}
  // Claude Code may spend some calls on a cheaper model (titles, subagents);
  // modelUsage has the split, so price each model at its own rate
  let byModel = null
  if (j?.modelUsage) {
    byModel = Object.entries(j.modelUsage).map(([m, v]) => ({ model: m, uncached: v.inputTokens || 0, cacheWrite: v.cacheCreationInputTokens || 0, cacheRead: v.cacheReadInputTokens || 0, out: v.outputTokens || 0 }))
  }
  const usage = {
    uncached: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0, out: u.output_tokens || 0,
    total_in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    byModel, reportedCostUsd: j?.total_cost_usd ?? null
  }
  return { rounds: j?.num_turns ?? null, usage, wallMs, halted: j?.num_turns >= MAX_TURNS ? 'turn cap' : null, error: j?.is_error ? (j.result || 'error') : (j ? null : 'no json: ' + r.stderr.slice(-300)), trace: j }
}

// ── Codex CLI ─────────────────────────────────────────────────────────────
function runCodex (inst, workdir, model) {
  const t0 = Date.now()
  const r = spawnSyncCapture('codex', ['exec', '--json', '-s', 'workspace-write', '--skip-git-repo-check', '-C', workdir, '-m', model, '-c', 'model_reasoning_effort="high"', prompt(inst)], { cwd: workdir })
  const wallMs = Date.now() - t0
  const events = r.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  let usage = null, rounds = 0
  for (const ev of events) {
    const u = ev.usage || ev.msg?.usage || ev.info?.total_token_usage || ev.payload?.usage
    if (u && (u.input_tokens != null)) usage = u
    if (ev.type === 'item.completed' || ev.msg?.type === 'exec_command_end') rounds++
  }
  const u = usage || {}
  return {
    rounds, wallMs,
    usage: { uncached: (u.input_tokens || 0) - (u.cached_input_tokens || 0), cacheRead: u.cached_input_tokens || 0, cacheWrite: 0, out: u.output_tokens || 0, total_in: u.input_tokens || 0 },
    halted: null, error: r.status ? ('exit ' + r.status + ': ' + r.stderr.slice(-300)) : null, trace: events.slice(-40)
  }
}

function spawnSyncCapture (bin, argv, opts) {
  const { spawnSync } = require_('node:child_process')
  const r = spawnSync(bin, argv, { ...opts, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60 * 60 * 1000 })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)

// ── run ───────────────────────────────────────────────────────────────────
async function run () {
  const harness = opt('harness')
  const model = opt('model')
  if (!harness || !model) throw new Error('--harness and --model are required')
  const provider = opt('provider', model.startsWith('claude') ? 'anthropic' : model.includes('/') ? 'openrouter' : 'openai')
  const mcp = opt('mcp', 'off') === 'on'
  const only = opt('only') ? opt('only').split(',') : null
  const p = loadPlan()
  const tasks = (only || p.tasks).slice(0, N)
  // --tag names the result set, so a rerun after a fix sits beside the run before it
  const tag = `${harness}${harness === 'radiant' && mcp ? '+mcp' : ''}${opt('tag') ? '@' + opt('tag') : ''}__${model.replace(/\//g, '_')}`
  const dir = path.join(RESULTS, tag)
  fs.mkdirSync(dir, { recursive: true })
  console.log(`${harness} · ${model} · ${tasks.length} task(s) × ${RUNS} run(s) → ${dir}`)
  for (let k = 1; k <= RUNS; k++) {
    for (const id of tasks) {
      const out = path.join(dir, `${id}__r${k}.json`)
      // an attempt that never reached the model (server hiccup, no JSON back)
      // is redone on the next pass; one that ran and failed the task is kept
      if (fs.existsSync(out)) {
        const prev = JSON.parse(fs.readFileSync(out, 'utf8'))
        const capped = /session limit|rate limit|429|usage limit|overloaded/i.test(String(prev.error || '')) && !prev.patch
        if (!capped && !(prev.error && !prev.patch && !(prev.rounds > 0))) continue
      }
      const inst = BY_ID[id]
      const work = path.join(BENCH, 'work', tag, `${id}-r${k}`)
      process.stdout.write(`  r${k} ${id.padEnd(30)} `)
      let rec
      // ⚠️ SETTING UP THE WORKING COPY CAN FAIL ON THE NETWORK, AND THAT IS NOT
      // A RESULT. `prepare` clones and pip-installs; a flaky moment there threw
      // "fetch failed" before a single token was spent, and the attempt was
      // written as if the harness had tried and produced nothing. Nine of the
      // first ninety. Retry it twice before recording anything.
      for (let tryNo = 1; tryNo <= 3; tryNo++) {
        try { prepare(id, work); break } catch (e) {
          if (tryNo === 3) throw e
          fs.rmSync(work, { recursive: true, force: true })
          await new Promise(r => setTimeout(r, 4000 * tryNo))
        }
      }
      try {
        // ⚠️ A SUBSCRIPTION CAP IS NOT A RESULT EITHER. Two harnesses on one
        // Claude subscription at once hit "session limit" / 429 on half their
        // attempts and were recorded as failures. Wait it out and try again;
        // a cap never says how long, so ten minutes, then again.
        let res
        for (let tryNo = 1; ; tryNo++) {
          res = harness === 'radiant' ? await runRadiant(inst, work, model, provider, mcp)
            : harness === 'claude' ? runClaude(inst, work, model)
            : harness === 'codex' ? runCodex(inst, work, model)
            : (() => { throw new Error('unknown harness ' + harness) })()
          const capped = /session limit|rate limit|429|usage limit|overloaded/i.test(String(res.error || '')) && !(res.rounds > 3)
          if (!capped || tryNo >= 12) break
          process.stdout.write(`(capped: ${String(res.error).slice(0, 50)} — waiting 10 min) `)
          fs.rmSync(work, { recursive: true, force: true }); prepare(id, work)
          await new Promise(r => setTimeout(r, 10 * 60 * 1000))
        }
        const patch = patchOf(work)
        rec = { instance_id: id, run: k, harness, model, ...res, patchBytes: patch.length, patch, costUsd: cost(res.usage, model), at: new Date().toISOString() }
        if (rec.usage.byModel) rec.costUsd = rec.usage.byModel.reduce((a, m) => a + (cost(m, m.model) || 0), 0)
      } catch (e) {
        rec = { instance_id: id, run: k, harness, model, error: e.message, patch: '', at: new Date().toISOString() }
      }
      fs.writeFileSync(out, JSON.stringify(rec, null, 1))
      fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(work + '.prepare.log', { force: true })
      const c = rec.costUsd == null ? '   n/a' : ('$' + rec.costUsd.toFixed(2)).padStart(6)
      console.log(`${rec.error ? 'ERR ' : 'ok  '} ${String(rec.rounds ?? '?').padStart(3)} turns  ${c}  ${Math.round((rec.wallMs || 0) / 1000)}s  patch ${rec.patchBytes || 0}b${rec.halted ? '  [' + rec.halted + ']' : ''}${rec.error ? '  ' + String(rec.error).slice(0, 120) : ''}`)
    }
  }
  if (radiant?.proc) radiant.proc.kill()
}

// ── grade ─────────────────────────────────────────────────────────────────
function grade () {
  const harness = opt('harness'), model = opt('model')
  const tag = `${harness}${harness === 'radiant' && opt('mcp', 'off') === 'on' ? '+mcp' : ''}${opt('tag') ? '@' + opt('tag') : ''}__${model.replace(/\//g, '_')}`
  const dir = path.join(RESULTS, tag)
  const recs = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.includes('__r')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  for (let k = 1; k <= RUNS; k++) {
    const rows = recs.filter(r => r.run === k)
    if (!rows.length) continue
    const preds = path.join(dir, `preds-r${k}.jsonl`)
    fs.writeFileSync(preds, rows.map(r => JSON.stringify({ instance_id: r.instance_id, model_name_or_path: `${tag}-r${k}`, model_patch: r.patch || '' })).join('\n') + '\n')
    const out = path.join(dir, `graded-r${k}.json`)
    console.log(`grading run ${k}: ${rows.length} prediction(s)`)
    execFileSync(PY, [GRADER, '--preds', preds, '--out', out, '--workers', opt('workers', '3')], { stdio: 'inherit' })
  }
}

// ── report ────────────────────────────────────────────────────────────────
function report () {
  if (!fs.existsSync(RESULTS)) return console.log('no results yet')
  const p = loadPlan()
  const lines = []
  for (const tag of fs.readdirSync(RESULTS)) {
    const dir = path.join(RESULTS, tag)
    const recs = fs.readdirSync(dir).filter(f => /__r\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    const graded = {}
    for (const f of fs.readdirSync(dir).filter(f => /^graded-r\d+\.json$/.test(f))) {
      const k = Number(/r(\d+)/.exec(f)[1]); graded[k] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    }
    // per task: mean over its runs; then mean over tasks — the paper's method
    const perTask = {}
    for (const r of recs) {
      const g = graded[r.run]?.[r.instance_id]
      const t = perTask[r.instance_id] ||= { n: 0, resolved: 0, cost: 0, turns: 0, secs: 0, cached: 0, totalIn: 0, graded: 0 }
      t.n++; t.cost += r.costUsd || 0; t.turns += r.rounds || 0; t.secs += (r.wallMs || 0) / 1000
      t.cached += r.usage?.cacheRead || 0; t.totalIn += r.usage?.total_in || 0
      if (g) { t.graded++; if (g.resolved) t.resolved++ }
    }
    const tasks = Object.values(perTask)
    const mean = f => tasks.length ? tasks.reduce((a, t) => a + f(t), 0) / tasks.length : 0
    // success only over tasks that have been graded — an ungraded task is not a failure
    const gradedTasks = tasks.filter(t => t.graded)
    const successRate = gradedTasks.length ? gradedTasks.reduce((a, t) => a + t.resolved / t.graded, 0) / gradedTasks.length : NaN
    const attempts = recs.length
    const cachePct = tasks.reduce((a, t) => a + t.cached, 0) / Math.max(1, tasks.reduce((a, t) => a + t.totalIn, 0)) * 100
    lines.push({ tag, tasks: tasks.length, attempts, graded: tasks.reduce((a, t) => a + t.graded, 0), gradedTasks: gradedTasks.length, success: successRate * 100, cost: mean(t => t.cost / t.n), turns: mean(t => t.turns / t.n), secs: mean(t => t.secs / t.n), cachePct })
  }
  console.log(`\nSWE-bench Lite (${p.tasks.length} tasks, native grading) · mean over tasks of mean over attempts\n`)
  console.log('harness · model                  tasks  attempts graded  success   $/task  turns   secs  cached-in')
  for (const l of lines) {
    console.log(`${l.tag.padEnd(32)} ${String(l.tasks).padStart(4)}  ${String(l.attempts).padStart(6)}  ${String(l.graded).padStart(5)}  ${(Number.isNaN(l.success) ? '   —' : l.success.toFixed(1).padStart(6) + '%')}  ${('$' + l.cost.toFixed(2)).padStart(7)}  ${l.turns.toFixed(1).padStart(5)}  ${Math.round(l.secs).toString().padStart(5)}  ${l.cachePct.toFixed(0).padStart(6)}%`)
  }
  fs.writeFileSync(path.join(BENCH, 'report.json'), JSON.stringify({ plan: p, rows: lines, at: new Date().toISOString() }, null, 1))
}

if (cmd === 'plan') plan()
else if (cmd === 'run') await run()
else if (cmd === 'grade') grade()
else if (cmd === 'report') report()
else { console.log('usage: bench-harness.mjs plan | run --harness X --model M | grade --harness X --model M | report'); process.exit(1) }
