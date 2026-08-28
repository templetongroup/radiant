/**
 * Apple's on-device model — the thing that answers before anything is downloaded.
 *
 * ⚠️ THIS EXISTS TO REMOVE A TOLL GATE. Radiant's own models are 0.7–4 GB, and
 * until one finishes the app can do nothing at all: New chat is disabled and
 * Home says there is no model. Apple's is already on the phone, needs no
 * download, no key and no network, so a fresh install can answer the first
 * message and the download becomes a choice.
 *
 * ⚠️ IT IS NOT ALWAYS THERE. iOS 26 or later, a phone that supports Apple
 * Intelligence, and the user having switched it on. The reason is carried
 * through verbatim from the native side because each one has a different fix —
 * a settings toggle, a wait, or the phone itself.
 */
// ⚠️ NOT AN IMPORT FROM bridge.js. Its default export is installBridge, and
// importing it as `plugins` returned that function — calling it gave
// undefined and every read threw. Same one-liner the other modules use.
const plugins = () => (typeof window !== 'undefined' && window.Capacitor?.Plugins) || {}

export const APPLE_ID = 'apple-intelligence'

/** The pseudo-model the pickers and Home treat like any other. */
export const appleAsModel = () => ({
  id: APPLE_ID,
  name: 'Apple Intelligence',
  maker: 'Apple',
  blurb: 'Already on this iPhone. Nothing to download.',
  sizeGB: 0,
  downloaded: true,
  apple: true
})

let cached = null
const listeners = new Set()

/** Ask once per launch; availability does not change while the app is open. */
export async function checkApple () {
  if (cached) return cached
  const am = plugins().AppleModel
  if (!am?.availability) {
    cached = { available: false, reason: 'Apple’s model needs the Radiant app on iOS 26 or later.' }
  } else {
    try { cached = await am.availability() } catch { cached = { available: false, reason: 'Apple’s model could not be reached.' } }
  }
  listeners.forEach(fn => fn(cached))
  return cached
}

export const appleState = () => cached
export function onAppleChecked (fn) {
  listeners.add(fn)
  if (cached) fn(cached)
  return () => listeners.delete(fn)
}

/**
 * Send one message.
 *
 * ⚠️ ONE TURN, NOT A TRANSCRIPT. The framework keeps its own session and its
 * context window is small; we hand it the same flattened prompt the local
 * models get so the budgeting in MobileChat stays the single place that decides
 * what fits.
 */
export function sendApple ({ prompt, instructions }) {
  const am = plugins().AppleModel
  if (!am?.send) return Promise.reject(new Error('unavailable'))
  return am.send({ prompt, instructions: instructions || '' })
}

export function stopApple () {
  const am = plugins().AppleModel
  return am?.stop ? am.stop() : Promise.resolve()
}
