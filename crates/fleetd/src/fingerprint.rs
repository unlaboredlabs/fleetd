//! This computer's fingerprint: a hash of the id its OS gives it (`/etc/machine-id` on Linux, `IOPlatformUUID` on
//! macOS), the same whichever fleetd dir, user or host name is in use. A node's hello carries it, so the hub never
//! enrolls a second computer under a machine id that is already another's; hub_info gives the hub's, so the app
//! knows when it runs on the hub's own machine. The desktop app computes it the same way (src/main/joinHere.ts).
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

/// 64 hex digits from the OS's machine id; None where the OS gives none.
pub fn machine() -> Option<String> {
    static ID: OnceLock<Option<String>> = OnceLock::new();
    ID.get_or_init(|| os_machine_id().map(|id| of(&id))).clone()
}

/// The fingerprint of an OS machine id: never the id itself, which some tools treat as private.
pub fn of(os_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("fleetd machine {}", os_id.trim()))
    )
}

fn os_machine_id() -> Option<String> {
    let id = if cfg!(target_os = "macos") {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        platform_uuid(&String::from_utf8_lossy(&out.stdout))?
    } else {
        ["/etc/machine-id", "/var/lib/dbus/machine-id"]
            .iter()
            .find_map(|f| std::fs::read_to_string(f).ok())?
    };
    Some(id.trim().to_owned()).filter(|id| !id.is_empty())
}

/// `"IOPlatformUUID" = "…"` in `ioreg -rd1 -c IOPlatformExpertDevice`.
fn platform_uuid(ioreg: &str) -> Option<String> {
    ioreg.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("\"IOPlatformUUID\"")?;
        let value = rest.trim_start().strip_prefix('=')?.trim();
        Some(value.trim_matches('"').to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_os_id_and_reads_macos_uuid() {
        assert_eq!(of("abc\n"), of("abc"));
        assert_eq!(of("abc").len(), 64);
        assert_ne!(of("abc"), of("abd"));
        // The app hashes the same text (src/main/joinHere.test.ts holds the same value).
        assert_eq!(
            of("0123456789abcdef0123456789abcdef"),
            format!(
                "{:x}",
                Sha256::digest("fleetd machine 0123456789abcdef0123456789abcdef")
            )
        );
        let ioreg = "+-o Mac  <class IOPlatformExpertDevice>\n    {\n      \"IOPlatformSerialNumber\" = \"C02X\"\n      \"IOPlatformUUID\" = \"4C4C4544-0042-3510-8058-B4C04F4D3532\"\n    }\n";
        assert_eq!(
            platform_uuid(ioreg).as_deref(),
            Some("4C4C4544-0042-3510-8058-B4C04F4D3532")
        );
        assert_eq!(platform_uuid("nothing"), None);
    }
}
