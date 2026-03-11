use crate::native;
use dll_syringe::process::{OwnedProcess, Process};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};
use windows::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GWL_STYLE, GetMessageW, GetWindowDisplayAffinity, GetWindowLongW,
    GetWindowRect, GetWindowThreadProcessId, IsWindow, IsWindowVisible, MSG, PostThreadMessageW,
    SetWindowPos, TranslateMessage, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, WM_QUIT, WS_CHILD,
};

// WinEvent constants not re-exported in this windows-rs version
const EVENT_OBJECT_CREATE: u32 = 0x8000;
const EVENT_OBJECT_SHOW: u32 = 0x8002;
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;  // async delivery via message pump
const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002; // don't call back for events from this process

// DWMWA_CLOAK (13) makes a window's content invisible in all screen captures
// instantly, without injection.  Different from DWMWA_CLOAKED (14) which is
// the read-only attribute that returns why a window is cloaked.
const DWMWA_CLOAK: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(13);

// ---------------------------------------------------------------------------
// Global watch list shared with the WinEvent callback (watch mode only).
// LazyLock<Mutex<>> so it can be updated dynamically by --serve mode when
// the watched-name list changes without restarting the entire process.
// ---------------------------------------------------------------------------
static WATCH_NAMES: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Thread ID of the active watcher message-pump thread (0 = not running).
/// Used by serve mode to send WM_QUIT and stop the old pump before restarting
/// the watcher with updated names.
static WATCHER_THREAD_ID: LazyLock<Mutex<u32>> = LazyLock::new(|| Mutex::new(0));

/// HWNDs currently being processed by a hide thread.
/// Prevents CREATE and SHOW callbacks from racing on the same window — the
/// second event to arrive finds the HWND already in the set and returns early.
static PROCESSING: LazyLock<Mutex<HashSet<u32>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Returns true if the process with the given PID matches the active watch list.
/// Only direct process-name matching is used — no parent-PID cascading.
/// Parent-based matching was removed because it caused unintended hiding of
/// system applications (e.g. taskmgr.exe) that are children of explorer.exe.
/// The frontend's updateWatcher() already broadens the watch list by including
/// process names of child windows belonging to locked PIDs, so child helper
/// processes (steamwebhelper.exe, Chrome helpers, etc.) are still caught.
fn check_and_cache_match(pid: u32) -> bool {
    let (_, process_name) = native::get_process_info(pid);
    if process_name.is_empty() {
        return false;
    }
    let lower = process_name.to_lowercase();
    let names = WATCH_NAMES.lock().unwrap();
    names.contains(&lower)
}

/// Lightweight path for windows where the INCONTEXT hook has already applied
/// WDA_EXCLUDEFROMCAPTURE and DWM-cloaked the window at CREATE time.
///
/// The cloak provides instant capture protection but must be removed once WDA
/// has fully propagated to DWM (1–3 composition cycles ≈ 16–50 ms at 60 Hz).
/// This function schedules the uncloak on a short timer.  No off-screen move
/// is performed — preserving Chrome's window positioning for tab drags.
fn schedule_delayed_uncloak(hwnd: HWND) {
    let hwnd_raw = hwnd.0 as usize;
    std::thread::spawn(move || {
        // 80 ms ≈ 5 frames at 60 Hz — comfortably past WDA propagation.
        std::thread::sleep(std::time::Duration::from_millis(80));
        let hwnd = HWND(hwnd_raw as *mut _);
        // Guard: skip if the window was destroyed during the wait.
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return;
        }
        let uncloak_val: u32 = 0;
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd, DWMWA_CLOAK,
                &uncloak_val as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            )
        };
    });
}

/// Called from a WinEvent message-pump callback when a new window from a
/// watched process is detected.
///
/// Everything before the thread spawn runs synchronously in the callback
/// thread with < 2 ms total latency:
///
///  1. Atomic deduplication — if the HWND is already in PROCESSING (because
///     the CREATE callback already handled it), SHOW returns immediately and
///     vice-versa.  Whichever event arrives first wins.
///
///  2. CLOAK the window via DwmSetWindowAttribute (< 0.5 ms).  This is done
///     FIRST because DWM processes cloak on the next composition cycle with
///     no cross-process message dispatch, whereas SetWindowPos requires the
///     target process to handle a WM_WINDOWPOSCHANGED message.
///
///  3. Save the current window rect via GetWindowRect  (< 0.1 ms).
///
///  4. Move the window off-screen via SetWindowPos     (< 2 ms, cross-process).
///
///  5. Spawn a background thread that does the slow work:
///       • DLL injection + SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
///       • Verify the HWND is still alive via IsWindow
///       • Restore the saved position (only on injection success)
///       • Remove DWM cloak
///       • Remove the HWND from PROCESSING
fn handle_window_event(hwnd: HWND, pid: u32) {
    let hwnd_u32 = hwnd.0 as usize as u32;

    // ── Step 1: Deduplication ──────────────────────────────────────────────
    {
        let mut set = PROCESSING.lock().unwrap();
        if set.contains(&hwnd_u32) {
            eprintln!("[SS] DEDUP   hwnd={:#010x}", hwnd_u32);
            return; // Already being handled — skip
        }
        set.insert(hwnd_u32);
    }

    // ── Step 2: CLOAK via DWM ────────────────────────────────────────────
    // Cloaking takes effect on the next DWM composition cycle (<1 ms) and
    // hides the window's content from all screen captures instantly, with
    // no injection required.  This is done BEFORE the off-screen move
    // because DWM processes cloak immediately, while SetWindowPos requires
    // the target process to handle the message (cross-process round-trip).
    let cloak_val: u32 = 1;
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd, DWMWA_CLOAK,
            &cloak_val as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        )
    };

    // ── Step 3: Save current window position (cross-process, < 0.1 ms) ───
    let mut rect = RECT::default();
    let restore_pos = if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok() {
        Some((rect.left, rect.top))
    } else {
        None
    };

    // ── Step 4: Move off-screen (cross-process, < 2 ms) ──────────────────
    // Secondary safety net — even if cloak is not respected by some
    // capture tool, the window's content is outside the visible area.
    let _ = unsafe {
        SetWindowPos(
            hwnd, None, -32000, -32000, 0, 0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    eprintln!("[SS] OFFSCR  hwnd={:#010x}", hwnd_u32);

    // ── Step 5: DLL injection + restore on a background thread ────────────
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_u32 as usize as *mut _);

        eprintln!("[SS] INJECT  hwnd={:#010x} pid={}", hwnd_u32, pid);
        let inject_ok =
            native::Injector::set_window_props_with_pid(pid, hwnd_u32, true, None).is_ok();
        eprintln!("[SS] {}   hwnd={:#010x}", if inject_ok { "OK    " } else { "FAIL  " }, hwnd_u32);

        // After per-window injection, also install the in-process hook in every
        // other running process with the same executable name (e.g., all
        // steamwebhelper.exe instances).  This covers sibling processes that have
        // no visible windows yet, so they intercept their first window before DWM
        // composites it rather than relying on the slower OUTOFCONTEXT watcher.
        // Skip explorer.exe — it hosts system UI and enabling auto-hide on it
        // would persistently hide all future explorer.exe windows.
        let (_, proc_name) = native::get_process_info(pid);
        if !proc_name.is_empty() && !proc_name.eq_ignore_ascii_case("explorer.exe") {
            native::Injector::apply_auto_hide_for_name(&proc_name, true);
        }

        // Remove from the processing set so any later events (e.g. a second
        // ShowWindow call by the app) can be re-processed if needed.
        PROCESSING.lock().unwrap().remove(&hwnd_u32);

        // Restore the saved position only when:
        //  (a) injection succeeded — WDA_EXCLUDEFROMCAPTURE is now active
        //  (b) we have a valid saved position
        //  (c) the HWND is still alive — window wasn't destroyed during injection
        if inject_ok {
            if let Some((x, y)) = restore_pos {
                if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                    eprintln!("[SS] RESTORE hwnd={:#010x} -> ({}, {})", hwnd_u32, x, y);
                    let _ = unsafe {
                        SetWindowPos(
                            hwnd, None, x, y, 0, 0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        )
                    };
                }
            }
        }

        // Remove DWM cloaking.  WDA_EXCLUDEFROMCAPTURE now applies (if
        // injection succeeded) so the window is excluded from capture while
        // being visible to the user.  Always uncloak — even on failure — so
        // the window is not permanently black for the user.
        let uncloak_val: u32 = 0;
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd, DWMWA_CLOAK,
                &uncloak_val as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            )
        };
    });
}

/// WinEvent callback — fires when a window is first *created* (before ShowWindow).
/// Calls handle_window_event which moves the window off-screen immediately and
/// spawns the injection thread.  The PROCESSING set prevents the companion
/// on_window_show callback from duplicating this work.
unsafe extern "system" fn on_window_create(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // OBJID_WINDOW == 0, CHILDID_SELF == 0 — real top-level windows only
    if id_object != 0 || id_child != 0 {
        return;
    }
    if hwnd.0.is_null() {
        return;
    }
    // Skip child windows — only top-level windows need the off-screen + cloak
    // + inject pipeline.  Child HWNDs (e.g. Chrome_RenderWidgetHostHWND) are
    // internal rendering surfaces; moving them off-screen breaks compositing
    // and causes the parent window to appear transparent.
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
    if style & WS_CHILD.0 as i32 != 0 {
        return;
    }
    // No IsWindowVisible check: at CREATE time the window is not yet visible.
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return;
    }

    if !check_and_cache_match(pid) {
        return;
    }

    // If the in-process (INCONTEXT) hook already applied WDA and cloaked the
    // window at CREATE time, WDA just needs a few DWM cycles to propagate.
    // Schedule a delayed uncloak — no off-screen move, preserving Chrome's
    // window positioning for tab drags and window snapping.
    let mut affinity: u32 = 0;
    if unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.is_ok() && affinity != 0 {
        schedule_delayed_uncloak(hwnd);
        return;
    }

    eprintln!("[SS] CREATE  hwnd={:#010x} pid={}", hwnd.0 as usize as u32, pid);
    handle_window_event(hwnd, pid);
}

/// WinEvent callback — fires when a window becomes *visible*.
/// Calls handle_window_event which is a no-op if on_window_create already
/// handled this HWND (PROCESSING dedup).  For windows created with WS_VISIBLE
/// where CREATE and SHOW fire simultaneously — whichever is delivered first
/// by the message pump wins.
unsafe extern "system" fn on_window_show(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // OBJID_WINDOW == 0, CHILDID_SELF == 0 — real top-level windows only
    if id_object != 0 || id_child != 0 {
        return;
    }
    if hwnd.0.is_null() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return;
    }

    // Skip child windows — same rationale as on_window_create.
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
    if style & WS_CHILD.0 as i32 != 0 {
        return;
    }

    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return;
    }

    if !check_and_cache_match(pid) {
        return;
    }

    // Same lightweight path as on_window_create: if WDA is already set by the
    // INCONTEXT hook, just schedule a delayed uncloak — no off-screen move.
    let mut affinity: u32 = 0;
    if unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.is_ok() && affinity != 0 {
        schedule_delayed_uncloak(hwnd);
        return;
    }

    eprintln!("[SS] SHOW    hwnd={:#010x} pid={}", hwnd.0 as usize as u32, pid);
    handle_window_event(hwnd, pid);
}

// ---------------------------------------------------------------------------
// Entry point called from main.rs
// ---------------------------------------------------------------------------
pub fn start() {
    // Attach to the calling console so output is visible when launched from cmd/powershell
    let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };

    let args: Vec<String> = std::env::args().skip(1).collect();

    // --serve: run as a persistent JSON-IPC subprocess.
    // All operations (list, hide, unhide, watch) are dispatched via stdin/stdout
    // so the caller never needs to spawn a new process per operation.
    if args.contains(&"--serve".to_string()) {
        serve();
        return;
    }

    // --list [--procs <name>...]: enumerate all top-level windows and print as
    // a JSON array.  When --procs names are supplied, also include one entry
    // per running process with that name that has NO visible window (e.g. an
    // app minimised to the system tray).  Those entries have hwnd=0 and
    // no_window=true so the frontend can distinguish them from real windows.
    if args.contains(&"--list".to_string()) {
        let mut windows = native::get_top_level_windows();

        // Collect optional --procs names that follow the flag (stop at next --)
        let procs_idx = args.iter().position(|a| a == "--procs");
        if let Some(idx) = procs_idx {
            let proc_names: Vec<&str> = args[idx + 1..]
                .iter()
                .filter(|a| !a.starts_with("--"))
                .map(|a| a.as_str())
                .collect();

            if !proc_names.is_empty() {
                // Only add a process entry when the PID has no visible window already.
                let existing_pids: std::collections::HashSet<u32> =
                    windows.iter().map(|w| w.pid).collect();
                let tray_entries =
                    native::get_processes_by_name(&proc_names, &existing_pids);
                windows.extend(tray_entries);
            }
        }

        println!(
            "{}",
            serde_json::to_string(&windows).unwrap_or_else(|_| "[]".to_string())
        );
        return;
    }

    // --enable-all <1|0> <name>...: inject ScreenShieldHook.dll into every running process
    // matching one of the listed names and call EnableAutoHide(enable).  Called by
    // Electron alongside --watch to pre-install the in-process hook even in processes
    // that currently have no visible windows (e.g. background steamwebhelper.exe).
    if args.contains(&"--enable-all".to_string()) {
        let mut iter = args.iter().skip_while(|a| *a != "--enable-all").peekable();
        iter.next(); // skip "--enable-all"
        let enable = iter
            .next()
            .map(|s| s == "1")
            .unwrap_or(false);
        for name in iter.filter(|a| !a.starts_with("--")) {
            native::Injector::apply_auto_hide_for_name(name, enable);
        }
        return;
    }

    // --watch <name> [<name>...]: persistent watcher that intercepts new
    // windows from the listed process names via SetWinEventHook and hides
    // them before they can appear on screen capture.  Runs until killed.
    if args.contains(&"--watch".to_string()) {
        let names: Vec<String> = args
            .into_iter()
            .filter(|a| !a.starts_with("--"))
            .map(|s| s.to_lowercase())
            .collect();

        if names.is_empty() {
            return;
        }

        let poll_names = names.clone();
        *WATCH_NAMES.lock().unwrap() = names;

        // ── ETW process-creation watcher ─────────────────────────────────────
        // Subscribes to Microsoft-Windows-Kernel-Process and fires injection
        // within ~1 ms of a matching process spawning — well ahead of the
        // 200–500 ms window-creation time of CEF-based helpers such as
        // steamwebhelper.exe.  Falls back gracefully if ETW is unavailable.
        native::start_etw_process_watcher(poll_names);

        // Hook EVENT_OBJECT_SHOW — fires when a window becomes visible.
        let hook_show = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_SHOW,
                EVENT_OBJECT_SHOW,
                None,
                Some(on_window_show),
                0, // all processes
                0, // all threads
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };

        // Hook EVENT_OBJECT_CREATE — fires when a window is created (before ShowWindow).
        // Pre-injecting ScreenShieldHook.dll here ensures SetWindowDisplayAffinity is called before
        // the first frame is painted, eliminating the brief flash.
        let hook_create = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_CREATE,
                EVENT_OBJECT_CREATE,
                None,
                Some(on_window_create),
                0, // all processes
                0, // all threads
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };

        // Block on the message pump — WinEvent hooks with OUTOFCONTEXT deliver
        // events as messages to this thread's queue.  Runs until Electron kills us.
        let mut msg = MSG::default();
        unsafe {
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWinEvent(hook_show);
            let _ = UnhookWinEvent(hook_create);
        }
        return;
    }

    let hide_flag = args.contains(&"--hide".to_string());
    let unhide_flag = args.contains(&"--unhide".to_string());

    if !hide_flag && !unhide_flag {
        eprintln!(
            "Usage: ScreenShieldHelper --list | --watch <name>... | --hide <hwnd|pid|name>... | --unhide <hwnd|pid|name>..."
        );
        std::process::exit(1);
    }

    let should_hide = hide_flag; // true = hide, false = unhide

    // --taskbar: also apply HideFromTaskbar (hides from Alt+Tab / taskbar)
    let taskbar_flag = args.contains(&"--taskbar".to_string());
    let hide_from_taskbar: Option<bool> = if taskbar_flag { Some(should_hide) } else { None };

    // Positional args (everything that isn't a --flag) are targets
    let targets: Vec<String> = args.into_iter().filter(|a| !a.starts_with("--")).collect();

    if targets.is_empty() {
        eprintln!("No targets provided.");
        std::process::exit(1);
    }

    // Enumerate all windows once to build fast lookup maps
    let all_windows = native::get_top_level_windows();

    // hwnd → pid
    let hwnd_to_pid: HashMap<u32, u32> =
        all_windows.iter().map(|w| (w.hwnd, w.pid)).collect();

    // pid → [hwnd, …]
    let pid_to_hwnds: HashMap<u32, Vec<u32>> = {
        let mut m: HashMap<u32, Vec<u32>> = HashMap::new();
        for w in &all_windows {
            m.entry(w.pid).or_default().push(w.hwnd);
        }
        m
    };

    for target in &targets {
        if let Ok(n) = target.parse::<u32>() {
            // Priority 1: treat as hwnd (fast O(1) lookup)
            if let Some(&pid) = hwnd_to_pid.get(&n) {
                if let Err(e) =
                    native::Injector::set_window_props_with_pid(pid, n, should_hide, hide_from_taskbar)
                {
                    eprintln!("Error (hwnd {}): {:?}", n, e);
                }
                continue;
            }

            // Priority 2: treat as PID – hide/unhide all windows of that process
            if let Some(hwnds) = pid_to_hwnds.get(&n) {
                for &hwnd in hwnds {
                    if let Err(e) =
                        native::Injector::set_window_props_with_pid(n, hwnd, should_hide, hide_from_taskbar)
                    {
                        eprintln!("Error (pid {} hwnd {}): {:?}", n, hwnd, e);
                    }
                }
                continue;
            }

            eprintln!("No window or process found for value '{}'", target);
        } else {
            // Target is a process name – find all matching processes
            let processes = OwnedProcess::find_all_by_name(target);
            if processes.is_empty() {
                eprintln!("No process found with name '{}'", target);
                continue;
            }
            for proc in processes {
                match proc.pid().map(|p| p.get()) {
                    Ok(pid) => {
                        if let Some(hwnds) = pid_to_hwnds.get(&pid) {
                            for &hwnd in hwnds {
                                if let Err(e) = native::Injector::set_window_props_with_pid(
                                    pid,
                                    hwnd,
                                    should_hide,
                                    hide_from_taskbar,
                                ) {
                                    eprintln!(
                                        "Error (name '{}' hwnd {}): {:?}",
                                        target, hwnd, e
                                    );
                                }
                            }
                        } else {
                            eprintln!("No windows found for process '{}'", target);
                        }
                    }
                    Err(e) => eprintln!("Failed to get PID for '{}': {}", target, e),
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Serve mode — persistent JSON-IPC subprocess
// ---------------------------------------------------------------------------
// Sends WM_QUIT to the current watcher message-pump thread (if any) so the
// thread exits cleanly and its WinEvent hooks are unregistered.
fn stop_watcher_thread() {
    let mut tid = WATCHER_THREAD_ID.lock().unwrap();
    if *tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(*tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        *tid = 0;
    }
}

/// Spawn a new background thread that installs WinEvent hooks and runs a
/// message pump.  Returns the thread ID of that pump thread so it can later
/// be stopped via PostThreadMessageW(WM_QUIT).
fn spawn_watcher_pump_thread() -> u32 {
    let (tx, rx) = std::sync::mpsc::channel::<u32>();
    std::thread::spawn(move || {
        let tid = unsafe { GetCurrentThreadId() };
        tx.send(tid).ok();

        let hook_show = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW,
                None, Some(on_window_show),
                0, 0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };
        let hook_create = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_CREATE, EVENT_OBJECT_CREATE,
                None, Some(on_window_create),
                0, 0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };

        let mut msg = MSG::default();
        unsafe {
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !hook_show.is_invalid() { let _ = UnhookWinEvent(hook_show); }
            if !hook_create.is_invalid() { let _ = UnhookWinEvent(hook_create); }
        }
    });
    rx.recv().unwrap_or(0)
}

/// Start (or restart) the watcher for any names that are currently in
/// WATCH_NAMES.  Stops the old pump thread first, then starts a new one.
/// Called from serve() on each "watch" command.
fn restart_watcher() {
    stop_watcher_thread();
    let names = WATCH_NAMES.lock().unwrap().clone();
    if names.is_empty() {
        return;
    }
    // Run the ETW process-creation watcher with the current names.
    // On subsequent calls the ETW updater silently refreshes the name list
    // rather than spawning a second ETW session.
    native::start_etw_process_watcher(names);
    let tid = spawn_watcher_pump_thread();
    *WATCHER_THREAD_ID.lock().unwrap() = tid;
}

/// Persistent JSON-IPC loop.
///
/// Protocol (newline-delimited JSON):
///   request:  {"id":<u64>,"cmd":"<verb>","params":{...}}
///   response: {"id":<u64>,"ok":true,"data":<json>}
///          or {"id":<u64>,"ok":false,"error":"<message>"}
///
/// Verbs:
///   list        params: {proc_names: string[]}  → WindowInfo[]
///   hide        params: {hwnds: number[], alt_tab: bool}
///   unhide      params: {hwnds: number[], alt_tab: bool}
///   watch       params: {names: string[]}
///   stop-watch  params: {}
///   enable-all  params: {enable: bool, names: string[]}
fn serve() {
    use std::io::{BufRead, BufReader, Write};

    #[derive(serde::Deserialize)]
    struct Req {
        id: u64,
        cmd: String,
        #[serde(default)]
        params: serde_json::Value,
    }

    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in BufReader::new(std::io::stdin()).lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_owned();
        if line.is_empty() {
            continue;
        }

        let req: Req = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let result: Result<serde_json::Value, String> = match req.cmd.as_str() {
            // ── list ────────────────────────────────────────────────────────
            "list" => {
                let proc_names: Vec<String> = req.params["proc_names"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                let mut windows = native::get_top_level_windows();
                if !proc_names.is_empty() {
                    let existing_pids: HashSet<u32> =
                        windows.iter().map(|w| w.pid).collect();
                    let pn_refs: Vec<&str> =
                        proc_names.iter().map(|s| s.as_str()).collect();
                    let tray =
                        native::get_processes_by_name(&pn_refs, &existing_pids);
                    windows.extend(tray);
                }
                serde_json::to_value(windows).map_err(|e| e.to_string())
            }

            // ── hide / unhide ────────────────────────────────────────────────
            "hide" | "unhide" => {
                let should_hide = req.cmd == "hide";
                let alt_tab = req.params["alt_tab"].as_bool().unwrap_or(false);
                let hwnds: Vec<u32> = req.params["hwnds"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_u64().map(|n| n as u32))
                            .collect()
                    })
                    .unwrap_or_default();

                let hide_from_taskbar: Option<bool> =
                    if alt_tab { Some(should_hide) } else { None };

                for hwnd in hwnds {
                    let hwnd_handle = HWND(hwnd as usize as *mut _);
                    let mut pid: u32 = 0;
                    unsafe {
                        GetWindowThreadProcessId(hwnd_handle, Some(&mut pid));
                    }
                    if pid == 0 {
                        continue;
                    }
                    let _ = native::Injector::set_window_props_with_pid(
                        pid, hwnd, should_hide, hide_from_taskbar,
                    );
                }
                Ok(serde_json::Value::Null)
            }

            // ── watch ────────────────────────────────────────────────────────
            "watch" => {
                let names: Vec<String> = req.params["names"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
                            .collect()
                    })
                    .unwrap_or_default();

                *WATCH_NAMES.lock().unwrap() = names;
                restart_watcher();
                Ok(serde_json::Value::Null)
            }

            // ── stop-watch ───────────────────────────────────────────────────
            "stop-watch" => {
                stop_watcher_thread();
                *WATCH_NAMES.lock().unwrap() = Vec::new();
                Ok(serde_json::Value::Null)
            }

            // ── enable-all ───────────────────────────────────────────────────
            "enable-all" => {
                let enable = req.params["enable"].as_bool().unwrap_or(false);
                let names: Vec<String> = req.params["names"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                for name in &names {
                    native::Injector::apply_auto_hide_for_name(name, enable);
                }
                Ok(serde_json::Value::Null)
            }

            other => Err(format!("unknown command: {other}")),
        };

        let response = match result {
            Ok(data) => serde_json::json!({"id": req.id, "ok": true, "data": data}),
            Err(err) => serde_json::json!({"id": req.id, "ok": false, "error": err}),
        };

        let _ = writeln!(out, "{}", response);
        let _ = out.flush();
    }

    // stdin closed — shut down the watcher thread before exiting.
    stop_watcher_thread();
}
