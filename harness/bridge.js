/**
 * A stand-in for the native side, so the phone UI can be RUN, not just read.
 *
 * ⚠️ THIS EXISTS BECAUSE THE GAUNTLET NEVER RAN THE APP. Six passes, 68
 * assertions, and not one of them rendered a screen — every gate read source or
 * exercised a pure function. Every bug Tony found lived in the gap: a hard-coded
 * "On device" under a cloud model, a transcript that would not scroll, a header
 * a hundred pixels narrower than its own rows, screens that led nowhere. Source
 * that reads correctly is not an app that works.
 *
 * The stub answers the way the real plugins answer — including the awkward bits
 * that shape the UI, like generate() having no memory between calls and download
 * progress arriving as events.
 */
const listeners = new Map()
const emit = (ev, data) => (listeners.get(ev) || []).forEach(fn => fn(data))
const addListener = (ev, fn) => {
  if (!listeners.has(ev)) listeners.set(ev, [])
  listeners.get(ev).push(fn)
  return { remove () { listeners.set(ev, (listeners.get(ev) || []).filter(f => f !== fn)) } }
}

// ⚠️ THE REAL CATALOGUE, ALL 44 — NOT A SLICE. This was five rows with
// SHORTENED blurbs ("Meta's." for Llama 3.2 3B), and that is precisely how a
// row layout that fits five short strings shipped while the real strings
// behaved differently. Vite serves this as raw text and it is parsed with the
// same regex test-catalog.mjs uses, so the harness renders what the phone
// renders and geometry measured here is geometry that is true.
import swift from '../apps/ios/ios/App/App/plugins/LocalModels.swift?raw'

const CATALOG = [...swift.matchAll(
  /Entry\(id: "([^"]+)", name: "([^"]+)", maker: "([^"]+)",\s*\n\s*blurb: "([^"]*)",\s*\n\s*gb: ([\d.]+), config: ([^\n]*)/g
)].map(m => ({
  id: m[1], name: m[2], maker: m[3], blurb: m[4], sizeGB: parseFloat(m[5]),
  // ⚠️ READ THE FLAGS FROM THE SWIFT, DO NOT LIST THEM HERE. A hand-kept copy
  // drifts the moment a model is added, and the harness would then be testing a
  // catalogue the app does not have.
  vision: /vision: true/.test(m[6]),
  video: /video: true/.test(m[6]),
  // Two resident models so both the "On this iPhone" group and the catalog
  // below it render, plus one that can see so the picture button has something
  // to appear beside.
  downloaded: m[1] === 'qwen3-1.7b' || m[1] === 'llama3.2-3b' || m[1] === 'qwen2-vl-2b'
}))
if (CATALOG.length < 40) throw new Error(`harness parsed only ${CATALOG.length} models from LocalModels.swift`)

// ⚠️ ?empty=1 IS FOR THE ONE CASE THE UI CANNOT REACH CLEANLY. A brand new
// install has nothing downloaded, and getting there by clicking Remove on every
// model leaves the navigation stack deep and the assertions fighting pop
// animations rather than testing the feature. This starts the phone the way it
// ships.
const EMPTY = new URLSearchParams(location.search).get('empty') === '1'
// ?apple=0 is the phone that cannot run Apple's model — an older iPhone, or
// Apple Intelligence switched off. It is the case that decides whether the app
// is usable at all on day one.
const NO_APPLE = new URLSearchParams(location.search).get('apple') === '0'
const state = {
  models: CATALOG.map(m => ({ ...m, downloaded: EMPTY ? false : m.downloaded })),
  ram: 6.44e9
}
window.__harness = { state, emit }

window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    // ⚠️ Mirrors AppleModel.swift. `state.appleAvailable` lets a test drive the
    // phone that cannot run it — an older iPhone, or Apple Intelligence off —
    // which is the case that decides whether the app is usable on day one.
    AppleModel: {
      addListener: (ev, fn) => Promise.resolve(addListener(ev, fn)),
      availability: async () => (NO_APPLE || state.appleAvailable === false
        ? { available: false, reason: 'Turn on Apple Intelligence in Settings to use Apple\u2019s model.' }
        : { available: true, reason: '' }),
      send: async ({ prompt }) => {
        const words = `Apple reply to ${JSON.stringify(prompt).slice(0, 40)}: here is a short answer.`.split(' ')
        let i = 0
        const tick = () => {
          if (i >= words.length) { emit('appleDone', {}); return }
          emit('appleToken', { text: (i ? ' ' : '') + words[i++] })
          setTimeout(tick, 25)
        }
        setTimeout(tick, 40)
        return {}
      },
      stop: async () => { emit('appleDone', { stopped: true }); return {} }
    },
    LocalModels: {
      addListener: (ev, fn) => Promise.resolve(addListener(ev, fn)),
      list: async () => ({ models: state.models.map(m => ({ ...m })) }),
      downloaded: async () => ({ ids: state.models.filter(m => m.downloaded).map(m => m.id) }),
      diskInfo: async () => ({ total: 511e9, free: 48e9, ramTotal: 12.26e9, ramAvailable: state.ram }),
      deviceInfo: async () => ({ name: 'iPhone 17 Pro Max', identifier: 'iPhone18,2', cores: 6, osVersion: '26.6', ramTotal: 12.26e9, ramAvailable: state.ram }),
      download: async ({ id }) => {
        emit('downloadStarted', { id })
        let p = 0
        const t = setInterval(() => {
          p += 0.25
          if (p >= 1) {
            clearInterval(t)
            const m = state.models.find(x => x.id === id); if (m) m.downloaded = true
            emit('downloadDone', { id })
          } else emit('downloadProgress', { id, progress: p })
        }, 40)
        return {}
      },
      cancelDownload: async ({ id }) => { emit('downloadCancelled', { id }); return {} },
      remove: async ({ id }) => { const m = state.models.find(x => x.id === id); if (m) m.downloaded = false; return {} },
      // ⚠️ Mirrors the real plugin: one shot, no memory of the conversation.
      // It STREAMS, deliberately — the scroll bug Tony hit only exists while
      // tokens are arriving, so a stub that answers instantly cannot catch it.
      // ⚠️ ECHO WHETHER A PICTURE ARRIVED. The one thing worth asserting about
      // vision from the web side is that the image actually reached the native
      // call — silently dropping it is the failure mode.
      generate: async ({ prompt, imageB64 }) => {
        state.lastImageBytes = imageB64 ? imageB64.length : 0
        const words = ((imageB64 ? 'Looking at your picture. ' : '') +
          'Local reply to ' + String(prompt).slice(-16) + ' ' +
          'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '.repeat(6)).split(' ')
        let i = 0
        const t = setInterval(() => {
          if (i >= words.length) { clearInterval(t); emit('done', {}); return }
          emit('token', { text: words[i++] + ' ' })
        }, 12)
        return {}
      },
      stop: async () => ({})
    },
    SecureStore: {
      set: async () => ({}), get: async () => ({ value: '' }),
      remove: async () => ({}), keys: async () => ({ keys: [] })
    },
    ProviderChat: {
      addListener: (ev, fn) => Promise.resolve(addListener(ev, fn)),
      models: async () => ({ models: ['anthropic/claude-opus-4.5', 'openai/gpt-5', 'deepseek/deepseek-v4'] }),
      send: async () => { emit('cloudToken', { text: 'Cloud reply.' }); emit('cloudDone', {}); return {} },
      stop: async () => ({})
    },
    Haptics: { impact: async () => ({}), notification: async () => ({}), selection: async () => ({}) },
    StatusBar: { setStyle: async () => ({}), setBackgroundColor: async () => ({}) },
    Keyboard: { addListener: (ev, fn) => Promise.resolve(addListener(ev, fn)), setAccessoryBarVisible: async () => ({}) },
    SplashScreen: { hide: async () => ({}) }
  }
}
