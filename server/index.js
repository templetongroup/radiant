import express from 'express'
import { listGatewayAgents } from './openclaw.js'
import http from 'http'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { execFileSync } from 'node:child_process'
import { promises as dnsp } from 'node:dns'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { execSync, spawn } from 'child_process'
import { RADIANT_DIR, DIR_POINTER, defaultDataDir, dataDirStatus, loadConfig, saveConfig, publicConfig, listSessions, loadSession, saveSession, deleteSession, searchSessions, upsertCredential, activateAccount, removeAccount, SESSIONS_DIR } from './config.js'
import { runTurn, listModels } from './providers.js'
import { OAUTH_PROVIDERS, buildAuthUrl, completePaste, startLoopback, validAccessToken, startDevice, pollDevice } from './oauth.js'
import { checkForUpdate } from './updater.js'
import { ollamaBin, hermesBin, SPAWN_ENV } from './ollama.js'
import { commandRisk } from './util.js'
import { listFacts, addFacts, addFactManual, deleteFact, clearFacts, relevantFacts } from './memory.js'
import { shouldReflect, reflectionPrompt, parseProposal, addSuggestion } from './skillsmith.js'

const PORT = Number(process.env.RADIANT_PORT || 5834)
const app = express()

// CORS: a remote client (another Mac's app, or a phone browser) talks to this
// server from a different origin. Allow it and answer preflight BEFORE auth — the
// custom x-radiant-token header triggers a preflight OPTIONS that carries no token.
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-radiant-token, authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '86400')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json({ limit: '10mb' }))

const __dirname0 = path.dirname(fileURLToPath(import.meta.url))
const APP_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname0, '..', 'package.json'), 'utf8')).version } catch { return '0.0.0' }
})()

let config = loadConfig()

// ---- network sharing --------------------------------------------------------
// Normally the server binds to localhost only. On an always-on "host" Mac you can
// share it so other Macs and phones connect as clients. When shared it binds to
// all interfaces and requires an access token on every /api and /term request
// (loopback — the app on the host machine itself — is exempt). Reachability is
// expected to go over Tailscale; the token is a second lock.
const share0 = config.settings.share || {}
const SHARE_ENABLED = process.env.RADIANT_SHARE === '1' || Boolean(share0.enabled)
const SHARE_TOKEN = process.env.RADIANT_TOKEN || share0.token || null
const BIND_HOST = SHARE_ENABLED ? '0.0.0.0' : '127.0.0.1'
// ⚠️ A LOOPBACK SOCKET IS NOT PROOF THE CLIENT IS LOCAL.
//
// Loopback skips the access token, which is right for the app talking to its
// own embedded server. But put ANY reverse proxy in front — Tailscale Serve,
// nginx, Caddy — and the proxy connects from 127.0.0.1, so every remote
// request looks local and the token check is skipped entirely. Verified
// 2026-08-23: through `tailscale serve`, /api/config returned 200 with no
// token, from another machine. Radiant runs shell commands, so that is a
// full compromise of the host, and with `tailscale funnel` it would be open
// to the internet.
//
// Any forwarding header means the request was relayed and the peer address
// belongs to the proxy, not the client. Those requests must present a token.
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'tailscale-user-login']
function isLocalRequest (req) {
  for (const h of PROXY_HEADERS) if (req.headers?.[h]) return false
  const ra = req.socket?.remoteAddress
  return !ra || ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
}
// The cookie is what keeps a phone signed in. localStorage on an iOS Home
// Screen app is separate from Safari's and can be evicted, which is why the
// token screen kept coming back; an httpOnly cookie survives both and is not
// readable by page scripts.
const TOKEN_COOKIE = 'radiant_token'
function cookieToken (req) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() !== TOKEN_COOKIE) continue
    try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return null }
  }
  return null
}
function setTokenCookie (res) {
  // a year, so "add to Home Screen" is a one-time setup
  res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${encodeURIComponent(SHARE_TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`)
}
function presentedToken (req) {
  return req.headers['x-radiant-token'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    cookieToken(req) || null
}
function tokenOk (req) {
  if (isLocalRequest(req)) return true
  if (!SHARE_TOKEN) return false
  return presentedToken(req) === SHARE_TOKEN
}
/**
 * The https address a phone can use to reach this Mac from anywhere.
 *
 * ⚠️ DERIVED AND VERIFIED — NOT ASKED OF A CLI. The first version shelled out to
 * the `tailscale` binary at three guessed paths. On Tony's dev-mbp that failed
 * silently: the machine demonstrably had Serve running (its https address
 * answered 401 in 45ms) and the panel still offered a Wi-Fi address, because the
 * binary was not where I guessed or could not be executed from the packaged app.
 * A detector that reports "no" when the answer is "yes" is worse than none — it
 * sent him to an address that cannot work from a phone.
 *
 * Two steps, neither of which needs a binary:
 *  1. REVERSE-DNS the tailnet address. MagicDNS publishes PTR records, so
 *     100.64.118.54 resolves to dev-mbp.tail1207dc.ts.net with a plain lookup.
 *  2. ACTUALLY FETCH IT. Deriving the name proves nothing about whether Serve is
 *     in front of it — so the URL is only offered once it has answered. 401 is
 *     the expected answer here and counts: it means Radiant is behind it and
 *     wants a token.
 */
let remoteUrl = null          // last verified https address, or null
let remoteCheckedAt = 0

function tailnetAddress () {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) return a.address
    }
  }
  return null
}

async function refreshRemoteUrl () {
  remoteCheckedAt = Date.now()
  const ip = tailnetAddress()
  if (!ip) { remoteUrl = null; return null }
  let name
  try { [name] = await dnsp.reverse(ip) } catch { remoteUrl = null; return null }
  if (!name) { remoteUrl = null; return null }
  const url = `https://${String(name).replace(/\.$/, '')}`
  try {
    const r = await fetch(url + '/api/config', { signal: AbortSignal.timeout(5000) })
    // 401 is success for this purpose: something is serving Radiant over TLS.
    remoteUrl = (r.status === 401 || r.ok) ? url : null
  } catch { remoteUrl = null }
  return remoteUrl
}

/**
 * Ask Tailscale to put the https front door up, when its CLI is available.
 *
 * ⚠️ BEST EFFORT ONLY, AND NOTHING DEPENDS ON IT. If the binary is missing or
 * unrunnable this quietly does nothing, and refreshRemoteUrl() still finds the
 * address when Serve was configured some other way — which is exactly the case
 * that was broken before.
 *
 * ⚠️ SERVE, NEVER FUNNEL. Serve publishes to the user's own tailnet, which is
 * what "share with my devices" asks for. Funnel would publish to the open
 * internet. One word apart; only one of them is consented to.
 */
function enableTailscaleServe (port) {
  const bins = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale'
  ]
  const bin = bins.find(b => { try { fs.accessSync(b); return true } catch { return false } })
  if (!bin) return
  try {
    execFileSync(bin, ['serve', '--bg', String(port)], { timeout: 15000, stdio: 'ignore' })
  } catch { /* already configured, or not permitted — refreshRemoteUrl decides */ }
}

/**
 * Can a phone reach this Mac, and if not, what does the PERSON need to do?
 *
 * Every `reason` here is written to be shown verbatim to someone who has never
 * heard of Tailscale Serve, because they should not have to.
 */
function phoneStatus () {
  if (remoteUrl) return { ready: true, url: remoteUrl, kind: 'anywhere' }
  if (!tailnetAddress()) return { ready: false, reason: 'no-tailscale' }
  return { ready: false, reason: remoteCheckedAt ? 'no-serve' : 'setting-up' }
}

// LAN / Tailscale addresses this host is reachable at
function hostAddresses () {
  const out = []
  if (remoteUrl) out.push({ address: remoteUrl, label: 'Tailscale', url: remoteUrl, phone: true })
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)
      // ⚠️ A WI-FI ADDRESS IS PHONE-USABLE; A TAILSCALE IP IS NOT.
      // iOS allows plain http to RFC1918 addresses (NSAllowsLocalNetworking),
      // which is how LM Studio and Locally do this and is the everyday case:
      // both devices on the same network, no third-party app at all.
      // 100.64/10 only LOOKS private — it is RFC6598 shared space and ATS
      // treats it as public, so a Tailscale user needs the Serve URL above.
      const local = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)
      out.push({
        address: a.address,
        label: tailscale ? 'Tailscale' : 'Wi-Fi',
        phone: local && !tailscale,
        wifi: local && !tailscale
      })
    }
  }
  // Wi-Fi before Tailscale-only IPs: it is the one most people can use today.
  out.sort((x, y) => (y.phone ? 1 : 0) - (x.phone ? 1 : 0))
  return out
}

// in-flight turn state
const activeTurns = new Map() // sessionId -> { controller }
const pendingApprovals = new Map() // callId -> resolve(bool)
const pendingQuestions = new Map() // questionId -> resolve(answer string)

// Reload config from disk before handling config-touching requests, so a second
// instance (or a stale in-memory copy) can't clobber another's keys/oauth when
// it saves. Skips long-lived streams that captured config at their start.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') &&
      !/^\/api\/(chat|pull|quantize|abort|approve)/.test(req.path)) {
    config = loadConfig()
  }
  next()
})

// Access-token gate for remote clients (loopback is always allowed). Only /api and
// the terminal socket are gated; the static UI loads freely so a phone can reach
// the token-entry screen.
// A link carrying ?token=… signs the device in and drops the token from the URL,
// so "Copy phone link" → open → Add to Home Screen is the whole setup and the
// token never sits in history or a bookmark.
app.get(/^\/(?!api).*/, (req, res, next) => {
  if (!SHARE_TOKEN || req.query.token !== SHARE_TOKEN) return next()
  setTokenCookie(res)
  const url = new URL(req.originalUrl, 'http://x')
  url.searchParams.delete('token')
  res.redirect(302, url.pathname + (url.search || '') + (url.hash || ''))
})

app.use('/api', (req, res, next) => {
  if (!tokenOk(req)) return res.status(401).json({ error: 'This Radiant server requires an access token.' })
  // Presented a good token by header? Leave a cookie so this device stays signed
  // in even if the page's stored copy is cleared.
  if (SHARE_TOKEN && !isLocalRequest(req) && cookieToken(req) !== SHARE_TOKEN) setTokenCookie(res)
  next()
})

// ---------- config ----------
app.get('/api/config', (req, res) => res.json(publicConfig(config)))

app.put('/api/settings', (req, res) => {
  config.settings = { ...config.settings, ...req.body }
  saveConfig(config)
  res.json(publicConfig(config))
})

// current sharing state + the addresses/token other devices use to connect
app.get('/api/share', (req, res) => {
  res.json({
    enabled: SHARE_ENABLED,      // reflects the RUNNING server (needs relaunch to change)
    desired: Boolean(config.settings.share?.enabled),
    token: SHARE_TOKEN,
    port: PORT,
    addresses: hostAddresses(),
    phone: phoneStatus()
  })
})

// toggle sharing (applies on next launch, since the bind host is fixed at boot)
app.post('/api/share', (req, res) => {
  const enabled = Boolean(req.body?.enabled)
  const cur = config.settings.share || {}
  const token = cur.token || crypto.randomBytes(24).toString('base64url')
  config.settings.share = { enabled, token }
  saveConfig(config)
  // Turning sharing on turns the https front door on too. The user asked to
  // share with their devices; wiring up the only transport an iPhone accepts is
  // part of doing that, not a separate chore to hand back to them.
  if (enabled) { try { enableTailscaleServe(PORT) } catch {} ; refreshRemoteUrl().catch(() => {}) }
  res.json({ desired: enabled, enabled: SHARE_ENABLED, token, needsRelaunch: enabled !== SHARE_ENABLED, port: PORT, addresses: hostAddresses(), phone: phoneStatus() })
})

app.post('/api/providers/:id/key', (req, res) => {
  const { key, newAccount, label } = req.body
  if (key) upsertCredential(config, req.params.id, { key }, { label, newAccount })
  else { const a = config.activeAccount?.[req.params.id]; if (a) removeAccount(config, req.params.id, a); else delete config.keys[req.params.id] }
  saveConfig(config)
  res.json(publicConfig(config))
})

// which providers are mid-way through adding a NEW account (vs replacing active)
const addingAccount = new Set()
app.post('/api/providers/:id/accounts/activate', (req, res) => {
  activateAccount(config, req.params.id, req.body.accountId)
  saveConfig(config)
  res.json(publicConfig(config))
})
app.delete('/api/providers/:id/accounts/:acctId', (req, res) => {
  removeAccount(config, req.params.id, req.params.acctId)
  saveConfig(config)
  res.json(publicConfig(config))
})

app.post('/api/providers', (req, res) => {
  const { name, baseUrl, type = 'openai', auth = 'key' } = req.body
  if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl required' })
  const id = 'custom-' + crypto.randomBytes(4).toString('hex')
  config.providers.push({ id, name, type, baseUrl: baseUrl.replace(/\/$/, ''), auth, removable: true })
  saveConfig(config)
  res.json(publicConfig(config))
})

app.delete('/api/providers/:id', (req, res) => {
  const p = config.providers.find(p => p.id === req.params.id)
  if (p && p.removable) {
    config.providers = config.providers.filter(x => x.id !== p.id)
    delete config.keys[p.id]
    // remember removed built-in/preset providers so the merge doesn't re-add them
    if (!p.id.startsWith('custom-')) {
      config.removedProviders = config.removedProviders || []
      if (!config.removedProviders.includes(p.id)) config.removedProviders.push(p.id)
    }
    saveConfig(config)
  }
  res.json(publicConfig(config))
})

// ---------- quantization ----------
app.get('/api/quantize/candidates', async (req, res) => {
  try {
    const { quantizableModels, QUANT_TYPES } = await import('./quantize.js')
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) })
    const data = await r.json()
    const local = (data.models || []).map(m => ({ name: m.name, sizeGB: +(m.size / 1024 ** 3).toFixed(1) }))
    res.json({ models: await quantizableModels(local), quants: QUANT_TYPES })
  } catch (e) {
    res.status(502).json({ error: e.message, models: [], quants: [] })
  }
})

app.post('/api/quantize', async (req, res) => {
  const { source, target, quant } = req.body
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`)
  try {
    const { runQuantize } = await import('./quantize.js')
    await runQuantize({ source, target, quant }, line => emit({ line }))
    emit({ done: true })
  } catch (e) {
    emit({ error: e.message })
  } finally {
    res.end()
  }
})

// ---------- MCP servers ----------
app.get('/api/mcp/status', async (req, res) => {
  try {
    const { mcpStatus } = await import('./mcp.js')
    res.json({ servers: await mcpStatus(config.mcpServers || []) })
  } catch (e) {
    res.json({ servers: [], error: e.message })
  }
})

app.post('/api/mcp', (req, res) => {
  const { name, transport, command, args, env, url } = req.body
  if (!name || (!command && !url)) return res.status(400).json({ error: 'name and a command or url required' })
  config.mcpServers = config.mcpServers || []
  config.mcpServers.push({
    id: 'mcp-' + crypto.randomBytes(4).toString('hex'),
    name, transport: transport || (url ? 'http' : 'stdio'),
    command: command || null, args: Array.isArray(args) ? args : (args ? String(args).split(' ').filter(Boolean) : []),
    env: env || {}, url: url || null, enabled: true
  })
  saveConfig(config)
  res.json(publicConfig(config))
})

app.patch('/api/mcp/:id', async (req, res) => {
  const s = (config.mcpServers || []).find(x => x.id === req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'command', 'args', 'env', 'url', 'enabled']) if (k in req.body) s[k] = req.body[k]
  try { const { disconnect } = await import('./mcp.js'); await disconnect(s.id) } catch {}
  saveConfig(config)
  res.json(publicConfig(config))
})

app.delete('/api/mcp/:id', async (req, res) => {
  try { const { disconnect } = await import('./mcp.js'); await disconnect(req.params.id) } catch {}
  config.mcpServers = (config.mcpServers || []).filter(x => x.id !== req.params.id)
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- workspace file search (for @-mentions) ----------
const FILE_SKIP = new Set(['node_modules', '.git', 'dist', 'release', '.next', 'build', '.cache', 'vendor', '__pycache__'])
app.get('/api/files', (req, res) => {
  const cwd = String(req.query.cwd || os.homedir())
  const q = String(req.query.q || '').toLowerCase()
  const out = []
  const walk = (dir, rel, depth) => {
    if (out.length >= 60 || depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= 60) return
      if (e.name.startsWith('.') && e.name !== '.env') continue
      const rp = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (!FILE_SKIP.has(e.name)) walk(path.join(dir, e.name), rp, depth + 1)
      } else if (!q || rp.toLowerCase().includes(q)) {
        out.push(rp)
      }
    }
  }
  walk(cwd, '', 0)
  // prioritise shallower + name matches
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  res.json(out.slice(0, 30))
})

// ---------- agents ----------
app.post('/api/agents', (req, res) => {
  const { name, emoji, icon, hue, persona, model, provider, skills, useTools, computerControl, plannerModel, plannerProvider, avatar, relay, source } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  config.agents = config.agents || []
  config.agents.push({
    id: 'ag-' + crypto.randomBytes(4).toString('hex'),
    name, emoji: emoji || '🤖', icon: icon || null, hue: hue ?? null, persona: persona || '',
    model: model || null, provider: provider || null, skills: skills || [],
    useTools: useTools !== false, computerControl: Boolean(computerControl),
    plannerModel: plannerModel || null, plannerProvider: plannerProvider || null,
    avatar: avatar || null, relay: relay || null, source: source || null
  })
  saveConfig(config)
  res.json(publicConfig(config))
})

app.patch('/api/agents/:id', (req, res) => {
  const a = (config.agents || []).find(x => x.id === req.params.id)
  if (!a) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'emoji', 'icon', 'hue', 'persona', 'model', 'provider', 'skills', 'useTools', 'computerControl', 'plannerModel', 'plannerProvider', 'avatar', 'relay', 'source']) {
    if (k in req.body) a[k] = req.body[k]
  }
  saveConfig(config)
  res.json(publicConfig(config))
})

// ── chat import / export ────────────────────────────────────────────────────
// Two formats, because they answer different questions. JSON is the archive:
// everything, and it can be imported back. Markdown is the artefact you paste
// into a ticket or send to someone — readable, and deliberately lossy.

const SAFE_SESSION_KEYS = [
  'title', 'agentId', 'group', 'participants', 'provider', 'model', 'cwd',
  'useTools', 'computerControl', 'planMode', 'createdAt', 'updatedAt', 'messages'
]

function chatToMarkdown (s) {
  const out = [`# ${s.title || 'Chat'}`, '']
  const meta = [s.model && `Model: ${s.model}`, s.cwd && `Folder: ${s.cwd}`,
    s.createdAt && `Started: ${new Date(s.createdAt).toLocaleString()}`].filter(Boolean)
  if (meta.length) out.push(meta.join('  ·  '), '')
  for (const m of s.messages || []) {
    if (m.role === 'user') {
      out.push('## You', '', m.text || '', '')
      for (const a of m.attachments || []) out.push(`_[attached: ${a.name || a.kind}]_`, '')
    } else {
      out.push('## Radiant', '')
      for (const p of m.parts || []) {
        if (p.type === 'text') out.push(p.text || '', '')
        // A tool call is a fact about what the agent DID; losing it would make
        // the transcript read as if files changed themselves.
        else if (p.type === 'tool') out.push(`\`[tool] ${p.name || 'tool'}\`${p.args ? ' ' + JSON.stringify(p.args).slice(0, 200) : ''}`, '')
        else if (p.type === 'notice') out.push(`_${p.text || ''}_`, '')
      }
    }
  }
  return out.join('\n')
}

app.get('/api/sessions/:id/export', (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  const safe = (s.title || 'chat').replace(/[^\w.-]+/g, '-').slice(0, 60).replace(/^-|-$/g, '') || 'chat'
  if (req.query.format === 'md') {
    return res.json({ filename: `${safe}.md`, mime: 'text/markdown', content: chatToMarkdown(s) })
  }
  res.json({
    filename: `${safe}.json`,
    mime: 'application/json',
    content: JSON.stringify({ radiantChats: 1, exportedAt: new Date().toISOString(), chats: [s] }, null, 2)
  })
})

app.get('/api/chats/export', (req, res) => {
  const chats = listSessions().map(r => loadSession(r.id)).filter(Boolean)
  const stamp = new Date().toISOString().slice(0, 10)
  res.json({
    filename: `radiant-chats-${stamp}.json`,
    mime: 'application/json',
    count: chats.length,
    content: JSON.stringify({ radiantChats: 1, exportedAt: new Date().toISOString(), chats }, null, 2)
  })
})

app.post('/api/chats/import', (req, res) => {
  const body = req.body || {}
  const incoming = Array.isArray(body.chats) ? body.chats : (body.messages ? [body] : null)
  if (!incoming) return res.status(400).json({ error: 'That file does not look like a Radiant chat export.' })

  // ⚠️ IMPORTED CHATS NEED A HOME OR THEY ARE LOST ON ARRIVAL. Without this
  // they land loose in the sidebar, indistinguishable from your own, and with
  // nothing to tell you which of two hundred rows just appeared. They go into
  // one project named for the day they arrived: findable, groupable, and
  // removable as a set — and deleting that project keeps the chats, like any
  // other.
  // ⚠️ THE NAME HAS TO BE TELLABLE APART. Importing twice in a day produced two
  // shelves both called "Imported Aug 25, 2026", and a move-to-project menu
  // listing the same words twice — nothing errored, and the feature was still
  // useless. Fall back to the time, then to a counter.
  const now = new Date()
  const day = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const clock = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const taken = new Set((config.projects || []).map(x => x.name))
  let name = `Imported ${day}`
  if (taken.has(name)) name = `Imported ${day} at ${clock}`
  for (let n = 2; taken.has(name); n++) name = `Imported ${day} at ${clock} (${n})`

  const project = {
    id: 'pr-' + crypto.randomBytes(4).toString('hex'),
    name,
    cwd: null, hue: null, model: null, provider: null, agentId: null,
    createdAt: new Date().toISOString()
  }

  let added = 0, skipped = 0
  for (const raw of incoming) {
    // ⚠️ MINT A NEW ID, ALWAYS. Honouring the id in the file would let an
    // import overwrite a chat you already have — silently, and with no undo.
    // An import can only ever ADD.
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) { skipped++; continue }
    const s = { id: crypto.randomUUID(), createdAt: new Date().toISOString() }
    // Copy only fields we know. Anything else in the file is ignored rather
    // than written into a session file we later read back and trust.
    for (const k of SAFE_SESSION_KEYS) if (k in raw) s[k] = raw[k]
    s.messages = raw.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    s.title = String(s.title || 'Imported chat').slice(0, 200)
    // A project id from the file means nothing here; these go to the new shelf.
    s.projectId = project.id
    s.pinned = false
    s.imported = true
    // ⚠️ KEEP THE ORIGINAL TIMESTAMP. saveSession stamps updatedAt with NOW, so
    // without this every imported chat claims to be the newest thing you have
    // and fifty of them bury the work you were actually doing. The sidebar
    // sorts on this, so it decides where they land.
    const when = raw.updatedAt || raw.createdAt || null
    try {
      saveSession(s)
      if (when) {
        const f = path.join(SESSIONS_DIR, s.id + '.json')
        const saved = JSON.parse(fs.readFileSync(f, 'utf8'))
        saved.updatedAt = when
        fs.writeFileSync(f, JSON.stringify(saved, null, 2))
      }
      added++
    } catch { skipped++ }
  }
  if (added) {
    config.projects = config.projects || []
    config.projects.push(project)
    saveConfig(config)
  }
  res.json({ ok: true, added, skipped, project: added ? project.name : null })
})

// ── where the data lives ────────────────────────────────────────────────────
// Radiant has no account and no server of ours. "Sync across devices" is
// therefore a folder question, not an identity question: put the data
// directory somewhere your other Macs already see.
app.get('/api/data-dir', (req, res) => res.json(dataDirStatus()))

app.post('/api/data-dir', (req, res) => {
  const reset = req.body?.reset === true
  const dest = reset ? defaultDataDir() : String(req.body?.path || '').trim()
  const mode = String(req.body?.mode || 'auto')   // auto | adopt | replace
  if (!dest) return res.status(400).json({ error: 'path required' })
  if (!path.isAbsolute(dest)) return res.status(400).json({ error: 'needs an absolute path' })
  // ⚠️ SAME FOLDER STILL NEEDS THE POINTER FIXED. Turning sync on and then off
  // again BEFORE restarting lands here: the active folder never changed, so an
  // early return skipped the pointer and sync stayed quietly on while the
  // checkbox insisted it was off. Do no copying, but do record the intent.
  if (dest === RADIANT_DIR) {
    try {
      if (dest === defaultDataDir()) fs.rmSync(DIR_POINTER, { force: true })
      else fs.writeFileSync(DIR_POINTER, dest)
    } catch (e) { return res.status(500).json({ error: `Could not record the location: ${e.message}` }) }
    return res.json({ ok: true, unchanged: true, ...dataDirStatus() })
  }

  try {
    fs.mkdirSync(dest, { recursive: true })
    const probe = path.join(dest, '.radiant-write-test')
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe)
  } catch (e) {
    // Say which kind of failure it is. "Cannot write to that folder: EPERM" is
    // a permissions problem the user can act on; ENOENT on a cloud path usually
    // means the service is signed out. Both were previously one opaque line.
    const code = e?.code || ''
    const why = /EPERM|EACCES/.test(code)
      ? 'macOS would not let Radiant write there. If this is a managed Mac, that folder may be restricted.'
      : /ENOENT|ENOTDIR/.test(code)
        ? 'That folder does not exist and could not be created. If it is a cloud folder, check the service is signed in.'
        : e.message
    return res.status(400).json({ error: `Cannot use that folder — ${why}` })
  }

  const destHasProfile = fs.existsSync(path.join(dest, 'config.json'))

  // ⚠️ TWO INTENTS LOOK IDENTICAL AND MEAN OPPOSITE THINGS.
  //   "put my setup here"      — this Mac's work should win
  //   "use the setup that's here" — the folder's work should win
  // Guessing loses somebody's work either way, so when the destination already
  // has a profile and the caller has not said which it means, ASK. Nothing is
  // written on this path.
  if (destHasProfile && mode === 'auto') {
    let when = null
    try { when = fs.statSync(path.join(dest, 'config.json')).mtime.toISOString() } catch {}
    return res.status(409).json({ needsChoice: true, dest, destModified: when })
  }

  let backedUp = null
  try {
    if (destHasProfile && mode === 'adopt') {
      // Use the folder as it stands. Nothing copied, nothing overwritten.
    } else {
      // Replacing, or filling an empty folder. If something is already there it
      // is moved aside with a dated name — never deleted, never written over.
      if (destHasProfile) {
        backedUp = path.join(dest, `radiant-replaced-${Date.now()}`)
        fs.mkdirSync(backedUp, { recursive: true })
        for (const e of fs.readdirSync(dest)) {
          if (e.startsWith('radiant-replaced-')) continue
          fs.renameSync(path.join(dest, e), path.join(backedUp, e))
        }
      }
      for (const entry of fs.readdirSync(RADIANT_DIR)) {
        if (entry.startsWith('radiant-replaced-')) continue
        fs.cpSync(path.join(RADIANT_DIR, entry), path.join(dest, entry), { recursive: true })
      }
    }
  } catch (e) {
    return res.status(500).json({ error: `Copy failed, nothing was changed: ${e.message}` })
  }

  try {
    if (dest === defaultDataDir()) fs.rmSync(DIR_POINTER, { force: true })
    else fs.writeFileSync(DIR_POINTER, dest)
  } catch (e) {
    return res.status(500).json({ error: `Could not record the new location: ${e.message}` })
  }

  res.json({ ok: true, from: RADIANT_DIR, to: dest, adopted: destHasProfile && mode === 'adopt', backedUp, needsRestart: true })
})

// Cloud folders this Mac actually has, so the UI can offer a real destination
// instead of asking someone to go hunting in a file picker.
app.get('/api/sync-targets', (req, res) => {
  const home = os.homedir()
  const out = []
  const seen = new Set()
  const push = (label, dir, note) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    out.push({ label, path: path.join(dir, 'Radiant'), note })
  }
  const addIfPresent = (label, dir) => { try { if (dir && fs.existsSync(dir)) push(label, dir) } catch {} }

  // ⚠️ iCloud IS ALWAYS OFFERED ON A MAC, DETECTED OR NOT.
  // This used to require com~apple~CloudDocs to stat successfully, and when it
  // did not — Tony's work MBA, iCloud Drive plainly switched on — the feature
  // fell back to "choose a folder", which is a question the user should never
  // have to answer. A Mac's iCloud Drive is ALWAYS at this path; if the
  // directory is missing, setDataDir creates it, and its write probe rejects
  // the folder if it is not actually usable. Verification was never what made
  // this safe, so it should not be what makes it unavailable.
  // ⚠️ NO WARNING BASED ON A FILESYSTEM GUESS. A note reading "turn on iCloud
  // Drive if it is off" was attached whenever ~/Library/Mobile Documents did
  // not stat — and it fired on a Mac with iCloud Drive plainly switched on,
  // telling the user to fix something that was not broken. That is the SECOND
  // wrong guess about the same machine from a stat call that evidently cannot
  // be trusted there, most likely because a managed Mac denies the read.
  //
  // So do not guess. Offer iCloud, and let ticking the box produce a REAL
  // answer: setDataDir creates the folder and write-probes it, so a genuine
  // failure arrives as a specific error at the moment it happens, instead of
  // speculative advice on a screen where nothing has been attempted yet.
  const CLOUD_DOCS = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  push('iCloud Drive', CLOUD_DOCS)

  addIfPresent('Dropbox', path.join(home, 'Dropbox'))
  try {
    for (const e of fs.readdirSync(path.join(home, 'Library', 'CloudStorage'))) {
      const dir = path.join(home, 'Library', 'CloudStorage', e)
      if (/\(.*\d.*\)$/.test(e)) continue          // dated duplicates macOS leaves behind
      if (/^Dropbox/i.test(e)) addIfPresent('Dropbox', dir)
      else if (/^GoogleDrive-/i.test(e)) addIfPresent(`Google Drive · ${e.replace('GoogleDrive-', '')}`, path.join(dir, 'My Drive'))
      else if (/^OneDrive/i.test(e)) addIfPresent('OneDrive', dir)
      else if (/^Box/i.test(e)) addIfPresent('Box', dir)
    }
  } catch { /* no CloudStorage directory on this Mac */ }

  res.json({ targets: out })
})

// ── projects ────────────────────────────────────────────────────────────────
// A named piece of work with a folder attached. Sessions reference one by id.
//
// ⚠️ DELETING A PROJECT MUST NEVER DELETE ITS SESSIONS. A folder in a sidebar
// looks disposable; the conversations inside it are not. Delete clears the
// pointer on every session that referenced it and leaves the work in place,
// where it reappears under "No project".
app.get('/api/projects', (req, res) => res.json(config.projects || []))

app.post('/api/projects', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name required' })
  config.projects = config.projects || []
  const project = {
    id: 'pr-' + crypto.randomBytes(4).toString('hex'),
    name,
    // A project may exist before anyone has decided where its files live.
    cwd: req.body.cwd || null,
    hue: req.body.hue ?? null,
    // Optional defaults a new session in this project inherits.
    model: req.body.model || null,
    provider: req.body.provider || null,
    agentId: req.body.agentId || null,
    createdAt: new Date().toISOString()
  }
  config.projects.push(project)
  saveConfig(config)
  res.json(project)
})

app.patch('/api/projects/:id', (req, res) => {
  const p = (config.projects || []).find(x => x.id === req.params.id)
  if (!p) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'cwd', 'hue', 'model', 'provider', 'agentId']) {
    if (k in req.body) p[k] = req.body[k]
  }
  saveConfig(config)
  res.json(p)
})

app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id
  config.projects = (config.projects || []).filter(x => x.id !== id)
  saveConfig(config)
  // Unassign, do not delete. See the warning above.
  let freed = 0
  for (const row of listSessions()) {
    if (row.projectId !== id) continue
    const full = loadSession(row.id)
    if (!full) continue
    full.projectId = null
    saveSession(full)
    freed++
  }
  res.json({ ok: true, sessionsFreed: freed })
})

app.delete('/api/agents/:id', (req, res) => {
  const a = (config.agents || []).find(x => x.id === req.params.id)
  if (a && a.builtin) return res.status(400).json({ error: 'built-in agents cannot be deleted' })
  config.agents = (config.agents || []).filter(x => x.id !== req.params.id)
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- connected agents (import from Hermes / OpenClaw on this Mac) ----------
const HERMES_AVATAR = 'data:image/png;base64,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'
// Agents connected in an earlier version carry whatever avatar shipped then —
// the first one was a filled slate-blue square, which read as "blue icon" next
// to the flat-colored built-ins. Refresh a connected Hermes agent's avatar to
// the current artwork on load so the picture improves with the app instead of
// only for people who re-import.
function refreshImportedAvatars (cfg) {
  let changed = false
  for (const a of cfg.agents || []) {
    if ((a.source === 'hermes' || a.relay === 'hermes') && a.avatar !== HERMES_AVATAR) {
      a.avatar = HERMES_AVATAR
      changed = true
    }
  }
  if (changed) saveConfig(cfg)
  return changed
}
if (refreshImportedAvatars(config)) console.log('[radiant] refreshed imported agent avatars')

function hexToHue (hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  if (!d) return null
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = Math.round(h * 60); return h < 0 ? h + 360 : h
}

function discoverExternalAgents () {
  const home = os.homedir()
  const out = []
  // Hermes — its "profiles" are agents; the persona lives in SOUL.md
  try {
    const hDir = path.join(home, '.hermes')
    const soulPath = path.join(hDir, 'SOUL.md')
    if (fs.existsSync(soulPath)) {
      const persona = fs.readFileSync(soulPath, 'utf8').trim()
      let title = 'Hermes', color = null, modelNote = ''
      try {
        const py = fs.readFileSync(path.join(hDir, 'profile.yaml'), 'utf8')
        const tm = /title:\s*['"]?([^'"\n]+)/i.exec(py); if (tm) title = tm[1].trim()
        const cm = /color:\s*['"]?(#[0-9a-fA-F]{6})/i.exec(py); if (cm) color = cm[1]
      } catch {}
      try {
        const cy = fs.readFileSync(path.join(hDir, 'config.yaml'), 'utf8')
        const pm = /provider:\s*([a-z0-9_-]+)/i.exec(cy); if (pm) modelNote = pm[1]
      } catch {}
      if (persona) out.push({
        source: 'hermes', sourceLabel: 'Hermes', name: title, emoji: '🪽', avatar: HERMES_AVATAR,
        hue: hexToHue(color), persona, model: null, relay: 'hermes',
        note: modelNote ? `Hermes profile · ${modelNote}` : 'Hermes profile',
        personaChars: persona.length, importable: true
      })
    }
  } catch {}
  // OpenClaw is handled by the gateway, not by scanning disk — see openclaw.js
  // and /api/external-agents.
  //
  // ⚠️ DO NOT GUESS AGENTS FROM FILES. This used to treat any folder holding a
  // SOUL.md or AGENTS.md as an agent. AGENTS.md is a repo convention for
  // instructing coding agents — Radiant's own repo has one — so on a real
  // machine it scraped every workspace, backup and dated snapshot and listed a
  // dozen entries called "Workspace". OpenClaw knows what its agents are.
  return out
}

app.get('/api/external-agents', async (req, res) => {
  try {
    const agents = discoverExternalAgents()
    // OpenClaw usually hosts the fleet on a gateway, not on this machine — ask
    // it. Failures come back as a reason, not an exception, so the UI can say
    // what is wrong instead of showing an empty list.
    const gw = await listGatewayAgents()
    if (gw.agents.length) {
      const host = (() => { try { return new URL(gw.url).hostname } catch { return 'the gateway' } })()
      for (const a of gw.agents) {
        agents.push({
          source: 'openclaw', sourceLabel: 'OpenClaw', name: a.name || a.label || a.id, emoji: '🦞',
          hue: null, persona: a.description || a.persona || '', model: a.model || a.agentRuntime?.model || null,
          note: `On ${host}`, gatewayId: a.id, importable: true
        })
      }
    } else if (gw.error) {
      // OpenClaw is set up here but its gateway would not answer. Say why —
      // an empty list looks identical to "you have no agents".
      agents.push({
        source: 'openclaw', sourceLabel: 'OpenClaw', name: 'OpenClaw', emoji: '🦞',
        hue: null, persona: '', model: null,
        note: gw.error, importable: false
      })
    }
    res.json({ agents })
  }
  catch (e) { res.json({ agents: [], error: String((e && e.message) || e) }) }
})

// Live relay to the real Hermes agent (its own model, skills, memory). Runs the
// Hermes CLI non-interactively (`hermes -z <text>`, no shell) and streams its
// stdout to the client as text_delta events so the reply lands in the normal
// chat bubble. Returns the full accumulated reply (persisted as the assistant turn).
function runHermesRelay ({ text, emit, signal, session }) {
  return new Promise(resolve => {
    let acc = ''
    let stderrTail = ''
    let settled = false
    const finish = () => { if (!settled) { settled = true; resolve(acc) } }
    let child
    try {
      child = spawn(hermesBin(), ['-z', String(text || '')], {
        // SPAWN_ENV, not process.env: hermes is a shell script that execs a
          // python venv, so it needs the augmented PATH too — resolving the
          // binary alone is not enough.
          env: SPAWN_ENV,
        cwd: (session && session.cwd) || undefined,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      const msg = `⚠️ Hermes could not respond (${e.message}).`
      acc += msg; emit({ type: 'text_delta', text: msg }); return finish()
    }
    const onAbort = () => { try { child.kill('SIGTERM') } catch {} }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', d => {
      const chunk = d.toString()
      acc += chunk
      emit({ type: 'text_delta', text: chunk })
    })
    child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-800) })
    child.on('error', e => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (!acc.trim() && !(signal && signal.aborted)) {
        const msg = `⚠️ Hermes could not respond (${e.message}).`
        acc += msg; emit({ type: 'text_delta', text: msg })
      }
      finish()
    })
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (code !== 0 && !acc.trim() && !(signal && signal.aborted)) {
        const tail = stderrTail.trim().split('\n').slice(-3).join(' ').slice(-300)
        const msg = `⚠️ Hermes could not respond (exit ${code}${tail ? `: ${tail}` : ''}).`
        acc += msg; emit({ type: 'text_delta', text: msg })
      }
      finish()
    })
  })
}

// ---------- usage / credits ----------
app.get('/api/usage', async (req, res) => {
  const out = []
  // OpenRouter exposes remaining credits
  if (config.keys.openrouter) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { authorization: `Bearer ${config.keys.openrouter}` },
        signal: AbortSignal.timeout(6000)
      })
      if (r.ok) {
        const d = (await r.json()).data || {}
        const remaining = (d.total_credits ?? 0) - (d.total_usage ?? 0)
        out.push({ provider: 'openrouter', label: 'OpenRouter', kind: 'credits', remaining: +remaining.toFixed(2), used: +(d.total_usage ?? 0).toFixed(2), total: +(d.total_credits ?? 0).toFixed(2) })
      }
    } catch {}
  }
  // ⚠️ ONLY SOME VENDORS PUBLISH USAGE. Claude and ChatGPT have private
  // endpoints their own apps call. xAI, Nous, Qwen and Copilot do not: probing
  // their APIs with a valid OAuth token returns 404 on every usage path and no
  // quota headers on any response (checked 2026-08-23). So the meter shows a
  // real gauge where the number exists and "signed in" where it does not —
  // rather than omitting the provider entirely, which read as broken.
  const USAGE = { anthropic: claudeUsage, openai: chatgptUsage }
  const SHORT = { anthropic: 'Claude', openai: 'ChatGPT', nousresearch: 'Nous', xai: 'Grok', qwen: 'Qwen', copilot: 'Copilot' }
  for (const id of Object.keys(config.oauth || {})) {
    if (!config.oauth[id]) continue
    const label = SHORT[id] || (OAUTH_PROVIDERS[id]?.label || id).replace(/\s*\(.*\)$/, '')
    let windows = null
    const fetcher = USAGE[id]
    if (fetcher) {
      try { windows = await fetcher(await validAccessToken(id, config, saveConfig)) } catch {}
    }
    out.push({ provider: id, label, kind: 'subscription', windows, reportsUsage: Boolean(fetcher) })
  }
  res.json({ items: out })
})

// Normalize a vendor's rate-limit "window" objects into {name, usedPct, resetAt}.
function normWindows (pairs) {
  const windows = []
  for (const [name, w] of pairs) {
    if (!w || typeof w !== 'object') continue
    const used = w.used ?? w.used_tokens ?? w.usage
    const limit = w.limit ?? w.limit_tokens ?? w.max ?? w.quota
    let pct = null
    if (typeof w.used_percent === 'number') pct = w.used_percent
    else if (typeof w.utilization === 'number') pct = w.utilization <= 1 ? w.utilization * 100 : w.utilization
    else if (typeof w.percent_used === 'number') pct = w.percent_used
    else if (typeof used === 'number' && typeof limit === 'number' && limit > 0) pct = (used / limit) * 100
    let resetAt = w.resets_at || w.reset_at || w.resets || w.reset
    if (!resetAt && w.resets_in_seconds) resetAt = new Date(Date.now() + w.resets_in_seconds * 1000).toISOString()
    if (pct != null || resetAt) windows.push({ name, usedPct: pct != null ? Math.round(pct) : null, resetAt: resetAt || null })
  }
  return windows.length ? windows : null
}

async function chatgptUsage (token) {
  const r = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(6000)
  })
  if (!r.ok) return null
  const d = await r.json()
  const rl = d.rate_limit || d
  return normWindows([['5h', rl.primary_window], ['weekly', rl.secondary_window]])
}

async function claudeUsage (token) {
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }, signal: AbortSignal.timeout(6000)
  })
  if (!r.ok) return null
  const d = await r.json()
  return normWindows([['5h', d.five_hour], ['weekly', d.seven_day]])
}

// open a file/folder in the OS default app (for the "files changed" chips)
app.post('/api/open', (req, res) => {
  const p = String(req.body?.path || '')
  if (!p || !fs.existsSync(p)) return res.status(400).json({ error: 'no such file' })
  try { spawn('open', [p], { detached: true, stdio: 'ignore' }).unref(); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---------- recipes (parameterized task templates) ----------
app.post('/api/recipes', (req, res) => {
  const { name, desc, template, params } = req.body
  if (!name || !template) return res.status(400).json({ error: 'name and template required' })
  config.recipes = config.recipes || []
  config.recipes.push({ id: 'rec-' + crypto.randomBytes(4).toString('hex'), name, desc: desc || '', template, params: Array.isArray(params) ? params : [] })
  saveConfig(config)
  res.json(publicConfig(config))
})
app.patch('/api/recipes/:id', (req, res) => {
  const r = (config.recipes || []).find(x => x.id === req.params.id)
  if (!r) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'desc', 'template', 'params']) if (k in req.body) r[k] = req.body[k]
  saveConfig(config)
  res.json(publicConfig(config))
})
app.delete('/api/recipes/:id', (req, res) => {
  config.recipes = (config.recipes || []).filter(x => x.id !== req.params.id)
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- memory ----------
app.get('/api/memory', (req, res) => res.json({ facts: listFacts() }))
app.post('/api/memory', (req, res) => { addFactManual(String(req.body?.text || '')); res.json({ facts: listFacts() }) })
app.delete('/api/memory/:id', (req, res) => { deleteFact(req.params.id); res.json({ facts: listFacts() }) })
app.post('/api/memory/clear', (req, res) => { clearFacts(); res.json({ facts: [] }) })

// ---------- skills ----------
app.post('/api/skills', (req, res) => {
  const { name, description, content } = req.body
  if (!name || !content) return res.status(400).json({ error: 'name and content required' })
  config.skills = config.skills || []
  config.skills.push({ id: 'sk-' + crypto.randomBytes(4).toString('hex'), name, description: description || '', content, enabled: true })
  saveConfig(config)
  res.json(publicConfig(config))
})

app.patch('/api/skills/:id', (req, res) => {
  const sk = (config.skills || []).find(s => s.id === req.params.id)
  if (!sk) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'description', 'content', 'enabled']) {
    if (k in req.body) sk[k] = req.body[k]
  }
  saveConfig(config)
  res.json(publicConfig(config))
})

app.delete('/api/skills/:id', (req, res) => {
  const id = req.params.id
  config.skills = (config.skills || []).filter(s => s.id !== id)
  // seeded skills get re-merged on load; remember the deletion so they stay gone
  if (id.startsWith('seed-')) {
    config.removedSkills = config.removedSkills || []
    if (!config.removedSkills.includes(id)) config.removedSkills.push(id)
  }
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- suggested skills (from skillsmith) ----------
app.post('/api/skill-suggestions/:id/accept', (req, res) => {
  const sug = (config.skillSuggestions || []).find(s => s.id === req.params.id)
  if (!sug) return res.status(404).json({ error: 'not found' })
  config.skills = config.skills || []
  config.skills.push({ id: 'sk-' + crypto.randomBytes(4).toString('hex'), name: sug.name, description: sug.description || '', content: sug.content, enabled: true, fromSuggestion: true })
  config.skillSuggestions = (config.skillSuggestions || []).filter(s => s.id !== sug.id)
  saveConfig(config)
  res.json(publicConfig(config))
})

app.post('/api/skill-suggestions/:id/reject', (req, res) => {
  const sug = (config.skillSuggestions || []).find(s => s.id === req.params.id)
  if (sug) {
    const key = (sug.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    config.rejectedSkills = config.rejectedSkills || []
    if (key && !config.rejectedSkills.includes(key)) config.rejectedSkills.push(key)
    config.skillSuggestions = (config.skillSuggestions || []).filter(s => s.id !== sug.id)
    saveConfig(config)
  }
  res.json(publicConfig(config))
})

// ---------- computer control status ----------
app.get('/api/computer-status', async (req, res) => {
  try {
    const { computerStatus } = await import('./computer-tools.js')
    res.json(await computerStatus())
  } catch (e) {
    res.json({ desktop: false, browser: false, error: e.message })
  }
})

// ---------- design mode (point at a page element, capture it) ----------
app.post('/api/design/open', async (req, res) => {
  try {
    const { web } = await import('./browser.js')
    res.json(await web.navigate(req.body.url))
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/design/pick', async (req, res) => {
  try {
    const { web } = await import('./browser.js')
    const capture = await web.pickElement()
    res.json({ capture })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ---------- version & updates ----------
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }))

app.get('/api/update-check', async (req, res) => {
  try {
    res.json(await checkForUpdate(APP_VERSION))
  } catch (e) {
    res.status(502).json({ error: e.message, current: APP_VERSION })
  }
})

// ---------- subscription sign-in (OAuth) ----------
app.get('/api/oauth/providers', (req, res) => {
  res.json(Object.entries(OAUTH_PROVIDERS).map(([id, p]) => ({ id, label: p.label, mode: p.mode })))
})

// begin a sign-in: returns the URL to open in a browser
app.post('/api/oauth/:id/start', (req, res) => {
  try {
    if (req.body?.newAccount) addingAccount.add(req.params.id)
    const { url, mode } = buildAuthUrl(req.params.id)
    if (mode === 'loopback') {
      startLoopback(req.params.id, (err, tok) => {
        if (!err && tok) { upsertCredential(config, req.params.id, { oauth: tok }, { newAccount: addingAccount.delete(req.params.id) }); saveConfig(config) }
      })
    }
    res.json({ url, mode })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// finish a paste-mode sign-in with the code from the callback page
app.post('/api/oauth/:id/complete', async (req, res) => {
  try {
    const tok = await completePaste(req.params.id, req.body.code)
    upsertCredential(config, req.params.id, { oauth: tok }, { newAccount: addingAccount.delete(req.params.id) })
    saveConfig(config)
    res.json(publicConfig(config))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// device-code sign-in (Nous): start returns a code + URL to open
app.post('/api/oauth/:id/device/start', async (req, res) => {
  try {
    if (req.body?.newAccount) addingAccount.add(req.params.id)
    res.json(await startDevice(req.params.id))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// device-code sign-in: poll until the user approves on the Portal
app.post('/api/oauth/:id/device/poll', async (req, res) => {
  try {
    const r = await pollDevice(req.params.id)
    if (r.done) { upsertCredential(config, req.params.id, { oauth: r.token }, { newAccount: addingAccount.delete(req.params.id) }); saveConfig(config) }
    res.json({ done: r.done, config: r.done ? publicConfig(config) : undefined })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// poll whether a loopback sign-in has landed
app.get('/api/oauth/:id/status', (req, res) => {
  res.json({ signedIn: Boolean(config.oauth[req.params.id]) })
})

app.post('/api/oauth/:id/signout', (req, res) => {
  const activeId = config.activeAccount?.[req.params.id]
  if (activeId) removeAccount(config, req.params.id, activeId)
  else delete config.oauth[req.params.id]
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- models ----------
app.get('/api/models', async (req, res) => {
  const results = await Promise.all(config.providers.map(async p => {
    const hasKey = Boolean(config.keys[p.id])
    const hasOAuth = Boolean(config.oauth[p.id])
    if ((p.auth === 'key' || p.auth === 'oauth') && !hasKey && !hasOAuth) return []
    const accessToken = hasOAuth ? await validAccessToken(p.id, config, saveConfig).catch(() => null) : null
    const prov = (p.id === 'qwen' && config.oauth.qwen?.apiBase) ? { ...p, baseUrl: config.oauth.qwen.apiBase } : p
    const models = await listModels(prov, config.keys[p.id], accessToken, hasOAuth ? config.oauth[p.id]?.accountId : null)
    models.sort((a, b) => a.id.localeCompare(b.id))
    return models.map(m => ({ ...m, provider: p.id, providerName: p.name }))
  }))
  res.json(results.flat())
})

// ---------- local models (Ollama) ----------
const OLLAMA = 'http://127.0.0.1:11434'

app.get('/api/system', (req, res) => {
  let chip = os.cpus()[0]?.model || 'Unknown CPU'
  try { chip = execSync('sysctl -n machdep.cpu.brand_string', { timeout: 2000 }).toString().trim() } catch {}
  let osVersion = ''
  try { osVersion = execSync('sw_vers -productVersion', { timeout: 2000 }).toString().trim() } catch {}
  // real free space on the volume that actually holds the models (follows the
  // ~/.ollama symlink if models live on an external drive) — the number a
  // download really gets, not Finder's purgeable-inflated figure.
  let diskFreeGB = null
  try {
    const modelsPath = path.join(os.homedir(), '.ollama', 'models')
    const target = fs.existsSync(modelsPath) ? modelsPath : os.homedir()
    const out = execSync(`df -k "${target}"`, { timeout: 3000 }).toString().trim().split('\n').pop().split(/\s+/)
    diskFreeGB = Math.round(Number(out[3]) / (1024 * 1024))
  } catch {}
  res.json({
    chip,
    ramGB: Math.round(os.totalmem() / (1024 ** 3)),
    cores: os.cpus().length,
    arch: os.arch(),
    platform: os.platform(),
    osVersion,
    diskFreeGB
  })
})

// ---------- local storage (Radiant's own data) ----------
app.get('/api/storage', (req, res) => {
  const dir = SESSIONS_DIR
  let count = 0; let bytes = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      count++; try { bytes += fs.statSync(path.join(dir, f)).size } catch {}
    }
  } catch {}
  res.json({ sessions: count, sizeMB: Math.round(bytes / (1024 * 1024) * 10) / 10 })
})
// delete sessions older than `days` (0 = all)
app.post('/api/storage/clear-sessions', (req, res) => {
  const days = Number(req.body?.days ?? 30)
  const cutoff = days > 0 ? Date.now() - days * 86400000 : Infinity
  let removed = 0
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json')) continue
      const p = path.join(SESSIONS_DIR, f)
      let mt = 0; try { mt = fs.statSync(p).mtimeMs } catch {}
      if (days === 0 || mt < cutoff) { try { fs.unlinkSync(p); removed++ } catch {} }
    }
  } catch {}
  res.json({ removed })
})

// live registry search: GGUF repos on Hugging Face, pullable via `ollama pull hf.co/{repo}:{quant}`
app.get('/api/registry-search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 100)
  const SORTS = { downloads: 'downloads', likes: 'likes', trending: 'trendingScore', updated: 'lastModified', created: 'createdAt' }
  const sort = SORTS[req.query.sort] || 'downloads'
  try {
    const url = `https://huggingface.co/api/models?filter=gguf&sort=${sort}&direction=-1&limit=30${q ? `&search=${encodeURIComponent(q)}` : ''}`
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`registry ${r.status}`)
    const data = await r.json()
    res.json(data.map(m => ({
      id: m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      updatedAt: m.lastModified
    })))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/registry-files', async (req, res) => {
  const repo = String(req.query.repo || '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ error: 'bad repo' })
  try {
    const r = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`registry ${r.status}`)
    const data = await r.json()
    const base = repo.split('/')[1].toLowerCase().replace(/[._-]?gguf$/i, '').replace(/[^a-z0-9._-]+/g, '-').replace(/(^-|-$)/g, '')
    const quants = {} // label -> { bytes, files:[{name,size}] }
    for (const s of data.siblings || []) {
      const f = s.rfilename
      if (!/\.gguf$/i.test(f)) continue
      // top-level weight files only — skip subfolder files and companions
      // (projectors, vision/clip encoders, drafts, LoRA/adapters, MTP heads).
      if (f.includes('/')) continue
      if (/mmproj|projector|\bproj\b|vision|\bclip\b|encoder|lora|adapter|draft|\bmtp\b/i.test(f)) continue
      // Group sharded parts (…-00001-of-00003.gguf) under one quant. We download
      // files directly from HF and `ollama create` from them, so shards are fine.
      const stem = f.replace(/-\d+-of-\d+\.gguf$/i, '.gguf')
      const m = stem.match(/[.\-_](I?Q\d[\w]*?|F16|F32|BF16|FP16|FP32)\.gguf$/i)
      const label = (m ? m[1] : 'default').toUpperCase().replace(/^FP(16|32)$/, 'F$1')
      quants[label] = quants[label] || { bytes: 0, files: [] }
      quants[label].bytes += s.size || 0
      quants[label].files.push(f)
    }
    res.json({
      repo,
      quants: Object.entries(quants)
        .map(([label, v]) => ({
          label,
          sizeGB: +(v.bytes / 1024 ** 3).toFixed(1),
          files: v.files.sort(),
          sharded: v.files.length > 1,
          model: `${base}:${label.toLowerCase()}`
        }))
        .sort((a, b) => a.sizeGB - b.sizeGB)
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.get('/api/local-models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) })
    const data = await r.json()
    res.json({ running: true, models: (data.models || []).map(m => ({ name: m.name, sizeGB: +(m.size / 1024 ** 3).toFixed(1) })) })
  } catch {
    res.json({ running: false, models: [] })
  }
})

app.delete('/api/local-models/:name', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/delete`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: req.params.name })
    })
    res.json({ ok: r.ok })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Ollama pulls `hf.co/repo:TAG` by matching TAG as a case-insensitive substring
// of exactly one filename. It errors with a cryptic "file does not exist" when the
// quant is only published as a multi-part split, when the file was renamed, or when
// the tag matches more than one file. Preflight against HF so we can either fix the
// tag or give the user an actionable message instead of Ollama's cryptic one.
const IS_SHARD = f => /-\d+-of-\d+\.gguf$/i.test(f)
const IS_COMPANION = f => /mmproj|projector|\bproj\b|vision|\bclip\b|encoder|lora|adapter|draft|\bmtp\b/i.test(f)
const IS_SINGLE = f => !f.includes('/') && !IS_SHARD(f) && !IS_COMPANION(f)

async function resolveHfPull (model) {
  const m = model.match(/^hf\.co\/([\w.-]+\/[\w.-]+)(?::(.+))?$/i)
  if (!m) return { model } // ollama library name, not an HF pull — pass through
  const repo = m[1]
  const tag = m[2] || null
  let siblings
  try {
    const r = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return { model } // registry hiccup — let Ollama try anyway
    siblings = ((await r.json()).siblings || []).map(s => s.rfilename).filter(f => /\.gguf$/i.test(f))
  } catch { return { model } }
  const single = siblings.filter(IS_SINGLE)
  if (!tag) return single.length ? { model } : { error: `No downloadable single-file GGUF found in ${repo}.` }
  const t = tag.toLowerCase()
  const singleHits = single.filter(f => f.toLowerCase().includes(t))
  // Ollama matches the tag against EVERY file in the repo (including shards). If a
  // sharded set shares this tag, Ollama tries to pull the shards and fails with
  // "sharded GGUF" — even when a valid single file also exists — so catch it here.
  const shardHits = siblings.filter(f => IS_SHARD(f) && f.toLowerCase().includes(t))
  if (shardHits.length) {
    return { error: `“${tag}” is published as a multi-part sharded GGUF in ${repo}, which Ollama can’t download from the registry. Pick a single-file quantization (one without a “…-00001-of-000NN” split), or a different repo.` }
  }
  if (singleHits.length === 1) return { model } // unique single-file match — good to pull
  if (singleHits.length > 1) {
    // Ambiguous among single files: find the shortest unique substring tag.
    const exact = singleHits.find(f => new RegExp(`[.\\-_]${t}\\.gguf$`, 'i').test(f)) || singleHits.sort((a, b) => a.length - b.length)[0]
    const stem = exact.replace(/\.gguf$/i, '')
    for (let n = 2; n <= 5; n++) {
      const sub = stem.split(/[.\-_]/).slice(-n).join('-')
      if (single.filter(f => f.toLowerCase().includes(sub.toLowerCase())).length === 1) {
        return { model: `hf.co/${repo}:${sub}`, note: `Matched ${exact}` }
      }
    }
    return { error: `“${tag}” matches ${singleHits.length} files in ${repo} and Ollama can’t tell them apart. Pick a more specific quantization.` }
  }
  return { error: `No “${tag}” GGUF in ${repo}. It may be a projector/adapter or was renamed — collapse and reopen the repo to refresh the list.` }
}

// pull a model through Ollama, streaming progress back as SSE
app.post('/api/pull', async (req, res) => {
  let { model } = req.body
  if (!model || !/^[\w.\/:-]+$/.test(model)) return res.status(400).json({ error: 'bad model tag' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`)
  const controller = new AbortController()
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  try {
    const resolved = await resolveHfPull(model)
    if (resolved.error) { emit({ error: resolved.error }); return }
    if (resolved.model !== model) { model = resolved.model; emit({ status: resolved.note || `resolved to ${model}` }) }
    const r = await fetch(`${OLLAMA}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: controller.signal
    })
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const j = JSON.parse(line)
          // Enrich Ollama's cryptic "file does not exist" with what it usually means.
          const err = j.error && /file does not exist|does not exist|not found/i.test(j.error)
            ? `${j.error} — this quant may be split-only or renamed on Hugging Face. Try a different quantization or repo.`
            : j.error
          emit({ status: j.status, completed: j.completed, total: j.total, error: err })
        } catch {}
      }
    }
    emit({ status: 'done' })
  } catch (e) {
    if (!controller.signal.aborted) emit({ error: e.message })
  } finally {
    res.end()
  }
})

// Download exact GGUF file(s) straight from Hugging Face (the way LM Studio does),
// then register them with Ollama via `ollama create`. This sidesteps Ollama's
// fragile registry tag-matching entirely and handles sharded quants too.
const DL_DIR = path.join(os.homedir(), '.radiant', 'downloads')
const hfUrl = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}?download=true`

// Downloads run detached from the request that starts them and are tracked here,
// so navigating away from (or closing) the Models screen never stops a download.
// key = model name -> { repo, files, model, status, completed, total, error, done }
const downloads = new Map()

async function runDownload (entry) {
  const controller = new AbortController()
  entry._abort = () => controller.abort()
  const dir = path.join(DL_DIR, crypto.randomUUID())
  let child = null
  entry._kill = () => { controller.abort(); child?.kill('SIGKILL') }
  try {
    fs.mkdirSync(dir, { recursive: true })
    let sizeByFile = {}
    try {
      const meta = await fetch(`https://huggingface.co/api/models/${entry.repo}?blobs=true`, { signal: controller.signal })
      if (meta.ok) for (const s of (await meta.json()).siblings || []) sizeByFile[s.rfilename] = s.size || 0
    } catch {}
    entry.total = entry.files.reduce((a, f) => a + (sizeByFile[f] || 0), 0)
    let done = 0
    for (let i = 0; i < entry.files.length; i++) {
      const f = entry.files[i]
      entry.status = entry.files.length > 1 ? `downloading part ${i + 1}/${entry.files.length}` : 'downloading'
      const r = await fetch(hfUrl(entry.repo, f), { redirect: 'follow', signal: controller.signal })
      if (!r.ok) throw new Error(`Couldn't download ${f} (HTTP ${r.status})`)
      const out = fs.createWriteStream(path.join(dir, f))
      const reader = r.body.getReader()
      while (true) {
        const { done: fin, value } = await reader.read()
        if (fin) break
        done += value.length
        entry.completed = done
        if (!out.write(Buffer.from(value))) await new Promise(rs => out.once('drain', rs))
      }
      out.end()
      await new Promise((rs, rj) => { out.on('finish', rs); out.on('error', rj) })
    }
    entry.status = 'importing into Ollama…'; entry.completed = entry.total
    const modelfile = path.join(dir, 'Modelfile')
    fs.writeFileSync(modelfile, `FROM ${path.join(dir, entry.files[0])}\n`)
    await new Promise((resolve, reject) => {
      child = spawn(ollamaBin(), ['create', entry.model, '-f', modelfile], { env: SPAWN_ENV })
      let err = ''
      const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r\x00-\x08\x0e-\x1f]/g, '').trim()
      const feed = b => b.toString().split('\n').forEach(raw => { const l = strip(raw); if (l) entry.status = l })
      child.stdout.on('data', feed)
      child.stderr.on('data', d => { err += d.toString(); feed(d) })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ollama create exited ${code}`)))
    })
    entry.status = 'done'; entry.done = true
  } catch (e) {
    if (controller.signal.aborted) { downloads.delete(entry.model); return }
    entry.error = e.message; entry.done = true
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {})
    // keep finished/errored entries briefly so the UI can show the final state
    if (entry.done) setTimeout(() => downloads.delete(entry.model), 60000)
  }
}

// start a download (idempotent per model) — returns immediately, runs in background
app.post('/api/download', (req, res) => {
  const { repo, files, model } = req.body || {}
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return res.status(400).json({ error: 'bad repo' })
  if (!Array.isArray(files) || !files.length || !files.every(f => /^[A-Za-z0-9._-]+\.gguf$/i.test(f))) return res.status(400).json({ error: 'bad files' })
  if (!/^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$/i.test(model || '')) return res.status(400).json({ error: 'bad model name' })
  const existing = downloads.get(model)
  if (existing && !existing.done) return res.json({ ok: true, already: true })
  const entry = { repo, files, model, status: 'starting', completed: 0, total: 0, error: null, done: false }
  downloads.set(model, entry)
  runDownload(entry) // detached — survives client disconnect
  res.json({ ok: true })
})

// snapshot of active/recent downloads for the UI to poll
app.get('/api/downloads', (req, res) => {
  res.json([...downloads.values()].map(({ repo, files, model, status, completed, total, error, done }) =>
    ({ repo, files, model, status, completed, total, error, done })))
})

app.post('/api/download/cancel', (req, res) => {
  const entry = downloads.get(req.body?.model)
  if (entry) { entry._kill?.(); downloads.delete(entry.model) }
  res.json({ ok: true })
})

// ---------- sessions ----------
app.get('/api/sessions', (req, res) => res.json(listSessions()))

app.post('/api/sessions', (req, res) => {
  const project = req.body.projectId ? (config.projects || []).find(p => p.id === req.body.projectId) : null
  // The project's agent is a DEFAULT, not an override: an explicit agentId on
  // the request still wins, so "new chat with this agent" keeps working inside
  // a project that names a different one.
  const agentId = req.body.agentId || (project && project.agentId) || null
  const agent = agentId ? (config.agents || []).find(a => a.id === agentId) : null
  const participants = Array.isArray(req.body.participants) ? req.body.participants.filter(id => (config.agents || []).some(a => a.id === id)) : null
  const isGroup = Boolean(participants && participants.length >= 2)
  const session = {
    id: crypto.randomUUID(),
    title: req.body.title || (isGroup ? 'Group chat' : 'New session'),
    agentId: agent ? agent.id : null,
    group: isGroup,
    participants: isGroup ? participants : undefined,
    // agent picks the model/tools unless the request overrides them
    projectId: project ? project.id : null,
    // Precedence, most specific first: what the request asked for, then the
    // agent, then the project, then the global default.
    provider: req.body.provider || (agent && agent.provider) || (project && project.provider) || null,
    model: req.body.model || (agent && agent.model) || (project && project.model) || config.settings.defaultModel,
    // A project's folder beats the global default — that is most of the point.
    cwd: req.body.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: req.body.useTools !== undefined ? req.body.useTools !== false : (agent ? agent.useTools !== false : true),
    computerControl: req.body.computerControl !== undefined ? Boolean(req.body.computerControl) : Boolean(agent && agent.computerControl),
    createdAt: new Date().toISOString(),
    messages: []
  }
  saveSession(session)
  res.json(session)
})

app.get('/api/sessions-search', (req, res) => res.json(searchSessions(req.query.q, 30)))

app.get('/api/sessions/:id', (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  res.json(s)
})

app.patch('/api/sessions/:id', (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  for (const k of ['title', 'model', 'provider', 'cwd', 'useTools', 'computerControl', 'agentId', 'projectId', 'pinned', 'planMode']) {
    if (k in req.body) s[k] = req.body[k]
  }
  if ('title' in req.body) s.autoTitle = false // manual rename pins the title
  saveSession(s)
  res.json(s)
})

app.delete('/api/sessions/:id', (req, res) => {
  deleteSession(req.params.id)
  res.json({ ok: true })
})

// rewind: drop all messages from `index` onward (branch the conversation)
app.post('/api/sessions/:id/truncate', (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  const idx = Number(req.body?.index)
  if (Number.isInteger(idx) && idx >= 0 && idx <= s.messages.length) {
    s.messages = s.messages.slice(0, idx)
    saveSession(s)
  }
  res.json(s)
})

// ---------- chat (SSE) ----------
app.post('/api/chat', async (req, res) => {
  config = loadConfig() // see the latest keys/oauth before the turn
  const { sessionId, content } = req.body
  const session = loadSession(sessionId)
  if (!session) return res.status(404).json({ error: 'session not found' })
  if (activeTurns.has(sessionId)) return res.status(409).json({ error: 'a turn is already running' })

  // agent (persona + its skills) plus globally-enabled skills
  const agent = session.agentId ? (config.agents || []).find(a => a.id === session.agentId) : null

  // Live relay: some agents bridge to a real external agent (e.g. Hermes) with its
  // own model, skills, and memory. They need no Radiant provider — stream the
  // external agent's reply straight through and skip provider/skills/mcp/runTurn.
  if (agent && agent.relay === 'hermes') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`)
    const text = typeof content === 'string' ? content : (content.text || '')
    const attachments = (typeof content === 'object' && content.attachments) || []
    session.messages.push({ role: 'user', text, attachments })
    if (session.messages.length === 1 && session.autoTitle !== false) {
      session.title = text.length > 48 ? text.slice(0, 48) + '…' : (text || `${attachments.length} file(s)`)
      session.autoTitle = true
      emit({ type: 'title', title: session.title })
    }
    saveSession(session)
    const controller = new AbortController()
    activeTurns.set(sessionId, { controller })
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    const assistant = { role: 'assistant', parts: [] }
    if (agent.id) assistant.agentId = agent.id
    session.messages.push(assistant)
    try {
      const reply = await runHermesRelay({ text, emit, signal: controller.signal, session })
      if (reply) assistant.parts.push({ type: 'text', text: reply })
      emit({ type: 'done' })
    } catch (e) {
      if (!controller.signal.aborted) emit({ type: 'error', message: e.message })
    } finally {
      activeTurns.delete(sessionId)
      saveSession(session)
      emit({ type: 'closed' })
      res.end()
    }
    return
  }

  let provider = config.providers.find(p => p.id === session.provider)
  if (!provider) return res.status(400).json({ error: 'Pick a model first — no provider set on this session.' })
  // Qwen's OAuth token names the API host to use; honour it over the default.
  if (provider.id === 'qwen' && config.oauth.qwen?.apiBase) provider = { ...provider, baseUrl: config.oauth.qwen.apiBase }
  const apiKey = config.keys[provider.id]
  const hasOAuth = Boolean(config.oauth[provider.id])
  if (provider.auth === 'key' && !apiKey && !hasOAuth) return res.status(400).json({ error: `No API key or subscription sign-in for ${provider.name}. Add one in Settings.` })

  // agent (persona + its skills, resolved above) plus globally-enabled skills
  const allSkills = config.skills || []
  const agentSkillIds = new Set(agent?.skills || [])
  const mergedSkills = allSkills.filter(s => s.enabled || agentSkillIds.has(s.id))

  // MCP tools from enabled servers, bridged into the tool set
  let mcpTools = []
  let callMcp = null
  if ((config.mcpServers || []).some(s => s.enabled)) {
    try {
      const mcp = await import('./mcp.js')
      mcpTools = await mcp.mcpToolDefs(config.mcpServers)
      callMcp = (name, args) => mcp.callMcpTool(name, args, config.mcpServers)
    } catch (e) { console.error('[mcp]', e.message) }
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const emit = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`)

  // content is either a string or { text, attachments:[{name,mime,dataB64,kind}] }
  const text = typeof content === 'string' ? content : (content.text || '')
  const attachments = (typeof content === 'object' && content.attachments) || []
  session.messages.push({ role: 'user', text, attachments })
  if (session.messages.length === 1 && session.autoTitle !== false) {
    // instant placeholder; upgraded to a nicer title after the turn (see below)
    session.title = text.length > 48 ? text.slice(0, 48) + '…' : (text || `${attachments.length} file(s)`)
    session.autoTitle = true
    emit({ type: 'title', title: session.title })
  }
  saveSession(session)

  const controller = new AbortController()
  activeTurns.set(sessionId, { controller })
  // res 'close' fires on client disconnect (req 'close' fires once the body is
  // consumed in modern Node, which would abort the turn immediately)
  res.on('close', () => { if (!res.writableEnded) controller.abort() })

  const requestApproval = call => new Promise(resolve => {
    // approval mode: 'ask' = confirm every command, 'auto' = only risky ones, 'off' = never
    const mode = config.settings.approvalMode || (config.settings.approveCommands === false ? 'off' : 'ask')
    if (mode === 'off') return resolve(true)
    // in Auto mode, run low-risk shell commands silently (a quick notice); still ask
    // for risky commands and always for MCP / desktop control.
    if (mode === 'auto' && call.name === 'run_command' && commandRisk(call.args?.command) === 'low') {
      emit({ type: 'notice', text: `Ran: ${call.args.command}` })
      return resolve(true)
    }
    pendingApprovals.set(call.id, resolve)
    emit({ type: 'approval_request', id: call.id, name: call.name, args: call.args })
    setTimeout(() => {
      if (pendingApprovals.delete(call.id)) resolve(false)
    }, 10 * 60 * 1000)
  })

  // pause the turn and ask the user a multiple-choice question (ask_user tool)
  const requestUserChoice = (question, options) => new Promise(resolve => {
    const id = crypto.randomUUID()
    pendingQuestions.set(id, resolve)
    emit({ type: 'question_request', id, question, options: Array.isArray(options) ? options : [] })
    setTimeout(() => { if (pendingQuestions.delete(id)) resolve('(no answer — the user did not respond in time)') }, 10 * 60 * 1000)
  })

  // let this agent consult the OTHER agents (peers) via the ask_agent tool
  const peers = (config.agents || []).filter(a => a.id !== session.agentId)
  const peerAgents = peers.map(a => ({ name: a.name, blurb: (a.persona || '').split(/(?<=[.!?])\s/)[0].slice(0, 90) || 'general assistant' }))
  const askAgent = async (agentRef, question) => {
    const target = peers.find(a => a.id === agentRef || a.name.toLowerCase() === String(agentRef || '').toLowerCase())
    if (!target) return `No agent named "${agentRef}". You can ask: ${peers.map(a => a.name).join(', ') || '(none available)'}.`
    if (!question || !String(question).trim()) return 'Provide a question for the agent.'
    let tProvider = provider, tApiKey = apiKey, tHasOAuth = hasOAuth, tModel = session.model
    if (target.model && target.provider) {
      const p = config.providers.find(x => x.id === target.provider)
      if (p) { tProvider = p; tApiKey = config.keys[p.id]; tHasOAuth = Boolean(config.oauth[p.id]); tModel = target.model }
    }
    const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: String(question) }] }

    // ⚠️ A CONSULT IS A WHOLE EXTRA MODEL TURN, FIRED AT A PROVIDER ALREADY
    // MID-TURN. A transient rate limit is therefore the LIKELIEST way for it to
    // fail, and there was no retry at all — one 429 and the consult was simply
    // gone. Two short backoffs cost nothing when things are fine and rescue the
    // common case when they are not. Aborts are never retried: an abort means
    // the user's connection dropped or they stopped the turn, and hammering the
    // provider after that is wrong.
    const attempt = async () => {
      let answer = ''
      await runTurn({
        provider: tProvider, model: tModel, apiKey: tApiKey,
        getAccessToken: tHasOAuth ? () => validAccessToken(tProvider.id, config, saveConfig) : null,
        getAccountId: tHasOAuth ? () => config.oauth[tProvider.id]?.accountId || null : null,
        session: tmp, useTools: false, computerControl: false,
        persona: target.persona || '', skills: [],
        emit: ev => { if (ev.type === 'text_delta') answer += ev.text },
        requestApproval: null, signal: controller.signal
      })
      return answer
    }
    const rateLimited = e => /429|rate.?limit|too many requests|overloaded/i.test(e?.message || '')
    let answer = ''
    for (let tryNo = 1; ; tryNo++) {
      try { answer = await attempt(); break } catch (e) {
        if (controller.signal.aborted) {
          // ⚠️ SAY SO IN THE TRANSCRIPT, NOT ONLY IN THE TOOL RESULT. The tool
          // result is buried in a collapsed block, so whether the user ever
          // learns a consult failed depended entirely on the model choosing to
          // mention it. A different model would quietly carry on and the user
          // would believe a specialist had reviewed the work.
          emit({ type: 'notice', text: `The consult with ${target.name} was cut short when the connection dropped.` })
          return `(${target.name} could not be reached: the turn was interrupted.)`
        }
        if (rateLimited(e) && tryNo <= 2) {
          emit({ type: 'notice', text: `${target.name} is rate limited — retrying in ${tryNo * 3}s…` })
          await new Promise(r => setTimeout(r, tryNo * 3000))
          continue
        }
        emit({ type: 'notice', text: `Could not reach ${target.name}: ${e.message}` })
        return `(${target.name} couldn't respond: ${e.message})`
      }
    }
    if (!answer.trim()) {
      emit({ type: 'notice', text: `${target.name} returned nothing.` })
      return `(${target.name} gave no answer.)`
    }
    return `${target.name} says:\n${answer.trim()}`
  }

  // one-shot summarizer used by auto-compaction (runs on the session's model, no tools)
  const summarize = async text => {
    const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `Summarize this conversation so it can continue without losing context. Preserve: decisions made, files created or edited, the current task and its state, and any open questions or next steps. Be concise but complete; use short bullet points.\n\n${text}` }] }
    let out = ''
    try {
      await runTurn({
        provider, model: session.model, apiKey,
        getAccessToken: hasOAuth ? () => validAccessToken(provider.id, config, saveConfig) : null,
        getAccountId: hasOAuth ? () => config.oauth[provider.id]?.accountId || null : null,
        session: tmp, useTools: false, computerControl: false, persona: '', skills: [],
        emit: ev => { if (ev.type === 'text_delta') out += ev.text },
        requestApproval: null, signal: controller.signal
      })
    } catch {}
    return out
  }

  const memoryOn = config.settings.memory !== false
  const memory = memoryOn ? relevantFacts(text, session.cwd) : []

  // lead/worker: if this agent has a planner model, have the (stronger) lead model
  // outline the approach first; the (session) model then executes it.
  let plannedPersona = agent?.persona || ''
  if (agent?.plannerModel && agent?.plannerProvider && session.useTools !== false && !session.group) {
    const pProvider = config.providers.find(p => p.id === agent.plannerProvider)
    if (pProvider) {
      const pOAuth = Boolean(config.oauth[pProvider.id])
      emit({ type: 'notice', text: `Planning with ${agent.plannerModel}…` })
      const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `You are the planning lead. Produce a brief numbered plan (3–6 steps, no code) that a coding agent will follow to handle this request in the workspace. Be concrete.\n\nRequest: ${text}` }] }
      let plan = ''
      try {
        await runTurn({
          provider: pProvider, model: agent.plannerModel, apiKey: config.keys[pProvider.id],
          getAccessToken: pOAuth ? () => validAccessToken(pProvider.id, config, saveConfig) : null,
          getAccountId: pOAuth ? () => config.oauth[pProvider.id]?.accountId || null : null,
          session: tmp, useTools: false, computerControl: false, persona: '', skills: [],
          emit: ev => { if (ev.type === 'text_delta') plan += ev.text },
          requestApproval: null, signal: controller.signal
        })
      } catch {}
      if (plan.trim()) plannedPersona = `${plannedPersona}\n\n[A lead model has planned the approach below — follow it, adapting as needed:]\n${plan.trim()}`
    }
  }

  const common = {
    provider,
    model: session.model,
    apiKey,
    getAccessToken: hasOAuth ? () => validAccessToken(provider.id, config, saveConfig) : null,
    getAccountId: hasOAuth ? () => config.oauth[provider.id]?.accountId || null : null,
    session,
    memory,
    summarize,
    autoCompact: config.settings.autoCompact !== false,
    autoApproveComputer: config.settings.fullAutomation === true,
    mcpTools,
    callMcp,
    emit,
    requestApproval,
    requestUserChoice,
    signal: controller.signal
  }

  try {
    const participants = (session.group && Array.isArray(session.participants)) ? session.participants : null
    if (participants && participants.length) {
      // group chat: each participant agent responds in turn, seeing the others' replies
      const names = participants.map(id => (config.agents || []).find(a => a.id === id)?.name).filter(Boolean)
      const groupNames = Object.fromEntries(participants.map(id => [id, (config.agents || []).find(a => a.id === id)?.name || 'Agent']))
      for (const pid of participants) {
        if (controller.signal.aborted) break
        const ag = (config.agents || []).find(a => a.id === pid)
        if (!ag) continue
        emit({ type: 'agent_turn', agentId: pid, name: ag.name })
        const groupPersona = `${ag.persona || ''}\n\nThis is a group discussion between ${names.join(', ')}. You are ${ag.name}. The other participants' messages are shown to you tagged like "[Name]: …". Speak only as yourself, in the first person, briefly. Add something new — build on or respectfully challenge what the others said; do not repeat them or role-play the other participants.`
        await runTurn({ ...common, agentId: pid, groupSpeakerId: pid, groupNames, persona: groupPersona, skills: [], useTools: false, computerControl: false })
      }
    } else {
      await runTurn({
        ...common,
        useTools: session.useTools !== false,
        computerControl: Boolean(session.computerControl),
        persona: plannedPersona,
        skills: mergedSkills,
        askAgent,
        peerAgents,
        planMode: Boolean(session.planMode),
        onPlanExit: () => { session.planMode = false; emit({ type: 'plan_mode', on: false }) }
      })
    }
    // auto-title a still-unnamed session from its first user message
    const firstUser = session.messages.find(m => m.role === 'user')
    if (firstUser?.text && session.autoTitle !== false && !controller.signal.aborted) {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim().replace(/^["'#\s]+|["'.…\s]+$/g, '').slice(0, 56)
      // fast heuristic fallback: first several words of the request
      let t = clean(firstUser.text.split(' ').slice(0, 8).join(' '))
      // nicer LLM title, but only for cloud models (local ones are slow / echo the prompt)
      const cloud = ['anthropic', 'openai', 'openrouter', 'nousresearch'].includes(provider.id)
      if (cloud) {
        try {
          const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `Reply with ONLY a 3-6 word title (no quotes, no punctuation) summarizing this coding request:\n\n${firstUser.text.slice(0, 600)}` }] }
          let out = ''
          await runTurn({
            provider, model: session.model, apiKey,
            getAccessToken: hasOAuth ? () => validAccessToken(provider.id, config, saveConfig) : null,
            getAccountId: hasOAuth ? () => config.oauth[provider.id]?.accountId || null : null,
            session: tmp, useTools: false, computerControl: false, persona: '', skills: [],
            emit: ev => { if (ev.type === 'text_delta') out += ev.text },
            requestApproval: null, signal: controller.signal
          })
          out = clean(out.split('\n').find(l => l.trim()) || '')
          // use it unless the model just echoed the request
          if (out && !firstUser.text.toLowerCase().startsWith(out.toLowerCase().slice(0, 20))) t = out
        } catch {}
      }
      if (t) { session.title = t; emit({ type: 'title', title: t }) }
    }
    // distill durable facts into long-term memory (best-effort, after the turn)
    if (memoryOn && !session.group && !controller.signal.aborted) {
      try {
        const lastUser = [...session.messages].reverse().find(m => m.role === 'user')
        const lastAsst = [...session.messages].reverse().find(m => m.role === 'assistant')
        const exchange = `User: ${(lastUser?.text || '').slice(0, 1500)}\n\nAssistant: ${(lastAsst?.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ').slice(0, 1500)}`
        const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `From this exchange, extract any NEW durable facts worth remembering long-term about the USER or their PROJECT — preferences, decisions, names, conventions, tools/environment, or goals. Only lasting facts, not task-specific chatter or one-off requests. Write each as a short standalone sentence, one per line. If there is nothing durable, reply exactly "none".\n\n${exchange}` }] }
        let out = ''
        await runTurn({
          provider, model: session.model, apiKey,
          getAccessToken: hasOAuth ? () => validAccessToken(provider.id, config, saveConfig) : null,
          getAccountId: hasOAuth ? () => config.oauth[provider.id]?.accountId || null : null,
          session: tmp, useTools: false, computerControl: false, persona: '', skills: [],
          emit: ev => { if (ev.type === 'text_delta') out += ev.text },
          requestApproval: null, signal: controller.signal
        })
        if (out && !/^\s*none\b/i.test(out.trim())) {
          const n = addFacts(out.split('\n').map(l => l.trim()).filter(Boolean), session.cwd)
          if (n) emit({ type: 'memory_added', count: n })
        }
      } catch {}
    }
    // skillsmith: draft a reusable-skill proposal from procedural work (best-effort,
    // cloud models only, and only when the turn looks skill-worthy). Never auto-saves.
    const suggestOn = config.settings.suggestSkills !== false
    const cloud = ['anthropic', 'openai', 'openrouter', 'nousresearch'].includes(provider.id)
    if (suggestOn && cloud && !session.group && !controller.signal.aborted) {
      try {
        const lastUser = [...session.messages].reverse().find(m => m.role === 'user')
        const lastAsst = [...session.messages].reverse().find(m => m.role === 'assistant')
        const alreadyPending = (config.skillSuggestions || []).some(s => s.sessionId === session.id)
        if (!alreadyPending && shouldReflect(lastUser, lastAsst)) {
          const asstText = (lastAsst?.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ')
          const toolNames = [...new Set((lastAsst?.parts || []).filter(p => p.type === 'tool' && p.name).map(p => p.name))].join(', ')
          const exchange = `User: ${(lastUser?.text || '').slice(0, 1800)}\n\nAssistant (tools used: ${toolNames || 'none'}): ${asstText.slice(0, 1800)}`
          const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: reflectionPrompt(exchange, config.skills || []) }] }
          let out = ''
          await runTurn({
            provider, model: session.model, apiKey,
            getAccessToken: hasOAuth ? () => validAccessToken(provider.id, config, saveConfig) : null,
            getAccountId: hasOAuth ? () => config.oauth[provider.id]?.accountId || null : null,
            session: tmp, useTools: false, computerControl: false, persona: '', skills: [],
            emit: ev => { if (ev.type === 'text_delta') out += ev.text },
            requestApproval: null, signal: controller.signal
          })
          const proposal = parseProposal(out)
          if (proposal) {
            const sug = addSuggestion(config, proposal, session.id)
            if (sug) { saveConfig(config); emit({ type: 'skill_suggested', suggestion: { id: sug.id, name: sug.name, description: sug.description, rationale: sug.rationale } }) }
          }
        }
      } catch {}
    }
  } catch (e) {
    if (!controller.signal.aborted) emit({ type: 'error', message: e.message })
  } finally {
    activeTurns.delete(sessionId)
    saveSession(session)
    emit({ type: 'closed' })
    res.end()
  }
})

app.post('/api/approve', (req, res) => {
  const { id, approved } = req.body
  const resolve = pendingApprovals.get(id)
  if (resolve) {
    pendingApprovals.delete(id)
    resolve(Boolean(approved))
  }
  res.json({ ok: true })
})

app.post('/api/answer-question', (req, res) => {
  const { id, answer } = req.body
  const resolve = pendingQuestions.get(id)
  if (resolve) { pendingQuestions.delete(id); resolve(String(answer ?? '')) }
  res.json({ ok: true })
})

app.post('/api/abort', (req, res) => {
  const turn = activeTurns.get(req.body.sessionId)
  if (turn) turn.controller.abort()
  res.json({ ok: true })
})

// ---------- static (production build) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(__dirname, '..', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

// ---------- terminal over WebSocket ----------
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/term' })
// ws re-emits the http server's 'error' events here; without a listener an
// EADDRINUSE would throw and kill the port-fallback logic below
wss.on('error', e => console.error('[ws]', e.message))

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  // terminal socket is gated too — browsers can't set headers on a WS, so remote
  // clients pass the token as a query param
  if (!isLocalRequest(req)) {
    const tok = url.searchParams.get('token')
    if (!SHARE_TOKEN || tok !== SHARE_TOKEN) { ws.close(1008, 'unauthorized'); return }
  }
  const cwd = url.searchParams.get('cwd') || os.homedir()
  const shell = process.env.SHELL || '/bin/zsh'
  let term
  try {
    term = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      env: { ...process.env, TERM_PROGRAM: 'radiant' }
    })
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e.message }))
    ws.close()
    return
  }
  term.onData(data => { if (ws.readyState === 1) ws.send(data) })
  term.onExit(() => ws.close())
  ws.on('message', msg => {
    const text = msg.toString()
    if (text.startsWith('\x00resize:')) {
      const [cols, rows] = text.slice(8).split(',').map(Number)
      if (cols > 0 && rows > 0) term.resize(cols, rows)
    } else {
      term.write(text)
    }
  })
  ws.on('close', () => term.kill())
})

// Resolves with the bound port once listening; falls back to a random free
// port if the default is taken (e.g. a dev instance is already running).
export const ready = new Promise((resolve, reject) => {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE') {
      server.listen(0, BIND_HOST, () => resolve(server.address().port))
    } else {
      reject(err)
    }
  })
  server.listen(PORT, BIND_HOST, () => resolve(server.address().port))
})
// ⚠️ SET UP THE AWAY-FROM-HOME ADDRESS AT BOOT, not only when the checkbox is
// flipped. Tony's bottom line: "i would like people using their iphone away from
// their home to be able to connect to radiant running on their mac and use the
// models within it." That needs an https address reachable off the local
// network, and Tailscale Serve is what provides it — but wiring it only to the
// toggle meant everyone who had ALREADY enabled sharing never got one, which is
// exactly the state Tony was in when nothing worked from outside the house.
if (SHARE_ENABLED) {
  // Try to raise the front door, then find out the truth either way.
  try { enableTailscaleServe(PORT) } catch { /* never block startup */ }
  refreshRemoteUrl()
    .then(u => { if (u) console.log(`radiant reachable from anywhere at ${u}`) })
    .catch(() => {})
}

ready.then(port => console.log(`radiant server listening on http://${BIND_HOST}:${port}${SHARE_ENABLED ? ' (shared — token required for remote clients)' : ''}`))
