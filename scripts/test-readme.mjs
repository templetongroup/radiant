/**
 * The Read me must only describe what is built.
 *
 * ⚠️ THIS IS A RULE THIS PROJECT HAS ALREADY BROKEN. A guide that promises a
 * feature the app does not have had to be unshipped once, and today Tony had to
 * ask whether the Read me had been updated at all — it had not, and was missing
 * Home, conversation history, providers, text size and the whole model
 * catalogue. A guide nothing checks is a guide that drifts.
 *
 * So the claims that CAN be checked mechanically are checked here: names of
 * providers, makers, settings sections, and the model count. It cannot verify
 * prose, but it catches the failure that actually happens — a feature renamed or
 * removed in code while the Read me keeps describing it.
 */
import { readFileSync } from 'node:fs'

const readme = readFileSync('src/mobile/ReadMeScreen.jsx', 'utf8')
const providers = readFileSync('src/mobile/providers.js', 'utf8')
const settings = readFileSync('src/mobile/SettingsScreen.jsx', 'utf8')
const swift = readFileSync('apps/ios/ios/App/App/plugins/LocalModels.swift', 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  if (got === want) { pass++; return }
  fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}

// Every provider the Read me names by name must actually be configured.
const named = ['Anthropic', 'OpenAI', 'OpenRouter', 'xAI', 'Nous', 'DeepSeek', 'Kimi', 'GLM', 'Groq', 'Mistral']
for (const p of named) {
  if (readme.includes(p)) is(`provider "${p}" exists`, providers.includes(p), true)
}

// Every settings screen the Read me sends the reader to must have that heading.
// Matched against the headings the screen actually renders rather than parsed
// out of the prose — a regex over English kept capturing the following verb.
const headings = [...settings.matchAll(/className="rx-section-header">([^<]+)</g)].map(m => m[1])
is('the settings screen has headings to check', headings.length > 3, true)
for (const m of readme.matchAll(/Settings → (\w[\w ]*?)(?= [a-z]+s\b| [a-z]+es\b| chooses| carries| sets| connects| lists| will|,|\.|$)/gm)) {
  const section = m[1].trim()
  if (section.startsWith('Devices')) continue // that one is the MAC's settings, not this app's
  is(`Settings has a "${section}" section`, headings.includes(section), true)
}

// The model count in the prose must match the catalogue.
const entries = (swift.match(/Entry\(id: "/g) || []).length
const words = { forty: 40, 'forty-one': 41, 'forty-two': 42, 'forty-three': 43, 'forty-four': 44, 'forty-five': 45, 'forty-six': 46, 'forty-seven': 47, 'forty-eight': 48, 'forty-nine': 49, fifty: 50, 'fifty-one': 51, 'fifty-two': 52 }
// Longest first: 'forty' is a substring of 'forty-four', and matching the
// short one made the test report 40 against a catalogue of 44.
const claimed = Object.entries(words)
  .sort((a, b) => b[0].length - a[0].length)
  .find(([w]) => readme.includes(w))
is('the Read me states a model count', !!claimed, true)
if (claimed) is(`stated count matches the catalogue (${entries})`, claimed[1], entries)

// Every maker the Read me lists must appear in the catalogue.
for (const maker of ['Google', 'Meta', 'Mistral', 'Microsoft', 'IBM', 'Alibaba', 'NVIDIA']) {
  if (readme.includes(maker)) is(`maker "${maker}" is in the catalogue`, swift.includes(`maker: "${maker}"`), true)
}

// The recommendation named in the prose must still be a model you can get.
const rec = readme.match(/(Qwen 3 [\d.]+B) is a good place to start/)
is('the recommended model is named', !!rec, true)
if (rec) is(`"${rec[1]}" is in the catalogue`, swift.includes(`name: "${rec[1]}"`), true)

// The three verdicts must match the labels the UI actually renders. They live
// in src/fit.js, shared by both apps — the phone's fit.js only re-exports them.
const fit = readFileSync('src/fit.js', 'utf8')
for (const v of ['Runs well', 'Runs tight', "Won't run"]) {
  is(`the UI still says "${v}"`, fit.includes(v), true)
}

// ⚠️ BEHAVIOUR CLAIMS, NOT JUST NAMES. The name checks above passed while the
// Read me still said a red model "cannot be downloaded" — true when written,
// false an hour later once the block came out. Assert the claims that a code
// change can silently invert.
const picker = readFileSync('src/mobile/ModelPicker.jsx', 'utf8')
const blocksOnMemory = /disabled = downloading \|\| busyElsewhere \|\| blocked \|\| tooBig/.test(picker)
is('the Read me and the code agree on whether a red model can be downloaded',
  readme.includes('cannot be downloaded'), blocksOnMemory)

// ⚠️ THE PRIVACY URL MUST KEEP ITS .html, AND MUST EXIST AT ALL. Apple requires
// it reachable from the binary, and templetongroup.dev answers 200 for unknown
// paths while serving the HOMEPAGE — so dropping ".html" for tidiness would
// leave a link that looks fine, returns 200, and shows a reviewer the wrong
// page. Verified live once: /showcase/radiant/privacy is 327 KB of homepage,
// /showcase/radiant/privacy.html is the real 7 KB policy.
const settingsSrc = readFileSync('src/mobile/SettingsScreen.jsx', 'utf8')
const purl = settingsSrc.match(/PRIVACY_URL = '([^']+)'/)?.[1]
is('the app carries a privacy policy URL', !!purl, true)
is('and it keeps the .html that makes it real', /\.html$/.test(purl || ''), true)
is('and the app links to it', settingsSrc.includes('Privacy policy'), true)

console.log(`${pass}/${pass + fail} passed  ·  Read me checked against the code`)
process.exit(fail ? 1 : 0)
