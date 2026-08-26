const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('radiantNative', {
  setMode: mode => ipcRenderer.send('radiant:set-mode', mode),
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
  onEvent: cb => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('rad:update-event', handler)
    return () => ipcRenderer.removeListener('rad:update-event', handler)
  }
})
