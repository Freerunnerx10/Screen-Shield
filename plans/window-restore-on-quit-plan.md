# Window Restoration on Quit Implementation Plan

## Problem
When the user quits the Screen Shield app, any windows that were hidden (via the hide functionality) remain hidden after the app closes. Users must manually restore these windows or restart their applications.

## Solution
Modify the app's quit lifecycle to automatically restore all hidden windows before the application terminates.

## Implementation Details

### 1. Track Hidden Windows
Add a global array to track the HWNDs of windows that have been hidden by the app.

```javascript
let hiddenWindows = []; // Track HWNDs of hidden windows
```

### 2. Update Hide Window Handler
Modify the existing `hide-window` IPC handler to record when windows are hidden.

```javascript
/** Hide a window by hwnd */
ipcMain.handle('hide-window', async (_event, hwnd, altTab) => {
  if (!client) return
  
  // Track the window as hidden
  if (!hiddenWindows.includes(hwnd)) {
    hiddenWindows.push(hwnd)
  }
  
  return client.send('hide', { hwnds: [hwnd], alt_tab: !!altTab })
})
```

### 3. Update Unhide Window Handler
Modify the existing `unhide-window` IPC handler to remove windows from tracking when they are shown.

```javascript
/** Unhide a window by hwnd */
ipcMain.handle('unhide-window', async (_event, hwnd, altTab) => {
  if (!client) return
  
  // Remove from tracking when unhidden
  hiddenWindows = hiddenWindows.filter(h => h !== hwnd)
  
  return client.send('unhide', { hwnds: [hwnd], alt_tab: !!altTab })
})
```

### 4. Enhance Before-Quit Handler
Modify the existing `before-quit` handler to restore all hidden windows before app exit.

```javascript
app.on('before-quit', () => {
  // Restore all hidden windows before quitting
  if (client && hiddenWindows.length > 0) {
    // Make a copy of the array to avoid issues if it changes during iteration
    const windowsToRestore = [...hiddenWindows]
    
    try {
      // Unhide all tracked windows
      client.send('unhide', { hwnds: windowsToRestore, alt_tab: false })
      
      // Clear the tracking array
      hiddenWindows = []
    } catch (error) {
      // Log error but continue with app exit
      console.error('[Screen Shield] Error restoring hidden windows on quit:', error)
    }
  }
  
  // Existing cleanup logic
  if (client) {
    client.stop()
    client = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
})
```

### 5. Safety Considerations
- **Error Handling**: Wrap the unhide call in try/catch to prevent app crashes if the backend is unavailable
- **Window Existence**: The Rust backend should handle cases where windows no longer exist
- **Duplicate Tracking**: Check if HWND is already tracked before adding to prevent duplicates
- **Array Safety**: Use spread operator to create a copy before iteration to avoid modification during traversal

### 6. Requirements Verification
✅ Hooks into app quit lifecycle via `app.on('before-quit')`  
✅ Iterates through all currently hidden windows before exit  
✅ Removes hiding mechanism via existing unhide-window IPC  
✅ Does NOT run when minimizing to tray (only runs on actual quit)  
✅ Handles errors safely with try/catch  
✅ Proceeds with normal app exit after restoration  

## Files to Modify
- `main.js`: Add hiddenWindows tracking and modify IPC handlers and before-quit handler

## Testing Approach
1. Hide several windows using the app's hide functionality
2. Verify they are tracked in the hiddenWindows array
3. Quit the app via system tray → Quit menu
4. Verify all previously hidden windows are now visible
5. Test edge cases: quitting with no hidden windows, error conditions
6. Verify minimizing to tray does NOT trigger restoration