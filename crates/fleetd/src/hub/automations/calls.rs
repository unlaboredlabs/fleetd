//! The lead's automation tools: create, list, update, pause and resume, delete, run now and the runs, scoped to the
//! caller's project by its session. The lead never sees a webhook secret: a person adds a webhook in the app, which
//! shows its URL once. A task can make none of these (`tasks::policy`).
//!
//! `confirmed: true` marks an automation the person said yes to in the chat (`Automation.confirmed`), so a Navi's
//! approval checker takes its prompt as their word on its runs. The hub takes it only when the person's last message
//! answers the lead's last question; a changed prompt or schedule without it unsets the mark.
use std::sync::{Arc, Weak};

use fleetd_contracts::automations::{
    AutomationDeleteResult, AutomationListResult, AutomationResult, AutomationRunResult,
    AutomationRunsResult,
};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::List;

use super::{Automations, Edit, NewAutomation, Start, from_call, text_of};
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};

pub const OPS: [&str; 7] = [
    "automation_create",
    "automation_list",
    "automation_update",
    "automation_pause",
    "automation_delete",
    "automation_run",
    "automation_runs",
];

/// How many runs `automation_runs` lists without a runId.
const RUNS_LISTED: usize = 20;

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                let confirms = match &call {
                    LeadCall::AutomationCreate(c) => c.confirmed == Some(true),
                    LeadCall::AutomationUpdate(c) => c.confirmed == Some(true),
                    _ => false,
                };
                let yes =
                    confirms && crate::hub::navi::checker::answered(&hub, &caller.project_ref);
                answer(&hub.automations, &caller, call, yes).await
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

/// Why a lead's `confirmed: true` wasn't taken.
const NOT_CONFIRMED: &str = "Not marked as the person's go-ahead: confirmed counts only when their last message \
                             answers your question about this automation. Ask them, with its prompt and schedule, and \
                             pass confirmed: true to automation_update once they say yes.";

/// The lead's call; `yes`: the person's last message in the chat answers the lead's last question, so a
/// `confirmed: true` holds.
pub async fn answer(
    automations: &Automations,
    caller: &LeadCaller,
    call: LeadCall,
    yes: bool,
) -> Result<LeadCallResult, McpToolError> {
    let r = &caller.project_ref;
    let by = caller.by.as_str();
    // A schedule without a zone runs in the person's (D288).
    let person_zone = || {
        crate::hub::people::zone::of_chat(&automations.db, r)
            .name()
            .to_owned()
    };
    Ok(match call {
        LeadCall::AutomationCreate(c) => {
            let asked = c.confirmed == Some(true);
            let (automation, _) = automations.create(NewAutomation {
                project_ref: r.clone(),
                name: c.name,
                prompt: c.prompt,
                schedule: c.schedule.map(|s| from_call(s, person_zone)),
                webhook: false,
                by: by.to_owned(),
                confirmed: asked && yes,
                client_request_id: None,
            })?;
            let once = automation
                .schedule
                .as_ref()
                .and_then(|s| s.at.as_ref().zip(Some(&s.tz)));
            let next = match (&automation.next_run_at, once) {
                (Some(_), Some((at, tz))) => format!(
                    "It runs once, at {at} {tz}, and opens an order for you then; it shows in the person's \
                     automations list until it has run. automation_delete cancels it."
                ),
                (Some(at), None) => format!(
                    "Its first run is at {at}; each run opens an order for you. A webhook trigger is added by a \
                     person in the app (Settings > Automations), where its secret URL is shown once."
                ),
                (None, _) => "It runs when you call automation_run or a person presses Run now; a schedule or a \
                         webhook makes it run by itself."
                    .to_owned(),
            };
            let next = if asked && !yes {
                format!("{next} {NOT_CONFIRMED}")
            } else {
                next
            };
            LeadCallResult::AutomationCreate(AutomationResult {
                automation,
                next: Some(next),
            })
        }
        LeadCall::AutomationList(_) => {
            let list = automations.list(r)?;
            let next = list
                .is_empty()
                .then(|| "No automations yet; automation_create makes one.".to_owned());
            LeadCallResult::AutomationList(AutomationListResult {
                automations: List::unchecked(list),
                next,
            })
        }
        LeadCall::AutomationUpdate(c) => {
            automations.own(r, &c.automation_id)?;
            let schedule = match (c.schedule, c.remove_schedule) {
                (_, Some(true)) => Some(None),
                (Some(s), _) => Some(Some(from_call(s, person_zone))),
                (None, _) => None,
            };
            let asked = c.confirmed == Some(true);
            // What it runs, or when, changed: the person's yes covers only what they saw.
            let changed = c.prompt.is_some() || schedule.is_some();
            let confirmed = match (asked && yes, changed) {
                (true, _) => Some(true),
                (false, true) => Some(false),
                (false, false) => None,
            };
            let (automation, _) = automations.update(
                &c.automation_id,
                Edit {
                    name: c.name,
                    prompt: c.prompt,
                    schedule,
                    webhook: None,
                    confirmed,
                },
                by,
            )?;
            LeadCallResult::AutomationUpdate(AutomationResult {
                automation,
                next: (asked && !yes).then(|| NOT_CONFIRMED.to_owned()),
            })
        }
        LeadCall::AutomationPause(c) => {
            automations.own(r, &c.automation_id)?;
            let automation = automations.pause(&c.automation_id, c.paused, by)?;
            let next = if c.paused {
                "Paused: its schedule and webhook start nothing until you resume it."
            } else {
                "Resumed: its schedule goes on from now."
            };
            LeadCallResult::AutomationPause(AutomationResult {
                automation,
                next: Some(next.into()),
            })
        }
        LeadCall::AutomationDelete(c) => {
            automations.own(r, &c.automation_id)?;
            automations.delete(&c.automation_id, by)?;
            LeadCallResult::AutomationDelete(AutomationDeleteResult {
                automation_id: c.automation_id,
                next: Some("Deleted; orders its runs opened stay open.".into()),
            })
        }
        LeadCall::AutomationRun(c) => {
            automations.own(r, &c.automation_id)?;
            let run = automations
                .run(&c.automation_id, Start::Manual { by: by.to_owned() })
                .await?;
            let next = match (&run.workstream_id, &run.why) {
                (Some(w), _) => format!("It opened {w}; it reaches you as a new order."),
                (None, Some(why)) => format!("Not run: {why}."),
                (None, None) => String::new(),
            };
            LeadCallResult::AutomationRun(AutomationRunResult {
                run,
                next: Some(next),
            })
        }
        LeadCall::AutomationRuns(c) => {
            automations.own(r, &c.automation_id)?;
            let (runs, payload) = match &c.run_id {
                Some(run_id) => match automations.run_with_payload(&c.automation_id, run_id)? {
                    Some((run, payload)) => (vec![run], payload),
                    None => {
                        return Err(McpToolError::new(
                            ErrorCode::NotFound,
                            format!("{} has no run {run_id}.", c.automation_id),
                        )
                        .with_fix("automation_runs without runId lists its runs."));
                    }
                },
                None => (automations.runs(&c.automation_id, RUNS_LISTED)?, None),
            };
            LeadCallResult::AutomationRuns(AutomationRunsResult {
                runs: List::unchecked(runs),
                payload: payload.map(|p| text_of(&p)),
                next: None,
            })
        }
        other => {
            return Err(McpToolError::new(
                ErrorCode::Invalid,
                format!("{} is not an automation call.", op_of(&other)),
            ));
        }
    })
}
