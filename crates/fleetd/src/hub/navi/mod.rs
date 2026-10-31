//! Navis (W97): personal assistants, as many as a person likes. A Navi is a project of kind `assistant` in a plain
//! folder of its own under its node's home (`navi/<name>`), marked in the `assistants` table with the key that made
//! it. Everything else is a project's, unchanged: its chat, memory and nightly refresh, automations, screens,
//! checklist and approvals. Its lead differs in two ways (`leads/lead.rs`): it starts from the `navi.start` prompt, and
//! runs in the assistant role (`SessionRole::Assistant`), which asks a person before a send, a write through an
//! integration, or a first visit to a site they didn't give it.
//!
//! Its lead reads and writes what the person can on its machine, but their keys and logins and fleetd's own files, from
//! a home of its own where its background processes outlive the turn (D234; the node's OS sandbox holds every tool and
//! command to it, `node/runner/sandbox.rs`), runs commands unasked (D208), and fetches or opens a site unasked only once the person allowed that site at its
//! first visit or linked it in their own message (`sites`).
//!
//! Each Navi has an owner (D215, `owner`): only they see it and use it, and the hub refuses anyone else.
//!
//! Its browser keeps its sign-ins between sessions in a profile of its own on its node (D221, node/browser/chrome.rs);
//! `navi_signins_forget` deletes it, and deleting the Navi (`project_remove`) does too.
//!
//! An archived Navi keeps its chat, memory and folder; its lead is stopped and doesn't start again until it is brought
//! back, and a message to it waits until then. Its factory bridge (messages to other projects' leads, the factory's
//! status, wakes when that work lands) is `bridge`; the app reads a Navi's asks with `navi_asks` (`tools`). A Navi
//! searches and reads back through its own chat with `recall`.
pub mod bridge;
#[cfg(test)]
mod mcp_fresh_tests;
pub mod owner;
#[cfg(test)]
mod owner_tests;
pub mod recall;
pub mod sites;
pub mod store;
#[cfg(test)]
mod tests;
pub mod tools;

use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadRef};
use fleetd_contracts::mcp::{
    ErrorCode, NaviArchiveInput, NaviArchiveOutput, NaviCreateInput, NaviCreateOutput,
    NaviListInput, NaviListOutput, NaviRenameInput, NaviRenameOutput, NaviSigninsForgetInput,
    NaviSigninsForgetOutput, NaviSiteRevokeInput, NaviSiteRevokeOutput, NaviSitesInput,
    NaviSitesOutput,
};
use fleetd_contracts::model::{ProjectCreator, ProjectKind, ProjectSummary};
use fleetd_contracts::node_link::{CAP_ASSISTANT, CAP_NAVI_SIGNINS};
use fleetd_contracts::projects::ProjectAddedData;

use crate::hub::api::{Caller, Hub, ToolError, allows, error, offline, require, unknown_project};
use crate::hub::executor::tools::from_executor;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

/// Where Navis' folders go, under the node's home.
pub const FOLDER: &str = "navi";

/// How many free names `navi_create` tries before it gives up.
const FOLDER_TRIES: usize = 50;

/// Whether the project is a Navi, and if so whether it is archived.
pub fn of(db: &HubDb, r: &ProjectRef) -> Result<Option<store::Navi>, StoreError> {
    db.with(|c| Ok(store::of(c, r)?))
}

/// A folder name from a Navi's name: lowercase letters, digits and dashes, at most 40; "navi" when nothing is left.
pub fn slug(name: &str) -> String {
    slug_or(name, FOLDER)
}

/// A folder name from a name, as [`slug`] makes a Navi's (a new project's too); `fallback` when nothing is left.
pub fn slug_or(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        fallback.to_owned()
    } else {
        out.to_owned()
    }
}

/// `navi/<slug>`, then `navi/<slug>-2` and on, skipping the folders of the machine's projects. The node also refuses a
/// folder that is already there (`FOLDER_TAKEN`), and the next one is tried.
fn free_folders(hub: &Hub, m: &MachineId, slug: &str) -> Result<Vec<String>, StoreError> {
    let taken: Vec<String> = hub
        .store
        .projects_list(Some(m), None)?
        .into_iter()
        .map(|p| p.workspace_root)
        .collect();
    let used = |name: &str| {
        let tail = format!("/{FOLDER}/{name}");
        taken
            .iter()
            .any(|root| root.trim_end_matches('/').ends_with(&tail))
    };
    Ok(std::iter::once(slug.to_owned())
        .chain((2..).map(|n| format!("{slug}-{n}")))
        .filter(|n| !used(n))
        .take(FOLDER_TRIES)
        .map(|n| format!("{FOLDER}/{n}"))
        .collect())
}

fn too_old(m: &MachineId) -> ToolError {
    error(
        ErrorCode::Invalid,
        format!("{m}'s node is too old to hold a Navi"),
        format!("Run fleetd update on {m}, or pass another machineId"),
    )
}

fn not_a_navi(r: &ProjectRef) -> ToolError {
    error(
        ErrorCode::NotFound,
        format!("{} on {} is not a Navi", r.project_id, r.machine_id),
        "navi_list shows the Navis and their ids",
    )
}

/// The Navi's summary as the hub serves it, or why there is none.
fn navi_of(hub: &Hub, r: &ProjectRef) -> Result<ProjectSummary, ToolError> {
    let project = hub
        .store
        .project_get(r)?
        .ok_or_else(|| unknown_project(r))?;
    if project.kind != Some(ProjectKind::Assistant) {
        return Err(not_a_navi(r));
    }
    Ok(project)
}

fn changed(hub: &Hub, navi: &ProjectSummary, summary: String) -> Result<(), ToolError> {
    hub.events.append(NewEvent {
        at: crate::hub::checks::now_ts(hub.clock.as_ref()),
        r#type: HubEventType::ProjectSettings,
        machine_id: Some(navi.machine_id.clone()),
        project_id: Some(navi.project_id.clone()),
        thread_id: None,
        summary,
        data: Some(serde_json::json!({
            "kind": navi.kind, "title": navi.title, "archivedAt": navi.archived_at,
        })),
        attention: None,
    })?;
    Ok(())
}

pub async fn create(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: NaviCreateInput,
) -> Result<NaviCreateOutput, ToolError> {
    if let Some(m) = &input.machine_id {
        require(caller, Role::Operate, Some(m))?;
    }
    let m = crate::hub::projects::target_machine(hub, input.machine_id.as_ref())?;
    require(caller, Role::Operate, Some(&m))?;
    if !hub.link.node_can(&m, CAP_ASSISTANT) {
        return Err(too_old(&m));
    }
    let name = input.name.as_str().trim().to_owned();
    let folders = free_folders(hub, &m, &slug(&name))?;
    let r = ProjectRef {
        machine_id: m.clone(),
        project_id: ProjectId::unchecked(crate::hub::executor::new_uuid().as_str()),
    };
    let at_ms = now_ms(hub.clock.as_ref());
    let created_by = ProjectCreator {
        key_id: caller.key_id.to_string(),
        name: caller.name.clone(),
    };
    // Marked first, so the node's report of the new project already reads as a Navi.
    hub.db.with(|c| {
        let owner = owner::who(c, caller)?;
        Ok(store::put(c, &r, &created_by, owner.as_ref(), at_ms)?)
    })?;
    let mut made = None;
    for folder in &folders {
        match hub
            .executors
            .project_folder(&m, &r.project_id, &name, folder)
            .await
        {
            Ok(path) => {
                made = Some(Ok(path));
                break;
            }
            Err(crate::hub::executor::ExecutorError::NodeRequestFailed { message, .. })
                if message.contains(fleetd_contracts::sessions::FOLDER_TAKEN) => {}
            Err(e) => {
                made = Some(Err(from_executor(e)));
                break;
            }
        }
    }
    let path = match made {
        Some(Ok(path)) => path,
        failed => {
            hub.db.with(|c| Ok(store::remove(c, &r)?))?;
            return Err(failed.and_then(Result::err).unwrap_or_else(|| {
                error(
                    ErrorCode::Failed,
                    format!("every free folder name for {name} on {m} is taken"),
                    "Give the Navi another name",
                )
            }));
        }
    };
    // In the cache now, so navi_list shows it before the node's report of it arrives.
    let summary = ProjectSummary {
        machine_id: m.clone(),
        project_id: r.project_id.clone(),
        title: name.clone(),
        workspace_root: path.clone(),
        threads: Default::default(),
        last_activity_at: iso_ms(at_ms).into(),
        repos: vec![],
        kind: None,
        created_by: None,
        owner: None,
        archived_at: None,
        avatar: None,
        icon: None,
    };
    if hub.store.project_get(&r)?.is_none() {
        hub.store.projects_upsert_many(&m, &[summary])?;
    }
    let data = crate::hub::projects::inspect::fit_added(ProjectAddedData {
        add_id: None,
        title: name.clone(),
        path,
        created: true,
        inspect: crate::hub::projects::inspect::folder(),
    });
    hub.events.append(NewEvent {
        at: iso_ms(at_ms).into(),
        r#type: HubEventType::ProjectAdded,
        machine_id: Some(m.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: crate::hub::executor::shell_mapper::js_take(
            &format!("Navi {name} made on {m}"),
            200,
        )
        .to_owned(),
        data: serde_json::to_value(&data).ok(),
        attention: None,
    })?;
    Ok(NaviCreateOutput {
        navi: navi_of(hub, &r)?,
        next: Some("Write to it with chat_send; its lead starts with the first message.".into()),
        truncated: None,
    })
}

pub fn list(hub: &Hub, caller: &Caller, input: NaviListInput) -> Result<NaviListOutput, ToolError> {
    let archived = input.archived == Some(true);
    let others = owner::others(&hub.db, caller)?;
    let mut navis = Vec::new();
    for r in hub.db.with(|c| Ok(store::all(c)?))? {
        if input
            .machine_id
            .as_ref()
            .is_some_and(|m| *m != r.machine_id)
            || !allows(caller, Role::Read, Some(&r.machine_id))
            || others.contains(&r)
        {
            continue;
        }
        if let Some(navi) = hub.store.project_get(&r)?
            && (archived || navi.archived_at.is_none())
        {
            navis.push(navi);
        }
    }
    let next = navis
        .is_empty()
        .then(|| "No Navis yet: navi_create makes one.".to_owned());
    Ok(NaviListOutput {
        navis,
        next,
        truncated: None,
    })
}

pub async fn rename(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: NaviRenameInput,
) -> Result<NaviRenameOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(caller, Role::Operate, Some(&r.machine_id))?;
    let navi = navi_of(hub, &r)?;
    if !hub.executors.is_connected(&r.machine_id) {
        return Err(offline(&r.machine_id));
    }
    let name = input.name.as_str().trim().to_owned();
    hub.executors
        .project_upsert(&r.machine_id, &r.project_id, &name, &navi.workspace_root)
        .await
        .map_err(from_executor)?;
    hub.store.projects_upsert_many(
        &r.machine_id,
        &[ProjectSummary {
            title: name.clone(),
            ..navi.clone()
        }],
    )?;
    let navi = navi_of(hub, &r)?;
    changed(hub, &navi, format!("Navi {} renamed {name}", r.project_id))?;
    Ok(NaviRenameOutput {
        navi,
        next: None,
        truncated: None,
    })
}

pub async fn archive(
    hub: &Arc<Hub>,
    caller: &Caller,
    input: NaviArchiveInput,
) -> Result<NaviArchiveOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(caller, Role::Operate, Some(&r.machine_id))?;
    let before = navi_of(hub, &r)?;
    let archive = input.archived != Some(false);
    if archive == before.archived_at.is_some() {
        return Ok(NaviArchiveOutput {
            navi: before,
            next: None,
            truncated: None,
        });
    }
    let at = archive.then(|| now_ms(hub.clock.as_ref()));
    hub.db.with(|c| Ok(store::set_archived(c, &r, at)?))?;
    if archive {
        stop_lead(hub, &r).await;
    }
    let navi = navi_of(hub, &r)?;
    let (verb, next) = if archive {
        (
            "archived",
            "Its chat, memory and folder stay; navi_archive with archived false brings it back.",
        )
    } else {
        ("back", "Its lead starts with the next chat message.")
    };
    changed(hub, &navi, format!("Navi {} {verb}", navi.title))?;
    Ok(NaviArchiveOutput {
        navi,
        next: Some(next.into()),
        truncated: None,
    })
}

/// Ends the lead's process, its turn first. Best effort: a lead on an offline machine stays stopped there, since an
/// archived Navi's lead never starts.
async fn stop_lead(hub: &Hub, r: &ProjectRef) {
    let Ok(Some(lead)) = hub.leads.records.lead_get(r) else {
        return;
    };
    let thread = ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: lead.thread_id,
    };
    let _ = hub.executors.interrupt_now(&thread).await;
    if let Err(error) = hub.executors.stop(&thread, false).await {
        tracing::info!(%error, "an archived Navi's lead was not stopped now");
    }
}

pub fn sites(
    hub: &Hub,
    caller: &Caller,
    input: NaviSitesInput,
) -> Result<NaviSitesOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(caller, Role::Read, Some(&r.machine_id))?;
    navi_of(hub, &r)?;
    let sites = hub.db.with(|c| Ok(store::sites(c, &r)?))?;
    let next = sites.is_empty().then(|| {
        "None yet: its first fetch or visit to a site asks the person, and approving it adds the site.".to_owned()
    });
    Ok(NaviSitesOutput {
        sites,
        next,
        truncated: None,
    })
}

/// A person's own chat message to a Navi allows the site of each link in it (D208): they gave it that link, so its
/// first fetch or visit there doesn't ask. Nothing for any other project, or a message with no link.
pub fn allow_pasted(hub: &Hub, r: &ProjectRef, text: &str, by: &str) -> Result<(), StoreError> {
    let pasted = sites::pasted(text);
    if pasted.is_empty() || of(&hub.db, r)?.is_none() {
        return Ok(());
    }
    let at = now_ms(hub.clock.as_ref());
    hub.db.with(|c| {
        for site in &pasted {
            store::allow_site(c, r, site, by, at)?;
        }
        Ok(())
    })
}

pub fn revoke_site(
    hub: &Hub,
    caller: &Caller,
    input: NaviSiteRevokeInput,
) -> Result<NaviSiteRevokeOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(caller, Role::Operate, Some(&r.machine_id))?;
    navi_of(hub, &r)?;
    let site =
        sites::site_of(input.site.as_str()).unwrap_or_else(|| input.site.as_str().to_owned());
    let sites = hub.db.with(|c| {
        store::revoke_site(c, &r, &site)?;
        Ok(store::sites(c, &r)?)
    })?;
    Ok(NaviSiteRevokeOutput {
        sites,
        next: Some(format!("Its next fetch or visit to {site} asks again.")),
        truncated: None,
    })
}

/// Forgets the Navi's sign-ins: its browser session, if one is open, ends, and the profile it keeps between sessions
/// is deleted on its node, so its next visit to each site starts signed out.
pub async fn forget_signins(
    hub: &Hub,
    caller: &Caller,
    input: NaviSigninsForgetInput,
) -> Result<NaviSigninsForgetOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(caller, Role::Operate, Some(&r.machine_id))?;
    let navi = navi_of(hub, &r)?;
    if !hub.executors.is_connected(&r.machine_id) {
        return Err(offline(&r.machine_id));
    }
    if !hub.link.node_can(&r.machine_id, CAP_NAVI_SIGNINS) {
        return Err(error(
            ErrorCode::Invalid,
            format!(
                "{}'s node is too old to keep a Navi's sign-ins",
                r.machine_id
            ),
            format!(
                "Run fleetd update on {}: until then its browser starts signed out every session",
                r.machine_id
            ),
        ));
    }
    hub.executors
        .navi_signins_forget(&r.machine_id, &r.project_id)
        .await
        .map_err(from_executor)?;
    changed(
        hub,
        &navi,
        format!("Navi {}'s sign-ins forgotten", navi.title),
    )?;
    Ok(NaviSigninsForgetOutput {
        ok: fleetd_contracts::prim::True,
        next: Some("Its next browser session starts signed out of every site.".into()),
        truncated: None,
    })
}
