import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import Markdown from './Markdown.jsx'

/**
 * One task, opened: the work on the left, its properties on the right.
 *
 * ⚠️ ONE FEED, NOT FOUR TABS. Comments, what changed, each run and the tools
 * that run used all go in one list in time order — the way you would read what
 * happened to a card, top to bottom. It is the shape Hermes' Kanban arrived at
 * (Tony, 2026-09-27: "hermes redid theirs"); the filter only narrows it.
 *
 * ⚠️ THE WORKER LOG IS READ FROM THE RUN'S TRANSCRIPT (GET /api/tasks/:id/feed),
 * never copied onto the card, so the card and the chat cannot disagree about
 * what the agent did.
 */

const STATE_LABEL = { queued: 'Queued', working: 'Working', blocked: 'Needs you', review: 'Review', done: 'Done' }
const PRIORITIES = [['none', 'No priority'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']]
const OUTCOME = { running: 'Running', finished: 'Finished', waiting: 'Waiting on you', error: 'Stopped with an error', stopped: 'Stopped' }
const FILTERS = [['all', 'All'], ['comment', 'Comments'], ['run', 'Runs'], ['activity', 'History']]

function when (iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function span (a, b) {
  if (!a || !b) return ''
  const s = Math.round((new Date(b) - new Date(a)) / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`
}

function RunItem ({ item, onOpenChat }) {
  const [open, setOpen] = useState(item.outcome === 'running')
  return (
    <div className={'td-run is-' + (item.outcome || 'running')}>
      <div className='td-run-head'>
        <span className='td-run-dot' aria-hidden='true' />
        <strong>Run {item.n}</strong>
        <span className='td-run-state'>{OUTCOME[item.outcome] || item.outcome}</span>
        {item.model && <span className='td-run-model'>{item.model}</span>}
        <span className='td-time'>{item.endedAt ? span(item.at, item.endedAt) : when(item.at)}</span>
      </div>
      {item.note && <div className='td-run-note'>{item.note}</div>}
      {item.log.length > 0 && (
        <button type='button' className='td-link' aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {open ? 'Hide' : 'Show'} worker log · {item.log.length} {item.log.length === 1 ? 'step' : 'steps'}
        </button>
      )}
      {open && item.log.length > 0 && (
        <ol className='td-log'>
          {item.log.map((l, i) => (
            <li key={i} className={l.error ? 'is-error' : ''}>
              <span className='td-log-tool'>{l.tool}</span>
              {l.args && <span className='td-log-args'>{l.args}</span>}
              {l.result && <pre className='td-log-result'>{l.result}</pre>}
            </li>
          ))}
        </ol>
      )}
      {item.reply && (
        <details className='td-reply'>
          <summary>Last reply</summary>
          <Markdown text={item.reply} />
        </details>
      )}
      <button type='button' className='td-link' onClick={onOpenChat}>Open the conversation</button>
    </div>
  )
}

export default function TaskDetail ({ taskId, agents = [], onClose, onOpenChat, onStart, onOpenTask, onChanged, onError }) {
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('all')
  const [comment, setComment] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [label, setLabel] = useState('')
  const [allTasks, setAllTasks] = useState([])
  const panel = useRef(null)

  const load = useCallback(async () => {
    try {
      const [feed, tasks] = await Promise.all([api.taskFeed(taskId), api.listTasks()])
      setData(feed); setAllTasks(tasks)
    } catch (e) { onError?.(e.message) }
  }, [taskId, onError])
  useEffect(() => { setData(null); setEditing(false); load() }, [load])
  // A run moves the card on the server; keep the open card current.
  useEffect(() => { const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])
  // ⚠️ FOCUS ONCE, ON OPEN. This effect used to depend on onClose, which the
  // board passes as a fresh arrow every render — so every poll and every
  // keystroke re-ran it and yanked focus back to the panel, out of whatever box
  // you were typing in. The latest onClose is read through a ref instead.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape' && !e.defaultPrevented) closeRef.current() }
    document.addEventListener('keydown', esc)
    panel.current?.focus()
    return () => document.removeEventListener('keydown', esc)
  }, [])

  const patch = async p => {
    try { await api.patchTask(taskId, p); await load(); onChanged?.() } catch (e) { onError?.(e.message) }
  }
  if (!data) return <div className='td-scrim' onClick={onClose}><section className='td' ref={panel} tabIndex={-1} aria-busy='true' /></div>

  const task = data.task
  const agent = task.agentId ? agents.find(a => a.id === task.agentId) : null
  const who = task.agentId ? (agent ? agent.name : 'Missing agent') : (task.model || 'Default model')
  const items = data.items.filter(i => filter === 'all' || i.kind === filter).slice().reverse()
  const waiting = data.waitingOn.length
  const lastStart = task.runs[task.runs.length - 1]?.startedAt || ''
  const freshComments = task.comments.filter(c => c.author === 'you' && c.at > lastStart).length
  const candidates = allTasks.filter(t => t.id !== task.id && !task.blockedBy.includes(t.id))

  const send = async e => {
    e?.preventDefault?.()
    const t = comment.trim()
    if (!t) return
    try { await api.commentTask(taskId, t); setComment(''); load(); onChanged?.() } catch (err) { onError?.(err.message) }
  }
  const addLabel = e => {
    e.preventDefault()
    const l = label.trim()
    if (!l) return
    setLabel('')
    patch({ labels: [...task.labels, l] })
  }
  const overdue = task.due && task.state !== 'done' && new Date(task.due) < new Date(new Date().toDateString())

  return (
    <div className='td-scrim' onClick={onClose}>
      <section
        className='td'
        role='dialog'
        aria-modal='true'
        aria-label={task.title}
        ref={panel}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className='td-main'>
          <div className='td-top'>
            <input
              className='td-title'
              aria-label='Task title'
              defaultValue={task.title}
              key={task.title}
              onBlur={e => { const v = e.target.value.trim(); if (v && v !== task.title) patch({ title: v }) }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
            <button type='button' className='td-close' aria-label='Close' onClick={onClose}>×</button>
          </div>

          <div className='td-desc'>
            {editing
              ? (
                <>
                  <textarea
                    className='tb-input td-desc-edit'
                    aria-label='Description'
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }}
                    rows={8}
                    autoFocus
                  />
                  <div className='td-row'>
                    <button type='button' className='tb-mini' onClick={() => { setEditing(false); patch({ detail: draft }) }}>Save</button>
                    <button type='button' className='tb-mini tb-mini-quiet' onClick={() => setEditing(false)}>Cancel</button>
                    <span className='td-hint'>Markdown works here.</span>
                  </div>
                </>
                )
              : task.detail
                ? <div className='td-md' onDoubleClick={() => { setDraft(task.detail); setEditing(true) }}><Markdown text={task.detail} /></div>
                : <p className='td-empty'>No description yet.</p>}
            {!editing && (
              <button type='button' className='td-link' onClick={() => { setDraft(task.detail || ''); setEditing(true) }}>
                {task.detail ? 'Edit description' : 'Add a description'}
              </button>
            )}
          </div>

          <div className='td-feed-head'>
            <h3>Activity</h3>
            <div className='td-filters' role='group' aria-label='Show'>
              {FILTERS.map(([id, name]) => (
                <button key={id} type='button' className={'td-chip' + (filter === id ? ' is-on' : '')} aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}</button>
              ))}
            </div>
          </div>

          <form className='td-compose' onSubmit={send}>
            <textarea
              className='tb-input'
              placeholder='Write a comment…'
              aria-label='Comment'
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e) }}
              rows={2}
            />
            <div className='td-row'>
              <span className='td-hint'>The agent reads new comments the next time this task starts or resumes.</span>
              <button className='tb-mini' type='submit' disabled={!comment.trim()}>Comment</button>
            </div>
          </form>

          <ol className='td-feed'>
            {items.map((i, n) => (
              <li key={i.kind + (i.id || n) + i.at} className={'td-item is-' + i.kind}>
                {i.kind === 'comment' && (
                  <div className='td-comment'>
                    <div className='td-comment-head'>
                      <strong>{i.author === 'agent' ? 'Agent' : 'You'}</strong>
                      <span className='td-time'>{when(i.at)}</span>
                    </div>
                    <Markdown text={i.text} />
                  </div>
                )}
                {i.kind === 'activity' && (
                  <div className='td-act'>
                    <span className='td-act-dot' aria-hidden='true' />
                    <span>{i.by === 'agent' ? 'Agent: ' : i.by === 'run' ? '' : ''}{i.text}</span>
                    <span className='td-time'>{when(i.at)}</span>
                  </div>
                )}
                {i.kind === 'run' && <RunItem item={i} onOpenChat={() => onOpenChat(task)} />}
              </li>
            ))}
            {items.length === 0 && <li className='td-empty'>Nothing here yet.</li>}
          </ol>
        </div>

        <aside className='td-side' aria-label='Properties'>
          <div className='td-prop'>
            <span className='td-prop-name'>Status</span>
            <span className={'td-state is-' + task.state}>{STATE_LABEL[task.state]}</span>
          </div>
          <div className='td-actions'>
            {task.state === 'queued' && (
              <button type='button' className='rx-btn rx-btn-go' disabled={waiting > 0} onClick={() => onStart(task)}>
                {waiting > 0 ? `Waiting on ${waiting}` : 'Start'}
              </button>
            )}
            {task.sessionId && task.state !== 'queued' && freshComments > 0 && task.state !== 'working' && (
              <button type='button' className='rx-btn rx-btn-go' onClick={() => onStart(task)}>
                Send {freshComments === 1 ? 'your comment' : `${freshComments} comments`} to the agent
              </button>
            )}
            {task.sessionId && <button type='button' className='rx-btn' onClick={() => onOpenChat(task)}>Open conversation</button>}
            {task.state === 'review' && <button type='button' className='rx-btn' onClick={() => patch({ state: 'done' })}>Accept — mark Done</button>}
            {task.state === 'done' && <button type='button' className='rx-btn' onClick={() => patch({ state: 'queued' })}>Back to Queued</button>}
          </div>

          <div className='td-prop'>
            <span className='td-prop-name'>Assigned to</span>
            <span className={agent || !task.agentId ? '' : 'tb-warn'}>{who}</span>
          </div>

          <label className='td-prop'>
            <span className='td-prop-name'>Priority</span>
            <select className='tb-select' value={task.priority} onChange={e => patch({ priority: e.target.value })}>
              {PRIORITIES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
          </label>

          <div className='td-prop'>
            <span className='td-prop-name'>Labels</span>
            <div className='td-labels'>
              {task.labels.map(l => (
                <span key={l} className='td-label'>{l}
                  <button type='button' aria-label={`Remove label ${l}`} onClick={() => patch({ labels: task.labels.filter(x => x !== l) })}>×</button>
                </span>
              ))}
              <input
                className='td-label-add'
                placeholder='Add label'
                aria-label='Add a label'
                value={label}
                onChange={e => setLabel(e.target.value)}
                // Enter, handled here: implicit form submission never reached React in the app
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') addLabel(e) }}
              />
            </div>
          </div>

          <label className='td-prop'>
            <span className='td-prop-name'>Due</span>
            <input type='date' className={'tb-select' + (overdue ? ' is-overdue' : '')} value={task.due ? task.due.slice(0, 10) : ''} onChange={e => patch({ due: e.target.value || null })} />
          </label>

          <div className='td-prop is-block'>
            <span className='td-prop-name'>Waits on</span>
            <ul className='td-links'>
              {data.blockedBy.map(t => (
                <li key={t.id}>
                  <button type='button' className='td-task-link' onClick={() => t.state && onOpenTask(t.id)}>
                    <span className={'td-dot is-' + (t.state || 'gone')} aria-hidden='true' />{t.title}
                    <span className='td-link-state'>{t.state ? STATE_LABEL[t.state] : ''}</span>
                  </button>
                  <button type='button' className='td-x' aria-label={`Stop waiting on ${t.title}`} onClick={() => patch({ blockedBy: task.blockedBy.filter(id => id !== t.id) })}>×</button>
                </li>
              ))}
            </ul>
            {candidates.length > 0 && (
              <select className='tb-select' value='' aria-label='Add a task this one waits on' onChange={e => e.target.value && patch({ blockedBy: [...task.blockedBy, e.target.value] })}>
                <option value=''>+ Wait on another task…</option>
                {candidates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            )}
          </div>

          {data.blocks.length > 0 && (
            <div className='td-prop is-block'>
              <span className='td-prop-name'>Blocks</span>
              <ul className='td-links'>
                {data.blocks.map(t => (
                  <li key={t.id}>
                    <button type='button' className='td-task-link' onClick={() => onOpenTask(t.id)}>
                      <span className={'td-dot is-' + t.state} aria-hidden='true' />{t.title}
                      <span className='td-link-state'>{STATE_LABEL[t.state]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className='td-dates'>
            <dt>Created</dt><dd>{when(task.createdAt)}</dd>
            {task.startedAt && <><dt>Started</dt><dd>{when(task.startedAt)}</dd></>}
            {task.finishedAt && <><dt>Finished</dt><dd>{when(task.finishedAt)}</dd></>}
            <dt>Runs</dt><dd>{task.runs.length}</dd>
          </dl>
        </aside>
      </section>
    </div>
  )
}
