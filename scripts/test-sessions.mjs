// Sessions: what is running, and what archiving protects.
//
// Both behaviours arrived as pull requests from justinsail and are asserted here
// because neither is visible from the sidebar alone: `active` is in-memory
// state, and the whole point of archiving is that nothing is destroyed.
//
// ⚠️ RUNS AGAINST ITS OWN DATA DIRECTORY. Radiant.app holds port 5834 whenever
// it is open, so a test pointed there silently probes the INSTALLED build rather
// than the working tree — which is exactly what happened the first time, and the
// results looked like the feature had not been written.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'radiant-sessions-'))
const PORT = 5847
const B = `http://127.0.0.1:${PORT}`
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) },
  stdio: 'ignore'
})
const stop = () => { try { server.kill() } catch {} ; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', stop)

const j = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return { s: r.status, b: await r.json().catch(() => null) }
}
// ⚠️ WAIT FOR A REAL ANSWER, not merely for fetch to stop throwing. Accepting
// the first response ran the assertions against a server still starting up, and
// they failed in a way that looked like the feature was missing.
let ready = false
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(B + '/api/version')
    if (r.ok && (await r.json())?.version) { ready = true; break }
  } catch { /* not listening yet */ }
  await new Promise(r => setTimeout(r, 250))
}
if (!ready) { console.log('  the test server never came up'); stop(); process.exit(1) }

let pass = 0, fail = 0
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${x}`) } }

const act = await j('GET', '/api/active')
ok('/api/active answers with the live set', act.s === 200 && Array.isArray(act.b?.active))
ok('and a count beside it', typeof act.b?.count === 'number')

const id = (await j('POST', '/api/sessions', { title: 'probe' })).b.id
const one = () => j('GET', '/api/sessions').then(r => r.b.find(s => s.id === id))

let s = await one()
ok('every session reports whether a turn is running', 'active' in s)
ok('an idle session is not active', s.active === false)
ok('a new session is not archived', s.archived === false)

await j('PATCH', '/api/sessions/' + id, { archived: true })
s = await one()
ok('archiving sets the flag', s.archived === true)
// The point of the feature: hidden, not destroyed.
ok('the transcript stays on disk', (await j('GET', '/api/sessions/' + id)).s === 200)
const found = await j('GET', '/api/sessions-search?q=probe')
ok('and stays findable by search', Array.isArray(found.b) && found.b.some(x => x.id === id))
const all = (await j('GET', '/api/sessions')).b
ok('archived sorts below everything live', all.slice(all.findIndex(x => x.id === id)).every(x => x.archived))

await j('PATCH', '/api/sessions/' + id, { archived: false })
ok('restoring is one call', (await one()).archived === false)
ok('delete is still permanent', await j('DELETE', '/api/sessions/' + id).then(() => j('GET', '/api/sessions/' + id)).then(r => r.s === 404))

// The sidebar must not leak an archived session back through another view.
const sidebar = await import('node:fs').then(m => m.readFileSync('src/components/Sidebar.jsx', 'utf8'))
ok('the sidebar splits live from archived', /const live = React\.useMemo/.test(sidebar))
ok('and no view reads the raw list',
   !/(sessions\.filter\(s => s\.agentId|sessions\.map\(s => <SessionRow)/.test(sidebar))
ok('the row archives rather than deletes', /title='Archive'/.test(sidebar))
// ⚠️ THE ICON MUST MEAN WHAT THE BUTTON DOES. Archiving shipped behind a ✕,
// which every interface uses for delete — so the one control that KEEPS your
// chat looked like the one that destroys it. Tony: "To me an X means delete."
ok('archiving is not a ✕', !/onArchive\(s\.id, true\) \}\}>✕/.test(sidebar))
ok('archiving uses the archive icon', /onArchive\(s\.id, true\)[\s\S]{0,80}Icon\.archive/.test(sidebar))
ok('restoring uses the unarchive icon', /onArchive\(s\.id, false\)[\s\S]{0,120}Icon\.unarchive/.test(sidebar))
ok('permanent delete uses the bin', /Delete permanently[\s\S]{0,400}Icon\.trash/.test(sidebar))
// Unicode glyphs render as tofu or the wrong picture; the app has its own set.
// Scoped to the CHAT row's controls only: the project row's ✕ is a real delete
// and should stay a ✕.
{
  // ⚠️ STRIP COMMENTS FIRST — the same trap test-keyboard-offset documents. The
  // rule this guards is explained in a comment that NAMES the glyphs it forbids,
  // so reading the raw source failed on correct code.
  const rowActions = sidebar
    .slice(sidebar.indexOf("className='session-actions'"), sidebar.indexOf('</div>', sidebar.indexOf('Delete permanently')))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  ok('no Unicode glyphs left on the chat row controls', !/[✕🗑⤺🗀🗂]/.test(rowActions))
}
const icons = await import('node:fs').then(m => m.readFileSync('src/components/Icons.jsx', 'utf8'))
ok('the icon set actually defines them', /archive:/.test(icons) && /unarchive:/.test(icons) && /trash:/.test(icons))
ok('and a permanent delete lives only in the archive', /Delete permanently/.test(sidebar))

console.log(`\n  ${pass}/${pass + fail} passed  ·  its own data directory, not yours`)
stop()
process.exit(fail ? 1 : 0)
