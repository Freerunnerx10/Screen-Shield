use {
    std::{env, io},
    winresource::WindowsResource,
};

// Windows application manifest embedded as RT_MANIFEST (resource ID 1).
  // Declares:
  //   - Windows 10 / 11 OS compatibility (suppresses Vista-era compatibility shims)
  //   - requireAdministrator execution level (DLL injection requires elevated rights)
  // Both declarations give AV engines additional context that improves classification
  // accuracy compared to a binary with no manifest at all.
  const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity
      type="win32"
      name="ScreenShieldBackgroundService"
      version="1.0.0.0"
      processorArchitecture="amd64"/>
  <description>ScreenShield Background Service</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 and Windows 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>"#;

fn main() -> io::Result<()> {
     if env::var_os("CARGO_CFG_WINDOWS").is_some() {
         WindowsResource::new()
             .set_icon("../Misc/invicon.ico")
             .set("FileDescription",  "ScreenShield Background Service")
             .set("ProductName",      "ScreenShield")
             .set("CompanyName",      "Freerunnerx10")
             .set("LegalCopyright",   "Copyright \u{00a9} 2026 Freerunnerx10")
             .set("OriginalFilename", "ScreenShieldBackgroundService.exe")
             .set("FileVersion",      "1.0.0.0")
             .set("ProductVersion",   "1.0.0")
             .set_manifest(MANIFEST)
             .compile()?;
     }
     Ok(())
 }
