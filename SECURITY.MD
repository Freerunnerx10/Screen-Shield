# Security Review Report: Screen Shield

## Executive Summary

Screen Shield is a Windows privacy utility designed to prevent selected windows and overlays from appearing in screen capture software while remaining visible to the user. The application achieves this through a combination of legitimate Windows APIs and techniques that, while intended for privacy protection, exhibit behaviors commonly associated with malicious software such as screen loggers, remote access trojans, and bypass tools.

This security review identifies that Screen Shield employs process injection, API hooking, and persistent monitoring mechanisms that are functionally similar to those used by malware. While the implemented techniques serve a legitimate privacy purpose, they trigger security controls and may be blocked or flagged by enterprise endpoint protection platforms.

The application requires administrator privileges to function correctly and establishes persistence through optional Windows Task Scheduler entries.

## Threat Model Overview

**Assets Protected**: User privacy by preventing sensitive window content from appearing in screen captures, recordings, or streams.

**Threat Actors Considered**:
- Malicious screen capture software attempting to exfiltrate visual data
- Unauthorized recording or streaming applications
- Shoulder surfing attacks mitigated by keeping content visible locally

**Attack Surface**:
- Process injection mechanisms targeting user applications
- System-wide window monitoring via ETW and WinEvent hooks
- Inter-process communication channels
- Privilege escalation vectors through service installation
- Persistence mechanisms

**Assumptions**:
- User trusts the application with access to window visibility state
- Administrator privileges are granted intentionally for privacy functionality
- Network isolation prevents exfiltration (application is strictly local)
- User understands the security trade-offs of privacy vs. detectability

## Findings

### High Severity

**Finding**: Process Injection via DLL Syringe
- **Location**: `native-backend/injector/src/native.rs` - `Injector::set_window_props()` and related functions
- **Description**: Uses the `dll-syringe` crate to inject `ScreenShieldHook.dll` into target processes. This involves opening process handles (`OpenProcess`), allocating remote memory, and creating remote threads to load and initialize the DLL.
- **Why it matters**: DLL injection is a primary technique used by malware, remote access trojans, and credential stealers to execute code within the context of legitimate processes. Endpoint detection and response (EDR) solutions commonly flag and block such behavior. The injected DLL establishes persistent hooks within target processes to monitor window events and modify display affinity.
- **Recommendation**: While core to the product's functionality, document this behavior prominently for security teams. Consider implementing integrity checks on the injected DLL and implementing additional safeguards to prevent injection into critical system processes (csrss.exe, winlogon.exe, lsass.exe, etc.). Explore whether user-mode hooking APIs (like the existing WinEvent hook approach) could achieve similar results with lower detectability.

**Finding**: Persistent WinEvent Hook Installation
- **Location**: `native-backend/payload/src/lib.rs` - `EnableAutoHide()` function
- **Description**: Installs a `WINEVENT_INCONTEXT` hook via `SetWinEventHook` for `EVENT_OBJECT_CREATE` through `EVENT_OBJECT_LOCATIONCHANGE` events. This hook runs in the context of injected processes and receives synchronous notifications before window creation functions return.
- **Why it matters**: While `WINEVENT_INCONTEXT` hooks are less invasive than global hooks (`WINEVENT_OUTOFCONTEXT`), they still represent API hooking behavior. The specific event range monitored (including `LOCATIONCHANGE`) enables continuous protection during window operations like dragging/resizing, which is more aggressive than standard hooking patterns. EDR solutions may flag the combination of DLL injection followed by WinEvent hook installation as indicative of tampering or surveillance behavior.
- **Recommendation**: Limit the hook event range to only what is strictly necessary (`EVENT_OBJECT_CREATE` and `EVENT_OBJECT_SHOW` may suffice for most use cases). Consider implementing runtime integrity checks to detect if the hook has been tampered with or bypassed. Provide clear documentation about the hook's purpose and scope.

### Medium Severity

**Finding**: ETW Process Creation Monitoring
- **Location**: `native-backend/injector/src/native.rs` - `start_etw_process_watcher()` and related ETW functions
- **Description**: Registers for real-time Event Tracing for Windows (ETW) notifications from the `Microsoft-Windows-Kernel-Process` provider to detect when new processes are created. This enables proactive injection into target processes before they create their first window.
- **Why it matters**: ETW monitoring for process creation is a technique used by both legitimate security products (for behavioral monitoring) and malware (for early injection). While less commonly hooked than process creation APIs, monitoring ETW providers can still raise alerts in environments with strict process monitoring controls.
- **Recommendation**: Document this behavior as part of the product's proactive protection model. Ensure the ETW session is properly cleaned up on application exit. Consider providing an option to disable proactive monitoring in favor of reactive (on-demand) protection for users concerned about ETW-related detections.

**Finding**: Cross-Process Window Manipulation
- **Location**: Multiple locations using `SetWindowDisplayAffinity`, `SetWindowLongW`, `SetWindowPos`
- **Description**: Modifies window attributes and styles in target processes to exclude them from screen capture (`WDA_EXCLUDEFROMCAPTURE`) and alter taskbar/Alt-Tab presentation.
- **Why it matters**: While these are legitimate Windows APIs, their combination with process injection to modify other processes' windows is reminiscent of techniques used by window loggers or surveillance tools that alter window visibility or behavior covertly.
- **Recommendation**: These APIs are core to the product's function and cannot be easily replaced. Focus on ensuring that manipulations are transparent to the user (windows remain visible and interactive) and that changes are reverted promptly when protection is disabled. Consider adding runtime checks to prevent manipulation of system-critical windows that could destabilize the user session.

### Low Severity

**Finding**: Administrator Privilege Requirement
- **Location**: `main.js` - elevation check and restart logic
- **Description**: The application requires administrator privileges to successfully inject into processes owned by other users or elevated processes. It implements both manifest-based `requireAdministrator` and runtime elevation checks.
- **Why it matters**: While necessary for full functionality, requiring administrator privileges increases the potential impact if the application is compromised. However, this is a reasonable requirement given the privilege levels needed for cross-process injection.
- **Recommendation**: Maintain the current elevation approach but consider implementing a reduced-functionality mode that operates without administrator privileges (protecting only user-owned processes) for environments where elevation is prohibited.

**Finding**: Optional Persistence via Scheduled Task
- **Location**: `main.js` - `createStartupTask()`, `removeStartupTask()` functions
- **Description**: Offers to create a Windows Scheduled Task that launches the application at user login with highest privileges (`/RL HIGHEST`).
- **Why it matters**: Persistence mechanisms are a key indicator looked for by security tools when assessing potential malware. While this persistence is user-configurable and visible in Task Scheduler, it still represents a mechanism for ensuring the application survives reboots.
- **Recommendation**: Keep the persistence mechanism but ensure it is off by default and clearly labeled. Provide transparent visibility into the scheduled task's existence and allow easy removal. Consider using the task's description field to clearly identify its purpose.

### Informational

**Finding**: Memory and Handle Management
- **Location**: Throughout codebase
- **Description**: The application opens process handles, creates remote threads, and allocates memory in target processes. Proper cleanup is implemented in most paths.
- **Why it matters**: While not inherently malicious, these operations contribute to the overall behavioral profile that resembles injection-based malware.
- **Recommendation**: Continue current resource management practices. Consider adding additional error handling paths to ensure resources are always cleaned up even in failure scenarios.

**Finding**: Diagnostic Logging
- **Location**: Multiple locations using `eprintln!` and file logging to `%TEMP%`
- **Description**: Writes diagnostic information to console and temporary files, including when running inside injected processes.
- **Why it matters**: While useful for debugging, logging from injected processes could potentially expose sensitive information if the log files are accessed by other processes or users.
- **Recommendation**: Consider limiting diagnostic logging in production builds or implementing access controls on log files. Ensure logs do not contain sensitive window content or user data.

## Keylogger Misclassification Risk Analysis

Screen Shield implements window event monitoring rather than direct input monitoring, which significantly reduces keylogging concerns but does not eliminate all risks of misclassification:

**Event Monitoring Scope**:
- Monitors `EVENT_OBJECT_CREATE`, `EVENT_OBJECT_SHOW`, and `EVENT_OBJECT_LOCATIONCHANGE` events
- These are window lifecycle events, not keyboard or mouse input events
- Does not use `SetWindowsHookEx` with `WH_KEYBOARD_LL` or `WH_MOUSE_LL` hooks
- Does not call `GetAsyncKeyState`, `GetKeyState`, or similar input querying functions

**Why Security Tools Might Flag It**:
1. **Behavioral Similarity**: The combination of DLL injection + persistent event monitoring + cross-process window manipulation resembles the behavioral chain used by some advanced keyloggers that need to know when to start/stop logging based on window focus.
2. **Hook Installation**: Any use of `SetWinEventHook`, even with `WINEVENT_INCONTEXT`, may trigger signature-based detection for known malware families that use this API.
3. **Process Context**: Running hooks inside processes like web browsers, banking applications, or cryptocurrency wallets may raise additional suspicion due to the high-value targets typically monitored by financial malware.

**Distinguishing Intent vs. Behavior**:
- **Legitimate Intent**: The window monitoring is used solely to apply and re-apply window display affinity attributes (`WDA_EXCLUDEFROMCAPTURE`) to prevent screen capture, not to record or transmit window content or input.
- **Technical Implementation**: The in-process hook (`in_process_hook` in `payload/src/lib.rs`) only calls Windows API functions related to window visibility and composition state. It does not capture window contents, keystrokes, mouse movements, or any user input data.
- **Data Flow**: All operations are confined to modifying window attributes locally on the user's desktop. No data is collected, stored, or transmitted outside the local machine.

**Conclusion**: While Screen Shield's behavior includes elements that could contribute to a heuristic score for keylogging malware, the absence of actual input capture mechanisms significantly reduces this risk. Security products that rely on behavioral analysis may still flag it due to the procedural similarity to surveillance software, but those using more specific indicators should be able to distinguish it based on the lack of data exfiltration or input monitoring capabilities.

## Defender / Endpoint Security Concerns

### Microsoft Defender Specific Concerns
1. **Process Injection Behavioral Triggers**:
   - `OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION`
   - Remote memory allocation and thread creation via `dll-syringe`
   - These behaviors match Defender's ML model for `Behavior:Win32/DefenseEvasion.A!ml` as noted in the code comments
   - **Risk Level**: Medium-High - leads to false positives requiring exclusions

2. **Persistent Monitoring**:
   - ETW session creation for process creation monitoring
   - WinEvent hook installation in remote processes
   - May trigger behavioral detection as "potential surveillance activity"
   - **Risk Level**: Medium

### General Endpoint Detection and Response (EDR) Concerns
EDR solutions (CrowdStrike, SentinelOne, etc.) are likely to flag:
1. **DLL Injection**: The core injection mechanism is a primary detection vector for many EDR platforms
2. **Hook Chaining**: Injection followed immediately by WinEvent hook installation represents a multi-stage technique
3. **Window API Abuse**: Using `SetWindowDisplayAffinity` for anti-capture purposes may be flagged as "evasion" or "anti-forensics" in some contexts
4. **ETW Misuse**: While ETW is legitimate, using it for proactive process monitoring to enable faster injection may be viewed suspiciously

### Enterprise Policy Compliance Risks
1. **Privilege Escalation Perception**: Cross-process injection may be interpreted as privilege escalation attempt
2. **Persistence Mechanisms**: Scheduled tasks, while user-enabled, still represent autorun vectors
3. **Binary Unsignedness**: As noted in the code, lack of code signing increases heuristic detection risk
4. **Living-off-the-land Binaries (LOLBins)**: Use of `schtasks.exe`, `powershell.exe` for legitimate purposes may still raise flags in tightly controlled environments

## Enterprise Deployment Risks

1. **False Positive Overhead**: Even with exclusions, behavioral detections may still occur requiring:
   - Security team investigation time
   - Potential quarantine/restore cycles
   - User productivity impact during remediation

2. **Policy Violations**: Deployment may violate:
   - Endpoint security baseline configurations
   - Change management procedures for security product modifications
   - Acceptable use policies regarding system modification tools

3. **Incident Response Complications**: During security investigations:
   - Legitimate injection behavior may be mistaken for compromise
   - Forensic analysis may need to distinguish between product activity and actual threats
   - Alert fatigue from repeated true-positive detections of the product's own behavior

4. **Scope Creep Concerns**: In high-security environments, administrators may question:
   - Why a privacy tool needs kernel-level process monitoring
   - Whether the same techniques could be repurposed for malicious purposes
   - The adequacy of safeguards against potential subversion or tampering

## Recommended Remediations

### Immediate Actions (High Priority)
1. **Implement Process Injection Safeguards**:
   - Add blacklist of critical system processes that should never be injected (csrss.exe, winlogon.exe, lsass.exe, services.exe, etc.)
   - Implement integrity verification of the injected DLL before and after injection
   - Consider reducing injection privileges where possible (e.g., only query necessary process information)

### Medium Priority Improvements
1. **Refine Event Monitoring Scope**:
   - Evaluate whether `EVENT_OBJECT_LOCATIONCHANGE` is strictly necessary for all use cases
   - Consider making the event range configurable or configurable per-process
   - Add timeout/disable mechanisms for the ETW watcher when not actively needed

2. **Enhance Transparency and Control**:
   - Provide more detailed UI feedback about which processes are being monitored/injected
   - Implement granular controls (per-process injection enable/disable)
   - Add ability to view and terminate active injection threads or hooks

3. **Strengthen Code Signing and Integrity**:
   - Implement Authenticode code signing for all binaries as noted in code comments
   - Consider implementing runtime integrity checks for critical DLLs
   - Explore Windows Defender Application Control (WDAC) rules for allowed injection targets

### Long Term Considerations
1. **Alternative Architectures**:
   - Investigate whether User-Mode Driver Framework (UMDF) or other less-invasive approaches could achieve similar results
   - Explore whether desktop duplication API (`IDXGIOutputDuplication`) combined with window occlusion queries could provide capture prevention without injection
   - Evaluate if the Windows Graphics Capture API (`windows-capture` crate already used) could be leveraged differently

2. **Improved Auditing and Logging**:
   - Implement secure logging of injection/hook activities for administrator review
   - Consider adding telemetry (opt-in) about detection events to help tune behavior
   - Maintain an audit trail of security-relevant operations (exclusion changes, injection events, etc.)

## Safe Usage Guidelines

### For Individual Users
1. **Understand the Trade-offs**: Recognize that the same techniques that provide screen capture protection also resemble those used by malicious software
2. **Maintain Updates**: Keep the application updated to benefit from any security-related behavior refinements
3. **Monitor Detections**: Pay attention to security product alerts and work with vendors to establish true-positive allowlists where appropriate
4. **Consider Context**: Be aware that using the tool on corporate-managed devices may violate acceptable use policies
5. **Verify Integrity**: Periodically verify that downloaded binaries match expected hashes/signatures

### For Enterprise Administrators
1. **Test Thoroughly**: Evaluate the application in a controlled lab environment before widespread deployment
2. **Document Exceptions**: If deploying, create formal exception requests for:
   - Behavior monitoring rules that may flag injection/hook behavior
   - Exclusion list modifications needed for proper function
   - Privilege requirements for cross-process operation
3. **Implement Granular Controls**: Consider deployment strategies such as:
   - Allowing use only on specific workstation types (e.g., not on domain controllers)
   - Restricting to users with legitimate privacy needs (financial, legal, health professionals)
   - Implementing application control rules that allow the binary but monitor its behavior closely
4. **Provide Clear User Guidance**: Educate users about:
   - Why administrator privileges are needed
   - What the protection actually does (and does not do)
   - How to recognize legitimate vs. malicious behavior
   - Reporting procedures for unexpected alerts or behavior
5. **Monitor and Review**: Establish processes to:
   - Track security product alerts related to the application
   - Review periodic reports on usage and detected behaviors
   - Reassess risk/benefit balance as threats and defenses evolve

### For Security Product Vendors
1. **Consider Context-Aware Detection**: Develop detections that distinguish between:
   - Legitimate privacy/security tools using injection for defensive purposes
   - Malicious software using identical techniques for offense
   - Potentially leverage code signing, publisher reputation, and user intent signals
2. **Provide Clear Documentation**: Offer specific guidance on how to configure products to allow legitimate privacy tools while maintaining protection against actual threats
3. **Engage with Developers**: Consider participating in developer outreach programs to help security-conscious applications minimize false positives while maintaining efficacy

## Conclusion

Screen Shield implements a technically sound solution for preventing window content from appearing in screen captures. However, its implementation necessarily involves techniques—process injection, API hooking, persistent monitoring, and cross-process window manipulation—that are intrinsically associated with both legitimate security products and malicious software.

The primary security concern is not malicious intent within the product itself, but rather the inevitable friction between its protective mechanisms and enterprise security controls designed to detect and prevent exactly these types of behaviors. For successful enterprise deployment, organizations must weigh the privacy benefits against the increased alert volume, potential for false positives, and need for formal exception processes. The application's developers should strongly consider implementing safeguards and enhancing transparency to facilitate informed risk acceptance decisions by administrators and security teams.

With appropriate safeguards, documentation, and user education, Screen Shield can be used safely in environments where its specific privacy protections are justified and where security teams are equipped to distinguish its legitimate behavior from actual threats.