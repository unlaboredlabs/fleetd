//! Usage-limit classification from what the node reports about a failed run: its failure class and reset time, plus
//! the error text the `claude` CLI or a proxy in front of it produced. Pure; the executor uses it to tell a limit from
//! a failure, and the usage layer to park and pace. fleetd never asks a usage API.
//! The text rules are the node's (`node::runner::failure::classify_text`); this module puts the node's own class
//! first and adds what the usage layer reads off the event log.
use super::time::{iso, parse_ms};
use crate::node::runner::failure::classify_text;
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::sessions::FailureClass;
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

/// The limit behind a failure, or None when it is an ordinary failure. A gateway's text names its pool first, then
/// the node's class (pool or rate limit) decides, then the text rules (where `usage_limit` counts as the usage hint).
pub fn classify_limit(input: &LimitInput) -> Option<Limit> {
    let at_ms = parse_ms(input.at).unwrap_or(0);
    let model = input.model.filter(|m| !m.is_empty()).map(str::to_owned);
    let found = classify_text(
        input.message,
        input.error_class == Some("usage_limit"),
        input.reset_at.and_then(parse_ms),
        at_ms,
    );
    let pool = |found_model: Option<String>| Limit {
        class: UsageClass::PoolExhausted,
        resume_at: None,
        model: found_model.or(model.clone()),
    };
    match (input.error_class, found) {
        (_, Some(f)) if f.class == FailureClass::PoolExhausted => Some(pool(f.model)),
        (Some("pool_exhausted"), _) => Some(pool(None)),
        (Some("rate_limit"), found) => {
            let reset = found
                .and_then(|f| f.reset_ms)
                .or_else(|| input.reset_at.and_then(parse_ms).filter(|ms| *ms > at_ms));
            Some(Limit {
                class: UsageClass::RateLimit,
                resume_at: Some(iso(reset.unwrap_or(at_ms + FALLBACK_RATE_LIMIT_MS))),
                model,
            })
        }
        (_, Some(f)) => Some(Limit {
            class: if f.class == FailureClass::RateLimit {
                UsageClass::RateLimit
            } else {
                UsageClass::UsageLimit
            },
            resume_at: f.reset_ms.map(iso),
            model,
        }),
        (_, None) => None,
    }
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

fn plus(at: &str, ms: i64) -> String {
    iso(parse_ms(at).unwrap_or(0) + ms)
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
    // Events from before M4 carry only a class and reset, and were all marked usage_limit.
    classify_limit(&LimitInput {
        error_class: Some(str_at(&data, &["error", "class"]).unwrap_or("usage_limit")),
        message: str_at(&data, &["error", "message"]).unwrap_or(""),
        reset_at: str_at(&data, &["usageLimitResetAt"]),
        at: event.at.as_str(),
        model: None,
    })
    .or_else(|| {
        Some(Limit {
            class: UsageClass::UsageLimit,
            resume_at: Some(plus(event.at.as_str(), FALLBACK_USAGE_LIMIT_MS)),
            model: None,
        })
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
        plus(AT, ms)
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

    // Error text shapes as stored in a thread's lastError: older adapter messages and the CLI's or CLIProxyAPI's raw
    // text. No live limit was hit to get them.
    #[test]
    fn classifies_the_fixture_table() {
        use UsageClass::*;
        let fixtures: Vec<(&str, LimitInput, Option<Limit>)> = vec![
            (
                "usage_limit with its reset",
                LimitInput {
                    reset_at: Some("2026-10-20T09:00:00.000Z"),
                    ..input(
                        "usage_limit",
                        "Claude usage limit reached. Send the message again once the limit resets.",
                    )
                },
                limit(UsageLimit, Some("2026-10-20T09:00:00.000Z".into()), None),
            ),
            (
                "blocking_limit without a reset",
                input(
                    "usage_limit",
                    "Claude stopped: a usage limit blocked the request.",
                ),
                limit(UsageLimit, Some(at(FALLBACK_USAGE_LIMIT_MS)), None),
            ),
            (
                "the CLI's usage limit with an epoch reset",
                input("provider_error", "Claude AI usage limit reached|1792483200"),
                limit(UsageLimit, Some("2026-10-20T08:00:00.000Z".into()), None),
            ),
            (
                "a 429",
                input(
                    "usage_limit",
                    "Claude API rate limit reached. Try again later.",
                ),
                limit(RateLimit, Some(at(FALLBACK_RATE_LIMIT_MS)), None),
            ),
            (
                "a raw API 429",
                input(
                    "provider_error",
                    r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#,
                ),
                limit(RateLimit, Some(at(FALLBACK_RATE_LIMIT_MS)), None),
            ),
            (
                "a proxy 503 wrapping a 429, with its wait",
                input(
                    "provider_error",
                    r#"API Error: 503 [claude] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}} (reset after 1h30m)"#,
                ),
                limit(RateLimit, Some(at(90 * 60_000)), None),
            ),
            (
                "CLIProxyAPI 400 unknown provider for model",
                LimitInput {
                    model: Some("claude-sonnet-5-5"),
                    ..input(
                        "provider_error",
                        r#"API Error: 400 {"error":{"message":"unknown provider for model claude-opus-5-5","type":"invalid_request_error","code":"model_not_found","param":"model"}}"#,
                    )
                },
                limit(PoolExhausted, None, Some("claude-opus-5-5")),
            ),
            (
                "CLIProxyAPI 503 no auth available",
                LimitInput {
                    model: Some("claude-opus-5-5"),
                    ..input(
                        "provider_error",
                        r#"API Error: 503 {"error":{"message":"no auth available","code":"auth_unavailable"}}"#,
                    )
                },
                limit(PoolExhausted, None, Some("claude-opus-5-5")),
            ),
            (
                "a proxy 503 no available account",
                input(
                    "provider_error",
                    "API Error: 503 no available account for claude-opus-5-5",
                ),
                limit(PoolExhausted, None, None),
            ),
            (
                "CLIProxyAPI model_cooldown with reset_seconds",
                input(
                    "provider_error",
                    r#"API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-5-5 are cooling down","model":"claude-opus-5-5","reset_time":"1h2m0s","reset_seconds":3720}}"#,
                ),
                limit(UsageLimit, Some(at(3_720_000)), None),
            ),
            (
                "overloaded",
                input(
                    "provider_error",
                    "Claude API is overloaded (529). Try again shortly.",
                ),
                None,
            ),
            (
                "context window",
                input(
                    "provider_error",
                    "Claude stopped: the prompt exceeds the model's context window.",
                ),
                None,
            ),
            (
                "transport",
                input("transport_error", "Claude API connection error."),
                None,
            ),
        ];
        for (name, input, expected) in fixtures {
            assert_eq!(classify_limit(&input), expected, "{name}");
        }
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
