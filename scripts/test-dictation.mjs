import { emptyDictation, applyDictationEvent, dictationText } from '../src/dictation.js'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }
const run = (base, evs) => {
  let s = emptyDictation(base)
  for (const e of evs) s = applyDictationEvent(s, e)
  return dictationText(s)
}
const p = text => ({ type: 'partial', text })
const f = text => ({ type: 'final', text })

// The bug this file exists for.
ok(run('', [p('hello'), p('hello there'), p('hello there world')]) === 'hello there world',
   'a partial REPLACES the utterance, it does not append to it')

ok(run('', [p('hello'), f('hello there.')]) === 'hello there.',
   'the final result replaces the partials that led to it')

ok(run('', [p('first one'), f('First one.'), p('second'), f('Second one.')]) === 'First one. Second one.',
   'two utterances join with exactly one space')

ok(run('Fix the ', [p('login bug')]) === 'Fix the login bug',
   'text already typed is kept, and its trailing space is not doubled')

ok(run('Fix the', [p('login bug')]) === 'Fix the login bug',
   'a space is added when what you typed does not end in one')

ok(run('', [p('draft')]) === 'draft',
   'no leading space when the box was empty')

ok(run('kept', []) === 'kept', 'no speech yet leaves what you typed exactly as it was')

ok(run('', [p('half a sentence'), { type: 'stopped' }]) === 'half a sentence',
   'stopping keeps a partial that never became final — you still said it')

ok(run('typed', [p('spoken'), { type: 'error', message: 'x' }]) === 'typed spoken',
   'an error does not erase text already transcribed')

ok(run('', [f('  '), p('real')]) === 'real',
   'an empty final commits nothing rather than a stray space')

ok(run('', [p('a'), f('A.'), p('')]) === 'A.',
   'an empty partial after a final does not leave a trailing space')

// State is not mutated in place — the UI keeps it in React state.
const s0 = emptyDictation('x')
applyDictationEvent(s0, p('y'))
ok(s0.current === '', 'applying an event does not mutate the state passed in')

// ── The four pieces that must exist together ────────────────────────────────
// Break any one and nothing fails to build, nothing throws, and no test goes red:
// the helper is killed by TCC the moment somebody presses Dictate. That is worth
// four string checks.
import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const ents = readFileSync('build/entitlements.mac.plist', 'utf8')
const hplist = readFileSync('native/Info.plist', 'utf8')
const swift = readFileSync('native/RadiantControl.swift', 'utf8')

ok(/NSMicrophoneUsageDescription/.test(JSON.stringify(pkg.build?.mac?.extendInfo || {})) &&
   /NSSpeechRecognitionUsageDescription/.test(JSON.stringify(pkg.build?.mac?.extendInfo || {})),
   'Radiant.app carries both usage strings (mac.extendInfo) — without them macOS kills the helper')

ok(ents.includes('com.apple.security.device.audio-input'),
   'the hardened runtime is allowed to open the microphone (audio-input entitlement)')

ok(pkg.scripts['compile:helper'].includes('__info_plist') &&
   pkg.scripts['compile:helper'].includes('native/Info.plist'),
   'the helper is built with its Info.plist linked in')

ok(hplist.includes('NSSpeechRecognitionUsageDescription') && hplist.includes('NSMicrophoneUsageDescription'),
   'the embedded plist has both keys')

// The whole point of on-device: audio never leaves the Mac.
ok(/requiresOnDeviceRecognition\s*=\s*true/.test(swift),
   'recognition is on-device — audio is never sent to Apple')
ok(/supportsOnDeviceRecognition\s+else/.test(swift) || /guard\s+recognizer\.supportsOnDeviceRecognition/.test(swift),
   'a locale with no offline model is refused rather than quietly going online')

console.log(`  ${pass}/${pass + fail} passed  ·  dictation is on-device and cannot start without its permissions`)
process.exit(fail ? 1 : 0)
