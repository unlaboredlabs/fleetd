//! Navi's factory bridge: a Navi's lead writes to another project's lead (`project_message`), reads the factory in one
//! call (`factory_status`), and is woken when what it asked for changes. Only a Navi's lead makes these calls
//! ([`may_use`]); a task can't (`tasks::policy`).
//!
//! A message goes into the other project's chat as the agent "Navi <title>", never as the person, so its lead reads it
//! as input and never as the person's answer or approval (`chat.agent`). Each message is an ask `N<n>`. The lead that
//! opens an order for it passes `asked: "N<n>"` to `brief`; `workstream.created` says so, and from then on [`run`]
//! follows the order in the event log: its opening, its close or stop, and its PRs merging or failing in the train
//! each wake the asking Navi's lead with one line.
use std::sync::{Arc, Weak};

use fleetd_contracts::checklist::TodoState;
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::{ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{WorkstreamId, WorkstreamState};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::navi::{
    AskHandle, FactoryAsk, FactoryOrder, FactoryProject, FactoryStatusCall, FactoryStatusResult,
    ProjectMessageCall, ProjectMessageResult, ask_footer,
};
use fleetd_contracts::status::ChangeStateData;
use fleetd_contracts::train::ChangeState;
use rusqlite::{OptionalExtension, params};

use crate::hub::api::Hub;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::status::rows::clip;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};

#[cfg(test)]
#[path = "bridge_tests.rs"]
mod tests;

pub const OPS: [&str; 2] = ["project_message", "factory_status"];
/// The event log cursor [`run`] keeps in `time_cursors`.
const CURSOR: &str = "navi.bridge";
/// The project kind a Navi has (`ProjectSummary.kind`).
pub const ASSISTANT: &str = "assistant";
/// Asks per project `factory_status` lists, newest first.
const ASKS_SHOWN: usize = 5;
const TYPES: [HubEventType; 4] = [
    HubEventType::WorkstreamCreated,
    HubEventType::WorkstreamDone,
    HubEventType::WorkstreamState,
    HubEventType::ChangeState,
];

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call).await
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "navi bridge store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
}

async fn answer(
    hub: &Arc<Hub>,
    caller: &LeadCaller,
    call: LeadCall,
) -> Result<LeadCallResult, McpToolError> {
    may_use(&hub.db, &caller.project_ref)?;
    match call {
        LeadCall::ProjectMessage(call) => Ok(LeadCallResult::ProjectMessage(
            project_message(hub, &caller.project_ref, call).await?,
        )),
        LeadCall::FactoryStatus(call) => Ok(LeadCallResult::FactoryStatus(factory_status(
            hub,
            &caller.project_ref,
            &call,
        )?)),
        other => Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a factory bridge call.", op_of(&other)),
        )),
    }
}

/// Only a Navi, a project of kind `assistant`, works with other projects: a coding project's lead keeps to its own.
pub fn may_use(db: &HubDb, r: &ProjectRef) -> Result<(), McpToolError> {
    let kind: Option<String> = db
        .with(|c| {
            Ok(c.query_row(
                "SELECT json_extract(data, '$.kind') FROM projects WHERE machine_id = ? AND project_id = ?",
                params![r.machine_id.as_str(), r.project_id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
        })
        .map_err(failed)?;
    if kind.as_deref() == Some(ASSISTANT) {
        return Ok(());
    }
    Err(McpToolError::new(
        ErrorCode::Forbidden,
        "Only a Navi works with other projects: this project's lead keeps to its own.",
    )
    .with_fix("Ask the person to give it to their Navi, or to the other project's chat."))
}

/// The project `name` names, by project id or title, other than the caller's own. One person owns every project on a
/// hub today, so any other project is the caller's to message; company Navi brings owners.
fn target(hub: &Hub, from: &ProjectRef, name: &str) -> Result<ProjectSummary, McpToolError> {
    let all = hub.store.projects_list(None, None).map_err(failed)?;
    let by_id: Vec<_> = all
        .iter()
        .filter(|p| p.project_id.as_str() == name)
        .collect();
    let found: Vec<_> = if by_id.is_empty() {
        all.iter()
            .filter(|p| p.title.trim().eq_ignore_ascii_case(name.trim()))
            .collect()
    } else {
        by_id
    };
    let p = match found.as_slice() {
        [p] => (*p).clone(),
        [] => {
            return Err(McpToolError::new(
                ErrorCode::NotFound,
                format!("No project {name} on this hub."),
            )
            .with_fix("Call factory_status to see the projects, and name one by its title."));
        }
        _ => {
            return Err(McpToolError::new(
                ErrorCode::Invalid,
                format!("{} projects are called {name}.", found.len()),
            )
            .with_fix("Name it by its project id, from factory_status."));
        }
    };
    if p.machine_id == from.machine_id && p.project_id == from.project_id {
        return Err(
            McpToolError::new(ErrorCode::Invalid, "That is this Navi's own project.").with_fix(
                "project_message writes to another project's lead; say it in your own reply.",
            ),
        );
    }
    Ok(p)
}

fn project_ref(p: &ProjectSummary) -> ProjectRef {
    ProjectRef {
        machine_id: p.machine_id.clone(),
        project_id: p.project_id.clone(),
    }
}

/// The agent name a Navi writes under: its title, with "Navi" in front unless the title says it already.
pub fn author(hub: &Hub, r: &ProjectRef) -> String {
    let title = hub
        .store
        .project_get(r)
        .ok()
        .flatten()
        .map_or_else(|| r.project_id.to_string(), |p| p.title);
    if title.to_lowercase().contains("navi") {
        title
    } else {
        format!("Navi {title}")
    }
}

async fn project_message(
    hub: &Arc<Hub>,
    from: &ProjectRef,
    call: ProjectMessageCall,
) -> Result<ProjectMessageResult, McpToolError> {
    let to = target(hub, from, call.project.as_str())?;
    let to_ref = project_ref(&to);
    let text = call.text.to_string();
    let now = now_ms(hub.clock.as_ref());
    let n: i64 = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "INSERT INTO navi_asks (from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms)
                 VALUES (?, ?, ?, ?, ?, ?) RETURNING n",
                params![
                    from.machine_id.as_str(),
                    from.project_id.as_str(),
                    to_ref.machine_id.as_str(),
                    to_ref.project_id.as_str(),
                    text,
                    now
                ],
                |row| row.get(0),
            )?)
        })
        .map_err(failed)?;
    let handle = AskHandle::unchecked(format!("N{n}"));
    let by = author(hub, from);
    let body = format!("{text}\n\n{}", ask_footer(&handle));
    let (_, lead_waiting) =
        crate::hub::chat::flow::send_as_agent(hub, &to_ref, &by, body, format!("navi:{handle}"))
            .await?;
    Ok(ProjectMessageResult {
        next: Some(format!(
            "In {}'s chat as {by}. Its lead reads it as input, never as the person's approval: anything it needs \
             the person for, it asks in its own chat. A wake tells you when an order opened for {handle} opens, \
             closes, merges or fails; end your turn instead of waiting.",
            to.title
        )),
        handle,
        project_ref: to_ref,
        title: to.title,
        lead_waiting,
    })
}

fn factory_status(
    hub: &Hub,
    from: &ProjectRef,
    call: &FactoryStatusCall,
) -> Result<FactoryStatusResult, McpToolError> {
    let only = match &call.project {
        Some(name) => Some(project_ref(&target(hub, from, name.as_str())?)),
        None => None,
    };
    let now = now_ms(hub.clock.as_ref());
    let rows = crate::hub::status::rows::read(hub, &hub.status.fresh, now).map_err(|e| {
        tracing::error!(error = %e, "navi bridge: status rows");
        McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
    })?;
    let asks = asks_from(&hub.db, from).map_err(failed)?;
    let mut projects = Vec::new();
    for row in rows {
        let r = &row.project_ref;
        if r == from || only.as_ref().is_some_and(|o| o != r) {
            continue;
        }
        let orders = hub
            .leads
            .records
            .workstreams_list(&WorkstreamFilter {
                project_ref: Some(r.clone()),
                state: Some(WorkstreamState::Open),
                limit: 20,
            })
            .map_err(failed)?;
        let checklist = crate::hub::checklist::read(&hub.db, r).map_err(failed)?;
        let to_it: Vec<&Ask> = asks.iter().filter(|a| a.to == *r).collect();
        let asked_for = |w: &WorkstreamId| {
            to_it
                .iter()
                .find(|a| a.orders.contains(w))
                .map(|a| a.handle.clone())
        };
        projects.push(FactoryProject {
            project_ref: r.clone(),
            title: row.title.to_string(),
            state: row.state,
            blocked_reason: row.blocked_reason.map(|b| b.to_string()),
            warning: row.warning.map(|w| w.to_string()),
            agents_running: row.agents_running,
            open_orders: orders
                .into_iter()
                .map(|w| FactoryOrder {
                    asked: asked_for(&w.workstream_id),
                    title: w.title.to_string(),
                    headline: w.headline.map(|h| h.to_string()).filter(|h| !h.is_empty()),
                    workstream_id: w.workstream_id,
                })
                .collect(),
            checklist: checklist
                .items
                .into_iter()
                .filter(|i| i.state != TodoState::Done)
                .collect(),
            last_merged: row.last_merged,
            merged_7d: row.merged_7d,
            asks: to_it
                .iter()
                .take(ASKS_SHOWN)
                .map(|a| FactoryAsk {
                    handle: a.handle.clone(),
                    text: clip(a.text.lines().next().unwrap_or(""), 120),
                    at: Timestamp(iso_ms(a.at_ms)),
                    orders: a.orders.clone(),
                })
                .collect(),
        });
    }
    let next = match (&only, projects.is_empty()) {
        (_, true) => "No other project on this hub yet.",
        (Some(_), false) => {
            "Write to its lead with project_message; what it needs the person for is in its own chat."
        }
        (None, false) => {
            "factory_status with project reads one. Write to a project's lead with project_message."
        }
    };
    Ok(FactoryStatusResult {
        projects,
        next: Some(next.into()),
    })
}

/// One ask, as the bridge keeps it.
struct Ask {
    handle: AskHandle,
    from: ProjectRef,
    to: ProjectRef,
    text: String,
    at_ms: i64,
    orders: Vec<WorkstreamId>,
}

fn pref(machine: String, project: String) -> ProjectRef {
    ProjectRef {
        machine_id: fleetd_contracts::ids::MachineId::unchecked(machine),
        project_id: ProjectId::unchecked(project),
    }
}

const ASK_COLUMNS: &str =
    "n, from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms";

fn ask_row(c: &rusqlite::Connection, row: &rusqlite::Row<'_>) -> rusqlite::Result<Ask> {
    let n: i64 = row.get(0)?;
    let mut stmt =
        c.prepare_cached("SELECT workstream_id FROM navi_ask_orders WHERE n = ? ORDER BY rowid")?;
    let orders = stmt
        .query_map([n], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(WorkstreamId::unchecked)
        .collect();
    Ok(Ask {
        handle: AskHandle::unchecked(format!("N{n}")),
        from: pref(row.get(1)?, row.get(2)?),
        to: pref(row.get(3)?, row.get(4)?),
        text: row.get(5)?,
        at_ms: row.get(6)?,
        orders,
    })
}

/// A Navi's asks, newest first.
fn asks_from(db: &HubDb, from: &ProjectRef) -> Result<Vec<Ask>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare_cached(&format!(
            "SELECT {ASK_COLUMNS} FROM navi_asks WHERE from_machine_id = ? AND from_project_id = ?
             ORDER BY n DESC LIMIT 200"
        ))?;
        let rows = stmt.query_map(
            params![from.machine_id.as_str(), from.project_id.as_str()],
            |row| ask_row(c, row),
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

fn ask(db: &HubDb, handle: &str) -> Result<Option<Ask>, StoreError> {
    let Some(n) = handle.strip_prefix('N').and_then(|n| n.parse::<i64>().ok()) else {
        return Ok(None);
    };
    db.with(|c| {
        Ok(c.query_row(
            &format!("SELECT {ASK_COLUMNS} FROM navi_asks WHERE n = ?"),
            [n],
            |row| ask_row(c, row),
        )
        .optional()?)
    })
}

/// The ask an order was opened for.
fn ask_of(db: &HubDb, w: &WorkstreamId) -> Result<Option<Ask>, StoreError> {
    let n: Option<i64> = db.with(|c| {
        Ok(c.query_row(
            "SELECT n FROM navi_ask_orders WHERE workstream_id = ?",
            [w.as_str()],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    match n {
        Some(n) => ask(db, &format!("N{n}")),
        None => Ok(None),
    }
}

/// Follows the event log for what Navis asked for, from where it left off. Runs until shutdown.
pub async fn run(hub: Arc<Hub>) {
    let mut head = hub.events.subscribe();
    // A first start begins at the head: nothing was asked before the bridge existed.
    let mut cursor = hub
        .db
        .with(|c| crate::hub::time::store::cursor(c, CURSOR))
        .ok()
        .flatten()
        .unwrap_or_else(|| hub.events.head());
    loop {
        head.borrow_and_update();
        match step(&hub, cursor) {
            Ok((next, more, _)) => {
                cursor = next;
                if more {
                    continue;
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "navi bridge: events not followed");
                tokio::select! {
                    () = hub.shutdown.wait() => return,
                    () = hub.clock.sleep(std::time::Duration::from_secs(5)) => {}
                }
                continue;
            }
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}

/// A wake the bridge sent: the asking Navi's project, and its line.
pub type Woken = (ProjectRef, String);

/// Follows one page after `cursor`: (the cursor to resume from, whether more pages are ready, the wakes it sent).
pub fn step(hub: &Hub, cursor: i64) -> Result<(i64, bool, Vec<Woken>), StoreError> {
    let page = hub.events.page(cursor, Some(&TYPES), None)?;
    let mut sent = Vec::new();
    for e in &page.events {
        if let Some((asker, line)) = wake_line(hub, e)? {
            hub.leads.wakes.trigger(
                &asker,
                Trigger::Line {
                    kind: LineKind::Factory,
                    text: line.clone(),
                },
            );
            sent.push((asker, line));
        }
    }
    if page.cursor != cursor {
        hub.db
            .with(|c| crate::hub::time::store::set_cursor(c, CURSOR, page.cursor))?;
    }
    Ok((page.cursor, page.more, sent))
}

/// The asking Navi and its wake line, for an event about an order one asked for.
fn wake_line(hub: &Hub, e: &HubEvent) -> Result<Option<(ProjectRef, String)>, StoreError> {
    let data = e.data.clone().unwrap_or_default();
    let Some(w) = data["workstreamId"]
        .as_str()
        .map(|w| WorkstreamId::unchecked(w.to_owned()))
    else {
        return Ok(None);
    };
    let title = || {
        hub.leads
            .records
            .workstream_get(&w)
            .ok()
            .flatten()
            .map(|w| format!(" \"{}\"", clip(w.title.as_str(), 80)))
            .unwrap_or_default()
    };
    let reason = || {
        data["reason"]
            .as_str()
            .map(|r| format!(": {}", clip(r, 160)))
            .unwrap_or_default()
    };
    if e.r#type == HubEventType::WorkstreamCreated {
        let Some(handle) = data["asked"].as_str() else {
            return Ok(None);
        };
        // Only the project asked can open an order for the ask.
        let Some(asked) = ask(&hub.db, handle)?.filter(|a| {
            Some(&a.to.machine_id) == e.machine_id.as_ref()
                && Some(&a.to.project_id) == e.project_id.as_ref()
        }) else {
            return Ok(None);
        };
        hub.db.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO navi_ask_orders (workstream_id, n) VALUES (?, ?)",
                params![w.as_str(), &asked.handle.as_str()[1..]],
            )?;
            Ok(())
        })?;
        let line = format!(
            "- {} to {}: its lead opened order {w}{}",
            asked.handle,
            project_title(hub, &asked.to),
            title()
        );
        return Ok(Some((asked.from, line)));
    }
    let Some(asked) = ask_of(&hub.db, &w)? else {
        return Ok(None);
    };
    let what = match e.r#type {
        HubEventType::WorkstreamDone => format!("order {w}{} is done{}", title(), reason()),
        HubEventType::WorkstreamState if data["state"] == "stopped" => {
            format!("order {w}{} was stopped{}", title(), reason())
        }
        HubEventType::ChangeState => {
            let Ok(change) = serde_json::from_value::<ChangeStateData>(data.clone()) else {
                return Ok(None);
            };
            let pr = format!("PR #{} ({})", change.pr_number.get(), change.repo);
            let how = match change.to {
                ChangeState::Merged => "merged",
                ChangeState::CiFailed => "failed CI",
                ChangeState::Refused => "was refused by the train",
                ChangeState::Abandoned => "was given up by the train",
                _ => return Ok(None),
            };
            format!("{pr} of order {w}{} {how}", title())
        }
        _ => return Ok(None),
    };
    let line = format!(
        "- {} to {}: {what}",
        asked.handle,
        project_title(hub, &asked.to)
    );
    Ok(Some((asked.from, line)))
}

fn project_title(hub: &Hub, r: &ProjectRef) -> String {
    hub.store
        .project_get(r)
        .ok()
        .flatten()
        .map_or_else(|| r.project_id.to_string(), |p| p.title)
}
