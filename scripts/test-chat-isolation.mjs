/**
 * One chat's turn cannot appear in another chat.
 *
 * ⚠️ RADIANT COULD ONLY EVER TRACK ONE RUNNING TURN, and nothing said so. The
 * streaming session was a single ref and the live view was a single object, so
 * starting a second chat did three things at once:
 *
 *   1. the FIRST chat's events were dropped at the guard and it appeared to
 *      stop dead — Tony: "the readaloud extention chat just stopped for no
 *      reason";
 *   2. the SECOND chat's thinking and output were painted into whichever chat
 *      was on screen — "content about the radiant last30days chat is leaking
 *      into the readaloud chat";
 *   3. an approval prompt from a background turn could appear in front of you,
 *      and pressing Approve there ran THAT chat's command. That is the one that
 *      could act on the machine rather than merely confuse.
 *
 * The turns themselves were always fine — the server keeps streaming and saves
 * the transcript. It was only ever the view that was single-tenant, which is
 * why it read as data loss and was not.
 *
 * This is a source check because the bug is not in any one function: it is a
 * scoping rule about every write the stream makes. Same shape as
 * test-renderer.mjs, and for the same reason — some invariants are about where
 * code is allowed to write, not about what it returns.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
let pass = 0, fail = 0
const results = []
const ok = (name, cond, extra = '') => { cond ? pass++ : (fail++, results.push(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)) }

// ── many turns at once, not one ─────────────────────────────────────────────
ok('the set of streaming chats is a Set, not one id',
   /streamingRef\s*=\s*useRef\(new Set\(\)\)/.test(src))
ok('...and nothing refers to the single-id ref any more',
   !/streamingSessionRef\.current/.test(src))
ok('a turn joins that set rather than replacing it',
   /streamingRef\.current\.add\(sessionId\)/.test(src))
ok('and leaves it when it ends', /streamingRef\.current\.delete\(/.test(src))
// ⚠️ THE GUARD MUST ASK "IS THIS TURN STILL RUNNING", NOT "IS IT THE ONE".
ok('an event is kept when its own chat is still streaming',
   /if \(!streamingRef\.current\.has\(sessionId\)\) return/.test(src))

// ── the view is per chat ────────────────────────────────────────────────────
for (const [what, map] of [['live', 'liveMap'], ['approval', 'approvalMap'], ['question', 'questionMap']]) {
  ok(`${what} is stored per chat`, new RegExp(`const \\[${map}, set${map[0].toUpperCase()}${map.slice(1)}\\] = useState\\(\\{\\}\\)`).test(src))
  ok(`${what} shown is the open chat's own`,
     new RegExp(`const ${what} = session \\? \\(${map}\\[session\\.id\\] \\|\\| null\\) : null`).test(src))
}

// ⚠️ NO UNKEYED WRITE MAY SURVIVE. This is the assertion that would have caught
// it: a bare setLive/setApproval/setQuestion writes one object for the whole
// app, which is exactly the defect.
for (const bad of ['setLive(', 'setApproval(', 'setQuestion(']) {
  const hits = src.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes(bad) && !l.trim().startsWith('//') && !l.includes('For('))
  ok(`no un-keyed ${bad.slice(0, -1)} anywhere`, hits.length === 0,
     hits.map(([n]) => 'line ' + n).join(', '))
}

// ── the readouts follow the chat on screen ──────────────────────────────────
// stats, usage, todos and the error banner describe one conversation. They are
// cheap to recompute and are only painted for the chat being read.
for (const c of ['stats', 'usage', 'todos']) {
  const line = src.split('\n').find(l => l.includes(`case '${c}':`))
  ok(`the ${c} readout only paints the chat on screen`,
     Boolean(line && line.includes('openSessionRef.current === sessionId')), line?.trim().slice(0, 70))
}
ok('an error banner belongs to the chat it happened in',
   /if \(openSessionRef\.current === sessionId\) setError\(ev\.message\)/.test(src))

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a turn is only ever visible in its own chat`)
process.exit(fail ? 1 : 0)
