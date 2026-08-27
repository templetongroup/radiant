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
