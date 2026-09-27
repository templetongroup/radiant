#!/usr/bin/env node
/**
 * Harvest what went wrong — step 1 of the loop that turns real failures into
 * tests (Tony, 2026-09-27, after Muratcan Koylan's "agents write the evals").
 *
 * ⚠️ WHY. Every regression test Radiant has was written by hand after Tony hit
 * the bug himself: download progress broke four times in production before it
 * had one. The evidence was on disk the whole time — every reply records how
 * it ended, what it claimed, and which tools failed. This reads it.
 *
 * Two sources, read-only:
 *   - your chats (the data folder, sessions + archive)
 *   - the harness benchmark's recorded runs (bench/results/radiant*), graded
 * Each failure gets a KIND and a SIGNATURE (provider family, tool, the error
 * with numbers, paths and ids taken out), and failures with the same signature
 * are one CAUSE. Causes are ranked by how often they happened.
 *
 *   node scripts/harvest-failures.mjs              # print the report
 *   node scripts/harvest-failures.mjs --json       # machine-readable
 *   node scripts/harvest-failures.mjs --save       # also write it to <data>/harvest/
 *
 * ⚠️ THE REPORT QUOTES YOUR CHATS. It is written into your own data folder,
 * never into the repo. Step 2 turns causes into tests that keep the shape of
 * what happened, not its words.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CMD_FAIL_RX } from '../server/providers.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function dataDir () {
  if (process.env.RADIANT_DIR) return process.env.RADIANT_DIR
  try { const p = fs.readFileSync(path.join(os.homedir(), '.radiant-location'), 'utf8').trim(); if (p && fs.existsSync(p)) return p } catch {}
  return path.join(os.homedir(), '.radiant')
}
const DATA = dataDir()

// ── signatures ───────────────────────────────────────────────────────────────
/** An error line with the parts that differ between occurrences taken out. */
export function signature (text) {
  return String(text || '')
    .split('\n').map(l => l.trim()).find(l => l && !/^\s*at\s/.test(l)) // first real line
    ?.replace(/\/(?:Users|home|private|tmp|var)\/[^\s'"`:)]+/g, '<path>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{7,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/(["'`])(?:(?!\1).){1,80}\1/g, '<str>')
    .replace(/\s+/g, ' ')
    .slice(0, 140) || ''
}
/** gpt-5.6-sol → openai, claude-sonnet-5 → anthropic, qwen3:8b → local … */
export function family (provider, model) {
  const m = `${provider || ''} ${model || ''}`.toLowerCase()
  if (/ollama|lmstudio|:latest|gguf/.test(m)) return 'local'
  if (/claude|anthropic/.test(m)) return 'anthropic'
  if (/gpt|openai|o\d/.test(m)) return 'openai'
  if (/grok|xai/.test(m)) return 'xai'
  if (/gemini|google/.test(m)) return 'google'
  return provider || 'unknown'
}

/**
 * Whose problem is it? Only some failures are Radiant's to fix:
 *   radiant     — the harness itself: a turn that died, went silent, or claimed
 *                 something no tool showed; a tool of ours that errored
 *   environment — the agent's shell is missing something (timeout, python) or
 *                 a command hung; Radiant sets that shell up, so ours too
 *   tool-use    — our tool refused a call it could have helped with
 *                 (edit_file's old_string not found)
 *   provider    — rate limits and the like, outside Radiant
 *   work        — the agent doing its job: a failing test while it debugs, a
 *                 site that 404s, a benchmark fix that did not pass
 * The default report shows the first three; --all shows everything.
 */
export function blame (f) {
  const t = `${f.sig} ${f.excerpt || ''}`
  if (f.kind === 'bench-unresolved' || f.kind === 'pushback') return f.kind === 'pushback' ? 'radiant' : 'work'
  if (/\b(429|rate limit|overloaded|quota)\b/i.test(t)) return 'provider'
  if (/^(halt|empty-reply|unbacked-claim|context|notice|bench-error|bench-halt)/.test(f.kind)) return 'radiant'
  if (f.kind === 'tool-timeout' || /command not found|\[exit code 12[67]\]|timed out|permission denied/i.test(t)) return 'environment'
  if (/old_string not found/i.test(t)) return 'tool-use'
  if (f.kind === 'repeat-failure') return /exit code N\]|Traceback|failed, N passed/.test(t) ? 'work' : 'radiant'
  if (f.tool && f.tool !== 'run_command' && f.tool !== 'read_file' && !/\b(40[134]|410|5\d\d)\b/.test(t)) return 'radiant'
  if (/search failed/i.test(t)) return 'radiant'
  return 'work'
}
const SHOWN = new Set(['radiant', 'environment', 'tool-use'])

const PUSHBACK = /\b(still (broken|not working|failing|wrong|doesn'?t)|doesn'?t work|didn'?t work|not (fixed|working)|that'?s (wrong|not right)|you didn'?t|same (error|issue|problem)|it (broke|crashed)|try again|why (did|is) it)\b/i

// ── scan one chat ────────────────────────────────────────────────────────────
/** Every failure in one chat, as { kind, sig, tool?, where, excerpt }. */
export function scanChat (chat, where) {
  const out = []
  const fam = family(chat.provider, chat.model)
  const msgs = Array.isArray(chat.messages) ? chat.messages : []
  msgs.forEach((m, i) => {
    const at = `${where} #${i}`
    if (m.role === 'user') {
      // the person saying it did not work is the strongest signal there is
      if (i > 0 && PUSHBACK.test(m.text || '')) out.push({ kind: 'pushback', sig: 'user says it did not work', where: at, excerpt: String(m.text).slice(0, 160), fam })
      return
    }
    if (m.role !== 'assistant') return
    const parts = Array.isArray(m.parts) ? m.parts : []
    const mfam = family(chat.provider, m.model || chat.model)
    if (!parts.some(p => (p.type === 'text' && p.text?.trim()) || p.type === 'tool' || p.type === 'halt' || p.type === 'notice')) {
      out.push({ kind: 'empty-reply', sig: 'a reply with nothing in it', where: at, fam: mfam })
    }
    // tool calls that failed, and the same failing call made again
    const failing = new Map()
    for (const p of parts) {
      if (p.type === 'halt') out.push({ kind: `halt:${p.reason || 'unknown'}`, sig: signature(p.text), where: at, excerpt: String(p.text || '').slice(0, 200), fam: mfam })
      if (p.type === 'notice') {
        const t = String(p.text || '')
        if (/^Not shown by anything in this turn/.test(t)) out.push({ kind: 'unbacked-claim', sig: 'a claim no tool result showed', where: at, excerpt: t.slice(0, 200), fam: mfam })
        else if (/limit|trimmed|summari[sz]ed|output limit|did not finish/i.test(t)) out.push({ kind: 'context', sig: signature(t), where: at, excerpt: t.slice(0, 200), fam: mfam })
        else if (/not on this Mac|could not|failed|error/i.test(t)) out.push({ kind: 'notice', sig: signature(t), where: at, excerpt: t.slice(0, 200), fam: mfam })
      }
      if (p.type !== 'tool') continue
      const r = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? '')
      const bad = p.timedOut || p.error || (/^(run_command|write_file|edit_file)$/.test(p.name) && CMD_FAIL_RX.test(r)) || /^(Error|ERROR)[: ]/.test(r)
      if (!bad) continue
      const line = r.split('\n').find(l => CMD_FAIL_RX.test(l) || /error|Error|failed/.test(l)) || r
      const sig = `${p.name}: ${signature(p.timedOut ? 'timed out' : line)}`
      out.push({ kind: p.timedOut ? 'tool-timeout' : 'tool-error', sig, tool: p.name, where: at, excerpt: line.slice(0, 200), fam: mfam })
      failing.set(sig, (failing.get(sig) || 0) + 1)
    }
    for (const [sig, n] of failing) if (n >= 3) out.push({ kind: 'repeat-failure', sig: `the same failure ${n}× in one reply — ${sig}`, where: at, fam: mfam })
  })
  return out
}

// ── sources ──────────────────────────────────────────────────────────────────
function readChats () {
  const files = []
  for (const sub of ['sessions', 'archive']) {
    const d = path.join(DATA, sub)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) files.push(path.join(d, f))
  }
  const chats = []
  for (const f of files) {
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(c?.messages)) chats.push({ chat: c, where: `chat “${String(c.title || c.id).slice(0, 50)}”` }) } catch {}
  }
  return chats
}

/** Benchmark attempts: the recorded chat, plus whether the fix passed the tests. */
function readBench () {
  const dir = path.join(ROOT, 'bench', 'results')
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const tag of fs.readdirSync(dir).filter(t => t.startsWith('radiant'))) {
    const grades = {}
    for (const g of fs.readdirSync(path.join(dir, tag)).filter(f => /^graded-r\d+\.json$/.test(f))) {
      try {
        const run = g.match(/r(\d+)/)[1]
        const j = JSON.parse(fs.readFileSync(path.join(dir, tag, g), 'utf8'))
        for (const [id, v] of Object.entries(j.results || j)) grades[`${id}__r${run}`] = v?.resolved ?? v
      } catch {}
    }
    for (const f of fs.readdirSync(path.join(dir, tag)).filter(f => /__r\d+\.json$/.test(f))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, tag, f), 'utf8'))
        const key = f.replace(/\.json$/, '')
        let chat = null
        try { chat = JSON.parse(r.trace?.content || 'null')?.chats?.[0] || null } catch {}
        out.push({ tag, id: r.instance_id, run: r.run, model: r.model, halted: r.halted, error: r.error, rounds: r.rounds, resolved: grades[key], chat })
      } catch {}
    }
  }
  return out
}

// ── harvest ──────────────────────────────────────────────────────────────────
export function harvest ({ chats = readChats(), bench = readBench() } = {}) {
  const failures = []
  for (const { chat, where } of chats) failures.push(...scanChat(chat, where).map(f => ({ ...f, source: 'chat' })))
  for (const b of bench) {
    const where = `bench ${b.tag} ${b.id} r${b.run}`
    const fam = family('', b.model)
    if (b.error) failures.push({ source: 'bench', kind: 'bench-error', sig: signature(b.error), where, excerpt: String(b.error).slice(0, 200), fam })
    if (b.halted) failures.push({ source: 'bench', kind: `bench-halt:${b.halted.reason || b.halted}`, sig: signature(b.halted.text || b.halted), where, fam })
    if (b.resolved === false) failures.push({ source: 'bench', kind: 'bench-unresolved', sig: `fix did not pass the task's tests (${b.id.split('__')[0]})`, where, fam })
    if (b.chat) failures.push(...scanChat(b.chat, where).map(f => ({ ...f, source: 'bench' })))
  }
  // one cause = same kind + same signature + same model family
  const causes = new Map()
  for (const f of failures) {
    const key = `${f.kind}|${f.fam}|${f.sig}`
    const c = causes.get(key) || { kind: f.kind, fam: f.fam, sig: f.sig, tool: f.tool || null, blame: blame(f), count: 0, sources: new Set(), examples: [] }
    c.count++
    c.sources.add(f.source)
    if (c.examples.length < 3) c.examples.push({ where: f.where, excerpt: f.excerpt || null })
    causes.set(key, c)
  }
  const ranked = [...causes.values()]
    .map(c => ({ ...c, sources: [...c.sources] }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
  return {
    at: new Date().toISOString(),
    scanned: { chats: chats.length, replies: chats.reduce((n, c) => n + c.chat.messages.filter(m => m.role === 'assistant').length, 0), benchRuns: bench.length, benchGraded: bench.filter(b => typeof b.resolved === 'boolean').length },
    failures: failures.length,
    byBlame: ranked.reduce((m, c) => ({ ...m, [c.blame]: (m[c.blame] || 0) + c.count }), {}),
    causes: ranked
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = harvest()
  if (args.includes('--save')) {
    const dir = path.join(DATA, 'harvest')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${report.at.slice(0, 10)}.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    if (!args.includes('--json')) console.log(`saved ${file}\n`)
  }
  if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }
  const s = report.scanned
  console.log(`Scanned ${s.chats} chats (${s.replies} replies) and ${s.benchRuns} benchmark runs (${s.benchGraded} graded).`)
  console.log(`${report.failures} failures, ${report.causes.length} causes: ${Object.entries(report.byBlame).map(([k, n]) => `${n} ${k}`).join(', ')}.`)
  const all = args.includes('--all')
  const shown = report.causes.filter(c => all || SHOWN.has(c.blame))
  console.log(all ? '' : `Showing the ${shown.length} causes Radiant can fix (radiant, environment, tool-use); --all for the rest.\n`)
  const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 25
  for (const [i, c] of shown.slice(0, top).entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${String(c.count).padStart(3)}×  ${c.blame.padEnd(11)} ${c.kind.padEnd(16)} ${c.fam.padEnd(9)} ${c.sig}`)
    for (const e of c.examples.slice(0, 2)) console.log(`         ${e.where}${e.excerpt ? ` — ${e.excerpt.replace(/\s+/g, ' ').slice(0, 110)}` : ''}`)
  }
}
