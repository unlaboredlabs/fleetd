//! `fleetd chat`: write to a project's lead from a terminal and read its chat. It talks to the hub over the app
//! socket, exactly as the desktop app does: the same chat_send, chat_history, events and streamed `chat_delta`
//! frames. A human key writes as you; any other key writes as an agent, by its name, and the hub never takes an
//! agent's message as the human's. `--key-file` is always required: agents run as the same OS user, so any key the CLI
//! found on its own, an agent could find too.

use std::collections::VecDeque;
use std::time::Duration;

use chrono::DateTime;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::args::{self, Kind, Spec};
use super::steer::{Failure, hub_url};

pub const CHAT_USAGE: &str = r#"  chat <machine>/<project> "<text>" [--now] [--wait | --follow] --key-file <key> [--hub <url>]
             write to a project's lead, as the app does: it starts the lead's next turn, or lands at
             its next step while it works; --now (a human key) stops that step and delivers at once.
             --wait prints the lead's reply when its turn ends; --follow streams it as it is written.
             Exit 0 it replied, 1 its turn ended without a reply. A human key writes as you; an agent
             key as that agent, by its name
  chat history <project> [--page <n>] --key-file <key> [--hub <url>]
             the project's chat: who wrote each message, when, and what; the newest page, older
             ones with --page
"#;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// As the app pages its chat.
const PAGE: u64 = 50;

#[derive(Debug, PartialEq)]
pub enum ChatCommand {
    Send {
        project: String,
        text: String,
        now: bool,
        wait: bool,
        follow: bool,
    },
    History {
        project: String,
        page: u64,
    },
}

#[derive(Debug, PartialEq)]
pub struct ChatArgs {
    pub command: ChatCommand,
    pub hub: Option<String>,
    pub home: Option<String>,
    pub key_file: String,
}

pub fn parse_chat_args(argv: &[String]) -> Result<ChatArgs, String> {
    const OPTIONS: &[(&str, Kind)] = &[
        ("hub", Kind::Str),
        ("key-file", Kind::Str),
        ("wait", Kind::Bool),
        ("follow", Kind::Bool),
        ("now", Kind::Bool),
        ("page", Kind::Str),
    ];
    let v = args::parse(
        argv,
        &Spec {
            options: OPTIONS,
            positionals: true,
        },
    )?;
    let p = &v.positionals;
    let command = if p.first().map(String::as_str) == Some("history") {
        if v.flag("wait") || v.flag("follow") || v.flag("now") {
            return Err("--now, --wait and --follow are for sending, not history".into());
        }
        let [_, project] = p.as_slice() else {
            return Err("expected fleetd chat history <project>".into());
        };
        let page = match v.str("page") {
            None => 1,
            Some(n) => n
                .parse()
                .ok()
                .filter(|n| *n > 0)
                .ok_or("--page is a page number: 1 is the newest")?,
        };
        ChatCommand::History {
            project: project.clone(),
            page,
        }
    } else {
        if v.has("page") {
            return Err("--page is for history".into());
        }
        let [project, words @ ..] = p.as_slice() else {
            return Err(r#"expected fleetd chat <machine>/<project> "<text>""#.into());
        };
        let text = words.join(" ");
        if text.trim().is_empty() {
            return Err(r#"expected fleetd chat <machine>/<project> "<text>""#.into());
        }
        ChatCommand::Send {
            project: project.clone(),
            text,
            now: v.flag("now"),
            wait: v.flag("wait"),
            follow: v.flag("follow"),
        }
    };
    let Some(key_file) = v.string("key-file").filter(|s| !s.is_empty()) else {
        return Err("--key-file is required: the key says who writes, your human key as you and an agent key as that \
                    agent. Make yours once: fleetd hub key create --human --name <device> --out <file>"
            .into());
    };
    Ok(ChatArgs {
        command,
        hub: v.string("hub").filter(|s| !s.is_empty()),
        home: None,
        key_file,
    })
}

// ---- what it prints ----

fn st<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// Who wrote a message, as the app's header says it: `you · cli`, `agent · <its key's name>`, `lead`, `fleetd`.
pub fn author_label(message: &Value) -> String {
    match st(message, "author") {
        Some("human") => format!("you · {}", st(message, "client").unwrap_or("app")),
        Some("agent") => format!("agent · {}", st(message, "by").unwrap_or("unnamed")),
        Some("lead") => "lead".into(),
        _ => "fleetd".into(),
    }
}

/// `Oct 22 14:02`, in this machine's zone (the same rule the hub uses for its own).
fn when(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|t| {
            t.with_timezone(&crate::hub::attention::hub_zone())
                .format("%b %-d %H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

/// What an inline item asks, in place of its empty text.
fn item_line(item: &Value) -> Option<String> {
    let state = st(item, "state").unwrap_or("open");
    match st(item, "kind")? {
        "secret_request" => Some(format!(
            "asks for a secret, {}: {state}",
            st(item, "name").unwrap_or("unnamed")
        )),
        "command_approval" => {
            let what = item["gated"]["argv"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .or_else(|| st(&item["permission"], "tool").map(str::to_owned))
                .unwrap_or_default();
            Some(format!("asks to run `{what}`: {state}"))
        }
        _ => None,
    }
}

/// One message: who and when on a line, then what it says, indented.
pub fn render_message(message: &Value) -> String {
    let mut out = author_label(message);
    if let Some(at) = st(message, "createdAt").map(when).filter(|t| !t.is_empty()) {
        out.push_str("  ");
        out.push_str(&at);
    }
    out.push('\n');
    let body = message
        .get("item")
        .and_then(item_line)
        .unwrap_or_else(|| st(message, "text").unwrap_or("").to_owned());
    for line in body.trim_end().lines() {
        out.push_str("  ");
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// The line after a send: how it went in, from chat_send's answer.
pub fn sent_line(sent: &Value) -> String {
    let who = author_label(&sent["message"]);
    if let Some(why) = st(sent, "leadWaiting") {
        return format!("held, as {who}: {why}");
    }
    let how = match st(&sent["message"], "delivery") {
        Some("turn") => "it starts the lead's next turn",
        Some("steer") => "the lead is working and reads it at its next step",
        Some("now") => "the lead stopped its step to read it",
        _ => "it goes in as soon as the lead is ready",
    };
    format!("sent as {who}: {how}")
}

/// Text the follower has printed of one streamed message, and what a `chat_delta` adds to it. Offsets are UTF-16 units,
/// as the hub counts them. A frame already applied adds nothing; a gap waits for the final text.
pub fn apply_delta(printed: &str, offset: usize, append: &str) -> Option<String> {
    let have = fleetd_contracts::prim::js_len(printed);
    (offset == have).then(|| append.to_owned())
}

/// The rest of a finished message after what was streamed of it.
pub fn rest_of(printed: &str, full: &str) -> String {
    match full.strip_prefix(printed) {
        Some(rest) => rest.to_owned(),
        None if printed.is_empty() => full.to_owned(),
        None => format!("\n{full}"),
    }
}

// ---- the app socket ----

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The hub's app socket, authenticated. Frames read while waiting for a call's answer are kept for later, in order.
struct Socket {
    ws: Ws,
    next_id: u64,
    kept: VecDeque<Value>,
}

/// `http://host:port` → `ws://host:port/app`.
pub fn app_url(hub: &str) -> String {
    let hub = hub.trim_end_matches('/');
    let ws = if let Some(rest) = hub.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = hub.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        hub.to_owned()
    };
    format!("{ws}/app")
}

fn refusal(frame: &Value) -> Failure {
    Failure::Refused(format!(
        "{}{}",
        st(frame, "message").unwrap_or("the hub refused"),
        st(frame, "fix")
            .map(|f| format!("\n  fix: {f}"))
            .unwrap_or_default()
    ))
}

impl Socket {
    async fn open(hub: &str, key: &str) -> Result<Self, Failure> {
        let url = app_url(hub);
        let ws = match tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(url.as_str()),
        )
        .await
        {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(error)) => {
                return Err(Failure::Unreachable(format!(
                    "cannot reach the hub at {hub}: {error}"
                )));
            }
            Err(_) => {
                return Err(Failure::Unreachable(format!(
                    "the hub at {hub} does not answer"
                )));
            }
        };
        let mut socket = Socket {
            ws,
            next_id: 0,
            kept: VecDeque::new(),
        };
        socket.send(json!({ "t": "auth", "key": key })).await?;
        loop {
            let frame = socket.read().await?;
            match st(&frame, "t") {
                Some("ready") => return Ok(socket),
                Some("error") => return Err(refusal(&frame)),
                _ => {}
            }
        }
    }

    async fn send(&mut self, frame: Value) -> Result<(), Failure> {
        self.ws
            .send(Message::Text(frame.to_string().into()))
            .await
            .map_err(|e| Failure::Unreachable(format!("the hub connection failed: {e}")))
    }

    async fn read(&mut self) -> Result<Value, Failure> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(frame) = serde_json::from_str(&text) {
                        return Ok(frame);
                    }
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err(Failure::Unreachable("the hub closed the connection".into()));
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    return Err(Failure::Unreachable(format!(
                        "the hub connection failed: {e}"
                    )));
                }
            }
        }
    }

    async fn next(&mut self) -> Result<Value, Failure> {
        match self.kept.pop_front() {
            Some(frame) => Ok(frame),
            None => self.read().await,
        }
    }

    async fn call(&mut self, tool: &str, input: Value) -> Result<Value, Failure> {
        self.next_id += 1;
        let id = format!("c{}", self.next_id);
        self.send(json!({ "t": "call", "id": id, "tool": tool, "input": input }))
            .await?;
        let answer = async {
            loop {
                let frame = self.read().await?;
                if st(&frame, "id") == Some(id.as_str()) {
                    return match st(&frame, "t") {
                        Some("result") => Ok(frame["output"].clone()),
                        _ => Err(refusal(&frame)),
                    };
                }
                self.kept.push_back(frame);
            }
        };
        tokio::time::timeout(CALL_TIMEOUT, answer)
            .await
            .unwrap_or_else(|_| {
                Err(Failure::Unreachable(format!(
                    "the hub did not answer {tool}"
                )))
            })
    }
}

/// The project `given` names, as `fleetd status` finds one: its id, title or folder, `<machine>/` first when two
/// machines have one.
async fn project_ref(socket: &mut Socket, given: &str) -> Result<Value, Failure> {
    let named = given
        .split_once('/')
        .filter(|(m, _)| super::is_machine_id(m));
    let listed = socket
        .call("project_get", json!({ "machineId": named.map(|(m, _)| m) }))
        .await?;
    let projects = listed["projects"].as_array().cloned().unwrap_or_default();
    let why = match pick_project(given, &projects) {
        Ok(r) => return Ok(r),
        Err(why) => why,
    };
    // A `<machine>/<id>` the list leaves out (a pool machine's project, one past the list's cut) is still the hub's:
    // asked for by its id, as chat always took one.
    let Some((machine_id, project_id)) = named else {
        return Err(Failure::Refused(why));
    };
    let r = json!({ "machineId": machine_id, "projectId": project_id });
    match socket.call("project_get", r.clone()).await {
        Ok(_) => Ok(r),
        Err(Failure::Refused(_)) => Err(Failure::Refused(why)),
        Err(unreachable) => Err(unreachable),
    }
}

fn pick_project(given: &str, projects: &[Value]) -> Result<Value, String> {
    super::time::resolve_project(given, projects).map_err(|why| match projects {
        [] => format!("no project {given}: the hub has none yet"),
        _ => why.replacen("no order or project", "no project", 1),
    })
}

fn client_request_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The hub (`--hub`, or the hub on this machine) and the key in `--key-file`.
fn hub_and_key(args: &ChatArgs) -> Result<(String, String), Failure> {
    let url = hub_url(args.hub.clone(), args.home.as_deref()).map_err(Failure::Unreachable)?;
    let key = std::fs::read_to_string(&args.key_file)
        .map(|k| k.trim().to_owned())
        .map_err(|error| Failure::Refused(format!("cannot read --key-file: {error}")))?;
    Ok((url, key))
}

async fn send(
    socket: &mut Socket,
    project: Value,
    text: String,
    now: bool,
    wait: bool,
    follow: bool,
    given: &str,
) -> Result<u8, Failure> {
    let watch = wait || follow;
    if watch {
        // Subscribed before the send, so no reply frame slips past.
        let cursor = socket.call("fleetd_status", json!({})).await?["cursor"].clone();
        if follow {
            socket
                .send(json!({ "t": "chat", "project": project }))
                .await?;
        }
        socket
            .send(json!({ "t": "events", "cursor": cursor }))
            .await?;
    }
    let mut input = json!({
        "projectRef": project, "text": text, "clientRequestId": client_request_id(), "client": "cli",
    });
    if now {
        input["now"] = json!(true);
    }
    // From inside a fleetd session the hub writes it as an agent's at most, and refuses the project's own lead and
    // tasks: a guard against mistakes, not a boundary (session_thread_id).
    if let Some(session) = crate::node::runner::process::session_thread_id() {
        input["session"] = json!(session);
    }
    let sent = socket.call("chat_send", input).await?;
    println!("{}", sent_line(&sent));
    if !watch {
        println!("`fleetd chat history {given}` shows the lead's reply");
        return Ok(0);
    }
    follow_reply(
        socket,
        &project,
        sent["message"]["seq"].as_i64().unwrap_or(0),
        follow,
    )
    .await
}

/// Prints the lead's reply to message `after` until its turn ends: streamed as written with `follow`, each message
/// once final without. 0 when it replied, 1 when its turn ended without a word.
async fn follow_reply(
    socket: &mut Socket,
    project: &Value,
    after: i64,
    follow: bool,
) -> Result<u8, Failure> {
    use std::io::Write;
    let ours = |frame: &Value| frame.get("projectRef") == Some(project);
    // What was streamed of each message, and the one being printed now.
    let mut texts: std::collections::HashMap<i64, String> = Default::default();
    let mut current: Option<i64> = None;
    let mut replied = false;
    let mut worked = false;
    let header = |current: &mut Option<i64>, seq: i64, replied: bool| {
        if *current != Some(seq) {
            if current.is_some() {
                println!();
            }
            println!("{}lead", if replied { "\n" } else { "" });
            *current = Some(seq);
        }
    };
    loop {
        let frame = socket.next().await?;
        match st(&frame, "t") {
            Some("chat_delta") if follow && ours(&frame) => {
                let seq = frame["seq"].as_i64().unwrap_or(0);
                if seq <= after {
                    continue;
                }
                header(&mut current, seq, replied);
                replied = true;
                let printed = texts.entry(seq).or_default();
                let offset = frame["offset"].as_u64().unwrap_or(0) as usize;
                if let Some(add) = apply_delta(printed, offset, st(&frame, "append").unwrap_or(""))
                {
                    print!("{add}");
                    let _ = std::io::stdout().flush();
                    printed.push_str(&add);
                }
            }
            Some("event") => {
                let data = &frame["data"];
                if !ours(data) {
                    continue;
                }
                match st(&frame, "type") {
                    Some("chat.message")
                        if st(data, "author") == Some("lead")
                            && st(data, "state") == Some("final")
                            && data["seq"].as_i64().unwrap_or(0) > after =>
                    {
                        let seq = data["seq"].as_i64().unwrap_or(0);
                        let message = match data.get("message") {
                            Some(m) if m.is_object() => m.clone(),
                            // Too large for the event: read it.
                            _ => socket
                                .call(
                                    "chat_history",
                                    json!({ "projectRef": project, "after": seq - 1, "limit": 1 }),
                                )
                                .await?["messages"][0]
                                .clone(),
                        };
                        let full = st(&message, "text").unwrap_or("");
                        if full.trim().is_empty() {
                            continue;
                        }
                        header(&mut current, seq, replied);
                        let printed = texts.remove(&seq).unwrap_or_default();
                        println!("{}", rest_of(&printed, full).trim_end_matches('\n'));
                        current = None;
                        replied = true;
                    }
                    Some("chat.waiting") => {
                        if data["leadWorking"].as_bool() == Some(true) {
                            worked = true;
                        } else if worked || replied {
                            if current.is_some() {
                                println!();
                            }
                            if !replied {
                                println!("the lead's turn ended without a reply");
                            }
                            return Ok(if replied { 0 } else { 1 });
                        }
                    }
                    _ => {}
                }
            }
            Some("error") if frame.get("id").is_none() => return Err(refusal(&frame)),
            _ => {}
        }
    }
}

async fn history(
    socket: &mut Socket,
    project: Value,
    page: u64,
    given: &str,
) -> Result<u8, Failure> {
    let mut before: Option<i64> = None;
    let mut out = Value::Null;
    for n in 1..=page {
        let mut input = json!({ "projectRef": project, "limit": PAGE });
        if let Some(b) = before {
            input["before"] = json!(b);
        }
        out = socket.call("chat_history", input).await?;
        let first = out["messages"][0]["seq"].as_i64();
        if n < page {
            match first {
                Some(seq) if out["moreBefore"].as_bool() == Some(true) => before = Some(seq),
                _ => {
                    println!("the chat has no page {page}");
                    return Ok(0);
                }
            }
        }
    }
    let messages = out["messages"].as_array().cloned().unwrap_or_default();
    if messages.is_empty() {
        println!("no messages yet");
    }
    for message in &messages {
        print!("{}", render_message(message));
    }
    if out["moreBefore"].as_bool() == Some(true) {
        println!("older: fleetd chat history {given} --page {}", page + 1);
    }
    Ok(0)
}

async fn run(args: ChatArgs) -> Result<u8, Failure> {
    let (url, key) = hub_and_key(&args)?;
    let mut socket = Socket::open(&url, &key).await?;
    match args.command {
        ChatCommand::Send {
            project,
            text,
            now,
            wait,
            follow,
        } => {
            let r = project_ref(&mut socket, &project).await?;
            send(&mut socket, r, text, now, wait, follow, &project).await
        }
        ChatCommand::History { project, page } => {
            let r = project_ref(&mut socket, &project).await?;
            history(&mut socket, r, page, &project).await
        }
    }
}

/// `fleetd chat …`.
pub async fn chat_command(argv: &[String]) -> u8 {
    match parse_chat_args(argv) {
        Err(error) => {
            eprint!("fleetd: {error}\n\nusage:\n{CHAT_USAGE}");
            2
        }
        Ok(args) => run(args)
            .await
            .unwrap_or_else(|failure| failure.report_as("chat")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_send_and_a_history_parse_and_mistakes_stop_before_the_hub() {
        let sent = parse_chat_args(&argv(&[
            "devbox/app",
            "ship",
            "it",
            "--follow",
            "--key-file",
            "k",
        ]))
        .unwrap();
        assert_eq!(
            sent.command,
            ChatCommand::Send {
                project: "devbox/app".into(),
                text: "ship it".into(),
                now: false,
                wait: false,
                follow: true
            }
        );
        assert_eq!(sent.key_file, "k");
        let history =
            parse_chat_args(&argv(&["history", "app", "--page", "2", "--key-file", "k"])).unwrap();
        assert_eq!(
            history.command,
            ChatCommand::History {
                project: "app".into(),
                page: 2
            }
        );
        let err = |a: &[&str]| parse_chat_args(&argv(a)).unwrap_err();
        assert!(err(&["devbox/app", "hi"]).contains("--key-file is required"));
        assert!(err(&["history", "app"]).contains("--key-file is required"));
        assert!(err(&["devbox/app"]).starts_with("expected"));
        assert!(err(&["history", "app", "--wait"]).contains("not history"));
        assert!(err(&["history", "app", "--now"]).contains("not history"));
        let now =
            parse_chat_args(&argv(&["devbox/app", "stop", "--now", "--key-file", "k"])).unwrap();
        assert!(matches!(now.command, ChatCommand::Send { now: true, .. }));
        assert!(err(&["history", "app", "--page", "0"]).contains("page number"));
        assert!(err(&["devbox/app", "hi", "--page", "2"]).contains("for history"));
    }

    /// Bug hunt: `fleetd chat devbox/storefront …`, as the docs write it, was refused ("No project storefront"):
    /// project ids are generated, and chat took only an id while status, time and project take the title too.
    #[test]
    fn a_chat_names_its_project_by_title_or_folder_as_status_does() {
        let projects = [
            json!({ "machineId": "devbox", "projectId": "f0d0d1a4", "title": "storefront", "workspaceRoot": "/w/shop" }),
            json!({ "machineId": "buildbox", "projectId": "9c1e", "title": "storefront", "workspaceRoot": "/w/shop" }),
            json!({ "machineId": "devbox", "projectId": "77ab", "title": "Docs site", "workspaceRoot": "/w/docs" }),
        ];
        let at = |m: &str, p: &str| Ok(json!({ "machineId": m, "projectId": p }));
        assert_eq!(
            pick_project("devbox/storefront", &projects),
            at("devbox", "f0d0d1a4")
        );
        assert_eq!(
            pick_project("devbox/f0d0d1a4", &projects),
            at("devbox", "f0d0d1a4")
        );
        assert_eq!(pick_project("Docs site", &projects), at("devbox", "77ab"));
        assert_eq!(pick_project("docs", &projects), at("devbox", "77ab"));
        assert!(
            pick_project("storefront", &projects)
                .unwrap_err()
                .contains("devbox/storefront, buildbox/storefront")
        );
        let none = pick_project("devbox/nope", &projects).unwrap_err();
        assert!(none.starts_with("no project 'devbox/nope'"), "{none}");
        assert!(pick_project("app", &[]).unwrap_err().contains("none yet"));
    }

    #[test]
    fn each_message_says_who_wrote_it_from_its_key() {
        let at = "2026-10-22T14:02:00.000Z";
        let cli = json!({ "author": "human", "client": "cli", "by": "desk", "text": "fix the login", "createdAt": at });
        let app = json!({ "author": "human", "by": "desk", "text": "hi", "createdAt": at });
        let agent = json!({ "author": "agent", "by": "scout", "text": "build failed on main", "createdAt": at });
        assert_eq!(author_label(&cli), "you · cli");
        assert_eq!(author_label(&app), "you · app");
        assert_eq!(author_label(&agent), "agent · scout");
        assert_eq!(author_label(&json!({ "author": "lead" })), "lead");
        assert_eq!(author_label(&json!({ "author": "system" })), "fleetd");
        let shown = render_message(
            &json!({ "author": "lead", "text": "On it.\nTwo agents.", "createdAt": at, "messageId": "m7", "seq": 7 }),
        );
        assert!(
            shown.starts_with("lead  ") && shown.ends_with("\n  On it.\n  Two agents.\n"),
            "{shown}"
        );
        assert!(
            !shown.contains("m7"),
            "no ids in what history prints: {shown}"
        );
        let gated = render_message(&json!({ "author": "lead", "text": "", "createdAt": at,
            "item": { "kind": "command_approval", "state": "open", "gated": { "argv": ["./deploy.sh", "prod"] } } }));
        assert!(
            gated.ends_with("  asks to run `./deploy.sh prod`: open\n"),
            "{gated}"
        );
    }

    #[test]
    fn the_send_line_says_how_it_went_in() {
        let msg = |delivery: &str| json!({ "message": { "author": "human", "client": "cli", "delivery": delivery } });
        assert_eq!(
            sent_line(&msg("turn")),
            "sent as you · cli: it starts the lead's next turn"
        );
        assert!(sent_line(&msg("steer")).contains("reads it at its next step"));
        assert!(sent_line(&msg("now")).contains("stopped its step"));
        let held = json!({ "message": { "author": "agent", "by": "scout" }, "leadWaiting": "The lead's machine is away." });
        assert_eq!(
            sent_line(&held),
            "held, as agent · scout: The lead's machine is away."
        );
    }

    #[test]
    fn streamed_text_is_printed_once_in_order_and_the_final_text_fills_any_gap() {
        assert_eq!(apply_delta("", 0, "On "), Some("On ".into()));
        // Offsets count UTF-16 units: "é" is one, "😀" two.
        assert_eq!(apply_delta("é😀", 3, "x"), Some("x".into()));
        assert_eq!(apply_delta("On it", 0, "On "), None, "already printed");
        assert_eq!(apply_delta("On ", 9, "late"), None, "a gap");
        assert_eq!(rest_of("On ", "On it."), "it.");
        assert_eq!(rest_of("", "On it."), "On it.");
        assert_eq!(app_url("http://127.0.0.1:4795/"), "ws://127.0.0.1:4795/app");
        assert_eq!(app_url("https://hub.example"), "wss://hub.example/app");
    }
}

#[cfg(test)]
mod against_a_hub {
    use std::sync::Arc;

    use crate::clock::SystemClock;
    use crate::hub::api::{self, HubConfig, Listen};
    use crate::hub::store::{HubDb, HubStore};
    use fleetd_contracts::auth::{Grant, KeyKind};
    use fleetd_contracts::ids::MachineId;
    use serde_json::json;

    /// Bug hunt: `fleetd chat devbox/storefront "…"`, as the docs write it, was refused ("No project storefront on
    /// devbox"), and `chat history` of it said "No messages yet": project ids are generated, and chat sent the title
    /// on as the id.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_chat_names_its_project_by_title() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let db = HubDb::open_memory().unwrap();
        HubStore::new(db.clone())
            .projects_upsert_many(
                &MachineId::new("devbox").unwrap(),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": "f0d0d1a4", "title": "storefront", "workspaceRoot": "/w/shop",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                    "lastActivityAt": "2026-11-08T00:00:00.000Z",
                }))
                .unwrap()],
            )
            .unwrap();
        // One the project list leaves out: a project on a pool machine.
        HubStore::new(db.clone())
            .projects_upsert_many(
                &MachineId::new("cloud-1").unwrap(),
                &[serde_json::from_value(json!({
                    "machineId": "cloud-1", "projectId": "p1", "title": "p1", "workspaceRoot": "/w/p1",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                    "lastActivityAt": "2026-11-08T00:00:00.000Z",
                }))
                .unwrap()],
            )
            .unwrap();
        db.with(|c| {
            c.execute(
                "INSERT INTO node_keys (machine_id, pub_key, pool) VALUES ('cloud-1', 'pk', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let hub = crate::hub::serve::build_on(db, config, Arc::new(SystemClock)).unwrap();
        for machine in ["devbox", "cloud-1"] {
            let machine = serde_json::from_value(json!({
                "machineId": machine, "name": machine, "tags": [], "status": "offline",
                "lastSeenAt": "2026-11-08T00:00:00.000Z", "nodeVersion": "0.1.0",
            }))
            .unwrap();
            hub.store.machine_upsert(&machine, None).unwrap();
        }
        let grants: Vec<Grant> =
            serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
        let key = hub
            .auth
            .create_key("tester", &grants, KeyKind::Agent)
            .unwrap()
            .key;
        let key_file = home.path().join("agent.key");
        std::fs::write(&key_file, format!("{key}\n")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let served = tokio::spawn(crate::hub::http::serve(
            listener,
            hub.clone(),
            Arc::new(api::registry()),
        ));
        let chat = |args: &[&str]| {
            let mut argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            argv.extend(
                ["--key-file", key_file.to_str().unwrap(), "--hub", &url].map(str::to_owned),
            );
            async move { super::chat_command(&argv).await }
        };
        assert_eq!(
            chat(&["devbox/storefront", "ship it"]).await,
            0,
            "by its title"
        );
        assert_eq!(
            chat(&["devbox/f0d0d1a4", "and the docs"]).await,
            0,
            "by its id"
        );
        // Review of the bug hunt: it went as given before chat looked titles up, then was refused ("no project").
        assert_eq!(chat(&["cloud-1/p1", "on the pool"]).await, 0);
        let texts: Vec<String> = hub
            .db
            .with(|c| {
                let mut stmt = c.prepare(
                    "SELECT project_id, json_extract(data, '$.text') FROM chat_messages ORDER BY n",
                )?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok(format!(
                            "{}: {}",
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(
            texts,
            [
                "f0d0d1a4: ship it",
                "f0d0d1a4: and the docs",
                "p1: on the pool"
            ]
        );
        assert_eq!(chat(&["history", "devbox/storefront"]).await, 0);
        assert_eq!(
            chat(&["history", "devbox/nope"]).await,
            3,
            "no such project"
        );
        served.abort();
    }
}
