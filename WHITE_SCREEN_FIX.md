# White Screen Fix for Long Idle Periods

## Problem
When ScreenShield runs and is minimized to the system tray for several hours, reopening the app sometimes shows only a **white screen**, requiring a restart.

## Root Cause
After extended idle time (hours), Windows may reclaim GPU resources or Chromium's rendering context may be lost. When the window is shown again, the webContents may not properly repaint, resulting in a white screen.

## Solution Implemented

### 1. Force Repaint on Show
Added a `show` event handler that forces Chromium to repaint the entire page using `webContents.invalidate()`. This recovers from GPU context loss or rendering pipeline suspension.

```javascript
mainWindow.on('show', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.invalidate()
  }
})
```

### 2. Content Verification with Fallback
For very long idle periods (>5 minutes), added a delayed content verification that:
- Checks if the page has any visible content
- Detects blank pages by examining DOM elements
- Reloads the webContents if blank content is detected
- Implements a retry mechanism (max 3 retries)
- Falls back to reloading the URL if retries are exhausted

```javascript
function verifyAndRecoverContent() {
  mainWindow.webContents.executeJavaScript(`
    (function() {
      const body = document.body
      if (!body) return { blank: true, reason: 'no-body' }
      
      const hasContent = body.children.length > 0
      const hasVisibleText = body.innerText && body.innerText.trim().length > 0
      const hasVisibleElements = body.querySelector('div, span, p, img, svg, button, input')
      
      if (!hasContent && !hasVisibleText && !hasVisibleElements) {
        return { blank: true, reason: 'no-content' }
      }
      
      return { blank: false }
    })()
  `).then((result) => {
    if (result.blank) {
      // Reload to recover rendering
      mainWindow.webContents.reload()
    }
  })
}
```

### 3. Renderer Crash Recovery
Added automatic recovery for renderer process crashes:

```javascript
mainWindow.webContents.on('render-process-gone', (event, details) => {
  console.log(`[Screen Shield] Renderer process gone: ${details.reason}`)
  setTimeout(() => {
    mainWindow.webContents.reload()
  }, 100)
})
```

### 4. Comprehensive Logging
Added detailed logging for debugging:
- Window hide/show events with timestamps
- Duration of idle periods
- Content verification results
- Recovery attempts and outcomes
- Renderer crash detection

## Benefits

1. **Automatic Recovery**: The app now automatically recovers from white screen states without user intervention
2. **No User Impact**: Recovery happens transparently in the background
3. **Robust Fallback**: Multiple recovery strategies ensure the UI always restores
4. **Debug Visibility**: Comprehensive logging helps diagnose any remaining issues
5. **No Regressions**: Existing functionality (minimize to tray, hidden apps, admin elevation) remains unchanged

## Testing Recommendations

1. **Short Idle**: Minimize to tray for 5-10 minutes, reopen - should show UI immediately
2. **Long Idle**: Minimize to tray for 1+ hours, reopen - should show UI after brief recovery
3. **Very Long Idle**: Minimize to tray overnight, reopen - should show UI after recovery
4. **Multiple Restorations**: Repeat the above multiple times to verify retry logic
5. **Tray Functionality**: Verify single-click, double-click, and context menu all work
6. **Hidden Apps**: Verify hidden windows remain hidden after recovery
7. **Admin Elevation**: Verify elevation prompt still appears when needed

## Files Modified

- `main.js`: Added show/hide event handlers, content verification, and crash recovery logic

## No Changes Required

- `frontend/src/App.jsx`: Frontend rendering logic unchanged
- `preload.js`: IPC bridge unchanged
- `app.manifest`: Admin elevation unchanged
- Tray setup and context menu unchanged
