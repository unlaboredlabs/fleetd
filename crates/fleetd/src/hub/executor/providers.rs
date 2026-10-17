//! The provider instances a machine's T3 runs (its `server.getConfig` provider list), and which instance a launch
//! goes to. Every launch goes to the "fleetd" Claude instance, whose launch args deny T3's own spawn tools, except a
//! model only a usable fleetd Codex instance offers: that runs there, so L-tier reviews can get a Codex reviewer. A
//! Codex instance counts only when its id starts with "fleetd". TS spec: apps/hub/src/executor/ProviderList.ts.
use t3_wire::types::ServerProvider;

pub const FLEETD_INSTANCE: &str = "fleetd";
pub const CODEX_DRIVER: &str = "codex";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderInstance {
    pub instance_id: String,
    pub driver: String,
    /// Enabled, installed, not reported unavailable, in error or logged out.
    pub usable: bool,
    /// Model slugs and their aliases.
    pub models: Vec<String>,
    pub default_model: Option<String>,
}

/// One entry of T3's `server.getConfig` `providers`.
pub fn to_instance(p: &ServerProvider) -> ProviderInstance {
    let preferred = p
        .models
        .iter()
        .find(|m| m.is_default == Some(true))
        .or_else(|| p.models.iter().find(|m| m.is_legacy != Some(true)));
    ProviderInstance {
        instance_id: p.instance_id.clone(),
        driver: p.driver.clone(),
        usable: p.enabled
            && p.installed
            && p.availability.as_deref() != Some("unavailable")
            && p.status != "error"
            && p.status != "disabled"
            && p.auth.status != "unauthenticated",
        models: p.models.iter().flat_map(|m| std::iter::once(m.slug.clone()).chain(m.aliases.clone().unwrap_or_default())).collect(),
        default_model: preferred.map(|m| m.slug.clone()),
    }
}

/// A usable Codex instance fleetd set up itself (its id starts with "fleetd").
pub fn is_fleetd_codex(i: &ProviderInstance) -> bool {
    i.driver == CODEX_DRIVER && i.usable && i.instance_id.starts_with(FLEETD_INSTANCE)
}

/// The first fleetd Codex instance with a model to run, if the machine has one.
pub fn codex_instance(instances: &[ProviderInstance]) -> Option<&ProviderInstance> {
    instances.iter().find(|i| is_fleetd_codex(i) && i.default_model.is_some())
}

/// Usable Codex instances fleetd does not use, because their ids do not start with "fleetd".
pub fn other_codex(instances: &[ProviderInstance]) -> Vec<String> {
    instances
        .iter()
        .filter(|i| i.driver == CODEX_DRIVER && i.usable && !is_fleetd_codex(i))
        .map(|i| i.instance_id.clone())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub instance_id: String,
    pub driver: String,
}

/// Claude models never leave the fleetd instance; a model only a fleetd Codex instance lists runs on it.
pub fn route_model(instances: &[ProviderInstance], model: &str) -> Route {
    let fleetd = Route { instance_id: FLEETD_INSTANCE.into(), driver: "claudeAgent".into() };
    if instances.iter().any(|i| i.driver != CODEX_DRIVER && i.models.iter().any(|m| m == model)) {
        return fleetd;
    }
    match instances.iter().find(|i| is_fleetd_codex(i) && i.models.iter().any(|m| m == model)) {
        Some(codex) => Route { instance_id: codex.instance_id.clone(), driver: codex.driver.clone() },
        None => fleetd,
    }
}

/// T3's effort option for the driver. Codex calls it `reasoningEffort` and its top level `xhigh`.
pub fn effort_option(driver: &str, effort: &str) -> (&'static str, String) {
    if driver == CODEX_DRIVER {
        ("reasoningEffort", if effort == "max" { "xhigh".into() } else { effort.to_owned() })
    } else {
        ("effort", effort.to_owned())
    }
}
