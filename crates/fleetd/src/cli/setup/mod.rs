//! Setup: `fleetd init` and `fleetd uninstall` on the hub machine, `fleetd machine add|remove` for workers.

mod checklist;
pub mod claude_check;
pub mod detect;
pub mod doctor;
pub mod machine;
pub mod machine_plan;
pub mod ordered_json;
pub mod ssh;
pub mod state;
pub mod units;
mod wizard;

use std::io::IsTerminal;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use super::args::{self, Kind, Spec};
use super::hub_key::resolve_home;
use ssh::run_local;
use state::{GitIdentity, is_noreply, parse_git_identity, read_setup, write_setup};
use units::{
    Dirs, Platform, Role, ServiceManager, ServiceSpec, render_unit, unit_path, unit_suffix,
};

/// Where `hub start` listens unless told otherwise (the hub's own default).
pub const DEFAULT_LISTEN: &str = "127.0.0.1:4790";

pub const SETUP_USAGE: &str = r#"  init [--yes] [--home <dir>] [--listen <host:port>] [--url <url>]
       [--git-identity "Name <email>"] [--no-service] [--unit-suffix <s>]
             set up fleetd step by step in a terminal: the hub on this machine (home default
             ~/.fleetd/hub, kept running by a systemd or launchd user service), where it listens
             (your tailnet when there is one), the claude and gh logins, the machines that run
             agents, a first project and the desktop app, then fleetd doctor. Run it again to
             check and repair; it keeps what works. --yes takes every default. Without a
             terminal and without --yes it only sets up the hub. --url is how devices reach the
             hub (default http://<listen>); --git-identity is the commit author for every
             machine (the GitHub noreply address for public repos); --no-service prepares
             everything but leaves starting the hub to you
  init --join <hub url> --code <code> [--machine-id <id>] [--git-identity "Name <email>"]
             make this machine a worker of that hub, without SSH from the hub: the command
             fleetd pair --worker prints on the hub
  doctor [--fix] [--home <dir>]
             run every setup check on the hub now and print each problem with its fix;
             --fix also applies the fixes the hub can make by itself
  uninstall [--home <dir>] [--purge]
             stop and remove the hub's service; its data stays unless --purge
"#;

static SAID: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn say(line: &str) {
    SAID.fetch_add(1, Ordering::Relaxed);
    eprintln!("{line}");
}

/// Lines `say` printed so far: the checklist rewrites a step's line only while nothing came after it.
pub(crate) fn said() -> usize {
    SAID.load(Ordering::Relaxed)
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

async fn sh(command: &str, log: &dyn Fn(&str)) -> Result<(), String> {
    log(&format!("  $ {command}"));
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

/// What `fleetd init` was told on its command line, checked; the rest comes from the previous run or the wizard.
pub struct InitOptions {
    pub home: PathBuf,
    pub previous: Option<state::SetupState>,
    pub listen: Option<String>,
    pub url: Option<String>,
    pub identity: Option<GitIdentity>,
    pub suffix: String,
    pub with_service: bool,
    pub yes: bool,
    /// `--join <hub url> --code <code>`: this machine becomes a worker of that hub (`fleetd pair --worker`).
    pub join: Option<(String, String)>,
    pub machine_id: Option<String>,
}

/// Everything `install_hub` writes and starts.
pub struct HubPlan<'a> {
    pub home: &'a Path,
    pub listen: String,
    pub url: String,
    pub suffix: String,
    pub identity: Option<GitIdentity>,
    pub with_service: bool,
}

/// A failed step: what is wrong, and the exact command or action that fixes it.
pub struct Failure {
    pub message: String,
    pub fix: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    Missing,
    Same,
    Changed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HubAction {
    /// Write the unit and (re)start the service.
    Install,
    /// The service runs this very unit and answers: leave it.
    Keep,
    /// No service wanted, and a hub someone started answers here.
    ByHand,
    /// No service wanted, and nothing runs yet.
    NotRunning,
    Refuse {
        message: String,
        fix: String,
    },
}

/// What `fleetd init` does about the hub, from what it found: run again on a working setup it changes nothing.
pub fn hub_action(
    with_service: bool,
    unit: Unit,
    holders: &[u32],
    probe: &Probe,
    listen: &str,
    home: &str,
) -> HubAction {
    let pids = holders
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let busy = |what: &str| HubAction::Refuse {
        message: format!("{listen} is in use by {what}"),
        fix: "pick a free address: fleetd init --listen 127.0.0.1:4791".into(),
    };
    match (with_service, holders.is_empty(), probe) {
        (true, false, _) if unit == Unit::Missing => HubAction::Refuse {
            message: format!("a hub started by hand runs on {home} (pid {pids})"),
            fix: format!(
                "stop it (kill {pids}), then run fleetd init again; or keep running it yourself: fleetd init --no-service"
            ),
        },
        (true, false, Probe::Hub) if unit == Unit::Same => HubAction::Keep,
        (true, false, _) => HubAction::Install,
        (false, false, Probe::Hub) => HubAction::ByHand,
        (false, false, _) => HubAction::Refuse {
            message: format!("a hub runs on {home} (pid {pids}) but does not answer at {listen}"),
            fix: format!(
                "run fleetd init --no-service --listen <the address it listens on>, or stop it (kill {pids})"
            ),
        },
        (_, true, Probe::Free) if with_service => HubAction::Install,
        (_, true, Probe::Free) => HubAction::NotRunning,
        (_, true, Probe::Hub) => busy("another fleetd hub"),
        (_, true, Probe::Other) => busy("something else"),
    }
}

/// The hub home, setup.json and, unless `--no-service`, the user service that runs the hub. `log` gets each
/// command before it runs. Returns how the hub runs now.
pub async fn install_hub(plan: &HubPlan<'_>, log: &dyn Fn(&str)) -> Result<String, Failure> {
    let fail = |message: String| Failure {
        message,
        fix: "fix the cause above, then run fleetd init again".into(),
    };
    let Some(listen) = parse_listen(&plan.listen) else {
        return Err(Failure {
            message: format!("--listen must be host:port, got '{}'", plan.listen),
            fix: "fleetd init --listen 127.0.0.1:4790".into(),
        });
    };
    let home_text = plan.home.to_string_lossy().into_owned();
    let platform = local_platform();
    if plan.with_service && platform.is_none() {
        return Err(Failure {
            message: format!(
                "fleetd runs the hub as a systemd or launchd service, not on {}",
                std::env::consts::OS
            ),
            fix: "fleetd init --no-service, then run fleetd hub start yourself".into(),
        });
    }
    let dirs = local_dirs();
    let unit_file = platform.map(|platform| {
        unit_path(
            platform,
            &Dirs {
                home: &dirs.home,
                config_home: &dirs.config_home,
            },
            Role::Hub,
            &plan.suffix,
        )
    });
    let exe = current_exe().map_err(fail)?;
    let exe_dir = exe
        .parent()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path = format!("{exe_dir}:{}", std::env::var("PATH").unwrap_or_default());
    let spec = hub_service_spec(
        &home_text,
        &plan.listen,
        &plan.suffix,
        &exe.to_string_lossy(),
        &path,
        &dirs.home,
    );
    let text = platform.map(|platform| render_unit(platform, &spec));
    let existing = unit_file
        .as_ref()
        .and_then(|file| std::fs::read_to_string(file).ok());
    let unit = match (&existing, &text) {
        (None, _) => Unit::Missing,
        (Some(old), Some(new)) if old == new => Unit::Same,
        _ => Unit::Changed,
    };
    let holders = processes_holding(&plan.home.join("hub.sqlite"));
    let probe = probe_listen(&listen).await;
    let action = hub_action(
        plan.with_service,
        unit,
        &holders,
        &probe,
        &plan.listen,
        &home_text,
    );
    if let HubAction::Refuse { message, fix } = action {
        return Err(Failure { message, fix });
    }

    mkdir_private(plan.home).map_err(fail)?;
    let state = state::SetupState {
        listen: plan.listen.clone(),
        url: plan.url.clone(),
        unit_suffix: plan.suffix.clone(),
        git_identity: plan.identity.clone(),
        machines: read_setup(plan.home)
            .ok()
            .flatten()
            .map(|p| p.machines)
            .unwrap_or_default(),
    };
    write_setup(plan.home, &state).map_err(fail)?;
    match action {
        HubAction::Keep => {
            return Ok(format!("runs as a service and answers at {}", plan.listen));
        }
        HubAction::ByHand => {
            return Ok(format!("answers at {}; you run it yourself", plan.listen));
        }
        HubAction::NotRunning => {
            return Ok(format!(
                "not started; run it yourself with: fleetd hub start --home {home_text} --listen {}",
                plan.listen
            ));
        }
        _ => {}
    }
    let (Some(platform), Some(file), Some(text)) = (platform, unit_file, text) else {
        unreachable!("Install needs a platform");
    };
    Path::new(&file)
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&file, &text))
        .map_err(|error| fail(format!("cannot write {file}: {error}")))?;
    log(&format!(
        "{} {file}",
        if unit == Unit::Same { "kept" } else { "wrote" }
    ));
    let services = ServiceManager::new(platform, local_uid(), &plan.suffix, |_| file.clone());
    sh(&services.restart(Role::Hub, unit == Unit::Changed), log)
        .await
        .map_err(|message| Failure {
            message,
            fix: if platform == Platform::Linux {
                format!(
                    "systemctl --user status {} shows why",
                    units::systemd_name(Role::Hub, &plan.suffix)
                )
            } else {
                format!("see {}", spec.log_path)
            },
        })?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while probe_listen(&listen).await != Probe::Hub {
        if Instant::now() > deadline {
            return Err(Failure {
                message: format!(
                    "the hub service did not answer at {} within 30 s",
                    plan.listen
                ),
                fix: format!("read {} for why, then run fleetd init again", spec.log_path),
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Ok(format!("runs as a service and answers at {}", plan.listen))
}

const INIT_OPTIONS: &[(&str, Kind)] = &[
    ("home", Kind::Str),
    ("listen", Kind::Str),
    ("url", Kind::Str),
    ("git-identity", Kind::Str),
    ("no-service", Kind::Bool),
    ("unit-suffix", Kind::Str),
    ("yes", Kind::Bool),
    ("join", Kind::Str),
    ("code", Kind::Str),
    ("machine-id", Kind::Str),
];

fn init_options(argv: &[String]) -> Result<InitOptions, u8> {
    let v = args::parse(
        argv,
        &Spec {
            options: INIT_OPTIONS,
            positionals: false,
        },
    )
    .map_err(|message| usage(&message))?;
    let home = resolve_home(v.str("home")).map_err(|message| fail(&message))?;
    let previous = read_setup(&home).map_err(|message| fail(&message))?;
    if let Some(listen) = v.str("listen")
        && parse_listen(listen).is_none()
    {
        return Err(usage(&format!(
            "--listen must be host:port, got '{listen}'"
        )));
    }
    if let Some(url) = v.str("url")
        && reqwest::Url::parse(url).is_err()
    {
        return Err(usage(&format!(
            "--url must be the hub's address, e.g. https://forge.tailnet.ts.net, got '{url}'"
        )));
    }
    let identity = match v.str("git-identity") {
        None => None,
        Some(text) => Some(parse_git_identity(text).ok_or_else(|| {
            usage(&format!(
                "--git-identity must look like \"Name <email>\", got '{text}'"
            ))
        })?),
    };
    let suffix = match v.str("unit-suffix") {
        None => previous
            .as_ref()
            .map(|p| p.unit_suffix.clone())
            .unwrap_or_default(),
        Some(text) => unit_suffix(Some(text)).ok_or_else(|| {
            usage(&format!(
                "--unit-suffix takes letters, digits and dashes, got '{text}'"
            ))
        })?,
    };
    let join = match (v.string("join"), v.string("code")) {
        (Some(hub), Some(code)) => Some((hub, code)),
        (None, None) => None,
        _ => {
            return Err(usage(
                "--join and --code go together: both are in what fleetd pair --worker prints",
            ));
        }
    };
    Ok(InitOptions {
        join,
        machine_id: v.string("machine-id"),
        home,
        previous,
        listen: v.string("listen"),
        url: v.string("url"),
        identity,
        suffix,
        with_service: !v.flag("no-service"),
        yes: v.flag("yes"),
    })
}

/// Without a terminal and without --yes: only the hub, as older releases did, so scripts see no prompt.
async fn init_plain(opts: InitOptions) -> u8 {
    let listen = opts
        .listen
        .clone()
        .or_else(|| opts.previous.as_ref().map(|p| p.listen.clone()))
        .unwrap_or_else(|| DEFAULT_LISTEN.to_owned());
    let url = opts
        .url
        .clone()
        .or_else(|| opts.previous.as_ref().map(|p| p.url.clone()))
        .unwrap_or_else(|| format!("http://{listen}"));
    let identity = opts
        .identity
        .clone()
        .or_else(|| opts.previous.as_ref().and_then(|p| p.git_identity.clone()));
    say(&format!("hub home {}", opts.home.display()));
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
    let plan = HubPlan {
        home: &opts.home,
        listen,
        url,
        suffix: opts.suffix.clone(),
        identity,
        with_service: opts.with_service,
    };
    match install_hub(&plan, &say).await {
        Ok(how) => say(&format!("the hub {how}")),
        Err(failure) => return fail(&format!("{}. Fix: {}", failure.message, failure.fix)),
    }
    say(
        "next: run fleetd init in a terminal to add workers, a first project and the desktop app (fleetd init --yes takes every default)",
    );
    0
}

async fn init_command(argv: &[String]) -> u8 {
    let opts = match init_options(argv) {
        Ok(opts) => opts,
        Err(code) => return code,
    };
    let terminal = std::io::stdin().is_terminal() && std::io::stderr().is_terminal();
    if opts.yes || terminal || opts.join.is_some() {
        let interactive = terminal && !opts.yes;
        wizard::run(opts, interactive).await
    } else {
        init_plain(opts).await
    }
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
                &say,
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
                let _ = sh(
                    &format!("XDG_RUNTIME_DIR=/run/user/{uid} systemctl --user daemon-reload"),
                    &say,
                )
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

/// `fleetd init`, `fleetd doctor` and `fleetd uninstall`.
pub async fn setup_command(command: &str, argv: &[String]) -> u8 {
    match command {
        "init" => init_command(argv).await,
        "doctor" => doctor::doctor_command(argv).await,
        _ => uninstall_command(argv).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(service: bool, unit: Unit, holders: &[u32], probe: Probe) -> HubAction {
        hub_action(service, unit, holders, &probe, "127.0.0.1:4790", "/h")
    }

    fn refused(action: HubAction) -> String {
        match action {
            HubAction::Refuse { message, fix } => format!("{message} | {fix}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn rerunning_init_keeps_a_working_hub_and_repairs_the_rest() {
        // First run, and a stopped or edited service: (re)install.
        assert_eq!(
            action(true, Unit::Missing, &[], Probe::Free),
            HubAction::Install
        );
        assert_eq!(
            action(true, Unit::Same, &[], Probe::Free),
            HubAction::Install
        );
        assert_eq!(
            action(true, Unit::Changed, &[7], Probe::Hub),
            HubAction::Install
        );
        assert_eq!(
            action(true, Unit::Same, &[7], Probe::Other),
            HubAction::Install
        );
        // The service runs the same unit and answers: nothing to do.
        assert_eq!(action(true, Unit::Same, &[7], Probe::Hub), HubAction::Keep);
        // --no-service: a hub someone runs is used as is; none yet is left to them.
        assert_eq!(
            action(false, Unit::Missing, &[7], Probe::Hub),
            HubAction::ByHand
        );
        assert_eq!(
            action(false, Unit::Missing, &[], Probe::Free),
            HubAction::NotRunning
        );
    }

    #[test]
    fn init_never_takes_over_what_it_did_not_start() {
        assert!(
            refused(action(true, Unit::Missing, &[7, 9], Probe::Hub))
                .contains("started by hand runs on /h (pid 7, 9) | stop it (kill 7, 9)")
        );
        assert!(
            refused(action(true, Unit::Missing, &[], Probe::Hub)).contains(
                "in use by another fleetd hub | pick a free address: fleetd init --listen"
            )
        );
        assert!(
            refused(action(false, Unit::Missing, &[], Probe::Other)).contains("by something else")
        );
        assert!(refused(action(false, Unit::Same, &[7], Probe::Free)).contains("does not answer"));
    }
}
