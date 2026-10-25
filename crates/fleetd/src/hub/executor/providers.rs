//! The runner a machine offers, and what to do when it can't take sessions. The words and commands come from the
//! runner's guide, so nothing here knows one runner from another.
use fleetd_contracts::sessions::{LoginStatus, RunnerInfo};

use crate::node::runner::guide;

/// Why the machine's runner can't take sessions, or None when it can (logged in). Its version never decides.
pub fn runner_problem(info: &RunnerInfo) -> Option<String> {
    if info.login == LoginStatus::LoggedIn {
        return None;
    }
    Some(info.problem.clone().unwrap_or_else(|| {
        format!(
            "{} is not logged in on this machine",
            guide(info.runner).name()
        )
    }))
}

/// What to run on the machine for a runner problem: a login, or (the runner missing or unreadable) the tested one.
pub fn runner_fix(info: &RunnerInfo, machine_id: &str) -> String {
    let guide = guide(info.runner);
    if info.login == LoginStatus::LoggedOut {
        format!(
            "On {machine_id}: {}.",
            guide.login_fix(info.proxy.is_some())
        )
    } else {
        format!("On {machine_id}: {}.", guide.install_tested())
    }
}
