//! What the status view needs from GitHub beyond the train's own reads: main-branch CI per train repo, read in the
//! train's pass at most once a minute (conditional, so an unchanged answer is free); whether opt-in webhooks are on
//! and when each repo last had a delivery; and the drift reconciliation found.
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use fleetd_contracts::status::{CiState, DriftKind};

use super::github::CheckRun;

pub const MAIN_CI_EVERY_MS: i64 = 60_000;
/// With webhooks on, a delivery kicks the pass; the reconciliation read is only a safety net.
pub const MAIN_CI_HOOKED_EVERY_MS: i64 = 5 * 60_000;
/// A change reconciliation saw with no delivery in this long before it is a missed webhook.
pub const DELIVERY_WINDOW_MS: i64 = 2 * 60_000;
/// After a missed webhook, main CI is read every minute again for this long.
pub const FALLBACK_MS: i64 = 30 * 60_000;
const DAY_MS: i64 = 24 * 60 * 60_000;
const TRAIN_MERGES_KEPT: usize = 50;

pub fn main_ci_every_ms() -> i64 {
    std::env::var("FLEETD_MAIN_CI_EVERY_SEC")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|s| *s > 0)
        .map_or(MAIN_CI_EVERY_MS, |s| s * 1000)
}

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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DriftCounts {
    pub outside_fleetd: u32,
    pub missed_webhook: u32,
}

/// The train's rule for a head, applied to the base: red when a completed run did not pass, green when every run
/// completed, pending otherwise (including no runs yet).
pub fn ci_state(runs: &[CheckRun]) -> (CiState, Vec<String>) {
    let failing: Vec<String> = runs
        .iter()
        .filter(|r| super::service::is_red(r))
        .map(|r| r.name.clone())
        .take(10)
        .collect();
    let state = if !failing.is_empty() {
        CiState::Red
    } else if !runs.is_empty() && runs.iter().all(|r| r.status == "completed") {
        CiState::Green
    } else {
        CiState::Pending
    };
    (state, failing)
}

#[derive(Default)]
struct RepoCi {
    base: Option<String>,
    last_try_ms: Option<i64>,
    /// A delivery asked for a read on the next pass.
    due: bool,
    latest: Option<MainCi>,
}

/// What a recorded read changed.
pub struct CiRead {
    pub previous: Option<MainCi>,
    pub state_changed: bool,
    pub sha_changed: bool,
}

#[derive(Default)]
pub struct GithubSync {
    ci: Mutex<HashMap<String, RepoCi>>,
    webhooks_on: AtomicBool,
    deliveries: Mutex<HashMap<String, i64>>,
    fallback_until: Mutex<HashMap<String, i64>>,
    drifts: Mutex<HashMap<String, Vec<(i64, DriftKind)>>>,
    train_merges: Mutex<HashMap<String, VecDeque<String>>>,
}

impl GithubSync {
    pub fn webhooks_on(&self) -> bool {
        self.webhooks_on.load(Ordering::Relaxed)
    }

    pub fn set_webhooks(&self, on: bool) {
        self.webhooks_on.store(on, Ordering::Relaxed);
    }

    pub fn every_ms(&self, repo: &str, now_ms: i64) -> i64 {
        let fallback = self
            .fallback_until
            .lock()
            .unwrap()
            .get(repo)
            .is_some_and(|until| now_ms < *until);
        if self.webhooks_on() && !fallback {
            MAIN_CI_HOOKED_EVERY_MS.max(main_ci_every_ms())
        } else {
            main_ci_every_ms()
        }
    }

    /// Whether this pass reads main CI; marks the try when it does.
    pub fn take_due(&self, repo: &str, now_ms: i64) -> bool {
        let every = self.every_ms(repo, now_ms);
        let mut ci = self.ci.lock().unwrap();
        let entry = ci.entry(repo.to_owned()).or_default();
        let due = entry.due || entry.last_try_ms.is_none_or(|t| now_ms - t >= every);
        if due {
            entry.due = false;
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

    pub fn record(
        &self,
        repo: &str,
        sha: String,
        state: CiState,
        failing: Vec<String>,
        now_ms: i64,
    ) -> CiRead {
        let mut ci = self.ci.lock().unwrap();
        let entry = ci.entry(repo.to_owned()).or_default();
        let previous = entry.latest.clone();
        let state_changed = previous.as_ref().is_none_or(|p| p.state != state);
        let sha_changed = previous.as_ref().is_some_and(|p| p.sha != sha);
        let since_ms = match &previous {
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
        CiRead {
            previous,
            state_changed,
            sha_changed,
        }
    }

    pub fn main_ci(&self, repo: &str) -> Option<MainCi> {
        self.ci.lock().unwrap().get(repo)?.latest.clone()
    }

    /// A signed delivery arrived; push and check events make the next pass read main CI.
    pub fn delivered(&self, repo: &str, event: &str, now_ms: i64) {
        self.deliveries
            .lock()
            .unwrap()
            .insert(repo.to_owned(), now_ms);
        if matches!(event, "push" | "check_suite" | "check_run" | "status") {
            self.ci
                .lock()
                .unwrap()
                .entry(repo.to_owned())
                .or_default()
                .due = true;
        }
    }

    pub fn last_delivery(&self, repo: &str) -> Option<i64> {
        self.deliveries.lock().unwrap().get(repo).copied()
    }

    /// Reconciliation saw a change: true when webhooks are on and no delivery came in the window before it, which
    /// also drops main CI back to every minute for a while.
    pub fn missed(&self, repo: &str, now_ms: i64) -> bool {
        if !self.webhooks_on() {
            return false;
        }
        let last = self.deliveries.lock().unwrap().get(repo).copied();
        if last.is_some_and(|d| now_ms - d <= DELIVERY_WINDOW_MS) {
            return false;
        }
        self.fallback_until
            .lock()
            .unwrap()
            .insert(repo.to_owned(), now_ms + FALLBACK_MS);
        true
    }

    pub fn note_drift(&self, repo: &str, kind: DriftKind, now_ms: i64) {
        let mut drifts = self.drifts.lock().unwrap();
        let list = drifts.entry(repo.to_owned()).or_default();
        list.retain(|(at, _)| now_ms - at < DAY_MS);
        list.push((now_ms, kind));
    }

    pub fn drift_counts(&self, repo: &str, since_ms: i64) -> DriftCounts {
        let drifts = self.drifts.lock().unwrap();
        let mut counts = DriftCounts::default();
        for (at, kind) in drifts.get(repo).into_iter().flatten() {
            if *at < since_ms {
                continue;
            }
            match kind {
                DriftKind::OutsideFleetd => counts.outside_fleetd += 1,
                DriftKind::MissedWebhook => counts.missed_webhook += 1,
            }
        }
        counts
    }

    pub fn train_merged(&self, repo: &str, sha: &str) {
        let mut merges = self.train_merges.lock().unwrap();
        let list = merges.entry(repo.to_owned()).or_default();
        list.push_back(sha.to_lowercase());
        if list.len() > TRAIN_MERGES_KEPT {
            list.pop_front();
        }
    }

    pub fn is_train_merge(&self, repo: &str, sha: &str) -> bool {
        self.train_merges
            .lock()
            .unwrap()
            .get(repo)
            .is_some_and(|l| l.iter().any(|s| s.eq_ignore_ascii_case(sha)))
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
    fn a_change_without_a_recent_delivery_is_a_missed_webhook() {
        let sync = GithubSync::default();
        assert!(
            !sync.missed("acme/storefront", 0),
            "webhooks off: nothing is missed"
        );
        sync.set_webhooks(true);
        assert!(sync.take_due("acme/storefront", 0));
        assert!(
            !sync.take_due("acme/storefront", 60_000),
            "hooked: every 5 min"
        );
        sync.delivered("acme/storefront", "push", 100_000);
        assert!(
            sync.take_due("acme/storefront", 100_001),
            "a push makes the next pass read"
        );
        assert!(!sync.missed("acme/storefront", 100_000 + DELIVERY_WINDOW_MS));
        assert!(sync.missed("acme/storefront", 100_001 + DELIVERY_WINDOW_MS));
        let now = 100_001 + DELIVERY_WINDOW_MS;
        assert!(
            sync.take_due("acme/storefront", now + main_ci_every_ms()),
            "fallback: every minute"
        );
    }

    #[test]
    fn a_read_reports_state_and_sha_changes() {
        let sync = GithubSync::default();
        let first = sync.record("r", "a".into(), CiState::Green, vec![], 10);
        assert!(first.state_changed && !first.sha_changed);
        let same = sync.record("r", "b".into(), CiState::Green, vec![], 20);
        assert!(!same.state_changed && same.sha_changed);
        assert_eq!(sync.main_ci("r").unwrap().since_ms, 10);
        sync.record("r", "b".into(), CiState::Red, vec!["rust".into()], 30);
        assert_eq!(sync.main_ci("r").unwrap().since_ms, 30);
    }
}
