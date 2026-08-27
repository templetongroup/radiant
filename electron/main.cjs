const { app, BrowserWindow, shell, ipcMain, nativeTheme, dialog, screen, session } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { pathToFileURL } = require('url')
const { installUpdater } = require('./updater.cjs')
const windowState = require('./window-state.cjs')

// window chrome follows the app's own light/dark setting, not the OS
function savedMode () {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.radiant', 'config.json'), 'utf8'))
    return cfg.settings?.mode === 'light' ? 'light' : 'dark'
  } catch { return 'dark' }
}
nativeTheme.themeSource = savedMode()
ipcMain.on('radiant:set-mode', (e, mode) => {
  nativeTheme.themeSource = mode === 'light' ? 'light' : 'dark'
})

// ⚠️ THE FRAME MUST MATCH THE THEME, NOT A CONSTANT. Electron paints
// backgroundColor before the page draws and while a window is being resized, and
// both windows had it hardcoded to #141517 / #f5f5f6. Every derived theme is
// near-neutral so nobody noticed; a pinned palette is not, so Nous Classic
// showed a dark grey frame flashing around a deep blue app. The renderer sends
// its real --bg whenever the theme changes.
let lastBg = null
ipcMain.on('radiant:set-bg', (e, color) => {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color.trim())) return
  lastBg = color.trim()
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed()) { try { w.setBackgroundColor(lastBg) } catch {} }
  }
})

// native folder picker for the workspace chip (window.prompt is a no-op in Electron)
// ⚠️ PARENT A DIALOG TO THE WINDOW THAT ASKED FOR IT. This was pinned to `win`,
// the main window, but the caller that matters is the Settings window. On macOS
// a modal opens as a sheet on its parent, so the sheet appeared on a window
// behind the one being used: the user ticks "Keep my setup in iCloud Drive",
// nothing visible happens, and the box springs back because the promise never
// resolves. Tony, on a third Mac: "i cant click the ccheckbox. nothing checks
// on."
ipcMain.handle('rad:pick-folder', async (e, current, title) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || win || undefined
  const res = await dialog.showOpenDialog(parent, {
    title: title || 'Choose workspace folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || undefined
  })
  return res.canceled || !res.filePaths?.length ? null : res.filePaths[0]
})

// Save a file the user asked for, with a real Save dialog.
//
// ⚠️ NOT AN <a download>. That leans on Electron's default download handling,
// which this app has never configured — and a feature resting on unconfigured
// default behaviour is the same bet that shipped a button wired to
// window.prompt(). This is explicit: our dialog, our write, and the path comes
// back so the app can say where the file went. The browser build still falls
// back to a blob download, because there that IS the native behaviour.
ipcMain.handle('rad:save-file', async (e, { name, content } = {}) => {
  const res = await dialog.showSaveDialog(win || undefined, {
    title: 'Save',
    defaultPath: path.join(os.homedir(), 'Downloads', name || 'radiant-export'),
    properties: ['createDirectory']
  })
  if (res.canceled || !res.filePath) return null
  fs.writeFileSync(res.filePath, String(content ?? ''), 'utf8')
  return res.filePath
})

console.log('[radiant] main.cjs loaded, electron', process.versions.electron)
process.on('uncaughtException', e => console.error('[radiant] uncaught:', e))
process.on('unhandledRejection', e => console.error('[radiant] unhandled rejection:', e))

let win = null
let settingsWin = null
let serverPort = null
let updater = null

ipcMain.on('rad:open-settings', async (e, tab) => {
  const port = await ensureServer()
  const hash = 'settings' + (tab ? '/' + tab : '')
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); if (tab) settingsWin.loadURL(`http://127.0.0.1:${port}/#${hash}`); return }
  const setState = windowState.restore('settings', { width: 940, height: 720 }, screen.getAllDisplays())
  settingsWin = new BrowserWindow({
    ...setState.bounds,
    minWidth: 720,
    minHeight: 520,
    title: 'Radiant Settings',
    backgroundColor: lastBg || (nativeTheme.themeSource === 'light' ? '#f5f5f6' : '#141517'),
    parent: win || undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') }
  })
  windowState.track(settingsWin, 'settings', setState)
  settingsWin.on('closed', () => {
    settingsWin = null
    if (win && !win.isDestroyed()) win.webContents.send('rad:settings-closed')
  })
  settingsWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  settingsWin.loadURL(`http://127.0.0.1:${port}/#${hash}`)
})
// ⚠️ TWO WINDOWS, TWO COPIES OF THE CONFIG. Settings is a separate renderer
// process, so a change made there was invisible to the main window until the
// Settings window CLOSED — the only moment anything refetched. Leave Settings
// open, which is normal, and every new chat kept using the old default model
// while the picker showed the new one. Relay the change immediately instead.
ipcMain.on('rad:config-changed', e => {
  for (const w of [win, settingsWin]) {
    if (w && !w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('rad:config-changed')
  }
})

ipcMain.on('rad:close-settings', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close() })

async function ensureServer () {
  if (serverPort) return serverPort
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href)
  serverPort = await mod.ready
  return serverPort
}

// ⚠️ AN UPGRADE MUST START FROM A CLEAN HTTP CACHE.
//
// The webview cached /api/ reads into the user data folder, where they outlived
// quitting, restarting and reinstalling. Refusing the cache on new requests
// (src/api.js) stops it recurring, but entries already stored on someone's Mac
// would keep being served to any code path that ever asks for them. Clear the
// cache once per version so an upgrade cannot inherit a poisoned one.
async function clearStaleCacheOnce () {
  try {
    const marker = path.join(app.getPath('userData'), 'cache-cleared-for')
    let seen = null
    try { seen = fs.readFileSync(marker, 'utf8').trim() } catch {}
    if (seen === app.getVersion()) return
    await session.defaultSession.clearCache()
    fs.writeFileSync(marker, app.getVersion(), 'utf8')
    console.log('[radiant] cleared http cache for', app.getVersion())
  } catch (e) {
    console.warn('[radiant] could not clear http cache:', e.message)
  }
}

async function createWindow () {
  await clearStaleCacheOnce()
  const port = await ensureServer()
  const state = windowState.restore('main', { width: 1360, height: 860 }, screen.getAllDisplays())
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 900,
    minHeight: 600,
    title: 'Radiant',
    backgroundColor: lastBg || (nativeTheme.themeSource === 'light' ? '#f5f5f6' : '#141517'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })
  windowState.track(win, 'main', state)
  win.on('closed', () => { win = null })
  // external links go to the real browser, not new Electron windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  await win.loadURL(`http://127.0.0.1:${port}`)

  // menu-bar "Check for Updates…" + a quiet auto-check on launch
  updater = installUpdater({ getWindow: () => win })
  updater.startAutoCheck()
}

app.whenReady().then(createWindow)

app.on('activate', () => {
  if (app.isReady() && !win) createWindow()
})

app.on('window-all-closed', () => {
  app.quit() // the embedded server dies with the process
})
