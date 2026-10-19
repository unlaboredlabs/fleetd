//! `fleetd machine add|remove`: sets up (or undoes) a worker over SSH, printing every remote command before it runs.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::model::MachineStatus;
use sha2::{Digest, Sha256};

use super::super::args::{self, Kind, Spec};
use super::super::hub_key::{HubAccess, open_hub, resolve_home};
use super::machine_plan::{
    MachineAddInput, MachineLayout, Stdin, Step, fresh_facts, local_target, login_command,
    login_status_command, parse_facts, plan_machine_add, plan_machine_remove, probe_command,
};
use super::ssh::{SshTarget, run_ssh, show_ssh};
use super::state::{GitIdentity, MachineRecord, read_setup, write_setup};
use super::units::unit_suffix;
use super::{Probe, current_exe, parse_listen, probe_listen, say};

pub fn machine_usage() -> String {
    use crate::node::runner::version::SUPPORTED;
    format!(
        "  machine add <ssh-host> | --local [--machine-id <id>] [--tags a,b] [--dry-run] [--no-service]
            [--hub-url <url>] [--ssh-config <file>] [--home <hub home>] [--unit-suffix <s>]
            [--claude-config-dir <dir>]
             set up a machine that runs agents, over SSH (--local: this machine): copies this fleetd
             there, checks its claude (installed, version {SUPPORTED}, logged in), enrolls the node and
             runs it as a user service, then waits until the machine is online; prints every command
             first, --dry-run only prints (for a fresh machine, without connecting); --no-service
             enrolls the node but writes no service and prints how to run it; safe to run again
  machine remove <id> [--purge] [--home <hub home>]
             stop and remove the node's service on the machine and revoke its key on the hub; --purge
             also deletes ~/.fleetd/node and ~/.fleetd/claude.env there, and
             what an older fleetd installed for T3 Code
"
    )
}

fn fail(message: &str) -> u8 {
    say(&format!("fleetd: {message}"));
    1
}

fn usage(message: &str) -> u8 {
    say(&format!("fleetd: {message}\n\nusage:\n{}", machine_usage()));
    2
}

/// `user@host.example:22` → `host`, as a machine id.
pub fn machine_id_from_host(host: &str) -> String {
    let host = host.rsplit('@').next().unwrap_or(host);
    let label = host.split('.').next().unwrap_or(host).to_lowercase();
    let mut id = String::new();
    let mut replacing = false;
    for c in label.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            id.push(c);
            replacing = false;
        } else if !replacing {
            id.push('-');
            replacing = true;
        }
    }
    id.trim_matches('-').chars().take(32).collect()
}

fn describe_stdin(step: &Step, exe: &Path, exe_len: u64) -> Option<String> {
    step.stdin.as_ref().map(|stdin| match stdin {
        Stdin::Binary => format!(
            "stdin: the fleetd binary {} ({exe_len} bytes)",
            exe.display()
        ),
        Stdin::EnrollToken => "stdin: one-time enroll token (not shown)".into(),
        Stdin::Text { label, text } => format!("stdin: {label} ({} bytes)", text.len()),
    })
}

fn print_step(index: usize, total: usize, step: &Step, exe: &Path, exe_len: u64) {
    say(&format!("[{index}/{total}] {}", step.title));
    say(&format!("  $ {}", step.command));
    if let Some(stdin) = describe_stdin(step, exe, exe_len) {
        say(&format!("    ({stdin})"));
    }
}

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().split('\n').collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Milliseconds since the epoch of an ISO-8601 UTC timestamp as the hub writes it (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
fn parse_iso_ms(text: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| text.get(range).and_then(|s| s.parse::<i64>().ok());
    let (y, mo, d, h, mi, s) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    let ms = if text.as_bytes().get(19) == Some(&b'.') {
        num(20..23).unwrap_or(0)
    } else {
        0
    };
    // Howard Hinnant's days_from_civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

/// True once the hub has heard from the machine's node at or after `since_ms` (online, or degraded with a reason it
/// reports). A quick node restart does not flap the status, so there may be no fresh machine.online event to wait
/// for; the hub writes from its own process, so this re-reads the record every second.
async fn wait_linked(
    hub: &HubAccess,
    machine_id: &MachineId,
    since_ms: i64,
    timeout: Duration,
) -> Option<MachineStatus> {
    let deadline = since_ms + timeout.as_millis() as i64;
    while now_ms() < deadline {
        if let Ok(Some(machine)) = hub.store.machine_get(machine_id)
            && machine.status != MachineStatus::Offline
            && parse_iso_ms(&machine.last_seen_at.to_string()).is_some_and(|at| at >= since_ms)
        {
            return Some(machine.status);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    None
}

/// This machine's name, as a machine id would be made from it.
pub fn local_host_name() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .arg("-s")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|name| name.trim().to_owned())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "this-machine".into())
}

/// What a finished `machine add` set up, for `fleetd init` to check and fix fleetd's Claude login there.
pub struct Added {
    pub machine_id: String,
    pub target: SshTarget,
    pub layout: MachineLayout,
    pub claude: String,
    pub logged_in: bool,
    /// `--no-service`: how to run its node by hand.
    pub run_by_hand: Option<String>,
    /// The CLAUDE_CONFIG_DIR its node runs claude with; `None`: the user's own.
    pub claude_config_dir: Option<String>,
}

/// Where the one-time enrollment token comes from: the hub's database (on the hub), `fleetd pair --worker` (on a
/// worker joining by itself), or nowhere: a joined worker being repaired keeps its enrolment.
pub enum Enroll {
    Hub,
    Token(String),
    Keep,
}

/// This machine's node, enrolled with a hub by itself (`fleetd init --join`): what a re-run repairs.
#[derive(Debug, PartialEq)]
pub struct Joined {
    pub hub: String,
    pub machine_id: String,
    pub tags: Vec<String>,
    pub suffix: String,
    pub identity: Option<GitIdentity>,
}

/// The unit suffix and commit identity in a node unit `machine add` wrote (systemd or launchd).
pub fn node_unit_facts(file_name: &str, text: &str) -> Option<(String, Option<GitIdentity>)> {
    let suffix = file_name
        .strip_prefix("fleetd-node")
        .and_then(|rest| rest.strip_suffix(".service"))
        .or_else(|| {
            file_name
                .strip_prefix("sh.fleetd.node")
                .and_then(|rest| rest.strip_suffix(".plist"))
        })?;
    let value = |key: &str| {
        let systemd = text.lines().find_map(|line| {
            let line = line.strip_prefix("Environment=")?.trim_matches('"');
            line.strip_prefix(&format!("{key}="))
                .map(|v| v.replace("\\\"", "\"").replace("%%", "%"))
        });
        systemd.or_else(|| {
            let mut lines = text.lines();
            lines.find(|l| l.trim() == format!("<key>{key}</key>"))?;
            let next = lines.next()?.trim();
            next.strip_prefix("<string>")?
                .strip_suffix("</string>")
                .map(|v| {
                    v.replace("&lt;", "<")
                        .replace("&gt;", ">")
                        .replace("&amp;", "&")
                })
        })
    };
    let identity = match (value("GIT_AUTHOR_NAME"), value("GIT_AUTHOR_EMAIL")) {
        (Some(name), Some(email)) => Some(GitIdentity { name, email }),
        _ => None,
    };
    Some((suffix.to_owned(), identity))
}

/// The node `fleetd init --join` set up here, if it is enrolled: from its node.json and its unit.
pub fn joined_here() -> Option<Joined> {
    let dirs = super::local_dirs();
    let layout = super::machine_plan::machine_layout_at(
        &dirs.home,
        &crate::home::fleetd_dir().to_string_lossy(),
    );
    let node: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&layout.node_config).ok()?).ok()?;
    if node.get("enrolled") != Some(&serde_json::Value::Bool(true)) {
        return None;
    }
    let text = |key: &str| {
        node.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let units = [
        format!("{}/systemd/user", dirs.config_home.trim_end_matches('/')),
        format!("{}/Library/LaunchAgents", dirs.home.trim_end_matches('/')),
    ];
    let (suffix, identity) = units
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .flatten()
        .find_map(|entry| {
            let unit = std::fs::read_to_string(entry.path()).ok()?;
            if !unit.contains(&layout.node_home) {
                return None;
            }
            node_unit_facts(&entry.file_name().to_string_lossy(), &unit)
        })
        .unwrap_or_default();
    Some(Joined {
        hub: text("hub")?,
        machine_id: text("machineId")?,
        tags: node
            .get("tags")
            .and_then(serde_json::Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(|t| t.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        suffix,
        identity,
    })
}

pub struct AddArgs {
    pub host: Option<String>,
    pub machine_id: Option<String>,
    pub tags: Vec<String>,
    pub dry_run: bool,
    pub hub_url: Option<String>,
    pub ssh_config: Option<String>,
    pub home: Option<String>,
    pub unit_suffix: Option<String>,
    pub enroll: Enroll,
    /// Only for a joining worker, which has no hub setup to read it from.
    pub git_identity: Option<GitIdentity>,
    /// `--no-service`: enroll, but leave running the node to the user.
    pub no_service: bool,
    /// `--claude-config-dir`: the node runs claude with this CLAUDE_CONFIG_DIR instead of the user's own.
    pub claude_config_dir: Option<String>,
}

fn parse_add(argv: &[String]) -> Result<AddArgs, u8> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("local", Kind::Bool),
        ("machine-id", Kind::Str),
        ("tags", Kind::Str),
        ("dry-run", Kind::Bool),
        ("hub-url", Kind::Str),
        ("ssh-config", Kind::Str),
        ("home", Kind::Str),
        ("unit-suffix", Kind::Str),
        ("no-service", Kind::Bool),
        ("claude-config-dir", Kind::Str),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )
    .map_err(|message| usage(&message))?;
    let host = match (v.positionals.as_slice(), v.flag("local")) {
        ([host], false) => Some(host.clone()),
        ([], true) => None,
        _ => {
            return Err(usage(
                "machine add takes one ssh host, or --local for this machine",
            ));
        }
    };
    Ok(AddArgs {
        host,
        machine_id: v.string("machine-id"),
        tags: v
            .str("tags")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect(),
        dry_run: v.flag("dry-run"),
        hub_url: v.string("hub-url"),
        ssh_config: v.string("ssh-config"),
        home: v.string("home"),
        unit_suffix: v.string("unit-suffix"),
        enroll: Enroll::Hub,
        git_identity: None,
        no_service: v.flag("no-service"),
        claude_config_dir: v.string("claude-config-dir"),
    })
}

async fn add_command(argv: &[String]) -> u8 {
    match parse_add(argv) {
        Ok(a) => match add(a).await {
            Ok(_) => 0,
            Err(code) => code,
        },
        Err(code) => code,
    }
}

/// `machine add`, returning what it set up (`None` for a dry run); `Err` carries the exit code after the error is
/// printed.
pub async fn add(a: AddArgs) -> Result<Option<Added>, u8> {
    let fail = |message: &str| Err(fail(message));
    let usage = |message: &str| Err(usage(message));
    let local = a.host.is_none();
    let host = a.host.clone().unwrap_or_else(|| "localhost".to_owned());
    let host = &host;
    let machine_id = a.machine_id.clone().unwrap_or_else(|| {
        machine_id_from_host(&if local {
            local_host_name()
        } else {
            host.clone()
        })
    });
    let Ok(machine) = MachineId::new(machine_id.clone()) else {
        return usage(&format!(
            "'{machine_id}' is not a machine id ([a-z0-9-]{{1,32}}); pass --machine-id"
        ));
    };
    let joining = !matches!(a.enroll, Enroll::Hub);
    let home = match resolve_home(a.home.as_deref()) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let state = if joining {
        None
    } else {
        match read_setup(&home) {
            Ok(Some(state)) => Some(state),
            Ok(None) => {
                return fail(&format!(
                    "{} has no hub set up. Fix: {}",
                    home.display(),
                    super::no_setup_fix(&home)
                ));
            }
            Err(message) => return fail(&message),
        }
    };
    let suffix = match a.unit_suffix.as_deref() {
        None => state
            .as_ref()
            .map(|s| s.unit_suffix.clone())
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
    let Some(hub_url) = a
        .hub_url
        .clone()
        .or_else(|| state.as_ref().map(|s| s.url.clone()))
    else {
        return usage("--hub-url is required to join a hub");
    };
    // The machine gets this very binary; for now only a machine that can run it.
    let exe = match current_exe() {
        Ok(exe) => exe,
        Err(message) => return fail(&message),
    };
    let binary = match std::fs::read(&exe) {
        Ok(bytes) => bytes,
        Err(error) => {
            return fail(&format!(
                "machine add copies the running fleetd to the machine, and {} is unreadable: {error}",
                exe.display()
            ));
        }
    };
    let exe_len = binary.len() as u64;
    let target = SshTarget {
        host: host.clone(),
        config: a.ssh_config.as_deref().map(|config| {
            std::path::absolute(config)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| config.to_owned())
        }),
        local,
    };
    let input = MachineAddInput {
        machine_id: machine_id.clone(),
        tags: a.tags.clone(),
        hub_url: hub_url.clone(),
        unit_suffix: suffix,
        git_identity: a
            .git_identity
            .clone()
            .or_else(|| state.as_ref().and_then(|s| s.git_identity.clone())),
        binary_digest: format!("{:x}", Sha256::digest(&binary)),
        binary_target: local_target(),
        version: env!("CARGO_PKG_VERSION").into(),
        hub_has_node_key: false,
        service: !a.no_service,
        claude_config_dir: a.claude_config_dir.clone(),
    };
    let again = if joining {
        "fleetd init again".to_owned()
    } else if local {
        "fleetd machine add --local".to_owned()
    } else {
        format!("fleetd machine add {host}")
    };

    if a.dry_run {
        let user = match host.split_once('@') {
            Some((user, _)) => user.to_owned(),
            None => std::env::var("USER")
                .or_else(|_| std::env::var("LOGNAME"))
                .unwrap_or_else(|_| "user".into()),
        };
        let plan = match plan_machine_add(&fresh_facts(&user, &input.binary_target.1), &input) {
            Ok(plan) => plan,
            Err(message) => return fail(&message),
        };
        say(&format!(
            "dry run: nothing runs. Planned for a fresh Linux machine at {host} (home {}); a real run first reads the machine's state and leaves out what is already done:",
            plan.layout
                .fleetd
                .strip_suffix("/.fleetd")
                .unwrap_or(&plan.layout.fleetd)
        ));
        say("[probe] read the machine's state (read-only)");
        for (i, step) in plan.steps.iter().enumerate() {
            print_step(i + 1, plan.steps.len(), step, &exe, exe_len);
        }
        say(&format!("[hub] wait until {machine_id} is online"));
        for note in &plan.notes {
            say(&format!("note: {note}"));
        }
        return Ok(None);
    }

    let hub = if joining {
        None
    } else {
        let listen = state
            .as_ref()
            .and_then(|s| parse_listen(&s.listen))
            .unwrap_or_default();
        if probe_listen(&listen).await != Probe::Hub {
            return fail(&format!(
                "no hub answers at {}:{}. Fix: fleetd init (it starts the hub), then run {again}",
                listen.0, listen.1
            ));
        }
        match open_hub(&home) {
            Ok(hub) => Some(hub),
            Err(message) => return fail(&message),
        }
    };

    say(&format!(
        "setting up {machine_id}{}; every command is shown before it runs.",
        if local {
            String::new()
        } else {
            format!(" on {host}")
        }
    ));
    say("[probe] read the machine's state (read-only)");
    let relocated = crate::home::relocated().map(|d| d.to_string_lossy().into_owned());
    let probed = run_ssh(
        &target,
        &probe_command(&input.unit_suffix, relocated.as_deref().filter(|_| local)),
        None,
    )
    .await;
    let facts = match (probed.code, parse_facts(&probed.stdout)) {
        (0, Ok(facts)) => facts,
        (code, parsed) => {
            let why = match parsed {
                Err(e) if code == 0 => e,
                _ => tail(&probed.stderr),
            };
            return fail(&format!(
                "cannot read {host}{} (exit {code}): {why}\nFix: {}then run {again}",
                if local { "" } else { " over SSH" },
                if local {
                    String::new()
                } else {
                    format!("make `ssh {host} true` work without a password (ssh-copy-id {host}), ")
                }
            ));
        }
    };

    // A joined worker being repaired: the hub holds its key as long as its node.json says enrolled.
    let has_key = matches!(a.enroll, Enroll::Keep)
        || hub.as_ref().is_some_and(|hub| {
            hub.auth
                .node_pub_key(&machine)
                .is_ok_and(|key| key.is_some())
        });
    let input = MachineAddInput {
        hub_has_node_key: has_key,
        ..input
    };
    let plan = match plan_machine_add(&facts, &input) {
        Ok(plan) => plan,
        Err(message) => return fail(&format!("{message}, then run {again}")),
    };
    // Never stop or re-enrol a joined node without a fresh code: that is what --join with --rejoin is for.
    if matches!(a.enroll, Enroll::Keep)
        && plan
            .steps
            .iter()
            .any(|s| s.stdin == Some(Stdin::EnrollToken))
    {
        return fail(&format!(
            "this machine's node is no longer enrolled with {hub_url} as {machine_id}. Fix: on the hub, run fleetd pair --worker {machine_id}, then run what it prints here with --rejoin"
        ));
    }
    // Recorded before anything changes, so `machine remove` can undo a run that stopped half way.
    if let Some(state) = &state {
        let mut recorded = state.clone();
        recorded.machines.insert(
            machine_id.clone(),
            MachineRecord {
                ssh_host: host.clone(),
                ssh_config: target.config.clone(),
                local,
                platform: plan.platform,
                home: facts.home.clone(),
                config_home: facts.config_home.clone(),
                uid: facts.uid,
                unit_suffix: input.unit_suffix.clone(),
            },
        );
        if let Err(message) = write_setup(&home, &recorded) {
            return fail(&message);
        }
    }

    // Set after each step, so after the last one (the node's (re)start) only the new node can count as linked.
    let mut steps_done = now_ms();
    for (i, step) in plan.steps.iter().enumerate() {
        print_step(i + 1, plan.steps.len(), step, &exe, exe_len);
        let stdin: Option<Vec<u8>> = match &step.stdin {
            None => None,
            Some(Stdin::Text { text, .. }) => Some(text.clone().into_bytes()),
            Some(Stdin::Binary) => Some(binary.clone()),
            Some(Stdin::EnrollToken) => match (&a.enroll, &hub) {
                (Enroll::Token(token), _) => Some(format!("{token}\n").into_bytes()),
                (Enroll::Hub, Some(hub)) => match hub.auth.create_enroll_token(&machine) {
                    Ok(token) => Some(format!("{}\n", token.token).into_bytes()),
                    Err(error) => return fail(&error.to_string()),
                },
                (Enroll::Hub, None) | (Enroll::Keep, _) => {
                    unreachable!("only a hub or a code enrolls")
                }
            },
        };
        let result = run_ssh(&target, &step.command, stdin.as_deref()).await;
        if result.code != 0 {
            let fix = if step.stdin == Some(Stdin::EnrollToken) && joining {
                "the code is single use and lasts 15 minutes: on the hub, run fleetd pair --worker for a new one".to_owned()
            } else {
                format!("fix that, then run {again}; finished steps are skipped")
            };
            return fail(&format!(
                "step {} failed (exit {}):\n{}\nFix: {fix}.",
                i + 1,
                result.code,
                tail(&format!("{}\n{}", result.stdout, result.stderr))
            ));
        }
        steps_done = now_ms();
        let shown = result.stdout.trim();
        if !shown.is_empty() && shown.len() < 200 && !shown.contains('\n') {
            say(&format!("  → {shown}"));
        }
    }

    if let Some(cmd) = &plan.run_by_hand {
        say(&format!(
            "{machine_id} is enrolled; with --no-service, start its node yourself{}:\n  {cmd}",
            if local {
                String::new()
            } else {
                format!(" on {host}")
            }
        ));
    } else if let Some(hub) = &hub {
        let already = !plan.node_restarts
            && hub
                .store
                .machine_get(&machine)
                .ok()
                .flatten()
                .is_some_and(|m| m.status != MachineStatus::Offline);
        if !already {
            say(&format!(
                "[hub] waiting until {machine_id} is online (up to 2 min)"
            ));
            if wait_linked(hub, &machine, steps_done, Duration::from_secs(120))
                .await
                .is_none()
            {
                return fail(&format!(
                    "{machine_id} did not come online within 2 min. Its node log is {}/node.log on {host}; the node must reach the hub at {}. Fix: make that address reachable from {host} (fleetd init --url <address>), then run {again}",
                    plan.layout.logs, input.hub_url
                ));
            }
        }
        say(&format!("{machine_id} is online."));
    }
    // A worker's claude with no login fails every session; say so now, not at the first order.
    let claude = facts.claude.clone().unwrap_or_default();
    let config_dir = a.claude_config_dir.clone();
    let status = run_ssh(
        &target,
        &login_status_command(&plan.layout, &claude, config_dir.as_deref()),
        None,
    )
    .await;
    let logged_in = serde_json::from_str::<serde_json::Value>(status.stdout.trim())
        .ok()
        .and_then(|v| v.get("loggedIn").and_then(serde_json::Value::as_bool))
        == Some(true);
    let mut notes = plan.notes.clone();
    if !logged_in {
        let login = login_command(&claude, config_dir.as_deref());
        notes.push(format!(
            "claude on {machine_id} is not logged in, so its sessions can't start. Fix: {}",
            if local {
                login
            } else {
                format!("ssh -t {host} {}", super::units::q(&login))
            }
        ));
    }
    for note in &notes {
        say(&format!("note: {note}"));
    }
    Ok(Some(Added {
        machine_id,
        target,
        layout: plan.layout,
        claude,
        logged_in,
        run_by_hand: plan.run_by_hand,
        claude_config_dir: config_dir,
    }))
}

async fn remove_command(argv: &[String]) -> u8 {
    let v = match args::parse(
        argv,
        &Spec {
            options: &[("purge", Kind::Bool), ("home", Kind::Str)],
            positionals: true,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let Some(machine) = v
        .positionals
        .first()
        .and_then(|id| MachineId::new(id.clone()).ok())
    else {
        return usage("machine remove takes a machine id");
    };
    let machine_id = machine.to_string();
    let home = match resolve_home(v.str("home")) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let state = match read_setup(&home) {
        Ok(state) => state,
        Err(message) => return fail(&message),
    };
    let record = state
        .as_ref()
        .and_then(|s| s.machines.get(&machine_id))
        .cloned();
    let purge = v.flag("purge");

    let mut remote_ok = true;
    match &record {
        None => say(&format!(
            "{machine_id} was not set up by fleetd machine add from this hub, so only its key is revoked here; stop its node by hand."
        )),
        Some(record) => {
            let target = SshTarget {
                host: record.ssh_host.clone(),
                config: record.ssh_config.clone(),
                local: record.local,
            };
            let relocated = crate::home::relocated().map(|d| d.to_string_lossy().into_owned());
            let steps = plan_machine_remove(
                record.platform,
                &record.home,
                relocated.as_deref().filter(|_| record.local),
                &record.config_home,
                record.uid,
                &record.unit_suffix,
                purge,
            );
            for (i, step) in steps.iter().enumerate() {
                say(&format!(
                    "[{}/{}] {}\n  $ {}",
                    i + 1,
                    steps.len(),
                    step.title,
                    step.command
                ));
                let result = run_ssh(&target, &step.command, None).await;
                if result.code != 0 {
                    remote_ok = false;
                    say(&format!(
                        "  failed (exit {}): {}",
                        result.code,
                        tail(&result.stderr)
                    ));
                    let rest: Vec<String> = steps[i..]
                        .iter()
                        .map(|s| format!("    {}", show_ssh(&target, &s.command)))
                        .collect();
                    say(&format!(
                        "  Fix: run the remaining steps yourself:\n{}",
                        rest.join("\n")
                    ));
                    break;
                }
            }
        }
    }

    let hub = match open_hub(&home) {
        Ok(hub) => hub,
        Err(message) => return fail(&message),
    };
    let revoked = match hub
        .auth
        .revoke_node(&machine)
        .and_then(|revoked| hub.store.machine_remove(&machine).map(|()| revoked))
    {
        Ok(revoked) => revoked,
        Err(error) => return fail(&error.to_string()),
    };
    say(&if revoked {
        format!("revoked {machine_id}'s node key; the hub refuses that node from now on.")
    } else {
        format!("the hub held no node key for {machine_id}.")
    });
    if let (Some(mut state), Some(_)) = (state, &record) {
        state.machines.remove(&machine_id);
        if let Err(message) = write_setup(&home, &state) {
            return fail(&message);
        }
    }
    if let Some(record) = &record
        && !purge
    {
        say(&format!(
            "fleetd's Claude login and the node's files stay on {}; --purge deletes them.",
            record.ssh_host
        ));
    }
    if remote_ok { 0 } else { 1 }
}

/// `fleetd machine …`.
pub async fn machine_command(argv: &[String]) -> u8 {
    match argv.first().map(String::as_str) {
        Some("add") => add_command(&argv[1..]).await,
        Some("remove") => remove_command(&argv[1..]).await,
        Some(other) => usage(&format!("unknown machine command '{other}'")),
        None => usage("missing machine command"),
    }
}

/// A worker joining by itself (`fleetd init --join <hub url> --code <token>`), or repaired after it did: `machine
/// add --local` against a hub this machine reaches but whose database it doesn't hold.
pub async fn join(hub_url: &str, enroll: Enroll, args: AddArgs) -> Result<Added, u8> {
    add(AddArgs {
        host: None,
        hub_url: Some(hub_url.to_owned()),
        home: None,
        enroll,
        ..args
    })
    .await
    .map(|added| added.expect("not a dry run"))
}

impl AddArgs {
    /// This machine, nothing else set.
    pub fn local(machine_id: String, unit_suffix: &str, service: bool) -> Self {
        AddArgs {
            host: None,
            machine_id: Some(machine_id),
            tags: Vec::new(),
            dry_run: false,
            hub_url: None,
            ssh_config: None,
            home: None,
            unit_suffix: Some(unit_suffix.to_owned()),
            enroll: Enroll::Hub,
            git_identity: None,
            no_service: !service,
            claude_config_dir: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_id_from_an_ssh_host() {
        assert_eq!(
            machine_id_from_host("ada@Mac-Mini.tail1234.ts.net"),
            "mac-mini"
        );
        assert_eq!(machine_id_from_host("devbox"), "devbox");
        assert_eq!(machine_id_from_host("build_box_2"), "build-box-2");
    }

    #[test]
    fn reads_a_joined_nodes_unit() {
        let systemd = "[Service]\nEnvironment=\"HOME=/home/a\"\nEnvironment=\"GIT_AUTHOR_NAME=Ada Lovelace\"\nEnvironment=GIT_AUTHOR_EMAIL=1+ada@users.noreply.github.com\n";
        assert_eq!(
            node_unit_facts("fleetd-node-lab.service", systemd),
            Some((
                "-lab".into(),
                Some(GitIdentity {
                    name: "Ada Lovelace".into(),
                    email: "1+ada@users.noreply.github.com".into()
                })
            ))
        );
        let plist = "    <key>GIT_AUTHOR_NAME</key>\n    <string>Ada &amp; Co</string>\n    <key>GIT_AUTHOR_EMAIL</key>\n    <string>a@b</string>\n";
        assert_eq!(
            node_unit_facts("sh.fleetd.node.plist", plist).map(|(s, i)| (s, i.map(|i| i.name))),
            Some((String::new(), Some("Ada & Co".into())))
        );
        assert_eq!(node_unit_facts("fleetd-hub.service", systemd), None);
        assert_eq!(node_unit_facts("fleetd-node.service", "").unwrap().1, None);
    }

    #[test]
    fn reads_hub_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(
            parse_iso_ms("2026-10-17T10:00:00.000Z"),
            Some(1_792_231_200_000)
        );
    }
}
