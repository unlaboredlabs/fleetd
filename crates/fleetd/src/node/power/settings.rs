//! Whether this machine puts itself to sleep when idle on AC power, read (never changed) from the places that decide
//! it: logind's IdleAction, KDE's and GNOME's power settings, macOS pmset. Sleep on battery only is fine.

/// One setting that makes this machine sleep when idle on AC.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdleSleep {
    /// Where the setting lives, e.g. "KDE power management".
    pub source: &'static str,
    /// "sleeps", "hibernates" or "shuts down".
    pub action: &'static str,
    pub after_sec: Option<u64>,
    /// The exact change that stops it.
    pub fix: String,
}

/// What a sleep-like action does to the machine, or None for one that keeps it reachable (lock, screen off).
fn action_word(action: &str) -> Option<&'static str> {
    match action {
        "suspend" | "hybrid-sleep" | "suspend-then-hibernate" | "sleep" => Some("sleeps"),
        "hibernate" => Some("hibernates"),
        "poweroff" | "halt" | "shutdown" => Some("shuts down"),
        _ => None,
    }
}

/// A systemd time span in seconds ("30min", "1h 30min", "900"); None for "infinity" or what it can't read.
pub fn parse_timespan(text: &str) -> Option<u64> {
    let text = text.trim();
    if text.is_empty() || text == "infinity" {
        return None;
    }
    let mut total = 0f64;
    for part in text.split_whitespace() {
        let split = part
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(part.len());
        let (number, unit) = part.split_at(split);
        let number: f64 = number.parse().ok()?;
        let scale = match unit {
            "" | "s" | "sec" | "second" | "seconds" => 1.0,
            "ms" | "msec" => 0.001,
            "us" | "usec" => 0.000_001,
            "m" | "min" | "minute" | "minutes" => 60.0,
            "h" | "hr" | "hour" | "hours" => 3600.0,
            "d" | "day" | "days" => 86_400.0,
            _ => return None,
        };
        total += number * scale;
    }
    Some(total.round() as u64)
}

/// A `KEY=VALUE` / `[Group]` file as (group, key, value), in order. KDE nests groups as `[AC][SuspendAndShutdown]`.
fn ini(text: &str) -> Vec<(String, String, String)> {
    let mut group = String::new();
    let mut out = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            group = line.to_owned();
        } else if !line.starts_with(['#', ';'])
            && let Some((key, value)) = line.split_once('=')
        {
            out.push((
                group.clone(),
                key.trim().to_owned(),
                value.trim().to_owned(),
            ));
        }
    }
    out
}

fn last<'a>(entries: &'a [(String, String, String)], group: &str, key: &str) -> Option<&'a str> {
    entries
        .iter()
        .rev()
        .find(|(g, k, _)| g == group && k == key)
        .map(|(_, _, v)| v.as_str())
}

const LOGIND_FIX: &str = "sudo mkdir -p /etc/systemd/logind.conf.d && printf '[Login]\\nIdleAction=ignore\\n' | sudo tee /etc/systemd/logind.conf.d/fleetd.conf, then reboot";

/// logind's IdleAction and IdleActionSec (default ignore, 30min). It acts on battery and AC alike.
pub fn logind(action: &str, after_sec: Option<u64>) -> Option<IdleSleep> {
    Some(IdleSleep {
        source: "logind IdleAction",
        action: action_word(action)?,
        after_sec,
        fix: LOGIND_FIX.into(),
    })
}

/// logind.conf, then its drop-ins in order (each later file wins), as logind reads them.
pub fn logind_files(texts: &[String]) -> Option<IdleSleep> {
    let entries: Vec<_> = texts.iter().flat_map(|t| ini(t)).collect();
    let action = last(&entries, "[Login]", "IdleAction").unwrap_or("ignore");
    let after = last(&entries, "[Login]", "IdleActionSec");
    // logind never acts after an infinite idle time.
    if after.is_some_and(|a| a.trim() == "infinity") {
        return None;
    }
    logind(action, after.map_or(Some(1800), parse_timespan))
}

/// Plasma 6 `powerdevilrc`, or Plasma 5 `powermanagementprofilesrc` when Plasma 6 has not migrated it. Plasma 6
/// sleeps after 15 minutes on AC unless told otherwise.
pub fn kde(powerdevilrc: Option<&str>, profilesrc: Option<&str>) -> Option<IdleSleep> {
    let plasma5 = profilesrc
        .map(ini)
        .filter(|e| last(e, "[Migration]", "MigratedProfilesToPlasma6").is_none());
    if powerdevilrc.is_none()
        && let Some(entries) = plasma5
    {
        // Plasma 5 suspends when the group exists; suspendType 1 sleep, 2 hibernate, 4 hybrid, 8 shut down.
        let kind = last(&entries, "[AC][SuspendSession]", "suspendType")?;
        let after = last(&entries, "[AC][SuspendSession]", "idleTime")
            .and_then(|ms| ms.parse::<u64>().ok())
            .map(|ms| ms / 1000);
        return Some(IdleSleep {
            source: "KDE power management",
            action: plasma_action(kind)?,
            after_sec: after,
            fix: "System Settings > Power Management > On AC Power: untick Suspend session".into(),
        });
    }
    let entries = powerdevilrc.map(ini).unwrap_or_default();
    let group = "[AC][SuspendAndShutdown]";
    let action = last(&entries, group, "AutoSuspendAction").unwrap_or("1");
    let after =
        last(&entries, group, "AutoSuspendIdleTimeoutSec").map_or(Some(900), |s| s.parse().ok());
    Some(IdleSleep {
        source: "KDE power management",
        action: plasma_action(action)?,
        after_sec: after,
        fix: "System Settings > Power Management > On AC Power > When inactive: Do nothing".into(),
    })
}

fn plasma_action(value: &str) -> Option<&'static str> {
    match value.trim() {
        "1" | "4" => Some("sleeps"),
        "2" => Some("hibernates"),
        "8" => Some("shuts down"),
        _ => None,
    }
}

/// `gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type` and `…-timeout` output.
pub fn gnome(kind: &str, timeout: Option<&str>) -> Option<IdleSleep> {
    let kind = kind.trim().trim_matches('\'');
    let after = timeout
        .and_then(|t| t.split_whitespace().last())
        .and_then(|t| t.parse::<u64>().ok());
    if after == Some(0) {
        return None;
    }
    Some(IdleSleep {
        source: "GNOME power settings",
        action: action_word(if kind == "suspend" { "sleep" } else { kind })?,
        after_sec: after,
        fix:
            "gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'"
                .into(),
    })
}

/// `pmset -g custom`: the `sleep` minutes under "AC Power:" (0 never).
pub fn pmset(text: &str) -> Option<IdleSleep> {
    let mut on_ac = false;
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) {
            on_ac = line.trim_end().eq_ignore_ascii_case("AC Power:");
            continue;
        }
        let mut words = line.split_whitespace();
        if on_ac && words.next() == Some("sleep") {
            let minutes: u64 = words.next()?.parse().ok()?;
            return (minutes > 0).then(|| IdleSleep {
                source: "macOS energy settings",
                action: "sleeps",
                after_sec: Some(minutes * 60),
                fix: "sudo pmset -c sleep 0".into(),
            });
        }
    }
    None
}

/// Every setting on this machine that makes it sleep when idle on AC.
pub async fn read() -> Vec<IdleSleep> {
    imp::read().await
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use crate::node::util::{exec, home_dir};
    use std::time::Duration;

    /// The effective setting from logind itself; its files when the system bus is not there.
    async fn logind_now() -> Option<IdleSleep> {
        async fn property<T>(bus: &zbus::Connection, name: &str) -> Option<T>
        where
            T: TryFrom<zbus::zvariant::OwnedValue>,
        {
            let reply = bus
                .call_method(
                    Some("org.freedesktop.login1"),
                    "/org/freedesktop/login1",
                    Some("org.freedesktop.DBus.Properties"),
                    "Get",
                    &("org.freedesktop.login1.Manager", name),
                )
                .await
                .ok()?;
            let value: zbus::zvariant::OwnedValue = reply.body().deserialize().ok()?;
            T::try_from(value).ok()
        }
        if let Ok(bus) = zbus::Connection::system().await
            && let Some(action) = property::<String>(&bus, "IdleAction").await
        {
            let usec = property::<u64>(&bus, "IdleActionUSec").await;
            // IdleActionSec=infinity: logind never acts.
            if usec == Some(u64::MAX) {
                return None;
            }
            return logind(&action, usec.map(|u| u / 1_000_000));
        }
        let mut texts = Vec::new();
        texts.extend(std::fs::read_to_string("/etc/systemd/logind.conf").ok());
        for dir in [
            "/usr/lib/systemd/logind.conf.d",
            "/run/systemd/logind.conf.d",
            "/etc/systemd/logind.conf.d",
        ] {
            let mut files: Vec<_> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "conf"))
                .collect();
            files.sort();
            texts.extend(files.iter().filter_map(|p| std::fs::read_to_string(p).ok()));
        }
        logind_files(&texts)
    }

    /// A running process whose name starts with `name` (comm is cut to 15 bytes).
    fn running(name: &str) -> bool {
        std::fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| {
                std::fs::read_to_string(e.path().join("comm"))
                    .is_ok_and(|comm| comm.trim().starts_with(name))
            })
    }

    async fn gsettings(key: &str) -> Option<String> {
        let out = exec(
            &[
                "gsettings".into(),
                "get".into(),
                "org.gnome.settings-daemon.plugins.power".into(),
                key.into(),
            ],
            Duration::from_secs(5),
        )
        .await;
        out.error.is_none().then_some(out.stdout)
    }

    pub async fn read() -> Vec<IdleSleep> {
        let mut found: Vec<IdleSleep> = logind_now().await.into_iter().collect();
        // Only the desktop that is running decides; another's settings may be installed and unused.
        if running("org_kde_powerde") {
            let config = home_dir().join(".config");
            let rc = std::fs::read_to_string(config.join("powerdevilrc")).ok();
            let profiles = std::fs::read_to_string(config.join("powermanagementprofilesrc")).ok();
            found.extend(kde(rc.as_deref(), profiles.as_deref()));
        }
        if running("gsd-power")
            && let Some(kind) = gsettings("sleep-inactive-ac-type").await
        {
            let timeout = gsettings("sleep-inactive-ac-timeout").await;
            found.extend(gnome(&kind, timeout.as_deref()));
        }
        found
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::node::util::exec;
    use std::time::Duration;

    pub async fn read() -> Vec<IdleSleep> {
        let out = exec(
            &["pmset".into(), "-g".into(), "custom".into()],
            Duration::from_secs(5),
        )
        .await;
        out.error
            .is_none()
            .then(|| pmset(&out.stdout))
            .flatten()
            .into_iter()
            .collect()
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod imp {
    pub async fn read() -> Vec<super::IdleSleep> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_time_spans() {
        assert_eq!(parse_timespan("30min"), Some(1800));
        assert_eq!(parse_timespan("1h 30min"), Some(5400));
        assert_eq!(parse_timespan("900"), Some(900));
        assert_eq!(parse_timespan("infinity"), None);
        assert_eq!(parse_timespan("soon"), None);
    }

    #[test]
    fn logind_files_last_assignment_wins() {
        let main = "[Login]\n#IdleAction=ignore\nIdleAction=suspend\n".to_owned();
        assert_eq!(
            logind_files(std::slice::from_ref(&main)).map(|s| (s.action, s.after_sec)),
            Some(("sleeps", Some(1800)))
        );
        let dropin = "[Login]\nIdleAction=ignore\n".to_owned();
        assert_eq!(logind_files(&[main, dropin]), None);
        assert_eq!(logind_files(&["[Login]\n".to_owned()]), None);
        let lock = "[Login]\nIdleAction=lock\nIdleActionSec=10min\n".to_owned();
        assert_eq!(logind_files(&[lock]), None);
        let never = "[Login]\nIdleAction=suspend\nIdleActionSec=infinity\n".to_owned();
        assert_eq!(logind_files(&[never]), None);
    }

    #[test]
    fn plasma6_sleeps_on_ac_by_default() {
        // No powerdevilrc at all, or one without the key: Plasma 6's default, sleep after 15 minutes.
        let default = kde(None, None).unwrap();
        assert_eq!((default.action, default.after_sec), ("sleeps", Some(900)));
        assert!(default.fix.contains("When inactive: Do nothing"));
        let screen_only = "[AC][Display]\nTurnOffDisplayIdleTimeoutSec=600\n";
        assert_eq!(kde(Some(screen_only), None), Some(default));
        let off = "[AC][Display]\nTurnOffDisplayIdleTimeoutSec=600\n\n[AC][SuspendAndShutdown]\nAutoSuspendAction=0\n";
        assert_eq!(kde(Some(off), None), None);
        let hibernate =
            "[AC][SuspendAndShutdown]\nAutoSuspendAction=2\nAutoSuspendIdleTimeoutSec=1200\n";
        let h = kde(Some(hibernate), None).unwrap();
        assert_eq!((h.action, h.after_sec), ("hibernates", Some(1200)));
        // Battery-only sleep is fine.
        let battery = "[Battery][SuspendAndShutdown]\nAutoSuspendAction=1\n[AC][SuspendAndShutdown]\nAutoSuspendAction=0\n";
        assert_eq!(kde(Some(battery), None), None);
    }

    #[test]
    fn plasma5_profiles_unless_migrated() {
        let p5 = "[AC][SuspendSession]\nidleTime=600000\nsuspendType=1\n";
        let s = kde(None, Some(p5)).unwrap();
        assert_eq!((s.action, s.after_sec), ("sleeps", Some(600)));
        assert!(s.fix.contains("Suspend session"));
        assert_eq!(kde(None, Some("[AC][DimDisplay]\nidleTime=300000\n")), None);
        assert_eq!(
            kde(None, Some("[Battery][SuspendSession]\nsuspendType=1\n")),
            None
        );
        // Plasma 6 migrated the old file and reads powerdevilrc (absent here: its default).
        let migrated = "[Migration]\nMigratedProfilesToPlasma6=powerdevilrc\n";
        assert_eq!(kde(None, Some(migrated)).unwrap().after_sec, Some(900));
    }

    #[test]
    fn gnome_ac_sleep() {
        let s = gnome("'suspend'\n", Some("900\n")).unwrap();
        assert_eq!((s.action, s.after_sec), ("sleeps", Some(900)));
        assert!(s.fix.contains("'nothing'"));
        assert_eq!(gnome("'nothing'\n", Some("900\n")), None);
        assert_eq!(gnome("'suspend'\n", Some("0\n")), None);
        assert_eq!(
            gnome("'hibernate'", Some("int32 1800")).unwrap().after_sec,
            Some(1800)
        );
    }

    #[test]
    fn pmset_reads_only_ac() {
        let laptop = "Battery Power:\n Sleep On Power Button 1\n sleep                1\n displaysleep         2\nAC Power:\n Sleep On Power Button 1\n sleep                0 (sleep prevented by powerd)\n displaysleep         10\n";
        assert_eq!(pmset(laptop), None);
        let desktop = "AC Power:\n standby              1\n sleep                10\n displaysleep         10\n";
        let s = pmset(desktop).unwrap();
        assert_eq!((s.action, s.after_sec), ("sleeps", Some(600)));
        assert_eq!(s.fix, "sudo pmset -c sleep 0");
    }
}
