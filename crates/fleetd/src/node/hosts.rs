//! What this machine can host for sessions (machine roles, W46), sent with each heartbeat's load: a browser (the
//! broker's Chrome, or its install on the first session), an Android emulator (fleetd's own pinned one, node/device,
//! with KVM), iOS simulators (fleetd's own golden and its clones, node/device/ios, with Xcode on macOS) and a Linux
//! desktop (docker or Xvfb). Each says why in plain words. Read at most every few minutes: `xcrun simctl` takes a
//! second.
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fleetd_contracts::machine_roles::{HostCheck, HostChecks, HostOff, SessionHost};
use fleetd_contracts::node_link::{AndroidHealth, AndroidState, DesktopState, IosState};
use fleetd_contracts::prim::{Int, Line, List};

use super::browser::BrowserConfig;
use super::browser::chrome;
use super::config::NodeConfig;
use super::desktop::{self, DesktopConfig};
use super::device::ios::IosConfig;
use super::device::{self, DeviceConfig};

const FRESH: Duration = Duration::from_secs(300);
/// A screen's idle timeout where node.json sets none.
const IDLE_MINUTES: u64 = 30;

fn check(host: SessionHost, off: Option<HostOff>, detail: impl Into<String>) -> HostCheck {
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
        ready: off.is_none(),
        detail: Line::unchecked(detail),
        off,
        on: None,
        idle_minutes: None,
        fix: None,
    }
}

/// The check with the command that clears what stands in the way, where it can't run and one does.
fn fixed(mut check: HostCheck, fix: Option<&str>) -> HostCheck {
    if !check.ready {
        check.fix = fix
            .filter(|f| !f.is_empty() && f.len() <= 300)
            .map(|f| Line::unchecked(f.to_owned()));
    }
    check
}

/// The check with its switch in Settings (`on`) and its idle timeout from node.json.
fn with(mut check: HostCheck, on: bool, idle_minutes: Option<u64>) -> HostCheck {
    check.on = Some(on);
    check.idle_minutes = Int::new(idle_minutes.unwrap_or(IDLE_MINUTES).clamp(1, 1440) as i64).ok();
    check
}

pub fn browser(home: &Path, config: &BrowserConfig) -> HostCheck {
    with(
        browser_check(home, config),
        config.enabled(),
        config.idle_minutes,
    )
}

fn browser_check(home: &Path, config: &BrowserConfig) -> HostCheck {
    let host = SessionHost::Browser;
    if !config.enabled() {
        return check(
            host,
            Some(HostOff::Off),
            "browser screens are off in node.json",
        );
    }
    if let Some(chrome) = &config.chrome {
        return match Path::new(chrome).is_file() {
            true => check(host, None, format!("Chrome at {chrome} (node.json)")),
            false => check(
                host,
                Some(HostOff::Missing),
                format!("node.json names Chrome at {chrome}, which is not there"),
            ),
        };
    }
    match chrome::find_chrome(&chrome::install_dir(home)) {
        Some(found) => check(host, None, format!("Chrome at {}", found.display())),
        None => check(
            host,
            None,
            "Chrome not installed yet: the node installs it with the first screen",
        ),
    }
}

/// fleetd's own Android emulator (node/device): ready where it is installed, or the machine is opted in so the first
/// session installs it (again, after an install that failed), and /dev/kvm opens; else what stands in the way, as the
/// doctor says it.
pub fn android(home: &Path, config: &DeviceConfig) -> HostCheck {
    let health = device::health(home, config);
    let on = health.is_some();
    with(android_check(config, health), on, config.idle_minutes)
}

fn android_check(config: &DeviceConfig, health: Option<AndroidHealth>) -> HostCheck {
    let host = SessionHost::Android;
    if !device::sdk::supported() {
        return check(
            host,
            Some(HostOff::Unsupported),
            "Android screens run on Linux x86_64 with KVM",
        );
    }
    if !config.enabled() {
        return check(
            host,
            Some(HostOff::Off),
            "Android screens are off in node.json",
        );
    }
    match health {
        Some(health) => {
            let off = match health.state {
                AndroidState::Ready | AndroidState::Wanted => None,
                AndroidState::Installing => Some(HostOff::Installing),
                // With KVM opening, only a failed install: the next session tries it again, so the hub must send it.
                _ if device::sdk::kvm().is_ok() => None,
                _ => Some(HostOff::Missing),
            };
            fixed(
                check(host, off, health.message.as_str()),
                health.fix.as_ref().map(|f| f.as_str()),
            )
        }
        None => check(
            host,
            Some(HostOff::Off),
            "not set up: turn Android on in Settings › Hub › Machines › Screens (or \"device\": {\"enabled\": true} in node.json)",
        ),
    }
}

/// fleetd's own iOS simulators (node/device/ios): ready once the node's golden simulator is made, else what stands in
/// the way, as the doctor says it.
pub fn ios(home: &Path, config: &IosConfig) -> HostCheck {
    let host = SessionHost::Ios;
    if !device::ios::supported() {
        return with(
            check(
                host,
                Some(HostOff::Unsupported),
                "iOS simulators need macOS",
            ),
            false,
            config.idle_minutes,
        );
    }
    if !config.enabled() {
        return with(
            check(host, Some(HostOff::Off), "iOS screens are off in node.json"),
            false,
            config.idle_minutes,
        );
    }
    // Ready where the golden is made, and also on a Mac opted in while it is made or after it failed, so the hub sends
    // the session there: the node says it is still making it, and the next session_start tries a failed one again.
    let (checked, on) = match device::ios::host(home, config) {
        Some((health, placeable)) => {
            let off = match (placeable, health.state) {
                (true, _) => None,
                (false, IosState::Wanted) => Some(HostOff::Off),
                (false, IosState::Preparing) => Some(HostOff::Installing),
                (false, _) => Some(HostOff::Missing),
            };
            (
                fixed(
                    check(host, off, health.message.as_str()),
                    health.fix.as_ref().map(|f| f.as_str()),
                ),
                config.opted_in() || health.state == IosState::Ready,
            )
        }
        None => (
            fixed(
                check(host, Some(HostOff::Missing), no_xcode(config)),
                Some(XCODE_FIX),
            ),
            config.opted_in(),
        ),
    };
    with(checked, on, config.idle_minutes)
}

/// Installs the newest Xcode from a terminal on the Mac, an SSH one too: xcodes asks for the Apple ID it downloads
/// with. The App Store's page (`XCODE_PAGE`) is the way at the Mac itself.
const XCODE_FIX: &str = "brew install xcodesorg/made/xcodes && xcodes install --latest --select";
const XCODE_PAGE: &str = "https://apps.apple.com/app/xcode/id497799835";

/// What a Mac without Xcode lacks, and the two ways to install it: the command (in any terminal on the Mac, over SSH
/// too), or the App Store at the Mac. Once iOS is on, only Xcode; else Xcode and then the switch.
fn no_xcode(config: &IosConfig) -> String {
    let ways = format!(
        "install it with the command (on this Mac, over SSH too; it asks for your Apple ID), or at the Mac from \
         {XCODE_PAGE}"
    );
    match config.opted_in() {
        true => format!("no Xcode: {ways}. This line then says what else it needs"),
        false => format!(
            "no Xcode: {ways}, then turn iOS on for this Mac in Settings › Hub › Machines › Screens"
        ),
    }
}

/// The desktop sessions' own word (node/desktop): what preparing found, else what is on the PATH.
fn desktop(home: &Path, config: &DesktopConfig) -> HostCheck {
    let host = SessionHost::Desktop;
    let checked = if !cfg!(target_os = "linux") {
        check(
            host,
            Some(HostOff::Unsupported),
            "desktop screens run on Linux (docker or Xvfb)",
        )
    } else if !config.enabled() {
        check(
            host,
            Some(HostOff::Off),
            "desktop screens are off in node.json",
        )
    } else {
        match desktop::health(home, config) {
            Some(health) => fixed(
                check(
                    host,
                    match health.state {
                        DesktopState::Unavailable => Some(HostOff::Missing),
                        _ => None,
                    },
                    health.message.as_str(),
                ),
                health.fix.as_ref().map(|f| f.as_str()),
            ),
            None => fixed(
                check(host, Some(HostOff::Missing), "no docker, podman or Xvfb"),
                Some(&desktop::install_fix()),
            ),
        }
    };
    with(checked, config.enabled(), config.idle_minutes)
}

/// What this machine can host now, read at most every few minutes, from node.json's screen sections (`config`). A
/// kind turned on since the node started waits for its restart (node/screens). Blocking: run it off the async threads.
pub fn checks(home: &Path, config: Option<&NodeConfig>) -> HostChecks {
    let mut checks = cached(home, config);
    super::screens::gate(&mut checks, config);
    List::unchecked(checks)
}

static LAST: Mutex<Option<(Instant, Vec<HostCheck>)>> = Mutex::new(None);

/// Drops what was read, so the next heartbeat reads the machine again: node.json just changed.
pub fn forget() {
    *LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

fn cached(home: &Path, config: Option<&NodeConfig>) -> Vec<HostCheck> {
    let mut last = LAST
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((at, checks)) = last.as_ref()
        && at.elapsed() < FRESH
    {
        return checks.clone();
    }
    let checks = vec![
        browser(
            home,
            &config.and_then(|c| c.browser.clone()).unwrap_or_default(),
        ),
        android(
            home,
            &config.and_then(|c| c.device.clone()).unwrap_or_default(),
        ),
        ios(
            home,
            &config.and_then(|c| c.ios.clone()).unwrap_or_default(),
        ),
        desktop(
            home,
            &config.and_then(|c| c.desktop.clone()).unwrap_or_default(),
        ),
    ];
    *last = Some((Instant::now(), checks.clone()));
    checks
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
                unset.detail.as_str().contains("turn Android on"),
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
    fn a_mac_without_xcode_says_only_what_is_missing_once_turned_on() {
        let on = IosConfig {
            enabled: Some(true),
            ..IosConfig::default()
        };
        assert!(!no_xcode(&on).contains("turn iOS on"), "{}", no_xcode(&on));
        assert!(!no_xcode(&on).contains("node.json"));
        assert!(no_xcode(&IosConfig::default()).contains("turn iOS on"));
        // Two ways that work wherever the person is: a command over SSH, or the App Store at the Mac.
        for config in [on, IosConfig::default()] {
            let said = no_xcode(&config);
            assert!(said.len() <= 300, "{said}");
            assert!(
                said.contains("over SSH") && said.contains(XCODE_PAGE),
                "{said}"
            );
        }
        assert!(
            !XCODE_FIX.contains("open "),
            "works without the Mac's screen"
        );
    }

    #[test]
    fn what_stands_in_the_way_comes_with_its_command_and_only_then() {
        let missing = check(SessionHost::Desktop, Some(HostOff::Missing), "no Xvfb");
        let fix = fixed(missing, Some("sudo apt-get install -y xvfb")).fix;
        assert_eq!(
            fix.as_ref().map(|f| f.as_str()),
            Some("sudo apt-get install -y xvfb")
        );
        let ready = check(SessionHost::Desktop, None, "Xvfb at /usr/bin/Xvfb");
        assert_eq!(fixed(ready, Some("sudo apt-get install -y xvfb")).fix, None);
        let none = check(SessionHost::Android, Some(HostOff::Missing), "no /dev/kvm");
        assert_eq!(fixed(none, None).fix, None);
        // A desktop that can't run installs Xvfb with this machine's package manager.
        assert!(
            desktop::install_fix().starts_with("sudo ")
                && desktop::install_fix().to_lowercase().contains("xvfb")
        );
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
