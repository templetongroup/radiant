// Which Radiant server to talk to. Empty base = this app's own bundled server
// (same origin). A remote base + token points at a shared server on another Mac.
//
// ⚠️ THE TOKEN IS A CREDENTIAL AND ON iOS IT LIVES IN THE KEYCHAIN. It grants
// access to every model, agent and session on someone's Mac, which makes it at
// least as sensitive as the provider API keys that already go to SecureStore —
// and it was sitting in localStorage while they did. On the Mac app localStorage
// is the app's own Electron store and stays fine; only the phone, where the web
// layer is a shipped WKWebView, moves it.
const KEY = 'radiant.server'
const SS = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.SecureStore : null)

// The address is not secret and stays in localStorage, so the app knows which
// Mac to talk to before the async Keychain read comes back.
let SERVER = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {} } catch { return {} } })()

// On the phone the token is stripped from that copy and fetched from the
// Keychain once at startup. Until it lands, requests go out unauthenticated and
// get a 401 — which is the correct failure, not a leak.
if (SS()) {
  if (SERVER.token) {
    // migrate a token written by an older build, then remove the plaintext one
    SS().set({ key: KEY, value: SERVER.token }).catch(() => {})
    const { token, ...rest } = SERVER
    localStorage.setItem(KEY, JSON.stringify(rest))
  }
  SS().get({ key: KEY })
    .then(r => { if (r?.value) SERVER = { ...SERVER, token: r.value } })
    .catch(() => {})
}

export function getServer () { return { ...SERVER } }
export function setServer (s) {
  // A token with no base is valid: the page is served by the shared server
  // itself, so the address is this origin and only the token is needed.
  if (!s || (!s.base && !s.token)) SERVER = {}
  else SERVER = { base: s.base ? String(s.base).replace(/\/$/, '') : '', token: s.token || '' }
  const ss = SS()
  if (ss) {
    // Keychain holds the token; localStorage holds only the address.
    if (SERVER.token) ss.set({ key: KEY, value: SERVER.token }).catch(() => {})
    else ss.remove({ key: KEY }).catch(() => {})
    const { token, ...rest } = SERVER
    localStorage.setItem(KEY, JSON.stringify(rest))
  } else {
    localStorage.setItem(KEY, JSON.stringify(SERVER))
  }
}
export function apiUrl (path) { return (SERVER.base || '') + path }
export function authHeaders (extra = {}) { return SERVER.token ? { ...extra, 'x-radiant-token': SERVER.token } : { ...extra } }
// WebSocket URL for the terminal, honoring a remote server + token.
export function wsUrl (path) {
  if (!SERVER.base) { const p = location.protocol === 'https:' ? 'wss' : 'ws'; return `${p}://${location.host}${path}` }
  const u = new URL(SERVER.base)
  const proto = u.protocol === 'https:' ? 'wss' : 'ws'
  const sep = path.includes('?') ? '&' : '?'
  return `${proto}://${u.host}${path}${SERVER.token ? `${sep}token=${encodeURIComponent(SERVER.token)}` : ''}`
}
// Verify a remote server is reachable with the given token (used by the connect UI).
// Is this page being served BY a Radiant server? Then it already knows the
// address — only the token is missing, and asking a phone to retype an IP it
// is literally connected to is busywork.
export function servedByRadiant () {
  return !SERVER.base && location.protocol.startsWith('http')
}
// Sign in against the server that served this page (the phone case).
export async function connectHere (token) {
  await testServer(location.origin, token)
  setServer({ base: '', token })
  return true
}
/**
 * Normalize what someone typed into an address we can actually fetch.
 *
 * ⚠️ A BARE HOSTNAME IS THE DANGEROUS CASE, not an obviously wrong one. Typed
 * without a scheme, `mac.tailnet.ts.net` makes `fetch()` build a RELATIVE url —
 * which on the phone resolves against `radiant://localhost/`, hits the app's own
 * bundled server, and gets the SPA fallback: index.html, with status 200. The
 * old check was `res.ok`, so that read as a successful connection to a Mac that
 * was never contacted. Assume https rather than fail, since that is what the
 * user meant, and make the http case an explicit refusal.
 */
/**
 * Is this host on the user's own network?
 *
 * ⚠️ THIS LIST MUST MATCH iOS's IDEA OF "LOCAL", or the app will accept an
 * address that ATS then refuses and the user gets a failure with no explanation.
 * NSAllowsLocalNetworking covers RFC1918 (10/8, 172.16/12, 192.168/16),
 * link-local 169.254/16, and .local names — and NOTHING ELSE.
 *
 * ⚠️ 100.64/10 IS NOT IN IT. Tailscale addresses live in that range and look
 * private, but it is RFC6598 shared address space and ATS treats it as public.
 * A Tailscale user needs the https Serve address, which is what the Mac now
 * hands them.
 */
function isLocalHost (host) {
  const h = String(host || '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.local')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 127) return true
  return false
}

function normalizeBase (raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '')
  if (!v) throw new Error('Enter the address of the Mac running Radiant.')
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
  // A bare address on your own network is the common case — someone typing
  // what the Mac showed them — so assume http there and https everywhere else.
  let candidate
  if (hasScheme) candidate = v
  else {
    const host = v.split('/')[0].split(':')[0]
    candidate = (isLocalHost(host) ? 'http://' : 'https://') + v
  }
  let u
  try { u = new URL(candidate) } catch { throw new Error('That does not look like a web address.') }
  // ⚠️ THE http RULE IS iOS's, NOT OURS — SO ONLY APPLY IT ON iOS. App Transport
  // Security refuses plain http to anything outside the local ranges, so on the
  // phone this has to be caught before the request hangs. The MAC HAS NO SUCH
  // RESTRICTION: Electron talks plain http to any host, and Mac-to-Mac over a
  // Tailscale address has always worked that way — Settings.jsx even prepends
  // http:// deliberately.
  //
  // I shipped this check unconditionally in shared code and broke exactly that:
  // the Mac's "Connect & reload" started throwing an iPhone error at a Mac.
  // A platform rule belongs behind a platform check.
  const onPhone = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true
  if (onPhone && u.protocol === 'http:' && !isLocalHost(u.hostname)) {
    throw new Error('That address is http, and iPhone only allows that on your own Wi-Fi. Use the https address your Mac shows you.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Use a web address starting http or https.')
  return candidate.replace(/\/+$/, '')
}

/**
 * Can we reach a Radiant on that Mac, and is it really Radiant?
 *
 * ⚠️ IT MUST TIME OUT. Tony, out of the house: "i entered info clicked connect
 * and nothing happened." A bare fetch to a Mac that is asleep, or to a Tailscale
 * name that does not resolve off the tailnet, does not fail fast — iOS will sit
 * on it for a minute or more. The button said "Connecting…" and the app looked
 * dead. Any network call the user is WAITING ON needs a deadline shorter than
 * their patience.
 *
 * ⚠️ AND `res.ok` IS NOT PROOF. See normalizeBase: the app's own server answers
 * 200 with HTML. The body has to parse as Radiant's config before this returns
 * true.
 */
const TEST_TIMEOUT_MS = 12000

export async function testServer (base, token) {
  const url = normalizeBase(base)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url + '/api/config', {
      cache: 'no-store',
      headers: token ? { 'x-radiant-token': token } : {},
      credentials: 'same-origin',
      signal: ctl.signal
    })
  } catch (e) {
    if (e?.name === 'AbortError') {
      // ⚠️ NAME THE MISTAKE IF WE CAN SEE IT. A raw Tailscale address times out
      // in a way that looks identical to a sleeping Mac, and Tony lost an
      // evening to exactly that: he picked 100.64.118.54:5834 from the Mac's own
      // list, and both readings of it dead-end — plain http is refused by iOS,
      // and there is no TLS on that port to fall back to, so the handshake just
      // hangs. Telling him "your Mac is probably asleep" when it was answering
      // in 45ms sent him looking in the wrong place.
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(new URL(url).hostname)) {
        throw new Error("That is a Tailscale IP address, and iPhone can't use one — it needs the https address instead. On your Mac, Settings → Devices shows it; it looks like https://your-mac.your-tailnet.ts.net")
      }
      throw new Error(`No answer from that Mac after ${TEST_TIMEOUT_MS / 1000} seconds. Check Radiant is open on it, and that both devices are on Tailscale.`)
    }
    throw new Error("Couldn't reach that server. Check the address is right, Radiant is running and shared on the host (v0.6.9+), and both devices are on Tailscale.")
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) throw new Error('Reached the server, but the access token is wrong or missing.')
  if (!res.ok) throw new Error(`Server responded ${res.status}`)
  // Prove it is Radiant and not this app's own index.html.
  let cfg
  try { cfg = await res.json() } catch {
    throw new Error('Something answered at that address, but it is not Radiant.')
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Something answered at that address, but it is not Radiant.')
  }
  return url
}

/**
 * ⚠️ REST CALLS GET A DEADLINE. Same lesson as testServer: when the Mac at the
 * other end goes to sleep mid-session, a bare fetch does not fail — iOS holds
 * the connection for a minute or more and the UI just stops. Every screen that
 * awaits this shows a spinner, so a hang here is indistinguishable from a bug.
 *
 * ⚠️ NOT APPLIED TO STREAMING. /api/chat and the download endpoints are
 * deliberately separate fetch calls below: a token stream legitimately runs for
 * minutes, and a total-duration timeout would cut off long answers. Those need
 * a connection deadline rather than a total one — noted, not yet done.
 *
 * 30s is generous for any REST call this talks to, and far short of the silent
 * minute-plus iOS would otherwise spend.
 */
const REST_TIMEOUT_MS = 30000

async function json (method, path, body) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), REST_TIMEOUT_MS)
  let res
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: authHeaders(body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      // ⚠️ THE SERVER'S no-store CANNOT EVICT WHAT IS ALREADY CACHED.
      //
      // Express stamps an ETag on every JSON response and nothing set a cache
      // directive, so the webview cached /api/ reads — from stable URLs, into a
      // cache that lives in the user data folder and survives quitting,
      // restarting, reinstalling, and replacing the app bundle entirely.
      //
      // Adding no-store on the server only marks responses it actually serves.
      // An entry already sitting in that cache is returned without a request
      // ever reaching the server, so the new header is never seen. Tony's
      // sidebar kept reading 0.6.128 out of a cache from days earlier while the
      // About pane, which had stopped asking the server at all, showed 0.6.133:
      // "nav bar says .128 about screen says 133."
      //
      // Only the caller can refuse the cache. This does, for every API call.
      cache: 'no-store',
      signal: ctl.signal
    })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('The Mac stopped answering. It may have gone to sleep, or you may have left the tailnet.')
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    let msg = `${res.status}`
    let body = null
    // ⚠️ KEEP THE BODY. Only `.error` used to survive, so an endpoint that
    // answers a 4xx with structured detail — "this needs a decision, here are
    // the options" — arrived at the caller as a bare string and the decision
    // could not be offered.
    try { body = await res.json(); msg = body.error || msg } catch {}
    const e = new Error(msg)
    e.status = res.status
    e.body = body
    throw e
  }
  return res.json()
}

export const api = {
  getConfig: () => json('GET', '/api/config'),
  // ⚠️ ANNOUNCE HERE, NOT AT THE CALL SITES. Settings runs in its own Electron
  // window with its own copy of the config, so a change there is invisible to
  // the main window until something refetches. There are TWO save handlers —
  // App.jsx and SettingsWindow.jsx — and putting the announcement in one of
  // them fixed nothing, because the Settings window uses the other. One place
  // that every caller already goes through cannot be half-wired.
  saveSettings: async patch => {
    const cfg = await json('PUT', '/api/settings', patch)
    try { window.radiantNative?.notifyConfigChanged?.() } catch {}
    return cfg
  },
  setKey: (providerId, key, opts) => json('POST', `/api/providers/${providerId}/key`, { key, ...(opts || {}) }),
  addProvider: p => json('POST', '/api/providers', p),
  removeProvider: id => json('DELETE', `/api/providers/${id}`),
  activateAccount: (providerId, accountId) => json('POST', `/api/providers/${providerId}/accounts/activate`, { accountId }),
  removeAccount: (providerId, acctId) => json('DELETE', `/api/providers/${providerId}/accounts/${acctId}`),
  designOpen: url => json('POST', '/api/design/open', { url }),
  designPick: () => json('POST', '/api/design/pick'),
  getStorage: () => json('GET', '/api/storage'),
  clearSessions: days => json('POST', '/api/storage/clear-sessions', { days }),
  getModels: () => json('GET', '/api/models'),
  exportChat: (id, format) => json('GET', `/api/sessions/${id}/export?format=${format || 'json'}`),
  exportAllChats: () => json('GET', '/api/chats/export'),
  importChats: payload => json('POST', '/api/chats/import', payload),
  getDataDir: () => json('GET', '/api/data-dir'),
  getSyncTargets: () => json('GET', '/api/sync-targets'),
  setDataDir: body => json('POST', '/api/data-dir', body),
  listProjects: () => json('GET', '/api/projects'),
  createProject: body => json('POST', '/api/projects', body || {}),
  patchProject: (id, body) => json('PATCH', `/api/projects/${id}`, body),
  deleteProject: id => json('DELETE', `/api/projects/${id}`),
  listSessions: () => json('GET', '/api/sessions'),
  searchSessions: q => json('GET', `/api/sessions-search?q=${encodeURIComponent(q)}`),
  createSession: body => json('POST', '/api/sessions', body || {}),
  getSession: id => json('GET', `/api/sessions/${id}`),
  patchSession: (id, body) => json('PATCH', `/api/sessions/${id}`, body),
  deleteSession: id => json('DELETE', `/api/sessions/${id}`),
  truncateSession: (id, index) => json('POST', `/api/sessions/${id}/truncate`, { index }),
  forkSession: (id, index) => json('POST', `/api/sessions/${id}/fork`, { index }),
  approve: (id, approved) => json('POST', '/api/approve', { id, approved }),
  abort: sessionId => json('POST', '/api/abort', { sessionId }),
  getSystem: () => json('GET', '/api/system'),
  getLocalModels: () => json('GET', '/api/local-models'),
  deleteLocalModel: name => json('DELETE', `/api/local-models/${encodeURIComponent(name)}`),
  registrySearch: (q, sort = 'downloads') => json('GET', `/api/registry-search?q=${encodeURIComponent(q)}&sort=${sort}`),
  registryFiles: repo => json('GET', `/api/registry-files?repo=${encodeURIComponent(repo)}`),
  oauthProviders: () => json('GET', '/api/oauth/providers'),
  oauthStart: (id, opts) => json('POST', `/api/oauth/${id}/start`, opts || {}),
  oauthComplete: (id, code) => json('POST', `/api/oauth/${id}/complete`, { code }),
  oauthStatus: id => json('GET', `/api/oauth/${id}/status`),
  oauthSignout: id => json('POST', `/api/oauth/${id}/signout`),
  oauthDeviceStart: (id, opts) => json('POST', `/api/oauth/${id}/device/start`, opts || {}),
  oauthDevicePoll: id => json('POST', `/api/oauth/${id}/device/poll`),
  getVersion: () => json('GET', '/api/version'),
  updateCheck: () => json('GET', '/api/update-check'),
  computerStatus: () => json('GET', '/api/computer-status'),
  quantizeCandidates: () => json('GET', '/api/quantize/candidates'),
  getUsage: () => json('GET', '/api/usage'),
  searchFiles: (cwd, q) => json('GET', `/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`),
  addSkill: skill => json('POST', '/api/skills', skill),
  updateSkill: (id, patch) => json('PATCH', `/api/skills/${id}`, patch),
  deleteSkill: id => json('DELETE', `/api/skills/${id}`),
  acceptSkillSuggestion: id => json('POST', `/api/skill-suggestions/${id}/accept`),
  rejectSkillSuggestion: id => json('POST', `/api/skill-suggestions/${id}/reject`),
  addRecipe: r => json('POST', '/api/recipes', r),
  updateRecipe: (id, patch) => json('PATCH', `/api/recipes/${id}`, patch),
  deleteRecipe: id => json('DELETE', `/api/recipes/${id}`),
  externalAgents: () => json('GET', '/api/external-agents'),
  addAgent: agent => json('POST', '/api/agents', agent),
  updateAgent: (id, patch) => json('PATCH', `/api/agents/${id}`, patch),
  deleteAgent: id => json('DELETE', `/api/agents/${id}`),
  mcpStatus: () => json('GET', '/api/mcp/status'),
  addMcp: server => json('POST', '/api/mcp', server),
  updateMcp: (id, patch) => json('PATCH', `/api/mcp/${id}`, patch),
  deleteMcp: id => json('DELETE', `/api/mcp/${id}`),
  getShare: () => json('GET', '/api/share'),
  setShare: enabled => json('POST', '/api/share', { enabled }),
  openFile: p => json('POST', '/api/open', { path: p }),
  answerQuestion: (id, answer) => json('POST', '/api/answer-question', { id, answer }),
  getMemory: () => json('GET', '/api/memory'),
  addMemory: text => json('POST', '/api/memory', { text }),
  deleteMemory: id => json('DELETE', `/api/memory/${id}`),
  clearMemory: () => json('POST', '/api/memory/clear')
}

// POST /api/quantize streams progress lines back on the response body.
export async function streamQuantize (body, onEvent) {
  const res = await fetch(apiUrl('/api/quantize'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5))) } catch {}
    }
  }
}

// POST /api/pull streams SSE progress events back on the response body.
export async function streamPull (model, onEvent, signal) {
  const res = await fetch(apiUrl('/api/pull'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model }),
    signal
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5))) } catch {}
    }
  }
}

// Downloads run detached on the server; start one, then poll getDownloads().
export async function startDownload ({ repo, files, model }) {
  const res = await fetch(apiUrl('/api/download'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ repo, files, model })
  })
  if (!res.ok) { let m = `${res.status}`; try { m = (await res.json()).error || m } catch {}; throw new Error(m) }
  return res.json()
}
export async function getDownloads () {
  const res = await fetch(apiUrl('/api/downloads'), { cache: 'no-store', headers: authHeaders() })
  return res.ok ? res.json() : []
}
export async function cancelDownload (model) {
  await fetch(apiUrl('/api/download/cancel'), { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ model }) })
}

// POST /api/chat streams SSE back on the response body.
export async function streamChat (sessionId, content, onEvent, skillIds) {
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ sessionId, content, ...(skillIds?.length ? { skillIds } : {}) })
  })
  if (!res.ok) {
    let msg = `${res.status}`
    try { msg = (await res.json()).error || msg } catch {}
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5))) } catch {}
    }
  }
}

/**
 * Write a file the user asked for, and say where it went.
 *
 * In the app this is a real Save dialog over IPC; in a browser it is a blob
 * download, which is that platform's equivalent. Returns the path when we know
 * it, '' when the browser handled it, and null if the user cancelled.
 */
export async function saveToFile (name, mime, content) {
  if (window.radiantNative?.saveFile) {
    return await window.radiantNative.saveFile({ name, content })
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return ''
}
