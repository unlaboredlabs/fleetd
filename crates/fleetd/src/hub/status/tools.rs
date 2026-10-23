//! status_get: the projects' rows, or one project's row and series.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ErrorCode, StatusGetInput, StatusGetOutput};
use fleetd_contracts::prim::List;

use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("status_get", status_get);
}

fn unread(e: anyhow::Error) -> ToolError {
    ToolError::new(
        ErrorCode::Failed,
        format!("The status rows were not read: {e}"),
    )
}

async fn status_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: StatusGetInput,
) -> Result<StatusGetOutput, ToolError> {
    let Some(r) = &input.project_ref else {
        let mut rows = hub.status.project_rows(&hub, &caller).map_err(unread)?;
        let truncated = (rows.len() > 200).then_some(true);
        rows.truncate(200);
        return Ok(StatusGetOutput {
            rows: Some(List::unchecked(rows)),
            row: None,
            series: None,
            next: Some("status_get with a row's projectRef for the series behind its bar".into()),
            truncated,
        });
    };
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let Some((row, series)) = hub.status.project(&hub, &caller, r).map_err(unread)? else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("There is no project {}/{}.", r.machine_id, r.project_id),
        )
        .with_fix("status_get without a projectRef lists them."));
    };
    Ok(StatusGetOutput {
        rows: None,
        row: Some(row),
        series: Some(List::unchecked(series)),
        next: None,
        truncated: None,
    })
}
