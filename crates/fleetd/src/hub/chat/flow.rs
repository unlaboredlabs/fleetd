//! The chat's moving parts over the hub: a human's message reaches the project's lead (a new turn when it is idle,
//! joined to its turn when it is working, held while it starts), the lead's replies stream back and land as
//! messages, the project's past is read in once, and the needs-you state follows.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::Role;
use fleetd_contracts::chat::{ChatAuthor, ChatDelivery, ChatHistorySource, ProjectChatState};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{LeadState, WorkstreamState};
use fleetd_contracts::mcp::{
    ChatSendInput, ChatSendOutput, ErrorCode, OrderStopInput, ProjectStopInput, ProjectStopOutput,
};
use fleetd_contracts::prim::Count;

use super::{NewMessage, history};
use crate::hub::api::{Caller, Hub, ToolError, require};
use crate::hub::intake::attachments;
use crate::hub::leads::lead::AutoStart;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::queue::ports::SendOpts;
use crate::hub::store::{StoreError, WaitInput};

/// How long the history read waits for the lead's session on its machine before reading without its messages.
const LEAD_READ_WAIT: Duration = Duration::from_secs(5);
/// Streamed text is folded into the chat this often.
const STREAM_TICK: Duration = Duration::from_millis(250);

fn store_error(e: StoreError) -> ToolError {
    tracing::error!(error = %e, "chat store");
    crate::hub::api::internal_error()
}

fn lead_thread(hub: &Hub, r: &ProjectRef) -> Option<ThreadRef> {
    let lead = hub.leads.records.lead_get(r).ok()??;
    Some(ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: lead.thread_id,
    })
}

pub fn lead_working(hub: &Hub, r: &ProjectRef) -> bool {
    hub.leads
        .leads
        .get(r)
        .ok()
        .flatten()
        .is_some_and(|l| l.state == LeadState::Working)
}

/// The project's chat state, announced when it changed.
pub fn state(hub: &Hub, r: &ProjectRef) -> Result<ProjectChatState, StoreError> {
    let state = hub.chat.state(r, lead_working(hub, r))?;
    hub.chat.tell_state(&state)?;
    Ok(state)
}

/// Every record of the project's past, as chat messages.
async fn past(hub: &Hub, r: &ProjectRef) -> Vec<NewMessage> {
    let mut out = Vec::new();
    let orders = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            limit: 500,
            ..Default::default()
        })
        .unwrap_or_default();
    for w in &orders {
        out.extend(history::order(w));
    }
    let ids: Vec<String> = orders.iter().map(|w| w.workstream_id.to_string()).collect();
    let rows = hub.db.with(|c| {
        let mut steers = Vec::new();
        let mut stmt = c.prepare("SELECT n, workstream_id, data FROM steers ORDER BY n")?;
        for row in stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })? {
            let (n, ws, data) = row?;
            if ids.contains(&ws) {
                steers.push((n, data));
            }
        }
        // The retired questions tool's rows, under the name they had or the one they were kept as.
        let mut asks = Vec::new();
        for table in ["legacy_asks", "asks"] {
            let exists: bool = c
                .query_row(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |_| Ok(()),
                )
                .is_ok();
            if !exists {
                continue;
            }
            let mut stmt = c.prepare(&format!("SELECT data FROM {table}"))?;
            for data in stmt.query_map([], |row| row.get::<_, String>(0))? {
                asks.push(data?);
            }
            break;
        }
        Ok((steers, asks))
    });
    let (steers, asks) = rows.unwrap_or_default();
    for (n, data) in steers {
        if let Ok(v) = serde_json::from_str(&data)
            && let Some(m) = history::steer(n, &v)
        {
            out.push(m);
        }
    }
    for data in asks {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        let own = v["projectRef"]["machineId"].as_str() == Some(r.machine_id.as_str())
            && v["projectRef"]["projectId"].as_str() == Some(r.project_id.as_str());
        if own {
            out.extend(history::question(&v));
        }
    }
    if let Some(thread) = lead_thread(hub, r)
        && let Ok(Ok(messages)) =
            tokio::time::timeout(LEAD_READ_WAIT, hub.executors.messages(&thread)).await
    {
        out.extend(history::lead_messages(thread.thread_id.as_str(), &messages));
    }
    out
}

/// Reads the project's past into its chat, once.
pub async fn ensure(hub: &Hub, r: &ProjectRef) -> Result<(), StoreError> {
    hub.chat.read_history(r, || past(hub, r)).await
}

fn waiting_reason(e: &crate::hub::leads::LeadError) -> String {
    match &e.fix {
        Some(fix) => format!("{} {fix}", e.message),
        None => e.message.to_string(),
    }
}

/// `chat_send`: the message is stored at once, then goes to the lead. The same clientRequestId returns the stored
/// message and sends nothing again.
pub async fn send(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: ChatSendInput,
) -> Result<ChatSendOutput, ToolError> {
    let r = input.project_ref.clone();
    require(caller, Role::Operate, Some(&r.machine_id))?;
    if hub.store.project_get(&r).map_err(store_error)?.is_none() {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("No project {} on {}.", r.project_id, r.machine_id),
        )
        .with_fix("Pick a project from fleetd_status."));
    }
    let ids: Vec<_> = input
        .attachments
        .as_ref()
        .map(|a| a.iter().cloned().collect())
        .unwrap_or_default();
    attachments::check(hub, caller, &ids)?;
    let request = format!("{}:{}", caller.key_id, input.client_request_id);
    if let Some(stored) = hub.chat.by_request(&r, &request).map_err(store_error)? {
        return Ok(ChatSendOutput {
            message: stored,
            lead_waiting: None,
            next: None,
            truncated: None,
        });
    }
    ensure(hub, &r).await.map_err(store_error)?;
    let (lead, lead_waiting) = match hub.leads.leads.auto_start(&r).await {
        AutoStart::Running(lead) | AutoStart::Started(lead) => (Some(lead), None),
        AutoStart::Off => (
            None,
            Some("This project's lead starts only by hand (lead.autoStart: false in its policy). Start it with lead_start; it then reads this message.".to_owned()),
        ),
        AutoStart::Held(e) => (None, Some(waiting_reason(&e))),
    };
    let delivery = match &lead {
        Some(l) if l.state == LeadState::Working => ChatDelivery::Steer,
        Some(l) if l.state == LeadState::Starting => ChatDelivery::Queued,
        Some(_) => ChatDelivery::Turn,
        None => ChatDelivery::Queued,
    };
    let (mut message, _) = hub
        .chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: input.text.to_string(),
                attachments: attachments::refs(hub, &ids)?,
                request: Some(request),
                by: Some(caller.name.to_string()),
                delivery: Some(delivery),
                ..Default::default()
            },
        )
        .map_err(store_error)?;
    match lead {
        Some(lead) => {
            let thread = ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id: lead.thread_id,
            };
            let queued = deliver(hub, caller, &r, &thread, &message, &ids).await?;
            if queued && delivery != ChatDelivery::Queued {
                message.delivery = Some(ChatDelivery::Queued);
                hub.chat.put(&message).map_err(store_error)?;
            }
        }
        None => hub.chat.hold(&message).map_err(store_error)?,
    }
    state(hub, &r).map_err(store_error)?;
    Ok(ChatSendOutput {
        message,
        lead_waiting,
        next: Some(
            "The lead's reply arrives as chat.message events; read the chat with chat_history."
                .into(),
        ),
        truncated: None,
    })
}

/// A human's chat message as the lead reads it: fixed wording around the human's own words, not an editable prompt.
pub fn for_lead(text: &str, files: &str) -> String {
    format!("The human writes in your chat:\n\n{text}{files}")
}

/// Into the lead's session: a plain send, which starts a turn or joins the running one. True when it waits for the
/// machine in the offline queue.
async fn deliver(
    hub: &Arc<Hub>,
    caller: &Caller,
    r: &ProjectRef,
    thread: &ThreadRef,
    message: &fleetd_contracts::chat::ChatMessage,
    ids: &[fleetd_contracts::mcp::AttachmentId],
) -> Result<bool, ToolError> {
    let files = if ids.is_empty() {
        Vec::new()
    } else {
        attachments::deliver(hub, caller, ids, r, "chat", None).await?
    };
    let files = if files.is_empty() {
        String::new()
    } else {
        format!("\n\nAttached:\n{}", files.join("\n"))
    };
    let text = for_lead(message.text.as_str(), &files);
    let crid = format!("chat:{}", message.message_id);
    let sent = hub
        .queue
        .send_with(thread, &text, &crid, None, SendOpts::default())
        .await
        .map_err(|e| ToolError::new(ErrorCode::Failed, e.to_string()))?;
    Ok(sent.queued)
}

/// Messages held while the project had no lead go in once it starts, oldest first.
async fn deliver_held(hub: &Arc<Hub>, r: &ProjectRef) {
    let Some(thread) = lead_thread(hub, r) else {
        return;
    };
    let held = match hub.chat.held(r) {
        Ok(held) => held,
        Err(error) => return tracing::warn!(%error, "chat: held messages not read"),
    };
    for message in held {
        let text = for_lead(message.text.as_str(), "");
        let crid = format!("chat:{}", message.message_id);
        match hub
            .queue
            .send_with(&thread, &text, &crid, None, SendOpts::default())
            .await
        {
            Ok(_) => {
                if let Err(error) = hub.chat.release(&message) {
                    tracing::warn!(%error, "chat: held message not released");
                }
            }
            Err(error) => tracing::warn!(%error, "chat: held message not delivered"),
        }
    }
}

/// `project_stop`: every open order of the project stops (its agents cancelled, what waits on a person withdrawn),
/// one line in the chat says so, and the lead hears it. The lead and the chat stay.
pub async fn project_stop(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: ProjectStopInput,
) -> Result<ProjectStopOutput, ToolError> {
    crate::hub::orders::notes::require_human(caller, "project_stop")?;
    let r = input.project_ref.clone();
    require(caller, Role::Operate, Some(&r.machine_id))?;
    let open = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            open: true,
            limit: 200,
            ..Default::default()
        })
        .map_err(store_error)?;
    let (mut stopped, mut cancelled) = (0, 0);
    for w in open.iter().filter(|w| {
        !matches!(
            w.state,
            WorkstreamState::Stopped | WorkstreamState::Done | WorkstreamState::Failed
        )
    }) {
        let one = OrderStopInput {
            workstream_id: w.workstream_id.clone(),
            reason: input.reason.clone(),
        };
        match crate::hub::orders::notes::stop(hub, caller, one).await {
            Ok(out) => {
                stopped += 1;
                cancelled += out.cancelled.get();
            }
            Err(e) => {
                tracing::warn!(workstream = %w.workstream_id, error = %e.message, "project_stop: order not stopped")
            }
        }
    }
    ensure(hub, &r).await.map_err(store_error)?;
    let text = match (stopped, cancelled) {
        (0, _) => "Stop: nothing was running.".to_owned(),
        (_, 0) => "Stopped all work here. No agent was running.".to_owned(),
        (_, 1) => "Stopped all work here: 1 agent cancelled.".to_owned(),
        (_, n) => format!("Stopped all work here: {n} agents cancelled."),
    };
    let message = hub.chat.system_line(&r, &text).map_err(store_error)?;
    state(hub, &r).map_err(store_error)?;
    Ok(ProjectStopOutput {
        stopped: Count::unchecked(stopped),
        cancelled: Count::unchecked(cancelled),
        message,
        next: Some("Tell the lead in the chat what to do next.".into()),
        truncated: None,
    })
}

/// Lands the lead's replies of its session as chat messages: new ones added, streamed ones finished with their
/// complete text. Messages from before the chat read in as history.
async fn mirror(hub: &Hub, r: &ProjectRef, thread: &ThreadRef) {
    if let Err(error) = ensure(hub, r).await {
        return tracing::warn!(%error, "chat: history not read");
    }
    let messages = match hub.executors.messages(thread).await {
        Ok(m) => m,
        Err(error) => return tracing::debug!(%error, "chat: lead messages not read"),
    };
    let since = hub.chat.history_ms(r).ok().flatten().unwrap_or(0);
    for m in history::lead_messages(thread.thread_id.as_str(), &messages) {
        let source = m.source.clone().unwrap_or_default();
        match hub.chat.by_source(r, &source) {
            Ok(Some(mut existing)) => {
                if existing.state == fleetd_contracts::chat::ChatMessageState::Streaming
                    && let Err(error) = hub.chat.finish(&mut existing, &m.text)
                {
                    tracing::warn!(%error, "chat: streamed message not finished");
                }
            }
            Ok(None) => {
                let old = m.created_ms.unwrap_or(0) < since;
                let new = NewMessage {
                    history: old.then_some(ChatHistorySource::LeadMessage),
                    ..m
                };
                if let Err(error) = hub.chat.add(r, new) {
                    tracing::warn!(%error, "chat: lead message not added");
                }
            }
            Err(error) => tracing::warn!(%error, "chat: lead message not read"),
        }
    }
    if let Err(error) = state(hub, r) {
        tracing::warn!(%error, "chat: state not told");
    }
}

/// Folds each working lead's streamed text into its chat: the first text of a reply starts a streaming message,
/// later text appends to it.
fn stream_pass(hub: &Hub, sent: &mut HashMap<String, u64>) {
    let Ok(leads) = hub.leads.records.leads_list() else {
        return;
    };
    let mut live = std::collections::HashSet::new();
    for lead in leads {
        let r = lead.project_ref;
        let thread = ThreadRef {
            machine_id: r.machine_id.clone(),
            thread_id: lead.thread_id,
        };
        let Some(parts) = hub.executors.live(&thread) else {
            continue;
        };
        let Some(text) = parts.text.filter(|_| parts.run_active) else {
            continue;
        };
        if !hub.chat.history_read(&r).unwrap_or(false) {
            continue;
        }
        let source = history::lead_source(thread.thread_id.as_str(), &text.message_id);
        live.insert(source.clone());
        let done = sent.get(&source).copied().unwrap_or(0);
        if text.total <= done {
            continue;
        }
        let append = text.since(done).to_owned();
        let message = match hub.chat.by_source(&r, &source) {
            Ok(Some(m)) => Some(m),
            Ok(None) => hub
                .chat
                .add(
                    &r,
                    NewMessage {
                        author: Some(ChatAuthor::Lead),
                        streaming: true,
                        source: Some(source.clone()),
                        ..Default::default()
                    },
                )
                .ok()
                .map(|(m, _)| m),
            Err(_) => None,
        };
        let Some(mut message) =
            message.filter(|m| m.state == fleetd_contracts::chat::ChatMessageState::Streaming)
        else {
            sent.insert(source, text.total);
            continue;
        };
        if let Err(error) = hub.chat.append(&mut message, &append) {
            tracing::warn!(%error, "chat: streamed text not kept");
            continue;
        }
        sent.insert(source, text.total);
    }
    sent.retain(|source, _| live.contains(source));
}

/// The project whose lead runs in `thread`.
fn lead_project(hub: &Hub, thread: &ThreadRef) -> Option<ProjectRef> {
    hub.leads
        .records
        .leads_list()
        .ok()?
        .into_iter()
        .find(|l| l.thread_id == thread.thread_id && l.project_ref.machine_id == thread.machine_id)
        .map(|l| l.project_ref)
}

/// Follows the leads until the hub stops: their turns starting and ending (the chat's working state, their replies
/// landing), a lead starting (messages held for it go in), and their streamed text.
pub async fn run(hub: Arc<Hub>) {
    let streamer = {
        let hub = hub.clone();
        tokio::spawn(async move {
            let mut sent = HashMap::new();
            loop {
                hub.clock.sleep(STREAM_TICK).await;
                stream_pass(&hub, &mut sent);
            }
        })
    };
    // Leads that ended a turn while the hub was down: their replies land now.
    if let Ok(leads) = hub.leads.records.leads_list() {
        for lead in leads {
            let thread = ThreadRef {
                machine_id: lead.project_ref.machine_id.clone(),
                thread_id: lead.thread_id,
            };
            if hub.chat.history_read(&lead.project_ref).unwrap_or(false) {
                mirror(&hub, &lead.project_ref, &thread).await;
            }
        }
    }
    let types = vec![
        HubEventType::ThreadStarted,
        HubEventType::ThreadCompleted,
        HubEventType::ThreadFailed,
        HubEventType::ThreadInterrupted,
        HubEventType::ThreadWaiting,
        HubEventType::LeadStarted,
    ];
    let mut cursor = hub.events.head();
    loop {
        let page = match hub
            .events
            .wait(WaitInput {
                cursor: Some(cursor),
                types: Some(types.clone()),
                machine_id: None,
                timeout_sec: 3600,
            })
            .await
        {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(%error, "chat: event log read failed");
                hub.clock.sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        cursor = page.cursor;
        for event in page.events {
            let (Some(machine_id), Some(thread_id)) = (event.machine_id, event.thread_id) else {
                continue;
            };
            let thread = ThreadRef {
                machine_id,
                thread_id,
            };
            let Some(r) = lead_project(&hub, &thread) else {
                continue;
            };
            match event.r#type {
                HubEventType::LeadStarted => deliver_held(&hub, &r).await,
                HubEventType::ThreadStarted => {
                    if let Err(error) = state(&hub, &r) {
                        tracing::warn!(%error, "chat: state not told");
                    }
                }
                _ => mirror(&hub, &r, &thread).await,
            }
        }
        if streamer.is_finished() {
            return;
        }
    }
}

/// For the snapshot and fleetd_status: every project's chat state.
pub fn states(hub: &Hub) -> Vec<ProjectChatState> {
    let Ok(projects) = hub.store.projects_list(None, None) else {
        return Vec::new();
    };
    projects
        .into_iter()
        .take(50)
        .filter_map(|p| {
            let r = ProjectRef {
                machine_id: p.machine_id,
                project_id: p.project_id,
            };
            hub.chat.state(&r, lead_working(hub, &r)).ok()
        })
        .collect()
}
