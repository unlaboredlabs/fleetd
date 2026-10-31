//! `fleetd machine add|remove`: sets up (or undoes) a worker over SSH, printing every remote command before it runs.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::model::MachineStatus;
use sha2::{Digest, Sha256};

use super::super::args::{self, Kind, Spec};
use super::super::hub_key::{HubAccess, open_hub, resolve_home};
use super::machine_plan::{
    Facts, MachineAddInput, MachineLayout, MachinePlan, Stdin, Step, fresh_facts, local_target,
    login_command, login_status_command, parse_facts, plan_machine_add, plan_machine_remove,
    probe_command,
};
use super::ssh::{RunResult, SshTarget, run_ssh, show_ssh};
use super::state::{GitIdentity, MachineRecord, SetupState, read_setup, write_setup};
use super::{Probe, current_exe, parse_listen, probe_listen, say};
use crate::hub::auth::Auth;
use crate::hub::store::HubStore;
use crate::update::BoxFuture;

pub fn machine_usage() -> String {
    use crate::node::runner::claude::version::SUPPORTED;
    format!(
        "  machine add <ssh-host> | --local [--machine-id <id>] [--dry-run] [--no-service]
            [--hub-url <url>] [--ssh-config <file>]
            [--claude-config-dir <dir>]
             set up a machine that runs agents, over SSH (--local: this machine): copies this fleetd
             there (for another OS or CPU, this version's release build for it, checked against
             its SHA256SUMS; there is no Linux ARM build yet), checks its claude (installed, version {SUPPORTED}, logged in), enrolls the node and
             runs it as a user service, then waits until the machine is online; prints every command
             first, --dry-run only prints (for a fresh machine, without connecting); --no-service
             enrolls the node but writes no service and prints how to run it; safe to run again
  machine remove <id> [--purge]
             stop and remove the node's service on the machine and revoke its key on the hub; --purge
             also deletes ~/.fleetd/node and ~/.fleetd/claude.env there, and
             what an older fleetd installed for T3 Code
{}",
        crate::cli::project::MACHINE_SET_USAGE
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

/// `what`: the fleetd binary the machine gets, as the step names it (this one's path, or the release asset fetched for
/// the machine's OS and CPU).
fn describe_stdin(step: &Step, what: &str, len: u64) -> Option<String> {
    step.stdin.as_ref().map(|stdin| match stdin {
        Stdin::Binary => format!("stdin: the fleetd binary {what} ({len} bytes)"),
        Stdin::EnrollToken => "stdin: one-time enroll token (not shown)".into(),
        Stdin::Text { label, text } => format!("stdin: {label} ({} bytes)", text.len()),
    })
}

fn plan_step(index: usize, total: usize, step: &Step, what: &str, len: u64) -> Begin {
    Begin {
        stage: Stage::Step(index, total),
        title: step.title.clone(),
        command: Some(step.command.clone()),
        stdin: describe_stdin(step, what, len),
    }
}

pub fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.trim().split('\n').collect();
    lines[lines.len().saturating_sub(15)..].join("\n")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Runs a command on the machine: over SSH, or here for `--local`. The hub's tests stand in a fake.
pub trait Runner: Send + Sync {
    fn run<'a>(
        &'a self,
        target: &'a SshTarget,
        command: &'a str,
        stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, RunResult>;
}

/// The real one: `ssh`, or `sh` on this machine.
pub struct Ssh;

impl Runner for Ssh {
    fn run<'a>(
        &'a self,
        target: &'a SshTarget,
        command: &'a str,
        stdin: Option<&'a [u8]>,
    ) -> BoxFuture<'a, RunResult> {
        Box::pin(run_ssh(target, command, stdin))
    }
}

/// The fleetd build for a machine of another OS or CPU than this fleetd's own: this very version's release asset.
/// Tests stand in a fake.
pub trait Builds: Send + Sync {
    /// The sha256 that `version`'s release lists for `asset` (`fleetd-<os>-<arch>`) in its SHA256SUMS: what the
    /// machine's copy must be. Or why not, with `Fix:` and what to do.
    fn digest<'a>(
        &'a self,
        version: &'a str,
        asset: &'a str,
    ) -> BoxFuture<'a, Result<String, String>>;
    /// The asset's bytes, checked against that release's SHA256SUMS.
    fn build<'a>(
        &'a self,
        version: &'a str,
        asset: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

/// The real one: the release of `version` (`v<version>`, or for an edge build the edge release while it is still that
/// build), or the directory FLEETD_BASE_URL names.
pub struct Releases;

impl Releases {
    fn feed(version: &str) -> (crate::update::HttpFeed, bool) {
        let (base, edge) = release_of(version, std::env::var("FLEETD_BASE_URL").ok().as_deref());
        (crate::update::HttpFeed::new(base), edge)
    }
}

impl Builds for Releases {
    fn digest<'a>(
        &'a self,
        version: &'a str,
        asset: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let (feed, edge) = Self::feed(version);
            release_digest(&feed, edge, version, asset).await
        })
    }

    fn build<'a>(
        &'a self,
        version: &'a str,
        asset: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let (feed, edge) = Self::feed(version);
            release_build(&feed, edge, version, asset).await
        })
    }
}

/// The edge release holds `version` only until the next edge build: its release.json says which it is now.
async fn still_holds(
    feed: &dyn crate::update::Feed,
    edge: bool,
    version: &str,
    asset: &str,
) -> Result<(), String> {
    if !edge {
        return Ok(());
    }
    let now = crate::update::release(feed)
        .await
        .map_err(|f| f.message)?
        .cli_version;
    if now.as_deref() == Some(version) {
        return Ok(());
    }
    Err(format!(
        "this hub runs fleetd {version}, and the edge release is now {}, so it has no {asset} of this hub's build. Fix: update the hub (fleetd update)",
        now.as_deref().unwrap_or("another build")
    ))
}

fn missing(asset: &str, version: &str, why: &str) -> String {
    format!(
        "no {asset} of fleetd {version} to copy to the machine: {}. Fix: run a released fleetd on the hub",
        why.trim_end_matches('.')
    )
}

/// What `feed`'s SHA256SUMS lists for `asset` of `version`.
pub async fn release_digest(
    feed: &dyn crate::update::Feed,
    edge: bool,
    version: &str,
    asset: &str,
) -> Result<String, String> {
    still_holds(feed, edge, version, asset).await?;
    let sums = crate::update::sums(feed)
        .await
        .map_err(|f| missing(asset, version, &f.message))?;
    sums.get(asset)
        .cloned()
        .ok_or_else(|| missing(asset, version, "its release has none"))
}

/// `asset` of `version` from `feed`, checked against its SHA256SUMS. An edge release that moved on between this and
/// [`release_digest`] hands over another build: `prepare` checks the bytes against the digest it planned with.
pub async fn release_build(
    feed: &dyn crate::update::Feed,
    edge: bool,
    version: &str,
    asset: &str,
) -> Result<Vec<u8>, String> {
    still_holds(feed, edge, version, asset).await?;
    crate::update::verified(feed, asset)
        .await
        .map_err(|f| missing(asset, version, &f.message))
}

/// Where fleetd `version`'s release assets are, and whether that is the rolling edge release (which holds it only
/// while its release.json still names it): `override_` (FLEETD_BASE_URL) when set, else its own `v<version>` release.
pub fn release_of(version: &str, override_: Option<&str>) -> (String, bool) {
    let repo = crate::update::REPO;
    match override_.filter(|b| !b.is_empty()) {
        Some(base) => (base.to_owned(), false),
        None if crate::edge_stamp(version).is_some() => (
            format!("https://github.com/{repo}/releases/download/edge"),
            true,
        ),
        None => (
            format!("https://github.com/{repo}/releases/download/v{version}"),
            false,
        ),
    }
}

/// Where a step stands in a run, as the CLI labels it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// `[probe]`: the read-only look at the machine.
    Probe,
    /// `[i/n]`: one of the plan's steps.
    Step(usize, usize),
    /// `[hub]`: the hub's wait for the node.
    Hub,
}

/// A step as it begins.
#[derive(Clone, Debug)]
pub struct Begin {
    pub stage: Stage,
    pub title: String,
    /// The command it runs on the machine; None for the hub's wait.
    pub command: Option<String>,
    /// What goes to its stdin, described.
    pub stdin: Option<String>,
}

/// What `machine add` and `machine remove` report as they go: the CLI prints it, the hub's machine_add streams it to
/// the app. A failed `add` ends with its [`Stop`] instead.
pub trait Progress: Send + Sync {
    /// The plan's steps once the machine has been read, before the first of them begins.
    fn planned(&self, _steps: &[Begin]) {}
    fn begin(&self, step: Begin);
    /// The step that began last ended; `output` is what it printed (nothing for the read of the machine).
    fn done(&self, output: &str);
    /// The step that began last failed (`machine remove`): its exit code, the end of its output, and the fix.
    fn failed(&self, code: i32, output: &str, fix: &str);
    /// The rest: the opening line, a note, "x is online".
    fn say(&self, line: &str);
}

/// The CLI's: every step and its command printed before it runs.
pub struct Print;

impl Progress for Print {
    fn begin(&self, step: Begin) {
        match step.stage {
            Stage::Probe => say(&format!("[probe] {}", step.title)),
            Stage::Hub => say(&format!("[hub] {}", step.title)),
            Stage::Step(index, total) => {
                say(&format!("[{index}/{total}] {}", step.title));
                if let Some(command) = &step.command {
                    say(&format!("  $ {command}"));
                }
                if let Some(stdin) = &step.stdin {
                    say(&format!("    ({stdin})"));
                }
            }
        }
    }

    fn done(&self, output: &str) {
        let shown = output.trim();
        if !shown.is_empty() && shown.len() < 200 && !shown.contains('\n') {
            say(&format!("  → {shown}"));
        }
    }

    fn failed(&self, code: i32, output: &str, fix: &str) {
        say(&format!("  failed (exit {code}): {output}"));
        say(&format!("  Fix: {fix}"));
    }

    fn say(&self, line: &str) {
        say(line);
    }
}

/// Why `machine add` or `remove` stopped: what to tell, with its fix, and the CLI's exit code (2 for a usage error).
#[derive(Debug, PartialEq, Eq)]
pub struct Stop {
    pub code: u8,
    pub message: String,
}

impl Stop {
    pub fn fail(message: impl Into<String>) -> Self {
        Self {
            code: 1,
            message: message.into(),
        }
    }

    fn usage(message: impl Into<String>) -> Self {
        Self {
            code: 2,
            message: message.into(),
        }
    }

    /// Prints it as the CLI does; the exit code.
    pub fn print(self) -> u8 {
        if self.code == 2 {
            usage(&self.message)
        } else {
            fail(&self.message)
        }
    }
}

/// The hub's database as `machine add` and `remove` use it: opened beside the hub by the CLI, the hub's own in its
/// tools.
#[derive(Clone, Copy)]
pub struct HubSide<'a> {
    pub auth: &'a Auth,
    pub store: &'a HubStore,
}

impl HubAccess {
    pub fn side(&self) -> HubSide<'_> {
        HubSide {
            auth: &self.auth,
            store: &self.store,
        }
    }
}

/// True once the hub has heard from the machine's node at or after `since_ms` (online, or degraded with a reason it
/// reports). A quick node restart does not flap the status, so there may be no fresh machine.online event to wait
/// for; the hub writes from its own process, so this re-reads the record every second.
async fn wait_linked(
    store: &HubStore,
    machine_id: &MachineId,
    since_ms: i64,
    timeout: Duration,
) -> Option<MachineStatus> {
    let deadline = since_ms + timeout.as_millis() as i64;
    while now_ms() < deadline {
        if let Ok(Some(machine)) = store.machine_get(machine_id)
            && machine.status != MachineStatus::Offline
            && crate::hub::store::parse_ms(&machine.last_seen_at.to_string())
                .is_some_and(|at| at >= since_ms)
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

/// Where a machine to add was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// This machine, the hub's.
    Here,
    /// Set up from this hub before.
    SetUp,
    /// A `Host` in ~/.ssh/config.
    SshConfig,
    /// An online Linux or macOS peer on the tailnet.
    Tailnet,
}

/// A machine `fleetd init` and the app's Add machine offer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub machine_id: String,
    /// The SSH host; None for this machine.
    pub host: Option<String>,
    pub ssh_config: Option<String>,
    pub found: Found,
}

/// This machine, those set up before, then the hosts in ~/.ssh/config (`ssh_hosts`) and the tailnet's peers: each
/// machine id once, the first place it was found winning.
pub fn candidates(
    recorded: &std::collections::BTreeMap<String, MachineRecord>,
    ssh_hosts: &[String],
    peers: &[super::detect::Peer],
) -> Vec<Candidate> {
    let local_id = recorded.iter().find(|(_, r)| r.local).map_or_else(
        || machine_id_from_host(&local_host_name()),
        |(id, _)| id.clone(),
    );
    let mut out = vec![Candidate {
        machine_id: local_id,
        host: None,
        ssh_config: None,
        found: Found::Here,
    }];
    for (id, record) in recorded.iter().filter(|(_, r)| !r.local) {
        out.push(Candidate {
            machine_id: id.clone(),
            host: Some(record.ssh_host.clone()),
            ssh_config: record.ssh_config.clone(),
            found: Found::SetUp,
        });
    }
    let found = ssh_hosts
        .iter()
        .map(|host| (machine_id_from_host(host), host.clone(), Found::SshConfig))
        .chain(peers.iter().map(|peer| {
            (
                machine_id_from_host(&peer.name),
                peer.dns_name.clone(),
                Found::Tailnet,
            )
        }));
    for (machine_id, host, how) in found {
        if MachineId::new(machine_id.clone()).is_ok()
            && !out.iter().any(|c| c.machine_id == machine_id)
        {
            out.push(Candidate {
                machine_id,
                host: Some(host),
                ssh_config: None,
                found: how,
            });
        }
    }
    out
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
    /// What to know or do by hand, each also said as a `note:` line.
    pub notes: Vec<String>,
}

/// Where the one-time enrollment token comes from: the hub's database (on the hub), `fleetd pair --worker` (on a
/// worker joining by itself), or nowhere: a joined worker being repaired keeps its enrolment.
#[derive(Clone)]
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
    pub identity: Option<GitIdentity>,
}

/// The commit identity in a node unit `machine add` wrote (systemd or launchd); None for any other file.
pub fn node_unit_facts(file_name: &str, text: &str) -> Option<Option<GitIdentity>> {
    if file_name != "fleetd-node.service" && file_name != "sh.fleetd.node.plist" {
        return None;
    }
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
    Some(identity)
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
    let identity = units
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
        identity,
    })
}

pub struct AddArgs {
    pub host: Option<String>,
    pub machine_id: Option<String>,
    pub dry_run: bool,
    pub hub_url: Option<String>,
    pub ssh_config: Option<String>,
    pub home: Option<String>,
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
        ("dry-run", Kind::Bool),
        ("hub-url", Kind::Str),
        ("ssh-config", Kind::Str),
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
        dry_run: v.flag("dry-run"),
        hub_url: v.string("hub-url"),
        ssh_config: v.string("ssh-config"),
        home: None,
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
    let exe = current_exe().map_err(|message| fail(&message))?;
    let r = resolve(&a, &exe).map_err(Stop::print)?;
    if a.dry_run {
        return dry_run(&r).map(|()| None).map_err(Stop::print);
    }
    let hub = if r.joining {
        None
    } else {
        let listen = r
            .state
            .as_ref()
            .and_then(|s| parse_listen(&s.listen))
            .unwrap_or_default();
        if probe_listen(&listen).await != Probe::Hub {
            return Err(fail(&format!(
                "no hub answers at {}:{}. Fix: fleetd init (it starts the hub), then run {}",
                listen.0, listen.1, r.again
            )));
        }
        Some(open_hub(&r.home).map_err(|message| fail(&message))?)
    };
    let side = hub.as_ref().map(HubAccess::side);
    let prepared = prepare(&r, side, &Ssh, &Releases, true, &Print)
        .await
        .map_err(Stop::print)?;
    execute(r, prepared, side, &Ssh, &Print)
        .await
        .map(Some)
        .map_err(Stop::print)
}

/// `machine add`'s arguments, checked and resolved against the hub's setup, before anything touches the machine.
pub struct Resolved {
    machine: MachineId,
    pub machine_id: String,
    local: bool,
    pub host: String,
    joining: bool,
    home: PathBuf,
    state: Option<SetupState>,
    target: SshTarget,
    input: MachineAddInput,
    binary: Vec<u8>,
    exe: PathBuf,
    /// How to run it again.
    again: String,
    enroll: Enroll,
    claude_config_dir: Option<String>,
}

/// The machine as its read found it, and what `machine add` will run there.
pub struct Prepared {
    facts: Facts,
    pub plan: MachinePlan,
    input: MachineAddInput,
    /// The release asset fetched for a machine of another OS or CPU, and its bytes; None: this fleetd's own.
    fetched: Option<(String, Vec<u8>)>,
}

impl Prepared {
    /// `linux-x64`, `darwin-arm64`.
    pub fn platform(&self) -> String {
        format!("{}-{}", self.facts.platform, self.facts.arch)
    }

    /// The plan's steps as they will begin, numbered.
    pub fn steps(&self, r: &Resolved) -> Vec<Begin> {
        let total = self.plan.steps.len();
        let (what, len) = self.binary(r);
        self.plan
            .steps
            .iter()
            .enumerate()
            .map(|(i, step)| plan_step(i + 1, total, step, &what, len.len() as u64))
            .collect()
    }

    /// The fleetd the machine gets, named, and its bytes.
    fn binary<'a>(&'a self, r: &'a Resolved) -> (String, &'a [u8]) {
        match &self.fetched {
            Some((asset, bytes)) => (format!("{asset} {}", crate::version()), bytes),
            None => (r.exe.display().to_string(), &r.binary),
        }
    }
}

/// Checks `a` and reads what `machine add` needs from the hub's setup and from `exe`, the fleetd the machine gets.
pub fn resolve(a: &AddArgs, exe: &Path) -> Result<Resolved, Stop> {
    let local = a.host.is_none();
    let host = a.host.clone().unwrap_or_else(|| "localhost".to_owned());
    let machine_id = a.machine_id.clone().unwrap_or_else(|| {
        machine_id_from_host(&if local {
            local_host_name()
        } else {
            host.clone()
        })
    });
    let Ok(machine) = MachineId::new(machine_id.clone()) else {
        return Err(Stop::usage(format!(
            "'{machine_id}' is not a machine id ([a-z0-9-]{{1,32}}); pass --machine-id"
        )));
    };
    let joining = !matches!(a.enroll, Enroll::Hub);
    let home = resolve_home(a.home.as_deref()).map_err(Stop::fail)?;
    let state = if joining {
        None
    } else {
        match read_setup(&home) {
            Ok(Some(state)) => Some(state),
            Ok(None) => {
                return Err(Stop::fail(format!(
                    "{} has no hub set up. Fix: {}",
                    home.display(),
                    super::no_setup_fix(&home)
                )));
            }
            Err(message) => return Err(Stop::fail(message)),
        }
    };
    let Some(hub_url) = a
        .hub_url
        .clone()
        .or_else(|| state.as_ref().map(|s| s.url.clone()))
    else {
        return Err(Stop::usage("--hub-url is required to join a hub"));
    };
    // The machine gets this very binary, or for another OS or CPU this version's release build for it.
    let binary = std::fs::read(exe).map_err(|error| {
        Stop::fail(format!(
            "machine add copies the running fleetd to the machine, and {} is unreadable: {error}",
            exe.display()
        ))
    })?;
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
        hub_url,
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
    Ok(Resolved {
        machine,
        machine_id,
        local,
        host,
        joining,
        home,
        state,
        target,
        input,
        binary,
        exe: exe.to_owned(),
        again,
        enroll: a.enroll.clone(),
        claude_config_dir: a.claude_config_dir.clone(),
    })
}

/// `--dry-run`: the plan for a fresh machine, printed; nothing connects.
fn dry_run(r: &Resolved) -> Result<(), Stop> {
    let user = match r.host.split_once('@') {
        Some((user, _)) => user.to_owned(),
        None => std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "user".into()),
    };
    let plan = plan_machine_add(&fresh_facts(&user, &r.input.binary_target.1), &r.input)
        .map_err(Stop::fail)?;
    say(&format!(
        "dry run: nothing runs. Planned for a fresh Linux machine at {} (home {}); a real run first reads the machine's state and leaves out what is already done:",
        r.host,
        plan.layout
            .fleetd
            .strip_suffix("/.fleetd")
            .unwrap_or(&plan.layout.fleetd)
    ));
    say("[probe] read the machine's state (read-only)");
    let total = plan.steps.len();
    let exe = r.exe.display().to_string();
    for (i, step) in plan.steps.iter().enumerate() {
        Print.begin(plan_step(i + 1, total, step, &exe, r.binary.len() as u64));
    }
    say(&format!("[hub] wait until {} is online", r.machine_id));
    for note in &plan.notes {
        say(&format!("note: {note}"));
    }
    Ok(())
}

/// Reads the machine (read-only) and plans `machine add` there; changes nothing. `hub` says whether it already holds
/// the node's key; a joining worker has none.
///
/// A machine of another OS or CPU gets this version's release build for it, unless it has that build already (by the
/// release's SHA256SUMS): with `fetch`, `builds` downloads and checks it as a step of its own; without (a plan), the
/// step is only listed.
pub async fn prepare(
    r: &Resolved,
    hub: Option<HubSide<'_>>,
    runner: &dyn Runner,
    builds: &dyn Builds,
    fetch: bool,
    progress: &dyn Progress,
) -> Result<Prepared, Stop> {
    progress.say(&format!(
        "setting up {}{}; every command is shown before it runs.",
        r.machine_id,
        if r.local {
            String::new()
        } else {
            format!(" on {}", r.host)
        }
    ));
    progress.begin(Begin {
        stage: Stage::Probe,
        title: "read the machine's state (read-only)".into(),
        command: None,
        stdin: None,
    });
    let relocated = crate::home::relocated().map(|d| d.to_string_lossy().into_owned());
    let probe = probe_command(relocated.as_deref().filter(|_| r.local));
    let probed = runner.run(&r.target, &probe, None).await;
    let facts = match (probed.code, parse_facts(&probed.stdout)) {
        (0, Ok(facts)) => facts,
        (code, parsed) => {
            let why = match parsed {
                Err(e) if code == 0 => e,
                _ => tail(&probed.stderr),
            };
            return Err(Stop::fail(format!(
                "cannot read {}{} (exit {code}): {why}\nFix: {}then run {}",
                r.host,
                if r.local { "" } else { " over SSH" },
                if r.local {
                    String::new()
                } else {
                    format!(
                        "make `ssh {h} true` work without a password (ssh-copy-id {h}), ",
                        h = r.host
                    )
                },
                r.again
            )));
        }
    };
    // What it printed is the machine's files: nothing to show.
    progress.done("");

    // A joined worker being repaired: the hub holds its key as long as its node.json says enrolled.
    let has_key = matches!(r.enroll, Enroll::Keep)
        || hub.is_some_and(|hub| {
            hub.auth
                .node_pub_key(&r.machine)
                .is_ok_and(|key| key.is_some())
        });
    let mut input = MachineAddInput {
        hub_has_node_key: has_key,
        ..r.input.clone()
    };
    // Another OS or CPU than this fleetd's: the same version, built for it.
    let target = (facts.platform.clone(), facts.arch.clone());
    // What the release workflow builds (.github/workflows/build-release.yml): no Linux ARM yet.
    let buildable = matches!(
        (target.0.as_str(), target.1.as_str()),
        ("linux", "x64") | ("darwin", "x64" | "arm64")
    );
    let (mut fetched, mut listed) = (None, None);
    if target != input.binary_target && buildable {
        let asset = format!("fleetd-{}-{}", target.0, target.1);
        let again = |why: String| Stop::fail(format!("{why}, then run {}", r.again));
        let wanted = builds
            .digest(crate::version(), &asset)
            .await
            .map_err(again)?;
        let has = facts
            .digests
            .get(&facts.layout().bin)
            .and_then(|d| d.as_deref())
            == Some(wanted.as_str());
        let step = Begin {
            stage: Stage::Hub,
            title: format!(
                "download fleetd {} for {}-{} (this hub's is a {}-{} build), checked against its release's SHA256SUMS",
                crate::version(),
                target.0,
                target.1,
                input.binary_target.0,
                input.binary_target.1
            ),
            command: None,
            stdin: None,
        };
        if has {
            // It has this very build: nothing to download, nothing to copy.
        } else if fetch {
            progress.begin(step);
            let bytes = builds
                .build(crate::version(), &asset)
                .await
                .map_err(again)?;
            if format!("{:x}", Sha256::digest(&bytes)) != wanted {
                return Err(again(format!(
                    "the release's {asset} changed while it was being read (a new edge build?)"
                )));
            }
            progress.done("");
            fetched = Some((asset, bytes));
        } else {
            listed = Some(step);
        }
        input.binary_digest = wanted;
        input.binary_target = target;
    }
    let plan = plan_machine_add(&facts, &input)
        .map_err(|message| Stop::fail(format!("{message}, then run {}", r.again)))?;
    // Never stop or re-enrol a joined node without a fresh code: that is what --join with --rejoin is for.
    if matches!(r.enroll, Enroll::Keep)
        && plan
            .steps
            .iter()
            .any(|s| s.stdin == Some(Stdin::EnrollToken))
    {
        return Err(Stop::fail(format!(
            "this machine's node is no longer enrolled with {} as {id}. Fix: on the hub, run fleetd pair --worker {id}, then run what it prints here with --rejoin",
            input.hub_url,
            id = r.machine_id
        )));
    }
    let prepared = Prepared {
        facts,
        plan,
        input,
        fetched,
    };
    let mut steps: Vec<Begin> = listed.into_iter().collect();
    steps.extend(prepared.steps(r));
    if prepared.plan.run_by_hand.is_none() && hub.is_some() {
        steps.push(wait_step(&r.machine_id));
    }
    progress.planned(&steps);
    Ok(prepared)
}

fn wait_step(machine_id: &str) -> Begin {
    Begin {
        stage: Stage::Hub,
        title: format!("waiting until {machine_id} is online (up to 2 min)"),
        command: None,
        stdin: None,
    }
}

/// Runs the plan [`prepare`] made: records the machine in the hub's setup, runs each step, waits until its node is
/// online and checks its claude login.
pub async fn execute(
    r: Resolved,
    p: Prepared,
    hub: Option<HubSide<'_>>,
    runner: &dyn Runner,
    progress: &dyn Progress,
) -> Result<Added, Stop> {
    let (what, binary) = p.binary(&r);
    let (what, binary) = (what, binary.to_vec());
    let Prepared {
        facts, plan, input, ..
    } = p;
    let (machine_id, host) = (&r.machine_id, &r.host);
    // Recorded before anything changes, so `machine remove` can undo a run that stopped half way.
    if let Some(state) = &r.state {
        let mut recorded = state.clone();
        recorded.machines.insert(
            machine_id.clone(),
            MachineRecord {
                ssh_host: host.clone(),
                ssh_config: r.target.config.clone(),
                local: r.local,
                platform: plan.platform,
                home: facts.home.clone(),
                config_home: facts.config_home.clone(),
                uid: facts.uid,
            },
        );
        write_setup(&r.home, &recorded).map_err(Stop::fail)?;
    }

    // Set after each step, so after the last one (the node's (re)start) only the new node can count as linked.
    let mut steps_done = now_ms();
    let total = plan.steps.len();
    for (i, step) in plan.steps.iter().enumerate() {
        progress.begin(plan_step(i + 1, total, step, &what, binary.len() as u64));
        let stdin: Option<Vec<u8>> = match &step.stdin {
            None => None,
            Some(Stdin::Text { text, .. }) => Some(text.clone().into_bytes()),
            Some(Stdin::Binary) => Some(binary.clone()),
            Some(Stdin::EnrollToken) => match (&r.enroll, hub) {
                (Enroll::Token(token), _) => Some(format!("{token}\n").into_bytes()),
                (Enroll::Hub, Some(hub)) => match hub.auth.create_enroll_token(&r.machine) {
                    Ok(token) => Some(format!("{}\n", token.token).into_bytes()),
                    Err(error) => return Err(Stop::fail(error.to_string())),
                },
                (Enroll::Hub, None) | (Enroll::Keep, _) => {
                    unreachable!("only a hub or a code enrolls")
                }
            },
        };
        let result = runner.run(&r.target, &step.command, stdin.as_deref()).await;
        if result.code != 0 {
            let fix = if step.stdin == Some(Stdin::EnrollToken) && r.joining {
                "the code is single use and lasts 15 minutes: on the hub, run fleetd pair --worker for a new one".to_owned()
            } else {
                format!("fix that, then run {}; finished steps are skipped", r.again)
            };
            return Err(Stop::fail(format!(
                "step {} failed (exit {}):\n{}\nFix: {fix}.",
                i + 1,
                result.code,
                tail(&format!("{}\n{}", result.stdout, result.stderr))
            )));
        }
        steps_done = now_ms();
        progress.done(&result.stdout);
    }

    if let Some(cmd) = &plan.run_by_hand {
        progress.say(&format!(
            "{machine_id} is enrolled; with --no-service, start its node yourself{}:\n  {cmd}",
            if r.local {
                String::new()
            } else {
                format!(" on {host}")
            }
        ));
    } else if let Some(hub) = hub {
        let already = !plan.node_restarts
            && hub
                .store
                .machine_get(&r.machine)
                .ok()
                .flatten()
                .is_some_and(|m| m.status != MachineStatus::Offline);
        if !already {
            progress.begin(wait_step(machine_id));
            if wait_linked(hub.store, &r.machine, steps_done, Duration::from_secs(120))
                .await
                .is_none()
            {
                return Err(Stop::fail(format!(
                    "{machine_id} did not come online within 2 min. Its node log is {}/node.log on {host}; the node must reach the hub at {}. Fix: make that address reachable from {host} (fleetd init --url <address>), then run {}",
                    plan.layout.logs, input.hub_url, r.again
                )));
            }
            progress.done("");
        }
        progress.say(&format!("{machine_id} is online."));
    }
    // A worker's claude with no login fails every session; say so now, not at the first order.
    let claude = facts.claude.clone().unwrap_or_default();
    let config_dir = r.claude_config_dir.clone();
    let status = runner
        .run(
            &r.target,
            &login_status_command(&plan.layout, &claude, config_dir.as_deref()),
            None,
        )
        .await;
    let logged_in = logged_in(&status.stdout);
    let mut notes = plan.notes.clone();
    if !logged_in {
        let login = login_command(&claude, config_dir.as_deref());
        notes.push(format!(
            "claude on {machine_id} is not logged in, so its sessions can't start. Fix: {}",
            if r.local {
                login
            } else {
                format!("ssh -t {host} {}", super::units::q(&login))
            }
        ));
    }
    for note in &notes {
        progress.say(&format!("note: {note}"));
    }
    Ok(Added {
        machine_id: r.machine_id,
        target: r.target,
        layout: plan.layout,
        claude,
        logged_in,
        run_by_hand: plan.run_by_hand,
        claude_config_dir: config_dir,
        notes,
    })
}

async fn remove_command(argv: &[String]) -> u8 {
    let v = match args::parse(
        argv,
        &Spec {
            options: &[("purge", Kind::Bool)],
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
    let home = match resolve_home(None) {
        Ok(home) => home,
        Err(message) => return fail(&message),
    };
    let hub = match open_hub(&home) {
        Ok(hub) => hub,
        Err(message) => return fail(&message),
    };
    match remove(&home, &machine, v.flag("purge"), hub.side(), &Ssh, &Print).await {
        Ok(removed) if removed.remote_ok => 0,
        Ok(_) => 1,
        Err(stop) => stop.print(),
    }
}

/// What `machine remove` did.
pub struct Removed {
    /// The hub held the node's key and revoked it.
    pub revoked: bool,
    /// Every step on the machine ran (true when it had none to run).
    pub remote_ok: bool,
}

/// `machine remove`: stops and removes the node's service on a machine `machine add` set up (with `purge` its files
/// too), then revokes its key on the hub and forgets it. A step that fails is reported with the steps left to run by
/// hand, and the key is revoked anyway.
pub async fn remove(
    home: &Path,
    machine: &MachineId,
    purge: bool,
    hub: HubSide<'_>,
    runner: &dyn Runner,
    progress: &dyn Progress,
) -> Result<Removed, Stop> {
    let machine_id = machine.to_string();
    let state = read_setup(home).map_err(Stop::fail)?;
    let record = state
        .as_ref()
        .and_then(|s| s.machines.get(&machine_id))
        .cloned();

    let mut remote_ok = true;
    match &record {
        None => progress.say(&format!(
            "{machine_id} was not set up by fleetd machine add from this hub, so only its key is revoked here; stop its node by hand."
        )),
        Some(record) => {
            let target = SshTarget {
                host: record.ssh_host.clone(),
                config: record.ssh_config.clone(),
                local: record.local,
            };
            let relocated = crate::home::relocated()
                .map(|d| d.to_string_lossy().into_owned())
                .filter(|_| record.local);
            // A second fleet's local node never stops the first fleet's node service.
            let own_service = match &relocated {
                None => true,
                Some(fleetd) => {
                    let unit = super::units::unit_path(
                        record.platform,
                        &super::units::Dirs {
                            home: &record.home,
                            config_home: &record.config_home,
                        },
                        super::units::Role::Node,
                    );
                    let node_home =
                        super::machine_plan::machine_layout_at(&record.home, fleetd).node_home;
                    let own = !super::units::foreign_unit(
                        std::fs::read_to_string(&unit).ok().as_deref(),
                        &node_home,
                    );
                    if !own {
                        progress.say(&format!(
                            "left {unit} alone: it runs another fleet's node"
                        ));
                    }
                    own
                }
            };
            let steps = plan_machine_remove(
                record.platform,
                &record.home,
                relocated.as_deref(),
                &record.config_home,
                record.uid,
                own_service,
                purge,
            );
            let total = steps.len();
            let begins: Vec<Begin> = steps
                .iter()
                .enumerate()
                .map(|(i, step)| plan_step(i + 1, total, step, "", 0))
                .collect();
            progress.planned(&begins);
            for (i, begin) in begins.into_iter().enumerate() {
                progress.begin(begin);
                let result = runner.run(&target, &steps[i].command, None).await;
                if result.code != 0 {
                    remote_ok = false;
                    let rest: Vec<String> = steps[i..]
                        .iter()
                        .map(|s| format!("    {}", show_ssh(&target, &s.command)))
                        .collect();
                    progress.failed(
                        result.code,
                        &tail(&result.stderr),
                        &format!("run the remaining steps yourself:\n{}", rest.join("\n")),
                    );
                    break;
                }
                progress.done(&result.stdout);
            }
        }
    }

    let revoked = hub
        .auth
        .revoke_node(machine)
        .and_then(|revoked| hub.store.machine_remove(machine).map(|()| revoked))
        .map_err(|error| Stop::fail(error.to_string()))?;
    progress.say(&if revoked {
        format!("revoked {machine_id}'s node key; the hub refuses that node from now on.")
    } else {
        format!("the hub held no node key for {machine_id}.")
    });
    if let (Some(mut state), Some(_)) = (state, &record) {
        state.machines.remove(&machine_id);
        write_setup(home, &state).map_err(Stop::fail)?;
    }
    if let Some(record) = &record
        && !purge
    {
        progress.say(&format!(
            "fleetd's Claude login and the node's files stay on {}; --purge deletes them.",
            record.ssh_host
        ));
    }
    Ok(Removed { revoked, remote_ok })
}

/// `fleetd machine …`.
pub async fn machine_command(argv: &[String]) -> u8 {
    match argv.first().map(String::as_str) {
        Some("add") => add_command(&argv[1..]).await,
        Some("remove") => remove_command(&argv[1..]).await,
        Some("set") => crate::cli::project::machine_set_command(&argv[1..]).await,
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
    pub fn local(machine_id: String, service: bool) -> Self {
        AddArgs {
            host: None,
            machine_id: Some(machine_id),
            dry_run: false,
            hub_url: None,
            ssh_config: None,
            home: None,
            enroll: Enroll::Hub,
            git_identity: None,
            no_service: !service,
            claude_config_dir: None,
        }
    }
}

/// `claude auth status --json` says it is logged in.
pub(super) fn logged_in(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|v| v.get("loggedIn").and_then(serde_json::Value::as_bool))
        == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_of_another_os_or_cpu_gets_its_versions_release() {
        assert_eq!(
            release_of("0.9.2", None),
            (
                "https://github.com/unlaboredlabs/fleetd/releases/download/v0.9.2".into(),
                false
            )
        );
        assert_eq!(
            release_of("0.9.2-edge.202610271107+333368c", Some("")),
            (
                "https://github.com/unlaboredlabs/fleetd/releases/download/edge".into(),
                true
            )
        );
        assert_eq!(
            release_of("0.9.2", Some("http://127.0.0.1:8000/assets")),
            ("http://127.0.0.1:8000/assets".into(), false)
        );
    }

    /// A release feed of named files.
    struct Files(std::collections::HashMap<&'static str, Vec<u8>>);

    impl crate::update::Feed for Files {
        fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
            Box::pin(async move {
                self.0
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("{name}: 404"))
            })
        }
    }

    fn feed(cli: &str) -> Files {
        let build = b"fleetd for darwin-arm64".to_vec();
        let sums = format!(
            "{}  fleetd-darwin-arm64\n",
            crate::update::sha256_hex(&build)
        );
        Files(
            [
                (
                    "release.json",
                    format!(r#"{{"cliVersion":"{cli}"}}"#).into_bytes(),
                ),
                ("SHA256SUMS", sums.into_bytes()),
                ("fleetd-darwin-arm64", build),
            ]
            .into(),
        )
    }

    #[tokio::test]
    async fn an_edge_hub_takes_a_build_only_while_the_edge_release_is_its_own() {
        let mine = "0.9.2-edge.202610271107+333368c";
        let digest = release_digest(&feed(mine), true, mine, "fleetd-darwin-arm64")
            .await
            .unwrap();
        let build = release_build(&feed(mine), true, mine, "fleetd-darwin-arm64")
            .await
            .unwrap();
        assert_eq!(crate::update::sha256_hex(&build), digest);

        let moved = feed("0.9.2-edge.202610281107+444444d");
        for why in [
            release_digest(&moved, true, mine, "fleetd-darwin-arm64")
                .await
                .unwrap_err(),
            release_build(&moved, true, mine, "fleetd-darwin-arm64")
                .await
                .unwrap_err(),
        ] {
            assert!(
                why.contains("the edge release is now 0.9.2-edge.202610281107+444444d")
                    && why.ends_with("Fix: update the hub (fleetd update)"),
                "{why}"
            );
        }
        // A tagged release is its version's for good: no release.json to ask.
        assert!(
            release_digest(&moved, false, "0.9.2", "fleetd-darwin-arm64")
                .await
                .is_ok()
        );
        let none = release_digest(&feed(mine), false, "0.9.2", "fleetd-linux-x64")
            .await
            .unwrap_err();
        assert!(
            none.starts_with("no fleetd-linux-x64 of fleetd 0.9.2"),
            "{none}"
        );
    }

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
            node_unit_facts("fleetd-node.service", systemd),
            Some(Some(GitIdentity {
                name: "Ada Lovelace".into(),
                email: "1+ada@users.noreply.github.com".into()
            }))
        );
        let plist = "    <key>GIT_AUTHOR_NAME</key>\n    <string>Ada &amp; Co</string>\n    <key>GIT_AUTHOR_EMAIL</key>\n    <string>a@b</string>\n";
        assert_eq!(
            node_unit_facts("sh.fleetd.node.plist", plist).map(|i| i.map(|i| i.name)),
            Some(Some("Ada & Co".into()))
        );
        assert_eq!(node_unit_facts("fleetd-hub.service", systemd), None);
        assert_eq!(node_unit_facts("fleetd-node.service", ""), Some(None));
        assert_eq!(node_unit_facts("fleetd-node-lab.service", systemd), None);
    }
}
