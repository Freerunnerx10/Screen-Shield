<p align="center">
  <img src="resources/ScreenShield- Logo (NoBorder).png" alt="Screen Shield Logo" width="140" />
</p>

<h1 align="center">Screen Shield</h1>

<p align="center">
  A Windows privacy utility that prevents selected windows and overlays from appearing in screen capture software, recordings, and streams while remaining fully visible and interactive on your display.
</p>

<p align="center">
  <a href="https://github.com/Freerunnerx10/Screen-Shield/releases/latest"><img src="https://img.shields.io/github/v/release/Freerunnerx10/Screen-Shield?style=flat-square&label=latest%20release" alt="Latest Release" /></a>
  <a href="https://github.com/Freerunnerx10/Screen-Shield/releases"><img src="https://img.shields.io/github/downloads/Freerunnerx10/Screen-Shield/total?style=flat-square" alt="Total Downloads" /></a>
  <a href="https://github.com/Freerunnerx10/Screen-Shield/stargazers"><img src="https://img.shields.io/github/stars/Freerunnerx10/Screen-Shield?style=flat-square" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Freerunnerx10/Screen-Shield?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#security-considerations">Security Considerations</a> · <a href="#defender-antivirus">Defender / Antivirus</a> · <a href="#enterprise-deployment">Enterprise Deployment</a> · <a href="#installation">Installation</a> · <a href="#usage">Usage</a> · <a href="#notes">Notes</a> · <a href="#license">License</a>
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
- **Advanced controls** — independently hide the desktop background, Task View, or taskbar from capture
- **System tray integration** — runs silently in the background with easy access via tray icon; restore windows from tray menu
- **Flexible deployment** — choose between installer version (with desktop shortcut) or portable executable (no installation required)
- **Session persistence** — your hidden window preferences are remembered and restored automatically when you restart the application
- **Clean exit** — when quitting via system tray, all previously hidden windows are automatically restored before the application closes
- **Launch at startup** — optional setting to start Screen Shield automatically when you log into Windows
- **Customizable appearance** — choose from four built-in themes (Default, Dark, Light, System) and switch instantly

---

## Security Considerations

Screen Shield employs legitimate Windows technologies to achieve its screen capture protection functionality. These techniques, while necessary for the product's core purpose, share behavioral similarities with those used by security tools and potentially unwanted software. As a result, the application may trigger alerts or be flagged by endpoint protection platforms.

**Key behaviors that may trigger security systems:**
- **Process injection**: To apply screen protection from within target processes, Screen Shield injects a small helper DLL into applications that need protection. This is a common technique used by both legitimate security products and malware.
- **API hooking**: The application installs window event hooks to monitor and maintain protection state in real time. Hooking mechanisms can be used for both defensive and offensive purposes.
- **Persistent monitoring**: Screen Shield uses Windows event tracing to detect when new processes start, enabling proactive protection before windows appear.
- **Cross-process window manipulation**: The application modifies window attributes in other processes to exclude them from screen capture while keeping them visible on screen.

**Functional necessity vs. security trade-off:**
Each of these behaviors is essential for Screen Shield to provide real-time, reliable screen capture protection without requiring manual re-protection of every new window. However, because these same techniques can be used for malicious purposes (e.g., data exfiltration, surveillance, or persistence), security products may flag them as potentially unwanted behavior.

**Enterprise impact:**
Organizations should evaluate whether the privacy benefits of Screen Shield outweigh the potential for increased security alerts or the need for exception processes in endpoint protection platforms. The application does not collect, store, or transmit any data, and all operations occur locally on the user's machine.

---

## Defender / Antivirus

Screen Shield may be flagged by Microsoft Defender or similar antivirus products due to its use of process injection and API hooking techniques. These behaviors match known patterns used by potentially unwanted applications, leading to false positive detections.

**Important:** Screen Shield does **not** automatically configure Microsoft Defender exclusions. Any exclusion configuration must be performed manually by a system administrator or via organizational policy to ensure compliance with enterprise security management.

**Recommendation:** If deploying Screen Shield in an environment with Microsoft Defender, administrators should:
1. Test the application in a controlled environment to observe Defender behavior.
2. If exclusions are required for proper function, configure them manually through the Windows Security interface or via Group Policy.
3. Never automate exclusion configuration via scripts or automation that bypasses change management processes, as this may violate enterprise security policies.

---

## Enterprise Deployment

### Admin Requirements
Screen Shield requires administrator privileges to function correctly when protecting windows owned by other users or high-integrity processes (e.g., services, administrator applications). The application implements both manifest-based and runtime elevation checks to enforce this requirement.

### Endpoint Security Considerations
Due to its use of process injection, API hooking, and persistent monitoring, Screen Shield may:
- Trigger behavioral detection rules in endpoint protection platforms (EDR, antivirus).
- Generate alerts related to DLL injection, hook installation, or process modification.
- Be mistaken for malicious activity during security investigations if proper context is not provided.

### Application Whitelisting Requirements
Organizations using application control solutions (e.g., Windows Defender Application Control, third-party allowlisting) should:
- Ensure the Screen Shield executable and its helper binaries are allowed to run.
- Consider allowing the specific injection and hooking behaviors only if justified by a documented risk assessment.
- Maintain an inventory of approved versions and monitor for unauthorized modifications.

### Corporate Environment Risks
Deployment of Screen Shield in managed environments may involve:
- **False positive overhead**: Security teams may need to investigate alerts related to the application's legitimate behavior.
- **Policy compliance**: Automated modification of security product configurations (e.g., Defender exclusions) violates centralized security management policies.
- **Incident response complications**: Legitimate injection behavior may be mistaken for compromise, requiring forensic analysis to distinguish between product activity and actual threats.
- **Scope creep considerations**: In high-security environments, administrators may question the necessity of kernel-level process monitoring for a privacy tool and evaluate the adequacy of safeguards against potential subversion.

Organizations should weigh the privacy benefits against these operational considerations and establish clear policies for use, exception handling, and monitoring.

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

## License

This project is licensed under the MIT License.
See the [LICENSE](LICENSE) file for full details.

Copyright © 2026 Freerunnerx10

---

## Acknowledgements

This project incorporates code derived from the [InvisWind](https://github.com/radiantly/invisiwind) project created by [radiantly](https://github.com/radiantly).

The original InvisWind project is licensed under the MIT License and attribution is provided in accordance with the terms of that license.

See [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) for additional information.