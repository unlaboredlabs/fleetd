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
/// How long the golden may take to settle before it is shut down anyway.
const SETTLE_MAX: Duration = Duration::from_secs(600);
/// A simulator is settled once its processes together use less than this share of one core...
const SETTLED_CPU: f64 = 25.0;
/// ...this many samples running, taken this far apart.
const SETTLED_SAMPLES: usize = 3;
const SAMPLE_EVERY: Duration = Duration::from_secs(5);

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
}

pub fn golden_path(home: &Path) -> PathBuf {
    super::ios_dir(home).join("golden.json")
}

/// The golden, when it was made for the pinned agent-device and the wrapper is there.
pub fn find(home: &Path) -> Option<Golden> {
    let golden: Golden = serde_json::from_slice(&std::fs::read(golden_path(home)).ok()?).ok()?;
    (golden.agent_device == agent_device::VERSION
        && agent_device::find(home).is_some()
        && wrapper::find(home).is_some())
    .then_some(golden)
}

/// Makes the golden simulator, from nothing: whatever the set held goes first. `device_type` names the device type
/// to use (node.json's `ios.deviceType`); absent, a plain iPhone.
pub async fn prepare(home: &Path, device_type: Option<&str>) -> Result<Golden, String> {
    if agent_device::find(home).is_none() {
        agent_device::install(home).await?;
    }
    let wrapper = wrapper::install(home)?;
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
        simctl.shutdown(&udid).await
    }
    .await;
    if let Err(why) = made {
        let _ = simctl.shutdown(&udid).await;
        let _ = simctl.delete(&udid).await;
        return Err(why);
    }
    let golden = Golden {
        udid,
        runtime: runtime.identifier.clone(),
        runtime_name: runtime.name.clone(),
        device_type: device_type.identifier.clone(),
        device_type_name: device_type.name.clone(),
        scale: super::simctl::scale(&device_type).await,
        agent_device: agent_device::VERSION.to_owned(),
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
    stop_daemon(&state);
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

/// Ends the agent-device daemon whose state directory is `state`, if one runs.
pub fn stop_daemon(state: &Path) {
    if let Ok(text) = std::fs::read_to_string(state.join("daemon.json"))
        && let Ok(daemon) = serde_json::from_str::<serde_json::Value>(&text)
        && let Some(pid) = daemon["pid"].as_i64()
        && daemon["stateDir"].as_str() == Some(&*state.to_string_lossy())
    {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGTERM,
        );
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

/// Booted clones waiting for a session: taking one costs no boot, and the pool clones and boots another behind it.
pub struct Pool {
    simctl: Simctl,
    pub golden: Golden,
    size: usize,
    warm: Mutex<VecDeque<Lent>>,
    filling: tokio::sync::Mutex<()>,
    /// Drained (the node stops): a boot still under way deletes its clone instead of keeping it.
    closed: AtomicBool,
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

    /// A booted clone, or one cloned and booted now when none waits; the pool refills behind it.
    pub async fn take(self: &Arc<Self>) -> Result<Lent, String> {
        let warm = lock(&self.warm).pop_front();
        let lent = match warm {
            Some(lent) => lent,
            None => self.boot().await?,
        };
        self.refill();
        Ok(lent)
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
                match pool.boot().await {
                    // Dropped: deleted.
                    Ok(_) if pool.closed.load(Ordering::Relaxed) => {}
                    Ok(lent) => lock(&pool.warm).push_back(lent),
                    Err(e) => {
                        tracing::warn!(error = %e, "iOS simulator pool not refilled");
                        return;
                    }
                }
            }
        });
    }

    pub fn warm(&self) -> usize {
        lock(&self.warm).len()
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
        };
        std::fs::create_dir_all(super::super::ios_dir(home.path())).unwrap();
        std::fs::write(
            golden_path(home.path()),
            serde_json::to_vec(&golden).unwrap(),
        )
        .unwrap();
        assert_eq!(find(home.path()), None, "agent-device isn't installed");
    }
}
