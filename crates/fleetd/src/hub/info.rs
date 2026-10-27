//! `hub_info`: the hub's own fleetd build, and everything a restart of the hub (or of one machine's node) would cut
//! off now. An update restarts at once anyway (`hub_update`, `fleetd update`): what it cuts off carries on by itself.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{LeadState, RequestKind, RequestState};
use fleetd_contracts::mcp::{HubBusyItem, HubBusyKind, HubChannel, HubInfoInput, HubInfoOutput};
use fleetd_contracts::prim::{List, Text};
use fleetd_contracts::tasks::TaskState;
use fleetd_contracts::train::{Change, ChangeState};

use fleetd_contracts::auth::Role;

use crate::hub::api::{Caller, Hub, Registry, ToolError, allows_everywhere, is_human, readable};
use crate::hub::approvals::store::RequestFilter;
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::tasks::TaskFilter;

/// `HubInfoOutput.busy`'s cap.
const BUSY_MAX: usize = 50;

pub fn register(tools: &mut Registry) {
    tools.add("hub_info", hub_info);
}

/// Nightly when the version says so, stable for any other release build, none for a local build.
pub fn channel(version: &str, release_build: bool) -> Option<HubChannel> {
    match (version.contains("-nightly."), release_build) {
        (true, _) => Some(HubChannel::Nightly),
        (false, true) => Some(HubChannel::Stable),
        (false, false) => None,
    }
}

async fn hub_info(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubInfoInput,
) -> Result<HubInfoOutput, ToolError> {
    let version = crate::version();
    let mut busy = busy(&hub)?;
    // A node restart cuts off only its own machine; the hub's own work (a merge in flight) goes on.
    busy.retain(|i| {
        i.machine_id.as_ref().is_none_or(|m| readable(&caller, m))
            && input
                .machine_id
                .as_ref()
                .is_none_or(|only| i.machine_id.as_ref() == Some(only))
    });
    let truncated = (busy.len() > BUSY_MAX).then_some(true);
    busy.truncate(BUSY_MAX);
    let next = if busy.is_empty() {
        "Nothing runs: restarting the hub now interrupts nothing."
    } else {
        "Restarting now cuts each busy item off; it carries on by itself once the hub or node is back."
    };
    let people = crate::hub::people::People::new(hub.db.clone(), hub.clock.clone());
    let me = match caller.person.as_ref().filter(|_| is_human(&caller)) {
        Some(person) => people.get(&person.person_id)?,
        None => None,
    };
    let count = fleetd_contracts::prim::Count::unchecked(people.count()? as i64);
    Ok(HubInfoOutput {
        version: version.to_owned(),
        protocol: fleetd_contracts::hello::ProtocolVersion::CURRENT,
        channel: channel(version, option_env!("FLEETD_VERSION").is_some()),
        started_at: None,
        busy: List::new(busy)
            .map_err(|e| ToolError::new(fleetd_contracts::mcp::ErrorCode::Failed, e))?,
        admin: Some(allows_everywhere(&caller, Role::Admin)),
        me,
        people: Some(count),
        machine_fingerprint: crate::fingerprint::machine(),
        next: Some(next.to_owned()),
        truncated,
    })
}

/// Everything in flight, every machine: lead turns, running agents, merges at the head of their repo's queue,
/// approved commands still running, and clones. A read that fails fails the call, so a hub that can't tell never
/// reads as idle.
pub fn busy(hub: &Hub) -> Result<Vec<HubBusyItem>, ToolError> {
    let title = |r: &ProjectRef| -> String {
        hub.store
            .project_get(r)
            .ok()
            .flatten()
            .map_or_else(|| r.project_id.to_string(), |p| p.title)
    };
    let mut out = Vec::new();
    for stored in hub.leads.records.leads_list()? {
        let r = stored.project_ref;
        if hub
            .leads
            .leads
            .get(&r)?
            .is_some_and(|l| l.state == LeadState::Working)
        {
            out.push(item(
                HubBusyKind::Lead,
                format!("the {} lead is working", title(&r)),
                &r,
                None,
            ));
        }
    }
    let running = hub.tasks.list(&TaskFilter {
        project_ref: None,
        state: Some(TaskState::Running),
        workstream_id: None,
        limit: BUSY_MAX * 4,
    })?;
    for task in running {
        out.push(item(
            HubBusyKind::Agent,
            format!(
                "{} in {}: {}",
                task.task_id,
                title(&task.project_ref),
                task.title
            ),
            &task.project_ref,
            task.started_at.clone(),
        ));
    }
    for (repo, r) in hub.train.repos() {
        let head = hub
            .train
            .state(&repo)
            .head
            .and_then(|id| hub.train.get(&id));
        if let Some(text) = head.as_ref().and_then(hub_step) {
            out.push(item(
                HubBusyKind::Train,
                text,
                &r,
                head.map(|c| c.updated_at),
            ));
        }
    }
    let approved = hub
        .approvals
        .list(&RequestFilter {
            states: Some(vec![RequestState::Approved]),
            kind: Some(RequestKind::Approval),
            limit: BUSY_MAX as i64,
            ..Default::default()
        })
        .map_err(|e| ToolError::new(fleetd_contracts::mcp::ErrorCode::Failed, e.message))?;
    for request in approved {
        let Some(gated) = &request.gated else {
            continue;
        };
        let argv: Vec<String> = gated.argv.iter().cloned().collect();
        out.push(item(
            HubBusyKind::Approval,
            format!(
                "running `{}` in {}, as approved",
                crate::hub::approvals::shown_argv(&argv),
                title(&request.project_ref)
            ),
            &request.project_ref,
            request.answered_at.clone(),
        ));
    }
    for (machine_id, clone) in crate::hub::projects::open_clones(&hub.events)? {
        let what = clone
            .repo
            .as_ref()
            .map_or_else(|| clone.path.clone(), ToString::to_string);
        let on = machine_id
            .as_ref()
            .map(|m| format!(" on {m}"))
            .unwrap_or_default();
        out.push(HubBusyItem {
            kind: HubBusyKind::Clone,
            text: text(format!("cloning {what}{on}")),
            machine_id,
            project_ref: None,
            since: None,
        });
    }
    Ok(out)
}

/// What the hub itself is doing to the change at the head of its repo's queue, when a restart would cut it off: a
/// rebase and push, or the merge. Waiting on CI is not: CI runs on GitHub and the hub picks it up again after a restart.
pub fn hub_step(change: &Change) -> Option<String> {
    match change.state {
        ChangeState::Rebasing => Some(format!(
            "updating PR #{} in {} before it merges",
            change.pr_number, change.repo
        )),
        ChangeState::Merging => Some(format!(
            "merging PR #{} into {}",
            change.pr_number, change.repo
        )),
        _ => None,
    }
}

fn item(
    kind: HubBusyKind,
    text_: String,
    r: &ProjectRef,
    since: Option<fleetd_contracts::ids::Timestamp>,
) -> HubBusyItem {
    HubBusyItem {
        kind,
        text: text(text_),
        machine_id: Some(MachineId::clone(&r.machine_id)),
        project_ref: Some(r.clone()),
        since,
    }
}

fn text(s: String) -> Text<1, 280> {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    Text::new(js_take(&flat, 280)).unwrap_or_else(|_| Text::unchecked("something is running"))
}

#[cfg(test)]
mod tests;
