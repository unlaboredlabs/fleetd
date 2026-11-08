//! The hub and node services `fleetd init` created for a binary, and restarting one (`systemctl --user restart`,
//! `launchctl kickstart -k`).
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A hub or node service `fleetd init` created for this binary.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Service {
    /// The unit file's name, e.g. `fleetd-hub.service` or `sh.fleetd.node.plist`.
    pub name: String,
    /// The name between prefix and extension: `hub`, `node`.
    pub unit: String,
}

impl Service {
    pub fn hub(&self) -> bool {
        self.unit.starts_with("hub")
    }
}

pub fn unit_affixes() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("sh.fleetd.", ".plist")
    } else {
        ("fleetd-", ".service")
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// The hub and node services `fleetd init` created for `exe`: the unit files whose command line names it, hubs first.
/// A lab's units, which run another binary, are left alone.
pub fn services(exe: &Path) -> Vec<Service> {
    services_in(&unit_dir(), exe)
}

/// Where the user's service manager reads the unit files `fleetd init` wrote.
pub fn unit_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/LaunchAgents")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"))
            .join("systemd/user")
    }
}

pub fn services_in(dir: &Path, exe: &Path) -> Vec<Service> {
    let exe = exe.to_string_lossy();
    let (prefix, ext) = unit_affixes();
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    let mut found: Vec<Service> = names
        .into_iter()
        .filter_map(|name| {
            let unit = name.strip_prefix(prefix)?.strip_suffix(ext)?.to_owned();
            let ours = (unit.starts_with("hub") || unit.starts_with("node"))
                && fs::read_to_string(dir.join(&name)).is_ok_and(|text| text.contains(&*exe));
            ours.then_some(Service { name, unit })
        })
        .collect();
    found.sort_by_key(|s| !s.hub());
    found
}

fn uid() -> Option<String> {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// What a non-PAM SSH session lacks for `systemctl --user` and `systemd-run --user`: without XDG_RUNTIME_DIR they
/// find no manager.
fn user_manager(mut c: Command) -> Command {
    if std::env::var_os("XDG_RUNTIME_DIR").is_none()
        && let Some(uid) = uid()
    {
        c.env("XDG_RUNTIME_DIR", format!("/run/user/{uid}"));
    }
    c
}

/// Restarts one service; the error is one plain reason.
pub fn restart(service: &Service) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "macos") {
        let (prefix, _) = unit_affixes();
        let mut c = Command::new("launchctl");
        c.args([
            "kickstart",
            "-k",
            &format!("gui/{}/{prefix}{}", uid().unwrap_or_default(), service.unit),
        ]);
        c
    } else {
        let mut c = user_manager(Command::new("systemctl"));
        c.args(["--user", "restart", &service.name]);
        c
    };
    match cmd.stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("restarting {} exited with {s}", service.name)),
        Err(e) => Err(format!("couldn't restart {}: {e}", service.name)),
    }
}

/// At a hub's or node's start under its systemd user unit: the unit rewritten from today's template when it was
/// written by an older fleetd (an update swaps only the binary, so the settings added since never reached it), and
/// enabled when it isn't, so the service starts at the next boot (a missing boot link left the devbox's node down for
/// 16 hours). Run by the new binary after an update's restart, so the update applies it; a rewritten unit takes effect
/// at the next restart. Off Linux, outside such a unit, or with a unit edited by hand, nothing changes.
pub fn refresh_own_unit() {
    if !cfg!(target_os = "linux") {
        return;
    }
    let Some(name) = std::fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|c| crate::node::runner::scope::own_unit(&c))
    else {
        return;
    };
    let Some(service) = std::env::current_exe()
        .ok()
        .and_then(|exe| services(&exe).into_iter().find(|s| s.name == name))
    else {
        return;
    };
    match rewrite(&unit_dir().join(&service.name), &service) {
        Ok(false) => {}
        Ok(true) => match daemon_reload() {
            Ok(()) => tracing::info!(unit = %name, "rewrote the unit from today's template"),
            Err(e) => {
                tracing::warn!(unit = %name, "rewrote the unit from today's template, but {e}")
            }
        },
        Err(e) => tracing::warn!(unit = %name, "couldn't rewrite the unit: {e}"),
    }
    if let Err(e) = enable(&service.name) {
        tracing::warn!(unit = %name, "it may not start at the next boot: {e}");
    }
}

/// Rewrites the unit at `path` from today's template; whether it changed.
fn rewrite(path: &Path, service: &Service) -> Result<bool, String> {
    use crate::cli::setup::units::{Role, refresh_systemd_unit};
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let role = if service.hub() { Role::Hub } else { Role::Node };
    let Some(fresh) = refresh_systemd_unit(&text, role) else {
        return Ok(false);
    };
    let staged = path.with_extension("service.new");
    fs::write(&staged, fresh)
        .and_then(|()| fs::rename(&staged, path))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Enables `name` when `systemctl --user is-enabled` says it isn't.
fn enable(name: &str) -> Result<(), String> {
    let run = |args: &[&str]| {
        let mut cmd = user_manager(Command::new("systemctl"));
        cmd.arg("--user").args(args);
        cmd.stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
    if run(&["is-enabled", "--quiet", name]).is_ok_and(|s| s.success()) {
        return Ok(());
    }
    match run(&["enable", name]) {
        Ok(s) if s.success() => {
            tracing::info!(unit = %name, "enabled the unit, which wasn't, so it starts at boot");
            Ok(())
        }
        Ok(s) => Err(format!("systemctl --user enable {name} exited with {s}")),
        Err(e) => Err(format!("couldn't run systemctl: {e}")),
    }
}

/// Has the systemd user manager read the unit files again; the error is one plain reason.
pub fn daemon_reload() -> Result<(), String> {
    let mut cmd = user_manager(Command::new("systemctl"));
    cmd.args(["--user", "daemon-reload"]);
    match cmd.stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("systemctl --user daemon-reload exited with {s}")),
        Err(e) => Err(format!("couldn't run systemctl: {e}")),
    }
}

/// Starts `program args` outside the calling service, so the service's own restart doesn't end it: a transient
/// systemd user unit on Linux, a new session on macOS (launchd ends a job's process group with the job).
pub fn spawn_outside(program: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "linux") {
        let mut run = user_manager(Command::new("systemd-run"));
        let unit = format!(
            "fleetd-update-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default()
        );
        run.args(["--user", "--collect", "--quiet", "--unit", &unit])
            .arg(program)
            .args(args);
        run
    } else {
        use std::os::unix::process::CommandExt;
        let mut c = Command::new(program);
        c.args(args).process_group(0);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if cfg!(target_os = "linux") {
        match cmd.status() {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(format!("systemd-run exited with {s}")),
            Err(e) => Err(format!("couldn't run systemd-run: {e}")),
        }
    } else {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("couldn't start {}: {e}", program.display()))
    }
}
