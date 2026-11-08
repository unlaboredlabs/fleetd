//! project_discover, project_add and project_remove: thin over the projects service. A project's settings are in
//! settings.rs, its repos in repos.rs; project_remove removes the checkouts of its repos with it, erases a Navi
//! (`navi::erase`), and asks each hub it is linked to to revoke its link. A project whose machine the hub no longer has is only forgotten in the hub.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::mcp::{
    ProjectAddInput, ProjectAddOutput, ProjectDiscoverInput, ProjectDiscoverOutput,
    ProjectRemoveInput,
};
use fleetd_contracts::node_link::{CAP_NAVI_ERASE, CAP_PROJECT_ERASE, CAP_PROJECT_SETTINGS};
use serde_json::{Value, json};

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, offline, require, unknown_project};
use crate::hub::executor::tools::from_executor;
use crate::hub::store::{NewEvent, iso_ms, now_ms};
use fleetd_contracts::events::HubEventType;

pub fn register(tools: &mut Registry) {
    tools.add("project_discover", discover);
    tools.add("project_add", add);
    tools.add("project_remove", remove);
    super::settings::register(tools);
    super::avatar::register(tools);
    super::icon::register(tools);
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
    let r = ProjectRef {
        machine_id: m.clone(),
        project_id: input.project_id.clone(),
    };
    // Its linked hubs, read before the erase deletes their keys: each is asked to revoke its link once it is gone.
    let links = crate::hub::hub_links::kept(&hub.db, Some(&r))?;
    if hub.store.machine_get(m)?.is_none() {
        let forgot = forget_gone(&hub, &r)?;
        crate::hub::hub_links::client::revoke_all_there(&hub, links);
        return Ok(forgot);
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
    // Every project is erased (D287, one rule since D310), on its node too, which must know how; its folder goes only
    // if asked. A node before that erases a Navi alone.
    let navi = crate::hub::navi::of(&hub.db, &r)?.is_some();
    let remove_folder = input.remove_folder == Some(true);
    let erases =
        hub.link.node_can(m, CAP_PROJECT_ERASE) || (navi && hub.link.node_can(m, CAP_NAVI_ERASE));
    if !erases {
        return Err(error(
            ErrorCode::Invalid,
            format!(
                "Update fleetd on {m} first: its node is too old to erase a project, so nothing was deleted"
            ),
            format!("Run fleetd update on {m}, then delete it again."),
        ));
    }
    // Marked first: should the node remove it but its answer never come, the hub still erases it (`navi::erase::run`).
    crate::hub::navi::erase::asked(&hub, &r)?;
    let mut checkouts = Vec::new();
    for checkout in super::repos::other_checkouts(&hub, &r)? {
        if hub.repos.holders(&checkout)?.iter().all(|(h, _)| *h == r) {
            checkouts.push(checkout.project_id);
        }
    }
    for project_id in std::iter::once(&input.project_id).chain(&checkouts) {
        let own = project_id == &input.project_id;
        hub.executors
            .project_remove(m, project_id, remove_worktrees, own, remove_folder && own)
            .await
            .map_err(from_executor)?;
    }
    crate::hub::navi::erase::erase(&hub, &r)?;
    crate::hub::hub_links::client::revoke_all_there(&hub, links);
    const ERASED: &str = "Erased: its chat, memory, skills, approvals and purchases, asks and decisions, orders and \
                          tasks, automations, kept browser sign-ins, Telegram link, linked hubs, transcripts, attachments and \
                          screen recordings";
    let next = if remove_folder {
        format!("{ERASED}, and its folder with everything in it.")
    } else {
        format!("{ERASED}. Its folder, files and branches stay on the machine.")
    };
    Ok(json!({ "ok": true, "next": next }))
}

/// A project of a machine the hub no longer has (removed before `machine remove` forgot its rows): no node holds its
/// files to stop or remove, so the hub erases what it holds of it (`navi::erase`, as for every project) and forgets
/// its rows (`machine_project_forget`), and says so with project.removed. Another machine's project under the same id stays.
fn forget_gone(hub: &Hub, r: &ProjectRef) -> Result<Value, ToolError> {
    let Some(project) = hub.store.project_get(r)? else {
        return Err(unknown_project(r));
    };
    crate::hub::navi::erase::erase(hub, r)?;
    hub.store.machine_project_forget(r)?;
    hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::ProjectRemoved,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: format!(
            "Project \"{}\" on {} was forgotten: its machine was removed",
            project.title, r.machine_id
        ),
        data: Some(json!({ "title": project.title })),
        attention: None,
    })?;
    Ok(json!({
        "ok": true,
        "next": format!(
            "{} is no longer in the hub, so no machine held its files: fleetd forgot the project, its chat and its settings.",
            r.machine_id
        ),
    }))
}
