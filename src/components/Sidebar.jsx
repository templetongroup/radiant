import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'
import HoldButton from './HoldButton.jsx'
import { glyphColor } from '../theme.js'
import { AgentGlyph } from './AgentIcons.jsx'
import { isImported } from './Chat.jsx'
import { api, saveToFile, getServer } from '../api.js'

function UsageChip () {
  const [items, setItems] = useState(null)
  const [stale, setStale] = useState(false)
  useEffect(() => {
    let alive = true
    // ⚠️ A SWALLOWED FAILURE LOOKS LIKE "NO USAGE". This kept the previous items
    // and said nothing, so a provider could sit there with no number and no
    // reason — indistinguishable from one that does not publish usage.
    const load = () => api.getUsage()
      .then(u => { if (alive) { setItems(u.items); setStale(false) } })
      .catch(() => { if (alive) setStale(true) })
    load()
    const t = setInterval(load, 5 * 60 * 1000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const credits = items?.find(i => i.kind === 'credits')
  const subs = (items || []).filter(i => i.kind === 'subscription')
  if (!items || (!credits && !subs.length)) return null
  const fmtReset = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }
  const resetShort = iso => {
    const d = new Date(iso); if (isNaN(d)) return ''
    const mins = Math.round((d.getTime() - Date.now()) / 60000)
    if (mins <= 0) return 'now'
    if (mins < 60) return `in ${mins}m`
    const h = Math.floor(mins / 60), m = mins % 60
    if (h < 24) return m ? `in ${h}h${m}m` : `in ${h}h`
    return `in ${Math.round(h / 24)}d`
  }
  const subTitle = s => {
    if (!s.windows?.length) {
      // Some vendors publish usage and some do not — say which, so an absent
      // gauge does not read as a bug.
      return s.reportsUsage === false
        ? `${s.label}: signed in — this provider does not publish usage, so there is no number to show`
        : `${s.label}: signed in (usage not reported right now)`
    }
    return `${s.label}:\n` + s.windows.map(w => `  ${w.name}: ${w.usedPct != null ? Math.max(0, 100 - w.usedPct) + '% left' : 'active'}${w.resetAt ? ` · resets ${fmtReset(w.resetAt)}` : ''}`).join('\n')
  }
  return (
    <div className='usage-chip' title={credits ? `${credits.label}: $${credits.remaining} left of $${credits.total} ($${credits.used} used)` : ''}>
      {/* ⚠️ SAME SHAPE AS EVERY OTHER ROW: dot, name, then the number in
          .usage-sub. This one was inverted — "$69.2 OPENROUTER" against
          "Claude 64% LEFT" — so one line in the stack read backwards and the
          eye had to re-parse it. Tony: "why are all the services first then
          usage after except for openrouter? thats ui inconsistency." */}
      {credits && (
        <span className='usage-line' >
          <span className='usage-dot' /> OpenRouter
          <span className='usage-sub'>
            <span className='num-pop' key={credits.remaining}>${credits.remaining}</span> left
          </span>
        </span>
      )}
      {subs.map(s => {
        // ⚠️ SHOW THE WINDOW THAT ACTUALLY BINDS, NOT THE FIRST ONE. Claude
        // reports a 5-hour and a weekly window; this took windows[0] and so
        // announced "81% left" from the 5-hour figure while the weekly one sat
        // at 90% used. The number a person needs is the smallest amount
        // remaining — that is the one that will stop them working.
        const withPct = (s.windows || []).filter(w => w.usedPct != null)
        const primary = withPct.length
          ? withPct.reduce((a, w) => (w.usedPct > a.usedPct ? w : a))
          : s.windows?.[0]
        const pct = primary?.usedPct
        const left = pct != null ? Math.max(0, 100 - pct) : null
        const reset = primary?.resetAt ? resetShort(primary.resetAt) : ''
        const scope = withPct.length > 1 && primary?.name ? primary.name : ''
        return (
          <span key={s.provider} className='usage-line sub' title={subTitle(s)}>
            <span className={'usage-dot' + (left != null && left <= 10 ? ' warn' : ' ok')} /> {s.label}
            <span className='usage-sub'>
              {left != null
                ? <><span className='num-pop' key={left}>{left}% left</span>{scope ? <span className='usage-reset'> {scope}</span> : ''}</>
                : (stale ? 'not reachable' : 'signed in')}{reset ? <span className='usage-reset'> · ↻ {reset}</span> : ''}
            </span>
          </span>
        )
      })}
    </div>
  )
}

const MIN_W = 190
const MAX_W = 460

export default function Sidebar ({ section = 'chat', onSection, onOpenAgents, sessions, activeId, working, onOpen, onNew, onNewGroup, onDelete, onArchive, onRename, onPin, agents = [], projects = [], projectsError = null, onNewProject, onRenameProject, onDeleteProject, onMoveSession, onSettings, mode, onToggleMode, updateInfo, onUpdate, onCloseNav }) {
  const agentOf = id => agents.find(a => a.id === id)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem('radiant.sidebarWidth'))
    return saved >= MIN_W && saved <= MAX_W ? saved : 248
  })
  const dragging = useRef(false)

  useEffect(() => {
    const move = e => {
      if (!dragging.current) return
      const w = Math.min(MAX_W, Math.max(MIN_W, e.clientX))
      setWidth(w)
    }
    const up = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        localStorage.setItem('radiant.sidebarWidth', String(width))
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

  const [view, setView] = useState('chats')
  // ⚠️ SHELVES OPEN BY DEFAULT AND FORGOT WHAT YOU DID. Every project unfolded
  // on launch, so a sidebar with a few projects opened as a wall of chats, and
  // collapsing them was undone by the next restart. Tony: "have the folderss
  // closed on app launch, not open. and remember the last state."
  //
  // Stored as the set of groups the user has OPENED, so anything unknown — a
  // project made on another Mac, or a fresh install — starts closed.
  const OPEN_KEY = 'radiant.openProjects'
  const [open, setOpen] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []) } catch { return new Set() }
  })
  const toggleGroup = id => setOpen(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])) } catch {}
    return next
  })
  const collapsed = new Proxy({}, { get: (_t, id) => !open.has(String(id)) })

  const [version, setVersion] = useState('')
  // ⚠️ THIS WINDOW MAY NOT BE SHOWING THIS MAC. A stored server address in
  // localStorage points every API call at another Mac — its models, chats,
  // projects and version — and nothing in the main window ever said so. The
  // footer showed that remote version as if it were this app's, while Settings
  // → About showed the local one, so the two disagreed permanently and the
  // update pill offered to "update" based on someone else's build. Tony chased
  // that across four releases: "nav bar says .128 about screen says 133."
  const remoteBase = getServer().base || ''
  const remoteHost = remoteBase ? (() => { try { return new URL(remoteBase).host } catch { return remoteBase } })() : ''
  useEffect(() => { let alive = true; api.getVersion().then(v => { if (alive) setVersion(v.version || '') }).catch(() => {}); return () => { alive = false } }, [])

  const [search, setSearch] = useState('')
  const [results, setResults] = useState(null)
  useEffect(() => {
    const q = search.trim()
    if (!q) { setResults(null); return }
    setResults(null)
    const t = setTimeout(() => api.searchSessions(q).then(setResults).catch(() => setResults([])), 200)
    return () => clearTimeout(t)
  }, [search])

  // Archived sessions leave every normal list and gather in their own section.
  const live = React.useMemo(() => sessions.filter(s => !s.archived), [sessions])
  const archived = React.useMemo(() => sessions.filter(s => s.archived), [sessions])
  const [showArchive, setShowArchive] = useState(false)
  // Which archived chat's bin is armed. A native confirm is swallowed here.
  // ⚠️ NO TIMEOUT — see the note in Settings.jsx. A four-second disarm turned the
  // second click into a re-arm, which looks exactly like nothing happening.
  // Clicking any other row's bin moves the arm; nothing else cancels it.

  // Grouped once per render rather than filtered inside the map, so a sidebar
  // with a few hundred chats does not walk the list once per project.
  const projectGroups = React.useMemo(() => {
    const byId = new Map(projects.map(p => [p.id, []]))
    for (const s of live) if (s.projectId && byId.has(s.projectId)) byId.get(s.projectId).push(s)
    return projects.map(p => ({ project: p, rows: byId.get(p.id) || [] }))
  }, [projects, live])
  const loose = React.useMemo(
    () => live.filter(s => !s.projectId || !projects.some(p => p.id === s.projectId)),
    [live, projects]
  )

  // ⚠️ NEVER window.prompt() IN THIS APP. It is a no-op in Electron — the
  // packaged build simply ignores it — so a button wired to prompt() does
  // nothing at all, silently, while working perfectly in a browser. That is
  // exactly how the New project button shipped dead in 0.6.112: it was verified
  // in Chrome. electron/main.cjs has said so since the workspace chip needed a
  // native folder picker for the same reason.
  //
  // Inline input instead: works in Electron, in a browser, and on the phone,
  // and needs no IPC. Enter commits, Escape cancels, blur commits so clicking
  // away does not silently discard what was typed.
  const [editing, setEditing] = useState(null)   // { kind, id, value }
  const commitEdit = () => {
    const e = editing
    setEditing(null)
    const v = (e?.value || '').trim()
    if (!v) return
    if (e.kind === 'new-project') onNewProject?.(v)
    else if (e.kind === 'project') onRenameProject?.(e.id, v)
    else if (e.kind === 'session') onRename?.(e.id, v)
  }
  const InlineEdit = ({ placeholder }) => (
    <input
      className='inline-edit'
      autoFocus
      placeholder={placeholder}
      defaultValue={editing?.value || ''}
      onClick={e => e.stopPropagation()}
      onChange={e => { editing.value = e.target.value }}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') commitEdit()
        if (e.key === 'Escape') setEditing(null)
      }}
      onBlur={commitEdit}
    />
  )

  const SessionRow = ({ s, showAgent = true }) => {
    const ag = agentOf(s.agentId)
    return (
      <div
        className={'session-item' + (s.id === activeId ? ' active' : '') + (s.pinned ? ' pinned' : '') + (working && s.id === activeId ? ' working' : '')}
        onClick={() => onOpen(s.id)}
        title={s.title}
      >
        <div className='session-title'>
          {showAgent && ag && <span className='session-agent' style={isImported(ag) ? undefined : { color: glyphColor(ag.hue, 0.7, 0.15) }}><AgentGlyph agent={ag} size={13} /></span>}
          {editing?.kind === 'session' && editing.id === s.id
            ? <InlineEdit placeholder='Chat name…' />
            : <span className='session-title-text'>{s.title}</span>}
        </div>
        <span className='session-meta'>{s.model || 'no model'} · {s.messageCount} msg</span>
        <div className='session-actions'>
          {/* ⚠️ A FOLDER ICON OVER A REAL <select>, not a menu of my own.
              Moving a chat is a one-of-N choice, so it stays a select — that is
              what gives it keyboard support, screen-reader semantics and a menu
              the platform positions correctly. Only the CHROME changes: the
              select sits transparent on top of the glyph and fills it, so the
              row shows one icon instead of a 74px box spelling out a project
              name. Tony: "the pull down menu on hover on the chats is
              cumbersome. maybe make it a folder icon". Hand-rolling a menu here
              would repeat the model-picker bug from the same day, where a
              hand-positioned menu opened on top of the form that summoned it. */}
          {onMoveSession && projects.length > 0 && (
            <span
              className='session-project-wrap'
              title={s.projectId ? `In ${projects.find(p => p.id === s.projectId)?.name || 'a project'} — move it` : 'Move to project'}
            >
              {/* ⚠️ THE APP'S OWN FOLDER, not a Unicode glyph. The first cut used
                  🗀 and 🗂 — U+1F5C0 and U+1F5C2, which macOS renders as an empty
                  box and a set of card dividers rather than folders. Tony: "i
                  dont know what that icone is you put in there." Icon.folder is
                  what the project rows already draw, so a chat's folder now
                  matches the folders it can be put into. */}
              <span className={'session-project-glyph' + (s.projectId ? ' is-filed' : '')} aria-hidden><Icon.folder size={13} /></span>
              <select
                className='session-project'
                aria-label={`Move "${s.title}" to a project`}
                value={s.projectId || ''}
                onClick={e => e.stopPropagation()}
                onChange={e => { e.stopPropagation(); onMoveSession(s.id, e.target.value || null) }}
              >
                <option value=''>No project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </span>
          )}
          <button data-tip={s.pinned ? 'Unpin' : 'Pin to top'} data-tip-below title={s.pinned ? 'Unpin' : 'Pin to top'} onClick={e => { e.stopPropagation(); onPin(s.id, !s.pinned) }}>{s.pinned ? '★' : '☆'}</button>
          {/* Export one chat. Markdown, not JSON: the reason you export a single
              conversation is to show it to somebody. The JSON archive lives in
              Settings, where you go to move everything at once. */}
          <button data-tip='Export as Markdown' data-tip-below title='Export as Markdown' onClick={async e => {
            e.stopPropagation()
            try {
              const r = await api.exportChat(s.id, 'md')
              await saveToFile(r.filename, r.mime, r.content)
            } catch (err) { window.alert(`Could not export: ${err.message}`) }
          }}>⤓</button>
          <button data-tip='Rename' data-tip-below title='Rename' onClick={e => { e.stopPropagation(); setEditing({ kind: 'session', id: s.id, value: s.title }) }}>✎</button>
          {/* ⚠️ data-tip, NOT title alone. styles.css has said since it was
              written that "Electron's native title tooltips are slow/flaky" and
              ships a CSS tooltip for exactly that reason — but these buttons
              were still on title, so six icon-only controls explained themselves
              nowhere. Tony: "theres no tooltips with the session tools including
              the new archive button". title stays for screen readers and the web
              build; data-tip is what a person sees. data-tip-below because the
              actions sit at the TOP of the row, where a tooltip above is clipped.

              ⚠️ THE ICON HAS TO MEAN WHAT THE BUTTON DOES. Archiving shipped
              behind a ✕, which every interface on earth uses for delete — so the
              one control that keeps your chat looked like the one that destroys
              it. Tony: "To me an X means delete." A box with an arrow going in
              archives; a bin, and only inside the archive, deletes. */}
          {s.archived
            ? <>
                <button data-tip='Restore from archive' data-tip-below title='Restore from archive' aria-label={`Restore "${s.title}" from the archive`}
                  onClick={e => { e.stopPropagation(); onArchive(s.id, false) }}><Icon.unarchive size={13} /></button>
                {/* The only route to a real delete. Everything it removes is
                    unrecoverable, so it says so and names the session. */}
                {/* ⚠️ NOT BECAUSE CONFIRM IS BROKEN — it is not; see HoldButton.jsx. A
                    two-click arm puts the second click on a button whose meaning
                    changed under the pointer, and Tony has twice reported one that
                    "did nothing" when it had re-armed. Holding has no second click
                    to miss, and letting go means nothing happened. */}
                <HoldButton
                  data-tip='Hold to delete permanently'
                  data-tip-below
                  label={`Delete "${s.title}" permanently — hold`}
                  holdLabel={`Keep holding to delete "${s.title}" for good`}
                  onConfirm={() => onDelete(s.id)}
                ><Icon.trash size={13} /></HoldButton>
              </>
            : <button data-tip='Archive' data-tip-below title='Archive' aria-label={`Archive "${s.title}"`}
                onClick={e => { e.stopPropagation(); onArchive(s.id, true) }}><Icon.archive size={13} /></button>}
        </div>
      </div>
    )
  }

  return (
    <nav className='sidebar' style={{ width }}>
      <div className='brand'>
        <div className={'logo-mark brand-mark' + (working ? ' working' : '')} aria-hidden />
        <span className='wordmark brand-word'>Radiant</span>
        {onCloseNav && <button className='nav-close' onClick={onCloseNav} title='Close menu' aria-label='Close menu'>✕</button>}
      </div>
      {/* ⚠️ ONE SWITCHER, NOT TWO. Tasks belongs in the control the sidebar
          already has. Adding a second row above the brand stacked two segmented
          controls on top of each other — which is what it looked like the moment
          I opened the app instead of reading the code.
          Chats and Agents stay sidebar-local; Tasks swaps the main area, which
          is why it calls up instead of setView. */}
      {/* The hotkey is the fast way in; a visible control is the discoverable
          one. Electron-only — there is no floating window in a browser tab. */}
      {typeof window !== 'undefined' && window.radiantNative?.toggleHud && (
        <button
          className='hud-open'
          data-tip={'What your agents are doing, floating\nabove your other apps  (\u2325\u2318R)'}
            data-tip-below
            data-tip-end
          title='Show the HUD'
          onClick={() => window.radiantNative.toggleHud()}
        >HUD</button>
      )}
      {/* ⚠️ THE PILL'S POSITION IS DATA, NOT MARKUP. It is a pseudo-element on the
          track that translates by whole steps, so which tab is selected has to
          reach CSS as a number. A background on the button cannot travel between
          two elements — which is why the selection used to jump. */}
      <div
        className='sidebar-switch'
        style={{ '--tab-i': section === 'tasks' ? 2 : view === 'bots' ? 1 : 0 }}
      >
        <button className={section === 'chat' && view === 'chats' ? 'on' : ''}
          onClick={() => { onSection?.('chat'); setView('chats') }}>Chats</button>
        <button className={section === 'chat' && view === 'bots' ? 'on' : ''}
          onClick={() => { onSection?.('chat'); setView('bots') }}>Agents</button>
        <button className={section === 'tasks' ? 'on' : ''}
          onClick={() => onSection?.('tasks')}>Tasks</button>
      </div>
      {section === 'chat' && view === 'chats' && (
        <input className='session-search' placeholder='Search all sessions…' value={search}
          onChange={e => setSearch(e.target.value)} />
      )}
      <button className='new-session' onClick={() => onNew()}>+ New session</button>
      {view === 'chats' && onNewProject && (
        editing?.kind === 'new-project'
          ? <div className='new-group-btn as-input'><InlineEdit placeholder='Project name…' /></div>
          : <button className='new-group-btn' onClick={() => setEditing({ kind: 'new-project', value: '' })}><Icon.folder size={13} /> New project</button>
      )}
      {view === 'bots' && agents.length >= 2 && onNewGroup && (
        <button className='new-group-btn' onClick={() => onNewGroup()}>👥 New group chat</button>
      )}

      {view === 'chats' ? (
        <div className='session-list'>
          {search.trim() ? (
            results === null
              ? <div style={{ padding: '10px 12px', color: 'var(--text-faint)', fontSize: 12 }}>Searching…</div>
              : results.length
                ? results.map(r => (
                    <div key={r.id} className='search-result' onClick={() => onOpen(r.id)}>
                      <div className='search-result-title'>{r.title}</div>
                      <div className='search-result-snippet'>…{r.snippet}…</div>
                    </div>
                  ))
                : <div style={{ padding: '10px 12px', color: 'var(--text-faint)', fontSize: 12 }}>No matches.</div>
          ) : <>
            {/* ⚠️ SAME SHELF IDIOM AS THE AGENTS TAB — caret, name, count, and a
                collapse that remembers. Two different ways to group the same
                sidebar would be exactly the inconsistency Tony has called out
                before. "No project" is rendered LAST and only when it has
                something in it, so a fully-filed sidebar shows no empty tail. */}
            {projectsError && (
              <div className='projects-error'>{projectsError}</div>
            )}
            {projectGroups.map(({ project, rows }) => {
              const isCollapsed = collapsed[project.id]
              return (
                <div className='bot-group' key={project.id}>
                  <div className='bot-head'>
                    <button className='bot-head-toggle' onClick={() => toggleGroup(project.id)} title={isCollapsed ? 'Show chats' : 'Hide chats'}>
                      <span className='bot-head-caret'>{rows.length ? (isCollapsed ? '▸' : '▾') : ''}</span>
                      <span className='bot-head-icon' style={{ color: glyphColor(project.hue, 0.7, 0.16) }}><Icon.folder size={14} /></span>
                      {editing?.kind === 'project' && editing.id === project.id
                        ? <InlineEdit placeholder='Project name…' />
                        : <span className='bot-head-name'>{project.name}</span>}
                      <span className='bot-head-count'>{rows.length}</span>
                    </button>
                    <span className='bot-head-actions'>
                    {onNew && (
                      <button className='bot-new' title={`New chat in ${project.name}`}
                        onClick={() => onNew({ projectId: project.id })}>+</button>
                    )}
                    {onRenameProject && (
                      <button className='bot-new' title={`Rename ${project.name}`}
                        onClick={() => setEditing({ kind: 'project', id: project.id, value: project.name })}>✎</button>
                    )}
                    {onDeleteProject && (
                      <button className='bot-new' title={`Delete ${project.name}`}
                        onClick={() => {
                          // Say what survives. A folder in a sidebar looks
                          // disposable and the chats inside it are not.
                          const msg = rows.length
                            ? `Delete the project "${project.name}"?\n\nIts ${rows.length} chat${rows.length === 1 ? '' : 's'} will be kept and moved to "No project".`
                            : `Delete the project "${project.name}"?`
                          if (window.confirm(msg)) onDeleteProject(project.id)
                        }}>✕</button>
                    )}
                    </span>
                  </div>
                  {!isCollapsed && rows.map(s => <SessionRow key={s.id} s={s} />)}
                  {!isCollapsed && !rows.length && (
                    <div className='bot-empty'>No chats yet.</div>
                  )}
                </div>
              )
            })}
            {loose.length > 0 && projects.length > 0 && (
              <div className='bot-group'>
                <div className='bot-head'>
                  <button className='bot-head-toggle' onClick={() => toggleGroup('__loose')} title={collapsed.__loose ? 'Show chats' : 'Hide chats'}>
                    <span className='bot-head-caret'>{collapsed.__loose ? '▸' : '▾'}</span>
                    <span className='bot-head-name'>No project</span>
                    <span className='bot-head-count'>{loose.length}</span>
                  </button>
                </div>
                {!collapsed.__loose && loose.map(s => <SessionRow key={s.id} s={s} />)}
              </div>
            )}
            {/* Before the first project exists there is nothing to group by, so
                the list stays exactly as it was. */}
            {!projects.length && live.map(s => <SessionRow key={s.id} s={s} />)}
            {/* Only when there are no shelves to speak for themselves. With
                projects present each one already says "No chats yet.", and this
                line underneath them said the same thing a third time. */}
            {!live.length && !projects.length && <div style={{ padding: '10px 12px', color: 'var(--text-faint)', fontSize: 12 }}>No sessions yet.</div>}
            {/* Archive: collapsed by default and last in the list, so it stays
                out of the way but the sessions remain reachable — and remain
                findable by search, which reads from disk regardless. */}
            {archived.length > 0 && (
              <div className='bot-group'>
                <div className='bot-head'>
                  <button className='bot-head-toggle' onClick={() => setShowArchive(v => !v)} title={showArchive ? 'Hide archived' : 'Show archived'}>
                    <span className='bot-head-caret'>{showArchive ? '▾' : '▸'}</span>
                    <span className='bot-head-name' style={{ color: 'var(--text-faint)' }}>Archived</span>
                    <span className='bot-head-count'>{archived.length}</span>
                  </button>
                </div>
                {showArchive && archived.map(s => <SessionRow key={s.id} s={s} />)}
              </div>
            )}
          </>}
        </div>
      ) : (
        <div className='session-list'>
          {[...agents].sort((x, y) => Number(isImported(x)) - Number(isImported(y))).map((a, i, list) => {
            const own = live.filter(s => s.agentId === a.id)
            const isCollapsed = collapsed[a.id]
            // first imported agent in the list opens the "from other apps" group
            const startsImported = isImported(a) && !(i > 0 && isImported(list[i - 1]))
            return (
              <React.Fragment key={a.id}>
              {startsImported && <div className='agent-divider'><span>Imported from other apps</span></div>}
              <div className='bot-group'>
                <div className='bot-head'>
                  <button className='bot-head-toggle' onClick={() => toggleGroup(a.id)} title={isCollapsed ? 'Show sessions' : 'Hide sessions'}>
                    <span className='bot-head-caret'>{own.length ? (isCollapsed ? '▸' : '▾') : ''}</span>
                    <span className='bot-head-icon' style={isImported(a) ? undefined : { color: glyphColor(a.hue, 0.7, 0.16) }}><AgentGlyph agent={a} size={16} /></span>
                    <span className='bot-head-name'>{a.name}</span>
                    <span className='bot-head-count'>{own.length}</span>
                  </button>
                  {/* ⚠️ DRAWN, NOT TYPED. A "+" character is not centred on its
                      em box — it sits on the font's mathematical axis, above the
                      middle — so `place-items: center` centres the LINE BOX and
                      the ink still lands high. It looked off, because it was.
                      Two strokes on an exact grid cannot drift with the font. */}
                  <button className='bot-new' title={`New session with ${a.name}`} onClick={() => onNew(a.id)} aria-label={`New session with ${a.name}`}>
                    <svg viewBox='0 0 12 12' width='11' height='11' aria-hidden='true'>
                      <path d='M6 2.5v7M2.5 6h7' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
                    </svg>
                  </button>
                </div>
                {!isCollapsed && own.map(s => <SessionRow key={s.id} s={s} showAgent={false} />)}
              </div>
              </React.Fragment>
            )
          })}
          {(() => { const orphans = live.filter(s => !agentOf(s.agentId)); return orphans.length > 0 && (
            <div className='bot-group'>
              <div className='bot-head'><span className='bot-head-name' style={{ color: 'var(--text-faint)' }}>No agent</span><span className='bot-head-count'>{orphans.length}</span></div>
              {orphans.map(s => <SessionRow key={s.id} s={s} />)}
            </div>
          )})()}
        </div>
      )}
      {updateInfo && !remoteBase && (
        <button className='update-pill' onClick={onUpdate} title={`Radiant ${updateInfo.latest} is available`}>
          ↑ Update to {updateInfo.latest}
        </button>
      )}
      <UsageChip />
      <div className='sidebar-foot'>
        <button className='icon-btn' onClick={onSettings} title='Open settings'><Icon.settings /> Settings</button>
        <button className='icon-btn' onClick={onToggleMode} title={`Appearance: ${mode}`} data-tip={`Theme: ${mode} — click to cycle\nlight / medium / dark`}>
          {mode === 'light' ? <Icon.sun /> : mode === 'medium' ? <Icon.contrast /> : <Icon.moon />}
        </button>
        {/* Which build you are actually running. Worth having in the window and
            not only in Settings → About: the first question about any odd
            behaviour is "are you on the current version", and until now
            answering it meant opening another screen. */}
        {version && (
          remoteBase
            ? <span className='sidebar-version is-remote' title={`Showing Radiant ${version} on ${remoteHost}. Settings → Devices to use this Mac instead.`}>
                {remoteHost} · {version}
              </span>
            : <span className='sidebar-version' title={`Radiant ${version}`}>{version}</span>
        )}
      </div>
      <div className='sidebar-resize' onMouseDown={startDrag} title='Drag to resize' />
    </nav>
  )
}
