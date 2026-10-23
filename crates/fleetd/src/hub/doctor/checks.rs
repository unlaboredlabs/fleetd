//! Each doctor check as a pure function of what the hub read: a status, a plain message, and at most one fix, a
//! command for a person to run.
use super::config::{HubConfig, MachineSetup, restart_command};
use crate::hub::usage::service::UsageBreaker;
use crate::hub::usage::time::clip;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

use crate::cli::setup::machine_plan::CLAUDE_INSTALL;
use crate::node::runner::claude_setup::ClaudeSetup;
use crate::node::runner::failure::login_fix;
use crate::node::runner::version::{self, TESTED as CLAUDE_TESTED, VersionVerdict};
use fleetd_contracts::model::{SleptSpan, duration_text};
use fleetd_contracts::node_link::{IdleSleep, NodeDisk};
use fleetd_contracts::sessions::{LoginStatus, RunnerInfo};

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

/// The hub's claude login fix. Behind a proxy the proxy holds the login. Otherwise `claude auth login`, or a gateway's
/// variables in `claude.env`, which the hub's service loads (the one-shot runner passes only those variables on).
pub fn claude_login_fix(proxy: Option<&str>) -> DoctorFix {
    match proxy {
        Some(proxy) => manual(
            &format!(
                "On the hub, {} (its claude goes through {proxy})",
                login_fix(true)
            ),
            None,
        ),
        None => manual(
            "Log claude in as the hub's user (a gateway instead: ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in \
             ~/.fleetd/claude.env, then restart the hub)",
            Some(login_fix(false).into()),
        ),
    }
}

/// `claude auth status --json` as the retro runs it (same environment, so the same login). The retro reaches a model
/// only through this login; without it, it can't run.
pub fn claude_login(outcome: &CmdOutcome) -> Entry {
    hub_claude_login(outcome, None)
}

/// [`claude_login`] for a hub claude that goes through `proxy`, whose login the proxy holds.
pub fn hub_claude_login(outcome: &CmdOutcome, proxy: Option<&str>) -> Entry {
    let (exit_code, stdout) = match outcome {
        CmdOutcome::SpawnError(e) if e == "ENOENT" => {
            return hub_entry(
                "claude_login",
                Fail,
                "Claude Code (claude) is not on the hub's PATH; the retro can't run.",
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
            "claude on the hub is not logged in; the retro can't reach a model.",
            Some(claude_login_fix(proxy)),
        );
    }
    let method = status
        .get("authMethod")
        .and_then(Value::as_str)
        .map_or(String::new(), auth_method_words);
    hub_entry(
        "claude_login",
        Pass,
        &format!("claude on the hub is logged in{method}; the retro can run."),
        None,
    )
}

/// claude's `authMethod` in words for a person; one this doesn't know stays as claude says it, as code.
fn auth_method_words(method: &str) -> String {
    match method {
        "oauth_token" => " with a long-lived login token".into(),
        "claude.ai" | "claudeai" => " with a Claude account".into(),
        "api_key" | "apiKey" => " with an API key".into(),
        "" => String::new(),
        other => format!(" (`{other}`)"),
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
    #[serde(default)]
    pub last_slept: Option<SleptSpan>,
}

/// The one fix for a machine whose runner is unusable, from the cause its probe reports: claude missing, out of the
/// supported range, a protocol break, logged out. Two causes at once become one ordered sentence (an update first,
/// since a login on a claude that can't run proves nothing). None when the runner reports no cause.
pub fn runner_fix(machine_id: &str, info: &RunnerInfo) -> Option<DoctorFix> {
    let claude = match &info.version {
        None => Some(("Install Claude Code", CLAUDE_INSTALL.to_owned())),
        Some(found) if !info.version_ok => Some((
            "Put a supported claude",
            version::check(found)
                .fix()
                .unwrap_or_else(|| "claude update".to_owned()),
        )),
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
    let mut out = vec![version, login, conformance];
    out.extend(auto_memory_check(machine_id, info));
    out.extend(subagents_check(machine_id, info));
    out
}

/// Claude Code's own subagents are off in fleetd sessions: the probe's init and the latest session's offered no agent
/// tool and no built-in agent fleetd's knobs remove. No line from a node that predates the check.
fn subagents_check(machine_id: &str, info: &RunnerInfo) -> Option<Entry> {
    let leaks = info.subagent_leaks.as_ref()?;
    Some(if leaks.is_empty() {
        machine_entry(
            machine_id,
            "claude_subagents",
            Pass,
            "Claude subagents off (fleetd manages agents)",
            None,
        )
    } else {
        machine_entry(
            machine_id,
            "claude_subagents",
            Fail,
            &format!(
                "claude on {machine_id} still offers its own subagents in fleetd sessions ({}): they would run \
                 outside fleetd's slots, so no new session starts there.",
                leaks.join(", ")
            ),
            Some(manual(
                "Install the claude version fleetd was tested with",
                Some(format!(
                    "claude install {}",
                    crate::node::runner::version::TESTED
                )),
            )),
        )
    })
}

/// What the latest session's `system/init` showed of claude's auto memory, which fleetd keeps off. No line until a
/// session has run there, nor from a node that predates the check.
fn auto_memory_check(machine_id: &str, info: &RunnerInfo) -> Option<Entry> {
    Some(match info.auto_memory? {
        false => machine_entry(
            machine_id,
            "claude_auto_memory",
            Pass,
            "claude auto memory off.",
            None,
        ),
        true => {
            let dir = info.config_dir.as_deref().unwrap_or("~/.claude");
            machine_entry(
                machine_id,
                "claude_auto_memory",
                Warn,
                &format!(
                    "claude on {machine_id} kept its auto memory on despite CLAUDE_CODE_DISABLE_AUTO_MEMORY and \
                     autoMemoryEnabled: its agents may carry notes from one worktree to the next."
                ),
                Some(manual(
                    &format!(
                        "On {machine_id}, set \"autoMemoryEnabled\": false in {dir}/settings.json, and run \
                         fleetd update"
                    ),
                    None,
                )),
            )
        }
    })
}

/// The version verdict as a check: a warning outside the tested versions that still run (older, or newer within the
/// minor), a failure where sessions are refused.
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
        VersionVerdict::UntestedNewer | VersionVerdict::UntestedOlder => entry(Warn, &problem, fix),
        _ => entry(Fail, &problem, fix),
    }
}

/// The hub's own claude (the retro runs it): version and protocol, from the probe.
pub fn hub_claude_version(info: &RunnerInfo) -> Entry {
    match &info.version {
        None => hub_entry(
            "claude_version",
            Fail,
            "Claude Code (claude) is not on the hub's PATH; the retro can't run.",
            Some(manual(
                "Install Claude Code on the hub machine, then log in",
                Some(CLAUDE_INSTALL.into()),
            )),
        ),
        Some(found) => version_entry(found, |status, message, fix| {
            hub_entry("claude_version", status, message, fix)
        }),
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
    /// Absent from nodes older than the sleep check.
    #[serde(default)]
    pub idle_sleep: Option<Vec<IdleSleep>>,
}

fn minutes(sec: u64) -> String {
    match sec {
        0..60 => format!("{sec} s"),
        60..7200 => format!("{} min", sec / 60),
        _ => format!("{} h", sec / 3600),
    }
}

/// Whether the machine puts itself to sleep when idle on AC, and its latest sleep while recent. The inhibitor keeps
/// it awake while agents run; between orders it still sleeps, and asleep it is unreachable.
pub fn idle_sleep(
    machine_id: &str,
    probe: Result<&HostProbe, &str>,
    last_slept: Option<&SleptSpan>,
    now_ms: i64,
) -> Entry {
    let entry =
        |status, message: &str, fix| machine_entry(machine_id, "sleep", status, message, fix);
    let probe = match probe {
        Err(why) => return entry(Unknown, why, None),
        Ok(p) => p,
    };
    let Some(found) = &probe.idle_sleep else {
        return entry(
            Unknown,
            &format!("{machine_id}'s node is too old to read its sleep settings."),
            Some(manual("Update fleetd", Some("fleetd update".into()))),
        );
    };
    let recent = last_slept.and_then(|s| {
        let text = s.recent_text(now_ms)?;
        let ago = duration_text(now_ms - s.to_ms.get());
        Some(format!("It {text} (woke {ago} ago)."))
    });
    // The status follows the settings only, so a sleep does not flap the check (and log doctor.changed) for an hour.
    let Some(first) = found.first() else {
        let how = recent
            .map(|r| format!(" {r} A lid, its power button or a suspend command put it to sleep."))
            .unwrap_or_default();
        return entry(
            Pass,
            &format!("{machine_id} does not sleep when idle on AC power.{how}"),
            None,
        );
    };
    let after = first
        .after_sec
        .map(|s| format!(" after {} idle", minutes(s.get().max(0) as u64)))
        .unwrap_or_else(|| " when idle".into());
    let also: Vec<&str> = found[1..].iter().map(|s| s.source.as_str()).collect();
    let also = if also.is_empty() {
        String::new()
    } else {
        format!(" ({} too)", also.join(", "))
    };
    entry(
        Warn,
        &format!(
            "{machine_id} {}{after} on AC power ({}){also}. fleetd keeps it awake while agents run, but it still sleeps between orders, and asleep it is unreachable: queued work and wakes wait until someone wakes it.{}",
            first.action,
            first.source,
            recent.map(|r| format!(" {r}")).unwrap_or_default()
        ),
        Some(manual(
            &format!("Stop {machine_id} sleeping when idle on AC"),
            Some(first.fix.to_string()),
        )),
    )
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

/// Projects whose checkout the machine's node won't run commands in (outside its cmdRoots): `(path, why)`. Their
/// PRs could never merge, since the train's git runs there too.
pub fn cmd_roots(machine_id: &str, refused: &[(String, String)]) -> Entry {
    if refused.is_empty() {
        return machine_entry(
            machine_id,
            "cmd-roots",
            Pass,
            "Every project's checkout is inside the node's cmdRoots.",
            None,
        );
    }
    let paths: Vec<&str> = refused.iter().map(|(path, _)| path.as_str()).collect();
    machine_entry(
        machine_id,
        "cmd-roots",
        Fail,
        &format!(
            "The node on {machine_id} won't run commands in {} (outside its cmdRoots), so the merge train can't merge {} PRs.",
            paths.join(", "),
            if paths.len() == 1 { "its" } else { "their" }
        ),
        Some(manual(
            &crate::node::cmd::outside_roots_fix(machine_id),
            None,
        )),
    )
}

/// Each project's writer areas, for reading: writers in different areas run at once, so a project with one area
/// runs its writers one at a time, which the line says. Never a warning: one area suits a small repo.
pub fn areas(machine_id: &str, projects: &[super::service::ProjectAreas]) -> Entry {
    let line = |p: &super::service::ProjectAreas| {
        let source = if p.inferred {
            "inferred from the repo"
        } else {
            "from .fleetd/policy.yaml"
        };
        let one = if p.areas.len() <= 1 {
            "; one area, so writers run one at a time"
        } else {
            ""
        };
        format!("{}: {} ({source}{one})", p.title, p.areas.join(", "))
    };
    let listed = projects.iter().map(line).collect::<Vec<_>>().join("; ");
    machine_entry(
        machine_id,
        "areas",
        Pass,
        &format!("Writer areas: {listed}."),
        None,
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_list_each_project_and_say_when_one_area_serializes_its_writers() {
        use super::super::service::ProjectAreas;
        let shop = ProjectAreas {
            title: "storefront".into(),
            areas: vec!["all".into(), "docs".into(), "web".into()],
            inferred: true,
        };
        let one = ProjectAreas {
            title: "billing".into(),
            areas: vec!["all".into()],
            inferred: false,
        };
        let check = areas("devbox", &[shop, one]).check;
        assert_eq!((check.id.as_str(), check.status), ("devbox/areas", Pass));
        assert_eq!(
            check.message,
            "Writer areas: storefront: all, docs, web (inferred from the repo); billing: all (from .fleetd/policy.yaml; one area, so writers run one at a time)."
        );
    }

    #[test]
    fn a_project_outside_cmd_roots_fails_with_the_fix() {
        let ok = cmd_roots("fe7", &[]).check;
        assert_eq!((ok.id.as_str(), ok.status), ("fe7/cmd-roots", Pass));
        let refused = cmd_roots(
            "fe7",
            &[(
                "/tmp/work/lab".into(),
                "/tmp/work/lab is outside cmdRoots".into(),
            )],
        )
        .check;
        assert_eq!(refused.status, Fail);
        assert!(
            refused.message.contains("/tmp/work/lab"),
            "{}",
            refused.message
        );
        let fix = refused.fix.unwrap();
        assert!(
            fix.label.contains("\"cmdRoots\" in node.json on fe7"),
            "{}",
            fix.label
        );
    }

    #[test]
    fn the_hub_login_says_its_method_in_words() {
        let ran = |method: &str| CmdOutcome::Ran {
            exit_code: 0,
            stdout: serde_json::json!({ "loggedIn": true, "authMethod": method }).to_string(),
            stderr: String::new(),
        };
        let message = |method: &str| {
            hub_claude_login(&ran(method), None)
                .check
                .message
                .to_string()
        };
        assert_eq!(
            message("oauth_token"),
            "claude on the hub is logged in with a long-lived login token; the retro can run."
        );
        assert!(message("claude.ai").contains("logged in with a Claude account;"));
        assert!(
            message("something_new").contains("logged in (`something_new`);"),
            "an unknown method shows as code"
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

    #[test]
    fn warns_when_a_machine_sleeps_idle_on_ac() {
        let probe = |idle_sleep: Option<serde_json::Value>| -> HostProbe {
            serde_json::from_value(serde_json::json!({
                "idleSleep": idle_sleep,
            }))
            .unwrap()
        };
        let kde = serde_json::json!([
            { "source": "KDE power management", "action": "sleeps", "afterSec": 900,
              "fix": "System Settings > Power Management > On AC Power > When inactive: Do nothing" },
            { "source": "logind IdleAction", "action": "sleeps", "afterSec": 1800, "fix": "edit logind.conf" },
        ]);
        let woke_at = 1_760_000_646_000;
        let slept = SleptSpan::new(woke_at - 646_000, woke_at).unwrap();
        let now = woke_at + 3 * 60_000;

        let warn = idle_sleep("devbox", Ok(&probe(Some(kde))), Some(&slept), now).check;
        assert_eq!(warn.status, Warn);
        assert_eq!(
            warn.message,
            "devbox sleeps after 15 min idle on AC power (KDE power management) (logind IdleAction too). fleetd keeps \
             it awake while agents run, but it still sleeps between orders, and asleep it is unreachable: queued work \
             and wakes wait until someone wakes it. It slept 10m46s (woke 3m00s ago)."
        );
        assert_eq!(
            warn.fix.and_then(|f| f.command).as_deref(),
            Some("System Settings > Power Management > On AC Power > When inactive: Do nothing")
        );

        // No idle sleep: a pass whatever the last sleep was, so a sleep never flaps the check.
        let quiet = idle_sleep(
            "devbox",
            Ok(&probe(Some(serde_json::json!([])))),
            Some(&slept),
            now,
        )
        .check;
        assert_eq!(quiet.status, Pass);
        assert!(
            quiet.message.contains("It slept 10m46s"),
            "{}",
            quiet.message
        );
        let long_ago = idle_sleep(
            "devbox",
            Ok(&probe(Some(serde_json::json!([])))),
            Some(&slept),
            now + 3_600_000,
        );
        assert_eq!(
            long_ago.check.message,
            "devbox does not sleep when idle on AC power."
        );

        let old_node = idle_sleep("devbox", Ok(&probe(None)), None, now).check;
        assert_eq!(
            (old_node.status, old_node.fix.and_then(|f| f.command)),
            (Unknown, Some("fleetd update".into()))
        );
    }

    /// A degraded machine's finding has exactly one fix, and it is the one for the cause.
    #[test]
    fn a_degraded_machine_gets_the_one_fix_for_its_cause() {
        let degraded = MachineView {
            machine_id: "mac".into(),
            status: "degraded".into(),
            last_seen_at: "now".into(),
            degraded_reason: Some("claude is not logged in. Fix: claude auth login".into()),
            last_slept: None,
        };
        let runner = |version: Option<&str>, version_ok, login, proxy: Option<&str>| RunnerInfo {
            runner: fleetd_contracts::sessions::RunnerKind::Claude,
            version: version.map(str::to_owned),
            supported: ">=2.1.300, <2.2.0".into(),
            version_ok,
            login,
            login_kind: None,
            conformance_ok: Some(true),
            problem: None,
            login_label: None,
            proxy: proxy.map(str::to_owned),
            proxy_source: None,
            config_dir: None,
            auto_memory: None,
            agent_tools: None,
            subagent_leaks: None,
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
            fix(Some(runner(ok, true, LoginStatus::LoggedOut, None))),
            (
                "Log claude in on mac".into(),
                Some("claude auth login".into())
            )
        );
        let (label, command) = fix(Some(runner(
            ok,
            true,
            LoginStatus::LoggedOut,
            Some("http://127.0.0.1:8317"),
        )));
        assert_eq!(command, None);
        assert!(
            label.contains("log in with your proxy") && label.contains("8317"),
            "{label}"
        );
        assert_eq!(
            fix(Some(runner(
                Some("2.0.1"),
                false,
                LoginStatus::LoggedIn,
                None
            )))
            .1
            .as_deref(),
            Some("claude update")
        );
        assert_eq!(
            fix(Some(runner(None, false, LoginStatus::Unknown, None)))
                .1
                .as_deref(),
            Some(CLAUDE_INSTALL)
        );
        // Two causes: one ordered sentence, the update first.
        let (label, command) = fix(Some(runner(
            Some("2.0.1"),
            false,
            LoginStatus::LoggedOut,
            None,
        )));
        assert_eq!(command, None);
        assert_eq!(label, "On mac: claude update, then claude auth login");
        // No runner report: the node's own fix, never a restart for a login problem.
        assert_eq!(fix(None).1.as_deref(), Some("claude auth login"));
        // No runner cause at all: the node itself is the problem.
        let down = MachineView {
            degraded_reason: Some("its node's runner is unavailable".into()),
            ..degraded.clone()
        };
        let entry = machine_online(
            &down,
            None,
            Some(&runner(ok, true, LoginStatus::LoggedIn, None)),
        );
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
            auto_memory: None,
            agent_tools: None,
            subagent_leaks: None,
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
        // Auto memory: a line once a session has shown it, a warning with the fix when claude kept it on.
        let memory = |on| {
            runner_checks(
                "mac",
                &RunnerInfo {
                    auto_memory: Some(on),
                    ..info(Some("2.1.302"), LoginStatus::LoggedIn, Some(true))
                },
            )
            .pop()
            .unwrap()
            .check
        };
        assert_eq!(
            (memory(false).status, memory(false).message.as_str()),
            (Pass, "claude auto memory off.")
        );
        let kept = memory(true);
        assert_eq!(kept.status, Warn);
        // Subagents: a pass once a probe found none on, a failure naming them with the reinstall otherwise.
        let subagents = |leaks: Vec<String>| {
            runner_checks(
                "mac",
                &RunnerInfo {
                    subagent_leaks: Some(leaks),
                    ..info(Some("2.1.302"), LoginStatus::LoggedIn, Some(true))
                },
            )
            .pop()
            .unwrap()
            .check
        };
        let off = subagents(vec![]);
        assert_eq!(
            (off.status, off.message.as_str()),
            (Pass, "Claude subagents off (fleetd manages agents)")
        );
        let on = subagents(vec!["Agent".into(), "agent Explore".into()]);
        assert_eq!(on.status, Fail);
        assert!(
            on.message.contains("(Agent, agent Explore)"),
            "{}",
            on.message
        );
        assert_eq!(
            on.fix.and_then(|f| f.command).as_deref(),
            Some("claude install 2.1.302")
        );
        assert!(
            kept.fix
                .unwrap()
                .label
                .contains("set \"autoMemoryEnabled\": false in ~/.claude/settings.json")
        );
        let bad = runner_checks(
            "mac",
            &info(Some("2.2.1"), LoginStatus::LoggedOut, Some(false)),
        );
        assert_eq!(bad[0].check.status, Fail);
        assert_eq!(
            bad[0].check.fix.as_ref().and_then(|f| f.command.as_deref()),
            Some("claude install 2.1.302, or fleetd update")
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
        assert_eq!(newer[0].check.status, Warn);
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
