use {
    std::{env, io},
    winresource::WindowsResource,
};

fn main() -> io::Result<()> {
    if env::var_os("CARGO_CFG_WINDOWS").is_some() {
        WindowsResource::new()
            .set("FileDescription",  "Screen Shield - Window Privacy Hook")
            .set("ProductName",      "ScreenShield")
            .set("CompanyName",      "Freerunnerx10")
            .set("LegalCopyright",   "Copyright \u{00a9} 2026 Freerunnerx10")
            .set("OriginalFilename", "ScreenShieldHook.dll")
            .set("FileVersion",      "1.0.0.0")
            .set("ProductVersion",   "1.0.0")
            .compile()?;
    }
    Ok(())
}
