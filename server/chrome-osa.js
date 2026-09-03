/**
 * Driving the Chrome the user is actually signed into.
 *
 * ⚠️ CDP CANNOT REACH IT, AND THAT IS PERMANENT. Chrome 136 removed the ability to
 * start the DEFAULT profile with --remote-debugging-port. Measured on Tony's Mac,
 * Chrome 152, 2026-09-03: the flag is on the running Chrome's command line and
 * NOTHING is listening on 9222. It is not an error and there is no warning — the
 * port is simply ignored. So every attach attempt fails, Playwright falls back to
 * LAUNCHING a browser, and the agent gets a stranger's Chrome with no tabs, no
 * extensions and no logins. That is why the agent kept reporting that it could not
 * see the page and blaming macOS permissions: "why cant you get browser/computer
 * control right."
 *
 * AppleScript can reach it, and does today. Verified against his 86 open tabs:
 * window and tab enumeration, the active tab's URL, and `execute javascript`
 * returning "DNS Management" from the GoDaddy tab he had open.
 *
 * ⚠️ ARGUMENTS GO THROUGH argv, NEVER THROUGH STRING CONCATENATION. A page's URL or
 * a snippet of JavaScript embedded into an AppleScript source string is an escaping
 * problem with three nested quoting contexts (shell, AppleScript, JS), and it breaks
 * on the first apostrophe, backslash or newline — which is to say, on real web
 * pages. `osascript -e '…on run argv…' <arg>` with execFile passes them as real
 * arguments, so there is nothing to escape. scripts/test-chrome-osa.mjs feeds it
 * quotes, backslashes, newlines and emoji and requires them back byte-for-byte.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileP = promisify(execFile)

const CHROME = 'Google Chrome'

async function osa (script, args = [], timeout = 20000) {
  const { stdout } = await execFileP('osascript', ['-e', script, ...args.map(String)], { timeout, maxBuffer: 8 * 1024 * 1024 })
  return stdout.replace(/\n$/, '')
}

/** Is the user's Chrome open right now? Never launches it. */
export async function running () {
  try {
    const out = await osa(`tell application "System Events" to return (count of (every process whose name is "${CHROME}")) as string`, [], 5000)
    return Number(out.trim()) > 0
  } catch { return false }
}

/**
 * ⚠️ THE JAVASCRIPT TOGGLE IS OFF BY DEFAULT AND THE ERROR DOES NOT SAY SO.
 * Chrome refuses `execute javascript` unless View › Developer › Allow JavaScript
 * from Apple Events is ticked, and the failure surfaces as a bare AppleScript error
 * number. Any caller that gets this back can tell the user the one thing they need
 * to do, instead of guessing at permissions — which is exactly what happened.
 */
const JS_BLOCKED = /Executing JavaScript through AppleScript is turned off|not allowed|-1743|-2700/i
function jsError (e) {
  const m = String(e?.stderr || e?.message || '')
  if (JS_BLOCKED.test(m)) {
    const err = new Error('Chrome is not allowing JavaScript from Apple Events. In Chrome: View › Developer › Allow JavaScript from Apple Events. Then ask me again.')
    err.code = 'js-blocked'
    return err
  }
  if (/not authori[sz]ed|1743/.test(m)) {
    const err = new Error('macOS has not granted Radiant permission to control Chrome. System Settings › Privacy & Security › Automation › Radiant › Google Chrome.')
    err.code = 'automation-denied'
    return err
  }
  return e
}

/** Every window and tab, so the agent can talk about the page you mean. */
export async function tabs () {
  // ⚠️ NOT `tab` AS A SEPARATOR. Inside `tell application "Google Chrome"`, `tab` is
  // Chrome's TAB CLASS, not the tab character — so the delimiter silently evaluated
  // to nothing and every field came back empty (87 rows of NaN and blanks). Ask for
  // the character by id instead, which no application dictionary can redefine.
  const out = await osa(`tell application "${CHROME}"
    set d to character id 9
    set out to ""
    set wi to 0
    repeat with w in windows
      set wi to wi + 1
      set ti to 0
      repeat with t in tabs of w
        set ti to ti + 1
        set out to out & wi & d & ti & d & (title of t) & d & (URL of t) & linefeed
      end repeat
    end repeat
    return out
  end tell`)
  return out.split('\n').filter(Boolean).map(line => {
    const [w, t, title, url] = line.split('\t')
    return { window: Number(w), tab: Number(t), title: title || '', url: url || '' }
  })
}

export async function activeTab () {
  const out = await osa(`tell application "${CHROME}" to return (URL of active tab of front window) & linefeed & (title of active tab of front window)`)
  const [url, ...rest] = out.split('\n')
  return { url, title: rest.join('\n') }
}

/** Run JavaScript in the active tab and return whatever it evaluates to, as text. */
export async function evaluate (js) {
  try {
    return await osa(`on run argv
      tell application "${CHROME}" to return (execute active tab of front window javascript (item 1 of argv)) as string
    end run`, [js])
  } catch (e) { throw jsError(e) }
}

export async function navigate (url) {
  const target = /^https?:\/\//i.test(url) ? url : 'https://' + url
  await osa(`on run argv
    tell application "${CHROME}"
      activate
      if (count of windows) is 0 then make new window
      set URL of active tab of front window to (item 1 of argv)
    end tell
  end run`, [target])
  // Give the load a moment, then report where we actually ended up — a redirect,
  // a login wall or a 404 is exactly what the caller needs to know about.
  await new Promise(r => setTimeout(r, 1200))
  return activeTab()
}

export async function readText (limit = 12000) {
  const text = await evaluate(`document.body ? document.body.innerText.slice(0, ${Number(limit) || 12000}) : ''`)
  const where = await activeTab()
  return { ...where, text, via: 'applescript' }
}

/** Focus a tab by its number from tabs(), so "the GoDaddy one" can be acted on. */
export async function selectTab (windowIndex, tabIndex) {
  await osa(`on run argv
    tell application "${CHROME}"
      activate
      set w to window (item 1 of argv as integer)
      set index of w to 1
      set active tab index of w to (item 2 of argv as integer)
    end tell
  end run`, [windowIndex, tabIndex])
  return activeTab()
}
