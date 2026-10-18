use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::events::HubEventType;
use crate::ids::{EventSeq, MachineId, Timestamp};
use crate::prim::NonEmpty;
use crate::{brand, literal};

/// WHATWG URL parsing.
pub fn is_http_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

brand!(
    /// Absolute http(s) URL; `file:` and every other scheme are refused.
    WebhookUrl,
    name = "WebhookUrl",
    check = is_http_url,
    expected = "an absolute http:// or https:// URL"
);

literal!(
    /// `"*"`: every event type or machine.
    Star = "*"
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SubscriptionTypes {
    All(Star),
    Only(Vec<HubEventType>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SubscriptionMachines {
    All(Star),
    Only(Vec<MachineId>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionState {
    Active,
    Disabled,
}

literal!(WebhookKind = "webhook");

/// A webhook push target. Its signing secret is shown once by subscription_set and never returned again.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub subscription_id: NonEmpty,
    pub kind: WebhookKind,
    pub url: WebhookUrl,
    pub types: SubscriptionTypes,
    pub machines: SubscriptionMachines,
    /// keyId of the agent key that created it.
    pub created_by: String,
    pub state: SubscriptionState,
    pub last_delivered_seq: Option<EventSeq>,
    /// When deliveries started failing; absent while healthy.
    pub failing_since: Option<Timestamp>,
}

impl Default for SubscriptionTypes {
    fn default() -> Self {
        Self::All(Star::Value)
    }
}

impl Default for SubscriptionMachines {
    fn default() -> Self {
        Self::All(Star::Value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absolute_http_urls() {
        assert!(is_http_url("https://example.com/hook"));
        assert!(is_http_url("http://127.0.0.1:4710/x"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("/relative"));
        assert!(!is_http_url("example.com"));
    }
}
