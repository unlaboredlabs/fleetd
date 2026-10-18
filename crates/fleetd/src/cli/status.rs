//! `fleetd status`: an order's, a project's or the fleet's progress, read from the hub's status doc (status_get) and,
//! with `--watch`, kept current by status_wait, which blocks on the hub until the doc changes. It lays out only what
//! the hub decided: the number, the ETA, and which parts are stale. Every time printed is absolute, so a block left on
//! screen never reads as fresher than it is. Also `fleetd hub github-webhook`, which wraps github_webhook_set.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use fleetd_contracts::ledger::WorkstreamId;
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::lead::js_number;
use super::mcp_client::{McpClient, McpError};

pub const STATUS_USAGE: &str = r#"  status [<order>|<project>] [--watch] [--json] [--hub <url> --key-file <path>]
             progress fleetd verified, the ETA from measured speed, what it waits on, what changed
             since you last looked, health and risks; for an order (W41), a project by id or title
             (<machine>/<project> when two machines have one), or the whole fleet. --watch prints
             each new version as the hub sends it; stale parts say so. On the hub machine it
             needs no --hub or --key-file
"#;

pub const GITHUB_WEBHOOK_USAGE: &str = r#"  hub github-webhook (--url <public url>/github | --off) [--hub <url> --key-file <path>]
             let GitHub tell the hub about pull requests, checks and pushes on the train's repos
             as they happen (admin key). It needs a URL GitHub can reach that forwards to this hub,
             which fleetd never creates; without one the hub syncs with GitHub on its own
"#;

/// The longest status_wait the hub takes; the CLI asks again right after an unchanged answer.
const WAIT_SEC: u64 = 50;
/// Reconnect backoff after the hub stops answering, in seconds.
const BACKOFF: &[u64] = &[1, 2, 5, 10, 30];

#[derive(Debug, PartialEq)]
pub struct StatusArgs {
    /// Both, or neither for the hub on this machine.
    pub hub: Option<(String, String)>,
    /// The order id or project as given; empty for the fleet.
    pub target: String,
    pub watch: bool,
    pub json: bool,
}

fn hub_flags(v: &args::Parsed) -> Result<Option<(String, String)>, String> {
    match (
        v.str("hub").filter(|s| !s.is_empty()),
        v.str("key-file").filter(|s| !s.is_empty()),
    ) {
        (Some(hub), Some(key_file)) => Ok(Some((hub.to_owned(), key_file.to_owned()))),
        (None, None) => Ok(None),
        (Some(_), None) => Err("--hub needs --key-file".into()),
        (None, Some(_)) => Err("--key-file needs --hub".into()),
    }
}

pub fn parse_status_args(argv: &[String]) -> Result<StatusArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("watch", Kind::Bool),
        ("json", Kind::Bool),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    if v.positionals.len() > 1 {
        return Err(format!(
            "give one order or project, got '{}'",
            v.positionals.join(" ")
        ));
    }
    Ok(StatusArgs {
        hub: hub_flags(&v)?,
        target: v.positionals.first().cloned().unwrap_or_default(),
        watch: v.flag("watch"),
        json: v.flag("json"),
    })
}

/// The project a name means, from `projects_list`: its id, its title or its folder's name, optionally after
/// `<machine>/`. Several machines with the same name need the machine.
pub fn resolve_project(name: &str, projects: &[Value]) -> Result<Value, String> {
    let (machine, rest) = match name.split_once('/') {
        Some((m, rest)) if super::is_machine_id(m) => (Some(m), rest),
        _ => (None, name),
    };
    let found: Vec<&Value> = projects
        .iter()
        .filter(|p| machine.is_none_or(|m| st(p, "machineId") == m))
        .filter(|p| {
            let folder = st(p, "workspaceRoot").rsplit('/').next().unwrap_or("");
            [st(p, "projectId"), st(p, "title"), folder].contains(&rest)
        })
        .collect();
    match found.as_slice() {
        [one] => {
            Ok(json!({ "machineId": st(one, "machineId"), "projectId": st(one, "projectId") }))
        }
        [] => Err(format!(
            "no order or project '{name}'; projects: {}",
            projects
                .iter()
                .map(|p| format!("{}/{}", st(p, "machineId"), st(p, "title")))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        many => Err(format!(
            "'{name}' is on several machines; say which: {}",
            many.iter()
                .map(|p| format!("{}/{rest}", st(p, "machineId")))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

// ---- reading the doc ----

fn st<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn opt<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn arr<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn num(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_f64).map(|n| n as i64)
}

/// The words of a marker, gate, risk or evidence: a string, or the first text field of an object.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Object(_) => ["text", "label", "message", "note", "title"]
            .iter()
            .map(|k| st(value, k))
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_owned(),
        _ => String::new(),
    }
}

/// `P12 full lab run`, or the order a virtual item stands for.
fn item_label(item: &Value) -> String {
    let item = opt(item, "item").unwrap_or(item);
    let id = ["itemId", "id", "workstreamId"]
        .iter()
        .map(|k| st(item, k))
        .find(|s| !s.is_empty())
        .unwrap_or("");
    let title = st(item, "title");
    match (id, title) {
        ("", t) => t.to_owned(),
        (i, "") => i.to_owned(),
        (i, t) => format!("{i} {t}"),
    }
}

fn parse_time(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// `14:02:07` on the doc's day, `Thu 14:02` within a week, `2026-10-12 14:02` before that.
fn clock(iso: &str, now: Option<DateTime<Utc>>, zone: Tz, seconds: bool) -> String {
    let Some(at) = parse_time(iso) else {
        return iso.to_owned();
    };
    let local = at.with_timezone(&zone);
    let today = now.map(|n| n.with_timezone(&zone).date_naive());
    let days = today.map(|d| (local.date_naive() - d).num_days().abs());
    match days {
        Some(0) if seconds => local.format("%H:%M:%S").to_string(),
        Some(0) => local.format("%H:%M").to_string(),
        Some(1..=6) => local.format("%a %H:%M").to_string(),
        _ => local.format("%Y-%m-%d %H:%M").to_string(),
    }
}

/// `10m46s`, `2h05m`.
fn dur(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m{:02}s", s / 60, s % 60),
        _ => format!("{}h{:02}m", s / 3600, s / 60 % 60),
    }
}

/// Where the doc says a source is stale: `(since, reason)`.
fn stale_of<'a>(doc: &'a Value, source: &str) -> Option<&'a Value> {
    arr(doc, "stale").iter().find(|s| st(s, "source") == source)
}

struct Ctx {
    now: Option<DateTime<Utc>>,
    zone: Tz,
}

impl Ctx {
    fn at(&self, iso: &str) -> String {
        clock(iso, self.now, self.zone, false)
    }
    fn at_s(&self, iso: &str) -> String {
        clock(iso, self.now, self.zone, true)
    }
}

/// One table column of label + body, the body's later lines indented under the first.
fn section(out: &mut Vec<String>, label: &str, lines: &[String]) {
    for (i, line) in lines.iter().enumerate() {
        let head = if i == 0 { label } else { "" };
        out.push(format!("{head:<8}{line}").trim_end().to_owned());
    }
}

fn health_line(doc: &Value, c: &Ctx) -> String {
    let health = opt(doc, "health").cloned().unwrap_or(Value::Null);
    let mut parts: Vec<String> = Vec::new();
    for ci in arr(&health, "ci") {
        let repo = st(ci, "repo");
        let failing: Vec<&str> = arr(ci, "failing")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let state = match st(ci, "state") {
            "red" if !failing.is_empty() => format!("red ({})", failing.join(", ")),
            "" => "unknown".into(),
            other => other.to_owned(),
        };
        let stale = stale_of(doc, &format!("github:{repo}"))
            .map(|s| format!(" (stale since {})", c.at_s(st(s, "since"))))
            .unwrap_or_default();
        let as_of = opt(ci, "asOf")
            .and_then(Value::as_str)
            .map(|t| format!(" as of {}", c.at_s(t)))
            .unwrap_or_default();
        parts.push(format!("main CI {repo} {state}{as_of}{stale}"));
    }
    let machines = arr(&health, "machines");
    let online = machines
        .iter()
        .filter(|m| {
            st(m, "status") == "online"
                && stale_of(doc, &format!("machine:{}", st(m, "machineId"))).is_none()
        })
        .count();
    if !machines.is_empty() {
        parts.push(format!("{online} of {} machines online", machines.len()));
    }
    for m in machines {
        let id = st(m, "machineId");
        let stale = stale_of(doc, &format!("machine:{id}"));
        let status = st(m, "status");
        if status != "online" || stale.is_some() {
            let seen = opt(m, "lastSeenAt")
                .and_then(Value::as_str)
                .map(|t| format!(" last seen {}", c.at_s(t)))
                .unwrap_or_default();
            let word = if status == "degraded" {
                "DEGRADED"
            } else {
                "OFFLINE"
            };
            parts.push(format!(
                "{id} {word}{seen}{}",
                if stale.is_some() { " (stale)" } else { "" }
            ));
        }
        if let Some(slept) = opt(m, "slept") {
            let (from, to) = (num(slept, "fromMs"), num(slept, "toMs"));
            if let (Some(from), Some(to)) = (from, to) {
                let at = Utc
                    .timestamp_millis_opt(from)
                    .single()
                    .map(|t| c.at(&t.to_rfc3339()))
                    .unwrap_or_default();
                parts.push(format!("{id} slept {} at {at}", dur(to - from)));
            }
        }
    }
    if let Some(usage) = opt(&health, "usage") {
        let limits = usage
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_else(|| arr(usage, "limits"));
        let shown: Vec<String> = limits
            .iter()
            .filter_map(|l| {
                let pct = l.get("utilization").and_then(Value::as_f64)?;
                let kind = match st(l, "limitType") {
                    "five_hour" => "5h",
                    "seven_day" | "weekly" => "wk",
                    other => other,
                };
                let stale = opt(l, "stale").and_then(Value::as_bool) == Some(true)
                    || !st(l, "staleReason").is_empty();
                Some(format!(
                    "{}% {kind}{}",
                    (pct * 100.0).round() as i64,
                    if stale { " (stale)" } else { "" }
                ))
            })
            .collect();
        if !shown.is_empty() {
            parts.push(format!("claude {}", shown.join(" ")));
        }
    }
    if let Some(slots) = opt(&health, "slots") {
        let queued = num(slots, "queued").unwrap_or(0);
        parts.push(format!(
            "slots {}/{}{}",
            num(slots, "used").unwrap_or(0),
            num(slots, "cap").unwrap_or(0),
            if queued > 0 {
                format!(", {queued} queued")
            } else {
                String::new()
            }
        ));
    }
    parts.join(" · ")
}

/// What `fleetd status` prints for one doc. `label` names the scope as the user typed it.
pub fn render(doc: &Value, label: &str, zone: Tz) -> String {
    let c = Ctx {
        now: parse_time(st(doc, "now")),
        zone,
    };
    let mut out: Vec<String> = Vec::new();
    let progress = opt(doc, "progress").cloned().unwrap_or(Value::Null);
    let stale = arr(doc, "stale");
    let live = if stale.is_empty() {
        "live".to_owned()
    } else {
        format!(
            "NOT LIVE: {} stale source{}",
            stale.len(),
            if stale.len() == 1 { "" } else { "s" }
        )
    };
    let pct = num(&progress, "pct")
        .map(|p| format!("{p}%"))
        .unwrap_or_else(|| "—".into());
    let polish = num(&progress, "polishPct")
        .map(|p| format!("  polish {p}%"))
        .unwrap_or_default();
    out.push(format!(
        "{label}  {pct}{polish}    as of {} ({live})",
        c.at_s(st(doc, "now"))
    ));
    if let (Some(done), Some(total)) = (num(&progress, "done"), num(&progress, "total")) {
        out.push(format!("  {done} of {total} required points verified"));
    }
    for marker in opt(&progress, "marker")
        .into_iter()
        .chain(arr(doc, "markers"))
    {
        let text = text_of(marker);
        if !text.is_empty() {
            out.push(format!("  {text}"));
        }
    }
    if let Some(headline) = opt(doc, "headline") {
        let tag = match (st(headline, "source"), opt(headline, "reason")) {
            ("generated", _) => "[generated]".to_owned(),
            (_, Some(reason)) => format!("[template: {}]", text_of(reason)),
            _ => "[template]".to_owned(),
        };
        out.push(format!("  {}   {tag}", st(headline, "text")));
    }
    if let Some(eta) = opt(doc, "eta") {
        let samples = num(eta, "samples").unwrap_or(0);
        let line = match opt(eta, "current").and_then(Value::as_str) {
            None => format!("measuring: {samples} of 5 verified"),
            Some(current) => {
                let planned = opt(eta, "original")
                    .and_then(Value::as_str)
                    .map(|o| format!("   planned {}", c.at(o)))
                    .unwrap_or_default();
                let lead = opt(eta, "lead")
                    .and_then(Value::as_str)
                    .map(|l| format!("   lead estimated {}", c.at(l)))
                    .unwrap_or_default();
                let basis = match st(eta, "basis") {
                    "" => String::new(),
                    b => format!(", {b}"),
                };
                format!(
                    "{}{planned}{lead}   {samples} samples{basis}",
                    c.at(current)
                )
            }
        };
        out.push(format!("  eta {line}"));
    }
    let gates: Vec<String> = arr(doc, "gates")
        .iter()
        .map(|g| {
            let serial = g.get("serial").and_then(Value::as_bool) == Some(true);
            format!("{}{}", text_of(g), if serial { " (serial)" } else { "" })
        })
        .filter(|g| !g.is_empty())
        .collect();
    if !gates.is_empty() {
        out.push(format!("  waiting on  {}", gates.join("; ")));
    }
    if let Some(since) = opt(doc, "since") {
        let mut counts: Vec<String> = [
            ("merged", "merged"),
            ("verified", "verified"),
            ("started", "started"),
            ("failed", "failed"),
            ("asked", "asked"),
        ]
        .iter()
        .filter_map(|(key, word)| {
            num(since, key)
                .filter(|n| *n != 0)
                .map(|n| format!("{n} {word}"))
        })
        .collect();
        if let Some(items) = num(since, "scopeItems").filter(|n| *n != 0) {
            counts.push(format!("{items:+} items"));
        }
        let from = opt(since, "seenAt")
            .and_then(Value::as_str)
            .map(|t| c.at(t))
            .unwrap_or_else(|| "first look".into());
        let what = if counts.is_empty() {
            "nothing new".into()
        } else {
            counts.join(", ")
        };
        out.push(format!("  since {from}  {what}"));
    }
    let health = health_line(doc, &c);
    if !health.is_empty() {
        section(&mut out, "health", &[health]);
    }
    let stale_lines: Vec<String> = stale
        .iter()
        .map(|s| {
            format!(
                "{} since {}: {}",
                st(s, "source"),
                c.at_s(st(s, "since")),
                st(s, "reason")
            )
        })
        .collect();
    section(&mut out, "stale", &stale_lines);
    if let Some(needs) = opt(doc, "needsYou").filter(|n| num(n, "count").unwrap_or(0) > 0) {
        let asks: Vec<&str> = arr(needs, "askIds")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        section(
            &mut out,
            "needs",
            &[format!(
                "{} need you: {} (answer in the app's inbox)",
                num(needs, "count").unwrap_or(0),
                asks.join(", ")
            )],
        );
    }
    let risks: Vec<String> = arr(doc, "risks").iter().map(text_of).collect();
    section(&mut out, "risks", &risks);
    let doing: Vec<String> = arr(doc, "inProgress")
        .iter()
        .map(|row| {
            let mut cells = vec![item_label(row)];
            let tasks: Vec<&str> = arr(row, "taskIds")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            if !tasks.is_empty() {
                cells.push(tasks.join(","));
            }
            if let Some(gate) = opt(row, "gate") {
                cells.push(text_of(gate));
            }
            if let Some(eta) = opt(row, "eta").and_then(Value::as_str) {
                cells.push(format!("eta {}", c.at(eta)));
            }
            if let Some(stale) = opt(row, "stale") {
                let why = text_of(stale);
                cells.push(if why.is_empty() {
                    "(stale)".into()
                } else {
                    format!("(stale: {why})")
                });
            }
            cells.join("   ")
        })
        .collect();
    section(&mut out, "doing", &doing);
    let next: Vec<String> = arr(doc, "next").iter().map(item_label).collect();
    if !next.is_empty() {
        section(&mut out, "next", &[next.join(", ")]);
    }
    let done: Vec<String> = arr(doc, "done")
        .iter()
        .map(|row| match opt(row, "evidence").map(text_of) {
            Some(evidence) if !evidence.is_empty() => format!("{}   {evidence}", item_label(row)),
            _ => item_label(row),
        })
        .collect();
    section(&mut out, "done", &done);
    if let Some(more) = opt(doc, "more").and_then(Value::as_object) {
        let hidden: Vec<String> = more
            .iter()
            .filter_map(|(k, v)| {
                v.as_f64()
                    .filter(|n| *n > 0.0)
                    .map(|_| format!("{} more {k}", js_number(v)))
            })
            .collect();
        if !hidden.is_empty() {
            out.push(format!("({}; the app shows them all)", hidden.join(", ")));
        }
    }
    out.join("\n")
}

/// What `fleetd status --watch` prints above the last doc when the hub stops answering. It is the CLI's own
/// connection, not a judgement on the hub's data.
pub fn not_live_banner(last_now: &str, zone: Tz, reason: &str) -> String {
    let now = parse_time(last_now);
    format!(
        "NOT LIVE: reconnecting to the hub ({reason}) · data from {}",
        clock(last_now, now, zone, true)
    )
}

// ---- talking to the hub ----

enum Target {
    Remote { url: String, key: String },
    Local { home: PathBuf },
}

impl Target {
    fn from_args(hub: &Option<(String, String)>, who: &str) -> Result<Self, u8> {
        match hub {
            Some((url, key_file)) => match std::fs::read_to_string(key_file) {
                Ok(key) => Ok(Target::Remote {
                    url: url.clone(),
                    key: key.trim().to_owned(),
                }),
                Err(error) => {
                    eprintln!("fleetd {who}: cannot read --key-file: {error}");
                    Err(2)
                }
            },
            None => match super::hub_key::resolve_home(None) {
                Ok(home) => Ok(Target::Local { home }),
                Err(message) => {
                    eprintln!(
                        "fleetd {who}: {message}\n  fix: run it on the hub machine, or pass --hub <url> --key-file <path>"
                    );
                    Err(4)
                }
            },
        }
    }

    async fn connect(&self, client_name: &str) -> Result<McpClient, (u8, String)> {
        match self {
            Target::Remote { url, key } => {
                McpClient::connect(url, key, client_name, Duration::from_secs(15))
                    .await
                    .map_err(|error| (exit_for(&error), error.message()))
            }
            Target::Local { home } => super::setup::doctor::connect_as(home, client_name)
                .await
                .map_err(|failure| {
                    (
                        4,
                        format!(
                            "{}\n  fix: run it on the hub machine, or pass --hub <url> --key-file <path>",
                            failure.message
                        ),
                    )
                }),
        }
    }
}

fn exit_for(error: &McpError) -> u8 {
    match error {
        McpError::Unauthorized => 3,
        McpError::Other(_) => 4,
    }
}

enum CallError {
    /// The hub could not be reached; worth reconnecting.
    Transport(McpError),
    /// The hub answered with a refusal: exit with this code after printing.
    Refused(String),
}

async fn call(
    client: &mut McpClient,
    tool: &str,
    input: Value,
    timeout: Duration,
) -> Result<Value, CallError> {
    match client.call_tool(tool, input, timeout).await {
        Err(error) => Err(CallError::Transport(error)),
        Ok(result) if result.is_error => {
            let text = |k: &str| result.body.get(k).and_then(Value::as_str);
            let fix = text("fix")
                .map(|f| format!("\n  fix: {f}"))
                .unwrap_or_default();
            Err(CallError::Refused(format!(
                "{}{fix}",
                text("message").unwrap_or("the hub refused")
            )))
        }
        Ok(result) => Ok(result.body),
    }
}

fn fail(who: &str, error: CallError) -> u8 {
    match error {
        CallError::Transport(error) => {
            eprintln!("fleetd {who}: {}", error.message());
            exit_for(&error)
        }
        CallError::Refused(message) => {
            eprintln!("fleetd {who}: {message}");
            3
        }
    }
}

async fn scope_for(client: &mut McpClient, target: &str) -> Result<Value, u8> {
    if target.is_empty() {
        return Ok(json!({ "kind": "fleet" }));
    }
    if WorkstreamId::new(target).is_ok() {
        return Ok(json!({ "kind": "order", "workstreamId": target }));
    }
    let listed = call(client, "projects_list", json!({}), Duration::from_secs(30))
        .await
        .map_err(|e| fail("status", e))?;
    match resolve_project(target, arr(&listed, "projects")) {
        Ok(project_ref) => Ok(json!({ "kind": "project", "projectRef": project_ref })),
        Err(error) => {
            eprintln!("fleetd status: {error}");
            Err(2)
        }
    }
}

struct Printer {
    json: bool,
    tty: bool,
    label: String,
    zone: Tz,
}

impl Printer {
    fn show(&self, doc: &Value, banner: Option<&str>) {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            let _ = writeln!(stdout, "{doc}");
            return;
        }
        let mut text = render(doc, &self.label, self.zone);
        if let Some(banner) = banner {
            text = format!("{banner}\n{text}");
        }
        if self.tty {
            // Home, clear: the new version replaces the old in place.
            let _ = writeln!(stdout, "\x1b[H\x1b[2J{text}");
        } else {
            let _ = writeln!(stdout, "{text}\n");
        }
        let _ = stdout.flush();
    }

    fn banner(&self, line: &str) {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            let _ = writeln!(stdout, "{}", json!({ "notLive": line }));
        } else if self.tty {
            // Top line, cleared, then back: the last doc stays on screen under the banner.
            let _ = write!(stdout, "\x1b7\x1b[H\x1b[2K{line}\x1b8");
        } else {
            let _ = writeln!(stdout, "{line}\n");
        }
        let _ = stdout.flush();
    }
}

async fn record_seen(client: &mut McpClient, scope: &Value, doc: &Value) {
    if let Some(seq) = doc.get("seq").filter(|s| s.is_number()) {
        // An agent key is told {recorded:false}; nothing to say about it either way.
        let _ = call(
            client,
            "status_seen",
            json!({ "scope": scope, "seq": seq }),
            Duration::from_secs(10),
        )
        .await;
    }
}

/// `fleetd status …`: exit 0, 2 on bad arguments, 3 when the hub refused the key or the call, 4 when it cannot be
/// reached.
pub async fn status_command(argv: &[String]) -> u8 {
    let args = match parse_status_args(argv) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{STATUS_USAGE}");
            return 2;
        }
    };
    let target = match Target::from_args(&args.hub, "status") {
        Ok(target) => target,
        Err(code) => return code,
    };
    let mut client = match target.connect("fleetd-status").await {
        Ok(client) => client,
        Err((code, message)) => {
            eprintln!("fleetd status: {message}");
            return code;
        }
    };
    let scope = match scope_for(&mut client, &args.target).await {
        Ok(scope) => scope,
        Err(code) => return code,
    };
    let printer = Printer {
        json: args.json,
        tty: args.watch && !args.json && std::io::stdout().is_terminal(),
        label: if args.target.is_empty() {
            "fleet".into()
        } else {
            args.target.clone()
        },
        zone: crate::hub::attention::hub_zone(),
    };
    let get = json!({ "scope": scope });
    let mut doc = match call(
        &mut client,
        "status_get",
        get.clone(),
        Duration::from_secs(30),
    )
    .await
    {
        Ok(doc) => doc,
        Err(error) => return fail("status", error),
    };
    printer.show(&doc, None);
    if args.watch {
        let mut stop = super::Stop::on_signals();
        loop {
            let after = doc.get("version").cloned().unwrap_or(json!(0));
            let wait = json!({ "scope": scope, "after": after, "timeoutSec": WAIT_SEC });
            let answer = tokio::select! {
                _ = stop.wait() => break,
                answer = call(&mut client, "status_wait", wait, Duration::from_secs(WAIT_SEC + 15)) => answer,
            };
            match answer {
                Ok(body) if body.get("unchanged") == Some(&Value::Bool(true)) => {}
                Ok(body) => {
                    doc = body;
                    printer.show(&doc, None);
                }
                Err(CallError::Refused(message)) => {
                    eprintln!("fleetd status: {message}");
                    return 3;
                }
                Err(CallError::Transport(McpError::Unauthorized)) => {
                    eprintln!("fleetd status: the hub refused the key (401)");
                    return 3;
                }
                Err(CallError::Transport(McpError::Other(reason))) => {
                    printer.banner(&not_live_banner(st(&doc, "now"), printer.zone, &reason));
                    let mut attempt = 0;
                    loop {
                        let delay = BACKOFF[attempt.min(BACKOFF.len() - 1)];
                        attempt += 1;
                        if stop.sleep(Duration::from_secs(delay)).await {
                            // Interrupted while away: nothing more was seen than what is on screen.
                            return 0;
                        }
                        let Ok(mut fresh) = target.connect("fleetd-status").await else {
                            continue;
                        };
                        if let Ok(body) = call(
                            &mut fresh,
                            "status_get",
                            get.clone(),
                            Duration::from_secs(30),
                        )
                        .await
                        {
                            client = fresh;
                            doc = body;
                            printer.show(&doc, None);
                            break;
                        }
                    }
                }
            }
        }
    }
    record_seen(&mut client, &scope, &doc).await;
    0
}

/// `fleetd hub github-webhook --url <url> | --off`.
pub async fn github_webhook_command(argv: &[String]) -> u8 {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("url", Kind::Str),
        ("off", Kind::Bool),
    ];
    let parsed = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: false,
        },
    )
    .and_then(|v| {
        let hub = hub_flags(&v)?;
        match (v.string("url").filter(|u| !u.is_empty()), v.flag("off")) {
            (Some(url), false) if url.starts_with("https://") || url.starts_with("http://") => {
                Ok((hub, Some(url)))
            }
            (Some(url), false) => Err(format!("--url must be an http(s) URL, got '{url}'")),
            (None, true) => Ok((hub, None)),
            _ => Err("give exactly one of --url <public url>/github and --off".into()),
        }
    });
    let (hub, url) = match parsed {
        Ok(parsed) => parsed,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{GITHUB_WEBHOOK_USAGE}");
            return 2;
        }
    };
    let target = match Target::from_args(&hub, "hub github-webhook") {
        Ok(target) => target,
        Err(code) => return code,
    };
    let mut client = match target.connect("fleetd-github-webhook").await {
        Ok(client) => client,
        Err((code, message)) => {
            eprintln!("fleetd hub github-webhook: {message}");
            return code;
        }
    };
    let input = match &url {
        Some(url) => json!({ "url": url }),
        None => json!({}),
    };
    match call(
        &mut client,
        "github_webhook_set",
        input,
        Duration::from_secs(120),
    )
    .await
    {
        Err(error) => fail("hub github-webhook", error),
        Ok(body) => {
            let repos = arr(&body, "repos");
            match url {
                Some(url) => {
                    println!(
                        "GitHub webhooks on: {} repo{} send to {url}",
                        repos.len(),
                        if repos.len() == 1 { "" } else { "s" }
                    );
                    for r in repos {
                        println!("  {} hook {}", st(r, "repo"), js_number(&r["hookId"]));
                    }
                    println!(
                        "The hub keeps syncing on its own too; a missed delivery only makes it sync more often for a while."
                    );
                }
                None => println!("GitHub webhooks off; the hub syncs with GitHub on its own."),
            }
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc() -> Tz {
        chrono_tz::UTC
    }

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn arguments() {
        let a = parse_status_args(&argv(&["W41", "--watch"])).unwrap();
        assert_eq!(
            (a.target.as_str(), a.watch, a.json, a.hub),
            ("W41", true, false, None)
        );
        assert_eq!(parse_status_args(&argv(&[])).unwrap().target, "");
        assert!(parse_status_args(&argv(&["a", "b"])).is_err());
        assert_eq!(
            parse_status_args(&argv(&["--hub", "http://h"])).unwrap_err(),
            "--hub needs --key-file"
        );
    }

    fn doc() -> Value {
        json!({
            "scope": { "kind": "project" }, "version": 7, "seq": 120, "now": "2026-10-18T14:02:07Z",
            "progress": { "pct": 61, "polishPct": 40, "done": 11, "total": 18, "asOf": "2026-10-18T14:02:07Z" },
            "markers": ["↓ from 69% · +3 items: time inspector added (14:00)"],
            "eta": { "current": "2026-10-22T14:00:00Z", "original": "2026-10-21T18:00:00Z", "samples": 18, "basis": "measured" },
            "gates": [{ "label": "P12 full lab run", "serial": true }, { "label": "CI on #212" }],
            "headline": { "text": "Not live: lab-b silent. Switching to the new runner.", "source": "generated", "at": "2026-10-18T14:02:00Z" },
            "since": { "seenAt": "2026-10-18T09:12:00Z", "merged": 7, "verified": 3, "started": 0, "failed": 1, "asked": 0, "scopeItems": 3 },
            "inProgress": [{ "item": { "itemId": "P12", "title": "full lab run" }, "taskIds": ["T88"], "eta": "2026-10-18T14:40:00Z" }],
            "next": [{ "itemId": "P14", "title": "switch default runner" }],
            "done": [{ "item": { "itemId": "P9", "title": "node outbox" }, "evidence": "#208 merged by the train 13:12" }],
            "needsYou": { "count": 0, "askIds": [] },
            "risks": [{ "rule": "machine_offline", "message": "lab-b offline (2 tasks waiting)" }],
            "health": {
                "ci": [{ "repo": "acme/storefront", "state": "red", "failing": ["rust (macos)"], "asOf": "2026-10-18T14:01:50Z" }],
                "machines": [
                    { "machineId": "devbox", "status": "online", "lastSeenAt": "2026-10-18T14:02:00Z" },
                    { "machineId": "lab-b", "status": "offline", "lastSeenAt": "2026-10-18T13:58:07Z" }
                ],
                "usage": [{ "limitType": "five_hour", "utilization": 0.58 }],
                "slots": { "cap": 40, "used": 8, "queued": 1 }
            },
            "stale": [{ "source": "machine:lab-b", "since": "2026-10-18T13:58:52Z", "reason": "no heartbeat from lab-b for 4m" }]
        })
    }

    #[test]
    fn a_stale_machine_reads_not_live_and_offline_with_absolute_times() {
        let text = render(&doc(), "storefront", utc());
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            "storefront  61%  polish 40%    as of 14:02:07 (NOT LIVE: 1 stale source)"
        );
        assert!(
            text.contains("  eta Thu 14:00   planned Wed 18:00   18 samples, measured"),
            "{text}"
        );
        assert!(text.contains("  waiting on  P12 full lab run (serial); CI on #212"));
        assert!(text.contains("  since 09:12  7 merged, 3 verified, 1 failed, +3 items"));
        assert!(text.contains(
            "health  main CI acme/storefront red (rust (macos)) as of 14:01:50 · 1 of 2 machines online · lab-b OFFLINE last seen 13:58:07 (stale) · claude 58% 5h · slots 8/40, 1 queued"
        ), "{text}");
        assert!(
            text.contains("stale   machine:lab-b since 13:58:52: no heartbeat from lab-b for 4m")
        );
        assert!(text.contains("doing   P12 full lab run   T88   eta 14:40"));
        assert!(text.contains("done    P9 node outbox   #208 merged by the train 13:12"));
        assert!(!text.contains("needs"), "zero asks print nothing");
    }

    #[test]
    fn a_clean_doc_is_live_and_a_stale_ci_source_is_marked() {
        let mut d = doc();
        d["stale"] = json!([]);
        assert!(
            render(&d, "fleet", utc())
                .lines()
                .next()
                .unwrap()
                .ends_with("(live)")
        );
        d["stale"] = json!([{ "source": "github:acme/storefront", "since": "2026-10-18T14:00:00Z", "reason": "gh: connect: network is unreachable" }]);
        let text = render(&d, "fleet", utc());
        assert!(
            text.contains("as of 14:01:50 (stale since 14:00:00)"),
            "{text}"
        );
    }

    #[test]
    fn eta_without_samples_says_so() {
        let mut d = doc();
        d["eta"] = json!({ "samples": 2, "basis": "fleet" });
        assert!(render(&d, "W41", utc()).contains("  eta measuring: 2 of 5 verified"));
    }

    #[test]
    fn the_not_live_banner_names_when_the_data_is_from() {
        assert_eq!(
            not_live_banner("2026-10-18T14:02:07Z", utc(), "connection refused"),
            "NOT LIVE: reconnecting to the hub (connection refused) · data from 14:02:07"
        );
    }

    #[test]
    fn a_project_by_id_title_or_folder() {
        let projects = vec![
            json!({ "machineId": "devbox", "projectId": "p1", "title": "storefront", "workspaceRoot": "/srv/storefront" }),
            json!({ "machineId": "buildbox", "projectId": "p2", "title": "storefront", "workspaceRoot": "/w/sf" }),
        ];
        assert!(
            resolve_project("storefront", &projects)
                .unwrap_err()
                .contains("several machines")
        );
        assert_eq!(
            resolve_project("buildbox/sf", &projects).unwrap(),
            json!({ "machineId": "buildbox", "projectId": "p2" })
        );
    }
}
