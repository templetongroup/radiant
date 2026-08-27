#!/usr/bin/env node
// Supply-chain gate.
//
// ⚠️ RADIANT IS SIGNED WITH TONY'S DEVELOPER ID AND RUNS SHELL COMMANDS. A
// dependency that turns malicious does not merely misbehave — it executes on his
// Mac, with his permissions, inside an app macOS has been told to trust. That is
// a different threat model from a web app, and it is why these checks exist.
//
// Three things are enforced:
//   1. Direct dependencies are pinned to exact versions. A floating range moves
//      silently on any `npm i`; express, ws, vite and five others had already
//      drifted off their declared floors before this landed.
//   2. Only reviewed packages may run install scripts. Lifecycle scripts are the
//      main way a poisoned package gets to execute at all.
//   3. Nothing installed was published in the last two days. Almost every npm
//      compromise follows one shape: maintainer account taken over, bad version
//      published, thousands install within hours. Waiting gives the ecosystem
//      time to notice. (Pi suggests `min-release-age=2` in .npmrc — npm does not
//      support that key and ignores it silently, so it is done here instead.)
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

const MIN_AGE_DAYS = 2

// Packages allowed to run install/preinstall/postinstall scripts, and why.
// Adding to this list is a decision, not a formality: read what the script does.
const LIFECYCLE_ALLOWED = {
  'node-pty': 'native pty bindings — compiles the terminal',
  esbuild: 'downloads its platform binary — vite depends on it',
  'electron-winstaller': 'windows installer tooling, pulled in by electron-builder'
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const direct = { ...pkg.dependencies, ...pkg.devDependencies }
const fail = []
const note = []

// 1. pinned
const floating = Object.entries(direct).filter(([, v]) => !/^\d+\.\d+\.\d+/.test(v))
if (floating.length) fail.push(`not pinned to an exact version: ${floating.map(([k, v]) => `${k}@${v}`).join(', ')}`)
console.log(`  ${floating.length ? '✗' : '✓'} all ${Object.keys(direct).length} direct dependencies pinned to exact versions`)

// 2. lifecycle scripts
const withScripts = []
for (const d of readdirSync('node_modules')) {
  if (d.startsWith('.')) continue
  const names = d.startsWith('@') ? readdirSync(path.join('node_modules', d)).map(x => `${d}/${x}`) : [d]
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(path.join('node_modules', n, 'package.json'), 'utf8')).scripts || {}
      if (s.install || s.postinstall || s.preinstall) withScripts.push(n)
    } catch {}
  }
}
const unreviewed = withScripts.filter(n => !(n in LIFECYCLE_ALLOWED))
if (unreviewed.length) {
  fail.push(`packages run install scripts and are not on the reviewed list: ${unreviewed.join(', ')}\n` +
            '    Read what each script does, then add it to LIFECYCLE_ALLOWED with a reason.')
}
console.log(`  ${unreviewed.length ? '✗' : '✓'} ${withScripts.length} packages run install scripts, all reviewed`)

// 3. nothing published in the last MIN_AGE_DAYS
const cutoff = Date.now() - MIN_AGE_DAYS * 86400_000
let checked = 0
let unreachable = 0
const tooNew = []
await Promise.all(Object.keys(direct).map(async name => {
  const version = direct[name]
  try {
    // ⚠️ NOT THE ABBREVIATED PACKUMENT. npm's install-v1 metadata is smaller and
    // omits `time` entirely, so asking for it made every check silently return
    // "could not be checked" — a gate reporting success while verifying nothing.
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) { unreachable++; return }
    const published = (await res.json())?.time?.[version]
    if (!published) { unreachable++; return }
    checked++
    const age = (Date.now() - Date.parse(published)) / 86400_000
    if (Date.parse(published) > cutoff) tooNew.push(`${name}@${version} published ${age.toFixed(1)} days ago`)
  } catch { unreachable++ }
}))
if (tooNew.length) {
  fail.push(`published less than ${MIN_AGE_DAYS} days ago:\n    ${tooNew.join('\n    ')}\n` +
            '    Wait, or pin the previous version. A brand-new release is when a compromise is live.')
}
const noneChecked = checked === 0 && Object.keys(direct).length > 0
console.log(`  ${tooNew.length || noneChecked ? '✗' : '✓'} ${checked} versions confirmed older than ${MIN_AGE_DAYS} days` +
            (unreachable ? ` (${unreachable} could not be checked)` : ''))
// ⚠️ VERIFYING NOTHING IS NOT PASSING. The first run of this gate checked zero
// packages and printed a tick, because a wrong request header meant every lookup
// came back empty. If not one package could be confirmed, the check is broken,
// not satisfied.
if (noneChecked) fail.push('not one dependency could be checked against the registry — the age check is not working, do not treat it as passed')
// Unreachable is a warning, not a failure: a network blip must not block a
// release, while a CONFIRMED too-new package must.
if (unreachable) note.push(`${unreachable} package(s) could not be checked against the registry — offline or rate-limited`)

console.log('')
for (const n of note) console.log(`  note: ${n}`)
if (fail.length) {
  console.error('\nsupply-chain gate FAILED:\n' + fail.map(f => '  ✗ ' + f).join('\n'))
  process.exit(1)
}
console.log('supply-chain checks passed')
