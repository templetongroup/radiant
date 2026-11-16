/**
 * HTTP side of the whiteboard (logic in whiteboard.js, agents in
 * whiteboard-run.js, chat side in whiteboard-tool.js). Every /api route
 * already sits behind the access-token gate in index.js.
 *
 * ⚠️ THE TASKS BRIDGE CREATES, THEN ONLY READS. "Send to Tasks" makes one task
 * per note, parked in Queued where nothing runs until you start it — unless you
 * tick "Let Radiant start on them". After that the board reads each task's
 * state to show it on the note, and never changes a task again.
 */
import path from 'path'
import {
  setWhiteboardDir, listBoards, loadBoard, saveBoard, deleteBoard, newBoard, mergeSave, updateBoard,
  placePlan, toCsv, toMarkdown, notesOf, groupsOf, clean, uid, TASK_WORDS, NOTE, normalizeItem
} from './whiteboard.js'
import { layoutFromSentence, groupNotes, unpackResult, handNotes, runRoute, askBoard, boardActivity, stopBoard } from './whiteboard-run.js'
import { chatState, markAsked, pendingChanges, acceptResultProposal } from './whiteboard-tool.js'

export function registerWhiteboardRoutes (app, deps) {
  const { dataDir, loadSession, activeTurns, listTasks, loadTask, saveTask, newTaskId, taskActivity, port } = deps
  setWhiteboardDir(path.join(dataDir, 'whiteboards'))

  const board = (req, res) => {
    const b = loadBoard(req.params.id)
    if (!b) { res.status(404).json({ error: 'No such board.' }); return null }
    return b
  }
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })

  app.get('/api/whiteboards', (req, res) => res.json(listBoards().map(b => ({
    id: b.id, name: b.name, layout: b.layout, notes: notesOf(b).length, sections: groupsOf(b).length, chatId: b.chatId, updatedAt: b.updatedAt, running: boardActivity(b.id).running
  }))))

  app.post('/api/whiteboards', (req, res) => {
    const b = newBoard(clean(req.body?.name, 120) || 'Untitled board')
    res.json(saveBoard(b))
  })

  app.get('/api/whiteboards/:id', (req, res) => {
    const b = board(req, res)
    if (b) res.json({ ...b, activity: boardActivity(b.id) })
  })

  // The page saves the whole board with the revision it started from.
  app.put('/api/whiteboards/:id', (req, res) => {
    const b = board(req, res)
    if (!b) return
    try { res.json(saveBoard(mergeSave(b, req.body?.board || {}, req.body?.baseRev))) } catch (e) { fail(res, e) }
  })

  app.delete('/api/whiteboards/:id', (req, res) => { deleteBoard(req.params.id); res.json({ ok: true }) })

  // ---------- AI, only when asked ----------

  // One sentence → a board. Returns the laid-out pieces; the page places them (undoably).
  app.post('/api/whiteboards/:id/layout', async (req, res) => {
    const b = board(req, res)
    if (!b) return
    const request = clean(req.body?.request, 600)
    if (!request) return res.status(400).json({ error: 'Say what you are planning first.' })
    try {
      const plan = await layoutFromSentence(deps, request, ['route', 'columns', 'map'].includes(req.body?.layout) ? req.body.layout : null)
      const right = b.items.length ? Math.max(...b.items.map(i => i.x + i.w)) + 200 : 0
      res.json(placePlan(plan, { origin: { x: right, y: 0 } }))
    } catch (e) { fail(res, e) }
  })

  app.post('/api/whiteboards/:id/group', async (req, res) => {
    try { res.json(await groupNotes(deps, req.params.id)) } catch (e) { fail(res, e) }
  })
  app.post('/api/whiteboards/:id/unpack', async (req, res) => {
    try { res.json(await unpackResult(deps, req.params.id, req.body?.resultId)) } catch (e) { fail(res, e) }
  })
  app.post('/api/whiteboards/:id/hand', (req, res) => {
    const ids = (Array.isArray(req.body?.noteIds) ? req.body.noteIds : []).map(String)
    if (!ids.length) return res.status(400).json({ error: 'Pick a note to hand over.' })
    try { res.json(handNotes(deps, req.params.id, ids)) } catch (e) { fail(res, e) }
  })
  app.post('/api/whiteboards/:id/run', (req, res) => {
    try { res.json(runRoute(deps, req.params.id)) } catch (e) { fail(res, e) }
  })
  app.post('/api/whiteboards/:id/ask', (req, res) => {
    const q = clean(req.body?.question, 600)
    if (!q) return res.status(400).json({ error: 'Type a question first.' })
    try { res.json(askBoard(deps, req.params.id, (req.body?.itemIds || []).map(String), q)) } catch (e) { fail(res, e) }
  })
  app.get('/api/whiteboards/:id/activity', (req, res) => res.json(boardActivity(req.params.id)))
  app.post('/api/whiteboards/:id/stop', (req, res) => res.json({ stopped: stopBoard(req.params.id) }))

  app.post('/api/whiteboards/:id/proposals/:pid/accept-result', (req, res) => {
    const b = acceptResultProposal(req.params.id, req.params.pid)
    b ? res.json(b) : res.status(404).json({ error: 'No such board.' })
  })

  // ---------- export ----------

  app.get('/api/whiteboards/:id/export', (req, res) => {
    const b = board(req, res)
    if (!b) return
    const csv = req.query.format === 'csv'
    const name = (b.name.replace(/[^\w .-]+/g, '').trim() || 'board') + (csv ? '.csv' : '.md')
    res.setHeader('content-type', csv ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${name}"`)
    res.send(csv ? toCsv(b) : toMarkdown(b))
  })

  // ---------- the linked chat ----------

  app.get('/api/whiteboards/:id/chat', (req, res) => res.json(chatState(req.params.id, { loadSession, activeTurns })))
  app.post('/api/whiteboards/:id/chat/asked', (req, res) => {
    const b = markAsked(req.params.id, (req.body?.noteIds || []).map(String), { loadSession })
    b ? res.json(b) : res.status(400).json({ error: 'This board is not linked to a chat.' })
  })
  app.get('/api/whiteboards/:id/chat/changes', (req, res) => res.json({ lines: pendingChanges(req.params.id) }))
  app.post('/api/whiteboards/:id/chat/told', (req, res) => {
    const b = updateBoard(req.params.id, bd => { bd.told = Object.fromEntries(notesOf(bd).map(n => [n.id, clean(n.text, 200)])); return bd })
    b ? res.json({ ok: true }) : res.status(404).json({ error: 'No such board.' })
  })
  app.post('/api/whiteboards/:id/clear-mark', (req, res) => {
    const b = updateBoard(req.params.id, bd => { const n = bd.items.find(i => i.id === req.body?.noteId); if (n) n.mark = undefined; return bd })
    b ? res.json(b) : res.status(404).json({ error: 'No such board.' })
  })

  // ---------- Tasks ----------

  const startTask = async (id) => {
    // The same two steps the Tasks board takes, over loopback: claim the task,
    // then send its opening message — here, with the server holding the stream.
    const base = `http://127.0.0.1:${port()}`
    const started = await fetch(`${base}/api/tasks/${id}/start`, { method: 'POST' }).then(r => r.json())
    if (!started.sessionId || !started.prompt) return
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: started.sessionId, content: started.prompt }) })
    const reader = r.body?.getReader()
    if (reader) while (!(await reader.read()).done) { /* drain until the turn ends */ }
  }

  app.post('/api/whiteboards/:id/send-tasks', (req, res) => {
    const b = board(req, res)
    if (!b) return
    const ids = (req.body?.noteIds || []).map(String).slice(0, 24)
    const notes = notesOf(b).filter(n => ids.includes(n.id) && clean(n.text))
    if (!notes.length) return res.status(400).json({ error: 'Select notes with text first.' })
    const made = []
    for (const n of notes) {
      // a second click gives the same task, not a copy
      const existing = n.taskId && loadTask(n.taskId)
      if (existing) { made.push({ noteId: n.id, task: existing }); continue }
      const result = b.items.find(i => i.kind === 'result' && i.for === n.id)
      const detail = [`From the whiteboard "${b.name}".`, n.owner ? `Owner: ${n.owner}` : '', n.due ? `Due: ${n.due}` : '', result ? `Result so far: ${clean(result.text, 400)}` : ''].filter(Boolean).join('\n')
      const task = {
        id: newTaskId(), title: clean(n.text, 120), detail,
        agentId: null, model: null, provider: null, cwd: null, projectId: null,
        state: 'queued', sessionId: null, order: Date.now() + made.length, createdAt: new Date().toISOString(),
        startedAt: null, finishedAt: null, lastError: null,
        priority: 'none', labels: ['whiteboard'], due: null, blockedBy: [], comments: [], activity: [], runs: []
      }
      taskActivity(task, `Sent from the whiteboard "${b.name}"`, 'you')
      saveTask(task)
      made.push({ noteId: n.id, task })
    }
    const out = updateBoard(b.id, bd => {
      for (const m of made) { const n = bd.items.find(i => i.id === m.noteId); if (n) { n.taskId = m.task.id; n.taskState = m.task.state } }
      return bd
    })
    if (req.body?.start) {
      // up to three opening turns at once, in the background
      const queue = made.filter(m => m.task.state === 'queued').map(m => m.task.id)
      const worker = async () => { while (queue.length) { try { await startTask(queue.shift()) } catch {} } }
      Promise.all([worker(), worker(), worker()]).catch(() => {})
    }
    res.json(out)
  })

  // Each note's task as it is now. Read only.
  app.get('/api/whiteboards/:id/task-states', (req, res) => {
    const b = board(req, res)
    if (!b) return
    const states = {}
    let changed = false
    for (const n of notesOf(b)) {
      if (!n.taskId) continue
      const t = loadTask(n.taskId)
      states[n.id] = t ? t.state : 'gone'
      if (t && t.state !== n.taskState) changed = true
    }
    if (changed) updateBoard(b.id, bd => { for (const n of notesOf(bd)) if (states[n.id] && states[n.id] !== 'gone') n.taskState = states[n.id]; return bd })
    res.json({ states, words: TASK_WORDS })
  })

  // A board laid out from Tasks: one column per state.
  const columnsFromTasks = () => {
    const tasks = listTasks()
    const order = ['queued', 'working', 'blocked', 'review', 'done']
    return placePlan({
      title: 'Tasks',
      layout: 'columns',
      sections: order.map(st => ({ title: TASK_WORDS[st], notes: tasks.filter(t => t.state === st).slice(0, 6).map(t => ({ text: t.title })) }))
    }, { by: 'radiant' })
  }
  app.post('/api/whiteboards/from-tasks', (req, res) => {
    const tasks = listTasks()
    const placed = columnsFromTasks()
    // tie each note back to its task, in the same order placePlan laid them out
    const order = ['queued', 'working', 'blocked', 'review', 'done']
    const queue = order.flatMap(st => tasks.filter(t => t.state === st).slice(0, 6))
    let k = 0
    for (const it of placed.items) if (it.kind === 'note') { const t = queue[k++]; if (t) { it.taskId = t.id; it.taskState = t.state } }
    for (const it of placed.items) if (it.kind === 'group') it.taskState = order.find(st => TASK_WORDS[st] === it.title)
    res.json(saveBoard(newBoard('Tasks', { layout: 'columns', items: placed.items, links: [], taskBoard: true })))
  })

  // Where Tasks says each note should be now; the page moves them in one undoable step.
  app.get('/api/whiteboards/:id/tasks-refresh', (req, res) => {
    const b = board(req, res)
    if (!b) return
    const columns = Object.fromEntries(groupsOf(b).filter(g => g.taskState).map(g => [g.taskState, g]))
    const known = new Set(notesOf(b).map(n => n.taskId).filter(Boolean))
    const moves = []
    const adds = []
    for (const t of listTasks()) {
      const col = columns[t.state]
      if (!col) continue
      const note = notesOf(b).find(n => n.taskId === t.id)
      if (note && note.taskState !== t.state) moves.push({ noteId: note.id, state: t.state, column: col.id })
      if (!known.has(t.id)) adds.push({ taskId: t.id, state: t.state, column: col.id, text: clean(t.title, 120) })
    }
    res.json({ moves, adds, size: NOTE })
  })

  return { normalizeItem, uid }
}
