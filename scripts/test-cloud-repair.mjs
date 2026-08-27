// Repairing an iCloud folder macOS never adopted.
//
// ⚠️ THIS MOVES A USER'S ENTIRE SETUP. It is the one operation in Radiant that
// can lose every project, chat and agent at once, so every failure path has to
// put things back exactly as they were — rule 10, copy-verify-swap, and never
// delete first. `cloudStatus` is injected so the broken Mac can be simulated.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, chmodSync } from 'fs'
import { tmpdir, homedir } from 'os'
import path from 'path'
import { repairCloudFolder } from '../server/config.js'

let pass = 0, fail = 0
const is = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want)
  if (a === b) { pass++; return }
  fail++; console.log(`  FAIL ${name}\n        got:    ${a}\n        wanted: ${b}`)
}
const ok = (name, cond) => is(name, !!cond, true)

// The function only acts on paths inside the real iCloud container, so the
// fixtures are built there and removed again.
const CLOUD = path.join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
const { rmSync } = await import('fs')

const makeSetup = (dir) => {
  mkdirSync(path.join(dir, 'projects'), { recursive: true })
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { themeId: 'violet' } }))
  writeFileSync(path.join(dir, 'projects', 'pr-1.json'), '{"name":"AiOS"}')
  writeFileSync(path.join(dir, 'memory.json'), 'x'.repeat(500))
}
const contents = (dir) => readdirSync(dir).sort().join(',')

// ---- refusals: nothing is touched -----------------------------------------
{
  const outside = mkdtempSync(path.join(tmpdir(), 'radiant-notcloud-'))
  makeSetup(outside)
  const r = repairCloudFolder(outside, { status: () => ({ ubiquitous: true }) })
  is('a folder outside iCloud is refused', r.reason, 'not_icloud')
  is('and is left alone', contents(outside), 'config.json,memory.json,projects')
  rmSync(outside, { recursive: true, force: true })
}
{
  const d = path.join(CLOUD, '.radiant-test-off')
  mkdirSync(d, { recursive: true }); makeSetup(d)
  const r = repairCloudFolder(d, { status: p => ({ ubiquitous: false }) })
  is('iCloud being off is refused', r.reason, 'icloud_off')
  is('and the setup is left alone', contents(d), 'config.json,memory.json,projects')
  rmSync(d, { recursive: true, force: true })
}
{
  const d = path.join(CLOUD, '.radiant-test-fine')
  mkdirSync(d, { recursive: true }); makeSetup(d)
  const r = repairCloudFolder(d, { status: () => ({ ubiquitous: true }) })
  is('a healthy folder is left alone', r.reason, 'already_fine')
  is('and keeps its contents', contents(d), 'config.json,memory.json,projects')
  rmSync(d, { recursive: true, force: true })
}

// ---- the repair itself -----------------------------------------------------
{
  const d = path.join(CLOUD, '.radiant-test-repair')
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true }); makeSetup(d)
  const before = contents(d)
  // The container is live. The folder is asked about twice: once as it is
  // (broken), and again after it has been recreated (adopted).
  let asked = 0
  const status = (p) => {
    if (p !== d) return { ubiquitous: true }
    return { ubiquitous: asked++ > 0 }
  }
  const orig = repairCloudFolder(d, { status, stamp: 'T1' })
  ok('the repair reports success', orig.ok)
  is('the folder still holds everything', contents(d), before)
  is('the settings survived byte for byte', readFileSync(path.join(d, 'config.json'), 'utf8'), JSON.stringify({ settings: { themeId: 'violet' } }))
  is('the project came across', readFileSync(path.join(d, 'projects', 'pr-1.json'), 'utf8'), '{"name":"AiOS"}')
  // ⚠️ THE OLD ONE IS KEPT, NEVER DELETED.
  ok('the old folder was kept', existsSync(orig.kept) && contents(orig.kept) === before)
  rmSync(d, { recursive: true, force: true })
  rmSync(orig.kept, { recursive: true, force: true })
}

// ---- rollback: iCloud still will not adopt the new folder -------------------
{
  const d = path.join(CLOUD, '.radiant-test-rollback')
  rmSync(d, { recursive: true, force: true })
  mkdirSync(d, { recursive: true }); makeSetup(d)
  const before = contents(d)
  // the container is live but the fresh folder is never adopted either
  const r = repairCloudFolder(d, { status: p => ({ ubiquitous: p === CLOUD }), stamp: 'T2' })
  is('an unadopted new folder rolls back', r.reason, 'rolled_back')
  ok('and says nothing was moved', /put back exactly as it was/.test(r.message))
  // ⚠️ THE WHOLE POINT: his setup is still there, in the original place.
  is('the original folder is back', contents(d), before)
  is('with the settings intact', readFileSync(path.join(d, 'config.json'), 'utf8'), JSON.stringify({ settings: { themeId: 'violet' } }))
  ok('and no stray copy was left behind', !existsSync(`${d}-not-syncing-T2`))
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} passed  ·  the repair puts things back when it cannot finish`)
process.exit(fail ? 1 : 0)
