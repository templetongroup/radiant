import express from 'express'
import { snapshot as ckSnapshot, changes as ckChanges, fileDiff as ckFileDiff, restore as ckRestore, eligible as ckEligible } from './checkpoints.js'
import { listGatewayAgents } from './openclaw.js'
import http from 'http'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { execFileSync, execFile } from 'node:child_process'
import { promises as dnsp } from 'node:dns'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import pty from 'node-pty'
import { execSync, spawn } from 'child_process'
import { RADIANT_DIR, DIR_POINTER, CONFIG_PATH, defaultDataDir, dataDirStatus, loadConfig, saveConfig as writeConfig, publicConfig, listSessions, loadSession, saveSession, deleteSession, searchSessions, upsertCredential, activateAccount, removeAccount, SESSIONS_DIR, listProjects, getProject, saveProject, deleteProject, migrateProjects, agentsStore, skillsStore, recipesStore, cloudStatus, MACHINE_KEYS, saveMachineSettings, skillLibrary, inspectSkillFolder, resolveSkillDir, USER_SKILLS_ROOT, repairCloudFolder, builtinAgent, listTasks, loadTask, saveTask, deleteTask, TASK_STATES, TASK_PRIORITIES, taskActivity, taskComment, listLoops, loadLoop, saveLoop, deleteLoop, LOOP_STATES, listGraphs, loadGraph, saveGraph, deleteGraph, saveTurnSession , loadProjectRules } from './config.js'
import { runTurn, listModels, JEV_ROUTER } from './providers.js'
import { checkVoiceRequest, liveSessionBody, createLiveSession, voiceKey, VOICE_ADDENDUM } from './voice.js'
import { geminiVoiceKey, checkGeminiVoiceRequest, geminiSetupFrame, mintEphemeralToken, geminiLiveModel, GEMINI_WS_URL, GEMINI_LIVE_MODELS, GEMINI_LIVE_VOICES, GEMINI_RATE_IN_PER_MINUTE, GEMINI_RATE_OUT_PER_MINUTE } from './voice-gemini.js'
import { addressing, groupPersona } from './group.js'
import { shouldFallBack, fallbackNotice } from './fallback.js'
import { OAUTH_PROVIDERS, buildAuthUrl, completePaste, startLoopback, validAccessToken, startDevice, pollDevice } from './oauth.js'
import { checkForUpdate } from './updater.js'
import { ollamaBin, hermesBin, SPAWN_ENV } from './ollama.js'
import { commandRisk } from './util.js'
import { claimLock, beatLock, releaseLock, describeHolder, sweepLegacyLocks, BEAT_MS } from './lock.js'
import { prStatus } from './pr.js'
const LOCK_HOST = computerName()   // "Tony's Home MBP M4", not a DNS name
import { IS_MAC, openCommand, chromeBinary, tailscaleBinary, defaultShell, cpuName, osVersion as osProductVersion, computerName } from './platform.js'
import { listFacts, addFacts, addFactManual, deleteFact, clearFacts, relevantFacts } from './memory.js'
import { shouldReflect, reflectionPrompt, parseProposal, addSuggestion } from './skillsmith.js'
import {
  normalizeStep, workPrompt, checkPrompt, readVerdict, readCommandVerdict,
  normalizeGoal, hasGoalCheck, goalPrompt, resetSteps,
  normalizeSchedule, nextRunAt, isDue, afterRun
} from './loop-rules.js'
import { normalizeNode, planLayers, suspectEdges, toMermaid, draftPrompt, readDraft, DEFAULT_CONCURRENCY, checkNodes, normalizeRepeat } from './graph-rules.js'
import { runGraph, isRunning, liveRun, stopGraph } from './graph-run.js'

const PORT = Number(process.env.RADIANT_PORT || 5834)
const app = express()

// CORS: a remote client (another Mac's app, or a phone browser) talks to this
// server from a different origin. Allow it and answer preflight BEFORE auth — the
// custom x-radiant-token header triggers a preflight OPTIONS that carries no token.
app.use((req, res, next) => {
  const origin = req.headers.origin
  // Reflecting a third-party origin is what would let its scripts READ the
  // reply. Same-site only; everything else gets no CORS headers at all.
  if (origin && sameSiteRequest(req)) {
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

// ⚠️ FIVE MACS, ONE FOLDER, AND EVERY SERVER HELD ITS OWN COPY. Each Radiant
// loaded config.json once and wrote its whole in-memory copy back on every
// change — so a theme picked on this Mac was overwritten by the next save on
// any other Mac, whose copy still had the old theme. The banner's answer was
// "quit one of them". Tony: "I have 5 macs. youre telling me i need to quit
// radiant on each one to work on another mac?" No.
//
// The fix is freshness, not exclusivity: the file is watched, and a write that
// is not ours (iCloud carrying another Mac's save) is loaded into memory the
// moment it lands, so the next save here carries it forward. What remains is
// last-writer-wins within iCloud's few seconds of propagation, which is the
// honest limit of a shared folder and is stated in Settings → Devices.
// fs.watchFile polls, deliberately: fs.watch on an iCloud folder misses events.
let configRev = 1
let ownConfigHash = null
const hashOf = raw => crypto.createHash('sha1').update(raw).digest('hex')
function saveConfig (cfg, opts) {
  writeConfig(cfg, opts)
  try { ownConfigHash = hashOf(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch {}
  configRev++
}
try { ownConfigHash = hashOf(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch {}
fs.watchFile(CONFIG_PATH, { interval: 4000 }, () => {
  let raw
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8') } catch { return }
  const h = hashOf(raw)
  if (h === ownConfigHash) return          // our own write coming back
  try { JSON.parse(raw) } catch { return } // a half-synced file; the next tick sees the whole one
  config = loadConfig()
  ownConfigHash = h
  configRev++
})
// Projects used to live in config.json. Move them to one file each before
// anything reads them, so a second Mac cannot overwrite the whole list.
migrateProjects(config)
agentsStore.migrate(config)
skillsStore.migrate(config)
recipesStore.migrate(config)

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
// ⚠️ A PAGE YOU DID NOT OPEN IS ALSO ON LOOPBACK. The socket address cannot tell
// the app's own window apart from someone else's tab hitting 127.0.0.1, and the
// CORS layer below used to reflect whatever Origin asked. Together that let any
// site the user happened to be browsing read /api/config and drive /api/chat
// with no token and no click. Origin is the only thing that separates them, so
// it is checked here and nowhere else has to think about it.
//
// ⚠️ THE EXPECTED ORIGIN IS BUILT AT BOOT, NEVER READ OFF THE REQUEST. The first
// version of this gate compared Origin against the Host header — but both are
// sent by the client, so it only asked whether the request agreed with itself.
// Any name an attacker controls satisfies that: serve a page from
// attacker.com:5834 with a one-second DNS record, flip it to 127.0.0.1, and the
// page is same-origin with Radiant. Origin equals Host, the socket is loopback,
// and the tab gets /api/share (the token) and a login shell on /term. Measured:
// `curl -H 'Host: attacker.example:5834' -H 'Origin: http://attacker.example:5834'`
// returned 200 where a plain third-party Origin correctly returned 401.
//
// So the allowlist is fixed: loopback on the port we actually bound, plus the
// tailnet name we verified ourselves. Nothing derived from the request.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1'])
// EADDRINUSE falls back to `listen(0)`, so the real port is not known until the
// server is up — the allowlist has to use that, not the constant.
let boundPort = PORT
const bareName = h => String(h || '').replace(/^\[|\]$/g, '')

// ⚠️ ONE EXTRA ORIGIN, AND ONLY WHEN SOMETHING SET IT. `npm run dev` serves the
// UI from Vite on another port and proxies /api here, so the browser sends
// Origin: http://localhost:5833 against a server bound to 5834 — a different
// origin by this rule, and correctly so. The effect was that every write from
// the dev server came back 401 while reads passed (a browser omits Origin on a
// same-origin GET and sends it on a POST), so `npm run dev` could show the app
// but not create a session, send a message or save a setting. Nobody noticed
// because the packaged app loads from this server's own origin and never
// crosses ports. The dev script sets this; a shipped build has no such variable,
// so the allowlist there is exactly what it was.
const DEV_ORIGIN = process.env.RADIANT_DEV_ORIGIN || null

function allowedOrigin (o) {
  let u
  try { u = new URL(o) } catch { return false }
  if (DEV_ORIGIN && o === DEV_ORIGIN) return true
  const name = bareName(u.hostname)
  if (LOOPBACK_NAMES.has(name)) return (u.port || '80') === String(boundPort)
  if (remoteUrl) { try { return bareName(new URL(remoteUrl).hostname) === name } catch { return false } }
  return false
}
function allowedHost (h) {
  let u
  try { u = new URL('http://' + String(h || '')) } catch { return false }
  // The dev proxy forwards the browser's Host as well as its Origin.
  if (DEV_ORIGIN) { try { if (u.host === new URL(DEV_ORIGIN).host) return true } catch {} }
  const name = bareName(u.hostname)
  if (LOOPBACK_NAMES.has(name)) return (u.port || '80') === String(boundPort)
  if (remoteUrl) { try { return bareName(new URL(remoteUrl).hostname) === name } catch { return false } }
  return false
}
function sameSiteRequest (req) {
  if (!allowedHost(req.headers?.host)) return false
  const o = req.headers?.origin
  if (o) return allowedOrigin(o)
  // ⚠️ NO ORIGIN IS NOT THE SAME AS NO BROWSER. Absent Origin is the app itself,
  // the iOS client and curl — but a browser also omits it on a no-cors
  // subresource load, so `<img src=".../api/dictate">` on any page counted as
  // trusted and turned the microphone on with no click. Browsers always send
  // Sec-Fetch-*; native clients and curl never do, so its absence is the signal.
  const site = req.headers['sec-fetch-site']
  if (!site) return true
  return site === 'same-origin' || site === 'none'
}
// The socket half, on its own: the extension bridge needs it without the Origin
// rule, because its Origin is a chrome-extension:// URL by design.
function loopbackSocket (req) {
  for (const h of PROXY_HEADERS) if (req.headers?.[h]) return false
  const ra = req.socket?.remoteAddress
  return !ra || ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
}
function isLocalRequest (req) {
  return sameSiteRequest(req) && loopbackSocket(req)
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
  const bin = tailscaleBinary()
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
const rulesNoticed = new Map() // sessionId -> the rules-file signature last announced, so it is said once
const pendingApprovals = new Map() // callId -> resolve(bool)
const pendingQuestions = new Map() // questionId -> resolve(answer string)

// A quiet "thinking" phase or a slow tool call can leave an SSE connection with
// no bytes flowing for a minute or more. A local client never notices, but a
// remote one — this Mac reached from another over Tailscale, say — often routes
// through NAT traversal or a DERP relay, and both commonly reap connections
// that go idle that long, which silently drops the turn (res 'close' below,
// same path recordTurnStopped now explains) well before either side did
// anything wrong. A small periodic comment line keeps real bytes moving so
// those hops never see the connection as idle in the first place.
function startHeartbeat (res) {
  // ⚠️ `destroyed`, NOT `writableEnded`. After a client vanishes, writableEnded
  // stays FALSE (nobody called res.end()) while destroyed is already true —
  // measured, not assumed — so the writableEnded guard never fires and the
  // pings keep going into a dead socket until the turn unwinds. Node swallows
  // them rather than throwing, so this is tidiness, not a crash.
  const timer = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n') }, 20000)
  return () => clearInterval(timer)
}

// Reload config from disk before handling config-touching requests, so a second
// instance (or a stale in-memory copy) can't clobber another's keys/oauth when
// it saves. Skips long-lived streams that captured config at their start.
// ⚠️ API RESPONSES MUST NEVER BE CACHED BY THE WEBVIEW.
//
// Express stamps an ETag on every JSON response and nothing set a cache
// directive, so Chromium was free to reuse an /api/ response it had already
// seen — from the same stable URL, out of a cache that lives in the user data
// folder and therefore survives quitting, restarting, and reinstalling the app.
//
// Tony's About pane insisted the app was running 0.6.128 while the window was
// plainly rendering 0.6.132's code, through a fresh install and repeated
// restarts, because /api/version was answering out of that cache. Every other
// read — projects, sessions, config — was equally cacheable.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store, must-revalidate')
  next()
})

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
app.get('/api/config', (req, res) => res.json({ ...publicConfig(config), rev: configRev, sharing, sharingText: describeHolder(sharing, LOCK_HOST) }))

app.put('/api/settings', (req, res) => {
  // ⚠️ SPLIT THE SAVE. Anything in MACHINE_KEYS describes this Mac — which model
  // is downloaded here, which provider serves it, where work starts — and goes
  // to a file outside the shared folder. Writing them into config.json would
  // mean picking a model on one Mac changes it on a Mac that does not have it.
  const body = req.body || {}
  const machine = {}
  for (const k of MACHINE_KEYS) if (k in body) machine[k] = body[k]
  if (Object.keys(machine).length) saveMachineSettings(machine)

  const shared = { ...body }
  for (const k of MACHINE_KEYS) delete shared[k]
  config.settings = { ...config.settings, ...shared }
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
  const { name, transport, command, args, env, url, token } = req.body
  if (!name || (!command && !url)) return res.status(400).json({ error: 'name and a command or url required' })
  config.mcpServers = config.mcpServers || []
  config.mcpServers.push({
    id: 'mcp-' + crypto.randomBytes(4).toString('hex'),
    name, transport: transport || (url ? 'http' : 'stdio'),
    command: command || null, args: Array.isArray(args) ? args : (args ? String(args).split(' ').filter(Boolean) : []),
    env: env || {}, url: url || null, token: token || null, enabled: true
  })
  saveConfig(config)
  res.json(publicConfig(config))
})

app.patch('/api/mcp/:id', async (req, res) => {
  const s = (config.mcpServers || []).find(x => x.id === req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'command', 'args', 'url', 'enabled', 'token']) if (k in req.body) s[k] = req.body[k]
  if ('args' in req.body && !Array.isArray(s.args)) s.args = s.args ? String(s.args).split(' ').filter(Boolean) : []
  s.transport = s.url ? 'http' : 'stdio'
  // env values are redacted on the way out, so they come back empty. An empty
  // value means "unchanged", not "erase it" — otherwise editing a server's name
  // would silently wipe the credentials it runs with.
  if ('env' in req.body) {
    const incoming = req.body.env || {}
    const next = {}
    for (const [k, v] of Object.entries(incoming)) next[k] = v === '' ? (s.env || {})[k] ?? '' : v
    s.env = next
  }
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
  const newAgent = {
    id: 'ag-' + crypto.randomBytes(4).toString('hex'),
    name, emoji: emoji || '🤖', icon: icon || null, hue: hue ?? null, persona: persona || '',
    model: model || null, provider: provider || null, skills: skills || [],
    useTools: useTools !== false, computerControl: Boolean(computerControl),
    plannerModel: plannerModel || null, plannerProvider: plannerProvider || null,
    avatar: avatar || null, relay: relay || null, source: source || null
  }
  agentsStore.save(newAgent)
  res.json(publicConfig(config))
})

app.patch('/api/agents/:id', (req, res) => {
  const a = agentsStore.get(req.params.id)
  if (!a) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'emoji', 'icon', 'hue', 'persona', 'model', 'provider', 'skills', 'useTools', 'computerControl', 'plannerModel', 'plannerProvider', 'avatar', 'relay', 'source']) {
    if (k in req.body) a[k] = req.body[k]
  }
  agentsStore.save(a)
  res.json(publicConfig(config))
})

// ── chat import / export ────────────────────────────────────────────────────
// Two formats, because they answer different questions. JSON is the archive:
// everything, and it can be imported back. Markdown is the artefact you paste
// into a ticket or send to someone — readable, and deliberately lossy.

const SAFE_SESSION_KEYS = [
  'title', 'agentId', 'group', 'participants', 'provider', 'model', 'cwd',
  'useTools', 'computerControl', 'planMode', 'skillIds', 'effort', 'createdAt', 'updatedAt', 'messages'
]

// ---- ChatGPT exports --------------------------------------------------------
//
// A ChatGPT export is conversations.json: an array of conversations, each
// holding a `mapping` of message nodes that form a TREE, because every edit or
// regeneration in ChatGPT creates a branch. `current_node` marks the leaf of the
// conversation as the user last left it, so walking parents from there and
// reversing gives the thread they actually saw. Reading `mapping` in object
// order instead would interleave abandoned branches into one nonsensical
// transcript.
function looksLikeChatGPT (body) {
  const arr = Array.isArray(body) ? body : (Array.isArray(body?.conversations) ? body.conversations : null)
  return Boolean(arr && arr.length && arr.some(c => c && typeof c.mapping === 'object'))
}

function chatGPTText (msg) {
  const c = msg?.content
  if (!c) return ''
  if (Array.isArray(c.parts)) {
    return c.parts.map(p => typeof p === 'string' ? p : (p?.text || '')).filter(Boolean).join('\n').trim()
  }
  return typeof c.text === 'string' ? c.text.trim() : ''
}

function fromChatGPT (body) {
  const convos = Array.isArray(body) ? body : body.conversations
  const out = []
  for (const c of convos) {
    if (!c || typeof c.mapping !== 'object') continue
    // Walk up from the leaf, then reverse: this is the thread as last seen.
    const chain = []
    let id = c.current_node
    const guard = new Set()
    while (id && c.mapping[id] && !guard.has(id)) {
      guard.add(id)
      chain.push(c.mapping[id])
      id = c.mapping[id].parent
    }
    chain.reverse()

    const messages = []
    for (const node of chain) {
      const m = node?.message
      const role = m?.author?.role
      if (role !== 'user' && role !== 'assistant') continue          // skips system + tool nodes
      if (m?.metadata?.is_visually_hidden_from_conversation) continue
      const text = chatGPTText(m)
      if (!text) continue
      messages.push(role === 'user'
        ? { role: 'user', text }
        : { role: 'assistant', parts: [{ type: 'text', text }] })
    }
    if (!messages.length) continue

    const stamp = t => (typeof t === 'number' && t > 0) ? new Date(t * 1000).toISOString() : null
    out.push({
      title: String(c.title || 'ChatGPT chat').slice(0, 200),
      messages,
      createdAt: stamp(c.create_time),
      updatedAt: stamp(c.update_time) || stamp(c.create_time)
    })
  }
  return out.length ? out : null
}

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
  const incoming = Array.isArray(body.chats) ? body.chats
    : (body.messages ? [body]
    : (looksLikeChatGPT(body) ? fromChatGPT(body) : null))
  if (!incoming) return res.status(400).json({ error: 'That file does not look like a Radiant or ChatGPT chat export.' })

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
  const taken = new Set(listProjects().map(x => x.name))
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
  if (added) saveProject(project)
  res.json({ ok: true, added, skipped, project: added ? project.name : null })
})

// ── where the data lives ────────────────────────────────────────────────────
// Radiant has no account and no server of ours. "Sync across devices" is
// therefore a folder question, not an identity question: put the data
// directory somewhere your other Macs already see.
// ⚠️ SAY WHEN A SECOND MAC IS ON THIS FOLDER. Settings has always warned that
// "two copies of Radiant writing to the same folder at once will overwrite each
// other" — in a hint, inside a collapsed section, which nobody reads before it
// matters. Nothing detected it, so the first sign was work quietly going
// missing. This notices, and deliberately does NOT block: refusing to start
// would lock someone out of their own chats over a lock that a crash or a slow
// iCloud sync could get wrong, and "you cannot reach your work" is a worse
// outcome than the race it prevents.
let sharing = null
function refreshLock (first) {
  if (first) { const swept = sweepLegacyLocks(RADIANT_DIR); if (swept) console.log(`[radiant] cleared ${swept} old iCloud lock file(s)`) }
  const r = first ? claimLock(RADIANT_DIR, { host: LOCK_HOST }) : beatLock(RADIANT_DIR, { host: LOCK_HOST })
  const was = sharing?.host || null
  sharing = r.contested ? r.holder : null
  if (sharing && sharing.host !== was) console.log(`[radiant] ${describeHolder(sharing, LOCK_HOST)}`)
  return sharing
}
refreshLock(true)
const lockBeat = setInterval(() => refreshLock(false), BEAT_MS)
lockBeat.unref?.()
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { releaseLock(RADIANT_DIR, LOCK_HOST) } catch {} ; if (sig !== 'exit') process.exit(0) })
}

app.get('/api/data-dir', (req, res) => res.json({ ...dataDirStatus(), sharing, sharingText: describeHolder(sharing, LOCK_HOST) }))

// The current branch's PR + CI, for the row above the composer. Read-only; hides
// itself when there is nothing to show. cwd comes from the chat's workspace.
app.get('/api/pr', async (req, res) => {
  try { res.json(await prStatus(req.query.cwd || null)) } catch (e) { res.json({ show: false, reason: 'error' }) }
})

// Repair an iCloud folder macOS never adopted. See repairCloudFolder — the old
// folder is kept, and any doubt rolls the whole thing back.
app.post('/api/data-dir/repair', (req, res) => {
  const out = repairCloudFolder(RADIANT_DIR)
  if (!out.ok) return res.status(400).json(out)
  res.json({ ...out, needsRestart: true, ...dataDirStatus() })
})

app.post('/api/data-dir', (req, res) => {
  const reset = req.body?.reset === true
  const dest = reset ? defaultDataDir() : String(req.body?.path || '').trim()
  const mode = String(req.body?.mode || 'auto')   // auto | adopt | replace
  if (!dest) return res.status(400).json({ error: 'path required' })
  if (!path.isAbsolute(dest)) return res.status(400).json({ error: 'needs an absolute path' })

  // ⚠️ DO NOT ADOPT AN iCLOUD FOLDER THAT iCLOUD IS NOT RUNNING. Radiant offered
  // iCloud on every Mac without checking, on the reasoning that detection had
  // been wrong before and should not gate the feature. The cost of that showed
  // up on Tony's dev Mac: he ticked the box, Radiant wrote into a CloudDocs
  // directory that macOS was not syncing, and it silently shared with nobody for
  // a day. Warning after the fact is too late — refuse at the moment of choosing,
  // while the user is still here to do something about it.
  //
  // Scoped deliberately to iCloud. Ubiquity is an iCloud concept: a Dropbox,
  // Google Drive, or external-disk folder is correctly "not ubiquitous" and must
  // still be allowed.
  if (!reset) {
    const cloudDocs = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
    if (dest === cloudDocs || dest.startsWith(cloudDocs + path.sep)) {
      const root = cloudStatus(cloudDocs)
      if (root && root.exists && !root.ubiquitous) {
        return res.status(409).json({
          error: 'iCloud Drive is not syncing on this Mac, so a folder inside it would share with nobody. ' +
                 'Check System Settings → your name → iCloud → iCloud Drive and make sure your other iCloud files appear in Finder, then try again. ' +
                 'You can also pick a Dropbox, Google Drive, or other synced folder instead.',
          icloudDead: true
        })
      }
    }
  }
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
  //
  // ⚠️ ALL OF THAT IS ABOUT A MAC, AND ONLY HOLDS ON ONE. "A Mac's iCloud Drive
  // is ALWAYS at this path" is the whole argument for offering it unverified,
  // and off a Mac the premise is simply false — there is no iCloud Drive to
  // create, so setDataDir could not produce the real answer that makes offering
  // it safe. Offering it anywhere else is the failure this reasoning rejects,
  // not an instance of it: an option that cannot work, presented as if it could.
  if (IS_MAC) {
    const CLOUD_DOCS = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
    push('iCloud Drive', CLOUD_DOCS)
  }

  addIfPresent('Dropbox', path.join(home, 'Dropbox'))
  // Linux keeps synced folders straight in $HOME; there is no CloudStorage
  // indirection, so these are the same clients under the names they install as.
  if (!IS_MAC) {
    addIfPresent('OneDrive', path.join(home, 'OneDrive'))
    addIfPresent('Nextcloud', path.join(home, 'Nextcloud'))
    addIfPresent('Google Drive', path.join(home, 'GoogleDrive'))
  }
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
app.get('/api/projects', (req, res) => res.json(listProjects()))

app.post('/api/projects', (req, res) => {
  const name = String(req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name required' })
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
  saveProject(project)
  res.json(project)
})

app.patch('/api/projects/:id', (req, res) => {
  const p = getProject(req.params.id)
  if (!p) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'cwd', 'hue', 'model', 'provider', 'agentId']) {
    if (k in req.body) p[k] = req.body[k]
  }
  saveProject(p)
  res.json(p)
})

app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id
  deleteProject(id)
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
  const a = agentsStore.get(req.params.id)
  // A built-in is seeded on every load, so removing one means recording that you
  // removed it. Refusing outright was the old answer, and it left fourteen
  // agents in the menu that nobody could clear.
  if (a && a.builtin) {
    if (!Array.isArray(config.removedAgents)) config.removedAgents = []
    if (!config.removedAgents.includes(a.id)) config.removedAgents.push(a.id)
  }
  agentsStore.remove(req.params.id)
  saveConfig(config)
  res.json(publicConfig(config))
})

// Putting one back. The library lists every built-in that has been removed, so
// this is not a one-way door — the whole point of recording the removal.
app.post('/api/agents/restore/:id', (req, res) => {
  const id = req.params.id
  // ⚠️ AGENTS LIVE IN THEIR OWN FILES. Clearing the removal record is not enough
  // — nothing re-seeds the store, so the agent has to be written back from its
  // original definition. The first version of this only edited the record and
  // silently restored nothing.
  const def = builtinAgent(id)
  if (!def) return res.status(404).json({ error: 'not a built-in agent' })
  agentsStore.save(def)
  config.removedAgents = (config.removedAgents || []).filter(x => x !== id)
  // ⚠️ SAY THAT THIS IS A RESTORE. saveConfig now unions tombstones with what is
  // on disk so a stale writer cannot resurrect a deleted agent; without
  // `forgetting`, that union would immediately put this id straight back and the
  // restore would appear to do nothing.
  saveConfig(config, { forgetting: [id] })
  res.json(publicConfig(config))
})

// ---------- connected agents (import from Hermes / OpenClaw on this Mac) ----------
const HERMES_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAZIklEQVR4nOVdDbQV1XX+vJcHLyglsiAoecKSogQkEIJRKVZjEUuCWuJPtVoT82NtKAY1WqIlsSZWm+pCLJQVNRKi1VKNjVVpLIn1DzWysJSXFw2RYFSqEBE16Av6fO907fTbWTsnZ+bOzJ2ZOw+/te667747d+bMnH322f97L+cc+jnqAGoA+gD0Br4fA2A8gKkApgCYAGB/ACMbnPclANsBbADwBIBHAWwC0JPi2pXHXv2UAPTB28kQDAbwYQAfBTCdE/7+HK+7nYSwGsD9AJ7zxoT+Rgj9iQBCky7/OwLA8ZzwAwEM4oqU794GsAvACADDCxjTIwBWAbgHwAvm/20B4qwk+gMB+CtLHu4xAE4FcBgn+MdclT8CsDXw8AeSAIRADgcwE8BxAAbkOE65/nUAvu+NvdIcocoEIA/PcTWDk/ennDj57jE+9CcB7I45T9RqHAbgdAAXABiX47h/CuAKALeY6/ea+6gUqkgA/oTJap8H4BR+3sFV3w5gCIB9+H95wJv56gLwAIAHDXHIeRW+0HYWgKsTCIZp8BMA8ykrhO6rGhACqMirzft8lnOu0zWHnc65Zc65yRHXaTN/D3TOLXb543bn3IiIe2z5q+UDcM7V+bIT/0wBE3Gnc26sd10EJuZE59zunK/d7Zw7PeLaLX21eguwbFH246/lvB+H8GXu0SG2rJ/FdvDflBPyxA0AzvWu1VK0igDszYuBZimAGSVe/4cATgbwYmAiBlJ97KCA+b6cry3nnEObQsuJoBUEoDctRptrAHwercFbAE4EsCaGE4ygMJc3J3gVwGSqrC0lAjGslK3P93AFPNvCyQcNRv8JYAHHZLUE/fwyrYmieeSJfQF0ApgUuPYeyQGUyuX9RgCfQrVwPo04UZxgEo1MeUPU0YMAbGkVJ6iVtPJ7aLXbVMHJFyyJ4QQDaVc4E8U8/ycob/QYLrlHEIA14c7njYo1r6pYAuCcABG8zc+3AVhWwHXFRL3OPKvanrAFWBv4CgCfRv/B4ZyQKJb8FF3KeeJXANYDOKps/0ER1Ka273au+v40+aB/oT0w+crR/gz5YxGAoQCu4rNr668EoKumg4KN7PtVxKtGqHsLwEmGDQtL/g7/tnuyTsxGGnTyRDudXF8ymkG9vxGAnfyNjLqpMv4cwD8CmAjguwCONOreHNoIer2JUK7wRbLtZmC1iu10cAlu57vrTwRQN4aTjQUYTrLgjYiVuowhYp2U/IVTCRbSMKX4J773Bghdzn15k+OTAJJ/4N/i0exmGNoECs19pWwFOTgUauZ9g6sW5jjnbvX+d5RxAA3k32P43WPOuZvMsQsDziL7ejbDmFY55yYZD+U451yHc26Qc24Xj3nTOTekDGdQXt48eV+dcZIed871umKwlGN7jZ+v9ya0zvep5jc3042sXrz2wD3r7+cHrrm5gRv7mAiv4FDvuOUNiC+XVy0nif8iAB/nvvjtFL//MaNui9J9xxlLH8jyBXt57PUVCoMq5cu4BO8xhivfQATe6y+9a4on8TwA/xsxptcC54OJIFJ83hiIikMOK/8gUqys4rnOuS0pVqj4yF+I+V788mtdNqxxzq0345UYg+si7mV5YBXLlnayc+7liN/oylxGTnGFc+5+59wmco1hzrlznXMXMRahk1tS6FyX8Hc+FhfNBZoxBKnBYi1duVMoGM1N+PsVDJe6NeYYCenayb+vBfAhAAdQiBtDlSkU2LmDx4hA9TgFqo8B+A+u2jrHPYYSfS1wnk9yVYr5+lIAd0YYacbT3nEe3cti0Hmd3KeT9yiS/b8BeJNhbNfQwngXYwifB/CLgOv5DWpT8l4Mmlz9s0mpsofOcs497Jw7zTm3xDm3nSsjhB7n3N4UGmVf3hZxnKyglc65GyPGYUO4NvH4u51z4yPGKxwhDV6jYHZHxErUzyLHKF50zs3k/+U5OMMhrzfHbub5T20whvlFcoFmJX9h95fy7/u9Y+QhWOz2WP9EClsgy1zECermQ7yF3y3iZ/l7MI/dm59P5nn1gfuTXudY2zyCTYsesvSobUDux8c859zXYwTcbo59fQT7VzzlPfOWE4De9DzeBLjPnc+/h5jYvotJ9T2GAFQyXxUh6Q73rifXcYFVDU7KdvO5nedqi4m7SyOjWJwWsxKH8R5DUI0iBFX7XnfxmO5xstxeWRIjdA+8nDZsDd2WECsYi5ZKtTcxRFv24W8B+FdKwCfS/AlP0t1Bg9Ishm5J8AS4z34TwDN00TqGgO/mOK4K5AecSYOLGFjO4H6+NaNX8niO3Ucb5ZQHOGYfOv4QNKT99xpcex5lmVrujqKUFKMUeBwps5377iXmmFmGXY4m+36vc24GZYRvOOcO4+9Fwp/GfXAJ93Q5RtEbs7L8FdbN/X8GjT2iBTxNOWMmj8uqUTiP0yS1CeSF3ogtqPQtQG9WJ2kJDUDTSRxTOOGDedwVPEYGb/c0Yf9lQuQTFyOUJsVhZiHU+K7WRLHuFYl5MVtQKWqgqkCi7v2PiXCdRvbeTafG7wM4gWrNHYy9a6uIf6BZnEdfQlSswIsFOsHkWR9q0tFzQRoZQPefz/HzO9Rp9bt9zJ4m2bJ7Io4mAajX8wDq+5Mo+3QWSADTeJ2uPING0hCAUvwn+C5UeDDeXZjM/MH7aJTyUUTgqMVJJIDchMGkNnj1ic8wBRdEEn+3YSTdxqHJByenSEj2FPLUBGopj1NV792KoeSEIdPsdxKoc81iArcBLYBRGgEoxR2L1uGtAhI0smA2gAsZJawQ2/9oRhKVcX3k5UFNepI+xsodgtZhECXhKsgBN9CRZDnD2JKuLwa03ELGkhCAspqxZcesB7CtIlwAgWRWYf//TgFRNKQiw9aH5nWNWopjxO3ZaoyiC7XVeDTwPxGK/4RBpl0mwCRvDOQ1kIcckGZFV4EAjqmAjWEHDTJRGE0tQbasKPTlxH2a5shpTlB04Yakdou3U4ad5Y3hDSY3CZolACmJlwvSEICYeqsAieu7DP0bA5qM8lEC6CmDAFQFrIrVbzbHJK7h/owdTfx2/7wSbdNoAc1mwuSJhfSR92cMavL3Y/MQBNNsAbYUal6QQMksmE/2J4Gb/dmsvKOJ3x+ahyBYS5nAmDfGmPSotLiHamF/Rc1EPGdBLom3aQjg5yjGxbnOy8lLE6L19xFhWnGoUsnWthw4QE9ZBCAZPEVgMYCLIxI534lgk99kNu9e9JD9bYrraep3FbBfE7LVaMZOFh4PoBSm+fN5YzQDNs9lssbZrMN/B8uxf9+Uev871hTcTiFoOtno5SzsOMoEjEat/jsY0XQUt6CDcq4angbvYbW0rBL9OFYyyx4gkjB2TGPS4+LX02AnAzg/wzhCjSH0X1fy+OeYfCLHd3nnkqDRBxhYmiV2fkhEXH9Z2NrEb5tOGkkbDCrp0nlEuJ4aE3WsAZftDD69jN8tThi5O43Ht3t5AvrS+6l7137FtQbbmghWXVEWAehrcBOD7WSKl2N6lE5SVLKDXc2fTXEdSfw4wSPeOM4wgO8+ZykLvQ0SZOOwLvCsUr1qKSXW7oyVMa6lH/0cCm17A/gKEzmi9i4b9bIxwgMXguynd1OeOIwyTJzk38f3Vrm6a02Y2afQNZxZs0lz0yoMft2EhadVWcZxsLeTkCTjNs6apXXz1hudfxmFwyQes0eZhXx2geVWHmGg7AcoUP5BhiJS7S1zDadkGcquR0bsmZqAEYJkD91nPn+P+9+nEuxjbczv38jPz8Sw03MDwuoWU5LF33JqfJeElbRYzm1MMo+u5ufTeI1xrC2QBLso6GbBRc3IAVn2DX2AHYHER8l0vSrhwF9j4uiahPvYMNbyAR92CGv5/T4mGXVbRJkXeNfNIgO8FfPdYwnS2iwkjS0L7myGALLse1ovbyv3dS2nopa9TTHm3XeM+VP2rr9gkMeIBPvYYJOIIoUeQhD7gOCvjLPlbMoaUVtAnzl/WsSFxk9PaV9wLXENZ5UePYq72suD7yAr9vEA08MtXk6Y9tzBpFSY9HOLVVz5X+HnZ00uXxLu0mq8EFMooxEOzDqPzUi+tprlxcaxs4Np24+wLIsv7PgxfesalEetm2DI+VzlK7iqL6Uv4H5+fpXC5Q/ZPXQdf9+Iu/RWwEfQ0YRzSB1DbWVygChu0MbGS2rssZxhg6nJpzg9wR5mV/AVRsjrNvKE7Pl3OecWBOSVJNylChC9PgsyF5PKs1p4zVQMVUymDm+xl6nP/7MUsYZ+B1HtGziC1T5tcYiktvE6jzuMBShajZ8yTkDkozTopE0gdeZwnsaPPjP5yorE4OPjFq9TWFIdttfU7q1zwl9m+fbd5n60dmGa+x+DamAMU8zTYjI9i6m3saK8YDqQ4RFFmsEy8usztErxJ9eu9r6Me/nBqAYGBQpPJsUhTJxJ5Rksyvyp5w2lS+2kL39lTn1y8siU/QCqg+EZiVjc26nntGz7t9i8P0wTbct75qF6Ec9gJZUs24DYUwSuSgQgTSEtdjDYw06+7umtQB/HIjb8qmBfCspZ5ID2tDmDZXOA0WRVtjGTCnet8saNalDKrb+EjA812duJF1StYNY61lv91zAkCySCwxndeyRXYysaWU5B9ZC1oJZuA4mfY9EP3GoBb9Bi+Dgtd6DuLZm03yP7KtMaV+N7K2se5D0vM8u6UCP0cULFqKHQ6Ne51NvVJHxJBsdJnvgIqoks+f/TIzqetYQDDI5gZXWWUhljGjh0FVoSPX6bOgTVRE9GOUBqCCWWA4ogAL3wfhH/13dJ8T6lwKyjJFxqaImlXcrKHUxlDyiSA/iS9Vg+cMnv163gzpLGElf2ZgCqiazPY24ae0ARD13P6evWA4zj50RW3dTWbLuNTl4GIdQqrAE0i8PpJEskQxT5sIdHDE7tAWDL9nGUCUaaCN6yWqcegj0PA00JmXorCSBUU0g6i2l/Xu2M9TBTw54mQYzyvIpFWAmdR5B7Go5LOr9FEkAocfFoagfPsnmEVrs4ljLDF1iHYJFRZ4ropP0OCWs89kxoMcneVrSP16CErggWK335VlFdiSuu/At24ZDzXJF3mXSGYL2APRdjudBK5wCa0RNlzvwM39tMFEwfV/+hfN3GFmqnZYiOSaMBpEWr4wZ9qEYVgpb1bWvFFjA0pm7+LHquNtA6uJCm4KUsBfskAz0/zYgiMR/n+fBrpvByGqgvo0rYyLC6ODkAZRKAri5rAg5BGjyB0b3X8ybuYgtaMLdvJeMHinIVT0l5/F0llINPi309W4q/0BqahYviAL4VMKQNTGGY938Z4e+fAzECRQiBWbaAFU3W9CnqHu5pxiycpmFEmrrCSSJ9v2aEwuPZj2eb6YZR1MT3ZNgCfkUvpmYeVQU1NqOWKiohfNQcF3mCRtAgwzT++iQhVidQFrB2gSRJHHlgGLWApPgu3zU1rUoYx+0yk3u4lnDyJ6YM2kiqX0uqt3UGFbXq4bHCUSm3v9v4LhlPVcPImG1geqPYy1qCyd+PgRtqMIiLV9MJTJrs8YcUVnaXHBeYpvD1GyaARX0WVTP97mIH8pAcoD6ZeloC0An/AaNUNZI3bpX20dIn7dSSQjWC3C1SMfervoik0r8mnrxcYB+ArFA9X4k0Km9QM7cSEUAbJ/MMWvOSVPPUkx9g+gcmgaSUn1WyEyhNHsDt5v6WsLRbFSFl8kJQa2yw1VwUAfR4q1NNtknYX5YY+6sCeYVFYkgK48899FZuMRFMVYJOqtRliKsfsLdp9h1LALqS55BV9rEYhL1YCHquuG4aUXg/YwPTRgepvaDNvOLQm1IFXE8J+96U20aZ0PmSfIsQDuAxOzk3Ys+APqtQNIyyCo0sSSv0ZHWxXk4n0eYGE9lnJtJ/VzTKjxuS0qtWZahmsjNCS+ugMLiTZvef0HooqndbiAP0eqbSASZ7Nk5S12SPIzLeSI3Glqk8V9Sr1+jykxldtIArdSFvNq7ghL3HtNiasi5xGRDBNE6Iluf6XrNN/IwE8Gv1MMQB+gL2/PGcnKietbripjbpvRtOYeY+SrXdRo/d39T2Hcm/QwS8gET4fM75h1cD+Gue8ysVaKGn0O15ZMyYRlKGUT/LBQDO//U9RVSOGOFV9rivQQUK/b9U/aoCXmHVD79KSJaScA865yZ495tXzeRm0cP6RjKmuTHH2cqpWrtJytLVoyjmTe/zH3NL6AlUxlLpfT9W/aoChtGt3B6Rd5jU6PQ3tKc/7QmZD6Ia2GIcVH4ibpTjS+4FFGr/KEQANbJXZS2KfzFBCOocssLWTagW3seIIrut6cT79xaCdAG90sQl2oRWqUpSBehkNvL/223bbomfCBGAY+CDv0om0B8+1TiHVNi62QR8VglHsCEFPKEwSe+DGbRqajW0OmWSMSF9ukXoMraXLML39CgCGEbXbMiqJELaM7x4J1mQWPLi8HwLXakXGM1CiUBcqEkE0i8brqeq8aaIkPdW4CG+Z22eNcHXAjTwsp36pZhp8+giupRSdKtwI40g3XQ+Sa+hJPgSn8FztG98ENWBRDY/RqJuZKG0thzL2Qf5BKD++G0M674vB2PIpU3ku+eFafRryN6/JuVvZ6GaeIjC+lUJfC/CqRW/FakdlRfXxfi8U5okgBu4+sVd2Wrcij0Ly2jlEy7VCL1RsZC1CFahrsWPM1QrC77NRlAS9FnVB/gO+ie6mVGlWk4jvBDIHg4SQK+Rkt9mDH9PymbNfSQaqdJ9Mllv1fBJjnE1+ifuot8kiSwmCTYv8e8xv5OsE2PVW+3V853WwIK2m5XAtab/+ASWrM2ufMw09zrR9U9oL4QkeNjcr9/067U4X8BSo9uLEeirlIIncVV3MDysl1vGauOYmBkTr64Qp8TrKBfHcqzaW/ApcrcsfZD6S/GIdYbb+w23f9SoOvdan2Kcc/Ma9OC7PCFlLnHOvejKw1yOcWDgPle4PRezeI/Sc9HHoqjkULUHjKIO7HOKPnoHH6SBZxD17DkJw8HeoIFG9PMyIB1EljfwDi5MYR/oL3idPprdnEc/qOVDSXoAHFMAVX5OqM8VC2nEdAf3+Ua9A+p8PzHl/lp1LOV9XRjRx7FhwwglgqMCDaKyoovnle2kCMjWMtY5NzSioUWjex1FF/CegHFs9tkT1XYWKR7MMHbkaBYyoDNccdjujT1p1xB4hLIgRdu3KmI170O6svl4k/2VUvcOVjaZJSBCVvwMnqOo1a+4NcXKR2A70DZzHU20yk2CbraL6yrgOsLJTo747rP6fNI+GLuajmMH8EYD72ZDxf34u5WuHByZYO9HA0JPoqXsZMcy0bddxt6D93Ofns0ObCK/NIPFMZ3Q1loNKEuJGD/itsZ2shfR6rSK9oBdDFhYb6JWLk6YZJIHfs4+wklQ532ohrCYWorFL+kK/ojRr7/Ke5N7Pylw3ieNz34Dn9uz9LZ20El1tJHOO6mNrKHOLraYtHiJtppOhtv7GEP3/P/PYwYWaTnCQM/q9xYFRv/YvZ1zV7rycVmDraDufTczwjq5hC1ue9mGdjaPF0EqhIUmJjHJaxRbwCoeZnteWcVbU97znIh931pBf3PPzRCAfQ322NbjbO82n4GiRe/5SZoq1mK2s1ERxqAu/l62E8e2uPqbkKawgZK3T2D2pdfWz/Y5jvRax2lLPWnJmwTXxUy+GvB+65p5TL6e8BsuO1YWqH/fbcbpT/wU7t8+XqTlTLmCrPpDzSRJl08fK7xn0qhbqX3VDDete9rW4oSRzLuoAcVZQX+HE+bFAUB2lUV4WUxKLxJTvbGKAHtP4Lgesu8hZvI7zYNrZwdzHwu9VZ/1GdrfrvCI+ECqb2kghDspavLzJAA9+ZEpV7KumntdsbiZ15kd8G/YsaimAloQu0zcve8hVSzIYeJ9IqgFNKZ7addPiuVmXiLV4Tw5gF6kgy3NG6lOZ/H44V4SShHojpn4zcY+Ye9jsxH25HVe4LcXNXrAGV92+xB5SnE1JzYOaz2OF0uYeVcKtSriRDqHPug5gR6i61gbRMzPqO7kgWsBXMi/Nf5/N8PHXqcqJmrTOVTPrFPsWwyYKar9nT7LOhNARhtV+rKA0+1RurW1YFSyceVMuUpxSdihrhpJUSoD3UZCfjiwStqMAWiL+e6WwLlWBlZqUc8S1CwU2wOCqy+DJN6Oih68rwKpJK4Sr2wDRcDfgnZRiFrM3DifCNvM9tVr9GX74BXCkot8blELxT6rB42D54ksE18GASR5pTVyJMEiCm8hs3BolbQZW4AIsD8wx4ktw2JjYHWWSQS3GzX1mUYqXpJXK1KcNbl0aYSpshlcx1R2G/j4MQBrTVaQ7q29Zp/sYN3dQaxRrLABra+a/LtUDZpzgIbp/SWLVo7keGzVtkzVy8omgDZGG59B4S9PPMk6ONqdXPBFJrdYgUgnrm4mfwPTvW4xIdTjPV/CbEY/pWlPnxd6SZw7mYRr6zQc3NRclsjG6sYI0wyeo59+pTE8yefbvOOWJ2CN7c65581vppjvzgycS93ErXjVjX1CTM6n0b8ysRmBtOzBS2h5VojQc4Fz7gsUgmzYuW+aXeNd13/VAgaotd4ki11dMb3B+frt6/8AmIwforUvVg8AAAAASUVORK5CYII='
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
    // ⚠️ 1 IS AMBIGUOUS AND THE GUESS WAS WRONG. Treating <=1 as a fraction turns
    // a genuine 1% into 100% — reporting someone as out of quota when they have
    // barely started. Anthropic sends whole percentages (19.0, 90.0), so only
    // treat a value below 1 as a fraction.
    else if (typeof w.utilization === 'number') pct = w.utilization < 1 ? w.utilization * 100 : w.utilization
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
// ⚠️ THE PREVIEW PANE READS FILES; IT DOES NOT BROWSE THE DISK. A file the
// agent wrote (or one the user typed into the address field) is served for
// the right panel's Preview tab, read-only, with a content type from its
// extension. Only files under the user's home or a session's working folder,
// never dotfiles, never anything outside — this endpoint is reachable from a
// paired phone, and a path is attacker-shaped input.
app.get('/api/preview', (req, res) => {
  const p = path.resolve(String(req.query.path || '').replace(/^~(?=\/|$)/, os.homedir()))
  const roots = [os.homedir(), os.tmpdir(), '/tmp', ...listSessions().map(s => s.cwd).filter(Boolean)].map(r => path.resolve(r))
  const inside = roots.some(r => p === r || p.startsWith(r + path.sep))
  if (!p || !inside || p.split(path.sep).some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) return res.status(403).json({ error: 'not previewable' })
  let st
  try { st = fs.statSync(p) } catch { return res.status(404).json({ error: 'no such file' }) }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' })
  if (st.size > 32 * 1024 * 1024) return res.status(413).json({ error: 'too large to preview' })
  const types = { html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', json: 'application/json', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', csv: 'text/plain' }
  const ext = path.extname(p).slice(1).toLowerCase()
  res.setHeader('content-type', (types[ext] || 'text/plain') + '; charset=utf-8')
  res.setHeader('last-modified', st.mtime.toUTCString())
  res.setHeader('etag', `"${st.size}-${Math.floor(st.mtimeMs)}"`)
  res.setHeader('cache-control', 'no-store')
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(p).pipe(res)
})

app.post('/api/open', (req, res) => {
  const p = String(req.body?.path || '')
  if (!p || !fs.existsSync(p)) return res.status(400).json({ error: 'no such file' })
  try { spawn(openCommand(), [p], { detached: true, stdio: 'ignore' }).unref(); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---------- recipes (parameterized task templates) ----------
app.post('/api/recipes', (req, res) => {
  const { name, desc, template, params } = req.body
  if (!name || !template) return res.status(400).json({ error: 'name and template required' })
  recipesStore.save({ id: 'rec-' + crypto.randomBytes(4).toString('hex'), name, desc: desc || '', template, params: Array.isArray(params) ? params : [] })
  saveConfig(config)
  res.json(publicConfig(config))
})
app.patch('/api/recipes/:id', (req, res) => {
  const r = recipesStore.get(req.params.id)
  if (!r) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'desc', 'template', 'params']) if (k in req.body) r[k] = req.body[k]
  recipesStore.save(r)
  res.json(publicConfig(config))
})
app.delete('/api/recipes/:id', (req, res) => {
  recipesStore.remove(req.params.id)
  res.json(publicConfig(config))
})

// ---------- memory ----------
app.get('/api/memory', (req, res) => res.json({ facts: listFacts() }))
app.post('/api/memory', async (req, res) => { await addFactManual(String(req.body?.text || '')); res.json({ facts: listFacts() }) })
app.delete('/api/memory/:id', (req, res) => { deleteFact(req.params.id); res.json({ facts: listFacts() }) })
app.post('/api/memory/clear', (req, res) => { clearFacts(); res.json({ facts: [] }) })

// ---------- skills ----------
app.post('/api/skills', (req, res) => {
  const { name, description, content } = req.body
  if (!name || !content) return res.status(400).json({ error: 'name and content required' })
  skillsStore.save({ id: 'sk-' + crypto.randomBytes(4).toString('hex'), name, description: description || '', content, enabled: true })
  saveConfig(config)
  res.json(publicConfig(config))
})

app.patch('/api/skills/:id', (req, res) => {
  const sk = skillsStore.get(req.params.id)
  if (!sk) return res.status(404).json({ error: 'not found' })
  for (const k of ['name', 'description', 'content', 'enabled', 'category']) {
    if (k in req.body) sk[k] = req.body[k]
  }
  skillsStore.save(sk)
  res.json(publicConfig(config))
})

app.delete('/api/skills/:id', (req, res) => {
  const id = req.params.id
  skillsStore.remove(id)
  // seeded skills get re-merged on load; remember the deletion so they stay gone
  if (id.startsWith('seed-')) {
    config.removedSkills = config.removedSkills || []
    if (!config.removedSkills.includes(id)) config.removedSkills.push(id)
  }
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- skill library ----------
//
// A shelf of ready-made skills that ship inside the app. Nothing here is active
// until it is added, and the whole text is readable first — see the preview
// route. Origin ECC (github.com/affaan-m/ecc), MIT, curated down to the ones
// that fit a Mac coding harness.

const librarySummary = () => skillLibrary((config.skills || []).map(s => s.dir).filter(Boolean))

app.get('/api/skill-library', (req, res) => res.json({ skills: librarySummary() }))

// Full text, so the user reads a skill before it can influence a single reply.
app.get('/api/skill-library/:dir', (req, res) => {
  const abs = resolveSkillDir(req.params.dir)
  if (!abs) return res.status(404).json({ error: 'not found' })
  const row = librarySummary().find(r => r.dir === req.params.dir) || { dir: req.params.dir }
  res.json({ ...row, ...inspectSkillFolder(abs) })
})

app.post('/api/skill-library/:dir', (req, res) => {
  const dir = req.params.dir
  const abs = resolveSkillDir(dir)
  if (!abs) return res.status(404).json({ error: 'not found' })
  if ((config.skills || []).some(s => s.dir === dir)) return res.json(publicConfig(config))
  const row = librarySummary().find(r => r.dir === dir)
  // The same refusal as an imported folder. The bundled set has no executable
  // files, and this is what keeps that true rather than assumed.
  const { executables } = inspectSkillFolder(abs)
  if (executables.length) return res.status(400).json({ error: 'executable_files', files: executables.map(f => f.name) })
  skillsStore.save({
    id: 'sk-' + crypto.randomBytes(4).toString('hex'),
    name: row?.title || dir,
    description: row?.blurb || '',
    dir,
    content: `When the user's task matches this skill, read SKILL.md in this skill's folder and follow it. For other tasks, ignore this skill.`,
    enabled: false,
    origin: row?.origin || null
  })
  saveConfig(config)
  res.json(publicConfig(config))
})

// Import a skill folder from disk. Refuses anything runnable, by name, so the
// answer is never "something in there looked wrong".
app.post('/api/skills/import-folder', (req, res) => {
  const src = String(req.body?.path || '')
  if (!src || !path.isAbsolute(src)) return res.status(400).json({ error: 'absolute path required' })
  let st
  try { st = fs.statSync(src) } catch { return res.status(400).json({ error: 'not_found' }) }
  if (!st.isDirectory()) return res.status(400).json({ error: 'not_a_folder' })
  const found = inspectSkillFolder(src)
  if (!found.doc) return res.status(400).json({ error: 'no_skill_md' })
  if (found.executables.length) return res.status(400).json({ error: 'executable_files', files: found.executables.map(f => f.name) })
  const base = path.basename(src).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!base || !/^[a-z0-9][a-z0-9._-]*$/.test(base)) return res.status(400).json({ error: 'bad_name' })
  let dir = base
  for (let n = 2; resolveSkillDir(dir) && n < 100; n++) dir = `${base}-${n}`
  const dest = path.join(USER_SKILLS_ROOT, dir)
  try {
    fs.mkdirSync(USER_SKILLS_ROOT, { recursive: true })
    // Copy only what was inspected — never the whole tree, or a file that
    // passed no check would ride in beside the ones that did.
    fs.mkdirSync(dest, { recursive: true })
    fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dest, 'SKILL.md'))
    for (const f of found.files) {
      if (f.dir) continue
      fs.copyFileSync(path.join(src, f.name), path.join(dest, f.name))
    }
  } catch (e) { return res.status(500).json({ error: 'copy_failed', detail: String(e.message || e) }) }
  const meta = /^---\n([\s\S]*?)\n---/.exec(found.doc)
  const field = k => (meta && new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(meta[1]) || [])[1]?.trim().replace(/^["']|["']$/g, '') || ''
  skillsStore.save({
    id: 'sk-' + crypto.randomBytes(4).toString('hex'),
    name: field('name') || base.replace(/[-_]/g, ' '),
    description: field('description').slice(0, 300),
    dir,
    content: `When the user's task matches this skill, read SKILL.md in this skill's folder and follow it. For other tasks, ignore this skill.`,
    enabled: false
  })
  saveConfig(config)
  res.json(publicConfig(config))
})

// ---------- suggested skills (from skillsmith) ----------
app.post('/api/skill-suggestions/:id/accept', (req, res) => {
  const sug = (config.skillSuggestions || []).find(s => s.id === req.params.id)
  if (!sug) return res.status(404).json({ error: 'not found' })
  skillsStore.save({ id: 'sk-' + crypto.randomBytes(4).toString('hex'), name: sug.name, description: sug.description || '', content: sug.content, enabled: true, fromSuggestion: true })
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
    // Jev Router leads OpenRouter's list: it picks the model for each message,
    // so it is the one to try first, not one of 400 to scroll past.
    models.sort((a, b) => (b.id === JEV_ROUTER) - (a.id === JEV_ROUTER) || a.id.localeCompare(b.id))
    return models.map(m => ({ ...m, provider: p.id, providerName: p.name }))
  }))
  res.json(results.flat())
})

// ---------- local models (Ollama) ----------
const OLLAMA = 'http://127.0.0.1:11434'

// ---------- the Chrome the agent drives ----------
//
// ⚠️ CHROME 136+ SILENTLY IGNORES --remote-debugging-port ON THE DEFAULT PROFILE.
// Not an error, not a warning: the flag is accepted and discarded. The first
// version of this quit Tony's Chrome and relaunched it with the flag on his normal
// profile — `ps` confirmed the flag was there and nothing was ever listening.
// "i clicked the Quit Chrome button. it quit chrome but this message did not
// change. even when i restarted radiant."
//
// A dedicated --user-data-dir is the only way to get a debuggable Chrome, and it
// has a happy consequence: a distinct profile means a SEPARATE instance, so his
// own Chrome never has to close. He signs into this one once and it persists.
// ⚠️ RESOLVED ON EVERY CALL, NOT ONCE AT IMPORT. A constant read at module load
// answers "not installed" forever to a user who installs Chrome while Radiant is
// open, and the only way back is to quit the app — which is rule 12: a state the
// user cannot act on. chromeBinary() also returns null rather than a path that
// does not exist, so `installed` below is an answer and not a guess.
const chromeApp = () => chromeBinary()
const chromeProfile = () => path.join(RADIANT_DIR, 'chrome')

// Dictation. A GET so it can be an EventSource, which reconnects on its own and,
// more importantly, tells the server the moment the page goes away — that is what
// releases the microphone.
app.get('/api/dictate', async (req, res) => {
  const { startDictation } = await import('./dictate.js')
  startDictation(req, res, String(req.query.locale || 'en-US'))
})

// The spoken conversation, saved into the chat when the call ends: rows of
// who said what, and the minutes. Role "voice"; the model reads it as text.
app.post('/api/sessions/:id/voice', (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  const rows = Array.isArray(req.body?.rows) ? req.body.rows
    .filter(r => r && (r.who === 'you' || r.who === 'radiant') && typeof r.text === 'string' && r.text.trim())
    .map(r => ({ who: r.who, text: r.text.trim().slice(0, 4000), startMs: Number(r.startMs) || 0, endMs: Number(r.endMs) || 0 }))
    .slice(0, 500) : []
  if (!rows.length) return res.json(s)
  s.messages.push({ role: 'voice', rows, seconds: Number(req.body?.seconds) || null, at: new Date().toISOString() })
  saveSession(s)
  res.json(s)
})

// The key voice uses, in its own slot. Saved through the same config writer as
// every other key; never read back, only whether it is there.
app.put('/api/voice/key', (req, res) => {
  // Two voices, two keys. `slot` names which one; the default stays
  // openai-voice so an older client that does not send it is unchanged.
  const slot = req.body?.provider === 'gemini' ? 'gemini-voice' : 'openai-voice'
  const key = String(req.body?.key || '').trim()
  if (key) config.keys[slot] = key
  else delete config.keys[slot]
  saveConfig(config)
  res.json(publicConfig(config))
})

// The Gemini half of voice: mint a short-lived token and hand the renderer the
// socket URL and the setup frame. The API key never leaves this process.
app.post('/api/voice/gemini/session', async (req, res) => {
  config = loadConfig()
  const apiKey = geminiVoiceKey(config)
  const bad = checkGeminiVoiceRequest({ settings: config.settings, apiKey })
  if (bad) return res.status(bad.status).json({ error: bad.error })
  const session = req.body?.sessionId ? loadSession(req.body.sessionId) : null
  try {
    const model = geminiLiveModel(config.settings)
    const token = await mintEphemeralToken({ apiKey, model })
    res.status(201).json({
      token,
      wsUrl: GEMINI_WS_URL,
      setup: geminiSetupFrame({ session, settings: config.settings, host: LOCK_HOST })
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// A spoken conversation over a chat: GPT-Live in front, this server's turn
// behind. Optional (settings.voice.enabled) and keyed with the OpenAI key.
app.post('/api/voice/session', async (req, res) => {
  config = loadConfig()
  const apiKey = voiceKey(config)
  const bad = checkVoiceRequest({ settings: config.settings, apiKey, sdp: req.body?.sdp, signedIn: Boolean(config.oauth?.openai) })
  if (bad) return res.status(bad.status).json({ error: bad.error })
  const session = req.body?.sessionId ? loadSession(req.body.sessionId) : null
  const provider = config.providers.find(p => p.id === 'openai')
  try {
    const body = liveSessionBody({ session, settings: config.settings, host: LOCK_HOST, sdp: req.body.sdp })
    const result = await createLiveSession({ apiKey, body, baseUrl: provider?.baseUrl || 'https://api.openai.com/v1' })
    res.status(201).json(result)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

app.post('/api/dictate/stop', async (req, res) => {
  const { stopDictation } = await import('./dictate.js')
  stopDictation()
  res.json({ ok: true })
})

// Where the extension lives on disk, so Settings can tell you the folder to load
// and say whether Chrome has it.
app.get('/api/browser/extension', async (req, res) => {
  const { extensionStatus } = await import('./chrome-ext.js')
  const candidates = [
    path.join(__dirname, '..', 'extension'),
    path.join(process.resourcesPath || '', 'extension')
  ]
  const dir = candidates.find(p => { try { return fs.existsSync(path.join(p, 'manifest.json')) } catch { return false } }) || null
  res.json({ ...extensionStatus(), dir })
})

app.get('/api/browser/status', async (req, res) => {
  const { chromeReachable, mode, CDP_PORT } = await import('./browser.js')
  res.json({
    port: CDP_PORT,
    mode,
    reachable: await chromeReachable(),
    profile: chromeProfile(),
    installed: Boolean(chromeApp())
  })
})

app.post('/api/browser/enable', async (req, res) => {
  const { CDP_PORT, chromeReachable } = await import('./browser.js')
  const bin = chromeApp()
  if (!bin) {
    return res.status(400).json({
      error: IS_MAC
        ? 'Google Chrome is not installed.'
        : 'Neither Google Chrome nor Chromium was found. Install one, or use the Radiant extension instead — it drives the browser you already have.'
    })
  }
  try {
    fs.mkdirSync(chromeProfile(), { recursive: true })
    // Detached and not through `open`, so the flags are certain to arrive and this
    // window outlives the request.
    const child = spawn(bin, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeProfile()}`,
      '--no-first-run',
      '--no-default-browser-check'
    ], { detached: true, stdio: 'ignore' })
    child.unref()
    let up = null
    for (let i = 0; i < 30 && !up; i++) {
      await new Promise(r => setTimeout(r, 500))
      up = await chromeReachable()
    }
    res.json({ ok: Boolean(up), reachable: up })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/system', (req, res) => {
  const chip = cpuName()
  const osVersion = osProductVersion()
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
  // ⚠️ SAY WHICH MAC THIS IS. Everything below describes the machine running the
  // SERVER, which is not the machine the user is looking at when they are
  // connected to another Mac. The Models screen presented all of it as "this
  // Mac", and downloads land here too — so a 30 GB pull started on a laptop
  // silently fills a Mac in another room. Tony, on where a model ends up:
  // "correct. thats what confused me."
  const hostname = computerName()
  res.json({
    hostname,
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
      // ⚠️ SUBFOLDERS ARE WHERE THE WEIGHTS LIVE NOW. This used to skip any file
      // with a slash in it, which was fine when every quant sat at the top
      // level. Unsloth (and others) now publish one FOLDER per quantization —
      // BF16/, UD-Q4_K_XL/, Q8_0/ — so that rule hid all 50 weight files in
      // Qwen3.8-Flash-Next-GGUF and the app said "No GGUF files in this repo"
      // about a repo full of them. Companions are still filtered, on the
      // basename: projectors, vision/clip encoders, drafts, LoRA, MTP heads.
      const dirName = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
      const baseName = f.slice(f.lastIndexOf('/') + 1)
      if (dirName.includes('/')) continue                     // one level only
      if (/mmproj|projector|\bproj\b|vision|\bclip\b|encoder|lora|adapter|draft|\bmtp\b/i.test(baseName)) continue
      // Group sharded parts (…-00001-of-00003.gguf) under one quant. We download
      // files directly from HF and `ollama create` from them, so shards are fine.
      const stem = baseName.replace(/-\d+-of-\d+\.gguf$/i, '.gguf')
      const m = stem.match(/[.\-_](I?Q\d[\w]*?|F16|F32|BF16|FP16|FP32)\.gguf$/i)
      // The folder name IS the quant when there is one — and it is the more
      // precise of the two: a filename regex reads UD-Q4_K_XL as Q4_K_XL and
      // would then collide with a plain Q4_K_XL from another folder.
      const label = (dirName || (m ? m[1] : 'default')).toUpperCase().replace(/^FP(16|32)$/, 'F$1')
      quants[label] = quants[label] || { bytes: 0, files: [] }
      quants[label].bytes += s.size || 0
      quants[label].files.push(f)
    }
    res.json({
      repo,
      quants: Object.entries(quants)
        .map(([label, v]) => ({
          label,
          // ⚠️ ZERO BYTES MEANS UNKNOWN, NOT EMPTY. Hugging Face sometimes returns
          // siblings carrying no size, and `bytes += s.size || 0` then leaves the
          // total at 0 — so a real multi-gigabyte quant was offered as "0 GB
          // download · ~2 GB RAM", a confident number that is simply false. null
          // says so, and the fit and disk checks already treat a missing size as
          // "cannot judge" rather than "fits easily".
          sizeGB: v.bytes ? +(v.bytes / 1024 ** 3).toFixed(1) : null,
          files: v.files.sort(),
          sharded: v.files.length > 1,
          model: `${base}:${label.toLowerCase()}`
        }))
        .sort((a, b) => (a.sizeGB ?? Infinity) - (b.sizeGB ?? Infinity))  // unknown sizes last
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

// What Ollama has LOADED right now, and with how much context. This is the
// number that costs the memory: Ollama sizes it from the machine's RAM (48 GB
// or more gets 256k), so a big Mac can quietly reserve a 262144-token KV cache
// and take 59 GB for one model. Radiant cannot set it — the OpenAI-compatible
// /v1 endpoint has no such option — so Settings shows it and says where it
// lives, rather than leaving people to guess which app is at fault.
app.get('/api/local-models/loaded', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(4000) })
    const data = await r.json()
    res.json({
      running: true,
      models: (data.models || []).map(m => ({
        name: m.name || m.model,
        context: m.context_length || null,
        sizeGB: m.size ? +(m.size / 1024 ** 3).toFixed(1) : null
      }))
    })
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
      // ⚠️ BASENAME, NOT THE REPO PATH. `BF16/model-00001-of-00008.gguf` has no
      // BF16 directory here, so writing the repo path straight out fails with
      // ENOENT — and joining an attacker-shaped path would be worse than that.
      const out = fs.createWriteStream(path.join(dir, path.basename(f)))
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
    fs.writeFileSync(modelfile, `FROM ${path.join(dir, path.basename(entry.files[0]))}\n`)
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
  // One optional folder level, each segment plain — never a traversal, never
  // an absolute path. These strings become a URL and, as a basename, a filename.
  const okFile = f => typeof f === 'string' && f.length < 256 &&
    /^(?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+\.gguf$/i.test(f) && !f.split('/').includes('..')
  if (!Array.isArray(files) || !files.length || !files.every(okFile)) return res.status(400).json({ error: 'bad files' })
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
// ---- tasks (the board) ----
// ⚠️ THE BOARD DOES NOT OWN PROGRESS. A card's state comes from the run it
// points at: `working` while the agent is going, `blocked` the moment it asks
// for approval, `review` when it finishes. Only queued/done are a human's to
// set. A board that let you drag a card to "done" while the agent was still
// running would be a drawing of work, not a view of it.
const TASK_ID = () => 'task-' + Math.random().toString(36).slice(2, 10)
// ⚠️ THE BOARD REFLECTS THE RUN; IT DOES NOT NARRATE IT. Card state is derived
// from the events a turn already emits, so a card cannot show progress the
// agent did not make. Attached to emit rather than sprinkled through the turn
// loop, because every path out of a run — success, approval, error, abort —
// goes through emit exactly once per event, and a state machine with five
// hand-placed call sites is a state machine with a missing one.
const RUN_PROGRESS = new Set(['round_start', 'text_delta', 'thinking_delta', 'tool_start', 'tool_result'])
const STATE_WORDS = { queued: 'Queued', working: 'Working', blocked: 'Needs you', review: 'Review', done: 'Done' }

function reflectTaskState (sessionId, ev) {
  if (!sessionId || !ev) return
  let task
  try { task = listTasks().find(t => t.sessionId === sessionId) } catch { return }
  if (!task) return
  const was = task.state
  // ⚠️ A QUESTION IS ALSO A BLOCK. `ask_user` ends the turn, so the run emits
  // question_request and then `done` — and a board that only watched `done`
  // filed "the agent asked you something" under Review, next to finished work.
  // It is the same situation as an approval: nothing moves until you answer.
  // Seen live the first time a task ran: the agent asked "How should we start?"
  // and the card read Review.
  if (ev.type === 'approval_request' || ev.type === 'question_request') task.state = 'blocked'
  else if (ev.type === 'done') {
    // `done` arrives right after a question. It must not overwrite the block.
    if (task.state === 'blocked') return
    task.state = 'review'
    task.finishedAt = new Date().toISOString()
  }
  else if (ev.type === 'error') { task.state = 'blocked'; task.lastError = String(ev.message || 'The run stopped.') }
  // ⚠️ A STOPPED RUN IS NOT STILL WORKING. Stop (or a closed window) ends the
  // turn with `stopped`, which this ignored — the card sat in Working forever
  // with nothing running. Half-done work needs a person to decide what next.
  else if (ev.type === 'stopped') { task.state = 'blocked'; task.lastError = 'Stopped before it finished.' }
  // Back to Working only on real progress — the agent writing or using a tool
  // after you answered it. Housekeeping events (stats, usage, the title) used to
  // count too, so a stopped or failed run bounced straight back to Working.
  else if (task.state === 'blocked' && RUN_PROGRESS.has(ev.type)) task.state = 'working'
  else return
  if (task.state === was) return
  if (task.state === 'working') task.lastError = null
  // The run's own record: how it is going, and when it stopped.
  const run = task.runs[task.runs.length - 1]
  if (run) {
    run.outcome = task.state === 'review' ? 'finished' : task.state === 'blocked' ? (ev.type === 'error' ? 'error' : ev.type === 'stopped' ? 'stopped' : 'waiting') : 'running'
    if (task.state === 'review' || ev.type === 'error' || ev.type === 'stopped') run.endedAt = new Date().toISOString()
    if (ev.type === 'error') run.note = task.lastError
  }
  taskActivity(task, ev.type === 'error'
    ? `The run stopped: ${task.lastError}`
    : ev.type === 'stopped' ? 'The run was stopped before it finished'
    : ev.type === 'question_request' ? 'The agent asked you a question'
      : ev.type === 'approval_request' ? 'The agent is waiting for your approval'
        : `Moved to ${STATE_WORDS[task.state]}`, 'run')
  try { saveTask(task) } catch { /* a board that cannot save must not kill the run */ }
}

// ⚠️ DEPENDENCIES ARE A GATE, NOT A SUGGESTION. A card that waits on others
// cannot start until every one of them is Done — the same rule a person would
// follow reading the board, enforced so a click cannot skip it.
function unmetDeps (task, all = listTasks()) {
  return task.blockedBy.map(id => all.find(t => t.id === id)).filter(t => t && t.state !== 'done')
}
/** Would `task` waiting on `ids` make a loop (A waits on B waits on A)? */
function depCycle (taskId, ids, all) {
  const byId = new Map(all.map(t => [t.id, t]))
  const seen = new Set()
  const walk = id => {
    if (id === taskId) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (byId.get(id)?.blockedBy || []).some(walk)
  }
  return ids.some(walk)
}
function cleanDeps (task, ids, all) {
  if (!Array.isArray(ids)) return { error: 'blockedBy must be a list of task ids.' }
  const list = [...new Set(ids.map(String))].filter(id => id !== task.id)
  const missing = list.filter(id => !all.some(t => t.id === id))
  if (missing.length) return { error: `No such task: ${missing.join(', ')}` }
  if (depCycle(task.id, list, all)) return { error: 'That would make the tasks wait on each other forever.' }
  return { list }
}
/** A card reached Done: say so on every card that was waiting on it. */
function announceDone (task, all = listTasks()) {
  for (const t of all) {
    if (!t.blockedBy.includes(task.id) || t.state !== 'queued') continue
    const left = unmetDeps(t, all).filter(d => d.id !== task.id)
    taskActivity(t, left.length ? `“${task.title}” is done — still waiting on ${left.length} more` : `“${task.title}” is done — this task is ready to start`, 'run')
    saveTask(t)
  }
}

function cleanProps (b, task) {
  if (b.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(b.priority)) return `Unknown priority: ${b.priority}`
    task.priority = b.priority
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels)) return 'labels must be a list.'
    task.labels = [...new Set(b.labels.map(l => String(l).trim()).filter(Boolean))].slice(0, 12)
  }
  if (b.due !== undefined) {
    if (b.due !== null && Number.isNaN(Date.parse(b.due))) return 'due must be a date.'
    task.due = b.due || null
  }
  return null
}

app.get('/api/tasks', (req, res) => res.json(listTasks()))

app.post('/api/tasks', (req, res) => {
  const b = req.body || {}
  const title = String(b.title || '').trim()
  if (!title) return res.status(400).json({ error: 'A task needs a title.' })
  const task = {
    id: TASK_ID(),
    title,
    detail: String(b.detail || ''),
    // Whichever the person picked. An agent carries its own model, so agentId
    // wins when both are set — the same precedence the composer already uses.
    agentId: b.agentId || null,
    model: b.model || null,
    provider: b.provider || null,
    cwd: b.cwd || null,
    projectId: b.projectId || null,
    state: 'queued',
    sessionId: null,
    order: Number.isFinite(b.order) ? b.order : Date.now(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    lastError: null,
    priority: 'none', labels: [], due: null, blockedBy: [], comments: [], activity: [], runs: []
  }
  const bad = cleanProps(b, task)
  if (bad) return res.status(400).json({ error: bad })
  if (b.blockedBy !== undefined) {
    const d = cleanDeps(task, b.blockedBy, listTasks())
    if (d.error) return res.status(400).json({ error: d.error })
    task.blockedBy = d.list
  }
  taskActivity(task, b.by === 'agent' ? 'Created by an agent' : 'Created', b.by === 'agent' ? 'agent' : 'you')
  res.json(saveTask(task))
})

app.patch('/api/tasks/:id', (req, res) => {
  const task = loadTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'No such task.' })
  const b = req.body || {}
  const by = b.byUser ? 'you' : b.by === 'agent' ? 'agent' : 'you'
  if (b.state !== undefined && b.state !== task.state) {
    if (!TASK_STATES.includes(b.state)) return res.status(400).json({ error: `Unknown state: ${b.state}` })
    // Dragging cannot fake progress. A person may park a card back in Queued or
    // accept it into Done; the run owns everything between.
    if (!['queued', 'done'].includes(b.state) && b.byUser) {
      return res.status(409).json({ error: 'That column is set by the run, not by hand.' })
    }
    task.state = b.state
    if (b.state === 'done') task.finishedAt = new Date().toISOString()
    taskActivity(task, `Moved to ${STATE_WORDS[b.state]}`, by)
  }
  const before = { title: task.title, detail: task.detail, priority: task.priority, labels: task.labels.join(', '), due: task.due }
  const bad = cleanProps(b, task)
  if (bad) return res.status(400).json({ error: bad })
  if (b.blockedBy !== undefined) {
    const all = listTasks()
    const d = cleanDeps(task, b.blockedBy, all)
    if (d.error) return res.status(400).json({ error: d.error })
    const added = d.list.filter(id => !task.blockedBy.includes(id))
    const removed = task.blockedBy.filter(id => !d.list.includes(id))
    const name = id => `“${all.find(t => t.id === id)?.title || id}”`
    if (added.length) taskActivity(task, `Now waits on ${added.map(name).join(', ')}`, by)
    if (removed.length) taskActivity(task, `No longer waits on ${removed.map(name).join(', ')}`, by)
    task.blockedBy = d.list
  }
  for (const k of ['title', 'detail', 'agentId', 'model', 'provider', 'cwd', 'projectId', 'order', 'sessionId']) {
    if (b[k] !== undefined) task[k] = b[k]
  }
  if (task.title !== before.title) taskActivity(task, `Renamed from “${before.title}”`, by)
  if (task.detail !== before.detail) taskActivity(task, 'Edited the description', by)
  if (task.priority !== before.priority) taskActivity(task, task.priority === 'none' ? 'Cleared the priority' : `Priority set to ${task.priority}`, by)
  if (task.labels.join(', ') !== before.labels) taskActivity(task, task.labels.length ? `Labels: ${task.labels.join(', ')}` : 'Removed the labels', by)
  if (task.due !== before.due) taskActivity(task, task.due ? `Due ${task.due.slice(0, 10)}` : 'Removed the due date', by)
  const saved = saveTask(task)
  if (b.state === 'done') announceDone(task)
  res.json(saved)
})

app.delete('/api/tasks/:id', (req, res) => {
  // A deleted card cannot hold anything up: take it off every waiting list.
  for (const t of listTasks()) {
    if (!t.blockedBy.includes(req.params.id)) continue
    t.blockedBy = t.blockedBy.filter(id => id !== req.params.id)
    saveTask(t)
  }
  deleteTask(req.params.id)
  res.json({ ok: true })
})

app.post('/api/tasks/:id/comments', (req, res) => {
  const task = loadTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'No such task.' })
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'A comment needs some text.' })
  const c = taskComment(task, text, req.body?.author === 'agent' ? 'agent' : 'you')
  saveTask(task)
  res.json(c)
})

/**
 * Everything that happened to a card, in time order, in one list: comments,
 * activity, and each run with the tools it used (its worker log). The log is
 * read from the run's own transcript, not copied — the chat and the card
 * cannot disagree about what the agent did.
 */
app.get('/api/tasks/:id/feed', (req, res) => {
  const task = loadTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'No such task.' })
  const session = task.sessionId ? loadSession(task.sessionId) : null
  const msgs = session?.messages || []
  const items = []
  for (const c of task.comments) items.push({ kind: 'comment', at: c.at, id: c.id, author: c.author, text: c.text })
  for (const a of task.activity) items.push({ kind: 'activity', at: a.at, by: a.by, text: a.text })
  task.runs.forEach((r, i) => {
    const to = task.runs[i + 1]?.fromIndex ?? msgs.length
    const log = []
    let reply = ''
    for (const m of msgs.slice(r.fromIndex || 0, to)) {
      if (m.role !== 'assistant') continue
      for (const p of m.parts || []) {
        if (p.type === 'tool') log.push({ tool: p.name, args: summarizeArgs(p.args), result: String(p.result ?? '').slice(0, 400), error: Boolean(p.error) })
        if (p.type === 'text' && p.text) reply = p.text
      }
    }
    items.push({ kind: 'run', at: r.startedAt, id: r.id, n: i + 1, sessionId: r.sessionId, endedAt: r.endedAt || null, outcome: r.outcome, note: r.note || null, model: r.model || null, log, reply: reply.slice(0, 1200) })
  })
  items.sort((a, b) => (a.at || '').localeCompare(b.at || ''))
  const all = listTasks()
  const link = id => { const t = all.find(x => x.id === id); return t ? { id: t.id, title: t.title, state: t.state } : { id, title: 'Deleted task', state: null } }
  res.json({
    task,
    items,
    blockedBy: task.blockedBy.map(link),
    blocks: all.filter(t => t.blockedBy.includes(task.id)).map(t => link(t.id)),
    waitingOn: unmetDeps(task, all).map(t => t.id)
  })
})

function summarizeArgs (args) {
  if (!args || typeof args !== 'object') return ''
  const v = args.command || args.path || args.file_path || args.url || args.query || args.pattern || Object.values(args).find(x => typeof x === 'string') || ''
  return String(v).slice(0, 160)
}

/**
 * The task_board tool (providers.js BOARD_TOOL), run against the same store the
 * board reads. Returns text for the model. Never throws: a bad call is an
 * answer the agent can correct, not a dead turn.
 */
function boardTool (args, session) {
  try {
    const all = listTasks()
    const own = session?.taskId || all.find(t => t.sessionId === session?.id)?.id || null
    const id = args.id || own
    const line = t => `${t.id} · ${STATE_WORDS[t.state]}${t.priority !== 'none' ? ` · ${t.priority}` : ''} · ${t.title}${t.blockedBy.length ? ` · waits on ${t.blockedBy.join(', ')}` : ''}${t.id === own ? ' · (this chat\'s task)' : ''}`
    switch (args.action) {
      case 'list':
        return all.length ? all.map(line).join('\n') : 'The board is empty.'
      case 'show': {
        const t = id && loadTask(id)
        if (!t) return id ? `No task ${id}.` : 'This chat is not attached to a task; pass an id.'
        const comments = t.comments.slice(-15).map(c => `- ${c.author === 'agent' ? 'Agent' : 'User'}: ${c.text}`).join('\n')
        return `${line(t)}\n\n${t.detail || '(no description)'}${t.labels.length ? `\n\nLabels: ${t.labels.join(', ')}` : ''}${t.due ? `\nDue: ${t.due}` : ''}${comments ? `\n\nComments:\n${comments}` : ''}`
      }
      case 'create': {
        const title = String(args.title || '').trim()
        if (!title) return 'create needs a title.'
        const parent = own ? loadTask(own) : null
        const task = {
          id: TASK_ID(), title, detail: String(args.detail || ''),
          // A subtask inherits who and where from the task that made it.
          agentId: parent?.agentId || null, model: parent?.model || null, provider: parent?.provider || null,
          cwd: parent?.cwd || session?.cwd || null, projectId: parent?.projectId || session?.projectId || null,
          state: 'queued', sessionId: null, order: Date.now(), createdAt: new Date().toISOString(),
          startedAt: null, finishedAt: null, lastError: null,
          priority: 'none', labels: [], due: null, blockedBy: [], comments: [], activity: [], runs: []
        }
        const bad = cleanProps({ priority: args.priority, labels: args.labels }, task)
        if (bad) return bad
        if (args.blockedBy) {
          const d = cleanDeps(task, args.blockedBy, all)
          if (d.error) return d.error
          task.blockedBy = d.list
        }
        taskActivity(task, parent ? `Created by an agent while working on “${parent.title}”` : 'Created by an agent', 'agent')
        saveTask(task)
        return `Created ${line(task)}`
      }
      case 'comment': {
        const t = id && loadTask(id)
        if (!t) return id ? `No task ${id}.` : 'This chat is not attached to a task; pass an id.'
        const text = String(args.text || '').trim()
        if (!text) return 'comment needs text.'
        taskComment(t, text, 'agent')
        saveTask(t)
        return `Commented on ${t.id}.`
      }
      case 'link': {
        const t = id && loadTask(id)
        if (!t) return id ? `No task ${id}.` : 'This chat is not attached to a task; pass an id.'
        const d = cleanDeps(t, [...t.blockedBy, ...(args.blockedBy || [])], all)
        if (d.error) return d.error
        const added = d.list.filter(x => !t.blockedBy.includes(x))
        t.blockedBy = d.list
        if (added.length) taskActivity(t, `An agent made it wait on ${added.map(x => `“${all.find(a => a.id === x)?.title || x}”`).join(', ')}`, 'agent')
        saveTask(t)
        return `${line(t)}`
      }
      default:
        return 'Unknown action. Use list, show, create, comment or link.'
    }
  } catch (e) {
    return `The board could not do that: ${e.message}`
  }
}

/** The comments a run has not seen yet, as the words the agent reads. */
function unseenComments (task, since) {
  const fresh = task.comments.filter(c => c.author === 'you' && (!since || c.at > since))
  return fresh.length ? `Comments on this task since you last worked on it:\n${fresh.map(c => `- ${c.text}`).join('\n')}` : ''
}

// Starting a task creates the session it will live in, and hands the id back so
// the client streams the turn exactly as it does for a chat. No second run
// engine: a task IS a conversation, opened with the goal as its first message.
app.post('/api/tasks/:id/start', (req, res) => {
  const task = loadTask(req.params.id)
  if (!task) return res.status(404).json({ error: 'No such task.' })
  const all = listTasks()
  const waiting = unmetDeps(task, all)
  if (waiting.length && task.state === 'queued') {
    return res.status(409).json({ error: `This task waits on ${waiting.map(t => `“${t.title}”`).join(', ')} — finish ${waiting.length === 1 ? 'that' : 'those'} first.` })
  }
  const lastRun = task.runs[task.runs.length - 1]
  const newRun = (sessionId, fromIndex, model) => {
    task.runs.push({ id: 'r-' + Math.random().toString(36).slice(2, 10), sessionId, fromIndex, model, startedAt: new Date().toISOString(), endedAt: null, outcome: 'running' })
    if (task.runs.length > 50) task.runs.splice(0, task.runs.length - 50)
  }
  if (task.sessionId) {
    const existing = loadSession(task.sessionId)
    if (existing) {
      // Resuming: the conversation already exists, so continue it rather than
      // starting a second one and orphaning the first. Anything you commented
      // since the last run goes in as the next message.
      const prompt = unseenComments(task, lastRun?.startedAt) || null
      // Only a new message or a card pulled back out of Queued is work starting;
      // opening a finished task's conversation must not claim it is running.
      if (prompt || task.state === 'queued') { task.state = 'working'; task.lastError = null }
      if (prompt) {
        newRun(existing.id, existing.messages.length, existing.model)
        taskActivity(task, `Run ${task.runs.length} started with your new comments`, 'you')
      } else taskActivity(task, 'Opened the conversation again', 'you')
      saveTask(task)
      return res.json({ task, sessionId: task.sessionId, prompt, resumed: true })
    }
  }
  const config = loadConfig()
  const project = task.projectId ? getProject(task.projectId) : null
  const agent = task.agentId ? agentsStore.get(task.agentId) : null
  const session = {
    id: crypto.randomUUID(),
    title: task.title,
    autoTitle: false,          // the task named it; do not let the first turn rename it
    agentId: agent ? agent.id : null,
    projectId: project ? project.id : null,
    provider: task.provider || (agent && agent.provider) || (project && project.provider) || config.settings.defaultProvider || null,
    model: task.model || (agent && agent.model) || (project && project.model) || config.settings.defaultModel,
    cwd: task.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: agent ? agent.useTools !== false : true,
    computerControl: Boolean(agent && agent.computerControl),
    taskId: task.id,           // so the transcript can point back at its card
    createdAt: new Date().toISOString(),
    messages: []
  }
  saveSession(session)
  task.sessionId = session.id
  task.state = 'working'
  task.startedAt = task.startedAt || new Date().toISOString()
  task.lastError = null
  newRun(session.id, 0, session.model)
  taskActivity(task, `Run ${task.runs.length} started${agent ? ` by ${agent.name}` : session.model ? ` on ${session.model}` : ''}`, 'you')
  saveTask(task)
  // The opening message: the goal, any detail the person wrote, what the tasks
  // it waited on produced, and any comments.
  const done = task.blockedBy.map(id => all.find(t => t.id === id)).filter(Boolean)
  const upstream = done.length ? `This task follows: ${done.map(t => `“${t.title}”`).join(', ')} (done).` : ''
  const notes = unseenComments(task, null)
  const prompt = [task.detail ? `${task.title}\n\n${task.detail}` : task.title, upstream, notes].filter(Boolean).join('\n\n')
  res.json({ task, sessionId: session.id, prompt, resumed: false })
})

// ---- loops (the layer above the board) ----
// ⚠️ THERE IS STILL ONLY ONE RUN ENGINE. A loop does not run turns; it decides
// which turn should run next and hands it to the client, which streams it
// exactly as it streams a chat — the same handoff `POST /api/tasks/:id/start`
// already does. Everything below is bookkeeping between turns.
//
// The client's whole job is: call /advance, run whatever it returns, call
// /advance again. That keeps approvals, steering, tools and the transcript on
// the one path that already works, and it means a loop is watchable rather than
// something happening invisibly in the server.
const LOOP_ID = () => 'loop-' + Math.random().toString(36).slice(2, 10)

/** Build a session for one step. Same shape a task's session has. */
function sessionForStep (loop, step, kind) {
  const config = loadConfig()
  const project = loop.projectId ? getProject(loop.projectId) : null
  const agentId = kind === 'check' ? step.checkAgentId : step.agentId
  const agent = agentId ? agentsStore.get(agentId) : null
  const session = {
    id: crypto.randomUUID(),
    title: kind === 'check' ? `Check — ${step.title}` : `${loop.title} — ${step.title}`,
    autoTitle: false,
    agentId: agent ? agent.id : null,
    projectId: project ? project.id : null,
    provider: step.provider || (agent && agent.provider) || (project && project.provider) || config.settings.defaultProvider || null,
    model: step.model || (agent && agent.model) || (project && project.model) || config.settings.defaultModel,
    cwd: loop.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: agent ? agent.useTools !== false : true,
    computerControl: Boolean(agent && agent.computerControl),
    loopId: loop.id,
    loopStepId: step.id,
    createdAt: new Date().toISOString(),
    messages: []
  }
  saveSession(session)
  return session
}

/** The text of the last thing the assistant said in a session. */
function lastAssistantText (sessionId) {
  const s = sessionId ? loadSession(sessionId) : null
  if (!s) return ''
  const m = [...(s.messages || [])].reverse().find(x => x.role === 'assistant')
  if (!m) return ''
  if (m.text) return m.text
  return (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
}

// How long a check command may block a loop before it counts as a failure.
// ⚠️ SHORTER THAN THE AGENT'S OWN run_command CAP ON PURPOSE. A check is meant
// to be a test suite or a file test, not the work — and this one runs while a
// loop is waiting on it, including on a schedule with nobody watching.
const CHECK_TIMEOUT_MS = 120_000

/**
 * Run one check command and report what happened. Never throws and never judges:
 * the verdict is read by readCommandVerdict, which is pure and tested.
 *
 * ⚠️ `bash -lc`, THE SAME SHELL THE AGENT'S OWN run_command USES. A check that
 * behaves differently from the command the user pasted it out of is a check
 * nobody can trust — `npm test` has to mean what it means in their terminal,
 * login profile and PATH included.
 */
function runCheckCommand (command, cwd) {
  return new Promise(resolve => {
    execFile('bash', ['-lc', command], {
      cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env
    }, (err, stdout, stderr) => {
      // ⚠️ THREE OUTCOMES WEAR THE SAME `err`, AND THEY MEAN DIFFERENT THINGS.
      // `killed` is the timeout. A string `code` (ENOENT) is the process never
      // starting. A number is the command running and saying no — which is the
      // ordinary case, and calling it "could not run" would send the user to
      // check their command instead of their code.
      const timedOut = Boolean(err && err.killed)
      const spawnError = err && !timedOut && typeof err.code !== 'number' ? (err.message || String(err.code)) : null
      resolve({
        code: timedOut || spawnError ? null : (err ? err.code : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut,
        timeoutMs: CHECK_TIMEOUT_MS,
        spawnError
      })
    })
  })
}

/** A session for the goal check — the judge of the whole run, not of one step. */
function sessionForGoal (loop) {
  const config = loadConfig()
  const project = loop.projectId ? getProject(loop.projectId) : null
  const session = {
    id: crypto.randomUUID(),
    title: `Goal check — ${loop.title}`,
    autoTitle: false,
    agentId: null,
    projectId: project ? project.id : null,
    provider: (project && project.provider) || config.settings.defaultProvider || null,
    model: (project && project.model) || config.settings.defaultModel,
    cwd: loop.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: true,
    computerControl: false,
    loopId: loop.id,
    loopStepId: null,
    createdAt: new Date().toISOString(),
    messages: []
  }
  saveSession(session)
  return session
}

// ⚠️ `due` IS COMPUTED HERE, NOT STORED. A stored flag needs something to clear
// it, and the something is a timer nobody wrote — so it goes stale and a loop
// either never fires or fires every tick. It is a function of the clock and the
// last run, so it is read as one.
app.get('/api/loops', (req, res) => res.json(listLoops().map(l => ({
  ...l, due: isDue(l), nextRunAt: nextRunAt(l)
}))))
app.get('/api/loops/:id', (req, res) => {
  const loop = loadLoop(req.params.id)
  if (!loop) return res.status(404).json({ error: 'No such loop.' })
  res.json(loop)
})

app.post('/api/loops', (req, res) => {
  const b = req.body || {}
  const title = String(b.title || '').trim()
  if (!title) return res.status(400).json({ error: 'A loop needs a goal.' })
  const steps = (Array.isArray(b.steps) ? b.steps : []).map(s => normalizeStep(s)).filter(s => s.title)
  if (!steps.length) return res.status(400).json({ error: 'A loop needs at least one step.' })
  const now = new Date().toISOString()
  const schedule = normalizeSchedule(b.schedule)
  res.json(saveLoop({
    id: LOOP_ID(),
    title,
    detail: String(b.detail || ''),
    cwd: b.cwd || null,
    projectId: b.projectId || null,
    state: 'idle',
    currentStep: 0,
    steps,
    ...normalizeGoal(b),
    // Which pass over the whole loop this is. 1 until a goal check sends it back.
    pass: 1,
    lastGoalFail: null,
    goalState: null,
    goalSessionId: null,
    schedule,
    scheduledAt: schedule ? now : null,
    scheduleOffReason: null,
    lastRunAt: null,
    consecutiveFailures: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null
  }))
})

app.patch('/api/loops/:id', (req, res) => {
  const loop = loadLoop(req.params.id)
  if (!loop) return res.status(404).json({ error: 'No such loop.' })
  const b = req.body || {}
  // ⚠️ A RUNNING LOOP IS NOT EDITABLE. Rewriting the steps under a run leaves the
  // index pointing at a step that no longer exists, and the attempt counts belong
  // to prompts that are gone.
  if (loop.state === 'running' && b.steps !== undefined) {
    return res.status(409).json({ error: 'Stop the loop before changing its steps.' })
  }
  if (b.title !== undefined) loop.title = String(b.title).trim() || loop.title
  if (b.detail !== undefined) loop.detail = String(b.detail)
  if (b.cwd !== undefined) loop.cwd = b.cwd || null
  if (b.projectId !== undefined) loop.projectId = b.projectId || null
  if (b.goalCheck !== undefined || b.goalCommand !== undefined || b.maxPasses !== undefined) {
    Object.assign(loop, normalizeGoal({
      goalCheck: b.goalCheck !== undefined ? b.goalCheck : loop.goalCheck,
      goalCommand: b.goalCommand !== undefined ? b.goalCommand : loop.goalCommand,
      maxPasses: b.maxPasses !== undefined ? b.maxPasses : loop.maxPasses
    }))
  }
  if (b.schedule !== undefined) {
    const next = normalizeSchedule(b.schedule)
    // ⚠️ RE-STAMP THE CLOCK WHENEVER THE INTERVAL CHANGES. Without this the next
    // run is measured from whenever the loop was written, so putting "every
    // hour" on a week-old loop makes it due the instant you press Save — the
    // user asked for an hour and got a run immediately, which reads as a bug.
    const changed = JSON.stringify(next) !== JSON.stringify(loop.schedule || null)
    loop.schedule = next
    if (changed) loop.scheduledAt = next ? new Date().toISOString() : null
    // Switching it back on is the user answering the give-up message.
    if (next) { loop.scheduleOffReason = null; loop.consecutiveFailures = 0 }
  }
  if (Array.isArray(b.steps)) {
    const byId = new Map(loop.steps.map(s => [s.id, s]))
    loop.steps = b.steps.map(s => normalizeStep(s, byId.get(s.id))).filter(s => s.title)
    if (!loop.steps.length) return res.status(400).json({ error: 'A loop needs at least one step.' })
    loop.currentStep = Math.min(loop.currentStep, loop.steps.length - 1)
  }
  res.json(saveLoop(loop))
})

app.delete('/api/loops/:id', (req, res) => { deleteLoop(req.params.id); res.json({ ok: true }) })

// Start, or start over. Everything a previous run wrote is cleared here so the
// step states cannot be a mix of this run and the last one.
app.post('/api/loops/:id/start', (req, res) => {
  const loop = loadLoop(req.params.id)
  if (!loop) return res.status(404).json({ error: 'No such loop.' })
  const from = Number(req.body?.from)
  const start = Number.isFinite(from) ? Math.min(Math.max(0, Math.round(from)), loop.steps.length - 1) : 0
  loop.steps = [...loop.steps.slice(0, start), ...resetSteps(loop.steps.slice(start))]
  loop.currentStep = start
  loop.state = 'running'
  loop.startedAt = new Date().toISOString()
  loop.lastRunAt = loop.startedAt
  loop.finishedAt = null
  // A fresh run is pass one. Everything the goal check learned last time goes
  // with it — carrying it forward would make pass one read as a retry.
  loop.pass = 1
  loop.lastGoalFail = null
  loop.goalState = null
  loop.goalSessionId = null
  res.json(saveLoop(loop))
})

app.post('/api/loops/:id/stop', (req, res) => {
  const loop = loadLoop(req.params.id)
  if (!loop) return res.status(404).json({ error: 'No such loop.' })
  if (loop.state === 'running') loop.state = 'idle'
  for (const s of loop.steps) if (s.state === 'working' || s.state === 'checking') s.state = 'pending'
  res.json(saveLoop(loop))
})
// ---- graphs (the layer above the loop) ----
// ⚠️ A LOOP IS ONE JOB THAT KEEPS GOING UNTIL IT VERIFIES. A GRAPH IS SEVERAL
// JOBS THAT DO NOT WAIT FOR EACH OTHER. Nodes are units of work; an edge exists
// only where one node actually reads another's output. Everything not waiting
// runs at the same time — see server/graph-run.js, which is the first thing in
// this app to run more than one turn at once.
const GRAPH_ID = () => 'graph-' + Math.random().toString(36).slice(2, 10)

// The one place a graph's turns get their credentials, resolved exactly the way
// the chat handler resolves them so there is no second answer to "which key".
async function graphCreds (providerId) {
  const cfg = loadConfig()
  let provider = cfg.providers.find(p => p.id === providerId)
  if (!provider) return null
  if (provider.id === 'qwen' && cfg.oauth.qwen?.apiBase) provider = { ...provider, baseUrl: cfg.oauth.qwen.apiBase }
  const apiKey = cfg.keys[provider.id]
  const hasOAuth = Boolean(cfg.oauth[provider.id])
  if (provider.auth === 'key' && !apiKey && !hasOAuth) return null
  return {
    provider,
    apiKey,
    getAccessToken: hasOAuth ? () => validAccessToken(provider.id, loadConfig(), saveConfig) : null,
    getAccountId: hasOAuth ? () => loadConfig().oauth[provider.id]?.accountId || null : null
  }
}
const graphDeps = { loadConfig, saveSession, agentsStore, getProject, credFor: graphCreds }

app.get('/api/graphs', (req, res) => res.json(listGraphs().map(g => ({ ...g, running: isRunning(g.id) }))))

app.get('/api/graphs/:id', (req, res) => {
  const g = loadGraph(req.params.id)
  if (!g) return res.status(404).json({ error: 'No such graph.' })
  // The live run outranks the saved one — a run in flight is only in memory.
  res.json({ ...g, running: isRunning(g.id), run: liveRun(g.id) || g.run || null })
})

app.post('/api/graphs', (req, res) => {
  const b = req.body || {}
  const title = String(b.title || '').trim()
  if (!title) return res.status(400).json({ error: 'A graph needs a goal.' })
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map(n => normalizeNode(n)).filter(n => n.title)
  if (!nodes.length) return res.status(400).json({ error: 'A graph needs at least one step.' })
  const { error } = planLayers(nodes)
  if (error) return res.status(400).json({ error })
  const bad = checkNodes(nodes)
  if (bad) return res.status(400).json({ error: bad })
  res.json(saveGraph({
    id: GRAPH_ID(),
    title,
    detail: String(b.detail || ''),
    cwd: b.cwd || null,
    projectId: b.projectId || null,
    concurrency: Number(b.concurrency) || DEFAULT_CONCURRENCY,
    // ⚠️ OFF UNLESS THE USER SAYS OTHERWISE. With this on, several agents run
    // shell commands at once with nobody watching. It is a real capability and
    // it is a deliberate choice, never a default.
    autoApprove: b.autoApprove === true,
    // Loop until dry, capped — see MAX_ROUNDS in graph-rules.js for why.
    repeat: normalizeRepeat(b.repeat),
    nodes,
    run: null,
    createdAt: new Date().toISOString()
  }))
})

app.patch('/api/graphs/:id', (req, res) => {
  const g = loadGraph(req.params.id)
  if (!g) return res.status(404).json({ error: 'No such graph.' })
  if (isRunning(g.id)) return res.status(409).json({ error: 'Stop the graph before changing it.' })
  const b = req.body || {}
  if (b.title !== undefined) g.title = String(b.title).trim() || g.title
  if (b.detail !== undefined) g.detail = String(b.detail)
  if (b.cwd !== undefined) g.cwd = b.cwd || null
  if (b.projectId !== undefined) g.projectId = b.projectId || null
  if (b.concurrency !== undefined) g.concurrency = Number(b.concurrency) || DEFAULT_CONCURRENCY
  if (b.autoApprove !== undefined) g.autoApprove = b.autoApprove === true
  if (b.repeat !== undefined) g.repeat = normalizeRepeat(b.repeat)
  if (Array.isArray(b.nodes)) {
    const byId = new Map(g.nodes.map(n => [n.id, n]))
    const nodes = b.nodes.map(n => normalizeNode(n, byId.get(n.id))).filter(n => n.title)
    if (!nodes.length) return res.status(400).json({ error: 'A graph needs at least one step.' })
    const { error } = planLayers(nodes)
    if (error) return res.status(400).json({ error })
    const bad = checkNodes(nodes)
    if (bad) return res.status(400).json({ error: bad })
    g.nodes = nodes
  }
  res.json(saveGraph(g))
})

app.delete('/api/graphs/:id', (req, res) => { deleteGraph(req.params.id); res.json({ ok: true }) })

// What would run at the same time, and which waits look fake. Answered before
// anything is spent, because the shape is the thing worth checking.
app.get('/api/graphs/:id/plan', (req, res) => {
  const g = loadGraph(req.params.id)
  if (!g) return res.status(404).json({ error: 'No such graph.' })
  const { layers, error } = planLayers(g.nodes)
  res.json({ layers, error, suspect: suspectEdges(g.nodes), mermaid: toMermaid(g, liveRun(g.id) || g.run) })
})

// ⚠️ RETURNS IMMEDIATELY. The run keeps going on the server with nobody watching
// — that is the whole point of a graph — and the client polls. Holding the
// request open would tie the run to a browser tab.
app.post('/api/graphs/:id/run', (req, res) => {
  const g = loadGraph(req.params.id)
  if (!g) return res.status(404).json({ error: 'No such graph.' })
  if (isRunning(g.id)) return res.status(409).json({ error: 'That graph is already running.' })
  const { error } = planLayers(g.nodes)
  if (error) return res.status(400).json({ error })
  runGraph(g, graphDeps, run => {
    // Persist as it goes, so closing the window loses nothing.
    try { saveGraph({ ...loadGraph(g.id), run }) } catch {}
  }).catch(e => {
    try { saveGraph({ ...loadGraph(g.id), run: { state: 'failed', error: e.message, nodes: {}, finishedAt: new Date().toISOString() } }) } catch {}
  })
  res.json({ ok: true, started: true })
})

app.post('/api/graphs/:id/stop', (req, res) => {
  res.json({ ok: true, stopped: stopGraph(req.params.id) })
})

// Draft a graph from a sentence.
//
// ⚠️ THIS DRAFTS; IT DOES NOT RUN. One cheap turn, no tools, nothing written —
// the result lands in the editor for the user to read and change, and the graph
// only runs when they press Run. Approval belongs between finished work and an
// irreversible action, not in front of a proposal.
app.post('/api/graphs/draft', async (req, res) => {
  const goal = String(req.body?.goal || '').trim()
  if (!goal) return res.status(400).json({ error: 'Say what you want done first.' })
  const cfg = loadConfig()
  const providerId = req.body?.provider || cfg.settings.defaultProvider
  const model = req.body?.model || cfg.settings.defaultModel
  if (!providerId || !model) return res.status(400).json({ error: 'Pick a model to draft with.' })
  const cred = await graphCreds(providerId)
  if (!cred) return res.status(400).json({ error: `Not signed in to ${providerId}.` })

  const prompt = draftPrompt(goal, String(req.body?.detail || ''), req.body?.cwd || '')
  const controller = new AbortController()
  const attempt = async (extra) => {
    let out = ''
    await runTurn({
      provider: cred.provider,
      model,
      apiKey: cred.apiKey,
      getAccessToken: cred.getAccessToken,
      getAccountId: cred.getAccountId,
      session: { cwd: req.body?.cwd || os.homedir(), messages: [{ role: 'user', text: extra ? `${prompt}\n\n${extra}` : prompt }] },
      useTools: false,
      computerControl: false,
      persona: '',
      skills: [],
      emit: ev => { if (ev.type === 'text_delta') out += ev.text },
      requestApproval: null,
      signal: controller.signal
    })
    return out
  }

  try {
    let draft = readDraft(await attempt())
    // ⚠️ ONE RETRY, WITH THE REASON. A draft that cannot be planned — a cycle, a
    // step depending on nothing that exists — is not a draft. Telling the model
    // exactly what was wrong fixes it far more often than asking again blind.
    if (!draft.ok) draft = readDraft(await attempt(`Your previous reply could not be used: ${draft.reason}\nReply again with JSON only, and make sure no step depends on itself or forms a circle.`))
    if (!draft.ok) return res.status(422).json({ error: draft.reason })
    res.json({ nodes: draft.nodes, tiers: draft.tiers, assumptions: draft.assumptions })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})


/**
 * The pump. Call it once when a loop starts and once after every turn it hands
 * back; it answers with the next turn to run, or with why there isn't one.
 *
 * action: 'work' | 'check' → stream `prompt` into `sessionId`, then call again
 *         'done' | 'failed' | 'idle' → nothing left to run
 */
app.post('/api/loops/:id/advance', async (req, res) => {
  let loop = loadLoop(req.params.id)
  if (!loop) return res.status(404).json({ error: 'No such loop.' })
  if (loop.state !== 'running') return res.json({ loop, action: loop.state === 'done' ? 'done' : loop.state === 'failed' ? 'failed' : 'idle' })

  const finish = (state) => {
    loop.state = state
    loop.finishedAt = new Date().toISOString()
    // A schedule that keeps starting a run that keeps failing is the unbounded
    // bill this app already refuses one layer down. The rule lives in
    // loop-rules.js so it can be tested without a timer.
    Object.assign(loop, afterRun(loop, state))
    loop = saveLoop(loop)
    return res.json({ loop, action: state })
  }

  /** Send the run back to step one carrying why. False when the cap is spent. */
  const startAnotherPass = reason => {
    loop.lastGoalFail = reason
    loop.goalState = null
    loop.goalSessionId = null
    if (loop.pass >= (loop.maxPasses || 1)) return false
    loop.pass++
    loop.currentStep = 0
    loop.steps = resetSteps(loop.steps)
    return true
  }

  // Walk forward: a step may resolve without needing a turn (a command check, no
  // check at all, nothing left to do), and the client should not have to
  // round-trip for that.
  for (let guard = 0; guard < loop.steps.length * 2 + 8; guard++) {
    if (loop.currentStep >= loop.steps.length) {
      // ⚠️ EVERY STEP PASSING IS NOT THE GOAL BEING MET. Without a goal check
      // this is where a loop has always stopped, and it stops on the weakest
      // possible evidence: that the list ran out. A loop can make each unit
      // correct and still have run the wrong units, and no amount of tuning a
      // step can see that, because the fault is not inside any step.
      if (!hasGoalCheck(loop)) return finish('done')

      if (loop.goalState === 'checking') {
        const { pass, reason } = readVerdict(lastAssistantText(loop.goalSessionId))
        if (pass) { loop.lastGoalFail = null; return finish('done') }
        if (!startAnotherPass(reason)) return finish('failed')
        loop = saveLoop(loop)
        continue
      }

      // Deterministic first, exactly as a step does it: the command cannot be
      // talked out of its answer and costs nothing to ask.
      if (loop.goalCommand) {
        const v = readCommandVerdict(await runCheckCommand(loop.goalCommand, loop.cwd))
        if (!v.pass) {
          if (!startAnotherPass(v.reason)) return finish('failed')
          loop = saveLoop(loop)
          continue
        }
      }
      if (!loop.goalCheck) { loop.lastGoalFail = null; return finish('done') }
      loop.goalState = 'checking'
      const session = sessionForGoal(loop)
      loop.goalSessionId = session.id
      loop = saveLoop(loop)
      return res.json({ loop, action: 'check', sessionId: session.id, stepId: null, goal: true, prompt: goalPrompt(loop) })
    }
    const step = loop.steps[loop.currentStep]

    if (step.state === 'pending') {
      step.attempts++
      step.state = 'working'
      step.startedAt = step.startedAt || new Date().toISOString()
      // ⚠️ A RETRY GETS A FRESH CONVERSATION. Reusing the session meant the
      // failed attempt was still in the context, and the model treated its own
      // earlier answer as settled work — the second attempt read as "as I said".
      const session = sessionForStep(loop, step, 'work')
      step.sessionId = session.id
      loop = saveLoop(loop)
      return res.json({ loop, action: 'work', sessionId: session.id, stepId: step.id, prompt: workPrompt(loop, step) })
    }

    if (step.state === 'working') {
      // ⚠️ THE COMMAND GOES FIRST AND THE OPINION GOES LAST. Evidence is not all
      // worth the same: a command that exits 0 settles the question for free,
      // and a model asked afterwards can only agree with it. Running them the
      // other way round means paying for a judgement that a shell was about to
      // overrule.
      if (step.checkCommand) {
        const v = readCommandVerdict(await runCheckCommand(step.checkCommand, loop.cwd))
        if (!v.pass) {
          step.lastFail = v.reason
          if (step.attempts >= step.maxAttempts) {
            step.state = 'failed'
            step.finishedAt = new Date().toISOString()
            return finish('failed')
          }
          // Straight back to the work, with the command's own output as the
          // evidence. No model turn was spent deciding this.
          step.state = 'pending'
          loop = saveLoop(loop)
          continue
        }
      }
      if (!step.check) {
        // A command that passed IS the check — deterministic, and stronger than
        // anything a model was going to say. With neither, the step is done when
        // the turn is done: honest, clearly weaker, and the view says so.
        step.state = 'passed'
        step.lastFail = null
        step.finishedAt = new Date().toISOString()
        loop.currentStep++
        continue
      }
      step.state = 'checking'
      const same = !step.checkAgentId
      const session = same ? loadSession(step.sessionId) : sessionForStep(loop, step, 'check')
      if (!session) { step.state = 'pending'; loop = saveLoop(loop); continue }
      step.checkSessionId = session.id
      loop = saveLoop(loop)
      return res.json({ loop, action: 'check', sessionId: session.id, stepId: step.id, prompt: checkPrompt(loop, step, same) })
    }

    if (step.state === 'checking') {
      const { pass, reason } = readVerdict(lastAssistantText(step.checkSessionId))
      if (pass) {
        step.state = 'passed'
        step.lastFail = null
        step.finishedAt = new Date().toISOString()
        loop.currentStep++
        continue
      }
      step.lastFail = reason
      if (step.attempts >= step.maxAttempts) {
        step.state = 'failed'
        step.finishedAt = new Date().toISOString()
        return finish('failed')
      }
      step.state = 'pending'
      continue
    }

    // passed / failed / skipped — move on.
    if (step.state === 'failed') return finish('failed')
    loop.currentStep++
  }
  // Only reachable if the walk above stopped making progress, which would be a
  // bug here rather than a state a person can get into. Say so instead of looping.
  loop.state = 'blocked'
  loop = saveLoop(loop)
  return res.json({ loop, action: 'blocked', error: 'The loop stopped making progress.' })
})


// `active` reports whether a turn is streaming for this session right now.
// activeTurns is in-memory, so until this landed nothing outside the process
// could tell a working session from an idle one — a status board could list
// every session but not which of them were actually running.
app.get('/api/sessions', (req, res) => res.json(listSessions().map(s => ({ ...s, active: activeTurns.has(s.id) }))))

// Just the live set, for pollers that want a cheap answer rather than every
// session on disk. Reading it costs nothing, so it is safe on a short interval.
app.get('/api/active', (req, res) => res.json({ active: [...activeTurns.keys()], count: activeTurns.size }))

app.post('/api/sessions', (req, res) => {
  const project = req.body.projectId ? getProject(req.body.projectId) : null
  // The project's agent is a DEFAULT, not an override: an explicit agentId on
  // the request still wins, so "new chat with this agent" keeps working inside
  // a project that names a different one.
  const agentId = req.body.agentId || (project && project.agentId) || null
  const agent = agentId ? agentsStore.get(agentId) : null
  const participants = Array.isArray(req.body.participants) ? req.body.participants.filter(id => Boolean(agentsStore.get(id))) : null
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
    // ⚠️ A DEFAULT MODEL NEEDS A DEFAULT PROVIDER. defaultProvider was stored and
    // never read, so a default model had nothing to serve it and fell back to
    // whatever the provider resolution happened to land on.
    provider: req.body.provider || (agent && agent.provider) || (project && project.provider) || config.settings.defaultProvider || null,
    model: req.body.model || (agent && agent.model) || (project && project.model) || config.settings.defaultModel,
    // A project's folder beats the global default — that is most of the point.
    cwd: req.body.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: req.body.useTools !== undefined ? req.body.useTools !== false : (agent ? agent.useTools !== false : true),
    computerControl: req.body.computerControl !== undefined ? Boolean(req.body.computerControl) : Boolean(agent && agent.computerControl),
    // ⚠️ MCP TOOLS ARE A PER-REQUEST COST, NOT A FREE CAPABILITY. One enabled
    // Linear server is 69 tool schemas — 16.6k tokens — sent on EVERY model
    // call of EVERY chat, coding or not. A chat can now opt out; the harness
    // benchmark (scripts/bench-harness.mjs) measures both ways.
    ...(req.body.mcp === false ? { mcp: false } : {}),
    createdAt: new Date().toISOString(),
    messages: []
  }
  saveSession(session)
  res.json(session)
})

// ⚠️ A BRANCH COPIES, IT NEVER MOVES. The original chat is untouched — the whole
// point is to try a different direction without losing the one you have. Copies
// everything that defines how the conversation behaves (agent, model, folder,
// toggles) so the branch runs under the same conditions, and keeps the messages
// up to and including the chosen one.
app.post('/api/sessions/:id/fork', (req, res) => {
  const src = loadSession(req.params.id)
  if (!src) return res.status(404).json({ error: 'not found' })
  const msgs = Array.isArray(src.messages) ? src.messages : []
  const at = Number.isInteger(req.body?.index) ? req.body.index : msgs.length - 1
  if (at < 0 || at >= msgs.length) return res.status(400).json({ error: 'no such message' })

  const branch = {
    ...structuredClone(src),
    id: crypto.randomUUID(),
    title: /\(branch(?: \d+)?\)$/.test(src.title || '') ? src.title : `${src.title || 'Chat'} (branch)`,
    messages: structuredClone(msgs.slice(0, at + 1)),
    forkedFrom: { id: src.id, title: src.title || null, index: at },
    createdAt: new Date().toISOString()
  }
  saveSession(branch)
  res.json(branch)
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
  // ⚠️ skillIds IS PER-CHAT AND DELIBERATE. Until now a skill was either on for
  // every conversation (the Settings checkbox) or bound to an agent — so a skill
  // you want occasionally had to live in every chat's system prompt. This is the
  // third source: skills the user added to THIS chat, and only this chat.
  for (const k of ['title', 'model', 'provider', 'cwd', 'useTools', 'computerControl', 'agentId', 'projectId', 'pinned', 'archived', 'planMode', 'skillIds', 'effort', 'groupFollowUp', 'mcp']) {
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

// ---------- checkpoints (see server/checkpoints.js) ----------
app.get('/api/sessions/:id/checkpoint/diff', async (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  const { from, to, file } = req.query
  if (!from || !to || !file) return res.status(400).json({ error: 'from, to and file are required' })
  try { res.json({ diff: await ckFileDiff(RADIANT_DIR, s.cwd, String(from), String(to), String(file)) }) } catch (e) { res.status(500).json({ error: e.message }) }
})
// ⚠️ UNDO IS ITSELF UNDOABLE. The current state is snapshotted before the
// restore, and the note written into the chat carries that sha, so "undo
// the undo" is one more restore.
app.post('/api/sessions/:id/checkpoint/restore', async (req, res) => {
  const s = loadSession(req.params.id)
  if (!s) return res.status(404).json({ error: 'not found' })
  if (activeTurns.has(s.id)) return res.status(409).json({ error: 'a turn is running — stop it first' })
  const sha = String(req.body?.sha || '')
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return res.status(400).json({ error: 'bad sha' })
  try {
    const r = await ckRestore(RADIANT_DIR, s.cwd, sha)
    const names = r.touched.map(t => t.file)
    const text = `Files restored to the snapshot ${sha.slice(0, 7)}${names.length ? ` — ${names.length} file${names.length === 1 ? '' : 's'} changed: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}` : ' (nothing differed)'}.`
    s.messages.push({ role: 'assistant', model: 'radiant', parts: [{ type: 'notice', text }], restore: { to: sha, safety: r.safety, touched: r.touched.slice(0, 200) } })
    saveSession(s)
    res.json({ ok: true, touched: r.touched, safety: r.safety, session: s })
  } catch (e) { res.status(500).json({ error: e.message }) }
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

// A turn that THROWS must leave its reason in the transcript, not only in a
// banner. Notices and halts were made to survive the stream closing (see the
// emit wrapper in providers.js), but a top-level throw — a local model
// erroring, its chat template breaking on tool results, the context
// overflowing — became a transient `error` event that the client showed as a
// banner and never wrote into the assistant message. On the next reload the
// chat showed an empty bubble with no explanation. That IS the "chats die
// mid-turn with no warning" class Tony keeps hitting on local models. Persist
// the reason as a halt (the shape the client already renders prominently, with
// a Continue button) BEFORE the finally saves the session, then emit it live.
// The banner still fires too, for immediate feedback.
function recordTurnFailure (session, emit, message) {
  let assistant = session.messages[session.messages.length - 1]
  if (!assistant || assistant.role !== 'assistant') {
    assistant = { role: 'assistant', parts: [] }
    session.messages.push(assistant)
  }
  if (!Array.isArray(assistant.parts)) assistant.parts = []
  assistant.parts.push({ type: 'halt', reason: 'error', text: message })
  emit({ type: 'halt', reason: 'error', text: message })
  emit({ type: 'error', message })
}

// ⚠️ BACKGROUND WORK MUST NOT COST FLAGSHIP PRICES, AND MUST NOT BE INVISIBLE.
// Every turn quietly fires three or four MORE model calls — name the chat,
// extract durable facts, draft a skill proposal, summarize for compaction —
// and each one ran on the CHAT'S model with an emit that collected only
// text_delta. So grok-4.6 was being paid top rates to write a one-line note to
// itself, and none of it reached the session's token count: spend that was
// both needlessly expensive AND unmeasurable. Tony: "that will kill this
// product if its burning tokens for no reason."
//
// These are small summarisation jobs. A cheap model does them just as well, so
// one is chosen from the models the chat's OWN provider already offers — the
// key is known to work and no second account is needed. The pick is
// data-driven rather than a hardcoded id, because a wrong id would silently
// stop titles and memory from working at all.
/** Failed tool calls and the call that followed each — the shape a lesson has. */
function troubleLog (parts) {
  const tools = parts.filter(p => p.type === 'tool')
  const lines = []
  tools.forEach((p, i) => {
    const r = String(p.result ?? '')
    if (!(p.denied || /\b(error|failed|not found|no such|cannot|exit code [1-9]|ENOENT|EACCES|Traceback)\b/i.test(r.slice(0, 400)))) return
    const head = t => `${t.name}(${String(t.args?.command || t.args?.path || t.args?.url || '').slice(0, 120)}) → ${String(t.result ?? '').replace(/\s+/g, ' ').slice(0, 160)}`
    lines.push('FAILED ' + head(p))
    if (tools[i + 1]) lines.push('  then ' + head(tools[i + 1]))
    if (lines.length >= 8) return
  })
  return lines.slice(0, 8).join('\n')
}

const UTILITY_HINTS = [/haiku/i, /flash[-_ ]?lite/i, /\bnano\b/i, /\bmini\b/i, /flash/i, /\blite\b/i, /\bsmall\b/i, /\b[0-4](?:\.\d)?b\b/i]
// ⚠️ NAMES ARE NOT PRICES. The hints above found nothing on xAI (no model is
// called mini) and on OpenRouter would have taken the first "haiku" in the
// catalogue — Claude 3 Haiku, from 2024. Per provider, the models that ARE
// the cheap fast lane, checked against the price lists on 2026-09-18 and
// listed cheapest-first; the first one the account can see wins.
//   xAI: 4.20 non-reasoning and 4.3 are $1.25/$2.50 per M against 4.6's
//   $2/$6, and non-reasoning skips the thinking step, so it is faster too.
//   OpenRouter: gpt-5-mini $0.25/$2, gemini-3.5-flash-lite $0.15/$1.25,
//   haiku 4.5 $1/$5. Fine for an easy message; a tenth of Opus's $5/$25.
const UTILITY_PREFERRED = {
  xai: [/^grok-4\.20-.*non-reasoning$/i, /^grok-4\.3$/i],
  openrouter: [/^openai\/gpt-5-mini$/i, /^google\/gemini-3\.5-flash-lite$/i, /^anthropic\/claude-haiku-4\.5$/i, /^google\/gemini-3\.[5-9]-flash$/i]
}
const utilityCache = new Map()   // providerId -> { at, model }

async function pickUtilityModel (provider, sessionModel) {
  // An explicit choice always wins; Settings → Models shows what is in use.
  const set = config.settings.utilityModel
  if (set && set.model) return { provider: config.providers.find(p => p.id === set.provider) || provider, model: set.model }
  const hit = utilityCache.get(provider.id)
  if (hit && Date.now() - hit.at < 600_000) return { provider, model: hit.model || sessionModel }
  let chosen = null
  try {
    const hasOAuth = Boolean(config.oauth[provider.id])
    const accessToken = hasOAuth ? await validAccessToken(provider.id, config, saveConfig).catch(() => null) : null
    const models = await listModels(provider, config.keys[provider.id], accessToken, hasOAuth ? config.oauth[provider.id]?.accountId : null)
    const ids = (models || []).map(m => m.id)
    for (const rx of (UTILITY_PREFERRED[provider.id] || [])) { const m = ids.find(id => rx.test(id)); if (m) { chosen = m; break } }
    if (!chosen) for (const rx of UTILITY_HINTS) { const m = ids.find(id => rx.test(id)); if (m) { chosen = m; break } }
  } catch {}
  utilityCache.set(provider.id, { at: Date.now(), model: chosen })
  return { provider, model: chosen || sessionModel }
}

/**
 * One small model call for Radiant's own housekeeping. Returns the text, never
 * throws, and ADDS ITS TOKENS to the session so the counter tells the truth
 * about what the chat cost — under their own heading, because they are not
 * what the user asked for.
 */
async function utilityTurn ({ provider, apiKey, session, tmp, signal }) {
  const { provider: up, model } = await pickUtilityModel(provider, session.model)
  const hasOAuth = Boolean(config.oauth[up.id])
  let out = ''
  const count = ev => {
    if (ev.type === 'usage') {
      const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
      st.bgIn = (st.bgIn || 0) + (ev.input || 0)
      st.bgOut = (st.bgOut || 0) + (ev.output || 0)
      st.bgCalls = (st.bgCalls || 0) + (ev.input ? 1 : 0)
    }
    if (ev.type === 'text_delta') out += ev.text
  }
  const run = async m => runTurn({
    provider: up, model: m, apiKey: config.keys[up.id] || apiKey,
    getAccessToken: hasOAuth ? () => validAccessToken(up.id, config, saveConfig) : null,
    getAccountId: hasOAuth ? () => config.oauth[up.id]?.accountId || null : null,
    session: tmp, useTools: false, computerControl: false, persona: '', skills: [],
    emit: count, requestApproval: null, signal
  })
  try { await run(model) } catch {
    // ⚠️ A CHEAP MODEL THAT IS NOT ON THIS ACCOUNT MUST NOT KILL THE FEATURE.
    // Falling back once keeps titles and memory working rather than quietly
    // disappearing, which is how a cost optimisation becomes a bug report.
    if (model !== session.model) { out = ''; try { await run(session.model) } catch {} }
  }
  return out
}

// ⚠️ AND AN ABORTED TURN IS THE SAME CLASS OF SILENCE. recordTurnFailure above
// only runs when the turn THREW; every `emit` of a 'stopped' event is dropped
// on the floor because the emit wrapper in providers.js persists only notices
// and halts. So a turn killed by the connection going away — the window
// closed, the app quit, the network blinked, the user pressed Stop — saved an
// assistant message with ZERO parts, and the chat showed an empty reply with
// no explanation. That is the same thing Tony keeps reporting, arriving by a
// different route: session e0b6fae9 had three of them (messages 5, 7 and 31),
// none carrying a word about what happened.
//
// A dropped connection and a deliberate Stop are different sentences, so the
// stop route marks which one it was. Nothing is emitted here — for a drop the
// response is already gone — it is written into the transcript, which is the
// only place that survives.
function recordTurnStopped (session, { byUser }) {
  // The board hears about it too — a task whose run was stopped or dropped is
  // not still Working. (Nothing else is emitted on this path; see above.)
  reflectTaskState(session.id, { type: 'stopped' })
  const assistant = session.messages[session.messages.length - 1]
  if (!assistant || assistant.role !== 'assistant') return
  if (!Array.isArray(assistant.parts)) assistant.parts = []
  if (assistant.parts.some(p => p.type === 'halt' || (p.type === 'notice' && p.text === 'Stopped.'))) return
  assistant.parts.push(byUser
    ? { type: 'notice', text: 'Stopped.' }
    : { type: 'halt', reason: 'dropped', text: 'The connection to this turn dropped before it finished — the window was closed, the app quit, or the network went away. Anything the agent had already done is saved above. Press Continue to carry on from here.' })
}

// ---------- chat (SSE) ----------
app.post('/api/chat', async (req, res) => {
  config = loadConfig() // see the latest keys/oauth before the turn
  // ⚠️ A SLASH SKILL APPLIES TO THE MESSAGE THAT CARRIES IT. Hermes and Claude
  // Code both work this way: the command goes into the box, and sending it is
  // what invokes the skill. Radiant attached the skill to the whole chat
  // instead, silently, which is why Tony could not tell whether anything had
  // happened. skillIds here is per-turn; session.skillIds still exists for a
  // skill deliberately pinned to a conversation.
  const { sessionId, content, skillIds: turnSkillIds, messageId: rawMessageId } = req.body
  const session = loadSession(sessionId)
  if (!session) return res.status(404).json({ error: 'session not found' })
  // ⚠️ ONE MESSAGE, ONE REPLY. The client names each message it sends, and a
  // name already in this chat — saved, or the one running right now — is the
  // same message arriving twice: a retried request, a voice delegation handed
  // over again. Answering it would run the whole turn a second time (the same
  // edits, the same commands). Idea from unreal-agent's inbox (MIT).
  const messageId = typeof rawMessageId === 'string' && /^[\w:.-]{1,100}$/.test(rawMessageId) ? rawMessageId : null
  if (messageId && (activeTurns.get(sessionId)?.messageId === messageId || session.messages.some(m => m.role === 'user' && m.id === messageId))) {
    return res.status(409).json({ error: 'That message was already received.', duplicate: true })
  }
  if (activeTurns.has(sessionId)) return res.status(409).json({ error: 'a turn is already running' })
  // ⚠️ CLAIM THE CHAT NOW, not after the skill and MCP choices below. Those
  // wait on the network, and a second send in that gap (phone and Mac on one
  // chat, or a retried request) also passed the check above — two turns ran on
  // two copies of the chat and the last save erased the other's whole turn.
  const controller = new AbortController()
  activeTurns.set(sessionId, { controller, messageId })

  // agent (persona + its skills) plus globally-enabled skills
  const agent = session.agentId ? agentsStore.get(session.agentId) : null

  // Live relay: some agents bridge to a real external agent (e.g. Hermes) with its
  // own model, skills, and memory. They need no Radiant provider — stream the
  // external agent's reply straight through and skip provider/skills/mcp/runTurn.
  if (agent && agent.relay === 'hermes') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const emit = ev => { reflectTaskState(sessionId, ev); res.write(`data: ${JSON.stringify(ev)}\n\n`) }
    const text = typeof content === 'string' ? content : (content.text || '')
    const attachments = (typeof content === 'object' && content.attachments) || []
    session.messages.push({ role: 'user', text, attachments, ...(messageId ? { id: messageId } : {}) })
    if (session.messages.length === 1 && session.autoTitle !== false) {
      session.title = text.length > 48 ? text.slice(0, 48) + '…' : (text || `${attachments.length} file(s)`)
      session.autoTitle = true
      emit({ type: 'title', title: session.title })
    }
    saveTurnSession(session)
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    const stopHeartbeat = startHeartbeat(res)
    const assistant = { role: 'assistant', parts: [] }
    if (agent.id) assistant.agentId = agent.id
    session.messages.push(assistant)
    try {
      const reply = await runHermesRelay({ text, emit, signal: controller.signal, session })
      if (reply) assistant.parts.push({ type: 'text', text: reply })
      emit({ type: 'done' })
    } catch (e) {
      if (!controller.signal.aborted) recordTurnFailure(session, emit, e.message)
    } finally {
      stopHeartbeat()
      if (controller.signal.aborted) recordTurnStopped(session, { byUser: Boolean(activeTurns.get(sessionId)?.stoppedByUser) })
      activeTurns.delete(sessionId)
      saveTurnSession(session)
      emit({ type: 'closed' })
      res.end()
    }
    return
  }

  let provider = config.providers.find(p => p.id === session.provider)
  if (!provider) { activeTurns.delete(sessionId); return res.status(400).json({ error: 'Pick a model first — no provider set on this session.' }) }
  // Qwen's OAuth token names the API host to use; honour it over the default.
  if (provider.id === 'qwen' && config.oauth.qwen?.apiBase) provider = { ...provider, baseUrl: config.oauth.qwen.apiBase }
  const apiKey = config.keys[provider.id]
  const hasOAuth = Boolean(config.oauth[provider.id])
  if (provider.auth === 'key' && !apiKey && !hasOAuth) { activeTurns.delete(sessionId); return res.status(400).json({ error: `No API key or subscription sign-in for ${provider.name}. Add one in Settings.` }) }

  // agent (persona + its skills, resolved above) plus globally-enabled skills
  const allSkills = skillsStore.list()
  const agentSkillIds = new Set(agent?.skills || [])
  // Three sources now: on for everything, carried by the agent, or added to this
  // chat with a slash command.
  const chatSkillIds = new Set([
    ...(Array.isArray(session.skillIds) ? session.skillIds : []),
    ...(Array.isArray(turnSkillIds) ? turnSkillIds : [])
  ])
  // ⚠️ EVERY DECISION IS KEPT WITH THE REPLY, probabilities and all, so it can
  // be replayed: change a bar, re-read the transcripts, see which messages
  // would have gone the other way — no new calls (scripts/replay-decisions.mjs).
  // AgentRun keeps its Jev answers with each case for the same reason.
  const decided = {}
  let mergedSkills = allSkills.filter(s => s.enabled || agentSkillIds.has(s.id) || chatSkillIds.has(s.id))
  // ⚠️ ALWAYS-ON SKILLS RIDE ONLY WHEN THE MESSAGE NEEDS THEM (decide.js
  // chooseSkills). Sticky per chat, so the cached system prefix grows and
  // never churns. Agent skills and slash skills were chosen on purpose and
  // always go. The model is told what it was not handed, below.
  let skillsSkipped = []
  if (config.settings.smartTools !== false && config.keys.openrouter && !session.group) {
    try {
      const { chooseSkills, decide } = await import('./decide.js')
      const text0 = typeof content === 'string' ? content : (content?.text || '')
      const judged = new Set(mergedSkills.filter(s => s.enabled && !agentSkillIds.has(s.id) && !chatSkillIds.has(s.id)).map(s => s.id))
      const sticky = new Set(Array.isArray(session.skillsAttached) ? session.skillsAttached : [])
      const pick = await chooseSkills({ message: text0, history: session.messages, skills: mergedSkills, judged, sticky, decideFn: decide, apiKey: config.keys.openrouter, sessionId })
      if (pick.decided) {
        decided.skills = { probs: pick.probs, attached: [...pick.attach], bar: 0.35 }
        mergedSkills = mergedSkills.filter(s => pick.attach.has(s.id))
        skillsSkipped = pick.skipped
        session.skillsAttached = [...new Set([...sticky, ...mergedSkills.filter(s => judged.has(s.id)).map(s => s.id)])]
        if (skillsSkipped.length) console.log('[skills] left off this turn:', skillsSkipped.map(s => `${s.name} (${Math.round(s.p * 100)}%)`).join(', '))
      }
    } catch (e) { console.error('[skills]', e.message) }
  }

  // MCP tools from enabled servers, bridged into the tool set
  let mcpTools = []
  let callMcp = null
  let mcpSkipped = []   // servers left off this turn, named to the model below
  if (session.mcp !== false && (config.mcpServers || []).some(s => s.enabled)) {
    try {
      const mcp = await import('./mcp.js')
      mcpTools = await mcp.mcpToolDefs(config.mcpServers)
      callMcp = (name, args) => mcp.callMcpTool(name, args, config.mcpServers)
      // ⚠️ ATTACH ONLY WHAT THE MESSAGE NEEDS. One enabled server is 16.6k
      // tokens of schema on every call of every chat. Jev (server/decide.js)
      // answers "does this message need Linear?" in ~300 ms for a fraction of
      // a cent; unreachable or switched off, everything is attached as before.
      if (config.settings.smartTools !== false && config.keys.openrouter) {
        const { chooseMcpServers, decide } = await import('./decide.js')
        const toolsByServer = {}
        for (const t of mcpTools) {
          const hit = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(t.name)
          if (hit) (toolsByServer[hit[1]] ||= []).push(t.name)
        }
        const text0 = typeof content === 'string' ? content : (content?.text || '')
        const pick = await chooseMcpServers({ message: text0, history: session.messages, servers: config.mcpServers, toolsByServer, decideFn: decide, apiKey: config.keys.openrouter, sessionId })
        if (pick.decided) {
          decided.mcp = { probs: pick.probs, attached: [...pick.attach], bar: 0.35 }
          mcpTools = mcpTools.filter(t => { const h = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(t.name); return !h || pick.attach.has(h[1]) })
          mcpSkipped = pick.skipped
          const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
          st.decisions = (st.decisions || 0) + 1
          st.decisionCost = (st.decisionCost || 0) + (pick.usage?.cost || 0)
          if (mcpSkipped.length) console.log('[mcp] left off this turn:', mcpSkipped.map(s => `${s.name} (${Math.round(s.p * 100)}%)`).join(', '))
        }
      }
    } catch (e) { console.error('[mcp]', e.message) }
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const emit = ev => { reflectTaskState(sessionId, ev); res.write(`data: ${JSON.stringify(ev)}\n\n`) }

  // content is either a string or { text, attachments:[{name,mime,dataB64,kind}] }
  const text = typeof content === 'string' ? content : (content.text || '')
  const attachments = (typeof content === 'object' && content.attachments) || []
  const spoken = typeof content === 'object' && Boolean(content.voice)
  session.messages.push({ role: 'user', text, attachments, ...(spoken ? { voice: true } : {}), ...(messageId ? { id: messageId } : {}) })
  if (session.messages.length === 1 && session.autoTitle !== false) {
    // instant placeholder; upgraded to a nicer title after the turn (see below)
    session.title = text.length > 48 ? text.slice(0, 48) + '…' : (text || `${attachments.length} file(s)`)
    session.autoTitle = true
    emit({ type: 'title', title: session.title })
  }
  saveTurnSession(session)

  // res 'close' fires on client disconnect (req 'close' fires once the body is
  // consumed in modern Node, which would abort the turn immediately)
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  const stopHeartbeat = startHeartbeat(res)

  // ⚠️ THE FAST LANE (server/fastlane.js): a closed list of read-only lookups
  // answered by a tool in well under a second, no model. Jev classifies the
  // message; only a confident match takes it. The reply is marked `lane` so
  // the label says "instant" and the transcript says how to get the model.
  if (config.settings.fastLane !== false && config.keys.openrouter && !session.group && !session.planMode) {
    try {
      const { classifyLookup, runLookup, LANE_NOTE } = await import('./fastlane.js')
      const { decide } = await import('./decide.js')
      const hasLinear = mcpTools.some(t => /get_issue$/.test(t.name))
      const c = await classifyLookup({ message: text, attachments, history: session.messages, hasLinear, decideFn: decide, apiKey: config.keys.openrouter, sessionId, signal: controller.signal })
      if (c.probs || c.p != null) decided.lane = { choice: c.choice, confidence: c.confidence, probs: c.probs, took: c.lane, bar: 0.85 }
      if (c.lane !== 'none') {
        const t0 = Date.now()
        const body = await runLookup(c.lane, { cwd: session.cwd, message: text, session, provider, callMcp, mcpTools })
        if (body) {
          console.log(`[lane] ${c.lane} (${Math.round(c.p * 100)}%) in ${Date.now() - t0} ms`)
          const assistant = { role: 'assistant', model: session.model, lane: c.lane, decisions: decided, parts: [{ type: 'text', text: body }, { type: 'notice', text: LANE_NOTE }] }
          if (session.agentId) assistant.agentId = session.agentId
          session.messages.push(assistant)
          const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
          st.turns += 1; st.decisions = (st.decisions || 0) + 1; st.lane = (st.lane || 0) + 1
          emit({ type: 'text_delta', text: body })
          emit({ type: 'notice', text: LANE_NOTE })
          emit({ type: 'done' })
          stopHeartbeat()
          activeTurns.delete(sessionId)
          saveTurnSession(session)
          emit({ type: 'closed' })
          res.end()
          return
        }
      }
    } catch (e) { console.error('[lane]', e.message) }
  }

  const requestApproval = call => new Promise(async resolve => {
    // approval mode: 'ask' = confirm every command, 'auto' = only risky ones, 'off' = never
    const mode = config.settings.approvalMode || (config.settings.approveCommands === false ? 'off' : 'ask')
    if (mode === 'off') return resolve(true)
    // in Auto mode, run low-risk shell commands silently (a quick notice); still ask
    // for risky commands and always for MCP / desktop control.
    let reason = null
    if (mode === 'auto' && call.name === 'run_command' && commandRisk(call.args?.command) === 'low') {
      // ⚠️ THE RULES SAY LOW; JEV GETS A SECOND LOOK (decide.js assessCommand).
      // It can only turn a silent run into a question, never the reverse.
      if (config.settings.smartTools !== false && config.keys.openrouter) {
        try {
          const { assessCommand, RISK_BAR, decide } = await import('./decide.js')
          const v = await assessCommand({ command: call.args.command, cwd: session.cwd, userText: text, decideFn: decide, apiKey: config.keys.openrouter, sessionId, signal: controller.signal })
          if (v.decided && v.risk >= RISK_BAR) { reason = v.reasons.join(', '); console.log(`[auto] asking instead of running: ${call.args.command} — ${reason}`) }
        } catch {}
      }
      if (!reason) {
        emit({ type: 'notice', text: `Ran: ${call.args.command}` })
        return resolve(true)
      }
    }
    // The client that would answer this is already gone. Waiting out the full
    // 10 minutes here kept activeTurns occupied that whole time, so a dropped
    // connection left the session showing "a turn is already running" for up to
    // 10 minutes even after recordTurnStopped had already offered Continue.
    if (controller.signal.aborted) return resolve(false)
    pendingApprovals.set(call.id, resolve)
    emit({ type: 'approval_request', id: call.id, name: call.name, args: call.args, ...(reason ? { reason } : {}) })
    const timer = setTimeout(() => {
      if (pendingApprovals.delete(call.id)) resolve(false)
    }, 10 * 60 * 1000)
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      if (pendingApprovals.delete(call.id)) resolve(false)
    }, { once: true })
  })

  // pause the turn and ask the user a multiple-choice question (ask_user tool)
  const requestUserChoice = (question, options) => new Promise(resolve => {
    if (controller.signal.aborted) return resolve('(no answer — the connection dropped)')
    const id = crypto.randomUUID()
    pendingQuestions.set(id, resolve)
    emit({ type: 'question_request', id, question, options: Array.isArray(options) ? options : [] })
    const timer = setTimeout(() => { if (pendingQuestions.delete(id)) resolve('(no answer — the user did not respond in time)') }, 10 * 60 * 1000)
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      if (pendingQuestions.delete(id)) resolve('(no answer — the connection dropped)')
    }, { once: true })
  })

  // let this agent consult the OTHER agents (peers) via the ask_agent tool
  const peers = agentsStore.list().filter(a => a.id !== session.agentId)
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

  // Read-only research subagents (the `research` tool; TG-514). Each question
  // is its own sub-turn on the cheap model with its own context and only
  // read_file + read-only run_command; they run in parallel, and only the
  // answers come back into the main turn's context.
  const research = async questions => {
    const qs = (Array.isArray(questions) ? questions : [questions]).map(q => String(q || '').trim()).filter(Boolean).slice(0, 5)
    if (!qs.length) return { text: 'Provide at least one question to research.', subagents: [] }
    const { provider: up, model: cheap } = await pickUtilityModel(provider, session.model)
    const upKey = config.keys[up.id] || apiKey
    const upOAuth = Boolean(config.oauth[up.id])
    emit({ type: 'notice', text: `Researching ${qs.length === 1 ? 'one question' : `${qs.length} questions`} in parallel on ${cheap}…` })
    const persona = `You are a research subagent. Another agent handed you ONE question about the code in this workspace and will read your answer without seeing anything you read, so make it self-contained. Find the answer by reading — read_file, and read-only commands such as grep, rg, find, ls, git log, git grep. Be economical: a few targeted reads, not the whole tree. Then reply in this shape:

Answer: the answer in plain words, with file paths and line numbers where you can.

Files that matter:
- path/to/file.js:LINE — one line on why this file matters to the question

If you could not find it, say so plainly and say where you looked. Do not guess beyond what you read.`
    const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
    const runOne = async (question, model) => {
      const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: question }] }
      const sub = { question, model, inTokens: 0, outTokens: 0, cachedIn: 0, rounds: 0, tools: 0, ms: 0 }
      let answer = ''
      const t0 = Date.now()
      await runTurn({
        provider: up, model, apiKey: upKey,
        getAccessToken: upOAuth ? () => validAccessToken(up.id, config, saveConfig) : null,
        getAccountId: upOAuth ? () => config.oauth[up.id]?.accountId || null : null,
        session: tmp, useTools: true, readOnly: true, maxRounds: 15, computerControl: false,
        persona, skills: [],
        emit: ev => {
          if (ev.type === 'usage') { sub.inTokens += ev.input || 0; sub.outTokens += ev.output || 0; sub.cachedIn += ev.cacheRead || 0 }
          if (ev.type === 'round_start') sub.rounds += 1
          if (ev.type === 'tool_start') sub.tools += 1
          if (ev.type === 'text_delta') answer += ev.text
        },
        requestApproval: null, signal: controller.signal
      })
      sub.ms = Date.now() - t0
      sub.answer = answer.trim()
      return sub
    }
    const results = await Promise.all(qs.map(async question => {
      try { return await runOne(question, cheap) } catch (e) {
        if (controller.signal.aborted) return { question, model: cheap, error: 'the turn was interrupted', inTokens: 0, outTokens: 0, ms: 0 }
        // ⚠️ THE CHEAP MODEL NOT BEING ON THIS ACCOUNT MUST NOT KILL THE
        // FEATURE — the same fallback utilityTurn makes. One retry on the
        // chat's own model; a second failure is reported, not hidden.
        if (cheap !== session.model) {
          try { return await runOne(question, session.model) } catch (e2) { e = e2 }
        }
        emit({ type: 'notice', text: `A research subagent failed: ${e.message}` })
        return { question, model: cheap, error: e.message, inTokens: 0, outTokens: 0, ms: 0 }
      }
    }))
    // Counted into the session under their own heading — like housekeeping,
    // they are real spend that is not the chat's own model.
    for (const r of results) { st.researchIn = (st.researchIn || 0) + (r.inTokens || 0); st.researchOut = (st.researchOut || 0) + (r.outTokens || 0); st.researchCalls = (st.researchCalls || 0) + (r.error ? 0 : 1) }
    const text = results.map((r, i) => `### ${i + 1}. ${r.question}
${r.error ? `(no answer: ${r.error})` : (r.answer || '(the subagent returned nothing)')}`).join('\n\n')
    return { text, subagents: results.map(({ answer, ...rest }) => rest) }
  }

  // one-shot summarizer used by auto-compaction (runs on the session's model, no tools)
  const summarize = async text => {
    const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `Summarize this conversation so it can continue without losing context. Preserve: decisions made, files created or edited, the current task and its state, and any open questions or next steps. Be concise but complete; use short bullet points.\n\n${text}` }] }
    // housekeeping runs on a cheap model and IS counted — see utilityTurn
    return await utilityTurn({ provider, apiKey, session, tmp, signal: controller.signal })
  }

  const memoryOn = config.settings.memory !== false
  const memory = memoryOn ? await relevantFacts(text, session.cwd) : []

  // lead/worker: if this agent has a planner model, have the (stronger) lead model
  // outline the approach first; the (session) model then executes it.
  //
  // ⚠️ THE PLAN TEXT IS PER-TURN, THE PERSONA ISN'T. `plan` is regenerated fresh
  // from `text` (this turn's request) every time this branch runs, so it must
  // travel to providers.js as `planAddendum` (the volatile half of the system
  // prompt), not folded into `persona` (the stable half) — see providers.js's
  // systemPrompt() comment. Folding it into persona was the original prompt-
  // caching bug: it made the "stable" system block change on every turn a
  // plannerModel was configured.
  const basePersona = agent?.persona || ''
  let planAddendum = ''
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
      if (plan.trim()) planAddendum = `[A lead model has planned the approach below — follow it, adapting as needed:]\n${plan.trim()}`
    }
  }
  // Spoken in, spoken out: the reply is read aloud, so it has to lead with a
  // sentence. Volatile, so it travels with the plan text, not the persona.
  if (spoken) planAddendum = planAddendum ? `${planAddendum}\n\n${VOICE_ADDENDUM}` : VOICE_ADDENDUM
  // The model must know a server exists that it was not handed, or it will say
  // "I have no access to Linear" to someone who set Linear up an hour ago.
  if (mcpSkipped.length) {
    const line = `MCP tools not attached to this message (judged not needed): ${mcpSkipped.map(s => s.name).join(', ')}. If the task turns out to need one, say so plainly and ask the user to send the request again naming it.`
    planAddendum = planAddendum ? `${planAddendum}\n\n${line}` : line
  }
  if (skillsSkipped.length) {
    const line = `Skills the user has on but not loaded for this message (judged not needed): ${skillsSkipped.map(s => s.name).join(', ')}. If one turns out to apply, say so and ask the user to send the message again with /${skillsSkipped[0].name.toLowerCase().replace(/\s+/g, '-')} or the skill named.`
    planAddendum = planAddendum ? `${planAddendum}\n\n${line}` : line
  }

  // ⚠️ WHICH MODEL ANSWERS THIS MESSAGE. Easy messages go to a fast model on
  // the same provider (server/decide.js chooseModel: Jev with a key, a cheap
  // model as the judge without one, off with neither). The reply carries
  // `routed` so the transcript says who answered and why. Same provider only:
  // the request below is built for THIS provider's auth.
  let turnModel = session.model
  let routed = null
  // Jev Router already picks the model for each message; routing it again would pick for the picker.
  if (config.settings.smartRouting !== false && !session.group && !session.planMode && !agent?.model && session.model !== JEV_ROUTER) {
    try {
      const { chooseModel, decide } = await import('./decide.js')
      const fast = await pickUtilityModel(provider, session.model)
      const fastModel = fast.provider.id === provider.id ? fast.model : null
      const judgeFn = config.keys.openrouter ? null : async (state, q) => {
        const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `You are sorting one chat message by difficulty. ${q.instructions}\n\nEASY means: ${q.criteria.true}\nHARD means: ${q.criteria.false}\n\nEarlier messages (context only):\n${state.earlier_messages.map(m => '- ' + m).join('\n') || '(none)'}\n\nLatest message:\n${state.latest_message}\n\nAnswer with exactly one word: EASY or HARD.` }] }
        const out = await utilityTurn({ provider, apiKey, session, tmp, signal: controller.signal })
        return /^\s*easy\b/i.test(out) ? 0.9 : /^\s*hard\b/i.test(out) ? 0.1 : null
      }
      const pick = await chooseModel({ message: text, attachments, history: session.messages, sessionModel: session.model, fastModel, planMode: session.planMode, group: session.group, agentModel: agent?.model, decideFn: decide, judgeFn, apiKey: config.keys.openrouter, sessionId, signal: controller.signal })
      if (pick.p != null) {
        const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
        st.decisions = (st.decisions || 0) + 1
        decided.route = { p: pick.p, judge: pick.judge, routed: pick.routed, from: session.model, to: pick.model, bar: 0.8 }
      } else decided.route = { reason: pick.reason }
      if (pick.routed) { turnModel = pick.model; routed = { from: session.model, p: pick.p, judge: pick.judge } }
      console.log(`[route] ${pick.routed ? `${session.model} → ${pick.model}` : `kept ${session.model}`} · ${pick.reason}${pick.p != null ? ` (${Math.round(pick.p * 100)}% easy, ${pick.judge})` : ''}${fastModel ? '' : ' · no fast model on ' + provider.id}`)
    } catch (e) { console.error('[route]', e.message) }
  }

  // ⚠️ A SNAPSHOT BEFORE THE TURN, so the reply's changes can be undone
  // (server/checkpoints.js). Not the home folder; not a folder that proved
  // slow. `session.checkpointNote` is set once so the chat says why not.
  let ckBefore = null
  if (config.settings.checkpoints !== false) {
    const el = ckEligible(session.cwd)
    if (el.ok) { const r = await ckSnapshot(RADIANT_DIR, session.cwd, 'before turn'); ckBefore = r?.sha || null }
    else if (!session.checkpointNote && session.messages.filter(m => m.role === 'user').length === 1) { session.checkpointNote = el.reason }
  }

  // the reply-vs-evidence check, when there is a key to ask with
  let verifyClaims = null
  if (config.settings.verifyClaims !== false && config.keys.openrouter) {
    const { verifyClaims: vc, decide } = await import('./decide.js')
    verifyClaims = async ({ text, toolParts }) => {
      const v = await vc({ text, toolParts, decideFn: decide, apiKey: config.keys.openrouter, sessionId, signal: controller.signal })
      if (v) (decided.claims ||= []).push({ claims: v.claims, unsupported: v.unsupported, bars: { claim: 0.6, support: 0.3 } })
      return v
    }
  }

  // The workspace's own rules file(s), loaded into every turn unless turned off.
  // Announced once per session (again only if the folder — and its rules — change),
  // so it is not a per-turn line in the transcript.
  const projectRules = (config.settings.projectRules !== false && session.useTools !== false && !session.group)
    ? loadProjectRules(session.cwd)
    : null
  if (projectRules && projectRules.files.length) {
    const sig = projectRules.files.join(',')
    if (rulesNoticed.get(sessionId) !== sig) {
      rulesNoticed.set(sessionId, sig)
      emit({ type: 'notice', text: `Loaded this project's rules from ${projectRules.files.join(', ')} — the agent will follow them here.` })
    }
  }

  const common = {
    provider,
    model: turnModel,
    routed,
    verifyClaims,
    apiKey,
    getAccessToken: hasOAuth ? () => validAccessToken(provider.id, config, saveConfig) : null,
    getAccountId: hasOAuth ? () => config.oauth[provider.id]?.accountId || null : null,
    session,
    memory,
    summarize,
    autoCompact: config.settings.autoCompact !== false,
    // Per-turn spend budget (tokens). The turn runs to completion unless it
    // reaches this, then it pauses and asks. undefined = the built-in default;
    // 0 = no budget (run to completion). Settings → Models → Long builds.
    turnTokenBudget: Number.isFinite(Number(config.settings.turnTokenBudget)) ? Number(config.settings.turnTokenBudget) : undefined,
    // The workspace's own rules file(s) — AGENTS.md/CLAUDE.md/.clinerules — loaded
    // into the prompt so the agent follows the project's conventions. On unless
    // turned off, and only when the chat has a real project folder.
    projectRules,
    // How much of a local model's context Radiant will fill before it trims.
    // 0 means "use whatever Ollama loaded it with". See LOCAL_CONTEXT_DEFAULT.
    localContext: Number.isFinite(Number(config.settings.localContext)) ? Number(config.settings.localContext) : undefined,
    autoApproveComputer: config.settings.fullAutomation === true,
    cachingEnabled: config.settings.promptCaching !== false,
    cacheTtl: config.settings.cacheTtl === '1h' ? '1h' : '5m',
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
      const names = participants.map(id => agentsStore.get(id)?.name).filter(Boolean)
      const groupNames = Object.fromEntries(participants.map(id => [id, agentsStore.get(id)?.name || 'Agent']))
      // @Name picks who ACTS this turn — with tools; @others sweeps the rest in
      // to RE-PLAN, without. See group.js for why those must not read alike.
      const addr = addressing(text, participants.map(id => ({ id, name: groupNames[id] })))
      const named = addr.named
      // ⚠️ THE ROOM OPTION, issue #18. iandouglas: "when sending output from one
      // agent to another, ask that second agent to evaluate if its previous
      // work/planning needs to change." With it on, naming one agent sweeps the
      // rest in automatically — the same thing typing @others does by hand, so
      // there is one behaviour to understand rather than two.
      const auto = Boolean(session.groupFollowUp) && named.length > 0
      const swept = addr.swept.length
        ? addr.swept
        : (auto ? participants.filter(id => !named.includes(id) && !addr.excluded.includes(id)) : [])
      const speakers = (named.length || swept.length) ? [...named, ...swept] : participants
      if (named.length || swept.length) {
        const nameList = ids => ids.map(id => groupNames[id]).join(' and ')
        const parts = []
        if (named.length) parts.push(`${nameList(named)} ${named.length === 1 ? 'is' : 'are'} acting on this`)
        if (swept.length) parts.push(`${nameList(swept)} ${swept.length === 1 ? 'is' : 'are'} updating ${swept.length === 1 ? 'its' : 'their'} own plan`)
        if (addr.excluded.length) parts.push(`${nameList(addr.excluded)} sits this one out`)
        emit({ type: 'notice', text: parts.join('; ') + '.' })
      }
      for (const pid of speakers) {
        if (controller.signal.aborted) break
        const ag = agentsStore.get(pid)
        if (!ag) continue
        emit({ type: 'agent_turn', agentId: pid, name: ag.name })
        const acting = named.includes(pid)
        const replanning = swept.includes(pid)
        const persona = groupPersona(ag.persona, {
          names, self: ag.name, addressed: acting || replanning,
          others: names.filter(n => n !== ag.name),
          role: acting ? 'act' : 'replan'
        })
        await runTurn({
          ...common, agentId: pid, groupSpeakerId: pid, groupNames, persona,
          // Only the agent doing the work gets tools. A re-planning agent is
          // revising its own notes; four agents with tools on one folder is
          // the thing addressing exists to prevent.
          skills: acting ? mergedSkills : [],
          useTools: acting && session.useTools !== false,
          computerControl: acting && Boolean(session.computerControl)
        })
      }
    } else {
      await runTurn({
        ...common,
        useTools: session.useTools !== false,
        computerControl: Boolean(session.computerControl),
        persona: basePersona,
        planAddendum,
        skills: mergedSkills,
        askAgent,
        peerAgents,
        research,
        board: args => boardTool(args, session),
        planMode: Boolean(session.planMode),
        effort: session.effort || 'auto',
        onPlanExit: () => { session.planMode = false; emit({ type: 'plan_mode', on: false }) }
      })
    }
    // the turn's decisions ride on its reply, for replay
    {
      const lastA = [...session.messages].reverse().find(m => m.role === 'assistant')
      if (lastA && Object.keys(decided).length) lastA.decisions = decided
      // and so does its checkpoint: before/after shas plus the files between them
      if (lastA && ckBefore) {
        const touchedFiles = (lastA.parts || []).some(p => p.type === 'tool' && /^(write_file|edit_file|run_command)$/.test(p.name) && !p.denied)
        if (touchedFiles) {
          const after = await ckSnapshot(RADIANT_DIR, session.cwd, 'after turn')
          if (after?.sha) {
            const ch = after.sha === ckBefore ? [] : await ckChanges(RADIANT_DIR, session.cwd, ckBefore, after.sha).catch(() => [])
            lastA.checkpoint = { before: ckBefore, after: after.sha, files: ch.length, changes: ch.slice(0, 200) }
          }
        }
      }
    }
    // ⚠️ ONE DECISION BEFORE THREE WRITERS. A title, a memory distiller and a
    // skill reflection each cost a model call after every turn — on "thanks"
    // as much as on real work. One Jev request (decide.js chooseHousekeeping)
    // says which are worth running; unreachable, all three run as before.
    const clean = s => (s || '').replace(/\s+/g, ' ').trim().replace(/^["'#\s]+|["'.…\s]+$/g, '').slice(0, 56)
    const firstUser = session.messages.find(m => m.role === 'user')
    const cloud = ['anthropic', 'openai', 'openrouter', 'nousresearch'].includes(provider.id)
    const hk = await (async () => {
      const lastUser = [...session.messages].reverse().find(m => m.role === 'user')
      const lastAsst = [...session.messages].reverse().find(m => m.role === 'assistant')
      const wantTitle = Boolean(firstUser?.text && session.autoTitle !== false && cloud && session.messages.filter(m => m.role === 'user').length === 1)
      const wantMemory = Boolean(memoryOn && !session.group)
      const wantSkill = Boolean(config.settings.suggestSkills !== false && cloud && !session.group)
      if (!config.keys.openrouter || controller.signal.aborted) return { title: wantTitle, memory: wantMemory, skill: wantSkill, decided: false }
      try {
        const { chooseHousekeeping, decide } = await import('./decide.js')
        const r = await chooseHousekeeping({
          userText: lastUser?.text, assistantText: (lastAsst?.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ') + (troubleLog(lastAsst?.parts || []) ? '\n\n[tool calls that failed, then what came next]\n' + troubleLog(lastAsst?.parts || []) : ''),
          toolNames: [...new Set((lastAsst?.parts || []).filter(p => p.type === 'tool' && p.name).map(p => p.name))],
          heuristicTitle: clean((firstUser?.text || '').split(' ').slice(0, 8).join(' ')),
          wantTitle, wantMemory, wantSkill, decideFn: decide, apiKey: config.keys.openrouter, sessionId, signal: controller.signal
        })
        if (r.decided) {
          decided.housekeeping = { p: r.p, ran: { title: r.title, memory: r.memory, skill: r.skill }, bars: { title_ok: 0.7, memory: 0.3, skill: 0.5 } }
          const st = session.stats || (session.stats = { turns: 0, inTokens: 0, outTokens: 0, llmMs: 0, toolMs: 0 })
          st.decisions = (st.decisions || 0) + 1
          st.decisionCost = (st.decisionCost || 0) + (r.usage?.cost || 0)
          console.log(`[housekeeping] title ${r.title ? 'write' : 'skip'} · memory ${r.memory ? 'write' : 'skip'} · skill ${r.skill ? 'write' : 'skip'}` + (r.p ? ` (${Object.entries(r.p).filter(([, v]) => v != null).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')})` : ''))
        }
        return r
      } catch { return { title: wantTitle, memory: wantMemory, skill: wantSkill, decided: false } }
    })()
    // auto-title a still-unnamed session from its first user message
    if (firstUser?.text && session.autoTitle !== false && !controller.signal.aborted) {
      // fast heuristic fallback: first several words of the request
      let t = clean(firstUser.text.split(' ').slice(0, 8).join(' '))
      // nicer LLM title, but only for cloud models (local ones are slow / echo the prompt)
      if (cloud && hk.title) {
        try {
          const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `Reply with ONLY a 3-6 word title (no quotes, no punctuation) summarizing this coding request:\n\n${firstUser.text.slice(0, 600)}` }] }
          const raw = await utilityTurn({ provider, apiKey, session, tmp, signal: controller.signal })
          const out = clean(raw.split('\n').find(l => l.trim()) || '')
          // use it unless the model just echoed the request
          if (out && !firstUser.text.toLowerCase().startsWith(out.toLowerCase().slice(0, 20))) t = out
        } catch {}
      }
      if (t) { session.title = t; emit({ type: 'title', title: t }) }
    }
    // distill durable facts into long-term memory (best-effort, after the turn)
    //
    // ⚠️ DO NOT DISTIL A TURN THAT READ SOMEONE ELSE'S WORDS. The distiller runs
    // on the assistant's own text, and untrusted() explicitly asks the agent to
    // repeat what a page said rather than act on it — so injected prose reliably
    // lands in that text. From there it was packed into a fresh turn with no
    // untrusted framing at all, and whatever came back was written to memory and
    // later rendered into the SYSTEM prompt as a remembered fact about the user.
    // Supersession made it worse: a poisoned fact phrased near a real one
    // replaces it outright. A web page cannot be allowed to author a durable
    // belief about Tony, so a turn that read one is not distilled.
    const FROM_ELSEWHERE = /^(fetch_url|web_search|browser_|mcp__)/
    const readElsewhere = (m => (m?.parts || []).some(p => p.type === 'tool' && FROM_ELSEWHERE.test(p.name || '')))(
      [...session.messages].reverse().find(m => m.role === 'assistant'))
    if (memoryOn && hk.memory && !readElsewhere && !session.group && !controller.signal.aborted) {
      try {
        const lastUser = [...session.messages].reverse().find(m => m.role === 'user')
        const lastAsst = [...session.messages].reverse().find(m => m.role === 'assistant')
        // the lessons live in the tool calls, not the prose: a call that failed
        // and the one that followed it are the failed-then-worked shape
        const trouble = troubleLog(lastAsst?.parts || [])
        const exchange = `User: ${(lastUser?.text || '').slice(0, 1500)}\n\nAssistant: ${(lastAsst?.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ').slice(0, 1500)}${trouble ? `\n\nTool calls that failed, and what came next:\n${trouble}` : ''}`
        const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: `From this exchange, extract anything worth remembering long-term: NEW durable facts about the USER or their PROJECT — preferences, decisions, names, conventions, tools/environment, goals — AND lessons about how the work is done here: something that failed and then worked, a flag or step a tool needs, a source that had the answer when another did not. Only lasting things, not task-specific chatter or one-off requests. Write each as a short standalone sentence a future assistant can act on, one per line. If there is nothing durable, reply exactly "none".\n\n${exchange}` }] }
        const out = await utilityTurn({ provider, apiKey, session, tmp, signal: controller.signal })
        if (out && !/^\s*none\b/i.test(out.trim())) {
          // Replacing a fact is not adding one. addFacts used to return the two
          // summed, so restating a preference reported facts remembered when the
          // count had not grown — and that distinction is the whole point of
          // supersession.
          const { added, superseded } = await addFacts(out.split('\n').map(l => l.trim()).filter(Boolean), session.cwd)
          if (added || superseded) emit({ type: 'memory_added', count: added, updated: superseded })
        }
      } catch {}
    }
    // skillsmith: draft a reusable-skill proposal from procedural work (best-effort,
    // cloud models only, and only when the turn looks skill-worthy). Never auto-saves.
    const suggestOn = config.settings.suggestSkills !== false
    if (suggestOn && hk.skill && cloud && !session.group && !controller.signal.aborted) {
      try {
        const lastUser = [...session.messages].reverse().find(m => m.role === 'user')
        const lastAsst = [...session.messages].reverse().find(m => m.role === 'assistant')
        const alreadyPending = (config.skillSuggestions || []).some(s => s.sessionId === session.id)
        if (!alreadyPending && (hk.decided || shouldReflect(lastUser, lastAsst))) {
          const asstText = (lastAsst?.parts || []).filter(p => p.type === 'text').map(p => p.text).join(' ')
          const toolNames = [...new Set((lastAsst?.parts || []).filter(p => p.type === 'tool' && p.name).map(p => p.name))].join(', ')
          const exchange = `User: ${(lastUser?.text || '').slice(0, 1800)}\n\nAssistant (tools used: ${toolNames || 'none'}): ${asstText.slice(0, 1800)}`
          const tmp = { cwd: session.cwd, messages: [{ role: 'user', text: reflectionPrompt(exchange, skillsStore.list()) }] }
          const out = await utilityTurn({ provider, apiKey, session, tmp, signal: controller.signal })
          const proposal = parseProposal(out)
          if (proposal) {
            const sug = addSuggestion(config, proposal, session.id)
            if (sug) { saveConfig(config); emit({ type: 'skill_suggested', suggestion: { id: sug.id, name: sug.name, description: sug.description, rationale: sug.rationale } }) }
          }
        }
      } catch {}
    }
  } catch (e) {
    // ⚠️ AN OUTAGE IS NOT THE END OF THE TURN if a fallback is set and nothing
    // had happened yet. See fallback.js for what counts and what does not.
    const fb = config.settings.fallback || null
    const assistant = session.messages[session.messages.length - 1]
    const verdict = controller.signal.aborted ? { ok: false } : shouldFallBack({ message: e.message, assistant: assistant?.role === 'assistant' ? assistant : null, current: { provider: provider.id, model: session.model }, fallback: fb })
    const fbProvider = verdict.ok ? config.providers.find(p => p.id === fb.provider) : null
    if (verdict.ok && fbProvider && !session.group) {
      if (assistant?.role === 'assistant') session.messages.pop()
      emit({ type: 'notice', text: fallbackNotice({ current: { provider: provider.id, providerName: provider.name, model: session.model }, fallback: fb, message: e.message }) })
      const fbOAuth = Boolean(config.oauth[fbProvider.id])
      try {
        await runTurn({
          ...common,
          provider: fbProvider,
          model: fb.model,
          apiKey: config.keys[fbProvider.id],
          getAccessToken: fbOAuth ? () => validAccessToken(fbProvider.id, config, saveConfig) : null,
          getAccountId: fbOAuth ? () => config.oauth[fbProvider.id]?.accountId || null : null,
          useTools: session.useTools !== false,
          computerControl: Boolean(session.computerControl),
          persona: basePersona,
          planAddendum,
          skills: mergedSkills,
          askAgent,
          research,
          board: args => boardTool(args, session),
          peerAgents,
          planMode: Boolean(session.planMode),
          effort: session.effort || 'auto',
          onPlanExit: () => { session.planMode = false; emit({ type: 'plan_mode', on: false }) }
        })
      } catch (e2) {
        if (!controller.signal.aborted) recordTurnFailure(session, emit, `${e.message} — and the fallback (${fb.model}) failed too: ${e2.message}`)
      }
    } else if (!controller.signal.aborted) recordTurnFailure(session, emit, e.message)
  } finally {
    stopHeartbeat()
    // An aborted turn threw nothing and emitted nothing that survives — say so
    // in the transcript before it is written, or the chat keeps its empty reply.
    if (controller.signal.aborted) recordTurnStopped(session, { byUser: Boolean(activeTurns.get(sessionId)?.stoppedByUser) })
    activeTurns.delete(sessionId)
    saveTurnSession(session)
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
  // Mark it BEFORE aborting: the turn's finally reads this to tell "you
  // pressed Stop" from "the connection died", which are different sentences.
  if (turn) { turn.stoppedByUser = true; turn.controller.abort() }
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
// ⚠️ ONE UPGRADE ROUTER, NOT TWO SERVERS EACH CLAIMING A PATH. Two
// WebSocketServers constructed with { server, path } each add their own 'upgrade'
// listener, and the one that does not match ABORTS THE HANDSHAKE — so adding the
// extension socket made /term's server answer 400 to it, before the extension's
// server ever saw the request. noServer + a single router is the supported way to
// share a port, and it fails loudly for an unknown path instead of by whoever
// happened to be listening first.
const wss = new WebSocketServer({ noServer: true })

// ---------- the browser extension ----------
// ⚠️ LOOPBACK AND A CHROME EXTENSION ORIGIN, NOTHING ELSE. This socket can read any
// page the user is signed into, so it must never be reachable from the network — a
// remote client with a share token gets the rest of Radiant, not this. The Origin
// header on an extension's WebSocket is chrome-extension://<id>, which a web page
// cannot forge: a page's Origin is its own site.
const extWss = new WebSocketServer({ noServer: true })
extWss.on('error', e => console.error('[ext-ws]', e.message))
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/term') return wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  if (pathname === '/ws/extension') return extWss.handleUpgrade(req, socket, head, ws => extWss.emit('connection', ws, req))
  socket.destroy()
})

extWss.on('connection', async (ws, req) => {
  const origin = req.headers.origin || ''
  // ⚠️ THIS IS THE ONLY ENDPOINT THAT TAKES AN EXTENSION ORIGIN. It used to be
  // blanket-trusted in sameSiteRequest, which meant any extension holding
  // <all_urls> — an ad blocker, a coupon tool, one that changed hands — also
  // reached /api and, worse, the /term socket, which spawns a login shell with
  // no token. A browser-scoped compromise became code execution on the Mac.
  // The bridge is all the extension ever opens (extension/sw.js:40), so the
  // origin rule lives here and nowhere else.
  if (!loopbackSocket(req) || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    ws.close(1008, 'unauthorized')
    return
  }
  const { attachExtension } = await import('./chrome-ext.js')
  attachExtension(ws)
})
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
  const shell = defaultShell()
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
// ⚠️ THE FALLBACK PORTS MUST BE THE ONES THE EXTENSION PROBES. When 5834 is busy
// (a dev instance, a second copy), the server used to fall back to listen(0) — a
// RANDOM port. But the Chrome extension can only look for Radiant on a fixed list
// (extension/sw.js DEFAULT_PORTS), so a random port meant the extension could
// never find the app: it showed "Not connected" forever and the agent quietly
// used its own browser instead. So walk the SAME list the extension probes, and
// only fall to a random port as a last resort (the app still runs; the extension
// just will not find that one). Keep this array equal to sw.js's; test-ext-ports
// fails if they drift.
export const EXT_PORTS = [5834, 5934, 5835, 5836, 5837]
export const ready = new Promise((resolve, reject) => {
  // ⚠️ RECORD THE PORT WE ACTUALLY GOT. The same-origin allowlist above compares
  // against it, so a fallback bind that left boundPort at 5834 would lock the
  // app's own window out of its own server.
  const up = () => { boundPort = server.address().port; resolve(boundPort) }
  // An explicit RADIANT_PORT (dev, tests) is honoured as-is; only the default
  // 5834 walks the shared list, because that is the one the extension hunts for.
  const candidates = PORT === 5834 ? EXT_PORTS : [PORT]
  const tryAt = i => {
    server.removeAllListeners('error')
    server.once('error', err => {
      if (err.code !== 'EADDRINUSE') return reject(err)
      if (i + 1 < candidates.length) tryAt(i + 1)
      else { server.removeAllListeners('error'); server.once('error', reject); server.listen(0, BIND_HOST, up) }
    })
    server.listen(candidates[i], BIND_HOST, up)
  }
  tryAt(0)
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
