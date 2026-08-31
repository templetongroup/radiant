// Chrome anchored above the composer must count the keyboard ONCE.
//
// ⚠️ THIS SHIPPED. The skill bar had --rx-kb in `bottom` AND the composer's
// translate3d(-kb), so raising the keyboard lifted it by two keyboard heights
// and it floated in the middle of the transcript, over the model's name. Tony:
// "the skill button floats at the top of the chat when you start typing."
// A screenshot is the only way to see it, and only with a keyboard up — so it
// is asserted from the stylesheet instead.
import { readFileSync } from 'node:fs'

// ⚠️ STRIP COMMENTS FIRST. The rule this guards carries a comment explaining
// the bug — which contains the words "bottom: 0" — and reading it as CSS made
// the check fail on correct code.
const css = (readFileSync('src/mobile/mobile.css', 'utf8') + readFileSync('src/mobile/MobileChat.jsx', 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${name}`) } }

const ruleFor = (sel) => {
  const m = new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}').exec(css)
  return m ? m[1] : null
}
const has = (body, prop) => {
  const m = new RegExp(prop + ':([^;]*)').exec(body || '')
  return m ? m[1] : ''
}

// The composer is the anchor: bottom:0, moved by transform.
const composer = ruleFor('.rx-chat-composer')
ok('the composer exists', Boolean(composer))
ok('the composer moves by transform', /--rx-kb/.test(has(composer, 'transform')))
ok('and is not also offset by bottom', !/--rx-kb/.test(has(composer, 'bottom')))

// Everything anchored ABOVE it offsets by bottom, and must not transform too.
for (const sel of ['.rx-chat-skillbar', '.rx-chat-slash', '.rx-chat-jump']) {
  const body = ruleFor(sel)
  ok(`${sel} exists`, Boolean(body))
  const b = has(body, 'bottom'), t = has(body, 'transform')
  ok(`${sel} offsets for the keyboard`, /--rx-kb/.test(b))
  ok(`${sel} does NOT count the keyboard twice`, !/--rx-kb/.test(t))
}


// ── ⚠️ NO BACKTICK INSIDE A CSS TEMPLATE LITERAL ────────────────────────────
// Both phone stylesheets are template literals in .jsx files. A backtick in one
// of their COMMENTS — writing `margin: auto` or the slash command `/` in prose —
// closes the literal early, the rest parses as JavaScript, and <style> renders
// something that is not CSS. It has happened twice in one day, once costing
// every chat style on the phone. Rule 19, checked instead of remembered.
for (const file of ['src/mobile/MobileChat.jsx', 'src/mobile/MobileShell.jsx']) {
  const src = readFileSync(file, 'utf8')
  const m = /const [A-Z_]*CSS = `/.exec(src)
  ok(`${file} has a CSS literal`, Boolean(m))
  if (!m) continue
  const rest = src.slice(m.index + m[0].length)
  let i = 0, len = 0
  while (i < rest.length) {
    if (rest[i] === '\\') { i += 2; continue }
    if (rest[i] === '`') break
    i++; len++
  }
  // A CSS block this small means the literal closed on a stray backtick.
  ok(`${file}'s CSS literal is whole (${len} chars)`, len > 3000)
}

// ── following must survive the keyboard ──────────────────────────────────────
// ⚠️ THIS SHIPPED TOO. onScroll assigned `follow.current = near` unconditionally.
// Opening the keyboard grows the transcript's bottom padding by the keyboard's
// height, so scrollHeight jumps and `near` goes false with nobody having
// scrolled — following switched itself off and the reply streamed in below the
// fold. Tony: "the message box doesnt move up when model responds. i have to
// close text, then scroll chat up to read it."
//
// A layout change is not an intent. Only a finger may turn following off.
const jsx = readFileSync('src/mobile/MobileChat.jsx', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

ok('following is never assigned straight from `near`',
   !/follow\.current\s*=\s*near\b/.test(jsx))
ok('reaching the bottom re-arms following',
   /if\s*\(\s*near\s*\)\s*follow\.current\s*=\s*true/.test(jsx))
ok('following is only turned off while the user is driving',
   /else\s+if\s*\(\s*userDriving\.current\s*\)\s*follow\.current\s*=\s*false/.test(jsx))
ok('the keyboard hiding re-sticks, because the bottom moves up under us',
   /keyboardWillHide[\s\S]{0,400}?follow\.current[\s\S]{0,120}?stick\(\)/.test(jsx))

console.log(`\n${pass}/${pass + fail} passed  ·  the keyboard is counted once`)
process.exit(fail ? 1 : 0)
