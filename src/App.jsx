import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamChat } from './api.js'
import { applyTheme } from './theme.js'
import Sidebar from './components/Sidebar.jsx'
import Chat, { GroupPicker } from './components/Chat.jsx'
import RightPanel from './components/RightPanel.jsx'
import Settings from './components/Settings.jsx'
import MotionBackground from './components/MotionBackground.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import ComparePanel from './components/ComparePanel.jsx'
import ConnectGate from './components/ConnectGate.jsx'

// ── the phone ───────────────────────────────────────────────────────────────
// Radiant on iPhone is a different app: the model lives on the phone, and the
// UI for that is src/mobile, which shares no styling with the desktop build.
// The check is a module-level constant, so the desktop render path below is
// identical to what it was — and because the import is lazy, mobile.css and the
// whole src/mobile tree stay out of the Mac bundle's entry chunk.
const NATIVE = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true
const Phone = NATIVE ? React.lazy(() => import('./mobile/Phone.jsx')) : null

export default function App () {
  if (NATIVE) {
    return (
      <React.Suspense fallback={null}>
        <Phone />
      </React.Suspense>
    )
  }
  return <DesktopApp />
}

function DesktopApp () {
  const [config, setConfig] = useState(null)
  const [models, setModels] = useState([])
  const [sessions, setSessions] = useState([])
  const [projects, setProjects] = useState([])
  const [projectsError, setProjectsError] = useState(null)
  const [session, setSession] = useState(null) // full active session {id,...,messages}
  const [live, setLive] = useState(null) // in-flight assistant message view {parts, thinking, streaming}
  const [approval, setApproval] = useState(null) // {id, name, args}
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const [skillSuggestion, setSkillSuggestion] = useState(null) // {id, name, description, rationale} — a drafted skill awaiting review
  const [activity, setActivity] = useState([]) // tool feed for right panel
  const [usage, setUsage] = useState(null)
  const [error, setError] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('providers')
  const [agentView, setAgentView] = useState(null) // 'library' deep-links the Agents pane into the template gallery
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState('activity')
  const [updateInfo, setUpdateInfo] = useState(null) // {latest, dmgUrl} when an update exists
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false) // mobile sidebar drawer
  const [todos, setTodos] = useState([]) // agent checklist for the active session
  const [question, setQuestion] = useState(null) // { id, question, options } when the agent asks
  const [stats, setStats] = useState(null) // cumulative session stats
  const streamingSessionRef = useRef(null)

  const refreshSessions = useCallback(() => api.listSessions().then(setSessions).catch(() => {}), [])
  // ⚠️ DO NOT SWALLOW THIS. It was `.catch(() => {})`, so when the Radiant you
  // are connected to cannot serve projects — most obviously a host Mac running
  // a build older than the one that added them — the sidebar simply showed no
  // projects, with nothing anywhere saying why. Tony: "and i dont see the
  // projects i setup on another mac." An empty list and a failed request must
  // not look identical.
  const refreshProjects = useCallback(() => api.listProjects()
    .then(p => { setProjects(p); setProjectsError(null) })
    .catch(e => {
      setProjects([])
      setProjectsError(e?.status === 404
        ? 'The Mac you are connected to is running an older Radiant that does not have projects. Update it and they will appear.'
        : `Could not load projects: ${e.message}`)
    }), [])

  // Project handlers. Each one refreshes BOTH lists: deleting a project rewrites
  // the projectId on every session that referenced it, so a sessions list left
  // unrefreshed would keep drawing chats under a shelf that no longer exists.
  const newProject = useCallback(async (name) => {
    await api.createProject({ name }).catch(() => {})
    refreshProjects(); refreshSessions()
  }, [refreshProjects, refreshSessions])
  const renameProject = useCallback(async (id, name) => {
    await api.patchProject(id, { name }).catch(() => {})
    refreshProjects()
  }, [refreshProjects])
  const deleteProject = useCallback(async (id) => {
    await api.deleteProject(id).catch(() => {})
    refreshProjects(); refreshSessions()
  }, [refreshProjects, refreshSessions])
  const moveSession = useCallback(async (id, projectId) => {
    await api.patchSession(id, { projectId }).catch(() => {})
    refreshSessions()
  }, [refreshSessions])
  const refreshModels = useCallback(() => api.getModels().then(setModels).catch(() => {}), [])

  useEffect(() => {
    api.getConfig().then(cfg => {
      setConfig(cfg)
      applyTheme(cfg.settings)
      if (cfg.settings.autoUpdateCheck !== false) {
        api.updateCheck().then(u => { if (u.hasUpdate) setUpdateInfo(u) }).catch(() => {})
      }
    }).catch(e => setError('Cannot reach the Radiant server: ' + e.message))
    refreshSessions()
    refreshProjects()
    refreshModels()
  }, [refreshSessions, refreshProjects, refreshModels])

  // ⚠️ A SHARED SERVER HAS MORE THAN ONE CLIENT, AND NOTHING TOLD THIS ONE.
  // The sidebar only ever refreshed after an action taken HERE, so a second Mac
  // pointed at a shared Radiant showed a stale list forever. Measured: a chat
  // created on the host was on the server instantly, and the other client still
  // did not have it after ten seconds, after being refocused, or at any point
  // until something unrelated was clicked on it.
  //
  // Poll while the window is actually being looked at, and refresh the moment it
  // is focused — which is exactly when you have walked back to the other Mac.
  // Nothing runs while hidden, so an idle window in the background costs zero.
  useEffect(() => {
    const sync = () => { if (!document.hidden) { refreshSessions(); refreshProjects() } }
    const onVisible = () => { if (!document.hidden) sync() }
    let timer = setInterval(sync, 12000)
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshSessions, refreshProjects])

  const saveSettings = async patch => {
    const cfg = await api.saveSettings(patch)
    setConfig(cfg)
    applyTheme(cfg.settings)
  }

  const openSettings = () => {
    setNavOpen(false) // close the mobile drawer so it doesn't cover the settings panel
    if (window.radiantNative?.openSettings) window.radiantNative.openSettings()
    else setSettingsOpen(true)
  }

  // when the separate settings window closes, pull in any changes it made
  useEffect(() => {
    if (!window.radiantNative?.onSettingsClosed) return
    return window.radiantNative.onSettingsClosed(() => {
      api.getConfig().then(cfg => { setConfig(cfg); applyTheme(cfg.settings) }).catch(() => {})
      refreshModels()
    })
  }, [refreshModels])

  const openSession = async id => {
    const s = await api.getSession(id)
    setSession(s)
    setTodos(s.todos || [])
    setStats(s.stats || null)
    setQuestion(null)
    setError(null)
    if (streamingSessionRef.current !== id) { setLive(null); setApproval(null) }
  }

  // ⚠️ TAKES EITHER SHAPE. Every existing caller passes a bare agentId string;
  // the project shelves pass { projectId }. Accepting both keeps one function
  // instead of a second near-identical one that would drift.
  const newSession = async (arg) => {
    const opts = (arg && typeof arg === 'object') ? arg : (arg ? { agentId: arg } : {})
    const agentId = opts.agentId || null
    const agent = agentId ? (config.agents || []).find(a => a.id === agentId) : null
    const body = { ...(agentId ? { agentId } : {}), ...(opts.projectId ? { projectId: opts.projectId } : {}) }
    // if the agent has no fixed model, seed with the first available model
    if (!(agent && agent.model)) {
      const best = models[0]
      if (best) { body.provider = best.provider; body.model = best.id }
    }
    const s = await api.createSession(body)
    setSession(s)
    setTodos([])
    setQuestion(null)
    setStats(null)
    setLive(null)
    setApproval(null)
    setError(null)
    refreshSessions()
  }

  const newGroup = async (participantIds) => {
    const body = { participants: participantIds }
    const best = models[0]
    if (best) { body.provider = best.provider; body.model = best.id }
    const s = await api.createSession(body)
    setSession(s); setTodos([]); setQuestion(null); setStats(null); setLive(null); setApproval(null); setError(null); setNavOpen(false)
    refreshSessions()
  }

  const truncateSession = async index => {
    if (!session) return
    const s = await api.truncateSession(session.id, index)
    setSession(s); setLive(null); setApproval(null); setStats(s.stats || null); setTodos(s.todos || []); setError(null)
    streamingSessionRef.current = null
    refreshSessions()
    return s
  }

  const removeSession = async id => {
    await api.deleteSession(id)
    if (session?.id === id) setSession(null)
    refreshSessions()
  }

  const renameSession = async (id, title) => {
    await api.patchSession(id, { title })
    if (session?.id === id) setSession(prev => ({ ...prev, title }))
    refreshSessions()
  }

  const pinSession = async (id, pinned) => {
    await api.patchSession(id, { pinned })
    refreshSessions()
  }

  const patchSession = async patch => {
    if (!session) return
    const s = await api.patchSession(session.id, patch)
    setSession(prev => ({ ...prev, ...s, messages: prev.messages }))
    refreshSessions()
  }

  const send = async content => {
    if (!session || live?.streaming) return
    // content is { text, attachments } from the composer
    const text = typeof content === 'string' ? content : content.text
    const attachments = (typeof content === 'object' && content.attachments) || []
    let target = session
    if (!target.provider || !target.model) {
      setError('Pick a model first (top right).')
      return
    }
    setError(null)
    setUsage(null)
    const sessionId = target.id
    streamingSessionRef.current = sessionId
    setSession(prev => ({ ...prev, messages: [...prev.messages, { role: 'user', text, attachments }] }))
    const liveMsg = { parts: [], thinking: '', thinkingActive: false, thinkingSecs: 0, streaming: true }
    setLive({ ...liveMsg })

    const endThinking = () => {
      if (liveMsg.thinkingActive) {
        liveMsg.thinkingActive = false
        liveMsg.thinkingSecs = Math.max(1, Math.round((Date.now() - liveMsg.thinkingStartedAt) / 1000))
      }
    }
    const pushText = text => {
      endThinking()
      const last = liveMsg.parts[liveMsg.parts.length - 1]
      if (last?.type === 'text') last.text += text
      else liveMsg.parts.push({ type: 'text', text })
    }

    try {
      await streamChat(sessionId, content, ev => {
        if (streamingSessionRef.current !== sessionId) return
        switch (ev.type) {
          case 'text_delta': pushText(ev.text); break
          case 'thinking_delta':
            if (!liveMsg.thinkingActive && !liveMsg.thinking) liveMsg.thinkingStartedAt = Date.now()
            liveMsg.thinkingActive = true
            liveMsg.thinking += ev.text
            break
          case 'tool_start':
            endThinking()
            if (ev.name === 'todo_write') break // rendered as the checklist, not a chip
            if (ev.name === 'show_widget') { liveMsg.parts.push({ type: 'tool', id: ev.id, name: 'show_widget', widget: ev.args, hidden: true }); break } // rendered as a rich widget
            liveMsg.parts.push({ type: 'tool', id: ev.id, name: ev.name, args: ev.args, pending: true })
            setActivity(a => [...a, { id: ev.id, name: ev.name, args: ev.args, at: Date.now() }])
            setRightOpen(true)
            break
          case 'tool_result': {
            const t = liveMsg.parts.find(p => p.type === 'tool' && p.id === ev.id)
            if (t) { t.result = ev.result; t.pending = false; t.denied = ev.denied }
            setActivity(a => a.map(x => x.id === ev.id ? { ...x, result: ev.result, denied: ev.denied } : x))
            setApproval(null)
            break
          }
          case 'approval_request': setApproval({ id: ev.id, name: ev.name, args: ev.args }); break
          case 'question_request': setQuestion({ id: ev.id, question: ev.question, options: ev.options || [] }); break
          case 'plan_mode': setSession(s => (s && s.id === sessionId ? { ...s, planMode: ev.on } : s)); break
          case 'stats': setStats(ev.stats); break
          case 'agent_turn': {
            // group chat: finalize the previous speaker's message, start the next
            endThinking()
            if (liveMsg.parts.length || liveMsg.thinking) {
              const finished = { role: 'assistant', parts: [...liveMsg.parts], model: target.model, agentId: liveMsg.agentId }
              setSession(prev => (prev && prev.id === sessionId ? { ...prev, messages: [...prev.messages, finished] } : prev))
            }
            liveMsg.parts = []; liveMsg.thinking = ''; liveMsg.thinkingActive = false; liveMsg.thinkingSecs = 0
            liveMsg.agentId = ev.agentId
            break
          }
          case 'usage': setUsage(u => ({ input: ev.input ?? u?.input, output: ev.output ?? u?.output })); break
          case 'notice': liveMsg.parts.push({ type: 'notice', text: ev.text }); break
          case 'todos': setTodos(ev.todos || []); break
          case 'title': setSession(s => (s && s.id === sessionId ? { ...s, title: ev.title } : s)); refreshSessions(); break
          case 'skill_suggested':
            setSkillSuggestion(ev.suggestion)
            api.getConfig().then(setConfig).catch(() => {})
            break
          case 'error': setError(ev.message); break
          default: break
        }
        setLive({ ...liveMsg, parts: [...liveMsg.parts] })
      })
    } catch (e) {
      setError(e.message)
    }

    if (streamingSessionRef.current === sessionId) {
      streamingSessionRef.current = null
      setApproval(null)
      setLive(null)
      try {
        const fresh = await api.getSession(sessionId)
        setSession(prev => (prev && prev.id === sessionId ? fresh : prev))
      } catch {}
      refreshSessions()
    }
  }

  const stop = () => { if (session) api.abort(session.id) }

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = e => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o) }
      else if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession() }
      else if (meta && e.key === ',') { e.preventDefault(); openSettings() }
      else if (e.key === 'Escape' && live?.streaming) { stop() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const answerApproval = async (id, approved) => {
    setApproval(null)
    await api.approve(id, approved)
  }

  if (!config) {
    if (error) return <ConnectGate error={error} />
    return <div className='app'><div style={{ margin: 'auto', color: 'var(--text-muted)' }}>Warming up…</div></div>
  }

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')}>
      <MotionBackground kind={config.settings.motionBg} />
      <div className='nav-backdrop' onClick={() => setNavOpen(false)} />
      <Sidebar
        sessions={sessions}
        activeId={session?.id}
        working={Boolean(live?.streaming)}
        onOpen={id => { openSession(id); setNavOpen(false) }}
        onNew={(...a) => { newSession(...a); setNavOpen(false) }}
        projects={projects}
        projectsError={projectsError}
        onNewProject={newProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onMoveSession={moveSession}
        onNewGroup={() => { setGroupPickerOpen(true); setNavOpen(false) }}
        onCloseNav={() => setNavOpen(false)}
        onDelete={removeSession}
        onRename={renameSession}
        onPin={pinSession}
        agents={config.agents || []}
        onSettings={openSettings}
        mode={config.settings.mode}
        onToggleMode={() => {
          const order = ['light', 'medium', 'dark']
          const next = order[(order.indexOf(config.settings.mode) + 1) % 3] || 'dark'
          saveSettings({ mode: next })
        }}
        updateInfo={updateInfo}
        onUpdate={() => { setNavOpen(false); if (window.radiantNative?.openSettings) window.radiantNative.openSettings('about'); else { setSettingsTab('about'); setSettingsOpen(true) } }}
      />
      <Chat
        rightOpen={rightOpen}
        onToggleRight={() => setRightOpen(o => !o)}
        onMenu={() => setNavOpen(true)}
        onNewGroup={newGroup}
        onTruncate={truncateSession}
        skillSuggestion={skillSuggestion}
        onReviewSkill={() => { setSkillSuggestion(null); setSettingsTab('skills'); setSettingsOpen(true) }}
        onOpenLibrary={() => { setAgentView('library'); setSettingsTab('agents'); setSettingsOpen(true) }}
        onDismissSuggestion={() => setSkillSuggestion(null)}
        recipes={config.recipes || []}
        agents={config.agents || []}
        session={session}
        todos={todos}
        stats={stats}
        live={live}
        approval={approval}
        usage={usage}
        error={error}
        models={models}
        onSend={send}
        onStop={stop}
        onApproval={answerApproval}
        onPickModel={m => patchSession({ provider: m.provider, model: m.id })}
        onToggleTools={() => patchSession({ useTools: !(session.useTools !== false) })}
        onToggleComputer={() => patchSession({ computerControl: !session.computerControl })}
        onTogglePlan={() => patchSession({ planMode: !session.planMode })}
        approvalMode={config.settings.approvalMode || 'ask'}
        onCycleApproval={() => { const order = ['ask', 'auto', 'off']; const cur = config.settings.approvalMode || 'ask'; saveSettings({ approvalMode: order[(order.indexOf(cur) + 1) % 3] }) }}
        question={question}
        onAnswer={answer => { if (question) { api.answerQuestion(question.id, answer).catch(() => {}); setQuestion(null) } }}
        onSetCwd={cwd => patchSession({ cwd })}
        onNew={newSession}
        projects={projects}
        projectsError={projectsError}
        onNewProject={newProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onMoveSession={moveSession}
        onRefreshModels={refreshModels}
      />
      {rightOpen && (
        <RightPanel
          tab={rightTab}
          onTab={setRightTab}
          activity={activity}
          cwd={session?.cwd}
          mode={config.settings.mode}
          onClose={() => setRightOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          agents={config.agents || []}
          models={models}
          session={session}
          onClose={() => setPaletteOpen(false)}
          actions={{
            newSession,
            openSettings,
            openSession,
            compare: () => setCompareOpen(true),
            toggleRight: () => setRightOpen(o => !o),
            toggleMode: () => {
              const order = ['light', 'medium', 'dark']
              saveSettings({ mode: order[(order.indexOf(config.settings.mode) + 1) % 3] || 'dark' })
            },
            pickModel: m => session && patchSession({ provider: m.provider, model: m.id })
          }}
        />
      )}
      {compareOpen && <ComparePanel models={models} onClose={() => setCompareOpen(false)} />}
      {groupPickerOpen && (
        <div className='group-modal-backdrop' onClick={() => setGroupPickerOpen(false)}>
          <div className='group-modal' onClick={e => e.stopPropagation()}>
            <GroupPicker agents={config.agents || []} onStart={ids => { setGroupPickerOpen(false); newGroup(ids) }} onCancel={() => setGroupPickerOpen(false)} />
          </div>
        </div>
      )}
      {settingsOpen && (
        <Settings
          config={config}
          initialTab={settingsTab}
          initialAgentView={agentView}
          onClose={() => { setSettingsOpen(false); setSettingsTab('providers'); setAgentView(null); refreshModels() }}
          onSettings={saveSettings}
          onConfigChange={setConfig}
          onModelsChanged={refreshModels}
        />
      )}
    </div>
  )
}
