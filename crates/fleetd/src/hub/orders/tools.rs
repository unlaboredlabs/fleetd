//! orders_board, order_get, order_note and order_stop.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    AttachmentPutInput, AttachmentPutOutput, ErrorCode, IntakePreviewInput, IntakePreviewOutput,
    OrderGetInput, OrderGetOutput, OrderNoteInput, OrderNoteOutput, OrderStopInput,
    OrderStopOutput, OrdersBoardInput, OrdersBoardOutput, ProjectFilesInput, ProjectFilesOutput,
};
use fleetd_contracts::prim::{List, Text};

use crate::hub::executor::tools::from_executor;

use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, require};
use crate::hub::store::{iso_ms, now_ms};

const ORDER_ASKS: usize = 20;
const ORDER_CLAIMS: usize = 20;
/// The hub trims lanes, then PRs, so a board answer stays under this.
const BOARD_MAX_BYTES: usize = 64 * 1024;

pub fn register(tools: &mut Registry) {
    tools.add("orders_board", orders_board);
    tools.add("order_get", order_get);
    tools.add("order_note", order_note);
    tools.add("order_stop", order_stop);
    tools.add("intake_preview", intake_preview);
    tools.add("attachment_put", attachment_put);
    tools.add("attachment_get", attachment_get);
    tools.add("project_files", project_files);
}

pub fn unknown_order(id: &str) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No order {id}."))
        .with_fix("Call orders_board to see open orders.")
}

async fn orders_board(
    hub: Arc<Hub>,
    caller: Caller,
    input: OrdersBoardInput,
) -> Result<OrdersBoardOutput, ToolError> {
    if let Some(r) = &input.project_ref {
        require(&caller, Role::Read, Some(&r.machine_id))?;
    }
    let orders = super::orders_in_scope(
        &hub,
        &caller,
        input.project_ref.as_ref(),
        input.include_done_since.as_ref(),
    );
    let (mut cards, trains, mut truncated) = super::board(&hub, &orders);
    // Bounded for a remote app: drop lanes beyond the first 4 per card, then PRs, then whole cards.
    let size = |cards: &[fleetd_contracts::live::OrderCard]| {
        serde_json::to_vec(cards).map_or(0, |v| v.len())
    };
    if size(&cards) > BOARD_MAX_BYTES {
        truncated = true;
        for card in &mut cards {
            let mut lanes = std::mem::take(&mut card.lanes).into_inner();
            lanes.truncate(4);
            card.lanes = List::unchecked(lanes);
        }
    }
    if size(&cards) > BOARD_MAX_BYTES {
        for card in &mut cards {
            let mut prs = std::mem::take(&mut card.prs).into_inner();
            prs.truncate(1);
            card.prs = List::unchecked(prs);
        }
    }
    while size(&cards) > BOARD_MAX_BYTES && !cards.is_empty() {
        cards.pop();
    }
    Ok(OrdersBoardOutput {
        orders: List::unchecked(cards),
        trains: List::unchecked(trains),
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        next: Some(
            "Open one with order_get; subscribe to live lanes with the app's live frame.".into(),
        ),
        truncated: truncated.then_some(true),
    })
}

async fn order_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: OrderGetInput,
) -> Result<OrderGetOutput, ToolError> {
    let id = &input.workstream_id;
    let w = match hub.leads.records.workstream_get(id)? {
        Some(s)
            if allows(
                &caller,
                Role::Read,
                Some(&s.workstream.project_ref.machine_id),
            ) =>
        {
            s.workstream
        }
        _ => return Err(unknown_order(id.as_str())),
    };
    let ports = hub.leads.ctx.ports();
    let mut requests: Vec<_> = ports
        .open_requests(Some(&w.project_ref), 200)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.workstream_id.as_ref() == Some(id))
        .collect();
    let changes = super::project_changes(&hub, &w.project_ref);
    let joined = super::join(&hub, &w, &changes, requests.len());
    let mut truncated = joined.truncated || requests.len() > ORDER_ASKS;
    requests.truncate(ORDER_ASKS);
    let claims = hub
        .leads
        .ctx
        .hooks
        .claims
        .get()
        .map(|c| c.list(id, ORDER_CLAIMS))
        .filter(|c| !c.is_empty());
    let title = hub
        .store
        .project_get(&w.project_ref)?
        .map_or_else(|| w.project_ref.project_id.to_string(), |p| p.title);
    let lead = hub
        .leads
        .leads
        .get(&w.project_ref)
        .ok()
        .flatten()
        .map(|l| super::lead_lane(&l, &title, hub.as_ref()));
    if joined.done.len() >= super::DONE_LANES {
        truncated = true;
    }
    Ok(OrderGetOutput {
        order: joined.card,
        lead,
        done_lanes: List::unchecked(joined.done),
        requests: List::unchecked(requests),
        claims: claims.map(List::unchecked),
        next: Some("Add to it with order_note; stop it with order_stop.".into()),
        truncated: truncated.then_some(true),
    })
}

async fn order_note(
    hub: Arc<Hub>,
    caller: Caller,
    input: OrderNoteInput,
) -> Result<OrderNoteOutput, ToolError> {
    super::notes::note(&hub, &caller, input).await
}

async fn order_stop(
    hub: Arc<Hub>,
    caller: Caller,
    input: OrderStopInput,
) -> Result<OrderStopOutput, ToolError> {
    super::notes::stop(&hub, &caller, input).await
}

async fn intake_preview(
    hub: Arc<Hub>,
    caller: Caller,
    input: IntakePreviewInput,
) -> Result<IntakePreviewOutput, ToolError> {
    let gate = caller.clone();
    let allows = move |m: &fleetd_contracts::ids::MachineId| allows(&gate, Role::Operate, Some(m));
    let echo = hub
        .leads
        .intake
        .preview(&input.text, &allows)
        .await
        .map_err(ToolError::from)?;
    Ok(IntakePreviewOutput {
        next: Some(match &echo {
            Some(_) => {
                "Pass that project to intake_submit so the router does not run again.".into()
            }
            None => {
                "The router could not place it; name the project with @<project> in intake_submit.".into()
            }
        }),
        echo,
        truncated: None,
    })
}

async fn attachment_put(
    hub: Arc<Hub>,
    caller: Caller,
    input: AttachmentPutInput,
) -> Result<AttachmentPutOutput, ToolError> {
    crate::hub::intake::attachments::put(&hub, &caller, input).await
}

async fn attachment_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: fleetd_contracts::mcp::AttachmentGetInput,
) -> Result<fleetd_contracts::mcp::AttachmentGetOutput, ToolError> {
    crate::hub::intake::attachments::get(&hub, &caller, input).await
}

async fn project_files(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectFilesInput,
) -> Result<ProjectFilesOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    let (paths, cut) = hub
        .executors
        .list_files(&r, &input.query, input.limit.get())
        .await
        .map_err(from_executor)?;
    let paths: Vec<Text<1, 1000>> = paths
        .iter()
        .filter_map(|p| Text::new(p.as_str()).ok())
        .take(50)
        .collect();
    Ok(ProjectFilesOutput {
        paths: List::unchecked(paths),
        next: None,
        truncated: cut.then_some(true),
    })
}
