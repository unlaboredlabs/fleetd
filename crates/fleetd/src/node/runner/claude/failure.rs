//! Classifies a failed run from what claude said, structured fields first and text second. The text rules are the
//! hub's `executor/limit.rs` ones (gateway texts and reset parsing included), moved here so the node decides once.
use std::str::FromStr;
use std::sync::LazyLock;

use chrono::TimeZone;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::prim::Text;
use fleetd_contracts::sessions::{FailureClass, RunFailure};
use regex::Regex;

use crate::node::runner::{ExitInfo, RateLimit};

/// What claude left behind for one failed run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FailureEvidence {
    /// The result's `is_error`.
    pub is_error: bool,
    /// The synthetic assistant message's `error`: authentication_failed, rate_limit, overloaded, server_error, ….
    pub assistant_error: Option<String>,
    pub api_error_status: Option<u16>,
    /// The result text, else the assistant error text, else the result's `errors` joined.
    pub text: String,
    pub terminal_reason: Option<String>,
    /// The result's `startup_failure_reason` (claude refused to start the turn: org pin, gateway sign-in, …).
    pub startup_failure_reason: Option<String>,
    /// The latest `rate_limit_event` of the session.
    pub rate_limit: Option<RateLimit>,
    /// Set when the process ended without a result.
    pub exit: Option<ExitInfo>,
    /// The tail of claude's stderr so far; when empty, `exit`'s tail is used.
    pub stderr: String,
    /// Epoch ms, for relative resets ("reset after 1h2m").
    pub now_ms: u64,
}

/// How many times the node itself re-runs an Overloaded or Network failure before it fails loudly.
pub const MAX_RUN_RETRIES: u32 = 3;
/// What a node retry sends, with `--resume`, so claude picks the turn back up.
pub const RETRY_MESSAGE: &str = "Continue where you left off.";
const MESSAGE_MAX: usize = 4000;
const STDERR_MARK: &str = "\n--- stderr tail ---\n";

/// The Agent SDK's `USAGE_LIMIT_ERROR_PREFIXES` (0.3.302): the texts claude starts a plan-limit error with.
pub const USAGE_LIMIT_ERROR_PREFIXES: &[&str] = &[
    "You've hit your",
    "You've reached your",
    "You're out of usage credits",
    "Your org is out of usage · add funds to continue",
    "Your org is out of usage · contact your admin",
    "Your seat type doesn't include usage credits",
    "Your seat type doesn't include usage",
    "Your usage allocation has been disabled by your admin",
    "Your group's usage limit is set to $0",
    "Fable 5 requires usage credits",
    "You're out of extra usage",
    "Your seat type doesn't include extra usage",
];

/// `SDKAssistantMessageError`s that only a person signing in again can fix.
const AUTH_ERRORS: &[&str] = &[
    "authentication_failed",
    "oauth_org_not_allowed",
    "verification_required",
    "cloud_credential_error",
];

/// claude's own stderr tag for a model name it doesn't know.
const UNRECOGNIZED_MODEL: &str = "[claude-code:unrecognized_model]";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex")
}

// The rules below are the hub's limit.rs ones, unchanged.
// CLIProxyAPI: a model no enabled credential offers, or every credential signed out.
static UNKNOWN_PROVIDER: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)unknown provider for model\s+["']?([^\s"'\\,}]+)"#));
static NO_ACCOUNT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)no available account|no auth available|auth_unavailable"));
// CLIProxyAPI: every credential for the model is cooling down; it says when in reset_seconds.
static COOLDOWN: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)model_cooldown|are cooling down"));
// "All credentials for model claude-opus-5-5 are cooling down", in its JSON body or as claude shows it.
static COOLDOWN_MODEL: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?i)credentials for model\s+["']?([^\s"'\\,}]+)["']?\s+are cooling down"#)
});
static RESET_SECONDS: LazyLock<Regex> = LazyLock::new(|| re(r#""reset_seconds"\s*:\s*(\d+)"#));
static RATE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)rate[ _-]?limit|\[429\]|\b(?:api error|status|error)\W{0,3}429\b"));
static USAGE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)usage limit|hit your (?:usage )?limit|(?:5-hour|weekly|session|opus) limit reached|out of extra usage",
    )
});
// The CLI's "Claude AI usage limit reached|<epoch seconds>".
static PIPE_EPOCH: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)limit reached\|(\d{10})\b"));
// A proxy's "(reset after 1h2m3s)".
static RESET_AFTER: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)reset after (?:(\d+)h ?)?(?:(\d+)m ?)?(?:(\d+)s)?"));

// New with the runner.
// The CLI's plan-limit suffix, "· resets 4pm (UTC)" or "resets 4:30am (Europe/Berlin)"; only read with a zone.
static RESETS_CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\bresets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)")
});
static OVERLOADED: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\boverloaded\b|\bapi error:? 5\d\d\b"));
static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|connection (?:refused|reset|error)|socket hang up|request timed out|network error",
    )
});
static CONTEXT_FULL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)prompt is too long|context (?:window|length)|maximum context|exceeds? the model's context",
    )
});

/// A limit the text rules found.
#[derive(Clone, Debug, PartialEq, Eq)]
struct TextLimit {
    /// UsageLimit, RateLimit or PoolExhausted.
    class: FailureClass,
    /// Epoch ms to continue at; absent when the text says none (the hub then checks the login on a backoff) and for
    /// PoolExhausted, which waits for a person (`usage_resume`).
    reset_ms: Option<i64>,
    /// The model a gateway named: PoolExhausted's "unknown provider for model X", a cooldown's "credentials for
    /// model X".
    model: Option<String>,
}

/// The model a gateway's "unknown provider for model X" names, for the hub's "no account available for X"
/// ([`RunFailure::model`]).
pub fn gateway_model(text: &str) -> Option<String> {
    UNKNOWN_PROVIDER.captures(text).map(|c| c[1].to_owned())
}

/// A limit only the text names: RATE before USAGE.
fn text_limit(text: &str, at_ms: i64) -> Option<TextLimit> {
    let class = if RATE.is_match(text) {
        FailureClass::RateLimit
    } else if USAGE.is_match(text) {
        FailureClass::UsageLimit
    } else {
        return None;
    };
    Some(TextLimit {
        class,
        reset_ms: reset_ms(text, None, at_ms),
        model: None,
    })
}

fn gateway_limit(text: &str, at_ms: i64) -> Option<TextLimit> {
    if let Some(model) = gateway_model(text) {
        return Some(TextLimit {
            class: FailureClass::PoolExhausted,
            reset_ms: None,
            model: Some(model),
        });
    }
    if NO_ACCOUNT.is_match(text) {
        return Some(TextLimit {
            class: FailureClass::PoolExhausted,
            reset_ms: None,
            model: None,
        });
    }
    // A cooldown with its reset_seconds is the account's quota; one without (claude shows only "All credentials for
    // model X are cooling down (last error: rate_limit_error …)") is the proxy resting its credentials after a 429,
    // usually for a minute or two.
    if !COOLDOWN.is_match(text) {
        return None;
    }
    let reset_ms = reset_ms(text, None, at_ms);
    Some(TextLimit {
        class: if reset_ms.is_some() {
            FailureClass::UsageLimit
        } else {
            FailureClass::RateLimit
        },
        reset_ms,
        model: COOLDOWN_MODEL.captures(text).map(|c| c[1].to_owned()),
    })
}

/// A reset further out than this is a garbled number, not a plan: cap it rather than park for years.
const MAX_RESET_MS: i64 = 31 * 24 * 60 * 60_000;

/// The first reset that lies after `at_ms`: the structured one, then the texts; `None` when none says, which the hub
/// answers by checking the login on a backoff rather than guessing an hour. Text numbers saturate and the result is
/// capped at [`MAX_RESET_MS`] out, so no gateway text can overflow it.
fn reset_ms(text: &str, structured_ms: Option<i64>, at_ms: i64) -> Option<i64> {
    let after = |ms: Option<i64>| ms.filter(|ms| *ms > at_ms);
    let num = |c: &regex::Captures, i: usize| {
        c.get(i)
            .map_or(0, |m| m.as_str().parse::<i64>().unwrap_or(i64::MAX))
    };
    let epoch = PIPE_EPOCH
        .captures(text)
        .map(|c| num(&c, 1).saturating_mul(1000));
    let seconds = RESET_SECONDS.captures(text).map(|c| num(&c, 1));
    let span_ms = RESET_AFTER.captures(text).map_or(0, |c| {
        num(&c, 1)
            .saturating_mul(3600)
            .saturating_add(num(&c, 2).saturating_mul(60))
            .saturating_add(num(&c, 3))
            .saturating_mul(1000)
    });
    let reset = after(structured_ms)
        .or_else(|| after(epoch))
        .or_else(|| {
            seconds
                .filter(|s| *s > 0)
                .map(|s| at_ms.saturating_add(s.saturating_mul(1000)))
        })
        .or_else(|| (span_ms > 0).then_some(at_ms.saturating_add(span_ms)))
        .or_else(|| clock_reset_ms(text, at_ms));
    reset.map(|r| r.min(at_ms.saturating_add(MAX_RESET_MS)))
}

/// "resets 4pm (UTC)": the next such wall-clock time in that zone after `at_ms`.
fn clock_reset_ms(text: &str, at_ms: i64) -> Option<i64> {
    let c = RESETS_CLOCK.captures(text)?;
    let hour12: u32 = c[1].parse().ok().filter(|h| (1..=12).contains(h))?;
    let minute: u32 = c.get(2).map_or(Some(0), |m| m.as_str().parse().ok())?;
    let hour = hour12 % 12
        + if c[3].eq_ignore_ascii_case("pm") {
            12
        } else {
            0
        };
    let tz = chrono_tz::Tz::from_str(c[4].trim()).ok()?;
    let now = tz.timestamp_millis_opt(at_ms).single()?;
    let mut day = now.date_naive();
    for _ in 0..2 {
        let at = tz
            .from_local_datetime(&day.and_hms_opt(hour, minute, 0)?)
            .earliest()?
            .timestamp_millis();
        if at > at_ms {
            return Some(at);
        }
        day = day.succ_opt()?;
    }
    None
}

/// `None` when the evidence shows no failure: a clean result, or an interrupt (`aborted_*`), which the runner
/// reports as `RunOutcome::Interrupted`.
pub fn classify(evidence: &FailureEvidence) -> Option<RunFailure> {
    let e = evidence;
    if e.terminal_reason
        .as_deref()
        .is_some_and(|r| r.starts_with("aborted"))
    {
        return None;
    }
    let failed = e.is_error
        || e.assistant_error.is_some()
        || e.startup_failure_reason.is_some()
        || e.exit.is_some();
    if !failed {
        return None;
    }
    let stderr = match (&e.exit, e.stderr.is_empty()) {
        (Some(exit), true) => exit.stderr_tail.as_str(),
        _ => e.stderr.as_str(),
    };
    let (class, reset) = decide(e, stderr);
    let message = loud_message(&e.text, stderr, e.exit.as_ref());
    Some(RunFailure {
        class,
        model: gateway_model_of(class, message.as_str()),
        message,
        api_status: e.api_error_status,
        reset_at: reset.map(timestamp),
        retries: 0,
    })
}

/// The model a gateway named in the failure: the one it has no account for, or the one whose credentials cool down.
fn gateway_model_of(class: FailureClass, message: &str) -> Option<String> {
    match class {
        FailureClass::PoolExhausted => gateway_model(message),
        FailureClass::UsageLimit | FailureClass::RateLimit if COOLDOWN.is_match(message) => {
            COOLDOWN_MODEL.captures(message).map(|c| c[1].to_owned())
        }
        _ => None,
    }
}

fn decide(e: &FailureEvidence, stderr: &str) -> (FailureClass, Option<i64>) {
    use FailureClass::*;
    let now = e.now_ms as i64;
    let error = e.assistant_error.as_deref();
    let status = e.api_error_status;
    let reason = e.terminal_reason.as_deref();
    let text = e.text.as_str();

    if let Some(startup) = e.startup_failure_reason.as_deref() {
        return (startup_class(startup), None);
    }
    if error == Some("model_not_found") {
        return (InvalidRequest, None);
    }
    if let Some(limit) = gateway_limit(text, now) {
        // claude tags every model name it doesn't know, gateway aliases and models newer than the pin included,
        // so the tag alone decides nothing. It only turns the gateway's "unknown provider for model X" from a
        // drained pool into a bad model name, which neither claude nor the gateway knows.
        let unknown_provider = limit.model.is_some();
        if unknown_provider && stderr.contains(UNRECOGNIZED_MODEL) {
            return (InvalidRequest, None);
        }
        return (limit.class, limit.reset_ms);
    }
    if error.is_some_and(|err| AUTH_ERRORS.contains(&err)) || status == Some(401) {
        return (Auth, None);
    }
    let rejected = e
        .rate_limit
        .as_ref()
        .filter(|r| r.status == "rejected")
        .map(|r| r.resets_at.map(|s| s.saturating_mul(1000)));
    let limited = error == Some("rate_limit") || status == Some(429);
    if let Some(resets_at) = rejected.filter(|_| limited || reason == Some("blocking_limit")) {
        return (UsageLimit, reset_ms(text, resets_at, now));
    }
    let plan_text = USAGE_LIMIT_ERROR_PREFIXES
        .iter()
        .any(|p| text.trim_start().starts_with(p));
    if reason == Some("blocking_limit") || (error == Some("rate_limit") && plan_text) {
        return (UsageLimit, reset_ms(text, None, now));
    }
    if let Some(limit) = text_limit(text, now) {
        return (limit.class, limit.reset_ms);
    }
    if limited || reason == Some("rapid_refill_breaker") {
        return (RateLimit, reset_ms(text, None, now));
    }
    let server = matches!(error, Some("overloaded" | "server_error"));
    if error == Some("overloaded")
        || status.is_some_and(|s| (500..600).contains(&s))
        || OVERLOADED.is_match(text)
    {
        return (Overloaded, None);
    }
    if (server && status.is_none()) || NETWORK.is_match(text) {
        return (Network, None);
    }
    if matches!(error, Some("invalid_request"))
        || matches!(reason, Some("prompt_too_long" | "image_error"))
        || CONTEXT_FULL.is_match(text)
        || status.is_some_and(|s| (400..500).contains(&s))
    {
        return (InvalidRequest, None);
    }
    if e.exit.is_some() && error.is_none() && !e.is_error {
        return (ProcessExited, None);
    }
    // billing_error, account_on_hold, max_output_tokens, max turns or budget, model_error, …: no retry.
    (Other, None)
}

/// `startup_failure_reason`s: a sign-in or org refusal needs a person, a "retrying may succeed" one is transient,
/// everything else is a setup problem that won't fix itself.
fn startup_class(reason: &str) -> FailureClass {
    match reason {
        "org_pin_api_key_conflict"
        | "org_verify_failed"
        | "org_pin_mismatch"
        | "gateway_signin_required"
        | "gateway_access_denied"
        | "org_config_refused" => FailureClass::Auth,
        "org_config_required_unavailable"
        | "remote_settings_required_unavailable"
        | "worktree_unverified" => FailureClass::Network,
        _ => FailureClass::InvalidRequest,
    }
}

/// The node retries these itself ([`retry_delay_ms`]); claude has already retried the API call.
pub fn retryable(class: FailureClass) -> bool {
    matches!(class, FailureClass::Overloaded | FailureClass::Network)
}

/// A run that ran out of context: the hub may answer it with `/compact`.
pub fn context_full(evidence: &FailureEvidence) -> bool {
    evidence.terminal_reason.as_deref() == Some("prompt_too_long")
        || CONTEXT_FULL.is_match(&evidence.text)
}

/// [`context_full`] from a recorded failure's message, which keeps claude's text ("Prompt is too long").
pub fn context_full_text(message: &str) -> bool {
    CONTEXT_FULL.is_match(message)
}

/// The node's own bounded retry for Overloaded and Network, after claude's internal retries gave up: the delay
/// before retry `attempt` (1-based), or `None` once the run should fail loudly.
pub fn retry_delay_ms(attempt: u32) -> Option<u64> {
    retry_delay_with(attempt, rand::random::<f64>())
}

/// [`retry_delay_ms`] with its jitter drawn: 1, 4 and 15 minutes (×4 a step, capped at 15), each ±10% by `unit`
/// in [0, 1) so that machines hit by one outage don't all come back at the same second. Whole seconds, as shown.
pub fn retry_delay_with(attempt: u32, unit: f64) -> Option<u64> {
    if attempt == 0 || attempt > MAX_RUN_RETRIES {
        return None;
    }
    let base = (60_000u64 * 4u64.pow(attempt - 1)).min(15 * 60_000);
    let factor = 0.9 + 0.2 * unit.clamp(0.0, 1.0);
    Some((base as f64 * factor / 1000.0).round() as u64 * 1000)
}

/// How to log claude in, run on the machine. Sessions use the user's own claude setup, so it is the same login as
/// their own `claude`; when that goes through a proxy, the proxy holds the login.
pub const LOGIN_FIX: &str = "claude auth login (or, when claude goes through your proxy, log in with your proxy as you normally do)";

/// [`LOGIN_FIX`] for a machine whose sessions do or don't go through a proxy.
pub fn login_fix(proxy: bool) -> &'static str {
    if proxy {
        "log in with your proxy as you normally do"
    } else {
        "claude auth login"
    }
}

/// The fix for an Auth failure on `machine`.
pub fn auth_fix(machine: &str) -> String {
    format!("On {machine}: {LOGIN_FIX}")
}

/// claude's own words first, then how the process ended, then the tail of its stderr; at most 4000 UTF-16 units.
fn loud_message(text: &str, stderr: &str, exit: Option<&ExitInfo>) -> Text<1, MESSAGE_MAX> {
    let mut head = text.trim().to_owned();
    if let Some(exit) = exit {
        let how = match (exit.code, exit.signal) {
            (_, Some(sig)) => format!(
                "claude was killed by {} before the run finished",
                nix::sys::signal::Signal::try_from(sig)
                    .map_or_else(|_| format!("signal {sig}"), |s| s.to_string())
            ),
            (Some(code), None) => format!("claude exited with code {code} before the run finished"),
            (None, None) => "claude exited before the run finished".to_owned(),
        };
        head = if head.is_empty() {
            how
        } else {
            format!("{head}\n{how}")
        };
    }
    if head.is_empty() {
        head = "claude reported an error without any text".to_owned();
    }
    let stderr = stderr.trim();
    let mut message = if stderr.is_empty() {
        head_units(&head, MESSAGE_MAX).to_owned()
    } else {
        let head = head_units(&head, MESSAGE_MAX / 2);
        let room = MESSAGE_MAX - units(head) - units(STDERR_MARK);
        format!("{head}{STDERR_MARK}{}", tail_units(stderr, room))
    };
    if message.is_empty() {
        message.push('?');
    }
    Text::unchecked(message)
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

fn head_units(s: &str, max: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        used += c.len_utf16();
        if used > max {
            return &s[..i];
        }
    }
    s
}

fn tail_units(s: &str, max: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices().rev() {
        used += c.len_utf16();
        if used > max {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

fn timestamp(ms: i64) -> Timestamp {
    Timestamp(
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap_or_default()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::runner::RateLimit as RateLimitEvent;
    use crate::node::runner::claude::protocol::{Block, Line};
    use FailureClass::*;

    /// 2026-10-18T10:00:00Z, before every reset in the fixtures.
    const NOW: i64 = 1_792_317_600_000;
    const MIN: i64 = 60_000;

    fn iso(ms: i64) -> String {
        timestamp(ms).0
    }

    /// The evidence a runner collects from one recorded run, as R1's mapper does: the synthetic assistant error,
    /// the session's latest rate_limit_event, the result (or the exit without one), and stderr.
    fn evidence(fixture: &str) -> FailureEvidence {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/node/runner/fixtures")
            .join(if fixture.ends_with(".jsonl") {
                fixture.to_owned()
            } else {
                format!("claude-2.1.302-{fixture}.jsonl")
            });
        let mut e = FailureEvidence {
            now_ms: NOW as u64,
            ..Default::default()
        };
        let (mut result, mut assistant_text, mut exit) = (false, String::new(), None);
        for raw in std::fs::read_to_string(&path).unwrap().lines() {
            let rec: serde_json::Value = serde_json::from_str(raw).unwrap();
            match rec["dir"].as_str().unwrap() {
                "stderr" => e.stderr.push_str(rec["raw"].as_str().unwrap()),
                "meta" if rec["msg"].get("exit").is_some() => {
                    let signal = rec["msg"]["signal"].as_str().map(|s| match s {
                        "SIGKILL" => 9,
                        other => panic!("signal {other}"),
                    });
                    exit = Some(ExitInfo {
                        code: rec["msg"]["exit"].as_i64().map(|c| c as i32),
                        signal,
                        stderr_tail: String::new(),
                    });
                }
                "out" => match serde_json::from_value::<Line>(rec["msg"].clone()).unwrap() {
                    Line::Assistant(a) if a.error.is_some() => {
                        e.assistant_error = a.error;
                        e.api_error_status = a.api_error_status;
                        for block in a.message.content {
                            if let Block::Text { text } = block {
                                assistant_text.push_str(&text);
                            }
                        }
                    }
                    Line::RateLimitEvent(r) => {
                        e.rate_limit = Some(RateLimitEvent {
                            status: r.rate_limit_info.status,
                            resets_at: r.rate_limit_info.resets_at,
                            limit_type: r.rate_limit_info.rate_limit_type,
                            utilization: r.rate_limit_info.utilization,
                        });
                    }
                    Line::Result(r) => {
                        result = true;
                        e.is_error = r.is_error;
                        e.text = r.result.unwrap_or_default();
                        e.terminal_reason = r.terminal_reason;
                        e.startup_failure_reason = r.startup_failure_reason;
                        e.api_error_status = r.api_error_status.or(e.api_error_status);
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        if e.text.is_empty() {
            e.text = assistant_text;
        }
        if !result {
            e.exit = exit;
        }
        e
    }

    fn class_of(fixture: &str) -> Option<FailureClass> {
        classify(&evidence(fixture)).map(|f| f.class)
    }

    #[test]
    fn clean_and_interrupted_runs_are_not_failures() {
        for fixture in [
            "init-partial-two-turns",
            "resume",
            "resume-after-kill",
            "permission-allow",
            "permission-deny",
            "allowlisted-tool",
            "compact-manual",
            "interrupt-mid-tool",
        ] {
            assert_eq!(class_of(fixture), None, "{fixture}");
        }
    }

    #[test]
    fn usage_limit_from_the_rate_limit_event_resets_at_its_resets_at() {
        let f = classify(&evidence("usage-limit-subscription.documented")).unwrap();
        assert_eq!(f.class, UsageLimit);
        // resetsAt (15:00) wins over the text's "resets 4pm (UTC)".
        assert_eq!(f.reset_at.unwrap().0, "2026-10-18T15:00:00.000Z");
        assert_eq!(f.api_status, Some(429));
        assert_eq!(
            f.message.as_str(),
            "You've hit your limit · resets 4pm (UTC)"
        );
    }

    #[test]
    fn usage_limit_without_the_event_reads_the_plan_text_or_names_no_reset() {
        let mut e = evidence("usage-limit-subscription.documented");
        e.rate_limit = None;
        let f = classify(&e).unwrap();
        assert_eq!(
            (f.class, f.reset_at.unwrap().0),
            (UsageLimit, "2026-10-18T16:00:00.000Z".into())
        );

        // A prefix with no reset at all: none, never a made-up hour; the hub checks the login instead.
        e.text = "You're out of extra usage".into();
        let f = classify(&e).unwrap();
        assert_eq!((f.class, f.reset_at), (UsageLimit, None));

        // An event already past is stale: the text decides.
        e.text = "You've hit your limit · resets 4pm (UTC)".into();
        e.rate_limit = Some(RateLimitEvent {
            status: "rejected".into(),
            resets_at: Some(NOW / 1000 - 60),
            limit_type: Some("five_hour".into()),
            utilization: None,
        });
        assert_eq!(
            classify(&e).unwrap().reset_at.unwrap().0,
            "2026-10-18T16:00:00.000Z"
        );

        // claude's blocking_limit terminal reason is a plan limit whatever the text.
        let e = FailureEvidence {
            is_error: true,
            text: "Claude stopped.".into(),
            terminal_reason: Some("blocking_limit".into()),
            now_ms: NOW as u64,
            ..Default::default()
        };
        assert_eq!(classify(&e).unwrap().class, UsageLimit);
    }

    #[test]
    fn huge_reset_numbers_saturate_and_cap_at_31_days() {
        let cap = iso(NOW + 31 * 24 * 60 * MIN);
        for text in [
            r#"API Error: 429 {"error":{"code":"model_cooldown","reset_seconds":9223372036854775807}}"#,
            r#"model_cooldown "reset_seconds":99999999999999999999999"#,
            "rate limit (reset after 9223372036854775807h9223372036854775807m)",
            "Claude AI usage limit reached|9999999999",
        ] {
            let limit = gateway_limit(text, NOW)
                .or_else(|| text_limit(text, NOW))
                .unwrap();
            assert_eq!(iso(limit.reset_ms.unwrap()), cap, "{text}");
        }
        let mut e = evidence("usage-limit-subscription.documented");
        e.rate_limit.as_mut().unwrap().resets_at = Some(i64::MAX);
        assert_eq!(classify(&e).unwrap().reset_at.unwrap().0, cap);
    }

    #[test]
    fn plan_text_resets_roll_to_the_next_day_and_need_a_zone() {
        let at = |text: &str| clock_reset_ms(text, NOW).map(iso);
        assert_eq!(at("resets 9am (UTC)").unwrap(), "2026-10-19T09:00:00.000Z");
        assert_eq!(
            at("resets 10:30am (UTC)").unwrap(),
            "2026-10-18T10:30:00.000Z"
        );
        // 10:00Z is 12:00 in Berlin (CEST); 4pm there is 14:00Z.
        assert_eq!(
            at("· resets 4pm (Europe/Berlin)").unwrap(),
            "2026-10-18T14:00:00.000Z"
        );
        assert_eq!(at("resets 12am (UTC)").unwrap(), "2026-10-19T00:00:00.000Z");
        assert_eq!(at("resets 4pm"), None);
        assert_eq!(at("resets 4pm (Mars/Olympus)"), None);
        assert_eq!(at("resets 13pm (UTC)"), None);
    }

    #[test]
    fn request_rate_limits_name_no_reset() {
        for fixture in ["rate-limit-429", "usage-429-api-key"] {
            let f = classify(&evidence(fixture)).unwrap();
            assert_eq!(f.class, RateLimit, "{fixture}");
            assert_eq!((f.reset_at, f.model), (None, None), "{fixture}");
            assert!(
                f.message.starts_with("API Error: Request rejected (429)"),
                "{fixture}"
            );
        }
    }

    /// forge, 2026-10-25 22:40 UTC: every agent behind its CLIProxyAPI gateway failed with this one text. It names
    /// no reset, so main's made-up hour parked them all until 23:40; it is the proxy resting its credentials after
    /// a 429, so the hub checks again from a minute on, and says the proxy did it.
    #[test]
    fn forges_proxy_cooldown_names_no_reset_and_its_model() {
        let e = evidence("claude-2.1.310-proxy-cooldown-429.jsonl");
        assert_eq!(
            (e.assistant_error.as_deref(), e.api_error_status),
            (Some("rate_limit"), Some(429))
        );
        let f = classify(&e).unwrap();
        assert_eq!(
            f.message.as_str(),
            "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down (last \
             error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)"
        );
        assert_eq!(
            (f.class, f.reset_at, f.model.as_deref()),
            (RateLimit, None, Some("claude-opus-5-5"))
        );
        // Its JSON form with reset_seconds is the account's quota, and parks until then.
        let mut e = e;
        e.text = r#"API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-5-5 are cooling down","reset_seconds":90}}"#.into();
        let f = classify(&e).unwrap();
        assert_eq!(
            (f.class, f.reset_at.unwrap().0, f.model.as_deref()),
            (UsageLimit, iso(NOW + 90_000), Some("claude-opus-5-5"))
        );
    }

    #[test]
    fn auth_failures_are_auth_with_claudes_words() {
        let f = classify(&evidence("not-logged-in")).unwrap();
        assert_eq!(
            (f.class, f.message.as_str()),
            (Auth, "Not logged in · Please run /login")
        );
        assert_eq!(f.reset_at, None);
        let f = classify(&evidence("auth-expired-401")).unwrap();
        assert_eq!((f.class, f.api_status), (Auth, Some(401)));
        assert!(f.message.contains("OAuth token has expired"));
        assert!(!retryable(Auth));
        assert_eq!(
            auth_fix("devbox"),
            "On devbox: claude auth login (or, when claude goes through your proxy, log in with your proxy as you \
             normally do)"
        );
    }

    #[test]
    fn server_errors_are_overloaded_and_refused_connections_network() {
        for (fixture, class, status) in [
            ("overloaded-529", Overloaded, Some(529)),
            ("server-500", Overloaded, Some(500)),
            ("network-refused", Network, None),
        ] {
            let f = classify(&evidence(fixture)).unwrap();
            assert_eq!(
                (f.class, f.api_status, f.reset_at),
                (class, status, None),
                "{fixture}"
            );
            assert!(f.message.starts_with("API Error: "), "{fixture}");
            assert!(retryable(f.class));
        }
    }

    #[test]
    fn an_unknown_model_is_invalid_and_a_drained_gateway_pool_exhausted() {
        // claude tags the model as unknown on stderr: a bad model name, never retried or parked.
        let e = evidence("invalid-model");
        let f = classify(&e).unwrap();
        assert_eq!((f.class, f.api_status), (InvalidRequest, Some(400)));
        assert!(
            f.message
                .starts_with("API Error: 400 unknown provider for model claude-does-not-exist-9")
        );
        assert!(
            f.message
                .contains("--- stderr tail ---\n[claude-code:unrecognized_model]")
        );
        // The same gateway text for a model claude knows: every credential behind the gateway is gone.
        let f = classify(&FailureEvidence {
            stderr: String::new(),
            ..e
        })
        .unwrap();
        assert_eq!((f.class, f.reset_at), (PoolExhausted, None));
        // The hub reads the model off the failure, never the text.
        assert_eq!(f.model.as_deref(), Some("claude-does-not-exist-9"));
        let e = FailureEvidence {
            is_error: true,
            assistant_error: Some("model_not_found".into()),
            api_error_status: Some(404),
            text: "There's an issue with the selected model (claude-x). It may not exist.".into(),
            now_ms: NOW as u64,
            ..Default::default()
        };
        assert_eq!(classify(&e).unwrap().class, InvalidRequest);
    }

    /// The unrecognized-model tag on stderr (any model claude doesn't know, e.g. a gateway alias) must not mask
    /// the real failure.
    #[test]
    fn the_unrecognized_model_tag_leaves_retries_and_parking_alone() {
        let tag =
            "[claude-code:unrecognized_model] {\"model\":\"gw-alias\",\"query_source\":\"sdk\"}\n";
        let tagged = |fixture: &str| {
            let mut e = evidence(fixture);
            e.stderr.push_str(tag);
            classify(&e).unwrap()
        };
        let f = tagged("overloaded-529");
        assert_eq!((f.class, f.api_status), (Overloaded, Some(529)));
        assert!(retryable(f.class));
        assert_eq!(tagged("network-refused").class, Network);
        let f = tagged("usage-limit-subscription.documented");
        assert_eq!(
            (f.class, f.reset_at.unwrap().0),
            (UsageLimit, "2026-10-18T15:00:00.000Z".into())
        );
        assert_eq!(tagged("rate-limit-429").class, FailureClass::RateLimit);
        assert_eq!(tagged("auth-expired-401").class, Auth);
        // A cooldown or a signed-out pool behind the gateway still parks.
        let mut e = evidence("overloaded-529");
        e.stderr.push_str(tag);
        e.text = r#"API Error: 429 {"error":{"code":"model_cooldown","reset_seconds":120}}"#.into();
        e.api_error_status = Some(429);
        assert_eq!(classify(&e).unwrap().class, UsageLimit);
        e.text = "API Error: 503 no available account for gw-alias".into();
        assert_eq!(classify(&e).unwrap().class, PoolExhausted);
    }

    #[test]
    fn context_overflow_is_invalid_and_asks_for_compaction() {
        let e = FailureEvidence {
            is_error: true,
            assistant_error: Some("invalid_request".into()),
            api_error_status: Some(400),
            text: "Prompt is too long".into(),
            terminal_reason: Some("prompt_too_long".into()),
            now_ms: NOW as u64,
            ..Default::default()
        };
        assert_eq!(classify(&e).unwrap().class, InvalidRequest);
        assert!(context_full(&e));
        assert!(!context_full(&evidence("invalid-model")));
        let unexplained_400 = FailureEvidence {
            assistant_error: Some("unknown".into()),
            terminal_reason: None,
            text: "API Error: 400 something new".into(),
            ..e
        };
        assert_eq!(classify(&unexplained_400).unwrap().class, InvalidRequest);
    }

    #[test]
    fn an_exit_without_a_result_is_process_exited_with_how_it_ended() {
        let f = classify(&evidence("sigkill-mid-tool")).unwrap();
        assert_eq!(f.class, ProcessExited);
        assert_eq!(
            f.message.as_str(),
            "claude was killed by SIGKILL before the run finished"
        );
        let f = classify(&evidence("sigterm-mid-tool")).unwrap();
        assert_eq!(f.class, ProcessExited);
        assert_eq!(
            f.message.as_str(),
            "claude exited with code 143 before the run finished"
        );
        // A refused start: only stderr says why.
        let f = classify(&evidence("session-id-in-use")).unwrap();
        assert_eq!(f.class, ProcessExited);
        assert!(
            f.message.ends_with("is already in use."),
            "{}",
            f.message.as_str()
        );
        assert!(!retryable(ProcessExited));
    }

    #[test]
    fn startup_refusals_split_into_sign_in_transient_and_setup() {
        let start = |reason: &str| {
            classify(&FailureEvidence {
                is_error: true,
                text: "refused".into(),
                startup_failure_reason: Some(reason.into()),
                ..Default::default()
            })
            .unwrap()
            .class
        };
        assert_eq!(start("gateway_signin_required"), Auth);
        assert_eq!(start("org_config_refused"), Auth);
        assert_eq!(start("org_config_required_unavailable"), Network);
        assert_eq!(start("cwd_unavailable"), InvalidRequest);
        assert_eq!(start("cli_version_too_old"), InvalidRequest);
    }

    #[test]
    fn other_errors_fail_loudly_without_retry() {
        let e = FailureEvidence {
            is_error: true,
            assistant_error: Some("billing_error".into()),
            text: "Credit balance is too low".into(),
            ..Default::default()
        };
        let f = classify(&e).unwrap();
        assert_eq!(
            (f.class, f.message.as_str()),
            (Other, "Credit balance is too low")
        );
        assert!(!retryable(Other));
    }

    /// The hub's limit.rs table (gateway texts, cooldown, the CLI's epoch suffix); a text with no reset names none.
    #[test]
    fn the_moved_text_rules_keep_their_answers() {
        let at = NOW;
        let limit = |class, reset_ms: Option<i64>, model: Option<&str>| {
            Some(TextLimit {
                class,
                reset_ms,
                model: model.map(str::to_owned),
            })
        };
        let table: Vec<(&str, Option<TextLimit>)> = vec![
            (
                "Claude usage limit reached. Send the message again once the limit resets.",
                limit(UsageLimit, None, None),
            ),
            (
                "Claude AI usage limit reached|1792483200",
                limit(UsageLimit, Some(1_792_483_200_000), None),
            ),
            (
                "Claude API rate limit reached. Try again later.",
                limit(RateLimit, None, None),
            ),
            (
                r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#,
                limit(RateLimit, None, None),
            ),
            (
                r#"API Error: 503 [claude] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}} (reset after 1h30m)"#,
                limit(RateLimit, Some(at + 90 * MIN), None),
            ),
            (
                r#"API Error: 400 {"error":{"message":"unknown provider for model claude-opus-5-5","type":"invalid_request_error","code":"model_not_found","param":"model"}}"#,
                limit(PoolExhausted, None, Some("claude-opus-5-5")),
            ),
            (
                r#"API Error: 503 {"error":{"message":"no auth available","code":"auth_unavailable"}}"#,
                limit(PoolExhausted, None, None),
            ),
            (
                "API Error: 503 no available account for claude-opus-5-5",
                limit(PoolExhausted, None, None),
            ),
            (
                r#"API Error: 429 {"error":{"code":"model_cooldown","message":"All credentials for model claude-opus-5-5 are cooling down","model":"claude-opus-5-5","reset_time":"1h2m0s","reset_seconds":3720}}"#,
                limit(UsageLimit, Some(at + 3_720_000), Some("claude-opus-5-5")),
            ),
            ("Claude API is overloaded (529). Try again shortly.", None),
            (
                "Claude stopped: the prompt exceeds the model's context window.",
                None,
            ),
            ("Claude API connection error.", None),
        ];
        for (text, want) in table {
            let found = gateway_limit(text, at).or_else(|| text_limit(text, at));
            assert_eq!(found, want, "{text}");
        }
    }

    #[test]
    fn the_message_keeps_claudes_words_and_the_stderr_tail_within_4000_units() {
        let text = "API Error: 529 Overloaded.";
        let stderr = format!("{}END", "x".repeat(10_000));
        let m = loud_message(text, &stderr, None);
        assert!(m.starts_with("API Error: 529 Overloaded.\n--- stderr tail ---\nxxx"));
        assert!(m.ends_with("xxxEND"));
        assert_eq!(m.encode_utf16().count(), 4000);
        // A huge text keeps its start and leaves room for stderr.
        let m = loud_message(&"é".repeat(9000), "boom", None);
        assert!(m.ends_with("--- stderr tail ---\nboom"));
        assert!(m.encode_utf16().count() <= 4000);
        // Astral characters count two units and are never split.
        let m = loud_message(&"😀".repeat(3000), "", None);
        assert_eq!(m.encode_utf16().count(), 4000);
        assert!(Text::<1, 4000>::new(m.into_inner()).is_ok());
        assert_eq!(
            loud_message("  ", "", None).as_str(),
            "claude reported an error without any text"
        );
    }

    #[test]
    fn node_retries_back_off_one_four_fifteen_minutes_with_jitter_then_stop() {
        assert_eq!(retry_delay_with(1, 0.5), Some(60_000));
        assert_eq!(retry_delay_with(2, 0.5), Some(240_000));
        assert_eq!(retry_delay_with(3, 0.5), Some(900_000));
        assert_eq!(retry_delay_with(1, 0.0), Some(54_000));
        assert_eq!(retry_delay_with(3, 1.0), Some(990_000));
        // Whole seconds, so the thread says "node retry 1/3 in 57 s".
        assert_eq!(retry_delay_with(1, 0.37), Some(58_000));
        assert_eq!(retry_delay_with(0, 0.5), None);
        assert_eq!(retry_delay_with(MAX_RUN_RETRIES + 1, 0.5), None);
        for attempt in 1..=MAX_RUN_RETRIES {
            let d = retry_delay_ms(attempt).unwrap();
            let base = retry_delay_with(attempt, 0.5).unwrap();
            assert!(d >= base * 9 / 10 && d <= base * 11 / 10, "{attempt}: {d}");
        }
        assert_eq!(retry_delay_ms(4), None);
    }
}
