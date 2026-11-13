import crypto from 'crypto'
import http from 'http'
import { fetchRetry, isTransient } from './util.js'

// Subscription sign-in via each vendor's own OAuth client (the same public
// PKCE clients their official CLIs use). This is UNOFFICIAL: vendors license
// subscriptions for their own apps, so tokens are presented the way the CLI
// presents them. Constants here mirror the official clients and may need
// updating if a vendor changes their flow.

export const OAUTH_PROVIDERS = {
  anthropic: {
    label: 'Claude (Pro / Max)',
    mode: 'paste', // user copies a code from the callback page
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    scope: 'org:create_api_key user:profile user:inference'
  },
  openai: {
    label: 'ChatGPT (Plus / Pro)',
    mode: 'loopback', // vendor redirects to a localhost port we listen on
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectPort: 1455,
    redirectPath: '/auth/callback',
    get redirectUri () { return `http://localhost:${this.redirectPort}${this.redirectPath}` },
    scope: 'openid profile email offline_access'
  },
  nousresearch: {
    label: 'Nous Portal',
    mode: 'device', // device-authorization grant: user enters a code on the Portal
    deviceCodeUrl: 'https://portal.nousresearch.com/api/oauth/device/code',
    tokenUrl: 'https://portal.nousresearch.com/api/oauth/token',
    clientId: 'hermes-cli',
    scope: 'inference:invoke'
  },
  xai: {
    label: 'xAI (Grok)',
    mode: 'device', // xAI's auth.x.ai OIDC server supports the device-code grant
    deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828', // public client id used by the grok CLI
    scope: 'openid profile email offline_access grok-cli:access api:access'
  },
  copilot: {
    label: 'GitHub Copilot',
    mode: 'device', // GitHub device flow → a GitHub token, then exchanged for a short-lived Copilot token
    deviceCodeUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientId: 'Iv1.b507a08c87ecfe98', // the public VS Code Copilot client id
    scope: 'read:user',
    custom: 'copilot'
  },
  qwen: {
    label: 'Qwen',
    mode: 'device', // Qwen's chat.qwen.ai device grant (PKCE required)
    deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
    tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
    clientId: 'f0304373b74a44d2b584a3fb70ca9e56', // public qwen-code client id
    scope: 'openid profile email model.completion',
    pkce: true, // device request must carry a PKCE challenge
    custom: 'qwen'
  }
}

// Copilot editor identification headers, required on every api.githubcopilot.com call.
export const COPILOT_HEADERS = {
  'Copilot-Integration-Id': 'vscode-chat',
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.22.0',
  'Openai-Intent': 'conversation-panel'
}

// Exchange a GitHub OAuth token for a short-lived Copilot API token.
async function exchangeCopilot (githubToken) {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { authorization: `token ${githubToken}`, accept: 'application/json', ...COPILOT_HEADERS }
  })
  if (!res.ok) throw new Error(res.status === 403 ? 'This GitHub account has no active Copilot subscription.' : `Copilot token exchange failed (${res.status})`)
  const j = await res.json()
  return { token: j.token, expires: (j.expires_at ? j.expires_at * 1000 : Date.now() + 25 * 60_000) }
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// decode a JWT payload (no verification — we only read our own token's claims)
function jwtClaims (jwt) {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString('utf8')) } catch { return {} }
}
// ChatGPT (Codex) responses backend needs the account id from the id_token
export function chatgptAccountId (idToken) {
  const c = jwtClaims(idToken)
  return c['https://api.openai.com/auth']?.chatgpt_account_id || c.chatgpt_account_id || null
}

export function makePkce () {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// pending flows keyed by providerId: { verifier, server? }
const pending = new Map()

export function buildAuthUrl (providerId) {
  const p = OAUTH_PROVIDERS[providerId]
  if (!p) throw new Error('unknown oauth provider')
  const { verifier, challenge } = makePkce()
  pending.set(providerId, { verifier })
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier
  })
  if (providerId === 'anthropic') params.set('code', 'true')
  return { url: `${p.authorizeUrl}?${params}`, mode: p.mode }
}

async function exchange (providerId, code) {
  const p = OAUTH_PROVIDERS[providerId]
  const flow = pending.get(providerId)
  if (!flow) throw new Error('no sign-in in progress — start again')
  // Anthropic returns "code#state"; keep only the code half.
  const cleanCode = String(code).split('#')[0].split('&')[0].trim()
  const body = {
    grant_type: 'authorization_code',
    code: cleanCode,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: flow.verifier,
    state: flow.verifier
  }
  const res = await fetchRetry(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    if (isTransient(res.status)) throw new Error(`${p.label} sign-in hit a temporary server error (${res.status}). Wait a few seconds and try again.`)
    throw new Error(`token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
  const json = await res.json()
  pending.delete(providerId)
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    idToken: json.id_token || null,
    accountId: chatgptAccountId(json.id_token),
    expires: Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600_000)
  }
}

// paste-mode: caller hands us the code from the callback page
export function completePaste (providerId, code) {
  return exchange(providerId, code)
}

// loopback-mode: stand up a one-shot listener, resolve when the vendor redirects
export function startLoopback (providerId, onDone) {
  const p = OAUTH_PROVIDERS[providerId]
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${p.redirectPort}`)
    if (!u.pathname.startsWith(p.redirectPath)) { res.writeHead(404); res.end(); return }
    const code = u.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body style="font-family:system-ui;background:#141517;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Radiant is signed in</h2><p>You can close this tab and return to Radiant.</p></div></body></html>')
    server.close()
    try {
      if (!code) throw new Error('no code in callback')
      onDone(null, await exchange(providerId, code))
    } catch (e) { onDone(e) }
  })
  server.on('error', e => onDone(e))
  server.listen(p.redirectPort, '127.0.0.1')
  pending.set(providerId, { ...(pending.get(providerId) || {}), server })
}

export async function refreshToken (providerId, tok) {
  const p = OAUTH_PROVIDERS[providerId]
  const res = await fetchRetry(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: p.clientId })
  })
  if (!res.ok) {
    const transient = isTransient(res.status) || res.status === 429
    const e = new Error(transient ? `${p.label} servers are temporarily unavailable (${res.status}) — try again shortly.` : `Your ${p.label} sign-in has expired. Sign in again in Settings → Providers.`)
    e.permanent = !transient
    throw e
  }
  const json = await res.json()
  return {
    access: json.access_token,
    refresh: json.refresh_token || tok.refresh,
    idToken: json.id_token || tok.idToken || null,
    accountId: chatgptAccountId(json.id_token) || tok.accountId || null,
    expires: Date.now() + (json.expires_in ? json.expires_in * 1000 : 3600_000)
  }
}

// ---------- device-authorization grant (Nous Portal) ----------
// The user opens a URL and enters a short code; we poll the token endpoint.
export async function startDevice (providerId) {
  const p = OAUTH_PROVIDERS[providerId]
  if (!p || p.mode !== 'device') throw new Error('not a device-code provider')
  const params = { client_id: p.clientId, scope: p.scope }
  let verifier = null
  if (p.pkce) {
    const pk = makePkce()
    verifier = pk.verifier
    params.code_challenge = pk.challenge
    params.code_challenge_method = 'S256'
  }
  const res = await fetch(p.deviceCodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params)
  })
  if (!res.ok) throw new Error(`couldn't start sign-in (${res.status})`)
  const j = await res.json()
  pending.set(providerId, { deviceCode: j.device_code, verifier })
  return {
    userCode: j.user_code,
    verificationUrl: j.verification_uri_complete || j.verification_uri,
    interval: j.interval || 5,
    expiresIn: j.expires_in || 600
  }
}

// poll once; returns { done:false } while pending, { done:true } once signed in
export async function pollDevice (providerId) {
  const p = OAUTH_PROVIDERS[providerId]
  const flow = pending.get(providerId)
  if (!flow?.deviceCode) throw new Error('no sign-in in progress — start again')
  const tokenParams = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: p.clientId, device_code: flow.deviceCode }
  if (flow.verifier) tokenParams.code_verifier = flow.verifier
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(tokenParams)
  })
  const j = await res.json().catch(() => ({}))
  if (res.ok && j.access_token) {
    pending.delete(providerId)
    // Copilot: the GitHub token is only the first leg — exchange it for a Copilot API token.
    if (p.custom === 'copilot') {
      const cop = await exchangeCopilot(j.access_token)
      return { done: true, token: { github: j.access_token, access: cop.token, expires: cop.expires } }
    }
    const token = { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + (j.expires_in ? j.expires_in * 1000 : 300_000) }
    // Qwen returns the API host to use in the token payload.
    if (p.custom === 'qwen' && j.resource_url) token.apiBase = /^https?:\/\//.test(j.resource_url) ? j.resource_url : `https://${j.resource_url}/v1`
    return { done: true, token }
  }
  if (j.error === 'authorization_pending' || j.error === 'slow_down') return { done: false }
  throw new Error(j.error_description || j.error || `sign-in failed (${res.status})`)
}

// Standard OIDC refresh for device-code providers (form-encoded, per RFC 6749).
async function refreshDevice (providerId, tok) {
  const p = OAUTH_PROVIDERS[providerId]
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: p.clientId })
  })
  if (!res.ok) throw new Error(`${p.label} session expired — sign in again (${res.status})`)
  const j = await res.json()
  const apiBase = j.resource_url
    ? (/^https?:\/\//.test(j.resource_url) ? j.resource_url : `https://${j.resource_url}/v1`)
    : tok.apiBase
  return {
    access: j.access_token,
    refresh: j.refresh_token || tok.refresh,
    idToken: j.id_token || tok.idToken || null,
    ...(apiBase ? { apiBase } : {}),
    expires: Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600_000)
  }
}

// Nous rotates a single-use refresh token and passes it in a custom header.
async function refreshNous (tok) {
  const p = OAUTH_PROVIDERS.nousresearch
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-nous-refresh-token': tok.refresh },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: p.clientId })
  })
  if (!res.ok) throw Object.assign(new Error(`Nous session expired — sign in again (${res.status})`), { permanent: !isTransient(res.status) && res.status !== 429 })
  const j = await res.json()
  return { access: j.access_token, refresh: j.refresh_token || tok.refresh, expires: Date.now() + (j.expires_in ? j.expires_in * 1000 : 300_000) }
}

// ⚠️ ONE REFRESH PER PROVIDER AT A TIME. Refresh tokens are single-use (Nous
// says so outright; OpenAI rotates too), and parallel graph nodes or a chat plus
// its title call each found the token expired and each refreshed with the same
// refresh token — the second was refused and reported "session expired" though
// nothing had. Concurrent callers now share one refresh, and a caller holding an
// older copy of the config gets the token already minted instead of spending a
// dead refresh token.
const refreshing = new Map() // providerId -> Promise<fresh token record>
const minted = new Map()     // providerId -> newest token record this process got

// ⚠️ A DEAD SIGN-IN WAS SILENT AND HAMMERED. Anthropic refused Tony's refresh token
// ("not found or invalid") from Oct 16; every model-list load retried it, the error was
// swallowed, the whole Anthropic group vanished, and Settings still said "✓ subscription".
// "why did anthropic subscription disappear?" The failure is now remembered against the
// refresh token that failed: a refused one is not retried until a new sign-in replaces it,
// a temporary one waits 5 minutes, and signInProblem() lets the UI say so.
const renewFailures = new Map() // providerId -> { refresh, message, permanent, at }
export function signInProblem (providerId, config) {
  const tok = config.oauth?.[providerId]
  const f = renewFailures.get(providerId)
  return tok && f && f.refresh === tok.refresh ? f.message : null
}

// returns a valid access token, refreshing in-place on config if near expiry
export async function validAccessToken (providerId, config, saveConfig) {
  const tok = config.oauth?.[providerId]
  if (!tok) return null
  // Copilot re-mints from the GitHub token; Nous invoke JWTs are short-lived.
  const skew = providerId === 'copilot' ? 120_000 : providerId === 'nousresearch' ? 130_000 : 60_000
  if (tok.expires - Date.now() > skew) return tok.access
  const newer = minted.get(providerId)
  if (newer && newer.expires > tok.expires && newer.expires - Date.now() > skew) { config.oauth[providerId] = newer; return newer.access }
  const failed = renewFailures.get(providerId)
  if (failed && failed.refresh === tok.refresh && (failed.permanent || Date.now() - failed.at < 5 * 60_000)) throw new Error(failed.message)
  let job = refreshing.get(providerId)
  if (!job) {
    job = (async () => {
      const fresh = providerId === 'copilot'
        ? await exchangeCopilot(tok.github).then(cop => ({ github: tok.github, access: cop.token, expires: cop.expires }))
        : providerId === 'nousresearch'
          ? await refreshNous(tok)
          : OAUTH_PROVIDERS[providerId]?.mode === 'device'
            ? await refreshDevice(providerId, tok)
            : await refreshToken(providerId, tok)
      renewFailures.delete(providerId)
      minted.set(providerId, fresh)
      config.oauth[providerId] = fresh
      saveConfig(config)
      return fresh
    })().catch(e => {
      renewFailures.set(providerId, { refresh: tok.refresh, message: e.message, permanent: Boolean(e.permanent), at: Date.now() })
      throw e
    }).finally(() => refreshing.delete(providerId))
    refreshing.set(providerId, job)
  }
  const fresh = await job
  config.oauth[providerId] = fresh
  return fresh.access
}
