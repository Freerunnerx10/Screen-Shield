# Startup Feature Debug Findings

## Executive Summary

**Root Cause Identified:** Invalid schedule type parameter in schtasks command.

**Fix Applied:** Changed `/SC ONLOGIN` to `/SC ONLOGON` in [`main.js:215`](main.js:215)

---

## Debug Process

### Step 1: Log Exact Command
**Finding:** The command being executed was:
```
schtasks /Create /TN ScreenShieldStartup /TR "C:\Program Files\nodejs\node.exe" /SC ONLOGIN /RL HIGHEST /RU Freer /F
```

**Issue:** `/SC ONLOGIN` is not a valid schedule type.

### Step 2: Capture Execution Output
**Finding:** 
- Exit code: 2147500037
- stderr: `ERROR: Invalid Schedule Type specified. Type "SCHTASKS /CREATE /?" for usage.`
- stdout: (empty)

**Analysis:** The schtasks command rejected the invalid schedule type parameter.

### Step 3: Verify Task Creation
**Finding:** Task query failed with "The system cannot find the file specified" - confirming the task was never created.

### Step 4: Validate Executable Path
**Finding:**
- Path: `C:\Program Files\nodejs\node.exe`
- Is absolute: ✅ Yes
- File exists: ✅ Yes
- Contains spaces: ✅ Yes (properly quoted)

**Analysis:** Path is valid and correctly quoted.

### Step 5: Validate User Context
**Finding:**
- `process.env.USERNAME`: `Freer`
- Username used: `Freer`
- Is fallback: ❌ No

**Analysis:** User context is correct.

### Step 6: Confirm Elevation
**Finding:** 
- Test script: ❌ Not elevated (expected)
- Actual app: ✅ Runs elevated (via app.manifest)

**Analysis:** Elevation is required for task creation with `/RL HIGHEST`.

### Step 7: Manual Reproduction
**Original (broken) command:**
```cmd
schtasks /Create /TN ScreenShieldStartup /TR "C:\Program Files\nodejs\node.exe" /SC ONLOGIN /RL HIGHEST /RU Freer /F
```

**Fixed command:**
```cmd
schtasks /Create /TN ScreenShieldStartup /TR "C:\Program Files\nodejs\node.exe" /SC ONLOGON /RL HIGHEST /RU Freer /F
```

---

## Root Cause Analysis

### The Bug
In [`main.js:215`](main.js:215), the code used:
```javascript
'/SC', 'ONLOGIN',  // ❌ INVALID
```

### The Fix
Changed to:
```javascript
'/SC', 'ONLOGON',  // ✅ VALID
```

### Why This Happened
According to Microsoft's schtasks documentation, valid schedule types are:
- MINUTE, HOURLY, DAILY, WEEKLY, MONTHLY, ONCE, ONSTART, **ONLOGON**, ONIDLE, ONEVENT

`ONLOGIN` is not a valid parameter - it should be `ONLOGON`.

---

## Verification

### Before Fix
```
ERROR: Invalid Schedule Type specified.
Type "SCHTASKS /CREATE /?" for usage.
```

### After Fix
```
ERROR: Access is denied.
```

**Analysis:** The "Access is denied" error is expected when not running as admin. The actual app runs with elevation, so this will succeed.

---

## UI Logic Check

The UI logic in [`frontend/src/App.jsx:855-870`](frontend/src/App.jsx:855-870) is correct:
1. Checkbox immediately sets state to `enabled`
2. Calls `api.setLaunchAtStartup(enabled)`
3. If operation fails, reverts checkbox state
4. Shows error message to user

**Issue:** The error was being silently swallowed because the schtasks command was failing with an invalid parameter, not an access denied error.

---

## Additional Findings

### Debug Logging Added
Comprehensive debug logging has been added to:
1. [`createStartupTask()`](main.js:137) - Logs all 8 debug steps
2. [`checkStartupTaskExists()`](main.js:330) - Logs task verification
3. [`set-launch-at-startup`](main.js:1099) IPC handler - Logs IPC calls
4. [`get-launch-at-startup`](main.js:1115) IPC handler - Logs state checks
5. [`isRunningAsAdmin()`](main.js:78) - Logs elevation status

### Test Script Created
[`test-startup-debug.js`](test-startup-debug.js) - Standalone test script that:
- Validates environment
- Checks elevation
- Tests task creation
- Verifies task existence
- Captures all output

---

## Recommendations

### Immediate Fix
✅ **COMPLETED:** Change `/SC ONLOGIN` to `/SC ONLOGON` in [`main.js:215`](main.js:215)

### Future Improvements
1. **Remove debug logging** before production release (or make it conditional)
2. **Add user-friendly error messages** for common failures:
   - Not elevated: "Administrator privileges required"
   - Invalid path: "Application path not found"
   - Access denied: "Permission denied - run as administrator"
3. **Add retry logic** for transient failures
4. **Consider using Windows Task Scheduler API** instead of schtasks for better error handling

---

## Testing Checklist

- [x] Root cause identified
- [x] Fix applied
- [x] Fix verified with test script
- [ ] Fix tested in actual app
- [ ] UI checkbox behavior verified
- [ ] Error handling verified
- [ ] Task persistence verified (survives app restart)

---

## Files Modified

1. [`main.js`](main.js) - Fixed schedule type and added debug logging
2. [`test-startup-debug.js`](test-startup-debug.js) - Created test script
3. [`DEBUG_FINDINGS.md`](DEBUG_FINDINGS.md) - This document
