//! What this machine can host for sessions (machine roles, W46), sent with each heartbeat's load: a browser (the
//! broker's Chrome, or its install on the first session), an Android emulator (fleetd's own pinned one, node/device,
//! with KVM), a Linux desktop (docker or Xvfb), and the agents' Mac's own screen (its agents session on the screen,
//! unlocked, with fleetd's grants). Each says why in plain words. Read at most every few minutes. iOS simulators are no
//! screen any more (D298): the agents' Mac lends them with `mac sim`, and the doctor's `ios` check says how they are.
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fleetd_contracts::machine_roles::{HostCheck, HostChecks, HostOff, SessionHost};
use fleetd_contracts::node_link::{AndroidHealth, AndroidState, DesktopState};
use fleetd_contracts::prim::{Int, Line, List};

use super::browser::BrowserConfig;
use super::browser::chrome;
use super::config::NodeConfig;
use super::desktop::mac::{self, MacConfig};
use super::desktop::{self, DesktopConfig};
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

/// The agents' Mac's own screen (node/desktop/mac): ready while the node's user is on the Mac's screen,
/// unlocked, with Screen Recording and Accessibility allowed; else exactly what stands in the way and how to clear it.
/// Each start checks it again.
pub fn mac_screen(config: &MacConfig) -> HostCheck {
    let host = SessionHost::Mac;
    let checked = if !mac::supported() {
        check(
            host,
            Some(HostOff::Unsupported),
            "the Mac screen is a Mac's own: its agents session's screen",
        )
    } else if !config.enabled() {
        check(
            host,
            Some(HostOff::Off),
            "off: on the agents' Mac, turn the Mac screen on in Settings › Hub › Machines › Screens",
        )
    } else {
        match mac::blocked() {
            None => check(
                host,
                None,
                "the node's session is on the Mac's screen, unlocked, with Screen Recording and Accessibility",
            ),
            Some(blocked) => fixed(
                check(host, Some(HostOff::Missing), blocked.message),
                blocked.fix.as_deref(),
            ),
        }
    };
    with(
        checked,
        config.enabled(),
        Some(config.idle_minutes.unwrap_or(mac::IDLE_MINUTES)),
    )
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
        desktop(
            home,
            &config.and_then(|c| c.desktop.clone()).unwrap_or_default(),
        ),
        mac_screen(&config.and_then(|c| c.mac.clone()).unwrap_or_default()),
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
