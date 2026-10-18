//! project_discover, project_inspect, project_add and project_remove: thin over the projects service.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ProjectAddInput, ProjectAddOutput, ProjectDiscoverInput, ProjectDiscoverOutput,
    ProjectInspectInput, ProjectInspectOutput, ProjectRemoveInput,
};
use serde_json::{Value, json};

use crate::hub::api::{Caller, Hub, Registry, ToolError, offline, require, unknown_machine};
use crate::hub::executor::tools::from_executor;

pub fn register(tools: &mut Registry) {
    tools.add("project_discover", discover);
    tools.add("project_inspect", inspect);
    tools.add("project_add", add);
    tools.add("project_remove", remove);
}

async fn discover(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectDiscoverInput,
) -> Result<ProjectDiscoverOutput, ToolError> {
    super::discover(&hub, &caller, input).await
}

async fn inspect(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectInspectInput,
) -> Result<ProjectInspectOutput, ToolError> {
    super::inspect(&hub, &caller, input).await
}

async fn add(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectAddInput,
) -> Result<ProjectAddOutput, ToolError> {
    super::add(hub, &caller, input).await
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectRemoveInput,
) -> Result<Value, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Operate, Some(m))?;
    if hub.store.machine_get(m)?.is_none() {
        return Err(unknown_machine(m));
    }
    if !hub.executors.is_connected(m) {
        return Err(offline(m));
    }
    hub.executors
        .project_remove(m, &input.project_id)
        .await
        .map_err(from_executor)?;
    Ok(json!({
        "ok": true,
        "next": "Its threads were stopped; its files, branches and worktrees stay on the machine. project_add brings it back.",
    }))
}
