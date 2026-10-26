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
    /// The name between prefix and extension: `hub`, `node`, with any `--unit-suffix`.
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

/// The hub and node services `fleetd init` created for `exe`: the unit files (their usual names, any `--unit-suffix`)
/// whose command line names it, hubs first. A lab's units, which run another binary, are left alone.
pub fn services(exe: &Path) -> Vec<Service> {
    let dir = if cfg!(target_os = "macos") {
        home().join("Library/LaunchAgents")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"))
            .join("systemd/user")
    };
    services_in(&dir, exe)
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
