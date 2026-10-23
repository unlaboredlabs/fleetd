//! What Status needs from GitHub beyond the train's own reads: main-branch CI per train repo, read in the train's
//! pass at most once a minute.
use std::collections::HashMap;
use std::sync::Mutex;

use fleetd_contracts::status::CiState;

use super::github::CheckRun;
use super::service::{Checks, checks};

pub const MAIN_CI_EVERY_MS: i64 = 60_000;

/// Main-branch CI of one repo as last read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MainCi {
    pub sha: String,
    pub state: CiState,
    /// Failing check names, at most 10.
    pub failing: Vec<String>,
    /// When `state` last changed.
    pub since_ms: i64,
    /// The last answer from GitHub for it.
    pub as_of_ms: i64,
}

/// The train's rule for a head, applied to the base: no runs yet is pending.
pub fn ci_state(runs: &[CheckRun]) -> (CiState, Vec<String>) {
    match checks(runs) {
        Checks::Red(red) => (
            CiState::Red,
            red.into_iter().map(|r| r.name).take(10).collect(),
        ),
        Checks::Green => (CiState::Green, Vec::new()),
        Checks::None | Checks::Pending => (CiState::Pending, Vec::new()),
    }
}

#[derive(Default)]
struct RepoCi {
    base: Option<String>,
    last_try_ms: Option<i64>,
    latest: Option<MainCi>,
}

#[derive(Default)]
pub struct GithubSync {
    ci: Mutex<HashMap<String, RepoCi>>,
}

impl GithubSync {
    /// Whether this pass reads main CI; marks the try when it does.
    pub fn take_due(&self, repo: &str, now_ms: i64) -> bool {
        let mut ci = self.ci.lock().unwrap();
        let entry = ci.entry(repo.to_owned()).or_default();
        let due = entry
            .last_try_ms
            .is_none_or(|t| now_ms - t >= MAIN_CI_EVERY_MS);
        if due {
            entry.last_try_ms = Some(now_ms);
        }
        due
    }

    pub fn base(&self, repo: &str) -> Option<String> {
        self.ci.lock().unwrap().get(repo)?.base.clone()
    }

    pub fn set_base(&self, repo: &str, base: String) {
        self.ci
            .lock()
            .unwrap()
            .entry(repo.to_owned())
            .or_default()
            .base = Some(base);
    }

    /// Keeps a read; true when the state changed.
    pub fn record(
        &self,
        repo: &str,
        sha: String,
        state: CiState,
        failing: Vec<String>,
        now_ms: i64,
    ) -> bool {
        let mut ci = self.ci.lock().unwrap();
        let entry = ci.entry(repo.to_owned()).or_default();
        let state_changed = entry.latest.as_ref().is_none_or(|p| p.state != state);
        let since_ms = match &entry.latest {
            Some(p) if !state_changed => p.since_ms,
            _ => now_ms,
        };
        entry.latest = Some(MainCi {
            sha,
            state,
            failing,
            since_ms,
            as_of_ms: now_ms,
        });
        state_changed
    }

    pub fn main_ci(&self, repo: &str) -> Option<MainCi> {
        self.ci.lock().unwrap().get(repo)?.latest.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(name: &str, status: &str, conclusion: Option<&str>) -> CheckRun {
        CheckRun {
            id: 1.0,
            name: name.into(),
            status: status.into(),
            conclusion: conclusion.map(String::from),
            html_url: None,
            head_sha: None,
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn main_ci_uses_the_train_rule() {
        assert_eq!(ci_state(&[]).0, CiState::Pending);
        let green = [
            run("rust", "completed", Some("success")),
            run("lint", "completed", Some("skipped")),
        ];
        assert_eq!(ci_state(&green).0, CiState::Green);
        let red = [
            run("rust", "completed", Some("failure")),
            run("lint", "in_progress", None),
        ];
        assert_eq!(ci_state(&red), (CiState::Red, vec!["rust".to_string()]));
        assert_eq!(ci_state(&[run("lint", "queued", None)]).0, CiState::Pending);
    }

    #[test]
    fn a_read_reports_a_state_change() {
        let sync = GithubSync::default();
        assert!(sync.record("r", "a".into(), CiState::Green, vec![], 10));
        assert!(!sync.record("r", "b".into(), CiState::Green, vec![], 20));
        assert_eq!(sync.main_ci("r").unwrap().since_ms, 10);
        sync.record("r", "b".into(), CiState::Red, vec!["rust".into()], 30);
        assert_eq!(sync.main_ci("r").unwrap().since_ms, 30);
    }
}
