# Icon Caching Plan for ScreenShield

## Problem Statement
When applications are minimized or closed to the system tray, ScreenShield loses their icons and falls back to the default icon (white "S" on red background). This happens because:
- `get_processes_by_name()` creates tray entries with `icon_data_url: String::new()` (line 653 in native.rs)
- The frontend's `AppIcon` component falls back to the default icon when `dataUrl` is empty

## Solution Overview
Leverage the existing `original_icon_data_url` field in the `WindowInfo` struct to cache and preserve app icons when they're minimized to tray.

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Current Flow (Broken)                         │
├─────────────────────────────────────────────────────────────────┤
│ 1. App open → get_icon(hwnd) → icon_data_url populated ✓       │
│ 2. App minimized → get_processes_by_name() → icon_data_url: "" ✗│
│ 3. Frontend → AppIcon → falls back to default icon ✗            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    New Flow (Fixed)                              │
├─────────────────────────────────────────────────────────────────┤
│ 1. App open → get_icon(hwnd) → icon_data_url populated ✓       │
│ 2. App minimized → get_processes_by_name() →                   │
│    - icon_data_url: "" (no HWND available)                      │
│    - original_icon_data_url: get_icon_from_exe(exe_path) ✓     │
│ 3. Frontend → AppIcon → uses original_icon_data_url as fallback│
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### 1. Backend Changes (native-backend/injector/src/native.rs)

#### Change 1: Update `get_processes_by_name()` to populate `original_icon_data_url`

**Location:** Lines 605-670

**Current code (line 653):**
```rust
icon_data_url: String::new(), // no HWND → no icon source
```

**New code:**
```rust
icon_data_url: String::new(), // no HWND → no icon source
original_icon_data_url: {
    // Extract the stable app icon from the executable file
    if let Some((width, height, pixels)) = get_icon_from_exe(&exe_path) {
        icon_b64_from_rgba(width, height, pixels).unwrap_or_default()
    } else {
        String::new()
    }
},
```

**Rationale:**
- `get_icon_from_exe()` extracts the static application icon from the exe's resource section
- This icon is stable and doesn't change when the app is minimized
- The `original_icon_data_url` field already exists in the `WindowInfo` struct (line 66)

### 2. Frontend Changes (frontend/src/WindowList.jsx)

#### Change 2: Update `AppIcon` component to use `original_icon_data_url` as fallback

**Location:** Lines 73-92

**Current code:**
```jsx
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
```

**New code:**
```jsx
function AppIcon({ dataUrl, originalDataUrl, letter, processName }) {
  const [failed, setFailed] = useState(false)
  const [originalFailed, setOriginalFailed] = useState(false)
  
  // Try current icon first
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
  
  // Fallback to original icon (cached from exe) when current icon unavailable
  if (originalDataUrl && !originalFailed) {
    return (
      <img
        className="app-icon"
        src={originalDataUrl}
        alt=""
        draggable={false}
        onError={() => setOriginalFailed(true)}
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
```

#### Change 3: Update `AppHeader` to pass `originalDataUrl` prop

**Location:** Lines 115-166

**Current code (line 128-132):**
```jsx
<AppIcon
  dataUrl={group.iconDataUrl}
  letter={iconLetter}
  processName={group.processName}
/>
```

**New code:**
```jsx
<AppIcon
  dataUrl={group.iconDataUrl}
  originalDataUrl={group.originalIconDataUrl}
  letter={iconLetter}
  processName={group.processName}
/>
```

#### Change 4: Update `WindowList` to include `originalIconDataUrl` in group

**Location:** Lines 225-244

**Current code (line 235):**
```jsx
iconDataUrl: win.icon_data_url ?? null,
```

**New code:**
```jsx
iconDataUrl: win.icon_data_url ?? null,
originalIconDataUrl: win.original_icon_data_url ?? null,
```

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Rust Backend                                  │
├─────────────────────────────────────────────────────────────────┤
│ get_top_level_windows()                                         │
│   ├─ get_icon(hwnd) → icon_data_url                            │
│   └─ get_icon_from_exe(exe_path) → original_icon_data_url      │
│                                                                  │
│ get_processes_by_name()                                         │
│   ├─ icon_data_url: "" (no HWND)                               │
│   └─ original_icon_data_url: get_icon_from_exe(exe_path) ← NEW│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    IPC Layer (main.js)                           │
├─────────────────────────────────────────────────────────────────┤
│ get-windows handler → returns WindowInfo[]                      │
│   - icon_data_url                                               │
│   - original_icon_data_url ← NEW                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (React)                              │
├─────────────────────────────────────────────────────────────────┤
│ App.jsx                                                         │
│   └─ WindowList groups windows by process_name                  │
│       └─ group.iconDataUrl = win.icon_data_url                 │
│       └─ group.originalIconDataUrl = win.original_icon_data_url│
│                                                                  │
│ WindowList.jsx                                                   │
│   └─ AppIcon component                                          │
│       ├─ Try dataUrl (current icon)                            │
│       ├─ Fallback to originalDataUrl (cached icon) ← NEW       │
│       └─ Fallback to default letter tile                       │
└─────────────────────────────────────────────────────────────────┘
```

## Testing Strategy

### Test Case 1: App Open → Minimize to Tray
1. Open Steam (or any app)
2. Verify icon is displayed correctly in ScreenShield
3. Minimize Steam to tray
4. Verify icon is still displayed correctly (not default icon)

### Test Case 2: App Closed to Tray
1. Open Discord (or any app with tray support)
2. Verify icon is displayed correctly
3. Close Discord to tray (X button)
4. Verify icon is still displayed correctly

### Test Case 3: App Restart
1. Open an app
2. Verify icon is cached
3. Close the app completely
4. Reopen the app
5. Verify icon is displayed correctly (should re-cache)

### Test Case 4: Multiple Instances
1. Open multiple instances of the same app (e.g., multiple Chrome windows)
2. Verify all instances show the same icon
3. Minimize one instance to tray
4. Verify the minimized instance still shows the correct icon

## Edge Cases Handled

1. **No icon available:** If `get_icon_from_exe()` fails, `original_icon_data_url` will be empty, and the frontend falls back to the default letter tile.

2. **Explorer.exe:** Already handled specially - uses `FolderIcon` SVG instead of extracted icon.

3. **Dynamic icons:** Some apps (like File Explorer) have dynamic window icons. The `original_icon_data_url` provides the stable app icon from the exe, which is more appropriate for tray entries.

4. **Icon load failure:** Both `dataUrl` and `originalDataUrl` have separate error handlers, so if one fails, the other can still be used.

## Files Modified

1. `native-backend/injector/src/native.rs` - Update `get_processes_by_name()` to populate `original_icon_data_url`
2. `frontend/src/WindowList.jsx` - Update `AppIcon` component and related code to use `original_icon_data_url` as fallback

## Dependencies

- No new dependencies required
- Uses existing `get_icon_from_exe()` function
- Uses existing `icon_b64_from_rgba()` function
- Uses existing `WindowInfo` struct fields

## Rollback Plan

If issues arise:
1. Revert changes to `native.rs` - `get_processes_by_name()` will return to empty `icon_data_url`
2. Revert changes to `WindowList.jsx` - `AppIcon` will only use `dataUrl`
3. The system will return to current behavior (default icon for tray entries)
