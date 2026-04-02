# Startup Feature Debug Guide

## Overview
This guide helps debug the "Launch on Startup" feature if it's not working correctly.

## What Was Fixed

### 1. User Context Issue
**Problem:** Used `%USERNAME%` which is a Windows environment variable that might not work correctly in schtasks command.

**Fix:** Changed to use `process.env.USERNAME` which gets the actual username from the Node.js process environment.

### 2. Path Handling
**Problem:** Executable path might have spaces and need proper quoting.

**Fix:** Already using `"${command}"` with proper quoting.

### 3. Added Explicit Logging
**Added:**
- Log the username being used
- Log the executable path
- Log the full schtasks command being executed
- Log stdout and stderr from schtasks
- Log task verification result

### 4. Added Task Verification
**Added:** After creating the task, immediately query it to verify it actually exists.

### 5. Fixed UI State Logic
**Fixed:** Only revert checkbox if task creation is confirmed to have failed.

## How to Debug

### Step 1: Check Console Logs
When you enable "Launch on Startup", check the console logs for:

```
[Screen Shield] Creating startup task for user: <username>
[Screen Shield] Executable path: <path>
[Screen Shield] Executing: schtasks /Create /TN ScreenShieldStartup /TR "<path>" /SC ONLOGIN /RL HIGHEST /RU <username> /F
```

If the task creation fails, you'll see:
```
[Screen Shield] Failed to create startup task: <error>
[Screen Shield] stdout: <output>
[Screen Shield] stderr: <error output>
```

If successful, you'll see:
```
[Screen Shield] Startup task created successfully.
[Screen Shield] stdout: <output>
[Screen Shield] Task verification successful: <query output>
```

### Step 2: Manual Testing
You can manually test the schtasks command in an elevated Command Prompt:

```cmd
schtasks /Create /TN "ScreenShieldStartup" /TR "C:\path\to\ScreenShield.exe" /SC ONLOGIN /RL HIGHEST /RU %USERNAME% /F
```

Replace `C:\path\to\ScreenShield.exe` with the actual path to your ScreenShield executable.

### Step 3: Verify Task Exists
Check if the task was created:

```cmd
schtasks /Query /TN "ScreenShieldStartup"
```

### Step 4: Check Task Details
View detailed task information:

```cmd
schtasks /Query /TN "ScreenShieldStartup" /FO LIST /V
```

Look for:
- **TaskName:** ScreenShieldStartup
- **Status:** Ready
- **Logon Mode:** At logon
- **Run As User:** <your username>
- **Run Level:** Highest

### Step 5: Test Task Execution
Manually run the task to test:

```cmd
schtasks /Run /TN "ScreenShieldStartup"
```

### Step 6: Delete Task (if needed)
If you need to remove the task:

```cmd
schtasks /Delete /TN "ScreenShieldStartup" /F
```

## Common Issues and Solutions

### Issue 1: "Access Denied" Error
**Cause:** Not running as administrator when creating the task.

**Solution:** 
- Ensure ScreenShield is running with admin privileges
- The app manifest requires administrator, so this should be automatic
- Check if UAC is blocking the operation

### Issue 2: "The system cannot find the file specified"
**Cause:** Incorrect executable path.

**Solution:**
- Check the console log for the actual path being used
- Verify the path exists and is accessible
- Ensure the path is properly quoted (especially if it has spaces)

### Issue 3: "The specified account name is not valid"
**Cause:** Invalid username in `/RU` parameter.

**Solution:**
- Check the console log for the username being used
- Verify `process.env.USERNAME` returns the correct value
- Try using the actual username instead of environment variable

### Issue 4: Task Created But Doesn't Run
**Cause:** Task might be disabled or have incorrect trigger.

**Solution:**
- Check task details with `schtasks /Query /TN "ScreenShieldStartup" /FO LIST /V`
- Verify the task is enabled
- Check the trigger is set to "At logon"
- Verify the action path is correct

### Issue 5: Checkbox Reverts Immediately
**Cause:** Task creation or verification failed.

**Solution:**
- Check console logs for the specific error
- Look at both stdout and stderr output
- Verify the task doesn't already exist with a different configuration
- Try manually creating the task to see the exact error

## Expected Behavior

### When Enabling "Launch on Startup"
1. Checkbox should tick and stay ticked
2. Console should show:
   ```
   [Screen Shield] Creating startup task for user: <username>
   [Screen Shield] Executable path: <path>
   [Screen Shield] Executing: schtasks /Create /TN ScreenShieldStartup /TR "<path>" /SC ONLOGIN /RL HIGHEST /RU <username> /F
   [Screen Shield] Startup task created successfully.
   [Screen Shield] stdout: SUCCESS: The scheduled task "ScreenShieldStartup" has successfully been created.
   [Screen Shield] Task verification successful: <query output>
   ```
3. Task should appear in Task Scheduler
4. Task should be enabled and ready

### When Disabling "Launch on Startup"
1. Checkbox should untick and stay unticked
2. Console should show:
   ```
   [Screen Shield] Removing startup task: ScreenShieldStartup
   [Screen Shield] Startup task removed successfully.
   [Screen Shield] stdout: SUCCESS: The scheduled task "ScreenShieldStartup" was successfully deleted.
   ```
3. Task should be removed from Task Scheduler

### On System Login
1. ScreenShield should launch automatically
2. No UAC prompt should appear
3. ScreenShield should run with admin privileges

## Testing Checklist

- [ ] Enable "Launch on Startup" in settings
- [ ] Check console logs for successful task creation
- [ ] Verify task exists in Task Scheduler
- [ ] Verify task details (user, run level, trigger)
- [ ] Reboot the system
- [ ] Verify ScreenShield launches automatically
- [ ] Verify ScreenShield runs with admin privileges (no UAC prompt)
- [ ] Disable "Launch on Startup" in settings
- [ ] Check console logs for successful task removal
- [ ] Verify task is removed from Task Scheduler
- [ ] Test with portable version
- [ ] Test with installed version

## Files Modified

1. [`main.js`](main.js) - Added logging, fixed user context, added task verification
2. [`frontend/src/App.jsx`](frontend/src/App.jsx) - Fixed UI state logic

## Additional Notes

- The task is created for the current user only (`/RU username`)
- The task runs with highest privileges (`/RL HIGHEST`)
- The task triggers at user login (`/SC ONLOGIN`)
- The task is forced to overwrite any existing task (`/F`)
- Task verification ensures the task was actually created before reporting success
- UI only reverts the checkbox if task creation is confirmed to have failed
