#!/usr/bin/env node
/**
 * The judgments the gates cannot make, made anyway — by Jev, before Tony sees it.
 *
 * scripts/ship-check.mjs verifies FACTS: committed, pushed, Read me touched,
 * tagged. It cannot tell whether the Read me entry is written for a person
 * using the app or for an engineer, whether the commit message says WHY, or
 * whether a release note describes something a user can do. Those are
 * judgment calls, and until now they were made by nobody until Tony read the
 * result and said "you're explaining things like I'm an engineer."
 *
 * Jev (server/decide.js) answers a yes/no with a calibrated probability in a
 * third of a second for a fraction of a cent, so every commit can be judged
 * on the way out. This reads what the last commit (or a range) changed —
 * the message, any new Read me entries on Mac or iPhone, any release notes
 * file given — and prints a scorecard. Exit 1 when a judgment fails, so
 * ship-check can refuse the same way it refuses an unpushed commit.
 *
 *   node scripts/ship-judge.mjs                # HEAD
 *   node scripts/ship-judge.mjs HEAD~3..HEAD   # a range
 *   node scripts/ship-judge.mjs --notes /tmp/notes.md
 *
 * ⚠️ ADVISORY WHEN IT CANNOT RUN. No OpenRouter key, endpoint down: it says
 * so and exits 0. A judge that is unreachable must not block a release.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decide } from '../server/decide.js'

const GIT = '/usr/bin/git'
const args = process.argv.slice(2)
const notesPath = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : null
const range = args.find(a => !a.startsWith('--') && a !== notesPath) || 'HEAD'
const spec = range.includes('..') ? range : `${range}~1..${range}`

// the key, from wherever Radiant keeps its data (the iCloud folder on this Mac)
function openrouterKey () {
  try {
    const dir = fs.existsSync(path.join(os.homedir(), '.radiant-location'))
      ? fs.readFileSync(path.join(os.homedir(), '.radiant-location'), 'utf8').trim()
      : path.join(os.homedir(), '.radiant')
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).keys?.openrouter || null
  } catch { return null }
}

const git = (...a) => execFileSync(GIT, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// ── what changed ─────────────────────────────────────────────────────────
const messages = git('log', '--format=%H%n%B%n----END----', spec).split('----END----').map(s => s.trim()).filter(Boolean)
  .map(s => { const [sha, ...rest] = s.split('\n'); return { sha: sha.slice(0, 7), text: rest.join('\n').replace(/\n*Co-Authored-By:.*$/s, '').trim() } })
const diff = git('diff', spec, '--', 'src/components/Settings.jsx', 'apps/ios/ios/App/App/Native/ReadMeView.swift')
// new Read me lines: added lines that look like a GUIDE entry or a phone section paragraph
const readme = []
for (const line of diff.split('\n')) {
  if (!line.startsWith('+') || line.startsWith('+++')) continue
  const m = /^\+\s*\['([^']+)',\s*'((?:[^'\\]|\\.)*)'\]/.exec(line)          // Mac GUIDE: ['Title', 'Body']
  if (m) readme.push({ where: 'Mac Read me', title: m[1], body: m[2].replace(/\\u2019/g, '’').replace(/\\u201c/g, '“').replace(/\\u201d/g, '”').replace(/\\u2014/g, '—').replace(/\\'/g, "'") })
  const p = /^\+\s*'((?:[^'\\]|\\.){80,})',?\s*$/.exec(line)                   // phone section paragraph
  if (p && !m) readme.push({ where: 'iPhone Read me', title: '', body: p[1].replace(/\\'/g, "'").replace(/\\u2019/g, '’').replace(/\\u2014/g, '—') })
}
const notes = notesPath && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : null

// ── the code itself ───────────────────────────────────────────────────────
// ⚠️ THE DIFF, NOT ONLY THE WORDS ABOUT IT. Everything above judges prose;
// this reads what changed (the jev-review pattern): per source file, four
// probabilities — a likely bug, a security or privacy hole, a behaviour
// change users would notice that the message does not mention, and a
// change that the test gates do not cover. Bugs and security at ≥ 0.7 fail;
// the other two are printed as warnings, because they are judgment calls a
// person should see, not a wall. Generated and vendored files are skipped.
const SKIP = /^(src\/sf-symbols|bench\/|docs\/|.*\.(png|icns|json|md|lock)$|package-lock|dist\/|release\/)/
const files = git('diff', '--name-only', spec).split('\n').filter(f => f && !SKIP.test(f))
const codeDiffs = []
for (const f of files) {
  const d = git('diff', spec, '--', f)
  if (d.length > 200 && d.length <= 24000) codeDiffs.push({ file: f, diff: d })
  else if (d.length > 24000) codeDiffs.push({ file: f, diff: d.slice(0, 24000) + '\n… (truncated)' })
}

// ── the questions ─────────────────────────────────────────────────────────
const questions = {}
const state = {}
for (const m of messages) {
  state[`commit_${m.sha}`] = m.text.slice(0, 3000)
  questions[`why_${m.sha}`] = {
    type: 'noul',
    instructions: `Read commit_${m.sha}. Does the message explain WHY the change was made — the problem, the cause, or what was observed — and not only what was changed?`,
    criteria: { true: 'It names a problem, a cause, a report, or a measurement that motivated the change.', false: 'It only lists what was edited, or says nothing beyond a title.' }
  }
}
readme.forEach((r, i) => {
  state[`readme_${i}`] = `${r.where}${r.title ? ' — ' + r.title : ''}\n${r.body}`
  questions[`plain_${i}`] = {
    type: 'noul',
    instructions: `Read readme_${i}, an entry in the app's built-in guide. Is it written for a person USING the app, not for an engineer?`,
    criteria: { true: 'A non-programmer would follow it on the first read; any technical term is explained in the same breath.', false: 'It leans on code names, file paths, protocol names or engineering jargon a user would not know.' }
  }
  questions[`cando_${i}`] = {
    type: 'noul',
    instructions: `Read readme_${i}. Does it say what the person can now DO, or what changed for them — not only what happened inside the software?`,
    criteria: { true: 'It tells the reader what they can do, see, or no longer have to do.', false: 'It describes internals with no consequence a user would notice.' }
  }
})
if (notes) {
  state.release_notes = notes.slice(0, 4000)
  questions.notes_user = {
    type: 'noul',
    instructions: 'Read release_notes. Are they written for the people who use the app?',
    criteria: { true: 'Each item says what changes for a user, in plain words.', false: 'They read like a commit log or an engineering summary.' }
  }
}

codeDiffs.forEach((c, i) => {
  state[`diff_${i}`] = `File: ${c.file}\nCommit message:\n${messages.map(m => m.text).join('\n---\n').slice(0, 1500)}\n\nDiff:\n${c.diff}`
  questions[`bug_${i}`] = { type: 'noul', instructions: `Read diff_${i}. Does the changed code contain a likely bug — a wrong condition, an unhandled case, a typo in a name, a resource never closed, an off-by-one — that would misbehave when run?`, criteria: { true: 'There is a specific defect a careful reviewer would flag as broken.', false: 'The change reads as correct; style or taste differences do not count.' } }
  questions[`sec_${i}`] = { type: 'noul', instructions: `Read diff_${i}. Does the change open a security or privacy hole — secrets logged or sent, input passed to a shell or a query unescaped, a check removed, data written where it should not be?`, criteria: { true: 'A concrete way for data to leak or for untrusted input to do harm.', false: 'No new exposure.' } }
  questions[`unsaid_${i}`] = { type: 'noul', instructions: `Read diff_${i}. Does the change alter behaviour a USER would notice that the commit message does not mention?`, criteria: { true: 'Something visible or felt changes and the message is silent about it.', false: 'The message covers what a user would notice, or nothing user-visible changes.' } }
  questions[`untested_${i}`] = { type: 'noul', instructions: `Read diff_${i}. Is this the kind of change that needs a test and the diff adds or changes none? Pure comments, copy, and generated files do not need one.`, criteria: { true: 'Logic changed and no test in the diff exercises it.', false: 'A test covers it, or it is not logic.' } }
})

if (!Object.keys(questions).length) { console.log('ship-judge: nothing to judge in ' + spec); process.exit(0) }

const key = openrouterKey()
if (!key) { console.log('ship-judge: no OpenRouter key — cannot judge (advisory only)'); process.exit(0) }
const out = await decide({ apiKey: key, state, questions, timeoutMs: 8000 })
if (!out) { console.log('ship-judge: Jev unreachable — cannot judge (advisory only)'); process.exit(0) }

// ── the scorecard ─────────────────────────────────────────────────────────
let failed = 0
const pct = a => a && typeof a.noul === 'number' ? Math.round(a.noul * 100) : null
const row = (label, p, bar = 50) => {
  const bad = p != null && p < bar
  if (bad) failed++
  console.log(`  ${bad ? '✗' : '✓'} ${String(p == null ? '—' : p + '%').padStart(4)}  ${label}`)
}
console.log(`ship-judge · ${spec} · ${Object.keys(questions).length} judgment(s) · $${(out.usage?.cost || 0).toFixed(5)}`)
for (const m of messages) row(`commit ${m.sha} says why — ${m.text.split('\n')[0].slice(0, 70)}`, pct(out.answers[`why_${m.sha}`]))
readme.forEach((r, i) => {
  row(`${r.where}: written for a user — ${(r.title || r.body).slice(0, 60)}`, pct(out.answers[`plain_${i}`]))
  row(`${r.where}: says what they can do`, pct(out.answers[`cando_${i}`]))
})
if (notes) row('release notes written for users', pct(out.answers.notes_user))
codeDiffs.forEach((c, i) => {
  row(`${c.file}: no likely bug`, pct(out.answers[`bug_${i}`]) == null ? null : 100 - pct(out.answers[`bug_${i}`]), 30)
  row(`${c.file}: no security or privacy hole`, pct(out.answers[`sec_${i}`]) == null ? null : 100 - pct(out.answers[`sec_${i}`]), 30)
  const unsaid = pct(out.answers[`unsaid_${i}`]), untested = pct(out.answers[`untested_${i}`])
  if (unsaid != null && unsaid >= 60) console.log(`  ⚠ ${String(unsaid + '%').padStart(4)}  ${c.file}: changes something users would notice that the message does not say`)
  if (untested != null && untested >= 60) console.log(`  ⚠ ${String(untested + '%').padStart(4)}  ${c.file}: logic changed with no test in the diff`)
})
console.log(failed ? `\n${failed} judgment(s) below the bar — rewrite before it ships` : '\nall judgments pass')
process.exit(failed ? 1 : 0)
