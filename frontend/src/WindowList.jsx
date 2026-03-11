import { useState } from 'react'
import './WindowList.css'

// ── Inline SVG icons ──────────────────────────────────────────────────────

function ChevronIcon({ expanded }) {
  return (
    <svg
      className="chevron-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg className="eye-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeSlashIcon() {
  return (
    <svg className="eye-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="m14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

function FolderIcon() {
  // Windows Explorer icon: golden folder body with distinctive blue ribbon band
  return (
    <svg className="app-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" stroke="none">
      {/* Back panel of folder — slightly darker gold */}
      <path d="M2 7C2 5.9 2.9 5 4 5h4.5l1.5 2H20c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V7z"
        fill="#E6901A" />
      {/* Front face of folder — bright amber */}
      <rect x="2" y="9" width="20" height="11" rx="1" fill="#F5A623" />
      {/* Blue ribbon band — the Windows Explorer signature stripe */}
      <rect x="2" y="15" width="20" height="5" rx="1" fill="#1976D2" />
    </svg>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** "chrome.exe" → "Chrome", "my-cool-app.exe" → "My Cool App" */
function deriveAppName(processName) {
  if (!processName) return ''
  return processName
    .replace(/\.exe$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

// ── AppIcon — shows the process icon, falls back to a letter tile on error ─

function AppIcon({ dataUrl, letter, processName }) {
  const [failed, setFailed] = useState(false)
  if (dataUrl && !failed) {
    return (
      <img
        className="app-icon"
        src={dataUrl}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
      />
    )
  }
  // Fallback for explorer.exe when native icon extraction returned nothing:
  // show the static Windows Explorer SVG rather than a letter tile.
  if (processName?.toLowerCase() === 'explorer.exe') {
    return <FolderIcon />
  }
  return <div className="app-icon-fallback">{letter}</div>
}

// ── WindowItem ────────────────────────────────────────────────────────────

function WindowItem({ win, onToggle }) {
  return (
    <div className={`window-item${win.hidden ? ' is-hidden' : ''}`}>
      <span className="window-item-title" title={win.title}>
        {win.title}
      </span>
      <button
        className={`eye-btn${win.hidden ? ' is-hidden' : ''}`}
        onClick={() => onToggle(win)}
        title={win.hidden ? 'Show — restore to screen capture' : 'Hide from screen capture'}
      >
        {win.hidden ? <EyeSlashIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}

// ── AppHeader ─────────────────────────────────────────────────────────────

function AppHeader({ group, onToggleAll, isExpanded, onToggleExpand }) {
  // Exclude no_window (tray-only) placeholders so the eye icon reflects only
  // windows that have actual HWNDs. When all real windows are visible the icon
  // should show the open eye even if a no_window placeholder is still hidden.
  const realWins = group.windows.filter((w) => !w.no_window)
  const evalSet = realWins.length > 0 ? realWins : group.windows
  const allHidden = evalSet.every((w) => w.hidden)
  const someHidden = !allHidden && evalSet.some((w) => w.hidden)
  const iconLetter = (group.appName[0] ?? '?').toUpperCase()

  return (
    <div className="app-header" onClick={onToggleExpand} style={{ cursor: 'pointer' }}>
      <div className="app-icon-wrap">
        <AppIcon
          dataUrl={group.iconDataUrl}
          letter={iconLetter}
          processName={group.processName}
        />
      </div>

      {/* Name + exe name */}
      <div className="app-info">
        <span className="app-name">{group.appName}</span>
        <span className="app-process">{group.processName}</span>
      </div>

      {/* Chevron collapse/expand (just left of eye) */}
      <button
        className="chevron-btn"
        onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
      >
        <ChevronIcon expanded={isExpanded} />
      </button>

      {/* Parent toggle — hides/shows all windows for this process */}
      <button
        className={`eye-btn${allHidden ? ' is-hidden' : ''}${someHidden ? ' is-partial' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleAll(!allHidden) }}
        title={
          allHidden
            ? 'Show all windows'
            : someHidden
              ? 'Hide remaining windows'
              : 'Hide all windows'
        }
      >
        {allHidden ? <EyeSlashIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}

// ── AppContainer ──────────────────────────────────────────────────────────

function AppContainer({ group, onToggle, onSetGroup, isExpanded, onToggleExpand }) {
  // Call onSetGroup for every PID in the group — handles merged multi-PID groups
  // (e.g. multiple steamwebhelper.exe instances collapsed into one row).
  const handleToggleAll = (hide) => {
    for (const pid of group.pids) {
      onSetGroup(pid, hide)
    }
  }

  return (
    <div className={`app-container${isExpanded ? ' is-expanded' : ''}`}>
      <AppHeader
        group={group}
        onToggleAll={handleToggleAll}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
      />
      {isExpanded && group.windows.filter((w) => !w.no_window).map((win) => (
        <WindowItem key={win.hwnd} win={win} onToggle={onToggle} />
      ))}
      {isExpanded && group.windows.every((w) => w.no_window) && (
        <div className="wl-tray-note">Running — no open windows</div>
      )}
    </div>
  )
}

// ── WindowList (root export) ──────────────────────────────────────────────

/**
 * Props:
 *   windows     [{hwnd, title, pid, hidden, process_name, exe_path, icon_data_url}]
 *   loading     boolean
 *   onToggle    (win) => void          — toggle a single window
 *   onSetGroup  (pid, hide) => void   — set all windows for a PID to a state
 */
export default function WindowList({ windows, loading, onToggle, onSetGroup }) {
  const [expanded, setExpanded] = useState(new Set())

  const toggleExpand = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (windows.length === 0 && !loading) {
    return <div className="wl-empty">No windows found. Click ↺ to refresh.</div>
  }

  // Group windows by process name, preserving first-seen insertion order.
  // Multiple PIDs with the same process name (e.g. steamwebhelper.exe) are
  // merged into a single group so the UI doesn't show duplicate rows.
  const groups = []
  const nameMap = {}

  for (const win of windows) {
    const key = win.process_name?.toLowerCase() || `__pid_${win.pid}`
    if (!nameMap[key]) {
      const group = {
        key,
        appName: deriveAppName(win.process_name) || `PID ${win.pid}`,
        processName: win.process_name || '',
        iconDataUrl: win.icon_data_url ?? null,
        pids: new Set(),
        windows: [],
      }
      nameMap[key] = group
      groups.push(group)
    }
    nameMap[key].pids.add(win.pid)
    nameMap[key].windows.push(win)
  }

  return (
    <div className="window-list">
      {groups.map((group) => (
        <AppContainer
          key={group.key}
          group={group}
          onToggle={onToggle}
          onSetGroup={onSetGroup}
          isExpanded={expanded.has(group.key)}
          onToggleExpand={() => toggleExpand(group.key)}
        />
      ))}
    </div>
  )
}
