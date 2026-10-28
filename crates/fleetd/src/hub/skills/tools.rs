//! skills_list, skill_get, skill_set, skill_delete, skill_install and skill_update: Settings → Projects → Agents and the
//! composer's `$`. Writes are a person's (human keys); a lead installs with its own `skill_install` (`calls`). The
//! repo's skills are read from the project's node and never written here: they change in the repo.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, SkillDeleteInput, SkillDeleteOutput, SkillGetInput, SkillGetOutput,
    SkillInstallInput, SkillInstallOutput, SkillSetInput, SkillSetOutput, SkillUpdateInput,
    SkillUpdateOutput, SkillsListInput, SkillsListOutput,
};
use fleetd_contracts::node_link::CAP_SKILLS;
use fleetd_contracts::prim::{Line, List, Text, True};
use fleetd_contracts::skills::{
    RepoSkill, SkillName, SkillOrigin, SkillScope, SkillSummary, description_of,
};
use serde_json::json;

use super::{Kept, SkillError, install, mark_shadowed};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows_everywhere, require, unknown_project,
};
use crate::hub::executor::tools::from_executor;
use crate::hub::orders::notes::require_human;
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("skills_list", skills_list);
    tools.add("skill_get", skill_get);
    tools.add("skill_set", skill_set);
    tools.add("skill_delete", skill_delete);
    tools.add("skill_install", skill_install);
    tools.add("skill_update", skill_update);
}

fn known_project(hub: &Hub, caller: &Caller, r: &ProjectRef, role: Role) -> Result<(), ToolError> {
    require(caller, role, Some(&r.machine_id))?;
    if hub.store.project_get(r)?.is_none() {
        return Err(unknown_project(r));
    }
    Ok(())
}

/// The project a write in `scope` is for, checked; None for global. A project's skills take operate on its machine;
/// global ones reach every machine's agents, so they take admin on every machine.
fn scope_project<'a>(
    hub: &Hub,
    caller: &Caller,
    scope: SkillScope,
    r: Option<&'a ProjectRef>,
) -> Result<Option<&'a ProjectRef>, ToolError> {
    match (scope, r) {
        (SkillScope::Project, Some(r)) => {
            known_project(hub, caller, r, Role::Operate)?;
            Ok(Some(r))
        }
        (SkillScope::Project, None) => Err(ToolError::new(
            ErrorCode::Invalid,
            "scope project needs projectRef.",
        )),
        (SkillScope::Global, _) if allows_everywhere(caller, Role::Admin) => Ok(None),
        (SkillScope::Global, _) => Err(ToolError::new(
            ErrorCode::Forbidden,
            "Global skills reach every machine's agents, so they take admin on every machine, and this key lacks it.",
        )
        .with_fix("Use a key with admin on every machine, or keep the skill in one project.")),
    }
}

fn not_found(name: &SkillName) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No skill called {name} here."))
        .with_fix("skills_list lists them.")
}

/// `skills.changed`, which tells the app to list the skills again. `project` is None for the global scope.
pub fn changed(
    hub: &Hub,
    project: Option<&ProjectRef>,
    names: &[SkillName],
    by: &str,
) -> Result<(), StoreError> {
    let scope = if project.is_some() {
        SkillScope::Project
    } else {
        SkillScope::Global
    };
    let list = names
        .iter()
        .map(SkillName::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::SkillsChanged,
        machine_id: project.map(|r| r.machine_id.clone()),
        project_id: project.map(|r| r.project_id.clone()),
        thread_id: None,
        summary: match project {
            None => format!("global skills changed: {list}"),
            Some(r) => format!(
                "skills of {}/{} changed: {list}",
                r.machine_id, r.project_id
            ),
        },
        data: Some(json!({ "scope": scope, "projectRef": project, "names": names, "by": by })),
        attention: None,
    })?;
    Ok(())
}

/// The repo's skills from the project's node, or why there are none to show.
pub async fn repo_skills(hub: &Hub, r: &ProjectRef) -> Result<Vec<RepoSkill>, String> {
    if !hub.executors.is_connected(&r.machine_id) {
        return Err(format!(
            "{} is offline, so its repo's skills aren't listed.",
            r.machine_id
        ));
    }
    if !hub.link.node_can(&r.machine_id, CAP_SKILLS) {
        return Err(format!(
            "The node on {} is too old to list its repo's skills; update it.",
            r.machine_id
        ));
    }
    hub.executors
        .list_repo_skills(r)
        .await
        .map_err(|e| e.to_string())
}

fn repo_summary(s: RepoSkill) -> SkillSummary {
    SkillSummary {
        name: s.name,
        origin: s.origin,
        description: Text::unchecked(s.description),
        shadowed_by: None,
        install: None,
        path: Some(Line::unchecked(s.path)),
        files: List::unchecked(Vec::new()),
        updated_at: None,
    }
}

async fn skills_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: SkillsListInput,
) -> Result<SkillsListOutput, ToolError> {
    let skills = hub.db.skills();
    let mut list: Vec<SkillSummary> = skills
        .list(SkillScope::Global, None)
        .iter()
        .map(Kept::summary)
        .collect();
    let mut repo_unavailable = None;
    if let Some(r) = &input.project_ref {
        known_project(&hub, &caller, r, Role::Read)?;
        list.extend(
            skills
                .list(SkillScope::Project, Some(r))
                .iter()
                .map(Kept::summary),
        );
        match repo_skills(&hub, r).await {
            Ok(repo) => list.extend(repo.into_iter().map(repo_summary)),
            Err(why) => repo_unavailable = Some(why),
        }
    }
    mark_shadowed(&mut list);
    Ok(SkillsListOutput {
        skills: List::unchecked(list),
        repo_unavailable,
        next: input.project_ref.is_none().then(|| {
            "skills_list with projectRef adds that project's skills and its repo's.".into()
        }),
        truncated: None,
    })
}

async fn skill_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: SkillGetInput,
) -> Result<SkillGetOutput, ToolError> {
    let r = input.project_ref.as_ref();
    if let Some(r) = r {
        known_project(&hub, &caller, r, Role::Read)?;
    }
    let (skill, text) = match (input.origin, r) {
        (SkillOrigin::Global, _) => {
            let kept = hub
                .db
                .skills()
                .get(SkillScope::Global, None, &input.name)
                .ok_or_else(|| not_found(&input.name))?;
            (kept.summary(), kept.text)
        }
        (SkillOrigin::Project, Some(r)) => {
            let kept = hub
                .db
                .skills()
                .get(SkillScope::Project, Some(r), &input.name)
                .ok_or_else(|| not_found(&input.name))?;
            (kept.summary(), kept.text)
        }
        (origin, Some(r)) => {
            let dir = origin.repo_dir().unwrap_or_default();
            let path = format!("{dir}/{}/SKILL.md", input.name);
            let text = hub
                .executors
                .read_project_file(&r.machine_id, &r.project_id, &path)
                .await
                .map_err(from_executor)?
                .ok_or_else(|| not_found(&input.name))?;
            let summary = repo_summary(RepoSkill {
                name: input.name.clone(),
                origin,
                description: description_of(&text),
                path,
            });
            (summary, text)
        }
        (_, None) => {
            return Err(ToolError::new(
                ErrorCode::Invalid,
                "Only a global skill is read without projectRef.",
            ));
        }
    };
    Ok(SkillGetOutput {
        skill,
        text: Text::unchecked(text),
        next: None,
        truncated: None,
    })
}

async fn skill_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: SkillSetInput,
) -> Result<SkillSetOutput, ToolError> {
    require_human(&caller, "skill_set")?;
    let r = scope_project(&hub, &caller, input.scope, input.project_ref.as_ref())?;
    let kept = hub.db.skills().set(
        input.scope,
        r,
        &input.name,
        input.text.as_str(),
        input.create == Some(true),
    )?;
    changed(
        &hub,
        r,
        std::slice::from_ref(&input.name),
        caller.name.as_str(),
    )?;
    Ok(SkillSetOutput {
        skill: kept.summary(),
        next: Some("Saved. Sessions get it from their next start.".into()),
        truncated: None,
    })
}

async fn skill_delete(
    hub: Arc<Hub>,
    caller: Caller,
    input: SkillDeleteInput,
) -> Result<SkillDeleteOutput, ToolError> {
    require_human(&caller, "skill_delete")?;
    let r = scope_project(&hub, &caller, input.scope, input.project_ref.as_ref())?;
    if !hub.db.skills().delete(input.scope, r, &input.name)? {
        return Err(not_found(&input.name));
    }
    changed(
        &hub,
        r,
        std::slice::from_ref(&input.name),
        caller.name.as_str(),
    )?;
    Ok(SkillDeleteOutput {
        ok: True,
        next: None,
        truncated: None,
    })
}

/// Fetches `given` and keeps its skills (or `want`) in the scope, pinned to the commit fetched. `local` lets a
/// source on the hub's own disk through (a person's install, never a lead's).
pub async fn install_from(
    hub: &Hub,
    scope: SkillScope,
    r: Option<&ProjectRef>,
    given: &str,
    want: Option<&SkillName>,
    local: bool,
) -> Result<(Vec<Kept>, String), SkillError> {
    let source = install::parse(given)?;
    if install::is_local(&source) && !local {
        return Err(SkillError::new(
            ErrorCode::Forbidden,
            "A lead installs from a remote source only.",
            Some(
                "Give owner/repo or a GitHub URL; a person can install a local one from Settings > Skills.",
            ),
        ));
    }
    let want = want.or(source.skill.as_ref());
    let fetched = install::fetch(&source).await?;
    let found = install::find(fetched.tree.path(), &source, want)?;
    let at = iso_ms(now_ms(hub.clock.as_ref()));
    let folders: Vec<_> = found
        .into_iter()
        .map(|f| {
            let record = install::record(given, &source, &fetched.commit, &f.path, &at);
            (f.name, f.files, record)
        })
        .collect();
    let kept = hub.db.skills().put_folders(scope, r, &folders)?;
    Ok((kept, fetched.commit))
}

async fn skill_install(
    hub: Arc<Hub>,
    caller: Caller,
    input: SkillInstallInput,
) -> Result<SkillInstallOutput, ToolError> {
    require_human(&caller, "skill_install")?;
    let r = scope_project(&hub, &caller, input.scope, input.project_ref.as_ref())?;
    let (kept, commit) = install_from(
        &hub,
        input.scope,
        r,
        input.source.as_str(),
        input.skill.as_ref(),
        true,
    )
    .await?;
    let names: Vec<SkillName> = kept.iter().map(|k| k.name.clone()).collect();
    changed(&hub, r, &names, caller.name.as_str())?;
    Ok(SkillInstallOutput {
        installed: List::unchecked(kept.iter().map(Kept::summary).collect()),
        next: Some(format!(
            "Pinned to {}. Sessions get it from their next start; Update fetches newer commits.",
            &commit[..12.min(commit.len())]
        )),
        truncated: None,
    })
}

async fn skill_update(
    hub: Arc<Hub>,
    caller: Caller,
    input: SkillUpdateInput,
) -> Result<SkillUpdateOutput, ToolError> {
    require_human(&caller, "skill_update")?;
    let r = scope_project(&hub, &caller, input.scope, input.project_ref.as_ref())?;
    let kept = hub
        .db
        .skills()
        .get(input.scope, r, &input.name)
        .ok_or_else(|| not_found(&input.name))?;
    let Some(pin) = kept.install else {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "{} was written here, not installed: it has no source to update from.",
                input.name
            ),
        ));
    };
    let source = install::source_of(&pin);
    let fetched = install::fetch(&source).await?;
    if fetched.commit == pin.commit.as_str() {
        return Ok(SkillUpdateOutput {
            skill: hub
                .db
                .skills()
                .get(input.scope, r, &input.name)
                .ok_or_else(|| not_found(&input.name))?
                .summary(),
            updated: false,
            next: Some("Already at the newest commit.".into()),
            truncated: None,
        });
    }
    let found = install::find(fetched.tree.path(), &source, Some(&input.name))?;
    let at = iso_ms(now_ms(hub.clock.as_ref()));
    let folders: Vec<_> = found
        .into_iter()
        .map(|f| {
            let record =
                install::record(pin.source.as_str(), &source, &fetched.commit, &f.path, &at);
            (f.name, f.files, record)
        })
        .collect();
    let kept = hub.db.skills().put_folders(input.scope, r, &folders)?;
    changed(
        &hub,
        r,
        std::slice::from_ref(&input.name),
        caller.name.as_str(),
    )?;
    Ok(SkillUpdateOutput {
        skill: kept[0].summary(),
        updated: true,
        next: Some("Updated. Sessions get it from their next start.".into()),
        truncated: None,
    })
}
