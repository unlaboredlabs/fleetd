//! `fleetd status`: an order's, a project's or the fleet's progress, read from the hub's status doc (status_get) and,
//! with `--watch`, kept current by status_wait, which blocks on the hub until the doc changes. It lays out only what
//! the hub decided: the number, the ETA, and which parts are stale. Every time printed is absolute, so a block left on
//! screen never reads as fresher than it is. Also `fleetd hub github-webhook`, which wraps github_webhook_set.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{StatusGetOutput, StatusWaitOutput};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::plan::PlanItemId;
use fleetd_contracts::status::{
    CiState, EtaBasis, HeadlineSource, Health, MIN_SAMPLES, Marker, RiskLevel, Since, StaleMark,
    StatusDoc, StatusEta, StatusScope,
};
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

fn arr<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn parse_time(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|t| t.with_timezone(&Utc))
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

/// `+6h`, `+40m`, `-1h30m`.
fn signed_minutes(minutes: i64) -> String {
    let sign = if minutes < 0 { "-" } else { "+" };
    let m = minutes.abs();
    match (m / 60, m % 60) {
        (0, m) => format!("{sign}{m}m"),
        (h, 0) => format!("{sign}{h}h"),
        (h, m) => format!("{sign}{h}h{m:02}m"),
    }
}

/// Absolute times in the hub machine's zone, relative to the doc's own `now`, so nothing printed ever ticks.
struct Clock {
    now: Option<DateTime<Utc>>,
    zone: Tz,
}

impl Clock {
    /// `14:02:07` on the doc's day (with `seconds`), `14:02`, `Thu 14:02` within a week, else the date.
    fn fmt(&self, at: &Timestamp, seconds: bool) -> String {
        let Some(at) = parse_time(&at.0) else {
            return at.0.clone();
        };
        let local = at.with_timezone(&self.zone);
        let days = self
            .now
            .map(|n| (local.date_naive() - n.with_timezone(&self.zone).date_naive()).num_days());
        match days {
            Some(0) if seconds => local.format("%H:%M:%S").to_string(),
            Some(0) => local.format("%H:%M").to_string(),
            Some(-6..=6) => local.format("%a %H:%M").to_string(),
            _ => local.format("%Y-%m-%d %H:%M").to_string(),
        }
    }
    fn at(&self, at: &Timestamp) -> String {
        self.fmt(at, false)
    }
    fn at_s(&self, at: &Timestamp) -> String {
        self.fmt(at, true)
    }
    fn ms(&self, ms: i64) -> String {
        Utc.timestamp_millis_opt(ms)
            .single()
            .map(|t| self.at(&Timestamp(t.to_rfc3339())))
            .unwrap_or_default()
    }
    fn stale(&self, mark: &StaleMark) -> String {
        format!("stale since {}: {}", self.at_s(&mark.since), mark.reason)
    }
}

/// One labelled block: the label in an 8-wide column, later lines indented under the first.
fn section(out: &mut Vec<String>, label: &str, lines: &[String]) {
    for (i, line) in lines.iter().enumerate() {
        let head = if i == 0 { label } else { "" };
        out.push(format!("{head:<8}{line}").trim_end().to_owned());
    }
}

fn marker_text(marker: &Marker, pct: i64, c: &Clock) -> String {
    let from = match marker.pct_before.map(|p| p.get()) {
        Some(before) if before > pct => format!("↓ from {before}% · "),
        Some(before) if before < pct => format!("↑ from {before}% · "),
        _ => String::new(),
    };
    format!("{from}{} ({})", marker.text, c.at(&marker.at))
}

fn eta_line(eta: &StatusEta, c: &Clock) -> String {
    let samples = eta.samples.get();
    let Some(current) = eta.current.as_ref().filter(|_| eta.basis != EtaBasis::None) else {
        return format!("measuring: {samples} of {MIN_SAMPLES} verified");
    };
    let mut parts = vec![c.at(current)];
    if let Some(original) = &eta.original {
        let slip = eta
            .slip
            .as_ref()
            .map(|s| {
                format!(
                    " ({} scope, {} slower)",
                    signed_minutes(s.scope_minutes.get()),
                    signed_minutes(s.speed_minutes.get())
                )
            })
            .unwrap_or_default();
        parts.push(format!("planned {}{slip}", c.at(original)));
    }
    if let Some(lead) = &eta.lead {
        parts.push(format!(
            "lead estimated {}; measured speed wins",
            c.at(lead)
        ));
    }
    let rate = eta
        .rate
        .map(|r| format!("{:.1} pts/busy h, ", r.get()))
        .unwrap_or_default();
    let basis = match eta.basis {
        EtaBasis::Order | EtaBasis::None => "",
        EtaBasis::Project => " (project's speed)",
        EtaBasis::Fleet => " (fleet's speed)",
    };
    parts.push(format!("{rate}{samples} samples{basis}"));
    if let Some(chain) = &eta.chain {
        parts.push(format!("set by {chain}"));
    }
    parts.join("   ")
}

fn since_line(since: &Since, c: &Clock) -> String {
    let mut counts: Vec<String> = [
        (since.merged, "merged"),
        (since.verified, "verified"),
        (since.started, "started"),
        (since.failed, "failed"),
        (since.asked, "asked"),
    ]
    .iter()
    .filter(|(n, _)| n.get() != 0)
    .map(|(n, word)| format!("{} {word}", n.get()))
    .collect();
    if since.scope_items.get() != 0 {
        counts.push(format!("{:+} items", since.scope_items.get()));
    }
    let from = match (&since.seen_at, since.pruned) {
        (_, Some(true)) => "you last looked here, more than 30 days ago".to_owned(),
        (Some(at), _) => format!("you last looked here {}", c.at(at)),
        (None, _) => "your first look from here".to_owned(),
    };
    let what = if counts.is_empty() {
        "nothing new".to_owned()
    } else {
        counts.join(", ")
    };
    format!("since {from}  {what}")
}

fn health_line(health: &Health, c: &Clock) -> String {
    let mut parts: Vec<String> = Vec::new();
    for ci in health.ci.iter() {
        let failing: Vec<&str> = ci.failing.iter().map(|f| f.as_str()).collect();
        let state = match ci.state {
            CiState::Green => "green".to_owned(),
            CiState::Red if failing.is_empty() => "RED".to_owned(),
            CiState::Red => format!("RED ({})", failing.join(", ")),
            CiState::Pending => "pending".to_owned(),
            CiState::Unknown => "not checked yet".to_owned(),
        };
        let as_of = ci
            .as_of
            .as_ref()
            .map(|t| format!(" as of {}", c.at_s(t)))
            .unwrap_or_default();
        let stale = ci
            .stale
            .as_ref()
            .map(|s| format!(" ({})", c.stale(s)))
            .unwrap_or_default();
        parts.push(format!(
            "main CI {} {state}{as_of}{stale}",
            ci.repo.as_str()
        ));
    }
    let machines = &health.machines;
    if !machines.is_empty() {
        let online = machines
            .iter()
            .filter(|m| m.status == MachineStatus::Online && m.stale.is_none())
            .count();
        parts.push(format!("{online} of {} machines online", machines.len()));
    }
    for m in machines.iter() {
        let id = m.machine_id.as_str();
        if m.status != MachineStatus::Online || m.stale.is_some() {
            let word = match m.status {
                MachineStatus::Degraded => "DEGRADED",
                _ => "OFFLINE",
            };
            let seen = m
                .last_seen_at
                .as_ref()
                .map(|t| format!(" last seen {}", c.at_s(t)))
                .unwrap_or_default();
            let stale = if m.stale.is_some() { " (stale)" } else { "" };
            parts.push(format!("{id} {word}{seen}{stale}"));
        }
        if let Some(slept) = m.slept {
            parts.push(format!(
                "{id} slept {} at {}",
                dur(slept.to_ms.get() - slept.from_ms.get()),
                c.ms(slept.from_ms.get())
            ));
        }
    }
    let usage: Vec<String> = health
        .usage
        .iter()
        .filter_map(|u| {
            let pct = (u.utilization?.get() * 100.0).round() as i64;
            let window = match u.limit_type.as_str() {
                "five_hour" => "5h",
                "seven_day" => "wk",
                other => other,
            };
            let stale = u
                .stale
                .as_ref()
                .map(|s| format!(" ({})", c.stale(s)))
                .unwrap_or_default();
            Some(format!("{pct}% {window}{stale}"))
        })
        .collect();
    if !usage.is_empty() {
        parts.push(format!("claude {}", usage.join(" ")));
    }
    let s = &health.slots;
    let queued = if s.queued.get() > 0 {
        format!(", {} queued", s.queued.get())
    } else {
        String::new()
    };
    parts.push(format!(
        "{} running, slots {}/{}{queued}",
        s.running.get(),
        s.used.get(),
        s.cap.get()
    ));
    parts.join(" · ")
}

fn row_label(item: Option<&PlanItemId>, order: Option<&WorkstreamId>, title: &str) -> String {
    match (item, order) {
        (Some(item), _) => format!("{} {title}", item.as_str()),
        (None, Some(order)) => format!("{} {title}", order.as_str()),
        (None, None) => title.to_owned(),
    }
}

/// What `fleetd status` prints for one doc.
pub fn render(doc: &StatusDoc, zone: Tz) -> String {
    let c = Clock {
        now: parse_time(&doc.now.0),
        zone,
    };
    let mut out: Vec<String> = Vec::new();
    let p = &doc.progress;
    let pct = p.pct.get();
    let live = match doc.stale.len() {
        0 => "live".to_owned(),
        1 => "NOT LIVE: 1 stale source".to_owned(),
        n => format!("NOT LIVE: {n} stale sources"),
    };
    let polish = if p.polish_total.get() > 0 {
        format!("  polish {}/{}", p.polish_done.get(), p.polish_total.get())
    } else {
        String::new()
    };
    out.push(format!(
        "{}  {pct}%{polish}    as of {} ({live})",
        doc.title,
        c.at_s(&doc.now)
    ));
    let tier = doc
        .virtual_tier
        .map(|t| format!(", no plan: counts as one {t:?} item"))
        .unwrap_or_default();
    out.push(format!(
        "  {} of {} required items verified{tier}{}",
        p.done.get(),
        p.total.get(),
        p.stale
            .as_ref()
            .map(|s| format!(" ({})", c.stale(s)))
            .unwrap_or_default()
    ));
    for marker in doc.markers.iter() {
        out.push(format!("  {}", marker_text(marker, pct, &c)));
    }
    let tag = match (doc.headline.source, &doc.headline.reason) {
        (HeadlineSource::Generated, _) => "[generated]".to_owned(),
        (HeadlineSource::Template, Some(reason)) => format!("[template: {reason}]"),
        (HeadlineSource::Template, None) => "[template]".to_owned(),
    };
    out.push(format!("  {}   {tag}", doc.headline.text));
    out.push(format!("  eta {}", eta_line(&doc.eta, &c)));
    if !doc.gates.is_empty() {
        let gates: Vec<String> = doc
            .gates
            .iter()
            .map(|g| format!("{}{}", g.label, if g.serial { " (serial)" } else { "" }))
            .collect();
        out.push(format!("  waiting on  {}", gates.join("; ")));
    }
    out.push(format!("  {}", since_line(&doc.since, &c)));
    section(&mut out, "health", &[health_line(&doc.health, &c)]);
    let stale: Vec<String> = doc
        .stale
        .iter()
        .map(|s| format!("{} since {}: {}", s.source, c.at_s(&s.since), s.reason))
        .collect();
    section(&mut out, "stale", &stale);
    if doc.needs_you.count.get() > 0 {
        let asks: Vec<&str> = doc.needs_you.ask_ids.iter().map(|a| a.as_str()).collect();
        let n = doc.needs_you.count.get();
        let verb = if n == 1 { "needs" } else { "need" };
        section(
            &mut out,
            "needs",
            &[format!(
                "{n} {verb} you: {} (answer in the app's inbox)",
                asks.join(", ")
            )],
        );
    }
    let risks: Vec<String> = doc
        .risks
        .iter()
        .map(|r| match r.level {
            RiskLevel::Danger => format!("{} (!)", r.message),
            RiskLevel::Warning => r.message.to_string(),
        })
        .collect();
    section(&mut out, "risks", &risks);
    let parts: Vec<String> = doc
        .parts
        .iter()
        .map(|part| {
            let eta = part
                .eta
                .as_ref()
                .map(|e| format!("   eta {}", c.at(e)))
                .unwrap_or_default();
            let marker = part
                .progress
                .marker
                .as_ref()
                .map(|m| format!("   {}", m.text))
                .unwrap_or_default();
            format!("{}  {}%{eta}{marker}", part.title, part.progress.pct.get())
        })
        .collect();
    let parts_label = match doc.scope {
        StatusScope::Fleet => "projects",
        _ => "milestones",
    };
    if !parts.is_empty() {
        out.push(parts_label.to_owned());
        out.extend(parts.into_iter().map(|p| format!("        {p}")));
    }
    let doing: Vec<String> = doc
        .in_progress
        .iter()
        .map(|row| {
            let mut cells = vec![row_label(
                row.item_id.as_ref(),
                Some(&row.workstream_id),
                &row.title,
            )];
            let tasks: Vec<&str> = row.task_ids.iter().map(|t| t.as_str()).collect();
            if !tasks.is_empty() {
                cells.push(tasks.join(","));
            }
            if let Some(gate) = &row.gate {
                cells.push(gate.to_string());
            }
            match (&row.eta, row.overdue_minutes.map(|m| m.get())) {
                (_, Some(late)) if late > 0 => cells.push(format!("overdue {late}m")),
                (Some(eta), _) => cells.push(format!("eta {}", c.at(eta))),
                _ => {}
            }
            if let Some(stale) = &row.stale {
                cells.push(format!("({})", c.stale(stale)));
            }
            cells.join("   ")
        })
        .collect();
    section(&mut out, "doing", &doing);
    if !doc.next.is_empty() {
        let next: Vec<String> = doc
            .next
            .iter()
            .map(|row| {
                let after: Vec<&str> = row.after.iter().map(|a| a.as_str()).collect();
                let after = if after.is_empty() {
                    String::new()
                } else {
                    format!(" (after {})", after.join(", "))
                };
                format!("{} {}{after}", row.item_id.as_str(), row.title)
            })
            .collect();
        section(&mut out, "next", &[next.join(", ")]);
    }
    let done: Vec<String> = doc
        .done
        .iter()
        .map(|row| {
            format!(
                "{}   {}",
                row_label(row.item_id.as_ref(), row.workstream_id.as_ref(), &row.title),
                row.evidence
            )
        })
        .collect();
    section(&mut out, "done", &done);
    let m = &doc.more;
    let hidden: Vec<String> = [
        (m.done, "done"),
        (m.in_progress, "in progress"),
        (m.next, "next"),
        (m.risks, "risks"),
        (m.parts, parts_label),
        (m.stale, "stale"),
    ]
    .iter()
    .filter(|(n, _)| n.get() > 0)
    .map(|(n, what)| format!("{} more {what}", n.get()))
    .collect();
    if !hidden.is_empty() {
        out.push(format!("({}; --json has the doc)", hidden.join(", ")));
    }
    out.join("\n")
}

/// What `fleetd status --watch` prints above the last doc while the hub does not answer. It is the CLI's own
/// connection, not a judgement on the hub's data.
pub fn not_live_banner(last: &StatusDoc, zone: Tz, reason: &str) -> String {
    let c = Clock {
        now: parse_time(&last.now.0),
        zone,
    };
    format!(
        "NOT LIVE: reconnecting to the hub ({reason}) · data from {}",
        c.at_s(&last.now)
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
    zone: Tz,
}

impl Printer {
    fn show(&self, doc: &StatusDoc) {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            let _ = writeln!(stdout, "{}", serde_json::to_string(doc).unwrap_or_default());
        } else if self.tty {
            // Home, clear: the new version replaces the old in place.
            let _ = writeln!(stdout, "\x1b[H\x1b[2J{}", render(doc, self.zone));
        } else {
            let _ = writeln!(stdout, "{}\n", render(doc, self.zone));
        }
        let _ = stdout.flush();
    }

    fn banner(&self, line: &str) {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            let _ = writeln!(stdout, "{}", json!({ "notLive": line }));
        } else if self.tty {
            // The top line, cleared, then back: the last doc stays on screen under the banner.
            let _ = write!(stdout, "\x1b7\x1b[H\x1b[2K{line}\x1b8");
        } else {
            let _ = writeln!(stdout, "{line}\n");
        }
        let _ = stdout.flush();
    }
}

fn decode<A: serde::de::DeserializeOwned>(tool: &str, body: Value) -> Result<A, u8> {
    serde_json::from_value(body).map_err(|error| {
        eprintln!(
            "fleetd status: {tool} answered in a shape this fleetd does not know ({error}); update fleetd"
        );
        1
    })
}

/// "Since you last looked here": this machine's own mark per hub and scope, in `~/.fleetd/cli/status-seen.json`
/// (0600). It is separate from the per-person marks the app keeps on the hub: neither moves the other, so the CLI
/// needs no person's key and a look in one place never hides news from the other.
struct Mark {
    file: PathBuf,
    key: String,
    /// `{seq, at}` from the last doc printed here.
    last: Option<Value>,
}

impl Mark {
    fn load(hub: &str, scope: &Value) -> Self {
        let file = super::home_dir().join(".fleetd/cli/status-seen.json");
        let scope_key = serde_json::from_value::<StatusScope>(scope.clone())
            .map(|s| s.key())
            .unwrap_or_default();
        let key = format!("{hub} {scope_key}");
        let last = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|all| all.get(&key).cloned());
        Mark { file, key, last }
    }

    /// The hub counts what happened after this seq.
    fn input(&self, mut input: Value) -> Value {
        if let Some(seq) = self.last.as_ref().and_then(|l| l.get("seq")) {
            input["sinceSeq"] = seq.clone();
        }
        input
    }

    /// The doc's "since" line reads from this machine's mark, not the key's.
    fn apply(&self, mut doc: StatusDoc) -> StatusDoc {
        doc.since.seen_at = self
            .last
            .as_ref()
            .and_then(|l| l.get("at"))
            .and_then(Value::as_str)
            .map(|at| Timestamp(at.to_owned()));
        doc
    }

    fn save(&self, doc: &StatusDoc) {
        let mut all = std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        all[&self.key] = json!({ "seq": doc.seq, "at": doc.now });
        if let Some(dir) = self.file.parent() {
            use std::os::unix::fs::DirBuilderExt;
            let _ = std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir);
        }
        // A mark that can't be written only means the next look counts from further back.
        let _ = super::setup::write_private(&self.file, &format!("{all}\n"));
    }
}

/// One status_get; `Err` keeps transport failures apart so `--watch` can reconnect.
async fn get(
    client: &mut McpClient,
    scope: &Value,
    mark: &Mark,
) -> Result<Result<StatusDoc, u8>, CallError> {
    let body = call(
        client,
        "status_get",
        mark.input(json!({ "scope": scope })),
        Duration::from_secs(30),
    )
    .await?;
    Ok(decode::<StatusGetOutput>("status_get", body).map(|out| mark.apply(out.doc)))
}

/// `fleetd status …`: exit 0, 1 when the hub answered in a shape this build does not know, 2 on bad arguments, 3
/// when the hub refused the key or the call, 4 when it cannot be reached.
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
        zone: crate::hub::attention::hub_zone(),
    };
    let hub = match &target {
        Target::Remote { url, .. } => url.clone(),
        Target::Local { .. } => "local".to_owned(),
    };
    let mark = Mark::load(&hub, &scope);
    let mut doc = match get(&mut client, &scope, &mark).await {
        Ok(Ok(doc)) => doc,
        Ok(Err(code)) => return code,
        Err(error) => return fail("status", error),
    };
    printer.show(&doc);
    if args.watch {
        let mut stop = super::Stop::on_signals();
        'watch: loop {
            let wait =
                mark.input(json!({ "scope": scope, "after": doc.version, "timeoutSec": WAIT_SEC }));
            let answer = tokio::select! {
                _ = stop.wait() => break,
                answer = call(&mut client, "status_wait", wait, Duration::from_secs(WAIT_SEC + 15)) => answer,
            };
            let reason = match answer {
                Ok(body) => match decode::<StatusWaitOutput>("status_wait", body) {
                    Ok(StatusWaitOutput {
                        doc: Some(next), ..
                    }) => {
                        doc = mark.apply(next);
                        printer.show(&doc);
                        continue;
                    }
                    // Unchanged within the hub's wait: wait again.
                    Ok(_) => continue,
                    Err(code) => return code,
                },
                Err(CallError::Transport(McpError::Other(reason))) => reason,
                Err(error) => return fail("status", error),
            };
            printer.banner(&not_live_banner(&doc, printer.zone, &reason));
            let mut attempt = 0;
            loop {
                let delay = BACKOFF[attempt.min(BACKOFF.len() - 1)];
                attempt += 1;
                if stop.sleep(Duration::from_secs(delay)).await {
                    break 'watch;
                }
                let Ok(mut fresh) = target.connect("fleetd-status").await else {
                    continue;
                };
                match get(&mut fresh, &scope, &mark).await {
                    Ok(Ok(next)) => {
                        client = fresh;
                        doc = next;
                        printer.show(&doc);
                        break;
                    }
                    Ok(Err(code)) => return code,
                    Err(_) => {}
                }
            }
        }
    }
    mark.save(&doc);
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

    fn doc(stale: Value) -> StatusDoc {
        serde_json::from_value(json!({
            "scope": { "kind": "project", "projectRef": { "machineId": "devbox", "projectId": "p1" } },
            "title": "storefront", "version": 7, "seq": 120, "now": "2026-10-18T14:02:07Z",
            "progress": { "pct": 61, "done": 11, "total": 18, "polishDone": 2, "polishTotal": 5, "asOf": "2026-10-18T14:02:07Z" },
            "markers": [{ "at": "2026-10-18T14:00:00Z", "text": "+3 items: time inspector added", "pctBefore": 69, "pctAfter": 61, "deltaItems": 3 }],
            "eta": { "current": "2026-10-22T14:00:00Z", "original": "2026-10-21T18:00:00Z", "slip": { "scopeMinutes": 360, "speedMinutes": 840 },
                     "rate": 4.1, "samples": 18, "basis": "order" },
            "gates": [{ "kind": "plan", "label": "P12 full lab run", "serial": true }, { "kind": "live", "label": "CI on #212", "serial": false }],
            "headline": { "text": "Not live: lab-b silent 4m. Switching to the new runner.", "source": "generated", "at": "2026-10-18T14:02:00Z" },
            "since": { "seenAt": "2026-10-18T09:12:00Z", "merged": 7, "verified": 3, "started": 0, "failed": 1, "asked": 0, "scopeItems": 3 },
            "parts": [],
            "done": [{ "itemId": "P9", "title": "node outbox", "doneAt": "2026-10-18T13:12:00Z", "evidence": "#208 merged by the train 13:12" }],
            "inProgress": [{ "itemId": "P12", "workstreamId": "W41", "title": "full lab run", "taskIds": ["T88"], "changeIds": [], "eta": "2026-10-18T14:40:00Z" }],
            "next": [{ "itemId": "P14", "title": "switch default runner", "after": ["P12"] }],
            "needsYou": { "count": 0, "askIds": [] },
            "risks": [{ "rule": "machine_offline", "level": "warning", "message": "lab-b offline (2 tasks waiting)" }],
            "health": {
                "ci": [{ "repo": "acme/storefront", "state": "red", "failing": ["rust (macos)"], "asOf": "2026-10-18T14:01:50Z" }],
                "machines": [
                    { "machineId": "devbox", "status": "online", "lastSeenAt": "2026-10-18T14:02:00Z", "dropsToday": 0 },
                    { "machineId": "lab-b", "status": "offline", "lastSeenAt": "2026-10-18T13:58:07Z", "dropsToday": 1,
                      "stale": { "since": "2026-10-18T13:58:52Z", "reason": "no heartbeat from lab-b for 4m" } }
                ],
                "usage": [{ "limitType": "five_hour", "machineId": "devbox", "utilization": 0.58, "status": "allowed" }],
                "slots": { "running": 8, "used": 8, "cap": 40, "queued": 1 }
            },
            "stale": stale,
            "more": { "done": 0, "inProgress": 0, "next": 0, "risks": 0, "parts": 0, "stale": 0 }
        }))
        .unwrap()
    }

    #[test]
    fn a_stale_machine_reads_not_live_and_offline_with_absolute_times() {
        let stale = json!([{ "source": "machine:lab-b", "since": "2026-10-18T13:58:52Z", "reason": "no heartbeat from lab-b for 4m" }]);
        let text = render(&doc(stale), chrono_tz::UTC);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            "storefront  61%  polish 2/5    as of 14:02:07 (NOT LIVE: 1 stale source)"
        );
        assert_eq!(
            lines[2],
            "  ↓ from 69% · +3 items: time inspector added (14:00)"
        );
        for want in [
            "  eta Thu 14:00   planned Wed 18:00 (+6h scope, +14h slower)   4.1 pts/busy h, 18 samples",
            "  waiting on  P12 full lab run (serial); CI on #212",
            "  since you last looked here 09:12  7 merged, 3 verified, 1 failed, +3 items",
            "health  main CI acme/storefront RED (rust (macos)) as of 14:01:50 · 1 of 2 machines online · lab-b OFFLINE last seen 13:58:07 (stale) · claude 58% 5h · 8 running, slots 8/40, 1 queued",
            "stale   machine:lab-b since 13:58:52: no heartbeat from lab-b for 4m",
            "doing   P12 full lab run   T88   eta 14:40",
            "next    P14 switch default runner (after P12)",
            "done    P9 node outbox   #208 merged by the train 13:12",
        ] {
            assert!(text.contains(want), "missing {want:?} in\n{text}");
        }
        assert!(!text.contains("needs"), "zero asks print nothing");
    }

    #[test]
    fn a_clean_doc_is_live_and_no_samples_means_no_eta() {
        let mut d = doc(json!([]));
        assert!(
            render(&d, chrono_tz::UTC)
                .lines()
                .next()
                .unwrap()
                .ends_with("(live)")
        );
        d.eta = serde_json::from_value(json!({ "samples": 2, "basis": "none" })).unwrap();
        assert!(render(&d, chrono_tz::UTC).contains("  eta measuring: 2 of 5 verified"));
    }

    #[test]
    fn the_not_live_banner_names_when_the_data_is_from() {
        assert_eq!(
            not_live_banner(&doc(json!([])), chrono_tz::UTC, "connection refused"),
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
