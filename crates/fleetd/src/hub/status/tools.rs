//! status_projects and status_get.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, StatusGetInput, StatusGetOutput, StatusProjectsInput, StatusProjectsOutput,
};
use fleetd_contracts::prim::List;

use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("status_projects", status_projects);
    tools.add("status_get", status_get);
}

fn unread(e: anyhow::Error) -> ToolError {
    ToolError::new(
        ErrorCode::Failed,
        format!("The status rows were not read: {e}"),
    )
}

async fn status_projects(
    hub: Arc<Hub>,
    caller: Caller,
    _input: StatusProjectsInput,
) -> Result<StatusProjectsOutput, ToolError> {
    let mut rows = hub.status.project_rows(&hub, &caller).map_err(unread)?;
    let truncated = (rows.len() > 200).then_some(true);
    rows.truncate(200);
    Ok(StatusProjectsOutput {
        rows: List::unchecked(rows),
        next: Some("status_get with a row's projectRef for the series behind its bar".into()),
        truncated,
    })
}

async fn status_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: StatusGetInput,
) -> Result<StatusGetOutput, ToolError> {
    let r = &input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let Some((row, series)) = hub.status.project(&hub, &caller, r).map_err(unread)? else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("There is no project {}/{}.", r.machine_id, r.project_id),
        )
        .with_fix("status_projects lists them."));
    };
    Ok(StatusGetOutput {
        row,
        series: List::unchecked(series),
        next: None,
        truncated: None,
    })
}
