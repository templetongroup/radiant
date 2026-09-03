// The mid-turn queue: it must go to the chat it was typed in, and nowhere else.
//
// ⚠️ THE BUG WAS A TRANSITION, NOT A STATE. Switching away from a streaming chat
// ran the drain and the "abandon the queue" reset in the same commit, in that
// order — so the drain fired with the previous chat's queue and the new chat's
// identity. Nothing about the finished screen looked wrong; only the moment
// between two renders did. That is why the decision is a pure function.
import { shouldDrainQueue } from '../src/queue.js'

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : 'FAIL'} ${name}${ok ? '' : `  got ${got}, wanted ${want}`}`)
}

const A = 'sess-a', B = 'sess-b'

is('a turn settling in the chat you are in drains it',
   shouldDrainQueue({ wasStreaming: true, streaming: false, streamedFor: A, sessionId: A, queuedCount: 2 }), true)

// the reported bug, exactly
is('switching to another chat mid-turn does NOT send into it',
   shouldDrainQueue({ wasStreaming: true, streaming: false, streamedFor: A, sessionId: B, queuedCount: 2 }), false)

is('and neither does landing on a brand-new chat',
   shouldDrainQueue({ wasStreaming: true, streaming: false, streamedFor: A, sessionId: 'sess-new', queuedCount: 1 }), false)

is('nothing queued, nothing sent',
   shouldDrainQueue({ wasStreaming: true, streaming: false, streamedFor: A, sessionId: A, queuedCount: 0 }), false)

is('a turn still running does not drain',
   shouldDrainQueue({ wasStreaming: true, streaming: true, streamedFor: A, sessionId: A, queuedCount: 3 }), false)

is('and neither does a chat that was never streaming',
   shouldDrainQueue({ wasStreaming: false, streaming: false, streamedFor: A, sessionId: A, queuedCount: 3 }), false)

is('no session, no send',
   shouldDrainQueue({ wasStreaming: true, streaming: false, streamedFor: undefined, sessionId: undefined, queuedCount: 2 }), false)

console.log(`\n  ${pass}/${pass + fail} passed  ·  the queue goes to the chat it was typed in`)
process.exit(fail ? 1 : 0)
