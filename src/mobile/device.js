/**
 * What to call the thing in the user's hands.
 *
 * ⚠️ "iPhone" WAS HARD-CODED IN FORTY-SIX PLACES. The app is universal now, and
 * on an iPad every one of those sentences was simply untrue — "running on your
 * iPhone" under a picture of an iPad is the kind of detail that tells someone
 * the app was not really made for their device.
 *
 * Resolved once from the native idiom and cached. Defaults to iPhone, because
 * that is what it is until the phone says otherwise and a wrong guess in that
 * direction is the smaller one — most devices are phones.
 */
const plugins = () => (typeof window !== 'undefined' && window.Capacitor?.Plugins) || {}

let word = 'iPhone'
const listeners = new Set()

export const deviceWord = () => word
export const isPad = () => word === 'iPad'

// The native build number (CFBundleVersion). The npm version is the same in
// every build cut from one commit, so it cannot tell two installs apart — which
// is how a fixed app got reported as still broken. Null off-device.
let build = null
export const buildNumber = () => build

/** Ask the device. Safe to call repeatedly; it only asks once. */
let asked = false
export async function resolveDevice () {
  if (asked) return word
  asked = true
  try {
    const info = await plugins().LocalModels?.deviceInfo?.()
    if (info?.idiom === 'pad') word = 'iPad'
    if (info?.build) build = String(info.build)
  } catch { /* the default already holds */ }
  listeners.forEach(fn => fn(word))
  return word
}

export function onDeviceResolved (fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
