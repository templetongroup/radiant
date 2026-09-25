/**
 * The native SwiftUI preview (NativePreview.swift): open it with this phone's
 * conversations, and keep this store in step with what happens there.
 *
 * ⚠️ THE WEB STORE STAYS THE ONLY STORE. The preview gets a copy when it opens
 * and reports every change back as it happens, so closing it — or the app —
 * loses nothing, and the web home already shows the result.
 */
import { allChats, saveFromNative, deleteChat, setArchived } from './chats.js'

const ACTIVE_MODEL_KEY = 'rx.activeModel'   // MobileShell.jsx
let listening = false

const plugin = () => (typeof window !== 'undefined' ? window.Capacitor?.Plugins?.NativePreview : null)

export const nativePreviewAvailable = () => Boolean(plugin()?.open)

export function openNativePreview () {
  const np = plugin()
  if (!np?.open) return
  if (!listening) {
    listening = true
    np.addListener('saved', e => { if (e?.chat) saveFromNative(e.chat) })
    np.addListener('deleted', e => { if (e?.id) deleteChat(e.id) })
    np.addListener('archived', e => { if (e?.id) setArchived(e.id, true) })
  }
  let current = null
  try { current = localStorage.getItem(ACTIVE_MODEL_KEY) } catch { /* private mode */ }
  np.open({ chats: allChats().filter(c => !c.archived), currentModelId: current }).catch(() => {})
}
