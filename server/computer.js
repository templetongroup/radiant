import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// the compiled Swift helper; in the packaged app it's unpacked next to server/
function helperPath () {
  const candidates = [
    path.join(__dirname, '..', 'native', 'radiant-control'),
    path.join(process.resourcesPath || '', 'native', 'radiant-control')
  ]
  return candidates.find(p => { try { return fs.existsSync(p) } catch { return false } }) || candidates[0]
}

/**
 * What macOS actually allows, asked of macOS.
 *
 * ⚠️ THE STATUS USED TO BE `helperAvailable()` — a check that this binary exists on
 * disk — presented in Settings as "Screen Recording and Accessibility are granted
 * — ready to use". It never asked about permissions at all. So the screen said
 * everything was fine while screencapture returned a wallpaper-only image (exit 0,
 * no error) and CGEvents went nowhere, and an agent handed the same lie invented
 * tccutil commands for a bundle id that does not exist.
 *
 * Both underlying calls are read-only and never prompt, so this is safe to poll.
 */
export async function permissions () {
  if (!helperAvailable()) return { helper: false, screenRecording: false, accessibility: false }
  try {
    const out = await execFileP(helperPath(), ['permissions'], { timeout: 5000 })
    const j = JSON.parse(out.stdout.trim())
    return { helper: true, screenRecording: Boolean(j.screenRecording), accessibility: Boolean(j.accessibility) }
  } catch {
    // An older helper has no `permissions` command. Say we do not know rather than
    // claiming either answer.
    return { helper: true, screenRecording: null, accessibility: null }
  }
}

export function helperAvailable () {
  try { return fs.existsSync(helperPath()) } catch { return false }
}

let ensuredExec = false
function ensureExecutable () {
  if (ensuredExec) return
  try { fs.chmodSync(helperPath(), 0o755) } catch {}
  ensuredExec = true
}

async function ctl (...args) {
  ensureExecutable() // packaging can strip the exec bit off the bundled helper
  const { stdout } = await execFileP(helperPath(), args.map(String), { timeout: 15000 })
  return stdout.trim()
}

// logical screen size in points — the coordinate space for clicks/screenshots
let cachedSize = null
export async function screenSize () {
  if (cachedSize) return cachedSize
  const out = await ctl('screensize')
  const [w, h] = out.split(/\s+/).map(Number)
  cachedSize = { width: w, height: h }
  return cachedSize
}

// capture the main display, normalized to point size, returned as base64 png.
// screencapture yields Retina pixels; we downscale to points so the model's
// click coordinates map 1:1 onto CGEvent points.
export async function screenshot () {
  const { width } = await screenSize()
  const tmp = path.join(os.tmpdir(), `radiant-shot-${process.pid}.png`)
  await execFileP('screencapture', ['-x', '-t', 'png', tmp], { timeout: 15000 })
  // downscale to logical width with sips (built in), keeping aspect
  await execFileP('sips', ['-Z', String(width), tmp], { timeout: 15000 }).catch(() => {})
  const data = fs.readFileSync(tmp)
  fs.unlink(tmp, () => {})
  return { dataB64: data.toString('base64'), mime: 'image/png' }
}

export const desktop = {
  screenshot,
  screenSize,
  move: (x, y) => ctl('move', x, y),
  click: (x, y, button = 'left') => ctl(button === 'right' ? 'rightclick' : 'click', x, y),
  doubleClick: (x, y) => ctl('doubleclick', x, y),
  drag: (x1, y1, x2, y2) => ctl('drag', x1, y1, x2, y2),
  scroll: (x, y, dy) => ctl('scroll', x, y, dy),
  type: text => ctl('type', text),
  key: spec => ctl('key', spec)
}
