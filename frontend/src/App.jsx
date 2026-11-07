import { useState, useEffect, useRef } from 'react'
import './App.css'
import PreviewPane from './PreviewPane'
import WindowList from './WindowList'
import StatusBar from './StatusBar'
import useWindowManager from './useWindowManager'
import AppOverlays from './AppOverlays'

// window.screenShield is injected by preload.js in Electron.
// When running in a plain browser (vite dev without Electron), use stubs.
const api = window.screenShield ?? {
  isElevated: async () => true,
  listWindows: async () => [],
  hideWindow: async () => {},
  unhideWindow: async () => {},
  listScreens: async () => [],
  getMonitors: async () => [],
  getPreviewFrame: async () => null,
  startWatch: async () => {},
  stopWatch: async () => {},
  enableAutoHideAll: async () => {},
  enableExplorerHook: async () => {},
  addHiddenProcess: async () => {},
  removeHiddenProcess: async () => {},
  getHiddenProcesses: async () => [],
  getSystemTheme: async () => ({ isDark: false, accentColor: null }),
  onSystemThemeChange: () => {},
  getLogoSrc: async () => null,
  saveSetting: async () => {},
  resetSettings: async () => {},
  onResetSettings: () => {},
  onAppHidden: () => {},
  onAppShown: () => {},
}

// ---------------------------------------------------------------------------
// Theme helpers — applied to document.documentElement
// ---------------------------------------------------------------------------
const THEME_VARS = ['--bg', '--surface', '--surface-hover', '--border', '--accent',
  '--accent-hover', '--text', '--text-muted', '--hidden-bg', '--hidden-border']

function clearInlineThemeVars() {
  THEME_VARS.forEach((v) => document.documentElement.style.removeProperty(v))
}

function applySystemThemeVars({ isDark, accentColor }) {
  const root = document.documentElement
  let accent, accentHover, hiddenBg, hiddenBorder
  if (accentColor && accentColor.length >= 6) {
    const r = parseInt(accentColor.slice(0, 2), 16)
    const g = parseInt(accentColor.slice(2, 4), 16)
    const b = parseInt(accentColor.slice(4, 6), 16)
    accent = `rgb(${r},${g},${b})`
    accentHover = `rgb(${Math.round(r * 0.8)},${Math.round(g * 0.8)},${Math.round(b * 0.8)})`
    hiddenBg = `rgba(${r},${g},${b},0.12)`
    hiddenBorder = `rgba(${r},${g},${b},0.45)`
  } else {
    // Fallback: Windows default blue
    accent = '#0078d4'; accentHover = '#005fa3'
    hiddenBg = 'rgba(0,120,212,0.12)'; hiddenBorder = 'rgba(0,120,212,0.45)'
  }
  const base = isDark
    ? { '--bg': '#202020', '--surface': '#2d2d2d', '--surface-hover': '#383838',
        '--border': '#404040', '--text': '#e0e0e0', '--text-muted': '#9e9e9e' }
    : { '--bg': '#f3f3f3', '--surface': '#ffffff', '--surface-hover': '#ebebeb',
        '--border': '#d0d0d0', '--text': '#1a1a1a', '--text-muted': '#666666' }
  const all = { ...base, '--accent': accent, '--accent-hover': accentHover,
    '--hidden-bg': hiddenBg, '--hidden-border': hiddenBorder }
  Object.entries(all).forEach(([k, v]) => root.style.setProperty(k, v))
}

export default function App() {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Theme & settings panel
  const [theme, setTheme] = useState(() => localStorage.getItem('ss-theme') || 'default')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const themeRef = useRef(theme)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)

  // First-launch setup
  const [firstLaunch, setFirstLaunch] = useState(() => localStorage.getItem('ss-setup-done') === null)
  const [logoSrc, setLogoSrc] = useState(null)

  const {
    windows, setWindows, loading, error, elevated, isAppVisible, screens, currentScreen, setCurrentScreen,
    hideDesktop, hideTaskbar, hideTaskView, refresh, toggle, setGroup, toggleHideDesktop,
    toggleHideTaskView, toggleHideTaskbar, visibleWindows, hiddenCount,
  } = useWindowManager(api, setLaunchAtStartup)

  useEffect(() => { themeRef.current = theme }, [theme])

  // Apply theme — sets data-theme attribute (static themes) or inline CSS variables (system)
  useEffect(() => {
    const root = document.documentElement
    clearInlineThemeVars()
    root.removeAttribute('data-theme')
    if (theme === 'dark' || theme === 'light') {
      root.dataset.theme = theme
    } else if (theme === 'system') {
      api.getSystemTheme?.().then(applySystemThemeVars).catch(() => {})
    }
    localStorage.setItem('ss-theme', theme)
    // Also persist to disk so the splash screen can match on next launch
    api.saveSetting?.('theme', theme).catch(() => {})
  }, [theme])

  // Listen for OS theme / accent changes and re-apply when System theme is active
  useEffect(() => {
    api.onSystemThemeChange?.((info) => {
      if (themeRef.current === 'system') applySystemThemeVars(info)
    })
  }, [])

   // Listen for a main-process reset request (tray menu or IPC handler), clear
   // persisted state and reload so the first-launch setup re-appears.
   useEffect(() => {
     api.onResetSettings?.(() => {
       localStorage.removeItem('ss-setup-done')
       localStorage.removeItem('ss-theme')
       window.location.reload()
     })
   }, [])

  // Load logo URL for the first-launch setup screen
  useEffect(() => {
    if (firstLaunch) {
      api.getLogoSrc?.().then((src) => { if (src) setLogoSrc(src) }).catch(() => {})
    }
  }, [firstLaunch])

  const handleSetupComplete = () => {
    localStorage.setItem('ss-setup-done', '1')
    setFirstLaunch(false)
  }

  return (
    <div className="app">
      {/* Admin warning — very top, full width, only when not elevated */}
      {!elevated && (
        <div className="elevation-warn">
          <span className="elevation-warn-title">⚠ Not running as Administrator</span>
          <span className="elevation-warn-body">Some features may not work correctly until the application is launched with administrator privileges.</span>
        </div>
      )}

      <div className="app-panels">
        {/* ── Panel 1: Preview ──────────────────────────────── */}
        <section className="panel panel-preview">
          <div className="panel-header">
            <div className="panel-header-info">
              <span className="panel-title">Preview</span>
              <span className="panel-sub">How others will see your screen</span>
            </div>
            <button
              className="settings-cog-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Open settings"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.34.07-.68.07-1.08s-.03-.74-.07-1.08l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.34-.07.69-.07 1.08s.03.74.07 1.08l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65z" />
              </svg>
            </button>
          </div>
          <PreviewPane
            screens={screens}
            currentScreen={currentScreen}
            isAppVisible={isAppVisible}
            onScreenChange={setCurrentScreen}
          />
        </section>

        {/* ── Panel 2: Hide Applications ────────────────────── */}
        <section className="panel panel-apps">
          <div className="panel-header">
            <div className="panel-header-info">
              <span className="panel-title">Hide Applications</span>
              <span className="panel-sub">Select the windows to hide from screen capture</span>
            </div>
            <button
              className="refresh-btn"
              onClick={refresh}
              disabled={loading}
              title="Refresh window list"
            >
              <span className="refresh-btn-icon">{loading ? '⟳' : '↺'}</span>
              Refresh
            </button>
          </div>
          {error && <div className="error-bar">{error}</div>}
          <WindowList
            windows={visibleWindows}
            loading={loading}
            onToggle={toggle}
            onSetGroup={setGroup}
          />

          {/* ── Advanced Settings ──────────────────────────── */}
          <div className="advanced-panel">
            <button
              type="button"
              className="advanced-header"
              aria-expanded={advancedOpen}
              aria-controls="advanced-options"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <svg
                className={`advanced-chevron${advancedOpen ? ' is-open' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Advanced
            </button>
            <div id="advanced-options" className="advanced-body" hidden={!advancedOpen}>
                <label className="advanced-option">
                  <input
                    type="checkbox"
                    checked={hideDesktop}
                    onChange={(e) => toggleHideDesktop(e.target.checked)}
                  />
                  <span className="advanced-option-label">
                    Hide desktop background from screen capture
                  </span>
                </label>
                <label className="advanced-option">
                  <input
                    type="checkbox"
                    checked={hideTaskbar}
                    onChange={(e) => toggleHideTaskbar(e.target.checked)}
                  />
                  <span className="advanced-option-label">
                    Hide taskbar from screen capture
                  </span>
                </label>
                <label className="advanced-option">
                  <input
                    type="checkbox"
                    checked={hideTaskView}
                    onChange={(e) => toggleHideTaskView(e.target.checked)}
                  />
                  <span className="advanced-option-label">
                    Hide Task View and Alt+Tab from screen capture
                  </span>
                </label>
            </div>
          </div>
        </section>
      </div>

      {/* ── Footer: status bar ────────────────────────────────── */}
      <StatusBar hiddenCount={hiddenCount} hideDesktop={hideDesktop} hideTaskbar={hideTaskbar} hideTaskView={hideTaskView} />

      <AppOverlays
        api={api}
        settingsOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onThemeChange={setTheme}
        launchAtStartup={launchAtStartup}
        onLaunchAtStartupChange={setLaunchAtStartup}
        windows={windows}
        firstLaunch={firstLaunch}
        logoSrc={logoSrc}
        onComplete={handleSetupComplete}
      />
    </div>
  )
}
