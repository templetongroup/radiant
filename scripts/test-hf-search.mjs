// Searching Hugging Face from the phone: the verdicts must be right BEFORE a
// download, because a wrong "runs well" costs a person gigabytes.
import { qualify, customRow, SUPPORTED, VISION_TYPES } from '../src/mobile/hf.js'
import fs from 'node:fs'
let pass = 0, fail = 0
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('  FAIL', what) } }

const q4 = { repo: 'mlx-community/Qwen3-4B-Instruct-2507-4bit', gb: 2.28, bytes: 2.28e9, modelType: 'qwen3', quantized: true, bits: 4, params: 4.0e9, bytesPerParam: 0.57, vision: false, hasWeights: true }
ok(qualify(q4, 'well').label === 'Runs well' && qualify(q4, 'well').ok, 'a 4-bit Qwen 3 that fits runs well')
ok(qualify(q4, 'tight').label === 'Runs tight' && qualify(q4, 'tight').ok, 'tight is allowed, and says so')
ok(qualify(q4, 'no').label === 'Won’t fit' && !qualify(q4, 'no').ok, 'too big for the device is refused')
// ⚠️ THE GEMMA 4 DEFECT: packed weights, config silent
const packed = { ...q4, repo: 'mlx-community/gemma-4-E4B-it-qat-mobile', modelType: 'gemma4', quantized: false, bits: null, bytesPerParam: 0.55 }
ok(qualify(packed, 'well').label === 'Won’t load' && /config\.json does not say/.test(qualify(packed, 'well').why), 'packed weights with no declaration are refused before the download')
ok(!qualify({ ...q4, modelType: 'mamba_new_thing' }, 'well').ok && /no loader/.test(qualify({ ...q4, modelType: 'mamba_new_thing' }, 'well').why), 'an architecture the engine lacks is refused, naming it')
ok(!qualify({ ...q4, draft: true }, 'well').ok && /draft model/.test(qualify({ ...q4, draft: true }, 'well').why), 'a draft model (DFlash2DraftModel says qwen3) is refused, not called runs well')
ok(!qualify({ ...q4, hasWeights: false }, 'well').ok, 'a repo without safetensors is not a model')
ok(!qualify({ ...q4, modelType: null }, 'well').ok, 'no config.json → cannot tell → refused')
ok(!qualify({ ...q4, quantized: false, bytesPerParam: 2.0, gb: 9 }, 'well').ok && /4-bit version/.test(qualify({ ...q4, quantized: false, bytesPerParam: 2.0, gb: 9 }, 'well').why), 'an unquantized 9 GB model is too big, and says what to look for')
ok(qualify({ ...q4, modelType: 'qwen3_vl', vision: true }, 'well').ok, 'a vision architecture the engine has is allowed')
ok(SUPPORTED.has('qwen3_vl') && SUPPORTED.has('gemma4') && SUPPORTED.has('lfm2') && !SUPPORTED.has('bert'), 'the supported set matches the linked mlx-swift-lm factories')
ok(VISION_TYPES.has('qwen3_vl') && !VISION_TYPES.has('qwen3'), 'vision types are the VLM factory keys')
const row = customRow(q4)
ok(row.id === 'hf-mlx-community-qwen3-4b-instruct-2507-4bit' && row.repo === q4.repo && row.maker === 'mlx-community' && row.gb === 2.28 && row.stop === null, `a custom row is well-formed: ${JSON.stringify(row)}`)
ok(customRow({ ...q4, modelType: 'gemma3_text' }).stop === '<end_of_turn>', 'Gemma rows carry the stop token the catalogue uses')
// the Swift side
const swift = fs.readFileSync('apps/ios/ios/App/App/plugins/LocalModels.swift', 'utf8')
ok(/CAPPluginMethod\(name: "addCustom"/.test(swift) && /CAPPluginMethod\(name: "removeCustom"/.test(swift), 'the plugin exposes addCustom and removeCustom')
ok(/radiant-custom-models\.json/.test(swift) && /rows \+= customEntries\(\)/.test(swift), 'custom rows are persisted and appended to the effective catalogue')
ok(/"custom": customIDs\.contains\(\$0\.id\), "repo": \$0\.config\.name/.test(swift), 'list marks custom rows and carries the repo')
// ⚠️ NOTHING IS FILTERED OUT OF THE RESULTS, AND THAT IS DELIBERATE. This
// search briefly shipped with a regex hiding repos whose name or tags said
// uncensored / abliterated / NSFW, added to keep an App Store age rating
// tidy. Tony: "why did you add a filter like that at all. I would want people
// to be able to download and use uncensored models." It hid the model he was
// actually trying to install. Qualification is about whether the ENGINE can
// run it, never about what it will say.
const hf = fs.readFileSync('src/mobile/hf.js', 'utf8')
ok(!/uncensor|abliterat|nsfw|heretic|erotic|porn/i.test(hf.replace(/\/\*[\s\S]*?\*\//g, '')),
   'no content word-filter in the search path (only the comment explaining why there is none)')
const unc = { ...q4, repo: 'osxest/Huihui-Ornith-1.5-9B-abliterated-mlx-4Bit', gb: 5.04, modelType: 'qwen3_5', params: 9e9, bytesPerParam: 0.56 }
ok(qualify(unc, 'tight').ok && qualify(unc, 'tight').label === 'Runs tight',
   'an abliterated model is judged on its architecture and size like any other')
ok(customRow(unc).id === 'hf-osxest-huihui-ornith-1-5-9b-abliterated-mlx-4bit', 'and installs under an ordinary custom-row id')

// ⚠️ A REFUSAL MUST SPEAK. download() returned silently when another model was
// in flight, so the button did nothing at all — no message, no haptic. Tony:
// "just tried downloading Bonsai and nothing happens."
const hook = fs.readFileSync('src/mobile/useLocalModels.js', 'utf8')
ok(!/includes\('downloading'\)\) return/.test(hook), 'the one-at-a-time guard no longer returns in silence')
ok(/is downloading\. Wait for it to finish, or stop it first/.test(hook), 'it names the model that is busy instead')
ok(/const busy = Object\.entries\(jobs\)/.test(hook), 'and finds which one it is')

// ⚠️ AND A FINISHED DOWNLOAD THE APP CANNOT FIND MUST SAY WHY, rather than
// reverting the row to "Download" on the next refresh.
ok(/lm\.diagnose\(\{ id \}\)/.test(hook), 'a completed download is checked against the native side')
ok(/found only .*of the .*expected in/.test(hook), 'and a mismatch reports the real numbers and the folder')
const swift2 = fs.readFileSync('apps/ios/ios/App/App/plugins/LocalModels.swift', 'utf8')
ok(/CAPPluginMethod\(name: "diagnose"/.test(swift2), 'diagnose is registered, or Capacitor refuses the call at runtime')
ok(/"bytesOnDisk": bytes/.test(swift2) && /"hasReceipt": downloadedIds\(\)\.contains\(id\)/.test(swift2),
   'and it returns the three things that decide "installed"')

// ⚠️ progress[id] IS AN OBJECT, AND READING IT AS A NUMBER PUTS NaN ON SCREEN.
// The Hugging Face row did `Math.round(progress[id] * 100)` where the hook
// stores { pct, done, total }, so it rendered "Downloading… NaN%". Tony: "i
// got Downloadin: NaN or something like that." The catalogue rows already had
// a correct shared formatter; the fix was to use it.
const { progressText } = await import('../src/mobile/progress.js')
{
  ok(progressText({ pct: 0.42, done: 1e9, total: 2e9 }) === '42%', 'a known total shows a percent')
  ok(progressText({ pct: null, done: 5e8, total: 0 }) === '500 MB', 'an unknown total falls back to megabytes')
  ok(progressText({ pct: null, done: 2.5e9, total: 0 }) === '2.5 GB', 'and to gigabytes once it is past one')
  ok(progressText({ pct: null, done: 0, total: 0 }) === null, 'nothing yet is null, not "0%"')
  ok(progressText(null) === null, 'and no progress at all is null')
  for (const shape of [{ pct: 0.5 }, { pct: null, done: 1e9 }, null, {}]) {
    ok(!String(progressText(shape)).includes('NaN'), `never NaN for ${JSON.stringify(shape)}`)
  }
}
const hfRow = fs.readFileSync('src/mobile/HuggingFaceSearch.jsx', 'utf8')
ok(/progressText\(local\.progress/.test(hfRow), 'the Hugging Face row uses the shared formatter')
ok(!/progress\[[^\]]*\] \* 100/.test(hfRow), 'and does no arithmetic of its own on the progress object')
ok(/<BrandSpinner size=\{29\} \/>/.test(hfRow), 'and shows the same turning swirl as a catalogue row')

// ⚠️ THE REGISTRY MUST ACTUALLY PERSIST. Library/Application Support does not
// exist on iOS until an app creates it, and saveCustom() wrote into it with
// `try?` — so the write failed silently, the model lived in memory for one
// session, and vanished on the next launch with its weights orphaned in
// Caches. Verified by listing a real phone: no Application Support directory.
const lm = fs.readFileSync('apps/ios/ios/App/App/plugins/LocalModels.swift', 'utf8')
ok(/createDirectory\(at: dir, withIntermediateDirectories: true\)/.test(lm),
   'saveCustom creates Application Support before writing into it')
ok(!/try\? data\.write\(to: customURL/.test(lm), 'and no longer swallows the write failure')
ok(/private func saveCustom\(_ rows: \[RemoteCatalog\.Row\]\) -> Bool/.test(lm), 'it reports whether it succeeded')
ok(/if saveCustom\(list\) \{ return true \}[\s\S]*?guard saved else/.test(lm), 'and addCustom refuses rather than claiming a save it did not make')
ok(/could not be saved to this device/.test(lm), 'with a reason a person can act on')

console.log(`\n${pass}/${pass + fail} passed  ·  a Hugging Face model is qualified before a byte is downloaded`)
process.exit(fail ? 1 : 0)
