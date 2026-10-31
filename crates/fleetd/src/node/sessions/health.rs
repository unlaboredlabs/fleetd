//! What the node says about its runner (`runner_info`): the last zero-cost probe, corrected by what real runs
//! showed since.
//!
//! A run that fails Auth marks the login logged out at once, so the hub shows the `claude auth login` fix without
//! waiting for a probe. Any later probe that reports logged in clears the mark. That includes a login in the macOS
//! keychain, which changes no file the node could watch, and the probe makes no model call. A probe that started
//! before the failure says nothing about it. A usable runner is probed once, at start. While it is unusable the node
//! re-probes every [`RECHECK_AFTER`] and pushes each change, so the hub's cached state, and with it its launch gate,
//! flips back within seconds of the fix.
use std::time::Duration;

use tokio::time::Instant;

use fleetd_contracts::sessions::{LoginStatus, RunnerInfo};

use crate::node::runner::claude::failure::login_fix;

/// How often a runner that can't run sessions is re-probed.
pub const RECHECK_AFTER: Duration = Duration::from_secs(15);

struct AuthMark {
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
            let fix = login_fix(info.proxy.is_some());
            let refused = format!(
                "claude refused its login: {}. Fix: {fix}",
                mark.message.trim_end_matches('.')
            );
            info.problem = Some(match info.problem.take() {
                Some(other) if !other.contains(fix) => format!("{refused} {other}"),
                _ => refused,
            });
        }
        Some(info)
    }

    /// How long until the next probe: none yet, then [`RECHECK_AFTER`] after the last one while the runner is
    /// unusable. `None` while it is usable: a `runner_info` call answers from the last probe.
    pub fn next_probe_in(&self, now: Instant) -> Option<Duration> {
        let Some((_, at)) = &self.probed else {
            return Some(Duration::ZERO);
        };
        let usable = self
            .info()
            .is_some_and(|i| i.login == LoginStatus::LoggedIn && i.conformance_ok != Some(false));
        (!usable).then(|| RECHECK_AFTER.saturating_sub(now.saturating_duration_since(*at)))
    }

    /// Records a probe that started at `started`.
    pub fn probed(&mut self, info: RunnerInfo, started: Instant) {
        if info.login == LoginStatus::LoggedIn
            && self
                .auth_failed
                .as_ref()
                .is_some_and(|mark| started >= mark.at)
        {
            self.auth_failed = None;
        }
        self.probed = Some((info, started));
    }

    /// A run failed Auth with `message`.
    pub fn auth_failed(&mut self, message: &str, now: Instant) {
        self.auth_failed = Some(AuthMark {
            at: now,
            message: message.lines().next().unwrap_or(message).to_owned(),
        });
    }

    /// A run completed, so the login works.
    pub fn run_completed(&mut self) {
        self.auth_failed = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::sessions::RunnerKind;

    fn info(login: LoginStatus) -> RunnerInfo {
        RunnerInfo {
            runner: RunnerKind::Claude,
            version: Some("2.1.314 (Claude Code)".into()),
            supported: ">=2.1.300, <2.2.0".into(),
            version_ok: true,
            login,
            login_kind: Some("subscription".into()),
            conformance_ok: Some(true),
            problem: None,
            login_label: None,
            proxy: None,
            proxy_source: None,
            config_dir: None,
            self_update: None,
            sandbox: None,
            account_overrides: None,
        }
    }

    #[test]
    fn a_usable_runner_is_probed_once_and_an_unusable_one_every_fifteen_seconds() {
        let t0 = Instant::now();
        let mut health = Health::default();
        assert_eq!(health.next_probe_in(t0), Some(Duration::ZERO));

        health.probed(info(LoginStatus::LoggedIn), t0);
        assert_eq!(health.next_probe_in(t0 + Duration::from_secs(86_400)), None);
        // Outside the tested range is only a warning.
        health.probed(
            RunnerInfo {
                version_ok: false,
                ..info(LoginStatus::LoggedIn)
            },
            t0,
        );
        assert_eq!(health.next_probe_in(t0), None);

        for unusable in [
            info(LoginStatus::LoggedOut),
            RunnerInfo {
                conformance_ok: Some(false),
                ..info(LoginStatus::LoggedIn)
            },
        ] {
            health.probed(unusable, t0);
            assert_eq!(health.next_probe_in(t0), Some(RECHECK_AFTER));
            assert_eq!(
                health.next_probe_in(t0 + RECHECK_AFTER),
                Some(Duration::ZERO)
            );
        }

        // An Auth failure makes a usable runner unusable without a probe: re-checked RECHECK_AFTER after the last one.
        let hour = Duration::from_secs(3600);
        health.probed(info(LoginStatus::LoggedIn), t0);
        health.auth_failed("Not logged in · Please run /login", t0 + hour);
        assert_eq!(health.next_probe_in(t0 + hour), Some(Duration::ZERO));
        // The fix lands; the next probe sees it and no further one is scheduled.
        health.probed(info(LoginStatus::LoggedIn), t0 + hour);
        assert_eq!(health.next_probe_in(t0 + hour), None);
    }

    #[test]
    fn an_auth_failure_logs_out_until_a_later_probe_or_run_says_the_login_works() {
        let t0 = Instant::now();
        let mut health = Health::default();
        // Before any probe there is nothing to report.
        assert_eq!(health.info(), None);
        health.probed(info(LoginStatus::LoggedIn), t0);

        let failed = t0 + Duration::from_secs(60);
        health.auth_failed(
            "Failed to authenticate. API Error: 401 OAuth token has expired.\nmore",
            failed,
        );
        let shown = health.info().unwrap();
        assert_eq!(shown.login, LoginStatus::LoggedOut);
        assert_eq!(
            shown.problem,
            Some(format!(
                "claude refused its login: Failed to authenticate. API Error: 401 OAuth token has expired. \
                 Fix: {}",
                login_fix(false)
            ))
        );
        // Logged out is unusable and the last probe is older than RECHECK_AFTER: probed again now.
        assert_eq!(health.next_probe_in(failed), Some(Duration::ZERO));

        // A probe that started before the failure, finishing after it, says nothing about it.
        health.probed(info(LoginStatus::LoggedIn), failed - Duration::from_secs(1));
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedOut);
        // One that finds no login keeps it logged out.
        health.probed(info(LoginStatus::LoggedOut), failed);
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedOut);
        // `claude auth login` into the macOS keychain changes no file the node sees: the next probe clears it.
        health.probed(info(LoginStatus::LoggedIn), failed + RECHECK_AFTER);
        assert_eq!(health.info().unwrap(), info(LoginStatus::LoggedIn));

        // So does a run that completed.
        health.auth_failed("Not logged in · Please run /login", failed);
        health.run_completed();
        assert_eq!(health.info().unwrap().login, LoginStatus::LoggedIn);
    }
}
