import { desktop, screenshot as screenScreenshot, screenSize, helperAvailable, permissions } from './computer.js'
import { web, browserAvailable } from './browser.js'

// Two control surfaces the agent can drive when "computer control" is enabled:
// the whole desktop (screen_*) and an automated browser (browser_*). Tools that
// capture a view return an image so a vision model can see the result.

export const COMPUTER_TOOL_DEFS = [
  // ---- browser ----
  { name: 'browser_navigate', description: 'Open a URL in the controlled browser. Returns a screenshot of the page.', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_screenshot', description: 'Take a screenshot of the current browser page.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'browser_click', description: 'Click in the browser at pixel coordinates from the latest browser screenshot (1280x800 space).', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'browser_type', description: 'Type text into the focused element in the browser.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'browser_key', description: 'Press a key or combo in the browser, e.g. "Enter", "cmd+a".', input_schema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'browser_scroll', description: 'Scroll the browser page vertically. Positive dy scrolls up, negative down.', input_schema: { type: 'object', properties: { dy: { type: 'number' } }, required: ['dy'] } },
  { name: 'browser_read', description: 'Get the visible text of the current browser page.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'browser_network', description: 'List the XHR/fetch JSON API calls the current site has made — its hidden API. Use it AFTER performing an action in the browser (search, load more, submit) to see the underlying requests (method, URL, headers, body, response sample), then recreate them as a plain HTTP client. Sensitive header values (cookies, tokens) are shown as present-but-hidden. Optional filter matches the URL.', input_schema: { type: 'object', properties: { filter: { type: 'string', description: 'Only calls whose URL contains this substring (optional).' } }, required: [] } },
  // ---- desktop ----
  { name: 'screen_screenshot', description: 'Screenshot the whole Mac desktop. Coordinates for clicks are in this image space.', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'screen_click', description: 'Click on the desktop at coordinates from the latest screen screenshot.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] } }, required: ['x', 'y'] } },
  { name: 'screen_doubleclick', description: 'Double-click on the desktop.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'screen_move', description: 'Move the mouse on the desktop without clicking.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'screen_drag', description: 'Press and drag on the desktop from one point to another.', input_schema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'screen_type', description: 'Type text on the desktop (into the focused app).', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'screen_key', description: 'Press a key or combo on the desktop, e.g. "return", "cmd+c".', input_schema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'screen_scroll', description: 'Scroll on the desktop at a point. Positive dy scrolls up.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' } }, required: ['dy'] } }
]

export const COMPUTER_TOOL_NAMES = new Set(COMPUTER_TOOL_DEFS.map(t => t.name))

// mutating actions ask for approval; pure views (screenshots/read) don't
export const COMPUTER_SAFE = new Set(['browser_screenshot', 'browser_read', 'browser_network', 'screen_screenshot', 'screen_move'])
const SENSITIVE_HDR = /^(cookie|authorization|x-csrf-token|x-xsrf-token|x-api-key|set-cookie)$/i
const NOISE_HDR = /^(host|connection|content-length|accept-encoding|user-agent|sec-|:)/i

export async function runComputerTool (name, input) {
  try {
    switch (name) {
      case 'browser_navigate': { const r = await web.navigate(input.url); const img = await web.screenshot(); return { content: `Opened ${r.url} — "${r.title}"`, image: img } }
      case 'browser_screenshot': { const img = await web.screenshot(); return { content: 'Browser screenshot.', image: img } }
      case 'browser_click': { await web.click(input.x, input.y); const img = await web.screenshot(); return { content: `Clicked (${input.x}, ${input.y}).`, image: img } }
      case 'browser_type': { await web.type(input.text); const img = await web.screenshot(); return { content: `Typed ${input.text.length} chars.`, image: img } }
      case 'browser_key': { await web.key(input.keys); const img = await web.screenshot(); return { content: `Pressed ${input.keys}.`, image: img } }
      case 'browser_scroll': { await web.scroll(input.dy); const img = await web.screenshot(); return { content: 'Scrolled.', image: img } }
      case 'browser_read': { const r = await web.readText(); return { content: `${r.title} (${r.url})\n\n${r.text}` } }
      case 'browser_network': {
        const calls = await web.getNetwork(input.filter)
        if (!calls.length) return { content: 'No JSON/API (XHR/fetch) calls captured yet. Navigate to the site and perform the action (search, load, submit) first, then call browser_network again.' }
        const fmt = calls.map((c, i) => {
          const hdrs = Object.entries(c.headers || {}).filter(([k]) => !NOISE_HDR.test(k)).map(([k, v]) => `    ${k}: ${SENSITIVE_HDR.test(k) ? '[present — sensitive; the request needs it, keep it out of shared code]' : v}`).join('\n')
          return `[${i + 1}] ${c.method} ${c.url}\n  ${c.status} · ${c.contentType}\n  headers:\n${hdrs}${c.postData ? `\n  request body: ${c.postData}` : ''}${c.responseSample ? `\n  response sample: ${c.responseSample}` : ''}`
        }).join('\n\n')
        return { content: `Captured ${calls.length} API call(s), newest first:\n\n${fmt}` }
      }

      case 'screen_screenshot': { const img = await screenScreenshot(); const s = await screenSize(); return { content: `Desktop screenshot (${s.width}x${s.height}).`, image: img } }
      case 'screen_click': { await desktop.click(input.x, input.y, input.button); const img = await screenScreenshot(); return { content: `Clicked (${input.x}, ${input.y}).`, image: img } }
      case 'screen_doubleclick': { await desktop.doubleClick(input.x, input.y); const img = await screenScreenshot(); return { content: `Double-clicked (${input.x}, ${input.y}).`, image: img } }
      case 'screen_move': { await desktop.move(input.x, input.y); return { content: `Moved to (${input.x}, ${input.y}).` } }
      case 'screen_drag': { await desktop.drag(input.x1, input.y1, input.x2, input.y2); const img = await screenScreenshot(); return { content: 'Dragged.', image: img } }
      case 'screen_type': { await desktop.type(input.text); const img = await screenScreenshot(); return { content: `Typed ${input.text.length} chars.`, image: img } }
      case 'screen_key': { await desktop.key(input.keys); const img = await screenScreenshot(); return { content: `Pressed ${input.keys}.`, image: img } }
      case 'screen_scroll': { await desktop.scroll(input.x || 0, input.y || 0, input.dy); const img = await screenScreenshot(); return { content: 'Scrolled.', image: img } }
      default: return { content: `Unknown tool ${name}` }
    }
  } catch (e) {
    // surface the common macOS permission failure clearly
    const msg = /could not create image|not authorized|not permitted/i.test(e.message)
      ? `${e.message} — grant Screen Recording (screenshots) and Accessibility (clicks/keys) to Radiant in System Settings → Privacy & Security.`
      : e.message
    return { content: `Error: ${msg}` }
  }
}

export async function computerStatus () {
  // ⚠️ `desktop` MEANS "macOS WILL LET US", not "the binary is present". The old
  // version answered the second question and the UI printed it as the first.
  const p = await permissions()
  return {
    desktop: p.helper && p.screenRecording !== false && p.accessibility !== false,
    browser: await browserAvailable(),
    ...p
  }
}
