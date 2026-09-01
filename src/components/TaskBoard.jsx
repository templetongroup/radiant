import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { ModelPicker } from './Chat.jsx'

/**
 * The board.
 *
 * ⚠️ IT SHOWS WORK, IT DOES NOT INVENT IT. Every column but Queued and Done is
 * set by the run itself, from the events the server already emits — a card
 * reaches Working because a turn started, Needs you because the agent asked for
 * approval, Review because the turn finished. Dragging into those columns is
 * refused by the server (409), because a board you can drag to "done" while the
 * agent is still going is a drawing of progress rather than a view of it.
 *
 * A task is an ordinary session with a goal attached, so the agent's own
 * checklist, its approvals, its model and its transcript are the same objects
 * the rest of Radiant uses. There is no second source of truth to drift.
 */

// Ordered left to right the way work actually moves. "Needs you" sits in the
// middle because it is the column that should catch your eye: it is the only
// one where nothing happens until you act.
//
// ⚠️ EACH COLUMN CARRIES ITS OWN ID AS A CLASS, and `has-work` only when it
// holds something. Styling used to reach the accented column by :nth-child(3),
// which lit it up whether or not anything was in it — an empty column claiming
// your attention — and would have lit the WRONG column the moment this list was
// reordered. Never style a column by position.
const COLUMNS = [
  { id: 'queued', label: 'Queued', hint: 'Not started' },
  { id: 'working', label: 'Working', hint: 'The agent is going' },
  { id: 'blocked', label: 'Needs you', hint: 'Waiting on your answer' },
  { id: 'review', label: 'Review', hint: 'Finished — unread' },
  { id: 'done', label: 'Done', hint: 'You accepted it' }
]
// Only these two are a person's to set; the rest belong to the run.
const HUMAN_COLUMNS = new Set(['queued', 'done'])

function timeAgo (iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Who is doing it — an agent if one was picked, otherwise the bare model. */
function assigneeOf (task, agents) {
  if (task.agentId) {
    const a = agents.find(x => x.id === task.agentId)
    return { name: a ? a.name : 'Missing agent', missing: !a }
  }
  return { name: task.model || 'Default model', missing: false }
}

function Card ({ task, agents, live, onOpen, onStart, onSteer, onDelete, onDragStart }) {
  // Steering only means something once something is running. A queued card has
  // nothing to redirect; a finished one has nothing left to say.
  const canSteer = task.state === 'working' || task.state === 'blocked'
  const [steering, setSteering] = useState(false)
  const [steerText, setSteerText] = useState('')
  const steerRef = useRef(null)
  useEffect(() => { if (steering) steerRef.current?.focus() }, [steering])
  const sendSteer = e => {
    e?.preventDefault?.(); e?.stopPropagation?.()
    const t = steerText.trim()
    if (!t) return
    onSteer?.(task, t)
    setSteerText(''); setSteering(false)
  }
  const who = assigneeOf(task, agents)
  const draggable = HUMAN_COLUMNS.has(task.state)
  // The agent's own checklist, for the card that is running right now. This is
  // the same todo_write state the chat renders — not a copy kept in step.
  const steps = live?.todos || []
  const doneCount = steps.filter(s => s.status === 'completed').length
  const current = steps.find(s => s.status === 'in_progress')

  return (
    <article
      className={'tb-card is-' + task.state + (draggable ? ' is-draggable' : '') + (who.missing ? ' is-orphan' : '')}
      draggable={draggable}
      onDragStart={e => draggable && onDragStart(e, task)}
      onClick={() => onOpen(task)}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onOpen(task) }}
      aria-label={`${task.title}, ${who.name}, ${COLUMNS.find(c => c.id === task.state)?.label}`}
    >
      <h4 className='tb-card-title'>{task.title}</h4>
      <div className='tb-card-who'>
        {who.missing
          // An agent can be deleted while a card still names it. Say so rather
          // than showing a blank, because the card cannot run as written.
          ? <span className='tb-warn'>That agent no longer exists</span>
          : who.name}
      </div>

      {task.state === 'working' && steps.length > 0 && (
        <div className='tb-steps'>
          <div className='tb-steps-bar'><i style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
          <div className='tb-steps-text'>
            {current ? current.content : `${doneCount} of ${steps.length} steps`}
          </div>
        </div>
      )}

      {task.state === 'blocked' && (
        <div className='tb-card-flag'>{task.lastError || 'Waiting for you to approve something'}</div>
      )}

      {/* ⚠️ THE AGENT MAY BE MID-TURN, AND THAT IS FINE. The message is held
          until the current turn settles and then sent — the same mid-turn queue
          the composer has. It is not a second way to reach an agent. */}
      {steering && (
        <form className='tb-steer' onSubmit={sendSteer} onClick={e => e.stopPropagation()}>
          <input
            ref={steerRef}
            className='tb-steer-input'
            placeholder='Tell it what to do instead…'
            aria-label={`Steer ${task.title}`}
            value={steerText}
            onChange={e => setSteerText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setSteering(false); setSteerText('') } }}
          />
          <button className='tb-mini' type='submit' disabled={!steerText.trim()}>Send</button>
        </form>
      )}

      <footer className='tb-card-foot'>
        <span className='tb-card-time'>{timeAgo(task.updatedAt || task.createdAt)}</span>
        {task.state === 'queued' && (
          <button className='tb-mini' onClick={e => { e.stopPropagation(); onStart(task) }}>Start</button>
        )}
        {canSteer && (
          <button
            className='tb-mini'
            onClick={e => { e.stopPropagation(); setSteering(v => !v) }}
          >{steering ? 'Cancel' : 'Steer'}</button>
        )}
        {(task.state === 'blocked' || task.state === 'review') && (
          <button className='tb-mini' onClick={e => { e.stopPropagation(); onOpen(task) }}>Open</button>
        )}
        <button
          className='tb-mini tb-mini-quiet'
          aria-label={`Delete ${task.title}`}
          onClick={e => { e.stopPropagation(); onDelete(task) }}
        >Delete</button>
      </footer>
    </article>
  )
}

export default function TaskBoard ({ agents = [], models = [], liveByTask = {}, onOpenTask, onSteer, onError, onRefreshModels }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  // What the picker understands: { model, provider }. An agent is carried in the
  // same shape with provider 'agent', so ONE list covers agents and models — the
  // agent library runs to 142 entries, which is no more browsable as a flat list
  // than the models were.
  const [who, setWho] = useState({ model: null, provider: null })
  const [dragOver, setDragOver] = useState(null)
  const dragged = useRef(null)
  const titleRef = useRef(null)

  const refresh = useCallback(async () => {
    try { setTasks(await api.listTasks()) } catch (e) { onError?.(e.message) } finally { setLoading(false) }
  }, [onError])

  useEffect(() => { refresh() }, [refresh])
  // The run moves cards on the server, so the board has to look again. Five
  // seconds is slow enough to be invisible in CPU terms and fast enough that a
  // card reaching "Needs you" is noticed while you are still at the desk.
  useEffect(() => {
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => { if (composing) titleRef.current?.focus() }, [composing])

  const byColumn = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map(c => [c.id, []]))
    for (const t of tasks) (map[t.state] || map.queued).push(t)
    return map
  }, [tasks])

  // Agents ride in the models list as their own provider group, so the picker
  // groups, collapses and searches them exactly as it does everything else.
  const pickable = useMemo(() => [
    ...agents.map(a => ({ id: a.name, provider: 'agent', providerName: 'Agents', agentId: a.id })),
    ...models
  ], [agents, models])

  const create = async e => {
    e?.preventDefault?.()
    const t = title.trim()
    if (!t) return
    const body = { title: t, detail: detail.trim() }
    if (who.provider === 'agent') {
      const a = agents.find(x => x.name === who.model)
      if (a) body.agentId = a.id
    } else if (who.model) {
      body.model = who.model
      body.provider = who.provider
    }
    try {
      await api.createTask(body)
      setTitle(''); setDetail(''); setWho({ model: null, provider: null }); setComposing(false)
      refresh()
    } catch (err) { onError?.(err.message) }
  }

  const start = async task => {
    try {
      const r = await api.startTask(task.id)
      refresh()
      // Hand the conversation to the chat view, which owns streaming. The board
      // never runs a turn itself — one run engine, not two.
      onOpenTask?.({ ...task, sessionId: r.sessionId }, r.prompt, r.resumed)
    } catch (err) { onError?.(err.message) }
  }

  const remove = async task => {
    try { await api.deleteTask(task.id); refresh() } catch (err) { onError?.(err.message) }
  }

  const drop = async (e, columnId) => {
    e.preventDefault()
    setDragOver(null)
    const task = dragged.current
    dragged.current = null
    if (!task || task.state === columnId) return
    if (!HUMAN_COLUMNS.has(columnId)) {
      onError?.('Working, Needs you and Review are set by the run, not by hand.')
      return
    }
    // Optimistic, then reconciled by refresh — a card that snaps back is the
    // server telling you the move was not allowed.
    setTasks(ts => ts.map(t => (t.id === task.id ? { ...t, state: columnId } : t)))
    try { await api.patchTask(task.id, { state: columnId }) } catch (err) { onError?.(err.message) }
    refresh()
  }

  return (
    <section className='tb' aria-label='Tasks'>
      <header className='tb-head'>
        <h2 className='tb-title'>Tasks</h2>
        <button className='tb-new' onClick={() => setComposing(c => !c)}>
          {composing ? 'Cancel' : 'New task'}
        </button>
      </header>

      {composing && (
        <form className='tb-compose' onSubmit={create}>
          <input
            ref={titleRef}
            className='tb-input'
            placeholder='What needs doing?'
            value={title}
            onChange={e => setTitle(e.target.value)}
            aria-label='Task title'
          />
          <textarea
            className='tb-input tb-area'
            placeholder='Any detail the agent should have (optional)'
            value={detail}
            onChange={e => setDetail(e.target.value)}
            aria-label='Task detail'
            rows={2}
          />
          <div className='tb-compose-foot'>
            <div className='tb-who-pick'>
              <ModelPicker
                session={who}
                models={pickable}
                onPick={m => setWho({ model: m.id, provider: m.provider })}
                onRefresh={() => onRefreshModels?.()}
              />
            </div>
            <button className='tb-add' type='submit' disabled={!title.trim()}>Add task</button>
          </div>
        </form>
      )}

      <div className='tb-cols'>
        {COLUMNS.map(col => (
          <div
            key={col.id}
            className={'tb-col tb-col-' + col.id + (dragOver === col.id ? ' is-over' : '') + (HUMAN_COLUMNS.has(col.id) ? '' : ' is-run-owned') + (byColumn[col.id].length ? ' has-work' : '')}
            onDragOver={e => { if (HUMAN_COLUMNS.has(col.id)) { e.preventDefault(); setDragOver(col.id) } }}
            onDragLeave={() => setDragOver(d => (d === col.id ? null : d))}
            onDrop={e => drop(e, col.id)}
          >
            <div className='tb-col-head'>
              <span className='tb-col-label'>{col.label}</span>
              <span className='tb-col-count'>{byColumn[col.id].length}</span>
            </div>
            <div className='tb-col-hint'>{col.hint}</div>
            <div className='tb-col-body'>
              {byColumn[col.id].map(t => (
                <Card
                  key={t.id}
                  task={t}
                  agents={agents}
                  live={liveByTask[t.id]}
                  onOpen={onOpenTask}
                  onStart={start}
                  onSteer={onSteer}
                  onDelete={remove}
                  onDragStart={(e, task) => { dragged.current = task; e.dataTransfer.effectAllowed = 'move' }}
                />
              ))}
              {byColumn[col.id].length === 0 && (
                <p className='tb-empty'>
                  {col.id === 'queued' && !loading && tasks.length === 0
                    ? 'Add a task and pick who should do it.'
                    : ''}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
