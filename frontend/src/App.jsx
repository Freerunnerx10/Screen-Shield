import { useState, useEffect, useCallback, useRef, startTransition } from 'react'
import './App.css'
import PreviewPane from './PreviewPane'
import WindowList from './WindowList'
import StatusBar from './StatusBar'

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
  getSystemTheme: async () => ({ isDark: false, accentColor: null }),
  onSystemThemeChange: () => {},
  getLogoSrc: async () => null,
  saveSetting: async () => {},
  resetSettings: async () => {},
  onResetSettings: () => {},
  onAppHidden: () => {},
  onAppShown: () => {},
}

/**
 * Stable dedup key for a list entry.
 * Real windows are keyed by their unique HWND (always > 0).
 * Process-only entries (no visible window, e.g. app in tray) are keyed by
 * their negative PID so they never collide with real HWNDs.
 */
const entryKey = (w) => (w.no_window ? -(w.pid) : w.hwnd)

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
   const [windows, setWindows] = useState([])
   const [loading, setLoading] = useState(false)
   const [error, setError] = useState(null)
   const [elevated, setElevated] = useState(true)
   const [isAppVisible, setIsAppVisible] = useState(true)

  // Multi-monitor state for the preview pane
  const [screens, setScreens] = useState([])
  const [currentScreen, setCurrentScreen] = useState(null)

  // Tracks PIDs whose group eye was toggled to "all hidden".
  // Any new window that appears for a locked PID is auto-hidden immediately.
  const lockedPidsRef = useRef(new Set())
  // Tracks specific HWNDs that must stay hidden (e.g. Program Manager desktop).
  const lockedHwndsRef = useRef(new Set())
  // Tracks lowercase process names that are locked — new windows from any PID
  // with a matching name are auto-hidden (catches Steam chat, helper processes, etc.)
  const lockedNamesRef = useRef(new Set())
  // Mirrors windows state so updateWatcher (no deps) can read the current list.
  const windowsRef = useRef([])

  // Advanced panel
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [hideDesktop, setHideDesktop] = useState(false)
  const [hideTaskbar, setHideTaskbar] = useState(false)
  // Ref mirror so the background poll (no deps) can read the current toggle state.
  // Task View (MultitaskingViewFrame) is rendered within the DWM desktop compositor
  // layer — when the desktop is hidden from capture, Task View is hidden as well.
  // The ref lets the poll hide/unhide the transient overlay in sync with the desktop toggle.
  const hideDesktopRef = useRef(false)

  // Theme & settings panel
  const [theme, setTheme] = useState(() => localStorage.getItem('ss-theme') || 'default')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const themeRef = useRef(theme)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)

  // First-launch setup
  const [firstLaunch, setFirstLaunch] = useState(() => localStorage.getItem('ss-setup-done') === null)
  const [logoSrc, setLogoSrc] = useState(null)

  // ---------------------------------------------------------------------------
  // Watcher management — starts/restarts the Rust --watch subprocess whenever
  // the set of locked process names changes.
  // ---------------------------------------------------------------------------
  const updateWatcher = useCallback(() => {
    // Start from the explicitly locked names, then also add process names of
    // currently-visible child windows of locked PIDs. For example, if the user
    // locked steam.exe, steamwebhelper.exe is automatically included — this
    // survives watcher restarts because the names are re-derived each time
    // rather than relying on a cache that was lost when the old process died.
    const names = new Set([...lockedNamesRef.current])

    // Determine which locked PIDs are eligible for parent→child cascade.
    // explorer.exe is the Windows shell host — every user-launched process has
    // it as parent_pid, so cascading from it would sweep the entire watch list.
    const cascadePids = new Set()
    for (const pid of lockedPidsRef.current) {
      const name = windowsRef.current.find((w) => w.pid === pid)?.process_name?.toLowerCase()
      if (name && name !== 'explorer.exe') cascadePids.add(pid)
    }

    for (const w of windowsRef.current) {
      if (!w.process_name) continue
      const n = w.process_name.toLowerCase()
      if (
        lockedPidsRef.current.has(w.pid) ||
        (w.parent_pid && cascadePids.has(w.parent_pid)) ||
        lockedNamesRef.current.has(n)
      ) {
        names.add(n)
      }
    }
    const nameList = [...names]
    if (nameList.length > 0) {
      api.startWatch?.(nameList).catch(() => {})
    } else {
      api.stopWatch?.().catch(() => {})
    }
  }, [])

  // Helper: check if a window matches any active lock (PID, HWND, name, or parent PID)
  const isWindowLocked = useCallback((w) => {
    return (
      lockedPidsRef.current.has(w.pid) ||
      lockedHwndsRef.current.has(w.hwnd) ||
      lockedNamesRef.current.has(w.process_name?.toLowerCase()) ||
      (w.parent_pid && lockedPidsRef.current.has(w.parent_pid))
    )
  }, [])

  // ---------------------------------------------------------------------------
  // Initial data load
  // ---------------------------------------------------------------------------
   const refresh = useCallback(async () => {
     // Prevent overlapping refresh calls
     if (loading) return
     setLoading(true)
     setError(null)
     try {
      const list = await api.listWindows()
      if (!Array.isArray(list)) { setWindows([]); return }

      // On the very first load (windowsRef still empty), OS-hidden windows come from
      // a previous Screen Shield session — restore them: rebuild lock state from the
      // OS-reported hidden flags and keep them marked as hidden in the UI.
      // On subsequent refreshes, OS-hidden windows without a matching lock are stale
      // (e.g. Screen Shield restarted mid-session) — clear the WDA on those.
      //
      // listWindows() already excludes system processes (taskmgr, applicationframehost)
      // and shell windows (NotifyIconOverflowWindow, Shell_TrayWnd, Progman, WorkerW),
      // so every hidden entry here is a legitimate user-visible window.
      const isFirstLoad = windowsRef.current.length === 0
      const toUnhide = []

      if (isFirstLoad) {
        // Session restore — rebuild lock sets from what the OS reports as hidden.
        // explorer.exe includes system UI like Progman (the desktop background host),
        // the taskbar (Shell_TrayWnd), and the Alt+Tab overlay (MultitaskingViewFrame).
        // Lock only the specific HWND for explorer.exe windows — adding explorer.exe
        // to lockedPidsRef or lockedNamesRef would cause all File Explorer windows to
        // be auto-hidden on the next refresh or poll.
        let desktopWasHidden = false
        let taskbarWasHidden = false
        for (const w of list) {
          if (w.no_window || !w.hidden) continue
          const isShell = w.process_name?.toLowerCase() === 'explorer.exe'
          if (!isShell && w.pid) lockedPidsRef.current.add(w.pid)
          if (!isShell && w.hwnd) lockedHwndsRef.current.add(w.hwnd)
          if (!isShell && w.process_name) lockedNamesRef.current.add(w.process_name.toLowerCase())
          if (isShell && w.title === 'Program Manager') desktopWasHidden = true
          if (isShell && (w.class_name === 'Shell_TrayWnd' || w.class_name === 'Shell_SecondaryTrayWnd')) taskbarWasHidden = true
          // MultitaskingViewFrame (Task View) shares the desktop compositor layer —
          // if it was hidden, restore the combined desktop toggle.
          if (isShell && w.class_name === 'MultitaskingViewFrame') desktopWasHidden = true
        }
        if (desktopWasHidden) setHideDesktop(true)
        if (taskbarWasHidden) setHideTaskbar(true)
      } else {
        // Stale-hidden cleanup: unlock anything the OS has hidden that we didn't lock.
        for (const w of list) {
          if (w.no_window || !w.hidden) continue
          if (
            lockedPidsRef.current.has(w.pid) ||
            lockedHwndsRef.current.has(w.hwnd) ||
            lockedNamesRef.current.has(w.process_name?.toLowerCase()) ||
            (w.parent_pid && lockedPidsRef.current.has(w.parent_pid))
          ) continue
          toUnhide.push(w.hwnd)
        }
      }

      setWindows((prev) => {
        const listMap = new Map(list.map((w) => [entryKey(w), w]))
        const prevKeys = new Set(prev.map((w) => entryKey(w)))

        // Update existing entries in original order, removing any that closed.
        // Use the UI's hidden state (p.hidden) rather than the OS state (live.hidden)
        // so our explicit choices are preserved and external WDA changes are ignored.
        const updated = prev.map((p) => {
          const live = listMap.get(entryKey(p))
          if (!live) return null // Window closed — remove
          return { ...live, hidden: p.hidden }
        }).filter(Boolean)

        const appendNew = list
          .filter((w) => !prevKeys.has(entryKey(w)))
          .map((w) => {
            const shouldHide =
              lockedPidsRef.current.has(w.pid) ||
              (!w.no_window && lockedHwndsRef.current.has(w.hwnd)) ||
              lockedNamesRef.current.has(w.process_name?.toLowerCase()) ||
              (w.parent_pid && lockedPidsRef.current.has(w.parent_pid))
            return { ...w, hidden: shouldHide }
          })

        return [...updated, ...appendNew]
      })

      // On session restore, restart the watcher for all restored process names
      // so new windows from those processes are auto-hidden immediately.
      if (isFirstLoad && lockedNamesRef.current.size > 0) {
        updateWatcher()
      }

       // Reset WDA on stale-hidden windows.  Fire-and-forget — the UI already
       // reflects hidden:false so the user sees a clean state immediately.
       // We do not unhide the window here to avoid visual flicker during refresh.
       // Instead, we rely on the fact that the window is not locked and will be
       // processed normally in the next poll or refresh.
       // Note: the window may remain hidden by WDA (from the OS) but we are not
       // locking it, so we do not want to hide it. The user may see it as not
       // hidden in the UI but it is not capturable until the WDA is reset by
       // a subsequent hide/unhide cycle (which happens when the window is
       // locked and then unlocked, or via the background poll).
       // For now, we skip the unhide to avoid flicker.
    } catch (err) {
      setError(err.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }, [updateWatcher])

  const refreshScreens = useCallback(async () => {
    try {
      const list = await api.getMonitors()
      if (Array.isArray(list) && list.length > 0) {
        setScreens(list)
        setCurrentScreen((prev) =>
          prev ? list.find((s) => s.id === prev.id) ?? list[0] : list[0],
        )
      }
    } catch {
      // getMonitors not available in plain browser dev — silently skip
    }
  }, [])

  useEffect(() => {
    refresh()
    refreshScreens()
    api.isElevated().then((ok) => setElevated(!!ok)).catch(() => {})
    api.getLaunchAtStartup?.().then((v) => setLaunchAtStartup(!!v)).catch(() => {})
  }, [refresh, refreshScreens])

  // Keep windowsRef in sync so updateWatcher can read current windows without deps
  useEffect(() => { windowsRef.current = windows }, [windows])

  // Keep themeRef in sync for use inside the stable system-theme change listener
  useEffect(() => { themeRef.current = theme }, [theme])

  // Keep hideDesktopRef in sync so the background poll can read the toggle state
  // for transient Task View / Alt-Tab overlay windows.
  useEffect(() => { hideDesktopRef.current = hideDesktop }, [hideDesktop])

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

   // Listen for app hidden/shown events to optimize resource usage
   useEffect(() => {
     const hiddenHandler = () => {
       // App is hidden to tray - we can reduce polling frequency or pause non-essential work
       console.log('[App] App hidden to tray')
       setIsAppVisible(false)
     }
     
     const shownHandler = () => {
       // App is shown from tray - resume normal operations
       console.log('[App] App shown from tray')
       setIsAppVisible(true)
     }
     
     const unsubscribeHidden = api.onAppHidden?.(hiddenHandler)
     const unsubscribeShown = api.onAppShown?.(shownHandler)
     
     return () => {
       unsubscribeHidden?.()
       unsubscribeShown?.()
     }
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

   // ---------------------------------------------------------------------------
   // Background poll — detects new windows and removes closed ones.
   // ---------------------------------------------------------------------------
   useEffect(() => {
     let pollActive = false
     let pollInterval = null
     
     const startPoll = (intervalMs) => {
       // Clear existing interval if any
       if (pollInterval) {
         clearInterval(pollInterval)
       }
       
       pollInterval = setInterval(async () => {
         // Skip if a previous poll is still running — prevents concurrent
          // ScreenShieldBackgroundService.exe requests from piling up under a slow system.
          if (pollActive) return
         pollActive = true
         try {
           const list = await api.listWindows()
           if (!Array.isArray(list)) return
 
           // Determine which new windows need hiding eagerly, before the React
           // state update, so the IPC calls fire promptly regardless of when
           // startTransition schedules the render.
           const toAutoHide = []
           const knownKeys = new Set(windowsRef.current.map((w) => entryKey(w)))
           for (const w of list) {
             if (w.no_window || knownKeys.has(entryKey(w))) continue
             if (
               lockedPidsRef.current.has(w.pid) ||
               lockedHwndsRef.current.has(w.hwnd) ||
               lockedNamesRef.current.has(w.process_name?.toLowerCase()) ||
               (w.parent_pid && lockedPidsRef.current.has(w.parent_pid))
             ) {
               toAutoHide.push(w.hwnd)
             }
           }
 
           // Task View / Alt-Tab overlay (MultitaskingViewFrame) is transient — it
           // only exists while Alt-Tab / Win-Tab is held.  It shares the DWM desktop
           // compositor layer, so its capture visibility is tied to the desktop toggle.
           // The poll catches it on each appearance and hides/unhides it accordingly.
           const toAutoUnhideAltTab = []
           for (const w of list) {
             if (w.class_name !== 'MultitaskingViewFrame') continue
             if (hideDesktopRef.current && !w.hidden) {
               toAutoHide.push(w.hwnd)
             } else if (!hideDesktopRef.current && w.hidden) {
               toAutoUnhideAltTab.push(w.hwnd)
             }
           }
 
           // Wrap the render update in startTransition so React can yield to
           // user interactions mid-render and avoid blocking the Windows message
           // queue (which would trigger the OS loading cursor).
           startTransition(() => {
             setWindows((prev) => {
               const listMap = new Map(list.map((w) => [entryKey(w), w]))
               const prevKeys = new Set(prev.map((w) => entryKey(w)))
               let anyChange = false
 
               // Update existing entries in their original order — preserves UI position.
               // Closed windows are always removed; the watcher re-hides them if they reopen.
               const updated = prev.map((p) => {
                 const live = listMap.get(entryKey(p))
                 if (!live) {
                   anyChange = true
                   return null // Window closed — remove from list
                 }
                 if (live.title !== p.title) anyChange = true
                 // Sync Task View / Alt-Tab overlay hidden state with the desktop
                 // toggle ref — the transient window may have been hidden in a prior
                 // cycle and must reflect the current toggle when it reappears.
                 const isAltTab = p.class_name === 'MultitaskingViewFrame'
                 const altTabHidden = isAltTab ? hideDesktopRef.current : p.hidden
                 if (isAltTab && altTabHidden !== p.hidden) anyChange = true
                 return { ...p, title: live.title, hidden: altTabHidden }
               }).filter(Boolean)
 
               // Append genuinely new windows (not seen in prev)
               const newWins = list.filter((w) => !prevKeys.has(entryKey(w)))
               if (newWins.length > 0) anyChange = true
 
               if (!anyChange) return prev
 
               return [
                 ...updated,
                 ...newWins.map((w) => {
                   const locked =
                     lockedPidsRef.current.has(w.pid) ||
                     (!w.no_window && lockedHwndsRef.current.has(w.hwnd)) ||
                     lockedNamesRef.current.has(w.process_name?.toLowerCase()) ||
                     (w.parent_pid && lockedPidsRef.current.has(w.parent_pid))
                   // Task View / Alt-Tab overlay: honour the desktop toggle via ref (transient window)
                   const isAltTab = w.class_name === 'MultitaskingViewFrame'
                   const shouldHide = !!locked || (isAltTab && hideDesktopRef.current)
                   return { ...w, hidden: shouldHide }
                 }),
               ]
             })
           })
 
           // Actually hide the new windows in the OS (fire-and-forget, outside
           // the transition so IPC calls are not deferred).
           for (const hwnd of toAutoHide) {
             api.hideWindow(hwnd, false).catch(() => {})
           }
           // Unhide Alt-Tab overlay windows when the toggle has been turned OFF.
           for (const hwnd of toAutoUnhideAltTab) {
             api.unhideWindow(hwnd, false).catch(() => {})
           }
         } catch {
           // silently ignore background poll errors
         } finally {
           pollActive = false
         }
       }, intervalMs)
     }
     
     // Adjust polling interval based on app visibility
     const intervalMs = isAppVisible ? 2000 : 10000 // 2s when visible, 10s when hidden
     
     // Start with appropriate interval
     startPoll(intervalMs)
     
     // Cleanup on unmount
     return () => {
       if (pollInterval) {
         clearInterval(pollInterval)
       }
     }
   }, [isAppVisible])

  // ---------------------------------------------------------------------------
  // Toggle a single window's hide state
  // ---------------------------------------------------------------------------
  const toggle = useCallback(
    async (win) => {
      // Process-only entries have no HWND — update lock state only.
      // The watcher will apply WDA when the process creates a window.
      if (win.no_window) {
        const shouldHide = !win.hidden
        if (shouldHide) {
          if (win.process_name) lockedNamesRef.current.add(win.process_name.toLowerCase())
          if (win.pid) lockedPidsRef.current.add(win.pid)
          updateWatcher()
        } else {
          if (win.process_name) lockedNamesRef.current.delete(win.process_name.toLowerCase())
          if (win.pid) lockedPidsRef.current.delete(win.pid)
          updateWatcher()
        }
        setWindows((prev) =>
          prev.map((w) =>
            w.no_window && w.pid === win.pid ? { ...w, hidden: shouldHide } : w,
          ),
        )
        return
      }

      try {
        const shouldHide = !win.hidden
        if (shouldHide) {
          await api.hideWindow(win.hwnd, false)
          lockedHwndsRef.current.add(win.hwnd)
          // Individual hide locks only this specific HWND — do NOT add to
          // lockedNamesRef or call updateWatcher.  Adding the process name here
          // caused every future window from the same process to be auto-hidden
          // even when the user only intended to hide one specific window.
        } else {
          await api.unhideWindow(win.hwnd, false)
          lockedHwndsRef.current.delete(win.hwnd)
          // Stop watching this process name if no other windows from it are locked
          if (win.process_name) {
            const name = win.process_name.toLowerCase()
            const pidLocked = windows.some(
              (w) => w.process_name?.toLowerCase() === name && lockedPidsRef.current.has(w.pid),
            )
            if (!pidLocked) {
              const hwndLocked = windows.some(
                (w) => w.hwnd !== win.hwnd && w.process_name?.toLowerCase() === name && lockedHwndsRef.current.has(w.hwnd),
              )
              if (!hwndLocked) {
                lockedNamesRef.current.delete(name)
                updateWatcher()
              }
            }
          }
        }
        setWindows((prev) =>
          prev.map((w) => (w.hwnd === win.hwnd ? { ...w, hidden: shouldHide } : w)),
        )
      } catch (err) {
        setError(err.message ?? String(err))
      }
    },
    [updateWatcher, windows],
  )

  // ---------------------------------------------------------------------------
  // Set all windows belonging to a PID to a specific hidden state.
  // Also tracks the process name so future windows from the same name are caught.
  // ---------------------------------------------------------------------------
  const setGroup = useCallback(
    async (pid, hide) => {
      // Process-only entries (no_window) have no HWND; only real windows get
      // the hide/unhide IPC call.  Lock-state updates below still cover the
      // whole group so future windows from tray-ed processes are protected.
      const processName = windows.find((w) => w.pid === pid)?.process_name?.toLowerCase()
      // explorer.exe is the Windows shell — every user-launched process has it
      // as parent_pid.  Skip parent-PID matching for it so hiding File Explorer
      // windows does not sweep unrelated apps.
      const isShellHost = processName === 'explorer.exe'
      const targets = windows.filter(
        (w) => !w.no_window && !isProgMan(w) && !isTaskbarWin(w) && !isAltTabWin(w) &&
          (w.pid === pid || (!isShellHost && w.parent_pid === pid)) &&
          w.hidden !== hide,
      )
      try {
        await Promise.all(
          targets.map((w) =>
            hide
              ? api.hideWindow(w.hwnd, false)
              : api.unhideWindow(w.hwnd, false),
          ),
        )
        setWindows((prev) =>
          prev.map((w) =>
            !isProgMan(w) && !isTaskbarWin(w) && !isAltTabWin(w) &&
            (w.pid === pid || (!isShellHost && w.parent_pid === pid))
              ? { ...w, hidden: hide } : w,
          ),
        )

        if (hide) {
          lockedPidsRef.current.add(pid)
          if (processName) lockedNamesRef.current.add(processName)
        } else {
          lockedPidsRef.current.delete(pid)
          if (processName) lockedNamesRef.current.delete(processName)
          // Also remove any individually-locked HWNDs for this PID
          for (const w of windows.filter((win) => win.pid === pid)) {
            lockedHwndsRef.current.delete(w.hwnd)
          }
        }

        updateWatcher()
      } catch (err) {
        setError(err.message ?? String(err))
      }
    },
    [windows, updateWatcher],
  )

  // ---------------------------------------------------------------------------
  // Program Manager = the desktop background; filter from the main window list
  // ---------------------------------------------------------------------------
  const isProgMan = (w) =>
    w.process_name?.toLowerCase() === 'explorer.exe' && w.title === 'Program Manager'

  // Taskbar windows (primary + per-monitor secondary); filtered from main list
  const isTaskbarWin = (w) =>
    w.class_name === 'Shell_TrayWnd' || w.class_name === 'Shell_SecondaryTrayWnd'

  // Alt+Tab overlay window; filtered from main list
  const isAltTabWin = (w) =>
    w.class_name === 'MultitaskingViewFrame'

  const toggleHideDesktop = useCallback(
    async (checked) => {
      setHideDesktop(checked)
      // Target both the desktop background (Program Manager) and any currently-visible
      // Task View / Alt-Tab overlay (MultitaskingViewFrame).  Task View is rendered
      // within the DWM desktop compositor layer, so its capture visibility is
      // inherently tied to the desktop surface.
      const targets = windows.filter((w) => isProgMan(w) || isAltTabWin(w))
      try {
        await Promise.all(
          targets.map((w) =>
            checked
              ? api.hideWindow(w.hwnd, false)
              : api.unhideWindow(w.hwnd, false),
          ),
        )
        setWindows((prev) =>
          prev.map((w) => (isProgMan(w) || isAltTabWin(w) ? { ...w, hidden: checked } : w)),
        )
        if (checked) targets.forEach((w) => lockedHwndsRef.current.add(w.hwnd))
        else targets.forEach((w) => lockedHwndsRef.current.delete(w.hwnd))
      } catch (err) {
        setError(err.message ?? String(err))
      }
    },
    [windows],
  )

  const toggleHideTaskbar = useCallback(
    async (checked) => {
      setHideTaskbar(checked)
      const targets = windows.filter(isTaskbarWin)
      try {
        await Promise.all(
          targets.map((w) =>
            checked
              ? api.hideWindow(w.hwnd, false)
              : api.unhideWindow(w.hwnd, false),
          ),
        )
        setWindows((prev) =>
          prev.map((w) => (isTaskbarWin(w) ? { ...w, hidden: checked } : w)),
        )
        if (checked) targets.forEach((w) => lockedHwndsRef.current.add(w.hwnd))
        else targets.forEach((w) => lockedHwndsRef.current.delete(w.hwnd))
      } catch (err) {
        setError(err.message ?? String(err))
      }
    },
    [windows],
  )

  // Exclude Program Manager, taskbar, and Alt+Tab overlay from the main window list —
  // they are controlled via the Advanced panel toggles, not the per-app eye buttons.
  const visibleWindows = windows.filter((w) => !isProgMan(w) && !isTaskbarWin(w) && !isAltTabWin(w))
  // Count only real (non-placeholder) user-facing windows that are actively hidden.
  // Excludes no_window tray placeholders and the desktop (ProgMan) so the number
  // reflects exactly what the user can see toggled in the UI.
  const hiddenCount = visibleWindows.filter((w) => w.hidden && !w.no_window).length

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
            <div className="advanced-header" onClick={() => setAdvancedOpen((o) => !o)}>
              <svg
                className={`advanced-chevron${advancedOpen ? ' is-open' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Advanced
            </div>
            {advancedOpen && (
              <div className="advanced-body">
                <label className="advanced-option">
                  <input
                    type="checkbox"
                    checked={hideDesktop}
                    onChange={(e) => toggleHideDesktop(e.target.checked)}
                  />
                  <span className="advanced-option-label">
                    Hide desktop background and Task View from screen capture
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
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── Footer: status bar ────────────────────────────────── */}
      <StatusBar hiddenCount={hiddenCount} hideDesktop={hideDesktop} hideTaskbar={hideTaskbar} />

      {/* ── Settings overlay ──────────────────────────────────── */}
      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <span className="settings-title">Settings</span>
              <button className="settings-close-btn" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="settings-body">
              <p className="settings-section-label">Theme</p>
              <div className="theme-options">
                {[
                  { id: 'default', label: 'Default', desc: 'Black & red' },
                  { id: 'dark',    label: 'Dark',    desc: 'Neutral dark, blue accent' },
                  { id: 'light',   label: 'Light',   desc: 'Light mode' },
                  { id: 'system',  label: 'System',  desc: 'Follows Windows theme & accent colour' },
                ].map(({ id, label, desc }) => (
                  <button
                    key={id}
                    className={`theme-option-btn${theme === id ? ' active' : ''}`}
                    onClick={() => setTheme(id)}
                  >
                    <span className={`theme-option-swatch theme-swatch-${id}`} />
                    <span className="theme-option-text">
                      <span className="theme-option-name">{label}</span>
                      <span className="theme-option-desc">{desc}</span>
                    </span>
                    {theme === id && (
                      <svg className="theme-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <div className="settings-startup-section">
                <p className="settings-section-label">Startup</p>
                <label className="settings-toggle-label">
                  <input
                    type="checkbox"
                    className="settings-toggle-checkbox"
                    checked={launchAtStartup}
                    onChange={async (e) => {
                      const enabled = e.target.checked
                      setLaunchAtStartup(enabled)
                      try {
                        const result = await api.setLaunchAtStartup?.(enabled)
                        if (result && !result.success) {
                          // Revert the toggle only if the operation was confirmed to have failed
                          setLaunchAtStartup(!enabled)
                          console.error('Failed to update startup setting:', result.error)
                        }
                      } catch (error) {
                        // Revert the toggle only if the operation was confirmed to have failed
                        setLaunchAtStartup(!enabled)
                        console.error('Failed to update startup setting:', error)
                      }
                    }}
                  />
                  <span className="settings-toggle-text">Launch ScreenShield on Windows startup</span>
                </label>
              </div>
              <div className="settings-reset-section">
                <p className="settings-section-label">Reset</p>
                <button
                  className="settings-reset-btn"
                  onClick={async () => {
                    // Restore every hidden window in the OS before wiping state
                    const toUnhide = windows.filter((w) => !w.no_window && w.hidden)
                    await Promise.allSettled(toUnhide.map((w) => api.unhideWindow(w.hwnd, false)))
                    // Stop the auto-hide watcher so no window is re-hidden after reload
                    api.stopWatch?.().catch(() => {})
                    // Delete on-disk config; onResetSettings listener clears localStorage and reloads
                    api.resetSettings?.().catch(() => {
                      localStorage.removeItem('ss-setup-done')
                      localStorage.removeItem('ss-theme')
                      window.location.reload()
                    })
                  }}
                >
                  Reset
                </button>
                <p className="settings-reset-note">Restores all hidden windows, stops the auto-hide watcher, clears saved preferences, and re-shows the setup screen on next load.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── First-launch setup overlay ─────────────────────────── */}
      {firstLaunch && (
        <div className="setup-overlay">
          <div className="setup-container">
            {logoSrc && <img className="setup-logo" src={logoSrc} alt="Screen Shield" />}
            <p className="setup-brand">SCREEN SHIELD</p>
            <p className="setup-heading">Choose your theme</p>
            <p className="setup-sub">You can change this later from the settings icon.</p>
            <div className="setup-theme-grid">
              {[
                { id: 'default', label: 'Default', desc: 'Black & red' },
                { id: 'dark',    label: 'Dark',    desc: 'Neutral dark' },
                { id: 'light',   label: 'Light',   desc: 'Light mode' },
                { id: 'system',  label: 'System',  desc: 'Follows Windows' },
              ].map(({ id, label, desc }) => (
                <button
                  key={id}
                  className={`setup-theme-btn${theme === id ? ' active' : ''}`}
                  onClick={() => setTheme(id)}
                >
                  <span className={`theme-option-swatch theme-swatch-${id}`} />
                  <span className="setup-theme-btn-text">
                    <span className="setup-theme-btn-name">{label}</span>
                    <span className="setup-theme-btn-desc">{desc}</span>
                  </span>
                  {theme === id && (
                    <svg className="theme-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            <button className="setup-get-started-btn" onClick={handleSetupComplete}>
              Get Started
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
