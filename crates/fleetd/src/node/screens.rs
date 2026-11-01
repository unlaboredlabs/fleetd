//! Settings › Hub › Machines › Screens (W268): `node_action` `screens` turns a kind of screen on or off, or sets every
//! kind's idle timeout, in this node's node.json, as a person would by hand; the rest of the file stays as it was. The
//! screen services read node.json once, as the node starts, so the node restarts itself to apply a change
//! ([`restart_wanted`]) once no screen is live here, holding its agents' tool calls first, as an update's restart does
//! (node/hold.rs), so it finds them between steps. Until then a kind turned on says it waits for that restart.
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use fleetd_contracts::machine_roles::{HostCheck, HostOff, ScreenSettings, SessionHost};
use fleetd_contracts::prim::Line;
use serde_json::{Map, Value};

use super::config::NodeConfig;

/// How often a change waiting for its restart looks for the screens live here to end.
const LOOK: Duration = Duration::from_secs(10);

/// The screen sections of node.json as the services running now read them.
#[derive(Clone, Debug, Default, PartialEq)]
struct Sections {
    browser: super::browser::BrowserConfig,
    device: super::device::DeviceConfig,
    ios: super::device::ios::IosConfig,
    desktop: super::desktop::DesktopConfig,
}

impl Sections {
    fn of(config: &NodeConfig) -> Self {
        Self {
            browser: config.browser.clone().unwrap_or_default(),
            device: config.device.clone().unwrap_or_default(),
            ios: config.ios.clone().unwrap_or_default(),
            desktop: config.desktop.clone().unwrap_or_default(),
        }
    }

    fn enabled(&self, host: SessionHost) -> Option<bool> {
        match host {
            SessionHost::Browser => self.browser.enabled,
            SessionHost::Android => self.device.enabled,
            SessionHost::Ios => self.ios.enabled,
            SessionHost::Desktop => self.desktop.enabled,
        }
    }
}

static STARTED: Mutex<Option<Sections>> = Mutex::new(None);
static LIVE: OnceLock<Box<dyn Fn() -> usize + Send + Sync>> = OnceLock::new();
/// Holds the agents' tool calls that haven't started, for the hold's lease; how many sessions are still mid-step.
static HOLD: OnceLock<Box<dyn Fn() -> u32 + Send + Sync>> = OnceLock::new();
static WATCHING: AtomicBool = AtomicBool::new(false);
static RESTART: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// Changes asked for, and changes whose answer is on the link: a restart never cuts off the answer that asked for it.
static ASKED: AtomicU64 = AtomicU64::new(0);
static FLUSHED: AtomicU64 = AtomicU64::new(0);
static ANSWERED: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// How long a restart waits for its answer to reach the link, at most.
const ANSWER_WAIT: Duration = Duration::from_secs(60);
/// How often the hold is renewed while agents finish the step they're on, and how long they get, as `fleetd update`.
const DRAIN_LOOK: Duration = Duration::from_secs(2);
const DRAIN_MAX: Duration = Duration::from_secs(600);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// As the node starts its screen services: the settings they run with, how many screens are live here, and the hold
/// of its agents' tool calls ahead of a restart.
pub fn started(
    config: &NodeConfig,
    live: Box<dyn Fn() -> usize + Send + Sync>,
    hold: Box<dyn Fn() -> u32 + Send + Sync>,
) {
    *lock(&STARTED) = Some(Sections::of(config));
    let _ = LIVE.set(live);
    let _ = HOLD.set(hold);
}

/// How often [`when_idle`] looks, and how long it lets agents finish their step.
struct Pace {
    look: Duration,
    drain_look: Duration,
    drain_max: Duration,
}

/// Waits until the node may restart to apply node.json: no screen live, then its agents held between steps with still
/// no screen live (one can open while they finish: a person's, a Navi's, or an agent's start that was mid-step). A
/// screen that opened meanwhile lets the agents go again, and the wait starts over. False once nothing differs any
/// more: changed back, so nothing to apply.
async fn when_idle(
    differs: impl Fn() -> bool,
    live: impl Fn() -> usize,
    hold: impl Fn() -> u32,
    clear: impl Fn(),
    pace: Pace,
) -> bool {
    loop {
        if !differs() {
            return false;
        }
        if live() == 0 {
            if !drain(&hold, pace.drain_look, pace.drain_max).await {
                tracing::warn!(
                    "screen settings: agents still mid-step after 10 min; restarting anyway"
                );
            }
            if !differs() {
                // Changed back meanwhile: nothing to apply, and what the hold stopped goes on now.
                clear();
                return false;
            }
            if live() == 0 {
                return true;
            }
            // A screen opened while the agents finished their step: it isn't cut off, and they carry on.
            clear();
        }
        tokio::time::sleep(pace.look).await;
    }
}

/// Holds the agents' tool calls and waits for those mid-step to finish (`hold` renews the hold and counts them), at
/// most `at_most`; whether they all did. Past it the restart goes anyway: a session cut off mid-step resumes after it.
async fn drain(hold: &impl Fn() -> u32, look: Duration, at_most: Duration) -> bool {
    let started = tokio::time::Instant::now();
    loop {
        if hold() == 0 {
            return true;
        }
        if started.elapsed() >= at_most {
            return false;
        }
        tokio::time::sleep(look).await;
    }
}

/// Resolves once a change wants the node restarted: the node then stops as it does for SIGTERM, and its service
/// manager starts it again.
pub async fn restart_wanted() {
    RESTART.notified().await;
}

/// A kind turned on in node.json since the node started, whose service doesn't run that way yet: it isn't ready until
/// the restart. Nothing changes before [`started`] (tests, the doctor).
pub fn gate(checks: &mut [HostCheck], now: Option<&NodeConfig>) {
    let Some(started) = lock(&STARTED).clone() else {
        return;
    };
    gated(checks, &started, &now.map(Sections::of).unwrap_or_default());
}

fn gated(checks: &mut [HostCheck], started: &Sections, now: &Sections) {
    for check in checks.iter_mut() {
        let was = started.enabled(check.host);
        // A browser or a desktop runs unless turned off: only one that was off waits. Android and iOS run opted in or
        // not, but only an opted-in service installs.
        let runs_already =
            matches!(check.host, SessionHost::Browser | SessionHost::Desktop) && was != Some(false);
        if check.ready && was != now.enabled(check.host) && !runs_already {
            check.ready = false;
            check.off = Some(HostOff::Restarting);
            check.detail = Line::unchecked(
                "turned on: it starts when this machine's node restarts, once the screens live here end".to_owned(),
            );
        }
    }
}

/// The answer to every change asked for so far is on the link (node/link.rs, once it is written).
pub fn answered() {
    FLUSHED.store(ASKED.load(Ordering::SeqCst), Ordering::SeqCst);
    ANSWERED.notify_waiters();
}

/// Waits until the answer to change `asked` is on the link, or `at_most` passed.
async fn wait_answered(asked: u64, at_most: Duration) {
    let _ = tokio::time::timeout(at_most, async {
        loop {
            let next = ANSWERED.notified();
            if FLUSHED.load(Ordering::SeqCst) >= asked {
                return;
            }
            next.await;
        }
    })
    .await;
}

/// Why `host` can't turn on here, in plain words; None where it can.
pub fn unsupported(host: SessionHost) -> Option<&'static str> {
    match host {
        SessionHost::Browser => None,
        SessionHost::Android if !super::device::sdk::supported() => {
            Some("Android screens run on Linux x86_64 with KVM")
        }
        SessionHost::Ios if !super::device::ios::supported() => {
            Some("iOS simulators need a Mac with Xcode")
        }
        SessionHost::Desktop if !cfg!(target_os = "linux") => {
            Some("desktop screens run on Linux (docker or Xvfb)")
        }
        _ => None,
    }
}

/// node.json's section for `host`.
fn section(host: SessionHost) -> &'static str {
    match host {
        SessionHost::Browser => "browser",
        SessionHost::Android => "device",
        SessionHost::Ios => "ios",
        SessionHost::Desktop => "desktop",
    }
}

/// node.json's text with `settings` in it: the kind's `enabled`, every section's `idleMinutes`. Everything else stays.
pub fn edited(text: &str, settings: &ScreenSettings) -> Result<String, String> {
    let mut json: Value =
        serde_json::from_str(text).map_err(|e| format!("node.json doesn't read as JSON: {e}"))?;
    let root = json
        .as_object_mut()
        .ok_or("node.json isn't a JSON object")?;
    let mut set = |name: &str, key: &str, value: Value| -> Result<(), String> {
        let part = root
            .entry(name)
            .or_insert_with(|| Value::Object(Map::new()));
        if part.is_null() {
            *part = Value::Object(Map::new());
        }
        part.as_object_mut()
            .ok_or_else(|| format!("node.json's {name} isn't a JSON object"))?
            .insert(key.to_owned(), value);
        Ok(())
    };
    if let (Some(host), Some(on)) = (settings.host, settings.on) {
        set(section(host), "enabled", Value::Bool(on))?;
    }
    if let Some(minutes) = settings.idle_minutes {
        for host in SessionHost::ALL {
            set(section(host), "idleMinutes", Value::from(minutes.get()))?;
        }
    }
    let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    // What the node reads back must still decode, so a change never leaves a node that can't start.
    serde_json::from_str::<NodeConfig>(&out)
        .map_err(|e| format!("node.json wouldn't decode: {e}"))?;
    Ok(format!("{out}\n"))
}

/// Writes `settings` into node.json, and restarts the node to apply them once no screen is live here. The answer, in
/// plain words.
pub fn apply(home: &Path, settings: &ScreenSettings) -> Result<String, String> {
    if let (Some(host), Some(true)) = (settings.host, settings.on)
        && let Some(why) = unsupported(host)
    {
        return Err(why.to_owned());
    }
    let file = home.join("node.json");
    let text =
        std::fs::read_to_string(&file).map_err(|e| format!("couldn't read node.json: {e}"))?;
    let out = edited(&text, settings)?;
    if out != text {
        // Write beside it, then rename: a node that stops midway keeps the old file whole. 0600, as node.json is.
        let next = home.join("node.json.next");
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&next)
                .map_err(|e| format!("couldn't write node.json: {e}"))?;
            f.write_all(out.as_bytes())
                .map_err(|e| format!("couldn't write node.json: {e}"))?;
        }
        std::fs::rename(&next, &file).map_err(|e| format!("couldn't write node.json: {e}"))?;
    }
    super::hosts::forget();
    let asked = ASKED.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(schedule(home, asked))
}

/// Whether the services run other settings than node.json has now.
fn differs(home: &Path) -> bool {
    let Some(started) = lock(&STARTED).clone() else {
        return false;
    };
    let now = super::config::read_config(home)
        .ok()
        .flatten()
        .map(|c| Sections::of(&c))
        .unwrap_or_default();
    started != now
}

fn live() -> usize {
    LIVE.get().map_or(0, |f| f())
}

/// Starts the wait for the restart that applies node.json, unless one waits already; what the answer says of it. The
/// restart comes only once the answer to change `asked` is on the link.
fn schedule(home: &Path, asked: u64) -> String {
    if !differs(home) {
        return "Saved.".to_owned();
    }
    let exe = crate::update::installed_exe().unwrap_or_default();
    if !crate::update::service::services(&exe)
        .iter()
        .any(|s| !s.hub())
    {
        return "Saved in node.json. This node doesn't run as the service fleetd sets up, so restart it to apply \
                the change."
            .to_owned();
    }
    let n = live();
    if !WATCHING.swap(true, Ordering::SeqCst) {
        let home = home.to_path_buf();
        tokio::spawn(async move {
            wait_answered(asked, ANSWER_WAIT).await;
            let restart = when_idle(
                || differs(&home),
                live,
                || HOLD.get().map_or(0, |f| f()),
                || super::hold::clear(&home),
                Pace {
                    look: LOOK,
                    drain_look: DRAIN_LOOK,
                    drain_max: DRAIN_MAX,
                },
            )
            .await;
            if restart {
                tracing::info!("screen settings changed: restarting the node to apply them");
                RESTART.notify_one();
            }
            WATCHING.store(false, Ordering::SeqCst);
        });
    }
    match n {
        0 => "Saved. The node restarts now to apply it.".to_owned(),
        1 => "Saved. It applies once the screen live here ends, when the node restarts.".to_owned(),
        n => {
            format!("Saved. It applies once the {n} screens live here end, when the node restarts.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::prim::Int;

    const NODE: &str = r#"{
  "hub": "http://devbox:4790",
  "machineId": "devbox",
  "name": "devbox",
  "enrolled": true,
  "browser": { "pool": 2 },
  "somethingNewer": { "kept": true }
}"#;

    fn settings(host: Option<SessionHost>, on: Option<bool>, idle: Option<i64>) -> ScreenSettings {
        ScreenSettings {
            host,
            on,
            idle_minutes: idle.map(Int::unchecked),
        }
    }

    #[test]
    fn a_kind_turned_on_writes_its_own_enabled_and_keeps_the_rest() {
        let out = edited(
            NODE,
            &settings(Some(SessionHost::Android), Some(true), None),
        )
        .unwrap();
        let json: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["device"]["enabled"], Value::Bool(true));
        assert_eq!(json["browser"]["pool"], 2, "{out}");
        assert_eq!(
            json["somethingNewer"]["kept"], true,
            "a key this build doesn't know stays"
        );
        assert!(json["browser"].get("enabled").is_none());

        let off = edited(
            &out,
            &settings(Some(SessionHost::Browser), Some(false), None),
        )
        .unwrap();
        let json: Value = serde_json::from_str(&off).unwrap();
        assert_eq!(json["browser"]["enabled"], Value::Bool(false));
        assert_eq!(json["browser"]["pool"], 2);
        assert_eq!(json["device"]["enabled"], Value::Bool(true));
    }

    #[test]
    fn the_idle_timeout_goes_to_every_kind() {
        let out = edited(NODE, &settings(None, None, Some(45))).unwrap();
        let config: NodeConfig = serde_json::from_str(&out).unwrap();
        assert_eq!(config.browser.unwrap().idle_minutes, Some(45));
        assert_eq!(config.device.unwrap().idle_minutes, Some(45));
        assert_eq!(config.ios.unwrap().idle_minutes, Some(45));
        assert_eq!(config.desktop.unwrap().idle_minutes, Some(45));
    }

    #[test]
    fn a_kind_turned_on_waits_for_the_restart_only_where_its_service_must_start_again() {
        let check = |host| HostCheck {
            host,
            ready: true,
            detail: Line::unchecked("ready".to_owned()),
            off: None,
            on: Some(true),
            idle_minutes: None,
        };
        let started = Sections {
            browser: super::super::browser::BrowserConfig {
                enabled: Some(false),
                ..Default::default()
            },
            ..Sections::default()
        };
        let mut now = started.clone();
        now.browser.enabled = Some(true);
        now.device.enabled = Some(true);
        now.desktop.enabled = Some(true);
        now.ios.idle_minutes = Some(10);
        let mut checks: Vec<_> = SessionHost::ALL.into_iter().map(check).collect();
        gated(&mut checks, &started, &now);
        let waiting: Vec<_> = checks
            .iter()
            .filter(|c| c.off == Some(HostOff::Restarting))
            .map(|c| c.host)
            .collect();
        // The browser was off and Android wasn't opted in; a desktop prepares at its first screen, and an idle timeout
        // alone changes nothing that is ready.
        assert_eq!(waiting, [SessionHost::Browser, SessionHost::Android]);
        assert!(checks.iter().all(|c| c.ready == c.off.is_none()));
    }

    /// The restart waits for the answer that asked for it to be on the link, so the hub hears it before the node goes.
    #[tokio::test]
    async fn a_restart_waits_for_its_answer_to_be_on_the_link() {
        let asked = ASKED.fetch_add(1, Ordering::SeqCst) + 1;
        let waiting = tokio::spawn(wait_answered(asked, Duration::from_secs(30)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished(), "the answer isn't written yet");
        answered();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("released once it is")
            .unwrap();
        // One already written doesn't wait.
        tokio::time::timeout(
            Duration::from_secs(5),
            wait_answered(asked, Duration::from_secs(30)),
        )
        .await
        .unwrap();
    }

    /// The restart holds the agents' tool calls first, and goes once none is mid-step, as an update's does.
    #[tokio::test(start_paused = true)]
    async fn a_restart_waits_for_agents_mid_step() {
        use std::sync::atomic::AtomicU32;
        let asks = AtomicU32::new(0);
        // Two sessions mid-step, then one, then none: the hold is renewed each time it is asked.
        let left = |n: &AtomicU32| match n.fetch_add(1, Ordering::SeqCst) {
            0 => 2,
            1 => 1,
            _ => 0,
        };
        assert!(
            drain(
                &|| left(&asks),
                Duration::from_secs(2),
                Duration::from_secs(600)
            )
            .await
        );
        assert_eq!(asks.load(Ordering::SeqCst), 3);
        // A step that never ends doesn't keep the restart for ever.
        let stuck = AtomicU32::new(0);
        let started = tokio::time::Instant::now();
        assert!(
            !drain(
                &|| {
                    stuck.fetch_add(1, Ordering::SeqCst);
                    1
                },
                Duration::from_secs(2),
                Duration::from_secs(600)
            )
            .await
        );
        assert!(started.elapsed() >= Duration::from_secs(600));
    }

    /// A screen that opens while the agents finish their step isn't cut off: the hold lets go, and the wait starts over.
    #[tokio::test(start_paused = true)]
    async fn a_screen_opened_during_the_hold_puts_the_restart_off() {
        use std::sync::atomic::AtomicUsize;
        let pace = || Pace {
            look: Duration::from_secs(10),
            drain_look: Duration::from_secs(2),
            drain_max: Duration::from_secs(600),
        };
        // Asked for live screens: none, then one (opened during the drain), then it is still live, then none twice.
        let looks = AtomicUsize::new(0);
        let screens = [0, 1, 1, 0, 0];
        let live = || {
            screens
                .get(looks.fetch_add(1, Ordering::SeqCst))
                .copied()
                .unwrap_or(0)
        };
        let cleared = AtomicUsize::new(0);
        let restart = when_idle(
            || true,
            live,
            || 0,
            || {
                cleared.fetch_add(1, Ordering::SeqCst);
            },
            pace(),
        )
        .await;
        assert!(restart);
        assert_eq!(
            cleared.load(Ordering::SeqCst),
            1,
            "the hold let go once, for the screen that opened"
        );
        assert_eq!(looks.load(Ordering::SeqCst), 5);

        // Changed back while held: no restart, and the hold lets go.
        let back = AtomicUsize::new(0);
        let differs = || back.fetch_add(1, Ordering::SeqCst) == 0;
        let cleared = AtomicUsize::new(0);
        assert!(
            !when_idle(
                differs,
                || 0,
                || 0,
                || {
                    cleared.fetch_add(1, Ordering::SeqCst);
                },
                pace()
            )
            .await
        );
        assert_eq!(cleared.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_file_that_would_not_decode_is_left_alone() {
        let broken = r#"{ "hub": "x", "machineId": "devbox", "name": "devbox", "enrolled": true, "ios": [] }"#;
        let err = edited(broken, &settings(Some(SessionHost::Ios), Some(true), None)).unwrap_err();
        assert!(err.contains("ios"), "{err}");
    }

    #[test]
    fn a_kind_this_machine_cant_run_is_refused_before_anything_is_written() {
        for host in SessionHost::ALL {
            let home = tempfile::tempdir().unwrap();
            std::fs::write(home.path().join("node.json"), NODE).unwrap();
            let refused = apply(home.path(), &settings(Some(host), Some(true), None));
            match unsupported(host) {
                Some(why) => {
                    assert_eq!(refused, Err(why.to_owned()));
                    assert_eq!(
                        std::fs::read_to_string(home.path().join("node.json")).unwrap(),
                        NODE
                    );
                }
                None => assert!(refused.is_ok(), "{host:?}: {refused:?}"),
            }
        }
    }
}
