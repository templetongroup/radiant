/**
 * Conversations, kept.
 *
 * ⚠️ THEY WERE NOT. MobileChat held its transcript in React state and wrote it
 * nowhere, so leaving the chat screen threw the conversation away — and the
 * shell's `hasSavedConversation()` hunted for storage keys nothing has ever
 * written. An app you return to has to remember what you were doing; a home
 * screen listing recent chats is impossible without this.
 *
 * localStorage, not the Keychain: a transcript is content, not a credential,
 * and it is already sitting in the web view's memory. Keys stay under one
 * prefix so `clear everything` in Settings can find them.
 */
const KEY = 'radiant.phone.chats'
const MAX = 40          // enough to feel complete, small enough to stay fast
const MAX_TURNS = 200   // one conversation cannot grow without bound

const read = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

/**
 * Every write announces itself.
 *
 * ⚠️ DO NOT make a screen's freshness depend on navigation. Home sits mounted
 * underneath the chat that is pushed over it, so it never remounts on the way
 * back and a list read at mount is what stays on screen — which is exactly how
 * a chat you had just started failed to appear. Tying the refresh to "the pop
 * animation finished" would make correctness depend on a transition. The store
 * tells its readers instead, the moment the data actually changes.
 */
const write = (rows) => {
  // ⚠️ THE CAP MUST NOT EAT WHAT YOU DELIBERATELY KEPT. Trimming to MAX
  // blindly meant the 41st conversation silently deleted the oldest — which is
  // fine for chatter and wrong for anything you archived on purpose. Archived
  // rows are exempt; the cap applies to the rest.
  const keep = rows.filter(c => c.archived)
  const rest = rows.filter(c => !c.archived).slice(0, MAX)
  const trimmed = rows.filter(c => keep.includes(c) || rest.includes(c))
  try { localStorage.setItem(KEY, JSON.stringify(trimmed)) } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent('rx:chats-changed')) } catch { /* SSR */ }
}

/** Subscribe to conversation changes. Returns an unsubscribe. */
export function onChatsChanged (fn) {
  window.addEventListener('rx:chats-changed', fn)
  return () => window.removeEventListener('rx:chats-changed', fn)
}

/** Newest first. Metadata only — enough to draw a list without parsing every turn. */
export function listChats ({ archived = false } = {}) {
  return read()
    .filter(c => Boolean(c.archived) === Boolean(archived))
    .map(c => ({
      id: c.id,
      title: c.title || 'New chat',
      modelId: c.modelId || null,
      modelName: c.modelName || null,
      updatedAt: c.updatedAt || 0,
      archived: Boolean(c.archived),
      turns: Array.isArray(c.messages) ? c.messages.length : 0
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Put a conversation away, or bring it back.
 *
 * ⚠️ ARCHIVING IS NOT DELETING, AND IT IS NOT A TIDIER DELETE EITHER. It is the
 * only way to tell this store that a conversation matters: an archived row is
 * exempt from the 40-chat cap that otherwise drops the oldest without a word.
 */
export function setArchived (id, archived) {
  const rows = read()
  const row = rows.find(c => c.id === id)
  if (!row) return
  row.archived = Boolean(archived)
  write(rows)
}

export function loadChat (id) {
  return read().find(c => c.id === id) || null
}

/**
 * A conversation's title is its first question, trimmed — the same thing every
 * messaging app does, and better than asking a model to name it, which costs a
 * round trip to say something the user already wrote.
 */
function titleFrom (messages) {
  const first = messages.find(m => m.role === 'user' && m.text?.trim())
  if (!first) return 'New chat'
  const t = first.text.trim().replace(/\s+/g, ' ')
  return t.length > 60 ? t.slice(0, 57).trimEnd() + '…' : t
}

export function saveChat ({ id, messages, modelId, modelName, skillId }) {
  if (!id || !Array.isArray(messages) || !messages.length) return
  const prev = read().find(c => c.id === id)
  const rows = read().filter(c => c.id !== id)
  rows.unshift({
    id,
    // carried, or using an archived chat would quietly un-archive it
    archived: Boolean(prev?.archived),
    title: titleFrom(messages),
    modelId: modelId || null,
    modelName: modelName || null,
    // ⚠️ THE CHOSEN SKILL BELONGS TO THE CHAT, NOT THE SCREEN. Held only in
    // React state it would vanish on leaving the conversation, silently, and
    // the next reply would come back in a different voice with nothing to
    // explain why.
    skillId: skillId || null,
    updatedAt: Date.now(),
    messages: messages.slice(-MAX_TURNS)
  })
  write(rows)
}

/** Every stored conversation, whole — for the native preview, which shows them itself. */
export function allChats () {
  return read()
}

/**
 * A conversation changed in the native preview (NativePreview.swift). It sends
 * back only id, role and text per message, so anything else a message carries
 * here (a photo, an error, a model name) is kept from the stored copy, and the
 * chat keeps its skill.
 */
export function saveFromNative ({ id, messages, modelId, modelName }) {
  if (!id || !Array.isArray(messages)) return
  const prev = loadChat(id)
  const byId = new Map((prev?.messages || []).map(m => [m.id, m]))
  const merged = messages.map(m => (byId.has(m.id) ? { ...byId.get(m.id), text: m.text } : { id: m.id, role: m.role, text: m.text }))
  saveChat({ id, messages: merged, modelId: modelId || prev?.modelId, modelName: modelName || prev?.modelName, skillId: prev?.skillId })
}

export function deleteChat (id) {
  write(read().filter(c => c.id !== id))
}

export function deleteAllChats () {
  write([])
}

/** A stable id for a new conversation, without pulling in a uuid dependency. */
export function newChatId () {
  return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
}

/** "2 minutes ago", "Yesterday", "12 Aug" — a list needs when, not a timestamp. */
export function whenLabel (ts) {
  if (!ts) return ''
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })
}
