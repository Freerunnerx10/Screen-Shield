# Startup Feature Fix Plan for ScreenShield

## Problem Analysis

**Current Issue:**
- "Launch on Startup" feature does not work after reboot
- A legacy registry entry exists at `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\com.screenshield.app`
- This entry appears in Windows Startup Apps but is turned off or ineffective
- Standard startup methods (registry Run key, Startup folder, Electron app.setLoginItemSettings) do NOT support elevation

**Root Cause:**
The current implementation has several bugs that prevent the scheduled task-based startup from working correctly:

1. **Portable version not supported** - `createStartupTask()` only works for packaged apps
2. **Incorrect execSync usage** - `checkStartupTaskExists()` uses wrong syntax
3. **Legacy registry never cleaned up** - `removeLegacyRegistryStartup()` exists but is never called
4. **Poor error handling** - Async operations not properly awaited
5. **Missing user context** - Task created without specifying current user

## Solution Overview

Implement a robust Task Scheduler-based startup mechanism that:
- Creates a scheduled task that runs at user login
- Runs with highest privileges (admin) without UAC prompt
- Supports both installed and portable versions
- Properly cleans up legacy registry entries
- Has comprehensive error handling

## Detailed Implementation Steps

### Step 1: Fix `createStartupTask()` Function

**File:** [`main.js`](main.js:137-174)

**Current Issues:**
- Line 138: `if (process.platform !== 'win32' || !app.isPackaged) return;` prevents portable version from working
- Lines 162-169: `execFile` is async but not properly awaited
- Missing user context (`/RU` parameter)

**Changes:**
```javascript
function createStartupTask() {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve, reject) => {
    // For packaged app, use the executable path directly
    // For portable version, use absolute path to current EXE
    const command = process.execPath;
    const args = [];

    // Build the command string for the task scheduler
    let commandString = `"${command}"`;
    if (args.length > 0) {
      commandString += ` ${args.map(arg => `"${arg}"`).join(' ')}`;
    }

    const taskName = "ScreenShieldStartup";

    // Remove any existing task to avoid duplicates
    execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true }, () => {
      // Ignore errors - task might not exist
      
      // Create the task with current user context
      execFile('schtasks', [
        '/Create',
        '/TN', taskName,
        '/TR', commandString,
        '/SC', 'ONLOGIN',
        '/RL', 'HIGHEST',   // Run with highest privileges
        '/RU', '%USERNAME%', // Run as current user
        '/F'                // Force creation (overwrite if exists)
      ], { windowsHide: true }, (error) => {
        if (error) {
          console.error('[Screen Shield] Failed to create startup task:', error);
          reject(error);
        } else {
          console.log('[Screen Shield] Startup task created successfully.');
          resolve();
        }
      });
    });
  });
}
```

### Step 2: Fix `removeStartupTask()` Function

**File:** [`main.js`](main.js:176-186)

**Current Issues:**
- `execFile` is async but not properly awaited
- No error handling

**Changes:**
```javascript
function removeStartupTask() {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve) => {
    const taskName = "ScreenShieldStartup";
    execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true }, (error) => {
      if (error) {
        console.error('[Screen Shield] Failed to remove startup task:', error);
      } else {
        console.log('[Screen Shield] Startup task removed successfully.');
      }
      resolve(); // Always resolve - don't fail if task doesn't exist
    });
  });
}
```

### Step 3: Fix `checkStartupTaskExists()` Function

**File:** [`main.js`](main.js:202-211)

**Current Issues:**
- Line 206: Incorrect usage of `execSync` - expects single command string, not separate arguments

**Changes:**
```javascript
function checkStartupTaskExists() {
  if (process.platform !== 'win32') return false;
  const taskName = "ScreenShieldStartup";
  try {
    execSync(`schtasks /Query /TN ${taskName}`, { windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}
```

### Step 4: Add Legacy Registry Cleanup on Startup

**File:** [`main.js`](main.js:385-421)

**Current Issues:**
- `removeLegacyRegistryStartup()` exists but is never called
- Legacy registry entry remains in system

**Changes:**
Add call to `removeLegacyRegistryStartup()` in the `app.whenReady()` callback:

```javascript
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)

  // Clean up legacy registry startup entry
  removeLegacyRegistryStartup()

  // ── 1. Show the splash screen FIRST ────────────────────────────────
  // ... rest of existing code ...
})
```

### Step 5: Update IPC Handlers for Async Operations

**File:** [`main.js`](main.js:950-963)

**Current Issues:**
- Lines 951-958: `set-launch-at-startup` handler doesn't await async functions
- No error handling for failed operations

**Changes:**
```javascript
/** Set or remove the Windows startup (login item) entry */
ipcMain.handle('set-launch-at-startup', async (_event, enable) => {
  try {
    if (!!enable) {
      await createStartupTask();
    } else {
      await removeStartupTask();
    }
    writeConfig({ launchAtStartup: !!enable })
    return { success: true }
  } catch (error) {
    console.error('[Screen Shield] Failed to update startup setting:', error);
    return { success: false, error: error.message }
  }
})

/** Returns the current launch-at-startup state */
ipcMain.handle('get-launch-at-startup', () => {
  return checkStartupTaskExists()
})
```

### Step 6: Update Frontend Error Handling

**File:** [`frontend/src/App.jsx`](frontend/src/App.jsx:855-859)

**Current Issues:**
- Line 858: No error handling for failed startup setting

**Changes:**
```javascript
onChange={async (e) => {
  const enabled = e.target.checked
  setLaunchAtStartup(enabled)
  try {
    const result = await api.setLaunchAtStartup?.(enabled)
    if (result && !result.success) {
      // Revert the toggle if the operation failed
      setLaunchAtStartup(!enabled)
      console.error('Failed to update startup setting:', result.error)
    }
  } catch (error) {
    // Revert the toggle if the operation failed
    setLaunchAtStartup(!enabled)
    console.error('Failed to update startup setting:', error)
  }
}}
```

### Step 7: Add Portable Version Path Tracking

**File:** [`main.js`](main.js:137-174)

**Enhancement:**
For portable versions, track the EXE path and recreate the task if it changes:

```javascript
function createStartupTask() {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const command = process.execPath;
    const taskName = "ScreenShieldStartup";
    
    // Check if task exists with different path
    try {
      const existingTask = execSync(`schtasks /Query /TN ${taskName} /FO LIST /V`, { windowsHide: true }).toString();
      if (existingTask.includes(command)) {
        // Task already exists with correct path
        console.log('[Screen Shield] Startup task already exists with correct path.');
        resolve();
        return;
      }
    } catch (e) {
      // Task doesn't exist or error querying - continue with creation
    }

    // Remove any existing task to avoid duplicates
    execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true }, () => {
      // Create the task
      execFile('schtasks', [
        '/Create',
        '/TN', taskName,
        '/TR', `"${command}"`,
        '/SC', 'ONLOGIN',
        '/RL', 'HIGHEST',
        '/RU', '%USERNAME%',
        '/F'
      ], { windowsHide: true }, (error) => {
        if (error) {
          console.error('[Screen Shield] Failed to create startup task:', error);
          reject(error);
        } else {
          console.log('[Screen Shield] Startup task created successfully.');
          resolve();
        }
      });
    });
  });
}
```

## Implementation Order

1. **Step 1-3:** Fix core functions (createStartupTask, removeStartupTask, checkStartupTaskExists)
2. **Step 4:** Add legacy registry cleanup
3. **Step 5:** Update IPC handlers for async operations
4. **Step 6:** Update frontend error handling
5. **Step 7:** Add portable version path tracking (optional enhancement)

## Testing Checklist

- [ ] Enable "Launch on Startup" in settings
- [ ] Verify scheduled task is created in Task Scheduler
- [ ] Verify task runs with highest privileges
- [ ] Verify task runs as current user
- [ ] Reboot the system
- [ ] Verify ScreenShield launches automatically
- [ ] Verify ScreenShield runs with admin privileges (no UAC prompt)
- [ ] Disable "Launch on Startup" in settings
- [ ] Verify scheduled task is removed
- [ ] Test with portable version
- [ ] Test with installed version
- [ ] Verify legacy registry entry is cleaned up
- [ ] Test error handling (e.g., disable Task Scheduler service)

## Expected Outcome

After implementing this fix:
- "Launch on Startup" feature works reliably for both installed and portable versions
- ScreenShield starts automatically at user login
- ScreenShield runs with administrator privileges without UAC prompt
- Legacy registry entries are cleaned up
- No dependency on Windows "Startup Apps" UI
- Robust error handling prevents silent failures

## Files to Modify

1. **[`main.js`](main.js)** - Fix startup task functions and add cleanup
2. **[`frontend/src/App.jsx`](frontend/src/App.jsx)** - Add error handling for startup toggle

## Files to Verify (No Changes Needed)

1. **[`preload.js`](preload.js)** - API exposure is correct
2. **[`app.manifest`](app.manifest)** - Already has requireAdministrator
3. **[`package.json`](package.json)** - Build configuration is correct
