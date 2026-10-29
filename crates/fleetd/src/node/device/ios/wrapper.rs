//! agent-device for iOS sessions: the same pinned package as android sessions (node/device/agent_device.rs), run by a
//! wrapper of its own at `<node home>/device/ios/bin/agent-device`, which names the node's simulator set and the runner
//! the golden built. Those are set in the wrapper only: an agent's own `xcrun simctl` and Xcode stay as they were. Each
//! agent session keeps its own agent-device home and state, and its config names the session's clone by udid.
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::node::device::agent_device::{self, PAUSED, VERSION};

/// The directory put first on a session's PATH: it holds only the `agent-device` wrapper.
pub fn bin_dir(home: &Path) -> PathBuf {
    super::ios_dir(home).join("bin")
}

/// Where agent-device's XCTest runner is built, once, by the golden's prepare: in the package's own `.tmp`. A cached
/// runner that doesn't connect in time (its start gets 45 s, which a slow Mac's first start can take) is cleaned and
/// built again, and agent-device cleans a runner only there: anywhere else, it refuses and the command fails. It
/// checks the path against the package's real path, so this is named by it. Sessions don't build: they start the
/// golden's runner as an external one ([`wrapper_script`]).
pub fn runner_dir(home: &Path) -> PathBuf {
    let package = agent_device::package_dir(home);
    std::fs::canonicalize(&package)
        .unwrap_or(package)
        .join(".tmp/fleetd-runner")
}

/// Where agent-device writes a lease for each XCTest runner it started: the runner's pid, port and token, by the
/// simulator's udid. A daemon that stops leaves its runner running, leased ([`wrapper_script`]), and the next daemon on
/// that simulator takes it over instead of starting one: so the pool starts a clone's runner before lending it
/// (pool.rs), and the node stops it by its lease when the clone goes ([`stop_runner`]).
pub fn lease_dir(home: &Path) -> PathBuf {
    super::ios_dir(home).join("runner-leases")
}

/// A runner's lease, as agent-device wrote it.
#[derive(Debug, PartialEq)]
pub struct Lease {
    pub pid: i32,
    pub port: u16,
}

/// The lease of the runner on simulator `udid`, if agent-device wrote one.
pub fn lease(home: &Path, udid: &str) -> Option<Lease> {
    let text = std::fs::read_to_string(lease_path(home, udid)).ok()?;
    let lease: serde_json::Value = serde_json::from_str(&text).ok()?;
    (lease["deviceId"] == udid).then_some(())?;
    Some(Lease {
        pid: i32::try_from(lease["runnerPid"].as_i64()?).ok()?,
        port: u16::try_from(lease["port"].as_u64()?).ok()?,
    })
}

/// agent-device names a lease by the udid, with anything but `[A-Za-z0-9._-]` a dash.
pub fn lease_path(home: &Path, udid: &str) -> PathBuf {
    let name: String = udid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    lease_dir(home).join(format!("{name}.json"))
}

/// Kills the runner leased on simulator `udid` before the simulator goes: its xcodebuild, left running, launches the
/// runner again once the simulator shuts down, which boots it again. Only an xcodebuild started for `udid` is killed:
/// a pid reused since is left alone.
pub fn stop_runner(home: &Path, udid: &str) {
    if let Some(lease) = lease(home, udid) {
        let command = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &lease.pid.to_string()])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        if command.contains("xcodebuild") && command.contains(udid) {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(lease.pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
    }
    let _ = std::fs::remove_file(lease_path(home, udid));
}

/// Where the runner was built before it moved into the package.
fn old_runner_dir(home: &Path) -> PathBuf {
    super::ios_dir(home).join("runner")
}

/// The wrapper, when it wraps the pinned package and starts the runner `xctestrun`.
pub fn find(home: &Path, xctestrun: &Path) -> Option<PathBuf> {
    let bin = bin_dir(home).join("agent-device");
    let script = std::fs::read_to_string(&bin).ok()?;
    (script == wrapper_script(&agent_device::entry(home), home, Some(xctestrun))).then_some(bin)
}

/// Writes the wrapper for the installed package: without a runner while the golden's prepare builds one, then with it.
pub fn install(home: &Path, xctestrun: Option<&Path>) -> Result<PathBuf, String> {
    let bin = bin_dir(home);
    std::fs::create_dir_all(&bin).map_err(|e| format!("cannot make {}: {e}", bin.display()))?;
    let wrapper = bin.join("agent-device");
    let script = wrapper_script(&agent_device::entry(home), home, xctestrun);
    crate::node::secrets::write_atomic(&wrapper, script.as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", wrapper.display()))?;
    std::fs::set_permissions(
        &wrapper,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(old_runner_dir(home));
    Ok(wrapper)
}

/// The wrapper: refuses while the session's control file says a person has the simulator, else runs agent-device on
/// the node's simulator set with the runner the golden built. A daemon that is stopped leaves its XCTest runner
/// running, leased in [`lease_dir`], for the next daemon on that simulator to take over: the pool's daemon that started
/// a clone's runner hands it to the session's (pool.rs). The golden's prepare sets `FLEETD_IOS_RUNNER_DETACH=0`, so its
/// daemon stops the runner: the runner's xcodebuild left behind relaunches it after the simulator shuts down, which
/// boots the simulator again, and a golden booted again can't be cloned.
///
/// Once built, the runner (`xctestrun`) is given to agent-device as an external one. A runner from its own cache whose
/// first start misses its 45 s is taken for a bad build: agent-device deletes it and builds it again inside the
/// agent's command, minutes on a loaded Mac, so the command timed out and the next one found no runner and built
/// again. An external runner is kept, and a slow start is only started again.
pub fn wrapper_script(entry: &Path, home: &Path, xctestrun: Option<&Path>) -> String {
    let quote = |p: &Path| p.to_string_lossy().replace('\'', r"'\''");
    let paused = PAUSED.replace('\'', r"'\''");
    let runner = quote(&runner_dir(home));
    let external = xctestrun.map_or(String::new(), |xctestrun| {
        format!(
            "AGENT_DEVICE_IOS_XCTESTRUN_FILE='{}'\n\
             AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH='{runner}'\n\
             export AGENT_DEVICE_IOS_XCTESTRUN_FILE AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH\n",
            quote(xctestrun)
        )
    });
    format!(
        "#!/bin/sh\n\
         # fleetd's: agent-device {VERSION}, pointed at this session's iOS simulator.\n\
         if [ -n \"$FLEETD_DEVICE_CONTROL\" ] && [ -e \"$FLEETD_DEVICE_CONTROL\" ]; then\n  \
         echo '{paused}' >&2\n  exit 75\nfi\n\
         AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET='{set}'\n\
         AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH='{runner}'\n\
         AGENT_DEVICE_IOS_RUNNER_DETACH=\"${{FLEETD_IOS_RUNNER_DETACH:-1}}\"\n\
         AGENT_DEVICE_IOS_RUNNER_LEASE_DIR='{leases}'\n\
         AGENT_DEVICE_NO_UPDATE_NOTIFIER=1\n\
         export AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH AGENT_DEVICE_IOS_RUNNER_DETACH \
         AGENT_DEVICE_IOS_RUNNER_LEASE_DIR AGENT_DEVICE_NO_UPDATE_NOTIFIER\n\
         {external}\
         exec node '{entry}' \"$@\"\n",
        set = quote(&super::set_dir(home)),
        leases = quote(&lease_dir(home)),
        entry = quote(entry),
    )
}

/// The runner agent-device built in [`runner_dir`] for the simulator: its newest `.xctestrun`, not the copies it writes
/// beside it with one start's port (`AgentDeviceRunner.env.*`).
pub fn built_xctestrun(home: &Path) -> Result<PathBuf, String> {
    let dir = runner_dir(home);
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut dirs = vec![dir.clone()];
    while let Some(next) = dirs.pop() {
        for entry in std::fs::read_dir(&next).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if path.is_dir() {
                dirs.push(path);
            } else if name.ends_with(".xctestrun")
                && name.contains("iphonesimulator")
                && !name.starts_with("agentdevicerunner.env.")
            {
                let modified = entry.metadata().and_then(|m| m.modified());
                found.push((modified.unwrap_or(std::time::UNIX_EPOCH), path));
            }
        }
    }
    found
        .into_iter()
        .max()
        .map(|(_, path)| path)
        .ok_or_else(|| {
            format!(
                "agent-device built no simulator runner in {}",
                dir.display()
            )
        })
}

/// Points the session's agent-device at its clone.
pub fn write_config(home: &Path, thread: &str, udid: &str) -> std::io::Result<()> {
    let dir = agent_device::session_dir(home, thread);
    crate::node::config::mkdir_private(&dir)?;
    let config = json!({ "platform": "ios", "udid": udid });
    crate::node::secrets::write_atomic(&dir.join("config.json"), format!("{config}\n").as_bytes())
}

/// What a session's claude gets in its environment: the wrapper first on PATH (it alone), its own agent-device home
/// and state, and the control file the wrapper checks.
pub fn env(home: &Path, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
    let mut env = agent_device::env(home, thread, path);
    let android = agent_device::bin_dir(home).to_string_lossy().into_owned();
    let ios = bin_dir(home).to_string_lossy().into_owned();
    for (key, value) in &mut env {
        if key == "PATH"
            && let Some(rest) = value.strip_prefix(&android)
        {
            *value = format!("{ios}{rest}");
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_finds_the_ios_wrapper_first_and_its_own_home() {
        let env = env(Path::new("/n"), "s1", Some("/usr/bin"));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), Some("/n/device/ios/bin:/usr/bin"));
        assert_eq!(
            get("AGENT_DEVICE_HOME"),
            Some("/n/sessions/s1/agent-device")
        );
        assert_eq!(
            get("FLEETD_DEVICE_CONTROL"),
            Some("/n/sessions/s1/device-control")
        );
        assert_eq!(env.len(), 4, "nothing else: {env:?}");
        let alone = super::env(Path::new("/n"), "s1", None);
        assert_eq!(
            alone
                .iter()
                .find(|(k, _)| k == "PATH")
                .map(|(_, v)| v.as_str()),
            Some("/n/device/ios/bin")
        );
    }

    #[test]
    fn the_config_names_the_lent_clone() {
        let home = tempfile::tempdir().unwrap();
        write_config(home.path(), "s1", "8A1B2C3D-0000-4000-8000-000000000002").unwrap();
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                agent_device::session_dir(home.path(), "s1").join("config.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            config,
            json!({ "platform": "ios", "udid": "8A1B2C3D-0000-4000-8000-000000000002" })
        );
        agent_device::release(home.path(), "s1");
        assert!(
            !agent_device::session_dir(home.path(), "s1")
                .join("config.json")
                .exists()
        );
    }

    #[test]
    fn the_wrapper_refuses_while_a_person_has_control_and_names_the_nodes_set() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake's agent-device.mjs");
        std::fs::write(
            &fake,
            "console.log('ran', process.argv.slice(2).join(' '), \
             process.env.AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET, process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH, \
             process.env.AGENT_DEVICE_IOS_RUNNER_DETACH, process.env.AGENT_DEVICE_IOS_XCTESTRUN_FILE, \
             process.env.AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH, process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR)\n",
        )
        .unwrap();
        let wrapper = dir.path().join("agent-device");
        let xctestrun =
            Path::new("/n/runner's/AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun");
        std::fs::write(
            &wrapper,
            wrapper_script(&fake, Path::new("/n"), Some(xctestrun)),
        )
        .unwrap();
        std::fs::set_permissions(
            &wrapper,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let control = dir.path().join("device-control");
        let run_detached = |detach: Option<&str>| {
            let mut command = std::process::Command::new(&wrapper);
            command
                .args(["open", "settings"])
                .env("FLEETD_DEVICE_CONTROL", &control)
                .env_remove("FLEETD_IOS_RUNNER_DETACH");
            if let Some(detach) = detach {
                command.env("FLEETD_IOS_RUNNER_DETACH", detach);
            }
            command.output().unwrap()
        };
        let run = || run_detached(None);
        std::fs::write(&control, "human").unwrap();
        let paused = run();
        assert_eq!(paused.status.code(), Some(75));
        assert!(String::from_utf8_lossy(&paused.stderr).contains("A person has control"));
        std::fs::remove_file(&control).unwrap();
        let ran = run();
        let node = std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if node {
            assert!(ran.status.success(), "{ran:?}");
            assert_eq!(
                String::from_utf8_lossy(&ran.stdout).trim(),
                "ran open settings /n/device/ios/set \
                 /n/device/agent-device/node_modules/agent-device/.tmp/fleetd-runner 1 \
                 /n/runner's/AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun \
                 /n/device/agent-device/node_modules/agent-device/.tmp/fleetd-runner \
                 /n/device/ios/runner-leases"
            );
            // The golden's prepare: its daemon stops the runner.
            let golden = run_detached(Some("0"));
            assert!(
                String::from_utf8_lossy(&golden.stdout).contains("/fleetd-runner 0 "),
                "{golden:?}"
            );
        }
    }

    #[test]
    fn a_runner_is_found_by_its_lease_and_only_its_xcodebuild_is_killed() {
        let home = tempfile::tempdir().unwrap();
        let udid = "8A1B2C3D-0000-4000-8000-000000000002";
        assert_eq!(lease(home.path(), udid), None);
        std::fs::create_dir_all(lease_dir(home.path())).unwrap();
        let path = lease_dir(home.path()).join(format!("{udid}.json"));
        // A sleep stands in for a runner whose pid was reused: it isn't an xcodebuild for this simulator.
        let mut other = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = other.id();
        let written =
            json!({ "schemaVersion": 1, "deviceId": udid, "runnerPid": pid, "port": 50123 });
        std::fs::write(&path, written.to_string()).unwrap();
        assert_eq!(
            lease(home.path(), udid),
            Some(Lease {
                pid: pid as i32,
                port: 50123
            })
        );
        assert_eq!(lease(home.path(), "another-udid"), None);
        stop_runner(home.path(), udid);
        assert!(!path.exists(), "the lease goes");
        assert!(
            other.try_wait().unwrap().is_none(),
            "not its runner: left alone"
        );
        other.kill().unwrap();
        let _ = other.wait();
    }

    #[test]
    fn the_runner_is_in_the_packages_real_tmp_where_agent_device_may_clean_it() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let package = agent_device::package_dir(&real);
        std::fs::create_dir_all(&package).unwrap();
        let home = dir.path().join("home");
        std::os::unix::fs::symlink(&real, &home).unwrap();
        let tmp = std::fs::canonicalize(&package).unwrap().join(".tmp");
        assert_eq!(runner_dir(&home), tmp.join("fleetd-runner"));
        std::fs::create_dir_all(old_runner_dir(&home)).unwrap();
        install(&home, None).unwrap();
        assert!(!old_runner_dir(&home).exists(), "the old runner goes");
    }

    #[test]
    fn the_wrapper_counts_only_when_it_wraps_this_install_and_its_runner() {
        let home = tempfile::tempdir().unwrap();
        let xctestrun = Path::new("/n/AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun");
        assert_eq!(find(home.path(), xctestrun), None);
        let wrapper = install(home.path(), None).unwrap();
        assert_eq!(
            find(home.path(), xctestrun),
            None,
            "still building its runner"
        );
        install(home.path(), Some(xctestrun)).unwrap();
        assert_eq!(find(home.path(), xctestrun), Some(wrapper.clone()));
        std::fs::write(&wrapper, "#!/bin/sh\nexec node old.mjs\n").unwrap();
        assert_eq!(
            find(home.path(), xctestrun),
            None,
            "an older wrapper is written again"
        );
    }

    #[test]
    fn sessions_start_the_runner_built_for_the_simulator_not_a_starts_copy() {
        let home = tempfile::tempdir().unwrap();
        assert!(built_xctestrun(home.path()).is_err(), "nothing built");
        // The runner is named by the package's real path once it is installed: on macOS a temp dir under /var is
        // /private/var, which agent-device compares against.
        std::fs::create_dir_all(agent_device::package_dir(home.path())).unwrap();
        let products = runner_dir(home.path()).join("Build/Products");
        assert!(products.starts_with(std::fs::canonicalize(home.path()).unwrap()));
        std::fs::create_dir_all(&products).unwrap();
        let built = products.join("AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun");
        std::fs::write(&built, "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        for copy in [
            "AgentDeviceRunner.env.session-AAAA-1-x-4000.xctestrun",
            "AgentDeviceRunner_macosx27.0-arm64.xctestrun",
        ] {
            std::fs::write(products.join(copy), "").unwrap();
        }
        assert_eq!(built_xctestrun(home.path()), Ok(built));
    }
}
