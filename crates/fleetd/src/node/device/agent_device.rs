//! The tool agents drive their emulator with: Callstack's agent-device, as a CLI with its skill (its MCP mode costs
//! ~64k tokens of tool definitions). The node installs it at a pinned version under `<node home>/device/agent-device`
//! and puts a wrapper of its own first on each session's PATH, with Google's adb beside it. Each agent session gets its
//! own agent-device home and state directory (so its own daemon), and the config there names the session's emulator
//! by serial once `session_start` lent it one.
//!
//! The wrapper refuses while a person has control of the device (the node keeps a file saying so): adb is the
//! agent's to reach, so this keeps an honest agent from fighting the person, as the browser's proxy does.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::json;
use sha2::Digest;

/// The agent-device release the node installs.
pub const VERSION: &str = "0.21.31";

/// Its skill, from the same tag (the npm package leaves it out), checked by digest.
const SKILL_URL: &str = "https://raw.githubusercontent.com/callstack/agent-device/v0.21.31/skills/agent-device/SKILL.md";
const SKILL_SHA256: &str = "ad3b4ccbd2d43c3baae80a5b0d5aaad14becffb49fabccb6c93d61d44dcd6698";

/// What the wrapper says while a person has control.
pub const PAUSED: &str = "A person has control of the device now. Wait for them to hand it back (carry on with other \
                          work meanwhile); your next agent-device command after that sees the screen as they left it.";

pub fn install_dir(home: &Path) -> PathBuf {
    super::sdk::device_dir(home).join("agent-device")
}

/// The directory put first on a session's PATH: it holds only the `agent-device` wrapper.
pub fn bin_dir(home: &Path) -> PathBuf {
    install_dir(home).join("bin")
}

fn entry(home: &Path) -> PathBuf {
    install_dir(home).join("node_modules/agent-device/bin/agent-device.mjs")
}

/// The wrapper, when it wraps the pinned version.
pub fn find(home: &Path) -> Option<PathBuf> {
    let bin = bin_dir(home).join("agent-device");
    let version = std::fs::read_to_string(install_dir(home).join("VERSION")).ok()?;
    (version.trim() == VERSION && bin.is_file() && entry(home).is_file()).then_some(bin)
}

/// Installs the pinned release from npm without its install scripts (its Android helpers ship built), its skill as a
/// plugin, and the wrapper. Needs Node.js 22.12 or later, as agent-device does.
pub async fn install(home: &Path) -> Result<PathBuf, String> {
    let dir = install_dir(home);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let out = tokio::process::Command::new("npm")
        .args([
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefix",
        ])
        .arg(&dir)
        .arg(format!("agent-device@{VERSION}"))
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("cannot run npm (Node.js) to install agent-device: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err
            .chars()
            .rev()
            .take(400)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("installing agent-device failed: {tail}"));
    }
    if !entry(home).is_file() {
        return Err("the agent-device package has no bin/agent-device.mjs".to_owned());
    }
    let skill = reqwest::get(SKILL_URL)
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("cannot download agent-device's skill: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("cannot download agent-device's skill: {e}"))?;
    let digest: String = sha2::Sha256::digest(&skill)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if digest != SKILL_SHA256 {
        return Err(format!(
            "agent-device's skill is not the pinned one (digest {digest})"
        ));
    }
    make_plugin(&String::from_utf8_lossy(&skill), &plugin_dir(home))?;
    let bin = bin_dir(home);
    std::fs::create_dir_all(&bin).map_err(|e| format!("cannot make {}: {e}", bin.display()))?;
    let wrapper = bin.join("agent-device");
    crate::node::secrets::write_atomic(&wrapper, wrapper_script(&entry(home)).as_bytes())
        .map_err(|e| format!("cannot write {}: {e}", wrapper.display()))?;
    std::fs::set_permissions(
        &wrapper,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(dir.join("VERSION"), VERSION).map_err(|e| e.to_string())?;
    Ok(wrapper)
}

/// The wrapper: refuses while the session's control file says a person has the device, else runs agent-device.
pub fn wrapper_script(entry: &Path) -> String {
    let quoted = entry.to_string_lossy().replace('\'', r"'\''");
    let paused = PAUSED.replace('\'', r"'\''");
    format!(
        "#!/bin/sh\n\
         # fleetd's: agent-device {VERSION}, pointed at this session's emulator.\n\
         if [ -n \"$FLEETD_DEVICE_CONTROL\" ] && [ -e \"$FLEETD_DEVICE_CONTROL\" ]; then\n  \
         echo '{paused}' >&2\n  exit 75\nfi\n\
         exec node '{quoted}' \"$@\"\n"
    )
}

/// The plugin that gives sessions agent-device's own skill (`--plugin-dir`).
pub fn plugin_dir(home: &Path) -> PathBuf {
    install_dir(home).join("plugin")
}

fn make_plugin(skill: &str, plugin: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(plugin);
    let skills = plugin.join("skills").join("agent-device");
    std::fs::create_dir_all(&skills).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(plugin.join(".claude-plugin")).map_err(|e| e.to_string())?;
    let manifest = json!({
        "name": "agent-device",
        "description": "agent-device's skill, for the Android session fleetd opens with session_start kind android.",
    });
    std::fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        format!("{manifest}\n"),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(skills.join("SKILL.md"), skill).map_err(|e| e.to_string())
}

/// An agent session's own agent-device home: its config, and its state (daemon, logs) below it.
pub fn session_dir(home: &Path, thread: &str) -> PathBuf {
    home.join("sessions").join(thread).join("agent-device")
}

/// The file whose presence tells the wrapper a person has control.
pub fn control_path(home: &Path, thread: &str) -> PathBuf {
    home.join("sessions").join(thread).join("device-control")
}

/// Points the session's agent-device at its emulator.
pub fn write_config(home: &Path, thread: &str, serial: &str) -> std::io::Result<()> {
    let dir = session_dir(home, thread);
    crate::node::config::mkdir_private(&dir)?;
    let config = json!({ "platform": "android", "serial": serial });
    crate::node::secrets::write_atomic(&dir.join("config.json"), format!("{config}\n").as_bytes())
}

/// Ends the session's agent-device daemon, if one runs, and drops the config naming its emulator.
pub fn release(home: &Path, thread: &str) {
    let dir = session_dir(home, thread);
    let state = dir.join("state");
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
    let _ = std::fs::remove_file(dir.join("config.json"));
    let _ = std::fs::remove_file(control_path(home, thread));
}

/// What a session's claude gets in its environment: the wrapper and adb first on PATH, its own agent-device home and
/// state, and the control file the wrapper checks.
pub fn env(home: &Path, thread: &str, path: Option<&str>) -> Vec<(String, String)> {
    let sdk = super::sdk::Sdk::at(home);
    let tools = sdk
        .adb
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bin = format!("{}:{tools}", bin_dir(home).to_string_lossy());
    let path = match path.filter(|p| !p.is_empty()) {
        Some(path) => format!("{bin}:{path}"),
        None => bin,
    };
    let dir = session_dir(home, thread);
    let lossy = |p: &Path| p.to_string_lossy().into_owned();
    vec![
        ("PATH".to_owned(), path),
        ("ANDROID_HOME".to_owned(), lossy(&sdk.root)),
        ("ANDROID_SDK_ROOT".to_owned(), lossy(&sdk.root)),
        ("AGENT_DEVICE_HOME".to_owned(), lossy(&dir)),
        (
            "AGENT_DEVICE_STATE_DIR".to_owned(),
            lossy(&dir.join("state")),
        ),
        (
            "FLEETD_DEVICE_CONTROL".to_owned(),
            lossy(&control_path(home, thread)),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_finds_the_wrapper_and_adb_first_and_its_own_home() {
        let env = env(Path::new("/n"), "s1", Some("/usr/bin"));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(
            get("PATH"),
            Some("/n/device/agent-device/bin:/n/device/sdk/platform-tools:/usr/bin")
        );
        assert_eq!(
            get("AGENT_DEVICE_HOME"),
            Some("/n/sessions/s1/agent-device")
        );
        assert_eq!(
            get("AGENT_DEVICE_STATE_DIR"),
            Some("/n/sessions/s1/agent-device/state")
        );
        assert_eq!(get("ANDROID_HOME"), Some("/n/device/sdk"));
        assert_eq!(
            get("FLEETD_DEVICE_CONTROL"),
            Some("/n/sessions/s1/device-control")
        );
    }

    #[test]
    fn the_config_names_the_lent_emulator_and_release_drops_it() {
        let home = tempfile::tempdir().unwrap();
        write_config(home.path(), "s1", "emulator-5556").unwrap();
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(session_dir(home.path(), "s1").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            config,
            json!({ "platform": "android", "serial": "emulator-5556" })
        );
        std::fs::write(control_path(home.path(), "s1"), "human").unwrap();
        release(home.path(), "s1");
        assert!(!session_dir(home.path(), "s1").join("config.json").exists());
        assert!(!control_path(home.path(), "s1").exists());
    }

    #[test]
    fn the_wrapper_refuses_while_a_person_has_control() {
        let dir = tempfile::tempdir().unwrap();
        // A stand-in for agent-device that says what it was asked.
        let fake = dir.path().join("fake's agent-device.mjs");
        std::fs::write(
            &fake,
            "console.log('ran', process.argv.slice(2).join(' '))\n",
        )
        .unwrap();
        let wrapper = dir.path().join("agent-device");
        std::fs::write(&wrapper, wrapper_script(&fake)).unwrap();
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
        if which_node() {
            assert!(ran.status.success(), "{ran:?}");
            assert_eq!(
                String::from_utf8_lossy(&ran.stdout).trim(),
                "ran open settings"
            );
        }
    }

    fn which_node() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[test]
    fn its_skill_becomes_a_plugin_sessions_load() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("plugin");
        make_plugin(
            "---\nname: agent-device\n---\nagent-device open <app>\n",
            &plugin,
        )
        .unwrap();
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "agent-device");
        assert!(plugin.join("skills/agent-device/SKILL.md").is_file());
        assert_eq!(find(dir.path()), None, "not installed");
    }
}
