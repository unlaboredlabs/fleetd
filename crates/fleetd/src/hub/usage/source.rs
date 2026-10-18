//! What usage_status reads from a machine's T3: the fleetd Claude instance's login kind and where T3 writes its trace.
//! Both come from T3's `server.getConfig`; credentials and env var values are never read, only the names.
//! The executor implements [`UsageSource`] over its T3 sessions.
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
    /// T3's logs directory, which holds `server.trace.ndjson`.
    pub logs_dir: Option<String>,
    /// T3 runs on the hub's own machine (a loopback URL), so its logs directory is the hub's to read.
    pub local: bool,
}

/// Fails (with the executor's message) when the machine is offline.
pub trait UsageSource: Send + Sync {
    fn read(&self, machine_id: &str) -> BoxFut<'_, Result<UsageReading, String>>;
}

const BASE_URL_VARS: &[&str] = &["ANTHROPIC_BASE_URL"];
const API_KEY_VARS: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/// A custom base URL wins over a key, which wins over a signed-in subscription. `auth_type` and `auth_status` are
/// T3's `ServerProvider.auth` fields; `env_names` the instance config's environment variable names.
pub fn login_kind_of(
    auth_type: Option<&str>,
    auth_status: Option<&str>,
    env_names: &[&str],
) -> LoginKind {
    if BASE_URL_VARS.iter().any(|n| env_names.contains(n)) {
        return LoginKind::CustomBaseUrl;
    }
    if auth_type == Some("apiKey") || API_KEY_VARS.iter().any(|n| env_names.contains(n)) {
        return LoginKind::ApiKey;
    }
    if auth_status == Some("authenticated") {
        return LoginKind::Subscription;
    }
    LoginKind::Unknown
}

pub fn is_loopback_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => match u.host_str() {
            Some(h) => h == "localhost" || h == "[::1]" || h == "::1" || h.starts_with("127."),
            None => false,
        },
        Err(_) => false,
    }
}
