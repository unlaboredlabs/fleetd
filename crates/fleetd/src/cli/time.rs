//! `fleetd time`: where agents' time went, over the hub's MCP endpoint (time_breakdown, time_insights, time_spans,
//! time_retention_set). It only lays out what the hub computed: the numbers, the critical path and the findings are
//! the ones the desktop app shows.

use std::time::Duration;

use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{TimeBreakdownOutput, TimeInsightsOutput, TimeSpansOutput};
use fleetd_contracts::time::{Category, Span, SpanKind};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::mcp_client::{McpClient, McpError};

pub const TIME_USAGE: &str = r#"  time [<order>|<project>] [--since 7d] [--spans <rule>] [--json] [--hub <url> --key-file <path> | --home <dir>]
             where agents' time went: an order's critical path, agent time by category, the
             slowest commands and the findings; a project by id or title (<machine>/<project>
             when two machines have one), the whole fleet with neither. --since takes 1h to
             400d, a date or an ISO time; --spans <rule> lists the spans a finding points at. On the
             hub machine it needs no --hub or --key-file
  time --retention <days> [--hub <url> --key-file <path> | --home <dir>]
             keep 1-365 days of timelines (admin key); daily totals are kept 400 days
"#;

#[derive(Debug, PartialEq)]
pub struct TimeArgs {
    /// Both, or neither for the hub on this machine.
    pub hub: Option<(String, String)>,
    /// That hub's home, when it isn't the default.
    pub home: Option<String>,
    /// The order id or project as given; empty for the fleet.
    pub target: String,
    pub since: String,
    pub spans: Option<String>,
    pub json: bool,
    pub retention: Option<u32>,
}

impl TimeArgs {
    fn is_order(&self) -> bool {
        WorkstreamId::new(&self.target).is_ok()
    }
}

/// `7d`, `12h` or an ISO time, as the ISO time it means.
pub fn parse_since(given: &str, now: DateTime<Utc>, zone: Tz) -> Result<String, String> {
    let bad = || format!("--since must be 1h to 400d, a date or an ISO time, got '{given}'");
    if let Ok(at) = DateTime::parse_from_rfc3339(given) {
        return Ok(at
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    // A date is its midnight on the hub machine's clock.
    if let Ok(day) = chrono::NaiveDate::parse_from_str(given, "%Y-%m-%d") {
        let midnight = day.and_hms_opt(0, 0, 0).expect("midnight exists");
        return zone
            .from_local_datetime(&midnight)
            .earliest()
            .map(|at| {
                at.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            })
            .ok_or_else(bad);
    }
    let (digits, hours_per) = match given.as_bytes().last() {
        Some(b'd') => (&given[..given.len() - 1], 24),
        Some(b'h') => (&given[..given.len() - 1], 1),
        _ => return Err(bad()),
    };
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let hours = digits.parse::<i64>().map_err(|_| bad())? * hours_per;
    if hours > 400 * 24 {
        return Err(bad());
    }
    Ok((now - chrono::Duration::hours(hours)).to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub fn parse_time_args(argv: &[String], now: DateTime<Utc>, zone: Tz) -> Result<TimeArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("home", Kind::Str),
        ("since", Kind::Str),
        ("spans", Kind::Str),
        ("json", Kind::Bool),
        ("retention", Kind::Str),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    let hub = match (
        v.str("hub").filter(|s| !s.is_empty()),
        v.str("key-file").filter(|s| !s.is_empty()),
    ) {
        (Some(hub), Some(key_file)) => Some((hub.to_owned(), key_file.to_owned())),
        (None, None) => None,
        (Some(_), None) => return Err("--hub needs --key-file".into()),
        (None, Some(_)) => return Err("--key-file needs --hub".into()),
    };
    if v.positionals.len() > 1 {
        return Err(format!(
            "give one order or project, got '{}'",
            v.positionals.join(" ")
        ));
    }
    let retention = match v.str("retention") {
        None => None,
        Some(days) => Some(
            days.parse::<u32>()
                .ok()
                .filter(|d| (1..=365).contains(d))
                .ok_or_else(|| format!("--retention must be 1 to 365 days, got '{days}'"))?,
        ),
    };
    Ok(TimeArgs {
        hub,
        home: v.string("home").filter(|s| !s.is_empty()),
        target: v.positionals.first().cloned().unwrap_or_default(),
        since: parse_since(v.str("since").unwrap_or("7d"), now, zone)?,
        spans: v.string("spans").filter(|s| !s.is_empty()),
        json: v.flag("json"),
        retention,
    })
}

/// The project a name means, from `projects_list`: its id, its title or its folder's name, optionally after
/// `<machine>/`. Several machines with the same name need the machine.
pub fn resolve_project(name: &str, projects: &[Value]) -> Result<Value, String> {
    let (machine, rest) = match name.split_once('/') {
        Some((m, rest)) if super::is_machine_id(m) => (Some(m), rest),
        _ => (None, name),
    };
    let s = |p: &Value, k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let found: Vec<&Value> = projects
        .iter()
        .filter(|p| machine.is_none_or(|m| s(p, "machineId") == m))
        .filter(|p| {
            let folder = s(p, "workspaceRoot");
            let folder = folder.rsplit('/').next().unwrap_or("");
            [s(p, "projectId").as_str(), s(p, "title").as_str(), folder].contains(&rest)
        })
        .collect();
    match found.as_slice() {
        [one] => Ok(json!({ "machineId": s(one, "machineId"), "projectId": s(one, "projectId") })),
        [] => Err(format!(
            "no order or project '{name}'; projects: {}",
            projects
                .iter()
                .map(|p| format!("{}/{}", s(p, "machineId"), s(p, "title")))
                .collect::<Vec<_>>()
                .join(", ")
        )),
        many => Err(format!(
            "'{name}' is on several machines; say which: {}",
            many.iter()
                .map(|p| format!("{}/{rest}", s(p, "machineId")))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// A command as one table cell: its first line, cut at `max` characters. The full text is in `--json`.
pub fn one_line(text: &str, max: usize) -> String {
    let first = text.lines().next().unwrap_or("").trim_end();
    let cut = first.chars().count() > max || text.trim_end().contains('\n');
    if !cut {
        return first.to_owned();
    }
    let kept: String = first.chars().take(max - 1).collect();
    format!("{}…", kept.trim_end())
}

/// `1h42m`, `34m`, `2m10s`, `8s`, `250ms`.
pub fn dur(ms: i64) -> String {
    let ms = ms.max(0);
    let s = ms / 1000;
    match s {
        0 if ms > 0 => format!("{ms}ms"),
        0..60 => format!("{s}s"),
        60..600 if s % 60 != 0 => format!("{}m{:02}s", s / 60, s % 60),
        60..3600 => format!("{}m", s / 60),
        _ => format!("{}h{:02}m", s / 3600, s / 60 % 60),
    }
}

fn pct(part: i64, whole: i64) -> String {
    if whole <= 0 {
        return "0%".into();
    }
    format!("{}%", (part as f64 * 100.0 / whole as f64).round() as i64)
}

/// The views' word for a category: waiting on a person is "you".
fn category_word(cat: Category) -> &'static str {
    match cat {
        Category::Model => "model",
        Category::Tools => "tools",
        Category::Machine => "machine",
        Category::Queue => "queue",
        Category::Human => "you",
        Category::Pipeline => "pipeline",
        Category::Idle => "idle",
    }
}

/// A kind's short name inside its category's line.
fn kind_word(kind: SpanKind) -> &'static str {
    use SpanKind as K;
    match kind {
        K::ModelFirstToken => "first token",
        K::ModelThinking => "thinking",
        K::ModelOutput => "output",
        K::ModelMessage => "model",
        K::ToolBash => "Bash",
        K::ToolRead => "Read",
        K::ToolEdit => "Edit",
        K::ToolWeb => "Web",
        K::ToolMcp => "MCP",
        K::ToolOther => "other tools",
        K::CheckClaim => "checks",
        K::WaitRetryApi | K::WaitRetryNode => "retries",
        K::RunStartup => "startup",
        K::ClaudeOther => "claude overhead",
        K::WaitOffline | K::QueueOffline => "offline",
        K::QueueSlot | K::SlotsFull => "slots",
        K::QueueLease => "leases",
        K::QueueUsage | K::ParkUsage => "usage limits",
        K::RunQueued => "behind a run",
        K::WakeDebounce => "debounce",
        K::WaitPermission => "approvals",
        K::WaitRequest => "requests",
        K::ChangeReview => "review",
        K::ChangeQueue => "train line",
        K::ChangeRebase => "rebase",
        K::ChangeCi | K::CiCheck => "CI",
        K::CiQueue => "CI queue",
        K::ChangeMerge => "merge",
        K::ChangeBlocked => "blocked",
        K::IntakeRoute => "routing",
        other => other.as_str(),
    }
}

/// The critical path's rows: pipeline splits into ci, review and train, as people talk about it.
fn path_group(kind: SpanKind, cat: Category, gap: bool) -> &'static str {
    match (kind, cat) {
        _ if gap => "nothing running",
        (SpanKind::ChangeCi | SpanKind::CiCheck | SpanKind::CiQueue, _) => "ci",
        (SpanKind::ChangeReview, _) => "review",
        (_, Category::Pipeline) => "train",
        (_, cat) => category_word(cat),
    }
}

/// Columns padded to their widest cell: the first left-aligned, numbers right-aligned, the last one free text.
fn table(rows: &[Vec<String>]) -> Vec<String> {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|c| {
            rows.iter()
                .filter_map(|r| r.get(c))
                .map(|s| s.chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    rows.iter()
        .map(|row| {
            let cells: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(c, cell)| match c {
                    0 => format!("{cell:<w$}", w = widths[c]),
                    _ if c + 1 == columns => cell.clone(),
                    _ => format!("{cell:>w$}", w = widths[c]),
                })
                .collect();
            cells.join("  ").trim_end().to_owned()
        })
        .collect()
}

/// What `fleetd time` prints. `order` is order_get's `order` card, for an order.
pub fn render(
    order: Option<&Value>,
    args: &TimeArgs,
    breakdown: &TimeBreakdownOutput,
    insights: &TimeInsightsOutput,
    zone: Tz,
) -> String {
    let mut out = Vec::new();
    let wall = breakdown.wall_ms.get();
    let agent = breakdown.agent_ms.get();
    let path = breakdown.critical_path.as_ref();

    let card = |k: &str| {
        order
            .and_then(|o| o.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    out.push(match (order, args.target.is_empty()) {
        (Some(_), _) => format!("{} {}  {}", args.target, card("title"), card("state")),
        (None, true) => format!("fleet since {}", local(&args.since, zone)),
        (None, false) => format!("{} since {}", args.target, local(&args.since, zone)),
    });
    let mut head = format!("wall {}", dur(wall));
    if let Some(p) = path {
        head.push_str(&format!(
            "  critical path {}",
            dur(p.end_ms.get() - p.start_ms.get())
        ));
    }
    head.push_str(&format!("  agent time {}", dur(agent)));
    if wall > 0 {
        head.push_str(&format!("  parallelism {:.1}x", agent as f64 / wall as f64));
    }
    let coverage = &breakdown.coverage;
    head.push_str(&if coverage.complete {
        "  coverage complete".to_owned()
    } else {
        let mut why = Vec::new();
        match coverage.gaps.len() {
            0 => {}
            1 => why.push("1 gap".to_owned()),
            n => why.push(format!("{n} gaps")),
        }
        if coverage.capped == Some(true) {
            why.push("newest spans only".into());
        }
        if let Some(since) = &coverage.detail_since {
            why.push(format!(
                "commands and findings from {}",
                local(since.as_str(), zone)
            ));
        }
        match why.is_empty() {
            true => "  coverage incomplete".to_owned(),
            false => format!("  coverage incomplete ({})", why.join("; ")),
        }
    });
    out.push(head);

    if let Some(p) = path {
        let path_ms = p.end_ms.get() - p.start_ms.get();
        // The rows come from the hub's totals, which cover the whole path; the segments, which the hub cuts to its
        // longest 400, only name what each row was.
        let mut groups: Vec<(&str, i64)> = Vec::new();
        let mut add = |group: &'static str, ms: i64| match groups.iter_mut().find(|g| g.0 == group)
        {
            Some(g) => g.1 += ms,
            None => groups.push((group, ms)),
        };
        for t in p.totals.iter() {
            match (t.cat, &t.kinds) {
                (Category::Pipeline, Some(kinds)) => {
                    for k in kinds.iter() {
                        add(path_group(k.kind, t.cat, false), k.ms.get());
                    }
                }
                (Category::Idle, _) => add("nothing running", t.ms.get()),
                (cat, _) => add(category_word(cat), t.ms.get()),
            }
        }
        groups.retain(|g| g.1 > 0);
        groups.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        let mut labels: Vec<(&str, &str, i64)> = Vec::new();
        for s in p.segments.iter() {
            let group = path_group(s.kind, s.cat, s.span_id.is_none());
            let label = s.label.as_deref().unwrap_or("");
            if label.is_empty() || matches!(group, "model" | "nothing running") {
                continue;
            }
            let d = s.end_ms.get() - s.start_ms.get();
            match labels
                .iter_mut()
                .find(|(g, l, _)| *g == group && *l == label)
            {
                Some(l) => l.2 += d,
                None => labels.push((group, label, d)),
            }
        }
        labels.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(b.1)));
        let mut rows = vec![vec!["critical path".to_owned(), dur(path_ms)]];
        for (group, total) in groups {
            let detail = labels
                .iter()
                .filter(|(g, _, _)| *g == group)
                .take(2)
                .map(|(_, l, d)| format!("{} {}", one_line(l, 40), dur(*d)))
                .collect::<Vec<_>>()
                .join(", ");
            rows.push(vec![
                format!("  {group}"),
                dur(total),
                pct(total, path_ms),
                detail,
            ]);
        }
        out.push(String::new());
        out.extend(table(&rows));
        if p.segments_truncated {
            out.push(format!(
                "  (the path has more than {} steps: the rows cover all of it, the names only the longest)",
                p.segments.len()
            ));
        }
    }

    let mut rows = vec![vec!["agent time".to_owned(), dur(agent)]];
    let mut categories: Vec<_> = breakdown
        .by_category
        .iter()
        .filter(|c| c.ms.get() > 0)
        .collect();
    categories.sort_by_key(|c| -c.ms.get());
    for c in categories {
        let mut kinds: Vec<_> = c.kinds.iter().filter(|k| k.ms.get() > 0).collect();
        kinds.sort_by_key(|k| -k.ms.get());
        let detail = if kinds.len() < 2 && c.cat != Category::Tools {
            String::new()
        } else {
            kinds
                .iter()
                .take(4)
                .map(|k| {
                    let n = if k.kind == SpanKind::ToolBash {
                        format!(" ({})", k.n.get())
                    } else {
                        String::new()
                    };
                    format!("{} {}{n}", kind_word(k.kind), dur(k.ms.get()))
                })
                .collect::<Vec<_>>()
                .join("  ")
        };
        rows.push(vec![
            format!("  {}", category_word(c.cat)),
            dur(c.ms.get()),
            pct(c.ms.get(), agent),
            detail,
        ]);
    }
    out.push(String::new());
    out.extend(table(&rows));

    if !breakdown.top_commands.is_empty() {
        let mut rows = vec![vec![
            "slowest commands".to_owned(),
            "n".into(),
            "total".into(),
            "median".into(),
            "failed".into(),
        ]];
        for c in breakdown.top_commands.iter().take(5) {
            rows.push(vec![
                format!("  {}", one_line(c.label.as_str(), 60)),
                c.n.get().to_string(),
                dur(c.total_ms.get()),
                dur(c.p50_ms.get()),
                c.failed.get().to_string(),
            ]);
        }
        out.push(String::new());
        out.extend(table(&rows));
    }

    out.push(String::new());
    if insights.insights.is_empty() {
        out.push("findings: none".into());
    } else {
        out.push("findings".into());
        let target = if args.target.is_empty() {
            String::new()
        } else {
            format!("{} ", args.target)
        };
        for (i, f) in insights.insights.iter().take(5).enumerate() {
            let rule = serde_json::to_value(f.rule).unwrap_or_default();
            out.push(format!("  {}. {}", i + 1, f.message.as_str()));
            out.push(format!(
                "     fleetd time {target}--spans {}",
                rule.as_str().unwrap_or("")
            ));
        }
        if insights.insights.len() > 5 {
            out.push(format!(
                "  and {} more (--json lists them all)",
                insights.insights.len() - 5
            ));
        }
    }
    out.join("\n")
}

fn local(iso: &str, zone: Tz) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|at| at.with_timezone(&zone).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| iso.to_owned())
}

/// `10:21:04  2m10s  exit 101  48 KB  thread:lab-a/t1  cargo test --workspace`.
pub fn span_line(span: &Span, zone: Tz) -> String {
    let start = span.start_ms.get();
    let mut parts = vec![
        zone.timestamp_millis_opt(start)
            .single()
            .map(|t| t.format("%H:%M:%S").to_string())
            .unwrap_or_default(),
        span.end_ms
            .map(|end| dur(end.get() - start))
            .unwrap_or_else(|| "open".into()),
    ];
    if let Some(code) = span.exit_code {
        parts.push(format!("exit {}", code.get()));
    }
    if let Some(bytes) = span.out_bytes.map(|b| b.get()) {
        parts.push(if bytes >= 1024 {
            format!("{} KB", bytes / 1024)
        } else {
            format!("{bytes} B")
        });
    }
    parts.push(span.lane.as_str().to_owned());
    parts.push(match span.label.as_deref() {
        Some(label) if !label.is_empty() => label.to_owned(),
        _ => kind_word(span.kind).to_owned(),
    });
    parts.join("  ")
}

fn unreachable(error: McpError) -> u8 {
    eprintln!("fleetd time: {}", error.message());
    match error {
        McpError::Unauthorized => 3,
        McpError::Other(_) => 4,
    }
}

struct Hub {
    client: McpClient,
    timeout: Duration,
}

impl Hub {
    /// One tool call; on failure, what to exit with after saying why.
    async fn call(&mut self, tool: &str, input: Value) -> Result<Value, u8> {
        match self.client.call_tool(tool, input, self.timeout).await {
            Err(error) => Err(unreachable(error)),
            Ok(result) if result.is_error => {
                let text = |k: &str| result.body.get(k).and_then(Value::as_str);
                let fix = text("fix")
                    .map(|f| format!("\n  fix: {f}"))
                    .unwrap_or_default();
                eprintln!(
                    "fleetd time: {}{fix}",
                    text("message").unwrap_or("the hub refused")
                );
                Err(1)
            }
            Ok(result) => Ok(result.body),
        }
    }

    async fn typed<A: DeserializeOwned>(&mut self, tool: &str, input: Value) -> Result<A, u8> {
        let body = self.call(tool, input).await?;
        serde_json::from_value(body).map_err(|error| {
            eprintln!("fleetd time: {tool} answered in a shape this fleetd does not know ({error}); update fleetd");
            1
        })
    }
}

/// `fleetd time …`: exit 0, 1 when the hub refused the call, 2 on bad arguments, 3 when it refused the key, 4 when
/// it cannot be reached.
pub async fn time_command(argv: &[String]) -> u8 {
    let args = match parse_time_args(argv, Utc::now(), crate::hub::attention::hub_zone()) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{TIME_USAGE}");
            return 2;
        }
    };
    let timeout = Duration::from_secs(30);
    let client = match &args.hub {
        Some((url, key_file)) => {
            let key = match std::fs::read_to_string(key_file) {
                Ok(key) => key.trim().to_owned(),
                Err(error) => {
                    eprintln!("fleetd time: cannot read --key-file: {error}");
                    return 2;
                }
            };
            match McpClient::connect(url, &key, "fleetd-time", timeout).await {
                Ok(client) => client,
                Err(error) => return unreachable(error),
            }
        }
        None => {
            let local = match super::hub_key::resolve_home(args.home.as_deref()) {
                Ok(home) => super::setup::doctor::connect_as(&home, "fleetd-time").await,
                Err(message) => Err(super::setup::Failure {
                    message,
                    fix: String::new(),
                }),
            };
            match local {
                Ok(client) => client,
                Err(failure) => {
                    eprintln!(
                        "fleetd time: {}\n  fix: run it on the hub machine, or pass --hub <url> --key-file <path>",
                        failure.message
                    );
                    return 4;
                }
            }
        }
    };
    let mut hub = Hub { client, timeout };
    match run(&mut hub, &args).await {
        Ok(()) => 0,
        Err(code) => code,
    }
}

async fn run(hub: &mut Hub, args: &TimeArgs) -> Result<(), u8> {
    if let Some(days) = args.retention {
        let set = hub
            .call("time_retention_set", json!({ "retentionDays": days }))
            .await?;
        println!("timelines are kept {} days", set["retentionDays"]);
        return Ok(());
    }
    let scope = if args.target.is_empty() {
        json!({ "kind": "fleet" })
    } else if args.is_order() {
        json!({ "kind": "order", "workstreamId": args.target })
    } else {
        let listed = hub.call("projects_list", json!({})).await?;
        let projects = listed["projects"].as_array().cloned().unwrap_or_default();
        match resolve_project(&args.target, &projects) {
            Ok(project_ref) => json!({ "kind": "project", "projectRef": project_ref }),
            Err(error) => {
                eprintln!("fleetd time: {error}");
                return Err(2);
            }
        }
    };
    let range = json!({ "scope": scope, "since": args.since });
    let zone = crate::hub::attention::hub_zone();

    if let Some(rule) = &args.spans {
        let mut spans = Vec::new();
        let mut after = None;
        loop {
            let mut input =
                json!({ "scope": scope, "since": args.since, "rule": rule, "limit": 500 });
            if let Some(after) = after {
                input["afterId"] = json!(after);
            }
            let page: TimeSpansOutput = hub.typed("time_spans", input).await?;
            after = page.next_after_id.map(|n| n.get());
            spans.extend(page.spans.into_inner());
            if after.is_none() {
                break;
            }
        }
        if args.json {
            println!("{}", serde_json::to_string(&spans).unwrap_or_default());
        } else if spans.is_empty() {
            println!("no spans for {rule} since {}", local(&args.since, zone));
        } else {
            for span in &spans {
                println!("{}", span_line(span, zone));
            }
        }
        return Ok(());
    }

    if args.json {
        let breakdown = hub.call("time_breakdown", range.clone()).await?;
        let insights = hub.call("time_insights", range).await?;
        println!(
            "{}",
            json!({ "breakdown": breakdown, "insights": insights })
        );
        return Ok(());
    }
    let breakdown: TimeBreakdownOutput = hub.typed("time_breakdown", range.clone()).await?;
    let insights: TimeInsightsOutput = hub.typed("time_insights", range).await?;
    let order = if args.is_order() {
        let got = hub
            .call("order_get", json!({ "workstreamId": args.target }))
            .await?;
        Some(got["order"].clone())
    } else {
        None
    };
    println!(
        "{}",
        render(order.as_ref(), args, &breakdown, &insights, zone)
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-18T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn arguments_and_the_range() {
        let base = ["--hub", "http://hub", "--key-file", "k"];
        let parse =
            |extra: &[&str]| parse_time_args(&argv(&[extra, &base[..]].concat()), now(), Tz::UTC);
        let order = parse(&["W41", "--since", "2d"]).unwrap();
        assert!(order.is_order());
        assert_eq!(order.since, "2026-10-16T12:00:00.000Z");
        assert!(!parse(&["storefront"]).unwrap().is_order());
        assert_eq!(parse(&[]).unwrap().since, "2026-10-11T12:00:00.000Z");
        assert_eq!(
            parse_since("2026-10-01", now(), "Europe/Berlin".parse().unwrap()).unwrap(),
            "2026-09-30T22:00:00.000Z"
        );
        assert_eq!(
            parse(&["--since", "2026-10-18T09:30:00+02:00"])
                .unwrap()
                .since,
            "2026-10-18T07:30:00.000Z"
        );
        for bad in [
            &["--since", "0d"][..],
            &["--since", "401d"],
            &["--since", "7w"],
            &["--retention", "366"],
            &["a", "b"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            parse_time_args(&argv(&["W1"]), now(), Tz::UTC).unwrap().hub,
            None
        );
        assert!(
            parse_time_args(&argv(&["W1", "--hub", "h"]), now(), Tz::UTC)
                .unwrap_err()
                .contains("--key-file")
        );
    }

    #[test]
    fn a_project_by_id_title_or_folder_and_its_machine_when_ambiguous() {
        let p = |m: &str, id: &str, title: &str, root: &str| json!({ "machineId": m, "projectId": id, "title": title, "workspaceRoot": root });
        let projects = [
            p("devbox", "p1", "storefront", "/src/acme/storefront"),
            p("buildbox", "p9", "storefront", "/w/storefront"),
            p("devbox", "p2", "Docs site", "/src/acme/docs"),
        ];
        let want = |m: &str, id: &str| Ok(json!({ "machineId": m, "projectId": id }));
        assert_eq!(resolve_project("p2", &projects), want("devbox", "p2"));
        assert_eq!(resolve_project("docs", &projects), want("devbox", "p2"));
        assert_eq!(
            resolve_project("Docs site", &projects),
            want("devbox", "p2")
        );
        assert_eq!(
            resolve_project("buildbox/storefront", &projects),
            want("buildbox", "p9")
        );
        let both = resolve_project("storefront", &projects).unwrap_err();
        assert!(
            both.contains("devbox/storefront, buildbox/storefront"),
            "{both}"
        );
        assert!(
            resolve_project("nope", &projects)
                .unwrap_err()
                .starts_with("no order or project 'nope'")
        );
    }

    #[test]
    fn commands_fit_one_cell() {
        assert_eq!(
            one_line("cargo test --workspace", 60),
            "cargo test --workspace"
        );
        assert_eq!(
            one_line("gh pr create --body \"Source: done:0\n\nmore\"", 60),
            "gh pr create --body \"Source: done:0…"
        );
        assert_eq!(one_line(&"x".repeat(80), 10), format!("{}…", "x".repeat(9)));
    }

    #[test]
    fn durations_read_like_the_views() {
        let cases = [
            (250, "250ms"),
            (8_000, "8s"),
            (130_000, "2m10s"),
            (540_000, "9m"),
            (3_060_000, "51m"),
            (6_120_000, "1h42m"),
            (11_100_000, "3h05m"),
        ];
        for (ms, text) in cases {
            assert_eq!(dur(ms), text);
        }
    }

    #[test]
    fn an_order_prints_its_path_from_the_totals_even_when_cut() {
        let args = parse_time_args(
            &argv(&["W41", "--hub", "h", "--key-file", "k"]),
            now(),
            Tz::UTC,
        )
        .unwrap();
        let min = 60_000;
        let seg =
            |id: Option<u64>, cat: &str, kind: &str, label: Option<&str>, start: i64, end: i64| {
                json!({ "spanId": id, "lane": "x", "cat": cat, "kind": kind, "label": label,
                    "startMs": start * min, "endMs": end * min })
            };
        let breakdown: TimeBreakdownOutput = serde_json::from_value(json!({
            "wallMs": 60 * min, "agentMs": 90 * min,
            "criticalPath": {
                "startMs": 0, "endMs": 60 * min, "segmentsTruncated": true,
                "totals": [
                    { "cat": "model", "ms": 9 * min },
                    { "cat": "idle", "ms": min },
                    { "cat": "human", "ms": 30 * min },
                    { "cat": "pipeline", "ms": 20 * min, "kinds": [
                        { "kind": "change.ci", "ms": 15 * min, "n": 1 }, { "kind": "change.merge", "ms": 5 * min, "n": 1 } ] },
                ],
                "nothingRunningMs": min, "offPathMs": 30 * min,
                "segments": [
                    seg(Some(1), "model", "model.output", None, 0, 9),
                    seg(None, "idle", "gap", None, 9, 10),
                    seg(Some(2), "human", "wait.request", Some("deploy.region"), 10, 40),
                    seg(Some(4), "pipeline", "change.merge", None, 55, 60),
                ],
            },
            "byCategory": [
                { "cat": "tools", "ms": 30 * min, "n": 52, "kinds": [
                    { "kind": "tool.bash", "ms": 25 * min, "n": 12 },
                    { "kind": "tool.read", "ms": 5 * min, "n": 40 } ] },
                { "cat": "human", "ms": 30 * min, "n": 1, "kinds": [{ "kind": "wait.request", "ms": 30 * min, "n": 1 }] },
            ],
            "topCommands": [{ "label": "cargo test --workspace", "family": "cargo test", "n": 3,
                              "totalMs": 390_000, "p50Ms": 130_000, "maxMs": 140_000, "failed": 1 }],
            "repeated": [], "ciChecks": [], "humanWait": { "totalMs": 30 * min, "n": 1 },
            "retentionDays": 30, "storedBytes": 0,
            "coverage": { "complete": false, "capped": true, "detailSince": "2026-10-17T00:00:00Z",
                          "gaps": [{ "why": "nothing_running", "fromMs": 9 * min, "toMs": 10 * min }] },
        }))
        .unwrap();
        let insights: TimeInsightsOutput = serde_json::from_value(json!({ "insights": [{
            "rule": "human_wait", "message": "waited 30m on you (1 request)", "numbers": [], "spanIds": [2] }] }))
        .unwrap();
        let order = json!({ "title": "Add three short pages", "state": "done" });
        let text = render(Some(&order), &args, &breakdown, &insights, Tz::UTC);
        let expected = "\
W41 Add three short pages  done
wall 1h00m  critical path 1h00m  agent time 1h30m  parallelism 1.5x  coverage incomplete (1 gap; newest spans only; commands and findings from 2026-10-17 00:00)

critical path      1h00m
  you                30m  50%  deploy.region 30m
  ci                 15m  25%
  model               9m  15%
  train               5m   8%
  nothing running     1m   2%
  (the path has more than 4 steps: the rows cover all of it, the names only the longest)

agent time  1h30m
  tools       30m  33%  Bash 25m (12)  Read 5m
  you         30m  33%

slowest commands          n  total  median  failed
  cargo test --workspace  3  6m30s   2m10s  1

findings
  1. waited 30m on you (1 request)
     fleetd time W41 --spans human_wait";
        assert_eq!(text, expected);
    }
}
