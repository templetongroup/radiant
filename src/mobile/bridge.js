/**
 * bridge — put the native plugins on window.Capacitor.Plugins ourselves.
 *
 * ⚠️ The rest of src/mobile reaches plugins as window.Capacitor.Plugins.X,
 * which is how it stays out of the Mac bundle: no @capacitor/core in the root
 * package.json, nothing for electron-builder to ship. But the injected
 * native-bridge.js does NOT populate Capacitor.Plugins on its own — in
 * Capacitor 5+ that object is filled in by registerPlugin() from the JS
 * wrapper, and we deliberately do not have one. What the bridge DOES give us is
 * the layer underneath:
 *
 *   Capacitor.nativePromise(plugin, method, options)  → Promise
 *   Capacitor.addListener(plugin, event, cb)          → { remove() }
 *
 * So this file builds the same proxies registerPlugin would have, over that
 * API, for the plugins this app actually uses. It is the whole reason the phone
 * can talk to LocalModels without a single dependency landing in the desktop
 * build.
 *
 * Optional plugins (Haptics, StatusBar, Keyboard, Device) may not be installed
 * natively at all. Their proxies swallow rejections, because a missing buzz must
 * never surface as an unhandled promise rejection — where a caller needs to know
 * (LocalModels, Device.getInfo) the error is passed through instead.
 */

const LOUD = {
  SecureStore: ['set', 'get', 'remove', 'keys'],
  ProviderChat: ['models', 'send', 'stop'],
  AppleModel: ['availability', 'send', 'stop'],
  LocalModels: ['list', 'downloaded', 'download', 'cancelDownload', 'remove', 'generate', 'stop', 'diskInfo', 'deviceInfo'] }
const QUIET = {
  Haptics: ['impact', 'notification', 'vibrate', 'selectionStart', 'selectionChanged', 'selectionEnd'],
  StatusBar: ['setStyle', 'setBackgroundColor', 'show', 'hide', 'setOverlaysWebView'],
  Keyboard: ['show', 'hide', 'setAccessoryBarVisible', 'setScroll', 'setStyle', 'setResizeMode'],
  Device: ['getInfo', 'getBatteryInfo', 'getId', 'getLanguageCode']
}

function makePlugin (cap, name, methods, quiet) {
  const plugin = {}
  for (const m of methods) {
    plugin[m] = (options = {}) => {
      const p = cap.nativePromise(name, m, options)
      // Device.getInfo has real callers who branch on failure; a haptic does not
      return quiet && name !== 'Device' ? p.catch(() => null) : p
    }
  }
  plugin.addListener = (event, cb) => {
    try {
      const handle = cap.addListener(name, event, cb)
      // Capacitor 7 callers await addListener; hand back a thenable handle so
      // both `await addListener(...)` and a bare handle work
      return Object.assign(Promise.resolve(handle), handle)
    } catch {
      const noop = { remove () {} }
      return Object.assign(Promise.resolve(noop), noop)
    }
  }
  plugin.removeAllListeners = () => Promise.resolve()
  return plugin
}

let installed = false

export default function installBridge () {
  if (installed) return
  const cap = typeof window !== 'undefined' ? window.Capacitor : null
  if (!cap || typeof cap.nativePromise !== 'function') return
  installed = true
  cap.Plugins = cap.Plugins || {}
  for (const [name, methods] of Object.entries(LOUD)) {
    if (!cap.Plugins[name]) cap.Plugins[name] = makePlugin(cap, name, methods, false)
  }
  for (const [name, methods] of Object.entries(QUIET)) {
    if (!cap.Plugins[name]) cap.Plugins[name] = makePlugin(cap, name, methods, true)
  }
}

export { installBridge }
