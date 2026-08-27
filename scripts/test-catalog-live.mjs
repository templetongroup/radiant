/**
 * The phone's model catalogue, checked against Hugging Face.
 *
 * ⚠️ THE SHIPPED LIST IS HAND-WRITTEN SWIFT, NOT A GENERATED FILE. Every row in
 * LocalModels.swift carries a size the picker shows and the fit badge reasons
 * about ("Runs well" / "Won't run"). Nothing was checking those against
 * reality, so a repo that is renamed, deleted, or requantised would keep being
 * offered at a size that is no longer true — and the user finds out after the
 * download. Tony: "iphone model list should update on every new build, no?"
 *
 * This is the half that CAN be automatic. What cannot: adding a new model needs
 * a maker, a written blurb, an architecture MLX Swift actually supports, and
 * the right stop token — so new models are reported here as candidates and
 * added by a person.
 *
 * ⚠️ NEVER PRINT A TICK HAVING VERIFIED NOTHING. If the network or the MLX
 * checkout is missing, this fails loudly rather than passing empty — the exact
 * way the supply-chain gate lied on its first run.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const swift = readFileSync('apps/ios/ios/App/App/plugins/LocalModels.swift', 'utf8')
const entries = [...swift.matchAll(
  /Entry\(id: "([^"]+)", name: "([^"]+)", maker: "([^"]+)",\s*\n\s*blurb: "([^"]*)",\s*\n\s*gb: ([\d.]+), config: ([^\n]+?)\)?,?\n/g
)].map(m => ({ id: m[1], name: m[2], maker: m[3], gb: parseFloat(m[5]), config: m[6].trim() }))

let pass = 0, fail = 0
const bad = []
const ok = (cond, msg) => { if (cond) pass++; else { fail++; bad.push(msg) } }

ok(entries.length >= 40, `only parsed ${entries.length} entries from LocalModels.swift`)

// ---- resolve every entry to a real repo ------------------------------------
// Half name the repo; the rest point at MLX Swift's own registry, which lives
// in the SPM checkout produced by a build.
const roots = ['/tmp/radiant-ios-dd/SourcePackages/checkouts',
  ...(() => {
    const dd = path.join(homedir(), 'Library/Developer/Xcode/DerivedData')
    try { return readdirSync(dd).filter(d => d.startsWith('App-')).map(d => path.join(dd, d, 'SourcePackages/checkouts')) } catch { return [] }
  })()]
const factory = roots
  .map(r => path.join(r, 'mlx-swift-lm/Libraries/MLXLLM/LLMModelFactory.swift'))
  .find(p => existsSync(p))

const registry = {}
if (factory) {
  const src = readFileSync(factory, 'utf8')
  for (const m of src.matchAll(/static public let (\w+) = ModelConfiguration\(\s*\n\s*id: "([^"]+)"/g)) registry[m[1]] = m[2]
}

const repoOf = e => {
  const direct = /rxRepo\("([^"]+)"/.exec(e.config)
  if (direct) return direct[1]
  const reg = /LLMRegistry\.(\w+)/.exec(e.config)
  return reg ? registry[reg[1]] || null : null
}

const resolved = entries.map(e => ({ ...e, repo: repoOf(e) }))
const unresolved = resolved.filter(r => !r.repo)

if (!factory) {
  console.log('  MLX checkout not found — build the iOS app once so the registry can be read.')
  console.log(`  ${entries.length - resolved.filter(r => r.repo).length} of ${entries.length} entries could not be resolved.`)
  process.exit(1)
}
ok(!unresolved.length, `entries point at registry names that no longer exist: ${unresolved.map(r => `${r.id} (${r.config})`).join(', ')}`)

// ---- what Hugging Face actually says ---------------------------------------
const probe = async (r) => {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${r.repo}?blobs=true`,
      { headers: { 'user-agent': 'radiant-catalog/1' }, signal: AbortSignal.timeout(30000) })
    // ⚠️ 401, NOT 404. Hugging Face answers a repo that does not exist with 401
    // rather than leak whether a private one is there, so treating only 404 as
    // "gone" reports a deleted model as a network problem.
    if (res.status === 404 || res.status === 401 || res.status === 403) return { ...r, gone: true }
    if (!res.ok) return { ...r, err: `HTTP ${res.status}` }
    const m = await res.json()
    const real = +((m.siblings || []).reduce((a, f) => a + (f.size || 0), 0) / 1e9).toFixed(2)
    return { ...r, real }
  } catch (e) { return { ...r, err: e.name } }
}
const checked = []
for (let i = 0; i < resolved.length; i += 8) {
  checked.push(...await Promise.all(resolved.slice(i, i + 8).filter(r => r.repo).map(probe)))
}

// ⚠️ A GATE THAT CHECKED NOTHING IS A GATE THAT LIED.
ok(checked.length >= 40, `only ${checked.length} entries reached Hugging Face`)
const errs = checked.filter(c => c.err)
ok(!errs.length, `could not reach ${errs.length} repos (${errs.slice(0, 3).map(e => e.id).join(', ')})`)
const gone = checked.filter(c => c.gone)
ok(!gone.length, `repos that no longer exist: ${gone.map(g => `${g.id} → ${g.repo}`).join(', ')}`)

// A repo carries several quantisations sometimes, so the claim is a floor, not
// an equality: it must not be BIGGER than what is really there.
const drifted = checked.filter(c => c.real != null && c.real < c.gb - 0.05)
ok(!drifted.length, `sizes claim more than the repo holds: ${drifted.map(d => `${d.id} says ${d.gb} GB, repo is ${d.real} GB`).join('; ')}`)

// ---- what is new that we do not carry ---------------------------------------
// ⚠️ A REPORT, NOT A GATE. A model existing is not a failure, and it must never
// be added automatically: a catalogue entry needs a maker, a written blurb, an
// architecture MLX Swift supports and the right stop token, or the phone
// downloads gigabytes and then cannot run it. This just means nobody has to
// notice by accident.
try {
  const have = new Set(checked.map(c => c.repo.toLowerCase()))
  const res = await fetch('https://huggingface.co/api/models?author=mlx-community&sort=createdAt&direction=-1&limit=100',
    { headers: { 'user-agent': 'radiant-catalog/1' }, signal: AbortSignal.timeout(30000) })
  const rows = res.ok ? await res.json() : []
  const fresh = rows
    .filter(m => !have.has(String(m.id).toLowerCase()))
    .filter(m => /4bit|qat|mobile|8bit/i.test(m.id))
    .filter(m => /instruct|-it\b|-it-|chat/i.test(m.id))
    .filter(m => !/vl|vision|audio|whisper|embed|rerank|coder-.*-base|base-/i.test(m.id))
    .slice(0, 8)
  if (fresh.length) {
    console.log(`\n  new on mlx-community and not in the catalogue (${fresh.length} shown — review, do not paste):`)
    for (const m of fresh) console.log(`    ${m.id}  ·  ${m.downloads || 0} downloads`)
  }
} catch { console.log('\n  (could not check for new models)') }

for (const b of bad) console.log(`  FAIL ${b}`)
const sized = checked.filter(c => c.real != null)
console.log(`\n${pass}/${pass + fail} passed  ·  ${sized.length} models resolved and checked against Hugging Face`)
process.exit(fail ? 1 : 0)
