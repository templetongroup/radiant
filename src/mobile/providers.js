/**
 * The providers a phone can actually reach, mirrored from the Mac's list in
 * server/config.js so the two cannot drift.
 *
 * WHAT IS DELIBERATELY MISSING, and why — an app that lists something it cannot
 * do is worse than one that lists less:
 *  · Ollama and LM Studio are localhost servers. On a phone there is no
 *    localhost worth talking to; reach them by connecting to your Mac.
 *  · ChatGPT Plus and GitHub Copilot sign in with an OAuth flow that redirects
 *    to a port on the machine running it. A phone cannot listen on one, so
 *    those subscriptions are a Mac-connection feature, not a phone feature.
 *  · Claude Pro/Max (paste) and Nous Portal (device code) COULD work on iOS and
 *    are not built yet. They are listed as pending, not offered.
 *
 * Everything here is a plain API key over HTTPS, which a phone does fine.
 *
 * ⚠️ EVERY baseUrl HERE IS FIXED. The phone has no Add provider row and no way
 * to edit one, so a provider with more than one endpoint can only ship the
 * endpoint listed here. MiniMax is the case that matters: its mainland-China
 * platform is a different domain with different accounts, and a key from it
 * cannot be used on the phone at all. The hint therefore names the platform the
 * key must come from, rather than describing a switch that does not exist here.
 */
export const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com',
    hint: 'Claude models. Key from console.anthropic.com.', prefix: 'sk-ant-' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    hint: 'GPT models. Key from platform.openai.com.', prefix: 'sk-' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    hint: 'Hundreds of models behind one key. openrouter.ai/keys.', prefix: 'sk-or-' },
  { id: 'xai', name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1',
    hint: 'Grok models. Key from console.x.ai.', prefix: 'xai-' },
  { id: 'nousresearch', name: 'Nous Portal', baseUrl: 'https://inference-api.nousresearch.com/v1',
    hint: 'Hermes models. Key from portal.nousresearch.com → API Keys.' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    hint: 'deepseek-chat and deepseek-reasoner. platform.deepseek.com.' },
  { id: 'moonshot', name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai/v1',
    hint: 'Kimi models. platform.moonshot.ai.' },
  { id: 'zai', name: 'GLM (Z.ai)', baseUrl: 'https://api.z.ai/api/paas/v4',
    hint: 'GLM-4.6 and 4.5. Works with the GLM Coding Plan.' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.io/v1',
    hint: 'MiniMax-M3 and the M2 series. Key from platform.minimax.io — the international platform, not the mainland-China one.' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
    hint: 'Very fast open models. console.groq.com.', prefix: 'gsk_' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1',
    hint: 'Mistral and Codestral. console.mistral.ai.' }
]

const SS = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.SecureStore : null)

/** Which providers have a key. Names only — the keys never enter the web layer. */
export async function connectedProviders () {
  const ss = SS()
  if (!ss?.keys) return []
  try { return (await ss.keys())?.keys || [] } catch { return [] }
}

export async function saveKey (id, value) {
  const ss = SS()
  if (!ss?.set) throw new Error('Secure storage is unavailable on this device.')
  await ss.set({ key: id, value: value.trim() })
}

export async function removeKey (id) {
  const ss = SS()
  if (!ss?.remove) return
  await ss.remove({ key: id })
}

/**
 * A shape check, not a validity check. It catches the overwhelmingly common
 * mistake — pasting the wrong provider's key, or a fragment — without claiming
 * the key works, which only the vendor can tell us.
 */
export function looksWrong (provider, value) {
  const v = (value || '').trim()
  if (v.length < 16) return 'That looks too short to be a key.'
  if (/\s/.test(v)) return 'That has a space in it — check the paste.'
  if (provider.prefix && !v.startsWith(provider.prefix)) {
    return `${provider.name} keys start with ${provider.prefix}`
  }
  return null
}

const PC = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.ProviderChat : null)

/**
 * The provider's own model list. Asked of the vendor rather than hard-coded,
 * so it shows what this key can actually reach and cannot go stale when a new
 * model ships.
 */
export async function fetchModels (provider) {
  const pc = PC()
  if (!pc?.models) throw new Error('This build cannot reach cloud providers.')
  const r = await pc.models({ provider: provider.id, baseUrl: provider.baseUrl })
  return r?.models || []
}

const CHOSEN = 'radiant.phone.cloudModel'

/** { providerId, model } or null — the cloud model the user last chose. */
export function loadChosen () {
  try {
    const raw = JSON.parse(localStorage.getItem(CHOSEN) || 'null')
    return raw && PROVIDERS.some(p => p.id === raw.providerId) ? raw : null
  } catch { return null }
}

export function saveChosen (chosen) {
  try {
    if (chosen) localStorage.setItem(CHOSEN, JSON.stringify(chosen))
    else localStorage.removeItem(CHOSEN)
  } catch { /* private mode */ }
  // Every screen that names the current model has to hear about this. Without
  // it, Home and the chat title keep showing a local model while the cloud one
  // is what actually answers.
  try { window.dispatchEvent(new CustomEvent('rx:cloud-model-changed')) } catch { /* SSR */ }
}

/** Subscribe to cloud-model changes. Returns an unsubscribe. */
export function onChosenChanged (fn) {
  window.addEventListener('rx:cloud-model-changed', fn)
  return () => window.removeEventListener('rx:cloud-model-changed', fn)
}

/**
 * The chosen cloud model, shaped like a local model so every screen can show it.
 *
 * ⚠️ THE APP WAS LYING ABOUT WHO ANSWERS. MobileChat reads loadChosen() and, if
 * a cloud model is set, sends there INSTEAD of the on-device model — silently.
 * Meanwhile Home said "Current model: Qwen 3 1.7B" and the chat title said the
 * same, because both only knew about downloaded models. Tony picked an
 * OpenRouter model and asked "now what? how do I start a chat with that model?"
 * — the answer was that every chat was already going to it, and nothing on
 * screen said so. A model list that shows the wrong name is worse than one that
 * shows nothing.
 */
export function chosenAsModel () {
  const c = loadChosen()
  if (!c) return null
  const p = providerById(c.providerId)
  return {
    id: `cloud:${c.providerId}:${c.model}`,
    name: shortModelName(c.model),
    maker: p?.name || c.providerId,
    blurb: `Runs on ${p?.name || c.providerId}, using your API key.`,
    cloud: true,
    providerId: c.providerId,
    model: c.model,
    downloaded: true,
    sizeGB: 0
  }
}

/**
 * "anthropic/claude-opus-4.5" -> "claude-opus-4.5".
 *
 * The provider is shown separately, so repeating it in the name wastes the
 * width a phone does not have.
 */
export function shortModelName (id) {
  const s = String(id || '')
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s
}

export const providerById = id => PROVIDERS.find(p => p.id === id) || null
