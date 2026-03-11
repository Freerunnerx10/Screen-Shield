const { contextBridge, ipcRenderer } = require('electron')

/**
 * Expose a safe, typed API to the renderer process.
 * All calls go through IPC — the renderer never touches Node directly.
 */
contextBridge.exposeInMainWorld('screenShield', {
  /** Returns true if the process is running with administrator rights */
  isElevated: () => ipcRenderer.invoke('is-elevated'),

  /** List all visible top-level windows */
  listWindows: () => ipcRenderer.invoke('get-windows'),

  /** Hide a window from screen capture. Pass altTab=true to also hide from Alt+Tab. */
  hideWindow: (hwnd, altTab) => ipcRenderer.invoke('hide-window', hwnd, altTab),

  /** Stop hiding a window */
  unhideWindow: (hwnd, altTab) => ipcRenderer.invoke('unhide-window', hwnd, altTab),

  /** List available display sources for the live preview pane */
  listScreens: () => ipcRenderer.invoke('screens:list'),

  /** Get merged monitor list with display metadata (bounds, scaleFactor, isPrimary) */
  getMonitors: () => ipcRenderer.invoke('get-monitors'),

  /** Get a single high-res thumbnail frame for the given screen source ID */
  getPreviewFrame: (screenId) => ipcRenderer.invoke('get-preview-frame', screenId),

  /** Start (or restart) the WinEvent watcher for a list of process names */
  startWatch: (names) => ipcRenderer.invoke('start-watch', names),

  /** Stop the WinEvent watcher */
  stopWatch: () => ipcRenderer.invoke('stop-watch'),

  /**
   * Inject utils.dll into every running process whose name is in `names` and call
   * EnableAutoHide(enable).  Pass enable=true to install the in-process hook,
   * enable=false to remove it.
   */
  enableAutoHideAll: (enable, names) => ipcRenderer.invoke('enable-auto-hide-all', enable, names),

  /** Returns the OS dark-mode flag and Windows accent color for the System theme */
  getSystemTheme: () => ipcRenderer.invoke('get-system-theme'),

  /** Register a callback to be called whenever the OS theme or accent color changes */
  onSystemThemeChange: (cb) => {
    ipcRenderer.on('system-theme-changed', (_event, data) => cb(data))
  },

  /** Returns the file:// URL of the Screen Shield logo (works in dev and packaged) */
  getLogoSrc: () => ipcRenderer.invoke('get-logo-src'),

  /** Persist a single app setting (key/value) to the on-disk config file */
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),

  /** Wipe all saved settings and re-trigger first-launch setup on next load */
  resetSettings: () => ipcRenderer.invoke('reset-settings'),

  /** Set or remove the Windows startup (login item) entry */
  setLaunchAtStartup: (enable) => ipcRenderer.invoke('set-launch-at-startup', enable),

  /** Returns the current launch-at-startup state */
  getLaunchAtStartup: () => ipcRenderer.invoke('get-launch-at-startup'),

  /** Register a callback to be called when the main process initiates a settings reset (e.g. tray menu) */
  onResetSettings: (cb) => ipcRenderer.on('main:reset-settings', cb),
})
