//! The agents' Mac (D298): a Mac whose node runs as a standard `agents` user lends its shell, builds and iOS
//! simulators to agents on every machine at once.

use serde::{Deserialize, Serialize};

/// node.json's `mac`: this Mac is the agents' Mac. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacToolConfig {
    /// True makes this machine the agents' Mac, on macOS under a standard (non-admin) user only. Absent: off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// iOS simulators booted for agents at once. Absent: from the Mac's memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simulators: Option<u32>,
}

impl MacToolConfig {
    /// Whether the node is the agents' Mac: turned on, on macOS, and not running as an admin.
    pub fn on(&self) -> bool {
        self.enabled == Some(true) && cfg!(target_os = "macos") && admin_check().is_ok()
    }
}

/// Why this process's user may not lend the Mac to agents: it's an admin (in the `admin` group, `id -Gn`) or may
/// sudo without a password (`sudo -n true`). An unreadable `id` counts as admin, so the Mac stays off rather than lending
/// an admin's account. Setup's check uses it too.
pub fn admin_check() -> Result<(), String> {
    let groups = match std::process::Command::new("id").arg("-Gn").output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => return Err("fleetd couldn't read this user's groups (`id -Gn`)".into()),
    };
    if admin_in(&groups) {
        return Err(
            "this user is an admin of the Mac: agents need a standard user of their own".into(),
        );
    }
    let sudo = std::process::Command::new("sudo")
        .args(["-n", "true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if sudo.is_ok_and(|s| s.success()) {
        return Err("this user may sudo without a password: agents' user must not".into());
    }
    Ok(())
}

/// Whether `id -Gn`'s groups name `admin`.
pub fn admin_in(groups: &str) -> bool {
    groups.split_whitespace().any(|g| g == "admin")
}
