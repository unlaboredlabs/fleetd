//! `fleetd status`: an order's, a project's or the fleet's progress, read from the hub's status doc (status_get) and,
//! with `--watch`, kept current by status_wait, which blocks on the hub until the doc changes. It lays out only what
//! the hub decided: the number (verified plus in flight), why it fell, what it waits on, and which parts are stale.
//! It never shows a time estimate. Every time printed is absolute, so a block left on screen never reads as fresher
//! than it is.

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
    CiState, Health, InProgressRow, Marker, Progress, RiskLevel, Since, StaleMark, StatusDoc,
    StatusScope,
};
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::mcp_client::{McpClient, McpError};
use super::time::resolve_project;

pub const STATUS_USAGE: &str = r#"  status [<order>|<project>] [--watch] [--json] [--hub <url> --key-file <path> | --home <dir>]
             progress (verified plus work in flight), why it fell, the critical path it waits on,
             what is slower than usual, what changed since you last looked, health and risks;
             for an order (W41), a project by id or title (<machine>/<project> when two machines
             have one), or the whole fleet. --watch prints
             each new version as the hub sends it; stale parts say so. On the hub machine it
             needs no --hub or --key-file
"#;

/// The longest status_wait the hub takes; the CLI asks again right after an unchanged answer.
const WAIT_SEC: u64 = 50;
/// Reconnect backoff after the hub stops answering, in seconds.
const BACKOFF: &[u64] = &[1, 2, 5, 10, 30];

#[derive(Debug, PartialEq)]
pub struct StatusArgs {
    /// Both, or neither for the hub on this machine.
    pub hub: Option<(String, String)>,
    /// That hub's home, when it isn't the default.
    pub home: Option<String>,
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
        ("home", Kind::Str),
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
        home: v.string("home").filter(|s| !s.is_empty()),
        target: v.positionals.first().cloned().unwrap_or_default(),
        watch: v.flag("watch"),
        json: v.flag("json"),
    })
}

// ---- reading the doc ----

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

fn since_line(since: &Since, c: &Clock) -> String {
    let mut counts: Vec<String> = [
        (since.merged, "merged"),
        (since.verified, "verified"),
        (since.started, "started"),
        (since.failed, "failed"),
    ]
    .iter()
    .filter(|(n, _)| n.get() != 0)
    .map(|(n, word)| format!("{} {word}", n.get()))
    .collect();
    if since.scope_items.get() != 0 {
        let n = since.scope_items.get();
        counts.push(format!("{n:+} {}", noun(n, "item", "items")));
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
        let all = machines.len() as i64;
        parts.push(format!(
            "{online} of {all} {} online",
            noun(all, "machine", "machines")
        ));
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

/// The number shown: the estimate (verified plus in-flight credit), or the verified share from a hub without one.
fn shown_pct(p: &Progress) -> i64 {
    p.estimate.as_ref().map_or(p.pct.get(), |e| e.pct.get())
}

const BAR: usize = 20;

/// `[██████▒▒▒░░░░░░░░░░░]`: solid is verified, shaded is in flight.
fn bar(verified: i64, in_flight: i64) -> String {
    let cells = |pct: i64| (pct.clamp(0, 100) as usize * BAR + 50) / 100;
    let solid = cells(verified);
    let shaded = cells(verified + in_flight)
        .saturating_sub(solid)
        .min(BAR - solid);
    format!(
        "[{}{}{}]",
        "█".repeat(solid),
        "▒".repeat(shaded),
        "░".repeat(BAR - solid - shaded)
    )
}

/// The row the scope's critical path runs through, else the first that waits on anything.
fn critical_row(doc: &StatusDoc) -> Option<&InProgressRow> {
    let waits = |r: &&InProgressRow| r.waiting_on.as_ref().is_some_and(|w| !w.is_empty());
    doc.in_progress
        .iter()
        .filter(waits)
        .find(|r| r.critical == Some(true))
        .or_else(|| doc.in_progress.iter().find(waits))
}

/// "waiting on: P12 full lab run: review of #12 → CI on #12 → merge   holds up P14, P16", from the critical row; a
/// hub without per-row paths gives its gates instead.
fn waiting_line(doc: &StatusDoc) -> Option<String> {
    if let Some(row) = critical_row(doc) {
        let path: Vec<&str> = row
            .waiting_on
            .iter()
            .flatten()
            .map(|w| w.as_str())
            .collect();
        let label = row_label(row.item_id.as_ref(), Some(&row.workstream_id), &row.title);
        let mut line = format!("waiting on: {label}: {}", path.join(" → "));
        if let Some(blocking) = row.blocking.as_ref().filter(|b| !b.is_empty()) {
            let ids: Vec<&str> = blocking.iter().map(|b| b.as_str()).collect();
            line.push_str(&format!("   holds up {}", ids.join(", ")));
        }
        return Some(line);
    }
    (!doc.gates.is_empty()).then(|| {
        let gates: Vec<String> = doc
            .gates
            .iter()
            .map(|g| format!("{}{}", g.label, if g.serial { " (serial)" } else { "" }))
            .collect();
        format!("waiting on: {}", gates.join(" → "))
    })
}

/// What `fleetd status` prints for one doc.
pub fn render(doc: &StatusDoc, zone: Tz) -> String {
    let c = Clock {
        now: parse_time(&doc.now.0),
        zone,
    };
    let mut out: Vec<String> = Vec::new();
    let p = &doc.progress;
    let pct = shown_pct(p);
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
    if let Some(e) = &p.estimate {
        out.push(format!(
            "  {} {}% verified + {}% in flight",
            bar(e.verified_pct.get(), e.in_flight_pct.get()),
            e.verified_pct.get(),
            e.in_flight_pct.get()
        ));
    }
    out.push(format!(
        "  {} of {} required {} verified{tier}{}",
        p.done.get(),
        p.total.get(),
        noun(p.total.get(), "item", "items"),
        p.stale
            .as_ref()
            .map(|s| format!(" ({})", c.stale(s)))
            .unwrap_or_default()
    ));
    if let Some(planning) = p.estimate.as_ref().and_then(|e| e.planning.as_ref())
        && planning.active
    {
        out.push(format!(
            "  the lead is planning: no plan items yet (planning {}% done)",
            planning.pct.get()
        ));
    }
    match &p.estimate {
        // The drops are on the estimate's scale, like the number; a marker's pctBefore is the verified figure, so
        // with an estimate a marker shows only its text, and not at all when a drop already says it.
        Some(e) => {
            // The figure holds on paused work: shown while it lasts, before why it last fell.
            if let Some(last) = e.series.iter().flatten().last()
                && let Some(paused) = &last.paused
            {
                out.push(format!("  {paused} ({})", c.at(&last.at)));
            }
            let drops: Vec<_> = e
                .series
                .iter()
                .flatten()
                .rev()
                .filter_map(|pt| pt.drop.as_ref().map(|d| (pt, d)))
                .take(3)
                .collect();
            for (point, drop) in &drops {
                out.push(format!(
                    "  ↓ from {}% · {} ({})",
                    drop.from_pct.get(),
                    drop.text,
                    c.at(&point.at)
                ));
            }
            for marker in doc.markers.iter() {
                if !drops.iter().any(|(_, d)| d.text == marker.text) {
                    out.push(format!("  {} ({})", marker.text, c.at(&marker.at)));
                }
            }
        }
        None => {
            for marker in doc.markers.iter() {
                out.push(format!("  {}", marker_text(marker, pct, &c)));
            }
        }
    }
    // Who wrote the headline (the model or the template) and why is the hub's bookkeeping, not the person's: only the
    // line itself is shown. `--json` keeps both.
    out.push(format!("  {}", doc.headline.text));
    if let Some(line) = waiting_line(doc) {
        out.push(format!("  {line}"));
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
        let n = doc.needs_you.count.get();
        let verb = if n == 1 { "needs" } else { "need" };
        section(
            &mut out,
            "needs",
            &[format!(
                "{n} {verb} you: a secret to enter or a command to approve (in the project's chat in the app)"
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
            let marker = part
                .progress
                .marker
                .as_ref()
                .map(|m| format!("   {}", m.text))
                .unwrap_or_default();
            format!("{}  {}%{marker}", part.title, shown_pct(&part.progress))
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
            // Each agent with its profile when it runs medium: "T88,T90 medium". High is the default and unmarked.
            let medium = row.medium_task_ids.as_ref();
            let tasks: Vec<String> = row
                .task_ids
                .iter()
                .map(|t| {
                    if medium.is_some_and(|m| m.contains(t)) {
                        format!("{t} medium")
                    } else {
                        t.to_string()
                    }
                })
                .collect();
            if !tasks.is_empty() {
                cells.push(tasks.join(","));
            }
            if row.critical == Some(true) {
                cells.push("critical path".to_owned());
            }
            match row.waiting_on.as_ref().filter(|w| !w.is_empty()) {
                Some(path) => {
                    let path: Vec<&str> = path.iter().map(|w| w.as_str()).collect();
                    cells.push(format!("waiting on {}", path.join(" → ")));
                }
                None => cells.extend(row.gate.as_ref().map(|g| g.to_string())),
            }
            if let Some(blocking) = row.blocking.as_ref().filter(|b| !b.is_empty()) {
                let ids: Vec<&str> = blocking.iter().map(|b| b.as_str()).collect();
                cells.push(format!("holds up {}", ids.join(", ")));
            }
            if row.slower_than_usual == Some(true) {
                cells.push("SLOWER THAN USUAL".to_owned());
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
    let part = match doc.scope {
        StatusScope::Fleet => "project",
        _ => "milestone",
    };
    let hidden: Vec<String> = [
        (m.done, "done", "done"),
        (m.in_progress, "in progress", "in progress"),
        (m.next, "next", "next"),
        (m.risks, "risk", "risks"),
        (m.parts, part, parts_label),
        (m.stale, "stale", "stale"),
    ]
    .iter()
    .filter(|(n, _, _)| n.get() > 0)
    .map(|(n, one, many)| format!("{} more {}", n.get(), noun(n.get(), one, many)))
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
    fn from_args(
        hub: &Option<(String, String)>,
        home: Option<&str>,
        who: &str,
    ) -> Result<Self, u8> {
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
            None => match super::hub_key::resolve_home(home) {
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

/// "Since you last looked here": this machine's own mark per hub and scope, in `<fleetd dir>/cli/status-seen.json`
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
        let file = crate::home::fleetd_dir().join("cli/status-seen.json");
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

/// A just-sent order has no status doc until the lead writes its brief: that is waiting, not a refusal.
async fn is_draft(client: &mut McpClient, target: &str) -> bool {
    if WorkstreamId::new(target).is_err() {
        return false;
    }
    call(
        client,
        "order_get",
        json!({ "workstreamId": target }),
        Duration::from_secs(30),
    )
    .await
    .is_ok_and(|body| body.pointer("/order/state").and_then(Value::as_str) == Some("draft"))
}

/// Waits for a scope's first doc (a draft order's, once its brief exists).
async fn first_doc(
    client: &mut McpClient,
    scope: &Value,
    mark: &Mark,
) -> Result<Result<StatusDoc, u8>, CallError> {
    loop {
        let wait = mark.input(json!({ "scope": scope, "timeoutSec": WAIT_SEC }));
        let body = call(
            client,
            "status_wait",
            wait,
            Duration::from_secs(WAIT_SEC + 15),
        )
        .await?;
        match decode::<StatusWaitOutput>("status_wait", body) {
            Ok(StatusWaitOutput { doc: Some(doc), .. }) => return Ok(Ok(mark.apply(doc))),
            Ok(_) => {}
            Err(code) => return Ok(Err(code)),
        }
    }
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
    let target = match Target::from_args(&args.hub, args.home.as_deref(), "status") {
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
        Err(CallError::Refused(_)) if is_draft(&mut client, &args.target).await => {
            println!("{} is a draft: waiting for the lead's brief", args.target);
            if !args.watch {
                return 0;
            }
            let mut stop = super::Stop::on_signals();
            let first = tokio::select! {
                _ = stop.wait() => return 0,
                first = first_doc(&mut client, &scope, &mark) => first,
            };
            match first {
                Ok(Ok(doc)) => doc,
                Ok(Err(code)) => return code,
                Err(error) => return fail("status", error),
            }
        }
        Err(error) => return fail("status", error),
    };
    printer.show(&doc);
    if !args.json
        && let Some(line) = super::versions::line(&mut client).await
    {
        println!("{line}");
    }
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

/// `one` for 1 and −1, `many` otherwise.
fn noun<'a>(n: i64, one: &'a str, many: &'a str) -> &'a str {
    if n.abs() == 1 { one } else { many }
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
            "gates": [{ "kind": "plan", "label": "P12 full lab run", "serial": true }, { "kind": "live", "label": "CI on #212", "serial": false }],
            "headline": { "text": "Not live: lab-b silent 4m. Switching to the new runner.", "source": "generated", "at": "2026-10-18T14:02:00Z" },
            "since": { "seenAt": "2026-10-18T09:12:00Z", "merged": 7, "verified": 3, "started": 0, "failed": 1, "scopeItems": 3 },
            "parts": [],
            "done": [{ "itemId": "P9", "title": "node outbox", "doneAt": "2026-10-18T13:12:00Z", "evidence": "#208 merged by the train 13:12" }],
            "inProgress": [{ "itemId": "P12", "workstreamId": "W41", "title": "full lab run", "taskIds": ["T88"], "changeIds": [] }],
            "next": [{ "itemId": "P14", "title": "switch default runner", "after": ["P12"] }],
            "needsYou": { "count": 0, "requestIds": [] },
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
            "  waiting on: P12 full lab run (serial) → CI on #212",
            "  since you last looked here 09:12  7 merged, 3 verified, 1 failed, +3 items",
            "health  main CI acme/storefront RED (rust (macos)) as of 14:01:50 · 1 of 2 machines online · lab-b OFFLINE last seen 13:58:07 (stale) · claude 58% 5h · 8 running, slots 8/40, 1 queued",
            "stale   machine:lab-b since 13:58:52: no heartbeat from lab-b for 4m",
            "doing   P12 full lab run   T88",
            "next    P14 switch default runner (after P12)",
            "done    P9 node outbox   #208 merged by the train 13:12",
        ] {
            assert!(text.contains(want), "missing {want:?} in\n{text}");
        }
        assert!(!text.contains("needs"), "zero asks print nothing");
    }

    /// One of each counts in the singular, and the headline prints without the hub's own source tag.
    #[test]
    fn counts_of_one_are_singular_and_no_internal_tag_shows() {
        let mut d = doc(json!([]));
        d.progress = serde_json::from_value(json!({
            "pct": 0, "done": 0, "total": 1, "polishDone": 0, "polishTotal": 0, "asOf": "2026-10-18T14:02:07Z"
        }))
        .unwrap();
        d.since = serde_json::from_value(json!({
            "seenAt": "2026-10-18T09:12:00Z", "merged": 1, "verified": 0, "started": 0, "failed": 0, "scopeItems": 1
        }))
        .unwrap();
        d.health.machines = serde_json::from_value(json!([
            { "machineId": "devbox", "status": "online", "lastSeenAt": "2026-10-18T14:02:00Z", "dropsToday": 0 }
        ]))
        .unwrap();
        for source in [
            json!({ "text": "Writing the FAQ page.", "source": "template", "at": "2026-10-18T14:02:00Z" }),
            json!({ "text": "Writing the FAQ page.", "source": "template", "reason": "facts changed, rewriting", "at": "2026-10-18T14:02:00Z" }),
            json!({ "text": "Writing the FAQ page.", "source": "generated", "at": "2026-10-18T14:02:00Z" }),
        ] {
            d.headline = serde_json::from_value(source).unwrap();
            let text = render(&d, chrono_tz::UTC);
            for want in [
                "  0 of 1 required item verified",
                "  Writing the FAQ page.\n",
                "1 merged, +1 item",
                "1 of 1 machine online",
            ] {
                assert!(text.contains(want), "missing {want:?} in\n{text}");
            }
            for internal in ["[template", "[generated]", "rewriting"] {
                assert!(!text.contains(internal), "{internal:?} shown in\n{text}");
            }
        }
        d.more = serde_json::from_value(json!({
            "done": 0, "inProgress": 0, "next": 0, "risks": 1, "parts": 1, "stale": 0
        }))
        .unwrap();
        let text = render(&d, chrono_tz::UTC);
        assert!(
            text.ends_with("(1 more risk, 1 more milestone; --json has the doc)"),
            "{text}"
        );
        d.scope = serde_json::from_value(json!({ "kind": "fleet" })).unwrap();
        d.more.risks = fleetd_contracts::prim::Count::unchecked(2);
        let text = render(&d, chrono_tz::UTC);
        assert!(
            text.ends_with("(2 more risks, 1 more project; --json has the doc)"),
            "{text}"
        );
    }

    #[test]
    fn a_clean_doc_is_live() {
        assert!(
            render(&doc(json!([])), chrono_tz::UTC)
                .lines()
                .next()
                .unwrap()
                .ends_with("(live)")
        );
    }

    #[test]
    fn a_progress_v2_doc_shows_verified_and_in_flight_drops_and_the_critical_path() {
        let mut d = doc(json!([]));
        d.progress = serde_json::from_value(json!({
            "pct": 61, "done": 11, "total": 18, "polishDone": 2, "polishTotal": 5, "asOf": "2026-10-18T14:02:07Z",
            "estimate": { "pct": 70, "verifiedPct": 61, "inFlightPct": 9, "weights": "project", "series": [
                { "at": "2026-10-18T13:00:00Z", "pct": 66, "verifiedPct": 58 },
                { "at": "2026-10-18T13:20:00Z", "pct": 63, "verifiedPct": 58,
                  "drop": { "reason": "ci_failed", "fromPct": 66, "text": "CI failed on #212" } },
                { "at": "2026-10-18T14:00:00Z", "pct": 61, "verifiedPct": 58,
                  "drop": { "reason": "scope_change", "fromPct": 69, "text": "+3 items: time inspector added" } },
                { "at": "2026-10-18T14:02:00Z", "pct": 70, "verifiedPct": 61,
                  "paused": "paused: an agent hit a usage limit" }
            ] }
        }))
        .unwrap();
        d.in_progress = serde_json::from_value(json!([
            { "itemId": "P11", "workstreamId": "W41", "title": "docs page", "taskIds": ["T87"], "changeIds": [],
              "waitingOn": ["review of #210"] },
            { "itemId": "P12", "workstreamId": "W41", "title": "full lab run", "taskIds": ["T88"], "changeIds": [],
              "waitingOn": ["review of #212", "CI on #212", "merge"], "blocking": ["P14", "P16"], "critical": true,
              "slowerThanUsual": true }
        ]))
        .unwrap();
        let text = render(&d, chrono_tz::UTC);
        assert!(text.starts_with("storefront  70%  polish 2/5"), "{text}");
        for want in [
            "  [████████████▒▒░░░░░░] 61% verified + 9% in flight\n  11 of 18 required items verified",
            "  paused: an agent hit a usage limit (14:02)\n  ↓ from 69% · +3 items: time inspector added (14:00)\n  ↓ from 66% · CI failed on #212 (13:20)",
            "  waiting on: P12 full lab run: review of #212 → CI on #212 → merge   holds up P14, P16",
            "        P12 full lab run   T88   critical path   waiting on review of #212 → CI on #212 → merge   holds up P14, P16   SLOWER THAN USUAL",
        ] {
            assert!(text.contains(want), "missing {want:?} in\n{text}");
        }
        assert_eq!(
            text.matches("+3 items: time inspector added").count(),
            1,
            "a scope change shows once, as its drop"
        );
        assert!(
            !text.contains("↓ from 61%"),
            "a marker's verified figure never sits beside the estimate"
        );
        assert!(
            !text.contains("P12 full lab run (serial)"),
            "per-row paths win over gates"
        );
    }

    #[test]
    fn the_bar_splits_verified_from_in_flight() {
        assert_eq!(bar(0, 0), format!("[{}]", "░".repeat(20)));
        assert_eq!(
            bar(50, 25),
            format!("[{}{}{}]", "█".repeat(10), "▒".repeat(5), "░".repeat(5))
        );
        assert_eq!(bar(100, 30), format!("[{}]", "█".repeat(20)));
    }

    #[test]
    fn the_not_live_banner_names_when_the_data_is_from() {
        assert_eq!(
            not_live_banner(&doc(json!([])), chrono_tz::UTC, "connection refused"),
            "NOT LIVE: reconnecting to the hub (connection refused) · data from 14:02:07"
        );
    }
}

#[cfg(test)]
mod against_a_hub {
    use std::sync::Arc;

    use crate::clock::SystemClock;
    use crate::hub::api::{self, HubConfig, Listen};
    use crate::hub::store::HubDb;
    use fleetd_contracts::auth::{Grant, KeyKind};
    use serde_json::json;

    /// Scripts read the exit code: an order just sent (a draft until the lead's brief) is waiting, not refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_draft_order_exits_0_and_an_unknown_one_3() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
            queue_ttl_sec: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            Arc::new(SystemClock),
        )
        .unwrap();
        let at = "2026-10-18T10:00:00.000Z";
        let w = json!({
            "workstreamId": "W1", "projectRef": { "machineId": "devbox", "projectId": "storefront" },
            "title": "Checkout redesign",
            "source": { "text": "Checkout redesign", "channel": "app", "by": "human", "at": at },
            "state": "draft", "createdAt": at, "updatedAt": at,
        });
        hub.db
            .with(|c| {
                c.execute(
                    "INSERT INTO workstreams (machine_id, project_id, state, data) VALUES ('devbox', 'storefront', 'draft', ?)",
                    [w.to_string()],
                )?;
                Ok(())
            })
            .unwrap();
        let grants: Vec<Grant> =
            serde_json::from_value(json!([{ "role": "read", "machines": "*" }])).unwrap();
        let key = hub
            .auth
            .create_key("test", &grants, KeyKind::Agent)
            .unwrap()
            .key;
        let key_file = home.path().join("read.key");
        std::fs::write(&key_file, format!("{key}\n")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let served = tokio::spawn(crate::hub::http::serve(
            listener,
            hub.clone(),
            Arc::new(api::registry()),
        ));
        let status = |order: &str| {
            let argv: Vec<String> = [
                order,
                "--hub",
                &url,
                "--key-file",
                key_file.to_str().unwrap(),
            ]
            .map(str::to_owned)
            .to_vec();
            async move { super::status_command(&argv).await }
        };
        assert_eq!(status("W1").await, 0, "a draft is waiting for its brief");
        assert_eq!(
            status("W9").await,
            3,
            "an order that doesn't exist is refused"
        );
        served.abort();
    }
}
