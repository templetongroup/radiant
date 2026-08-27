const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('radiantNative', {
  setMode: mode => ipcRenderer.send('radiant:set-mode', mode),
  setBackground: color => ipcRenderer.send('radiant:set-bg', color),
  // Settings runs in its own window with its own copy of the config. Whoever
  // changes something says so; every other window refetches.
  notifyConfigChanged: () => ipcRenderer.send('rad:config-changed'),
  onConfigChanged: cb => {
    const h = () => cb()
    ipcRenderer.on('rad:config-changed', h)
    return () => ipcRenderer.removeListener('rad:config-changed', h)
  },
  openSettings: tab => ipcRenderer.send('rad:open-settings', tab),
  pickFolder: current => ipcRenderer.invoke('rad:pick-folder', current),
  saveFile: payload => ipcRenderer.invoke('rad:save-file', payload),
  closeSettings: () => ipcRenderer.send('rad:close-settings'),
  onSettingsClosed: cb => {
    const h = () => cb()
    ipcRenderer.on('rad:settings-closed', h)
    return () => ipcRenderer.removeListener('rad:settings-closed', h)
  }
})

// auto-updater bridge (only present in the packaged app)
contextBridge.exposeInMainWorld('radiantUpdater', {
  check: () => ipcRenderer.invoke('rad:check-update'),
  download: () => ipcRenderer.send('rad:download-update'),
  install: () => ipcRenderer.send('rad:install-update'),
  // Quitting Radiant properly is the one step a user can get wrong: closing the
  // window leaves the process running, so the old code keeps serving and the
  // "quit and reopen" advice appears to do nothing. This does it for them.
  relaunch: () => ipcRenderer.send('rad:relaunch'),
  onEvent: cb => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('rad:update-event', handler)
    return () => ipcRenderer.removeListener('rad:update-event', handler)
  }
})
