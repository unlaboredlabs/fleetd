//! Each doctor check as a pure function of what the hub read: a status, a plain message, and at most one fix, a
//! command for a person to run.
use super::config::{HubConfig, MachineSetup, restart_command};
use crate::hub::usage::service::UsageBreaker;
use crate::hub::usage::time::clip;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::cli::setup::machine_plan::CLAUDE_INSTALL;
use crate::hub::tasks::base;
use crate::node::runner::claude_setup::ClaudeSetup;
use crate::node::runner::failure::login_fix;
use crate::node::runner::version::{self, TESTED as CLAUDE_TESTED, VersionVerdict};
use fleetd_contracts::node_link::NodeDisk;
use fleetd_contracts::sessions::{BaseErrorKind, LoginStatus, RunnerInfo, WorktreeBase};

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub check: DoctorCheck,
}

fn manual(label: &str, command: Option<String>) -> DoctorFix {
    DoctorFix {
        kind: "manual".into(),
        label: clip(label, 200),
        command,
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
            fix,
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

/// The one fix for a machine whose runner is unusable, from the cause its probe reports: claude missing, a protocol
/// break, logged out. Two causes at once become one ordered sentence (the install first, since a login on a claude
/// that can't run proves nothing). None when the runner reports no cause.
pub fn runner_fix(machine_id: &str, info: &RunnerInfo) -> Option<DoctorFix> {
    let claude = match &info.version {
        None => Some(("Install Claude Code", CLAUDE_INSTALL.to_owned())),
        Some(_) if info.conformance_ok == Some(false) => Some((
            "Put the tested claude",
            format!("claude install {CLAUDE_TESTED}"),
        )),
        Some(_) => None,
    };
    let login = (info.login == LoginStatus::LoggedOut).then(|| login_fix(info.proxy.is_some()));
    Some(match (claude, login) {
        (None, None) => return None,
        (Some((label, command)), None) => {
            manual(&format!("{label} on {machine_id}"), Some(command))
        }
        // Behind a proxy the proxy holds the login: nothing to paste.
        (None, Some(login)) if info.proxy.is_some() => manual(
            &format!(
                "On {machine_id}, {login} (claude goes through {})",
                info.proxy.as_deref().unwrap_or_default()
            ),
            None,
        ),
        (None, Some(login)) => manual(
            &format!("Log claude in on {machine_id}"),
            Some(login.to_owned()),
        ),
        (Some((_, command)), Some(login)) => {
            manual(&format!("On {machine_id}: {command}, then {login}"), None)
        }
    })
}

/// The node's link to the hub; what it runs is checked by the claude checks.
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
            // The cause decides the fix: a runner problem is fixed on claude, and only a node with no runner cause
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

/// `claude_version`, `claude_login` and `runner_conformance` from what the node's runner reports (`runner_info`).
pub fn runner_checks(machine_id: &str, info: &RunnerInfo) -> Vec<Entry> {
    // Sessions use the machine's own claude setup, so the fix is the login the user would do for their own claude.
    let setup = ClaudeSetup::from_info(info);
    let login_fix = || {
        Some(if setup.proxy.is_some() {
            manual(
                &format!(
                    "On {machine_id}, {} (claude goes through {})",
                    login_fix(true),
                    setup.proxy.as_deref().unwrap_or_default()
                ),
                None,
            )
        } else {
            manual(
                &format!("Log claude in on {machine_id}"),
                Some(login_fix(false).into()),
            )
        })
    };
    let version = match &info.version {
        None => machine_entry(
            machine_id,
            "claude_version",
            Fail,
            &format!("claude is not installed on {machine_id}; its sessions can't start."),
            Some(manual(
                &format!("Install Claude Code on {machine_id}"),
                Some(CLAUDE_INSTALL.into()),
            )),
        ),
        Some(found) => version_entry(found, |status, message, fix| {
            machine_entry(machine_id, "claude_version", status, message, fix)
        }),
    };
    let login = match info.login {
        LoginStatus::LoggedIn => machine_entry(
            machine_id,
            "claude_login",
            Pass,
            &format!("{machine_id}: {setup}."),
            None,
        ),
        LoginStatus::LoggedOut => machine_entry(
            machine_id,
            "claude_login",
            Fail,
            &format!("{machine_id}: {setup}, so its sessions can't start."),
            login_fix(),
        ),
        LoginStatus::Unknown => machine_entry(
            machine_id,
            "claude_login",
            Unknown,
            &format!("{machine_id}'s node could not tell whether its claude is logged in."),
            None,
        ),
    };
    let conformance = match info.conformance_ok {
        Some(true) => machine_entry(
            machine_id,
            "runner_conformance",
            Pass,
            "claude speaks the stream-json protocol fleetd expects.",
            None,
        ),
        Some(false) => machine_entry(
            machine_id,
            "runner_conformance",
            Fail,
            &info.problem.clone().unwrap_or_else(|| {
                format!(
                    "claude on {machine_id} did not answer fleetd's protocol probe as expected."
                )
            }),
            Some(manual(
                &format!("Put the tested claude on {machine_id}"),
                Some(format!("claude install {CLAUDE_TESTED}")),
            )),
        ),
        None => machine_entry(
            machine_id,
            "runner_conformance",
            Unknown,
            &format!("{machine_id}'s node has not probed its claude yet."),
            None,
        ),
    };
    vec![version, login, conformance]
}

/// The version verdict as a check: a warning outside the tested versions, which still run.
fn version_entry(
    found: &str,
    entry: impl Fn(DoctorStatus, &str, Option<DoctorFix>) -> Entry,
) -> Entry {
    let v = version::check(found);
    let fix = v
        .fix()
        .map(|command| manual("Change the installed claude", Some(command)));
    let problem = v.problem(found).unwrap_or_default();
    match v {
        VersionVerdict::Ok => entry(
            Pass,
            &format!("claude {} is supported.", found.trim()),
            None,
        ),
        _ => entry(Warn, &problem, fix),
    }
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
            Some(m) => manual(
                &format!(
                    "Run machine setup again from the hub to write the hub's identity into {machine_id}'s service"
                ),
                Some(m.add_command()),
            ),
            // Joined by itself (fleetd pair --worker): the join command carries the identity.
            None => manual(
                &format!(
                    "Join {machine_id} again; the command the hub prints carries the identity"
                ),
                Some(format!(
                    "fleetd pair --worker {machine_id}, then run what it prints on {machine_id}"
                )),
            ),
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

/// Whether git could fetch each project's remote at the last worktree started there. None until one has started.
pub fn git_fetch(machine_id: &str, bases: &[(String, WorktreeBase)], now: &str) -> Option<Entry> {
    if bases.is_empty() {
        return None;
    }
    let failing: Vec<_> = bases
        .iter()
        .filter_map(|(project, b)| Some((project, b, base::alert(b)?)))
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
    let status = if *kind == BaseErrorKind::Auth {
        Fail
    } else {
        Warn
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
        let ok = Some("2.1.302 (Claude Code)");
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
            "On mac: claude install 2.1.302, then claude auth login"
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
        };
        let statuses = |i: &RunnerInfo| {
            runner_checks("mac", i)
                .into_iter()
                .map(|e| (e.check.id, e.check.status))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            statuses(&info(
                Some("2.1.302 (Claude Code)"),
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
            Some("claude install 2.1.302")
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
                    Some("2.1.302 (Claude Code)"),
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
                    Some("2.1.302 (Claude Code)"),
                    LoginStatus::LoggedIn,
                    Some(true),
                )
            },
        );
        assert_eq!(
            ok[1].check.message,
            "mac: claude 2.1.302, logged in (Max), via proxy http://127.0.0.1:8317 from ~/.claude/settings.json."
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
