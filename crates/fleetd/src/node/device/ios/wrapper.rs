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

/// Where agent-device's XCTest runner is built, once, for every session: in the package's own `.tmp`. A cached runner
/// that doesn't connect in time (its start gets 45 s, which a slow Mac's first start can take) is cleaned and built
/// again, and agent-device cleans a runner only there: anywhere else, it refuses and the command fails. It checks the
/// path against the package's real path, so this is named by it.
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

/// The wrapper, when it wraps the pinned package.
pub fn find(home: &Path) -> Option<PathBuf> {
    let bin = bin_dir(home).join("agent-device");
    let script = std::fs::read_to_string(&bin).ok()?;
    (script == wrapper_script(&agent_device::entry(home), home)).then_some(bin)
}

/// Writes the wrapper for the installed package.
pub fn install(home: &Path) -> Result<PathBuf, String> {
    let bin = bin_dir(home);
    std::fs::create_dir_all(&bin).map_err(|e| format!("cannot make {}: {e}", bin.display()))?;
    let wrapper = bin.join("agent-device");
    let script = wrapper_script(&agent_device::entry(home), home);
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
/// the node's simulator set with the runner the golden built.
pub fn wrapper_script(entry: &Path, home: &Path) -> String {
    let quote = |p: &Path| p.to_string_lossy().replace('\'', r"'\''");
    let paused = PAUSED.replace('\'', r"'\''");
    format!(
        "#!/bin/sh\n\
         # fleetd's: agent-device {VERSION}, pointed at this session's iOS simulator.\n\
         if [ -n \"$FLEETD_DEVICE_CONTROL\" ] && [ -e \"$FLEETD_DEVICE_CONTROL\" ]; then\n  \
         echo '{paused}' >&2\n  exit 75\nfi\n\
         AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET='{set}'\n\
         AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH='{runner}'\n\
         AGENT_DEVICE_NO_UPDATE_NOTIFIER=1\n\
         export AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH AGENT_DEVICE_NO_UPDATE_NOTIFIER\n\
         exec node '{entry}' \"$@\"\n",
        set = quote(&super::set_dir(home)),
        runner = quote(&runner_dir(home)),
        entry = quote(entry),
    )
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
             process.env.AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET, process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH)\n",
        )
        .unwrap();
        let wrapper = dir.path().join("agent-device");
        std::fs::write(&wrapper, wrapper_script(&fake, Path::new("/n"))).unwrap();
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
                 /n/device/agent-device/node_modules/agent-device/.tmp/fleetd-runner"
            );
        }
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
        install(&home).unwrap();
        assert!(!old_runner_dir(&home).exists(), "the old runner goes");
    }

    #[test]
    fn the_wrapper_counts_only_when_it_wraps_this_install() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(find(home.path()), None);
        let wrapper = install(home.path()).unwrap();
        assert_eq!(find(home.path()), Some(wrapper.clone()));
        std::fs::write(&wrapper, "#!/bin/sh\nexec node old.mjs\n").unwrap();
        assert_eq!(find(home.path()), None, "an older wrapper is written again");
    }
}
