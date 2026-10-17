//! Usage-limit classification from what T3 reports about a failed thread: its failure class and reset time, plus the
//! error text the `claude` CLI or a proxy in front of it produced. Pure; the executor uses it to tell a limit from a
//! failure, and the usage area to park and pace. fleetd never asks a usage API. TS spec: apps/hub/src/usage/classify.ts
//! (the executor needs it at G1, so it lives here; usage imports it).
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::shell_mapper::Summary;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    /// T3's failure class (`usage_limit`, `provider_error`, ...).
    pub error_class: Option<&'a str>,
    pub message: &'a str,
    /// T3's `usageLimitResetAt`.
    pub reset_at: Option<&'a str>,
    /// When the thread failed; fallback resets count from here.
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

/// When nothing says when the limit resets.
pub fn fallback_wait_ms(class: UsageClass) -> i64 {
    match class {
        UsageClass::RateLimit => 5 * 60_000,
        _ => 60 * 60_000,
    }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex")
}

// CLIProxyAPI: a model no enabled credential offers, or every credential signed out.
static UNKNOWN_PROVIDER: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)unknown provider for model\s+["']?([^\s"'\\,}]+)"#));
static NO_ACCOUNT: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)no available account|no auth available|auth_unavailable"));
// CLIProxyAPI: every credential for the model is cooling down; it says when in reset_seconds.
static COOLDOWN: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)model_cooldown|are cooling down"));
static RESET_SECONDS: LazyLock<Regex> = LazyLock::new(|| re(r#""reset_seconds"\s*:\s*(\d+)"#));
static RATE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)rate[ _-]?limit|\[429\]|\b(?:api error|status|error)\W{0,3}429\b"));
static USAGE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)usage limit|hit your (?:usage )?limit|(?:5-hour|weekly|session|opus) limit reached|out of extra usage")
});
// The CLI's "Claude AI usage limit reached|<epoch seconds>".
static PIPE_EPOCH: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)limit reached\|(\d{10})\b"));
// A proxy's "(reset after 1h2m3s)".
static RESET_AFTER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?"));

/// Epoch ms of an ISO timestamp, as `Date.parse` reads the ones T3 and fleetd write.
pub fn parse_ms(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp_millis())
}

/// `new Date(ms).toISOString()`.
pub fn iso_of_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// T3's DateTimeUtc as fleetd formats it (`DateTime.formatIso`): UTC with milliseconds.
pub fn normalize_iso(iso: &str) -> String {
    parse_ms(iso).map(iso_of_ms).unwrap_or_else(|| iso.to_owned())
}

fn plus(at: &str, ms: i64) -> String {
    iso_of_ms(parse_ms(at).unwrap_or(0) + ms)
}

/// The first reset that lies after the failure.
fn reset_of(input: &LimitInput, class: UsageClass) -> String {
    let failed_ms = parse_ms(input.at).unwrap_or(0);
    let after = |iso: Option<String>| iso.filter(|iso| parse_ms(iso).is_some_and(|ms| ms > failed_ms));
    let num = |c: &regex::Captures, i: usize| c.get(i).map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(0));
    let epoch = PIPE_EPOCH.captures(input.message).map(|c| iso_of_ms(num(&c, 1) * 1000));
    let seconds = RESET_SECONDS.captures(input.message).map(|c| num(&c, 1));
    let span_ms = RESET_AFTER
        .captures(input.message)
        .map_or(0, |c| (num(&c, 1) * 3600 + num(&c, 2) * 60 + num(&c, 3)) * 1000);
    after(input.reset_at.map(str::to_owned))
        .or_else(|| after(epoch))
        .or_else(|| seconds.filter(|s| *s > 0).map(|s| plus(input.at, s * 1000)))
        .or_else(|| (span_ms > 0).then(|| plus(input.at, span_ms)))
        .unwrap_or_else(|| plus(input.at, fallback_wait_ms(class)))
}

/// The limit behind a failure, or None when it is an ordinary failure.
pub fn classify_limit(input: &LimitInput) -> Option<Limit> {
    let text = input.message;
    let model = input.model.filter(|m| !m.is_empty()).map(str::to_owned);
    if let Some(c) = UNKNOWN_PROVIDER.captures(text) {
        return Some(Limit { class: UsageClass::PoolExhausted, resume_at: None, model: Some(c[1].to_owned()) });
    }
    if NO_ACCOUNT.is_match(text) {
        return Some(Limit { class: UsageClass::PoolExhausted, resume_at: None, model });
    }
    if COOLDOWN.is_match(text) {
        return Some(Limit { class: UsageClass::UsageLimit, resume_at: Some(reset_of(input, UsageClass::UsageLimit)), model });
    }
    let class = if RATE.is_match(text) {
        UsageClass::RateLimit
    } else if input.error_class == Some("usage_limit") || USAGE.is_match(text) {
        UsageClass::UsageLimit
    } else {
        return None;
    };
    Some(Limit { class, resume_at: Some(reset_of(input, class)), model })
}

/// A failed thread's limit, read off its summary.
pub fn limit_of_summary(s: &Summary) -> Option<Limit> {
    if s.status != "failed" {
        return None;
    }
    let error = s.last_error.as_ref()?;
    classify_limit(&LimitInput {
        error_class: Some(&error.class),
        message: &error.message,
        reset_at: s.usage_limit_reset_at.as_deref(),
        at: &s.last_progress_at,
        model: s.model.as_deref(),
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
