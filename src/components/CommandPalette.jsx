import React, { useEffect, useMemo, useRef, useState } from 'react'

// ⌘K command palette: fuzzy-ish search over actions, agents, sessions, models.
export default function CommandPalette ({ sessions, agents, models, session, actions, onClose }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const commands = useMemo(() => {
    const cmds = [
      { id: 'new', group: 'Actions', label: 'New session', hint: '⌘N', run: () => actions.newSession() },
      { id: 'settings', group: 'Actions', label: 'Open settings', hint: '⌘,', run: () => actions.openSettings() },
      { id: 'compare', group: 'Actions', label: 'Compare two models', run: () => actions.compare() },
      { id: 'panel', group: 'Actions', label: 'Toggle activity & terminal panel', run: () => actions.toggleRight() },
      { id: 'mode', group: 'Actions', label: 'Cycle appearance (light / medium / dark)', run: () => actions.toggleMode() }
    ]
    for (const a of agents) cmds.push({ id: 'agent-' + a.id, group: 'Start with agent', label: `${a.emoji || '\u00b7'}  ${a.name}`, run: () => actions.newSession(a.id) })
    if (session) for (const m of models) cmds.push({ id: 'model-' + m.provider + m.id, group: 'Switch model', label: `${m.providerName} · ${m.id}`, run: () => actions.pickModel(m) })
    for (const s of sessions) cmds.push({ id: 'sess-' + s.id, group: 'Sessions', label: s.title, hint: s.model, run: () => actions.openSession(s.id) })
    return cmds
  }, [agents, models, sessions, session, actions])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return commands.slice(0, 40)
    return commands.filter(c => (c.label + ' ' + c.group).toLowerCase().includes(t)).slice(0, 40)
  }, [q, commands])

  useEffect(() => { setSel(0) }, [q])
  useEffect(() => {
    const el = listRef.current?.children[sel]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const choose = c => { c.run(); onClose() }
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[sel]) choose(filtered[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  // group headers inline
  let lastGroup = null
  return (
    <div className='palette-backdrop' onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className='palette'>
        <input
          ref={inputRef} className='palette-input' placeholder='Search actions, agents, sessions, models…'
          value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
        />
        <div className='palette-list' ref={listRef}>
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? <div key={'h' + c.group + i} className='palette-group'>{c.group}</div> : null
            lastGroup = c.group
            return (
              <React.Fragment key={c.id}>
                {header}
                <button
                  className={'palette-item' + (i === sel ? ' sel' : '')}
                  onMouseMove={() => setSel(i)}
                  onClick={() => choose(c)}
                >
                  <span className='palette-label'>{c.label}</span>
                  {c.hint && <span className='palette-hint'>{c.hint}</span>}
                </button>
              </React.Fragment>
            )
          })}
          {!filtered.length && <div className='palette-empty'>No matches</div>}
        </div>
      </div>
    </div>
  )
}
