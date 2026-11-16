import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { whiteboardApi as wb, authHeaders } from '../api.js'
import Markdown from './Markdown.jsx'
import {
  COLORS, NOTE, STICKERS, MARK_WORDS, MAX_ITEMS, uid, centre, inside, overlaps, rectOf, bounds, fitView,
  carried, sectionOf, spotBeside, history, copyOf, pasted, removeItems, acceptProposal, skipProposal,
  proposalLine, asTable, chatRequest
} from '../whiteboard/board.js'

/**
 * The whiteboard. You think a plan through on a board; Radiant lays it out,
 * groups your notes and sends agents to do the work, right there on it.
 * Modelled on Adolanium/hermes-whiteboard (MIT); the server half is
 * server/whiteboard*.js.
 *
 * ⚠️ NOTHING RUNS UNTIL YOU CLICK. Laying out, grouping, unpacking and the
 * brief are one model turn each with no tools. Hand to Radiant, Run and Ask
 * start agents that may search the web; they cannot ask you anything, so
 * anything that needs approval is refused and the card says so.
 *
 * ⚠️ THE PAGE IS NOT THE ONLY WRITER. Agents and chats add results,
 * suggestions and status marks on the server while you edit. adopt() folds
 * those in without undoing your own unsaved edits, and every save carries the
 * revision it started from (see mergeSave in server/whiteboard.js).
 */

const TASK_WORDS = { queued: 'Queued', working: 'Working', blocked: 'Needs you', review: 'Review', done: 'Done', gone: 'Task deleted' }
const SERVER_FIELDS = ['mark', 'taskId', 'taskState', 'chatAsk']
const LAST = 'radiant.whiteboard.last'

/** Fold the server's copy into ours: keep our unsaved edits, take what agents and chats added or removed. */
function adopt (local, server, known) {
  const sItems = new Map(server.items.map(i => [i.id, i]))
  const lIds = new Set(local.items.map(i => i.id))
  const items = local.items
    .filter(i => sItems.has(i.id) || !known.has(i.id))
    .map(i => { const s = sItems.get(i.id); if (!s) return i; const o = { ...i }; for (const f of SERVER_FIELDS) o[f] = s[f]; return o })
  for (const s of server.items) if (!lIds.has(s.id) && !known.has(s.id)) items.push(s)
  const sLinks = new Set(server.links.map(l => l.id))
  const lLinks = new Set(local.links.map(l => l.id))
  const links = [...local.links.filter(l => sLinks.has(l.id) || !known.has(l.id)), ...server.links.filter(l => !lLinks.has(l.id) && !known.has(l.id))]
  const mine = new Map(local.proposals.map(p => [p.id, p]))
  const proposals = server.proposals.map(p => (mine.get(p.id)?.state !== 'pending' && mine.has(p.id)) ? mine.get(p.id) : p)
  for (const p of local.proposals) if (!proposals.some(x => x.id === p.id)) proposals.push(p)
  return { ...local, items, links, proposals, brief: server.brief, chatId: server.chatId, rev: server.rev }
}
const idsOf = b => new Set([...b.items.map(i => i.id), ...b.links.map(l => l.id)])

export default function Whiteboard ({ models = [], sessions = [], onError, onOpenChat, onAskInChat }) {
  const [boards, setBoards] = useState([])
  const [board, setBoard] = useState(null)
  const [view, setView] = useState({ x: 200, y: 160, zoom: 1 })
  const [sel, setSel] = useState([])
  const [editing, setEditing] = useState(null)
  const [tool, setTool] = useState('select')
  const [activity, setActivity] = useState({ running: false, jobs: {} })
  const [chat, setChat] = useState(null)
  const [compose, setCompose] = useState({ text: '', layout: '', busy: false })
  const [busy, setBusy] = useState('')
  const [dialog, setDialog] = useState(null) // { kind: 'ask' | 'tasks' | 'where' | 'link' | 'stickers' | 'export' | 'boards', ... }
  const [tray, setTray] = useState(false)
  const [box, setBox] = useState(null) // area selection rect, world coords
  const [ink, setInk] = useState(null) // the stroke being drawn
  const [cursor, setCursor] = useState(null) // Radiant's gold cursor while it places a laid-out board
  const [arrowFrom, setArrowFrom] = useState(null)
  const [pendingChanges, setPendingChanges] = useState([])
  const [tasksRefresh, setTasksRefresh] = useState(null)

  const wrap = useRef(null)
  const hist = useRef(history())
  const baseRev = useRef(0)
  const known = useRef(new Set())
  const dirty = useRef(false)
  const saving = useRef(false)
  const saveTimer = useRef(null)
  const drag = useRef(null)
  const clip = useRef(null)
  const boardRef = useRef(null)
  boardRef.current = board
  const fitNext = useRef(false)
  // fit once the canvas exists: on the first open it is not rendered yet
  useEffect(() => {
    if (!board || !fitNext.current || !wrap.current) return
    fitNext.current = false
    const r = wrap.current.getBoundingClientRect()
    setView(board.items.length ? fitView(board.items, r.width, r.height) : { x: r.width / 2, y: r.height / 3, zoom: 1 })
  }, [board?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const fail = useCallback(e => onError?.(e?.message || String(e)), [onError])

  /**
   * Take the server's copy. ⚠️ THE SET OF IDS WE KNOW IS READ NOW, NOT INSIDE
   * THE UPDATER: React runs the updater later, after known.current has moved on
   * to the server's ids — and then every new result looked like something you
   * had deleted, and never appeared.
   */
  const take = useCallback((server, also = []) => {
    const k = new Set([...known.current, ...also])
    setBoard(cur => cur && cur.id === server.id ? adopt(cur, server, k) : cur)
    known.current = idsOf(server)
    baseRev.current = server.rev
  }, [])

  // ---------- loading & saving ----------

  const loadList = useCallback(() => wb.list().then(setBoards).catch(() => {}), [])
  const open = useCallback(async (id, { fit = true } = {}) => {
    try {
      const b = await wb.get(id)
      hist.current = history()
      baseRev.current = b.rev
      known.current = idsOf(b)
      dirty.current = false
      setBoard(b); setSel([]); setEditing(null); setActivity(b.activity || { running: false, jobs: {} })
      try { localStorage.setItem(LAST, id) } catch {}
      fitNext.current = fit
    } catch (e) { fail(e) }
  }, [fail])

  useEffect(() => {
    wb.list().then(async list => {
      setBoards(list)
      let last = null
      try { last = localStorage.getItem(LAST) } catch {}
      const pick = list.find(b => b.id === last) || list[0]
      if (pick) open(pick.id)
      else { const b = await wb.create('My first board'); setBoards([b]); open(b.id) }
    }).catch(fail)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    const b = boardRef.current
    if (!b || saving.current || !dirty.current) return
    saving.current = true
    dirty.current = false
    const sent = b
    try {
      const server = await wb.save(b.id, sent, baseRev.current)
      take(server, idsOf(sent))
    } catch (e) { dirty.current = true; fail(e) } finally {
      saving.current = false
      if (dirty.current) { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(flush, 400) }
    }
  }, [fail, take])

  /** Change the board. `undoable` snapshots first, so Cmd Z brings it back. */
  const change = useCallback((fn, undoable = true) => {
    setBoard(cur => {
      if (!cur) return cur
      const next = fn(cur)
      if (!next || next === cur) return cur
      if (undoable) hist.current.push(cur)
      if (next.items.length > MAX_ITEMS) { fail(new Error(`A board holds up to ${MAX_ITEMS} items.`)); return cur }
      return next
    })
    dirty.current = true
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 500)
  }, [flush, fail])

  useEffect(() => () => { clearTimeout(saveTimer.current); flush() }, [flush])

  // Pull what agents and chats did. Faster while something is happening.
  const pull = useCallback(async () => {
    const b = boardRef.current
    if (!b || saving.current) return
    try {
      const [server, act] = await Promise.all([wb.get(b.id), wb.activity(b.id)])
      setActivity(act)
      if (server.rev !== baseRev.current && !saving.current) {
        take(server)
      }
    } catch {}
  }, [take])
  useEffect(() => {
    if (!board?.id) return
    const fast = activity.running || board.chatId || board.items.some(i => i.chatAsk)
    const t = setInterval(pull, fast ? 1800 : 6000)
    return () => clearInterval(t)
  }, [board?.id, board?.chatId, activity.running, pull]) // eslint-disable-line react-hooks/exhaustive-deps

  // The linked chat: is it working, how did its last turn end, did it answer.
  useEffect(() => {
    if (!board?.chatId) { setChat(null); return }
    let live = true
    const tick = () => wb.chat(board.id).then(c => { if (live) setChat(c) }).catch(() => {})
    const changes = () => wb.changes(board.id).then(r => { if (live) setPendingChanges(r.lines || []) }).catch(() => {})
    tick(); changes()
    const t = setInterval(() => { tick(); changes() }, 4000)
    return () => { live = false; clearInterval(t) }
  }, [board?.id, board?.chatId])

  // Tasks: each note's task as it is now, about every 25 seconds.
  const hasTasks = Boolean(board?.items.some(i => i.taskId))
  useEffect(() => {
    if (!board?.id || !hasTasks) return
    const tick = async () => {
      try {
        await wb.taskStates(board.id)
        if (board.taskBoard) {
          const r = await wb.tasksRefresh(board.id)
          setTasksRefresh(r.moves.length || r.adds.length ? r : null)
        }
        pull()
      } catch {}
    }
    tick()
    const t = setInterval(tick, 25000)
    return () => clearInterval(t)
  }, [board?.id, hasTasks, board?.taskBoard, pull])

  // ---------- coordinates ----------

  const toWorld = useCallback((cx, cy) => {
    const r = wrap.current.getBoundingClientRect()
    return { x: (cx - r.left - view.x) / view.zoom, y: (cy - r.top - view.y) / view.zoom }
  }, [view])
  const centreOfView = () => {
    const r = wrap.current.getBoundingClientRect()
    return toWorld(r.left + r.width / 2, r.top + r.height / 2)
  }

  // ---------- items ----------

  const byId = useMemo(() => new Map((board?.items || []).map(i => [i.id, i])), [board])
  const selected = sel.map(id => byId.get(id)).filter(Boolean)
  const setItem = (id, patch, undoable = true) => change(b => ({ ...b, items: b.items.map(i => i.id === id ? { ...i, ...patch } : i) }), undoable)

  const addNote = (at, extra = {}) => {
    const note = { id: uid('n'), kind: 'note', x: at.x - NOTE.w / 2, y: at.y - NOTE.h / 2, ...NOTE, text: '', color: 'yellow', by: 'you', ...extra }
    change(b => ({ ...b, items: [...b.items, note] }))
    setSel([note.id]); setEditing(note.id)
  }
  const addText = at => {
    const t = { id: uid('t'), kind: 'text', x: at.x - 160, y: at.y - 20, w: 320, h: 60, text: '', size: 24, by: 'you' }
    change(b => ({ ...b, items: [...b.items, t] }))
    setSel([t.id]); setEditing(t.id)
  }
  const addSticker = (name, at) => {
    const s = { id: uid('s'), kind: 'sticker', x: at.x - 36, y: at.y - 36, w: 72, h: 72, sticker: name, by: 'you' }
    change(b => ({ ...b, items: [...b.items, s] }))
    setSel([s.id])
  }
  const addGroupAround = () => {
    const picked = selected.filter(i => i.kind !== 'group')
    if (!picked.length) return
    const bb = bounds(picked)
    const g = { id: uid('g'), kind: 'group', x: bb.x - 20, y: bb.y - 64, w: bb.w + 40, h: bb.h + 84, title: 'New section', by: 'you' }
    change(b => ({ ...b, items: [g, ...b.items] }))
    setSel([g.id]); setEditing(g.id)
  }
  const del = () => { if (!sel.length) return; change(b => removeItems(b, sel)); setSel([]); setEditing(null) }
  const duplicate = () => {
    if (!sel.length) return
    const p = pasted(copyOf(board, sel))
    change(b => ({ ...b, items: [...b.items, ...p.items], links: [...b.links, ...p.links] }))
    setSel(p.items.map(i => i.id))
  }
  const copy = () => { if (sel.length) clip.current = copyOf(board, sel) }
  const paste = () => {
    if (!clip.current) return
    const p = pasted(clip.current, 40, 40)
    change(b => ({ ...b, items: [...b.items, ...p.items], links: [...b.links, ...p.links] }))
    clip.current = { items: p.items, links: p.links }
    setSel(p.items.map(i => i.id))
  }
  const undo = () => { const b = hist.current.undo(boardRef.current); if (b) { setBoard(b); dirty.current = true; clearTimeout(saveTimer.current); saveTimer.current = setTimeout(flush, 400) } }
  const redo = () => { const b = hist.current.redo(boardRef.current); if (b) { setBoard(b); dirty.current = true; clearTimeout(saveTimer.current); saveTimer.current = setTimeout(flush, 400) } }

  // ---------- keys ----------

  useEffect(() => {
    const onKey = e => {
      if (!board) return
      const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable
      if (typing) { if (e.key === 'Escape') { setEditing(null); e.target.blur() } return }
      const cmd = e.metaKey || e.ctrlKey
      if (cmd && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
      else if (cmd && e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
      else if (cmd && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate() }
      else if (cmd && e.key.toLowerCase() === 'c') { copy() }
      else if (cmd && e.key.toLowerCase() === 'v') { e.preventDefault(); paste() }
      else if (cmd && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(board.items.map(i => i.id)) }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); del() }
      else if (e.key === 'Enter' && sel.length === 1) { e.preventDefault(); setEditing(sel[0]) }
      else if (e.key === 'Escape') { setSel([]); setTool('select'); setArrowFrom(null); setDialog(null) }
      else if (cmd) return
      else if (e.key === 'n' || e.key === 'N') addNote(centreOfView())
      else if (e.key === 't' || e.key === 'T') addText(centreOfView())
      else if (e.key === 'p' || e.key === 'P') setTool(t => t === 'pen' ? 'select' : 'pen')
      else if (e.key === 'l' || e.key === 'L') setTool(t => t === 'area' ? 'select' : 'area')
      else if (e.key === 'a' || e.key === 'A') setTool(t => t === 'arrow' ? 'select' : 'arrow')
      else if (e.key === 'v' || e.key === 'V') setTool('select')
      else if (e.key === 'g' || e.key === 'G') addGroupAround()
      else if (e.key === 'f' || e.key === 'F') fit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- pointer ----------

  const fit = () => { if (board && wrap.current) { const r = wrap.current.getBoundingClientRect(); setView(fitView(board.items, r.width, r.height)) } }
  const zoomBy = (k, cx, cy) => setView(v => {
    const r = wrap.current.getBoundingClientRect()
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2
    const zoom = Math.max(0.12, Math.min(3, v.zoom * k))
    const wx = (px - r.left - v.x) / v.zoom, wy = (py - r.top - v.y) / v.zoom
    return { zoom, x: px - r.left - wx * zoom, y: py - r.top - wy * zoom }
  })

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = e => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
      else setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [board?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const onBoardDown = e => {
    if (e.button !== 0) return
    const p = toWorld(e.clientX, e.clientY)
    if (tool === 'pen') { setInk([[p.x, p.y]]); drag.current = { kind: 'ink' }; e.currentTarget.setPointerCapture(e.pointerId); return }
    if (tool === 'area' || e.shiftKey) { drag.current = { kind: 'box', start: p }; setBox({ x: p.x, y: p.y, w: 0, h: 0 }); e.currentTarget.setPointerCapture(e.pointerId); return }
    setSel([]); setEditing(null); setArrowFrom(null)
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: view }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onItemDown = (e, item) => {
    if (e.button !== 0 || editing === item.id) return
    e.stopPropagation()
    if (tool === 'arrow') {
      if (!arrowFrom) { setArrowFrom(item.id); return }
      if (arrowFrom !== item.id) change(b => ({ ...b, links: [...b.links, { id: uid('l'), kind: 'arrow', from: arrowFrom, to: item.id }] }))
      setArrowFrom(null); setTool('select'); return
    }
    if (tool === 'pen' || tool === 'area') return onBoardDown(e)
    let ids = sel
    if (e.shiftKey || e.metaKey) ids = sel.includes(item.id) ? sel.filter(x => x !== item.id) : [...sel, item.id]
    else if (!sel.includes(item.id)) ids = [item.id]
    setSel(ids)
    const p = toWorld(e.clientX, e.clientY)
    // a section carries the notes inside it
    const moving = new Set(ids)
    for (const id of ids) { const it = byId.get(id); if (it?.kind === 'group') for (const c of carried(board, it)) moving.add(c.id) }
    drag.current = { kind: 'move', start: p, ids: [...moving], orig: new Map([...moving].map(id => [id, { x: byId.get(id).x, y: byId.get(id).y, points: byId.get(id).points }])), snap: board, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onResizeDown = (e, item) => {
    e.stopPropagation()
    drag.current = { kind: 'resize', id: item.id, start: toWorld(e.clientX, e.clientY), w: item.w, h: item.h, snap: board }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = e => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') { setView({ ...d.v, x: d.v.x + e.clientX - d.sx, y: d.v.y + e.clientY - d.sy }); return }
    const p = toWorld(e.clientX, e.clientY)
    if (d.kind === 'ink') { setInk(pts => pts ? [...pts, [p.x, p.y]] : pts); return }
    if (d.kind === 'box') { setBox(rectOf(d.start, p)); return }
    if (d.kind === 'move') {
      const dx = p.x - d.start.x, dy = p.y - d.start.y
      if (!d.moved && Math.hypot(dx, dy) < 3) return
      d.moved = true
      setBoard(b => ({ ...b, items: b.items.map(i => { const o = d.orig.get(i.id); return o ? { ...i, x: o.x + dx, y: o.y + dy, points: o.points?.map(([x, y]) => [x + dx, y + dy]) } : i }) }))
    }
    if (d.kind === 'resize') {
      const w = Math.max(60, d.w + p.x - d.start.x), h = Math.max(40, d.h + p.y - d.start.y)
      setBoard(b => ({ ...b, items: b.items.map(i => i.id === d.id ? { ...i, w, h } : i) }))
    }
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'ink' && ink && ink.length > 1) {
      const xs = ink.map(p => p[0]), ys = ink.map(p => p[1])
      const item = { id: uid('i'), kind: 'ink', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(20, Math.max(...xs) - Math.min(...xs)), h: Math.max(20, Math.max(...ys) - Math.min(...ys)), points: ink, color: '#2b2b2b', by: 'you' }
      change(b => ({ ...b, items: [...b.items, item] }))
    }
    setInk(null)
    if (d.kind === 'box' && box) {
      setSel(board.items.filter(i => overlaps(i, box) && !(i.kind === 'group' && !(i.x >= box.x && i.y >= box.y && i.x + i.w <= box.x + box.w && i.y + i.h <= box.y + box.h))).map(i => i.id))
      setBox(null)
      if (tool === 'area') setTool('select')
    }
    if ((d.kind === 'move' && d.moved) || d.kind === 'resize') { hist.current.push(d.snap); dirty.current = true; clearTimeout(saveTimer.current); saveTimer.current = setTimeout(flush, 400) }
  }
  const onBoardDouble = e => {
    if (e.target !== e.currentTarget && !e.target.classList.contains('wb-world')) return
    addNote(toWorld(e.clientX, e.clientY))
  }

  // ---------- AI ----------

  const layOut = async () => {
    const text = compose.text.trim()
    if (!text || !board) return
    setCompose(c => ({ ...c, busy: true }))
    try {
      const placed = await wb.layout(board.id, text, compose.layout || undefined)
      const r = wrap.current.getBoundingClientRect()
      const empty = board.items.length === 0
      setView(fitView(placed.items, r.width, r.height))
      // Radiant's cursor places each piece; the camera already holds the whole plan
      const order = placed.items
      change(b => ({ ...b, name: empty || b.name === 'Untitled board' || b.name === 'My first board' ? placed.name : b.name, layout: empty ? placed.layout : b.layout, items: [...b.items, ...order.map(i => ({ ...i, appear: true }))], links: [...b.links, ...placed.links] }))
      order.forEach((it, k) => setTimeout(() => setCursor({ x: it.x + it.w - 10, y: it.y + 10 }), k * 110))
      setTimeout(() => { setCursor(null); setBoard(b => b && ({ ...b, items: b.items.map(i => i.appear ? { ...i, appear: undefined } : i) })) }, order.length * 110 + 600)
      setCompose({ text: '', layout: compose.layout, busy: false })
      loadList()
    } catch (e) { setCompose(c => ({ ...c, busy: false })); fail(e) }
  }

  const doGroup = async () => {
    setBusy('group')
    try { await flush(); take(await wb.group(board.id)); setTray(true) } catch (e) { fail(e) }
    setBusy('')
  }
  const doUnpack = async id => {
    setBusy('unpack')
    try { await flush(); take(await wb.unpack(board.id, id)); setTray(true) } catch (e) { fail(e) }
    setBusy('')
  }

  // Hand to Radiant / Run: a linked board asks first where the work should go.
  const handOrAsk = (notes, run = false) => {
    if (board.chatId) { setDialog({ kind: 'where', notes, run }); return }
    run ? startRun() : startHand(notes)
  }
  const startHand = async notes => { try { await flush(); setActivity(await wb.hand(board.id, notes.map(n => n.id))) } catch (e) { fail(e) } }
  const startRun = async () => { try { await flush(); setActivity(await wb.run(board.id)) } catch (e) { fail(e) } }
  const askInChat = async notes => {
    try {
      await flush()
      await wb.asked(board.id, notes.map(n => n.id))
      pull()
      onAskInChat?.(board.chatId, chatRequest(board, notes))
    } catch (e) { fail(e) }
  }
  const startAsk = async question => {
    try { await flush(); setActivity(await wb.ask(board.id, sel, question)) } catch (e) { fail(e) }
  }
  const stop = async () => { try { await wb.stop(board.id); pull() } catch (e) { fail(e) } }

  const accept = async p => {
    if (p.kind === 'result') {
      try { await flush(); hist.current.push(board); take(await wb.acceptResult(board.id, p.id)) } catch (e) { fail(e) }
      return
    }
    change(b => acceptProposal(b, p))
  }
  const skip = p => change(b => skipProposal(b, p))
  const pending = (board?.proposals || []).filter(p => p.state === 'pending')

  // ---------- export ----------

  const download = async format => {
    try {
      await flush()
      const r = await fetch(wb.exportUrl(board.id, format), { headers: authHeaders() })
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${board.name.replace(/[^\w .-]+/g, '').trim() || 'board'}.${format === 'csv' ? 'csv' : 'md'}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e) { fail(e) }
    setDialog(null)
  }
  const copyTable = async () => { try { await navigator.clipboard.writeText(asTable(board)) } catch (e) { fail(e) } setDialog(null) }

  // ---------- boards ----------

  const newBoardNamed = async () => { await flush(); const b = await wb.create('Untitled board'); await loadList(); open(b.id); setDialog(null) }
  const fromTasks = async () => { try { await flush(); const b = await wb.fromTasks(); await loadList(); open(b.id) } catch (e) { fail(e) } setDialog(null) }
  const removeBoard = async () => {
    if (!window.confirm(`Delete the board "${board.name}"? This cannot be undone.`)) return
    await wb.remove(board.id)
    const list = await wb.list()
    setBoards(list)
    if (list[0]) open(list[0].id)
    else { const b = await wb.create('Untitled board'); setBoards([b]); open(b.id) }
    setDialog(null)
  }
  const applyTasksRefresh = () => {
    const r = tasksRefresh
    if (!r) return
    change(b => {
      let items = [...b.items]
      const colOf = id => items.find(i => i.id === id)
      for (const m of r.moves) {
        const col = colOf(m.column)
        const inCol = items.filter(i => i.kind === 'note' && col && inside(i, col) && i.id !== m.noteId)
        const y = col ? Math.max(col.y + 64, ...inCol.map(i => i.y + i.h + 14)) : 0
        items = items.map(i => i.id === m.noteId && col ? { ...i, x: col.x + 20, y, taskState: m.state } : i)
      }
      for (const a of r.adds) {
        const col = colOf(a.column)
        if (!col) continue
        const inCol = items.filter(i => i.kind === 'note' && inside(i, col))
        items.push({ id: uid('n'), kind: 'note', x: col.x + 20, y: Math.max(col.y + 64, ...inCol.map(i => i.y + i.h + 14)), ...NOTE, text: a.text, color: 'blue', taskId: a.taskId, taskState: a.state, by: 'radiant' })
      }
      // grow columns to hold their notes
      items = items.map(g => {
        if (g.kind !== 'group') return g
        const bottom = Math.max(g.y + 120, ...items.filter(i => i.kind === 'note' && inside(i, g)).map(i => i.y + i.h + 20))
        return { ...g, h: Math.max(g.h, bottom - g.y) }
      })
      return { ...b, items }
    })
    setTasksRefresh(null)
  }

  // ---------- render ----------

  if (!board) return <div className='wb-page'><div className='wb-empty'>Loading the whiteboard…</div></div>

  const k = Math.min(1.8, Math.max(1, 0.62 / view.zoom)) // text grows as you zoom out, so a fitted board still reads
  const jobs = activity.jobs || {}
  const working = id => jobs[id]?.state === 'working'
  const resultFor = id => board.items.find(i => i.kind === 'result' && i.for === id)
  const actionNotes = board.items.filter(i => i.kind === 'note' && i.action)
  const doneGroups = new Set(board.items.filter(g => g.kind === 'group').filter(g => {
    const acts = actionNotes.filter(n => sectionOf(board, n)?.id === g.id)
    return acts.length && acts.every(n => resultFor(n.id))
  }).map(g => g.id))
  const selNotes = selected.filter(i => i.kind === 'note')
  const single = selected.length === 1 ? selected[0] : null
  const selBox = selected.length ? bounds(selected) : null
  const screen = p => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y })

  const linkPath = l => {
    const a = byId.get(l.from), b = byId.get(l.to)
    if (!a || !b) return null
    const ca = centre(a), cb = centre(b)
    if (l.kind === 'road') {
      const mx = (ca.x + cb.x) / 2
      return <path key={l.id} d={`M ${ca.x} ${ca.y} C ${mx} ${ca.y - 80}, ${mx} ${cb.y + 80}, ${cb.x} ${cb.y}`} className={'wb-road' + (doneGroups.has(a.id) || b.kind === 'result' ? ' is-gold' : '')} />
    }
    // stop the line at the target's edge so the arrowhead shows
    const dx = cb.x - ca.x, dy = cb.y - ca.y
    const t = Math.min(Math.abs((b.w / 2) / (dx || 1e-6)), Math.abs((b.h / 2) / (dy || 1e-6)), 1)
    const ex = cb.x - dx * t, ey = cb.y - dy * t
    return <line key={l.id} x1={ca.x} y1={ca.y} x2={ex} y2={ey} className={l.kind === 'result' ? 'wb-link is-result' : 'wb-link'} markerEnd={l.kind === 'arrow' ? 'url(#wb-arrow)' : undefined} />
  }

  const renderItem = it => {
    const isSel = sel.includes(it.id)
    const style = { left: it.x, top: it.y, width: it.w, height: it.h }
    const common = {
      key: it.id,
      style,
      onPointerDown: e => onItemDown(e, it),
      onDoubleClick: e => { e.stopPropagation(); if (it.kind !== 'sticker' && it.kind !== 'ink') setEditing(it.id) }
    }
    const cls = `wb-item wb-${it.kind}${isSel ? ' is-sel' : ''}${it.appear ? ' is-appearing' : ''}${arrowFrom === it.id ? ' is-arrow-from' : ''}`
    const resize = isSel && selected.length === 1 && it.kind !== 'ink' && <span className='wb-resize' onPointerDown={e => onResizeDown(e, it)} />
    if (it.kind === 'ink') return null
    if (it.kind === 'group') {
      return (
        <div {...common} className={cls + (it.color ? ` c-${it.color}` : '') + (activity.stop === it.id ? ' is-stop' : '')}>
          <div className='wb-group-head'>
            {it.sticker && <span className='wb-sticker-sm'>{STICKERS[it.sticker]}</span>}
            {editing === it.id
              ? <input autoFocus className='wb-group-title-in' defaultValue={it.title} onPointerDown={e => e.stopPropagation()} onBlur={e => { setItem(it.id, { title: e.target.value.trim() || 'Untitled section' }); setEditing(null) }} onKeyDown={e => e.key === 'Enter' && e.target.blur()} />
              : <span className='wb-group-title' style={{ fontSize: 15 * Math.min(k, 1.5) }}>{it.title || 'Untitled section'}</span>}
            {it.label && <span className='wb-group-label'>{it.label}</span>}
          </div>
          {resize}
        </div>
      )
    }
    if (it.kind === 'sticker') return <div {...common} className={cls}><span style={{ fontSize: Math.min(it.w, it.h) * 0.8 }}>{STICKERS[it.sticker]}</span>{resize}</div>
    if (it.kind === 'text') {
      return (
        <div {...common} className={cls}>
          {editing === it.id
            ? <textarea autoFocus className='wb-edit' style={{ fontSize: it.size }} defaultValue={it.text} onPointerDown={e => e.stopPropagation()} onBlur={e => { const v = e.target.value; v.trim() ? setItem(it.id, { text: v }) : change(b => removeItems(b, [it.id])); setEditing(null) }} />
            : <div className='wb-text-body' style={{ fontSize: it.size * Math.min(k, 1.6) }}>{it.text || <i>Text</i>}</div>}
          {resize}
        </div>
      )
    }
    if (it.kind === 'result') {
      return (
        <div {...common} className={cls}>
          <div className='wb-result-head'>
            <span className='wb-result-stamp'>{it.stamp || (it.by === 'chat' ? 'From chat' : 'Radiant')}</span>
            <strong style={{ fontSize: 13 * Math.min(k, 1.8) }}>{it.title}</strong>
          </div>
          <div className='wb-result-body' style={{ fontSize: 12.5 * Math.min(k, 1.5) }} onWheel={e => { if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation() }}>
            <Markdown text={it.text} />
            {it.sources?.length > 0 && <div className='wb-sources'>{it.sources.map(s => <a key={s} href={s} target='_blank' rel='noreferrer'>{s.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)}</a>)}</div>}
            {it.acted?.length > 0 && <div className='wb-acted'>Tried and refused (needs your approval): {it.acted.join(', ')}</div>}
            {it.model && <div className='wb-model'>Done with {it.model}</div>}
          </div>
          {resize}
        </div>
      )
    }
    // note
    return (
      <div {...common} className={`${cls} c-${it.color}${working(it.id) ? ' is-working' : ''}${it.action ? ' is-action' : ''}`}>
        {editing === it.id
          ? <textarea autoFocus className='wb-edit' defaultValue={it.text} placeholder='Type a note…' onPointerDown={e => e.stopPropagation()}
              onBlur={e => { const v = e.target.value; if (!v.trim() && !it.text) change(b => removeItems(b, [it.id]), false); else setItem(it.id, { text: v }); setEditing(null) }}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.blur() }} />
          : <div className='wb-note-text' style={{ fontSize: 14 * k }}>{it.text || <i>Empty note</i>}</div>}
        <div className='wb-note-foot'>
          {it.action && <span className='wb-chip is-action' title='Action item: an agent can do this'>Action</span>}
          {it.owner && <span className='wb-chip'>{it.owner}</span>}
          {it.due && <span className='wb-chip'>Due {it.due}</span>}
          {it.mark && <span className={`wb-chip is-mark is-${it.mark.state}`} title={it.mark.detail || ''}>{MARK_WORDS[it.mark.state] || it.mark.state}<button className='wb-chip-x' title='Clear' onPointerDown={e => e.stopPropagation()} onClick={() => wb.clearMark(board.id, it.id).then(pull)}>×</button></span>}
          {it.taskState && <span className={`wb-chip is-task is-${it.taskState}`} title='Its task on the Tasks board'>Task: {TASK_WORDS[it.taskState] || it.taskState}</span>}
          {it.chatAsk && <span className='wb-chip is-waiting'>Waiting on chat</span>}
          {jobs[it.id]?.state === 'failed' && <span className='wb-chip is-failed' title={jobs[it.id].error}>Failed</span>}
        </div>
        {working(it.id) && <span className='wb-agent-cursor'>Radiant</span>}
        {resize}
      </div>
    )
  }

  const chatName = board.chatId ? (sessions.find(s => s.id === board.chatId)?.title || chat?.title || 'a chat') : null

  return (
    <div className='wb-page'>
      <div className='wb-head'>
        <button className='wb-board-btn' onClick={() => setDialog(d => d?.kind === 'boards' ? null : { kind: 'boards' })}>
          <span className='wb-board-name'>{board.name}</span><span className='model-caret'>▾</span>
        </button>
        <form className='wb-compose' onSubmit={e => { e.preventDefault(); layOut() }}>
          <input value={compose.text} disabled={compose.busy} placeholder='What are you planning? Radiant lays it out…' onChange={e => setCompose(c => ({ ...c, text: e.target.value }))} />
          <select value={compose.layout} onChange={e => setCompose(c => ({ ...c, layout: e.target.value }))} title='Layout'>
            <option value=''>Any layout</option><option value='route'>Route</option><option value='columns'>Columns</option><option value='map'>Map</option>
          </select>
          <button className='rx-btn rx-btn-sm' disabled={!compose.text.trim() || compose.busy}>{compose.busy ? 'Laying out…' : 'Lay it out'}</button>
        </form>
        <div className='wb-actions'>
          <button className='rx-btn rx-btn-sm' disabled={busy === 'group'} onClick={doGroup}>{busy === 'group' ? 'Grouping…' : 'Group my notes'}</button>
          {activity.running
            ? <button className='rx-btn rx-btn-sm is-stop' onClick={stop}>Stop</button>
            : <button className='rx-btn rx-btn-sm' disabled={!actionNotes.length} title={actionNotes.length ? 'Agents work every action item, stop by stop' : 'Mark a note as an action item first'} onClick={() => handOrAsk([], true)}>▶ Run</button>}
          <button className={'rx-btn rx-btn-sm' + (pending.length ? ' has-badge' : '')} onClick={() => setTray(t => !t)}>Suggestions{pending.length ? ` (${pending.length})` : ''}</button>
          <button className='rx-btn rx-btn-sm' onClick={() => setDialog(d => d?.kind === 'link' ? null : { kind: 'link' })} title={board.chatId ? `Linked to ${chatName}` : 'Link this board to a chat'}>
            <span className={'wb-chat-dot' + (chat?.working ? ' is-working' : chat?.ended === 'failed' ? ' is-failed' : board.chatId ? ' is-linked' : '')} />
            {board.chatId ? (chat?.working ? 'Chat working' : 'Chat') : 'Link chat'}
          </button>
          <button className='rx-btn rx-btn-sm' onClick={() => setDialog(d => d?.kind === 'export' ? null : { kind: 'export' })}>Export</button>
        </div>
      </div>

      <div className='wb-main'>
        <div ref={wrap} className={`wb-canvas tool-${tool}`} onPointerDown={onBoardDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onBoardDouble}>
          <div className='wb-world' style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            {board.items.filter(i => i.kind === 'group').map(renderItem)}
            <svg className='wb-svg' width='1' height='1'>
              <defs><marker id='wb-arrow' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M 0 0 L 10 5 L 0 10 z' /></marker></defs>
              {board.links.map(linkPath)}
              {board.items.filter(i => i.kind === 'ink').map(i => (
                <polyline key={i.id} points={i.points.map(p => p.join(',')).join(' ')} className={'wb-ink' + (sel.includes(i.id) ? ' is-sel' : '')} stroke={i.color}
                  onPointerDown={e => onItemDown(e, i)} />
              ))}
              {ink && <polyline points={ink.map(p => p.join(',')).join(' ')} className='wb-ink' stroke='#2b2b2b' />}
              {box && <rect x={box.x} y={box.y} width={box.w} height={box.h} className='wb-box' />}
            </svg>
            {board.items.filter(i => i.kind !== 'group').map(renderItem)}
            {cursor && <span className='wb-place-cursor' style={{ left: cursor.x, top: cursor.y }}>Radiant</span>}
          </div>

          {selBox && !editing && tool === 'select' && (
            <div className='wb-selbar' style={{ left: Math.max(8, Math.min(screen({ x: selBox.x, y: selBox.y }).x, (wrap.current?.clientWidth || 800) - 660)), top: Math.max(8, screen({ x: selBox.x, y: selBox.y }).y - 46) }} onPointerDown={e => e.stopPropagation()}>
              {selNotes.length > 0 && COLORS.map(c => <button key={c} className={`wb-swatch c-${c}`} title={c} onClick={() => change(b => ({ ...b, items: b.items.map(i => sel.includes(i.id) && i.kind === 'note' ? { ...i, color: c } : i) }))} />)}
              {single?.kind === 'note' && <>
                <button className={'wb-sb' + (single.action ? ' is-on' : '')} onClick={() => setItem(single.id, { action: !single.action })}>Action</button>
                <button className='wb-sb' onClick={() => { const v = window.prompt('Owner', single.owner || ''); if (v !== null) setItem(single.id, { owner: v.trim() || undefined }) }}>Owner</button>
                <button className='wb-sb' onClick={() => { const v = window.prompt('Due', single.due || ''); if (v !== null) setItem(single.id, { due: v.trim() || undefined }) }}>Due</button>
              </>}
              {selNotes.length > 0 && <button className='wb-sb is-go' disabled={activity.running} onClick={() => handOrAsk(selNotes)}>Hand to Radiant</button>}
              <button className='wb-sb' disabled={activity.running} onClick={() => setDialog({ kind: 'ask' })}>Ask</button>
              {selNotes.length > 0 && <button className='wb-sb' onClick={() => setDialog({ kind: 'tasks', notes: selNotes, start: false })}>Send to Tasks</button>}
              {single?.kind === 'result' && <button className='wb-sb' disabled={busy === 'unpack'} onClick={() => doUnpack(single.id)}>{busy === 'unpack' ? 'Unpacking…' : 'Unpack'}</button>}
              {selected.some(i => i.kind !== 'group') && selected.length > 1 && <button className='wb-sb' onClick={addGroupAround}>Group</button>}
              {single?.kind === 'group' && <button className='wb-sb' onClick={() => setDialog({ kind: 'stickers', forGroup: single.id })}>Sticker</button>}
              {single?.kind === 'group' && <button className='wb-sb' onClick={() => { const v = window.prompt('Label (e.g. Week 1)', single.label || ''); if (v !== null) setItem(single.id, { label: v.trim() || undefined }) }}>Label</button>}
              <button className='wb-sb is-danger' onClick={del} title='Delete (Backspace)'>Delete</button>
            </div>
          )}

          {board.items.length === 0 && !compose.busy && (
            <div className='wb-hint'>
              <p><strong>Say what you are planning</strong> in the box above and Radiant lays it out — a route, columns or a map.</p>
              <p>Or double-click anywhere for a note. <kbd>N</kbd> note · <kbd>T</kbd> text · <kbd>P</kbd> pen · <kbd>L</kbd> select an area · <kbd>A</kbd> arrow · scroll to pan, <kbd>⌘</kbd>-scroll or pinch to zoom.</p>
            </div>
          )}

          <div className='wb-toolbar' onPointerDown={e => e.stopPropagation()}>
            {[['select', 'Select (V)', '↖'], ['area', 'Select an area (L)', '⬚'], ['pen', 'Pen (P)', '✎'], ['arrow', 'Arrow (A)', '→']].map(([t, tip, glyph]) => (
              <button key={t} className={'wb-tool' + (tool === t ? ' is-on' : '')} title={tip} onClick={() => { setTool(t); setArrowFrom(null) }}>{glyph}</button>
            ))}
            <span className='wb-tool-sep' />
            <button className='wb-tool' title='Note (N)' onClick={() => addNote(centreOfView())}>▢</button>
            <button className='wb-tool' title='Text (T)' onClick={() => addText(centreOfView())}>T</button>
            <button className='wb-tool' title='Sticker' onClick={() => setDialog(d => d?.kind === 'stickers' ? null : { kind: 'stickers' })}>☺</button>
            <span className='wb-tool-sep' />
            <button className='wb-tool' title='Undo (⌘Z)' disabled={!hist.current.canUndo} onClick={undo}>↶</button>
            <button className='wb-tool' title='Redo (⇧⌘Z)' disabled={!hist.current.canRedo} onClick={redo}>↷</button>
            <span className='wb-tool-sep' />
            <button className='wb-tool' title='Zoom out' onClick={() => zoomBy(1 / 1.2)}>−</button>
            <button className='wb-tool wb-zoom' title='Fit the board (F)' onClick={fit}>{Math.round(view.zoom * 100)}%</button>
            <button className='wb-tool' title='Zoom in' onClick={() => zoomBy(1.2)}>+</button>
          </div>

          {compose.busy && <div className='wb-banner is-run'>Radiant is laying out your board…</div>}
          {tool === 'arrow' && <div className='wb-banner'>{arrowFrom ? 'Now click the item the arrow points to.' : 'Click the item the arrow starts from.'}</div>}
          {activity.running && (
            <div className='wb-banner is-run'>
              {activity.kind === 'route' ? 'Running the route' : activity.kind === 'ask' ? 'Answering' : 'Working'} · {Object.values(jobs).filter(j => j.state === 'working').length} agent(s) at work · {Object.values(jobs).filter(j => j.state === 'done').length} done
              <button className='wb-sb' onClick={stop}>Stop</button>
            </div>
          )}
          {!activity.running && activity.error && <div className='wb-banner is-failed'>{activity.error}</div>}
          {tasksRefresh && (
            <div className='wb-banner'>Tasks changed: {tasksRefresh.moves.length} moved, {tasksRefresh.adds.length} new. <button className='wb-sb' onClick={applyTasksRefresh}>Refresh</button></div>
          )}
          {board.chatId && pendingChanges.length > 0 && (
            <div className='wb-banner is-low'>{pendingChanges.length} change{pendingChanges.length === 1 ? '' : 's'} the linked chat has not heard about — it hears with your next message there.
              <button className='wb-sb' onClick={async () => { await flush(); onAskInChat?.(board.chatId, `I changed the whiteboard "${board.name}":\n${pendingChanges.map(l => `- ${l}`).join('\n')}`); wb.told(board.id) }}>Tell the chat now</button>
            </div>
          )}
        </div>

        {tray && (
          <aside className='wb-tray'>
            <div className='wb-tray-head'><strong>Suggestions</strong><button className='wb-chip-x' onClick={() => setTray(false)}>×</button></div>
            {!pending.length && <p className='wb-tray-empty'>Nothing waiting. <em>Group my notes</em>, <em>Unpack</em> and linked chats send suggestions here for you to accept or skip.</p>}
            {pending.length > 1 && <button className='wb-sb' onClick={() => { for (const p of pending.filter(x => x.kind !== 'result')) change(b => acceptProposal(b, p)); for (const p of pending.filter(x => x.kind === 'result')) accept(p) }}>Accept all</button>}
            {pending.map(p => (
              <div key={p.id} className='wb-prop'>
                <div className='wb-prop-line'>{proposalLine(p, board)}</div>
                {p.reason && <div className='wb-prop-why'>{p.by === 'chat' ? 'From the chat: ' : ''}{p.reason}</div>}
                {p.kind === 'result' && <div className='wb-prop-text'><Markdown text={p.text.slice(0, 600)} /></div>}
                <div className='wb-prop-btns'><button className='wb-sb is-go' onClick={() => accept(p)}>Accept</button><button className='wb-sb' onClick={() => skip(p)}>Skip</button></div>
              </div>
            ))}
            <p className='wb-tray-foot'>Every accepted change can be taken back with ⌘Z.</p>
          </aside>
        )}
      </div>

      {dialog?.kind === 'boards' && (
        <div className='wb-pop wb-pop-boards' onPointerDown={e => e.stopPropagation()}>
          <input className='wb-rename' defaultValue={board.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== board.name) { change(b => ({ ...b, name: v }), false); setTimeout(loadList, 800) } }} onKeyDown={e => e.key === 'Enter' && e.target.blur()} title='Rename this board' />
          <div className='wb-pop-list'>
            {boards.map(b => <button key={b.id} className={'wb-pop-item' + (b.id === board.id ? ' is-on' : '')} onClick={async () => { await flush(); open(b.id); setDialog(null) }}>{b.name}<span>{b.notes} notes{b.running ? ' · working' : ''}{b.chatId ? ' · linked' : ''}</span></button>)}
          </div>
          <button className='wb-pop-item' onClick={newBoardNamed}>+ New board</button>
          <button className='wb-pop-item' onClick={fromTasks}>+ New board from Tasks</button>
          <button className='wb-pop-item is-danger' onClick={removeBoard}>Delete this board</button>
        </div>
      )}
      {dialog?.kind === 'export' && (
        <div className='wb-pop wb-pop-right' onPointerDown={e => e.stopPropagation()}>
          <button className='wb-pop-item' onClick={() => download('md')}>Markdown file</button>
          <button className='wb-pop-item' onClick={() => download('csv')}>CSV file</button>
          <button className='wb-pop-item' onClick={copyTable}>Copy as a table<span>paste into any spreadsheet</span></button>
        </div>
      )}
      {dialog?.kind === 'link' && (
        <LinkChat board={board} sessions={sessions} chat={chat}
          onLink={id => { change(b => ({ ...b, chatId: id }), false); setDialog(null) }}
          onOpen={() => { setDialog(null); onOpenChat?.(board.chatId) }}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'stickers' && (
        <div className='wb-pop wb-pop-stickers' onPointerDown={e => e.stopPropagation()}>
          {Object.entries(STICKERS).map(([name, glyph]) => (
            <button key={name} title={name} onClick={() => { dialog.forGroup ? setItem(dialog.forGroup, { sticker: name }) : addSticker(name, centreOfView()); setDialog(null) }}>{glyph}</button>
          ))}
        </div>
      )}
      {dialog?.kind === 'ask' && (
        <Modal title={selected.length ? `Ask about ${selected.length} selected item${selected.length === 1 ? '' : 's'}` : 'Ask about the board'} onClose={() => setDialog(null)}>
          <form onSubmit={e => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) { startAsk(q); setDialog(null) } }}>
            <input name='q' autoFocus className='wb-modal-in' placeholder='What do you want to know?' />
            <p className='wb-modal-note'>An agent answers, using web search if it needs to. The answer lands as a card beside what you asked about.</p>
            <div className='wb-modal-btns'><button type='button' className='rx-btn rx-btn-sm' onClick={() => setDialog(null)}>Cancel</button><button className='rx-btn rx-btn-sm rx-btn-go'>Ask</button></div>
          </form>
        </Modal>
      )}
      {dialog?.kind === 'tasks' && (
        <Modal title={`Send ${dialog.notes.length} note${dialog.notes.length === 1 ? '' : 's'} to Tasks`} onClose={() => setDialog(null)}>
          <p className='wb-modal-note'>One task per note, on Radiant's Tasks board. They wait in Queued with nobody on them, so nothing runs until you start them. Sending the same note again gives the same task, not a copy.</p>
          <label className='check-row'><input type='checkbox' checked={dialog.start} onChange={e => setDialog(d => ({ ...d, start: e.target.checked }))} /><span>Let Radiant start on them <span className='desc'>— each task's agent begins right away, on your default model (up to three at once)</span></span></label>
          <div className='wb-modal-btns'><button className='rx-btn rx-btn-sm' onClick={() => setDialog(null)}>Cancel</button>
            <button className='rx-btn rx-btn-sm rx-btn-go' onClick={async () => { try { await flush(); take(await wb.sendTasks(board.id, dialog.notes.map(n => n.id), dialog.start)) } catch (e) { fail(e) } setDialog(null) }}>Send</button></div>
        </Modal>
      )}
      {dialog?.kind === 'where' && (
        <Modal title='Where should this work go?' onClose={() => setDialog(null)}>
          <p className='wb-modal-note'>This board is linked to <strong>{chatName}</strong>.</p>
          <button className='wb-choice' onClick={() => { const notes = dialog.run ? actionNotes : dialog.notes; setDialog(null); askInChat(notes) }}>
            <strong>Ask in the linked chat</strong><span>Opens the chat with the request written in its message box. You send it, so the chat that owns the work does it, with its own approvals. Its answer comes back here as a suggestion.</span>
          </button>
          <button className='wb-choice' onClick={() => { const d = dialog; setDialog(null); d.run ? startRun() : startHand(d.notes) }}>
            <strong>Start separate work here</strong><span>Agents run from the board in the background and put their results beside each note.</span>
          </button>
        </Modal>
      )}
    </div>
  )
}

function Modal ({ title, children, onClose }) {
  return (
    <div className='wb-modal-back' onPointerDown={onClose}>
      <div className='wb-modal' onPointerDown={e => e.stopPropagation()} role='dialog' aria-label={title}>
        <div className='wb-modal-title'>{title}</div>
        {children}
      </div>
    </div>
  )
}

function LinkChat ({ board, sessions, chat, onLink, onOpen, onClose }) {
  const [q, setQ] = useState('')
  const list = sessions.filter(s => !s.hidden && (s.title || '').toLowerCase().includes(q.toLowerCase())).slice(0, 40)
  return (
    <Modal title={board.chatId ? 'Linked chat' : 'Link this board to a chat'} onClose={onClose}>
      {board.chatId && (
        <div className='wb-linked'>
          <div><strong>{chat?.title || 'Linked chat'}</strong> — {chat?.missing ? 'that chat no longer exists' : chat?.working ? 'working now' : chat?.ended ? `last turn ${chat.ended}` : 'no turns yet'}</div>
          {chat?.firstLine && <div className='wb-modal-note'>“{chat.firstLine}”</div>}
          <div className='wb-modal-btns'><button className='rx-btn rx-btn-sm' onClick={onOpen}>Open the chat</button><button className='rx-btn rx-btn-sm' onClick={() => onLink(null)}>Unlink</button></div>
        </div>
      )}
      <p className='wb-modal-note'>On a linked board, Hand to Radiant and Run ask whether the chat should do the work. With “Chats can read my boards” on (Settings → Automation → Whiteboard), the chat marks notes as it works and hears what you change here.</p>
      <input className='wb-modal-in' autoFocus placeholder='Find a chat…' value={q} onChange={e => setQ(e.target.value)} />
      <div className='wb-pop-list'>
        {list.map(s => <button key={s.id} className={'wb-pop-item' + (s.id === board.chatId ? ' is-on' : '')} onClick={() => onLink(s.id)}>{s.title || 'Untitled chat'}</button>)}
      </div>
    </Modal>
  )
}
