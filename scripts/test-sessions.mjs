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
import nodeFs, { mkdtempSync, rmSync } from 'node:fs'
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
// ⚠️ TOOLTIPS COME FROM data-tip, NOT title. styles.css has said since it was
// written that "Electron's native title tooltips are slow/flaky" and ships a CSS
// tooltip for that reason — but the chat row's six icon-only controls were still
// on title alone, so none of them explained itself. Tony: "theres no tooltips
// with the session tools including the new archive button".
{
  // ⚠️ ANCHOR ON STRUCTURE, NOT ON A LABEL. This used to slice up to the literal
    // "Delete permanently"; when the bin became a <HoldButton> with a different
    // label, indexOf returned -1 and the slice collapsed to nothing — so the check
    // silently measured an empty string instead of failing honestly.
    const rowStart = sidebar.indexOf("className='session-actions'")
    const rowEnd = sidebar.indexOf('</HoldButton>', rowStart)
    const rowBtns = sidebar.slice(rowStart, rowEnd === -1 ? rowStart : rowEnd)
    // The bin is a <HoldButton>, which takes title and aria-label as props.
    // ⚠️ COUNT ELEMENTS, NOT A PATTERN ACROSS THEM. `<button[^]*?title=` is
    // non-greedy and runs past the end of one tag into the next, so it undercounts
    // — this repo has been bitten by exactly that shape more than once. Split on
    // the tags and ask each one.
    //
    // And ask the real question: does every control expose a NAME? A plain button
    // says title=; a <HoldButton> takes `label` and sets title and aria-label from
    // it. Counting one spelling would fail an accessible control for being
    // spelled differently.
    const tags = rowBtns.split(/<(?=button|HoldButton)/).slice(1)
    const named = tags.filter(t => /\btitle=/.test(t) || /\blabel=/.test(t))
    const withTitle = named.length
    ok('every chat-row control exposes a name', named.length === tags.length,
       `${named.length} named of ${tags.length}`)
  const withTip = (rowBtns.match(/data-tip=/g) || []).length
  ok('every chat-row control has a data-tip', withTip >= withTitle, `${withTip} tips for ${withTitle} buttons`)
  // The controls sit at the TOP of the row; a tooltip above them is clipped.
  ok('and they open downward', (rowBtns.match(/data-tip-below/g) || []).length >= withTip)
  // ⚠️ The bin is a <HoldButton> now, which sets title and aria-label itself from
  // `label`/`holdLabel` — so the literal count here is one lower, and the
  // guarantee moved rather than disappeared. Both are asserted right after.
  ok('title stays too, for screen readers and the web build', withTitle >= 5)
  ok('and the hold button carries both as well', (() => {
    const hb = nodeFs.readFileSync('src/components/HoldButton.jsx', 'utf8')
    return /aria-label=/.test(hb) && /title=/.test(hb)
  })())
}

// ⚠️ THE ICON MUST MEAN WHAT THE BUTTON DOES. Archiving shipped behind a ✕,
// which every interface uses for delete — so the one control that KEEPS your
// chat looked like the one that destroys it. Tony: "To me an X means delete."
ok('archiving is not a ✕', !/onArchive\(s\.id, true\) \}\}>✕/.test(sidebar))
ok('archiving uses the archive icon', /onArchive\(s\.id, true\)[\s\S]{0,80}Icon\.archive/.test(sidebar))
ok('restoring uses the unarchive icon', /onArchive\(s\.id, false\)[\s\S]{0,120}Icon\.unarchive/.test(sidebar))
// The button grew when its native confirm was replaced by a two-click arm, so
// read its element rather than a fixed window of characters after the label.
{
  const at = sidebar.indexOf('<HoldButton')
    const el = at === -1 ? '' : sidebar.slice(at, sidebar.indexOf('</HoldButton>', at))
    ok('permanent delete uses the bin', /Icon\.trash/.test(el))
    ok('and says it must be held', /Hold to delete/.test(el))
}
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
ok('and a permanent delete lives only in the archive', /permanently/.test(sidebar))


// ⚠️ THE DEVICES SCREEN DESCRIBES WHICHEVER MAC IS ANSWERING. When the window is
// borrowing another Mac, /api/share is answered by THAT Mac — so its sharing
// state, address and token rendered under the heading "This Mac does the work".
// Tony, connected to dev-mbp: "it says This mac does the work, but its connected
// to the Dev MBP." The checkbox would also have switched sharing off on the very
// Mac the window depends on.
{
  const settings = await import('node:fs').then(m => m.readFileSync('src/components/Settings.jsx', 'utf8'))
  const role = settings.slice(settings.indexOf('This Mac does the work'), settings.indexOf('This Mac is a window onto another'))
  ok('the "does the work" half is guarded on linked', /\{linked\s*\n?\s*\?/.test(role))
  ok('and it names the Mac actually answering', /server\.base/.test(role))
  ok('the share controls are inside the not-linked branch', role.indexOf('type=\'checkbox\'') > role.indexOf('{linked'))
}


// ⚠️ THE ROW'S TOOLTIPS CANNOT BE CENTRED. The controls sit hard against the
// right edge of a 248px sidebar, and .session-list scrolls — which clips
// horizontally too. A centred tooltip on the last button is cut in half; Tony's
// screenshot showed "Delete perma…". They must grow inward.
{
  const css = await import('node:fs').then(m => m.readFileSync('src/styles.css', 'utf8')).then(t => t.replace(/\/\*[\s\S]*?\*\//g, ''))
  const rule = /\.session-actions \[data-tip\]:hover::after \{([^}]*)\}/.exec(css)?.[1] || ''
  ok('row tooltips are anchored, not centred', /right:\s*0/.test(rule) && /transform:\s*none/.test(rule))
  ok('and they are capped to fit the sidebar', /max-width/.test(rule))
}

// ⚠️ A TURN MUST NOT UNDO WHAT YOU DID WHILE IT RAN. /api/chat loads the session
// when the turn starts and writes the whole object back when it ends, minutes
// later. Moving the chat to a project mid-turn wrote projectId to disk via its
// own PATCH, and the turn's stale copy then overwrote it with null. Tony:
// "during a chat, i moved it into the Templeton Group project and something
// moved it out to No Project. thats a real problem." Same shape as the
// removedAgents bug: a long-lived in-memory object clobbering a concurrent write.
{
  process.env.RADIANT_DIR = dir
  const cfg = await import('../server/config.js')
  cfg.saveSession({ id: 'sess-mid', title: 'Before', projectId: null, autoTitle: true, messages: [] })

  const turn = cfg.loadSession('sess-mid')            // the turn takes its copy

  const live = cfg.loadSession('sess-mid')            // the user, mid-turn
  live.projectId = 'proj-1'; live.pinned = true; live.archived = true
  live.title = 'Renamed by hand'; live.autoTitle = false
  cfg.saveSession(live)

  turn.messages.push({ role: 'assistant', content: 'done' })
  turn.title = 'Auto-title from the first message'
  cfg.saveTurnSession(turn)

  const after = cfg.loadSession('sess-mid')
  ok('a chat moved to a project mid-turn stays there', after.projectId === 'proj-1', JSON.stringify(after.projectId))
  ok('pinning mid-turn survives', after.pinned === true)
  ok('archiving mid-turn survives', after.archived === true)
  ok('a manual rename beats the auto-title', after.title === 'Renamed by hand', JSON.stringify(after.title))
  ok('and the turn still saved its transcript', (after.messages || []).length === 1)
}

// ⚠️ DELETING FOREVER IS A HOLD NOW, NOT A SECOND CLICK. window.confirm is a
// no-op in these windows, which is why this was a two-click arm — but the second
// click lands on a button whose meaning changed under the pointer, and Tony has
// twice reported one that "did nothing" when it had re-armed. A hold has no
// second click to miss, and letting go leaves no trace.
{
  const hfs = await import('node:fs')
  const hb = hfs.readFileSync('src/components/HoldButton.jsx', 'utf8')
  ok('the hold only fires when it completes', /if \(p >= 1\)/.test(hb))
  ok('letting go cancels it outright', /onPointerUp=|onPointerLeave=/.test(hb))
  ok('and it fires once, not once per frame', /done\.current/.test(hb))
  // A control you can only work by holding a mouse button is one some people
  // cannot work at all, and every session row here is reachable by tab.
  ok('holding a key works too', /onKeyDown=/.test(hb) && /onKeyUp=/.test(hb))
  ok('Space does not scroll the list instead', /preventDefault\(\)/.test(hb))
  // ⚠️ The ring must be a real element: these buttons carry data-tip, and the CSS
  // tooltip IS ::after — a ring drawn there is never painted. It shipped that way
  // for one build: --hold counted up correctly and nothing appeared on screen.
  ok('the ring is a real element, not ::after', /className='hold-ring'/.test(hb))

  const hcss = hfs.readFileSync('src/styles.css', 'utf8')
  ok('and the stylesheet draws that element', /\.hold-btn \.hold-ring/.test(hcss))
  ok('filled from the live progress value', /var\(--hold\)/.test(hcss))
  {
    // The ring may stop animating under Reduce Motion; the DELAY must not shrink.
    const at = hcss.indexOf('prefers-reduced-motion', hcss.indexOf('.hold-btn.is-holding .hold-ring'))
    const body = at === -1 ? '' : hcss.slice(at, at + 320)
    ok('Reduce Motion does not shorten the hold', !/--hold|transition-duration:\s*0s/.test(body))
  }

  const sb = hfs.readFileSync('src/components/Sidebar.jsx', 'utf8')
  ok('the archive bin uses it', /<HoldButton/.test(sb))
  ok('and the old two-click arm is gone', !/armedDelete/.test(sb))
}

// ⚠️ THE SIDEBAR HEADINGS ARE NO LONGER BOLD — Tony's call — so the size step is
// now doing the work on its own. Project names, "No project", "Archived", agent
// names and "No agent" all share .bot-head-name, and it sits directly above chat
// rows. Shrink it to the rows' size and a heading becomes just another chat.
{
  const bfs = await import('node:fs')
  const bcss = bfs.readFileSync('src/styles.css', 'utf8')
  const head = /^\.bot-head-name \{([^}]*)\}/m.exec(bcss)?.[1] || ''
  const row = /^\.session-title-text \{([^}]*)\}/m.exec(bcss)?.[1] || ''
  const px = t => Number((/font-size:\s*([\d.]+)px/.exec(t) || [])[1])
  ok('headings are regular weight', /font-weight:\s*400/.test(head), head.trim().slice(0, 60))
  ok('and still larger than the rows beneath them', px(head) > px(row), `${px(head)}px vs ${px(row)}px`)
  // Colour is the other half: rows are muted, headings are full-strength ink.
  ok('and brighter than them', /color:\s*var\(--text\)/.test(head))
}

console.log(`\n  ${pass}/${pass + fail} passed  ·  its own data directory, not yours`)
stop()
process.exit(fail ? 1 : 0)
