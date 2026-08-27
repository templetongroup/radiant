// Slash commands on the phone.
//
// ⚠️ THIS GATE EXISTS BECAUSE THE FEATURE WAS MISSING, NOT BROKEN. `/plain-english`
// worked on the Mac and did nothing on iPhone — it went to the model as literal
// text — because the phone's composer had no slash handling at all. Tony:
// "the slash command is not working in ios". Assertions, not a phone.
import { slug, slashMatches, parseSlash } from '../src/mobile/skills.js'

let pass = 0, fail = 0
const is = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want)
  if (a === b) { pass++; return }
  fail++; console.log(`  FAIL ${name}: got ${a}, wanted ${b}`)
}

const ROWS = [
  { id: 'seed-plain', name: 'Plain English', body: 'Answer in plain English.' },
  { id: 'seed-brief', name: 'Keep it short', body: 'At most three sentences.' },
  { id: 'seed-steps', name: 'Step by step', body: 'Numbered steps.' }
]
const cmds = d => slashMatches(d, ROWS).map(c => c.cmd)

is('a name becomes a command', slug('Plain English'), 'plain-english')
is('punctuation and case are dropped', slug('  Step  by/Step! '), 'step-by-step')

// The list
is('a bare slash offers everything', cmds('/'), ['/plain-english', '/keep-it-short', '/step-by-step'])
is('typing narrows it', cmds('/ke'), ['/keep-it-short'])
is('no match is an empty list, not everything', cmds('/zzz'), [])
is('ordinary text is not a command', cmds('what is 2/3'), [])
is('a slash mid-message is not a command', cmds('read src/mobile'), [])
is('an empty box shows nothing', cmds(''), [])

// The send
is('the command is stripped from what the model reads',
  parseSlash('/plain-english explain this', ROWS).text, 'explain this')
is('and the skill comes back',
  parseSlash('/plain-english explain this', ROWS).skill?.id, 'seed-plain')
is('a command on its own still says something',
  parseSlash('/keep-it-short', ROWS).text, 'Use the Keep it short skill.')
// ⚠️ AN UNKNOWN COMMAND IS LEFT ALONE. A path or a date at the start of a
// message must reach the model intact; silently eating it would be worse than
// not having the feature.
is('an unknown command is left in the message',
  parseSlash('/usr/bin/env is missing', ROWS).text, '/usr/bin/env is missing')
is('and selects no skill', parseSlash('/nope hello', ROWS).skill, null)
is('a message with no command is untouched',
  parseSlash('  hello there  ', ROWS).text, 'hello there')

console.log(`\n${pass}/${pass + fail} slash checks passed`)
process.exit(fail ? 1 : 0)
