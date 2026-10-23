//! agents_list and agent_work. Both read-only.
use std::sync::Arc;

use fleetd_contracts::agents::{
    AGENTS_MAX, WORK_PAGE_MAX_BYTES, WorkAction, WorkMessage, WorkStep,
};
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::mcp::{
    AgentWorkInput, AgentWorkOutput, AgentsListInput, AgentsListOutput, ErrorCode, TailRole,
};
use fleetd_contracts::model::ActionItem;
use fleetd_contracts::prim::{List, NonEmpty, Text};

use crate::hub::api::{Caller, Hub, Registry, ToolError, clip, offline, require};
use crate::hub::executor::thread_view::TailRow;
use crate::hub::executor::tools::from_executor;
use crate::hub::redact::redact;
use crate::hub::store::{iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("agents_list", agents_list);
    tools.add("agent_work", agent_work);
}

async fn agents_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: AgentsListInput,
) -> Result<AgentsListOutput, ToolError> {
    if let Some(r) = &input.project_ref {
        require(&caller, Role::Read, Some(&r.machine_id))?;
    }
    let (agents, truncated) = super::rows(
        &hub,
        &caller,
        input.project_ref.as_ref(),
        input.ended_since.as_ref(),
        AGENTS_MAX,
    );
    Ok(AgentsListOutput {
        agents: List::unchecked(agents),
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        next: Some(
            "agent_work with a row's threadRef reads what it did; live { agent: laneId } streams its text."
                .into(),
        ),
        truncated: truncated.then_some(true),
    })
}

const CURSOR_SEP: char = '|';

/// The `(at, id)` a cursor names; `at` is an ISO stamp, which never holds the separator.
pub fn parse_cursor(cursor: &str) -> Option<(&str, &str)> {
    cursor
        .split_once(CURSOR_SEP)
        .filter(|(at, id)| !at.is_empty() && !id.is_empty())
}

pub fn cursor_of(step: &WorkStep) -> String {
    let at = match step {
        WorkStep::Message(m) => &m.at,
        WorkStep::Action(a) => &a.at,
    };
    format!("{}{CURSOR_SEP}{}", at.0, step.id())
}

fn redacted<const MAX: usize>(text: &str) -> Text<0, MAX> {
    Text::unchecked(clip(&redact(text), MAX))
}

/// One view row as a step, with secrets replaced.
pub fn step_of(id: String, row: TailRow) -> Option<WorkStep> {
    let id = NonEmpty::new(id).ok()?;
    Some(match row {
        TailRow::Message { at, role, text } => WorkStep::Message(WorkMessage {
            id,
            at: at.into(),
            role: match role.as_str() {
                "user" => TailRole::User,
                "system" => TailRole::System,
                _ => TailRole::Assistant,
            },
            text: redacted(&text),
        }),
        TailRow::Action { at, mut action } => {
            action.summary = clip(&redact(&action.summary), 200);
            action.output_tail = action.output_tail.map(|o| clip(&redact(&o), 1024));
            let item: ActionItem =
                serde_json::from_value(serde_json::to_value(&action).ok()?).ok()?;
            WorkStep::Action(WorkAction {
                id,
                at: at.into(),
                action: item,
            })
        }
    })
}

/// Steps newest first, cut to `max_bytes` of JSON; the page oldest first, and whether any were cut.
pub fn fit_page(newest_first: Vec<WorkStep>, max_bytes: usize) -> (Vec<WorkStep>, bool) {
    let mut used = 0;
    let mut page = Vec::new();
    let total = newest_first.len();
    for step in newest_first {
        let cost = serde_json::to_vec(&step).map_or(usize::MAX, |b| b.len() + 1);
        if !page.is_empty() && used + cost > max_bytes {
            break;
        }
        used += cost;
        page.push(step);
    }
    let cut = page.len() < total;
    page.reverse();
    (page, cut)
}

async fn agent_work(
    hub: Arc<Hub>,
    caller: Caller,
    input: AgentWorkInput,
) -> Result<AgentWorkOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    if !hub.executors.is_connected(&input.machine_id) {
        return Err(offline(&input.machine_id));
    }
    let before = match input.before.as_deref() {
        None => None,
        Some(c) => Some(parse_cursor(c).ok_or_else(|| {
            ToolError::new(ErrorCode::Invalid, "That cursor is not one agent_work gave.")
                .with_fix("Pass the `before` of an earlier agent_work answer, or leave it out for the newest steps.")
        })?),
    };
    let r = ThreadRef {
        machine_id: input.machine_id.clone(),
        thread_id: input.thread_id.clone(),
    };
    let limit = input.limit.get().max(1) as usize;
    let work = hub
        .executors
        .work(&r, before, limit)
        .await
        .map_err(from_executor)?;
    let steps: Vec<WorkStep> = work
        .rows
        .into_iter()
        .filter_map(|(id, row)| step_of(id, row))
        .collect();
    let (page, cut) = fit_page(steps, WORK_PAGE_MAX_BYTES);
    let more = work.more || cut;
    let before = page
        .first()
        .filter(|_| more)
        .and_then(|oldest| Text::new(cursor_of(oldest)).ok());
    Ok(AgentWorkOutput {
        steps: List::unchecked(page),
        before,
        running: work.running,
        next: None,
        truncated: None,
    })
}
