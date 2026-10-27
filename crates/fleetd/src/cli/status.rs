//! `fleetd status`: the same rows as the app's Status screen, read from the hub (status_get): each project's word and
//! its work in groups. With `--watch` it reads them again after each event that can change one (events_wait). It never
//! shows a time estimate, and every time printed is absolute, so a block left on screen never reads as fresher than it
//! is.

use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::mcp::StatusGetOutput;
use fleetd_contracts::status::{ProjectRowState, ProjectStatusRow, StatusGroup, StatusItem};
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::mcp_client::{McpClient, McpError};
use super::time::resolve_project;

pub const STATUS_USAGE: &str = r#"  status [<project>] [--watch] [--json] [--hub <url> --key-file <path> | --home <dir>]
             one row per project, as the app's Status screen shows it: what it is doing
             (working, waiting on you, blocked and why, idle), its work in groups (waiting on
             you, in review, working, landing, idle, done), agents running and the last merge;
             one project by id or title (<machine>/<project> when two machines have one).
             --watch prints the rows again after each change; a stale row says so. On the hub
             machine it needs no --hub or --key-file
"#;

/// The longest events_wait the hub takes; the CLI asks again right after an empty answer.
const WAIT_SEC: u64 = 50;
/// Reconnect backoff after the hub stops answering, in seconds.
const BACKOFF: &[u64] = &[1, 2, 5, 10, 30];

#[derive(Debug, PartialEq)]
pub struct StatusArgs {
    /// Both, or neither for the hub on this machine.
    pub hub: Option<(String, String)>,
    /// That hub's home, when it isn't the default.
    pub home: Option<String>,
    /// The project as given; empty for every project.
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
            "give one project, got '{}'",
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

// ---- printing the rows ----

/// `14:02:07` on the day of `now`, `Thu 14:02` within a week, else the date, in the hub machine's zone.
fn at(t: &Timestamp, now: &Timestamp, zone: Tz) -> String {
    let parse = |iso: &str| {
        DateTime::parse_from_rfc3339(iso)
            .ok()
            .map(|t| t.with_timezone(&Utc).with_timezone(&zone))
    };
    let Some(local) = parse(&t.0) else {
        return t.0.clone();
    };
    match parse(&now.0).map(|n| (local.date_naive() - n.date_naive()).num_days()) {
        Some(0) => local.format("%H:%M:%S").to_string(),
        Some(-6..=6) => local.format("%a %H:%M").to_string(),
        _ => local.format("%Y-%m-%d %H:%M").to_string(),
    }
}

/// A group as Status says it.
fn group_word(g: StatusGroup) -> &'static str {
    match g {
        StatusGroup::WaitingOnYou => "waiting on you",
        StatusGroup::InReview => "in review",
        StatusGroup::Working => "working",
        StatusGroup::Landing => "landing",
        StatusGroup::Idle | StatusGroup::Unknown => "idle",
        StatusGroup::Done => "done",
    }
}

/// "1 waiting on you · 2 working · 3 done": the groups that have work, in order.
fn counts_line(row: &ProjectStatusRow) -> String {
    let c = &row.counts;
    [
        (c.waiting_on_you, StatusGroup::WaitingOnYou),
        (c.in_review, StatusGroup::InReview),
        (c.working, StatusGroup::Working),
        (c.landing, StatusGroup::Landing),
        (c.idle, StatusGroup::Idle),
        (c.done, StatusGroup::Done),
    ]
    .into_iter()
    .filter(|(n, _)| n.get() > 0)
    .map(|(n, g)| format!("{} {}", n.get(), group_word(g)))
    .collect::<Vec<_>>()
    .join(" · ")
}

/// "in review: Add the cart page (T4, #212)", "waiting on you: Approve the deploy (approval)".
fn item_line(i: &StatusItem) -> String {
    let refs: Vec<String> = i
        .task_id
        .iter()
        .map(|t| t.to_string())
        .chain(i.pr.iter().map(|p| format!("#{}", p.number.get())))
        .chain(i.why.iter().map(|w| w.to_string()))
        .collect();
    let refs = if refs.is_empty() {
        String::new()
    } else {
        format!(" ({})", refs.join(", "))
    };
    format!("  {}: {}{refs}", group_word(i.group), i.title)
}

fn word(row: &ProjectStatusRow) -> String {
    match row.state {
        ProjectRowState::Working => "working".into(),
        ProjectRowState::WaitingOnYou => "waiting on you".into(),
        ProjectRowState::Blocked => match &row.blocked_reason {
            Some(why) => format!("blocked: {why}"),
            None => "blocked".into(),
        },
        ProjectRowState::Idle | ProjectRowState::Unknown => "idle".into(),
    }
}

/// One project: its word, its groups' counts, agents and last merge, its last 7 days' merges, its warning (a red
/// main), each listed item, and whether it is stale.
fn render_row(row: &ProjectStatusRow, zone: Tz) -> Vec<String> {
    let now = &row.as_of;
    let mut out = vec![format!("{}: {}", row.title, word(row))];
    let counts = counts_line(row);
    let agents = match row.agents_running.get() {
        1 => "1 agent".to_owned(),
        n => format!("{n} agents"),
    };
    let merged = row.last_merged.as_ref().map_or_else(
        || "nothing merged yet".to_owned(),
        |m| {
            let pr = m
                .pr_number
                .map(|n| format!(" #{}", n.get()))
                .unwrap_or_default();
            format!("merged {}{pr} {}", m.title, at(&m.at, now, zone))
        },
    );
    let parts: Vec<&str> = [counts.as_str(), agents.as_str(), merged.as_str()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    out.push(format!("  {}", parts.join(" · ")));
    if let Some(n) = row.merged_7d {
        let share = row
            .through_fleetd_pct_7d
            .map(|p| format!(" · {}% through fleetd", p.get().round() as i64))
            .unwrap_or_default();
        out.push(format!("  {} merged in 7 days{share}", n.get()));
    }
    if let Some(warning) = &row.warning {
        out.push(format!("  warning: {warning}"));
    }
    out.extend(row.items.iter().map(item_line));
    if let Some(mark) = &row.stale {
        out.push(format!(
            "  STALE since {}: {}",
            at(&mark.since, now, zone),
            mark.reason
        ));
    }
    out
}

pub fn render(rows: &[ProjectStatusRow], zone: Tz) -> String {
    let Some(first) = rows.first() else {
        return "no projects yet".into();
    };
    let mut out = vec![format!(
        "Status at {}",
        at(&first.as_of, &first.as_of, zone)
    )];
    for row in rows {
        out.push(String::new());
        out.extend(render_row(row, zone));
    }
    out.join("\n")
}

/// What `fleetd status --watch` prints above the last rows while the hub does not answer. It is the CLI's own
/// connection, not a judgement on the hub's data.
fn not_live_banner(last: &[ProjectStatusRow], zone: Tz, reason: &str) -> String {
    let from = last
        .first()
        .map(|r| format!(" · rows from {}", at(&r.as_of, &r.as_of, zone)))
        .unwrap_or_default();
    format!("NOT LIVE: reconnecting to the hub ({reason}){from}")
}

// ---- talking to the hub ----

enum Target {
    Remote { url: String, key: String },
    Local { home: PathBuf },
}

impl Target {
    fn from_args(hub: &Option<(String, String)>, home: Option<&str>) -> Result<Self, u8> {
        match hub {
            Some((url, key_file)) => match std::fs::read_to_string(key_file) {
                Ok(key) => Ok(Target::Remote {
                    url: url.clone(),
                    key: key.trim().to_owned(),
                }),
                Err(error) => {
                    eprintln!("fleetd status: cannot read --key-file: {error}");
                    Err(2)
                }
            },
            None => match super::hub_key::resolve_home(home) {
                Ok(home) => Ok(Target::Local { home }),
                Err(message) => {
                    eprintln!(
                        "fleetd status: {message}\n  fix: run it on the hub machine, or pass --hub <url> --key-file <path>"
                    );
                    Err(4)
                }
            },
        }
    }

    async fn connect(&self) -> Result<McpClient, (u8, String)> {
        match self {
            Target::Remote { url, key } => {
                McpClient::connect(url, key, "fleetd-status", Duration::from_secs(15))
                    .await
                    .map_err(|error| (exit_for(&error), error.message()))
            }
            Target::Local { home } => super::setup::doctor::connect_as(home, "fleetd-status")
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
    /// The hub answered with a refusal or a shape this build does not know: exit with this code after printing.
    Exit(u8),
}

async fn call<A: serde::de::DeserializeOwned>(
    client: &mut McpClient,
    tool: &str,
    input: Value,
    timeout: Duration,
) -> Result<A, CallError> {
    let result = client
        .call_tool(tool, input, timeout)
        .await
        .map_err(CallError::Transport)?;
    if result.is_error {
        let text = |k: &str| result.body.get(k).and_then(Value::as_str);
        let fix = text("fix")
            .map(|f| format!("\n  fix: {f}"))
            .unwrap_or_default();
        eprintln!(
            "fleetd status: {}{fix}",
            text("message").unwrap_or("the hub refused")
        );
        return Err(CallError::Exit(3));
    }
    serde_json::from_value(result.body).map_err(|error| {
        eprintln!(
            "fleetd status: {tool} answered in a shape this fleetd does not know ({error}); update fleetd"
        );
        CallError::Exit(1)
    })
}

fn fail(error: CallError) -> u8 {
    match error {
        CallError::Transport(error) => {
            eprintln!("fleetd status: {}", error.message());
            exit_for(&error)
        }
        CallError::Exit(code) => code,
    }
}

type Rows = Vec<ProjectStatusRow>;

/// The rows (only `only`'s when given).
async fn read(client: &mut McpClient, only: Option<&Value>) -> Result<Rows, CallError> {
    let listed: StatusGetOutput =
        call(client, "status_get", json!({}), Duration::from_secs(30)).await?;
    Ok(listed
        .rows
        .map(|rows| rows.to_vec())
        .unwrap_or_default()
        .into_iter()
        .filter(|row| {
            only.is_none_or(|o| *o == serde_json::to_value(&row.project_ref).unwrap_or_default())
        })
        .collect())
}

struct Printer {
    json: bool,
    tty: bool,
    zone: Tz,
}

impl Printer {
    fn show(&self, rows: &Rows) {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            let all: Vec<Value> = rows.iter().map(|row| json!({ "row": row })).collect();
            let _ = writeln!(stdout, "{}", Value::Array(all));
        } else if self.tty {
            // Home, clear: the new rows replace the old in place.
            let _ = writeln!(stdout, "\x1b[H\x1b[2J{}", render(rows, self.zone));
        } else {
            let _ = writeln!(stdout, "{}\n", render(rows, self.zone));
        }
        let _ = stdout.flush();
    }

    fn banner(&self, line: &str) {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            let _ = writeln!(stdout, "{}", json!({ "notLive": line }));
        } else if self.tty {
            // The top line, cleared, then back: the last rows stay on screen under the banner.
            let _ = write!(stdout, "\x1b7\x1b[H\x1b[2K{line}\x1b8");
        } else {
            let _ = writeln!(stdout, "{line}\n");
        }
        let _ = stdout.flush();
    }
}

/// The event log's end now: `--watch` waits for what comes after it.
async fn head(client: &mut McpClient) -> Result<Value, CallError> {
    let got: Value = call(
        client,
        "events_wait",
        json!({ "timeoutSec": 0 }),
        Duration::from_secs(30),
    )
    .await?;
    Ok(got["cursor"].clone())
}

/// `fleetd status …`: exit 0, 1 when the hub answered in a shape this build does not know, 2 on bad arguments or an
/// unknown project, 3 when the hub refused the key or the call, 4 when it cannot be reached.
pub async fn status_command(argv: &[String]) -> u8 {
    let args = match parse_status_args(argv) {
        Ok(args) => args,
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{STATUS_USAGE}");
            return 2;
        }
    };
    let target = match Target::from_args(&args.hub, args.home.as_deref()) {
        Ok(target) => target,
        Err(code) => return code,
    };
    let mut client = match target.connect().await {
        Ok(client) => client,
        Err((code, message)) => {
            eprintln!("fleetd status: {message}");
            return code;
        }
    };
    let only = if args.target.is_empty() {
        None
    } else {
        let listed: Value = match call(
            &mut client,
            "project_get",
            json!({}),
            Duration::from_secs(30),
        )
        .await
        {
            Ok(v) => v,
            Err(error) => return fail(error),
        };
        let projects = listed["projects"].as_array().cloned().unwrap_or_default();
        match resolve_project(&args.target, &projects) {
            Ok(r) => Some(r),
            Err(error) => {
                eprintln!("fleetd status: {error}");
                return 2;
            }
        }
    };
    let printer = Printer {
        json: args.json,
        tty: args.watch && !args.json && std::io::stdout().is_terminal(),
        zone: crate::hub::attention::hub_zone(),
    };
    let mut cursor = Value::Null;
    if args.watch {
        cursor = match head(&mut client).await {
            Ok(c) => c,
            Err(error) => return fail(error),
        };
    }
    let mut rows = match read(&mut client, only.as_ref()).await {
        Ok(rows) => rows,
        Err(error) => return fail(error),
    };
    printer.show(&rows);
    if !args.json
        && let Some(line) = super::versions::line(&mut client).await
    {
        println!("{line}");
    }
    if !args.watch {
        return 0;
    }
    let types = serde_json::to_value(crate::hub::status::rows::CHANGES_A_ROW).unwrap_or_default();
    let mut stop = super::Stop::on_signals();
    'watch: loop {
        let wait = json!({ "cursor": cursor, "types": types, "timeoutSec": WAIT_SEC });
        let answer = tokio::select! {
            _ = stop.wait() => break,
            answer = call::<Value>(&mut client, "events_wait", wait, Duration::from_secs(WAIT_SEC + 15)) => answer,
        };
        let reason = match answer {
            Ok(got) => {
                cursor = got["cursor"].clone();
                if got["events"].as_array().is_none_or(Vec::is_empty) {
                    continue;
                }
                match read(&mut client, only.as_ref()).await {
                    Ok(next) => {
                        if next != rows {
                            rows = next;
                            printer.show(&rows);
                        }
                        continue;
                    }
                    Err(CallError::Transport(McpError::Other(reason))) => reason,
                    Err(error) => return fail(error),
                }
            }
            Err(CallError::Transport(McpError::Other(reason))) => reason,
            Err(error) => return fail(error),
        };
        printer.banner(&not_live_banner(&rows, printer.zone, &reason));
        let mut attempt = 0;
        loop {
            let delay = BACKOFF[attempt.min(BACKOFF.len() - 1)];
            attempt += 1;
            if stop.sleep(Duration::from_secs(delay)).await {
                break 'watch;
            }
            let Ok(mut fresh) = target.connect().await else {
                continue;
            };
            let (Ok(c), Ok(next)) = (
                head(&mut fresh).await,
                read(&mut fresh, only.as_ref()).await,
            ) else {
                continue;
            };
            (client, cursor, rows) = (fresh, c, next);
            printer.show(&rows);
            break;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn arguments() {
        let a = parse_status_args(&argv(&["storefront", "--watch"])).unwrap();
        assert_eq!(
            (a.target.as_str(), a.watch, a.json, a.hub),
            ("storefront", true, false, None)
        );
        assert_eq!(parse_status_args(&argv(&[])).unwrap().target, "");
        assert!(parse_status_args(&argv(&["a", "b"])).is_err());
        assert_eq!(
            parse_status_args(&argv(&["--hub", "http://h"])).unwrap_err(),
            "--hub needs --key-file"
        );
    }

    fn row(extra: Value) -> ProjectStatusRow {
        let mut v = json!({
            "projectRef": { "machineId": "devbox", "projectId": "p1" }, "title": "storefront", "state": "working",
            "counts": { "waitingOnYou": 1, "inReview": 1, "working": 2, "landing": 0, "idle": 0, "done": 9 },
            "items": [
                { "group": "waiting_on_you", "title": "Deploy to staging", "why": "approval", "at": "2026-10-18T14:00:00Z" },
                { "group": "in_review", "title": "Add the cart page", "taskId": "T4",
                  "pr": { "repo": "acme/storefront", "number": 212, "url": "https://github.com/acme/storefront/pull/212" },
                  "at": "2026-10-18T13:50:00Z" },
            ],
            "agentsRunning": 1,
            "lastMerged": { "title": "Add the login page", "prNumber": 208, "at": "2026-10-18T13:12:00Z" },
            "asOf": "2026-10-18T14:02:07Z",
        });
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_row_prints_its_word_groups_agents_merge_and_items() {
        let row = row(json!({ "merged7d": 12, "throughFleetdPct7d": 63.6 }));
        let text = render(&[row], chrono_tz::UTC);
        assert_eq!(
            text,
            "Status at 14:02:07\n\nstorefront: working\n  1 waiting on you · 1 in review · 2 working · 9 done · 1 agent · \
             merged Add the login page #208 13:12:00\n  12 merged in 7 days · 64% through fleetd\n  \
             waiting on you: Deploy to staging (approval)\n  in review: Add the cart page (T4, #212)"
        );
    }

    #[test]
    fn a_red_main_is_a_warning_under_a_working_row() {
        let row = row(json!({ "warning": "`ios sessions` is red on main, fix in progress" }));
        let text = render(&[row], chrono_tz::UTC);
        assert!(
            text.contains(
                "storefront: working\n  1 waiting on you · 1 in review · 2 working · 9 done · 1 agent · merged Add the \
                 login page #208 13:12:00\n  warning: `ios sessions` is red on main, fix in progress\n"
            ),
            "{text}"
        );
    }

    #[test]
    fn a_blocked_stale_row_says_why_and_since_when_and_nothing_estimates_time() {
        let stale = row(json!({
            "state": "blocked", "blockedReason": "devbox is offline", "agentsRunning": 0,
            "counts": { "waitingOnYou": 0, "inReview": 0, "working": 0, "landing": 0, "idle": 0, "done": 0 },
            "items": [], "lastMerged": null,
            "stale": { "since": "2026-10-18T13:58:52Z", "reason": "no heartbeat from devbox since 13:58" },
        }));
        let text = render(&[stale], chrono_tz::UTC);
        assert!(
            text.contains(
                "storefront: blocked: devbox is offline\n  0 agents · nothing merged yet"
            ),
            "{text}"
        );
        assert!(
            text.contains("STALE since 13:58:52: no heartbeat from devbox since 13:58"),
            "{text}"
        );
        let lower = text.to_lowercase();
        for word in ["eta", "left", "remaining", "usual", "estimate", "%"] {
            assert!(!lower.contains(word), "{word:?} in {text}");
        }
    }
}

#[cfg(test)]
mod against_a_hub {
    use std::sync::Arc;

    use crate::clock::SystemClock;
    use crate::hub::api::{self, HubConfig, Listen};
    use crate::hub::store::HubDb;
    use fleetd_contracts::auth::{Grant, KeyKind};
    use fleetd_contracts::ids::MachineId;
    use serde_json::json;

    /// Scripts read the exit code: a project there is reads 0, one there isn't 2.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_known_project_exits_0_and_an_unknown_one_2() {
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
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": "storefront", "title": "storefront",
                    "workspaceRoot": "/work/storefront",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                    "lastActivityAt": "2026-10-18T10:00:00.000Z",
                }))
                .unwrap()],
            )
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
        let status = |project: &str| {
            let argv: Vec<String> = [
                project,
                "--hub",
                &url,
                "--key-file",
                key_file.to_str().unwrap(),
            ]
            .map(str::to_owned)
            .to_vec();
            async move { super::status_command(&argv).await }
        };
        assert_eq!(status("storefront").await, 0);
        assert_eq!(status("nope").await, 2, "no such project");
        served.abort();
    }
}
