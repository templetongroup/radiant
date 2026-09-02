/**
 * Things that work in a browser and are DEAD in the packaged Electron app.
 *
 * ⚠️ THIS EXISTS BECAUSE 0.6.112 SHIPPED A BUTTON THAT DID NOTHING. "New
 * project" was wired to window.prompt(), verified in Chrome where it works
 * perfectly, and released. Electron does not implement prompt() — it throws
 * "prompt() is not supported" — so in the app Tony actually runs, the button
 * was inert. electron/main.cjs had carried a comment saying exactly this since
 * the workspace chip needed a native folder picker for the same reason.
 *
 * A comment nobody greps is not a guardrail. This is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
const results = []
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  if (!ok) results.push(`  FAIL ${name}\n        got:    ${JSON.stringify(got)}\n        wanted: ${JSON.stringify(want)}`)
}

const files = []
;(function walk (dir) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e)
    if (statSync(f).isDirectory()) { if (e !== 'assets') walk(f) }
    else if (/\.(jsx?|mjs)$/.test(e)) files.push(f)
  }
})('src')

// window.prompt is not implemented in Electron. The ONLY tolerable use is as
// the else-branch of a window.radiantNative check — that branch is unreachable
// in the packaged app and exists for the same UI served to a browser or phone.
// Anything else is a control that will silently do nothing.
const prompts = []
const guarded = []
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // Skip the warnings that talk ABOUT it — a gate that cannot tell code from
    // prose cries wolf and then gets ignored.
    if (/^\s*(\/\/|\*)/.test(line)) return
    if (!/\bwindow\.prompt\s*\(/.test(line)) return
    const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
    ;(/radiantNative/.test(near) ? guarded : prompts).push(`${f}:${i + 1}`)
  })
}
is('no unguarded window.prompt — Electron does not implement it', prompts, [])
// And the guarded one must really be guarded: if the native check is ever
// dropped, the line above starts failing instead of quietly going dead.
is('the workspace-folder fallback is behind a native check', guarded.length, 1)

// The renderer must not assume a browser-only global exists.
const banned = [
  ['window.open(', /(?<!\/\/.*)\bwindow\.open\s*\(/],
  ['showModalDialog', /showModalDialog\s*\(/]
]
for (const [label, re] of banned) {
  const hits = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return
      if (re.test(line)) hits.push(`${f}:${i + 1}`)
    })
  }
  if (label === 'showModalDialog') is(`nothing calls ${label}`, hits, [])
  else pass++ // window.open is legitimate for external links; counted, not banned
}

// ⚠️ SETTINGS MUST NOT BE A CHILD WINDOW. On macOS a BrowserWindow with `parent`
// is ATTACHED to it: always floating above, and dragged along when the parent
// moves. Tony: "when the settings window is open and i move the main window
// behind it, the settings window seems stuck to it. they move together."
// The only thing `parent` gave us was closing together, which is now explicit.
{
  const main = readFileSync('electron/main.cjs', 'utf8')
  const decls = main.split('new BrowserWindow(')
  const settings = decls.find(d => /title: 'Radiant Settings'/.test(d)) || ''
  is('the settings window exists', settings.length > 0, true)
  // Read the options object, not the whole file — `parent` appears in prose too.
  const opts = settings.slice(0, settings.indexOf('})'))
  is('and is not parented to the main window', /^\s*parent:/m.test(opts), false)
  // Nothing else closes it now, and an orphan holds a half-dead app on screen.
  const onClosed = main.slice(main.indexOf("win.on('closed'"), main.indexOf("win.on('closed'") + 420)
  is('but it still closes with the main window', /settingsWin.*close\(\)/s.test(onClosed), true)
}

console.log(results.join('\n'))
console.log(`${pass}/${pass + fail} passed  ·  no browser-only APIs in the renderer`)
process.exit(fail ? 1 : 0)
