const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('splashAPI', {
  getLogoSrc: () => ipcRenderer.sendSync('splash:logo-src'),
  onClose: (cb) => ipcRenderer.on('splash:close', () => cb()),
})
