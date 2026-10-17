//! Each doctor check as a pure function of what the hub read: a status, a plain message, and at most one fix. Only
//! three fixes are automatic (restart T3 with the node's own command, re-mint the hub's T3 session, re-apply the
//! fleetd instance config); every other fix is a command for a person to run. TS: apps/hub/src/doctor/checks.ts
//! (after the phone app's removal: no push check).
use super::config::{HubConfig, MachineSetup, restart_command};
use crate::hub::usage::probes::ProbeCounter;
use crate::hub::usage::service::UsageBreaker;
use crate::hub::usage::time::clip;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// The fleetd provider instance in T3's settings (executor/ProviderList.ts).
pub const FLEETD_INSTANCE: &str = "fleetd";

#[derive(Deserialize)]
struct Pin {
    commit: String,
    npm: String,
}
static PIN: LazyLock<Pin> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../../vendor/t3/pin.json"))
        .expect("vendor/t3/pin.json")
});

/// T3 commit the vendored wire client comes from.
pub fn t3_pin() -> &'static str {
    &PIN.commit
}
/// npm `t3` release built from the pin: what `fleetd machine add` installs and the doctor holds each machine to.
pub fn t3_npm_version() -> &'static str {
    &PIN.npm
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoctorStatus {
    Ok,
    Warn,
    Fail,
    Unknown,
}

impl DoctorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Fail => "fail",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorFix {
    /// "auto": doctor_fix runs it. "manual": a person runs `command`.
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    /// "hub" or "machine".
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    pub status: DoctorStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<DoctorFix>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoAction {
    RestartT3,
    RemintSession,
    ReapplyInstance,
}

impl AutoAction {
    /// The node action name (node-link `node_action`), for the two the node runs.
    pub fn node_action(self) -> &'static str {
        match self {
            Self::RestartT3 => "restart_t3",
            Self::RemintSession => "remint_session",
            Self::ReapplyInstance => "reapply_instance",
        }
    }
}

/// A check with the automatic fix behind its `auto` fix, if it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub check: DoctorCheck,
    pub action: Option<AutoAction>,
}

/// The disk floor: below this a machine cannot hold more worktrees.
pub const MIN_FREE_BYTES: f64 = 5e9;
/// Every tool the fleetd instance must deny: T3's own (they spawn and schedule outside fleetd's slots) and Claude's
/// subagents.
pub const REQUIRED_DISALLOWED: [&str; 3] = ["mcp__t3-code__*", "Task", "Workflow"];
const DISALLOWED_FLAGS: [&str; 2] = ["--disallowedTools", "--disallowed-tools"];

fn manual(label: &str, command: Option<String>) -> DoctorFix {
    DoctorFix {
        kind: "manual".into(),
        label: clip(label, 200),
        command,
    }
}

fn auto(label: String) -> DoctorFix {
    DoctorFix {
        kind: "auto".into(),
        label,
        command: None,
    }
}

fn hub_entry(name: &str, status: DoctorStatus, message: &str, fix: Option<DoctorFix>) -> Entry {
    Entry {
        check: DoctorCheck {
            id: format!("hub/{name}"),
            scope: "hub".into(),
            machine_id: None,
            status,
            message: clip(message, 500),
            fix,
        },
        action: None,
    }
}

fn machine_entry(
    machine_id: &str,
    name: &str,
    status: DoctorStatus,
    message: &str,
    fix: Option<DoctorFix>,
    action: Option<AutoAction>,
) -> Entry {
    Entry {
        check: DoctorCheck {
            id: format!("{machine_id}/{name}"),
            scope: "machine".into(),
            machine_id: Some(machine_id.to_string()),
            status,
            message: clip(message, 500),
            fix,
        },
        action,
    }
}

fn setup_again(machine_id: &str, setup: Option<&MachineSetup>) -> DoctorFix {
    let host = setup.map_or_else(
        || format!("<ssh host of {machine_id}>"),
        |s| s.ssh_host.clone(),
    );
    manual(
        "Run machine setup again from the hub; it is idempotent",
        Some(format!("fleetd machine add {host}")),
    )
}

use DoctorStatus::{Fail, Ok as Pass, Unknown, Warn};

// Hub checks

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Probe {
    Ok,
    Failed(String),
}

pub fn hub_reachable(url: &str, probe: &Probe, restart: String) -> Entry {
    match probe {
        Probe::Ok => hub_entry(
            "reachable",
            Pass,
            &format!("The hub answers at {url}."),
            None,
        ),
        Probe::Failed(why) => hub_entry(
            "reachable",
            Fail,
            &format!("The hub does not answer at its own address {url} ({why})."),
            Some(manual("Restart the hub service", Some(restart))),
        ),
    }
}

/// A finished command, or why it could not start (`ENOENT` when the binary is missing).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CmdOutcome {
    Ran {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    SpawnError(String),
}

static GH_ACCOUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"account (\S+)").unwrap());

pub fn gh_auth(outcome: &CmdOutcome) -> Entry {
    let (exit_code, stdout, stderr) = match outcome {
        CmdOutcome::SpawnError(e) if e == "ENOENT" => {
            return hub_entry(
                "gh_auth",
                Fail,
                "The GitHub CLI (gh) is not installed on the hub; the merge train and PR checks need it.",
                Some(manual(
                    "Install gh (https://cli.github.com), then log in",
                    Some("gh auth login".into()),
                )),
            );
        }
        CmdOutcome::SpawnError(e) => {
            return hub_entry(
                "gh_auth",
                Unknown,
                &format!("Could not run gh on the hub: {e}"),
                None,
            );
        }
        CmdOutcome::Ran {
            exit_code,
            stdout,
            stderr,
        } => (*exit_code, stdout, stderr),
    };
    if exit_code != 0 {
        return hub_entry(
            "gh_auth",
            Fail,
            "gh is not logged in on the hub; the merge train and PR checks need it.",
            Some(manual(
                "Log gh in on the hub machine",
                Some("gh auth login".into()),
            )),
        );
    }
    let both = format!("{stdout}\n{stderr}");
    match GH_ACCOUNT.captures(&both) {
        Some(c) => hub_entry(
            "gh_auth",
            Pass,
            &format!("gh is logged in on the hub as {}.", &c[1]),
            None,
        ),
        None => hub_entry("gh_auth", Pass, "gh is logged in on the hub.", None),
    }
}

pub fn claude_login_fix() -> DoctorFix {
    manual(
        "Log the hub user's claude in (or put ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the env block of ~/.claude/settings.json)",
        Some("claude auth login".into()),
    )
}

/// `claude auth status --json` as the router runs it (same environment, so the same login). The intake router and
/// the retro reach a model only through this login; without it they can't run.
pub fn claude_login(outcome: &CmdOutcome) -> Entry {
    let (exit_code, stdout) = match outcome {
        CmdOutcome::SpawnError(e) if e == "ENOENT" => {
            return hub_entry(
                "claude_login",
                Fail,
                "Claude Code (claude) is not on the hub's PATH; the intake router and the retro can't run.",
                Some(manual(
                    "Install Claude Code on the hub machine, then log in",
                    Some("claude auth login".into()),
                )),
            );
        }
        CmdOutcome::SpawnError(e) => {
            return hub_entry(
                "claude_login",
                Unknown,
                &format!("Could not run claude on the hub: {e}"),
                None,
            );
        }
        CmdOutcome::Ran {
            exit_code, stdout, ..
        } => (*exit_code, stdout),
    };
    let Some(status) = serde_json::from_str::<Value>(stdout)
        .ok()
        .filter(|v| !v.is_null())
    else {
        return hub_entry(
            "claude_login",
            Unknown,
            &format!("claude auth status gave no JSON (exit {exit_code})."),
            None,
        );
    };
    if status.get("loggedIn") != Some(&Value::Bool(true)) {
        return hub_entry(
            "claude_login",
            Fail,
            "claude on the hub is not logged in; the intake router and the retro can't reach a model.",
            Some(claude_login_fix()),
        );
    }
    let method = status
        .get("authMethod")
        .and_then(Value::as_str)
        .map_or(String::new(), |m| format!(" ({m})"));
    hub_entry(
        "claude_login",
        Pass,
        &format!(
            "claude on the hub is logged in{method}; the intake router and the retro can run."
        ),
        None,
    )
}

pub fn https_reachable(
    config: &HubConfig,
    problem: Option<&str>,
    port: u16,
    probe: Option<&Probe>,
) -> Entry {
    let serve = || {
        manual(
            "Serve the hub over HTTPS (Tailscale Serve shown), then stop the hub and run fleetd init --url https://<that address>",
            Some(format!("tailscale serve --bg {port}")),
        )
    };
    if let Some(p) = problem {
        return hub_entry("https", Warn, p, Some(serve()));
    }
    let Some(url) = &config.url else {
        return hub_entry(
            "https",
            Warn,
            "The hub has no address set up (fleetd init --url), so the desktop app and other machines cannot reach it over HTTPS.",
            Some(serve()),
        );
    };
    if !url.starts_with("https://") {
        return hub_entry(
            "https",
            Warn,
            &format!(
                "The hub's address {url} is not HTTPS; keys from the desktop app and other machines would cross the network unencrypted."
            ),
            Some(serve()),
        );
    }
    match probe {
        None | Some(Probe::Ok) => hub_entry(
            "https",
            Pass,
            &format!("The hub is reachable over HTTPS at {url}."),
            None,
        ),
        Some(Probe::Failed(why)) => hub_entry(
            "https",
            Fail,
            &format!("{url} does not answer ({why})."),
            Some(manual(
                "Check that HTTPS still points at the hub",
                Some("tailscale serve status".into()),
            )),
        ),
    }
}

// Machine checks

/// The fields of `Machine` the checks read.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineView {
    pub machine_id: String,
    /// "online", "degraded" or "offline".
    pub status: String,
    pub last_seen_at: String,
    pub t3: Option<T3Info>,
    #[serde(default)]
    pub degraded_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct T3Info {
    pub version: String,
}

pub fn machine_online(
    machine: &MachineView,
    connected: bool,
    setup: Option<&MachineSetup>,
) -> Entry {
    let id = machine.machine_id.as_str();
    match machine.status.as_str() {
        "offline" => machine_entry(
            id,
            "online",
            Fail,
            &format!("{id} is offline (last seen {}).", machine.last_seen_at),
            Some(manual(
                &format!("Start the fleetd node on {id}"),
                Some(restart_command("node", setup)),
            )),
            None,
        ),
        "degraded" => machine_entry(
            id,
            "online",
            Fail,
            &format!(
                "{id} is degraded: {}.",
                machine.degraded_reason.as_deref().unwrap_or("T3 is down")
            ),
            Some(auto(format!(
                "Restart T3 on {id} with its node's restart command"
            ))),
            Some(AutoAction::RestartT3),
        ),
        _ if connected => {
            machine_entry(id, "online", Pass, &format!("{id} is online."), None, None)
        }
        _ => machine_entry(
            id,
            "online",
            Fail,
            &format!(
                "{id}'s node is linked, but the hub has no T3 connection there (its session may be revoked or expired)."
            ),
            Some(auto(format!("Re-mint the hub's T3 session on {id}"))),
            Some(AutoAction::RemintSession),
        ),
    }
}

pub fn t3_version(machine: &MachineView, setup: Option<&MachineSetup>) -> Entry {
    let id = machine.machine_id.as_str();
    let Some(t3) = &machine.t3 else {
        return machine_entry(
            id,
            "t3_version",
            Unknown,
            &format!("T3 on {id} has not reported its version yet."),
            None,
            None,
        );
    };
    let (npm, pin) = (t3_npm_version(), t3_pin());
    if t3.version == npm {
        return machine_entry(
            id,
            "t3_version",
            Pass,
            &format!("T3 {npm}, the version setup installs."),
            None,
            None,
        );
    }
    // The node reports T3 run from a source checkout as `<package version>+<commit>`.
    if t3.version.ends_with(&format!("+{pin}")) {
        return machine_entry(
            id,
            "t3_version",
            Pass,
            &format!(
                "T3 from source at {}, the commit setup's {npm} is built from.",
                &pin[..pin.len().min(10)]
            ),
            None,
            None,
        );
    }
    machine_entry(
        id,
        "t3_version",
        Fail,
        &format!("T3 {} runs on {id}; setup installs {npm}.", t3.version),
        Some(setup_again(id, setup)),
        None,
    )
}

fn tokens(args: &str) -> impl Iterator<Item = &str> {
    args.split_whitespace()
}

fn split_flag(token: &str) -> (&str, Option<&str>) {
    match token.find('=') {
        Some(i) => (&token[..i], Some(&token[i + 1..])),
        None => (token, None),
    }
}

/// The tools a launch-args string denies, from every `--disallowedTools` (or `=`) flag, comma or space separated.
pub fn disallowed_tools(launch_args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_flag = false;
    for token in tokens(launch_args) {
        let (flag, inline) = split_flag(token);
        if DISALLOWED_FLAGS.contains(&flag) {
            in_flag = inline.is_none();
            if let Some(list) = inline {
                out.extend(list.split(',').map(str::to_string));
            }
            continue;
        }
        if token.starts_with('-') {
            in_flag = false;
        } else if in_flag {
            out.extend(token.split(',').map(str::to_string));
        }
    }
    out.retain(|t| !t.is_empty());
    out
}

/// The launch args with one `--disallowedTools` flag that denies everything required plus whatever it denied before.
pub fn with_required_args(launch_args: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut in_flag = false;
    for token in tokens(launch_args) {
        let (flag, _) = split_flag(token);
        if DISALLOWED_FLAGS.contains(&flag) {
            in_flag = !token.contains('=');
            continue;
        }
        if token.starts_with('-') {
            in_flag = false;
        }
        if !in_flag {
            kept.push(token);
        }
    }
    let mut denied: Vec<String> = Vec::new();
    for t in REQUIRED_DISALLOWED
        .iter()
        .map(|s| s.to_string())
        .chain(disallowed_tools(launch_args))
    {
        if !denied.contains(&t) {
            denied.push(t);
        }
    }
    let joined = denied.join(",");
    let mut all = kept;
    all.push("--disallowedTools");
    all.push(&joined);
    all.join(" ")
}

fn config_of(instance: &Value) -> Map<String, Value> {
    instance
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

static OWN_CLAUDE_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/\.claude/?$").unwrap());

fn fleetd_instance(settings: &Value) -> Option<&Value> {
    settings.get("providerInstances")?.get(FLEETD_INSTANCE)
}

/// The fleetd instance, when it is one fleetd can re-apply: a Claude instance with its own config dir. `settings` is
/// T3's `ServerSettings` as JSON.
pub fn reapplicable(settings: &Value) -> Option<&Value> {
    let instance = fleetd_instance(settings)?;
    if instance.get("driver").and_then(Value::as_str) != Some("claudeAgent") {
        return None;
    }
    let config = config_of(instance);
    let home = config.get("homePath").and_then(Value::as_str)?;
    (!home.trim().is_empty() && !OWN_CLAUDE_DIR.is_match(home)).then_some(instance)
}

/// `instance_args` and `auto_resume`, from the machine's T3 settings, or why they could not be read.
pub fn instance_checks(
    machine_id: &str,
    settings: Result<&Value, &str>,
    setup: Option<&MachineSetup>,
) -> Vec<Entry> {
    let settings = match settings {
        Err(why) => {
            return ["instance_args", "auto_resume"]
                .iter()
                .map(|n| machine_entry(machine_id, n, Unknown, why, None, None))
                .collect();
        }
        Ok(s) => s,
    };
    let reapply = || {
        auto(format!(
            "Re-apply the fleetd instance config on {machine_id}"
        ))
    };
    let instance = fleetd_instance(settings);
    let config = instance.map(config_of).unwrap_or_default();
    let home = config
        .get("homePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let args = config
        .get("launchArgs")
        .and_then(Value::as_str)
        .unwrap_or("");
    let denied = disallowed_tools(args);
    let missing: Vec<&str> = REQUIRED_DISALLOWED
        .iter()
        .copied()
        .filter(|t| !denied.iter().any(|d| d == t))
        .collect();
    let driver = instance
        .and_then(|i| i.get("driver"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let fail = |message: String| {
        machine_entry(
            machine_id,
            "instance_args",
            Fail,
            &message,
            Some(setup_again(machine_id, setup)),
            None,
        )
    };
    let instance_args = if instance.is_none() {
        fail(format!(
            "T3 on {machine_id} has no \"{FLEETD_INSTANCE}\" Claude instance."
        ))
    } else if driver != "claudeAgent" {
        fail(format!(
            "The \"{FLEETD_INSTANCE}\" instance on {machine_id} runs {driver}, not Claude."
        ))
    } else if home.is_empty() {
        fail(format!(
            "The fleetd instance on {machine_id} has no config dir of its own (CLAUDE_CONFIG_DIR)."
        ))
    } else if reapplicable(settings).is_none() {
        fail(format!(
            "The fleetd instance on {machine_id} shares your own Claude config dir ({home})."
        ))
    } else if !missing.is_empty() {
        let shown = if args.trim().is_empty() {
            "none"
        } else {
            args.trim()
        };
        machine_entry(
            machine_id,
            "instance_args",
            Fail,
            &format!(
                "The fleetd instance on {machine_id} does not deny {} (launch args: {shown}).",
                missing.join(", ")
            ),
            Some(reapply()),
            Some(AutoAction::ReapplyInstance),
        )
    } else {
        machine_entry(
            machine_id,
            "instance_args",
            Pass,
            &format!(
                "The fleetd instance denies {} and uses its own config dir {home}.",
                REQUIRED_DISALLOWED.join(", ")
            ),
            None,
            None,
        )
    };
    let auto_resume = if settings
        .get("autoResumeLimitedThreads")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        machine_entry(
            machine_id,
            "auto_resume",
            Fail,
            &format!(
                "T3 on {machine_id} auto-resumes usage-limited threads, which bypasses fleetd's usage pacing."
            ),
            Some(reapply()),
            Some(AutoAction::ReapplyInstance),
        )
    } else {
        machine_entry(
            machine_id,
            "auto_resume",
            Pass,
            "T3 does not auto-resume usage-limited threads.",
            None,
            None,
        )
    };
    vec![instance_args, auto_resume]
}

pub fn probe_counter(machine_id: &str, probes: &ProbeCounter) -> Entry {
    if !probes.observable {
        return machine_entry(
            machine_id,
            "probes",
            Unknown,
            &format!(
                "Probe counter not observable: {}.",
                probes.reason.as_deref().unwrap_or("no trace to read")
            ),
            None,
            None,
        );
    }
    let count = probes.count.unwrap_or(0);
    if count == 0 {
        return machine_entry(
            machine_id,
            "probes",
            Pass,
            "T3 made no direct usage API calls (probe counter 0).",
            None,
            None,
        );
    }
    machine_entry(
        machine_id,
        "probes",
        Fail,
        &format!(
            "T3 on {machine_id} made {count} direct usage or reset-credit call{} (seen in {}).",
            if count == 1 { "" } else { "s" },
            probes.source.as_deref().unwrap_or("its trace")
        ),
        Some(manual(
            "Remove stored Claude credentials from the fleetd instance's config dir and any cliproxy usage source in T3's settings",
            None,
        )),
        None,
    )
}

pub fn usage_breaker(machine_id: &str, breaker: &UsageBreaker) -> Entry {
    if breaker.state == "closed" {
        return machine_entry(
            machine_id,
            "usage_breaker",
            Pass,
            "The usage breaker is closed.",
            None,
            None,
        );
    }
    let until = breaker
        .until
        .as_ref()
        .map_or(String::new(), |u| format!(" ({u})"));
    machine_entry(
        machine_id,
        "usage_breaker",
        Warn,
        &breaker.message.clone().unwrap_or_else(|| {
            format!("New turns on {machine_id} are paused by the usage breaker.")
        }),
        Some(manual(
            &format!(
                "Wait for the reset{until}, or call usage_resume for {machine_id} once the login has capacity"
            ),
            None,
        )),
        None,
    )
}

/// The node's `probe` action result (node-link `NodeActionResult.probe`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    #[serde(default)]
    pub git_email: Option<String>,
    /// "env": the node's service environment (GIT_AUTHOR_EMAIL), which setup gives T3 too; else git's global config.
    #[serde(default)]
    pub git_email_from: Option<String>,
    pub disk_path: String,
    pub disk_free_bytes: f64,
}

static NOREPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)@users\.noreply\.github\.com$").unwrap());

pub fn commit_identity(
    machine_id: &str,
    probe: Result<&HostProbe, &str>,
    config: &HubConfig,
) -> Entry {
    let probe = match probe {
        Err(why) => return machine_entry(machine_id, "commit_identity", Unknown, why, None, None),
        Ok(p) => p,
    };
    let want = config.git_identity.as_ref().map(|g| g.email.as_str());
    // Setup writes the identity into the T3 and node units; by hand, git's global config is the place.
    let set = || match want {
        None => manual(
            &format!("Set the commit identity on {machine_id}"),
            Some("git config --global user.email '<id>+<user>@users.noreply.github.com'".into()),
        ),
        Some(_) => {
            let host = config.machines.get(machine_id).map_or_else(
                || format!("<ssh host of {machine_id}>"),
                |m| m.ssh_host.clone(),
            );
            manual(
                &format!(
                    "Run machine setup again from the hub to write the hub's identity into {machine_id}'s services"
                ),
                Some(format!("fleetd machine add {host}")),
            )
        }
    };
    let Some(email) = &probe.git_email else {
        return machine_entry(
            machine_id,
            "commit_identity",
            Fail,
            &format!("No git commit identity is set on {machine_id}."),
            Some(set()),
            None,
        );
    };
    let from = if probe.git_email_from.as_deref() == Some("env") {
        "the service environment"
    } else {
        "git's global config"
    };
    if let Some(want) = want
        && email.to_lowercase() != want.to_lowercase()
    {
        return machine_entry(
            machine_id,
            "commit_identity",
            Warn,
            &format!(
                "Commits on {machine_id} use {email} (from {from}); the hub's identity is {want}."
            ),
            Some(set()),
            None,
        );
    }
    let noreply = if NOREPLY.is_match(email) {
        ", a GitHub noreply address"
    } else {
        ""
    };
    machine_entry(
        machine_id,
        "commit_identity",
        Pass,
        &format!("Commits on {machine_id} use {email} (from {from}{noreply})."),
        None,
        None,
    )
}

fn gb(bytes: f64) -> String {
    format!("{:.1} GB", bytes / 1e9)
}

pub fn disk_space(machine_id: &str, probe: Result<&HostProbe, &str>) -> Entry {
    let probe = match probe {
        Err(why) => return machine_entry(machine_id, "disk", Unknown, why, None, None),
        Ok(p) => p,
    };
    if probe.disk_free_bytes < 0.0 {
        return machine_entry(
            machine_id,
            "disk",
            Unknown,
            &format!(
                "Could not read the free space under {} on {machine_id}.",
                probe.disk_path
            ),
            None,
            None,
        );
    }
    if probe.disk_free_bytes < MIN_FREE_BYTES {
        return machine_entry(
            machine_id,
            "disk",
            Fail,
            &format!(
                "{} free under {} on {machine_id}; fleetd needs at least {}.",
                gb(probe.disk_free_bytes),
                probe.disk_path,
                gb(MIN_FREE_BYTES)
            ),
            Some(manual(
                &format!("Free disk space on {machine_id}"),
                Some(format!("df -h {}", probe.disk_path)),
            )),
            None,
        );
    }
    machine_entry(
        machine_id,
        "disk",
        Pass,
        &format!(
            "{} free under {}.",
            gb(probe.disk_free_bytes),
            probe.disk_path
        ),
        None,
        None,
    )
}
