#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::{
    Foundation::{HMODULE, HWND, LPARAM, TRUE},
    Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE},
    System::{
        LibraryLoader::{
            GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        },
        Threading::GetCurrentProcessId,
    },
    UI::{
        Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
        WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowDisplayAffinity, GetWindowLongW,
            IsWindow, SetWindowDisplayAffinity, SetWindowLongW,
            SetWindowPos, GWL_EXSTYLE, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOMOVE,
            SWP_NOSIZE, SWP_NOZORDER, WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WS_CHILD,
            WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_VISIBLE,
        },
    },
};

/// Append a diagnostic line to %TEMP%\screenshield-hook.log.
/// Runs inside explorer.exe where stderr is not visible.
fn debug_log(msg: &str) {
    use std::io::Write;
    if let Ok(tmp) = std::env::var("TEMP") {
        let path = std::path::Path::new(&tmp).join("screenshield-hook.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "[SS-Hook] {}", msg);
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn SetWindowVisibility(hwnd: HWND, hide: bool) -> bool {
    let dwaffinity = if hide {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    let result = unsafe { SetWindowDisplayAffinity(hwnd, dwaffinity) };
    let success = !result.is_err();
    eprintln!(
        "[SS] SetWindowDisplayAffinity hwnd={:#010x} hide={} success={}",
        hwnd.0 as u32, hide, success
    );
    if !success {
        eprintln!(
            "[SS] SetWindowDisplayAffinity failed with error: {:?}",
            result.err()
        );
    }
    return success;
}

#[unsafe(no_mangle)]
pub extern "system" fn HideFromTaskbar(hwnd: HWND, hide: bool) -> bool {
    let mut style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    if style == 0 {
        return false;
    }
    if hide {
        style |= WS_EX_TOOLWINDOW.0 as i32;
        style &= (!WS_EX_APPWINDOW.0) as i32;
    } else {
        style |= WS_EX_APPWINDOW.0 as i32;
        style &= (!WS_EX_TOOLWINDOW.0) as i32;
    }
    unsafe { SetWindowLongW(hwnd, GWL_EXSTYLE, style) };
    // Flush the style change — without this Win32 may not update Alt+Tab / taskbar state
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        )
    };
    true
}

// ── In-process WinEvent hook ──────────────────────────────────────────────────
//
// Once utils.dll is injected into a target process, calling EnableAutoHide(true)
// registers a WINEVENT_INCONTEXT hook for EVENT_OBJECT_CREATE..EVENT_OBJECT_LOCATIONCHANGE
// in that process.
//
// WINEVENT_INCONTEXT fires synchronously on the thread that calls CreateWindowEx /
// ShowWindow / SetWindowPos — before each function returns, and therefore before
// DWM composites the window's first frame.  This eliminates the OUTOFCONTEXT
// delivery latency (~10–50 ms) that caused the brief visible flash in screen
// capture.
//
// The expanded event range (CREATE through LOCATIONCHANGE) ensures that windows
// which move or resize — e.g. during Chrome tab detach drags — are continuously
// verified for WDA protection.  Only CREATE and SHOW receive full cloaking;
// other events perform a lightweight WDA re-verify.

const EVENT_OBJECT_CREATE: u32 = 0x8000;
const EVENT_OBJECT_SHOW: u32 = 0x8002;
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;

/// DWMWA_CLOAK (value 13) — cloaks a window so DWM hides it from composition
/// on the next cycle (<1 ms).  Used at CREATE time (and at SHOW time when WDA
/// hasn't propagated yet) to bridge the 1–3 frame gap while
/// WDA_EXCLUDEFROMCAPTURE propagates.  The in-process uncloak thread removes
/// the cloak after verifying WDA is active.
const DWMWA_CLOAK: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(13);

/// true  while the in-process hook is running; controls the keep-alive loop.
static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Raw HWINEVENTHOOK pointer stored as usize for lock-free atomic access.
static HOOK_HANDLE: AtomicUsize = AtomicUsize::new(0);
/// When true, the in-process hook only applies WDA to windows whose class
/// matches a hardcoded whitelist (currently just `MultitaskingViewFrame`).
/// Used for explorer.exe where the blanket hook would hide system UI.
static EXPLORER_MODE: AtomicBool = AtomicBool::new(false);

/// Check whether WDA_EXCLUDEFROMCAPTURE is active on the given window.
unsafe fn is_wda_active(hwnd: HWND) -> bool {
    let mut affinity: u32 = 0;
    unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.is_ok()
        && affinity == WDA_EXCLUDEFROMCAPTURE.0
}

/// DWM-cloak a window and spawn a background thread to uncloak it once WDA
/// has propagated.  The uncloak thread verifies WDA is active before removing
/// the cloak — if WDA hasn't propagated after the initial 80 ms wait, it
/// retries up to 3 times (20 ms apart) before uncloaking unconditionally.
unsafe fn cloak_and_schedule_uncloak(hwnd: HWND) {
    let cloak_val: u32 = 1;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CLOAK,
            &cloak_val as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
    };

    let hwnd_raw = hwnd.0 as usize;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        let hwnd = HWND(hwnd_raw as *mut _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return;
        }
        // Verify WDA has propagated before uncloaking.  If not, retry a few
        // times — WDA typically propagates within 3 DWM cycles (~50 ms at
        // 60 Hz), but under heavy GPU load it may take longer.
        if !unsafe { is_wda_active(hwnd) } {
            for _ in 0..3 {
                std::thread::sleep(Duration::from_millis(20));
                if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                    return;
                }
                if unsafe { is_wda_active(hwnd) } {
                    break;
                }
            }
        }
        let uncloak_val: u32 = 0;
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CLOAK,
                &uncloak_val as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            )
        };
    });
}

/// In-process WinEvent hook procedure.
/// Fires synchronously on every CREATE / SHOW / LOCATIONCHANGE event within
/// this process — i.e. on the same thread as the CreateWindowEx / ShowWindow /
/// SetWindowPos call, before it returns.
///
/// CREATE and SHOW receive full handling (WDA + DWM cloak + scheduled uncloak).
/// All other events in the range perform a lightweight WDA re-verify, catching
/// any case where WDA is lost during drag/resize operations.
unsafe extern "system" fn in_process_hook(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _id_thread: u32,
    _time: u32,
) {
    if id_object != 0 || id_child != 0 {
        return;
    }
    if hwnd.0.is_null() {
        return;
    }
    // Skip child windows — SetWindowDisplayAffinity only works on top-level
    // windows, and WDA on the parent already excludes all child content from
    // capture.  Processing child HWNDs (e.g. Chrome's internal rendering
    // surfaces) is unnecessary and can trigger the out-of-context watcher to
    // move them off-screen, causing transparent/unpainted parent windows.
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
    if style & WS_CHILD.0 as i32 != 0 {
        return;
    }
    // Get the window class for filtering decisions.
    let mut class_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    if class_len > 0 {
        let class = String::from_utf16_lossy(&class_buf[..class_len as usize]);
        if EXPLORER_MODE.load(Ordering::Relaxed) {
            // Explorer mode: ONLY process XamlExplorerHostIslandWindow (Task View /
            // Alt-Tab overlay).  Skip everything else so File Explorer windows,
            // taskbar popups, notification areas, etc. are unaffected.
            // Note: Windows 11 uses XamlExplorerHostIslandWindow (not the older
            // MultitaskingViewFrame from Windows 10).  The _WASDK variant is a
            // different control and must be excluded.
            if class.as_str() == "XamlExplorerHostIslandWindow" {
                debug_log(&format!(
                    "HOOK HIT: XamlExplorerHostIslandWindow hwnd={:#010x} event={:#x} style={:#x}",
                    hwnd.0 as u32, event, style
                ));
            } else {
                return;
            }
        } else {
            // Normal mode: skip system shell windows that must never be
            // capture-excluded.  Hiding Progman or WorkerW blacks out the
            // desktop; Shell_TrayWnd is the taskbar.
            if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
                return;
            }
        }
    } else if EXPLORER_MODE.load(Ordering::Relaxed) {
        // Explorer mode but we couldn't read the class — skip to be safe.
        return;
    }
    // On SHOW events, verify the window is actually becoming visible before
    // applying capture exclusion — mirrors the C example in the design doc.
    if event == EVENT_OBJECT_SHOW && style & WS_VISIBLE.0 as i32 == 0 {
        return;
    }

    // ── Events other than CREATE / SHOW ─────────────────────────────────
    // For LOCATIONCHANGE, REORDER, STATECHANGE, etc.: lightweight WDA
    // re-verify.  During Chrome tab-drag operations LOCATIONCHANGE fires on
    // every pixel of movement; if WDA was somehow lost, re-apply it
    // immediately.  No cloaking — the window is already visible to the user
    // and we only need to ensure it stays excluded from capture.
    if event != EVENT_OBJECT_CREATE && event != EVENT_OBJECT_SHOW {
        if !unsafe { is_wda_active(hwnd) } {
            let _ = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) };
        }
        return;
    }

    // ── CREATE / SHOW ───────────────────────────────────────────────────
    // Check whether WDA was already set BEFORE we apply it.  This tells us
    // if a previous event (typically CREATE) already applied WDA, meaning
    // DWM has had at least one composition cycle to propagate the change.
    let wda_was_set = unsafe { is_wda_active(hwnd) };
    let wda_result = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) };

    // In explorer mode (targeting XamlExplorerHostIslandWindow), skip the
    // cloak+uncloak dance.  The user needs the Task View / Alt-Tab overlay
    // visible immediately; cloaking it would hide it from the user for ~80ms
    // on every appearance.  The WDA propagation delay is acceptable.
    if EXPLORER_MODE.load(Ordering::Relaxed) {
        let wda_now = unsafe { is_wda_active(hwnd) };
        debug_log(&format!(
            "WDA applied: hwnd={:#010x} result={:?} wda_was_set={} wda_now={}",
            hwnd.0 as u32, wda_result, wda_was_set, wda_now
        ));
        return;
    }

    if event == EVENT_OBJECT_CREATE {
        // Always cloak at CREATE — first opportunity to protect the window.
        unsafe { cloak_and_schedule_uncloak(hwnd) };
    } else if !wda_was_set {
        // SHOW where WDA wasn't previously set — CREATE was skipped or
        // failed.  Cloak to bridge the WDA propagation gap.
        unsafe { cloak_and_schedule_uncloak(hwnd) };
    }
}

/// Check whether `hwnd` is a Task View / Alt-Tab overlay window.
/// Matches class `XamlExplorerHostIslandWindow` (exact — excludes the `_WASDK`
/// variant which is a different control).
fn is_task_switching_window(hwnd: HWND) -> bool {
    let mut class_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    if class_len == 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&class_buf[..class_len as usize]);
    class == "XamlExplorerHostIslandWindow"
}

/// Apply or remove WDA_EXCLUDEFROMCAPTURE on all existing
/// `XamlExplorerHostIslandWindow` windows in the current process.
/// Called once when the explorer hook is first enabled so that the
/// pre-existing (hidden) Task View window is protected before the user
/// ever presses Alt+Tab or Win+Tab.
fn apply_wda_to_existing_task_view_windows(enable: bool) {
    let affinity = if enable {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    let our_pid = unsafe { GetCurrentProcessId() };
    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let (target_pid, affinity_val) = &*(lparam.0 as *const (u32, u32));
            let mut pid = 0u32;
            windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == *target_pid && is_task_switching_window(hwnd) {
                let result = SetWindowDisplayAffinity(hwnd, windows::Win32::UI::WindowsAndMessaging::WINDOW_DISPLAY_AFFINITY(*affinity_val));
                debug_log(&format!(
                    "apply_wda_existing: hwnd={:#010x} affinity={:#x} result={:?}",
                    hwnd.0 as u32, affinity_val, result
                ));
            }
            TRUE // continue enumeration
        }
    }
    let ctx = (our_pid, affinity.0);
    let _ = unsafe {
        EnumWindows(
            Some(enum_cb),
            LPARAM(&ctx as *const _ as isize),
        )
    };
}

/// Enable or disable the in-process hook in explorer-mode (class-filtered).
///
/// Like `EnableAutoHide`, but sets `EXPLORER_MODE = true` so the hook callback
/// only applies WDA_EXCLUDEFROMCAPTURE to `XamlExplorerHostIslandWindow` windows
/// (Task View / Alt-Tab overlay).  All other explorer.exe windows (File
/// Explorer, taskbar popups, notification centre, etc.) are left untouched.
///
/// Call with `enable = true` when the user enables Task View hiding.
/// Call with `enable = false` to stop hiding new Task View windows.
#[unsafe(no_mangle)]
pub extern "system" fn EnableExplorerAutoHide(enable: bool) -> bool {
    debug_log(&format!("EnableExplorerAutoHide({}) called", enable));
    if enable {
        EXPLORER_MODE.store(true, Ordering::SeqCst);
    }
    // Apply WDA to any existing Task View windows immediately — the window
    // already exists (hidden) and will only become visible on Alt+Tab/Win+Tab.
    apply_wda_to_existing_task_view_windows(enable);
    let result = EnableAutoHide(enable);
    debug_log(&format!("EnableExplorerAutoHide({}) -> EnableAutoHide returned {}", enable, result));
    if !enable {
        EXPLORER_MODE.store(false, Ordering::SeqCst);
    }
    result
}

/// Enable or disable the in-process window-creation hook.
///
/// Call with `enable = true` once after the first successful injection into a
/// process.  All future windows spawned by that process will have
/// WDA_EXCLUDEFROMCAPTURE applied with zero latency (no OUTOFCONTEXT delay).
///
/// Call with `enable = false` when the process group is un-hidden so that new
/// windows are no longer suppressed.
///
/// Blocks until the hook is actually registered on its keep-alive thread, so
/// the caller can be certain that all subsequent window creations will be
/// intercepted.  Timeout is 2 seconds — returns false on failure.
#[unsafe(no_mangle)]
pub extern "system" fn EnableAutoHide(enable: bool) -> bool {
    if enable {
        // Idempotent — skip if already active.
        if HOOK_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return true;
        }

        // Synchronisation: the spawned thread signals this channel once
        // SetWinEventHook has completed, so the caller blocks until the hook
        // is live and all future window creations will be intercepted.
        let (tx, rx) = std::sync::mpsc::channel::<bool>();

        std::thread::spawn(move || {
            // Retrieve this DLL's own HMODULE.  SetWinEventHook with
            // WINEVENT_INCONTEXT requires a valid hmod so Windows can map the
            // hook-proc address back to a loaded module.
            let mut hmod = HMODULE(std::ptr::null_mut());
            let _ = unsafe {
                GetModuleHandleExW(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                        | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    PCWSTR(in_process_hook as *const () as *const u16),
                    &mut hmod,
                )
            };

            let hook = unsafe {
                SetWinEventHook(
                    EVENT_OBJECT_CREATE,
                    EVENT_OBJECT_LOCATIONCHANGE,
                    Some(hmod),
                    Some(in_process_hook),
                    GetCurrentProcessId(), // current process only
                    0,                     // all threads in the process
                    4,                     // WINEVENT_INCONTEXT = 0x0004
                )
            };

            if hook.0.is_null() {
                // Hook registration failed; reset flag so a future call can retry.
                HOOK_ACTIVE.store(false, Ordering::SeqCst);
                let _ = tx.send(false);
                return;
            }

            HOOK_HANDLE.store(hook.0 as usize, Ordering::SeqCst);
            let _ = tx.send(true);

            // Keep this thread alive.  Windows frees an INCONTEXT hook when
            // the registering thread exits, so we must not return until disabled.
            while HOOK_ACTIVE.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(500));
            }

            // Disabled — unhook and clean up.
            let val = HOOK_HANDLE.swap(0, Ordering::SeqCst);
            if val != 0 {
                let _ = unsafe { UnhookWinEvent(HWINEVENTHOOK(val as *mut _)) };
            }
        });

        // Wait for the hook thread to signal, with a 2-second timeout.
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
    } else {
        // Signal the keep-alive thread to exit and unregister the hook.
        HOOK_ACTIVE.store(false, Ordering::SeqCst);
        true
    }
}
