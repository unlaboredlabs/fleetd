//! project_repo_add, project_repo_list and project_repo_remove (W79): the repos a project holds besides its own
//! directory. A repo's files are a node checkout, a node "project" like any other, on the project's machine: adding
//! one by path or by clone goes the way project_add does, then records the checkout as a repo of the project. While a
//! project holds it, the checkout doesn't show as a project of its own; one that was a project with its own chat and
//! history is archived read-only (`repos::holder`): its lead is stopped, and refused every start, wake and spawn. Its tasks end when the repo is removed (`leads::removals`); nothing
//! on disk is deleted.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::{
    ErrorCode, ProjectRepoAddInput, ProjectRepoAddOutput, ProjectRepoListInput,
    ProjectRepoListOutput, ProjectRepoRemoveInput, ProjectRepoRemoveOutput,
};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::node_link::CAP_PROJECT_ENV_COPY;
use fleetd_contracts::projects::{AddId, ProjectAddedData, ProjectInspect, ProjectProblemCode};
use fleetd_contracts::repos::{ProjectRepo, RepoName};
use fleetd_contracts::sessions::RepoFacts;

use super::{CloneInto, problem, problem_error};
use crate::hub::api::{Caller, Hub, Registry, ToolError, error, require, unknown_project};
use crate::hub::store::NewEvent;

pub fn register(tools: &mut Registry) {
    tools.add("project_repo_add", add);
    tools.add("project_repo_list", list);
    tools.add("project_repo_remove", remove);
}

/// The project, if the caller may act on it with `role` and it isn't itself archived as another project's repo.
fn target(
    hub: &Hub,
    caller: &Caller,
    role: Role,
    machine_id: &MachineId,
    project_id: &ProjectId,
) -> Result<(ProjectRef, ProjectSummary), ToolError> {
    require(caller, role, Some(machine_id))?;
    let r = ProjectRef {
        machine_id: machine_id.clone(),
        project_id: project_id.clone(),
    };
    let Some(project) = hub.store.project_get(&r)? else {
        return Err(unknown_project(&r));
    };
    if role != Role::Read {
        not_archived(hub, &r)?;
    }
    Ok((r, project))
}

/// Refused for a project archived as another project's repo checkout.
fn not_archived(hub: &Hub, r: &ProjectRef) -> Result<(), ToolError> {
    match crate::hub::repos::holder(&hub.db, r)? {
        Some((holder, repo)) => {
            let (message, fix) = crate::hub::repos::archived_note(&holder, &repo);
            Err(error(ErrorCode::Invalid, message, fix))
        }
        None => Ok(()),
    }
}

/// The checkouts of the project's repos other than its own directory, on its machine: where its environment also
/// goes.
pub fn other_checkouts(hub: &Hub, r: &ProjectRef) -> Result<Vec<ProjectRef>, ToolError> {
    Ok(hub
        .repos
        .repos_of(r)?
        .into_iter()
        .map(|repo| repo.checkout)
        .filter(|c| c != r && c.machine_id == r.machine_id)
        .collect())
}

async fn add(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectRepoAddInput,
) -> Result<ProjectRepoAddOutput, ToolError> {
    let (r, _) = target(
        &hub,
        &caller,
        Role::Operate,
        &input.machine_id,
        &input.project_id,
    )?;
    let m = r.machine_id.clone();
    if let Some(name) = &input.name
        && hub.repos.repo_by_name(&r, name)?.is_some()
    {
        return Err(error(
            ErrorCode::Invalid,
            format!("The project already has a repo named {name}."),
            "Give another name, or leave it out for one made from the repo's",
        ));
    }
    super::repo_node(&hub, &m).map_err(|p| problem_error(&p))?;
    if let Some(path) = &input.path {
        let path = path.as_str().strip_suffix('/').unwrap_or(path.as_str());
        if hub.executors.project_at(&m, path).as_ref() == Some(&r.project_id) {
            return Err(own_directory(path));
        }
        let facts = git_checkout(&hub, &m, path).await?;
        let inspect = super::inspect_checkout(&facts).await?;
        let (repo, archived) =
            attach_checkout(&hub, &r, input.name.as_ref(), path, &facts, inspect, None).await?;
        return Ok(added(&m, repo, archived));
    }
    let url = input.url.as_ref().expect("checked on decode");
    let repo = super::repo_of(url.as_str())?;
    // Before cloning: does gh see it, and is the destination free?
    super::read_github(&repo, None).await?;
    let target =
        super::clone_target(&hub, &m, &repo, input.dest.as_ref().map(|d| d.as_str())).await?;
    if target.exists {
        if target.same_remote && input.use_existing == Some(true) {
            let facts = git_checkout(&hub, &m, &target.path).await?;
            let inspect = super::inspect_checkout(&facts).await?;
            let (repo, archived) = attach_checkout(
                &hub,
                &r,
                input.name.as_ref(),
                &target.path,
                &facts,
                inspect,
                None,
            )
            .await?;
            return Ok(added(&m, repo, archived));
        }
        return Err(super::dest_taken(&m, &repo, &target));
    }
    let run = hub.executors.clone_start();
    let add_id = AddId::unchecked(run.add_id.as_str());
    let path = target.path.clone();
    tokio::spawn(super::clone_and_register(
        hub.clone(),
        m.clone(),
        repo,
        path.clone(),
        CloneInto::Repo {
            project: r,
            name: input.name,
        },
        run,
    ));
    Ok(ProjectRepoAddOutput {
        path: path.clone(),
        repo: None,
        add_id: Some(add_id.clone()),
        archived: None,
        next: Some(format!(
            "Cloning into {path} on {m}. Follow events_wait for project.clone_progress, then project.added or project.add_failed with data.addId {add_id}."
        )),
        truncated: None,
    })
}

fn added(m: &MachineId, repo: ProjectRepo, archived: Option<ProjectRef>) -> ProjectRepoAddOutput {
    let path = repo.path.clone().unwrap_or_default();
    let next_path = path.clone();
    let mut next = format!(
        "{} is a repo of the project now, at {path} on {m}.",
        repo.name
    );
    if let Some(old) = &archived {
        next.push_str(&format!(
            " The project {} it was is archived: its chat and history stay, its lead no longer runs.",
            old.project_id
        ));
    }
    ProjectRepoAddOutput {
        path: next_path,
        repo: Some(repo),
        add_id: None,
        archived,
        next: Some(next),
        truncated: None,
    }
}

fn own_directory(path: &str) -> ToolError {
    error(
        ErrorCode::Invalid,
        format!("{path} is the project's own directory."),
        "Give another checkout",
    )
}

/// The directory at `path`, which must be a git checkout to be a repo.
async fn git_checkout(hub: &Hub, m: &MachineId, path: &str) -> Result<RepoFacts, ToolError> {
    let facts = super::checkout(hub, m, path).await?;
    if !facts.is_git {
        return Err(problem_error(&problem(
            ProjectProblemCode::NotAGitRepo,
            format!("{path} on {m} is not a git repository"),
            "Give the repository's root directory, or run `git init` there first",
        )));
    }
    Ok(facts)
}

/// Records the checkout at `path` on the project's machine as a repo of the project: registered on the node when it
/// isn't a project yet, else archived when it is one of its own. The project's environment is copied to it, and
/// `project.added` (the project's) says so. Returns the repo, and the project archived.
pub(super) async fn attach_checkout(
    hub: &Hub,
    r: &ProjectRef,
    name: Option<&RepoName>,
    path: &str,
    facts: &RepoFacts,
    inspect: ProjectInspect,
    add_id: Option<AddId>,
) -> Result<(ProjectRepo, Option<ProjectRef>), ToolError> {
    let m = &r.machine_id;
    // Again, for a clone that ends after the project was removed or archived.
    if hub.store.project_get(r)?.is_none() {
        return Err(unknown_project(r));
    }
    not_archived(hub, r)?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let existing = hub.executors.project_at(m, path);
    let created = existing.is_none();
    let mut archived = None;
    let checkout = match existing {
        Some(id) if id == r.project_id => return Err(own_directory(path)),
        Some(id) => {
            let checkout = ProjectRef {
                machine_id: m.clone(),
                project_id: id,
            };
            if let Some(repo) = hub
                .repos
                .repos_of(r)?
                .into_iter()
                .find(|repo| repo.checkout == checkout)
            {
                return Err(error(
                    ErrorCode::Invalid,
                    format!("{path} is already the project's repo {}.", repo.name),
                    "project_repo_list shows its repos",
                ));
            }
            if hub
                .repos
                .repos_of(&checkout)?
                .iter()
                .any(|repo| repo.checkout != checkout)
            {
                return Err(error(
                    ErrorCode::Invalid,
                    format!("{path} is a project that holds repos of its own."),
                    "Remove its other repos first (project_repo_remove), or add those repos to this project instead",
                ));
            }
            // A project of its own until now (no project held it yet): it is archived, once nothing runs in it.
            if hub.repos.holders(&checkout)?.is_empty() {
                if !hub.tasks.live(Some(&checkout)).is_empty() {
                    return Err(error(
                        ErrorCode::Invalid,
                        format!(
                            "{path} is the project {} and its agents still run.",
                            checkout.project_id
                        ),
                        "Stop them first (project_stop, or the chat's Stop), then add it",
                    ));
                }
                archived = Some(checkout.clone());
            }
            checkout
        }
        None => {
            let id = ProjectId::unchecked(crate::hub::executor::new_uuid().as_str());
            let title = path.rsplit('/').next().unwrap_or(path);
            hub.executors
                .project_upsert(m, &id, title, path)
                .await
                .map_err(crate::hub::executor::tools::from_executor)?;
            ProjectRef {
                machine_id: m.clone(),
                project_id: id,
            }
        }
    };
    super::bind_scope(hub, m, &checkout.project_id, facts);
    if let Err(error) = hub.repos.ensure_own(&checkout, Some(path)) {
        tracing::warn!(%error, "the checkout's own repo was not recorded");
    }
    let mut repo = hub.repos.attach(r, name, &checkout, path)?;
    repo.path.get_or_insert_with(|| path.to_owned());
    // Archived from here: its lead is refused every start and wake, and the session it has now is stopped.
    if let Some(old) = &archived
        && let Some(lead) = hub.leads.records.lead_get(old)?
    {
        let thread = fleetd_contracts::ids::ThreadRef {
            machine_id: m.clone(),
            thread_id: lead.thread_id,
        };
        if let Err(error) = hub.executors.stop(&thread, false).await {
            tracing::warn!(%error, "the archived project's lead was not stopped");
        }
    }
    if hub.link.node_can(m, CAP_PROJECT_ENV_COPY)
        && let Err(error) = hub
            .executors
            .project_env_copy(m, &r.project_id, &checkout.project_id)
            .await
    {
        tracing::warn!(%error, "the project's environment was not copied to its new repo");
    }
    let title = hub
        .store
        .project_get(r)?
        .map_or_else(|| r.project_id.to_string(), |p| p.title);
    let summary = format!(
        "{} added to {title} on {m}: {}",
        repo.name, inspect.lead_needs
    );
    let data = super::inspect::fit_added(ProjectAddedData {
        add_id,
        title,
        path: path.to_owned(),
        created,
        inspect,
    });
    hub.events.append(NewEvent {
        at: super::now(hub),
        r#type: HubEventType::ProjectAdded,
        machine_id: Some(m.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: crate::hub::executor::shell_mapper::js_take(&summary, 200).to_owned(),
        data: serde_json::to_value(&data).ok(),
        attention: None,
    })?;
    Ok((repo, archived))
}

async fn list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectRepoListInput,
) -> Result<ProjectRepoListOutput, ToolError> {
    let (r, _) = target(
        &hub,
        &caller,
        Role::Read,
        &input.machine_id,
        &input.project_id,
    )?;
    let repos = hub.repos.repos_of(&r)?;
    let next = if repos.is_empty() {
        "A plain folder: project_repo_add adds a repo by path or GitHub URL."
    } else {
        "project_repo_add adds another; project_repo_remove takes one out."
    };
    Ok(ProjectRepoListOutput {
        repos,
        next: Some(next.into()),
        truncated: None,
    })
}

async fn remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectRepoRemoveInput,
) -> Result<ProjectRepoRemoveOutput, ToolError> {
    let (r, _) = target(
        &hub,
        &caller,
        Role::Operate,
        &input.machine_id,
        &input.project_id,
    )?;
    let repo = super::settings::repo_named(&hub, &r, Some(&input.name))?.expect("named");
    if repo.checkout == r {
        return Err(error(
            ErrorCode::Invalid,
            format!("{} is the project's own directory.", repo.name),
            "project_remove removes the project itself",
        ));
    }
    hub.repos.detach(&r, &repo.name)?;
    // Keyed on `repos`: a stop before this ends them at the next start.
    let cancelled = hub
        .leads
        .removals
        .end_removed_repos()
        .await
        .map_err(ToolError::from)?;
    // Every client lists the project's repos and its projects again.
    hub.events.append(NewEvent {
        at: super::now(&hub),
        r#type: HubEventType::ProjectSettings,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: format!("{} removed from the project", repo.name),
        data: Some(serde_json::json!({ "repoRemoved": repo.name })),
        attention: None,
    })?;
    let path = repo
        .path
        .clone()
        .unwrap_or_else(|| repo.checkout.project_id.to_string());
    let mut next = format!(
        "Its checkout stays at {path} on {}, files and all.",
        repo.checkout.machine_id
    );
    if hub.repos.holders(&repo.checkout)?.is_empty() {
        next.push_str(
            " No project holds it now, so it shows as a project of its own again; project_remove forgets it (its files stay).",
        );
    }
    Ok(ProjectRepoRemoveOutput {
        removed: repo,
        cancelled,
        next: Some(next),
        truncated: None,
    })
}
