//! project_discover, project_add and project_remove: thin over the projects service. A project's settings are in
//! settings.rs, its repos in repos.rs; project_remove removes the checkouts of its repos with it.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ProjectAddInput, ProjectAddOutput, ProjectDiscoverInput, ProjectDiscoverOutput,
    ProjectRemoveInput,
};
use fleetd_contracts::node_link::CAP_PROJECT_SETTINGS;
use serde_json::{Value, json};

use crate::hub::api::{Caller, Hub, Registry, ToolError, offline, require, unknown_machine};
use crate::hub::executor::tools::from_executor;

pub fn register(tools: &mut Registry) {
    tools.add("project_discover", discover);
    tools.add("project_add", add);
    tools.add("project_remove", remove);
    super::settings::register(tools);
    super::avatar::register(tools);
    super::profiles::register(tools);
    super::repos::register(tools);
}

async fn discover(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectDiscoverInput,
) -> Result<ProjectDiscoverOutput, ToolError> {
    super::discover(&hub, &caller, input).await
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
    let remove_worktrees = input.remove_worktrees == Some(true);
    if remove_worktrees && !hub.link.node_can(m, CAP_PROJECT_SETTINGS) {
        return Err(super::settings::too_old(m));
    }
    // The checkouts of its other repos go with it, the same way: each is a node project of its own, hidden only while
    // a project holds it, so one left on the node would show as a project once this one is gone. One another project
    // also holds stays.
    let r = ProjectRef {
        machine_id: m.clone(),
        project_id: input.project_id.clone(),
    };
    let mut checkouts = Vec::new();
    for checkout in super::repos::other_checkouts(&hub, &r)? {
        if hub.repos.holders(&checkout)?.iter().all(|(h, _)| *h == r) {
            checkouts.push(checkout.project_id);
        }
    }
    for project_id in std::iter::once(&input.project_id).chain(&checkouts) {
        hub.executors
            .project_remove(m, project_id, remove_worktrees)
            .await
            .map_err(from_executor)?;
    }
    let next = if remove_worktrees {
        "Its threads were stopped and its worktrees removed; its checkout and branches stay on the machine. \
         project_add brings it back."
    } else {
        "Its threads were stopped; its files, branches and worktrees stay on the machine. project_add brings it back."
    };
    Ok(json!({ "ok": true, "next": next }))
}
