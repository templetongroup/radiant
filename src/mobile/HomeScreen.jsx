/**
 * Home — somewhere to arrive, not a list of files to manage.
 *
 * The app used to open onto Models: a catalogue of things to install. Tony:
 * "I feel like theres no Home Screen on this app. it feels wrong." He was
 * right. Nothing greeted you, nothing showed what you had been doing, and
 * starting a conversation meant going through an inventory screen first.
 *
 * So: who you are talking to, what you were saying, and one obvious way on.
 * Models moved to where model management belongs — a screen you visit when you
 * want to change something, not the front door.
 */
import React, { useCallback, useEffect, useState } from 'react'
import usePress from './usePress.js'
import { BrandMark } from './BrandSpinner.jsx'
import wordUrl from '../assets/brand/radiant-wordmark.png'
import { listChats, deleteChat, whenLabel, onChatsChanged } from './chats.js'

/** Time of day, because a greeting that never changes stops being one. */
function greeting () {
  const h = new Date().getHours()
  if (h < 5) return 'Still up'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function ChatRow ({ chat, onOpen, onRemove }) {
  const row = usePress(() => onOpen(chat.id), {
    label: `${chat.title}, ${whenLabel(chat.updatedAt)}${chat.modelName ? `, ${chat.modelName}` : ''}`
  })
  // Deleting is its own labelled control, never the row — the same rule the
  // review forced on Settings after a one-tap delete shipped there.
  const del = usePress(() => onRemove(chat), {
    label: `Delete ${chat.title}`, haptic: 'MEDIUM'
  })
  return (
    <div className={'rx-row rx-row-2line rx-row-compact' + row.className} {...row.handlers}>
      <div className="rx-row-text">
        <div className="rx-headline">{chat.title}</div>
        <div className="rx-row-blurb">
          {whenLabel(chat.updatedAt)}
          {chat.modelName ? ` · ${chat.modelName}` : ''}
        </div>
      </div>
      <span className={'rx-row-remove' + del.className} {...del.handlers}>Delete</span>
    </div>
  )
}

export default function HomeScreen ({
  activeModel, models = [], isTop, onStartChat, onOpenChat, onChooseModel
}) {
  const [chats, setChats] = useState(() => listChats())
  const refresh = useCallback(() => setChats(listChats()), [])

  // The store tells us the moment a conversation is written, so this does not
  // depend on a pop animation finishing or on this screen remounting — neither
  // of which happens when you come back from a chat.
  useEffect(() => onChatsChanged(refresh), [refresh])

  // and belt-and-braces: re-read whenever this screen is on top again
  useEffect(() => { if (isTop) refresh() }, [isTop, refresh])

  // and when the whole app comes back from the background
  useEffect(() => {
    const onVis = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh])

  const remove = useCallback((chat) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete “${chat.title}”?`)) return
    deleteChat(chat.id)
    refresh()
  }, [refresh])

  const start = usePress(() => onStartChat?.(), {
    label: activeModel ? `New chat with ${activeModel.name}` : 'Choose a model to start',
    disabled: !activeModel
  })
  const choose = usePress(() => onChooseModel?.(), { label: 'Models' })

  const downloaded = models.filter(m => m?.downloaded)

  return (
    <>
      {/* The lockup IS the header — which is why the route carries no large
          title: "Radiant" set in the nav bar above a RADIANT wordmark would be
          the name twice. The model card that used to sit here is gone; the
          model is named on the button that uses it. */}
      <div className="rx-home-head">
        <span className="rx-home-mark"><BrandMark size={72} /></span>
        <span
          className="rx-home-word"
          role="img"
          aria-label="Radiant"
          style={{
            WebkitMask: `url(${wordUrl}) center / contain no-repeat`,
            mask: `url(${wordUrl}) center / contain no-repeat`
          }}
        />
        <p className="rx-home-greeting">{greeting()}</p>
        {!activeModel && (
          <p className="rx-home-empty">
            No model on this iPhone yet.
            {/* Its own line: the first sentence is the state, the second is
                what to do about it, and running them together made one long
                wrap that read as neither. */}
            <span className="rx-home-empty-2">Choose one and it runs here, offline.</span>
          </p>
        )}
      </div>

      <div className="rx-home-actions">
        <button type="button" className={'rx-intro-cta' + start.className} {...start.handlers}>
          New chat
        </button>
        <button type="button" className={'rx-intro-second' + choose.className} {...choose.handlers}>
          {downloaded.length ? 'Models' : 'Choose a model'}
        </button>
      </div>

      {/* Under the buttons rather than in one: the label stays "New chat" and
          this line carries the state. It is aria-hidden because the button's
          own accessible name already says which model it will use — a screen
          reader hearing the model twice on one action is noise. */}
      {activeModel && (
        <p className="rx-home-current" aria-hidden="true">
          Current model: <span className="rx-home-current-name">{activeModel.name}</span>
        </p>
      )}

      {chats.length > 0 && (
        <>
          <h2 className="rx-section-header">Recent Sessions</h2>
          <div className="rx-group">
            {chats.map(c => (
              <ChatRow key={c.id} chat={c} onOpen={onOpenChat} onRemove={remove} />
            ))}
          </div>
        </>
      )}

      {/* The byline the first-run screen carries, kept at the foot of Home —
          once the intro stops appearing, Home is the only screen anyone sees
          on launch, and it was the only place the product said whose it is. */}
      <p className="rx-home-byline">
        Radiant is a Templeton&nbsp;Technologies product.
      </p>
    </>
  )
}

export { HomeScreen }
