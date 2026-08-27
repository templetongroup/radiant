/**
 * Skills, on the phone.
 *
 * ⚠️ THESE ARE NOT THE MAC'S SKILLS, AND SHOULD NOT BECOME THEM. The Mac's
 * skills assume a repository, a filesystem and tools — "read SKILL.md in this
 * skill's folder", "run the tests", "grep for callers". None of that exists
 * here: the phone has no workspace, no shell, and a 2–4 GB model that follows
 * long instructions far less reliably than Claude does. Porting that library
 * across would produce skills that quietly do nothing.
 *
 * What works on a phone is short and about the SHAPE of the answer. Every
 * bundled skill below is one or two sentences, and the editor warns past a few
 * hundred characters, because every character spent here is taken from a 4,000
 * character prompt budget that also has to hold the conversation.
 *
 * localStorage, same as chats.js, under the same `radiant.phone.` prefix so
 * "clear everything" in Settings still finds it. Skills are content, not
 * credentials.
 */

const KEY = 'radiant.phone.skills'
const SEEDED = 'radiant.phone.skillsSeeded'

/** Roughly a quarter of the prompt budget. See MobileChat's PROMPT_CHARS. */
export const MAX_SKILL_CHARS = 900

/**
 * What ships with the app.
 *
 * Deliberately about tone and format, never about tools or files. Each one is
 * something a small model can actually hold onto for a whole reply.
 */
const BUNDLED = [
  {
    id: 'seed-plain',
    name: 'Plain English',
    body: 'Answer in plain English that a smart person outside software would follow on the first read. No jargon unless you define it in the same sentence.'
  },
  {
    id: 'seed-brief',
    name: 'Keep it short',
    body: 'Answer in at most three sentences. If the honest answer needs more room, give the short answer first and say what you left out.'
  },
  {
    id: 'seed-steps',
    name: 'Step by step',
    body: 'Give the answer as numbered steps in the order I should do them. One action per step. Say what I should see after each one.'
  },
  {
    id: 'seed-reasoning',
    name: 'Show your reasoning',
    body: 'Before the answer, state briefly what you are assuming and why you are taking this approach. If you are unsure, say which part you are unsure about rather than picking confidently.'
  },
  {
    id: 'seed-devil',
    name: 'Argue the other side',
    body: 'Give the strongest case against what I just said before you agree with any of it. Be specific rather than balanced.'
  }
]

const read = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    return Array.isArray(raw) ? raw : null
  } catch { return null }
}

const write = (rows) => {
  try { localStorage.setItem(KEY, JSON.stringify(rows)) } catch { /* private mode */ }
  // Same contract as chats.js: every write announces itself, so a screen
  // mounted underneath another does not show a stale list on the way back.
  try { window.dispatchEvent(new CustomEvent('rx:skills-changed')) } catch { /* SSR */ }
}

/**
 * ⚠️ SEED ONCE, NOT EVERY LAUNCH. A separate flag records that the bundled
 * skills have been installed, so deleting one makes it stay deleted. Testing
 * "is the list empty" instead would resurrect all five the moment someone
 * cleared the last one.
 */
export function listSkills () {
  const stored = read()
  if (stored) return stored
  let seeded = false
  try { seeded = localStorage.getItem(SEEDED) === '1' } catch {}
  if (seeded) return []
  const rows = BUNDLED.map(s => ({ ...s, builtin: true }))
  write(rows)
  try { localStorage.setItem(SEEDED, '1') } catch {}
  return rows
}

export function getSkill (id) {
  if (!id) return null
  return listSkills().find(s => s.id === id) || null
}

export function saveSkill ({ id, name, body }) {
  const clean = String(name || '').trim().slice(0, 60)
  const text = String(body || '').trim().slice(0, MAX_SKILL_CHARS)
  if (!clean || !text) return null
  const rows = listSkills()
  const at = id ? rows.findIndex(s => s.id === id) : -1
  const row = at >= 0
    ? { ...rows[at], name: clean, body: text }
    : { id: 'sk-' + Math.random().toString(36).slice(2, 9), name: clean, body: text }
  if (at >= 0) rows[at] = row; else rows.push(row)
  write(rows)
  return row
}

export function deleteSkill (id) {
  write(listSkills().filter(s => s.id !== id))
}

/** Subscribe to library changes. Returns an unsubscribe. */
export function onSkillsChanged (fn) {
  const h = () => fn()
  window.addEventListener('rx:skills-changed', h)
  return () => window.removeEventListener('rx:skills-changed', h)
}

/**
 * Slash commands.
 *
 * `/plain-english fix this` means "use the Plain English skill for this one
 * message". The Mac has worked this way since the day Tony pointed out that
 * Hermes and Claude both insert the command into the box; the phone shipped
 * without it, so typing the same thing here sent the slash to the model as
 * literal text.
 *
 * Kept here, pure and exported, because the alternative is parsing inside a
 * component nobody can test without a phone.
 */
export const slug = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Skills whose command starts with what has been typed, or [] if it is not a command. */
export function slashMatches (draft, rows = listSkills()) {
  if (!/^\/[\w-]*$/.test(draft || '')) return []
  // Alphabetical: storage order is not an order anyone can predict.
  return rows.map(sk => ({ ...sk, cmd: '/' + slug(sk.name) }))
    .filter(c => c.cmd.startsWith(draft))
    .sort((a, b) => a.cmd.localeCompare(b.cmd))
}

/**
 * Split a leading command off a message.
 *
 * Returns { text, skill }. The command is REMOVED from the text: the skill's
 * instructions reach the model at the head of the prompt, where they work,
 * rather than as a bare word at the top of the request. An unknown command is
 * left alone — it is far likelier to be a date or a path than a typo.
 */
export function parseSlash (body, rows = listSkills()) {
  const text = String(body || '').trim()
  const lead = /^\/([\w-]+)\s*/.exec(text)
  if (!lead) return { text, skill: null }
  const skill = rows.find(sk => slug(sk.name) === lead[1])
  if (!skill) return { text, skill: null }
  const rest = text.slice(lead[0].length).trim()
  return { text: rest || `Use the ${skill.name} skill.`, skill }
}

/**
 * Read a SKILL.md (or any markdown) into a phone skill.
 *
 * ⚠️ NEVER SILENTLY TRUNCATE. A skill cut in half still looks like a skill and
 * quietly stops working, which is worse than refusing it. `tooLong` is reported
 * and the caller has to decide; nothing here shortens anything.
 */
export function parseSkillMarkdown (text, filename = '') {
  const raw = String(text || '')
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(raw)
  const meta = fm ? fm[1] : ''
  const field = k => {
    const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(meta)
    return m ? m[1].trim().replace(/^["'>]+|["']+$/g, '').trim() : ''
  }
  let body = (fm ? raw.slice(fm[0].length) : raw).trim()
  // A leading "# Title" is the document's name, not an instruction.
  const h1 = /^#\s+(.+)\s*\n+/.exec(body)
  const heading = h1 ? h1[1].trim() : ''
  if (h1) body = body.slice(h1[0].length).trim()

  const name = (field('name') || heading ||
    filename.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]/g, ' ')).slice(0, 60).trim()
  return { name, body, tooLong: body.length > MAX_SKILL_CHARS, length: body.length }
}

// ── the Mac ──────────────────────────────────────────────────────────────────

const MAC_KEY = 'radiant.phone.mac'

export const readMac = () => {
  try { return JSON.parse(localStorage.getItem(MAC_KEY) || 'null') || { base: '', token: '' } }
  catch { return { base: '', token: '' } }
}
export const saveMac = (mac) => {
  try { localStorage.setItem(MAC_KEY, JSON.stringify(mac)) } catch { /* private mode */ }
}

/** `100.1.2.3:5834`, `host.local:5834` or a full URL all become one origin. */
export function macOrigin (input) {
  let v = String(input || '').trim().replace(/\/+$/, '')
  if (!v) return ''
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v
  try { return new URL(v).origin } catch { return '' }
}

/**
 * Fetch the Mac's skills.
 *
 * ⚠️ MOST MAC SKILLS CANNOT WORK HERE, AND THE HONEST ANSWER IS TO SAY SO. A
 * library skill's text is one line — "read SKILL.md in this skill's folder" —
 * and the phone has no folder and no way to read one. Those come back flagged
 * `reason`, shown and disabled, rather than imported as an instruction that
 * points at nothing.
 */
export async function fetchMacSkills (base, token) {
  const origin = macOrigin(base)
  if (!origin) throw new Error('bad_address')
  const res = await fetch(origin + '/api/config', {
    headers: token ? { 'x-radiant-token': token } : {},
    cache: 'no-store'
  })
  if (res.status === 401 || res.status === 403) throw new Error('unauthorized')
  if (!res.ok) throw new Error('http_' + res.status)
  const cfg = await res.json()
  return (cfg.skills || []).map(sk => {
    const body = String(sk.content || '').trim()
    const reason = sk.dir ? 'needs a folder — Mac only'
      : !body ? 'empty'
      : body.length > MAX_SKILL_CHARS ? `too long for the phone (${body.length} characters)`
      : null
    return { id: sk.id, name: sk.name || 'Untitled', body, reason }
  })
}

