/**
 * The native SwiftUI app (apps/ios/.../Native/*.swift), during the rebuild.
 *
 * ⚠️ ONE STORE, TWO FRONTS. The native screens are handed a snapshot of every
 * `radiant.phone.*` and `rx.*` key when they open and send back each write as it
 * happens ("kv"), so both designs share one set of chats, skills, models and
 * settings. On close — or when the native side asks for a screen it does not
 * have yet ("navigate") — the web app reloads, so everything it shows is read
 * fresh from that store rather than from state held before the native app ran.
 *
 * `radiant.phone.nativeUI` = "1" makes the native app the one you land in:
 * it opens at launch, and again whenever you come back to Home.
 */
const NATIVE_KEY = 'radiant.phone.nativeUI'
const ROUTE_KEY = 'rx.nativeRoute'   // sessionStorage: the web screen to show after a reload
let listening = false

const plugin = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.NativePreview : null)

export const nativePreviewAvailable = () => Boolean(plugin()?.open)

export function nativeUIEnabled () {
  try { return localStorage.getItem(NATIVE_KEY) === '1' } catch { return false }
}

/** A web screen the native app asked for, consumed once. */
export function takeNativeRoute () {
  try {
    const r = sessionStorage.getItem(ROUTE_KEY)
    if (r) sessionStorage.removeItem(ROUTE_KEY)
    return r || null
  } catch { return null }
}

function snapshot () {
  const out = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('radiant.phone.') || k.startsWith('rx.'))) out[k] = localStorage.getItem(k)
    }
  } catch { /* private mode */ }
  return out
}

export function openNativePreview ({ animated = true } = {}) {
  const np = plugin()
  if (!np?.open) return
  if (!listening) {
    listening = true
    np.addListener('kv', e => {
      if (!e?.key) return
      try {
        if (e.value === null || e.value === undefined) localStorage.removeItem(e.key)
        else localStorage.setItem(e.key, e.value)
      } catch { /* private mode */ }
    })
    np.addListener('navigate', e => {
      try { if (e?.route) sessionStorage.setItem(ROUTE_KEY, e.route) } catch {}
      window.location.reload()
    })
    np.addListener('closed', () => window.location.reload())
  }
  try { localStorage.setItem(NATIVE_KEY, '1') } catch {}
  np.open({ store: snapshot(), animated }).catch(() => {})
}
