//! Setup: `fleetd init` and `fleetd uninstall` on the hub machine, `fleetd machine add|remove` for workers.

pub mod machine;
pub mod machine_plan;
pub mod ssh;
pub mod state;
pub mod t3_settings;
pub mod units;

use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use ssh::run_local;
use state::{is_noreply, parse_git_identity, read_setup, write_setup};
use units::{
    Dirs, Platform, Role, ServiceManager, ServiceSpec, render_unit, unit_path, unit_suffix,
};

/// The npm `t3` release built from the pinned T3 commit (vendor/t3/pin.json): what `machine add` installs.
pub const T3_NPM_VERSION: &str = env!("FLEETD_T3_NPM_VERSION");

/// Where `hub start` listens unless told otherwise (the hub's own default).
pub const DEFAULT_LISTEN: &str = "127.0.0.1:4790";

pub const SETUP_USAGE: &str = r#"  init [--home <dir>] [--listen <host:port>] [--url <url>]
       [--git-identity "Name <email>"] [--no-service] [--unit-suffix <s>]
             set up this machine as the hub: home (default ~/.fleetd/hub) and a user service
             (systemd or launchd) that keeps it running, reached at --url (default http://<listen>);
             --git-identity is the commit author for every machine (the GitHub noreply address
             for public repos); --no-service prepares everything but leaves starting it to you
  uninstall [--home <dir>] [--purge]
             stop and remove the hub's service; its data stays unless --purge
"#;

pub(crate) fn say(line: &str) {
    eprintln!("{line}");
}

fn fail(message: &str) -> u8 {
    say(&format!("fleetd: {message}"));
    1
}

fn usage(message: &str) -> u8 {
    say(&format!("fleetd: {message}\n\nusage:\n{SETUP_USAGE}"));
    2
}

pub(crate) fn mkdir_private(dir: &Path) -> Result<(), String> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("cannot create {}: {e}", dir.display()))
}

/// Writes `text` to a new or existing file, creating it 0600.
pub(crate) fn write_private(file: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| format!("cannot write {}: {e}", file.display()))
}

pub fn local_platform() -> Option<Platform> {
    match std::env::consts::OS {
        "linux" => Some(Platform::Linux),
        "macos" => Some(Platform::Darwin),
        _ => None,
    }
}

pub struct LocalDirs {
    pub home: String,
    pub config_home: String,
}

pub fn local_dirs() -> LocalDirs {
    let home = super::home_dir().to_string_lossy().into_owned();
    let config_home = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{home}/.config"));
    LocalDirs { home, config_home }
}

/// This user's uid, from `id -u` (no libc call, so no `unsafe`).
pub fn local_uid() -> u32 {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

/// `host:port`, `:port` or `port`; IPv6 hosts in brackets, as in `[::1]:4790`.
pub fn parse_listen(value: &str) -> Option<(String, u16)> {
    let (raw_host, raw_port) = match value.rfind(':') {
        Some(colon) => (&value[..colon], &value[colon + 1..]),
        None => ("", value),
    };
    if raw_port.is_empty() || !raw_port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u32 = raw_port.parse().ok()?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    let host = raw_host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(raw_host);
    Some((
        if host.is_empty() {
            "127.0.0.1".into()
        } else {
            host.into()
        },
        port as u16,
    ))
}

#[derive(PartialEq, Eq)]
pub enum Probe {
    Hub,
    Other,
    Free,
}

/// What answers at `http://host:port/healthz`: a fleetd hub, something else, or nothing.
pub async fn probe_listen(listen: &(String, u16)) -> Probe {
    let host = if listen.0.contains(':') {
        format!("[{}]", listen.0)
    } else {
        listen.0.clone()
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return Probe::Other;
    };
    match client
        .get(format!("http://{host}:{}/healthz", listen.1))
        .send()
        .await
    {
        Ok(response) => {
            let ok = response.status().is_success();
            let body: Option<serde_json::Value> = response.json().await.ok();
            if ok
                && body.is_some_and(|b| b.get("protocol").is_some_and(serde_json::Value::is_number))
            {
                Probe::Hub
            } else {
                Probe::Other
            }
        }
        Err(error) => {
            let mut source: Option<&dyn std::error::Error> = Some(&error);
            while let Some(cause) = source {
                if cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
                {
                    return Probe::Free;
                }
                source = cause.source();
            }
            Probe::Other
        }
    }
}

/// PIDs (other than this one) with `file` open: the hub keeps hub.sqlite open while it runs.
pub fn processes_holding(file: &Path) -> Vec<u32> {
    let me = std::process::id();
    if cfg!(target_os = "linux") {
        let mut held = Vec::new();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return held;
        };
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            if pid == me {
                continue;
            }
            // Not ours to read, or gone: skipped.
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            if fds
                .flatten()
                .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|target| target == file))
            {
                held.push(pid);
            }
        }
        held.sort_unstable();
        return held;
    }
    std::process::Command::new("lsof")
        .arg("-t")
        .arg(file)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| {
            text.lines()
                .filter_map(|l| l.parse::<u32>().ok())
                .filter(|pid| *pid != me)
                .collect()
        })
        .unwrap_or_default()
}

async fn sh(command: &str) -> Result<(), String> {
    say(&format!("  $ {command}"));
    let result = run_local("/bin/sh", &["-c".to_owned(), command.to_owned()], None).await;
    if result.code != 0 {
        return Err(format!(
            "{command} failed (exit {}): {}",
            result.code,
            result.stderr.trim()
        ));
    }
    Ok(())
}

/// The hub service runs this very binary.
pub fn hub_service_spec(
    home: &str,
    listen: &str,
    suffix: &str,
    exe: &str,
    path: &str,
    user_home: &str,
) -> ServiceSpec {
    ServiceSpec {
        role: Role::Hub,
        suffix: suffix.into(),
        description: "fleetd hub".into(),
        program: [exe, "hub", "start", "--home", home, "--listen", listen]
            .map(String::from)
            .to_vec(),
        // The hub runs gh, git and `claude -p`, so it keeps the PATH it was set up from.
        env: vec![
            ("HOME".into(), user_home.into()),
            ("PATH".into(), path.into()),
            ("LANG".into(), "C.UTF-8".into()),
        ],
        env_file: None,
        working_directory: home.into(),
        log_path: format!("{home}/hub.log"),
    }
}

/// The running executable, symlinks resolved.
pub fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|error| format!("cannot find the running fleetd executable: {error}"))
}

async fn init_command(argv: &[String]) -> u8 {
    const OPTIONS: &[(&str, Kind)] = &[
        ("home", Kind::Str),
        ("listen", Kind::Str),
        ("url", Kind::Str),
        ("git-identity", Kind::Str),
        ("no-service", Kind::Bool),
        ("unit-suffix", Kind::Str),
    ];
    let v = match args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let home = match resolve_home(v.str("home")) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let previous = match read_setup(&home) {
        Ok(previous) => previous,
        Err(message) => return fail(&message),
    };
    let listen_text = v
        .string("listen")
        .or_else(|| previous.as_ref().map(|p| p.listen.clone()))
        .unwrap_or_else(|| DEFAULT_LISTEN.to_owned());
    let Some(listen) = parse_listen(&listen_text) else {
        return usage(&format!("--listen must be host:port, got '{listen_text}'"));
    };
    let url = v
        .string("url")
        .or_else(|| previous.as_ref().map(|p| p.url.clone()))
        .unwrap_or_else(|| format!("http://{listen_text}"));
    if reqwest::Url::parse(&url).is_err() {
        return usage(&format!(
            "--url must be the hub's address, e.g. https://forge.tailnet.ts.net, got '{url}'"
        ));
    }
    let identity = match v.str("git-identity") {
        None => previous.as_ref().and_then(|p| p.git_identity.clone()),
        Some(text) => match parse_git_identity(text) {
            Some(identity) => Some(identity),
            None => {
                return usage(&format!(
                    "--git-identity must look like \"Name <email>\", got '{text}'"
                ));
            }
        },
    };
    let suffix = match v.str("unit-suffix") {
        None => previous
            .as_ref()
            .map(|p| p.unit_suffix.clone())
            .unwrap_or_default(),
        Some(text) => match unit_suffix(Some(text)) {
            Some(suffix) => suffix,
            None => {
                return usage(&format!(
                    "--unit-suffix takes letters, digits and dashes, got '{text}'"
                ));
            }
        },
    };
    let with_service = !v.flag("no-service");
    let platform = local_platform();
    if with_service && platform.is_none() {
        return fail(&format!(
            "fleetd runs the hub as a systemd or launchd service, not on {}; use --no-service and run fleetd hub start yourself",
            std::env::consts::OS
        ));
    }

    let holders = processes_holding(&home.join("hub.sqlite"));
    if !holders.is_empty() {
        return fail(&format!(
            "a hub already runs on {} (pid {}); stop it first (fleetd uninstall keeps its data)",
            home.display(),
            holders
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    match probe_listen(&listen).await {
        Probe::Free => {}
        Probe::Hub => return fail(&format!("a fleetd hub already answers at {listen_text}")),
        Probe::Other => {
            return fail(&format!(
                "{listen_text} is in use by something else; pick another --listen"
            ));
        }
    }

    if let Err(message) = mkdir_private(&home) {
        return fail(&message);
    }
    let home_text = home.to_string_lossy().into_owned();
    say(&format!("hub home {home_text}"));
    let state = state::SetupState {
        listen: listen_text.clone(),
        url: url.clone(),
        unit_suffix: suffix.clone(),
        git_identity: identity.clone(),
        machines: previous.map(|p| p.machines).unwrap_or_default(),
    };
    if let Err(message) = write_setup(&home, &state) {
        return fail(&message);
    }
    match &identity {
        None => say(
            r#"no commit identity yet: add one with --git-identity "Name <id+user@users.noreply.github.com>" before adding machines"#,
        ),
        Some(id) => say(&format!(
            "commit identity {} <{}>{}",
            id.name,
            id.email,
            if is_noreply(id) {
                ""
            } else {
                " (not a GitHub noreply address: commits in public repos will show it)"
            }
        )),
    }

    if let (true, Some(platform)) = (with_service, platform) {
        let exe = match current_exe() {
            Ok(exe) => exe,
            Err(message) => return fail(&message),
        };
        let exe_dir = exe
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        let path = format!("{exe_dir}:{}", std::env::var("PATH").unwrap_or_default());
        let dirs = local_dirs();
        let spec = hub_service_spec(
            &home_text,
            &listen_text,
            &suffix,
            &exe.to_string_lossy(),
            &path,
            &dirs.home,
        );
        let file = unit_path(
            platform,
            &Dirs {
                home: &dirs.home,
                config_home: &dirs.config_home,
            },
            Role::Hub,
            &suffix,
        );
        let text = render_unit(platform, &spec);
        let existing = std::fs::read_to_string(&file).ok();
        let changed = existing.as_deref() != Some(text.as_str());
        let written = Path::new(&file)
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&file, &text))
            .map_err(|error| format!("cannot write {file}: {error}"));
        if let Err(message) = written {
            return fail(&message);
        }
        say(&format!(
            "{} {file}",
            if changed { "wrote" } else { "kept" }
        ));
        let services = ServiceManager::new(platform, local_uid(), &suffix, |_| file.clone());
        if let Err(message) = sh(&services.restart(Role::Hub, changed && existing.is_some())).await
        {
            return fail(&message);
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while probe_listen(&listen).await != Probe::Hub {
            if Instant::now() > deadline {
                return fail(&format!(
                    "the hub service did not answer at {listen_text} within 30 s; see {}",
                    spec.log_path
                ));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        say(&format!(
            "the hub runs as a service and answers at {listen_text}"
        ));
    } else {
        say(&format!(
            "not installing a service; run the hub yourself with:\n  fleetd hub start --home {home_text} --listen {listen_text}"
        ));
    }

    say(&format!(
        "next: fleetd hub key create --human --name <device> prints the key the desktop app connects to {url} with"
    ));
    say("then: fleetd machine add <ssh-host> for each machine that runs agents");
    0
}

async fn uninstall_command(argv: &[String]) -> u8 {
    let v = match args::parse(
        argv,
        &Spec {
            options: &[("home", Kind::Str), ("purge", Kind::Bool)],
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let home = match resolve_home(v.str("home")) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let state = match read_setup(&home) {
        Ok(state) => state,
        Err(message) => return fail(&message),
    };
    if let Some(platform) = local_platform() {
        let suffix = state
            .as_ref()
            .map(|s| s.unit_suffix.clone())
            .unwrap_or_default();
        let dirs = local_dirs();
        let file = unit_path(
            platform,
            &Dirs {
                home: &dirs.home,
                config_home: &dirs.config_home,
            },
            Role::Hub,
            &suffix,
        );
        if Path::new(&file).exists() {
            let uid = local_uid();
            if let Err(message) = sh(
                &ServiceManager::new(platform, uid, &suffix, |_| file.clone()).remove(Role::Hub),
            )
            .await
            {
                return fail(&message);
            }
            if let Err(error) = std::fs::remove_file(&file) {
                return fail(&format!("cannot remove {file}: {error}"));
            }
            say(&format!("removed {file}"));
            if platform == Platform::Linux {
                let _ = sh(&format!(
                    "XDG_RUNTIME_DIR=/run/user/{uid} systemctl --user daemon-reload"
                ))
                .await;
            }
        } else {
            say(&format!("no hub service at {file}"));
        }
    }
    let machines: Vec<&str> = state
        .iter()
        .flat_map(|s| s.machines.keys().map(String::as_str))
        .collect();
    if !machines.is_empty() {
        say(&format!(
            "machines still set up from this hub: {} (fleetd machine remove <id> undoes each)",
            machines.join(", ")
        ));
    }
    let home_text = home.display();
    if !v.flag("purge") {
        say(&format!(
            "kept the hub's data in {home_text}; fleetd init starts it again, --purge deletes it"
        ));
        return 0;
    }
    if !home.join("hub.sqlite").exists() && state.is_none() {
        return fail(&format!(
            "{home_text} does not look like a hub home (no hub.sqlite or setup.json); not deleting it"
        ));
    }
    let holders = processes_holding(&home.join("hub.sqlite"));
    if !holders.is_empty() {
        return fail(&format!(
            "a hub still runs on {home_text} (pid {}); stop it before --purge",
            holders
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Err(error) = std::fs::remove_dir_all(&home)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        return fail(&format!("cannot delete {home_text}: {error}"));
    }
    say(&format!("deleted {home_text}"));
    0
}

/// `fleetd init` and `fleetd uninstall`.
pub async fn setup_command(command: &str, argv: &[String]) -> u8 {
    if command == "init" {
        init_command(argv).await
    } else {
        uninstall_command(argv).await
    }
}
