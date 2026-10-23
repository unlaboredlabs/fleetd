//! `fleetd agent-mcp --role lead|worker`: the MCP server (stdio, one JSON-RPC message per line) the node puts in every
//! lead's and task's `--mcp-config`. Each tool is one lead-side call, sent through the node's socket exactly as the
//! CLI sends it, with the session's `FLEETD_THREAD_ID`; the hub decides who may make it (`hub/tasks/policy.rs`). The
//! role only picks which tools are listed. Results that take time (a task's result, an answer, an approval) arrive
//! in a later wake, never by polling.
use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Duration;

use fleetd_contracts::lead_calls::{
    AskLeadCall, BriefCreateCall, ChangeEnqueueCall, CloseCall, DecideCall, DecisionsSearchCall,
    GatedRunCall, LeadCall, RequestSecretCall, RequestWithdrawCall, TaskCancelCall, TaskListCall,
    TaskMessageCall, TaskSpawnCall, TaskStatusCall, WorkstreamOpenCall,
};
use fleetd_contracts::plan::{
    PlanAddCall, PlanDropCall, PlanEditCall, PlanMilestoneCall, PlanShowCall,
};
use fleetd_contracts::schema::inline_schema;
use fleetd_contracts::verification::ReviewVerdict;
use serde_json::{Value, json};

use super::lead::{LeadDeps, env_deps, send_call, send_to_node};

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
        "agent_status",
        "task_status",
        "One task as stored: state, queued reason, thread, result.",
        inline_schema::<TaskStatusCall>,
    ),
    lead(
        "list_agents",
        "task_list",
        "The project's tasks, newest first, optionally by state or workstream.",
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
        "Set a draft workstream's brief (goal, why, pointers, constraints, doneWhen lines) and \
         start it, or edit it later.",
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
        "plan_milestone",
        "plan_milestone",
        "Add a milestone to the project's plan.",
        inline_schema::<PlanMilestoneCall>,
    ),
    lead(
        "plan_add",
        "plan_add",
        "Add a plan item (must or polish, size s|m|l, after other items). After a milestone's first 10 minutes a \
         change needs why, or steer when the human's steer asked for it.",
        inline_schema::<PlanAddCall>,
    ),
    lead(
        "plan_edit",
        "plan_edit",
        "Change a plan item.",
        inline_schema::<PlanEditCall>,
    ),
    lead(
        "plan_drop",
        "plan_drop",
        "Drop a plan item, with why or steer.",
        inline_schema::<PlanDropCall>,
    ),
    lead(
        "plan_show",
        "plan_show",
        "The project's plan.",
        inline_schema::<PlanShowCall>,
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
    lead(
        "workstream_open",
        "workstream_open",
        "Open a workstream for work you took from the chat: a draft you then brief. template picks the \
         playbook (feature, bugfix, research).",
        inline_schema::<WorkstreamOpenCall>,
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
    let read_file = |file: &str| std::fs::read_to_string(file);
    let deps = env_deps(&send, &read_file);
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
            "agent_status",
            "list_agents",
            "stop_agent",
            "request_secret",
            "decide",
            "brief",
            "close",
            "gated_run",
            "plan_add",
            "plan_show",
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
        let read_file = |_: &str| Err(std::io::Error::other("no file"));
        let deps = LeadDeps {
            pwd: None,
            sock: Some("/n.sock".into()),
            thread: Some("s1".into()),
            cwd: "/work/p".into(),
            send: &send,
            read_file: &read_file,
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
}
