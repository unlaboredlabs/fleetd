//! `fleetd steer`: a person redirects an order's lead or one of its agents mid-run, over the hub's MCP endpoint
//! (steer_send, steer_withdraw, steers_list). A steer speaks for the human, so it needs a human key (`fleetd hub key
//! create --human`). `--wait` follows the receipt the hub records from claude's own frames, through events_wait.

use std::time::Duration;

use chrono::DateTime;
use serde_json::{Value, json};

use super::args::{self, Kind, Spec};
use super::mcp_client::{McpClient, McpError};

pub const STEER_USAGE: &str = r#"  steer <W|T> "<text>" [--now] [--wait] --key-file <human key> [--hub <url> | --home <dir>]
             steer an order's lead (W41) or one agent (T88) mid-run. Plain: it lands at the
             agent's next step, after the tool it is running returns. --now stops that step and
             delivers at once. --wait follows the receipt: exit 0 acknowledged, 1 not
             acknowledged, withdrawn or failed. Without --hub it uses the hub on this machine
  steer withdraw S<n> --key-file <human key> [--hub <url> | --home <dir>]
             take back a steer the agent has not taken in yet
  steers [W|T] --key-file <human key> [--hub <url> | --home <dir>]
             recent steers and their receipts
"#;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest events_wait the hub takes.
const WAIT_SEC: u64 = 50;

#[derive(Debug, PartialEq)]
pub enum SteerCommand {
    Send {
        target: Value,
        text: String,
        mode: &'static str,
        wait: bool,
    },
    Withdraw {
        steer_id: String,
    },
    List {
        target: Option<Value>,
    },
}

#[derive(Debug, PartialEq)]
pub struct SteerArgs {
    pub command: SteerCommand,
    pub hub: Option<String>,
    /// The hub on this machine's home, when it isn't the default.
    pub home: Option<String>,
    pub key_file: String,
}

fn is_numbered(id: &str, prefix: char) -> bool {
    id.strip_prefix(prefix).is_some_and(|n| {
        !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// `W41` is an order (its lead), `T88` one task.
pub fn target_of(id: &str) -> Result<Value, String> {
    if is_numbered(id, 'W') {
        Ok(json!({ "workstreamId": id }))
    } else if is_numbered(id, 'T') {
        Ok(json!({ "taskId": id }))
    } else {
        Err(format!(
            "'{id}' is not an order (W41) or a task (T88); `fleetd status` lists them"
        ))
    }
}

/// `steer …` when `list` is false, `steers …` when it is.
pub fn parse_steer_args(argv: &[String], list: bool) -> Result<SteerArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("home", Kind::Str),
        ("now", Kind::Bool),
        ("wait", Kind::Bool),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    let Some(key_file) = v.string("key-file").filter(|s| !s.is_empty()) else {
        return Err(
            "--key-file is required: a steer speaks for you, so it needs a human key (fleetd hub key create --human)"
                .into(),
        );
    };
    let hub = v.string("hub").filter(|s| !s.is_empty());
    let p = &v.positionals;
    let no_send_flags = |what: &str| {
        if v.flag("now") || v.flag("wait") {
            Err(format!(
                "--now and --wait are for sending a steer, not {what}"
            ))
        } else {
            Ok(())
        }
    };
    let command = if list {
        no_send_flags("listing")?;
        match p.as_slice() {
            [] => SteerCommand::List { target: None },
            [id] => SteerCommand::List {
                target: Some(target_of(id)?),
            },
            _ => return Err("expected fleetd steers [W|T]".into()),
        }
    } else if p.first().map(String::as_str) == Some("withdraw") {
        no_send_flags("withdraw")?;
        match &p[1..] {
            [id] if is_numbered(id, 'S') => SteerCommand::Withdraw {
                steer_id: id.clone(),
            },
            _ => return Err("expected fleetd steer withdraw S<n>".into()),
        }
    } else {
        let [id, words @ ..] = p.as_slice() else {
            return Err(r#"expected fleetd steer <W|T> "<text>""#.into());
        };
        let text = words.join(" ");
        if text.trim().is_empty() {
            return Err(r#"expected fleetd steer <W|T> "<text>""#.into());
        }
        SteerCommand::Send {
            target: target_of(id)?,
            text,
            mode: if v.flag("now") { "now" } else { "queue" },
            wait: v.flag("wait"),
        }
    };
    Ok(SteerArgs {
        command,
        hub,
        home: v.string("home").filter(|s| !s.is_empty()),
        key_file,
    })
}

// ---- receipts ----

fn st<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// `14:02:07.120`, in this machine's zone (the same rule the hub uses for its own).
fn clock(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|t| {
            t.with_timezone(&crate::hub::attention::hub_zone())
                .format("%H:%M:%S%.3f")
                .to_string()
        })
        .unwrap_or_else(|_| iso.to_owned())
}

fn stage_of(steer: &Value) -> &str {
    st(steer, "stage").unwrap_or("queued")
}

/// One line for the steer's current stage, as the hub recorded it.
pub fn receipt_line(steer: &Value) -> String {
    let id = st(steer, "id").unwrap_or("S?");
    let stage = stage_of(steer);
    let at = |key: &str| {
        st(steer, key)
            .map(|t| format!(" {}", clock(t)))
            .unwrap_or_default()
    };
    let detail = st(steer, "detail")
        .map(|d| format!(" ({d})"))
        .unwrap_or_default();
    let quote = |key: &str| {
        st(steer, key)
            .map(|e| format!("  \"{}\"", e.replace('\n', " ")))
            .unwrap_or_default()
    };
    match stage {
        "queued" => format!("{id} queued{}{detail}", at("queuedAt")),
        "delivered" => {
            let how = match st(steer, "how") {
                Some("stopped") => format!(
                    " (stopped {})",
                    st(steer, "stoppedTool").unwrap_or("its current step")
                ),
                Some("boundary") => " (after the running tool returned)".into(),
                Some("turn") => " (started a turn)".into(),
                Some("joined") => " (joined the running turn)".into(),
                _ => String::new(),
            };
            format!("{id} delivered{}{how}{detail}", at("deliveredAt"))
        }
        "acknowledged" => format!("{id} acknowledged{}{}", at("ackedAt"), quote("ackExcerpt")),
        "unacknowledged" => format!(
            "{id} not acknowledged: its reply did not name {id}{}",
            st(steer, "ackExcerpt")
                .map(|e| format!("; it said \"{}\"", e.replace('\n', " ")))
                .unwrap_or_default()
        ),
        other => format!("{id} {other}{detail}"),
    }
}

/// The exit code once the receipt stops moving: 0 acknowledged, 1 anything else final; `None` while it can move.
pub fn exit_for_stage(stage: &str) -> Option<u8> {
    match stage {
        "acknowledged" => Some(0),
        "unacknowledged" | "withdrawn" | "failed" | "expired" => Some(1),
        _ => None,
    }
}

/// The receipts `--wait` has not printed yet, in order: a fast steer can be delivered and acknowledged between two
/// reads, and the delivered line still says how.
pub fn new_lines(steer: &Value, printed: &mut Vec<String>) -> Vec<String> {
    let mut lines = Vec::new();
    let stage = stage_of(steer);
    let reached_delivery = st(steer, "deliveredAt").is_some();
    let mut push = |line: String, stage: &str| {
        if !printed.iter().any(|s| s == stage) {
            printed.push(stage.to_owned());
            lines.push(line);
        }
    };
    if stage != "queued" && reached_delivery && stage != "delivered" {
        let mut delivered = steer.clone();
        delivered["stage"] = json!("delivered");
        push(receipt_line(&delivered), "delivered");
    }
    push(receipt_line(steer), stage);
    lines
}

// ---- talking to the hub ----

fn client_request_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16)
        .map(|_| format!("{:02x}", rng.r#gen::<u8>()))
        .collect()
}

/// `--hub`, else the hub this machine runs (`fleetd init`), at `--home` when given.
pub(super) fn hub_url(hub: Option<String>, home: Option<&str>) -> Result<String, String> {
    if let Some(hub) = hub {
        return Ok(hub);
    }
    let home = super::hub_key::resolve_home(home)?;
    match super::setup::state::read_setup(&home)? {
        Some(state) => Ok(format!("http://{}", state.listen)),
        None => Err(format!(
            "no hub is set up on this machine ({}); pass --hub <url>",
            home.display()
        )),
    }
}

pub(super) enum Failure {
    /// Exit 4: the hub could not be reached.
    Unreachable(String),
    /// Exit 3: the hub refused (or the key is not a human key).
    Refused(String),
}

impl Failure {
    fn report(self) -> u8 {
        self.report_as("steer")
    }

    pub(super) fn report_as(self, command: &str) -> u8 {
        let (code, message) = match self {
            Failure::Unreachable(m) => (4, m),
            Failure::Refused(m) => (3, m),
        };
        eprintln!("fleetd {command}: {message}");
        code
    }
}

impl From<McpError> for Failure {
    fn from(error: McpError) -> Self {
        match error {
            McpError::Unauthorized => Failure::Refused(error.message()),
            McpError::Other(m) => Failure::Unreachable(m),
        }
    }
}

pub(super) async fn call(
    client: &mut McpClient,
    tool: &str,
    input: Value,
    timeout: Duration,
) -> Result<Value, Failure> {
    let result = client.call_tool(tool, input, timeout).await?;
    if result.is_error {
        let text = |k: &str| result.body.get(k).and_then(Value::as_str);
        return Err(Failure::Refused(format!(
            "{}{}",
            text("message").unwrap_or("the hub refused"),
            text("fix")
                .map(|f| format!("\n  fix: {f}"))
                .unwrap_or_default()
        )));
    }
    Ok(result.body)
}

/// The steer as the hub has it now.
async fn read_steer(client: &mut McpClient, steer: &Value) -> Result<Value, Failure> {
    let id = st(steer, "id").unwrap_or_default();
    let mut input = steer.get("target").cloned().unwrap_or_else(|| json!({}));
    input["limit"] = json!(100);
    let listed = call(client, "steers_list", input, CALL_TIMEOUT).await?;
    Ok(listed
        .get("steers")
        .and_then(Value::as_array)
        .and_then(|all| all.iter().find(|s| st(s, "id") == Some(id)))
        .cloned()
        .unwrap_or_else(|| steer.clone()))
}

/// Prints each receipt as the hub records it, until it is final.
async fn follow(
    client: &mut McpClient,
    mut steer: Value,
    mut cursor: Value,
) -> Result<u8, Failure> {
    let id = st(&steer, "id").unwrap_or_default().to_owned();
    let mut printed = vec!["queued".to_owned()];
    loop {
        steer = read_steer(client, &steer).await?;
        for line in new_lines(&steer, &mut printed) {
            println!("{line}");
        }
        if let Some(code) = exit_for_stage(stage_of(&steer)) {
            return Ok(code);
        }
        // Long-poll for this steer's next receipt; any steer event for it means read it again.
        loop {
            let page = call(
                client,
                "events_wait",
                json!({
                    "cursor": cursor,
                    "timeoutSec": WAIT_SEC,
                    "types": ["steer.delivered", "steer.acknowledged", "steer.unacknowledged", "steer.withdrawn", "steer.failed"],
                }),
                Duration::from_secs(WAIT_SEC + 20),
            )
            .await?;
            cursor = page.get("cursor").cloned().unwrap_or(cursor);
            let ours = page
                .get("events")
                .and_then(Value::as_array)
                .is_some_and(|events| {
                    events
                        .iter()
                        .any(|e| e.get("data").and_then(|d| st(d, "steerId")) == Some(id.as_str()))
                });
            if ours {
                break;
            }
        }
    }
}

async fn run(args: SteerArgs) -> Result<u8, Failure> {
    let key = std::fs::read_to_string(&args.key_file)
        .map(|k| k.trim().to_owned())
        .map_err(|error| Failure::Refused(format!("cannot read --key-file: {error}")))?;
    let url = hub_url(args.hub, args.home.as_deref()).map_err(Failure::Unreachable)?;
    let mut client =
        McpClient::connect(&url, &key, "fleetd-steer", Duration::from_secs(15)).await?;
    match args.command {
        SteerCommand::Send {
            target,
            text,
            mode,
            wait,
        } => {
            // The cursor before the send, so no receipt slips past --wait.
            let cursor = if wait {
                call(&mut client, "fleetd_status", json!({}), CALL_TIMEOUT)
                    .await?
                    .get("cursor")
                    .cloned()
                    .unwrap_or(json!(0))
            } else {
                Value::Null
            };
            let steer = call(
                &mut client,
                "steer_send",
                json!({ "target": target, "text": text, "mode": mode, "clientRequestId": client_request_id() }),
                CALL_TIMEOUT,
            )
            .await?;
            println!("{}", receipt_line(&steer));
            if !wait {
                let id = st(&steer, "id").unwrap_or("S?");
                println!(
                    "{}",
                    if mode == "now" {
                        "it stops the agent's current step; `fleetd steers` shows its receipt"
                            .to_owned()
                    } else {
                        format!(
                            "it lands at the agent's next step; `fleetd steer withdraw {id}` takes it back until then"
                        )
                    }
                );
                return Ok(0);
            }
            follow(&mut client, steer, cursor).await
        }
        SteerCommand::Withdraw { steer_id } => {
            let steer = call(
                &mut client,
                "steer_withdraw",
                json!({ "steerId": steer_id }),
                CALL_TIMEOUT,
            )
            .await?;
            println!("{}", receipt_line(&steer));
            Ok(0)
        }
        SteerCommand::List { target } => {
            let mut input = target.unwrap_or_else(|| json!({}));
            input["limit"] = json!(20);
            let listed = call(&mut client, "steers_list", input, CALL_TIMEOUT).await?;
            let steers = listed
                .get("steers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if steers.is_empty() {
                println!("no steers yet");
            }
            for steer in &steers {
                let to = steer
                    .get("target")
                    .and_then(|t| st(t, "taskId").or_else(|| st(t, "workstreamId")))
                    .unwrap_or("?");
                let text: String = st(steer, "text").unwrap_or("").chars().take(80).collect();
                println!("{} → {to}: \"{text}\"", st(steer, "id").unwrap_or("S?"));
                println!("  {}", receipt_line(steer));
            }
            Ok(0)
        }
    }
}

/// `fleetd steer …` (`list` false) and `fleetd steers …` (`list` true).
pub async fn steer_command(argv: &[String], list: bool) -> u8 {
    match parse_steer_args(argv, list) {
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{STEER_USAGE}");
            2
        }
        Ok(args) => run(args).await.unwrap_or_else(Failure::report),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn enter_is_queue_and_now_is_now_for_a_lead_or_a_task() {
        let sent = parse_steer_args(
            &argv(&["W41", "skip", "the docs", "--key-file", "k"]),
            false,
        )
        .unwrap();
        assert_eq!(
            sent.command,
            SteerCommand::Send {
                target: json!({ "workstreamId": "W41" }),
                text: "skip the docs".into(),
                mode: "queue",
                wait: false
            }
        );
        let now = parse_steer_args(
            &argv(&["T88", "stop", "--now", "--wait", "--key-file", "k"]),
            false,
        )
        .unwrap();
        assert!(matches!(
            now.command,
            SteerCommand::Send { mode: "now", wait: true, ref target, .. } if *target == json!({ "taskId": "T88" })
        ));
        assert_eq!(now.hub, None);
    }

    #[test]
    fn bad_steers_are_refused_before_the_hub() {
        let err = |a: &[&str], list| parse_steer_args(&argv(a), list).unwrap_err();
        assert!(err(&["W41", "x"], false).contains("--key-file is required"));
        assert!(err(&["W41", "--key-file", "k"], false).starts_with("expected"));
        assert!(err(&["P3", "x", "--key-file", "k"], false).contains("not an order"));
        assert!(err(&["W0", "x", "--key-file", "k"], false).contains("not an order"));
        assert!(err(&["withdraw", "12", "--key-file", "k"], false).contains("withdraw S<n>"));
        assert!(
            err(&["withdraw", "S12", "--now", "--key-file", "k"], false).contains("not withdraw")
        );
        assert!(err(&["--wait", "--key-file", "k"], true).contains("not listing"));
        let withdraw =
            parse_steer_args(&argv(&["withdraw", "S12", "--key-file", "k"]), false).unwrap();
        assert_eq!(
            withdraw.command,
            SteerCommand::Withdraw {
                steer_id: "S12".into()
            }
        );
    }

    #[test]
    fn only_a_final_receipt_ends_wait_and_only_an_ack_is_success() {
        assert_eq!(exit_for_stage("queued"), None);
        assert_eq!(exit_for_stage("delivered"), None);
        assert_eq!(exit_for_stage("acknowledged"), Some(0));
        for stage in ["unacknowledged", "withdrawn", "failed", "expired"] {
            assert_eq!(exit_for_stage(stage), Some(1), "{stage}");
        }
    }

    #[test]
    fn a_fast_ack_still_prints_how_it_was_delivered_once() {
        let steer = json!({
            "id": "S12", "stage": "acknowledged", "how": "stopped", "stoppedTool": "cargo test --workspace",
            "queuedAt": "2026-10-18T14:02:07.120Z", "deliveredAt": "2026-10-18T14:02:07.143Z",
            "ackedAt": "2026-10-18T14:02:08.910Z", "ackExcerpt": "S12: dropping the docs page",
        });
        // The names read here are the contract's: a real Steer round-trips through them.
        let mut full = steer.clone();
        full.as_object_mut().unwrap().extend(
            json!({ "target": { "workstreamId": "W41" }, "workstreamId": "W41", "thread": { "machineId": "lab-a", "threadId": "t1" },
                "runId": "r1", "by": { "kind": "human", "keyName": "me" }, "mode": "now", "text": "skip the docs" })
                .as_object()
                .unwrap()
                .clone(),
        );
        let typed: fleetd_contracts::steer::Steer = serde_json::from_value(full.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), full);
        let mut printed = vec!["queued".to_owned()];
        let lines = new_lines(&steer, &mut printed);
        assert_eq!(lines.len(), 2);
        assert!(
            lines[0].starts_with("S12 delivered ")
                && lines[0].ends_with("(stopped cargo test --workspace)")
        );
        assert!(
            lines[1].starts_with("S12 acknowledged ")
                && lines[1].ends_with("\"S12: dropping the docs page\"")
        );
        assert!(new_lines(&steer, &mut printed).is_empty());
    }

    #[test]
    fn not_acknowledged_quotes_the_reply_it_got() {
        let line = receipt_line(
            &json!({ "id": "S3", "stage": "unacknowledged", "ackExcerpt": "Running the tests\nnow" }),
        );
        assert_eq!(
            line,
            "S3 not acknowledged: its reply did not name S3; it said \"Running the tests now\""
        );
        let waiting = receipt_line(
            &json!({ "id": "S4", "stage": "queued", "detail": "waiting for lab-b (until 14:30)" }),
        );
        assert_eq!(waiting, "S4 queued (waiting for lab-b (until 14:30))");
    }
}
