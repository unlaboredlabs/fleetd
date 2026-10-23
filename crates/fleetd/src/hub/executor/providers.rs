//! The runners a machine offers, and which one a launch goes to. Today the node runs only Claude, through the
//! `claude` CLI; a model any other runner would serve is refused until that runner has an adapter. The instance list
//! stays so reviews can pick a Codex reviewer again once a node offers one.
use fleetd_contracts::sessions::{LoginStatus, RunnerInfo, RunnerKind};

pub const FLEETD_INSTANCE: &str = "fleetd";
pub const CODEX_DRIVER: &str = "codex";
pub const CLAUDE_DRIVER: &str = "claude";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderInstance {
    pub instance_id: String,
    pub driver: String,
    /// The runner is installed and logged in.
    pub usable: bool,
    /// Model slugs and their aliases.
    pub models: Vec<String>,
    pub default_model: Option<String>,
}

/// The machine's Claude runner as a provider instance.
pub fn to_instance(info: &RunnerInfo) -> ProviderInstance {
    ProviderInstance {
        instance_id: FLEETD_INSTANCE.into(),
        driver: CLAUDE_DRIVER.into(),
        usable: info.login == LoginStatus::LoggedIn,
        models: vec![],
        default_model: None,
    }
}

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

/// A usable Codex instance fleetd set up itself (its id starts with "fleetd").
pub fn is_fleetd_codex(i: &ProviderInstance) -> bool {
    i.driver == CODEX_DRIVER && i.usable && i.instance_id.starts_with(FLEETD_INSTANCE)
}

/// The first fleetd Codex instance with a model to run, if the machine has one.
pub fn codex_instance(instances: &[ProviderInstance]) -> Option<&ProviderInstance> {
    instances
        .iter()
        .find(|i| is_fleetd_codex(i) && i.default_model.is_some())
}

/// Usable Codex instances fleetd does not use, because their ids do not start with "fleetd".
pub fn other_codex(instances: &[ProviderInstance]) -> Vec<String> {
    instances
        .iter()
        .filter(|i| i.driver == CODEX_DRIVER && i.usable && !is_fleetd_codex(i))
        .map(|i| i.instance_id.clone())
        .collect()
}
