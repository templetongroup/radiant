/**
 * Dictation: Apple's on-device speech recognition, streamed to the browser.
 *
 * ⚠️ THE HELPER MUST BE A CHILD OF RADIANT.APP, AND RADIANT.APP MUST CARRY THE
 * USAGE STRINGS. Measured on 2026-09-03: the same signed helper, with the same
 * NSSpeechRecognitionUsageDescription embedded in its own __TEXT,__info_plist,
 * is killed by TCC when it is spawned from a shell —
 *
 *   namespace TCC: "This app has crashed because it attempted to access
 *   privacy-sensitive data without a usage description."
 *
 * — and runs to "authorized" when the responsible process is a real bundle whose
 * Info.plist has the key. Putting it in a bundle of its own did not help; being
 * launched by something that has the key did. That is why the two strings are in
 * package.json's mac.extendInfo, and why breaking them would not fail a build —
 * it would crash the microphone at the moment somebody tries to speak.
 *
 * Only one at a time: a second microphone tap on the same device is how you get
 * two half-transcripts. Closing the response kills the child, and closing the
 * child's stdin is what stops it — that survives the server being killed, which
 * a SIGTERM handler does not.
 */
import { spawn } from 'child_process'
import { helperPath, helperAvailable } from './computer.js'

let active = null   // { child, res }

export function dictationBusy () { return Boolean(active) }

export function stopDictation () {
  if (!active) return
  const { child } = active
  active = null
  try { child.stdin.end() } catch {}
  // It should exit on its own the moment stdin closes; if it does not, it is
  // holding the microphone open and gets no say in the matter.
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 1500)
}

export function startDictation (req, res, locale = 'en-US') {
  if (!helperAvailable()) {
    res.writeHead(503, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'The Radiant helper is not installed, so dictation cannot start.' }))
  }
  if (active) {
    res.writeHead(409, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'Dictation is already running.' }))
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  const send = obj => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch {} }

  const child = spawn(helperPath(), ['dictate', locale], { stdio: ['pipe', 'pipe', 'pipe'] })
  active = { child, res }

  let buf = ''
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('{')) continue      // the Speech framework logs to stdout too
      try { send(JSON.parse(t)) } catch {}
    }
  })
  // Framework chatter, not ours. Kept out of the stream but not thrown away —
  // "Cannot make recognizer for xx-XX" only ever appears here.
  let err = ''
  child.stderr.on('data', d => { err = (err + d.toString()).slice(-2000) })

  child.on('error', e => {
    send({ type: 'error', code: 'spawn', message: `Could not start dictation: ${e.message}` })
    try { res.end() } catch {}
    active = null
  })
  child.on('close', code => {
    // A crash with no message of its own is the TCC kill described above, and it
    // is silent by design — say something rather than closing the stream dead.
    if (code !== 0 && code !== null) {
      send({ type: 'error', code: 'crashed', message: err.trim().split('\n').pop() ||
        `Dictation stopped unexpectedly (exit ${code}).` })
    }
    send({ type: 'stopped' })
    try { res.end() } catch {}
    if (active && active.child === child) active = null
  })

  // Navigating away, closing the tab, or pressing the button again.
  req.on('close', () => { if (active && active.child === child) stopDictation() })
}
