const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, desktopCapturer, screen, nativeTheme, systemPreferences } = require('electron')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawn, execFile, execSync } = require('child_process')
const fs = require('fs')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Set the Windows App User Model ID before app.whenReady() so that Task
// Manager, the taskbar, and the notification system all group every process
// (main, renderer, GPU) under a single stable identity.
if (process.platform === 'win32') app.setAppUserModelId('com.screenshield.app')

// ---------------------------------------------------------------------------
// Persistent app config — stores theme preference so the splash screen can
// match the user's chosen theme on each subsequent launch.
// Only called after app.whenReady() so getPath('userData') is available.
// ---------------------------------------------------------------------------
function getConfigPath() {
  return path.join(app.getPath('userData'), 'ss-config.json')
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')) }
  catch { return {} }
}

function writeConfig(updates) {
  const cp = getConfigPath()
  const cfg = readConfig()
  Object.assign(cfg, updates)
  try { fs.writeFileSync(cp, JSON.stringify(cfg, null, 2), 'utf8') }
  catch { /* ignore write errors — non-fatal */ }
}

// ---------------------------------------------------------------------------
// System accent color — nativeTheme does not expose accentColor; use
// systemPreferences.getAccentColor() which returns RRGGBBAA on Windows.
// ---------------------------------------------------------------------------
function getSystemAccentColor() {
  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return systemPreferences.getAccentColor() || null
    }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// Settings reset — clears the on-disk config and tells the renderer to wipe
// localStorage so the first-launch setup re-appears on the next load.
// ---------------------------------------------------------------------------
function resetAppSettings() {
  try { fs.unlinkSync(getConfigPath()) } catch { /* already absent */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:reset-settings')
  }
}

// ---------------------------------------------------------------------------
// Reduce Chromium / V8 memory footprint — Screen Shield is a lightweight
// utility and does not need the full Chromium feature set.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128')
app.commandLine.appendSwitch('disable-features', 'TranslateUI,OptimizationHints,VizDisplayCompositor,AudioServiceOutOfProcess,NetworkService,NetworkServiceInProcess,RendererCodeIntegrity,Spelling')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-spell-check')
// ---------------------------------------------------------------------------
// Runtime elevation check — enforces admin privileges on launch.
// Primary method: app.manifest requests requireAdministrator
// Secondary method: runtime check + relaunch if not elevated
// ---------------------------------------------------------------------------
const ELEVATED_FLAG = '--elevated'

function isRunningAsAdmin() {
  try {
    execSync('fltmc', { stdio: 'ignore' })
    console.log('[DEBUG] isRunningAsAdmin(): true (fltmc succeeded)');
    return true
  } catch (e) {
    console.log('[DEBUG] isRunningAsAdmin(): false (fltmc failed)');
    console.log('[DEBUG] fltmc error:', e.message);
    return false
  }
}

function restartAsAdmin() {
  // Relaunch self with elevation using shell "runas" verb
  // This triggers the UAC prompt
  const exePath = process.execPath
  // Get all arguments except the --elevated flag we may have added
  const args = process.argv.slice(1).filter(arg => arg !== ELEVATED_FLAG)
  
  // Use PowerShell to invoke runas - more reliable on Windows
  const psCommand = `Start-Process -FilePath '${exePath}' -ArgumentList '${args.join("'").replace(/"/g, '\\"')}' -Verb RunAs -WindowStyle Hidden`
  
  execFile(
    'powershell.exe',
    ['-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCommand],
    { windowsHide: true },
    () => {
      // Exit after spawning elevated process - user may cancel UAC
      // The app will exit gracefully after the UAC dialog closes
    }
  )
  
  // Exit this non-elevated instance
  app.quit()
}

// Check for elevation before app is ready - this is the secondary enforcement
// If we have --elevated flag, we came from a relaunch and should continue
if (!isRunningAsAdmin() && !process.argv.includes(ELEVATED_FLAG)) {
  // This is a non-blocking check - we launch the elevated process and exit
  // But we need to defer until app is ready to use app.quit()
  app.whenReady().then(() => {
    // Double-check after app is ready (handles edge cases)
    if (!isRunningAsAdmin()) {
      console.log('[Screen Shield] Not running as administrator. Requesting elevation...')
      restartAsAdmin()
      // Wait briefly for the elevated process to start before quitting
      setTimeout(() => {
        // If user cancelled UAC, the elevated process won't start - exit anyway
        app.exit(1)
      }, 2000)
    }
  })
}

// Legacy helper — used to show a warning in the renderer, not to gate startup.
// DLL injection will fail gracefully if not elevated and the UI will show the
// error returned by the backend.
function isElevated() {
  return isRunningAsAdmin()
}

function createStartupTask() {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve, reject) => {
    // For packaged app, use the executable path directly
    // For portable version, use absolute path to current EXE
    const command = process.execPath;
    const taskName = "ScreenShieldStartup";
    const username = process.env.USERNAME || 'CURRENTUSER';

    // =========================================================================
    // DEBUG LOGGING - Step 1: Log exact command
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[DEBUG] Step 1: Log Exact Command');
    console.log('='.repeat(80));
    console.log(`[DEBUG] Task name: ${taskName}`);
    console.log(`[DEBUG] Executable path: ${command}`);
    console.log(`[DEBUG] Username: ${username}`);
    console.log(`[DEBUG] process.env.USERNAME: ${process.env.USERNAME}`);
    console.log(`[DEBUG] process.execPath: ${process.execPath}`);
    console.log(`[DEBUG] process.platform: ${process.platform}`);
    console.log(`[DEBUG] app.isPackaged: ${app.isPackaged}`);
    
    // =========================================================================
    // DEBUG LOGGING - Step 6: Confirm Elevation
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[DEBUG] Step 6: Confirm Elevation');
    console.log('='.repeat(80));
    const isAdmin = isRunningAsAdmin();
    console.log(`[DEBUG] Is running as admin: ${isAdmin}`);
    if (!isAdmin) {
      console.error('[DEBUG] ERROR: Not running as administrator!');
      reject(new Error('Not running as administrator. Startup task creation requires elevation.'));
      return;
    }

    // =========================================================================
    // DEBUG LOGGING - Step 4: Validate Executable Path
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[DEBUG] Step 4: Validate Executable Path');
    console.log('='.repeat(80));
    console.log(`[DEBUG] Resolved path: ${command}`);
    console.log(`[DEBUG] Path is absolute: ${path.isAbsolute(command)}`);
    try {
      const stats = fs.statSync(command);
      console.log(`[DEBUG] File exists: true`);
      console.log(`[DEBUG] File size: ${stats.size} bytes`);
    } catch (err) {
      console.error(`[DEBUG] File exists: false`);
      console.error(`[DEBUG] Error checking file: ${err.message}`);
    }
    console.log(`[DEBUG] Path contains spaces: ${command.includes(' ')}`);
    console.log(`[DEBUG] Quoted path: "${command}"`);

    // =========================================================================
    // DEBUG LOGGING - Step 5: Validate User Context
    // =========================================================================
    console.log('='.repeat(80));
    console.log('[DEBUG] Step 5: Validate User Context');
    console.log('='.repeat(80));
    console.log(`[DEBUG] process.env.USERNAME: ${process.env.USERNAME}`);
    console.log(`[DEBUG] Username to use: ${username}`);
    console.log(`[DEBUG] Is fallback used: ${username === 'CURRENTUSER'}`);

    console.log(`[Screen Shield] Creating startup task for user: ${username}`);
    console.log(`[Screen Shield] Executable path: ${command}`);

    // Remove any existing task to avoid duplicates
    execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true }, () => {
      // Ignore errors - task might not exist
      
      // Build the schtasks command arguments
      const args = [
        '/Create',
        '/TN', taskName,
        '/TR', `"${command}"`,
        '/SC', 'ONLOGON',   // Run at user logon (not ONLOGIN - that's invalid)
        '/RL', 'HIGHEST',   // Run with highest privileges
        '/RU', username,    // Run as current user (do not quote - execFile handles arguments separately)
        '/F'                // Force creation (overwrite if exists)
      ];

      // =========================================================================
      // DEBUG LOGGING - Step 7: Manual Reproduction
      // =========================================================================
      console.log('='.repeat(80));
      console.log('[DEBUG] Step 7: Manual Reproduction Command');
      console.log('='.repeat(80));
      const manualCommand = `schtasks ${args.join(' ')}`;
      console.log(`[DEBUG] Copy-paste ready command:`);
      console.log(`[DEBUG] ${manualCommand}`);
      console.log('='.repeat(80));

      console.log(`[Screen Shield] Executing: schtasks ${args.join(' ')}`);
      
      // Create the task with current user context
      execFile('schtasks', args, { windowsHide: true }, (error, stdout, stderr) => {
        // =========================================================================
        // DEBUG LOGGING - Step 2: Capture Execution Output
        // =========================================================================
        console.log('='.repeat(80));
        console.log('[DEBUG] Step 2: Capture Execution Output');
        console.log('='.repeat(80));
        console.log(`[DEBUG] Exit code: ${error ? error.code : 0}`);
        console.log(`[DEBUG] stdout: ${stdout || '(empty)'}`);
        console.log(`[DEBUG] stderr: ${stderr || '(empty)'}`);
        console.log('='.repeat(80));

        if (error) {
          console.error('[Screen Shield] Failed to create startup task:', error);
          console.error('[Screen Shield] stdout:', stdout);
          console.error('[Screen Shield] stderr:', stderr);
          reject(error);
        } else {
          console.log('[Screen Shield] Startup task created successfully.');
          console.log('[Screen Shield] stdout:', stdout);
          
          // =========================================================================
          // DEBUG LOGGING - Step 3: Verify Task Creation
          // =========================================================================
          console.log('='.repeat(80));
          console.log('[DEBUG] Step 3: Verify Task Creation');
          console.log('='.repeat(80));
          console.log(`[DEBUG] Running: schtasks /Query /TN ${taskName}`);
          
          // Verify the task was actually created
          execFile('schtasks', ['/Query', '/TN', taskName], { windowsHide: true }, (queryError, queryStdout, queryStderr) => {
            console.log(`[DEBUG] Query exit code: ${queryError ? queryError.code : 0}`);
            console.log(`[DEBUG] Query stdout: ${queryStdout || '(empty)'}`);
            console.log(`[DEBUG] Query stderr: ${queryStderr || '(empty)'}`);
            console.log('='.repeat(80));
            
            if (queryError) {
              console.error('[Screen Shield] Task creation verification failed:', queryError);
              reject(new Error('Task creation could not be verified'));
            } else {
              console.log('[Screen Shield] Task verification successful:', queryStdout);
              resolve();
            }
          });
        }
      });
    });
  });
}

function removeStartupTask() {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve) => {
    const taskName = "ScreenShieldStartup";
    console.log(`[Screen Shield] Removing startup task: ${taskName}`);
    
    execFile('schtasks', ['/Delete', '/TN', taskName, '/F'], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        console.error('[Screen Shield] Failed to remove startup task:', error);
        console.error('[Screen Shield] stdout:', stdout);
        console.error('[Screen Shield] stderr:', stderr);
      } else {
        console.log('[Screen Shield] Startup task removed successfully.');
        console.log('[Screen Shield] stdout:', stdout);
      }
      resolve(); // Always resolve - don't fail if task doesn't exist
    });
  });
}

function removeLegacyRegistryStartup() {
  if (process.platform !== 'win32') return Promise.resolve();

  return new Promise((resolve) => {
    const regPath = 'HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run';
    const valueName = 'com.screenshield.app';
    console.log(`[Screen Shield] Removing legacy registry startup entry: ${valueName}`);
    
    execFile('reg', ['delete', regPath, '/v', valueName, '/f'], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // Ignore if the entry doesn't exist
        console.log('[Screen Shield] No legacy registry startup entry to remove.');
        console.log('[Screen Shield] stdout:', stdout);
        console.log('[Screen Shield] stderr:', stderr);
      } else {
        console.log('[Screen Shield] Legacy registry startup entry removed successfully.');
        console.log('[Screen Shield] stdout:', stdout);
      }
      resolve(); // Always resolve - don't fail if entry doesn't exist
    });
  });
}

function checkStartupTaskExists() {
  if (process.platform !== 'win32') return false;
  const taskName = "ScreenShieldStartup";
  
  // =========================================================================
  // DEBUG LOGGING - checkStartupTaskExists
  // =========================================================================
  console.log('='.repeat(80));
  console.log('[DEBUG] checkStartupTaskExists() called');
  console.log('='.repeat(80));
  console.log(`[DEBUG] Task name: ${taskName}`);
  console.log(`[DEBUG] Running: schtasks /Query /TN ${taskName}`);
  
  try {
    const result = execSync(`schtasks /Query /TN ${taskName}`, { windowsHide: true }).toString();
    console.log(`[DEBUG] Task exists: true`);
    console.log(`[DEBUG] Query result: ${result}`);
    console.log('='.repeat(80));
    return true;
  } catch (e) {
    console.log(`[DEBUG] Task exists: false`);
    console.log(`[DEBUG] Error: ${e.message}`);
    console.log(`[DEBUG] Error code: ${e.status}`);
    console.log(`[DEBUG] stderr: ${e.stderr ? e.stderr.toString() : '(empty)'}`);
    console.log('='.repeat(80));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Microsoft Defender exclusion — ensures the helper binary and hook DLL are
// not quarantined at runtime.  The NSIS installer applies exclusions via
// Add-MpPreference, but that only covers the installed path ($INSTDIR).
// Portable builds, dev runs, and Temp-extracted copies are unprotected.
//
// This function adds exclusions for the actual running paths on every launch.
// Add-MpPreference is idempotent — duplicate entries are silently ignored.
// Requires elevation; on non-admin launches the command fails silently and
// the app continues without protection (the user may need to add a manual
// Defender exclusion).
// ---------------------------------------------------------------------------
function addDefenderExclusions() {
  if (process.platform !== 'win32') return Promise.resolve()

  const exeDir = path.dirname(app.getPath('exe'))
  const resDir = isDev
    ? __dirname
    : process.resourcesPath

  // Build a single PowerShell command that adds path and process exclusions.
  // -Force suppresses confirmation prompts; -ErrorAction SilentlyContinue
  // prevents non-admin errors from producing noisy stderr output.
  const psCmd = [
    'try {',
     `  Add-MpPreference -ExclusionPath '${exeDir}','${resDir}'`,
     `    -ExclusionProcess 'ScreenShieldBackgroundService.exe','ScreenShieldHook.dll'`,
    '    -Force -ErrorAction SilentlyContinue',
    '} catch {}',
  ].join(' ')

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd],
      { windowsHide: true, timeout: 8000 },
      () => resolve(), // resolve on success or failure — never block startup
    )
  })
}

// ---------------------------------------------------------------------------
// Persistent backend client — keeps ONE ScreenShieldBackgroundService.exe --serve process alive
// for the lifetime of the Electron session.  All operations (list, hide/unhide,
// watch management) are dispatched through stdin/stdout JSON IPC so no new
// processes need to be spawned per operation.
// ---------------------------------------------------------------------------
class ScreenShieldHelperClient {
  constructor(backendPath) {
    this.backendPath = backendPath
    this.proc = null
    this.buffer = ''
    this.pending = new Map()   // id → { resolve, reject, timer }
    this.nextId = 0
    this._stopping = false
  }

  start() {
    if (this.proc || this._stopping) return
    try {
      this.proc = spawn(this.backendPath, ['--serve'])
    } catch (err) {
      // Backend binary not found (e.g. pre-build dev run) — silently degrade
      return
    }

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let nl
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        let resp
        try { resp = JSON.parse(line) } catch { continue }
        const entry = this.pending.get(resp.id)
        if (!entry) continue
        clearTimeout(entry.timer)
        this.pending.delete(resp.id)
        if (resp.ok) entry.resolve(resp.data)
        else entry.reject(new Error(resp.error || 'backend error'))
      }
    })

    this.proc.stderr.on('data', () => { /* ignore */ })

    this.proc.on('close', () => {
      this.proc = null
      // Reject all in-flight requests
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('backend process exited'))
        this.pending.delete(id)
      }
      // Auto-restart after a short delay unless we are shutting down
      if (!this._stopping) {
        setTimeout(() => this.start(), 800)
      }
    })

    this.proc.on('error', () => {
      this.proc = null
    })
  }

  send(cmd, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error('backend not running'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`backend command "${cmd}" timed out`))
        }
      }, 20000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin.write(
          JSON.stringify({ id, cmd, params: params ?? {} }) + '\n',
        )
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  stop() {
    this._stopping = true
    if (this.proc) {
      this.proc.removeAllListeners('close')
      this.proc.kill()
      this.proc = null
    }
  }
}

let mainWindow = null
let splashWindow = null
let tray = null
let client = null
// Process names currently under watch — passed to list so that
// tray-minimised processes still appear in the application list.
let watchedNames = []
// Track HWNDs of windows that have been hidden by the app
let hiddenWindows = []

// ---------------------------------------------------------------------------
// CLI pass-through: electron . -- --hide <pid>  /  --unhide <pid>
// ---------------------------------------------------------------------------
   const argv = process.argv.slice(isDev ? 2 : 1)
   if (argv.includes('--hide') || argv.includes('--unhide')) {
     const backendPath = isDev
       ? path.join(__dirname, 'native-backend', 'target', 'release', 'ScreenShieldBackgroundService.exe')
       : path.join(process.resourcesPath, 'ScreenShieldBackgroundService.exe')
 
     const child = spawn(backendPath, argv, { stdio: 'inherit' })
     child.on('close', (code) => process.exit(code ?? 0))
     // don't open a window
   } else {
  // Prevent multiple instances — second launch focuses the running window and exits.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    app.whenReady().then(async () => {
      Menu.setApplicationMenu(null)

      // Clean up legacy registry startup entry
      removeLegacyRegistryStartup()

      // ── 1. Show the splash screen FIRST ────────────────────────────────
      // Create and display the splash before any heavy initialisation so the
      // user sees a polished instant launch.  The 'ready-to-show' event
      // fires once Chromium has painted the first frame — waiting for it
      // guarantees the logo, title, and spinner are fully visible before we
      // block on Defender exclusions or backend startup.
      const splashReady = createSplashWindow()
      await splashReady

      // ── 2. Heavy initialisation (runs while splash is visible) ─────────
      // Apply Defender exclusions for the running paths before starting
      // the backend — gives the exclusion a moment to take effect so
      // Defender does not quarantine the helper on its first spawn.
      await addDefenderExclusions()

       // Start the persistent backend client before the main window loads so
       // IPC handlers are ready as soon as the renderer sends its first request.
       const backendPath = isDev
         ? path.join(__dirname, 'native-backend', 'target', 'release', 'ScreenShieldBackgroundService.exe')
         : path.join(process.resourcesPath, 'ScreenShieldBackgroundService.exe')
       client = new ScreenShieldHelperClient(backendPath)
       client.start()

      // ── 3. Create the main window (hidden until splash closes) ─────────
      createMainWindow()

      // ── 4. Signal the splash to fade out and close ─────────────────────
      // The splash no longer auto-closes on a timer — it waits for this IPC
      // signal so the logo/title/spinner remain visible for exactly as long
      // as initialisation takes, no more, no less.
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('splash:close')
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Create and display the splash screen.  Returns a Promise that resolves once
 * Chromium has painted the first frame (the 'ready-to-show' event), so the
 * caller can be certain the splash is fully visible before starting any heavy
 * initialisation work.
 */
function createSplashWindow() {
  // Read saved theme BEFORE creating the window so the initial background
  // colour matches — prevents a brief white flash in the native frame before
  // Chromium paints the HTML content.
  const savedCfg = readConfig()
  const splashTheme = savedCfg.theme || 'default'
  const splashIsDark = nativeTheme.shouldUseDarkColors ? '1' : '0'
  const themeColors = {
    'default': '#0a0a0a',
    'dark':    '#1e1e1e',
    'light':   '#f0f0f0',
    'system':  nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
  }
  const bgColor = themeColors[splashTheme] || themeColors['default']

  splashWindow = new BrowserWindow({
    width: 600,
    height: 338,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,                // don't show until content is painted
    backgroundColor: bgColor,  // native fill so the frame is never blank
    icon: isDev
      ? path.join(__dirname, 'resources', 'ScreenShield.ico')
      : path.join(process.resourcesPath, 'ScreenShield.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  splashWindow.loadFile(path.join(__dirname, 'splash.html'), {
    query: { theme: splashTheme, isDark: splashIsDark },
  })
  splashWindow.on('closed', () => {
    splashWindow = null
    if (mainWindow) {
      mainWindow.show()
      // Temporarily set always-on-top to guarantee foreground focus — Windows
      // may deny SetForegroundWindow if another app took focus during init.
      mainWindow.setAlwaysOnTop(true)
      mainWindow.focus()
      mainWindow.setAlwaysOnTop(false)
    }
  })

  // Return a promise that resolves once the first frame is painted.
  // 'ready-to-show' fires after layout + paint but before the window is
  // visible, so calling show() here guarantees every pixel is rendered.
  return new Promise((resolve) => {
    splashWindow.once('ready-to-show', () => {
      splashWindow.show()
      resolve()
    })
  })
}

/**
 * Create the main application window (hidden until the splash closes).
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 920,
    show: false, // revealed when the splash closes
    resizable: false,
    maximizable: false,
    frame: true,
    icon: isDev
      ? path.join(__dirname, 'resources', 'ScreenShield.ico')
      : path.join(process.resourcesPath, 'ScreenShield.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep timers running at full rate when minimised to tray
      zoomFactor: 1,               // pin zoom — prevents OS DPI or persisted Chromium zoom from scaling UI
    },
    title: 'Screen Shield',
  })

  // Strip WS_MAXIMIZEBOX from the native window style so Windows renders only
  // the minimize and close buttons — no greyed-out maximize button at all.
  // Electron's `maximizable: false` greys out the button but cannot remove it.
  if (process.platform === 'win32') {
    try {
      const { getNativeWindowHandle } = mainWindow
      const hBuf = mainWindow.getNativeWindowHandle()
      // The handle buffer is a 4-byte or 8-byte pointer depending on architecture
      const hwnd = hBuf.byteLength === 8
        ? Number(hBuf.readBigUInt64LE(0))
        : hBuf.readUInt32LE(0)

      const GWL_STYLE = -16
      const WS_MAXIMIZEBOX = 0x00010000
      // Use Windows native APIs through Node ffi-napi or direct module — but
      // the simplest approach for Electron is to shell out a tiny PowerShell:
      const { execSync: execSyncLocal } = require('child_process')
      execSyncLocal(
        `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "` +
        `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;` +
        `public class W{[DllImport(\\\"user32.dll\\\")]public static extern int GetWindowLong(IntPtr h,int i);` +
        `[DllImport(\\\"user32.dll\\\")]public static extern int SetWindowLong(IntPtr h,int i,int v);}';` +
        `[IntPtr]$h=${hwnd};` +
        `$s=[W]::GetWindowLong($h,${GWL_STYLE});` +
        `[void][W]::SetWindowLong($h,${GWL_STYLE},$s -band -bnot ${WS_MAXIMIZEBOX})"`,
        { windowsHide: true, timeout: 5000 },
      )
    } catch (_) { /* non-critical — falls back to greyed-out maximize */ }
  }

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'))
  }

  // Enforce zoom = 1 after every page load.  Chromium persists a per-origin
  // zoom level to disk; left unchecked it will drift if the OS DPI changes or
  // if the user accidentally Ctrl+scrolled inside the window.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1)
  })

  // Intercept keyboard / pinch-zoom gestures and immediately restore 1:1 so
  // the fixed-layout UI cannot be accidentally scaled by user input.
  mainWindow.webContents.on('zoom-changed', (_event, _direction) => {
    mainWindow.webContents.setZoomFactor(1)
  })

  // Push OS theme/accent changes to the renderer so the System theme updates live.
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system-theme-changed', {
        isDark: nativeTheme.shouldUseDarkColors,
        accentColor: getSystemAccentColor(),
      })
    }
  })

  // Windows fires accent-color-changed independently of nativeTheme 'updated'
  // (e.g. user picks a new accent colour without switching dark/light mode).
  if (process.platform === 'win32') {
    systemPreferences.on('accent-color-changed', (_event, newColor) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system-theme-changed', {
          isDark: nativeTheme.shouldUseDarkColors,
          accentColor: newColor || null,
        })
      }
    })
  }

  mainWindow.on('close', (event) => {
    if (tray) {
      // minimize to tray instead of quitting
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // -----------------------------------------------------------------------
  // Fix for white screen after long idle periods in system tray
  // -----------------------------------------------------------------------
  // After extended idle time (hours), Windows may reclaim GPU resources or
  // Chromium's rendering context may be lost. When the window is shown again,
  // the webContents may not properly repaint, resulting in a white screen.
  //
  // Solution:
  // 1. Force a repaint on every 'show' event using webContents.invalidate()
  // 2. Add a fallback that detects blank content and reloads if necessary
  // 3. Log all show/hide events for debugging
  // -----------------------------------------------------------------------

  let lastHideTime = null
  let showRetryCount = 0
  const MAX_SHOW_RETRIES = 3

   mainWindow.on('hide', () => {
     lastHideTime = Date.now()
     console.log(`[Screen Shield] Window hidden to tray at ${new Date().toISOString()}`)
     // Notify renderer that app is hidden
     if (mainWindow && !mainWindow.isDestroyed()) {
       mainWindow.webContents.send('app-hidden')
     }
   })
 
   mainWindow.on('show', () => {
     const now = Date.now()
     const hiddenDuration = lastHideTime ? (now - lastHideTime) / 1000 : 0
     console.log(`[Screen Shield] Window shown from tray (hidden for ${hiddenDuration.toFixed(1)}s)`)
 
     // Force Chromium to repaint the entire page — this recovers from GPU
     // context loss or rendering pipeline suspension after long idle periods.
     if (mainWindow && !mainWindow.isDestroyed()) {
       mainWindow.webContents.invalidate()
 
       // For very long idle periods (>5 minutes), add a delayed check to
       // detect if the page is still blank and force a reload if needed.
       if (hiddenDuration > 300) {
         console.log(`[Screen Shield] Long idle detected (${hiddenDuration.toFixed(0)}s), scheduling content verification`)
         setTimeout(() => {
           verifyAndRecoverContent()
         }, 500)
       }
     }
     // Notify renderer that app is shown
     if (mainWindow && !mainWindow.isDestroyed()) {
       mainWindow.webContents.send('app-shown')
     }
   })

  /**
   * Verify that the webContents has actual content and recover if blank.
   * This handles edge cases where invalidate() alone doesn't restore rendering.
   */
  function verifyAndRecoverContent() {
    if (!mainWindow || mainWindow.isDestroyed()) return

    mainWindow.webContents.executeJavaScript(`
      (function() {
        // Check if the page has any visible content
        const body = document.body
        if (!body) return { blank: true, reason: 'no-body' }

        const hasContent = body.children.length > 0
        const hasVisibleText = body.innerText && body.innerText.trim().length > 0
        const hasVisibleElements = body.querySelector('div, span, p, img, svg, button, input')

        // If the page appears blank, signal recovery needed
        if (!hasContent && !hasVisibleText && !hasVisibleElements) {
          return { blank: true, reason: 'no-content' }
        }

        return { blank: false }
      })()
    `).then((result) => {
      if (result.blank) {
        showRetryCount++
        console.log(`[Screen Shield] Blank content detected (attempt ${showRetryCount}/${MAX_SHOW_RETRIES}), reason: ${result.reason}`)

        if (showRetryCount <= MAX_SHOW_RETRIES) {
          // Force a full reload to recover rendering
          console.log(`[Screen Shield] Reloading webContents to recover from blank state`)
          mainWindow.webContents.reload()
        } else {
          console.log(`[Screen Shield] Max retries reached, attempting alternative recovery`)
          // Last resort: recreate the renderer by loading the URL again
          if (isDev) {
            mainWindow.loadURL('http://localhost:5173')
          } else {
            mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'))
          }
          showRetryCount = 0
        }
      } else {
        // Content is visible, reset retry counter
        if (showRetryCount > 0) {
          console.log(`[Screen Shield] Content verified successfully after ${showRetryCount} recovery attempts`)
        }
        showRetryCount = 0
      }
    }).catch((err) => {
      // JavaScript execution failed — likely a renderer crash, reload to recover
      console.log(`[Screen Shield] Content verification failed: ${err.message}, reloading`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload()
      }
    })
  }

  // Also listen for renderer process crashes and recover automatically
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.log(`[Screen Shield] Renderer process gone: ${details.reason}`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        console.log(`[Screen Shield] Reloading after renderer crash`)
        mainWindow.webContents.reload()
      }, 100)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    lastHideTime = null
    showRetryCount = 0
  })

  setupTray()
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------
function setupTray() {
  // Resolve icon: prefer tray-icon.png, fall back to the bundled Rust ICO
  const candidates = isDev
    ? [
        path.join(__dirname, 'resources', 'ScreenShield.ico'),
        path.join(__dirname, 'frontend', 'src', 'assets', 'tray-icon.png'),
        path.join(__dirname, 'native-backend', 'Misc', 'invicon.ico'),
      ]
    : [
        path.join(process.resourcesPath, 'ScreenShield.ico'),
        path.join(process.resourcesPath, 'tray-icon.png'),
        path.join(process.resourcesPath, 'invicon.ico'),
      ]

  let icon = nativeImage.createEmpty()
  for (const candidate of candidates) {
    try {
      const img = nativeImage.createFromPath(candidate)
      if (!img.isEmpty()) {
        // Force 32×32 so the system tray renders sharply at all DPI scales
        icon = img.resize({ width: 32, height: 32 })
        break
      }
    } catch {
      // try next candidate
    }
  }

  try {
    tray = new Tray(icon)
  } catch {
    // Tray creation failed (e.g. empty icon on some platforms) — tray stays null
    return
  }

  tray.setToolTip('Screen Shield')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Screen Shield',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        tray = null
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  // Both single- and double-click restore the window (standard Windows tray convention)
  const showWindow = () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  }
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

/** Returns the file:// URL for the splash logo image (dev and packaged paths differ) */
ipcMain.on('splash:logo-src', (event) => {
  const logoFile = 'ScreenShield- Logo (NoBorder).png'
  const p = isDev
    ? path.join(__dirname, 'resources', logoFile)
    : path.join(process.resourcesPath, logoFile)
  event.returnValue = pathToFileURL(p).href
})

/** Returns the file:// URL for the logo — async version for the main renderer */
ipcMain.handle('get-logo-src', () => {
  const logoFile = 'ScreenShield- Logo (NoBorder).png'
  const p = isDev
    ? path.join(__dirname, 'resources', logoFile)
    : path.join(process.resourcesPath, logoFile)
  return pathToFileURL(p).href
})

/** Returns whether the current process is running with admin/elevated rights */
ipcMain.handle('is-elevated', () => isElevated())

/** Returns list of visible top-level windows with icons from the Rust backend */
ipcMain.handle('get-windows', async () => {
  if (!client) return []
  try {
    const data = await client.send('list', {
      proc_names: watchedNames.length > 0 ? watchedNames : undefined,
    })
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
})

/** Hide a window by hwnd */
ipcMain.handle('hide-window', async (_event, hwnd, altTab) => {
  if (!client) return
  
  // Track the window as hidden
  if (!hiddenWindows.includes(hwnd)) {
    hiddenWindows.push(hwnd)
  }
  
  return client.send('hide', { hwnds: [hwnd], alt_tab: !!altTab })
})

/** Unhide a window by hwnd */
ipcMain.handle('unhide-window', async (_event, hwnd, altTab) => {
  if (!client) return
  
  // Remove from tracking when unhidden
  hiddenWindows = hiddenWindows.filter(h => h !== hwnd)
  
  return client.send('unhide', { hwnds: [hwnd], alt_tab: !!altTab })
})

/** List available display sources for the screen preview */
ipcMain.handle('screens:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }))
})

/** Return a single high-res thumbnail frame for a given screen source ID */
ipcMain.handle('get-preview-frame', async (_event, screenId) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 640, height: 360 },
  })
  const source = screenId
    ? sources.find((s) => s.id === screenId) ?? sources[0]
    : sources[0]
  return source ? source.thumbnail.toDataURL() : null
})

/**
 * Return merged monitor list: Electron display metadata + desktopCapturer source IDs.
 * Displays and sources are matched positionally — Electron guarantees the same order.
 */
ipcMain.handle('get-monitors', async () => {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  })
  return displays.map((display, i) => {
    const source = sources[i] ?? sources[0]
    return {
      id: source?.id ?? `display:${display.id}`,
      displayId: display.id,
      name: source?.name ?? `Display ${i + 1}`,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      isPrimary: display.id === primary.id,
      thumbnail: source?.thumbnail.toDataURL() ?? null,
    }
  })
})

/** Start (or restart) the watcher for the given process names */
ipcMain.handle('start-watch', async (_event, names) => {
  if (!Array.isArray(names) || names.length === 0) return
  watchedNames = [...names]
  if (!client) return

  // Install the in-process hook in already-running instances and start the
  // WinEvent watcher — both are handled inside the persistent serve process.
  client.send('enable-all', { enable: true, names }).catch(() => {})
  return client.send('watch', { names })
})

/**
 * Inject utils.dll into every running process whose name is in `names` and call
 * EnableAutoHide(enable).  Used on startup restore so processes that survived a
 * ScreenShield restart re-receive the in-process hook without waiting for their
 * next new window.
 */
ipcMain.handle('enable-auto-hide-all', async (_event, enable, names) => {
  if (!Array.isArray(names) || names.length === 0 || !client) return
  return client.send('enable-all', { enable, names })
})

/** Stop the watcher */
ipcMain.handle('stop-watch', async () => {
  watchedNames = []
  if (!client) return
  return client.send('stop-watch', {})
})

/** Returns the OS color scheme and Windows accent color for the System theme */
ipcMain.handle('get-system-theme', () => ({
  isDark: nativeTheme.shouldUseDarkColors,
  accentColor: getSystemAccentColor(),
}))

/** Persist a single setting (key/value) to the on-disk app config file */
ipcMain.handle('save-setting', (_event, key, value) => {
  if (typeof key === 'string') {
    writeConfig({ [key]: value })
  }
})

/** Wipe the on-disk config and trigger the renderer to clear localStorage */
ipcMain.handle('reset-settings', () => { resetAppSettings() })

/** Set or remove the Windows startup (login item) entry */
ipcMain.handle('set-launch-at-startup', async (_event, enable) => {
  // =========================================================================
  // DEBUG LOGGING - set-launch-at-startup IPC handler
  // =========================================================================
  console.log('='.repeat(80));
  console.log('[DEBUG] set-launch-at-startup IPC handler called');
  console.log('='.repeat(80));
  console.log(`[DEBUG] Enable parameter: ${enable}`);
  console.log(`[DEBUG] Type of enable: ${typeof enable}`);
  console.log(`[DEBUG] Boolean value: ${!!enable}`);
  
  try {
    if (!!enable) {
      console.log('[DEBUG] Calling createStartupTask()...');
      await createStartupTask();
      console.log('[DEBUG] createStartupTask() completed successfully');
    } else {
      console.log('[DEBUG] Calling removeStartupTask()...');
      await removeStartupTask();
      console.log('[DEBUG] removeStartupTask() completed successfully');
    }
    writeConfig({ launchAtStartup: !!enable })
    console.log('[DEBUG] Config updated with launchAtStartup:', !!enable);
    console.log('='.repeat(80));
    return { success: true }
  } catch (error) {
    console.error('[Screen Shield] Failed to update startup setting:', error);
    console.error('[DEBUG] Error details:', error.message);
    console.error('[DEBUG] Error stack:', error.stack);
    console.log('='.repeat(80));
    return { success: false, error: error.message }
  }
})

/** Returns the current launch-at-startup state */
ipcMain.handle('get-launch-at-startup', () => {
  // =========================================================================
  // DEBUG LOGGING - get-launch-at-startup IPC handler
  // =========================================================================
  console.log('='.repeat(80));
  console.log('[DEBUG] get-launch-at-startup IPC handler called');
  console.log('='.repeat(80));
  const exists = checkStartupTaskExists();
  console.log(`[DEBUG] Task exists: ${exists}`);
  console.log('='.repeat(80));
  return exists;
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) createMainWindow()
})

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
  
  if (client) {
    client.stop()
    client = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
})
