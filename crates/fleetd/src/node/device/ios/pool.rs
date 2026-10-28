//! The simulators sessions get. The node makes one golden simulator in its set (the newest iOS runtime, a plain
//! iPhone), boots it once and lets it settle (a fresh simulator's first boot keeps 40-300% of a core busy for minutes),
//! has agent-device build its XCTest runner against it, and shuts it down: `simctl clone` copies only a simulator that
//! is shut down. Each session gets a clone of it, booted ahead of time in a warm pool, and the clone is deleted with
//! everything done in it when the session ends; the pool clones and boots the next behind it.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::simctl::Simctl;
use super::wrapper;
use crate::node::device::agent_device;

/// A clone of a settled simulator boots in seconds on a Mac; on GitHub's 3-vCPU macOS VM, 80-100 s when idle, more with
/// another simulator running. This allows a loaded machine.
pub const BOOT_TIMEOUT: Duration = Duration::from_secs(300);
/// The golden's first boot: it migrates data and builds caches.
const FIRST_BOOT: Duration = Duration::from_secs(600);
/// agent-device's runner builds with xcodebuild: minutes on a laptop.
const RUNNER_BUILD: Duration = Duration::from_secs(1500);
/// How long agent-device's daemon may take to stop its runner and exit.
const DAEMON_EXIT: Duration = Duration::from_secs(60);
/// How long the golden may take to settle before it is shut down anyway.
const SETTLE_MAX: Duration = Duration::from_secs(600);
/// A simulator is settled once its processes together use less than this share of one core...
const SETTLED_CPU: f64 = 25.0;
/// ...this many samples running, taken this far apart.
const SETTLED_SAMPLES: usize = 3;
const SAMPLE_EVERY: Duration = Duration::from_secs(5);
/// After a boot fails, the pool waits this long before the next, doubling with each failure in a row up to
/// [`BACKOFF_MAX`]; a boot that works starts it over. A Mac that can't boot doesn't clone and boot over and over beside
/// a live session.
const BACKOFF_FIRST: Duration = Duration::from_secs(60);
const BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);
/// What a boot is guessed to take before one has been timed.
const BOOT_GUESS: Duration = Duration::from_secs(30);
/// The shortest wait a session_start is told.
const WAIT_MIN: Duration = Duration::from_secs(5);

pub const GOLDEN_NAME: &str = "fleetd-golden";

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The golden simulator, as `<node home>/device/ios/golden.json` keeps it once made.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Golden {
    pub udid: String,
    pub runtime: String,
    /// "iOS 27.0".
    pub runtime_name: String,
    pub device_type: String,
    /// "iPhone 17".
    pub device_type_name: String,
    /// The screen's scale: its pixels per point.
    pub scale: f64,
    /// The agent-device release whose runner was built for it.
    pub agent_device: String,
    /// That runner's `.xctestrun`, which every session's agent-device starts as it is (wrapper.rs). A golden made
    /// before has none and is made again.
    pub xctestrun: PathBuf,
}

pub fn golden_path(home: &Path) -> PathBuf {
    super::ios_dir(home).join("golden.json")
}

/// The golden, when it was made for the pinned agent-device and the wrapper and its runner are there: without the
/// runner every session's agent-device fails to start, so the golden is made again.
pub fn find(home: &Path) -> Option<Golden> {
    let golden: Golden = serde_json::from_slice(&std::fs::read(golden_path(home)).ok()?).ok()?;
    (golden.agent_device == agent_device::VERSION
        && agent_device::find(home).is_some()
        && wrapper::find(home, &golden.xctestrun).is_some()
        && golden.xctestrun.is_file())
    .then_some(golden)
}

/// Makes the golden simulator, from nothing: whatever the set held goes first. `device_type` names the device type
/// to use (node.json's `ios.deviceType`); absent, a plain iPhone.
pub async fn prepare(home: &Path, device_type: Option<&str>) -> Result<Golden, String> {
    if agent_device::find(home).is_none() {
        agent_device::install(home).await?;
    }
    let wrapper = wrapper::install(home, None)?;
    let simctl = Simctl::new(super::set_dir(home));
    let runtimes = simctl.runtimes().await?;
    let (runtime, device_type) = super::simctl::pick(&runtimes, device_type)?;
    let _ = std::fs::remove_file(golden_path(home));
    clear(&simctl, None).await;
    let udid = simctl
        .create(GOLDEN_NAME, &device_type.identifier, &runtime.identifier)
        .await?;
    let made = async {
        simctl.boot(&udid, FIRST_BOOT).await?;
        settle(&udid).await;
        runner(home, &wrapper, &udid).await?;
        simctl.shutdown(&udid).await?;
        let xctestrun = wrapper::built_xctestrun(home)?;
        wrapper::install(home, Some(&xctestrun))?;
        Ok(xctestrun)
    }
    .await;
    let xctestrun = match made {
        Ok(xctestrun) => xctestrun,
        Err(why) => {
            let _ = simctl.shutdown(&udid).await;
            let _ = simctl.delete(&udid).await;
            return Err(why);
        }
    };
    let golden = Golden {
        udid,
        runtime: runtime.identifier.clone(),
        runtime_name: runtime.name.clone(),
        device_type: device_type.identifier.clone(),
        device_type_name: device_type.name.clone(),
        scale: super::simctl::scale(&device_type).await,
        agent_device: agent_device::VERSION.to_owned(),
        xctestrun,
    };
    let bytes = serde_json::to_vec_pretty(&golden).map_err(|e| e.to_string())?;
    crate::node::secrets::write_atomic(&golden_path(home), &bytes)
        .map_err(|e| format!("cannot write {}: {e}", golden_path(home).display()))?;
    Ok(golden)
}

/// Waits until the booted golden's processes go quiet, or [`SETTLE_MAX`] passes.
async fn settle(udid: &str) {
    let started = Instant::now();
    let mut quiet = 0;
    while quiet < SETTLED_SAMPLES && started.elapsed() < SETTLE_MAX {
        tokio::time::sleep(SAMPLE_EVERY).await;
        let out = tokio::process::Command::new("ps")
            .args(["-A", "-o", "pid=,ppid=,%cpu=,command="])
            .stdin(Stdio::null())
            .output()
            .await;
        let cpu = out
            .ok()
            .map(|o| device_cpu(&String::from_utf8_lossy(&o.stdout), udid));
        quiet = match cpu {
            Some(cpu) if cpu < SETTLED_CPU => quiet + 1,
            _ => 0,
        };
    }
    tracing::info!(
        udid,
        secs = started.elapsed().as_secs(),
        "the golden iOS simulator settled"
    );
}

/// The CPU a simulator's processes use together, as `ps -A -o pid=,ppid=,%cpu=,command=` lists them: its
/// `launchd_sim` (whose arguments hold the simulator's data path, and so its udid) and everything under it.
pub fn device_cpu(ps: &str, udid: &str) -> f64 {
    let procs: Vec<(u32, u32, f64, &str)> = ps
        .lines()
        .filter_map(|line| {
            fn field(rest: &str) -> Option<(&str, &str)> {
                rest.trim_start().split_once(char::is_whitespace)
            }
            let (pid, rest) = field(line)?;
            let (ppid, rest) = field(rest)?;
            let (cpu, command) = field(rest)?;
            Some((
                pid.parse().ok()?,
                ppid.parse().ok()?,
                cpu.parse().ok()?,
                command.trim(),
            ))
        })
        .collect();
    let mut ours: Vec<u32> = procs
        .iter()
        .filter(|(_, _, _, command)| command.contains("launchd_sim") && command.contains(udid))
        .map(|(pid, ..)| *pid)
        .collect();
    let mut i = 0;
    while i < ours.len() {
        let parent = ours[i];
        ours.extend(
            procs
                .iter()
                .filter(|(pid, ppid, ..)| *ppid == parent && !ours.contains(pid))
                .map(|(pid, ..)| *pid)
                .collect::<Vec<_>>(),
        );
        i += 1;
    }
    procs
        .iter()
        .filter(|(pid, ..)| ours.contains(pid))
        .map(|(_, _, cpu, _)| cpu)
        .sum()
}

/// Has agent-device build its XCTest runner for the golden (into the node's runner directory, which every session's
/// wrapper names) and start it once, then stops the daemon that did.
async fn runner(home: &Path, wrapper: &Path, udid: &str) -> Result<(), String> {
    let dir = super::ios_dir(home).join("prepare");
    let state = dir.join("state");
    crate::node::config::mkdir_private(&dir).map_err(|e| e.to_string())?;
    let timeout_ms = RUNNER_BUILD.as_millis().to_string();
    let run = tokio::process::Command::new(wrapper)
        .args(["prepare", "ios-runner", "--platform", "ios", "--udid", udid])
        .args(["--timeout", &timeout_ms])
        .env("AGENT_DEVICE_HOME", &dir)
        .env("AGENT_DEVICE_STATE_DIR", &state)
        .env("AGENT_DEVICE_NO_UPDATE_NOTIFIER", "1")
        .env_remove("FLEETD_DEVICE_CONTROL")
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(RUNNER_BUILD + Duration::from_secs(60), run).await;
    stop_daemon(&state).await;
    let out = out
        .map_err(|_| "agent-device's runner did not build in 25 minutes".to_owned())?
        .map_err(|e| format!("cannot run agent-device: {e}"))?;
    if !out.status.success() {
        let said = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        return Err(format!(
            "agent-device's runner did not build: {}",
            said.trim().chars().take(300).collect::<String>()
        ));
    }
    Ok(())
}

/// Ends the agent-device daemon whose state directory is `state`, if one runs, and waits for it to exit: on its way
/// out it stops the XCTest runner it started (the wrapper keeps it from leaving the runner running for a next daemon),
/// whose xcodebuild would otherwise boot the golden again once it is shut down, and `simctl clone` refuses a booted one.
pub async fn stop_daemon(state: &Path) {
    let daemon = std::fs::read_to_string(state.join("daemon.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let Some(pid) = daemon
        .filter(|d| d["stateDir"].as_str() == Some(&*state.to_string_lossy()))
        .and_then(|d| d["pid"].as_i64())
    else {
        return;
    };
    let pid = nix::unistd::Pid::from_raw(pid as i32);
    if nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGTERM).is_err() {
        return;
    }
    let started = Instant::now();
    while nix::sys::signal::kill(pid, None).is_ok() {
        if started.elapsed() > DAEMON_EXIT {
            tracing::warn!(%pid, "agent-device's daemon did not exit in time; the golden is shut down anyway");
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Deletes every simulator in the node's set but `keep`: the clones a node that stopped left behind (each holds a
/// booted simulator's memory), or everything before a new golden. Returns how many.
pub async fn clear(simctl: &Simctl, keep: Option<&str>) -> usize {
    let Ok(devices) = simctl.devices().await else {
        return 0;
    };
    let mut cleared = 0;
    for device in devices.iter().filter(|d| Some(d.udid.as_str()) != keep) {
        if device.state != "Shutdown" {
            let _ = simctl.shutdown(&device.udid).await;
        }
        if simctl.delete(&device.udid).await.is_ok() {
            cleared += 1;
        }
    }
    cleared
}

/// How the pool's boots have gone: whether one is under way, how long the last one that worked took, and the failures in
/// a row with the backoff they set.
#[derive(Debug)]
pub struct Refill {
    booting_since: Option<Instant>,
    last_boot: Duration,
    failures: u32,
    retry_at: Option<Instant>,
    last_error: Option<String>,
}

impl Default for Refill {
    fn default() -> Self {
        Self {
            booting_since: None,
            last_boot: BOOT_GUESS,
            failures: 0,
            retry_at: None,
            last_error: None,
        }
    }
}

/// Why a session_start has no clone now, and about how long until it has one.
#[derive(Clone, Debug, PartialEq)]
pub struct Waiting {
    /// Until a clone is ready.
    pub secs: u64,
    /// The last boot's error, while boots keep failing.
    pub failing: Option<String>,
    /// Until the next boot starts, while the pool backs off; None while one is booting.
    pub retry_in: Option<u64>,
}

/// The wait after `failures` boots in a row failed.
pub fn backoff(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    BACKOFF_FIRST
        .saturating_mul(1 << doublings)
        .min(BACKOFF_MAX)
}

impl Refill {
    /// Whether a boot may start now: none under way, and no backoff running.
    pub fn may_boot(&self, now: Instant) -> bool {
        self.booting_since.is_none() && self.retry_at.is_none_or(|at| now >= at)
    }

    pub fn started(&mut self, now: Instant) {
        self.booting_since = Some(now);
    }

    pub fn succeeded(&mut self, now: Instant) {
        if let Some(since) = self.booting_since.take() {
            self.last_boot = now.duration_since(since);
        }
        self.failures = 0;
        self.retry_at = None;
        self.last_error = None;
    }

    pub fn failed(&mut self, now: Instant, why: String) {
        self.booting_since = None;
        self.failures += 1;
        self.retry_at = Some(now + backoff(self.failures));
        self.last_error = Some(why);
    }

    /// About how long until a clone is ready, with none warm.
    pub fn wait(&self, now: Instant) -> Waiting {
        let retry_in = match (self.booting_since, self.retry_at) {
            (None, Some(at)) if at > now => Some(at - now),
            _ => None,
        };
        let left = match self.booting_since {
            Some(since) => self.last_boot.saturating_sub(now.duration_since(since)),
            None => retry_in.unwrap_or_default() + self.last_boot,
        };
        Waiting {
            secs: left.max(WAIT_MIN).as_secs(),
            failing: (self.failures > 0).then(|| self.last_error.clone().unwrap_or_default()),
            retry_in: retry_in.map(|r| r.max(WAIT_MIN).as_secs()),
        }
    }

    /// A boot that ended without an outcome (its task cancelled, or it panicked): the slot is free again, and nothing
    /// counts as a failure.
    pub fn released(&mut self) {
        self.booting_since = None;
    }
}

/// The pool's one boot slot, held while a boot runs: [`BootSlot::take`] claims it, and dropped without
/// [`BootSlot::succeeded`] or [`BootSlot::failed`] (the boot's task was cancelled, or panicked) it frees it, so the pool
/// keeps refilling.
pub struct BootSlot<'a> {
    refill: &'a Mutex<Refill>,
    done: bool,
}

impl<'a> BootSlot<'a> {
    /// The slot, unless a boot runs or the pool backs off.
    pub fn take(refill: &'a Mutex<Refill>, now: Instant) -> Option<Self> {
        let mut held = lock(refill);
        if !held.may_boot(now) {
            return None;
        }
        held.started(now);
        Some(Self {
            refill,
            done: false,
        })
    }

    pub fn succeeded(mut self, now: Instant) {
        self.done = true;
        lock(self.refill).succeeded(now);
    }

    /// Records the failure; returns the backoff it set.
    pub fn failed(mut self, now: Instant, why: String) -> Duration {
        self.done = true;
        let mut refill = lock(self.refill);
        refill.failed(now, why);
        backoff(refill.failures)
    }
}

impl Drop for BootSlot<'_> {
    fn drop(&mut self) {
        if !self.done {
            lock(self.refill).released();
        }
    }
}

/// Booted clones waiting for a session: taking one costs no boot, and the pool clones and boots another behind it.
pub struct Pool {
    simctl: Simctl,
    pub golden: Golden,
    size: usize,
    warm: Mutex<VecDeque<Lent>>,
    filling: tokio::sync::Mutex<()>,
    /// Drained (the node stops): a boot still under way deletes its clone instead of keeping it.
    closed: AtomicBool,
    refill: Mutex<Refill>,
}

/// A clone, from the moment simctl made it: shut down and deleted when dropped, so one whose boot failed, whose
/// session_start went away mid-boot, or that waited in a drained pool goes too.
pub struct Lent {
    pub udid: String,
    simctl: Simctl,
}

impl Drop for Lent {
    fn drop(&mut self) {
        discard(&self.simctl, &self.udid);
    }
}

/// Shuts a clone down and deletes it, off the caller's thread.
fn discard(simctl: &Simctl, udid: &str) {
    let (simctl, udid) = (simctl.clone(), udid.to_owned());
    std::thread::spawn(move || {
        let _ = simctl.blocking(&["shutdown", &udid]).status();
        let _ = simctl.blocking(&["delete", &udid]).status();
    });
}

impl Pool {
    pub fn new(simctl: Simctl, golden: Golden, size: usize) -> Arc<Self> {
        Arc::new(Self {
            simctl,
            golden,
            size,
            warm: Mutex::default(),
            filling: tokio::sync::Mutex::new(()),
            closed: AtomicBool::new(false),
            refill: Mutex::default(),
        })
    }

    pub fn simctl(&self) -> &Simctl {
        &self.simctl
    }

    /// Clones the golden and boots the clone now.
    async fn boot(&self) -> Result<Lent, String> {
        let name = format!("fleetd-{}", super::short_id());
        let lent = Lent {
            udid: self.simctl.clone_device(&self.golden.udid, &name).await?,
            simctl: self.simctl.clone(),
        };
        self.simctl.boot(&lent.udid, BOOT_TIMEOUT).await?;
        Ok(lent)
    }

    /// A booted clone; the pool refills behind it. With none warm, a boot starts (unless one is under way or the
    /// pool is backing off), and the answer says about how long it takes: a boot can outlast the agent's wait for its
    /// tool call, so session_start doesn't wait for it.
    pub fn take(self: &Arc<Self>) -> Result<Lent, Waiting> {
        let warm = lock(&self.warm).pop_front();
        self.refill();
        warm.ok_or_else(|| lock(&self.refill).wait(Instant::now()))
    }

    /// Clones and boots in the background until the pool holds its size.
    pub fn refill(self: &Arc<Self>) {
        let pool = self.clone();
        tokio::spawn(async move {
            let Ok(_filling) = pool.filling.try_lock() else {
                return;
            };
            while lock(&pool.warm).len() < pool.size {
                if pool.closed.load(Ordering::Relaxed) {
                    return;
                }
                let Some(slot) = BootSlot::take(&pool.refill, Instant::now()) else {
                    return;
                };
                match pool.boot().await {
                    // Dropped: deleted.
                    Ok(_) if pool.closed.load(Ordering::Relaxed) => slot.succeeded(Instant::now()),
                    Ok(lent) => {
                        slot.succeeded(Instant::now());
                        lock(&pool.warm).push_back(lent);
                    }
                    Err(e) => {
                        let wait = slot.failed(Instant::now(), e.clone());
                        tracing::warn!(error = %e, retry_in_secs = wait.as_secs(), "iOS simulator pool not refilled");
                        return;
                    }
                }
            }
        });
    }

    pub fn warm(&self) -> usize {
        lock(&self.warm).len()
    }

    /// The last boot's error, while the pool's boots keep failing.
    pub fn failing(&self) -> Option<String> {
        lock(&self.refill).last_error.clone()
    }

    /// Deletes every waiting clone.
    pub fn drain(&self) {
        self.closed.store(true, Ordering::Relaxed);
        lock(&self.warm).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_simulators_cpu_is_its_launchd_sim_and_everything_under_it() {
        let ps = "\
            1     0   0.5 /sbin/launchd
          500     1  12.0 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/launchd_sim /Users/me/n/device/ios/set/AAAA-1/data/var/run/launchd_bootstrap.plist
          501   500  80.5 /Library/Developer/CoreSimulator/Volumes/iOS_23A/RuntimeRoot/usr/libexec/backboardd
          502   501   7.5 /RuntimeRoot/usr/libexec/assetsd
          600     1   3.0 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/launchd_sim /Users/me/n/device/ios/set/BBBB-2/data/var/run/launchd_bootstrap.plist
          601   600  90.0 /RuntimeRoot/usr/libexec/backboardd
          700     1  50.0 /usr/bin/cargo build";
        assert_eq!(device_cpu(ps, "AAAA-1"), 100.0);
        assert_eq!(device_cpu(ps, "BBBB-2"), 93.0);
        assert_eq!(device_cpu(ps, "CCCC-3"), 0.0, "not booted");
    }

    #[test]
    fn failed_boots_back_off_doubling_to_half_an_hour_and_a_good_one_starts_over() {
        assert_eq!(backoff(1), Duration::from_secs(60));
        assert_eq!(backoff(2), Duration::from_secs(120));
        assert_eq!(backoff(5), Duration::from_secs(960));
        assert_eq!(backoff(6), BACKOFF_MAX);
        assert_eq!(backoff(1000), BACKOFF_MAX);

        let t0 = Instant::now();
        let mut refill = Refill::default();
        assert!(refill.may_boot(t0));
        refill.started(t0);
        assert!(!refill.may_boot(t0), "one boot at a time");
        refill.failed(t0, "simctl boot failed".into());
        refill.started(t0 + Duration::from_secs(60));
        refill.failed(t0 + Duration::from_secs(60), "simctl boot failed".into());
        let after = t0 + Duration::from_secs(60);
        assert!(
            !refill.may_boot(after + Duration::from_secs(119)),
            "backing off"
        );
        assert!(refill.may_boot(after + Duration::from_secs(120)));
        refill.started(after + Duration::from_secs(120));
        refill.succeeded(after + Duration::from_secs(160));
        assert_eq!(refill.failures, 0);
        assert_eq!(refill.last_boot, Duration::from_secs(40), "timed");
        assert!(refill.may_boot(after + Duration::from_secs(160)));
    }

    #[tokio::test]
    async fn a_boot_cancelled_or_panicking_frees_the_slot_and_counts_no_failure() {
        let refill = Arc::new(Mutex::new(Refill::default()));
        let slot = BootSlot::take(&refill, Instant::now()).unwrap();
        assert!(
            BootSlot::take(&refill, Instant::now()).is_none(),
            "one boot at a time"
        );
        drop(slot);
        assert!(lock(&refill).may_boot(Instant::now()), "dropped: free");

        // Cancelled mid-boot, as a drained pool's task or a stopped node's is.
        let held = refill.clone();
        let (booting, started) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _slot = BootSlot::take(&held, Instant::now()).unwrap();
            let _ = booting.send(());
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        assert!(!lock(&refill).may_boot(Instant::now()), "booting");
        task.abort();
        let _ = task.await;
        assert!(lock(&refill).may_boot(Instant::now()), "cancelled: free");

        // A boot that panics.
        let held = refill.clone();
        let panicked = tokio::spawn(async move {
            let _slot = BootSlot::take(&held, Instant::now()).unwrap();
            panic!("a boot that panics");
        })
        .await;
        assert!(panicked.unwrap_err().is_panic());
        assert!(lock(&refill).may_boot(Instant::now()), "panicked: free");
        assert_eq!(lock(&refill).failures, 0, "neither is a failure");

        let slot = BootSlot::take(&refill, Instant::now()).unwrap();
        assert_eq!(slot.failed(Instant::now(), "x".into()), BACKOFF_FIRST);
        assert!(
            !lock(&refill).may_boot(Instant::now()),
            "a failure backs off"
        );
    }

    #[test]
    fn with_no_warm_clone_a_start_hears_about_how_long() {
        let t0 = Instant::now();
        let mut refill = Refill::default();
        assert_eq!(
            refill.wait(t0),
            Waiting {
                secs: 30,
                failing: None,
                retry_in: None,
            },
            "a guess before any boot was timed"
        );
        refill.started(t0);
        refill.succeeded(t0 + Duration::from_secs(80));
        refill.started(t0 + Duration::from_secs(100));
        assert_eq!(
            refill.wait(t0 + Duration::from_secs(130)).secs,
            50,
            "a boot under way"
        );
        assert_eq!(
            refill.wait(t0 + Duration::from_secs(300)).secs,
            5,
            "at least a few seconds"
        );
        refill.failed(
            t0 + Duration::from_secs(300),
            "simctl boot did not finish".into(),
        );
        let failing = refill.wait(t0 + Duration::from_secs(300));
        assert_eq!(failing.secs, 60 + 80, "the backoff, then a boot");
        assert_eq!(failing.retry_in, Some(60));
        refill.started(t0 + Duration::from_secs(360));
        let retrying = refill.wait(t0 + Duration::from_secs(370));
        assert_eq!(
            (retrying.secs, retrying.retry_in),
            (70, None),
            "booting again: no backoff to wait out"
        );
        assert!(retrying.failing.is_some(), "the last one failed");
        assert_eq!(
            failing.failing.as_deref(),
            Some("simctl boot did not finish")
        );
    }

    #[test]
    fn a_golden_counts_only_for_the_pinned_agent_device_with_its_wrapper() {
        let home = tempfile::tempdir().unwrap();
        let golden = Golden {
            udid: "AAAA-1".into(),
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0".into(),
            runtime_name: "iOS 27.0".into(),
            device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17".into(),
            device_type_name: "iPhone 17".into(),
            scale: 3.0,
            agent_device: agent_device::VERSION.into(),
            xctestrun: "/n/runner/AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun".into(),
        };
        std::fs::create_dir_all(super::super::ios_dir(home.path())).unwrap();
        std::fs::write(
            golden_path(home.path()),
            serde_json::to_vec(&golden).unwrap(),
        )
        .unwrap();
        assert_eq!(find(home.path()), None, "agent-device isn't installed");
    }

    #[test]
    fn a_golden_whose_runner_is_gone_is_made_again() {
        let home = tempfile::tempdir().unwrap();
        let install = agent_device::install_dir(home.path());
        std::fs::create_dir_all(agent_device::bin_dir(home.path())).unwrap();
        std::fs::write(install.join("VERSION"), agent_device::VERSION).unwrap();
        std::fs::write(agent_device::bin_dir(home.path()).join("agent-device"), "").unwrap();
        let entry = agent_device::entry(home.path());
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "").unwrap();
        let products = home.path().join("runner/Build/Products");
        std::fs::create_dir_all(&products).unwrap();
        let xctestrun = products.join("AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun");
        std::fs::write(&xctestrun, "").unwrap();
        wrapper::install(home.path(), Some(&xctestrun)).unwrap();
        let golden = Golden {
            udid: "AAAA-1".into(),
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0".into(),
            runtime_name: "iOS 27.0".into(),
            device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17".into(),
            device_type_name: "iPhone 17".into(),
            scale: 3.0,
            agent_device: agent_device::VERSION.into(),
            xctestrun: xctestrun.clone(),
        };
        std::fs::write(
            golden_path(home.path()),
            serde_json::to_vec(&golden).unwrap(),
        )
        .unwrap();
        assert_eq!(find(home.path()), Some(golden));
        std::fs::remove_file(&xctestrun).unwrap();
        assert_eq!(
            find(home.path()),
            None,
            "every session would fail to start the runner"
        );
    }
}
