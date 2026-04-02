use dll_syringe::{
    Syringe,
    process::{BorrowedProcessModule, OwnedProcess, Process},
    rpc::{RawRpcFunctionPtr, RemoteRawProcedure},
};
use std::collections::{HashMap, HashSet};
use std::error;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::{env, path::PathBuf};
use tracing::debug;
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, TRUE, WPARAM},
        Graphics::{
            Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
            Gdi::{
                BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC,
                GetDIBits, GetObjectW, ReleaseDC,
            },
        },
        System::{
            Diagnostics::{
                Etw::{
                    CloseTrace, ControlTraceW, EnableTraceEx2,
                    EVENT_CONTROL_CODE_ENABLE_PROVIDER, EVENT_RECORD,
                    EVENT_TRACE_CONTROL_STOP, EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES,
                    EVENT_TRACE_REAL_TIME_MODE, OpenTraceW, PROCESS_TRACE_MODE_EVENT_RECORD,
                    PROCESS_TRACE_MODE_REAL_TIME, ProcessTrace, StartTraceW,
                    WNODE_FLAG_TRACED_GUID, CONTROLTRACE_HANDLE,
                },
                ToolHelp::{
                    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                    TH32CS_SNAPPROCESS,
                },
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Shell::ExtractIconExW,
            WindowsAndMessaging::{
                DestroyIcon, EnumWindows, GCLP_HICON, GCLP_HICONSM, GetClassLongPtrW,
                GetClassNameW, GetIconInfo, GetWindowDisplayAffinity, GetWindowRect,
                GetWindowTextW, GetWindowThreadProcessId, HICON, ICON_BIG, ICON_SMALL2, ICONINFO,
                IsWindowVisible, SendMessageW, WM_GETICON,
            },
        },
    },
    core::{BOOL, PWSTR},
};

/// Icon cache — maps PID to icon data URL to avoid repeated extraction on every poll.
/// Icons are stable for the lifetime of a process, so caching them is safe.
static ICON_CACHE: LazyLock<Mutex<HashMap<u32, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, serde::Serialize)]
pub struct WindowInfo {
    pub hwnd: u32,
    pub title: String,
    pub class_name: String,
    pub pid: u32,
    pub parent_pid: u32,
    pub hidden: bool,
    pub exe_path: String,
    pub process_name: String,
    pub icon_data_url: String,
    /// Original icon data URL (for when app is hidden/minimized)
    pub original_icon_data_url: String,
    /// true when the entry represents a running process with no visible window
    /// (e.g. minimised to the system tray).  hwnd is 0 for these entries.
    pub no_window: bool,
}

/// Returns (full exe path, basename e.g. "chrome.exe") for the given PID.
/// Returns empty strings if the process cannot be queried.
pub fn get_process_info(pid: u32) -> (String, String) {
    let handle: HANDLE = match unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    } {
        Ok(h) => h,
        Err(_) => return (String::new(), String::new()),
    };

    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;

    let result = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
    };

    let _ = unsafe { CloseHandle(handle) };

    if result.is_err() || len == 0 {
        return (String::new(), String::new());
    }

    let exe_path = String::from_utf16_lossy(&buf[..len as usize]);
    let process_name = std::path::Path::new(&exe_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    (exe_path, process_name)
}

/// Snapshot all running processes and return a pid → parent_pid map.
fn build_parent_pid_map() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(h) => h,
        Err(_) => return map,
    };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    unsafe {
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                entry = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    map
}


/// Standard Base64 encoder — avoids pulling in a base64 crate.
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Converts raw RGBA pixel data into a `data:image/png;base64,...` string.
/// If the alpha channel is all-zero (old-style GDI bitmaps), forces full opacity.
fn icon_b64_from_rgba(width: usize, height: usize, mut rgba: Vec<u8>) -> Option<String> {
    // Old-style GDI icon bitmaps have alpha == 0 for solid pixels.
    // If every alpha byte is zero, treat the image as fully opaque.
    if rgba.iter().skip(3).step_by(4).all(|&a| a == 0) {
        for a in rgba.iter_mut().skip(3).step_by(4) {
            *a = 255;
        }
    }

    let img: image::RgbaImage =
        image::ImageBuffer::from_raw(width as u32, height as u32, rgba)?;
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64_encode(buf.get_ref())))
}

/// Returns a default icon as a data URL (white "S" on red background).
/// This is used as a fallback when no icon can be extracted from a window or executable.
fn get_default_icon_data_url() -> String {
    // 16x16 PNG: white "S" on red background
    // This is a minimal valid PNG that represents the ScreenShield default icon
    const DEFAULT_ICON_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0xF3, 0xFF, 0x61, 0x00, 0x00, 0x00,
        0x01, 0x73, 0x52, 0x47, 0x42, 0x00, 0xAE, 0xCE, 0x1C, 0xE9, 0x00, 0x00,
        0x00, 0x44, 0x45, 0x58, 0x54, 0x65, 0x78, 0x74, 0x00, 0x43, 0x72, 0x65,
        0x61, 0x74, 0x65, 0x64, 0x20, 0x77, 0x69, 0x74, 0x68, 0x20, 0x47, 0x49,
        0x4D, 0x50, 0x57, 0x81, 0x0E, 0x17, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44,
        0x41, 0x54, 0x38, 0x4F, 0x63, 0x64, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00,
        0x04, 0x00, 0x01, 0x39, 0x39, 0x6E, 0x9C, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    format!("data:image/png;base64,{}", base64_encode(DEFAULT_ICON_PNG))
}

#[tracing::instrument]
pub fn get_icon(hwnd: u32) -> Option<(usize, usize, Vec<u8>)> {
    let hwnd = HWND(hwnd as *mut _);

    // Try icons from largest to smallest for best display quality at 32px:
    //   1. WM_GETICON ICON_BIG        — 32x32 process-provided icon
    //   2. WM_GETICON ICON_SMALL2     — DPI-aware small icon
    //   3. GetClassLongPtrW GCLP_HICON  — 32x32 registered class icon
    //   4. GetClassLongPtrW GCLP_HICONSM — small registered class icon
    let candidates: [isize; 4] = [
        unsafe { SendMessageW(hwnd, WM_GETICON, Some(WPARAM(ICON_BIG as usize)),    None) }.0,
        unsafe { SendMessageW(hwnd, WM_GETICON, Some(WPARAM(ICON_SMALL2 as usize)), None) }.0,
        unsafe { GetClassLongPtrW(hwnd, GCLP_HICON) }  as isize,
        unsafe { GetClassLongPtrW(hwnd, GCLP_HICONSM) } as isize,
    ];
    let hicon_val = candidates.iter().copied().find(|&v| v != 0)?;
    let hicon = HICON(hicon_val as *mut _);

    let mut icon_info = ICONINFO::default();
    let info_result = unsafe { GetIconInfo(hicon, &mut icon_info as *mut _) };
    if let Err(err) = info_result {
        debug!("no iconinfo retrieved {:?}", err);
        return None;
    }

    let hdc = unsafe { GetDC(None) };
    if hdc.is_invalid() {
        debug!("no dc");
        return None;
    }

    let mut bitmap = BITMAP::default();
    let object_result = unsafe {
        GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        )
    };

    if object_result == 0 {
        debug!("no object");
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = bitmap.bmWidth;
    bmi.bmiHeader.biHeight = -bitmap.bmHeight;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;

    let pixel_count = bitmap.bmWidth * bitmap.bmHeight;
    let mut pixels: Vec<u8> = vec![0; (pixel_count * 4) as usize];
    let _ = unsafe {
        GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            bitmap.bmHeight as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi as *mut _,
            DIB_RGB_COLORS,
        )
    };

    for i in (0..pixels.len()).step_by(4) {
        (pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]) =
            (pixels[i + 2], pixels[i + 1], pixels[i], pixels[i + 3]);
    }

    let icon = Some((bitmap.bmWidth as usize, bitmap.bmHeight as usize, pixels));

    let _ = unsafe { ReleaseDC(None, hdc) };
    let _ = unsafe { DeleteObject(icon_info.hbmColor.into()) };
    let _ = unsafe { DeleteObject(icon_info.hbmMask.into()) };

    return icon;
}

/// Extracts the default application icon from an executable file path.
/// Reads from the exe's resource section via ExtractIconExW, so the icon is
/// always the static application icon rather than the dynamic window HICON
/// (which for File Explorer reflects the current folder thumbnail).
fn get_icon_from_exe(exe_path: &str) -> Option<(usize, usize, Vec<u8>)> {
    let path_wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut hicon_large = HICON::default();
    let count = unsafe {
        ExtractIconExW(
            windows::core::PCWSTR(path_wide.as_ptr()),
            0,
            Some(&mut hicon_large),
            None,
            1,
        )
    };
    if count == 0 || hicon_large.0.is_null() {
        return None;
    }

    let mut icon_info = ICONINFO::default();
    if unsafe { GetIconInfo(hicon_large, &mut icon_info as *mut _) }.is_err() {
        let _ = unsafe { DestroyIcon(hicon_large) };
        return None;
    }

    let hdc = unsafe { GetDC(None) };
    if hdc.is_invalid() {
        let _ = unsafe { DeleteObject(icon_info.hbmColor.into()) };
        let _ = unsafe { DeleteObject(icon_info.hbmMask.into()) };
        let _ = unsafe { DestroyIcon(hicon_large) };
        return None;
    }

    let mut bitmap = BITMAP::default();
    let object_result = unsafe {
        GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        )
    };
    if object_result == 0 {
        let _ = unsafe { ReleaseDC(None, hdc) };
        let _ = unsafe { DeleteObject(icon_info.hbmColor.into()) };
        let _ = unsafe { DeleteObject(icon_info.hbmMask.into()) };
        let _ = unsafe { DestroyIcon(hicon_large) };
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = bitmap.bmWidth;
    bmi.bmiHeader.biHeight = -bitmap.bmHeight;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;

    let pixel_count = bitmap.bmWidth * bitmap.bmHeight;
    let mut pixels: Vec<u8> = vec![0; (pixel_count * 4) as usize];
    let _ = unsafe {
        GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            bitmap.bmHeight as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi as *mut _,
            DIB_RGB_COLORS,
        )
    };

    // BGRA → RGBA channel swap (same as get_icon)
    for i in (0..pixels.len()).step_by(4) {
        (pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]) =
            (pixels[i + 2], pixels[i + 1], pixels[i], pixels[i + 3]);
    }

    let result = Some((bitmap.bmWidth as usize, bitmap.bmHeight as usize, pixels));
    let _ = unsafe { ReleaseDC(None, hdc) };
    let _ = unsafe { DeleteObject(icon_info.hbmColor.into()) };
    let _ = unsafe { DeleteObject(icon_info.hbmMask.into()) };
    let _ = unsafe { DestroyIcon(hicon_large) };
    result
}

unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // Check display affinity first — a non-zero affinity means we have hidden this window
    // via WDA_EXCLUDEFROMCAPTURE.  We must include such windows even when they are not
    // visible (e.g. the app minimised to the system tray after we hid it), so that they
    // remain listed in the UI and the hide rule stays active.
    let mut affinity: u32 = 0;
    let result_affinity = unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity as *mut _) };
    if result_affinity.is_err() {
        return TRUE;
    }
    let hidden = affinity != 0;

    // Skip windows that are neither visible to the user nor hidden by us.
    // This keeps minimised-to-tray windows we own while filtering out all
    // other invisible windows (tooltips, background helpers, etc.).
    let is_visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
    if !is_visible && !hidden {
        return TRUE;
    }

    // Skip visible windows that occupy zero screen space — these are background
    // helper windows (Chrome GPU process, extension background pages, etc.) that
    // carry WS_VISIBLE but have no actual on-screen presence.
    if !hidden {
        let mut rc = RECT::default();
        let _ = unsafe { GetWindowRect(hwnd, &mut rc) };
        if rc.right - rc.left == 0 && rc.bottom - rc.top == 0 {
            return TRUE;
        }
    }

    // Skip known system shell window classes that must never appear in the UI:
    // NotifyIconOverflowWindow = system tray overflow popup (explorer.exe)
    // WorkerW                  = internal DWM/wallpaper compositor layer
    // Shell_TrayWnd and MultitaskingViewFrame are intentionally NOT excluded —
    // they are the taskbar and Alt+Tab overlay hosts, and must remain in the list
    // so the Advanced "Hide taskbar" and "Hide Alt+Tab" toggles can target their HWNDs.
    let mut class_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    let class_name = if class_len > 0 {
        String::from_utf16_lossy(&class_buf[..class_len as usize])
    } else {
        String::new()
    };
     const EXCLUDED_CLASSES: &[&str] = &[
         "NotifyIconOverflowWindow",
         "WorkerW",
         "MS_WebCheckMonitor",
         "Progman",
         "Shell_TrayWnd",
     ];
    if EXCLUDED_CLASSES.contains(&class_name.as_str()) {
        return TRUE;
    }

    // System UI windows that are always present but have empty window titles.
    // Assign a synthetic title so they pass the title filter below.
    // Shell_TrayWnd            = primary taskbar
    // Shell_SecondaryTrayWnd   = per-monitor taskbar on secondary displays
    // MultitaskingViewFrame    = Alt+Tab / Task View overlay (hosted by explorer.exe)
    const SYSTEM_UI_CLASSES: &[(&str, &str)] = &[
        ("Shell_TrayWnd", "Taskbar"),
        ("Shell_SecondaryTrayWnd", "Taskbar"),
        ("MultitaskingViewFrame", "Alt+Tab Switcher"),
    ];
    let synthetic_title = SYSTEM_UI_CLASSES
        .iter()
        .find(|(cls, _)| *cls == class_name.as_str())
        .map(|(_, title)| *title);

    // get title
    let mut buf = [0u16; 128];
    let title_len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    let title = if title_len > 0 {
        String::from_utf16_lossy(&buf[..title_len as usize])
    } else if let Some(t) = synthetic_title {
        t.to_string()
    } else {
        return TRUE; // skip empty-title windows that aren't special system UI
    };

    // skip cloaked windows (Calculator, Settings, virtual-desktop invisible windows)
    let mut cloaked: u32 = 0;
    let result_get = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as _,
            std::mem::size_of::<u32>() as u32,
        )
    };

    debug!("Window {:?} {:?} {:?}", hwnd.0, cloaked, title);

    // skip cloaked windows — but preserve windows we have hidden ourselves (WDA set)
    // so they stay listed in the UI even when the OS has also cloaked them.
    if (result_get.is_err() || cloaked != 0) && !hidden {
        return TRUE;
    }

    // Get owning process ID
    let mut pid = 0u32;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };

    if thread_id == 0 {
        return TRUE;
    }

    // Recover our Vec<WindowInfo> from lparam and push.
    let out: &mut Vec<WindowInfo> = unsafe { &mut *(lparam.0 as *mut _) };
    out.push(WindowInfo {
        hwnd: hwnd.0 as u32,
        title,
        class_name,
        pid,
        parent_pid: 0, // filled in by get_top_level_windows after enumeration
        hidden,
        exe_path: String::new(),
        process_name: String::new(),
        icon_data_url: String::new(),
        original_icon_data_url: String::new(),
        no_window: false,
    });

    TRUE // continue enumeration
}

#[tracing::instrument]
pub fn get_top_level_windows() -> Vec<WindowInfo> {
    let mut top_level_windows: Vec<WindowInfo> = Vec::new();

    unsafe {
        // Pass a pointer to our Vec via LPARAM.
        let param = LPARAM(&mut top_level_windows as *mut _ as isize);
        // Enumerate all *top-level* windows.
        let _ = EnumWindows(Some(enum_windows_proc), param);
    }

    // Augment each entry with process info and icon.
    // Both are deduplicated per PID so each process is queried only once.
    let mut pid_info_cache: HashMap<u32, (String, String)> = HashMap::new();
    let mut pid_first_hwnd: HashMap<u32, u32> = HashMap::new();
    // Tracks exe paths for processes whose window HICON is dynamic (e.g. explorer.exe).
    // These are loaded via ExtractIconExW from the exe file to get the stable app icon.
    let mut pid_exe_for_icon: HashMap<u32, String> = HashMap::new();
    // Cache for original icons to avoid repeated extraction
    let mut pid_original_icon: HashMap<u32, String> = HashMap::new();

    // Processes whose window HICON is dynamically generated — skip icon fetch for these.
    // (Explorer's icon reflects the current folder thumbnail, not the app icon.)
    const SKIP_ICON_PROCS: &[&str] = &["explorer.exe"];
    // System host processes whose windows are internal containers, not real apps.
    // applicationframehost.exe — UWP shell host; its windows are ghost containers
    // for UWP apps and should not appear as standalone entries in the list.
    const SYSTEM_EXCLUSIONS: &[&str] = &["applicationframehost.exe"];

    for win in &mut top_level_windows {
        let info = pid_info_cache
            .entry(win.pid)
            .or_insert_with(|| get_process_info(win.pid));
        win.exe_path = info.0.clone();
        win.process_name = info.1.clone();
        let proc_lower = win.process_name.to_lowercase();
        if SKIP_ICON_PROCS.contains(&proc_lower.as_str()) {
            pid_exe_for_icon.entry(win.pid).or_insert_with(|| win.exe_path.clone());
        } else {
            pid_first_hwnd.entry(win.pid).or_insert(win.hwnd);
        }
    }

    // Get current icons (may reflect hidden state) and original icons
    for win in &mut top_level_windows {
        // Get current icon from window (may be affected by hiding)
        if let Some((width, height, pixels)) = get_icon(win.hwnd) {
            if let Some(icon_url) = icon_b64_from_rgba(width, height, pixels) {
                win.icon_data_url = icon_url;
            }
        }
        
        // Get original icon from executable (stable app icon)
        let original_icon_url = if SKIP_ICON_PROCS.contains(&win.process_name.to_lowercase().as_str()) {
            // For explorer.exe, get icon from exe file
            if let Some((width, height, pixels)) = get_icon_from_exe(&win.exe_path) {
                icon_b64_from_rgba(width, height, pixels).unwrap_or_else(|| {
                    // Fallback to default icon
                    tracing::warn!("Failed to get icon for {}, using fallback", win.process_name);
                    get_default_icon_data_url()
                })
            } else {
                // Fallback to default icon
                tracing::warn!("Failed to get icon for {}, using fallback", win.process_name);
                get_default_icon_data_url()
            }
        } else {
            // For other apps, try to get icon from window first, then fallback to exe
            if let Some((width, height, pixels)) = get_icon(win.hwnd) {
                if let Some(icon_url) = icon_b64_from_rgba(width, height, pixels) {
                    icon_url
                } else {
                    // Fallback to exe icon
                    if let Some((width, height, pixels)) = get_icon_from_exe(&win.exe_path) {
                        icon_b64_from_rgba(width, height, pixels).unwrap_or_else(|| {
                            tracing::warn!("Failed to get icon for {}, using fallback", win.process_name);
                            get_default_icon_data_url()
                        })
                    } else {
                        tracing::warn!("Failed to get icon for {}, using fallback", win.process_name);
                        get_default_icon_data_url()
                    }
                }
            } else {
                // Fallback to exe icon
                if let Some((width, height, pixels)) = get_icon_from_exe(&win.exe_path) {
                    icon_b64_from_rgba(width, height, pixels).unwrap_or_else(|| {
                        tracing::warn!("Failed to get icon for {}, using fallback", win.process_name);
                        get_default_icon_data_url()
                    })
                } else {
                    tracing::warn!("Failed to get icon for {}, using fallback", win.process_name);
                    get_default_icon_data_url()
                }
            }
        };
        win.original_icon_data_url = original_icon_url;
        
        // If we haven't set a current icon yet, use the original
        if win.icon_data_url.is_empty() {
            win.icon_data_url = win.original_icon_data_url.clone();
        }
    }

    // Populate parent_pid for every window using a single ToolHelp snapshot.
    let parent_map = build_parent_pid_map();
    for win in &mut top_level_windows {
        win.parent_pid = parent_map.get(&win.pid).copied().unwrap_or(0);
    }

    // Remove system host processes that must not appear in the window list.
    top_level_windows.retain(|win| {
        !SYSTEM_EXCLUSIONS.contains(&win.process_name.to_lowercase().as_str())
    });

    // Fetch one icon per unique PID using the first window handle seen.
    // Use global cache to avoid repeated extraction on every poll.
    let mut icon_cache = ICON_CACHE.lock().unwrap();
    for (&pid, &hwnd) in &pid_first_hwnd {
        // Check cache first
        if let Some(cached_url) = icon_cache.get(&pid) {
            // Use cached icon
            for win in top_level_windows.iter_mut().filter(|w| w.pid == pid) {
                win.icon_data_url = cached_url.clone();
            }
        } else {
            // Extract and cache
            let url = get_icon(hwnd)
                .and_then(|(w, h, rgba)| icon_b64_from_rgba(w, h, rgba))
                .unwrap_or_default();
            icon_cache.insert(pid, url.clone());
            for win in top_level_windows.iter_mut().filter(|w| w.pid == pid) {
                win.icon_data_url = url.clone();
            }
        }
    }
    // For processes with dynamic window icons, load from the exe file directly.
    for (&pid, exe_path) in &pid_exe_for_icon {
        // Check cache first
        if let Some(cached_url) = icon_cache.get(&pid) {
            for win in top_level_windows.iter_mut().filter(|w| w.pid == pid) {
                win.icon_data_url = cached_url.clone();
            }
        } else {
            // Extract and cache
            let url = get_icon_from_exe(exe_path)
                .and_then(|(w, h, rgba)| icon_b64_from_rgba(w, h, rgba))
                .unwrap_or_default();
            icon_cache.insert(pid, url.clone());
            for win in top_level_windows.iter_mut().filter(|w| w.pid == pid) {
                win.icon_data_url = url.clone();
            }
        }
    }
    // Release the lock
    drop(icon_cache);

    for win in &mut top_level_windows {
        if win.icon_data_url.is_empty() {
            // Fallback to default icon if still empty
            win.icon_data_url = get_default_icon_data_url();
        }
    }

    top_level_windows
}

/// Return one `WindowInfo` entry per running PID whose executable name
/// (case-insensitive) matches any name in `names`, **excluding** PIDs that
/// are already represented in `exclude_pids` (i.e. processes that already
/// have at least one visible window in the normal window list).
///
/// These "tray" entries have `hwnd = 0` and `no_window = true`.  They let
/// the UI keep tracked processes visible even when the application has
/// minimized all its windows to the system tray.
pub fn get_processes_by_name(names: &[&str], exclude_pids: &HashSet<u32>) -> Vec<WindowInfo> {
    let names_lower: Vec<String> = names.iter().map(|n| n.to_lowercase()).collect();

    let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(h) => h,
        Err(_) => return Vec::new(),
    };

    let mut entries: Vec<WindowInfo> = Vec::new();
    // Track which PIDs we've already added to avoid duplicates within this call.
    let mut seen_pids: HashSet<u32> = HashSet::new();

    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    unsafe {
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;

                if !exclude_pids.contains(&pid) && !seen_pids.contains(&pid) {
                    let nul = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let exe_name = String::from_utf16_lossy(&entry.szExeFile[..nul]);
                    let exe_lower = exe_name.to_lowercase();

                    if names_lower.contains(&exe_lower) {
                        seen_pids.insert(pid);
                        let parent_pid = entry.th32ParentProcessID;
                        let (exe_path, process_name) = get_process_info(pid);
                        entries.push(WindowInfo {
                            hwnd: 0,
                            // Show the process name as the title so the UI has
                            // something meaningful to display.
                            title: exe_name.clone(),
                            class_name: String::new(),
                            pid,
                            parent_pid,
                            hidden: false, // lock state is applied by the frontend
                            exe_path: exe_path.clone(),
                            process_name: if process_name.is_empty() {
                                exe_name
                            } else {
                                process_name
                            },
                            icon_data_url: String::new(), // no HWND → no icon source
                            original_icon_data_url: {
                                // Extract the stable app icon from the executable file
                                // so the UI can display it even when the app is minimized to tray.
                                if let Some((width, height, pixels)) = get_icon_from_exe(&exe_path) {
                                    icon_b64_from_rgba(width, height, pixels).unwrap_or_default()
                                } else {
                                    String::new()
                                }
                            },
                            no_window: true,
                        });
                    }
                }

                entry = std::mem::zeroed();
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    entries
}

pub struct Injector {}

impl Injector {
    fn get_dll_path(process: &OwnedProcess) -> Result<PathBuf, Box<dyn error::Error>> {
        let mut dll_path = env::current_exe()?;
        dll_path.pop();

        if cfg!(debug_assertions) && process.runs_under_wow64()? {
            dll_path.push("../i686-pc-windows-msvc/debug/ScreenShieldHook.dll");
        } else if process.is_x86()? {
            dll_path.push("ScreenShieldHook32.dll");
        } else {
            dll_path.push("ScreenShieldHook.dll");
        }

        Ok(dll_path)
    }

    pub fn get_remote_proc<F: RawRpcFunctionPtr>(
        syringe: &Syringe,
        module: BorrowedProcessModule<'_>,
        proc_name: &str,
    ) -> Result<RemoteRawProcedure<F>, Box<dyn error::Error>> {
        match unsafe { syringe.get_raw_procedure::<F>(module, proc_name) }? {
            Some(remote_proc) => Ok(remote_proc),
            None => Err(format!("Failed to find procedure {}", proc_name).into()),
        }
    }

    pub fn set_window_props(
        target_process: OwnedProcess,
        hwnds: &[u32],
        hide: bool,
        hide_from_taskbar: Option<bool>,
    ) -> Result<(), Box<dyn error::Error>> {
        let dll_path = Self::get_dll_path(&target_process)?;
        // Resolve process name BEFORE moving target_process into Syringe.
        let proc_pid = target_process.pid().map(|p| p.get()).unwrap_or(0);
        let (_, proc_name) = get_process_info(proc_pid);
        let syringe = Syringe::for_process(target_process);
        let module = syringe.find_or_inject(dll_path)?;

        let remote_proc = Self::get_remote_proc::<extern "system" fn(u32, bool) -> bool>(
            &syringe,
            module,
            "SetWindowVisibility",
        )?;

        let remote_proc2 = Self::get_remote_proc::<extern "system" fn(u32, bool) -> bool>(
            &syringe,
            module,
            "HideFromTaskbar",
        )?;

        for hwnd in hwnds {
            remote_proc.call(*hwnd, hide).unwrap();

            if let Some(hide_from_taskbar) = hide_from_taskbar {
                remote_proc2.call(*hwnd, hide_from_taskbar).unwrap();
            }
        }

        // Enable (or disable) the in-process INCONTEXT hook so every future window
        // spawned by this process has WDA_EXCLUDEFROMCAPTURE applied synchronously
        // on the ShowWindow thread — before DWM composites the first frame.
        // Best-effort: silently skip if the export isn't present (older DLL build).
        //
        // SKIP for explorer.exe — it hosts system UI (desktop, taskbar, Alt-Tab
        // overlay) alongside File Explorer windows.  Enabling the auto-hide hook
        // on explorer.exe would cause every future explorer.exe window (including
        // new File Explorer windows) to be persistently hidden from capture.
        // System UI HWNDs are targeted individually via SetWindowDisplayAffinity.
        let is_explorer = proc_name.eq_ignore_ascii_case("explorer.exe");
        if !is_explorer {
            if let Ok(remote_enable) =
                Self::get_remote_proc::<extern "system" fn(bool) -> bool>(
                    &syringe,
                    module,
                    "EnableAutoHide",
                )
            {
                let _ = remote_enable.call(hide);
            }
        }

        Ok(())
    }

    pub fn set_window_props_with_pid(
        pid: u32,
        hwnd: u32,
        hide: bool,
        hide_from_taskbar: Option<bool>,
    ) -> Result<(), Box<dyn error::Error>> {
        let target_process = OwnedProcess::from_pid(pid)?;
        Self::set_window_props(target_process, &[hwnd], hide, hide_from_taskbar)?;
        Ok(())
    }

    /// Enumerate every running process whose executable name (case-insensitive) matches
    /// `name`, inject ScreenShieldHook.dll into each one, and call `EnableAutoHide(enable)`.
    ///
    /// This is the complement to per-window injection: it covers processes that have
    /// no visible windows at call time — for example, newly-spawned steamwebhelper.exe
    /// instances that haven't created any top-level windows yet.  Calling it with
    /// `enable = true` after the initial hide, and again from the watcher callback,
    /// ensures the in-process INCONTEXT hook is present in every relevant process
    /// before those processes create their first window.
    ///
    /// Errors for individual processes (access denied, architecture mismatch, etc.)
    /// are silently ignored — the function is best-effort.
    pub fn apply_auto_hide_for_name(name: &str, enable: bool) {
        let name_lower = name.to_lowercase();
        let self_pid = std::process::id();

        // Collect all matching PIDs from a single process snapshot.
        let snapshot = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
            Ok(h) => h,
            Err(_) => return,
        };

        let mut pids: Vec<u32> = Vec::new();
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        unsafe {
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let this_pid = entry.th32ProcessID;
                    if this_pid != self_pid {
                        let nul = entry
                            .szExeFile
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(entry.szExeFile.len());
                        let exe =
                            String::from_utf16_lossy(&entry.szExeFile[..nul]).to_lowercase();
                        if exe == name_lower {
                            pids.push(this_pid);
                        }
                    }
                    entry = std::mem::zeroed();
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }

        for pid in pids {
            let Ok(proc) = OwnedProcess::from_pid(pid) else {
                continue;
            };
            let Ok(dll_path) = Self::get_dll_path(&proc) else {
                continue;
            };
            let syringe = Syringe::for_process(proc);
            let Ok(module) = syringe.find_or_inject(&dll_path) else {
                continue;
            };
            let Ok(remote_enable) =
                Self::get_remote_proc::<extern "system" fn(bool) -> bool>(
                    &syringe,
                    module,
                    "EnableAutoHide",
                )
            else {
                continue;
            };
            let _ = remote_enable.call(enable);
        }
    }
}

// ── ETW process-creation watcher ─────────────────────────────────────────────
// Subscribes to the Microsoft-Windows-Kernel-Process provider and fires
// an injection for any newly-spawned process whose name matches the watched
// list.  Latency is ~1 ms from process-create to callback, well ahead of the
// 200–500 ms window-creation time of CEF-based helpers.

/// Live set of watched process names — updated on each start_etw_process_watcher call
/// so serve mode can refresh the list without restarting the ETW session.
static ETW_WATCH_NAMES: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
/// Guards the one-time ETW session startup — the session runs for the lifetime of the process.
static ETW_STARTED: OnceLock<()> = OnceLock::new();

/// Microsoft-Windows-Kernel-Process provider GUID  {22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716}
const KERNEL_PROCESS_GUID: windows::core::GUID = windows::core::GUID {
    data1: 0x22fb2cd6,
    data2: 0x0e7b,
    data3: 0x422b,
    data4: [0xa0, 0xc7, 0x2f, 0xad, 0x1f, 0xd0, 0xe7, 0x16],
};

/// Inject ScreenShieldHook.dll into a single known PID and call EnableAutoHide(true).
/// Called from the ETW callback thread — spawns a worker so the callback
/// returns quickly.
fn inject_pid_enable_auto_hide(pid: u32) {
    let Ok(proc) = OwnedProcess::from_pid(pid) else { return };
    let Ok(dll_path) = Injector::get_dll_path(&proc) else { return };
    let syringe = Syringe::for_process(proc);
    let Ok(module) = syringe.find_or_inject(&dll_path) else { return };
    let Ok(remote_enable) = Injector::get_remote_proc::<extern "system" fn(bool) -> bool>(
        &syringe,
        module,
        "EnableAutoHide",
    ) else {
        return;
    };
    let _ = remote_enable.call(true);
}

/// ETW event callback — called on the ProcessTrace thread for every event.
unsafe extern "system" fn etw_event_callback(record: *mut EVENT_RECORD) {
    if record.is_null() {
        return;
    }
    let record = unsafe { &*record };

    // Only care about the Kernel-Process provider.
    if record.EventHeader.ProviderId != KERNEL_PROCESS_GUID {
        return;
    }
    // Event ID 1 = ProcessStart.
    if record.EventHeader.EventDescriptor.Id != 1 {
        return;
    }

    let data_len = record.UserDataLength as usize;
    if data_len < 4 || record.UserData.is_null() {
        return;
    }

    let user_data = unsafe {
        std::slice::from_raw_parts(record.UserData as *const u8, data_len)
    };

    // UserData layout for ProcessStart:
    //   offset 0..4  : ProcessID       (UINT32, new process)
    //   offset 4..8  : ParentProcessID (UINT32)
    //   offset 8..   : ImageName       (null-terminated UTF-16LE)
    let new_pid = u32::from_le_bytes([
        user_data[0], user_data[1], user_data[2], user_data[3],
    ]);

    // Derive file name — prefer parsing UserData to avoid an extra OpenProcess.
    let file_name: String = if data_len > 8 {
        let name_bytes = &user_data[8..];
        let wchars: Vec<u16> = name_bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .take_while(|&c| c != 0)
            .collect();
        let full_path = String::from_utf16_lossy(&wchars);
        // Path may be NT form  (\Device\…\foo.exe) or Win32 — split on '\' either way.
        full_path
            .split('\\')
            .next_back()
            .unwrap_or(&full_path)
            .to_lowercase()
    } else {
        // Fallback: look up via OpenProcess (cheap — just reads the PEB).
        let (_, pname) = get_process_info(new_pid);
        pname.to_lowercase()
    };

    // Check once under the lock, then release before spawning any thread.
    let file_matches = {
        let watched = ETW_WATCH_NAMES.lock().unwrap();
        !file_name.is_empty() && watched.iter().any(|n| n == &file_name)
    };
    if !file_matches {
        return;
    }

    // Dispatch injection on a worker thread so this callback returns promptly.
    let pid = new_pid;
    std::thread::spawn(move || inject_pid_enable_auto_hide(pid));
}

/// Stop a named ETW trace session (best-effort; used for startup cleanup and shutdown).
unsafe fn stop_etw_session(session_name_wide: &[u16]) {
    let props_size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>()
        + session_name_wide.len() * 2;
    let mut buf: Vec<u8> = vec![0u8; props_size];
    let props = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
    unsafe {
        (*props).Wnode.BufferSize = props_size as u32;
        (*props).LoggerNameOffset =
            std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;
        // Pass the session name; ControlTraceW finds the session by name when
        // the handle is the default (zero).
        let _ = ControlTraceW(
            CONTROLTRACE_HANDLE::default(),
            windows::core::PCWSTR(session_name_wide.as_ptr()),
            props,
            EVENT_TRACE_CONTROL_STOP,
        );
    }
}

/// Start (or update) the ETW process-creation watcher.
///
/// Updates the global name list and — on the very first call — spawns a
/// background thread that runs an ETW real-time session.  Subsequent calls
/// only refresh the watched names; the already-running session picks them up
/// automatically through the shared mutex.
pub fn start_etw_process_watcher(names: Vec<String>) {
    *ETW_WATCH_NAMES.lock().unwrap() = names;

    // Only start the ETW session thread once per process lifetime.
    if ETW_STARTED.set(()).is_err() {
        return; // session already running — name update above is sufficient
    }

    std::thread::spawn(|| unsafe {
        const SESSION: &str = "ScreenShieldProcWatcher";
        let session_name_wide: Vec<u16> =
            SESSION.encode_utf16().chain(std::iter::once(0u16)).collect();

        // Clean up any session left by a previous unclean exit.
        stop_etw_session(&session_name_wide);

        // Allocate EVENT_TRACE_PROPERTIES followed immediately by the session
        // name in the same heap buffer.
        let props_size = std::mem::size_of::<EVENT_TRACE_PROPERTIES>()
            + session_name_wide.len() * 2;
        let mut buf: Vec<u8> = vec![0u8; props_size];
        let props = buf.as_mut_ptr() as *mut EVENT_TRACE_PROPERTIES;
        (*props).Wnode.BufferSize = props_size as u32;
        (*props).Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        (*props).LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        (*props).LoggerNameOffset =
            std::mem::size_of::<EVENT_TRACE_PROPERTIES>() as u32;

        let mut session_handle = CONTROLTRACE_HANDLE::default();
        if StartTraceW(
            &mut session_handle,
            windows::core::PCWSTR(session_name_wide.as_ptr()),
            props,
        )
        .is_err()
        {
            return;
        }

        // Enable the Kernel-Process provider — keyword 0 means "all events".
        if EnableTraceEx2(
            session_handle,
            &KERNEL_PROCESS_GUID,
            EVENT_CONTROL_CODE_ENABLE_PROVIDER.0,
            4u8, // TRACE_LEVEL_INFORMATION
            0u64,
            0u64,
            0u32,
            None,
        )
        .is_err()
        {
            stop_etw_session(&session_name_wide);
            return;
        }

        let mut logfile = EVENT_TRACE_LOGFILEW::default();
        logfile.LoggerName =
            windows::core::PWSTR(session_name_wide.as_ptr() as *mut u16);
        logfile.Anonymous1.ProcessTraceMode =
            PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        logfile.Anonymous2.EventRecordCallback = Some(etw_event_callback);

        let trace_handle = OpenTraceW(&mut logfile);
        // INVALID_PROCESSTRACE_HANDLE = 0xFFFFFFFFFFFFFFFF
        if trace_handle.Value == u64::MAX {
            stop_etw_session(&session_name_wide);
            return;
        }

        // Blocking until the session is stopped (process exit).
        let _ = ProcessTrace(std::slice::from_ref(&trace_handle), None, None);

        let _ = CloseTrace(trace_handle);
        stop_etw_session(&session_name_wide);
    });
}
