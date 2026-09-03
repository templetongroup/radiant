import React, { useEffect, useRef, useState } from 'react'
import Terminal from './Terminal.jsx'
import { Icon } from './Icons.jsx'

const MIN_W = 300
const MAX_W = 720

// ⚠️ ONE SCROLLBAR PER PANEL, NOT ONE PER ENTRY. Every activity row carried
// `max-height: 200px; overflow-y: auto`, so reading the feed meant scrolling the
// panel to a card and then scrolling again inside it, with each card a separate
// bordered box. Tony: "having the commands in separate rolling boxes is also
// poor design and hard to follow."
//
// Now it is one continuous stream. Long output is clamped with a fade and a
// button that says how much is hidden, rather than trapped in a small window —
// so the panel scrolls once and nothing is buried inside something else.
const CLAMP_LINES = 12

function ActivityItem ({ item }) {
  const [open, setOpen] = useState(false)
  const head = item.name === 'run_command' ? '$ ' + (item.args?.command || '') : JSON.stringify(item.args ?? {})
  const body = item.denied ? '[denied by user]'
    : item.result != null ? String(item.result).slice(0, 8000)
    : '[running…]'
  const text = head + '\n' + body
  const lines = text.split('\n')
  const long = lines.length > CLAMP_LINES
  const shown = open || !long ? text : lines.slice(0, CLAMP_LINES).join('\n')
  const failed = item.denied || (item.result != null && /^Error/i.test(String(item.result)))
  return (
    <div className={'activity-item' + (failed ? ' failed' : '')}>
      <div className='head'>
        <span className='tool-name'>{item.name}</span>
        {failed && <span className='act-fail'>failed</span>}
        <span className='when'>{new Date(item.at).toLocaleTimeString()}</span>
      </div>
      <pre className={long && !open ? 'is-clamped' : ''}>{shown}</pre>
      {long && (
        <button className='act-more' onClick={() => setOpen(o => !o)}>
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}

export default function RightPanel ({ tab, onTab, activity, cwd, mode, onClose }) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('radiant.rightWidth'))
    return saved >= MIN_W && saved <= MAX_W ? saved : 400
  })
  const dragging = useRef(false)

  useEffect(() => {
    const move = e => {
      if (!dragging.current) return
      const w = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX))
      setWidth(w)
    }
    const up = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        localStorage.setItem('radiant.rightWidth', String(width))
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [width])

  const startDrag = () => {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <aside className='right-panel' style={{ width }}>
      <div className='right-resize' onMouseDown={startDrag} title='Drag to resize' />
      <div className='right-tabs'>
        <button className={'right-tab' + (tab === 'activity' ? ' active' : '')} onClick={() => onTab('activity')}>Activity</button>
        <button className={'right-tab' + (tab === 'terminal' ? ' active' : '')} onClick={() => onTab('terminal')}>Terminal</button>
        <div style={{ flex: 1 }} />
        <button className='icon-btn' onClick={onClose} title='Close panel'><Icon.close /></button>
      </div>
      <div className='right-body'>
        {tab === 'activity' && (
          <div className='activity-feed'>
            {!activity.length && <div className='activity-empty'>Agent tool calls will appear here as they run.</div>}
            {/* ⚠️ NEWEST FIRST. The feed appends as tools run and never follows the
                bottom, so watching a long turn meant scrolling down again after
                every call. Tony: "shouldnt newest be at the top so i dont have to
                scroll down every time to see latest?"
                Reversed on render rather than stored backwards, because the array
                is updated by id — a completed call is patched in place, and
                reversing the SOURCE would put the write and the read out of step. */}
            {[...activity].reverse().map(item => <ActivityItem key={item.id + item.at} item={item} />)}
          </div>
        )}
        {tab === 'terminal' && <Terminal cwd={cwd} mode={mode} />}
      </div>
    </aside>
  )
}
