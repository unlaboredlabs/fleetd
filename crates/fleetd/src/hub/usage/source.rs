//! What usage_status reads from a machine: how its Claude runner is logged in. It comes from the node's `runner_info`,
//! which names the login kind and never carries a credential.
//! `OpsPorts::read` (wire.rs) reads it over the node link.
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
