//! Usage-limit classification from what T3 reports about a failed thread: its failure class and reset time, plus the
//! error text the `claude` CLI or a proxy in front of it produced. Pure; the executor uses it to tell a limit from a
//! failure, and the usage layer to park and pace. fleetd never asks a usage API.
//! The classifier itself is `executor::limit`'s; this module adds what the usage layer reads off the event log.
use super::ports::HubEvent;
use super::time::{iso, parse_ms};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::hub::executor::limit::{Limit, LimitInput, UsageClass, classify_limit, limit_data};

/// When nothing says when the limit resets.
pub const FALLBACK_USAGE_LIMIT_MS: i64 = 60 * 60_000;
pub const FALLBACK_RATE_LIMIT_MS: i64 = 5 * 60_000;

fn plus(at: &str, ms: i64) -> String {
    iso(parse_ms(at).unwrap_or(0) + ms)
}

/// A failed thread's limit, read off the fields of its summary (`limitOfSummary`).
pub fn limit_of_failure(
    status: &str,
    last_error: Option<(&str, &str)>,
    last_progress_at: &str,
    usage_limit_reset_at: Option<&str>,
    model: Option<&str>,
) -> Option<Limit> {
    let (class, message) = last_error.filter(|_| status == "failed")?;
    classify_limit(&LimitInput {
        error_class: Some(class),
        message,
        reset_at: usage_limit_reset_at,
        at: last_progress_at,
        model,
    })
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
    if event.kind != "thread.usage_limited" {
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
    // Events from before M4 carry only T3's class and reset; T3 marked them usage_limit.
    classify_limit(&LimitInput {
        error_class: Some(str_at(&data, &["error", "class"]).unwrap_or("usage_limit")),
        message: str_at(&data, &["error", "message"]).unwrap_or(""),
        reset_at: str_at(&data, &["usageLimitResetAt"]),
        at: &event.at,
        model: None,
    })
    .or_else(|| {
        Some(Limit {
            class: UsageClass::UsageLimit,
            resume_at: Some(plus(&event.at, FALLBACK_USAGE_LIMIT_MS)),
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
        since: event.at.clone(),
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

    // Error text shapes as T3 stores them in a thread's lastError: T3's own Claude adapter messages and the CLI's or
    // CLIProxyAPI's raw text it passes through. No live limit was hit to get them.
    #[test]
    fn classifies_the_fixture_table() {
        use UsageClass::*;
        let fixtures: Vec<(&str, LimitInput, Option<Limit>)> = vec![
            (
                "T3 usage_limit with its reset",
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
                "T3 blocking_limit without a reset",
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
                "T3 429",
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
