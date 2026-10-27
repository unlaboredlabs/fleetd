//! What this machine can host for sessions (machine roles, W46), sent with each heartbeat's load: a browser (the
//! broker's Chrome, or its install on the first session), an Android emulator (fleetd's own pinned one, node/device,
//! with KVM), iOS simulators (fleetd's own golden and its clones, node/device/ios, with Xcode on macOS) and a Linux
//! desktop (docker or Xvfb). Each says why in plain words. Read at most every few minutes: `xcrun simctl` takes a
//! second.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fleetd_contracts::machine_roles::{HostCheck, HostChecks, SessionHost};
use fleetd_contracts::prim::{Line, List};

use fleetd_contracts::node_link::AndroidState;

use super::browser::BrowserConfig;
use super::browser::chrome;
use super::device::ios::IosConfig;
use super::device::{self, DeviceConfig};

const FRESH: Duration = Duration::from_secs(300);

fn check(host: SessionHost, ready: bool, detail: impl Into<String>) -> HostCheck {
    let mut detail: String = detail.into();
    if detail.len() > 300 {
        let mut end = 297;
        while !detail.is_char_boundary(end) {
            end -= 1;
        }
        detail.truncate(end);
        detail.push_str("...");
    }
    HostCheck {
        host,
        ready,
        detail: Line::unchecked(detail),
    }
}

/// The first of `names` on PATH.
fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

pub fn browser(home: &Path, config: &BrowserConfig) -> HostCheck {
    let host = SessionHost::Browser;
    if !config.enabled() {
        return check(host, false, "browser sessions are off in node.json");
    }
    if let Some(chrome) = &config.chrome {
        return match Path::new(chrome).is_file() {
            true => check(host, true, format!("Chrome at {chrome} (node.json)")),
            false => check(
                host,
                false,
                format!("node.json names Chrome at {chrome}, which is not there"),
            ),
        };
    }
    match chrome::find_chrome(&chrome::install_dir(home)) {
        Some(found) => check(host, true, format!("Chrome at {}", found.display())),
        None => check(
            host,
            true,
            "Chrome not installed yet: the node installs it with the first session",
        ),
    }
}

/// fleetd's own Android emulator (node/device): ready where it is installed, or the machine is opted in so the first
/// session installs it (again, after an install that failed), and /dev/kvm opens; else what stands in the way, as the
/// doctor says it.
pub fn android(home: &Path, config: &DeviceConfig) -> HostCheck {
    let host = SessionHost::Android;
    if !config.enabled() {
        let why = match device::sdk::supported() {
            true => "Android sessions are off in node.json",
            false => "Android sessions run on Linux x86_64 with KVM",
        };
        return check(host, false, why);
    }
    match device::health(home, config) {
        Some(health) => check(
            host,
            match health.state {
                AndroidState::Ready | AndroidState::Wanted => true,
                AndroidState::Installing => false,
                // With KVM opening, only a failed install: the next session tries it again, so the hub must send it.
                _ => device::sdk::kvm().is_ok(),
            },
            health.message.as_str(),
        ),
        None => check(
            host,
            false,
            "not set up: opt this machine in with \"device\": {\"enabled\": true} in node.json",
        ),
    }
}

/// fleetd's own iOS simulators (node/device/ios): ready once the node's golden simulator is made, else what stands in
/// the way, as the doctor says it.
pub fn ios(home: &Path, config: &IosConfig) -> HostCheck {
    let host = SessionHost::Ios;
    if !config.enabled() {
        let why = match device::ios::supported() {
            true => "iOS sessions are off in node.json",
            false => "iOS simulators need macOS",
        };
        return check(host, false, why);
    }
    // Ready where the golden is made, and also on a Mac opted in while it is made or after it failed, so the hub sends
    // the session there: the node says it is still making it, and the next session_start tries a failed one again.
    match device::ios::host(home, config) {
        Some((health, placeable)) => check(host, placeable, health.message.as_str()),
        None => check(
            host,
            false,
            "no Xcode: install it, then opt this Mac in with \"ios\": {\"enabled\": true} in node.json",
        ),
    }
}

fn desktop() -> HostCheck {
    let host = SessionHost::Desktop;
    if !cfg!(target_os = "linux") {
        return check(
            host,
            false,
            "desktop sessions run on Linux (docker or Xvfb)",
        );
    }
    match (on_path(&["Xvfb"]), on_path(&["docker", "podman"])) {
        (Some(x), Some(d)) => check(
            host,
            true,
            format!("Xvfb at {}, docker at {}", x.display(), d.display()),
        ),
        (Some(x), None) => check(host, true, format!("Xvfb at {}", x.display())),
        (None, Some(d)) => check(host, true, format!("docker at {}", d.display())),
        (None, None) => check(host, false, "no docker or Xvfb"),
    }
}

/// What this machine can host now, read at most every few minutes. Blocking: run it off the async threads.
pub fn checks(
    home: &Path,
    config: &BrowserConfig,
    device: &DeviceConfig,
    ios_config: &IosConfig,
) -> HostChecks {
    static LAST: Mutex<Option<(Instant, Vec<HostCheck>)>> = Mutex::new(None);
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, checks)) = last.as_ref()
        && at.elapsed() < FRESH
    {
        return List::unchecked(checks.clone());
    }
    let checks = vec![
        browser(home, config),
        android(home, device),
        ios(home, ios_config),
        desktop(),
    ];
    *last = Some((Instant::now(), checks.clone()));
    List::unchecked(checks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_is_fleetds_own_emulator_and_only_where_set_up() {
        let home = tempfile::tempdir().unwrap();
        let off = DeviceConfig {
            enabled: Some(false),
            ..DeviceConfig::default()
        };
        assert!(!android(home.path(), &off).ready);
        let unset = android(home.path(), &DeviceConfig::default());
        assert!(!unset.ready, "neither installed nor opted in");
        if device::sdk::supported() {
            assert!(
                unset.detail.as_str().contains("opt this machine in"),
                "{unset:?}"
            );
        }
        let opted_in = DeviceConfig {
            enabled: Some(true),
            ..DeviceConfig::default()
        };
        let asked = android(home.path(), &opted_in);
        assert_eq!(
            asked.ready,
            device::sdk::kvm().is_ok(),
            "installs at the first session where KVM opens: {asked:?}"
        );
        // An install that failed is tried again by the next session, so it stays placeable where KVM opens.
        let state = device::sdk::device_dir(home.path()).join("state.json");
        std::fs::create_dir_all(state.parent().unwrap()).unwrap();
        std::fs::write(
            &state,
            r#"{"installing":false,"failed":"the download broke"}"#,
        )
        .unwrap();
        let failed = android(home.path(), &opted_in);
        assert_eq!(failed.ready, device::sdk::kvm().is_ok(), "{failed:?}");
        if device::sdk::kvm().is_ok() {
            assert!(
                failed.detail.as_str().contains("the download broke"),
                "{failed:?}"
            );
        }
        std::fs::write(&state, r#"{"installing":true,"failed":null}"#).unwrap();
        assert!(!android(home.path(), &opted_in).ready, "installing now");
    }

    #[test]
    fn ios_is_fleetds_own_simulator_and_only_where_set_up() {
        let home = tempfile::tempdir().unwrap();
        let off = IosConfig {
            enabled: Some(false),
            ..IosConfig::default()
        };
        assert!(!ios(home.path(), &off).ready);
        let opted_in = IosConfig {
            enabled: Some(true),
            ..IosConfig::default()
        };
        // Which states a Mac opted in is placed in: node/device/ios's tests, where they can be set up anywhere.
        if !device::ios::supported() {
            let asked = ios(home.path(), &opted_in);
            assert!(!asked.ready);
            assert_eq!(asked.detail.as_str(), "iOS simulators need macOS");
        }
    }

    #[test]
    fn a_browser_turned_off_is_not_ready() {
        let home = std::env::temp_dir();
        let off = BrowserConfig {
            enabled: Some(false),
            ..BrowserConfig::default()
        };
        assert!(!browser(&home, &off).ready);
        let named = BrowserConfig {
            chrome: Some("/nowhere/chrome".into()),
            ..BrowserConfig::default()
        };
        let check = browser(&home, &named);
        assert!(!check.ready);
        assert!(check.detail.as_str().contains("not there"));
    }
}
