//! automation_list, automation_create, automation_update, automation_pause, automation_rotate, automation_delete,
//! automation_run and automation_runs: Settings > Automations, and any MCP client with the grant. Reads need read on
//! the project's machine, writes operate there. automation_list also gives the nightly memory refresh's row
//! (hub/memory/refresh), whose switch is project_settings_set's memoryRefresh and whose Run now is memory_refresh_run.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::automations::{Automation, RUNS_KEPT};
use fleetd_contracts::mcp::*;
use fleetd_contracts::prim::{List, True};

use super::{Edit, NewAutomation, Start, webhook_url};
use crate::hub::api::{Caller, Hub, Registry, ToolError, is_human, require};

pub fn register(tools: &mut Registry) {
    tools.add("automation_list", automation_list);
    tools.add("automation_create", automation_create);
    tools.add("automation_update", automation_update);
    tools.add("automation_pause", automation_pause);
    tools.add("automation_rotate", automation_rotate);
    tools.add("automation_delete", automation_delete);
    tools.add("automation_run", automation_run);
    tools.add("automation_runs", automation_runs);
}

/// Who a call is by, as the automation and its runs record it.
fn by(caller: &Caller) -> String {
    if is_human(caller) {
        "human".into()
    } else {
        caller.key_id.to_string()
    }
}

/// The automation, once the caller holds `role` on its machine. An automation on a machine the key can't read is
/// as unknown as one that doesn't exist.
fn granted(hub: &Hub, caller: &Caller, id: &str, role: Role) -> Result<Automation, ToolError> {
    let unknown = || {
        ToolError::new(ErrorCode::NotFound, format!("There is no automation {id}."))
            .with_fix("automation_list with the project's projectRef shows its automations.")
    };
    let a = hub.automations.get(id)?.ok_or_else(unknown)?;
    require(caller, Role::Read, Some(&a.project_ref.machine_id)).map_err(|_| unknown())?;
    require(caller, role, Some(&a.project_ref.machine_id))?;
    Ok(a)
}

fn url(hub: &Hub, a: &Automation, secret: Option<String>) -> Option<String> {
    secret.map(|s| webhook_url(&hub.config.url(), &a.automation_id, &s))
}

const URL_ONCE: &str = "The webhook URL holds its secret and is shown only now: copy it. automation_rotate makes a new one.";

async fn automation_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationListInput,
) -> Result<AutomationListOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.project_ref.machine_id))?;
    let automations = hub.automations.list(&input.project_ref)?;
    let next = automations
        .is_empty()
        .then(|| "No automations yet; automation_create makes one.".to_owned());
    // A project the hub doesn't know has no refresh to list.
    let memory_refresh = match hub.store.project_get(&input.project_ref)? {
        Some(_) => Some(crate::hub::memory::refresh::job(&hub, &input.project_ref)?),
        None => None,
    };
    Ok(AutomationListOutput {
        automations: List::unchecked(automations),
        memory_refresh,
        next,
        truncated: None,
    })
}

async fn automation_create(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationCreateInput,
) -> Result<AutomationCreateOutput, ToolError> {
    require(&caller, Role::Operate, Some(&input.project_ref.machine_id))?;
    let (automation, secret) = hub.automations.create(NewAutomation {
        project_ref: input.project_ref,
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        webhook: input.webhook,
        by: by(&caller),
        client_request_id: Some(input.client_request_id.into_inner()),
    })?;
    let webhook_url = url(&hub, &automation, secret);
    let next = match (&webhook_url, automation.webhook) {
        (Some(_), _) => URL_ONCE.to_owned(),
        (None, true) => {
            "Already made by this request; automation_rotate shows a new webhook URL.".into()
        }
        (None, false) => {
            "Its runs open orders for the project's lead; automation_run runs it now.".into()
        }
    };
    Ok(AutomationCreateOutput {
        automation,
        webhook_url,
        next: Some(next),
        truncated: None,
    })
}

async fn automation_update(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationUpdateInput,
) -> Result<AutomationUpdateOutput, ToolError> {
    let a = granted(&hub, &caller, &input.automation_id, Role::Operate)?;
    let schedule = match (input.schedule, input.remove_schedule) {
        (_, Some(true)) => Some(None),
        (Some(s), _) => Some(Some(s)),
        (None, _) => None,
    };
    let (automation, secret) = hub.automations.update(
        a.automation_id.as_str(),
        Edit {
            name: input.name,
            prompt: input.prompt,
            schedule,
            webhook: input.webhook,
        },
        &by(&caller),
    )?;
    let webhook_url = url(&hub, &automation, secret);
    Ok(AutomationUpdateOutput {
        next: webhook_url.as_ref().map(|_| URL_ONCE.to_owned()),
        automation,
        webhook_url,
        truncated: None,
    })
}

async fn automation_pause(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationPauseInput,
) -> Result<AutomationPauseOutput, ToolError> {
    let a = granted(&hub, &caller, &input.automation_id, Role::Operate)?;
    let automation = hub
        .automations
        .pause(a.automation_id.as_str(), input.paused, &by(&caller))?;
    let next = if input.paused {
        "Paused: its schedule and webhook start nothing; Run now still runs it."
    } else {
        "Resumed: its schedule goes on from now."
    };
    Ok(AutomationPauseOutput {
        automation,
        next: Some(next.into()),
        truncated: None,
    })
}

async fn automation_rotate(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationRotateInput,
) -> Result<AutomationRotateOutput, ToolError> {
    let a = granted(&hub, &caller, &input.automation_id, Role::Operate)?;
    let (automation, secret) = hub
        .automations
        .rotate(a.automation_id.as_str(), &by(&caller))?;
    Ok(AutomationRotateOutput {
        webhook_url: webhook_url(&hub.config.url(), &automation.automation_id, &secret),
        automation,
        next: Some(format!("{URL_ONCE} The old URL no longer works.")),
        truncated: None,
    })
}

async fn automation_delete(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationDeleteInput,
) -> Result<AutomationDeleteOutput, ToolError> {
    let a = granted(&hub, &caller, &input.automation_id, Role::Operate)?;
    hub.automations
        .delete(a.automation_id.as_str(), &by(&caller))?;
    Ok(AutomationDeleteOutput {
        ok: True,
        next: Some("Deleted with its run history; orders its runs opened stay.".into()),
        truncated: None,
    })
}

async fn automation_run(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationRunInput,
) -> Result<AutomationRunOutput, ToolError> {
    let a = granted(&hub, &caller, &input.automation_id, Role::Operate)?;
    let run = hub
        .automations
        .run(a.automation_id.as_str(), Start::Manual { by: by(&caller) })
        .await?;
    let next = match &run.workstream_id {
        Some(w) => format!("It opened {w} for the lead; watch it with order_get."),
        None => run
            .why
            .as_ref()
            .map_or_else(String::new, |w| format!("Not run: {w}.")),
    };
    Ok(AutomationRunOutput {
        run,
        next: Some(next),
        truncated: None,
    })
}

async fn automation_runs(
    hub: Arc<Hub>,
    caller: Caller,
    input: AutomationRunsInput,
) -> Result<AutomationRunsOutput, ToolError> {
    let a = granted(&hub, &caller, &input.automation_id, Role::Read)?;
    let limit = (input.limit.get() as usize).min(RUNS_KEPT);
    let runs = hub.automations.runs(a.automation_id.as_str(), limit)?;
    Ok(AutomationRunsOutput {
        runs: List::unchecked(runs),
        next: None,
        truncated: None,
    })
}
