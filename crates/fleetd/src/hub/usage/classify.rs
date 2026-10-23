//! Usage limits from what the node reports about a failed run: its failure class and reset time. The node decides
//! the class (`node::runner::failure`); this module only maps it, for the executor to tell a limit from a failure
//! and the usage layer to park and pace. Pure. fleetd never asks a usage API.
use crate::hub::store::{iso_ms, parse_ms};
use crate::node::runner::failure::gateway_model;
use fleetd_contracts::events::{HubEvent, HubEventType};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub use crate::node::runner::failure::{FALLBACK_RATE_LIMIT_MS, FALLBACK_USAGE_LIMIT_MS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageClass {
    UsageLimit,
    RateLimit,
    PoolExhausted,
}

impl UsageClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UsageLimit => "usage_limit",
            Self::RateLimit => "rate_limit",
            Self::PoolExhausted => "pool_exhausted",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LimitInput<'a> {
    /// The node's failure class (`usage_limit`, `rate_limit`, `pool_exhausted`, `other`, ...).
    pub error_class: Option<&'a str>,
    pub message: &'a str,
    /// The node's reset time for the limit.
    pub reset_at: Option<&'a str>,
    /// When the run failed; fallback resets count from here.
    pub at: &'a str,
    pub model: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limit {
    pub class: UsageClass,
    /// Absent for pool_exhausted, which waits for usage_resume.
    pub resume_at: Option<String>,
    pub model: Option<String>,
}

/// The limit behind a failure, or None when the node classed it an ordinary failure. A reset that isn't after the
/// failure falls back to the class's default.
pub fn classify_limit(input: &LimitInput) -> Option<Limit> {
    let model = input.model.filter(|m| !m.is_empty()).map(str::to_owned);
    let (class, fallback_ms) = match input.error_class? {
        "pool_exhausted" => {
            return Some(Limit {
                class: UsageClass::PoolExhausted,
                resume_at: None,
                model: gateway_model(input.message).or(model),
            });
        }
        "usage_limit" => (UsageClass::UsageLimit, FALLBACK_USAGE_LIMIT_MS),
        "rate_limit" => (UsageClass::RateLimit, FALLBACK_RATE_LIMIT_MS),
        _ => return None,
    };
    let at_ms = parse_ms(input.at).unwrap_or(0);
    let reset = input.reset_at.and_then(parse_ms).filter(|ms| *ms > at_ms);
    Some(Limit {
        class,
        resume_at: Some(iso_ms(reset.unwrap_or(at_ms + fallback_ms))),
        model,
    })
}

/// The event data fields the executor adds to thread.usage_limited.
pub fn limit_data(limit: &Limit) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert("usageClass".into(), json!(limit.class.as_str()));
    if let Some(r) = &limit.resume_at {
        data.insert("resumeAt".into(), json!(r));
    }
    if let Some(m) = &limit.model {
        data.insert("model".into(), json!(m));
    }
    data
}

fn str_at<'a>(data: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut v = data;
    for key in path {
        v = v.get(key)?;
    }
    v.as_str()
}

/// A thread.usage_limited event's limit: what the executor stamped on it, else classified again from its error.
pub fn limit_of_event(event: &HubEvent) -> Option<Limit> {
    if event.r#type != HubEventType::ThreadUsageLimited {
        return None;
    }
    let data = event.data.clone().unwrap_or(Value::Null);
    if let Some(cls) = data
        .get("usageClass")
        .and_then(|v| serde_json::from_value::<UsageClass>(v.clone()).ok())
    {
        return Some(Limit {
            class: cls,
            resume_at: str_at(&data, &["resumeAt"]).map(str::to_string),
            model: str_at(&data, &["model"]).map(str::to_string),
        });
    }
    // Events from before M4 carry no usageClass, and were all usage limits.
    classify_limit(&LimitInput {
        error_class: Some("usage_limit"),
        reset_at: str_at(&data, &["usageLimitResetAt"]),
        at: event.at.as_str(),
        ..Default::default()
    })
}

/// What a task or lead record shows while parked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageParked {
    pub class: UsageClass,
    pub since: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_at: Option<String>,
}

pub fn parked_of(event: &HubEvent) -> Option<UsageParked> {
    let limit = limit_of_event(event)?;
    Some(UsageParked {
        class: limit.class,
        since: event.at.to_string(),
        resume_at: limit.resume_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-10-17T10:00:00.000Z";
    fn at(ms: i64) -> String {
        iso_ms(parse_ms(AT).unwrap() + ms)
    }
    fn input(class: &'static str, message: &'static str) -> LimitInput<'static> {
        LimitInput {
            error_class: Some(class),
            message,
            at: AT,
            ..Default::default()
        }
    }
    fn limit(class: UsageClass, resume_at: Option<String>, model: Option<&str>) -> Option<Limit> {
        Some(Limit {
            class,
            resume_at,
            model: model.map(str::to_string),
        })
    }

    #[test]
    fn the_nodes_class_and_reset_decide_and_a_pool_names_the_gateways_model() {
        let usage = LimitInput {
            reset_at: Some("2026-10-20T09:00:00.000Z"),
            ..input(
                "usage_limit",
                "Claude usage limit reached. Send the message again once the limit resets.",
            )
        };
        assert_eq!(
            classify_limit(&usage),
            limit(
                UsageClass::UsageLimit,
                Some("2026-10-20T09:00:00.000Z".into()),
                None
            )
        );
        let pool = LimitInput {
            model: Some("claude-opus-5-5"),
            ..input(
                "pool_exhausted",
                r#"API Error: 503 {"error":{"message":"no auth available","code":"auth_unavailable"}}"#,
            )
        };
        assert_eq!(
            classify_limit(&pool),
            limit(UsageClass::PoolExhausted, None, Some("claude-opus-5-5"))
        );
        let named = LimitInput {
            model: Some("opus"),
            ..input(
                "pool_exhausted",
                "API Error: 400 unknown provider for model claude-opus-5-5",
            )
        };
        assert_eq!(
            classify_limit(&named),
            limit(UsageClass::PoolExhausted, None, Some("claude-opus-5-5"))
        );
        // A rate limit's text in a failure the node classed otherwise is the node's call, not a limit.
        assert_eq!(classify_limit(&input("auth", "rate limit")), None);
    }

    #[test]
    fn ignores_a_reported_reset_that_is_not_after_the_failure() {
        let before = at(-1000);
        let i = LimitInput {
            reset_at: Some(&before),
            ..input("usage_limit", "Claude usage limit reached.")
        };
        assert_eq!(
            classify_limit(&i),
            limit(
                UsageClass::UsageLimit,
                Some(at(FALLBACK_USAGE_LIMIT_MS)),
                None
            )
        );
    }
}
