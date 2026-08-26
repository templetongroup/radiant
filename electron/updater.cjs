const { app, Menu, dialog, shell, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('fs')
const path = require('path')

// ⚠️ A STAGED PACKAGE IS NOT NECESSARILY THE LATEST ONE.
//
// electron-updater downloads into a `pending` folder and, with
// autoInstallOnAppQuit, installs whatever is sitting there when the app quits.
// Nothing expires it. So if you download an update and don't restart, then a
// few more releases ship, quitting installs the OLD staged build — and the next
// launch finds a newer one and asks again. Being several versions behind meant
// clicking through an update prompt per version to crawl forward one at a time.
//
// The fix is to treat `pending` as a cache that must match the newest release:
// drop it whenever it holds something already installed or something older than
// what the feed offers, so a quit-install can only ever apply the latest.
function pendingDir () {
  return path.join(app.getPath('cache'), `${app.getName().toLowerCase()}-updater`, 'pending')
}

function stagedVersion () {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(pendingDir(), 'update-info.json'), 'utf8'))
    const m = /-(\d+\.\d+\.\d+)-/.exec(info.fileName || '')
    return info.version || (m ? m[1] : null)
  } catch { return null }
}

function clearStaged (why) {
  const dir = pendingDir()
  if (!fs.existsSync(dir)) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`[radiant] discarded staged update (${why})`)
    return true
  } catch (e) {
    console.warn('[radiant] could not discard staged update:', e.message)
    return false
  }
}

// -1 / 0 / 1, on plain x.y.z. Enough for our own version numbers.
function cmpVersion (a, b) {
  const pa = String(a || '0').split('.').map(Number)
  const pb = String(b || '0').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
  }
  return 0
}

// Real auto-update via electron-updater against GitHub Releases. Works because
// the app is signed + notarized. Flow: check → (ask) download w/ progress →
// quit & relaunch into the new version. Renderer drives it over IPC; the menu
// bar has a "Check for Updates…" item too.

// The "Automatically check for updates on launch" checkbox in Settings → About
// was never read — the background check ran regardless. Honour it. This is the
// only change to the update flow; everything else is exactly as it shipped in
// v0.6.91, which worked.
function autoUpdatesEnabled () {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.radiant', 'config.json'), 'utf8'))
    return cfg.settings?.autoUpdateCheck !== false
  } catch { return true }
}

function installUpdater ({ getWindow }) {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  let latest = null
  // one update conversation at a time — repeated checks used to stack dialogs
  let dialogOpen = false
  let promptedFor = null

  // Before anything can quit-install it: a staged build at or below the running
  // version is spent (it is usually the one we just installed) and would only
  // reinstall what is already here.
  const staleOnDisk = stagedVersion()
  if (staleOnDisk && cmpVersion(staleOnDisk, app.getVersion()) <= 0) {
    clearStaged(`${staleOnDisk} is already installed`)
  }

  const send = (type, data) => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('rad:update-event', { type, data })
  }

  autoUpdater.on('update-available', info => { latest = info; send('available', { version: info.version, notes: info.releaseNotes }) })
  autoUpdater.on('update-not-available', () => send('none', {}))
  autoUpdater.on('download-progress', p => send('progress', { percent: Math.round(p.percent), transferred: p.transferred, total: p.total }))
  autoUpdater.on('update-downloaded', info => send('downloaded', { version: info.version }))
  autoUpdater.on('error', err => send('error', { message: String(err && err.message || err) }))

  ipcMain.handle('rad:check-update', async () => {
    try {
      const r = await autoUpdater.checkForUpdates()
      const v = r && r.updateInfo && r.updateInfo.version
      // ⚠️ COMPARE, DO NOT JUST TEST INEQUALITY. `v !== current` is also true
      // when the published release is OLDER than what is installed — a pulled
      // or rolled-back release would have been offered as an "update" that
      // silently downgrades. cmpVersion already existed a few lines above and
      // was used by checkNow; this handler simply never called it.
      return { version: v, current: app.getVersion(), hasUpdate: Boolean(v) && cmpVersion(v, app.getVersion()) > 0 }
    } catch (e) {
      return { error: String(e && e.message || e), current: app.getVersion() }
    }
  })
  ipcMain.on('rad:download-update', () => { autoUpdater.downloadUpdate().catch(e => send('error', { message: String(e.message || e) })) })
  ipcMain.on('rad:install-update', () => { setImmediate(() => autoUpdater.quitAndInstall(false, true)) })
  // A full process restart, not a window reopen. app.exit skips the quit
  // handlers that could keep it alive; relaunch queues the new process first.
  ipcMain.on('rad:relaunch', () => { app.relaunch(); app.exit(0) })

  async function checkNow (silent) {
    let r
    try { r = await autoUpdater.checkForUpdates() } catch (e) {
      if (!silent) dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates', detail: String(e.message || e), buttons: ['OK'] })
      return
    }
    const v = r && r.updateInfo && r.updateInfo.version
    if (v && cmpVersion(v, app.getVersion()) > 0) {
      // Anything staged that isn't this newest release would install the wrong
      // version on quit — and it is what made a multi-version gap take several
      // prompts to cross. Drop it and go straight to the latest.
      const staged = stagedVersion()
      if (staged && staged !== v) clearStaged(`staged ${staged}, but ${v} is current`)

      if (dialogOpen || (silent && promptedFor === v)) return
      dialogOpen = true
      let response
      try {
        ;({ response } = await dialog.showMessageBox(getWindow() || undefined, {
          type: 'info',
          message: `Radiant ${v} is available`,
          detail: `You have ${app.getVersion()}. Download it now? Radiant will install it and relaunch when it's ready.`,
          buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1
        }))
      } finally { dialogOpen = false }
      promptedFor = v
      if (response === 0) autoUpdater.downloadUpdate()
    } else if (!silent) {
      dialog.showMessageBox(getWindow() || undefined, { type: 'info', message: "You're up to date", detail: `Radiant ${app.getVersion()} is the latest version.`, buttons: ['OK'] })
    }
  }

  // when a download finishes from the menu path, offer to restart
  autoUpdater.on('update-downloaded', async info => {
    if (dialogOpen) return
    dialogOpen = true
    let response
    try {
      ;({ response } = await dialog.showMessageBox(getWindow() || undefined, {
        type: 'info',
        message: `Radiant ${info.version} is ready`,
        detail: 'Restart now to finish updating?',
        buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1
      }))
    } finally { dialogOpen = false }
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall(false, true))
  })

  function buildMenu () {
    const isMac = process.platform === 'darwin'
    const template = [
      ...(isMac ? [{
        label: 'Radiant',
        submenu: [
          { role: 'about' },
          { label: 'Check for Updates…', click: () => checkNow(false) },
          { type: 'separator' },
          { role: 'services' }, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit' }
        ]
      }] : []),
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      {
        label: 'Help',
        submenu: [
          { label: 'Check for Updates…', click: () => checkNow(false) },
          { label: 'Radiant on GitHub', click: () => shell.openExternal('https://github.com/templetongroup/radiant') }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  function startAutoCheck () {
    const tick = () => { if (autoUpdatesEnabled()) checkNow(true) }
    setTimeout(tick, 8000)
    setInterval(tick, 6 * 60 * 60 * 1000)
  }

  buildMenu()
  return { checkNow, startAutoCheck }
}

module.exports = { installUpdater }
