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

console.log(`\n${pass}/${pass + fail} passed  ·  the keyboard is counted once`)
process.exit(fail ? 1 : 0)
