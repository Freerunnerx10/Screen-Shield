<p align="center">
  <img src="resources/ScreenShield- Logo (NoBorder).png" alt="Screen Shield Logo" width="140" />
</p>

<h1 align="center">Screen Shield</h1>

<p align="center">
  A Windows privacy utility that prevents selected windows and overlays from appearing in screen capture software, recordings, and streams while remaining fully visible and interactive on your display.
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#installation">Installation</a> · <a href="#usage">Usage</a> · <a href="#notes">Notes</a> · <a href="#security-considerations">Security Considerations</a> · <a href="#acknowledgements">Acknowledgements</a> · <a href="#license">License</a>
</p>

---

## Overview

Screen Shield is a Windows privacy utility that prevents selected windows and overlays from appearing in screen capture software, recordings, and streams while remaining fully visible and interactive on your display.

---

## Features

- **Screen capture protection** — prevents selected windows and overlays from appearing in screenshots, screen recordings, and streaming software while keeping them fully visible on your display
- **Instant window hiding** — new windows from protected applications are hidden automatically before they become visible in capture software
- **Chrome compatibility** — reliably hides Chrome windows in all scenarios including new tabs, detached windows, and tab-drag operations
- **Steam compatibility** — stable hiding for Steam windows and overlays
- **Per-window and group controls** — toggle individual windows with the eye icon, or hide all windows belonging to a process at once
- **Intelligent window list** — hidden applications appear at the top of the list, sorted alphabetically, with visible applications below
- **Live preview** — see exactly what screen capture software will see in real time
- **Auto-hide watcher** — newly opened windows from protected applications are hidden automatically without manual intervention
- **Advanced controls** — independently hide the desktop background, Task View, or the taskbar from capture
- **System tray integration** — runs silently in the background with easy access via tray icon; restore windows from tray menu
- **Flexible deployment** — choose between installer version (with desktop shortcut) or portable executable (no installation required)
- **Session persistence** — your hidden window preferences are remembered and restored automatically when you restart the application
- **Clean exit** — when quitting via system tray, all previously hidden windows are automatically restored before the application closes
- **Launch at startup** — optional setting to start Screen Shield automatically when you log into Windows
- **Customizable appearance** — choose from four built-in themes (Default, Dark, Light, System) and switch instantly

---

## Installation

Download the latest version from the [GitHub Releases](https://github.com/Freerunnerx10/Screen-Shield/releases) page.

| Build | Description |
|---|---|
| **`ScreenShield_Setup_v1.1.1.exe`** | Installer (recommended) — installs to Program Files with desktop shortcut |
| **`ScreenShield_Portable_v1.1.1.exe`** | Portable executable — no installation required |

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
- The application does not modify system files or registry keys outside of its own configuration and optional scheduled task for launch at startup.
- Code signing is not currently applied for production builds. Signing the binaries with a trusted certificate is recommended to reduce heuristic detection by antivirus products.

---

## Security Considerations

See Security.md for full technical security details and behavioral analysis. Screen Shield employs process injection, API hooking, persistent monitoring, and cross-process window manipulation to provide real-time screen capture protection. These techniques, while necessary for the product's core purpose, may trigger alerts in endpoint protection platforms due to behavioral similarities with potentially unwanted software. The application requires administrator privileges for full functionality, and any required antivirus exclusions must be configured manually by the user or administrator following organizational policy.

---

## Acknowledgements

This project incorporates code derived from the [InvisWind](https://github.com/radiantly/invisiwind) project created by [radiantly](https://github.com/radiantly).

The original InvisWind project is licensed under the MIT License and attribution is provided in accordance with the terms of that license.

See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for additional information.

---

## License

This project is licensed under the MIT License.
See the [LICENSE](LICENSE) file for full details.

Copyright © 2026 Freerunnerx10
