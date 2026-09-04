/**
 * The other end of the Radiant browser extension.
 *
 * ⚠️ THE EXTENSION DIALS OUT AND WE ANSWER. A service worker cannot listen, and
 * Radiant should not be able to reach into a browser that never asked for it. So
 * the socket is opened by the extension, on loopback, and every request travels
 * back down the connection it arrived on. Closing Chrome, or uninstalling, unplugs
 * it — there is nothing to revoke.
 *
 * ⚠️ EVERY REQUEST CARRIES AN ID AND A DEADLINE. One socket multiplexes all the
 * tools, so replies must be matched to their callers rather than assumed to arrive
 * in order; and a page that never finishes loading must not hang the turn forever
 * with no explanation — the exact shape of failure this app has shipped repeatedly.
 * Timeouts reject with a sentence a person can act on.
 */
let socket = null
let seq = 0
const pending = new Map()   // id -> { resolve, reject, timer }

export function extensionConnected () {
  return Boolean(socket && socket.readyState === 1)
}

export function attachExtension (ws) {
  // Only one browser at a time. A second connection replaces the first rather than
  // racing it — two half-connected browsers is a worse state than one.
  if (socket && socket !== ws) { try { socket.close() } catch {} }
  socket = ws
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error || 'The browser extension could not do that.'))
  })
  const drop = () => {
    if (socket === ws) socket = null
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('The Radiant browser extension disconnected mid-request.'))
      pending.delete(id)
    }
  }
  ws.on('close', drop)
  ws.on('error', drop)
}

export function callExtension (op, args = {}, timeout = 20000) {
  if (!extensionConnected()) {
    return Promise.reject(new Error('The Radiant browser extension is not connected. Open Chrome, or install it from Settings › Computer control.'))
  }
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The browser did not answer "${op}" within ${Math.round(timeout / 1000)}s. The page may still be loading, or waiting on you.`))
    }, timeout)
    pending.set(id, { resolve, reject, timer })
    try { socket.send(JSON.stringify({ id, op, args })) }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e) }
  })
}

// The operations, named the same as the tools that use them.
export const ext = {
  tabs: () => callExtension('tabs'),
  activeTab: () => callExtension('activeTab'),
  selectTab: tabId => callExtension('selectTab', { tabId }),
  navigate: (url, tabId) => callExtension('navigate', { url, tabId }, 30000),
  readText: (limit, tabId) => callExtension('readText', { limit, tabId }),
  screenshot: tabId => callExtension('screenshot', { tabId }),
  click: ({ text, selector, tabId }) => callExtension('click', { text, selector, tabId }),
  type: ({ text, selector, submit, tabId }) => callExtension('type', { text, selector, submit, tabId })
  // No evaluate: the extension executes only its own bundled functions. See sw.js.
}
