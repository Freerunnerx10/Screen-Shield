; installer.nsh
; Screen Shield — custom NSIS install / uninstall hooks
;
; ScreenShieldHelper.exe uses Windows DLL injection to apply
; SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) inside each protected
; application's process.  This legitimate technique matches behavioural
; patterns used by some malware, causing Microsoft Defender to raise a
; false-positive alert on the helper binary.
;
; The macros below add Defender exclusions immediately after installation
; and remove them when the application is uninstalled.  Both operations
; run silently; errors are caught and discarded so they never block the
; install or uninstall flow.
; ---------------------------------------------------------------------------

!macro customInstall
  ; Add Microsoft Defender exclusions for the installed directory and the
  ; helper process and hook DLL so Defender does not quarantine them at runtime.
  nsExec::ExecToStack "powershell.exe -NonInteractive -WindowStyle Hidden -Command $\"try { Add-MpPreference -ExclusionPath '$INSTDIR' -ExclusionProcess 'ScreenShieldHelper.exe','ScreenShieldHook.dll' -Force -ErrorAction SilentlyContinue } catch {}$\""
  Pop $0  ; exit code  (ignored)
  Pop $1  ; stdout/err  (ignored)

  ; Write publisher and support URLs to the uninstall registry key so they
  ; appear in Windows Apps & Features / Add-Remove Programs.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout"  "https://github.com/Freerunnerx10/Screen-Shield"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "HelpLink"      "https://github.com/Freerunnerx10/Screen-Shield/issues"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "URLUpdateInfo" "https://github.com/Freerunnerx10/Screen-Shield/releases"
!macroend

!macro customUnInstall
  ; Remove the Defender exclusions when the application is uninstalled.
  nsExec::ExecToStack "powershell.exe -NonInteractive -WindowStyle Hidden -Command $\"try { Remove-MpPreference -ExclusionPath '$INSTDIR' -ExclusionProcess 'ScreenShieldHelper.exe','ScreenShieldHook.dll' -Force -ErrorAction SilentlyContinue } catch {}$\""
  Pop $0
  Pop $1
!macroend
