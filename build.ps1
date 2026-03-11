# build.ps1 — Full build pipeline for ScreenShield
# Usage (Windows Terminal / PowerShell 7):  .\build.ps1
# Usage (double-click / keep window open):  powershell -NoExit -File build.ps1
#
# Steps:
#   1. Initialize MSVC environment (vcvarsall x64)
#   2. cargo build --release  (produces ScreenShieldHelper.exe + utils.dll)
#   3. vite build + electron-builder --win (produces build/)

Set-StrictMode -Version Latest

$root = $PSScriptRoot

function Step([string]$msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function OK([string]$msg) {
    Write-Host "    $msg" -ForegroundColor Green
}

function Fail([string]$msg) {
    Write-Host "`n[FAILED] $msg" -ForegroundColor Red
    Read-Host "`nPress Enter to close"
    exit 1
}

# ---------------------------------------------------------------------------
# 0. Initialize MSVC x64 environment
#    cargo (x86_64-pc-windows-msvc toolchain) needs LIB / INCLUDE / PATH set
#    by vcvarsall.bat.  We locate it via vswhere.exe and import the variables
#    into the current PowerShell session so all subsequent native commands
#    (cargo, link.exe) can find libcmt.lib and friends.
# ---------------------------------------------------------------------------
Step "Initialising MSVC x64 environment..."

$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vsWhere)) {
    Fail "vswhere.exe not found. Install Visual Studio 2022 with the 'Desktop development with C++' workload."
}

$vsInstall = & $vsWhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath

if (-not $vsInstall) {
    Fail "No Visual Studio installation with C++ build tools found.`nOpen Visual Studio Installer and add the 'Desktop development with C++' workload."
}

$vcvarsall = Join-Path $vsInstall "VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path $vcvarsall)) {
    Fail "vcvarsall.bat not found at: $vcvarsall"
}

# Run vcvarsall and capture the resulting environment variables
$envLines = cmd /c "`"$vcvarsall`" x64 > nul 2>&1 && set"
foreach ($line in $envLines) {
    if ($line -match '^([^=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
OK "MSVC x64 environment ready  ($vsInstall)"

# ---------------------------------------------------------------------------
# 0b. Kill any running ScreenShield / Electron processes that would hold a
#     file lock on the previous build output and cause "Access is denied"
#     when electron-builder tries to clean the win-unpacked directory.
# ---------------------------------------------------------------------------
Step "Stopping any running ScreenShield processes..."

$targets = @('ScreenShield', 'electron')
foreach ($name in $targets) {
    $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force
        Write-Host "    Stopped $($procs.Count) $name process(es)." -ForegroundColor Yellow
    }
}
# Brief pause so Windows can fully release file handles
Start-Sleep -Milliseconds 800

# ---------------------------------------------------------------------------
# 1. Rust backend
# ---------------------------------------------------------------------------
Step "Building Rust backend (cargo build --release)..."

$rustDir = Join-Path $root "native-backend"
if (-not (Test-Path $rustDir)) {
    Fail "native-backend directory not found at: $rustDir"
}

Push-Location $rustDir
cmd /c "cargo build --release"
$cargoExit = $LASTEXITCODE
Pop-Location

if ($cargoExit -ne 0) { Fail "cargo build failed (exit $cargoExit)" }

# Verify the expected outputs exist
foreach ($f in @(
    (Join-Path $rustDir "target\release\ScreenShieldHelper.exe"),
    (Join-Path $rustDir "target\release\ScreenShieldHook.dll")
)) {
    if (-not (Test-Path $f)) { Fail "Expected output not found: $f" }
}
OK "ScreenShieldHelper.exe and ScreenShieldHook.dll built successfully."

# ---------------------------------------------------------------------------
# 1b. Remove intermediate executables and DLLs from target/release/deps/
#     Cargo copies the final binary there as part of its incremental build
#     cache.  These duplicates are identical to the release binary and trigger
#     the same AV heuristics.  Removing them prevents Defender from
#     quarantining redundant copies that are never packaged or distributed.
# ---------------------------------------------------------------------------
Step "Cleaning intermediate binaries from target/release/deps/..."
$depsDir = Join-Path $rustDir "target\release\deps"
if (Test-Path $depsDir) {
    $removed = 0
    foreach ($pattern in @("*.exe", "*.dll")) {
        $files = @(Get-ChildItem (Join-Path $depsDir $pattern) -File -ErrorAction SilentlyContinue)
        $files | Remove-Item -Force
        $removed += $files.Count
    }
    OK "Removed $removed intermediate binary file(s) from deps/."
} else {
    OK "deps/ not found -- nothing to clean."
}

# ---------------------------------------------------------------------------
# 2. Vite frontend + electron-builder packaging
# ---------------------------------------------------------------------------
Step "Building frontend and packaging Electron app (npm run build)..."

# Disable electron-builder's auto certificate discovery.
# Without this flag it downloads winCodeSign (a macOS signing toolchain) and
# tries to extract macOS .dylib symlinks — which requires SeCreateSymbolicLinkPrivilege
# and fails on most Windows setups.  We have no signing cert, so skip it entirely.
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

# Remove any partially-extracted winCodeSign cache left by previous failed attempts.
$codeSignCache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
if (Test-Path $codeSignCache) {
    Remove-Item -Recurse -Force $codeSignCache
    Write-Host "    Cleared stale winCodeSign cache." -ForegroundColor Yellow
}

Push-Location $root
cmd /c "npm run build"
$npmExit = $LASTEXITCODE
Pop-Location

if ($npmExit -ne 0) { Fail "npm run build failed (exit $npmExit)" }

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Step "Build complete!"
OK "Output directory: $(Join-Path $root 'build')"
OK ""
OK "  Installer : build\ScreenShield-Setup-*.exe"
OK "  Portable  : build\ScreenShield-Portable-*.exe"

Read-Host "`nPress Enter to close"
