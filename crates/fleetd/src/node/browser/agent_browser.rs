//! The tool agents drive their browser with: Vercel's agent-browser, as a CLI (its MCP mode costs ~20k tokens of tool
//! definitions). The node installs it at a pinned version under `<node home>/browser/agent-browser` and puts it first
//! on each session's PATH, pointed at the session's proxy (`AGENT_BROWSER_CDP`), with a daemon of its own per agent
//! session (`AGENT_BROWSER_SESSION`) and an action policy file (`AGENT_BROWSER_ACTION_POLICY`) the node writes.
//!
//! The policy names agent-browser's internal action names (`evaluate`, `inputvalue`): its documented
//! category names (`eval`, `get`) are silently ignored by 0.39.x, which the tests check against the real binary.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::json;

/// The agent-browser release the node installs.
pub const VERSION: &str = "0.39.4";

/// Where it goes.
pub fn install_dir(home: &Path) -> PathBuf {
    home.join("browser").join("agent-browser")
}

/// The directory put first on a session's PATH: it holds only `agent-browser`.
pub fn bin_dir(home: &Path) -> PathBuf {
    install_dir(home).join("bin")
}

fn platform_binary() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("agent-browser-linux-x64"),
        ("linux", "aarch64") => Some("agent-browser-linux-arm64"),
        ("macos", "aarch64") => Some("agent-browser-darwin-arm64"),
        ("macos", "x86_64") => Some("agent-browser-darwin-x64"),
        _ => None,
    }
}

/// The installed binary, when it is the pinned version. An install from before the node set its exec bit gets it
/// here, as the node starts or a session needs it; one that can't be made executable is not found, so it is installed
/// again.
pub fn find(home: &Path) -> Option<PathBuf> {
    let bin = bin_dir(home).join("agent-browser");
    let version = std::fs::read_to_string(install_dir(home).join("VERSION")).ok()?;
    if version.trim() != VERSION || !bin.is_file() {
        return None;
    }
    match make_executable(&bin) {
        Ok(()) => Some(bin),
        Err(why) => {
            tracing::warn!(error = %why, "agent-browser not executable");
            None
        }
    }
}

/// Sets the native binary's exec bits (through the link): npm unpacks the package's binaries without them, and the
/// package's own postinstall, which sets them, doesn't run (`--ignore-scripts`).
fn make_executable(native: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(native)
        .map_err(|e| format!("cannot read {}: {e}", native.display()))?
        .permissions()
        .mode();
    if mode & 0o111 == 0o111 {
        return Ok(());
    }
    std::fs::set_permissions(native, std::fs::Permissions::from_mode(mode | 0o111))
        .map_err(|e| format!("cannot make {} executable: {e}", native.display()))
}

/// Installs the pinned release from npm, without running its install scripts: the package carries a native binary
/// for each platform, and the node makes the one for this machine executable and links it. Blocking.
pub fn install(home: &Path) -> Result<PathBuf, String> {
    let dir = install_dir(home);
    let Some(name) = platform_binary() else {
        return Err(format!(
            "agent-browser has no build for {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
    let out = std::process::Command::new("npm")
        .args([
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefix",
        ])
        .arg(&dir)
        .arg(format!("agent-browser@{VERSION}"))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run npm (Node.js) to install agent-browser: {e}"))?;
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
        return Err(format!("installing agent-browser failed: {tail}"));
    }
    link(home, name)
}

/// Makes the installed package's native binary `name` executable and links it as the session's `agent-browser`,
/// with its skill as a plugin.
fn link(home: &Path, name: &str) -> Result<PathBuf, String> {
    let dir = install_dir(home);
    let native = dir.join("node_modules/agent-browser/bin").join(name);
    if !native.is_file() {
        return Err(format!("the agent-browser package has no {name}"));
    }
    make_executable(&native)?;
    let bin = bin_dir(home);
    std::fs::create_dir_all(&bin).map_err(|e| format!("cannot make {}: {e}", bin.display()))?;
    let link = bin.join("agent-browser");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&native, &link)
        .map_err(|e| format!("cannot link {}: {e}", link.display()))?;
    make_plugin(
        &dir.join("node_modules/agent-browser/skills/agent-browser"),
        &plugin_dir(home),
    )?;
    std::fs::write(dir.join("VERSION"), VERSION).map_err(|e| e.to_string())?;
    Ok(link)
}

/// The plugin that gives sessions agent-browser's own skill (`--plugin-dir`): its stub, which sends the agent to
/// `agent-browser skills get core`, the guide for the installed version.
pub fn plugin_dir(home: &Path) -> PathBuf {
    install_dir(home).join("plugin")
}

fn make_plugin(skill: &Path, plugin: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(skill.join("SKILL.md"))
        .map_err(|e| format!("the agent-browser package has no skill: {e}"))?;
    let _ = std::fs::remove_dir_all(plugin);
    let skills = plugin.join("skills").join("agent-browser");
    std::fs::create_dir_all(&skills).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(plugin.join(".claude-plugin")).map_err(|e| e.to_string())?;
    let manifest = json!({
        "name": "agent-browser",
        "description": "agent-browser's skill, for the browser session fleetd opens with session_start.",
    });
    std::fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        format!("{manifest}\n"),
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(skills.join("SKILL.md"), text).map_err(|e| e.to_string())
}

/// The actions every session denies: connecting to a browser other than the session's. (`launch` can't be denied:
/// agent-browser names attaching to `AGENT_BROWSER_CDP` so too.)
pub const ALWAYS_DENIED: &[&str] = &["connect"];

/// And those a session that filled a credential denies too: anything that reads a value back.
pub const CREDENTIAL_DENIED: &[&str] = &["evaluate", "inputvalue", "addinitscript", "addscript"];

/// The policy file's text for a session, with credentials filled or not.
pub fn policy(credentials: bool) -> String {
    let mut deny: Vec<&str> = ALWAYS_DENIED.to_vec();
    if credentials {
        deny.extend(CREDENTIAL_DENIED);
    }
    format!("{}\n", json!({ "default": "allow", "deny": deny }))
}

/// Where a session's policy file is.
pub fn policy_path(home: &Path, thread: &str) -> PathBuf {
    home.join("sessions")
        .join(thread)
        .join("agent-browser-policy.json")
}

pub fn write_policy(home: &Path, thread: &str, credentials: bool) -> std::io::Result<()> {
    let path = policy_path(home, thread);
    if let Some(dir) = path.parent() {
        crate::node::config::mkdir_private(dir)?;
    }
    crate::node::secrets::write_atomic(&path, policy(credentials).as_bytes())
}

/// What a session's claude gets in its environment: agent-browser first on PATH, pointed at the session's proxy
/// with its own daemon and policy.
pub fn env(home: &Path, thread: &str, cdp: &str, path: Option<&str>) -> Vec<(String, String)> {
    let bin = bin_dir(home).to_string_lossy().into_owned();
    let path = match path.filter(|p| !p.is_empty()) {
        Some(path) => format!("{bin}:{path}"),
        None => bin,
    };
    vec![
        ("PATH".to_owned(), path),
        ("AGENT_BROWSER_CDP".to_owned(), cdp.to_owned()),
        (
            "AGENT_BROWSER_SESSION".to_owned(),
            format!("fleetd-{thread}"),
        ),
        (
            "AGENT_BROWSER_ACTION_POLICY".to_owned(),
            policy_path(home, thread).to_string_lossy().into_owned(),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_names_agent_browsers_internal_actions() {
        let open: serde_json::Value = serde_json::from_str(&policy(false)).unwrap();
        assert_eq!(open["default"], "allow");
        assert!(open["deny"].as_array().unwrap().contains(&json!("connect")));
        assert!(
            !open["deny"].as_array().unwrap().contains(&json!("launch")),
            "attaching is a launch"
        );
        assert!(
            !open["deny"]
                .as_array()
                .unwrap()
                .contains(&json!("evaluate"))
        );
        let sealed: serde_json::Value = serde_json::from_str(&policy(true)).unwrap();
        for action in ["evaluate", "inputvalue"] {
            assert!(
                sealed["deny"].as_array().unwrap().contains(&json!(action)),
                "{action}"
            );
        }
        // The documented categories do nothing in 0.39.x; they must not stand in for the real names.
        assert!(!sealed["deny"].as_array().unwrap().contains(&json!("eval")));
    }

    #[test]
    fn its_skill_becomes_a_plugin_sessions_load() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join("package/skills/agent-browser");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: agent-browser\n---\nRun skills get core.\n",
        )
        .unwrap();
        let plugin = dir.path().join("plugin");
        make_plugin(&skill, &plugin).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "agent-browser");
        assert!(
            std::fs::read_to_string(plugin.join("skills/agent-browser/SKILL.md"))
                .unwrap()
                .contains("skills get core")
        );
        // Not the pinned version: not found, so the node installs it again.
        assert_eq!(find(dir.path()), None);
    }

    /// A stand-in for the package's native binary, as npm leaves it: a script without its exec bit.
    fn package_without_exec_bit(home: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let package = install_dir(home).join("node_modules/agent-browser");
        let native = package.join("bin").join(platform_binary().unwrap());
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "#!/bin/sh\necho agent-browser $1\n").unwrap();
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o644)).unwrap();
        let skill = package.join("skills/agent-browser");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: agent-browser\n---\n").unwrap();
        native
    }

    /// Runs `agent-browser --version`, past ETXTBSY: another test's fork may still hold the script open for a moment.
    fn run(bin: &Path) -> std::io::Result<std::process::Output> {
        for _ in 0..50 {
            match std::process::Command::new(bin).arg("--version").output() {
                Err(e) if e.raw_os_error() == Some(26) => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                other => return other,
            }
        }
        std::process::Command::new(bin).arg("--version").output()
    }

    #[test]
    fn an_install_on_devbox_leaves_agent_browser_executable() {
        let home = tempfile::tempdir().unwrap();
        package_without_exec_bit(home.path());
        let bin = link(home.path(), platform_binary().unwrap()).unwrap();
        assert_eq!(find(home.path()), Some(bin.clone()));
        let out = run(&bin).expect("agent-browser runs");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "agent-browser --version\n"
        );
    }

    #[test]
    fn an_existing_install_without_the_exec_bit_is_repaired_when_the_node_finds_it() {
        let home = tempfile::tempdir().unwrap();
        // devbox's install from before: linked and versioned, its binary as npm left it.
        let native = package_without_exec_bit(home.path());
        std::fs::create_dir_all(bin_dir(home.path())).unwrap();
        let bin = bin_dir(home.path()).join("agent-browser");
        std::os::unix::fs::symlink(&native, &bin).unwrap();
        std::fs::write(install_dir(home.path()).join("VERSION"), VERSION).unwrap();
        assert_eq!(find(home.path()), Some(bin.clone()));
        let out = run(&bin).expect("agent-browser runs");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            "agent-browser --version\n"
        );
    }

    #[test]
    fn a_session_finds_agent_browser_first_and_its_own_proxy() {
        let env = env(
            Path::new("/n"),
            "s1",
            "ws://127.0.0.1:9/devtools/browser/t",
            Some("/usr/bin"),
        );
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PATH"), Some("/n/browser/agent-browser/bin:/usr/bin"));
        assert_eq!(
            get("AGENT_BROWSER_CDP"),
            Some("ws://127.0.0.1:9/devtools/browser/t")
        );
        assert_eq!(get("AGENT_BROWSER_SESSION"), Some("fleetd-s1"));
        assert_eq!(
            get("AGENT_BROWSER_ACTION_POLICY"),
            Some("/n/sessions/s1/agent-browser-policy.json")
        );
    }
}
