import { useCallback, useEffect, useRef, useState, startTransition } from 'react'

const entryKey = (window) => (window.no_window ? -window.pid : window.hwnd)
const isProgMan = (window) =>
  window.process_name?.toLowerCase() === 'explorer.exe' && window.title === 'Program Manager'
const isTaskbarWin = (window) =>
  window.class_name === 'Shell_TrayWnd' || window.class_name === 'Shell_SecondaryTrayWnd'
const isAltTabWin = (window) => window.class_name === 'XamlExplorerHostIslandWindow'

export default function useWindowManager(api, setLaunchAtStartup) {
  const [windows, setWindows] = useState([])
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const [error, setError] = useState(null)
  const [elevated, setElevated] = useState(true)
  const [isAppVisible, setIsAppVisible] = useState(true)
  const [screens, setScreens] = useState([])
  const [currentScreen, setCurrentScreen] = useState(null)
  const [hideDesktop, setHideDesktop] = useState(false)
  const [hideTaskbar, setHideTaskbar] = useState(false)
  const [hideTaskView, setHideTaskView] = useState(false)

  const lockedPidsRef = useRef(new Set())
  const lockedHwndsRef = useRef(new Set())
  const lockedNamesRef = useRef(new Set())
  const windowsRef = useRef([])
  const hideDesktopRef = useRef(false)
  const hideTaskViewRef = useRef(false)

  const updateWatcher = useCallback(() => {
    const names = new Set([...lockedNamesRef.current])
    const processNameByPid = new Map()
    for (const window of windowsRef.current) {
      if (window.pid && window.process_name && !processNameByPid.has(window.pid)) {
        processNameByPid.set(window.pid, window.process_name.toLowerCase())
      }
    }

    const cascadePids = new Set()
    for (const pid of lockedPidsRef.current) {
      const name = processNameByPid.get(pid)
      if (name && name !== 'explorer.exe') cascadePids.add(pid)
    }

    for (const window of windowsRef.current) {
      if (!window.process_name) continue
      const name = window.process_name.toLowerCase()
      if (
        lockedPidsRef.current.has(window.pid) ||
        (window.parent_pid && cascadePids.has(window.parent_pid)) ||
        lockedNamesRef.current.has(name)
      ) {
        names.add(name)
      }
    }

    const nameList = [...names]
    if (nameList.length > 0) api.startWatch?.(nameList).catch(() => {})
    else api.stopWatch?.().catch(() => {})
  }, [api])

  const refresh = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError(null)
    try {
      const list = await api.listWindows()
      if (!Array.isArray(list)) {
        setWindows([])
        return
      }

      const isFirstLoad = windowsRef.current.length === 0
      if (isFirstLoad) {
        try {
          const persisted = await api.getHiddenProcesses?.() ?? []
          for (const process of persisted) {
            if (process.name) lockedNamesRef.current.add(process.name.toLowerCase())
          }
        } catch { /* non-fatal */ }

        let desktopWasHidden = false
        let taskbarWasHidden = false
        for (const window of list) {
          if (window.no_window || !window.hidden || window.hidden_by === 'system') continue
          const isShell = window.process_name?.toLowerCase() === 'explorer.exe'
          if (!isShell && window.pid) lockedPidsRef.current.add(window.pid)
          if (!isShell && window.hwnd) lockedHwndsRef.current.add(window.hwnd)
          if (!isShell && window.process_name) lockedNamesRef.current.add(window.process_name.toLowerCase())
          if (isShell && window.title === 'Program Manager') desktopWasHidden = true
          if (isShell && isTaskbarWin(window)) taskbarWasHidden = true
          if (isShell && isAltTabWin(window)) desktopWasHidden = true
        }
        if (desktopWasHidden) setHideDesktop(true)
        if (taskbarWasHidden) setHideTaskbar(true)
      }

      setWindows((previous) => {
        const windowsByKey = new Map(list.map((window) => [entryKey(window), window]))
        const previousKeys = new Set(previous.map(entryKey))
        const updated = previous.map((oldWindow) => {
          const liveWindow = windowsByKey.get(entryKey(oldWindow))
          if (!liveWindow) return null
          const hiddenBy = liveWindow.hidden_by ?? null
          const hidden = hiddenBy === 'system'
            ? true
            : oldWindow.hidden_by === 'system'
              ? liveWindow.hidden
              : oldWindow.hidden
          return { ...liveWindow, hidden, hidden_by: hiddenBy }
        }).filter(Boolean)

        const newWindows = list
          .filter((window) => !previousKeys.has(entryKey(window)))
          .map((window) => {
            if (window.hidden_by === 'system') return { ...window, hidden: true }
            const shouldHide =
              lockedPidsRef.current.has(window.pid) ||
              (!window.no_window && lockedHwndsRef.current.has(window.hwnd)) ||
              lockedNamesRef.current.has(window.process_name?.toLowerCase()) ||
              (window.parent_pid && lockedPidsRef.current.has(window.parent_pid))
            return { ...window, hidden: !!shouldHide }
          })

        return [...updated, ...newWindows]
      })

      if (isFirstLoad && lockedNamesRef.current.size > 0) updateWatcher()
    } catch (refreshError) {
      setError(refreshError.message ?? String(refreshError))
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [api, updateWatcher])

  const refreshScreens = useCallback(async () => {
    try {
      const list = await api.getMonitors()
      if (Array.isArray(list) && list.length > 0) {
        setScreens(list)
        setCurrentScreen((previous) =>
          previous ? list.find((screen) => screen.id === previous.id) ?? list[0] : list[0],
        )
      }
    } catch {
      // Monitor enumeration is unavailable in plain-browser development.
    }
  }, [api])

  useEffect(() => {
    refresh()
    refreshScreens()
    api.isElevated().then((value) => setElevated(!!value)).catch(() => {})
    api.getLaunchAtStartup?.().then((value) => setLaunchAtStartup(!!value)).catch(() => {})
  }, [api, refresh, refreshScreens, setLaunchAtStartup])

  useEffect(() => { windowsRef.current = windows }, [windows])
  useEffect(() => { hideDesktopRef.current = hideDesktop }, [hideDesktop])
  useEffect(() => { hideTaskViewRef.current = hideTaskView }, [hideTaskView])

  useEffect(() => {
    const unsubscribeHidden = api.onAppHidden?.(() => setIsAppVisible(false))
    const unsubscribeShown = api.onAppShown?.(() => setIsAppVisible(true))
    return () => {
      unsubscribeHidden?.()
      unsubscribeShown?.()
    }
  }, [api])

  useEffect(() => {
    let pollActive = false
    const pollInterval = setInterval(async () => {
      if (pollActive) return
      pollActive = true
      try {
        const list = await api.listWindows()
        if (!Array.isArray(list)) return

        const autoHide = []
        const knownKeys = new Set(windowsRef.current.map(entryKey))
        for (const window of list) {
          if (window.no_window || knownKeys.has(entryKey(window)) || window.hidden_by === 'system') continue
          if (
            lockedPidsRef.current.has(window.pid) ||
            lockedHwndsRef.current.has(window.hwnd) ||
            lockedNamesRef.current.has(window.process_name?.toLowerCase()) ||
            (window.parent_pid && lockedPidsRef.current.has(window.parent_pid))
          ) {
            autoHide.push(window.hwnd)
          }
        }

        const autoUnhideDesktop = []
        for (const window of list) {
          if (!isProgMan(window)) continue
          if (hideDesktopRef.current && !window.hidden) autoHide.push(window.hwnd)
          else if (!hideDesktopRef.current && window.hidden) autoUnhideDesktop.push(window.hwnd)
        }

        const autoUnhideTaskView = []
        for (const window of list) {
          if (!isAltTabWin(window)) continue
          if (hideTaskViewRef.current && !window.hidden) autoHide.push(window.hwnd)
          else if (!hideTaskViewRef.current && window.hidden) autoUnhideTaskView.push(window.hwnd)
        }

        startTransition(() => {
          setWindows((previous) => {
            const windowsByKey = new Map(list.map((window) => [entryKey(window), window]))
            const previousKeys = new Set(previous.map(entryKey))
            let changed = false
            const updated = previous.map((oldWindow) => {
              const liveWindow = windowsByKey.get(entryKey(oldWindow))
              if (!liveWindow) {
                changed = true
                return null
              }
              if (liveWindow.title !== oldWindow.title) changed = true
              const hiddenBy = liveWindow.hidden_by ?? null
              if (hiddenBy !== oldWindow.hidden_by) changed = true
              const isDesktop = isProgMan(oldWindow)
              const isTaskView = isAltTabWin(oldWindow)
              let hidden = oldWindow.hidden_by === 'system' && hiddenBy !== 'system'
                ? liveWindow.hidden
                : oldWindow.hidden
              if (isDesktop) hidden = hideDesktopRef.current
              else if (isTaskView) hidden = hideTaskViewRef.current
              if (hiddenBy === 'system') hidden = true
              if ((isDesktop || isTaskView) && hidden !== oldWindow.hidden) changed = true
              return { ...oldWindow, title: liveWindow.title, hidden, hidden_by: hiddenBy }
            }).filter(Boolean)

            const newWindows = list.filter((window) => !previousKeys.has(entryKey(window)))
            if (newWindows.length > 0) changed = true
            if (!changed) return previous

            return [
              ...updated,
              ...newWindows.map((window) => {
                if (window.hidden_by === 'system') return { ...window, hidden: true }
                const locked =
                  lockedPidsRef.current.has(window.pid) ||
                  (!window.no_window && lockedHwndsRef.current.has(window.hwnd)) ||
                  lockedNamesRef.current.has(window.process_name?.toLowerCase()) ||
                  (window.parent_pid && lockedPidsRef.current.has(window.parent_pid))
                return {
                  ...window,
                  hidden: !!locked || (isProgMan(window) && hideDesktopRef.current) ||
                    (isAltTabWin(window) && hideTaskViewRef.current),
                }
              }),
            ]
          })
        })

        for (const hwnd of autoHide) api.hideWindow(hwnd, false).catch(() => {})
        for (const hwnd of autoUnhideDesktop) api.unhideWindow(hwnd, false).catch(() => {})
        for (const hwnd of autoUnhideTaskView) api.unhideWindow(hwnd, false).catch(() => {})
      } catch {
        // Background polling is best-effort.
      } finally {
        pollActive = false
      }
    }, isAppVisible ? 2000 : 10000)

    return () => clearInterval(pollInterval)
  }, [api, isAppVisible])

  const toggle = useCallback(async (window) => {
    if (window.no_window) {
      const shouldHide = !window.hidden
      if (shouldHide) {
        if (window.process_name) lockedNamesRef.current.add(window.process_name.toLowerCase())
        if (window.pid) lockedPidsRef.current.add(window.pid)
      } else {
        if (window.process_name) lockedNamesRef.current.delete(window.process_name.toLowerCase())
        if (window.pid) lockedPidsRef.current.delete(window.pid)
      }
      updateWatcher()
      setWindows((previous) => previous.map((entry) =>
        entry.no_window && entry.pid === window.pid ? { ...entry, hidden: shouldHide } : entry,
      ))
      return
    }

    const shouldHide = !window.hidden
    try {
      const result = shouldHide
        ? await api.hideWindow(window.hwnd, false)
        : await api.unhideWindow(window.hwnd, false)
      if (!result.success) {
        setError(`Failed to ${shouldHide ? 'hide' : 'unhide'} window: ${result.error}`)
        return
      }
      if (shouldHide) {
        lockedHwndsRef.current.add(window.hwnd)
      } else {
        lockedHwndsRef.current.delete(window.hwnd)
        if (window.process_name) {
          const name = window.process_name.toLowerCase()
          const pidLocked = windows.some((entry) =>
            entry.process_name?.toLowerCase() === name && lockedPidsRef.current.has(entry.pid),
          )
          const hwndLocked = windows.some((entry) =>
            entry.hwnd !== window.hwnd && entry.process_name?.toLowerCase() === name &&
            lockedHwndsRef.current.has(entry.hwnd),
          )
          if (!pidLocked && !hwndLocked) {
            lockedNamesRef.current.delete(name)
            updateWatcher()
          }
        }
      }
      setWindows((previous) => previous.map((entry) =>
        entry.hwnd === window.hwnd ? { ...entry, hidden: shouldHide } : entry,
      ))
    } catch (toggleError) {
      setError(toggleError.message ?? String(toggleError))
    }
  }, [api, updateWatcher, windows])

  const setGroup = useCallback(async (pid, hide) => {
    const processName = windows.find((window) => window.pid === pid)?.process_name?.toLowerCase()
    const isShellHost = processName === 'explorer.exe'
    const belongsToGroup = (window) =>
      window.pid === pid || (!isShellHost && window.parent_pid === pid)
    const targets = windows.filter((window) =>
      !window.no_window && !isProgMan(window) && !isTaskbarWin(window) && !isAltTabWin(window) &&
      belongsToGroup(window) && window.hidden !== hide,
    )

    try {
      const results = await Promise.all(targets.map((window) =>
        hide ? api.hideWindow(window.hwnd, false) : api.unhideWindow(window.hwnd, false),
      ))
      const failed = results.find((result) => !result.success)
      if (failed) {
        setError(`Failed to ${hide ? 'hide' : 'unhide'} process windows: ${failed.error}`)
        return
      }

      setWindows((previous) => previous.map((window) =>
        !isProgMan(window) && !isTaskbarWin(window) && !isAltTabWin(window) && belongsToGroup(window)
          ? { ...window, hidden: hide }
          : window,
      ))

      if (hide) {
        lockedPidsRef.current.add(pid)
        if (processName) {
          lockedNamesRef.current.add(processName)
          if (!isShellHost) api.addHiddenProcess?.(processName).catch(() => {})
        }
      } else {
        lockedPidsRef.current.delete(pid)
        if (processName) {
          lockedNamesRef.current.delete(processName)
          if (!isShellHost) api.removeHiddenProcess?.(processName).catch(() => {})
        }
        for (const window of windows) {
          if (window.pid === pid) lockedHwndsRef.current.delete(window.hwnd)
        }
      }
      updateWatcher()
    } catch (groupError) {
      setError(groupError.message ?? String(groupError))
    }
  }, [api, updateWatcher, windows])

  const toggleHideDesktop = useCallback(async (checked) => {
    setHideDesktop(checked)
    const targets = windows.filter(isProgMan)
    try {
      const results = await Promise.all(targets.map((window) =>
        checked ? api.hideWindow(window.hwnd, false) : api.unhideWindow(window.hwnd, false),
      ))
      const failed = results.find((result) => !result.success)
      if (failed) {
        setError(`Failed to ${checked ? 'hide' : 'unhide'} desktop: ${failed.error}`)
        return
      }
      setWindows((previous) => previous.map((window) =>
        isProgMan(window) ? { ...window, hidden: checked } : window,
      ))
      for (const window of targets) {
        if (checked) lockedHwndsRef.current.add(window.hwnd)
        else lockedHwndsRef.current.delete(window.hwnd)
      }
    } catch (toggleError) {
      setError(toggleError.message ?? String(toggleError))
    }
  }, [api, windows])

  const toggleHideTaskView = useCallback(async (checked) => {
    setHideTaskView(checked)
    try {
      const result = await api.enableExplorerHook(checked)
      if (result && !result.success) {
        setError(`Failed to ${checked ? 'enable' : 'disable'} Task View hiding: ${result.error}`)
        return
      }
      const targets = windows.filter(isAltTabWin)
      await Promise.all(targets.map((window) =>
        checked ? api.hideWindow(window.hwnd, false) : api.unhideWindow(window.hwnd, false),
      ))
      setWindows((previous) => previous.map((window) =>
        isAltTabWin(window) ? { ...window, hidden: checked } : window,
      ))
    } catch (toggleError) {
      setError(toggleError.message ?? String(toggleError))
    }
  }, [api, windows])

  const toggleHideTaskbar = useCallback(async (checked) => {
    setHideTaskbar(checked)
    const targets = windows.filter(isTaskbarWin)
    try {
      const results = await Promise.all(targets.map((window) =>
        checked ? api.hideWindow(window.hwnd, false) : api.unhideWindow(window.hwnd, false),
      ))
      const failed = results.find((result) => !result.success)
      if (failed) {
        setError(`Failed to ${checked ? 'hide' : 'unhide'} taskbar: ${failed.error}`)
        return
      }
      setWindows((previous) => previous.map((window) =>
        isTaskbarWin(window) ? { ...window, hidden: checked } : window,
      ))
      for (const window of targets) {
        if (checked) lockedHwndsRef.current.add(window.hwnd)
        else lockedHwndsRef.current.delete(window.hwnd)
      }
    } catch (toggleError) {
      setError(toggleError.message ?? String(toggleError))
    }
  }, [api, windows])

  const visibleWindows = windows.filter((window) =>
    !isProgMan(window) && !isTaskbarWin(window) && !isAltTabWin(window),
  )
  const hiddenCount = visibleWindows.filter((window) => window.hidden && !window.no_window).length

  return {
    windows,
    setWindows,
    loading,
    error,
    elevated,
    isAppVisible,
    screens,
    currentScreen,
    setCurrentScreen,
    hideDesktop,
    hideTaskbar,
    hideTaskView,
    refresh,
    toggle,
    setGroup,
    toggleHideDesktop,
    toggleHideTaskView,
    toggleHideTaskbar,
    visibleWindows,
    hiddenCount,
  }
}