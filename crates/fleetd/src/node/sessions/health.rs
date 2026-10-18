//! What the node says about its runner (`runner_info`): the last zero-cost probe, corrected by what real runs
//! showed since.
//!
//! The probe cannot prove a login works. claude's `initialize` only reports which credential it would use, so a
//! revoked token or a bad API key still probes as logged in until a run gets a 401. A run that fails Auth therefore
//! marks the login logged out, and that mark outlives probes that merely repeat the old answer. It is cleared by
//! evidence: a run that completes, a probe that reports logged in after the login inputs changed (someone ran
//! `claude auth login` or edited `claude.env`), or a probe reporting logged in once the mark is [`PROBE_EVERY`] old.
//! The last case covers a macOS keychain login, which changes no file the node can see.
use std::time::Duration;

use tokio::time::Instant;

use fleetd_contracts::sessions::{LoginStatus, RunnerInfo};

use crate::node::runner::failure::LOGIN_FIX;

/// The scheduled probe: version drift, a login that expired, a conformance break after `claude update`.
pub const PROBE_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// A runner that can't run sessions is re-probed on demand at most this often, so a fix shows within seconds while
/// a hub asking repeatedly never spawns claude for every call.
pub const RECHECK_AFTER: Duration = Duration::from_secs(30);

struct AuthMark {
    /// [`super::SessionConfig::login_fingerprint`] when the run failed.
    login: u64,
    at: Instant,
    /// claude's own words.
    message: String,
}

#[derive(Default)]
pub struct Health {
    probed: Option<(RunnerInfo, Instant)>,
    auth_failed: Option<AuthMark>,
}

impl Health {
    /// What `runner_info` reports; `None` before the first probe ends.
    pub fn info(&self) -> Option<RunnerInfo> {
        let (probed, _) = self.probed.as_ref()?;
        let mut info = probed.clone();
        if let Some(mark) = &self.auth_failed {
            info.login = LoginStatus::LoggedOut;
            let refused = format!(
                "claude refused fleetd's login: {}. Fix: {LOGIN_FIX}",
                mark.message.trim_end_matches('.')
            );
            info.problem = Some(match info.problem.take() {
                Some(other) if !other.contains(LOGIN_FIX) => format!("{refused} {other}"),
                _ => refused,
            });
        }
        Some(info)
    }

    /// Whether a `runner_info` call probes rather than answering from the last probe: when there is no answer yet,
    /// the scheduled probe is due, or the runner is unusable and was last probed at least [`RECHECK_AFTER`] ago.
    pub fn recheck_due(&self, now: Instant) -> bool {
        let Some((_, at)) = &self.probed else {
            return true;
        };
        let age = now.saturating_duration_since(*at);
        age >= PROBE_EVERY || (age >= RECHECK_AFTER && !self.info().is_some_and(|i| usable(&i)))
    }

    /// How long until the scheduled probe: zero before the first, then [`PROBE_EVERY`] after the last probe of any
    /// kind.
    pub fn until_scheduled(&self, now: Instant) -> Duration {
        self.probed.as_ref().map_or(Duration::ZERO, |(_, at)| {
            PROBE_EVERY.saturating_sub(now.saturating_duration_since(*at))
        })
    }

    /// Records a probe, with the login inputs as they were for it.
    pub fn probed(&mut self, info: RunnerInfo, login: u64, now: Instant) {
        if info.login == LoginStatus::LoggedIn
            && self.auth_failed.as_ref().is_some_and(|mark| {
                mark.login != login || now.saturating_duration_since(mark.at) >= PROBE_EVERY
            })
        {
            self.auth_failed = None;
        }
        self.probed = Some((info, now));
    }

    /// A run failed Auth with `message`, while the login inputs were `login`.
    pub fn auth_failed(&mut self, message: &str, login: u64, now: Instant) {
        self.auth_failed = Some(AuthMark {
            login,
            at: now,
            message: message.lines().next().unwrap_or(message).to_owned(),
        });
    }

    /// A run completed, so the login works.
    pub fn run_completed(&mut self) {
        self.auth_failed = None;
    }
}

fn usable(info: &RunnerInfo) -> bool {
    info.version_ok && info.login == LoginStatus::LoggedIn && info.conformance_ok != Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::sessions::RunnerKind;

    fn info(login: LoginStatus) -> RunnerInfo {
        RunnerInfo {
            runner: RunnerKind::Claude,
            version: Some("2.1.302 (Claude Code)".into()),
            supported: ">=2.1.300, <2.2.0".into(),
            version_ok: true,
            login,
            login_kind: Some("subscription".into()),
            conformance_ok: Some(true),
            problem: None,
        }
    }

    #[test]
    fn probes_run_at_start_every_six_hours_and_on_demand_only_while_unusable() {
        let t0 = Instant::now();
        let mut health = Health::default();
        assert!(health.recheck_due(t0));
        assert_eq!(health.until_scheduled(t0), Duration::ZERO);

        health.probed(info(LoginStatus::LoggedIn), 1, t0);
        let hour = t0 + Duration::from_secs(3600);
        // A healthy runner answers from the last probe however often the hub asks.
        assert!(!health.recheck_due(hour));
        assert_eq!(
            health.until_scheduled(hour),
            PROBE_EVERY - Duration::from_secs(3600)
        );
        assert_eq!(health.until_scheduled(t0 + PROBE_EVERY), Duration::ZERO);
        assert!(health.recheck_due(t0 + PROBE_EVERY));

        // An unusable one is re-checked on demand, but not more often than RECHECK_AFTER.
        health.probed(info(LoginStatus::LoggedOut), 1, t0);
        assert!(!health.recheck_due(t0 + Duration::from_secs(5)));
        assert!(health.recheck_due(t0 + RECHECK_AFTER));
        let mut drifted = info(LoginStatus::LoggedIn);
        drifted.conformance_ok = Some(false);
        health.probed(drifted, 1, t0);
        assert!(health.recheck_due(t0 + RECHECK_AFTER));
    }

    #[test]
    fn an_auth_failure_logs_out_until_evidence_says_the_login_works() {
        let t0 = Instant::now();
        let mut health = Health::default();
        // Before any probe there is nothing to report, mark or not.
        health.auth_failed("Not logged in · Please run /login", 1, t0);
        assert_eq!(health.info(), None);
        health.probed(info(LoginStatus::LoggedIn), 1, t0);
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedOut);

        health.auth_failed(
            "Failed to authenticate. API Error: 401 OAuth token has expired.\nmore",
            1,
            t0,
        );
        let shown = health.info().unwrap();
        assert_eq!(shown.login, LoginStatus::LoggedOut);
        assert_eq!(
            shown.problem,
            Some(format!(
                "claude refused fleetd's login: Failed to authenticate. API Error: 401 OAuth token has expired. \
                 Fix: {LOGIN_FIX}"
            ))
        );
        // Logged out is unusable, so the hub's next call re-checks soon.
        assert!(health.recheck_due(t0 + RECHECK_AFTER));

        // The same credential probing as logged in again proves nothing.
        let later = t0 + RECHECK_AFTER;
        health.probed(info(LoginStatus::LoggedIn), 1, later);
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedOut);
        // A probe that finds no login at all keeps the mark.
        health.probed(info(LoginStatus::LoggedOut), 2, later);
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedOut);
        // After `claude auth login` the inputs differ and the probe sees a login: cleared.
        health.probed(info(LoginStatus::LoggedIn), 3, later);
        assert_eq!(health.info().unwrap(), info(LoginStatus::LoggedIn));

        // A keychain login changes no file: a probe once the mark is PROBE_EVERY old clears it.
        health.auth_failed("Not logged in · Please run /login", 3, t0);
        health.probed(info(LoginStatus::LoggedIn), 3, later);
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedOut);
        health.probed(info(LoginStatus::LoggedIn), 3, t0 + PROBE_EVERY);
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedIn);

        // So does a run that completed.
        health.auth_failed("Not logged in · Please run /login", 3, t0);
        health.run_completed();
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedIn);
    }
}
