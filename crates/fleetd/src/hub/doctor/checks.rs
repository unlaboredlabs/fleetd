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
use crate::node::runner::version::{self, TESTED as CLAUDE_TESTED, VersionVerdict};
use fleetd_contracts::sessions::{LoginStatus, RunnerInfo};

/// The login a person runs on a worker: fleetd's Claude keeps its own config dir there.
pub const MACHINE_LOGIN_FIX: &str = "CLAUDE_CONFIG_DIR=~/.fleetd/claude claude auth login";

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

/// The disk floor: below this a machine cannot hold more worktrees.
pub const MIN_FREE_BYTES: f64 = 5e9;

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

pub fn claude_login_fix() -> DoctorFix {
    manual(
        "Log claude in as the hub's user (a gateway instead: ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in the env block of ~/.claude/settings.json)",
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

/// The node's link to the hub; what it runs is checked by the claude checks.
pub fn machine_online(machine: &MachineView, setup: Option<&MachineSetup>) -> Entry {
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
        "degraded" => machine_entry(
            id,
            "online",
            Warn,
            &format!(
                "{id} is degraded: {}.",
                machine
                    .degraded_reason
                    .as_deref()
                    .unwrap_or("its node reports a problem")
            ),
            restart(),
        ),
        _ => machine_entry(id, "online", Pass, &format!("{id} is online."), None),
    }
}

/// `claude_version`, `claude_login` and `runner_conformance` from what the node's runner reports (`runner_info`).
pub fn runner_checks(machine_id: &str, info: &RunnerInfo) -> Vec<Entry> {
    let login_fix = || {
        Some(manual(
            &format!("Log fleetd's Claude in on {machine_id} (its own config dir)"),
            Some(MACHINE_LOGIN_FIX.into()),
        ))
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
            &format!(
                "fleetd's Claude on {machine_id} is logged in{}.",
                info.login_kind
                    .as_deref()
                    .map_or(String::new(), |k| format!(" ({k})"))
            ),
            None,
        ),
        LoginStatus::LoggedOut => machine_entry(
            machine_id,
            "claude_login",
            Fail,
            &format!(
                "fleetd's Claude on {machine_id} is not logged in, so its sessions can't start."
            ),
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

/// The version verdict as a check: refused outside the supported range, a warning past the tested version.
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
        VersionVerdict::UntestedNewer => entry(Warn, &problem, fix),
        _ => entry(Fail, &problem, fix),
    }
}

/// The hub's own claude (the intake router and the retro run it): version and protocol, from the probe.
pub fn hub_claude_version(info: &RunnerInfo) -> Entry {
    match &info.version {
        None => hub_entry(
            "claude_version",
            Fail,
            "Claude Code (claude) is not on the hub's PATH; the intake router and the retro can't run.",
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
                Some(format!("fleetd machine add {}", m.ssh_host)),
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

pub fn disk_space(machine_id: &str, probe: Result<&HostProbe, &str>) -> Entry {
    let probe = match probe {
        Err(why) => return machine_entry(machine_id, "disk", Unknown, why, None),
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
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_is_fine_only_on_loopback_and_the_tailnet() {
        for url in [
            "http://127.0.0.1:4790",
            "http://localhost:4790/",
            "http://[::1]:4790",
            "http://100.104.249.49:4790",
            "http://forge.tailb10092.ts.net:4790",
            "http://[fd7a:115c:a1e0::b430:f932]:4790",
        ] {
            assert!(sealed_http(url).is_some(), "{url}");
        }
        for url in [
            "http://192.168.8.227:4790",
            "http://100.128.0.1:4790",
            "http://forge.example.com",
            "http://10.0.0.2:4790",
        ] {
            assert_eq!(sealed_http(url), None, "{url}");
        }
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
            &info(Some("2.0.1"), LoginStatus::LoggedOut, Some(false)),
        );
        assert_eq!(bad[0].check.status, Fail);
        assert_eq!(
            bad[0].check.fix.as_ref().and_then(|f| f.command.as_deref()),
            Some("claude update (or claude install 2.1.302)")
        );
        assert_eq!(
            bad[1].check.fix.as_ref().and_then(|f| f.command.as_deref()),
            Some(MACHINE_LOGIN_FIX)
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
