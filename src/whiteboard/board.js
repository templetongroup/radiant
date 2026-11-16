// The whiteboard page's pure half: no React, no network, so it can be tested.
// The server keeps its own copy of the shapes (server/whiteboard.js); this is
// what the page needs to edit a board in your hands.

export const COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple']
export const NOTE = { w: 240, h: 110 }
export const STICKERS = {
  rocket: '🚀', flag: '🚩', star: '⭐', idea: '💡', check: '✅', warning: '⚠️', money: '💰', calendar: '📅',
  people: '👥', chart: '📈', target: '🎯', tools: '🛠️', mail: '✉️', phone: '📞', home: '🏠', plane: '✈️',
  car: '🚗', map: '🗺️', book: '📚', heart: '❤️', fire: '🔥', clock: '⏰', lock: '🔒', gift: '🎁',
  music: '🎵', camera: '📷', coffee: '☕', trophy: '🏆', puzzle: '🧩', leaf: '🌿', sun: '☀️', question: '❓'
}
export const MARK_WORDS = { doing: 'Chat is on it', done: 'Chat: done', blocked: 'Blocked' }
export const MAX_ITEMS = 600

export const uid = p => `${p}${Math.random().toString(16).slice(2, 12)}`

// ---------- geometry ----------

export const centre = i => ({ x: i.x + i.w / 2, y: i.y + i.h / 2 })
export const inside = (it, g) => { const c = centre(it); return c.x >= g.x && c.x <= g.x + g.w && c.y >= g.y && c.y <= g.y + g.h }
export const overlaps = (a, r) => a.x < r.x + r.w && a.x + a.w > r.x && a.y < r.y + r.h && a.y + a.h > r.y
export const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })

export function bounds (items) {
  if (!items.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...items.map(i => i.x)), y = Math.min(...items.map(i => i.y))
  return { x, y, w: Math.max(...items.map(i => i.x + i.w)) - x, h: Math.max(...items.map(i => i.y + i.h)) - y }
}

/** The view that fits `items` in a `vw`×`vh` window. */
export function fitView (items, vw, vh, pad = 80) {
  const b = bounds(items)
  if (!b.w || !b.h) return { x: vw / 2, y: vh / 2, zoom: 1 }
  const zoom = Math.max(0.15, Math.min(1.2, Math.min((vw - pad * 2) / b.w, (vh - pad * 2) / b.h)))
  return { zoom, x: vw / 2 - (b.x + b.w / 2) * zoom, y: vh / 2 - (b.y + b.h / 2) * zoom }
}

/** Items a section carries when it moves: everything whose centre sits inside it. */
export function carried (board, group) {
  return board.items.filter(i => i.id !== group.id && i.kind !== 'group' && inside(i, group))
}

export const sectionOf = (board, note) => board.items.filter(g => g.kind === 'group' && inside(note, g)).sort((a, z) => a.w * a.h - z.w * z.h)[0] || null

/** A clear spot to the right of `anchor` (or the board's right edge). */
export function spotBeside (board, anchor, size = NOTE) {
  const fits = (x, y) => !board.items.some(i => i.kind !== 'group' && i.kind !== 'ink' && overlaps({ x: x - 8, y: y - 8, w: size.w + 16, h: size.h + 16 }, i))
  const sx = anchor ? anchor.x + anchor.w + 30 : 0
  const sy = anchor ? anchor.y : 0
  for (let k = 0; k < 48; k++) {
    const x = sx + Math.floor(k / 8) * (size.w + 30), y = sy + (k % 8) * 40
    if (fits(x, y)) return { x, y }
  }
  return { x: Math.max(0, ...board.items.map(i => i.x + i.w)) + 40, y: sy }
}

// ---------- history ----------

/** Undo/redo as whole-board snapshots of items and links. Small boards, so this is cheap. */
export function history (limit = 80) {
  let past = [], future = []
  const snap = b => JSON.stringify({ items: b.items, links: b.links, proposals: b.proposals })
  return {
    push (b) { past.push(snap(b)); if (past.length > limit) past.shift(); future = [] },
    undo (b) { if (!past.length) return null; future.push(snap(b)); return { ...b, ...JSON.parse(past.pop()) } },
    redo (b) { if (!future.length) return null; past.push(snap(b)); return { ...b, ...JSON.parse(future.pop()) } },
    get canUndo () { return past.length > 0 },
    get canRedo () { return future.length > 0 }
  }
}

// ---------- editing ----------

/** Copy: the items, plus links between them. Paste: fresh ids, nudged so you can see it landed. */
export function copyOf (board, ids) {
  const set = new Set(ids)
  return { items: board.items.filter(i => set.has(i.id)), links: board.links.filter(l => set.has(l.from) && set.has(l.to) && l.kind === 'arrow') }
}
export function pasted (clip, dx = 30, dy = 30) {
  const map = new Map(clip.items.map(i => [i.id, uid(i.kind[0])]))
  return {
    items: clip.items.map(i => ({ ...i, id: map.get(i.id), x: i.x + dx, y: i.y + dy, by: 'you', mark: undefined, taskId: undefined, taskState: undefined, chatAsk: undefined, rev: 0, points: i.points?.map(([x, y]) => [x + dx, y + dy]) })),
    links: clip.links.map(l => ({ ...l, id: uid('l'), from: map.get(l.from), to: map.get(l.to), rev: 0 }))
  }
}

export function removeItems (board, ids) {
  const set = new Set(ids)
  return { ...board, items: board.items.filter(i => !set.has(i.id)), links: board.links.filter(l => !set.has(l.from) && !set.has(l.to)) }
}

// ---------- suggestions ----------

/**
 * Accept one suggestion. Returns the new board (results are accepted on the
 * server, which places the card; everything else here).
 */
export function acceptProposal (board, p) {
  const decided = board.proposals.map(x => x.id === p.id ? { ...x, state: 'accepted' } : x)
  let b = { ...board, proposals: decided, items: [...board.items], links: [...board.links] }
  const sectionByTitle = t => t && b.items.find(i => i.kind === 'group' && i.title.toLowerCase() === String(t).toLowerCase())
  if (p.kind === 'note' || p.kind === 'action') {
    const from = p.from && b.items.find(i => i.id === p.from)
    const sec = sectionByTitle(p.section)
    let at
    if (sec) {
      const inSec = b.items.filter(i => i.kind === 'note' && inside(i, sec))
      at = { x: sec.x + 20, y: Math.max(sec.y + 64, ...inSec.map(i => i.y + i.h + 14)) }
      const need = at.y + NOTE.h + 20 - (sec.y + sec.h)
      if (need > 0) b.items = b.items.map(i => i.id === sec.id ? { ...i, h: i.h + need } : i)
    } else at = spotBeside(b, from || null)
    const note = { id: uid('n'), kind: 'note', ...at, ...NOTE, text: p.text, color: p.kind === 'action' ? 'orange' : 'yellow', action: p.kind === 'action' || Boolean(p.action), owner: p.owner, due: p.due, by: p.by || 'radiant' }
    b.items.push(note)
    if (from) b.links.push({ id: uid('l'), kind: 'arrow', from: from.id, to: note.id })
  } else if (p.kind === 'owner') {
    b.items = b.items.map(i => i.id === p.noteId ? { ...i, owner: p.owner } : i)
  } else if (p.kind === 'group') {
    // a new section to the right of the board, with its notes moved into it in a column
    const notes = p.noteIds.map(id => b.items.find(i => i.id === id)).filter(Boolean)
    if (notes.length) {
      const right = Math.max(0, ...b.items.map(i => i.x + i.w)) + 80
      const top = Math.min(...notes.map(n => n.y))
      const g = { id: uid('g'), kind: 'group', x: right, y: top, w: NOTE.w + 40, h: 64 + notes.length * (NOTE.h + 14) + 20, title: p.title, sticker: p.sticker, by: p.by || 'radiant' }
      const moved = new Map(notes.map((n, k) => [n.id, { x: g.x + 20, y: g.y + 64 + k * (NOTE.h + 14) }]))
      b.items = b.items.map(i => moved.has(i.id) ? { ...i, ...moved.get(i.id) } : i)
      b.items.push(g)
    }
  }
  return b
}

export const skipProposal = (board, p) => ({ ...board, proposals: board.proposals.map(x => x.id === p.id ? { ...x, state: 'skipped' } : x) })

/** A short line for a suggestion in the tray. */
export function proposalLine (p, board) {
  const note = id => board.items.find(i => i.id === id)
  switch (p.kind) {
    case 'group': return `Group ${p.noteIds.length} note${p.noteIds.length === 1 ? '' : 's'} as "${p.title}"`
    case 'action': return `Action: ${p.text}${p.owner ? ` — ${p.owner}` : ''}${p.due ? ` (due ${p.due})` : ''}`
    case 'owner': return `${p.owner} owns "${(note(p.noteId)?.text || 'a note').slice(0, 50)}"`
    case 'result': return `Result for "${(note(p.noteId)?.text || 'a note').slice(0, 50)}": ${p.title || p.text.slice(0, 60)}`
    default: return `Note: ${p.text}`
  }
}

// ---------- export ----------

/** The board as a table to paste into a spreadsheet. */
export function asTable (board) {
  const rows = board.items.filter(i => i.kind === 'note').map(n => {
    const r = board.items.find(i => i.kind === 'result' && i.for === n.id)
    return [sectionOf(board, n)?.title || '', n.text, n.action ? 'yes' : '', n.owner || '', n.due || '', (r?.text || '').replace(/\s+/g, ' ').slice(0, 500)]
  })
  const cell = v => String(v ?? '').replace(/[\t\n]+/g, ' ')
  return [['Section', 'Note', 'Action', 'Owner', 'Due', 'Result'], ...rows].map(r => r.map(cell).join('\t')).join('\n')
}

/** What the linked chat should be asked to do for these notes. */
export function chatRequest (board, notes) {
  if (notes.length === 1) return `From the whiteboard "${board.name}": please do this item and tell me the outcome.\n\n${notes[0].text}${notes[0].owner ? `\nOwner: ${notes[0].owner}` : ''}${notes[0].due ? `\nDue: ${notes[0].due}` : ''}`
  return `From the whiteboard "${board.name}": please work through these items in order and tell me the outcome of each.\n\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}`
}
