//! What usage_status reads from a machine: how its Claude runner is logged in. It comes from the node's `runner_info`,
//! which names the login kind and never carries a credential.
//! The executor implements [`UsageSource`] over the node link.
use super::ports::BoxFut;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginKind {
    Subscription,
    ApiKey,
    CustomBaseUrl,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageReading {
    pub login: LoginKind,
    /// Where a probe trace file could be read; the native runner keeps none, so always None.
    pub logs_dir: Option<String>,
    /// Whether that directory is on the hub's machine; always false with the native runner.
    pub local: bool,
}

/// Fails (with the executor's message) when the machine is offline.
pub trait UsageSource: Send + Sync {
    fn read(&self, machine_id: &str) -> BoxFut<'_, Result<UsageReading, String>>;
}

/// `RunnerInfo.login_kind`: "subscription", "api_key", "token" (an `ANTHROPIC_AUTH_TOKEN` gateway, which always
/// comes with its own base URL) or "none".
pub fn login_kind_of(runner_login_kind: Option<&str>) -> LoginKind {
    match runner_login_kind {
        Some("subscription") => LoginKind::Subscription,
        Some("api_key") => LoginKind::ApiKey,
        Some("token") => LoginKind::CustomBaseUrl,
        _ => LoginKind::Unknown,
    }
}
