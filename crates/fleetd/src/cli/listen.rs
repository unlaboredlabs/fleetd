//! `fleetd listen`: streams hub events to a command or a URL, at least once. It long-polls events_wait over MCP and
//! persists its cursor only after the command exits 0 or the POST gets a 2xx, so a crash or restart re-delivers the
//! event in flight instead of losing it.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;

use super::args::{self, Kind, Spec};
use super::mcp_client::{McpClient, McpError};
use super::{Stop, is_machine_id};

pub const LISTEN_USAGE: &str = r#"  listen --hub <url> --key-file <path> (--exec '<cmd>' | --post <url>)
         [--types a,b] [--machines a,b] [--name <name>]
             deliver hub events, at least once and in order, to a command (one event's JSON on stdin)
             or a URL; the cursor lives in ~/.fleetd/listen/<name>.cursor (name default "default").
             Exits 78 when the hub refuses the key.
"#;

/// sysexits EX_CONFIG: the key or flags are wrong, so a service manager restarting us would only loop.
pub const EXIT_CONFIG: u8 = 78;

const HUB_RETRY_SEC: [u64; 5] = [1, 2, 5, 10, 30];
const DELIVER_RETRY_SEC: [u64; 4] = [1, 5, 30, 60];

pub enum WaitError {
    /// The hub refused the key (HTTP 401) or the request (forbidden/invalid): retrying cannot help.
    Refused(String),
    Unavailable(String),
}

pub struct WaitPage {
    pub events: Vec<Value>,
    pub cursor: u64,
}

fn warn(line: &str) {
    eprintln!("fleetd listen: {line}");
}

/// events_wait over the hub's MCP endpoint, reconnecting after any transport failure.
struct McpHub {
    hub: String,
    key: String,
    types: Option<Vec<String>>,
    machine_id: Option<String>,
    client: Option<McpClient>,
}

impl McpHub {
    /// One events_wait long-poll; no cursor means from the hub's current end.
    async fn wait(&mut self, cursor: Option<u64>) -> Result<WaitPage, WaitError> {
        let result = self.call(cursor).await;
        let refused = |message: String| WaitError::Refused(message);
        match result {
            Ok(page) => Ok(page),
            Err(McpError::Unauthorized) => Err(refused(
                "the hub refused the key (401); check --key-file or create a new key".into(),
            )),
            Err(McpError::Other(message))
                if message.starts_with("forbidden: ") || message.starts_with("invalid: ") =>
            {
                Err(refused(message))
            }
            Err(other) => {
                self.client = None;
                Err(WaitError::Unavailable(other.message()))
            }
        }
    }

    async fn call(&mut self, cursor: Option<u64>) -> Result<WaitPage, McpError> {
        if self.client.is_none() {
            self.client = Some(
                McpClient::connect(
                    &self.hub,
                    &self.key,
                    "fleetd-listen",
                    Duration::from_secs(70),
                )
                .await?,
            );
        }
        let mut arguments = serde_json::Map::new();
        if let Some(cursor) = cursor {
            arguments.insert("cursor".into(), json!(cursor));
        }
        if let Some(types) = &self.types {
            arguments.insert("types".into(), json!(types));
        }
        if let Some(machine) = &self.machine_id {
            arguments.insert("machineId".into(), json!(machine));
        }
        arguments.insert("timeoutSec".into(), json!(50));
        let client = self.client.as_mut().expect("connected above");
        let result = client
            .call_tool(
                "events_wait",
                Value::Object(arguments),
                Duration::from_secs(70),
            )
            .await?;
        let body = result.body;
        if result.is_error {
            let code = body
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("undefined");
            let fix = body
                .get("fix")
                .and_then(Value::as_str)
                .map(|fix| format!(" ({fix})"))
                .unwrap_or_default();
            return Err(McpError::Other(format!(
                "{code}: {}{fix}",
                body.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined")
            )));
        }
        Ok(WaitPage {
            events: body
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            cursor: body
                .get("cursor")
                .and_then(Value::as_u64)
                .or(cursor)
                .unwrap_or(0),
        })
    }
}

fn read_cursor(file: &PathBuf) -> Result<Option<u64>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    text.trim().parse::<u64>().map(Some).map_err(|_| {
        format!(
            "cursor file {} is corrupt; delete it to start from now",
            file.display()
        )
    })
}

fn write_cursor(file: &PathBuf, seq: u64) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    if let Some(dir) = file.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", file.display()));
    std::fs::write(&tmp, format!("{seq}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

enum Deliver {
    Exec(String),
    Post(String, reqwest::Client),
}

impl Deliver {
    /// Hands one event to the consumer; true means it was taken (exit 0 or a 2xx).
    async fn deliver(&self, event: &Value) -> bool {
        match self {
            Deliver::Exec(cmd) => {
                let Ok(mut child) = tokio::process::Command::new("sh")
                    .args(["-c", cmd])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                else {
                    return false;
                };
                // A command that never reads stdin closes the pipe early; its exit code still decides.
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(format!("{event}\n").as_bytes()).await;
                }
                child.wait().await.is_ok_and(|status| status.success())
            }
            Deliver::Post(url, http) => http
                .post(url)
                .header("content-type", "application/json")
                .body(event.to_string())
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success()),
        }
    }
}

/// Runs until refused (`Ok(78)`) or stopped (`Ok(0)`). Each event is retried until delivered, never skipped; the
/// cursor moves past it only then. `machines` filters here because events_wait takes one machine at most.
async fn listen_loop(
    hub: &mut McpHub,
    deliver: &Deliver,
    cursor_file: &PathBuf,
    machines: Option<&[String]>,
    stop: &mut Stop,
) -> Result<u8, String> {
    let mut cursor = read_cursor(cursor_file)?;
    let mut hub_failures = 0usize;
    loop {
        let page = tokio::select! {
            page = hub.wait(cursor) => page,
            _ = stop.wait() => return Ok(0),
        };
        let page = match page {
            Ok(page) => page,
            Err(WaitError::Refused(message)) => {
                warn(&format!(
                    "{message}; exiting {EXIT_CONFIG} so a service manager does not restart-loop"
                ));
                return Ok(EXIT_CONFIG);
            }
            Err(WaitError::Unavailable(message)) => {
                let delay = HUB_RETRY_SEC[hub_failures.min(HUB_RETRY_SEC.len() - 1)];
                hub_failures += 1;
                warn(&format!(
                    "hub unavailable ({message}); retrying in {delay}s"
                ));
                if stop.sleep(Duration::from_secs(delay)).await {
                    return Ok(0);
                }
                continue;
            }
        };
        hub_failures = 0;
        for event in &page.events {
            let machine = event.get("machineId").and_then(Value::as_str);
            if let Some(machines) = machines
                && !machine.is_some_and(|m| machines.iter().any(|x| x == m))
            {
                continue;
            }
            let seq = event.get("seq").and_then(Value::as_u64).unwrap_or(0);
            let mut attempt = 0usize;
            // Once started, an attempt and its ack finish even on SIGTERM, so a clean stop never re-delivers.
            while !deliver.deliver(event).await {
                let delay = DELIVER_RETRY_SEC[attempt.min(DELIVER_RETRY_SEC.len() - 1)];
                attempt += 1;
                let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
                warn(&format!(
                    "event {seq} ({kind}) not delivered; retrying in {delay}s"
                ));
                if stop.sleep(Duration::from_secs(delay)).await {
                    return Ok(0);
                }
            }
            write_cursor(cursor_file, seq)?;
            cursor = Some(seq);
            if stop.stopped() {
                return Ok(0);
            }
        }
        if cursor.is_none_or(|c| page.cursor > c) {
            cursor = Some(page.cursor);
            write_cursor(cursor_file, page.cursor)?;
        }
    }
}

fn usage(message: &str) -> u8 {
    eprint!("fleetd: {message}\n\nusage:\n{LISTEN_USAGE}");
    2
}

fn list(value: Option<&str>) -> Option<Vec<String>> {
    value.map(|v| {
        v.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    })
}

fn is_event_type(name: &str) -> bool {
    serde_json::from_value::<fleetd_contracts::events::HubEventType>(Value::String(name.to_owned()))
        .is_ok()
}

fn is_listener_name(name: &str) -> bool {
    (1..=64).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// `fleetd listen …`: runs until a signal (exit 0) or until the hub refuses the key (exit 78).
pub async fn listen_command(argv: &[String]) -> u8 {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("exec", Kind::Str),
        ("post", Kind::Str),
        ("types", Kind::Str),
        ("machines", Kind::Str),
        ("name", Kind::Str),
    ];
    let v = match args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: false,
        },
    ) {
        Ok(v) => v,
        Err(message) => return usage(&message),
    };
    let Some(hub) = v.str("hub").filter(|s| !s.is_empty()) else {
        return usage("--hub is required");
    };
    let Some(key_file) = v.str("key-file").filter(|s| !s.is_empty()) else {
        return usage("--key-file is required");
    };
    if v.str("exec").is_none() == v.str("post").is_none() {
        return usage("give exactly one of --exec or --post");
    }
    let types = list(v.str("types"));
    if let Some(bad) = types.iter().flatten().find(|t| !is_event_type(t)) {
        return usage(&format!("'{bad}' is not an event type"));
    }
    let machines = list(v.str("machines"));
    if let Some(bad) = machines.iter().flatten().find(|m| !is_machine_id(m)) {
        return usage(&format!("'{bad}' is not a machine id ([a-z0-9-]{{1,32}})"));
    }
    let name = v.str("name").unwrap_or("default");
    if !is_listener_name(name) {
        return usage("--name may use letters, digits, '.', '_' and '-'");
    }
    let key = match std::fs::read_to_string(key_file) {
        Ok(key) => key.trim().to_owned(),
        Err(error) => {
            eprintln!("fleetd listen: cannot read --key-file: {error}");
            return EXIT_CONFIG;
        }
    };

    let deliver = match (v.string("exec"), v.string("post")) {
        (Some(cmd), _) => Deliver::Exec(cmd),
        (None, Some(url)) => Deliver::Post(
            url,
            reqwest::Client::builder()
                .user_agent(format!("fleetd-listen/{}", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("a plain HTTP client builds"),
        ),
        (None, None) => unreachable!(),
    };
    let mut mcp = McpHub {
        hub: hub.to_owned(),
        key,
        types,
        machine_id: machines
            .as_ref()
            .filter(|m| m.len() == 1)
            .map(|m| m[0].clone()),
        client: None,
    };
    let cursor_file = super::home_dir()
        .join(".fleetd")
        .join("listen")
        .join(format!("{name}.cursor"));
    let mut stop = Stop::on_signals();
    match listen_loop(
        &mut mcp,
        &deliver,
        &cursor_file,
        machines.as_deref(),
        &mut stop,
    )
    .await
    {
        Ok(code) => code,
        Err(message) => {
            eprintln!("fleetd: {message}");
            1
        }
    }
}
