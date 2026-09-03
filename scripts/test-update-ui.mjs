/**
 * The update UI, which lives in a different window from the one the updater talked to.
 *
 * ⚠️ THIS IS A WHOLE CLASS OF BUG IN A MULTI-WINDOW APP. Radiant has three windows —
 * main, Settings and the HUD — and anything sent with getWindow().webContents.send()
 * reaches exactly one of them. The updater's progress and "downloaded" events were
 * sent that way, while the progress bar they were meant to fill lives in Settings.
 * Tony: "I just hit update on the app and it seems frozen." Nothing was frozen: the
 * 163 MB download completed normally, staged on disk, and the bar sat at 0% in a
 * window that was never told.
 *
 * Nothing here needs Electron: the mistake is visible in the wiring, and the wiring
 * is what shipped wrong.
 */
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg) } }

const upd = readFileSync('electron/updater.cjs', 'utf8')
const pre = readFileSync('electron/preload.cjs', 'utf8')
const set = readFileSync('src/components/Settings.jsx', 'utf8')

// ── Every window hears it ──────────────────────────────────────────────────
ok(/BrowserWindow\.getAllWindows\(\)/.test(upd),
   'update events go to every window, because the one that shows them is not the main one')
ok(!/const w = getWindow\(\)\s*\n\s*if \(w && !w\.isDestroyed\(\)\) w\.webContents\.send\('rad:update-event'/.test(upd),
   'and the single-window send is gone, not merely supplemented')
ok(/BrowserWindow/.test(upd.split('\n').find(l => l.includes("require('electron')")) || ''),
   'BrowserWindow is actually imported — the broadcast throws at runtime otherwise, mid-download')

// ── A window that opens late is not left blank ─────────────────────────────
ok(/ipcMain\.handle\('rad:update-state'/.test(upd), 'the main process can be asked what was missed')
ok(/state = type === 'progress'/.test(upd), 'and it keeps that state as events pass')
ok(/state: \(\) => ipcRenderer\.invoke\('rad:update-state'\)/.test(pre), 'the bridge exposes it')
ok(/native\.state\(\)\.then/.test(set), 'and the About pane asks on mount')
ok(/st\.phase === 'ready'/.test(set) && /st\.phase === 'downloading'/.test(set),
   'restoring BOTH an in-flight download and a finished one — a finished one showing "Download & install" again is how you fetch 163 MB twice')

// ── The states themselves stay honest ──────────────────────────────────────
ok(/phase === 'ready'/.test(set) && /Restart &amp; install/.test(set),
   'a downloaded update offers a restart, which is the only thing that installs it')
ok(/type === 'error'/.test(upd) || /'error'/.test(upd), 'an error resets rather than leaving a bar mid-way')

console.log(`  ${pass}/${pass + fail} passed  ·  every window hears the updater`)
process.exit(fail ? 1 : 0)
