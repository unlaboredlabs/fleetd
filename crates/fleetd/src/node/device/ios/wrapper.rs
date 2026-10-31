//! agent-device for iOS sessions: the same pinned package as android sessions (node/device/agent_device.rs), run by a
//! wrapper of its own at `<node home>/device/ios/bin/agent-device`, which names the node's simulator set and the runner
//! the golden built. Those are set in the wrapper only: an agent's own `xcrun simctl` and Xcode stay as they were. Each
//! agent session keeps its own agent-device home and state, and its config names the session's clone by udid.
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::node::device::agent_device::{self, LENT, PAUSED, VERSION};

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

/// While a session's own agent-device starts its XCTest runner (session.rs), this file holds the pid of the `prepare`
/// doing it, and the wrapper waits for it to end before it runs anything: a command that needs the runner meanwhile would
/// give a start its own 45 s, and a start that takes longer was given up on, the one it made again too.
pub fn starting_path(home: &Path, thread: &str) -> PathBuf {
    home.join("sessions").join(thread).join("runner-starting")
}

/// The wrapper: refuses while the session's control file says a person has the simulator, waits while the session's
/// runner starts ([`starting_path`]), switches to the clone's own agent-device home when the session's names one
/// ([`LENT`]), else runs agent-device on the node's simulator set with the runner the golden built. A daemon that is stopped stops its XCTest runner: by
/// default agent-device leaves it running for a next daemon to take over, and fleetd's daemons have none (each lives
/// as long as its session, or the golden's prepare). The runner's xcodebuild left behind relaunches it after the
/// simulator shuts down, which boots the simulator again: a golden booted again can't be cloned.
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
         if [ -n \"$FLEETD_RUNNER_STARTING\" ]; then\n  \
         while pid=$(cat \"$FLEETD_RUNNER_STARTING\" 2>/dev/null) && [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; do sleep 0.2; done\n\
         fi\n\
         if [ -n \"$AGENT_DEVICE_HOME\" ] && lent=$(cat \"$AGENT_DEVICE_HOME/{LENT}\" 2>/dev/null) && [ -n \"$lent\" ]; then\n  \
         AGENT_DEVICE_HOME=\"$lent\"\n  AGENT_DEVICE_STATE_DIR=\"$lent/state\"\n  export AGENT_DEVICE_HOME AGENT_DEVICE_STATE_DIR\n\
         fi\n\
         AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET='{set}'\n\
         AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH='{runner}'\n\
         AGENT_DEVICE_IOS_RUNNER_DETACH=0\n\
         AGENT_DEVICE_NO_UPDATE_NOTIFIER=1\n\
         export AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH AGENT_DEVICE_IOS_RUNNER_DETACH \
         AGENT_DEVICE_NO_UPDATE_NOTIFIER\n\
         {external}\
         exec node '{entry}' \"$@\"\n",
        set = quote(&super::set_dir(home)),
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

/// Points the session's agent-device at its clone, and its commands at the clone's own agent-device home (`lent`), where
/// the pool started the clone's runner, when it has one.
pub fn write_config(
    home: &Path,
    thread: &str,
    udid: &str,
    lent: Option<&Path>,
) -> std::io::Result<()> {
    let dir = agent_device::session_dir(home, thread);
    write_device(&dir, udid)?;
    match lent {
        Some(lent) => {
            crate::node::secrets::write_atomic(&dir.join(LENT), lent.to_string_lossy().as_bytes())
        }
        None => match std::fs::remove_file(dir.join(LENT)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

/// Writes the config of the agent-device home `dir`, naming the simulator `udid`.
pub fn write_device(dir: &Path, udid: &str) -> std::io::Result<()> {
    crate::node::config::mkdir_private(dir)?;
    let config = json!({ "platform": "ios", "udid": udid });
    crate::node::secrets::write_atomic(&dir.join("config.json"), format!("{config}\n").as_bytes())
}

/// What a session's claude gets in its environment: the wrapper first on PATH (it alone), its own agent-device home
/// and state, and the control and runner-starting files the wrapper checks.
pub fn env(home: &Path, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
    let mut env = agent_device::env(home, thread, path);
    env.push((
        "FLEETD_RUNNER_STARTING".to_owned(),
        starting_path(home, thread).to_string_lossy().into_owned(),
    ));
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
        assert_eq!(
            get("FLEETD_RUNNER_STARTING"),
            Some("/n/sessions/s1/runner-starting")
        );
        assert_eq!(env.len(), 5, "nothing else: {env:?}");
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
        write_config(
            home.path(),
            "s1",
            "8A1B2C3D-0000-4000-8000-000000000002",
            None,
        )
        .unwrap();
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
             process.env.AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH)\n",
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
        let run = || {
            std::process::Command::new(&wrapper)
                .args(["open", "settings"])
                .env("FLEETD_DEVICE_CONTROL", &control)
                .output()
                .unwrap()
        };
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
                 /n/device/agent-device/node_modules/agent-device/.tmp/fleetd-runner 0 \
                 /n/runner's/AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun \
                 /n/device/agent-device/node_modules/agent-device/.tmp/fleetd-runner"
            );
        }
    }

    #[test]
    fn the_wrapper_switches_to_the_clones_home_the_session_was_lent() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake.mjs");
        std::fs::write(
            &fake,
            "console.log(process.env.AGENT_DEVICE_HOME, process.env.AGENT_DEVICE_STATE_DIR)\n",
        )
        .unwrap();
        let wrapper = dir.path().join("agent-device");
        std::fs::write(&wrapper, wrapper_script(&fake, Path::new("/n"), None)).unwrap();
        std::fs::set_permissions(
            &wrapper,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let own = dir.path().join("sessions/s1/agent-device");
        std::fs::create_dir_all(&own).unwrap();
        let run = || {
            let out = std::process::Command::new(&wrapper)
                .arg("snapshot")
                .env("AGENT_DEVICE_HOME", &own)
                .env("AGENT_DEVICE_STATE_DIR", own.join("state"))
                .env_remove("FLEETD_DEVICE_CONTROL")
                .env_remove("FLEETD_RUNNER_STARTING")
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        let node = std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success());
        if !node {
            return;
        }
        assert_eq!(
            run(),
            format!("{} {}", own.display(), own.join("state").display()),
            "its own home while nothing is lent"
        );
        let clone = dir.path().join("device/ios/clones/AAAA 1");
        write_config(dir.path(), "s1", "AAAA-1", Some(&clone)).unwrap();
        assert_eq!(
            run(),
            format!("{} {}", clone.display(), clone.join("state").display())
        );
        write_config(dir.path(), "s1", "AAAA-1", None).unwrap();
        assert!(!own.join(LENT).exists());
    }

    #[test]
    fn the_wrapper_waits_while_the_sessions_runner_starts() {
        let dir = tempfile::tempdir().unwrap();
        let wrapper = dir.path().join("agent-device");
        let entry = dir.path().join("none.mjs");
        std::fs::write(&wrapper, wrapper_script(&entry, Path::new("/n"), None)).unwrap();
        std::fs::set_permissions(
            &wrapper,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let starting = dir.path().join("runner-starting");
        // When the wrapper ended: it waits for nothing gone, so a run that hangs past a minute fails. Not timed
        // otherwise: on a loaded Mac node alone takes seconds to start.
        let run = || {
            let mut child = std::process::Command::new(&wrapper)
                .arg("snapshot")
                .env("FLEETD_RUNNER_STARTING", &starting)
                .env_remove("FLEETD_DEVICE_CONTROL")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while child.try_wait().unwrap().is_none() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the wrapper still waits"
                );
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            std::time::Instant::now()
        };
        run();
        // A prepare under way: the command runs only after it ended. It is reaped as it ends, as the node's is.
        let mut prepare = std::process::Command::new("sleep")
            .arg("2")
            .spawn()
            .unwrap();
        std::fs::write(&starting, prepare.id().to_string()).unwrap();
        let reaped = std::thread::spawn(move || {
            prepare.wait().unwrap();
            std::time::Instant::now()
        });
        let ended = run();
        assert!(ended >= reaped.join().unwrap(), "it waited for the prepare");
        // A prepare gone (a node that stopped) holds nothing back.
        run();
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
