//! Usage-limit classification from what T3 reports about a failed thread: its failure class and reset time, plus the
//! error text the `claude` CLI or a proxy in front of it produced. Pure; the executor uses it to tell a limit from a
//! failure, and the usage layer to park and pace. fleetd never asks a usage API. TS: apps/hub/src/usage/classify.ts.
use super::ports::HubEvent;
use super::time::{iso, parse_ms};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Default)]
pub struct LimitInput {
    /// T3's failure class (`usage_limit`, `provider_error`, ...).
    pub error_class: Option<String>,
    pub message: String,
    /// T3's `usageLimitResetAt`.
    pub reset_at: Option<String>,
    /// When the thread failed; fallback resets count from here.
    pub at: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limit {
    pub class: UsageClass,
    /// Absent for pool_exhausted, which waits for usage_resume.
    pub resume_at: Option<String>,
    pub model: Option<String>,
}

/// When nothing says when the limit resets.
pub const FALLBACK_USAGE_LIMIT_MS: i64 = 60 * 60_000;
pub const FALLBACK_RATE_LIMIT_MS: i64 = 5 * 60_000;

fn fallback_ms(cls: UsageClass) -> i64 {
    if cls == UsageClass::RateLimit { FALLBACK_RATE_LIMIT_MS } else { FALLBACK_USAGE_LIMIT_MS }
}

macro_rules! re {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).expect("valid regex"));
    };
}

// CLIProxyAPI: a model no enabled credential offers, or every credential signed out (research 04 §2.3).
re!(UNKNOWN_PROVIDER, r#"(?i)unknown provider for model\s+["']?([^\s"'\\,}]+)"#);
re!(NO_ACCOUNT, r"(?i)no available account|no auth available|auth_unavailable");
// CLIProxyAPI: every credential for the model is cooling down; it says when in reset_seconds.
re!(COOLDOWN, r"(?i)model_cooldown|are cooling down");
re!(RESET_SECONDS, r#""reset_seconds"\s*:\s*(\d+)"#);
re!(RATE, r"(?i)rate[ _-]?limit|\[429\]|\b(?:api error|status|error)\W{0,3}429\b");
re!(USAGE, r"(?i)usage limit|hit your (?:usage )?limit|(?:5-hour|weekly|session|opus) limit reached|out of extra usage");
// The CLI's "Claude AI usage limit reached|<epoch seconds>".
re!(PIPE_EPOCH, r"(?i)limit reached\|(\d{10})\b");
// A proxy's "(reset after 1h2m3s)".
re!(RESET_AFTER, r"(?i)reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?");

fn plus(at: &str, ms: i64) -> String {
    iso(parse_ms(at).unwrap_or(0) + ms)
}

/// The first reset that lies after the failure.
fn reset_of(input: &LimitInput, cls: UsageClass) -> String {
    let failed_ms = parse_ms(&input.at);
    let after = |text: Option<String>| -> Option<String> {
        let text = text?;
        match (parse_ms(&text), failed_ms) {
            (Some(t), Some(f)) if t > f => Some(text),
            _ => None,
        }
    };
    let num = |c: Option<regex::Match>| c.map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0));
    let epoch = PIPE_EPOCH.captures(&input.message).map(|c| iso(num(c.get(1)) * 1000));
    let seconds = RESET_SECONDS.captures(&input.message).map(|c| num(c.get(1)));
    let span_ms = RESET_AFTER
        .captures(&input.message)
        .map_or(0, |c| (num(c.get(1)) * 3600 + num(c.get(2)) * 60 + num(c.get(3))) * 1000);
    after(input.reset_at.clone())
        .or_else(|| after(epoch))
        .or_else(|| seconds.filter(|s| *s > 0).map(|s| plus(&input.at, s * 1000)))
        .or_else(|| (span_ms > 0).then(|| plus(&input.at, span_ms)))
        .unwrap_or_else(|| plus(&input.at, fallback_ms(cls)))
}

fn non_empty(model: &Option<String>) -> Option<String> {
    model.as_ref().filter(|m| !m.is_empty()).cloned()
}

/// The limit behind a failure, or `None` when it is an ordinary failure.
pub fn classify_limit(input: &LimitInput) -> Option<Limit> {
    let text = &input.message;
    if let Some(c) = UNKNOWN_PROVIDER.captures(text) {
        return Some(Limit { class: UsageClass::PoolExhausted, resume_at: None, model: Some(c[1].to_string()) });
    }
    if NO_ACCOUNT.is_match(text) {
        return Some(Limit { class: UsageClass::PoolExhausted, resume_at: None, model: non_empty(&input.model) });
    }
    if COOLDOWN.is_match(text) {
        let cls = UsageClass::UsageLimit;
        return Some(Limit { class: cls, resume_at: Some(reset_of(input, cls)), model: non_empty(&input.model) });
    }
    let cls = if RATE.is_match(text) {
        UsageClass::RateLimit
    } else if input.error_class.as_deref() == Some("usage_limit") || USAGE.is_match(text) {
        UsageClass::UsageLimit
    } else {
        return None;
    };
    Some(Limit { class: cls, resume_at: Some(reset_of(input, cls)), model: non_empty(&input.model) })
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
        error_class: Some(class.to_string()),
        message: message.to_string(),
        reset_at: usage_limit_reset_at.map(str::to_string),
        at: last_progress_at.to_string(),
        model: model.map(str::to_string),
    })
}

/// The event data fields the executor adds to thread.usage_limited.
pub fn limit_data(limit: &Limit) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("usageClass".into(), json!(limit.class));
    if let Some(r) = &limit.resume_at {
        out.insert("resumeAt".into(), json!(r));
    }
    if let Some(m) = &limit.model {
        out.insert("model".into(), json!(m));
    }
    out
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
    if let Some(cls) = data.get("usageClass").and_then(|v| serde_json::from_value::<UsageClass>(v.clone()).ok()) {
        return Some(Limit {
            class: cls,
            resume_at: str_at(&data, &["resumeAt"]).map(str::to_string),
            model: str_at(&data, &["model"]).map(str::to_string),
        });
    }
    // Events from before M4 carry only T3's class and reset; T3 marked them usage_limit.
    classify_limit(&LimitInput {
        error_class: Some(str_at(&data, &["error", "class"]).unwrap_or("usage_limit").to_string()),
        message: str_at(&data, &["error", "message"]).unwrap_or("").to_string(),
        reset_at: str_at(&data, &["usageLimitResetAt"]).map(str::to_string),
        at: event.at.clone(),
        model: None,
    })
    .or_else(|| Some(Limit { class: UsageClass::UsageLimit, resume_at: Some(plus(&event.at, FALLBACK_USAGE_LIMIT_MS)), model: None }))
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
    Some(UsageParked { class: limit.class, since: event.at.clone(), resume_at: limit.resume_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-10-17T10:00:00.000Z";
    fn at(ms: i64) -> String {
        plus(AT, ms)
    }
    fn input(class: &str, message: &str) -> LimitInput {
        LimitInput { error_class: Some(class.into()), message: message.into(), at: AT.into(), ..Default::default() }
    }
    fn limit(class: UsageClass, resume_at: Option<String>, model: Option<&str>) -> Option<Limit> {
        Some(Limit { class, resume_at, model: model.map(str::to_string) })
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
                    reset_at: Some("2026-10-20T09:00:00.000Z".into()),
                    ..input("usage_limit", "Claude usage limit reached. Send the message again once the limit resets.")
                },
                limit(UsageLimit, Some("2026-10-20T09:00:00.000Z".into()), None),
            ),
            (
                "T3 blocking_limit without a reset",
                input("usage_limit", "Claude stopped: a usage limit blocked the request."),
                limit(UsageLimit, Some(at(FALLBACK_USAGE_LIMIT_MS)), None),
            ),
            (
                "the CLI's usage limit with an epoch reset",
                input("provider_error", "Claude AI usage limit reached|1792483200"),
                limit(UsageLimit, Some("2026-10-20T08:00:00.000Z".into()), None),
            ),
            (
                "T3 429",
                input("usage_limit", "Claude API rate limit reached. Try again later."),
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
                    model: Some("claude-sonnet-5-5".into()),
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
                    model: Some("claude-opus-5-5".into()),
                    ..input("provider_error", r#"API Error: 503 {"error":{"message":"no auth available","code":"auth_unavailable"}}"#)
                },
                limit(PoolExhausted, None, Some("claude-opus-5-5")),
            ),
            (
                "a proxy 503 no available account",
                input("provider_error", "API Error: 503 no available account for claude-opus-5-5"),
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
            ("overloaded", input("provider_error", "Claude API is overloaded (529). Try again shortly."), None),
            ("context window", input("provider_error", "Claude stopped: the prompt exceeds the model's context window."), None),
            ("transport", input("transport_error", "Claude API connection error."), None),
        ];
        for (name, input, expected) in fixtures {
            assert_eq!(classify_limit(&input), expected, "{name}");
        }
    }

    #[test]
    fn ignores_a_reported_reset_that_is_not_after_the_failure() {
        let i = LimitInput { reset_at: Some(at(-1000)), ..input("usage_limit", "Claude usage limit reached.") };
        assert_eq!(classify_limit(&i), limit(UsageClass::UsageLimit, Some(at(FALLBACK_USAGE_LIMIT_MS)), None));
    }
}
