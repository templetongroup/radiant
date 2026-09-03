/**
 * The AppleScript path to the user's own Chrome.
 *
 * ⚠️ THIS EXISTS BECAUSE CDP CANNOT REACH THAT BROWSER AND NEVER WILL AGAIN.
 * Chrome 136 removed --remote-debugging-port for the default profile. Measured on
 * Chrome 152: the flag is on the running process and nothing listens on 9222, with
 * no error anywhere. Every attach failed, Playwright launched a fresh browser, and
 * the agent described an empty stranger's Chrome — or blamed macOS permissions.
 *
 * The two things that actually break in this layer are quoting and delimiters, and
 * both are checked here without touching the user's browser.
 */
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }

const src = readFileSync('server/chrome-osa.js', 'utf8')

// ── Quoting: three nested contexts, so nothing may be concatenated ──────────
// A URL or a JS snippet pasted into AppleScript source breaks on the first
// apostrophe, backslash or newline — which is to say, on real web pages.
ok(/execute active tab of front window javascript \(item 1 of argv\)/.test(src),
   'JavaScript reaches Chrome as an argv item, never spliced into the script text')
ok(!/javascript\s+"\s*\$\{/.test(src) && !/javascript \(" \+/.test(src),
   'no template or concatenation builds the javascript string')
ok(/set URL of active tab of front window to \(item 1 of argv\)/.test(src),
   'the URL is an argv item too')

// And prove argv really is byte-for-byte, with the things that break quoting.
const nasty = [
  `it's a "quoted" string`,
  'back\\slash and \\"escaped\\"',
  'multi\nline\ttabbed',
  'unicode — em dash, emoji 🎤, ¥€$',
  `'); DROP TABLE tabs; --`,
  'a'.repeat(4000)
]
for (const v of nasty) {
  const { stdout } = await execFileP('osascript', ['-e', 'on run argv\nreturn item 1 of argv\nend run', v])
  const got = stdout.replace(/\n$/, '')
  const want = v.replace(/\n/g, '\r')   // osascript normalises newlines on the way back
  ok(got === v || got === want,
     `argv survives: ${JSON.stringify(v.slice(0, 32))} — got ${JSON.stringify(got.slice(0, 32))}`)
}

// ── The delimiter bug, which shipped for one build ─────────────────────────
// Inside `tell application "Google Chrome"`, `tab` is Chrome's TAB CLASS, not the
// tab character, so the separator silently evaluated to nothing and every field of
// all 87 rows came back empty.
ok(/set d to character id 9/.test(src),
   'the tab separator is asked for by character id, which no app dictionary can redefine')
ok(!/& tab &/.test(src),
   'the bare word `tab` is never used as a separator inside a Chrome tell block')

// ── The tools the agent is offered ────────────────────────────────────────
const ct = await import('../server/computer-tools.js')
for (const n of ['browser_tabs', 'browser_select_tab', 'browser_click_text']) {
  ok(ct.COMPUTER_TOOL_NAMES.has(n), `${n} is offered to the agent`)
}
ok(ct.COMPUTER_SAFE.has('browser_tabs'),
   'listing tabs is read-only and does not ask for approval')
const tabsDef = ct.COMPUTER_TOOL_DEFS.find(t => t.name === 'browser_tabs')
ok(/signed-in|logged in/i.test(tabsDef.description),
   "the description tells the model these are the user's LOGGED-IN pages, which the launched browser is not")

// ── The honest failure ────────────────────────────────────────────────────
const cts = readFileSync('server/computer-tools.js', 'utf8')
ok(/can't photograph your own Chrome/.test(cts),
   'browser_screenshot says it cannot picture the user\'s Chrome rather than returning a different browser')
ok(/Allow JavaScript from Apple Events/.test(src),
   'the one toggle a user may need to flip is named exactly, not guessed at')
ok(/Privacy & Security › Automation/.test(src),
   'and so is the Automation permission, with its real path')

console.log(`  ${pass}/${pass + fail} passed  ·  the browser the user is signed into`)
process.exit(fail ? 1 : 0)
