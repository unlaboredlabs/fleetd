//! `fleetd agent-mcp --role lead|worker`: the MCP server (stdio, one JSON-RPC message per line) the node puts in every
//! lead's and task's `--mcp-config`. Each tool is one lead-side call, sent through the node's socket with the session's
//! `FLEETD_THREAD_ID`; the hub decides who may make it (`hub/tasks/policy.rs`). The
//! role only picks which tools are listed. Results that take time (a task's result, an answer, an approval) arrive
//! in a later wake, never by polling.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fleetd_contracts::lead_calls::{
    AskLeadCall, BriefCreateCall, ChangeEnqueueCall, CloseCall, DecideCall, DecisionsSearchCall,
    GatedRunCall, LeadCall, LeadSocketFrame, RequestSecretCall, RequestWithdrawCall, TaskCancelCall, TaskListCall,
    TaskMessageCall, TaskSpawnCall,
};
use fleetd_contracts::plan::PlanCall;
use fleetd_contracts::schema::inline_schema;
use fleetd_contracts::verification::ReviewVerdict;
use serde_json::{Value, json};

const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Lead,
    Worker,
}

/// The server's name in a session's `--mcp-config`; claude shows its tools as `mcp__fleetd__<name>`.
pub const SERVER_NAME: &str = "fleetd";

pub struct Tool {
    pub name: &'static str,
    /// The lead call's `op`.
    pub op: &'static str,
    pub worker: bool,
    pub lead: bool,
    pub description: &'static str,
    pub schema: fn() -> Value,
    /// What a person must do before the call takes effect; `None` when nothing.
    pub human: Option<&'static str>,
}

const fn lead(
    name: &'static str,
    op: &'static str,
    description: &'static str,
    schema: fn() -> Value,
) -> Tool {
    Tool {
        name,
        op,
        worker: false,
        lead: true,
        description,
        schema,
        human: None,
    }
}

impl Tool {
    const fn needs(self, human: &'static str) -> Tool {
        Tool {
            human: Some(human),
            ..self
        }
    }
}

static TOOLS: &[Tool] = &[
    lead(
        "spawn_agent",
        "task_spawn",
        "Start a fleetd agent (a task) with its own session, slot and lane. kind write|read|review; a writer \
         gets its own worktree and branch; a review task needs pr. profile is high by default; medium is for mechanical \
         work only, and reviews always run high. A full slot board queues it and it starts by itself. The result names \
         the other writers running in the project. Its result arrives in a later wake: end your turn instead of waiting.",
        inline_schema::<TaskSpawnCall>,
    ),
    lead(
        "message_agent",
        "task_message",
        "Steer a task: a running one takes the message at its next tool boundary (now: true stops its current step \
         first), a waiting one gets it as its answer, and an ended one continues in its own thread.",
        inline_schema::<TaskMessageCall>,
    ),
    lead(
        "agents",
        "task_list",
        "The project's tasks as stored (state, queued reason, thread, result), newest first: one by taskId, or \
         filtered by state or workstream.",
        inline_schema::<TaskListCall>,
    ),
    lead(
        "stop_agent",
        "task_cancel",
        "Stop a task: interrupts its thread and releases its slot.",
        inline_schema::<TaskCancelCall>,
    ),
    lead(
        "brief",
        "brief_create",
        "Set a workstream's brief (goal, why, pointers, constraints, doneWhen lines) and start it, or edit it \
         later. Without workstreamId it opens one for work you took from the chat: text is the order in the human's \
         words, template picks the playbook (feature, bugfix, research).",
        inline_schema::<BriefCreateCall>,
    ),
    lead(
        "request_secret",
        "request_secret",
        "Ask the human for a secret (a key, a token, a password). The app shows a masked field in the chat; the value \
         is sealed to the sink's machine and written there, and never enters a transcript. Only its fingerprint \
         arrives, in a later wake.",
        inline_schema::<RequestSecretCall>,
    )
    .needs("The human enters the value in chat; you see only its fingerprint."),
    lead(
        "request_withdraw",
        "request_withdraw",
        "Take back a secret request or a command approval you no longer need (the human said so in chat).",
        inline_schema::<RequestWithdrawCall>,
    ),
    lead(
        "decide",
        "decide",
        "Log a decision: one you made yourself, or the human's answer to a question you asked in chat (so you never \
         ask it twice).",
        inline_schema::<DecideCall>,
    ),
    lead(
        "close",
        "close",
        "The workstream is done: say why in one line. It stops nothing; stop any agent of it you no longer need.",
        inline_schema::<CloseCall>,
    ),
    lead(
        "gated_run",
        "gated_run",
        "A prod write, spend, delete or credential use: the chat shows the human exactly this argv with Approve / \
         Deny, and the node runs it only once approved; secrets come from the node's own sinks. The exit code and \
         output tail arrive in a later wake.",
        inline_schema::<GatedRunCall>,
    )
    .needs("A human approves the exact command in chat before the node runs it."),
    lead(
        "plan",
        "plan",
        "Set a workstream's plan items, in order (must or polish, size s|m|l, after other items, an optional \
         milestone title), and get the plan back. Its open items you leave out are dropped. Without items: the plan.",
        inline_schema::<PlanCall>,
    ),
    lead(
        "decisions_search",
        "decisions_search",
        "Search the decision log.",
        inline_schema::<DecisionsSearchCall>,
    ),
    lead(
        "change_enqueue",
        "change_enqueue",
        "Put a PR no task's result put there on its repo's merge train; only the train merges.",
        inline_schema::<ChangeEnqueueCall>,
    ),
    Tool {
        name: "report",
        op: "review_verdict",
        worker: true,
        lead: false,
        description: "Record your review verdict once, before your final message: the number of blocking and \
                      non-blocking findings and a one-paragraph summary. fleetd fills in your task and the head you \
                      reviewed.",
        schema: report_schema,
        human: None,
    },
    Tool {
        name: "ask_lead",
        op: "ask_lead",
        worker: true,
        lead: false,
        description: "Ask your lead a question. Carry on with what you can; the answer arrives as a message. If you \
                      can't go on without it, end your turn: the answer continues this thread.",
        schema: inline_schema::<AskLeadCall>,
        human: None,
    },
];

/// A verdict without what the hub fills in from the session: its task and the head it reviewed.
fn report_schema() -> Value {
    let mut schema = inline_schema::<ReviewVerdict>();
    if let Some(props) = schema["properties"].as_object_mut() {
        props.remove("taskId");
        props.remove("prHeadSha");
    }
    schema
}

pub fn tools_for(role: Role) -> impl Iterator<Item = &'static Tool> {
    TOOLS.iter().filter(move |t| match role {
        Role::Lead => t.lead,
        Role::Worker => t.worker,
    })
}

/// The `tools/list` answer for `role`.
pub fn tool_list(role: Role) -> Value {
    let tools: Vec<Value> = tools_for(role)
        .map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": (t.schema)() }))
        .collect();
    json!({ "tools": tools })
}

/// The lead call a `tools/call` makes, or why its arguments are not one.
pub fn call_of(role: Role, name: &str, arguments: Value) -> Result<Value, String> {
    let Some(tool) = tools_for(role).find(|t| t.name == name) else {
        return Err(format!("No tool {name} here."));
    };
    let mut call = match arguments {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        _ => return Err("The arguments must be an object.".into()),
    };
    call.insert("op".into(), tool.op.into());
    let call = Value::Object(call);
    serde_json::from_value::<LeadCall>(call.clone())
        .map_err(|e| format!("Invalid arguments for {name}: {e}."))?;
    Ok(call)
}

/// A node answer frame as an MCP tool result.
pub fn tool_result(answer: &Value) -> Value {
    if let Some(result) = answer.get("result") {
        let text = serde_json::to_string_pretty(result).unwrap_or_default();
        return json!({ "content": [{ "type": "text", "text": text }], "isError": false });
    }
    let error = answer.get("error").cloned().unwrap_or_default();
    let mut text = format!(
        "Refused: {}",
        error["message"]
            .as_str()
            .unwrap_or("the hub refused the call")
    );
    if let Some(fix) = error["fix"].as_str() {
        text.push_str(&format!("\nNext: {fix}"));
    }
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn error_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

/// Under the fleetd dir.
pub const NODE_SOCKET_PATH: &str = "node/node.sock";

/// `path.normalize` for an absolute path: `.` and `..` resolved lexically, a trailing slash kept.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let mut out = format!("/{}", parts.join("/"));
    if path.ends_with('/') && out != "/" {
        out.push('/');
    }
    out
}

/// The working directory as the caller's shell names it. The node keeps workspace roots as written, symlinks included,
/// and starts agents there, so the shell's logical `PWD` matches a root where the kernel's resolved path may not.
pub fn caller_cwd(pwd: Option<&str>, physical: &Path) -> String {
    let physical_text = physical.to_string_lossy().into_owned();
    let Some(logical) = pwd.filter(|p| p.starts_with('/')) else {
        return physical_text;
    };
    match (
        std::fs::canonicalize(logical),
        std::fs::canonicalize(physical),
    ) {
        (Ok(a), Ok(b)) if a == b => normalize(logical),
        _ => physical_text,
    }
}

pub fn node_socket_path(env_sock: Option<&str>) -> PathBuf {
    match env_sock.filter(|s| !s.is_empty()) {
        Some(sock) => PathBuf::from(sock),
        None => crate::home::fleetd_dir().join(NODE_SOCKET_PATH),
    }
}

/// One frame out, one frame back over the node's socket. The node answers within ~35 s; `timeout` is a backstop.
/// `Err` is why the node could not be asked or did not answer.
pub fn send_to_node(socket: &Path, frame: &Value, timeout: Duration) -> Result<Value, String> {
    let shown = socket.display();
    let mut conn = UnixStream::connect(socket).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => format!(
            "fleetd hub unreachable: no fleetd node is listening at {shown} (set FLEETD_NODE_SOCK if it is elsewhere) — tell the human the node is down and carry on"
        ),
        _ => format!("cannot reach the fleetd node at {shown}: {error}"),
    })?;
    let started = Instant::now();
    let timed_out = || {
        format!(
            "the fleetd node did not answer within {} s; the call may or may not have gone through — try again shortly",
            timeout.as_secs()
        )
    };
    conn.write_all(format!("{frame}\n").as_bytes())
        .map_err(|error| format!("cannot reach the fleetd node at {shown}: {error}"))?;
    conn.set_read_timeout(Some(
        timeout
            .saturating_sub(started.elapsed())
            .max(Duration::from_millis(1)),
    ))
    .map_err(|error| format!("cannot reach the fleetd node at {shown}: {error}"))?;
    let mut line = String::new();
    match BufReader::new(conn).read_line(&mut line) {
        Ok(_) if line.ends_with('\n') => {}
        Ok(_) => {
            return Err(
                "the fleetd node closed the connection without answering — try again shortly"
                    .into(),
            );
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            return Err(timed_out());
        }
        Err(error) => return Err(format!("cannot reach the fleetd node at {shown}: {error}")),
    }
    decode_result_frame(line.trim_end_matches('\n'))
        .ok_or_else(|| "the fleetd node sent an answer this CLI cannot read; check that node and CLI versions match".to_owned())
}

/// The node's answer, checked against the contract (a `lead_result` with exactly one of result and error).
fn decode_result_frame(line: &str) -> Option<Value> {
    match serde_json::from_str::<LeadSocketFrame>(line).ok()? {
        LeadSocketFrame::LeadResult(_) => serde_json::from_str(line).ok(),
        LeadSocketFrame::LeadCall(_) => None,
    }
}

/// Where the server runs and how it reaches the node; tests swap `send`.
pub struct LeadDeps<'a> {
    pub pwd: Option<String>,
    pub sock: Option<String>,
    /// `FLEETD_THREAD_ID`: set inside a fleetd session, so the hub knows which agent is calling.
    pub thread: Option<String>,
    pub cwd: PathBuf,
    pub send: &'a dyn Fn(&Path, &Value) -> Result<Value, String>,
}

/// One lead call (`{"op": …, …}`) to the hub through the node; the answer frame, or why the node could not be asked.
pub fn send_call(call: Value, deps: &LeadDeps) -> Result<Value, String> {
    let mut frame = json!({
        "t": "lead_call",
        "id": format!("cli-{}", std::process::id()),
        "cwd": caller_cwd(deps.pwd.as_deref(), &deps.cwd),
        "call": call,
    });
    if let Some(thread) = deps.thread.as_deref().filter(|t| !t.is_empty()) {
        frame["threadId"] = thread.into();
    }
    (deps.send)(&node_socket_path(deps.sock.as_deref()), &frame)
}

/// The real process's [`LeadDeps`].
pub fn env_deps<'a>(
    send: &'a dyn Fn(&Path, &Value) -> Result<Value, String>,
) -> LeadDeps<'a> {
    LeadDeps {
        pwd: std::env::var("PWD").ok(),
        sock: std::env::var("FLEETD_NODE_SOCK").ok(),
        thread: std::env::var("FLEETD_THREAD_ID").ok(),
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
        send,
    }
}

/// One JSON-RPC message in, its answer out (`None` for a notification).
pub fn handle(role: Role, message: &Value, deps: &LeadDeps) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message["method"].as_str().unwrap_or_default();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fleetd", "version": crate::version() },
            "instructions": "fleetd's own tools: every agent is a fleetd task, started, steered and stopped here.",
        }),
        "ping" => json!({}),
        "tools/list" => tool_list(role),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            let arguments = message["params"]["arguments"].clone();
            match call_of(role, name, arguments) {
                Err(why) => error_result(&why),
                Ok(call) => match send_call(call, deps) {
                    Ok(answer) => tool_result(&answer),
                    Err(unreachable) => error_result(&format!(
                        "{unreachable}. Carry on without this call and say so in your result."
                    )),
                },
            }
        }
        _ => {
            return Some(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") },
            }));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// `fleetd agent-mcp --role lead|worker`: serves stdin until it closes.
pub fn run(argv: &[String]) -> u8 {
    let role = match argv {
        [flag, role] if flag == "--role" && role == "lead" => Role::Lead,
        [flag, role] if flag == "--role" && role == "worker" => Role::Worker,
        _ => {
            eprintln!("usage: fleetd agent-mcp --role lead|worker");
            return 2;
        }
    };
    let send = |socket: &Path, frame: &Value| send_to_node(socket, frame, Duration::from_secs(60));
    let deps = env_deps(&send);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle(role, &message, &deps),
            Err(e) => Some(json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": format!("parse error: {e}") },
            })),
        };
        if let Some(answer) = answer
            && writeln!(stdout, "{answer}")
                .and_then(|()| stdout.flush())
                .is_err()
        {
            break;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(role: Role) -> Vec<String> {
        tool_list(role)["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn a_worker_sees_only_report_and_ask_lead() {
        assert_eq!(names(Role::Worker), ["report", "ask_lead"]);
        let lead = names(Role::Lead);
        for tool in [
            "spawn_agent",
            "message_agent",
            "agents",
            "stop_agent",
            "request_secret",
            "decide",
            "brief",
            "close",
            "gated_run",
            "plan",
        ] {
            assert!(lead.contains(&tool.to_owned()), "{tool}");
        }
        assert!(!lead.contains(&"report".to_owned()) && !lead.contains(&"ask_lead".to_owned()));
        // A worker calling a lead's tool by name gets nothing sent.
        assert_eq!(
            call_of(Role::Worker, "spawn_agent", json!({})).unwrap_err(),
            "No tool spawn_agent here."
        );
    }

    #[test]
    fn every_tool_is_one_lead_call_with_an_object_schema() {
        for role in [Role::Lead, Role::Worker] {
            for tool in tool_list(role)["tools"].as_array().unwrap() {
                let schema = &tool["inputSchema"];
                assert_eq!(schema["type"], "object", "{}", tool["name"]);
                assert!(
                    !schema.to_string().contains("$ref"),
                    "{} has a $ref",
                    tool["name"]
                );
            }
        }
        let spawn = call_of(
            Role::Lead,
            "spawn_agent",
            json!({ "workstreamId": "W1", "title": "t", "prompt": "p" }),
        )
        .unwrap();
        assert_eq!(spawn["op"], "task_spawn");
        let bad = call_of(Role::Lead, "spawn_agent", json!({ "workstreamId": "W1" })).unwrap_err();
        assert!(
            bad.starts_with("Invalid arguments for spawn_agent"),
            "{bad}"
        );
        let brief = json!({ "goal": "g", "why": "w", "pointers": [], "constraints": [], "doneWhen": ["d"] });
        let unopened = call_of(Role::Lead, "brief", json!({ "brief": brief })).unwrap_err();
        assert!(unopened.contains("or text to open one"), "{unopened}");
        assert_eq!(
            call_of(Role::Worker, "ask_lead", json!({ "question": "Postgres?" })).unwrap(),
            json!({ "op": "ask_lead", "question": "Postgres?" })
        );
    }

    #[test]
    fn report_is_a_verdict_the_hub_completes() {
        let verdict = json!({ "blocking": 0, "nonBlocking": 1, "summary": "ok" });
        assert_eq!(
            call_of(Role::Worker, "report", verdict).unwrap(),
            json!({ "op": "review_verdict", "blocking": 0, "nonBlocking": 1, "summary": "ok" })
        );
        let schema = report_schema();
        for field in ["taskId", "prHeadSha"] {
            assert!(schema["properties"].get(field).is_none(), "{field}");
        }
    }

    #[test]
    fn calls_go_through_the_node_socket_with_the_session_named() {
        let sent = std::cell::RefCell::new(Vec::new());
        let send = |_: &Path, frame: &Value| {
            sent.borrow_mut().push(frame.clone());
            Ok(json!({ "t": "lead_result", "id": "x", "error": {
                "code": "forbidden", "message": "T3 is a task, and a task's agent can't start agents.",
                "fix": "Do this work yourself." } }))
        };
        let deps = LeadDeps {
            pwd: None,
            sock: Some("/n.sock".into()),
            thread: Some("s1".into()),
            cwd: "/work/p".into(),
            send: &send,
        };
        let message = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "ask_lead", "arguments": { "question": "Which DB?" } } });
        let answer = handle(Role::Worker, &message, &deps).unwrap();
        assert_eq!(sent.borrow()[0]["threadId"], "s1");
        assert_eq!(sent.borrow()[0]["call"]["op"], "ask_lead");
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(
            answer["result"]["content"][0]["text"],
            "Refused: T3 is a task, and a task's agent can't start agents.\nNext: Do this work yourself."
        );
        assert!(
            handle(
                Role::Worker,
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                &deps
            )
            .is_none()
        );
    }

    #[test]
    fn talks_to_a_node_socket_and_says_when_none_listens() {
        let dir = std::env::temp_dir().join(format!("fleetd-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("node.sock");
        let _ = std::fs::remove_file(&socket);
        let down = send_to_node(&socket, &json!({}), Duration::from_secs(5)).unwrap_err();
        assert!(down.starts_with(&format!(
            "fleetd hub unreachable: no fleetd node is listening at {}",
            socket.display()
        )));

        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&conn).read_line(&mut line).unwrap();
            let frame: Value = serde_json::from_str(&line).unwrap();
            let answer = json!({ "t": "lead_result", "id": frame["id"], "result": { "op": "decisions_search", "decisions": [] } });
            (&conn).write_all(format!("{answer}\n").as_bytes()).unwrap();
            frame
        });
        let frame = json!({ "t": "lead_call", "id": "cli-1", "cwd": "/w", "call": { "op": "decisions_search", "query": "health" } });
        let answer = send_to_node(&socket, &frame, Duration::from_secs(5)).unwrap();
        assert_eq!(server.join().unwrap(), frame);
        assert_eq!(answer["result"]["op"], "decisions_search");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn caller_cwd_keeps_the_shells_logical_path() {
        let dir = std::env::temp_dir().join(format!("fleetd-cwd-{}", std::process::id()));
        let real = dir.join("real");
        let link = dir.join("link");
        std::fs::create_dir_all(real.join("src")).unwrap();
        let _ = std::os::unix::fs::symlink(&real, &link);
        let real_src = std::fs::canonicalize(real.join("src")).unwrap();
        let link_src = format!("{}/src", link.display());
        assert_eq!(caller_cwd(Some(&link_src), &real_src), link_src);
        assert_eq!(
            caller_cwd(Some(&format!("{}/./src/", link.display())), &real_src),
            format!("{link_src}/")
        );
        assert_eq!(caller_cwd(None, &real_src), real_src.display().to_string());
        assert_eq!(
            caller_cwd(Some("link"), &real_src),
            real_src.display().to_string()
        );
        assert_eq!(
            caller_cwd(Some(&link.display().to_string()), &real_src),
            real_src.display().to_string()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
