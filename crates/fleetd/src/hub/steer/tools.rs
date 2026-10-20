//! steer_send, steer_withdraw and steers_list.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    SteerSendInput, SteerSendOutput, SteerWithdrawInput, SteerWithdrawOutput, SteersListInput,
    SteersListOutput,
};
use fleetd_contracts::prim::List;
use fleetd_contracts::steer::{SteerStage, SteerTarget};

use super::{By, SteerRequest};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows};
use crate::hub::intake::attachments;
use crate::hub::orders::notes::{render_refs, require_human};

pub fn register(tools: &mut Registry) {
    tools.add("steer_send", steer_send);
    tools.add("steer_withdraw", steer_withdraw);
    tools.add("steers_list", steers_list);
}

fn next(stage: SteerStage) -> Option<String> {
    Some(match stage {
        SteerStage::Queued => {
            "Watch for steer.delivered, then steer.acknowledged or steer.unacknowledged, with events_wait.".into()
        }
        _ => return None,
    })
}

async fn steer_send(
    hub: Arc<Hub>,
    caller: Caller,
    input: SteerSendInput,
) -> Result<SteerSendOutput, ToolError> {
    require_human(&caller, "steer_send")?;
    let refs = render_refs(
        &hub,
        &caller,
        input.refs.as_ref().map_or(&[][..], |r| r.as_slice()),
    )?;
    let ids: Vec<_> = input.attachments.iter().flatten().cloned().collect();
    let attached = if ids.is_empty() {
        Vec::new()
    } else {
        let workstream_id = match &input.target {
            SteerTarget::Lead { workstream_id } => workstream_id.clone(),
            SteerTarget::Task { task_id } => hub
                .tasks
                .get(task_id)?
                .map(|t| t.workstream_id)
                .ok_or_else(|| {
                    ToolError::new(
                        fleetd_contracts::mcp::ErrorCode::NotFound,
                        format!("No task {task_id}."),
                    )
                })?,
        };
        let w = hub
            .leads
            .records
            .workstream_get(&workstream_id)?
            .ok_or_else(|| crate::hub::orders::tools::unknown_order(workstream_id.as_str()))?
            .workstream;
        attachments::deliver(
            &hub,
            &caller,
            &ids,
            &w.project_ref,
            workstream_id.as_str(),
            Some(&workstream_id),
        )
        .await?
    };
    let steer = super::send(
        &hub,
        By::Human(&caller),
        SteerRequest {
            target: input.target,
            text: &input.text,
            mode: input.mode,
            refs,
            attached,
            client_request_id: &input.client_request_id,
        },
    )
    .await?;
    Ok(SteerSendOutput {
        next: next(steer.stage),
        steer,
        truncated: None,
    })
}

async fn steer_withdraw(
    hub: Arc<Hub>,
    caller: Caller,
    input: SteerWithdrawInput,
) -> Result<SteerWithdrawOutput, ToolError> {
    require_human(&caller, "steer_withdraw")?;
    let steer = super::withdraw(&hub, &caller, &input.steer_id).await?;
    Ok(SteerWithdrawOutput {
        steer,
        next: None,
        truncated: None,
    })
}

async fn steers_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: SteersListInput,
) -> Result<SteersListOutput, ToolError> {
    let limit = input.limit.get() as usize;
    let steers: Vec<_> = super::store::list(
        &hub.db,
        input.workstream_id.as_ref().map(|w| w.as_str()),
        input.task_id.as_ref().map(|t| t.as_str()),
        input.after_n.map_or(0, |n| n.get()),
        limit,
    )?
    .into_iter()
    .filter(|s| allows(&caller, Role::Read, Some(&s.thread.machine_id)))
    .collect();
    let truncated = (steers.len() == limit).then_some(true);
    Ok(SteersListOutput {
        steers: List::unchecked(steers),
        next: None,
        truncated,
    })
}
