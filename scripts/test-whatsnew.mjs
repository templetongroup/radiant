import { readFileSync } from 'node:fs'
import { WHATS_NEW, whatsNewSince, cmpVersion } from '../src/whatsnew.js'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }
const vs = r => r.map(e => e.version)

// ⚠️ STRING COMPARISON IS WRONG AND LOOKS RIGHT FOR A LONG TIME. '0.6.9' > '0.6.10'
// alphabetically, so somewhere past .10 the screen would quietly stop appearing.
ok(cmpVersion('0.6.9', '0.6.10') < 0, '0.6.9 is older than 0.6.10, numerically')
ok(cmpVersion('0.6.227', '0.6.227') === 0, 'a version equals itself')
ok(cmpVersion('0.7.0', '0.6.999') > 0, 'the minor number outranks the patch')
ok(cmpVersion('0.6.1', '0.6.1.0') === 0, 'a missing part counts as zero')

ok(whatsNewSince(null, '0.6.227').length === 0,
   'a fresh install is shown nothing — it has not met the old features, let alone the new ones')
ok(whatsNewSince('0.6.227', '0.6.227').length === 0, 'no update, nothing to say')
ok(whatsNewSince('0.6.230', '0.6.227').length === 0,
   'running an OLDER build than last time says nothing rather than replaying history')

ok(vs(whatsNewSince('0.6.226', '0.6.227')).join() === '0.6.227', 'one release shows that release')
ok(vs(whatsNewSince('0.6.220', '0.6.227')).join() === '0.6.227,0.6.225,0.6.223,0.6.221',
   'jumping several versions shows all of them, newest first — updates install on quit and several can pass while a laptop is shut')
ok(whatsNewSince('0.6.221', '0.6.227').every(e => e.version !== '0.6.221'),
   'the version you were already on is not repeated')
ok(whatsNewSince('0.6.220', '0.6.223').every(e => cmpVersion(e.version, '0.6.223') <= 0),
   'nothing from the future leaks in — an entry written ahead of a release stays hidden until it ships')

// Every entry is shaped for a person, not a changelog.
for (const e of WHATS_NEW) {
  ok(/^\d+\.\d+\.\d+$/.test(e.version), `${e.version} is a real version number`)
  ok(e.items.length > 0 && e.items.length <= 4, `${e.version} has 1–4 items, not a wall of text`)
  for (const [title, body] of e.items) {
    ok(title.length > 0 && title.length < 70, `"${title.slice(0, 40)}" is a headline, not a paragraph`)
    ok(body.length > 30, `${e.version}: "${title.slice(0, 30)}" actually explains itself`)
    ok(!/[A-Za-z]\.[a-z]+\(|\bconst\b|=>/.test(body), `${e.version}: "${title.slice(0, 30)}" has no code in it`)
  }
}
ok(WHATS_NEW.every((e, i, a) => i === 0 || cmpVersion(a[i - 1].version, e.version) > 0),
   'the list is newest-first and has no duplicates')

// ⚠️ THE LIST MUST NOT DRIFT FROM THE APP, which is exactly what happened to the
// Read me before it was checked. A release that adds a feature and forgets to say so
// does not build.
// ⚠️ AN OVERLAY MUST NOT BE A CHILD OF THE APP LAYOUT. Rendered inside .app this
// dialog became a flex item: styles.css has `.app > *:not(.motion-bg) { position:
// relative }`, which outranks a single-class `position: fixed`, so the backdrop
// claimed a column. The sidebar jumped from x 0 to x 1152 while the dialog was
// open and snapped back on dismiss, and the dialog centred in the leftover space
// instead of the window. Tony: "the nav bar shifts over to the right. looks bad."
const wn = readFileSync('src/components/WhatsNew.jsx', 'utf8')
ok(/createPortal\(/.test(wn), 'the dialog renders through a portal, outside the app layout')
ok(/document\.body\)/.test(wn), 'and lands on document.body, where no flex parent can size it')
ok(!/return \(\s*<div className='wn-backdrop'/.test(wn),
   'it is not returned as a plain child of the app tree')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
ok(WHATS_NEW.some(e => e.version === pkg.version),
   `this build (${pkg.version}) has a what's-new entry — add one to src/whatsnew.js`)

console.log(`  ${pass}/${pass + fail} passed  ·  shown once, on the version it changed in`)
process.exit(fail ? 1 : 0)
