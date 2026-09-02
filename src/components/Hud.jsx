import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

/**
 * The HUD — a small window that floats above whatever you are working in and
 * says what your agents are doing.
 *
 * ⚠️ IT SHOWS ONLY WHAT IS HAPPENING NOW. A HUD that lists everything is a
 * second sidebar, and you would stop looking at it. Working tasks and anything
 * blocked; nothing else. When there is neither, it says so in one line rather
 * than drawing an empty frame.
 *
 * ⚠️ AND IT READS THE SAME STATE THE BOARD DOES. Card state is set by the run
 * itself (server-side, from the events a turn emits), so the HUD cannot claim
 * progress the board would disagree with — there is one source, polled twice.
 */

// Blocked first, always. It is the only row where nothing happens until you act,
// which is the entire reason to keep a window above your other apps.
const ORDER = { blocked: 0, working: 1 }

function timeAgo (iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export default function Hud () {
  const [rows, setRows] = useState([])
  const [err, setErr] = useState(null)

  const refresh = useCallback(async () => {
    try {
      // ⚠️ A RUNNING CHAT IS RUNNING. The HUD asked only for board tasks, so an
      // agent streaming in a chat — the most common thing anyone has running —
      // showed as "Nothing running." Tony, with a turn mid-flight on screen:
      // "HUD mode shows nothing running even though there clearly is."
      // /api/sessions already flags which sessions have a live turn; nothing new
      // is needed on the server, the HUD simply never asked.
      const [tasks, sessions] = await Promise.all([api.listTasks(), api.listSessions()])
      const chats = sessions
        .filter(s => s.active)
        .map(s => ({
          id: 'chat-' + s.id,
          sessionId: s.id,
          title: s.title || 'Chat',
          state: 'working',
          isChat: true,
          agentId: s.agentId,
          model: s.model,
          updatedAt: s.updatedAt
        }))
      const board = tasks.filter(t => t.state === 'working' || t.state === 'blocked')
      setRows(
        [...board, ...chats]
          .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      )
      setErr(null)
    } catch (e) {
      // A HUD that silently freezes is worse than one that says it lost contact:
      // an empty panel reads as "nothing running", which is a claim.
      setErr(e.message || 'Cannot reach Radiant')
    }
  }, [])

  useEffect(() => {
    refresh()
    // Two seconds, not five. This window exists to be glanced at, and the board's
    // slower poll is fine because you are looking straight at it when you use it.
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const open = task => {
    // The HUD never opens a chat itself — it asks the main window to, which is
    // the window that owns conversations.
    window.radiantNative?.hudOpenTask?.(task.sessionId || null)
  }

  return (
    <div className='hud'>
      <header className='hud-head'>
        <span className='hud-title'>Radiant</span>
        <span className='hud-count'>{rows.length ? `${rows.length} running` : ''}</span>
      </header>

      <div className='hud-body'>
        {err && <div className='hud-err'>{err}</div>}

        {!err && rows.length === 0 && (
          <div className='hud-idle'>Nothing running.</div>
        )}

        {rows.map(t => (
          <button
            key={t.id}
            className={'hud-row' + (t.state === 'blocked' ? ' is-blocked' : '')}
            onClick={() => open(t)}
            title={t.state === 'blocked' ? 'Waiting on you — click to answer' : 'Click to open'}
          >
            <span className='hud-dot' aria-hidden />
            <span className='hud-row-main'>
              <span className='hud-row-title'>{t.title}</span>
              <span className='hud-row-sub'>
                {t.state === 'blocked'
                  ? (t.lastError || 'Needs you')
                  : t.isChat
                    ? (t.model || 'chat')
                    : (t.agentId ? 'agent' : (t.model || 'working'))}
              </span>
            </span>
            <span className='hud-row-time'>{timeAgo(t.updatedAt || t.createdAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
