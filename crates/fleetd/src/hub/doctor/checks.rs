//! Each doctor check as a pure function of what the hub read: a status, a plain message, and at most one fix, a
//! command for a person to run.
use super::config::{HubConfig, MachineSetup, restart_command};
use crate::hub::usage::service::UsageBreaker;
use crate::hub::usage::time::clip;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::hub::tasks::base;
use crate::node::runner::guide;
use fleetd_contracts::claude_accounts::{
    ClaudeHubApi, ClaudeSealedOn, ClaudeSubscription, ClaudeTest,
};
use fleetd_contracts::node_link::{
    AndroidHealth, AndroidState, DesktopHealth, DesktopState, IosHealth, IosState, NodeDisk,
};
use fleetd_contracts::sessions::{
    BaseErrorKind, LoginStatus, RunnerInfo, SandboxStatus, WorktreeBase,
};

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
    /// Where `command` runs: "hub" (the hub's machine) or "machine" (the check's machine). Set by the entry it is
    /// in, unless a fix says otherwise ([`on_hub`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub check: DoctorCheck,
}

fn manual(label: &str, command: Option<String>) -> DoctorFix {
    DoctorFix {
        kind: "manual".into(),
        label: clip(label, 200),
        command,
        on: None,
    }
}

/// A fix whose command runs on the hub's machine, though its check is a machine's.
fn on_hub(mut fix: DoctorFix) -> DoctorFix {
    fix.on = Some("hub".into());
    fix
}

/// The fix with where its command runs: where the fix says, else where its check is.
fn placed(fix: Option<DoctorFix>, scope: &str) -> Option<DoctorFix> {
    fix.map(|mut f| {
        if f.command.is_some() && f.on.is_none() {
            f.on = Some(scope.into());
        }
        f
    })
}

fn hub_entry(name: &str, status: DoctorStatus, message: &str, fix: Option<DoctorFix>) -> Entry {
    Entry {
        check: DoctorCheck {
            id: format!("hub/{name}"),
            scope: "hub".into(),
            machine_id: None,
            status,
            message: clip(message, 500),
            fix: placed(fix, "hub"),
        },
    }
}

fn machine_entry(
    machine_id: &str,
    name: &str,
    status: DoctorStatus,
    message: &str,
    fix: Option<DoctorFix>,
) -> Entry {
    Entry {
        check: DoctorCheck {
            id: format!("{machine_id}/{name}"),
            scope: "machine".into(),
            machine_id: Some(machine_id.to_string()),
            status,
            message: clip(message, 500),
            fix: placed(fix, "machine"),
        },
    }
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

/// Repos whose ready PRs wait because they have no CI: fleetd merges only on green CI, so they wait until it exists.
pub fn repo_ci(without_ci: &[String]) -> Entry {
    if without_ci.is_empty() {
        return hub_entry(
            "repo_ci",
            Pass,
            "Every repo with a PR ready to merge has CI.",
            None,
        );
    }
    let repos = without_ci.join(", ");
    hub_entry(
        "repo_ci",
        Fail,
        &format!("No CI on {repos}: fleetd merges only on green CI, so their ready PRs wait."),
        Some(manual(
            &format!("Add a GitHub Actions workflow that runs on pull requests to {repos}"),
            None,
        )),
    )
}

/// What the hub keeps of its optional setup: each check below is there only once its step is
/// set up, since "not set up" is no problem for a step nothing needs yet.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SetupFacts {
    /// Who joined after the hub's first person, by name.
    pub joined: Vec<String>,
    /// The hub's own GitHub App (D190), as the hub keeps it: where it is installed and its last Test.
    pub github_app: Option<fleetd_contracts::github_app::GithubApp>,
}

/// The setup checks the hub reads from its own state: someone else joined, the GitHub App. A step not set up has no
/// check.
pub fn setup_checks(facts: &SetupFacts) -> Vec<Entry> {
    let mut out = Vec::new();
    let joined = match facts.joined.as_slice() {
        [] => None,
        [one] => Some(format!("{one} has joined.")),
        [first, second] => Some(format!("{first} and {second} have joined.")),
        [first, rest @ ..] => Some(format!("{first} and {} others have joined.", rest.len())),
    };
    if let Some(joined) = joined {
        out.push(hub_entry("people", Pass, &joined, None));
    }
    if let Some(app) = &facts.github_app {
        out.push(github_app(app));
    }
    out
}

/// `hub/github_app`: the hub's own GitHub App, installed somewhere, and what its last Test said.
pub fn github_app(app: &fleetd_contracts::github_app::GithubApp) -> Entry {
    let fix = |what: &str| Some(manual(what, Some("fleetd github-app test".to_owned())));
    if app.installations.is_empty() {
        return hub_entry(
            "github_app",
            Warn,
            &format!(
                "The hub's GitHub App \"{}\" isn't installed on any repository yet.",
                app.name
            ),
            fix("Install it on Settings › Hub accounts › GitHub, then Test"),
        );
    }
    match &app.last_test {
        Some(t) if !t.ok => hub_entry(
            "github_app",
            Fail,
            &t.said,
            fix("Check it on Settings › Hub accounts › GitHub, then Test"),
        ),
        Some(t) => hub_entry("github_app", Pass, &t.said, None),
        None => {
            let places: Vec<&str> = app
                .installations
                .iter()
                .map(|i| i.account.as_str())
                .collect();
            hub_entry(
                "github_app",
                Pass,
                &format!(
                    "The hub's GitHub App \"{}\" is installed on {}.",
                    app.name,
                    places.join(", ")
                ),
                None,
            )
        }
    }
}

/// Why plain HTTP to `url` is safe, if it is: loopback never leaves the machine, and a tailnet address (100.64.0.0/10,
/// fd7a:115c:a1e0::/48 or a *.ts.net name) travels inside Tailscale's WireGuard tunnel.
pub fn sealed_http(url: &str) -> Option<&'static str> {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split('/').next().unwrap_or_default();
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => authority,
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let tailnet = "it stays inside your tailnet's encrypted tunnel";
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) if ip.is_loopback() => Some("it never leaves this machine"),
        Ok(std::net::IpAddr::V4(v4)) => {
            let [a, b, ..] = v4.octets();
            (a == 100 && (64..128).contains(&b)).then_some(tailnet)
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            (v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]).then_some(tailnet)
        }
        Err(_) if host == "localhost" => Some("it never leaves this machine"),
        Err(_) => host.ends_with(".ts.net").then_some(tailnet),
    }
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
        if let Some(why) = sealed_http(url) {
            return hub_entry(
                "https",
                Pass,
                &format!("The hub's address {url} is plain HTTP, which is fine: {why}."),
                None,
            );
        }
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
    #[serde(default)]
    pub degraded_reason: Option<String>,
}

/// The one fix for a machine whose runner is unusable, from the cause its probe reports: the runner missing, a
/// protocol break, logged out. Two causes at once become one ordered sentence (the install first, since a login on a
/// runner that can't run proves nothing). None when the runner reports no cause.
pub fn runner_fix(machine_id: &str, info: &RunnerInfo) -> Option<DoctorFix> {
    let g = guide(info.runner);
    let name = g.name();
    let install = match &info.version {
        None => Some((format!("Install {}", g.product()), g.install())),
        Some(_) if info.conformance_ok == Some(false) => {
            Some((format!("Put the tested {name}"), g.pin_tested()))
        }
        Some(_) => None,
    };
    let login = (info.login == LoginStatus::LoggedOut).then(|| g.login_fix(info.proxy.is_some()));
    Some(match (install, login) {
        (None, None) => return None,
        (Some((label, command)), None) => {
            manual(&format!("{label} on {machine_id}"), Some(command))
        }
        // Behind a proxy the proxy holds the login: nothing to paste.
        (None, Some(login)) if info.proxy.is_some() => manual(
            &format!(
                "On {machine_id}, {login} ({name} goes through {})",
                info.proxy.as_deref().unwrap_or_default()
            ),
            None,
        ),
        (None, Some(login)) => manual(
            &format!("Log {name} in on {machine_id}"),
            Some(login.to_owned()),
        ),
        (Some((_, command)), Some(login)) => {
            manual(&format!("On {machine_id}: {command}, then {login}"), None)
        }
    })
}

/// The node's link to the hub; what it runs is checked by the runner checks.
pub fn machine_online(
    machine: &MachineView,
    setup: Option<&MachineSetup>,
    runner: Option<&RunnerInfo>,
) -> Entry {
    let id = machine.machine_id.as_str();
    let restart = || {
        Some(manual(
            &format!("Restart the fleetd node on {id}"),
            Some(restart_command("node", setup)),
        ))
    };
    match machine.status.as_str() {
        "offline" => machine_entry(
            id,
            "online",
            Fail,
            &format!("{id} is offline (last seen {}).", machine.last_seen_at),
            restart(),
        ),
        "degraded" => {
            let reason = machine
                .degraded_reason
                .as_deref()
                .unwrap_or("its node reports a problem");
            // The node's reason carries its own "Fix: …"; the finding has one fix field, so it is cut from the text.
            let (cause, embedded) = match reason.split_once(" Fix: ") {
                Some((cause, fix)) => (cause, Some(fix.trim_end_matches('.'))),
                None => (reason, None),
            };
            // The cause decides the fix: a runner problem is fixed on the runner, and only a node with no runner cause
            // gets the restart.
            let fix = match (runner.and_then(|info| runner_fix(id, info)), embedded) {
                (Some(fix), _) => Some(fix),
                (None, Some(command)) => {
                    Some(manual(&format!("On {id}"), Some(command.to_owned())))
                }
                (None, None) => restart(),
            };
            machine_entry(
                id,
                "online",
                Warn,
                &format!("{id} is degraded: {}.", cause.trim_end_matches('.')),
                fix,
            )
        }
        _ => machine_entry(id, "online", Pass, &format!("{id} is online."), None),
    }
}

/// `<runner>_version`, `<runner>_login` and `runner_conformance` (claude's: `claude_version`, `claude_login`) from what
/// the node's runner reports (`runner_info`).
pub fn runner_checks(machine_id: &str, info: &RunnerInfo) -> Vec<Entry> {
    let g = guide(info.runner);
    let name = g.name();
    let (version_check, login_check) = (format!("{name}_version"), format!("{name}_login"));
    // Sessions use the machine's own runner setup, so the fix is the login the user would do for their own.
    let setup = g.setup(info);
    let login_fix = || {
        Some(if info.proxy.is_some() {
            manual(
                &format!(
                    "On {machine_id}, {} ({name} goes through {})",
                    g.login_fix(true),
                    info.proxy.as_deref().unwrap_or_default()
                ),
                None,
            )
        } else {
            manual(
                &format!("Log {name} in on {machine_id}"),
                Some(g.login_fix(false).into()),
            )
        })
    };
    let version = match &info.version {
        None => machine_entry(
            machine_id,
            &version_check,
            Fail,
            &format!("{name} is not installed on {machine_id}; its sessions can't start."),
            Some(manual(
                &format!("Install {} on {machine_id}", g.product()),
                Some(g.install()),
            )),
        ),
        Some(found) => version_entry(g, found, |status, message, fix| {
            machine_entry(machine_id, &version_check, status, message, fix)
        }),
    };
    let login = match info.login {
        LoginStatus::LoggedIn => machine_entry(
            machine_id,
            &login_check,
            Pass,
            &format!("{machine_id}: {setup}."),
            None,
        ),
        LoginStatus::LoggedOut => machine_entry(
            machine_id,
            &login_check,
            Fail,
            &format!("{machine_id}: {setup}, so its sessions can't start."),
            login_fix(),
        ),
        LoginStatus::Unknown => machine_entry(
            machine_id,
            &login_check,
            Unknown,
            &format!("{machine_id}'s node could not tell whether its {name} is logged in."),
            None,
        ),
    };
    let conformance = match info.conformance_ok {
        Some(true) => machine_entry(
            machine_id,
            "runner_conformance",
            Pass,
            &format!("{name} speaks {} fleetd expects.", g.protocol()),
            None,
        ),
        Some(false) => machine_entry(
            machine_id,
            "runner_conformance",
            Fail,
            &info.problem.clone().unwrap_or_else(|| {
                format!(
                    "{name} on {machine_id} did not answer fleetd's protocol probe as expected."
                )
            }),
            Some(manual(
                &format!("Put the tested {name} on {machine_id}"),
                Some(g.pin_tested()),
            )),
        ),
        None => machine_entry(
            machine_id,
            "runner_conformance",
            Unknown,
            &format!("{machine_id}'s node has not probed its {name} yet."),
            None,
        ),
    };
    let mut checks = vec![version, login, conformance];
    checks.extend(self_update_entry(machine_id, name, info));
    checks.extend(navi_sandbox_entry(machine_id, info));
    checks
}

/// `navi_sandbox`: the OS sandbox a Navi runs in on the machine, as its node reports it. A gap warns. A machine where
/// none starts reads quiet rather than wanting a look: other agents run as before, and only a Navi needs it. None from
/// a node that doesn't say.
fn navi_sandbox_entry(machine_id: &str, info: &RunnerInfo) -> Option<Entry> {
    let sandbox = info.sandbox.as_ref()?;
    let status = match sandbox.status {
        SandboxStatus::Ready => Pass,
        SandboxStatus::Gap => Warn,
        SandboxStatus::Missing => Unknown,
    };
    let fix = sandbox
        .fix
        .as_ref()
        .map(|fix| manual(&format!("On {machine_id}: {fix}"), None));
    Some(machine_entry(
        machine_id,
        "navi_sandbox",
        status,
        &format!("{machine_id}: {}", sandbox.line),
        fix,
    ))
}

/// `<runner>_self_update`: the runner's own background update is off, so only fleetd's update moves its version (to
/// the one it was tested with). None from a node that doesn't say.
fn self_update_entry(machine_id: &str, name: &str, info: &RunnerInfo) -> Option<Entry> {
    let check = format!("{name}_self_update");
    Some(match info.self_update? {
        false => machine_entry(
            machine_id,
            &check,
            Pass,
            &format!(
                "{name} on {machine_id} doesn't update itself: fleetd's update brings it to the version it was tested with."
            ),
            None,
        ),
        true => {
            let settings = info.config_dir.as_deref().map_or_else(
                || "~/.claude/settings.json".to_owned(),
                |d| format!("{d}/settings.json"),
            );
            machine_entry(
                machine_id,
                &check,
                Warn,
                &format!(
                    "{name} on {machine_id} updates itself in the background, so its version can change under its agents: its node turns that off when it starts, and couldn't."
                ),
                Some(manual(
                    &format!(
                        "On {machine_id}, set \"DISABLE_AUTOUPDATER\": \"1\" in the \"env\" of {settings}, then \
                         restart its node"
                    ),
                    None,
                )),
            )
        }
    })
}

/// The version verdict as a check: a warning outside the tested versions, which still run.
fn version_entry(
    g: &crate::node::runner::claude::guide::Guide,
    found: &str,
    entry: impl Fn(DoctorStatus, &str, Option<DoctorFix>) -> Entry,
) -> Entry {
    let name = g.name();
    match g.version_problem(found) {
        None => entry(
            Pass,
            &format!("{name} {} is supported.", found.trim()),
            None,
        ),
        Some((problem, fix)) => entry(
            Warn,
            &problem,
            fix.map(|command| manual(&format!("Change the installed {name}"), Some(command))),
        ),
    }
}

// Claude accounts (teams step 8, D200)

/// What the Claude checks read of the hub's accounts: never a key or token, only where each is and its last Test.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaudeSetupView {
    pub hub_api: Option<ClaudeHubApi>,
    /// The hub's owner, by name, and their subscription; `None` on a hub with no owner.
    pub owner: Option<(String, Option<ClaudeSubscription>)>,
    /// Any account is set up: else every machine runs on its own login, and no machine's settings outrank one.
    pub configured: bool,
    /// Every machine agents run on.
    pub machines: Vec<String>,
}

/// One account's state as a check: its last Test failed, machines don't hold it, it is untested, or it works.
fn account_entry(
    name: &str,
    what: &str,
    sealed_on: &[ClaudeSealedOn],
    last_test: Option<&ClaudeTest>,
    machines: &[String],
    fix: &str,
) -> Entry {
    if let Some(t) = last_test.filter(|t| !t.ok) {
        let said = t
            .error
            .as_deref()
            .unwrap_or("claude failed")
            .trim_end_matches('.');
        return hub_entry(
            name,
            Fail,
            &format!("{what} failed its Test on {}: {said}.", t.machine_id),
            Some(manual(fix, None)),
        );
    }
    let missing: Vec<&str> = machines
        .iter()
        .map(String::as_str)
        .filter(|m| !sealed_on.iter().any(|s| s.machine_id.as_str() == *m))
        .collect();
    if !missing.is_empty() {
        let list = missing.join(", ");
        return hub_entry(
            name,
            Warn,
            &format!("{what} isn't on {list}, so nothing runs on it there."),
            Some(manual(
                &format!(
                    "Save it again while {list} {} online",
                    if missing.len() == 1 { "is" } else { "are" }
                ),
                None,
            )),
        );
    }
    match last_test {
        Some(t) => hub_entry(
            name,
            Pass,
            &format!("{what} works: tested on {}.", t.machine_id),
            None,
        ),
        None => hub_entry(
            name,
            Unknown,
            &format!("{what} is saved but not tested yet."),
            Some(manual("Press Test beside it", None)),
        ),
    }
}

/// `hub/claude_key`: the hub's API configuration, which projects' leads and work nobody started run on first, and
/// anyone who chooses it.
pub fn claude_key(setup: &ClaudeSetupView) -> Entry {
    let fix =
        "Check the key and endpoint on Settings › Hub accounts › Claude, then save them again";
    match &setup.hub_api {
        None => hub_entry(
            "claude_key",
            Unknown,
            "The hub has no Claude API key.",
            Some(manual("Add one on Settings › Hub accounts › Claude", None)),
        ),
        Some(api) => {
            let what = match &api.endpoint {
                Some(url) => format!("The hub's Claude API key (through {url})"),
                None => "The hub's Claude API key".to_owned(),
            };
            account_entry(
                "claude_key",
                &what,
                &api.sealed_on,
                api.last_test.as_ref(),
                &setup.machines,
                fix,
            )
        }
    }
}

/// `hub/claude_owner`: the hub owner's own subscription, which projects' leads and work nobody started fall back to
/// without a hub API key.
pub fn claude_owner(setup: &ClaudeSetupView) -> Entry {
    let Some((name, subscription)) = &setup.owner else {
        return hub_entry(
            "claude_owner",
            Unknown,
            "The hub has no owner to connect a subscription.",
            None,
        );
    };
    match subscription {
        None => hub_entry(
            "claude_owner",
            Unknown,
            &format!("{name}, the hub's owner, has no Claude subscription connected."),
            Some(manual(
                &format!("{name} connects it in Settings › Your accounts › Claude"),
                None,
            )),
        ),
        Some(sub) => account_entry(
            "claude_owner",
            &format!("{name}'s Claude subscription"),
            &sub.sealed_on,
            sub.last_test.as_ref(),
            &setup.machines,
            &format!(
                "{name} runs `claude setup-token` again and pastes the new token in Settings › Your accounts › Claude"
            ),
        ),
    }
}

/// `claude_account_override`: the machine's claude user settings set a credential or gateway in their `env`, which
/// claude applies over the account fleetd gives a session. Only once the hub has an account set up, and only from a
/// node that reads its settings for it.
pub fn claude_account_override(
    machine_id: &str,
    info: &RunnerInfo,
    configured: bool,
) -> Option<Entry> {
    let names = info.account_overrides.as_ref().filter(|_| configured)?;
    let settings = info.config_dir.as_deref().map_or_else(
        || "~/.claude/settings.json".to_owned(),
        |d| format!("{d}/settings.json"),
    );
    if names.is_empty() {
        return Some(machine_entry(
            machine_id,
            "claude_account_override",
            Pass,
            &format!(
                "{machine_id}'s claude settings set no credential of their own: its sessions run on the account fleetd gives them."
            ),
            None,
        ));
    }
    let list = names.join(", ");
    Some(machine_entry(
        machine_id,
        "claude_account_override",
        Warn,
        &format!(
            "{settings} on {machine_id} sets {list} in its \"env\", which claude applies over the Claude account fleetd gives each session there."
        ),
        Some(manual(
            &format!(
                "On {machine_id}, move {list} out of the \"env\" of {settings} (into ~/.fleetd/claude.env for the machine's own login), then restart its node"
            ),
            None,
        )),
    ))
}

pub fn usage_breaker(machine_id: &str, breaker: &UsageBreaker) -> Entry {
    if breaker.state == "closed" {
        return machine_entry(
            machine_id,
            "usage_breaker",
            Pass,
            "The usage breaker is closed.",
            None,
        );
    }
    let wait = match (&breaker.until, &breaker.check_at) {
        (Some(u), _) => format!("Wait for the reset ({u})"),
        (None, Some(c)) => format!("Nothing: fleetd tries the login again by itself (next at {c})"),
        (None, None) => "Wait for the reset".to_string(),
    };
    machine_entry(
        machine_id,
        "usage_breaker",
        Warn,
        &breaker.message.clone().unwrap_or_else(|| {
            format!("New turns on {machine_id} are paused by the usage breaker.")
        }),
        Some(manual(
            &format!(
                "{wait}, or once the login has capacity press Resume in the app, or run fleetd usage resume {machine_id}"
            ),
            None,
        )),
    )
}

/// An open recovery breaker (`tasks::breaker`): the agents whose deaths opened it, the ones that wait, and when it
/// closes if nothing else dies there ("10:42 UTC").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryPaused {
    pub opened_by: Vec<String>,
    pub waiting: Vec<String>,
    pub until: String,
}

pub fn recovery_breaker(machine_id: &str, paused: Option<&RecoveryPaused>) -> Entry {
    let Some(p) = paused else {
        return machine_entry(
            machine_id,
            "recovery",
            Pass,
            &format!("Agents on {machine_id} whose run dies resume on their own."),
            None,
        );
    };
    let waiting = match p.waiting.len() {
        0 => String::new(),
        n => format!(
            " {} wait{}: {}.",
            n,
            if n == 1 { "s" } else { "" },
            p.waiting.join(", ")
        ),
    };
    machine_entry(
        machine_id,
        "recovery",
        Warn,
        &format!(
            "Automatic recovery is paused on {machine_id}: {} agents died there within 10 min ({}).{waiting} It \
             resumes at {} if no other agent dies there, or once one there completes.",
            p.opened_by.len(),
            p.opened_by.join(", "),
            p.until
        ),
        Some(manual(
            &format!(
                "Find out what kills agents on {machine_id} (its memory, its toolchain); message_agent continues one now"
            ),
            None,
        )),
    )
}

/// A session a node runs that no task or lead of this hub owns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnownedSession {
    pub thread_id: String,
    pub title: String,
}

pub fn unowned_sessions(machine_id: &str, offline: bool, sessions: &[UnownedSession]) -> Entry {
    if offline {
        return machine_entry(
            machine_id,
            "sessions",
            Unknown,
            &format!("{machine_id} is offline."),
            None,
        );
    }
    if sessions.is_empty() {
        return machine_entry(
            machine_id,
            "sessions",
            Pass,
            &format!("Every session running on {machine_id} is an agent's or a lead's."),
            None,
        );
    }
    let named: Vec<String> = sessions
        .iter()
        .take(5)
        .map(|s| format!("\"{}\" ({})", clip(&s.title, 60), s.thread_id))
        .collect();
    let more = sessions.len().saturating_sub(named.len());
    let more = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    machine_entry(
        machine_id,
        "sessions",
        Warn,
        &format!(
            "{machine_id} runs {} session{} no agent or lead of this hub owns: {}{more}. Nothing watches or counts them.",
            sessions.len(),
            if sessions.len() == 1 { "" } else { "s" },
            named.join(", ")
        ),
        Some(manual(
            &format!(
                "Read it with thread_tail; if nothing should be running it, stop its claude on {machine_id}"
            ),
            None,
        )),
    )
}

/// The node's `probe` action result (node-link `NodeActionResult.probe`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    #[serde(default)]
    pub git_email: Option<String>,
    /// "env": the node's service environment (GIT_AUTHOR_EMAIL), which setup writes; else git's global config.
    #[serde(default)]
    pub git_email_from: Option<String>,
}

static NOREPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)@users\.noreply\.github\.com$").unwrap());

pub fn commit_identity(
    machine_id: &str,
    probe: Result<&HostProbe, &str>,
    config: &HubConfig,
) -> Entry {
    let probe = match probe {
        Err(why) => return machine_entry(machine_id, "commit_identity", Unknown, why, None),
        Ok(p) => p,
    };
    let want = config.git_identity.as_ref().map(|g| g.email.as_str());
    // Setup writes the identity into the node's unit; by hand, git's global config is the place.
    let set = || match want {
        None => manual(
            &format!("Set the commit identity on {machine_id}"),
            Some("git config --global user.email '<id>+<user>@users.noreply.github.com'".into()),
        ),
        Some(_) => match config.machines.get(machine_id) {
            Some(m) => on_hub(manual(
                &format!(
                    "Run machine setup again from the hub to write the hub's identity into {machine_id}'s service"
                ),
                Some(m.add_command()),
            )),
            // Joined by itself (fleetd pair --worker): the join command carries the identity.
            None => on_hub(manual(
                &format!(
                    "Join {machine_id} again: run this on the hub, then the line it prints on {machine_id}; it carries \
                     the identity"
                ),
                Some(format!("fleetd pair --worker {machine_id}")),
            )),
        },
    };
    let Some(email) = &probe.git_email else {
        return machine_entry(
            machine_id,
            "commit_identity",
            Fail,
            &format!("No git commit identity is set on {machine_id}."),
            Some(set()),
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
    )
}

fn gb(bytes: f64) -> String {
    format!("{:.1} GB", bytes / 1e9)
}

/// Free space where the node's worktrees live, from its heartbeat, and whether the guard holds new agents there.
pub fn disk_space(
    machine_id: &str,
    offline: bool,
    disk: Option<&NodeDisk>,
    paused: Option<&str>,
) -> Entry {
    let Some(d) = disk.filter(|_| !offline) else {
        let why = if offline {
            format!("{machine_id} is offline.")
        } else {
            format!("{machine_id}'s node hasn't reported its free disk space.")
        };
        return machine_entry(machine_id, "disk", Unknown, &why, None);
    };
    let (free, min) = (d.free_bytes.get() as f64, d.min_free_bytes.get() as f64);
    let space = format!(
        "{} free of {} where {machine_id}'s worktrees live",
        gb(free),
        gb(d.total_bytes.get() as f64)
    );
    let Some(paused) = paused else {
        let floor = if min > 0.0 {
            format!("new agents pause below {}", gb(min))
        } else {
            "minFreeGb 0 turns the disk pause off".to_owned()
        };
        return machine_entry(
            machine_id,
            "disk",
            Pass,
            &format!("{space}; {floor}."),
            None,
        );
    };
    let message = format!(
        "{paused}. {space}. Running agents keep going; new ones start again once it has room."
    );
    if free < min {
        let fix = manual(
            &format!(
                "Free disk space on {machine_id}: a writer's worktree goes once its PR merges"
            ),
            None,
        );
        return machine_entry(machine_id, "disk", Fail, &message, Some(fix));
    }
    machine_entry(machine_id, "disk", Warn, &message, None)
}

/// Whether the machine can host android sessions, from its heartbeat; None where they are off (or the machine is
/// offline, or its node is older).
pub fn android_sessions(
    machine_id: &str,
    offline: bool,
    health: Option<&AndroidHealth>,
) -> Option<Entry> {
    let health = health.filter(|_| !offline)?;
    let status = match health.state {
        AndroidState::Ready | AndroidState::Wanted | AndroidState::Installing => Pass,
        AndroidState::Unavailable => Fail,
    };
    let fix = health.fix.as_ref().map(|command| {
        manual(
            &format!("On {machine_id}; its node checks again by itself within minutes"),
            Some(command.to_string()),
        )
    });
    Some(machine_entry(
        machine_id,
        "android",
        status,
        health.message.as_str(),
        fix,
    ))
}

/// Whether the Mac can host iOS sessions (Xcode, an iOS runtime, simctl, the golden simulator), from its heartbeat;
/// None where they are off (or the machine is offline, or its node is older).
pub fn ios_sessions(machine_id: &str, offline: bool, health: Option<&IosHealth>) -> Option<Entry> {
    let health = health.filter(|_| !offline)?;
    let status = match health.state {
        IosState::Ready | IosState::Wanted | IosState::Preparing => Pass,
        IosState::Unavailable => Fail,
    };
    let fix = health.fix.as_ref().map(|command| {
        manual(
            &format!("On {machine_id}; its node checks again by itself within minutes"),
            Some(command.to_string()),
        )
    });
    Some(machine_entry(
        machine_id,
        "ios",
        status,
        health.message.as_str(),
        fix,
    ))
}

/// Whether the machine can host Linux desktop sessions, and in what (a container or Xvfb), from its heartbeat; None
/// where they are off (or the machine is offline, or its node is older).
pub fn desktop_sessions(
    machine_id: &str,
    offline: bool,
    health: Option<&DesktopHealth>,
) -> Option<Entry> {
    let health = health.filter(|_| !offline)?;
    let status = match health.state {
        DesktopState::Ready | DesktopState::Preparing => Pass,
        DesktopState::Unavailable => Fail,
    };
    let fix = health.fix.as_ref().map(|command| {
        manual(
            &format!("On {machine_id}; its node checks again by itself within minutes"),
            Some(command.to_string()),
        )
    });
    Some(machine_entry(
        machine_id,
        "desktop",
        status,
        health.message.as_str(),
        fix,
    ))
}

/// Whether git could fetch each project's remote at the last worktree started there. None until one has started.
pub fn git_fetch(machine_id: &str, bases: &[(String, WorktreeBase)], now: &str) -> Option<Entry> {
    if bases.is_empty() {
        return None;
    }
    let failing: Vec<_> = bases
        .iter()
        .filter_map(|(project, b)| Some((project, b, base::doctor_alert(b)?)))
        .collect();
    let Some((project, first, kind)) = failing.first() else {
        // Only what the last starts showed: a fetch that worked, an offline one, or no remote to fetch.
        let each: Vec<String> = bases
            .iter()
            .map(|(project, b)| match b.error.as_ref().map(|e| e.kind) {
                None => format!("{project} fetched its remote"),
                Some(BaseErrorKind::NoRemote) => format!("{project} has no remote"),
                Some(_) => format!("{project} was offline (from {})", base::start(b, now)),
            })
            .collect();
        return Some(machine_entry(
            machine_id,
            "git_fetch",
            Pass,
            &format!(
                "At each project's last start on {machine_id}: {}.",
                each.join("; ")
            ),
            None,
        ));
    };
    let (text, command) = base::fetch_failed_text(project, first, now);
    let more = match failing.len() {
        1 => String::new(),
        n => format!(" {} more projects fail too.", n - 1),
    };
    let status = match kind {
        BaseErrorKind::Auth | BaseErrorKind::NoSsh => Fail,
        _ => Warn,
    };
    let label = base::fix_label(*kind, machine_id);
    Some(machine_entry(
        machine_id,
        "git_fetch",
        status,
        &format!("{text}{more}"),
        Some(manual(&label, command)),
    ))
}

/// A fork's default branch behind its upstream's: agents start from the fork. None when no project is a fork.
pub fn fork_behind(machine_id: &str, bases: &[(String, WorktreeBase)]) -> Option<Entry> {
    let forks: Vec<_> = bases
        .iter()
        .filter_map(|(project, b)| Some((project, b, b.fork_behind?)))
        .collect();
    if forks.is_empty() {
        return None;
    }
    let Some((project, b, behind)) = forks.iter().find(|(_, _, n)| *n > 0) else {
        return Some(machine_entry(
            machine_id,
            "fork_behind",
            Pass,
            "Each fork's default branch has everything upstream's has.",
            None,
        ));
    };
    let branch = b
        .base_ref
        .split_once('/')
        .map_or(b.base_ref.as_str(), |(_, b)| b);
    Some(machine_entry(
        machine_id,
        "fork_behind",
        Warn,
        &format!(
            "{project}: your fork's {branch} is {behind} behind upstream, and agents start from it; `gh repo sync` \
             brings it up to date."
        ),
        Some(manual(
            "Sync the fork with upstream: GitHub's Sync fork button, or `gh repo sync <owner>/<fork>`",
            None,
        )),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::setup::machine_plan::CLAUDE_INSTALL;

    #[test]
    fn a_fix_says_where_its_command_runs_and_the_identitys_runs_on_the_hub() {
        let config: HubConfig = serde_json::from_value(serde_json::json!({
            "gitIdentity": { "name": "ada", "email": "1+ada@users.noreply.github.com" },
            "machines": { "builder-1": { "sshHost": "builder-1", "platform": "linux", "uid": 1000 } },
        }))
        .unwrap();
        let other = HostProbe {
            git_email: Some("someone@else.example".into()),
            git_email_from: None,
        };
        // Set up over SSH: machine setup runs again on the hub.
        let fix = commit_identity("builder-1", Ok(&other), &config)
            .check
            .fix
            .unwrap();
        assert_eq!(fix.command.as_deref(), Some("fleetd machine add builder-1"));
        assert_eq!(fix.on.as_deref(), Some("hub"));
        // Joined with a code: the hub makes the line, one command.
        let fix = commit_identity("laptop", Ok(&other), &config)
            .check
            .fix
            .unwrap();
        assert_eq!(fix.command.as_deref(), Some("fleetd pair --worker laptop"));
        assert_eq!(fix.on.as_deref(), Some("hub"));
        // Without the hub's identity, git's config on the machine itself.
        let unset = HostProbe {
            git_email: None,
            git_email_from: None,
        };
        let fix = commit_identity("laptop", Ok(&unset), &HubConfig::default())
            .check
            .fix
            .unwrap();
        assert_eq!(fix.on.as_deref(), Some("machine"));
        // A hub check's command runs on the hub; a fix with no command runs nowhere.
        let hub = hub_entry("x", Fail, "x", Some(manual("Restart it", Some("x".into()))));
        assert_eq!(hub.check.fix.unwrap().on.as_deref(), Some("hub"));
        let words = machine_entry("laptop", "x", Fail, "x", Some(manual("Press Test", None)));
        assert_eq!(words.check.fix.unwrap().on, None);
    }

    fn base(error: Option<(BaseErrorKind, &str)>, fork_behind: Option<u32>) -> WorktreeBase {
        WorktreeBase {
            base_ref: "origin/main".into(),
            sha: "abc1234def".into(),
            fetched_at: Some(fleetd_contracts::ids::Timestamp(
                "2026-10-25T06:00:00Z".into(),
            )),
            error: error.map(|(kind, message)| fleetd_contracts::sessions::BaseError {
                kind,
                message: message.into(),
            }),
            fork_behind,
        }
    }

    #[test]
    fn a_project_git_cant_fetch_fails_the_check_with_the_login_fix() {
        let now = "2026-10-25T07:00:00Z";
        assert_eq!(git_fetch("mbp", &[], now), None, "no worktree started yet");
        let fine = vec![
            ("shop".to_owned(), base(None, None)),
            (
                "blog".to_owned(),
                base(Some((BaseErrorKind::Offline, "offline")), None),
            ),
        ];
        let fine = git_fetch("mbp", &fine, now).unwrap().check;
        assert_eq!(fine.status, Pass);
        assert_eq!(
            fine.message,
            "At each project's last start on mbp: shop fetched its remote; blog was offline (from origin/main @abc1234 \
             as of 06:00 UTC)."
        );
        let mut local = base(Some((BaseErrorKind::NoRemote, "no remote")), None);
        local.base_ref = "main".into();
        let local = git_fetch("mbp", &[("notes".to_owned(), local)], now)
            .unwrap()
            .check;
        assert_eq!(
            local.message,
            "At each project's last start on mbp: notes has no remote."
        );
        let gone = vec![(
            "shop".to_owned(),
            base(
                Some((BaseErrorKind::NoAccess, "ERROR: Repository not found.")),
                None,
            ),
        )];
        let gone = git_fetch("mbp", &gone, now).unwrap().check;
        assert_eq!(gone.status, Warn);
        assert!(
            gone.message.starts_with(
                "git can't fetch origin for shop: ERROR: Repository not found. Fix: check the remote's URL"
            ),
            "{}",
            gone.message
        );
        assert_eq!(
            gone.fix.unwrap().command.as_deref(),
            Some("git remote get-url origin")
        );
        let no_ssh = vec![(
            "shop".to_owned(),
            base(
                Some((
                    BaseErrorKind::NoSsh,
                    "error: cannot run ssh: No such file or directory",
                )),
                None,
            ),
        )];
        let no_ssh = git_fetch("mbp", &no_ssh, now).unwrap().check;
        assert_eq!(no_ssh.status, Fail);
        assert!(
            no_ssh
                .message
                .starts_with("ssh isn't installed, so git can't fetch origin for shop"),
            "{}",
            no_ssh.message
        );
        assert_eq!(no_ssh.fix.unwrap().label, "Install OpenSSH on mbp");
        let refused = vec![(
            "shop".to_owned(),
            base(
                Some((
                    BaseErrorKind::Auth,
                    "git@github.com: Permission denied (publickey).",
                )),
                None,
            ),
        )];
        let check = git_fetch("mbp", &refused, now).unwrap().check;
        assert_eq!((check.id.as_str(), check.status), ("mbp/git_fetch", Fail));
        assert!(
            check.message.starts_with(
                "git can't fetch origin for shop: git@github.com: Permission denied (publickey). Fix: `gh auth login` \
                 or your SSH key."
            ),
            "{}",
            check.message
        );
        assert_eq!(check.fix.unwrap().command.as_deref(), Some("gh auth login"));
    }

    #[test]
    fn android_sessions_fail_with_the_fix_a_person_runs() {
        let health = |state, fix: Option<&str>| AndroidHealth {
            state,
            message: fleetd_contracts::prim::Text::unchecked("devuser may not use /dev/kvm."),
            fix: fix.map(fleetd_contracts::prim::Text::unchecked),
        };
        let broken = health(
            AndroidState::Unavailable,
            Some("sudo usermod -aG kvm devuser"),
        );
        let entry = android_sessions("devbox", false, Some(&broken)).unwrap();
        assert_eq!(entry.check.id, "devbox/android");
        assert_eq!(entry.check.status, Fail);
        let fix = entry.check.fix.unwrap();
        assert_eq!(fix.command.as_deref(), Some("sudo usermod -aG kvm devuser"));
        let ready = health(AndroidState::Ready, None);
        let entry = android_sessions("devbox", false, Some(&ready)).unwrap();
        assert_eq!((entry.check.status, entry.check.fix), (Pass, None));
        assert!(
            android_sessions("devbox", true, Some(&ready)).is_none(),
            "offline"
        );
        assert!(
            android_sessions("devbox", false, None).is_none(),
            "off there"
        );
    }

    #[test]
    fn ios_sessions_fail_with_the_fix_a_person_runs() {
        let health = |state, fix: Option<&str>| IosHealth {
            state,
            message: fleetd_contracts::prim::Text::unchecked("Xcode has no iOS simulator runtime."),
            fix: fix.map(fleetd_contracts::prim::Text::unchecked),
        };
        let broken = health(
            IosState::Unavailable,
            Some("xcodebuild -downloadPlatform iOS"),
        );
        let entry = ios_sessions("mac", false, Some(&broken)).unwrap();
        assert_eq!(entry.check.id, "mac/ios");
        assert_eq!(entry.check.status, Fail);
        assert_eq!(
            entry.check.fix.unwrap().command.as_deref(),
            Some("xcodebuild -downloadPlatform iOS")
        );
        let ready = ios_sessions("mac", false, Some(&health(IosState::Ready, None))).unwrap();
        assert_eq!((ready.check.status, ready.check.fix), (Pass, None));
        assert!(ios_sessions("mac", true, Some(&health(IosState::Ready, None))).is_none());
        assert!(ios_sessions("mac", false, None).is_none());
    }

    #[test]
    fn desktop_sessions_say_what_they_run_in_and_the_fix_where_they_cant() {
        let health = |state, backend, fix: Option<&str>| DesktopHealth {
            state,
            backend,
            message: fleetd_contracts::prim::Text::unchecked("Desktop screens run on Xvfb."),
            fix: fix.map(fleetd_contracts::prim::Text::unchecked),
        };
        let xvfb = health(
            DesktopState::Ready,
            Some(fleetd_contracts::browser::DesktopBackend::Xvfb),
            None,
        );
        let entry = desktop_sessions("devbox", false, Some(&xvfb)).unwrap();
        assert_eq!(entry.check.id, "devbox/desktop");
        assert_eq!((entry.check.status, entry.check.fix), (Pass, None));
        let none = health(
            DesktopState::Unavailable,
            None,
            Some("sudo apt install xvfb"),
        );
        let entry = desktop_sessions("devbox", false, Some(&none)).unwrap();
        assert_eq!(entry.check.status, Fail);
        assert_eq!(
            entry.check.fix.unwrap().command.as_deref(),
            Some("sudo apt install xvfb")
        );
        assert!(
            desktop_sessions("devbox", true, Some(&xvfb)).is_none(),
            "offline"
        );
        assert!(
            desktop_sessions("devbox", false, None).is_none(),
            "off there"
        );
    }

    #[test]
    fn a_fork_behind_upstream_warns() {
        assert_eq!(
            fork_behind("mbp", &[("shop".to_owned(), base(None, None))]),
            None
        );
        let even = [("shop".to_owned(), base(None, Some(0)))];
        assert_eq!(fork_behind("mbp", &even).unwrap().check.status, Pass);
        let behind = [("shop".to_owned(), base(None, Some(31)))];
        let check = fork_behind("mbp", &behind).unwrap().check;
        assert_eq!((check.id.as_str(), check.status), ("mbp/fork_behind", Warn));
        assert_eq!(
            check.message,
            "shop: your fork's main is 31 behind upstream, and agents start from it; `gh repo sync` brings it up to date."
        );
    }

    #[test]
    fn setup_checks_are_there_only_once_their_step_is_set_up() {
        assert!(setup_checks(&SetupFacts::default()).is_empty());
        let facts = SetupFacts {
            joined: vec!["Alice".into(), "Bo".into(), "Cy".into()],
            github_app: None,
        };
        let got: Vec<_> = setup_checks(&facts)
            .into_iter()
            .map(|e| (e.check.id, e.check.status, e.check.message))
            .collect();
        assert_eq!(
            got,
            [(
                "hub/people".into(),
                Pass,
                "Alice and 2 others have joined.".into()
            )]
        );
    }

    #[test]
    fn a_repo_with_no_ci_fails_with_the_add_ci_fix() {
        assert_eq!(repo_ci(&[]).check.status, Pass);
        let held = repo_ci(&["acme/app".into()]).check;
        assert_eq!((held.id.as_str(), held.status), ("hub/repo_ci", Fail));
        assert_eq!(
            held.fix.map(|f| f.label),
            Some("Add a GitHub Actions workflow that runs on pull requests to acme/app".into())
        );
    }

    #[test]
    fn plain_http_is_fine_only_on_loopback_and_the_tailnet() {
        for url in [
            "http://127.0.0.1:4790",
            "http://localhost:4790/",
            "http://[::1]:4790",
            "http://100.101.102.103:4790",
            "http://devbox.tail1234.ts.net:4790",
            "http://[fd7a:115c:a1e0::b430:f932]:4790",
        ] {
            assert!(sealed_http(url).is_some(), "{url}");
        }
        for url in [
            "http://192.168.8.227:4790",
            "http://100.128.0.1:4790",
            "http://devbox.example.com",
            "http://10.0.0.2:4790",
        ] {
            assert_eq!(sealed_http(url), None, "{url}");
        }
    }

    /// A degraded machine's finding has exactly one fix, and it is the one for the cause.
    #[test]
    fn a_degraded_machine_gets_the_one_fix_for_its_cause() {
        let degraded = MachineView {
            machine_id: "mac".into(),
            status: "degraded".into(),
            last_seen_at: "now".into(),
            degraded_reason: Some("claude is not logged in. Fix: claude auth login".into()),
        };
        let runner = |version: Option<&str>, login, proxy: Option<&str>| RunnerInfo {
            runner: fleetd_contracts::sessions::RunnerKind::Claude,
            version: version.map(str::to_owned),
            supported: ">=2.1.300, <2.2.0".into(),
            version_ok: true,
            login,
            login_kind: None,
            conformance_ok: Some(true),
            problem: None,
            login_label: None,
            proxy: proxy.map(str::to_owned),
            proxy_source: None,
            config_dir: None,
            self_update: None,
            sandbox: None,
            account_overrides: None,
        };
        let fix = |info: Option<RunnerInfo>| {
            let entry = machine_online(&degraded, None, info.as_ref());
            assert_eq!(
                entry.check.message,
                "mac is degraded: claude is not logged in."
            );
            let fix = entry.check.fix.unwrap();
            (fix.label, fix.command)
        };
        let ok = Some("2.1.314 (Claude Code)");
        assert_eq!(
            fix(Some(runner(ok, LoginStatus::LoggedOut, None))),
            (
                "Log claude in on mac".into(),
                Some("claude auth login".into())
            )
        );
        let (label, command) = fix(Some(runner(
            ok,
            LoginStatus::LoggedOut,
            Some("http://127.0.0.1:8317"),
        )));
        assert_eq!(command, None);
        assert!(
            label.contains("log in with your proxy") && label.contains("8317"),
            "{label}"
        );
        // A version outside the tested range is never the cause.
        assert_eq!(
            fix(Some(runner(Some("2.0.1"), LoginStatus::LoggedOut, None))).1,
            Some("claude auth login".into())
        );
        assert_eq!(
            fix(Some(runner(None, LoginStatus::Unknown, None)))
                .1
                .as_deref(),
            Some(CLAUDE_INSTALL)
        );
        // Two causes: one ordered sentence, the install first.
        let (label, command) = fix(Some(RunnerInfo {
            conformance_ok: Some(false),
            ..runner(ok, LoginStatus::LoggedOut, None)
        }));
        assert_eq!(command, None);
        assert_eq!(
            label,
            "On mac: claude install 2.1.314, then claude auth login"
        );
        // No runner report: the node's own fix, never a restart for a login problem.
        assert_eq!(fix(None).1.as_deref(), Some("claude auth login"));
        // No runner cause at all: the node itself is the problem.
        let down = MachineView {
            degraded_reason: Some("its node's runner is unavailable".into()),
            ..degraded.clone()
        };
        let entry = machine_online(&down, None, Some(&runner(ok, LoginStatus::LoggedIn, None)));
        assert_eq!(
            entry.check.fix.and_then(|f| f.command).as_deref(),
            Some("systemctl --user restart fleetd-node.service")
        );
    }

    fn sealed(machine: &str) -> ClaudeSealedOn {
        ClaudeSealedOn {
            machine_id: fleetd_contracts::ids::MachineId::new(machine).unwrap(),
            fingerprint: fleetd_contracts::secrets::SecretFingerprint::new("0123abcd").unwrap(),
        }
    }

    fn tested(ok: bool) -> ClaudeTest {
        ClaudeTest {
            at: fleetd_contracts::ids::Timestamp::from("2026-10-27T10:00:00.000Z"),
            machine_id: fleetd_contracts::ids::MachineId::new("devbox").unwrap(),
            ok,
            error: (!ok).then(|| "Invalid API key · Fix external API key".to_owned()),
        }
    }

    /// The GitHub App's check: created but not installed wants a look, a Test GitHub refused fails, a passing one
    /// says what Test said.
    #[test]
    fn the_github_app_check_reads_its_installations_and_last_test() {
        let app = |installed: bool,
                   test: Option<(bool, &str)>|
         -> fleetd_contracts::github_app::GithubApp {
            serde_json::from_value(serde_json::json!({
                "appId": 1, "slug": "fleetd-on-devbox", "name": "fleetd on devbox", "clientId": "Iv23li", "owner": "acme",
                "htmlUrl": "https://github.com/apps/fleetd-on-devbox",
                "settingsUrl": "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox",
                "createdAt": "2026-10-28T10:00:00.000Z",
                "installations": if installed { serde_json::json!([{ "installationId": 7, "account": "acme",
                    "allRepositories": true, "repositoryCount": 3 }]) } else { serde_json::json!([]) },
                "lastTest": test.map(|(ok, said)| serde_json::json!({ "at": "2026-10-28T10:00:00.000Z", "ok": ok, "said": said })),
            }))
            .unwrap()
        };
        let at = |e: Entry| (e.check.id, e.check.status, e.check.message);
        assert_eq!(
            at(github_app(&app(false, None))),
            (
                "hub/github_app".into(),
                Warn,
                "The hub's GitHub App \"fleetd on devbox\" isn't installed on any repository yet."
                    .into()
            )
        );
        assert_eq!(
            at(github_app(&app(
                true,
                Some((false, "GitHub refused (401)."))
            )))
            .1,
            Fail
        );
        assert_eq!(
            at(github_app(&app(true, Some((true, "It works."))))),
            ("hub/github_app".into(), Pass, "It works.".into())
        );
        assert_eq!(
            at(github_app(&app(true, None))).2,
            "The hub's GitHub App \"fleetd on devbox\" is installed on acme."
        );
    }

    /// The hub's key and the owner's subscription read the same way: none is to do, a failed Test fails, a machine
    /// without it warns, untested waits for Test, tested works.
    #[test]
    fn the_claude_checks_read_the_key_and_the_owners_subscription() {
        let at = |checked: Entry| {
            (
                checked.check.id,
                checked.check.status,
                checked.check.message,
            )
        };
        let machines = vec!["devbox".to_owned(), "buildbox".to_owned()];
        let none = ClaudeSetupView {
            owner: Some(("Sam Rivera".into(), None)),
            machines: machines.clone(),
            ..Default::default()
        };
        assert_eq!(
            at(claude_key(&none)),
            (
                "hub/claude_key".into(),
                Unknown,
                "The hub has no Claude API key.".into()
            )
        );
        assert_eq!(
            at(claude_owner(&none)),
            (
                "hub/claude_owner".into(),
                Unknown,
                "Sam Rivera, the hub's owner, has no Claude subscription connected.".into()
            )
        );
        let api = |sealed_on: Vec<ClaudeSealedOn>, last_test: Option<ClaudeTest>| ClaudeHubApi {
            endpoint: Some(
                fleetd_contracts::claude_accounts::ClaudeEndpoint::new(
                    "https://gateway.devbox.example",
                )
                .unwrap(),
            ),
            sealed_on,
            updated_at: fleetd_contracts::ids::Timestamp::from("2026-10-27T09:00:00.000Z"),
            updated_by: None,
            last_test,
        };
        let with = |a: ClaudeHubApi| ClaudeSetupView {
            hub_api: Some(a),
            configured: true,
            ..none.clone()
        };
        let both = vec![sealed("devbox"), sealed("buildbox")];
        let failed = claude_key(&with(api(both.clone(), Some(tested(false)))));
        assert_eq!(failed.check.status, Fail);
        assert_eq!(
            failed.check.message,
            "The hub's Claude API key (through https://gateway.devbox.example) failed its Test on devbox: Invalid API key · Fix external API key."
        );
        let partly = claude_key(&with(api(vec![sealed("devbox")], Some(tested(true)))));
        assert_eq!(partly.check.status, Warn);
        assert!(
            partly.check.message.contains("isn't on buildbox"),
            "{}",
            partly.check.message
        );
        assert_eq!(
            partly.check.fix.unwrap().label,
            "Save it again while buildbox is online"
        );
        assert_eq!(
            claude_key(&with(api(both.clone(), None))).check.status,
            Unknown
        );
        assert_eq!(
            claude_key(&with(api(both.clone(), Some(tested(true)))))
                .check
                .status,
            Pass
        );
        let owner = |last_test| ClaudeSetupView {
            owner: Some((
                "Sam Rivera".into(),
                Some(ClaudeSubscription {
                    sealed_on: both.clone(),
                    connected_at: fleetd_contracts::ids::Timestamp::from(
                        "2026-10-27T09:00:00.000Z",
                    ),
                    last_test,
                }),
            )),
            configured: true,
            ..none.clone()
        };
        assert_eq!(
            at(claude_owner(&owner(Some(tested(true))))),
            (
                "hub/claude_owner".into(),
                Pass,
                "Sam Rivera's Claude subscription works: tested on devbox.".into()
            )
        );
        let expired = claude_owner(&owner(Some(tested(false))));
        assert_eq!(expired.check.status, Fail);
        assert!(
            expired
                .check
                .fix
                .unwrap()
                .label
                .contains("claude setup-token")
        );
    }

    /// Credentials in a machine's claude settings warn once an account is set up; with none, or from a node that
    /// doesn't say, there is no check.
    #[test]
    fn claude_settings_that_outrank_the_account_warn() {
        let info = |overrides: Option<Vec<&str>>| RunnerInfo {
            runner: fleetd_contracts::sessions::RunnerKind::Claude,
            version: None,
            supported: String::new(),
            version_ok: true,
            login: LoginStatus::LoggedIn,
            login_kind: None,
            conformance_ok: None,
            problem: None,
            login_label: None,
            proxy: None,
            proxy_source: None,
            config_dir: Some("/home/ada/.claude".into()),
            self_update: None,
            sandbox: None,
            account_overrides: overrides.map(|o| o.into_iter().map(str::to_owned).collect()),
        };
        let set = info(Some(vec!["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]));
        assert_eq!(claude_account_override("devbox", &set, false), None);
        assert_eq!(claude_account_override("devbox", &info(None), true), None);
        let warned = claude_account_override("devbox", &set, true).unwrap().check;
        assert_eq!(
            (warned.id.as_str(), warned.status),
            ("devbox/claude_account_override", Warn)
        );
        assert_eq!(
            warned.message,
            "/home/ada/.claude/settings.json on devbox sets ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY in its \"env\", which claude applies over the Claude account fleetd gives each session there."
        );
        assert_eq!(
            claude_account_override("devbox", &info(Some(vec![])), true)
                .unwrap()
                .check
                .status,
            Pass
        );
    }

    /// Claude Code updating itself is a warning naming the setting; off is a pass; a node that doesn't say adds none.
    #[test]
    fn the_doctor_checks_claude_doesnt_update_itself() {
        let info = |self_update| RunnerInfo {
            runner: fleetd_contracts::sessions::RunnerKind::Claude,
            version: Some("2.1.314 (Claude Code)".into()),
            supported: ">=2.1.300, <2.2.0".into(),
            version_ok: true,
            login: LoginStatus::LoggedIn,
            login_kind: None,
            conformance_ok: Some(true),
            problem: None,
            login_label: None,
            proxy: None,
            proxy_source: None,
            config_dir: Some("/home/u/.claude".into()),
            self_update,
            sandbox: None,
            account_overrides: None,
        };
        let sandboxed = |status, line: &str| {
            let mut i = info(None);
            i.sandbox = Some(fleetd_contracts::sessions::NaviSandbox {
                status,
                line: line.into(),
                fix: (status != SandboxStatus::Ready).then(|| "Install bubblewrap".into()),
            });
            runner_checks("devbox", &i).pop().unwrap().check
        };
        let ready = sandboxed(SandboxStatus::Ready, "Navis run in bubblewrap.");
        assert_eq!(
            (ready.id.as_str(), ready.status),
            ("devbox/navi_sandbox", Pass)
        );
        let gap = sandboxed(
            SandboxStatus::Gap,
            "this kernel can't scope abstract sockets",
        );
        assert_eq!(gap.status, Warn);
        assert!(gap.message.contains("abstract sockets"), "{}", gap.message);
        // A machine with no sandbox runs every other agent as before: it reads quiet, with its fix.
        let none = sandboxed(SandboxStatus::Missing, "no bubblewrap");
        assert_eq!(none.status, Unknown);
        assert!(none.fix.is_some());
        let last = |i: &RunnerInfo| runner_checks("mac", i).pop().unwrap().check;
        let off = last(&info(Some(false)));
        assert_eq!(
            (off.id.as_str(), off.status),
            ("mac/claude_self_update", Pass)
        );
        let on = last(&info(Some(true)));
        assert_eq!(
            (on.id.as_str(), on.status),
            ("mac/claude_self_update", Warn)
        );
        let fix = on.fix.unwrap().label;
        assert!(
            fix.contains(r#""DISABLE_AUTOUPDATER": "1""#)
                && fix.contains("/home/u/.claude/settings.json"),
            "{fix}"
        );
        assert_eq!(runner_checks("mac", &info(None)).len(), 3);
    }

    #[test]
    fn claude_checks_from_runner_info() {
        let info = |version: Option<&str>, login, conformance| RunnerInfo {
            runner: fleetd_contracts::sessions::RunnerKind::Claude,
            version: version.map(str::to_owned),
            supported: ">=2.1.300, <2.2.0".into(),
            version_ok: true,
            login,
            login_kind: Some("subscription".into()),
            conformance_ok: conformance,
            problem: None,
            login_label: None,
            proxy: None,
            proxy_source: None,
            config_dir: None,
            self_update: None,
            sandbox: None,
            account_overrides: None,
        };
        let statuses = |i: &RunnerInfo| {
            runner_checks("mac", i)
                .into_iter()
                .map(|e| (e.check.id, e.check.status))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            statuses(&info(
                Some("2.1.314 (Claude Code)"),
                LoginStatus::LoggedIn,
                Some(true)
            )),
            [
                ("mac/claude_version".to_owned(), Pass),
                ("mac/claude_login".to_owned(), Pass),
                ("mac/runner_conformance".to_owned(), Pass)
            ]
        );
        let bad = runner_checks(
            "mac",
            &info(Some("2.2.1"), LoginStatus::LoggedOut, Some(false)),
        );
        // Past the tested range: a warning with the tested version, never a refusal.
        assert_eq!(bad[0].check.status, Warn);
        assert_eq!(
            bad[0].check.fix.as_ref().and_then(|f| f.command.as_deref()),
            Some("claude install 2.1.314")
        );
        // Older than tested: a warning with the update, never a refusal on the version alone.
        let older = runner_checks(
            "mac",
            &info(Some("2.1.296"), LoginStatus::LoggedIn, Some(true)),
        );
        assert_eq!(older[0].check.status, Warn);
        assert_eq!(
            older[0]
                .check
                .fix
                .as_ref()
                .and_then(|f| f.command.as_deref()),
            Some("claude update")
        );
        assert_eq!(
            bad[1].check.fix.as_ref().and_then(|f| f.command.as_deref()),
            Some("claude auth login")
        );
        // Behind a proxy the proxy holds the login: no `claude auth login`, and the message names the proxy.
        let proxied = runner_checks(
            "mac",
            &RunnerInfo {
                proxy: Some("http://127.0.0.1:8317".into()),
                proxy_source: Some("~/.claude/settings.json".into()),
                config_dir: Some("/Users/ada/.claude".into()),
                ..info(
                    Some("2.1.314 (Claude Code)"),
                    LoginStatus::LoggedOut,
                    Some(true),
                )
            },
        );
        let fix = proxied[1].check.fix.as_ref().unwrap();
        assert_eq!(fix.command, None);
        assert!(
            fix.label.contains("log in with your proxy"),
            "{}",
            fix.label
        );
        let ok = runner_checks(
            "mac",
            &RunnerInfo {
                login_label: Some("Max".into()),
                proxy: Some("http://127.0.0.1:8317".into()),
                proxy_source: Some("~/.claude/settings.json".into()),
                config_dir: Some("/Users/ada/.claude".into()),
                ..info(
                    Some("2.1.314 (Claude Code)"),
                    LoginStatus::LoggedIn,
                    Some(true),
                )
            },
        );
        assert_eq!(
            ok[1].check.message,
            "mac: claude 2.1.314, logged in (Max), via proxy http://127.0.0.1:8317 from ~/.claude/settings.json."
        );
        assert_eq!(bad[2].check.status, Fail);
        let newer = runner_checks(
            "mac",
            &info(Some("2.1.399"), LoginStatus::LoggedIn, Some(true)),
        );
        assert_eq!(newer[0].check.status, Pass);
        let missing = runner_checks("mac", &info(None, LoginStatus::Unknown, None));
        assert_eq!(
            missing[0]
                .check
                .fix
                .as_ref()
                .and_then(|f| f.command.as_deref()),
            Some("curl -fsSL https://claude.ai/install.sh | bash")
        );
    }
}
