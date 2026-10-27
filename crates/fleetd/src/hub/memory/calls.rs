//! The lead's `remember`, `forget` and `memory_read`, scoped to the caller's project by its session. A task can make
//! none of them (`tasks::policy`): writers get the memory in their first message and nothing else. A nightly refresh's
//! changes are kept for its one line at the end (`refresh`), not posted one by one.
use std::sync::{Arc, Weak};

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::memory::{
    MemoryReadResult, MemoryScope, MemoryTopic, RememberResult, RememberedItem,
};
use fleetd_contracts::prim::{Count, Line, Text};
use serde_json::json;

use super::{MemoryError, Target};
use crate::hub::api::Hub;
use crate::hub::chat::NewMessage;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms};

pub const OPS: [&str; 3] = ["remember", "forget", "memory_read"];

impl From<MemoryError> for McpToolError {
    fn from(e: MemoryError) -> Self {
        let error = McpToolError::new(e.code, e.message);
        match e.fix {
            Some(fix) => error.with_fix(fix),
            None => error,
        }
    }
}

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call)
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn answer(hub: &Hub, caller: &LeadCaller, call: LeadCall) -> Result<LeadCallResult, McpToolError> {
    let r = &caller.project_ref;
    match call {
        LeadCall::Remember(call) => {
            let memory = hub.db.memory();
            let (t, item, len) = memory.remember(r, &call)?;
            let file = Line::unchecked(t.name());
            let cap = memory.cap(&t);
            let next = match item {
                None => "Already remembered, word for word.".to_owned(),
                Some(item) => {
                    remembered(hub, r, caller, item)?;
                    format!(
                        "Remembered in {}. Sessions get it from their next start; you already know it.",
                        t.name()
                    )
                }
            };
            Ok(LeadCallResult::Remember(RememberResult {
                file,
                chars: Count::unchecked(len as i64),
                cap: Count::unchecked(cap as i64),
                next: Some(next),
            }))
        }
        LeadCall::Forget(call) => {
            let memory = hub.db.memory();
            let (t, item, len) = memory.forget(r, &call)?;
            let (file, cap) = (Line::unchecked(t.name()), memory.cap(&t));
            remembered(hub, r, caller, item)?;
            Ok(LeadCallResult::Forget(RememberResult {
                file,
                chars: Count::unchecked(len as i64),
                cap: Count::unchecked(cap as i64),
                next: Some(format!(
                    "Forgot it from {}. Sessions go without it from their next start.",
                    t.name()
                )),
            }))
        }
        LeadCall::MemoryRead(call) => {
            let text = hub.db.memory().read(&Target {
                project: Some(r),
                topic: Some(&call.topic),
            });
            let next = text.trim().is_empty().then(|| {
                format!(
                    "There is no topic {} yet; MEMORY.md lists the ones there are.",
                    call.topic
                )
            });
            Ok(LeadCallResult::MemoryRead(MemoryReadResult {
                topic: call.topic,
                text: Text::unchecked(text),
                next,
            }))
        }
        other => Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a memory call.", op_of(&other)),
        )),
    }
}

/// The chat line that says what was remembered or forgotten and offers Undo, and the event that refreshes Settings >
/// Memory. A nightly refresh's change waits for its one line instead.
fn remembered(
    hub: &Hub,
    r: &ProjectRef,
    caller: &LeadCaller,
    item: RememberedItem,
) -> Result<(), StoreError> {
    let project = (item.scope == MemoryScope::Project).then_some(r);
    changed(hub, project, item.topic.as_ref(), &caller.by)?;
    if caller.agent == CallerAgent::MemoryRefresh {
        return super::refresh::record(&hub.db, r, item);
    }
    let where_ = match (item.scope, &item.topic) {
        (MemoryScope::User, _) => " for every project".to_owned(),
        (MemoryScope::Project, Some(topic)) => format!(" ({topic})"),
        (MemoryScope::Project, None) => String::new(),
    };
    let text = match (item.forgotten == Some(true), &item.reason) {
        (true, Some(why)) => format!("Forgot{where_}: {} ({})", item.text.as_str(), why.as_str()),
        (true, None) => format!("Forgot{where_}: {}", item.text.as_str()),
        (false, _) => format!("Remembered{where_}: {}", item.text.as_str()),
    };
    hub.chat.add(
        r,
        NewMessage {
            author: Some(ChatAuthor::System),
            text,
            remembered: Some(item),
            ..Default::default()
        },
    )?;
    Ok(())
}

/// `memory.changed`, which tells the app to read the memory again. `project` is None for `user.md`.
pub fn changed(
    hub: &Hub,
    project: Option<&ProjectRef>,
    topic: Option<&MemoryTopic>,
    by: &str,
) -> Result<(), StoreError> {
    let scope = if project.is_some() {
        MemoryScope::Project
    } else {
        MemoryScope::User
    };
    hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::MemoryChanged,
        machine_id: project.map(|r| r.machine_id.clone()),
        project_id: project.map(|r| r.project_id.clone()),
        thread_id: None,
        summary: match project {
            None => "user.md changed".into(),
            Some(r) => format!(
                "{} of {}/{} changed",
                topic.map_or_else(|| super::INDEX_FILE.to_owned(), |t| format!("{t}.md")),
                r.machine_id,
                r.project_id
            ),
        },
        data: Some(json!({ "scope": scope, "projectRef": project, "topic": topic, "by": by })),
        attention: None,
    })?;
    Ok(())
}
