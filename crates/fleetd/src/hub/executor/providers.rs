//! The runner a machine offers, and which one a launch goes to. Today the node runs only Claude, through the
//! `claude` CLI; a model any other runner would serve is refused until that runner has an adapter.
use fleetd_contracts::sessions::{LoginStatus, RunnerInfo, RunnerKind};

/// Why the machine's runner can't take sessions, or None when it can (logged in). Its version never decides.
pub fn runner_problem(info: &RunnerInfo) -> Option<String> {
    if info.login == LoginStatus::LoggedIn {
        return None;
    }
    Some(
        info.problem
            .clone()
            .unwrap_or_else(|| "claude is not logged in on this machine".into()),
    )
}

/// What to run on the machine for a runner problem: a login, or (claude missing or unreadable) the tested claude.
pub fn runner_fix(info: &RunnerInfo, machine_id: &str) -> String {
    if info.login == LoginStatus::LoggedOut {
        format!(
            "On {machine_id}: {}.",
            crate::node::runner::failure::login_fix(info.proxy.is_some())
        )
    } else {
        format!(
            "On {machine_id}: curl -fsSL https://claude.ai/install.sh | bash -s {}.",
            crate::node::runner::version::TESTED
        )
    }
}

/// The runner a model runs on, or why none does.
pub fn route_model(model: &str) -> Result<RunnerKind, String> {
    if model.starts_with("claude") {
        Ok(RunnerKind::Claude)
    } else {
        Err(format!(
            "{model} is not a Claude model, and fleetd runs only Claude on its nodes for now"
        ))
    }
}
