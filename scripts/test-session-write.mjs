/**
 * A chat being saved is never half a chat on disk.
 *
 * ⚠️ SAVING A SESSION USED TO TRUNCATE THE FILE AND REFILL IT. fs.writeFileSync
 * is not atomic: for the whole of that window the file on disk is a partial
 * document. Sessions run to several megabytes — Tony's largest is 5.3 MB — and
 * loadSession answers a JSON parse failure with a silent `null`, so the chat
 * renders as EMPTY and then, on the next read, comes back. Tony: "a lot of
 * context in the chat disappeared and then came back."
 *
 * A shared iCloud folder does not cause this, it just makes it far likelier:
 * iCloud reads the file to upload it and a second Mac reads it to draw the same
 * chat, so there are simply more readers landing inside the window.
 *
 * Every other store in config.js already wrote through writeJsonAtomic. Sessions
 * — the biggest and most frequently written files of the lot — were the one
 * exception, and memory.js records the identical lesson for a file two orders of
 * magnitude smaller.
 *
 * ⚠️ THIS TEST PROVES IT CAN DETECT THE BUG. A concurrency test that only ever
 * asserts "no failures" passes just as well when it is looking in the wrong
 * place, so the plain-write control has to FAIL first for the atomic result to
 * mean anything.
 */
import { mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'

let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

const dir = mkdtempSync(join(tmpdir(), 'rx-write-'))
const file = join(dir, 'chat.json')
// A real transcript's shape and size: mostly tool results.
const session = { id: 'chat', messages: Array.from({ length: 3500 }, (_, i) => ({ role: 'assistant', parts: [{ type: 'tool', name: 'fetch_url', result: 'x'.repeat(1200) }] })) }
const json = JSON.stringify(session, null, 2)

// A reader in its own process, so it truly runs while the parent writes.
const readerSrc = join(dir, 'reader.mjs')
writeFileSync(readerSrc, `
import { readFileSync } from 'node:fs'
let reads = 0, torn = 0
const file = process.argv[2]
const until = Date.now() + Number(process.argv[3])
while (Date.now() < until) {
  reads++
  // loadSession's exact behaviour: a parse failure is a silent null.
  try { JSON.parse(readFileSync(file, 'utf8')) } catch { torn++ }
}
process.send({ reads, torn })
`)

async function run (write, ms = 1500) {
  write()
  const child = fork(readerSrc, [file, String(ms)], { silent: true })
  const done = new Promise(r => child.on('message', r))
  const until = Date.now() + ms
  while (Date.now() < until) { write(); await new Promise(r => setImmediate(r)) }
  const out = await done
  child.kill()          // it has said its piece; do not wait on an exit we may have missed
  return out
}

const plain = () => writeFileSync(file, json)
const atomic = () => { const t = file + '.tmp'; writeFileSync(t, json); renameSync(t, file) }

console.log(`  transcript: ${(json.length / 1024 / 1024).toFixed(1)} MB`)
const before = await run(plain)
console.log(`  plain writeFileSync : ${before.reads} reads, ${before.torn} came back as an EMPTY CHAT`)
const after = await run(atomic)
console.log(`  write-then-rename   : ${after.reads} reads, ${after.torn} came back as an EMPTY CHAT`)

ok('the control proves this test can see the bug at all', before.torn > 0,
   'a non-atomic write tore nothing, so the assertion below means nothing')
ok('a reader never sees a half-written chat', after.torn === 0, `${after.torn} torn reads`)
ok('and it read enough times for that to mean something', after.reads > 50, `${after.reads} reads`)

// ⚠️ AND THE REAL SAVER MUST BE THE ATOMIC ONE. The above proves rename works;
// this proves saveSession uses it, which is the thing that actually shipped.
const src = readFileSync(new URL('../server/config.js', import.meta.url), 'utf8')
const at = src.indexOf('export function saveSession (')
const body = src.slice(at, src.indexOf('\n}', at))
ok('saveSession writes through writeJsonAtomic', /writeJsonAtomic\(/.test(body))
ok('...and never calls fs.writeFileSync directly', !/fs\.writeFileSync\(/.test(body))

rmSync(dir, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a chat is never half-written on disk`)
process.exit(fail ? 1 : 0)
