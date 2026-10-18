//! The M1 MCP tools over the executor and the caches it fills: fleetd_status, projects_list, project_get,
//! thread_tail, actions_list, thread_launch, thread_send and thread_interrupt.
//! Later areas add to fleetd_status and project_get through `ToolHooks` (slots, lead,
//! workstreams, tasks, trains), gate launches (usage), and route thread_send through the offline write queue.
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::mcp::{
    ActionsListInput, ErrorCode, FleetdStatusInput, ProjectGetInput, ProjectsListInput, TailKind,
    ThreadInterruptInput, ThreadLaunchInput, ThreadSendInput, ThreadTailInput,
};
use fleetd_contracts::model::{Machine, MachineStatus};
use serde_json::{Map, Value, json};

use super::thread_view::TailRow;
use super::{ExecutorError, LaunchInput, LaunchOptions, WriteOutcome};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, any_truncated, can_read, cap, clip, limits, offline,
    readable, require, unknown_machine, unknown_project, unknown_thread,
};
use crate::hub::store::{iso_ms, now_ms};

pub type HookFuture<T> = Pin<Box<dyn Future<Output = Result<T, ToolError>> + Send>>;

/// What an area adds to one project's project_get outcome.
#[derive(Default)]
pub struct ProjectExtra {
    /// Merged into the outcome (`lead`, `workstreams`, `taskCounts`, `tasks`, `trains`).
    pub fields: Map<String, Value>,
    /// Threads that show elsewhere (task threads show only as tasks), left out of `threads`.
    pub exclude_threads: HashSet<String>,
    pub truncated: Option<bool>,
}

type ProjectHook = Arc<dyn Fn(Arc<Hub>, ProjectRef) -> HookFuture<ProjectExtra> + Send + Sync>;
type StatusHook = Arc<dyn Fn(Arc<Hub>, Caller) -> HookFuture<Map<String, Value>> + Send + Sync>;
type LaunchGate = Arc<
    dyn Fn(Arc<Hub>, MachineId) -> Pin<Box<dyn Future<Output = Option<String>> + Send>>
        + Send
        + Sync,
>;

/// Where later areas plug into the M1 tools.
#[derive(Default)]
pub struct ToolHooks {
    project: RwLock<Vec<ProjectHook>>,
    status: RwLock<Vec<StatusHook>>,
    launch_gates: RwLock<Vec<LaunchGate>>,
}

impl ToolHooks {
    /// Adds fields to project_get (leads, workstreams, tasks, trains).
    pub fn extend_project_get(&self, hook: ProjectHook) {
        self.project.write().unwrap().push(hook);
    }
    /// Adds fields to fleetd_status (the slot board, filtered to the caller's machines).
    pub fn extend_status(&self, hook: StatusHook) {
        self.status.write().unwrap().push(hook);
    }
    /// A launch refused while a gate says why (usage: the login is exhausted). The reason reads "Not launched: <it>."
    pub fn gate_launch(&self, gate: LaunchGate) {
        self.launch_gates.write().unwrap().push(gate);
    }
}

const ATTENTION_TYPES: [&str; 6] = [
    "thread.failed",
    "thread.waiting",
    "thread.usage_limited",
    "usage.breaker",
    "change.needs_rebase",
    "change.ci_failed",
];
/// How far back fleetd_status looks for attention events.
const ATTENTION_LOOKBACK: i64 = 1000;

pub fn register(tools: &mut Registry) {
    tools.add("fleetd_status", fleetd_status);
    tools.add("projects_list", projects_list);
    tools.add("project_get", project_get);
    tools.add("thread_tail", thread_tail);
    tools.add("actions_list", actions_list);
    tools.add("thread_launch", thread_launch);
    tools.add("thread_send", thread_send);
    tools.add("thread_interrupt", thread_interrupt);
}

fn now(hub: &Hub) -> String {
    iso_ms(now_ms(hub.clock.as_ref()))
}

pub fn from_executor(error: ExecutorError) -> ToolError {
    match error {
        ExecutorError::MachineNotConnected { machine_id } => offline(&machine_id),
        ExecutorError::ThreadNotFound {
            machine_id,
            thread_id,
        } => unknown_thread(&ThreadRef {
            machine_id,
            thread_id,
        }),
        e @ ExecutorError::T3RequestFailed { .. } => {
            if let ExecutorError::T3RequestFailed { cause, .. } = &e {
                tracing::warn!(cause = %cause, "executor: T3 request failed");
            }
            ToolError::new(ErrorCode::T3Error, e.to_string())
                .with_fix("Retry; if it keeps failing, check the machine with fleetd_status.")
        }
    }
}

/// A machine's cache is fresh only while its node is online and its executor holds a T3 connection.
fn freshness(hub: &Hub, machine_id: &MachineId) -> Result<(Machine, bool, String), ToolError> {
    let machine = hub
        .store
        .machine_get(machine_id)?
        .ok_or_else(|| unknown_machine(machine_id))?;
    let live = machine.status == MachineStatus::Online && hub.executors.is_connected(machine_id);
    let as_of = if live {
        now(hub)
    } else {
        machine.last_seen_at.0.clone()
    };
    Ok((machine, !live, as_of))
}

fn mark_stale(mut thread: Value, stale: bool, as_of: &str) -> Value {
    if stale {
        thread["stale"] = json!(true);
        thread["asOf"] = json!(as_of);
    }
    thread
}

fn with_truncated(out: &mut Value, truncated: Option<bool>) {
    if truncated == Some(true) {
        out["truncated"] = json!(true);
    }
}

/// The latest attention events the caller may see, oldest first, scanned forward from a bounded lookback.
fn attention(hub: &Hub, caller: &Caller, head: i64) -> Result<Vec<Value>, ToolError> {
    let types: Vec<HubEventType> = ATTENTION_TYPES
        .iter()
        .filter_map(|t| serde_json::from_value(json!(t)).ok())
        .collect();
    let mut cursor = (head - ATTENTION_LOOKBACK).max(0);
    let mut latest: Vec<Value> = vec![];
    loop {
        let page = hub.events.page(cursor, Some(&types), None)?;
        for e in page.events.iter().filter(|e| can_read(caller, e)) {
            latest.push(serde_json::to_value(e).unwrap_or_default());
        }
        if latest.len() > limits::ATTENTION {
            latest.drain(..latest.len() - limits::ATTENTION);
        }
        if !page.more || page.cursor <= cursor {
            return Ok(latest);
        }
        cursor = page.cursor;
    }
}

async fn fleetd_status(
    hub: Arc<Hub>,
    caller: Caller,
    _: FleetdStatusInput,
) -> Result<Value, ToolError> {
    let cursor = hub.events.head();
    let machines: Vec<Machine> = hub
        .store
        .machines_list()?
        .into_iter()
        .filter(|m| readable(&caller, &m.machine_id))
        .collect();
    let mut projects: Vec<_> = hub
        .store
        .projects_list(None, None)?
        .into_iter()
        .filter(|p| readable(&caller, &p.machine_id))
        .collect();
    projects.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    let shown = cap(projects, limits::PROJECTS);
    let mut out = json!({
        "machines": machines,
        "projects": shown.items,
        "attention": attention(&hub, &caller, cursor)?,
        "cursor": cursor,
        "next": format!("Call events_wait with cursor {cursor} to wait for changes, or project_get for one project's outcome."),
    });
    let hooks: Vec<StatusHook> = hub.executors.hooks.status.read().unwrap().clone();
    for hook in hooks {
        for (k, v) in hook(hub.clone(), caller.clone()).await? {
            out[k] = v;
        }
    }
    with_truncated(&mut out, shown.truncated);
    Ok(out)
}

async fn projects_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectsListInput,
) -> Result<Value, ToolError> {
    if let Some(machine_id) = &input.machine_id {
        require(&caller, Role::Read, Some(machine_id))?;
    }
    let projects: Vec<_> = hub
        .store
        .projects_list(input.machine_id.as_ref(), input.query.as_deref())?
        .into_iter()
        .filter(|p| readable(&caller, &p.machine_id))
        .collect();
    let shown = cap(projects, limits::PROJECTS);
    let mut out = json!({ "projects": shown.items });
    if shown.truncated == Some(true) {
        out["truncated"] = json!(true);
        out["next"] = json!("Narrow the list with machineId or query.");
    }
    Ok(out)
}

async fn project_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectGetInput,
) -> Result<Value, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let (_, stale, as_of) = freshness(&hub, &input.machine_id)?;
    let r = ProjectRef {
        machine_id: input.machine_id.clone(),
        project_id: input.project_id.clone(),
    };
    let project = hub
        .store
        .project_get(&r)?
        .ok_or_else(|| unknown_project(&r))?;
    let hooks: Vec<ProjectHook> = hub.executors.hooks.project.read().unwrap().clone();
    let mut extras = vec![];
    for hook in hooks {
        extras.push(hook(hub.clone(), r.clone()).await?);
    }
    let excluded: HashSet<&String> = extras.iter().flat_map(|e| &e.exclude_threads).collect();
    // Task threads show only as tasks, never in the thread list.
    let own: Vec<Value> = hub
        .store
        .threads_by_project(&r, limits::OUTCOME_THREAD_SCAN as i64)?
        .into_iter()
        .filter(|t| !excluded.contains(&t.thread_id.to_string()))
        .map(|t| mark_stale(serde_json::to_value(t).unwrap_or_default(), stale, &as_of))
        .collect();
    let threads = cap(own, limits::OUTCOME_THREADS);
    let next = if stale {
        format!("Cached as of {as_of}: {} is offline.", input.machine_id)
    } else {
        "Call thread_tail for a thread's latest messages and actions.".to_owned()
    };
    let mut out = json!({ "project": project, "threads": threads.items, "stale": stale, "asOf": as_of, "next": next });
    let mut flags = vec![threads.truncated];
    for extra in extras {
        for (k, v) in extra.fields {
            out[k] = v;
        }
        flags.push(extra.truncated);
    }
    with_truncated(&mut out, any_truncated(&flags));
    Ok(out)
}

async fn thread_tail(
    hub: Arc<Hub>,
    caller: Caller,
    input: ThreadTailInput,
) -> Result<Value, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let (_, stale, as_of) = freshness(&hub, &input.machine_id)?;
    let r = ThreadRef {
        machine_id: input.machine_id.clone(),
        thread_id: input.thread_id.clone(),
    };
    let n = input.n.get().max(0) as usize;
    if stale {
        // The hub caches shell rows only, so offline the tail is the cached latest message.
        let stored = hub
            .store
            .thread_get(&r)?
            .ok_or_else(|| unknown_thread(&r))?;
        let thread = stored.thread;
        let wants_messages = input
            .kinds
            .as_ref()
            .is_none_or(|k| k.contains(&TailKind::Message));
        let tail = thread.latest_message_tail.as_str();
        let items = if wants_messages && !tail.is_empty() {
            vec![json!({
                "kind": "message",
                "at": thread.last_progress_at,
                "role": "assistant",
                "text": clip(tail, limits::TAIL_TEXT),
            })]
        } else {
            vec![]
        };
        return Ok(json!({
            "items": items,
            "thread": mark_stale(serde_json::to_value(&thread).unwrap_or_default(), true, &as_of),
            "next": format!("Cached as of {as_of}: {} is offline, so only the latest message is available.", input.machine_id),
        }));
    }
    let kinds: Option<Vec<&str>> = input.kinds.as_ref().map(|ks| {
        ks.iter()
            .map(|k| {
                if *k == TailKind::Message {
                    "message"
                } else {
                    "action"
                }
            })
            .collect()
    });
    let tail = hub
        .executors
        .tail(&r, n, kinds.as_deref())
        .await
        .map_err(from_executor)?;
    let items = cap(tail.items, n);
    let rows: Vec<Value> = items
        .items
        .into_iter()
        .map(|row| match row {
            TailRow::Message { at, role, text } => {
                json!({ "kind": "message", "at": at, "role": role, "text": clip(&text, limits::TAIL_TEXT) })
            }
            action => serde_json::to_value(action).unwrap_or_default(),
        })
        .collect();
    let mut out = json!({ "items": rows, "thread": tail.thread });
    with_truncated(
        &mut out,
        any_truncated(&[items.truncated, tail.truncated.then_some(true)]),
    );
    Ok(out)
}

async fn actions_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ActionsListInput,
) -> Result<Value, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let (_, stale, _) = freshness(&hub, &input.machine_id)?;
    if stale {
        return Err(offline(&input.machine_id));
    }
    let r = ThreadRef {
        machine_id: input.machine_id.clone(),
        thread_id: input.thread_id.clone(),
    };
    let limit = input.limit.get().max(0) as usize;
    let actions = hub
        .executors
        .actions(&r, limit, input.failed_only == Some(true))
        .await
        .map_err(from_executor)?;
    let shown = cap(actions, limit);
    let mut out = json!({ "actions": shown.items });
    with_truncated(&mut out, shown.truncated);
    Ok(out)
}

fn require_connected(hub: &Hub, machine_id: &MachineId) -> Result<(), ToolError> {
    if hub.executors.is_connected(machine_id) {
        Ok(())
    } else {
        Err(offline(machine_id))
    }
}

async fn thread_launch(
    hub: Arc<Hub>,
    caller: Caller,
    input: ThreadLaunchInput,
) -> Result<Value, ToolError> {
    require(&caller, Role::Operate, Some(&input.machine_id))?;
    require_connected(&hub, &input.machine_id)?;
    let r = ProjectRef {
        machine_id: input.machine_id.clone(),
        project_id: input.project_id.clone(),
    };
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    // M4 usage: no new turn goes into a login fleetd knows is exhausted.
    let gates: Vec<LaunchGate> = hub.executors.hooks.launch_gates.read().unwrap().clone();
    for gate in gates {
        if let Some(paused) = gate(hub.clone(), input.machine_id.clone()).await {
            return Err(ToolError::new(ErrorCode::Invalid, format!("Not launched: {paused}.")).with_fix(format!(
                "Wait for the reset (usage_status shows it), or run usage_resume with machineId {} once the login has capacity again.",
                input.machine_id
            )));
        }
    }
    let cursor = hub.events.head();
    let launch = LaunchInput {
        project_id: input.project_id.clone(),
        prompt: input.prompt.as_str().to_owned(),
        model: input.model.as_str().to_owned(),
        effort: input.effort,
        runtime_mode: input.runtime_mode,
        title: input.title.clone(),
        client_request_id: input.client_request_id.as_str().to_owned(),
    };
    let thread_id = hub
        .executors
        .launch(&input.machine_id, &launch, LaunchOptions::default())
        .await
        .map_err(from_executor)?;
    Ok(json!({
        "threadId": thread_id,
        "next": format!("Call events_wait with cursor {cursor} and machineId {} to wait for thread.completed.", input.machine_id),
    }))
}

async fn thread_send(
    hub: Arc<Hub>,
    caller: Caller,
    input: ThreadSendInput,
) -> Result<Value, ToolError> {
    require(&caller, Role::Operate, Some(&input.machine_id))?;
    let r = ThreadRef {
        machine_id: input.machine_id.clone(),
        thread_id: input.thread_id.clone(),
    };
    // A write that may wait in the queue needs a target the hub has seen, since T3 can't vouch for it offline.
    if hub.store.machine_get(&r.machine_id)?.is_none() {
        return Err(unknown_machine(&r.machine_id));
    }
    if hub.store.thread_get(&r)?.is_none() && !hub.executors.is_connected(&r.machine_id) {
        return Err(unknown_thread(&r));
    }
    let message = input.message.as_str();
    let request_id = input.client_request_id.as_str();
    let sent = match hub.executors.offline_writer() {
        Some(writer) => writer.send(&r, message, request_id).await,
        None => hub
            .executors
            .send(&r, message, request_id)
            .await
            .map(|s| WriteOutcome {
                run_id: s.run_id,
                queued: s.queued,
                queued_until: None,
            }),
    }
    .map_err(from_executor)?;
    // As in older hubs: a message queued behind a run T3 is still starting also reads "offline … until undefined".
    let next = if sent.queued {
        format!(
            "{} is offline: the message is queued until {}. Wait for write.delivered or write.expired with events_wait.",
            input.machine_id,
            sent.queued_until.as_deref().unwrap_or("undefined")
        )
    } else {
        "Call events_wait to wait for the thread to finish.".to_owned()
    };
    let mut out = json!({ "queued": sent.queued, "next": next });
    if let Some(run_id) = sent.run_id {
        out["runId"] = json!(run_id);
    }
    if let Some(until) = sent.queued_until {
        out["queuedUntil"] = json!(until);
    }
    Ok(out)
}

async fn thread_interrupt(
    hub: Arc<Hub>,
    caller: Caller,
    input: ThreadInterruptInput,
) -> Result<Value, ToolError> {
    require(&caller, Role::Operate, Some(&input.machine_id))?;
    require_connected(&hub, &input.machine_id)?;
    let r = ThreadRef {
        machine_id: input.machine_id.clone(),
        thread_id: input.thread_id.clone(),
    };
    hub.executors
        .interrupt(&r, input.client_request_id.as_str())
        .await
        .map_err(from_executor)?;
    Ok(json!({ "ok": true }))
}
