const settingsThemes = [
  { id: 'default', label: 'Default', desc: 'Black & red' },
  { id: 'dark', label: 'Dark', desc: 'Neutral dark, blue accent' },
  { id: 'light', label: 'Light', desc: 'Light mode' },
  { id: 'system', label: 'System', desc: 'Follows Windows theme & accent colour' },
]

const setupThemes = [
  { id: 'default', label: 'Default', desc: 'Black & red' },
  { id: 'dark', label: 'Dark', desc: 'Neutral dark' },
  { id: 'light', label: 'Light', desc: 'Light mode' },
  { id: 'system', label: 'System', desc: 'Follows Windows' },
]

function ThemePicker({ theme, onSelect, variant }) {
  const isSetup = variant === 'setup'
  const themes = isSetup ? setupThemes : settingsThemes

  return (
    <div className={isSetup ? 'setup-theme-grid' : 'theme-options'}>
      {themes.map(({ id, label, desc }) => (
        <button
          key={id}
          type="button"
          className={`${isSetup ? 'setup-theme-btn' : 'theme-option-btn'}${theme === id ? ' active' : ''}`}
          onClick={() => onSelect(id)}
          aria-pressed={theme === id}
        >
          <span className={`theme-option-swatch theme-swatch-${id}`} />
          <span className={isSetup ? 'setup-theme-btn-text' : 'theme-option-text'}>
            <span className={isSetup ? 'setup-theme-btn-name' : 'theme-option-name'}>{label}</span>
            <span className={isSetup ? 'setup-theme-btn-desc' : 'theme-option-desc'}>{desc}</span>
          </span>
          {theme === id && (
            <svg className="theme-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
      ))}
    </div>
  )
}

function SettingsDialog({
  api,
  launchAtStartup,
  onClose,
  onLaunchAtStartupChange,
  onThemeChange,
  theme,
  windows,
}) {
  const reset = async () => {
    const toUnhide = windows.filter((window) => !window.no_window && window.hidden)
    await Promise.allSettled(toUnhide.map((window) => api.unhideWindow(window.hwnd, false)))
    api.stopWatch?.().catch(() => {})
    api.resetSettings?.().catch(() => {
      localStorage.removeItem('ss-setup-done')
      localStorage.removeItem('ss-theme')
      window.location.reload()
    })
  }

  const updateLaunchAtStartup = async (event) => {
    const enabled = event.target.checked
    onLaunchAtStartupChange(enabled)
    try {
      const result = await api.setLaunchAtStartup?.(enabled)
      if (result && !result.success) {
        onLaunchAtStartupChange(!enabled)
        console.error('Failed to update startup setting:', result.error)
      }
    } catch (error) {
      onLaunchAtStartupChange(!enabled)
      console.error('Failed to update startup setting:', error)
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="settings-body">
          <p className="settings-section-label">Theme</p>
          <ThemePicker theme={theme} onSelect={onThemeChange} variant="settings" />
          <div className="settings-startup-section">
            <p className="settings-section-label">Startup</p>
            <label className="settings-toggle-label">
              <input
                type="checkbox"
                className="settings-toggle-checkbox"
                checked={launchAtStartup}
                onChange={updateLaunchAtStartup}
              />
              <span className="settings-toggle-text">Launch ScreenShield on Windows startup</span>
            </label>
          </div>
          <div className="settings-reset-section">
            <p className="settings-section-label">Reset</p>
            <button className="settings-reset-btn" onClick={reset}>Reset</button>
            <p className="settings-reset-note">Restores all hidden windows, stops the auto-hide watcher, clears saved preferences, and re-shows the setup screen on next load.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function FirstLaunchSetup({ logoSrc, onComplete, onThemeChange, theme }) {
  return (
    <div className="setup-overlay">
      <div className="setup-container">
        {logoSrc && <img className="setup-logo" src={logoSrc} alt="Screen Shield" />}
        <p className="setup-brand">SCREEN SHIELD</p>
        <p className="setup-heading">Choose your theme</p>
        <p className="setup-sub">You can change this later from the settings icon.</p>
        <ThemePicker theme={theme} onSelect={onThemeChange} variant="setup" />
        <button className="setup-get-started-btn" onClick={onComplete}>Get Started</button>
      </div>
    </div>
  )
}

export default function AppOverlays(props) {
  return (
    <>
      {props.settingsOpen && <SettingsDialog {...props} />}
      {props.firstLaunch && <FirstLaunchSetup {...props} />}
    </>
  )
}