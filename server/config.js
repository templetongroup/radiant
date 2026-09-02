import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

// ── where Radiant keeps everything ──────────────────────────────────────────
// Config, projects, sessions and memory all live in one directory. Point it at
// a folder your other Macs already see — iCloud Drive, Dropbox, a synced
// volume — and your setup follows you without Radiant growing an account
// system, a server, or a copy of your data on someone else's disk.
//
// ⚠️ THE POINTER CANNOT LIVE INSIDE THE DIRECTORY IT POINTS AT. That is the
// obvious place for it and it is circular: once the data moves, the file
// naming the new location has moved with it and cannot be found. It sits in
// the home directory instead, next to where the default would have been.
export const DIR_POINTER = path.join(os.homedir(), '.radiant-location')

export function defaultDataDir () { return path.join(os.homedir(), '.radiant') }

// ⚠️ SOME SETTINGS DESCRIBE THE MAC, NOT THE PERSON. The synced folder carries
// one settings object, which is right for a theme and wrong for anything that
// depends on what is installed here: the default model, the provider serving
// it, the folder work starts in. Tony has local models downloaded on different
// Macs and wants each to use its own — "on my work mba, i want to use the local
// models i downloaded there" — and a single shared value cannot express that.
//
// These live beside the location pointer, OUTSIDE the data directory, so they
// can never sync no matter which folder is shared. Everything else stays in
// config.json and follows him between Macs, which is the point of syncing.
export const MACHINE_KEYS = ['defaultModel', 'defaultProvider', 'defaultCwd']
const MACHINE_FILE = path.join(os.homedir(), '.radiant-machine.json')

export function loadMachineSettings () {
  try {
    const raw = JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8'))
    return Object.fromEntries(MACHINE_KEYS.filter(k => k in raw).map(k => [k, raw[k]]))
  } catch { return {} }
}

export function saveMachineSettings (patch) {
  const next = { ...loadMachineSettings() }
  for (const k of MACHINE_KEYS) if (k in patch) next[k] = patch[k]
  try { writeJsonAtomic(MACHINE_FILE, next) } catch {}
  return next
}

/** Does this directory exist AND answer promptly? See resolveDataDir. */
function reachable (dir) {
  try {
    execFileSync('/bin/test', ['-d', dir], { timeout: 3000, stdio: 'ignore' })
    return true
  } catch (e) {
    if (e && (e.code === 'ETIMEDOUT' || e.signal)) {
      console.warn('[radiant] data folder did not respond in 3s, treating as unreachable:', dir)
    }
    return false
  }
}

function resolveDataDir () {
  // An explicit env var wins — it is how the test harness and a sandboxed run
  // get their own directory without touching a real one.
  if (process.env.RADIANT_DIR) return process.env.RADIANT_DIR
  try {
    const p = fs.readFileSync(DIR_POINTER, 'utf8').trim()
    // A pointer at a folder that has gone away (an unmounted volume, a signed
    // out cloud drive) must NOT silently start a blank profile: that reads as
    // "Radiant lost all my work". Fall back to the default and let the UI say
    // the configured folder is unreachable.
    //
    // ⚠️ existsSync ITSELF CAN HANG. A path inside a wedged File Provider — an
    // iCloud Drive that is signed in but not actually running — blocks in the
    // kernel, and this runs at module load, inside the Electron main process,
    // before a window exists. The app opens and freezes with no way back: Tony
    // hit exactly that on his dev Mac after its iCloud folder went away.
    //
    // A blocked syscall cannot be raced from inside this process, so the probe
    // happens in a child that can be killed. Slow means unreachable here, which
    // is the safe reading: worst case Radiant starts on the local folder and
    // says the configured one is unreachable, which is recoverable. Freezing is
    // not.
    if (p && reachable(p)) return p
  } catch { /* no pointer: the default */ }
  return defaultDataDir()
}

export const RADIANT_DIR = resolveDataDir()
export const SESSIONS_DIR = path.join(RADIANT_DIR, 'sessions')
export const PROJECTS_DIR = path.join(RADIANT_DIR, 'projects')
export const TASKS_DIR = path.join(RADIANT_DIR, 'tasks')
const CONFIG_PATH = path.join(RADIANT_DIR, 'config.json')

/** What the UI needs to describe the current location honestly. */
export function dataDirStatus () {
  let configured = null
  try { configured = fs.readFileSync(DIR_POINTER, 'utf8').trim() || null } catch {}
  // ⚠️ THREE DIFFERENT STATES LOOK ALIKE AND MUST NOT BE CONFLATED.
  //   chosen and in use        — normal
  //   chosen, exists, not live — the pointer was just written; a restart applies it
  //   chosen and NOT on disk   — the drive is gone; we fell back and must say so
  // Collapsing the middle case into "unreachable" makes the panel warn about a
  // missing folder one second after the user successfully chose it.
  let exists = false
  try { exists = Boolean(configured) && fs.existsSync(configured) } catch {}
  // Is the folder we are syncing into actually in iCloud on THIS Mac? A folder
  // sitting at the iCloud path with iCloud Drive off is a silent dead end.
  let cloud = Boolean(configured) ? cloudStatus(RADIANT_DIR) : null
  // Only worth asking when the folder itself is not syncing: it turns "this is
  // broken" into "here is the switch to flip".
  if (cloud && cloud.exists && !cloud.ubiquitous) cloud = { ...cloud, icloud: icloudAvailable() }
  return {
    cloud,
    active: RADIANT_DIR,
    configured,
    isDefault: RADIANT_DIR === defaultDataDir(),
    syncing: Boolean(configured),
    pendingRestart: Boolean(configured) && exists && configured !== RADIANT_DIR,
    unreachable: Boolean(configured) && !exists
  }
}

// Bundled SKILL.md-format skill folders: skills/ at the repo root in dev,
// shipped as an extraResource in the packaged app.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const skillsCandidates = [
  path.join(__dirname, '..', 'skills'),
  path.join(process.resourcesPath || '', 'skills')
]
export const SKILLS_ROOT = skillsCandidates.find(p => { try { return fs.existsSync(p) } catch { return false } }) || skillsCandidates[0]

// Skills the user added live in the DATA directory, not the app bundle.
// SKILLS_ROOT is inside Radiant.app: read-only, and replaced wholesale by every
// update. A folder written there would vanish on the next release, which is the
// same class of bug as rule 16 — so anything the user owns goes here instead,
// where it also syncs with the rest of their data.
export const USER_SKILLS_ROOT = path.join(RADIANT_DIR, 'skills')

/**
 * Absolute path for a skill's `dir`, or null.
 *
 * ⚠️ `dir` REACHES THIS FROM A URL. It is one path segment, never a path:
 * anything with a separator, a dot-dot, or a leading dot is refused outright
 * rather than normalized, because normalizing is where traversal bugs hide.
 * User skills win over bundled ones so a local edit of a library skill sticks.
 */
export function resolveSkillDir (dir) {
  const name = String(dir || '')
  if (!name || name.length > 128) return null
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..')) return null
  for (const root of [USER_SKILLS_ROOT, SKILLS_ROOT]) {
    const abs = path.join(root, name)
    // belt and braces: the resolved path must still sit under its root
    if (path.relative(root, abs).startsWith('..')) continue
    try { if (fs.statSync(abs).isDirectory()) return abs } catch {}
  }
  return null
}

// Files a skill folder may contain. A skill is instructions the agent READS;
// nothing in one needs to be runnable, so anything that could be executed is
// refused at import rather than shipped and hoped about.
const SKILL_TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'])
const SKILL_EXEC_EXT = new Set(['.py', '.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.rb', '.pl', '.php', '.command', '.scpt', '.applescript', '.app', '.exe', '.dylib', '.so'])

/**
 * Look inside a skill folder without installing it.
 *
 * Returns the SKILL.md text so the user can read the whole thing before it ever
 * reaches a prompt, plus every other file split into text and executable. An
 * import that reports `executables` is refused by the caller — see the route.
 */
export function inspectSkillFolder (abs) {
  const out = { doc: '', files: [], executables: [], oversize: false }
  let names = []
  try { names = fs.readdirSync(abs) } catch { return out }
  for (const n of names) {
    if (n.startsWith('.')) continue
    let st
    try { st = fs.statSync(path.join(abs, n)) } catch { continue }
    if (st.isDirectory()) { out.files.push({ name: n + '/', bytes: 0, dir: true }); continue }
    const ext = path.extname(n).toLowerCase()
    const rec = { name: n, bytes: st.size }
    if (SKILL_EXEC_EXT.has(ext) || (st.mode & 0o111)) out.executables.push(rec)
    else if (!SKILL_TEXT_EXT.has(ext)) out.executables.push({ ...rec, unknown: true })
    else if (n !== 'SKILL.md') out.files.push(rec)
  }
  try {
    const raw = fs.readFileSync(path.join(abs, 'SKILL.md'), 'utf8')
    out.oversize = raw.length > 200_000
    out.doc = raw.slice(0, 200_000)
  } catch {}
  return out
}

/**
 * Repair a data folder that sits inside iCloud Drive but that iCloud never
 * adopted.
 *
 * ⚠️ THIS IS THE BUG THAT LOSES A MAC'S PROJECTS. If the folder was created
 * before iCloud Drive finished setting up, macOS treats it as an ordinary
 * directory forever: Radiant writes there happily, nothing uploads, nothing
 * arrives, and that Mac shows an empty sidebar while the others are fine. A
 * folder created inside a LIVE container is adopted immediately — measured, not
 * assumed — so the repair is to stand a fresh one up in the same place.
 *
 * ⚠️ COPY-VERIFY-SWAP, AND ROLL BACK ON ANY DOUBT (rule 10). The old folder is
 * renamed aside, never deleted, and it stays non-ubiquitous so it does not
 * suddenly upload gigabytes. `status` is injected so the failure paths can be
 * tested without a broken Mac.
 */
export function repairCloudFolder (dir, { status = cloudStatus, stamp = String(Date.now()) } = {}) {
  const cloudDocs = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  if (dir !== cloudDocs && !dir.startsWith(cloudDocs + path.sep)) {
    return { ok: false, reason: 'not_icloud', message: 'That folder is not inside iCloud Drive, so this repair does not apply to it.' }
  }
  const root = status(cloudDocs)
  if (!root?.ubiquitous) {
    return { ok: false, reason: 'icloud_off', message: 'iCloud Drive is not running on this Mac, so a folder inside it would still sync with nobody. Check System Settings → your name → iCloud → iCloud Drive first.' }
  }
  const here = status(dir)
  if (here?.ubiquitous) {
    return { ok: false, reason: 'already_fine', message: 'This folder is already syncing — there is nothing to repair.' }
  }

  const aside = `${dir}-not-syncing-${stamp}`
  try { fs.renameSync(dir, aside) } catch (e) {
    return { ok: false, reason: 'move_failed', message: `Could not set the old folder aside, so nothing was changed: ${e.message}` }
  }

  const rollback = (why) => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    try { fs.renameSync(aside, dir) } catch {}
    return { ok: false, reason: 'rolled_back', message: why }
  }

  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {
    return rollback(`Could not create the new folder: ${e.message}. Your setup was put back exactly as it was.`)
  }
  // The whole point of the exercise: iCloud has to own the new one.
  if (!status(dir)?.ubiquitous) {
    return rollback('The new folder was still not adopted by iCloud, so nothing was moved. Your setup was put back exactly as it was.')
  }

  try {
    for (const entry of fs.readdirSync(aside)) fs.cpSync(path.join(aside, entry), path.join(dir, entry), { recursive: true })
  } catch (e) {
    return rollback(`Copying your setup across failed: ${e.message}. Your setup was put back exactly as it was.`)
  }

  // ⚠️ VERIFY BEFORE DECLARING SUCCESS. Every top-level name has to be present,
  // and config.json has to be the same size it was.
  try {
    const want = fs.readdirSync(aside)
    const got = new Set(fs.readdirSync(dir))
    const missing = want.filter(n => !got.has(n))
    if (missing.length) return rollback(`The copy was incomplete (${missing.slice(0, 3).join(', ')}). Your setup was put back exactly as it was.`)
    const a = path.join(aside, 'config.json')
    const b = path.join(dir, 'config.json')
    if (fs.existsSync(a) && fs.statSync(a).size !== fs.statSync(b).size) {
      return rollback('Your settings file did not copy across cleanly. Your setup was put back exactly as it was.')
    }
  } catch (e) {
    return rollback(`The copy could not be verified: ${e.message}. Your setup was put back exactly as it was.`)
  }

  return { ok: true, kept: aside, message: 'Repaired. Your setup is in a folder iCloud is syncing, and the old one was kept alongside it.' }
}

/** The bundled library: catalog rows, each flagged with whether it is installed. */
export function skillLibrary (installedDirs = []) {
  let rows = []
  try { rows = JSON.parse(fs.readFileSync(path.join(SKILLS_ROOT, 'library.json'), 'utf8')) } catch { return [] }
  const have = new Set(installedDirs)
  return rows.filter(r => resolveSkillDir(r.dir)).map(r => ({ ...r, installed: have.has(r.dir) }))
}

const DEFAULT_CONFIG = {
  // A project is a named piece of work with a folder attached. Sessions point at
  // one by id. It is deliberately its OWN entity rather than being derived from
  // each session's cwd: two projects can share a directory, a project can be
  // renamed without moving anything on disk, and a session can belong to a
  // project before anyone has decided where its files live.
  projects: [],
  providers: [
    { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'key', removable: false },
    { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', auth: 'key', removable: false },
    { id: 'ollama', name: 'Ollama (local)', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', auth: 'none', removable: false },
    { id: 'lmstudio', name: 'LM Studio (local)', type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', auth: 'none', removable: false },
    { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', auth: 'key', removable: false },
    { id: 'nousresearch', name: 'Nous Portal', type: 'openai', baseUrl: 'https://inference-api.nousresearch.com/v1', auth: 'key', removable: false, hint: 'Sign in with your Nous Portal subscription below — or paste an API key from portal.nousresearch.com → API Keys.' },
    { id: 'xai', name: 'xAI (Grok)', type: 'openai', baseUrl: 'https://api.x.ai/v1', auth: 'key', removable: false, hint: 'Sign in with your Grok subscription below (SuperGrok / Premium+) — or paste an xAI API key from console.x.ai.' },
    { id: 'copilot', name: 'GitHub Copilot', type: 'openai', baseUrl: 'https://api.githubcopilot.com', auth: 'oauth', removable: false, hint: 'Sign in with your GitHub Copilot subscription below — it unlocks GPT, Claude, and Gemini models through Copilot.' },
    { id: 'qwen', name: 'Qwen', type: 'openai', baseUrl: 'https://portal.qwen.ai/v1', auth: 'oauth', removable: false, hint: 'Sign in with your Qwen (chat.qwen.ai) subscription below.' },
    // Pre-configured API-key services (OpenAI-compatible). Removable — hide any you don't use.
    { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', auth: 'key', removable: true, preset: true, hint: 'deepseek-chat & deepseek-reasoner. Key at platform.deepseek.com.' },
    { id: 'moonshot', name: 'Kimi (Moonshot)', type: 'openai', baseUrl: 'https://api.moonshot.ai/v1', auth: 'key', removable: true, preset: true, hint: 'Kimi models. Key at platform.moonshot.ai.' },
    { id: 'zai', name: 'GLM (Z.ai)', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', auth: 'key', removable: true, preset: true, hint: 'GLM-4.6 / 4.5. Key at z.ai — works with the GLM Coding Plan.' },
    { id: 'mistral', name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', auth: 'key', removable: true, preset: true, hint: 'Key at console.mistral.ai.' },
    { id: 'groq', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', auth: 'key', removable: true, preset: true, hint: 'Very fast inference. Key at console.groq.com.' },
    { id: 'together', name: 'Together', type: 'openai', baseUrl: 'https://api.together.xyz/v1', auth: 'key', removable: true, preset: true, hint: 'Open models. Key at api.together.ai.' },
    { id: 'fireworks', name: 'Fireworks', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', auth: 'key', removable: true, preset: true, hint: 'Open models. Key at fireworks.ai.' },
    { id: 'cerebras', name: 'Cerebras', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', auth: 'key', removable: true, preset: true, hint: 'Very fast inference. Key at cloud.cerebras.ai.' },
    { id: 'perplexity', name: 'Perplexity', type: 'openai', baseUrl: 'https://api.perplexity.ai', auth: 'key', removable: true, preset: true, hint: 'Sonar models. Key at perplexity.ai/settings/api.' },
    { id: 'vercel', name: 'Vercel AI Gateway', type: 'openai', baseUrl: 'https://ai-gateway.vercel.sh/v1', auth: 'key', removable: true, preset: true, hint: 'Routes to many models. Key from your Vercel dashboard.' },
    { id: 'ollama-cloud', name: 'Ollama Cloud', type: 'openai', baseUrl: 'https://ollama.com/v1', auth: 'key', removable: true, preset: true, hint: 'Cloud-hosted Ollama models. Key at ollama.com/settings/keys.' },
    { id: 'gemini', name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', auth: 'key', removable: true, preset: true, hint: 'Gemini models. Key from aistudio.google.com/apikey (free tier available).' }
  ],
  removedProviders: [],
  keys: {},
  oauth: {},
  accounts: {},
  activeAccount: {},
  mcpServers: [],
  skills: [
    // dir: points at a SKILL.md folder bundled under SKILLS_ROOT; the folder's
    // absolute path is appended to the skill text at prompt-build time.
    { id: 'seed-archmap', name: 'Architecture map', description: 'Build an interactive isometric map of the repo\'s architecture.', dir: 'architecture-map', content: 'When the user asks for an architecture map, system diagram, codebase overview, or to "show how this repo fits together", read SKILL.md in this skill\'s folder and follow it. Its references/, scripts/, and assets/ live alongside it. For other tasks, ignore this skill.', enabled: false },
    { id: 'seed-harapi', name: 'Website → API client', description: 'Turn a website\'s hidden API into a reusable HTTP client.', dir: 'har-derived-api-client', content: 'When the user wants to pull data from or automate a website that has no official API — a search, feed, prices, a list, a repeated action — read SKILL.md in this skill\'s folder and follow it: drive the browser once, use browser_network to capture the site\'s XHR/fetch JSON calls, then rebuild and verify a plain HTTP client. Needs the computer/browser toggle on. For other tasks, ignore this skill.', enabled: false },
    { id: 'seed-commits', name: 'Conventional commits', description: 'Commit messages in Conventional Commits format.', content: 'When writing git commit messages, use Conventional Commits format (feat:, fix:, docs:, refactor:, chore:, test:) — a concise summary line, and a short body only when it adds value.', enabled: false },
    { id: 'seed-plan', name: 'Plan before acting', description: 'State a brief plan before non-trivial changes.', content: 'Before making non-trivial changes, state your plan in 1–2 sentences, then carry it out. Keep the user oriented on what you are about to do.', enabled: false },
    { id: 'seed-minimal', name: 'Minimal diffs', description: 'Smallest change that solves the problem.', content: 'Make the smallest change that solves the problem. Match the surrounding code style and conventions. Do not refactor or reformat unrelated code.', enabled: false }
  ],
  skillSuggestions: [],
  rejectedSkills: [],
  removedSkills: [],
  // Built-in agents the user removed; without this they return on every load.
  removedAgents: [],
  agents: [
    { id: 'agent-radiant', name: 'Radiant', emoji: '✦', icon: 'radiant', hue: null, persona: '', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-reviewer', name: 'Reviewer', emoji: '🔍', icon: 'search', hue: null, persona: 'You are a meticulous senior code reviewer. Hunt for bugs, edge cases, security issues, race conditions, and unclear code. Be specific — cite files and lines. Prioritize correctness over style, and call out what you are NOT sure about.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-architect', name: 'Architect', emoji: '📐', icon: 'compass', hue: null, persona: 'You are a software architect. Before writing code, think about structure, boundaries, data flow, and tradeoffs. Propose a design, note alternatives, and only then implement. Favor simple, evolvable designs.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-explainer', name: 'Explainer', emoji: '💡', icon: 'bulb', hue: null, persona: 'You explain code and concepts clearly for someone learning. Use plain language, small examples, and analogies. Read the code first, then teach it top-down. Prefer clarity over completeness.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-pair', name: 'Coder', emoji: '🧑‍💻', icon: 'code', hue: null, persona: 'You are a hands-on implementer. Given a task, write the code and make it work. Follow the existing patterns and style in the repo, keep changes small and focused, add or update tests, and run/verify your changes when practical. Unlike the Architect, you optimize for shipping working code now, not for exploring the design space — if the approach is unclear, pick the simplest one that fits and note the tradeoff briefly.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-security', name: 'Security', emoji: '🛡️', icon: 'shield', hue: null, persona: 'You are an application security engineer. Review code and designs for vulnerabilities — injection, broken auth/authorization, secrets handling, SSRF, XSS/CSRF, insecure dependencies, unsafe deserialization, path traversal. For each issue explain the risk, how it could be exploited, and the concrete fix. Cite OWASP categories where relevant, and be clear about what you are and are not sure about.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-sales', name: 'Sales', emoji: '📣', icon: 'megaphone', hue: null, persona: 'You help with sales and go-to-market. Write clear, persuasive outreach, positioning, and proposals; qualify leads; and reason about value propositions, objections, and pricing. Keep it concise and benefit-focused, tailor to the audience, and avoid hype and jargon.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-design', name: 'Design', emoji: '🎨', icon: 'palette', hue: null, persona: 'You are a product and UI/UX designer. Think about clarity, hierarchy, spacing, and flow before aesthetics. Give concrete, actionable feedback and propose specific layouts, components, states, and copy. Favor simple, accessible, consistent design; explain the reasoning behind each choice.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-education', name: 'Education', emoji: '🎓', icon: 'cap', hue: null, persona: 'You are a patient teacher. Break topics into small steps, use plain language and concrete examples, and build from the fundamentals. Check the learner\'s understanding, adapt to their level, and prefer clarity over completeness. Encourage, and never make the learner feel behind.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-finance', name: 'Finance', emoji: '📈', icon: 'chart', hue: null, persona: 'You help with finance and quantitative analysis — budgets, models, unit economics, forecasts, and tradeoffs. State your assumptions, show the calculations, sanity-check the numbers, flag risks, and give a clear bottom line. You are not a licensed financial advisor; say so if asked for personalized investment advice.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-devops', name: 'DevOps', emoji: '⚙️', icon: 'wrench', hue: null, persona: 'You are a DevOps / SRE engineer. Handle builds, CI/CD, containers, infrastructure-as-code, deployment, monitoring, and reliability. Prefer reproducible, automated, observable setups; think about failure modes, rollbacks, and least privilege; and give exact commands and config.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-data', name: 'Data', emoji: '📊', icon: 'flask', hue: null, persona: 'You are a data analyst. Explore data, write correct SQL and analysis code, verify your assumptions, and explain findings plainly with their caveats and confidence. Prefer reproducible analysis; when you make a chart, keep it simple and labeled.', model: null, provider: null, skills: [], useTools: true, builtin: true },
    { id: 'agent-docs', name: 'Docs', emoji: '📖', icon: 'book', hue: null, persona: 'You are a technical writer. Produce clear, accurate documentation — READMEs, API references, guides, and inline comments. Read the code first, write for the reader\'s level, use examples, and keep it concise and well-structured with good headings.', model: null, provider: null, skills: [], useTools: true, builtin: true }
  ],
  recipes: [
    { id: 'rec-review', name: 'Review code / PR', desc: 'Thorough code review', params: [{ name: 'target', label: 'File, folder, or PR', placeholder: 'e.g. src/auth.js' }], template: 'Review {target} thoroughly for bugs, edge cases, security issues, and unclear code. Cite specific files and lines, and prioritize correctness over style.', builtin: true },
    { id: 'rec-tests', name: 'Write tests', desc: 'Add tests for some code', params: [{ name: 'target', label: 'What to test', placeholder: 'e.g. the login function' }], template: 'Write thorough tests for {target}. Cover happy paths, edge cases, and error handling. Then run the tests and fix any failures.', builtin: true },
    { id: 'rec-scaffold', name: 'Scaffold a project', desc: 'Start a new app', params: [{ name: 'stack', label: 'Framework / stack', placeholder: 'e.g. Vite + React + TS' }, { name: 'desc', label: 'What it does', placeholder: 'e.g. a todo app' }], template: 'Scaffold a new {stack} project: {desc}. Set up the structure, install dependencies, and get it running. Show me how to start it.', builtin: true },
    { id: 'rec-explain', name: 'Explain code', desc: 'Understand a file or system', params: [{ name: 'target', label: 'File or topic', placeholder: 'e.g. how auth works' }], template: 'Explain {target}, starting from the entry point. Read the relevant files first, then walk me through it top-down in plain language.', builtin: true },
    { id: 'rec-debug', name: 'Debug an issue', desc: 'Find & fix a bug', params: [{ name: 'symptom', label: 'The bug / symptom', placeholder: 'e.g. login returns a 500' }], template: 'Debug this: {symptom}. Reproduce it, find the root cause by reading the code and any logs, fix it, and verify the fix works.', builtin: true },
    { id: 'rec-refactor', name: 'Refactor', desc: 'Clean up without changing behavior', params: [{ name: 'target', label: 'What to refactor', placeholder: 'e.g. the settings module' }], template: 'Refactor {target} for clarity and simplicity without changing its behavior. Keep changes small and verify nothing breaks (run tests if present).', builtin: true }
  ],
  settings: {
    mode: 'dark',
    // ⚠️ MUST BE A REAL THEME ID FROM src/theme.js. This said 'steel', which
    // does not exist, so every fresh install fell through to customHue and
    // rendered orange instead of Radiant blue. The fallback below catches a
    // bad id now, but the default should still be right.
    themeId: 'radiant',
    customHue: 258,
    customChroma: 0.19,
    fontFamily: 'inter',
    uiScale: 1,
    customTint: 1,
    motionBg: 'off',
    approveCommands: true,
    autoUpdateCheck: true,
    defaultModel: null,
    defaultCwd: os.homedir()
  }
}

function ensureDirs () {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.mkdirSync(PROJECTS_DIR, { recursive: true })
  fs.mkdirSync(TASKS_DIR, { recursive: true })
}

// ⚠️ A HALF-WRITTEN FILE IN A CLOUD FOLDER GETS SYNCED AS-IS. writeFileSync
// truncates and then fills; interrupt it — a crash, a quit, a sleeping Mac —
// and the short version is what the other Macs receive. Write beside it and
// rename, which is atomic on the same filesystem: readers see the old file or
// the new one, never a partial one.
function writeJsonAtomic (file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function loadConfig () {
  ensureDirs()
  let cfg = structuredClone(DEFAULT_CONFIG)
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    // merge: keep default providers up to date, preserve user additions and keys
    const byId = Object.fromEntries((saved.providers || []).map(p => [p.id, p]))
    cfg.providers = cfg.providers.map(p => ({ ...p, ...(byId[p.id] ? { baseUrl: byId[p.id].baseUrl } : {}) }))
    for (const p of saved.providers || []) {
      if (!cfg.providers.find(d => d.id === p.id)) cfg.providers.push(p)
    }
    // presets/defaults the user has removed stay removed across restarts
    if (saved.removedProviders) {
      cfg.removedProviders = saved.removedProviders
      cfg.providers = cfg.providers.filter(p => !saved.removedProviders.includes(p.id))
    }
    cfg.keys = saved.keys || {}
    cfg.oauth = saved.oauth || {}
    cfg.accounts = saved.accounts || {}
    cfg.activeAccount = saved.activeAccount || {}
    if (Array.isArray(saved.projects)) cfg.projects = saved.projects
    if (saved.removedSkills) cfg.removedSkills = saved.removedSkills
    if (saved.skills) {
      cfg.skills = saved.skills
      // bundled skills (dir:) join existing configs too, unless the user deleted them
      const have = new Set(cfg.skills.map(s => s.id))
      for (const def of DEFAULT_CONFIG.skills) {
        if (def.dir && !have.has(def.id) && !cfg.removedSkills.includes(def.id)) cfg.skills.push(structuredClone(def))
      }
    }
    // ⚠️ A BUILT-IN YOU DELETE MUST STAY DELETED. The 14 default agents are
    // seeded from DEFAULT_CONFIG on every load, so a "delete" with no record of
    // it is undone the moment Radiant restarts — which is why deleting them was
    // refused outright, leaving fourteen agents nobody could clear. Tony: "i
    // feel like the agents menu is too cluttered." Same shape as
    // removedProviders and removedSkills, which existed for exactly this.
    if (saved.removedAgents) {
      cfg.removedAgents = saved.removedAgents
      // ⚠️ AGENTS ARE SERVED FROM agentsStore, NOT FROM THIS LIST. Deleting a
      // built-in unlinks its file, so the removal already persists; this filter
      // only stops the one-time config.json → store migration putting it back.
      cfg.agents = cfg.agents.filter(a => !saved.removedAgents.includes(a.id))
    }
    if (saved.agents) {
      // built-in agents now follow the accent color (hue: null); null out any that
      // still carry an original seeded hue, but keep a hue the user chose themselves.
      const OLD_HUES = { 'agent-radiant': 258, 'agent-reviewer': 25, 'agent-architect': 200, 'agent-explainer': 90, 'agent-pair': 300, 'agent-security': 15, 'agent-sales': 40, 'agent-design': 325, 'agent-education': 130, 'agent-finance': 160, 'agent-devops': 195, 'agent-data': 175, 'agent-docs': 65 }
      // backfill new built-in fields (e.g. icon) onto saved built-in agents
      const defById = Object.fromEntries(cfg.agents.map(a => [a.id, a]))
      cfg.agents = saved.agents.map(a => {
        if (!(a.builtin && defById[a.id])) return a
        const def = defById[a.id]
        // one-time migration: the Radiant agent now wears the swirl logo, not sparkles
        const icon = (a.id === 'agent-radiant' && a.icon === 'sparkles') ? 'radiant' : (a.icon || def.icon)
        // one-time migration: "Pair" became "Coder" (only if the user hasn't renamed it)
        const migratePair = a.id === 'agent-pair' && a.name === 'Pair'
        const name = migratePair ? def.name : a.name
        const persona = (migratePair && /^You are a pair-programming partner/.test(a.persona || '')) ? def.persona : a.persona
        const hue = (a.hue === OLD_HUES[a.id]) ? null : a.hue
        return { ...a, icon, name, persona, hue }
      })
      // add any new built-in agents that didn't exist when this config was saved
      const haveIds = new Set(cfg.agents.map(a => a.id))
      for (const def of Object.values(defById)) if (!haveIds.has(def.id)) cfg.agents.push(def)
    }
    if (saved.mcpServers) cfg.mcpServers = saved.mcpServers
    if (saved.skillSuggestions) cfg.skillSuggestions = saved.skillSuggestions
    if (saved.rejectedSkills) cfg.rejectedSkills = saved.rejectedSkills
    if (saved.recipes) {
      const seeded = cfg.recipes
      cfg.recipes = saved.recipes
      const have = new Set(cfg.recipes.map(r => r.id))
      for (const r of seeded) if (r.builtin && !have.has(r.id)) cfg.recipes.push(r)
    }
    cfg.settings = { ...cfg.settings, ...(saved.settings || {}) }
  // ⚠️ MERGE MACHINE SETTINGS ON THE WAY IN, NOT ONLY ON THE WAY OUT. When these
  // moved to their own file, publicConfig folded them back for the client and
  // nothing folded them into the server's own config — so the app displayed the
  // chosen default model correctly while session creation, which reads
  // config.settings.defaultModel, saw undefined and every new chat opened with
  // no model. Saved, reported, and completely unused. saveConfig still strips
  // them, so they cannot leak into the shared file.
  cfg.settings = { ...cfg.settings, ...loadMachineSettings() }
  } catch { /* first run */ }
  migrateAccounts(cfg)
  return cfg
}

// ⚠️ NOTHING TEMPORARY BELONGS IN A FILE THAT SYNCS. settings._iconTmp is a
// base64 icon held while the user is picking one. It was being persisted, and
// it was 155 KB of a 212 KB config.json — three quarters of everything iCloud
// had to re-upload on every change, on every Mac, forever. Tony's projects were
// 635 bytes riding behind it.
// ⚠️ RECORDS THAT LIVE IN FILES MUST NEVER BE WRITTEN BACK HERE. Deleting the
// key at migration time was not enough: loadConfig repopulates agents, skills
// and recipes from the built-in defaults, the middleware reloads config on
// every API request, and the next save put them straight back into the shared
// file. Nothing broke — reads come from the stores — but config.json kept
// re-acquiring the very records this change exists to get out of it, which is
// how two Macs would go on overwriting each other's agents.
//
// Stripping them here makes it structural: whatever is in memory, the shared
// file cannot carry them. Migration is unaffected, because it copies records
// into their own files before this ever runs.
const OWN_FILE_NOW = ['agents', 'skills', 'recipes', 'projects']

// ⚠️ A REMOVAL MUST SURVIVE A STALE WRITER. These three lists are tombstones:
// they record what you deleted, and every one of them is the ONLY thing standing
// between a deleted built-in and the seeding code that puts it back on load.
//
// saveConfig writes a whole in-memory snapshot, and there are two dozen callers.
// Any of them holding a config object from before a removal silently erases the
// record — and the very next launch re-seeds every agent, skill or provider the
// tombstone was protecting. Tony's data folder is in iCloud and shared with a
// second Mac, so "one writer, the server" is simply not true there: his
// config.json carried removedProviders and removedSkills but had lost
// removedAgents, and 51 minutes later all thirteen built-in agent files were
// written back. "I just created a single new agent and all of the previous
// pre-installed agents just reappeared."
//
// So tombstones are merged with what is already on disk rather than overwritten.
// Union, because removal is monotonic: two machines that each delete something
// should end up with both deletions, never with one machine's list winning.
// Undoing a removal is the one case that must subtract, and it says so
// explicitly via `forgetting` — a restore, never an accident.
const TOMBSTONE_KEYS = ['removedAgents', 'removedSkills', 'removedProviders']

function mergeTombstones (out, forgetting) {
  let disk = null
  try { disk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return }
  if (!disk || typeof disk !== 'object') return
  for (const k of TOMBSTONE_KEYS) {
    const mine = Array.isArray(out[k]) ? out[k] : []
    const theirs = Array.isArray(disk[k]) ? disk[k] : []
    if (!mine.length && !theirs.length) continue
    out[k] = [...new Set([...theirs, ...mine])].filter(id => !forgetting.includes(id))
  }
}

export function saveConfig (cfg, { forgetting = [] } = {}) {
  ensureDirs()
  const out = { ...cfg }
  mergeTombstones(out, forgetting)
  if (out.settings && '_iconTmp' in out.settings) {
    out.settings = { ...out.settings }
    delete out.settings._iconTmp
  }
  for (const k of OWN_FILE_NOW) delete out[k]
  // Machine-specific values must not travel in the shared file either.
  if (out.settings) {
    out.settings = { ...out.settings }
    for (const k of MACHINE_KEYS) delete out.settings[k]
  }
  writeJsonAtomic(CONFIG_PATH, out)
}

// ---- is this folder actually in iCloud? -------------------------------------
//
// ⚠️ A FOLDER AT THE iCLOUD PATH IS NOT NECESSARILY IN iCLOUD. With iCloud Drive
// off, or signed into a different Apple ID, CloudDocs can still exist as an
// ordinary local directory. Radiant would create its hierarchy inside it and
// write there forever, syncing to nobody, while the checkbox said "Keep my
// setup in iCloud Drive". Tony's dev Mac did exactly that — the same setup
// worked on two other Macs and that one stayed empty through reboots and
// reinstalls, with nothing on screen suggesting anything was wrong.
//
// An earlier attempt counted `.icloud` placeholder files and shelled out to
// `brctl download`. Both were wrong: modern placeholders are File Provider
// entries rather than sidecar files, so the count is always zero on current
// macOS, and brctl is a diagnostic tool that does not belong in a shipped app.
// Foundation's URL resource values are the supported answer, reached through
// the native helper we already ship.
const HELPER = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'radiant-control'),
  path.join(process.resourcesPath || '', 'native', 'radiant-control')
].find(p => { try { return fs.existsSync(p) } catch { return false } })

function helperSays (cmd, target) {
  if (!HELPER) return null
  try {
    const out = execFileSync(HELPER, [cmd, target], { encoding: 'utf8', timeout: 5000 }).trim()
    return Object.fromEntries(out.split(' ').map(kv => {
      const i = kv.indexOf('=')
      return i < 0 ? [kv, true] : [kv.slice(0, i), kv.slice(i + 1)]
    }))
  } catch { return null }
}

/**
 * What iCloud thinks of a folder. null when we cannot tell — never guess, and
 * never let "cannot tell" render as "broken".
 */
export function cloudStatus (dir) {
  const r = helperSays('ubiquity', dir)
  if (!r) return null
  return {
    exists: r.exists === 'true',
    ubiquitous: r.ubiquitous === 'true',
    uploaded: r.uploaded === 'true',
    uploading: r.uploading === 'true',
    excluded: r.excluded === 'true',
    error: r.error === 'yes'
  }
}

// ⚠️ ASK THE DOCUMENTED QUESTION, NOT A PROXY FOR IT. This used to test whether
// the CloudDocs root was itself a ubiquitous item and report "iCloud Drive is
// switched off" when it was not. That was wrong on Tony's dev Mac — System
// Settings showed iCloud Drive → "Sync this Mac" ON while Radiant told him it
// was off, sending him after a setting that was already correct.
//
// ubiquityIdentityToken is what Foundation provides for this: non-nil when
// iCloud is signed in and available. Returns null when we cannot tell, and the
// UI must then say nothing rather than guess.
export function icloudAvailable () {
  const r = helperSays('icloud', '')
  if (!r) return null
  return r.available === 'true'
}

/** Ask iCloud to fetch an item. The supported call, not `brctl download`. */
export function requestCloudDownload (dir) { helperSays('fetch', dir) }

// ---- collections: one file per record ---------------------------------------
//
// ⚠️ ANYTHING TWO MACS BOTH EDIT NEEDS ITS OWN FILE. iCloud Drive has no merge:
// the later write wins and the other Mac's work is gone. Projects were moved out
// of config.json for this reason; agents (the largest at ~24 KB), skills and
// recipes had exactly the same exposure and are moved here.
//
// Settings deliberately stays in config.json. It is one small object rather than
// a list of records, so there is nothing to split it into — two Macs changing
// preferences at once still race, but the loss is a theme, not a week of work.
function makeCollection (name) {
  const dir = () => path.join(RADIANT_DIR, name)
  const file = id => path.join(dir(), encodeURIComponent(String(id)) + '.json')
  const ensure = () => fs.mkdirSync(dir(), { recursive: true })
  return {
    list () {
      try {
        return fs.readdirSync(dir())
          .filter(f => f.endsWith('.json'))
          .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8')) } catch { return null } })
          .filter(Boolean)
          .sort((a, b) => String(a.createdAt || a.name || '').localeCompare(String(b.createdAt || b.name || '')))
      } catch { return [] }
    },
    get (id) {
      if (!id) return null
      try { return JSON.parse(fs.readFileSync(file(id), 'utf8')) } catch { return null }
    },
    save (item) {
      if (!item?.id) throw new Error(`${name}: id required`)
      ensure(); writeJsonAtomic(file(item.id), item); return item
    },
    remove (id) { try { fs.unlinkSync(file(id)) } catch {} },
    // Copy out of config.json first, clear second: an interruption leaves
    // duplicates rather than nothing.
    //
    // ⚠️ RUN THE SHARED-FILE WRITE ONCE, NOT EVERY LAUNCH. loadConfig always
    // repopulates these keys from the built-in defaults, so a naive "is the key
    // present" test fires on every start — and rewriting config.json on every
    // start is exactly the shared write this change exists to remove. A marker
    // records that the move already happened. Later launches still seed any
    // newly shipped built-in into its own file; they just do not touch the
    // shared file to do it.
    migrate (cfg) {
      const marker = path.join(RADIANT_DIR, `.${name}-moved`)
      let first = false
      try { first = !fs.existsSync(marker) } catch { first = false }
      ensure()
      for (const item of (Array.isArray(cfg?.[name]) ? cfg[name] : [])) {
        if (!item?.id) continue
        if (!this.get(item.id)) this.save(item)
      }
      if (cfg && name in cfg) delete cfg[name]
      if (first) {
        try { fs.writeFileSync(marker, new Date().toISOString()) } catch {}
        saveConfig(cfg)
        console.log(`[radiant] moved ${name} out of config.json into ${name}/`)
      }
      return first
    }
  }
}

export const agentsStore = makeCollection('agents')

/** A built-in agent's original definition, for putting one back after removal. */
export function builtinAgent (id) {
  const def = DEFAULT_CONFIG.agents.find(a => a.id === id)
  return def ? structuredClone(def) : null
}
export const skillsStore = makeCollection('skills')
export const recipesStore = makeCollection('recipes')

// ---- projects: one file each ------------------------------------------------
//
// ⚠️ TWO MACS MUST NEVER WRITE THE SAME FILE. iCloud Drive has no merge — the
// later write wins and the other Mac's work is gone. Projects lived inside the
// single config.json that every Mac rewrites in full, so adding a project on
// one Mac could erase one added on another. Chats never had this problem
// because they are one file per chat; projects now work the same way. Two Macs
// adding different projects touch different files and both survive.
const PROJECT_ID = /^[a-z0-9-]+$/

export function listProjects () {
  ensureDirs()
  let out = []
  try {
    out = fs.readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8')) } catch { return null } })
      .filter(Boolean)
  } catch {}
  return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
}

export function getProject (id) {
  if (!PROJECT_ID.test(String(id || ''))) return null
  try { return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, id + '.json'), 'utf8')) } catch { return null }
}

export function saveProject (project) {
  ensureDirs()
  if (!PROJECT_ID.test(String(project?.id || ''))) throw new Error('bad project id')
  writeJsonAtomic(path.join(PROJECTS_DIR, project.id + '.json'), project)
  return project
}

export function deleteProject (id) {
  if (!PROJECT_ID.test(String(id || ''))) return
  try { fs.unlinkSync(path.join(PROJECTS_DIR, id + '.json')) } catch {}
}

// Move projects out of config.json the first time this build runs. Copy first,
// clear second, so an interruption leaves duplicates rather than nothing.
export function migrateProjects (cfg) {
  if (!Array.isArray(cfg?.projects) || !cfg.projects.length) return false
  for (const p of cfg.projects) {
    if (!PROJECT_ID.test(String(p?.id || ''))) continue
    if (!getProject(p.id)) saveProject(p)
  }
  delete cfg.projects
  saveConfig(cfg)
  console.log('[radiant] moved projects out of config.json into projects/')
  return true
}

// ---- multiple accounts per provider ----
// accounts[providerId] holds every saved credential (incl. the active one);
// activeAccount[providerId] names the active one. config.keys / config.oauth
// always mirror the active account, so the whole request path is unchanged.
function jwtEmail (tok) {
  const jwt = tok?.idToken || tok?.access
  try { const c = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64').toString('utf8')); return c.email || null } catch { return null }
}
function autoLabel (cred, n) {
  if (cred.oauth) return jwtEmail(cred.oauth) || `Account ${n}`
  if (cred.key) return 'Key ••••' + String(cred.key).slice(-4)
  return `Account ${n}`
}
// write the active account's credential into config.keys / config.oauth
export function syncActiveAccount (config, providerId) {
  const list = config.accounts?.[providerId] || []
  const act = list.find(a => a.id === config.activeAccount?.[providerId]) || list[0]
  if (!act) { delete config.keys[providerId]; delete config.oauth[providerId]; return }
  config.activeAccount = config.activeAccount || {}
  config.activeAccount[providerId] = act.id
  if (act.key) config.keys[providerId] = act.key; else delete config.keys[providerId]
  if (act.oauth) config.oauth[providerId] = act.oauth; else delete config.oauth[providerId]
}
// add a new account (or replace the active one's credential when newAccount is false)
export function upsertCredential (config, providerId, cred, { label, newAccount } = {}) {
  config.accounts = config.accounts || {}
  config.activeAccount = config.activeAccount || {}
  const list = config.accounts[providerId] = config.accounts[providerId] || []
  const active = list.find(a => a.id === config.activeAccount[providerId])
  if (!newAccount && active) {
    active.key = cred.key; active.oauth = cred.oauth
    if (label) active.label = label
  } else {
    const acct = { id: 'acct-' + crypto.randomBytes(4).toString('hex'), label: label || autoLabel(cred, list.length + 1), key: cred.key, oauth: cred.oauth }
    list.push(acct)
    config.activeAccount[providerId] = acct.id
  }
  syncActiveAccount(config, providerId)
}
export function activateAccount (config, providerId, acctId) {
  config.activeAccount = config.activeAccount || {}
  config.activeAccount[providerId] = acctId
  syncActiveAccount(config, providerId)
}
export function removeAccount (config, providerId, acctId) {
  const list = config.accounts?.[providerId] || []
  config.accounts[providerId] = list.filter(a => a.id !== acctId)
  if (config.activeAccount?.[providerId] === acctId) {
    config.activeAccount[providerId] = config.accounts[providerId][0]?.id
  }
  syncActiveAccount(config, providerId)
}
// backfill accounts for installs whose keys/tokens predate multi-account
function migrateAccounts (config) {
  config.accounts = config.accounts || {}
  config.activeAccount = config.activeAccount || {}
  const ids = new Set([...Object.keys(config.keys || {}), ...Object.keys(config.oauth || {})])
  for (const id of ids) {
    if (config.accounts[id]?.length) continue
    const cred = { key: config.keys?.[id], oauth: config.oauth?.[id] }
    if (!cred.key && !cred.oauth) continue
    const acct = { id: 'acct-' + crypto.randomBytes(4).toString('hex'), label: autoLabel(cred, 1), key: cred.key, oauth: cred.oauth }
    config.accounts[id] = [acct]
    config.activeAccount[id] = acct.id
  }
}

// Public view: never expose key material to the browser.
export function publicConfig (cfg) {
  return {
    providers: cfg.providers.map(p => ({
      ...p,
      hasKey: p.auth === 'none' || Boolean(cfg.keys[p.id]),
      signedIn: Boolean(cfg.oauth[p.id]),
      // account roster (labels only — never any key or token material)
      accounts: (cfg.accounts?.[p.id] || []).map(a => ({ id: a.id, label: a.label, kind: a.oauth ? 'subscription' : 'key', active: a.id === cfg.activeAccount?.[p.id] }))
    })),
    // ⚠️ THE API SHAPE DOES NOT CHANGE WHEN THE STORAGE DOES. These live in one
    // file each now, but the app still receives the same arrays it always did,
    // so nothing in the UI had to be touched to move them off a shared blob.
    skills: skillsStore.list(),
    skillSuggestions: cfg.skillSuggestions || [],
    agents: agentsStore.list(),
    // The UI needs to SEE what was removed, or the library cannot offer it back
    // and "Remove" becomes a one-way door.
    removedAgents: cfg.removedAgents || [],
    // ⚠️ SEND THE WHOLE DEFINITION, NOT JUST THE ID. With only ids the library
    // had to invent what it showed: a generic robot for every one of them, and a
    // name unslugged from the id — "agent-devops" rendered as "Devops". You were
    // asked to put back something you could not recognise. Tony: "there should be
    // an option to restore the original, pre-defined ones ... with their original
    // icons and agent descriptions." These ARE the originals, straight out of the
    // built-in table, so nothing has to be duplicated client-side and nothing can
    // drift from what restore actually writes back.
    removedAgentDefs: (cfg.removedAgents || []).map(builtinAgent).filter(Boolean),
    recipes: recipesStore.list(),
    mcpServers: cfg.mcpServers || [],
    // ⚠️ THIS MAC'S OWN CHOICES WIN. Model, provider and starting folder depend
    // on what is installed here, so they come from the machine-local file
    // rather than the synced one. Everything else follows the user between
    // Macs, which is the point of syncing.
    settings: { ...cfg.settings, ...loadMachineSettings() }
  }
}

// ---- sessions ----
export function listSessions () {
  ensureDirs()
  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))
        return { id: s.id, title: s.title, model: s.model, provider: s.provider, cwd: s.cwd, agentId: s.agentId || null, projectId: s.projectId || null, pinned: Boolean(s.pinned), archived: Boolean(s.archived), updatedAt: s.updatedAt, messageCount: s.messages.length }
      } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => (a.archived - b.archived) || (b.pinned - a.pinned) || (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

// Full-text search across all past sessions (title + message text).
export function searchSessions (query, limit = 30) {
  ensureDirs()
  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  const out = []
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue
    let s
    try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')) } catch { continue }
    const texts = []
    for (const m of s.messages || []) {
      if (m.text) texts.push(m.text)
      for (const p of m.parts || []) if (p.type === 'text' && p.text) texts.push(p.text)
    }
    const hay = ((s.title || '') + '\n' + texts.join('\n')).toLowerCase()
    const idx = hay.indexOf(q)
    if (idx === -1) continue
    const snippet = hay.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ').trim()
    out.push({ id: s.id, title: s.title || 'Untitled', snippet, updatedAt: s.updatedAt, messageCount: (s.messages || []).length })
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, limit)
}

export function loadSession (id) {
  if (!/^[a-z0-9-]+$/.test(id)) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8'))
  } catch { return null }
}

export function saveSession (session) {
  ensureDirs()
  session.updatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(SESSIONS_DIR, session.id + '.json'), JSON.stringify(session, null, 2))
}

// ---- tasks ----
// ⚠️ ONE FILE PER TASK, like sessions. Two Macs both editing a shared board file
// would lose cards outright: iCloud Drive has no merge, it picks a winner. A
// card moved on the laptop and a card added on the desktop must both survive.
//
// A task is NOT a parallel world. It is a goal plus a lifecycle, pointing at an
// ordinary session — so the agent's own checklist, its approvals, its model and
// its transcript are the same objects the rest of the app already uses. The
// board reads state that exists; it does not keep a second copy of the truth.
//
// State is one of: queued | working | blocked | review | done.
// Only `queued` and `done` are set by a person. `working`, `blocked` and
// `review` are set by the run itself, from events the server already emits, so
// a card cannot claim progress that did not happen.
export const TASK_STATES = ['queued', 'working', 'blocked', 'review', 'done']

export function listTasks () {
  ensureDirs()
  return fs.readdirSync(TASKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export function loadTask (id) {
  if (!/^[a-z0-9-]+$/.test(id)) return null
  try { return JSON.parse(fs.readFileSync(path.join(TASKS_DIR, id + '.json'), 'utf8')) } catch { return null }
}

export function saveTask (task) {
  ensureDirs()
  if (!/^[a-z0-9-]+$/.test(task.id)) throw new Error('bad task id')
  if (!TASK_STATES.includes(task.state)) throw new Error(`unknown task state: ${task.state}`)
  task.updatedAt = new Date().toISOString()
  writeJsonAtomic(path.join(TASKS_DIR, task.id + '.json'), task)
  return task
}

export function deleteTask (id) {
  if (!/^[a-z0-9-]+$/.test(id)) return
  try { fs.unlinkSync(path.join(TASKS_DIR, id + '.json')) } catch {}
}

// Permanent: unlinks the transcript, every message and every tool call with it.
// There is no undo and no trash. The sidebar reaches this only from the archive,
// behind its own confirm — archiving is what a session row's ✕ does.
export function deleteSession (id) {
  if (!/^[a-z0-9-]+$/.test(id)) return
  try { fs.unlinkSync(path.join(SESSIONS_DIR, id + '.json')) } catch {}
}
