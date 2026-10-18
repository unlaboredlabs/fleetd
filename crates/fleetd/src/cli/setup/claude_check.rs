//! What setup and the doctor need to know about an installed `claude`: is its version one the runner speaks, and is
//! fleetd's login there.
//!
//! Stand-in until the runner's failure and version slice lands (feat/runner-failures): then `verdict` becomes
//! `node::runner::version::check` and `probe` becomes `node::runner::conformance::probe`, with the same answers.

use std::path::Path;

use fleetd_contracts::sessions::{LoginStatus, RunnerInfo, RunnerKind};

pub const TESTED: &str = "2.1.302";
pub const SUPPORTED: &str = ">=2.1.300, <2.2.0";
pub const INSTALL: &str = "curl -fsSL https://claude.ai/install.sh | bash";

#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    /// Sessions may start with it.
    pub runs: bool,
    /// Inside the range but newer than the tested version.
    pub untested: bool,
    pub problem: Option<String>,
    pub fix: Option<String>,
}

fn parse(version: &str) -> Option<(u64, u64, u64)> {
    let word = version.split_whitespace().next()?;
    let core = word
        .strip_prefix('v')
        .unwrap_or(word)
        .split(['-', '+'])
        .next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(v)
}

/// `printed` as `claude --version` prints it ("2.1.302 (Claude Code)").
pub fn verdict(printed: &str) -> Verdict {
    let found = printed.trim();
    let refuse = |problem: String, fix: String| Verdict {
        runs: false,
        untested: false,
        problem: Some(problem),
        fix: Some(fix),
    };
    let Some(v) = parse(found) else {
        return refuse(
            format!("`claude --version` printed {found:?}, which is not a version"),
            format!("{INSTALL} -s {TESTED}"),
        );
    };
    let tested = parse(TESTED).expect("TESTED parses");
    if v < (2, 1, 300) {
        refuse(
            format!("claude {found} is older than fleetd supports ({SUPPORTED})"),
            format!("claude update (or claude install {TESTED})"),
        )
    } else if v >= (2, 2, 0) {
        refuse(
            format!("claude {found} is newer than fleetd supports ({SUPPORTED})"),
            format!("claude install {TESTED}, or fleetd update"),
        )
    } else if v > tested {
        Verdict {
            runs: true,
            untested: true,
            problem: Some(format!(
                "claude {found} is newer than {TESTED}, the version fleetd was tested with; sessions run"
            )),
            fix: Some(format!("claude install {TESTED}")),
        }
    } else {
        Verdict {
            runs: true,
            untested: false,
            problem: None,
            fix: None,
        }
    }
}

/// Version and login of `binary` with exactly `env`, without a model call.
pub async fn probe(binary: &Path, env: &[(String, String)]) -> RunnerInfo {
    let run = |args: &'static [&'static str]| {
        tokio::process::Command::new(binary)
            .args(args)
            .env_clear()
            .envs(env.iter().cloned())
            .stdin(std::process::Stdio::null())
            .output()
    };
    let mut info = RunnerInfo {
        runner: RunnerKind::Claude,
        version: None,
        supported: SUPPORTED.into(),
        version_ok: false,
        login: LoginStatus::Unknown,
        login_kind: None,
        conformance_ok: None,
        problem: None,
    };
    let Ok(out) = run(&["--version"]).await else {
        info.problem = Some(format!("claude is not installed. Fix: {INSTALL}"));
        return info;
    };
    let printed = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let v = verdict(&printed);
    info.version_ok = v.runs;
    info.problem = v.problem.map(|p| match v.fix {
        Some(fix) => format!("{p}. Fix: {fix}"),
        None => p,
    });
    info.version = Some(printed);
    if let Ok(out) = run(&["auth", "status", "--json"]).await {
        let status: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        info.login = match status.get("loggedIn").and_then(serde_json::Value::as_bool) {
            Some(true) => LoginStatus::LoggedIn,
            Some(false) => LoginStatus::LoggedOut,
            None => LoginStatus::Unknown,
        };
        info.login_kind = status
            .get("authMethod")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_verdicts() {
        assert!(verdict("2.1.302 (Claude Code)").runs);
        assert!(!verdict("2.1.302 (Claude Code)").untested);
        let newer = verdict("2.1.310 (Claude Code)");
        assert!(newer.runs && newer.untested);
        assert_eq!(
            verdict("2.1.299").fix.as_deref(),
            Some("claude update (or claude install 2.1.302)")
        );
        assert!(!verdict("2.2.0").runs);
        assert!(!verdict("Claude Code").runs);
        assert!(verdict("2.1.303-beta.1").untested);
    }
}
