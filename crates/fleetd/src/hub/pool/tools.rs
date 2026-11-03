//! `cloud_stop`, the cloud machines' kill switch for admin keys (`fleetd cloud stop`, and Settings › Cloud's "Stop all
//! cloud machines"): no key or secret crosses it.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{CloudStopInput, CloudStopOutput, ErrorCode};

use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("cloud_stop", stop);
}

async fn stop(
    hub: Arc<Hub>,
    caller: Caller,
    _: CloudStopInput,
) -> Result<CloudStopOutput, ToolError> {
    require(&caller, Role::Admin, None)?;
    let kill = hub
        .pool
        .kill()
        .await
        .map_err(|e| ToolError::new(ErrorCode::Failed, e))?;
    Ok(CloudStopOutput {
        stopped: kill.stopped,
        failed: kill
            .failed
            .into_iter()
            .map(|(machine, why)| format!("{machine}: {why}"))
            .collect(),
        unlisted: kill.unlisted,
        next: None,
        truncated: None,
    })
}
