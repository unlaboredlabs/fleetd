//! What this machine can host for sessions (machine roles, W46), sent with each heartbeat's load: a browser (the
//! broker's Chrome, or its install on the first session), an Android emulator (the SDK's emulator, with KVM on Linux),
//! iOS simulators (Xcode on macOS) and a Linux desktop (docker or Xvfb). Each says why in plain words. Read at most
//! every few minutes: `xcrun simctl` takes a second.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fleetd_contracts::machine_roles::{HostCheck, HostChecks, SessionHost};
use fleetd_contracts::prim::{Line, List};

use super::browser::BrowserConfig;
use super::browser::chrome;

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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
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

/// What /dev/kvm allows this user.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kvm {
    Usable,
    Missing,
    Denied,
}

fn kvm() -> Kvm {
    let path = Path::new("/dev/kvm");
    if !path.exists() {
        return Kvm::Missing;
    }
    match nix::unistd::access(
        path,
        nix::unistd::AccessFlags::R_OK | nix::unistd::AccessFlags::W_OK,
    ) {
        Ok(()) => Kvm::Usable,
        Err(_) => Kvm::Denied,
    }
}

/// The Android SDK: ANDROID_HOME, ANDROID_SDK_ROOT, else where Android Studio puts it.
fn android_sdk() -> Option<PathBuf> {
    let named = ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from);
    let usual = home_dir()
        .into_iter()
        .flat_map(|h| [h.join("Android/Sdk"), h.join("Library/Android/sdk")]);
    named.chain(usual).find(|p| p.is_dir())
}

/// The Android check from its facts: the SDK, its emulator, and on Linux, KVM.
pub fn android_from(sdk: Option<&Path>, emulator: bool, linux: bool, kvm: Kvm) -> HostCheck {
    let host = SessionHost::Android;
    let Some(sdk) = sdk else {
        return check(host, false, "no Android SDK (set ANDROID_HOME)");
    };
    let at = sdk.display();
    if !emulator {
        return check(
            host,
            false,
            format!("Android SDK at {at}, but no emulator in it (sdkmanager emulator)"),
        );
    }
    if !linux {
        return check(host, true, format!("Android SDK at {at}"));
    }
    match kvm {
        Kvm::Usable => check(host, true, format!("Android SDK at {at}, with KVM")),
        Kvm::Missing => check(
            host,
            false,
            format!("Android SDK at {at}, but no /dev/kvm: the emulator needs KVM"),
        ),
        Kvm::Denied => check(
            host,
            false,
            format!(
                "Android SDK at {at}, but this user can't use /dev/kvm (add it to the kvm group)"
            ),
        ),
    }
}

fn android() -> HostCheck {
    let sdk = android_sdk();
    let emulator = sdk
        .as_ref()
        .is_some_and(|s| s.join("emulator").join("emulator").is_file());
    let linux = cfg!(target_os = "linux");
    let kvm = if linux { kvm() } else { Kvm::Usable };
    android_from(sdk.as_deref(), emulator, linux, kvm)
}

/// iOS simulators from `xcrun simctl list devices available -j`'s JSON: how many are iOS.
pub fn ios_simulators(json: &str) -> Option<usize> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let devices = v.get("devices")?.as_object()?;
    Some(
        devices
            .iter()
            .filter(|(runtime, _)| runtime.contains("iOS"))
            .map(|(_, list)| list.as_array().map_or(0, Vec::len))
            .sum(),
    )
}

fn ios() -> HostCheck {
    let host = SessionHost::Ios;
    if !cfg!(target_os = "macos") {
        return check(host, false, "iOS simulators need macOS");
    }
    let simctl = Command::new("xcrun")
        .args(["simctl", "list", "devices", "available", "-j"])
        .output();
    let out = match simctl {
        Ok(out) if out.status.success() => out,
        _ => {
            return check(
                host,
                false,
                "no Xcode: install it and run xcode-select --switch",
            );
        }
    };
    match ios_simulators(&String::from_utf8_lossy(&out.stdout)) {
        Some(0) | None => check(
            host,
            false,
            "Xcode, but no iOS simulator (add a runtime in Xcode > Settings > Components)",
        ),
        Some(1) => check(host, true, "Xcode with 1 iOS simulator"),
        Some(n) => check(host, true, format!("Xcode with {n} iOS simulators")),
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
pub fn checks(home: &Path, config: &BrowserConfig) -> HostChecks {
    static LAST: Mutex<Option<(Instant, Vec<HostCheck>)>> = Mutex::new(None);
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, checks)) = last.as_ref()
        && at.elapsed() < FRESH
    {
        return List::unchecked(checks.clone());
    }
    let checks = vec![browser(home, config), android(), ios(), desktop()];
    *last = Some((Instant::now(), checks.clone()));
    List::unchecked(checks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_says_what_is_missing_in_plain_words() {
        let sdk = Path::new("/home/dev/Android/Sdk");
        let none = android_from(None, false, true, Kvm::Usable);
        assert!(!none.ready);
        assert_eq!(none.detail.as_str(), "no Android SDK (set ANDROID_HOME)");
        let no_kvm = android_from(Some(sdk), true, true, Kvm::Missing);
        assert!(!no_kvm.ready);
        assert!(no_kvm.detail.as_str().contains("no /dev/kvm"));
        let denied = android_from(Some(sdk), true, true, Kvm::Denied);
        assert!(denied.detail.as_str().contains("kvm group"));
        let ok = android_from(Some(sdk), true, true, Kvm::Usable);
        assert!(ok.ready);
        assert_eq!(
            ok.detail.as_str(),
            "Android SDK at /home/dev/Android/Sdk, with KVM"
        );
        // macOS runs the emulator on its own hypervisor.
        assert!(android_from(Some(sdk), true, false, Kvm::Missing).ready);
        assert!(!android_from(Some(sdk), false, true, Kvm::Usable).ready);
    }

    #[test]
    fn ios_counts_only_ios_simulators() {
        let json = r#"{"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0":[{"name":"iPhone 16"},{"name":"iPad"}],
            "com.apple.CoreSimulator.SimRuntime.watchOS-11-0":[{"name":"Watch"}]
        }}"#;
        assert_eq!(ios_simulators(json), Some(2));
        assert_eq!(ios_simulators("not json"), None);
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
