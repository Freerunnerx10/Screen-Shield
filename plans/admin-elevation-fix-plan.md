# Admin Elevation Fix Plan for ScreenShield

## Problem Analysis

**Current Behavior:**
- Portable version: ✓ Correctly prompts for UAC on launch
- Installed version: ✗ Does NOT prompt for UAC when launched

**Root Cause:**
The NSIS installer configuration in [`package.json`](package.json:82-93) is missing the `requestExecutionLevel` setting. The portable version has it configured correctly:

```json
"portable": {
  "artifactName": "ScreenShield-Portable-${version}.exe",
  "requestExecutionLevel": "admin"  // ✓ Present
}
```

But the NSIS installer configuration does NOT:

```json
"nsis": {
  "oneClick": false,
  "allowToChangeInstallationDirectory": true,
  "perMachine": true,
  // ✗ Missing: "requestExecutionLevel": "admin"
  ...
}
```

When electron-builder builds the NSIS installer without `requestExecutionLevel`, it doesn't embed the `requireAdministrator` manifest into the installed executable, so Windows doesn't prompt for UAC.

## Solution Overview

### 1. Fix NSIS Configuration (Primary Fix)
Add `"requestExecutionLevel": "admin"` to the NSIS configuration in [`package.json`](package.json:82-93).

### 2. Verify Runtime Elevation Logic (Secondary Enforcement)
The existing runtime elevation check in [`main.js`](main.js:69-125) provides a fallback mechanism. Review and ensure it works correctly for all launch paths.

### 3. Verify Installer Script
Confirm [`installer.nsh`](installer.nsh) doesn't override or suppress the manifest.

## Detailed Implementation Steps

### Step 1: Update package.json NSIS Configuration

**File:** [`package.json`](package.json:82-93)

**Change:**
```json
"nsis": {
  "oneClick": false,
  "allowToChangeInstallationDirectory": true,
  "perMachine": true,
  "requestExecutionLevel": "admin",  // ADD THIS LINE
  "installerIcon": "resources/ScreenShield.ico",
  "uninstallerIcon": "resources/ScreenShield.ico",
  "installerSidebar": "resources/installer-sidebar.bmp",
  "createDesktopShortcut": "always",
  "shortcutName": "Screen Shield",
  "artifactName": "ScreenShield-Setup-${version}.exe",
  "include": "installer.nsh"
}
```

**Impact:**
- electron-builder will embed the `requireAdministrator` manifest into the installed executable
- Windows will prompt for UAC when the installed version is launched
- Desktop shortcuts, Start Menu shortcuts, and direct EXE launches will all require elevation

### Step 2: Review Runtime Elevation Logic in main.js

**File:** [`main.js`](main.js:69-125)

**Current Implementation:**
- Lines 73-82: `isRunningAsAdmin()` function checks elevation using `fltmc` command
- Lines 84-106: `restartAsAdmin()` function relaunches with elevation using PowerShell's `Start-Process -Verb RunAs`
- Lines 108-125: Elevation check runs before app is ready, relaunches if not elevated

**Potential Issues:**
1. The elevation check happens in `app.whenReady().then()` which means the app starts loading before the check completes
2. This could cause the app window to briefly appear before the UAC prompt

**Recommended Improvement:**
Move the elevation check to run immediately (synchronously) before `app.whenReady()` to prevent any window from appearing.

### Step 3: Verify installer.nsh Doesn't Override Manifest

**File:** [`installer.nsh`](installer.nsh)

**Analysis:**
The installer script only adds Microsoft Defender exclusions and writes registry entries. It does NOT:
- Modify the executable manifest
- Override the `requestExecutionLevel` setting
- Suppress UAC prompts

**Conclusion:** No changes needed to installer.nsh.

## Launch Path Validation

After implementing the fix, verify these launch paths all prompt for UAC:

1. **Desktop Shortcut** - Created by NSIS installer with `createDesktopShortcut: "always"`
   - Should inherit the executable's manifest and prompt for UAC

2. **Start Menu Shortcut** - Created by NSIS installer
   - Should inherit the executable's manifest and prompt for UAC

3. **Direct EXE Launch** - User double-clicks the executable
   - Will prompt for UAC due to embedded manifest

4. **Startup/Boot Launch** - If added to startup folder or registry
   - Will prompt for UAC due to embedded manifest

5. **Portable Version** - Already working correctly
   - Will continue to work with `requestExecutionLevel: "admin"`

## Testing Checklist

- [ ] Build the installer: `npm run build`
- [ ] Install the application using the generated installer
- [ ] Launch from desktop shortcut - verify UAC prompt appears
- [ ] Launch from Start Menu - verify UAC prompt appears
- [ ] Launch by double-clicking the EXE - verify UAC prompt appears
- [ ] Test portable version - verify UAC prompt still appears
- [ ] Verify the app runs with admin privileges after elevation
- [ ] Test cancellation of UAC - verify app exits gracefully
- [ ] Verify no infinite relaunch loops occur

## Files to Modify

1. **[`package.json`](package.json:82-93)** - Add `requestExecutionLevel: "admin"` to NSIS config
2. **[`main.js`](main.js:108-125)** - (Optional) Improve runtime elevation check timing

## Files to Verify (No Changes Needed)

1. **[`app.manifest`](app.manifest:19)** - Already has `requireAdministrator`
2. **[`installer.nsh`](installer.nsh)** - Doesn't override manifest
3. **[`build.ps1`](build.ps1)** - Build script is correct

## Expected Outcome

After implementing this fix:
- Both portable and installed versions will ALWAYS prompt for UAC when launched
- The app will consistently run with administrator privileges regardless of how it is started
- All launch paths (desktop shortcut, Start Menu, direct EXE, startup) will require elevation
- The runtime fallback in main.js provides additional protection if the manifest is somehow bypassed
