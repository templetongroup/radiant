/**
 * ChatScreen — the shell's adapter around MobileChat.
 *
 * MobileChat owns the transcript, the token stream and its own chrome (the
 * two-line title, the composer, the menu), so the shell renders it bare: the
 * chat route is the one screen that does not get a shell nav bar, because a
 * pinned composer cannot live inside somebody else's scroll view.
 *
 * What is left for this file is what the shell, not the transcript, has an
 * opinion about: WHICH conversation this is, where it is persisted, and what
 * Back means.
 *
 * ⚠️ IT USED TO KEEP EXACTLY ONE. A single `rx.chat.transcript` key, overwritten
 * by whatever you were last saying, with no id, no title and no way back to
 * anything earlier. Nothing was lost between launches — but there was no
 * history, so "your chats" could not exist and the app had nowhere to be a home.
 * Conversations are keyed by id now, in chats.js. The old single transcript is
 * migrated on first run rather than dropped.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import MobileChat from './MobileChat.jsx'
import { loadChat, saveChat, deleteChat, newChatId, listChats } from './chats.js'

const LEGACY_KEY = 'rx.chat.transcript'

/** The one conversation the old build kept, brought across once. */
function migrateLegacy () {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const msgs = JSON.parse(raw)
    if (!Array.isArray(msgs) || !msgs.length) { localStorage.removeItem(LEGACY_KEY); return null }
    const id = newChatId()
    saveChat({ id, messages: msgs, modelId: null, modelName: null })
    localStorage.removeItem(LEGACY_KEY)
    return id
  } catch { return null }
}

export default function ChatScreen ({ nav, model, onModelInfo, chatId, downloadedModels, onSwitchModel }) {
  // A chat route always resolves to an id: the one it was opened with, the most
  // recent, a migrated legacy transcript, or a fresh one.
  const [id] = useState(() => {
    if (chatId) return chatId
    const migrated = migrateLegacy()
    if (migrated) return migrated
    return listChats()[0]?.id || newChatId()
  })

  const [initial] = useState(() => loadChat(id)?.messages || [])
  const [nonce, setNonce] = useState(0)
  // The skill this conversation is using, restored with the conversation.
  const [skillId, setSkillId] = useState(() => loadChat(id)?.skillId || null)

  const onMessagesChange = useCallback((messages) => {
    saveChat({ id, messages, modelId: model?.id || null, modelName: model?.name || null, skillId })
  }, [id, model, skillId])

  // Changing the skill has to persist even before the next message is sent,
  // or picking one and leaving would lose it.
  const onSkillChange = useCallback((next) => {
    setSkillId(next)
    const cur = loadChat(id)
    if (cur?.messages?.length) {
      saveChat({ id, messages: cur.messages, modelId: cur.modelId, modelName: cur.modelName, skillId: next })
    }
  }, [id])

  const onDeleteConversation = useCallback(() => {
    deleteChat(id)
    setNonce(n => n + 1)
  }, [id])

  // The shell's ellipsis menu is a fallback for the bar it does not draw here;
  // both "delete" and "new" mean "start again from empty".
  useEffect(() => {
    const onMenu = (e) => {
      if (e?.detail?.action === 'delete' || e?.detail?.action === 'new') onDeleteConversation()
    }
    window.addEventListener('rx:chat-menu', onMenu)
    return () => window.removeEventListener('rx:chat-menu', onMenu)
  }, [onDeleteConversation])

  const back = useMemo(() => () => nav?.pop?.(), [nav])

  return (
    <MobileChat
      key={nonce}
      model={model}
      onBack={back}
      onModelInfo={onModelInfo}
      downloadedModels={downloadedModels}
      onSwitchModel={onSwitchModel}
      initialMessages={nonce === 0 ? initial : []}
      onMessagesChange={onMessagesChange}
      onDeleteConversation={onDeleteConversation}
      skillId={skillId}
      onSkillChange={onSkillChange}
      // ⚠️ A LIBRARY YOU CANNOT REACH FROM WHERE YOU USE IT. Skills lived only
      // under Settings → Skills, three taps from the composer that applies
      // them, and Tony went looking and reported the phone had no way to add
      // one at all. The picker is where you find out you want a different
      // skill, so the way to write one belongs in the picker.
      onManageSkills={() => nav.push('skills', {})}
    />
  )
}

export { ChatScreen }
