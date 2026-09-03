/**
 * Radiant's bridge into the browser you are actually signed into.
 *
 * ⚠️ THIS EXISTS BECAUSE CHROME CLOSED THE OTHER DOOR ON PURPOSE. Chrome 136
 * removed --remote-debugging-port for the default profile, because one flag let any
 * program on the machine read every logged-in session in the browser. That was
 * being used to steal cookies, so it is a security fix and it is not coming back.
 * An extension is the sanctioned way in: it runs INSIDE Chrome with the user's own
 * session, and the authorisation is the user installing it rather than a hole
 * punched in the browser.
 *
 * ⚠️ THE EXTENSION DIALS OUT; RADIANT NEVER DIALS IN. A service worker cannot
 * listen for connections, and Radiant must not be able to reach into a browser that
 * did not ask for it. So this connects to Radiant on loopback and Radiant answers
 * requests on that socket. Unplugging is uninstalling — or just quitting Radiant.
 *
 * ⚠️ AND IT MUST SURVIVE THE SERVICE WORKER BEING KILLED. MV3 shuts an idle worker
 * down after ~30 seconds, which closes the socket with it. A chrome.alarms tick
 * wakes it and reconnects; that is why the alarm exists and why it must not be
 * removed as "unused".
 */
// ⚠️ RADIANT MOVES IF ITS PORT IS TAKEN. server/index.js falls back to a random
// free port when 5834 is busy, and a service worker cannot read a file to find out
// where it went — so a handful of likely ports are tried and Settings says plainly
// when nothing answered. 5934 is the documented alternate.
const DEFAULT_PORTS = [5834, 5934, 5835, 5836, 5837]
let sock = null
let connectedPort = null

function log (...a) { console.log('[radiant]', ...a) }

function connect () {
  if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return
  const ports = DEFAULT_PORTS
  let i = 0
  const tryNext = () => {
    if (i >= ports.length) return
    const port = ports[i++]
    let ws
    try { ws = new WebSocket(`ws://127.0.0.1:${port}/ws/extension`) } catch { return tryNext() }
    ws.onopen = () => {
      sock = ws; connectedPort = port
      chrome.action.setBadgeText({ text: 'on' })
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' })
      log('connected on', port)
    }
    ws.onclose = () => {
      if (sock === ws) { sock = null; connectedPort = null; chrome.action.setBadgeText({ text: '' }) }
      tryNext()
    }
    ws.onerror = () => { try { ws.close() } catch {} }
    ws.onmessage = async ev => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      const reply = r => { try { ws.send(JSON.stringify({ id: msg.id, ...r })) } catch {} }
      try { reply({ ok: true, result: await handle(msg.op, msg.args || {}) }) }
      catch (e) { reply({ ok: false, error: String(e && e.message || e) }) }
    }
  }
  tryNext()
}

async function activeTab () {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!t) throw new Error('No active tab.')
  return t
}

// ⚠️ RUN IN THE PAGE, RETURN A VALUE — do not try to send functions or DOM nodes
// back. executeScript serialises the result, so everything here returns plain data.
async function inPage (tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return res?.result
}

async function handle (op, a) {
  switch (op) {
    case 'ping': return { ok: true, version: chrome.runtime.getManifest().version }

    case 'tabs': {
      const tabs = await chrome.tabs.query({})
      return tabs.map(t => ({ id: t.id, windowId: t.windowId, index: t.index, active: t.active, title: t.title || '', url: t.url || '' }))
    }

    case 'activeTab': {
      const t = await activeTab()
      return { id: t.id, title: t.title || '', url: t.url || '' }
    }

    case 'selectTab': {
      const t = await chrome.tabs.get(Number(a.tabId))
      await chrome.windows.update(t.windowId, { focused: true })
      await chrome.tabs.update(t.id, { active: true })
      return { id: t.id, title: t.title || '', url: t.url || '' }
    }

    case 'navigate': {
      const t = a.tabId ? await chrome.tabs.get(Number(a.tabId)) : await activeTab()
      const url = /^https?:\/\//i.test(a.url) ? a.url : 'https://' + a.url
      await chrome.tabs.update(t.id, { url })
      await waitForLoad(t.id)
      const fresh = await chrome.tabs.get(t.id)
      return { id: fresh.id, title: fresh.title || '', url: fresh.url || '' }
    }

    case 'readText': {
      const t = a.tabId ? await chrome.tabs.get(Number(a.tabId)) : await activeTab()
      const limit = Number(a.limit) || 12000
      const text = await inPage(t.id, n => (document.body ? document.body.innerText.slice(0, n) : ''), [limit])
      return { id: t.id, title: t.title || '', url: t.url || '', text: text || '' }
    }

    case 'screenshot': {
      const t = a.tabId ? await chrome.tabs.get(Number(a.tabId)) : await activeTab()
      await chrome.windows.update(t.windowId, { focused: true })
      await chrome.tabs.update(t.id, { active: true })
      const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' })
      return { dataB64: dataUrl.replace(/^data:image\/png;base64,/, ''), mime: 'image/png' }
    }

    case 'click': {
      const t = a.tabId ? await chrome.tabs.get(Number(a.tabId)) : await activeTab()
      return await inPage(t.id, (sel, text) => {
        const el = sel
          ? document.querySelector(sel)
          : [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[role=link],[onclick]')]
              .find(e => ((e.innerText || e.value || '').trim().toLowerCase()).includes(String(text).toLowerCase()))
        if (!el) return { found: false }
        el.scrollIntoView({ block: 'center' })
        el.click()
        return { found: true, what: (el.innerText || el.value || el.tagName || '').trim().slice(0, 80) }
      }, [a.selector || null, a.text || ''])
    }

    case 'type': {
      const t = a.tabId ? await chrome.tabs.get(Number(a.tabId)) : await activeTab()
      return await inPage(t.id, (sel, value, submit) => {
        const el = sel ? document.querySelector(sel) : document.activeElement
        if (!el) return { ok: false, why: 'nothing focused and no selector given' }
        el.focus()
        // ⚠️ SET THE VALUE THE WAY REACT SEES IT. Assigning .value directly leaves
        // React's own state stale, so the page looks filled in and submits empty —
        // which is worse than not typing at all.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, value); else el.value = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        if (submit) el.form?.requestSubmit?.()
        return { ok: true, into: el.name || el.id || el.tagName }
      }, [a.selector || null, String(a.text ?? ''), Boolean(a.submit)])
    }

    case 'evaluate': {
      const t = a.tabId ? await chrome.tabs.get(Number(a.tabId)) : await activeTab()
      // ⚠️ NEW Function, NOT eval OF A STRING WE BUILT. The expression arrives as an
      // argument and is compiled inside the page, so nothing is spliced into source
      // text here and there is no quoting to get wrong.
      return await inPage(t.id, src => {
        try { return { ok: true, value: String(new Function('return (' + src + ')')()) } }
        catch (e) { return { ok: false, error: String(e.message || e) } }
      }, [String(a.js || 'null')])
    }

    default: throw new Error(`Unknown op: ${op}`)
  }
}

function waitForLoad (tabId, ms = 15000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(timer); setTimeout(resolve, 400) }
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done() }
    const timer = setTimeout(done, ms)
    chrome.tabs.onUpdated.addListener(fn)
  })
}

// The popup asks what the worker knows; the worker is the only thing that has a
// socket, so it is the only thing that can answer.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.op === 'status') {
    reply({ connected: Boolean(sock && sock.readyState === WebSocket.OPEN), port: connectedPort })
    return true
  }
})

chrome.runtime.onInstalled.addListener(connect)
chrome.runtime.onStartup.addListener(connect)
chrome.alarms.create('radiant-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(connect)
connect()
