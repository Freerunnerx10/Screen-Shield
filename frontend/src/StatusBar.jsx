import './StatusBar.css'

/**
 * StatusBar — persistent footer bar showing what is currently hidden.
 *
 * Props:
 *   hiddenCount       number   — total hidden app windows
 *   hideDesktop       boolean  — whether the desktop background + Task View is hidden
 *   hideTaskbar       boolean  — whether the taskbar is hidden
 */
export default function StatusBar({ hiddenCount, hideDesktop, hideTaskbar }) {
  const systemHidden = hideDesktop || hideTaskbar
  const active = hiddenCount > 0 || systemHidden

  // Build a compact label for the advanced-settings flags that are active.
  const badges = []
  if (hideDesktop) badges.push('DESKTOP')
  if (hideTaskbar) badges.push('TASKBAR')

  const countLabel =
    hiddenCount > 0
      ? `SCREENS HIDDEN: ${hiddenCount}`
      : systemHidden
        ? 'SYSTEM UI HIDDEN'
        : 'ALL WINDOWS VISIBLE'

  const subLabel =
    hiddenCount > 0
      ? `${hiddenCount} window${hiddenCount === 1 ? '' : 's'} excluded from screen capture`
      : systemHidden
        ? 'Selected system UI is excluded from screen capture'
        : 'No windows are hidden from capture'

  return (
    <div className={`status-bar${active ? '' : ' status-bar-idle'}`} role="status" aria-live="polite">
      <span className="status-bar-dot" aria-hidden="true" />
      <span className="status-bar-text">
        <span className="status-bar-count">
          {countLabel}
          {badges.map((b) => (
            <span key={b} className="status-bar-badge">{b}</span>
          ))}
        </span>
        <span className="status-bar-sub">{subLabel}</span>
      </span>
    </div>
  )
}
