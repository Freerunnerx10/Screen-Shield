<p align="center">
  <img src="resources/ScreenShield- Logo (NoBorder).png" alt="Screen Shield Logo" width="140" />
</p>

<h1 align="center">Screen Shield</h1>

<p align="center">
  A Windows privacy utility that prevents selected windows and overlays from appearing in screen capture software while remaining visible to the user.
</p>

<p align="center">
  <a href="https://github.com/Freerunnerx10/Screen-Shield/releases/latest"><img src="https://img.shields.io/github/v/release/Freerunnerx10/Screen-Shield?style=flat-square&label=latest%20release" alt="Latest Release" /></a>
  <a href="https://github.com/Freerunnerx10/Screen-Shield/releases"><img src="https://img.shields.io/github/downloads/Freerunnerx10/Screen-Shield/total?style=flat-square" alt="Total Downloads" /></a>
  <a href="https://github.com/Freerunnerx10/Screen-Shield/stargazers"><img src="https://img.shields.io/github/stars/Freerunnerx10/Screen-Shield?style=flat-square" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Freerunnerx10/Screen-Shield?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#installation">Installation</a> · <a href="#usage">Usage</a> · <a href="#notes">Notes</a> · <a href="#license">License</a>
</p>

---

## Overview

Screen Shield uses the Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` API to make individual windows invisible in screenshots, screen recordings, and streaming software — while keeping them fully visible and interactive on your physical display.

Because this API must be called from within the target process, Screen Shield injects a lightweight hook DLL into each process that needs protection. A native Rust helper handles process enumeration, DLL injection, and real-time monitoring so that newly opened windows from hidden processes are protected automatically.

---

## Features

- **Screen capture protection** — uses the Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` API to hide windows from screenshots, recordings, and streaming software while keeping them visible on your display
- **Instant window hiding** — new windows from hidden processes are protected before their first frame is composited, using in-process hooks and DWM cloaking
- **Chrome compatibility** — reliably hides Chrome windows across all scenarios including new tabs, detached windows, and tab-drag operations with zero visible frames in capture
- **Steam compatibility** — stable hiding for Steam windows and overlays
- **Per-window and group controls** — toggle individual windows with the eye icon, or hide all windows belonging to a process at once
- **Live preview** — a real-time capture view shows exactly what screen capture software will see
- **Auto-hide watcher** — newly opened windows from locked processes are hidden automatically without manual intervention
- **Advanced controls** — independently hide the desktop background, Task View, or the taskbar from capture
- **System tray** — minimises to the notification area and continues running in the background; restore from the tray icon or context menu
- **Portable and installer builds** — available as an NSIS installer or a single portable executable
- **Session restore** — hidden window state is restored automatically when the application restarts
- **Launch on startup** — optional toggle in Settings to start Screen Shield with Windows
- **Theme support** — four built-in themes (Default, Dark, Light, System) with instant switching

---

## Installation

Download the latest version from the [GitHub Releases](https://github.com/Freerunnerx10/Screen-Shield/releases) page.

| Build | Description |
|---|---|
| **`ScreenShield_Setup_v1.0.exe`** | Installer (recommended) — installs to Program Files with desktop shortcut |
| **`ScreenShield_Portable_v1.0.exe`** | Portable executable — no installation required |

> **NOTE:**
> Administrator privileges are recommended. Without elevation, hiding windows owned by other users or high-integrity processes will not work.

---

## Usage

1. Launch **Screen Shield** (Run as administrator is recommended).
2. The **Hide Applications** panel lists all visible top-level windows. Click the eye icon on any row to hide that window from capture.
3. Click the group eye icon next to a process name to hide or restore all of its windows at once.
4. Use the **Preview** pane at the top to confirm which windows are hidden — it shows your screen as capture software would see it.
5. Open the **Advanced** panel to hide the desktop background, Task View, or the taskbar from capture.
6. Click the gear icon to open **Settings**, where you can change the theme, enable launch on startup, or reset the application.
7. Close the window to minimise to the system tray. The auto-hide watcher continues running in the background.

---

## Notes

- All processing is local. Screen Shield makes no network connections and transmits no data.
- Screen Shield uses the official `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` Windows API, available since Windows 10 version 2004.
- The hook DLL is injected into target processes to call the API from within-process. This technique may be flagged as suspicious by some antivirus products. The installer and a runtime startup routine both add Defender exclusions automatically.

> **NOTE:**
> Code signing is not currently applied for production builds. Signing the binaries with a trusted certificate is recommended to eliminate antivirus warnings.

---

## License

This project is licensed under the MIT License.
See the [LICENSE](LICENSE) file for full details.

Copyright © 2026 Freerunnerx10

## Acknowledgements

This project incorporates code derived from the [InvisWind](https://github.com/radiantly/invisiwind) project created by [radiantly](https://github.com/radiantly).

The original InvisWind project is licensed under the MIT License and attribution is provided in accordance with the terms of that license.

See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for additional information.
