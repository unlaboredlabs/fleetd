//! Adding a project, the one path MCP, the app and the CLI share: discover repos, inspect one, add a path (a git
//! checkout or a plain folder) or clone a GitHub repository with progress events, and remove. The node does the filesystem and git work on its machine;
//! gh runs on the hub machine, and `gh repo list` falls back to the target worker when the hub has no gh login.
pub mod avatar;
#[cfg(test)]
mod avatar_tests;
#[cfg(test)]
mod create_tests;
pub mod icon;
#[cfg(test)]
mod icon_tests;
pub mod inspect;
pub mod order_env;
pub mod profiles;
#[cfg(test)]
mod profiles_tests;
pub mod repos;
#[cfg(test)]
mod repos_tests;
pub mod settings;
#[cfg(test)]
mod settings_tests;
pub mod tools;

use std::sync::Arc;
use std::time::{Duration, Instant};

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::{
    ErrorCode, ProjectAddInput, ProjectAddOutput, ProjectDiscoverInput, ProjectDiscoverOutput,
};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::prim::Text;
use fleetd_contracts::projects::{
    AddId, Checkout, ClonePhase, CloneProgressData, CloneTarget, FoundRepo, GitHubCandidate,
    GitHubRepos, MachineRepos, ProjectAddFailedData, ProjectAddedData, ProjectInspect,
    ProjectProblem, ProjectProblemCode, github_repo, short_remote,
};
use fleetd_contracts::repos::RepoName;
use fleetd_contracts::sessions::{GhRepos, RepoFacts};
use fleetd_contracts::train::GitHubRepo;
use futures_util::future::join_all;

use crate::hub::api::{Caller, Hub, ToolError, allows, error, require};
use crate::hub::executor::ExecutorError;
use crate::hub::store::NewEvent;
#[cfg(not(test))]
use crate::hub::train::github::SystemGh;
use crate::hub::train::github::{GhErrorKind, TrainGitHub};
use inspect::{GitHubAnswers, Worker};

/// gh runs here, on the hub machine. An inspection is not a train read, so it feeds no status source. Tests never run
/// the real gh: there it reads as missing.
fn github() -> TrainGitHub {
    #[cfg(not(test))]
    let gh = Arc::new(SystemGh);
    #[cfg(test)]
    let gh = Arc::new(NoGh);
    TrainGitHub::new(
        gh,
        Arc::new(crate::hub::status::fresh::Fresh::default()),
        Arc::new(crate::clock::SystemClock),
    )
}

#[cfg(test)]
struct NoGh;

#[cfg(test)]
impl crate::hub::train::github::GhRunner for NoGh {
    fn run(
        &self,
        _: Vec<String>,
    ) -> crate::hub::train::host::BoxFut<'_, Result<crate::hub::train::github::GhOut, String>> {
        Box::pin(async { Err("ENOENT".into()) })
    }
}

fn now(hub: &Hub) -> fleetd_contracts::ids::Timestamp {
    crate::hub::checks::now_ts(hub.clock.as_ref())
}

fn problem_error(p: &ProjectProblem) -> ToolError {
    let code = match p.code {
        ProjectProblemCode::MachineOffline => ErrorCode::MachineOffline,
        ProjectProblemCode::GhNoAccess | ProjectProblemCode::PathMissing => ErrorCode::NotFound,
        ProjectProblemCode::NoWorker
        | ProjectProblemCode::NotAGitRepo
        | ProjectProblemCode::DestExists => ErrorCode::Invalid,
        _ => ErrorCode::Failed,
    };
    error(code, p.message.clone(), p.fix.clone().unwrap_or_default())
}

fn problem(
    code: ProjectProblemCode,
    message: impl Into<String>,
    fix: impl Into<String>,
) -> ProjectProblem {
    ProjectProblem {
        code,
        message: message.into(),
        fix: Some(fix.into()),
    }
}

/// Whether `m`'s node can take the repo calls now. An older node drops its link on a call it can't decode, so it is
/// never sent one.
fn repo_node(hub: &Hub, m: &MachineId) -> Result<(), ProjectProblem> {
    inspect::repo_gate(
        m,
        hub.executors.is_connected(m),
        hub.link.node_can(m, fleetd_contracts::node_link::CAP_REPOS),
    )
}

fn node_problem(m: &MachineId, e: &ExecutorError) -> ProjectProblem {
    match e {
        ExecutorError::MachineNotConnected { .. } => problem(
            ProjectProblemCode::MachineOffline,
            format!("{m} is offline"),
            format!("Start the node on {m} (fleetd node run) or check its network, then retry"),
        ),
        // An older node can't decode the call and never answers it.
        ExecutorError::NodeRequestFailed { message, .. }
            if message.starts_with("no answer within") =>
        {
            problem(
                ProjectProblemCode::NodeTooOld,
                format!("{m}'s node did not answer: it may predate adding projects"),
                format!("Run fleetd update on {m}"),
            )
        }
        e => problem(
            ProjectProblemCode::Other,
            e.to_string(),
            format!("fleetd doctor shows what is wrong on {m}"),
        ),
    }
}

/// Every machine as a clone target, for [`inspect::best_worker`].
fn workers(hub: &Hub) -> Vec<Worker> {
    let running = hub.executors.running();
    hub.store
        .machines_list()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let id = m.machine_id;
            Worker {
                connected: hub.executors.is_connected(&id) && m.status != MachineStatus::Offline,
                capable: hub
                    .link
                    .node_can(&id, fleetd_contracts::node_link::CAP_REPOS),
                ready: hub.executors.is_ready(&id),
                running: running
                    .iter()
                    .filter(|r| r.thread_ref.machine_id == id)
                    .count(),
                load: hub
                    .link
                    .load(&id)
                    .map(|l| l.load1.get() / l.cpus.get().max(1) as f64),
                machine_id: id,
            }
        })
        .collect()
}

pub fn best_worker(hub: &Hub) -> Option<MachineId> {
    inspect::best_worker(&workers(hub))
}

pub(crate) fn target_machine(hub: &Hub, given: Option<&MachineId>) -> Result<MachineId, ToolError> {
    let m = match given {
        Some(m) => m.clone(),
        None => best_worker(hub).ok_or_else(|| {
            problem_error(&problem(
                ProjectProblemCode::NoWorker,
                "no machine is online to add the project on",
                "Start a node (fleetd node run on the machine) or pass a machine id",
            ))
        })?,
    };
    if hub.store.machine_get(&m)?.is_none() {
        return Err(crate::hub::api::unknown_machine(&m));
    }
    repo_node(hub, &m).map_err(|p| problem_error(&p))?;
    Ok(m)
}

fn repo_of(text: &str) -> Result<GitHubRepo, ToolError> {
    github_repo(text).ok_or_else(|| {
        error(
            ErrorCode::Invalid,
            format!("{text} is not a GitHub repository"),
            "Give https://github.com/owner/repo, git@github.com:owner/repo.git or owner/repo",
        )
    })
}

fn remote_repo(facts: &RepoFacts) -> Option<GitHubRepo> {
    facts.remote.as_deref().and_then(github_repo)
}

/// GitHub's view of `repo` through the hub's gh. `Err` only when gh is logged in but cannot see the repository.
async fn read_github(
    repo: &GitHubRepo,
    local: Option<&RepoFacts>,
) -> Result<ProjectInspect, ToolError> {
    let gh = github();
    let r = repo.as_str();
    let mut answers = GitHubAnswers::default();
    let mut notes = Vec::new();
    let mut gh_ok = true;
    match gh.get(&format!("repos/{r}")).await {
        Ok(Ok(v)) => answers.repo = Some(v),
        Ok(Err((404, _))) => {
            return Err(problem_error(&problem(
                ProjectProblemCode::GhNoAccess,
                format!(
                    "gh on the hub can't see {r}: it is private to another account, renamed, or misspelled"
                ),
                format!(
                    "Check the name; or run `gh auth login` on the hub machine with an account that can read {r}"
                ),
            )));
        }
        Ok(Err((status, message))) => answers
            .unread
            .push(format!("{r} (HTTP {status}: {message})")),
        Err(e) if e.kind == GhErrorKind::Failed => {
            answers.unread.push(format!("{r} ({})", e.message))
        }
        Err(e) => {
            gh_ok = false;
            notes.push(e.message);
        }
    }
    if answers.repo.is_some() {
        let branch = answers
            .repo
            .as_ref()
            .and_then(|v| v.get("default_branch"))
            .and_then(|v| v.as_str())
            .unwrap_or("main")
            .to_owned();
        let read = |path: String| {
            let gh = gh.clone();
            async move {
                match gh.get(&path).await {
                    Ok(Ok(v)) => Ok(v),
                    Ok(Err((status, message))) => Err(format!("HTTP {status}: {message}")),
                    Err(e) => Err(e.message),
                }
            }
        };
        let (b, rules, sets, wf) = tokio::join!(
            read(format!("repos/{r}/branches/{branch}")),
            read(format!("repos/{r}/rules/branches/{branch}")),
            read(format!("repos/{r}/rulesets")),
            read(format!("repos/{r}/actions/workflows")),
        );
        let mut take = |what: &str, got: Result<serde_json::Value, String>| match got {
            Ok(v) => Some(v),
            Err(why) => {
                answers.unread.push(format!("{what} ({why})"));
                None
            }
        };
        let (branch_v, rules_v, wf_v) = (
            take("branch protection", b),
            take("branch rules", rules),
            take("workflows", wf),
        );
        answers.branch = branch_v;
        answers.rules = rules_v;
        answers.workflows = wf_v;
        // Without ruleset names the rules still apply; they show as "ruleset <id>".
        answers.rulesets = sets.ok();
    }
    Ok(inspect::build(Some(repo), &answers, local, notes, gh_ok))
}

/// A checkout's inspect: GitHub's view when its remote is on GitHub, else what the checkout itself shows; a plain
/// folder's says so.
async fn inspect_checkout(facts: &RepoFacts) -> Result<ProjectInspect, ToolError> {
    if !facts.is_git {
        return Ok(inspect::folder());
    }
    match remote_repo(facts) {
        Some(repo) => read_github(&repo, Some(facts)).await,
        None => Ok(inspect::build(
            None,
            &GitHubAnswers::default(),
            Some(facts),
            vec![],
            true,
        )),
    }
}

/// The directory at `path` on `m` (a git checkout, or a plain folder), or why it can't be a project.
async fn checkout(hub: &Hub, m: &MachineId, path: &str) -> Result<RepoFacts, ToolError> {
    repo_node(hub, m).map_err(|p| problem_error(&p))?;
    let facts = hub
        .executors
        .repo_inspect(m, path)
        .await
        .map_err(|e| problem_error(&node_problem(m, &e)))?;
    if !facts.exists {
        return Err(problem_error(&problem(
            ProjectProblemCode::PathMissing,
            format!("{path} does not exist on {m}"),
            format!(
                "Check the path on {m}, or clone the repo there by giving its GitHub URL instead"
            ),
        )));
    }
    Ok(facts)
}

async fn clone_target(
    hub: &Hub,
    m: &MachineId,
    repo: &GitHubRepo,
    dest: Option<&str>,
) -> Result<CloneTarget, ToolError> {
    repo_node(hub, m).map_err(|p| problem_error(&p))?;
    let path = match dest {
        Some(d) => d.strip_suffix('/').unwrap_or(d).to_owned(),
        None => {
            let root = hub
                .executors
                .repo_scan(m)
                .await
                .map_err(|e| problem_error(&node_problem(m, &e)))?
                .clone_root;
            let name = repo.as_str().rsplit('/').next().unwrap_or(repo.as_str());
            format!("{}/{name}", root.trim_end_matches('/'))
        }
    };
    let facts = hub
        .executors
        .repo_inspect(m, &path)
        .await
        .map_err(|e| problem_error(&node_problem(m, &e)))?;
    Ok(CloneTarget {
        machine_id: m.clone(),
        same_remote: facts.is_git && remote_repo(&facts).as_ref() == Some(repo),
        exists: facts.exists,
        project_id: hub.executors.project_at(m, &path),
        path,
    })
}

pub async fn discover(
    hub: &Hub,
    caller: &Caller,
    input: ProjectDiscoverInput,
) -> Result<ProjectDiscoverOutput, ToolError> {
    let machines: Vec<MachineId> = hub
        .store
        .machines_list()?
        .into_iter()
        .map(|m| m.machine_id)
        .filter(|m| input.machine_id.as_ref().is_none_or(|only| only == m))
        .filter(|m| allows(caller, Role::Read, Some(m)))
        .collect();
    let scans = join_all(machines.iter().map(|m| async move {
        if let Err(problem) = repo_node(hub, m) {
            return MachineRepos {
                machine_id: m.clone(),
                online: hub.executors.is_connected(m),
                clone_root: None,
                projects_root: None,
                repos: vec![],
                problem: Some(problem),
            };
        }
        match hub.executors.repo_scan(m).await {
            Ok(scan) => MachineRepos {
                machine_id: m.clone(),
                online: true,
                clone_root: Some(scan.clone_root),
                projects_root: scan.projects_root,
                repos: scan
                    .repos
                    .into_iter()
                    .map(|r| FoundRepo {
                        name: r.path.rsplit('/').next().unwrap_or(&r.path).to_owned(),
                        project_id: hub.executors.project_at(m, &r.path),
                        repo: r.remote.as_deref().and_then(github_repo),
                        remote: r.remote.as_deref().map(short_remote),
                        path: r.path,
                    })
                    .collect(),
                problem: None,
            },
            Err(e) => MachineRepos {
                machine_id: m.clone(),
                online: true,
                clone_root: None,
                projects_root: None,
                repos: vec![],
                problem: Some(node_problem(m, &e)),
            },
        }
    }))
    .await;
    let best = best_worker(hub);
    let github = if input.github == Some(false) {
        GitHubRepos {
            gh_on: None,
            owners: vec![],
            repos: vec![],
            problem: None,
        }
    } else {
        gh_list(
            hub,
            input.machine_id.clone().or_else(|| best.clone()),
            &scans,
        )
        .await
    };
    Ok(ProjectDiscoverOutput {
        machines: scans,
        github,
        best,
        next: Some("Add one with project_add (path on a machine, or url to clone); project_add with dryRun shows its CI and merge rules first.".into()),
        truncated: None,
    })
}

/// `gh repo list` on the hub, else on `fallback`'s node.
async fn gh_list(hub: &Hub, fallback: Option<MachineId>, scans: &[MachineRepos]) -> GitHubRepos {
    let mut listed: GhRepos = crate::node::repos::gh_repo_list().await;
    let mut gh_on = Some("hub".to_owned());
    let hub_problem = listed.problem.clone();
    if hub_problem.is_some()
        && let Some(m) = fallback
        && repo_node(hub, &m).is_ok()
        && let Ok(theirs) = hub.executors.gh_repo_list(&m).await
        && theirs.problem.is_none()
    {
        listed = theirs;
        gh_on = Some(m.to_string());
    }
    let problem = listed.problem.as_ref().map(|p| {
        problem(
            ProjectProblemCode::GhUnavailable,
            format!(
                "gh repo list did not run: {p} on the hub{}",
                if gh_on.as_deref() == Some("hub") {
                    ""
                } else {
                    " or the worker"
                }
            ),
            "Run `gh auth login` on the hub machine, or paste the repository's URL",
        )
    });
    if problem.is_some() {
        gh_on = None;
    }
    let repos = listed
        .repos
        .into_iter()
        .filter_map(|r| {
            let repo = GitHubRepo::new(&r.name_with_owner).ok()?;
            let checkouts = scans
                .iter()
                .flat_map(|s| {
                    s.repos
                        .iter()
                        .filter(|f| f.repo.as_ref() == Some(&repo))
                        .map(|f| Checkout {
                            machine_id: s.machine_id.clone(),
                            path: f.path.clone(),
                            project_id: f.project_id.clone(),
                        })
                })
                .collect();
            Some(GitHubCandidate {
                repo,
                url: r.url,
                private: r.is_private,
                description: r
                    .description
                    .map(|d| Text::unchecked(crate::hub::executor::shell_mapper::js_take(&d, 300))),
                pushed_at: r.pushed_at,
                checkouts,
            })
        })
        .collect();
    GitHubRepos {
        gh_on,
        owners: listed.owners,
        repos,
        problem,
    }
}

/// Registers `path` on `m` (the same directory again is the same project; a title renames it) and emits
/// `project.added` with the inspect. Returns the inspect it emitted.
async fn register(
    hub: &Hub,
    m: &MachineId,
    path: &str,
    title: Option<&str>,
    facts: &RepoFacts,
    inspect: ProjectInspect,
    add_id: Option<AddId>,
) -> Result<(ProjectId, bool, ProjectInspect), ToolError> {
    let path = path.strip_suffix('/').unwrap_or(path);
    let name = path.rsplit('/').next().unwrap_or(path);
    let existing = hub.executors.project_at(m, path);
    let created = existing.is_none();
    let project_id =
        existing.unwrap_or_else(|| ProjectId::unchecked(crate::hub::executor::new_uuid().as_str()));
    let title = title.unwrap_or(name).to_owned();
    if created || title != name {
        hub.executors
            .project_upsert(m, &project_id, &title, path)
            .await
            .map_err(crate::hub::executor::tools::from_executor)?;
    }
    bind_scope(hub, m, &project_id, facts);
    // A git checkout is the project's own repo, with a remote or without; a plain folder holds none.
    let project = ProjectRef {
        machine_id: m.clone(),
        project_id: project_id.clone(),
    };
    if facts.is_git
        && let Err(error) = hub.repos.ensure_own(&project, Some(path))
    {
        tracing::warn!(%error, "the project's own repo was not recorded");
    }
    let summary = format!("{title} added on {m}: {}", inspect.lead_needs);
    // The event log keeps at most 2 KB of data; a dry-run project_add has the whole inspect.
    let data = inspect::fit_added(ProjectAddedData {
        add_id,
        title,
        path: path.to_owned(),
        created,
        inspect: inspect.clone(),
    });
    hub.events.append(NewEvent {
        at: now(hub),
        r#type: HubEventType::ProjectAdded,
        machine_id: Some(m.clone()),
        project_id: Some(project_id.clone()),
        thread_id: None,
        summary: crate::hub::executor::shell_mapper::js_take(&summary, 200).to_owned(),
        data: serde_json::to_value(&data).ok(),
        attention: None,
    })?;
    Ok((project_id, created, inspect))
}

/// Records the repo and base the project's work lands on, from what adding it read. `work::bind_from_root` reads
/// them again for a project that has none recorded.
fn bind_scope(hub: &Hub, m: &MachineId, project_id: &ProjectId, facts: &RepoFacts) {
    let repo_key = facts
        .remote
        .as_deref()
        .and_then(fleetd_contracts::work::RepoKey::of);
    let base = facts
        .default_branch
        .as_deref()
        .and_then(|b| fleetd_contracts::prim::Line::new(b).ok());
    let (Some(repo_key), Some(base)) = (repo_key, base) else {
        return;
    };
    let project = ProjectRef {
        machine_id: m.clone(),
        project_id: project_id.clone(),
    };
    let scope = fleetd_contracts::work::WorkScope { repo_key, base };
    if let Err(error) = hub.work.bind_project(&project, &scope) {
        tracing::warn!(%error, "the project's repo and base were not recorded");
    }
}

pub async fn add(
    hub: Arc<Hub>,
    caller: &Caller,
    input: ProjectAddInput,
) -> Result<ProjectAddOutput, ToolError> {
    if let Some(m) = &input.machine_id {
        require(caller, Role::Operate, Some(m))?;
    }
    let m = target_machine(&hub, input.machine_id.as_ref())?;
    require(caller, Role::Operate, Some(&m))?;
    let title = input.title.as_ref().map(|t| t.as_str().to_owned());
    let dry_run = input.dry_run == Some(true);
    if input.create == Some(true) {
        return create(&hub, &m, &input, dry_run).await;
    }
    if let Some(path) = &input.path {
        let path = path.as_str().strip_suffix('/').unwrap_or(path.as_str());
        let facts = checkout(&hub, &m, path).await?;
        let inspect = inspect_checkout(&facts).await?;
        if dry_run {
            return Ok(dry(m, path.to_owned(), inspect, None));
        }
        let (project_id, created, inspect) =
            register(&hub, &m, path, title.as_deref(), &facts, inspect, None).await?;
        return Ok(ProjectAddOutput {
            next: Some(format!(
                "{}. Write to its lead with chat_send; the lead starts with the first message.",
                inspect.lead_needs
            )),
            machine_id: m,
            path: path.to_owned(),
            project_id: Some(project_id),
            created,
            add_id: None,
            inspect: Some(inspect),
            clone: None,
            truncated: None,
        });
    }
    let url = input.url.as_ref().expect("checked on decode");
    let repo = repo_of(url.as_str())?;
    // Before cloning: does gh see it, and is the destination free?
    let github = read_github(&repo, None).await?;
    let target = clone_target(&hub, &m, &repo, input.dest.as_ref().map(|d| d.as_str())).await?;
    if dry_run {
        return Ok(dry(m, target.path.clone(), github, Some(target)));
    }
    if target.exists {
        if target.same_remote && input.use_existing == Some(true) {
            let facts = checkout(&hub, &m, &target.path).await?;
            let inspect = inspect_checkout(&facts).await?;
            let (project_id, created, inspect) = register(
                &hub,
                &m,
                &target.path,
                title.as_deref(),
                &facts,
                inspect,
                None,
            )
            .await?;
            return Ok(ProjectAddOutput {
                next: Some(inspect.lead_needs.to_string()),
                machine_id: m,
                path: target.path,
                project_id: Some(project_id),
                created,
                add_id: None,
                inspect: Some(inspect),
                clone: None,
                truncated: None,
            });
        }
        return Err(dest_taken(&m, &repo, &target));
    }
    let run = hub.executors.clone_start();
    let add_id = AddId::unchecked(run.add_id.as_str());
    let path = target.path.clone();
    tokio::spawn(clone_and_register(
        hub.clone(),
        m.clone(),
        repo,
        path.clone(),
        CloneInto::Project { title },
        run,
    ));
    Ok(ProjectAddOutput {
        next: Some(format!(
            "Cloning into {path} on {m}. Follow events_wait for project.clone_progress, then project.added or project.add_failed with data.addId {add_id}."
        )),
        machine_id: m,
        path,
        project_id: None,
        created: true,
        add_id: Some(add_id),
        inspect: None,
        clone: None,
        truncated: None,
    })
}

fn cant_make(m: &MachineId) -> ToolError {
    problem_error(&problem(
        ProjectProblemCode::NodeTooOld,
        format!("{m}'s node is too old to make a new project's folder"),
        format!("Run fleetd update on {m}, or pick another machine"),
    ))
}

/// Why the node didn't make the folder at `path`: it holds files already, or it can't be made there. The node names the
/// folder in each of its own refusals; anything else (a dropped link, no answer) is the machine's problem.
fn folder_refused(m: &MachineId, path: &str, e: ExecutorError) -> ToolError {
    match &e {
        ExecutorError::NodeRequestFailed { message, .. }
            if message.contains(fleetd_contracts::sessions::FOLDER_NOT_EMPTY) =>
        {
            problem_error(&problem(
                ProjectProblemCode::DestExists,
                format!("{path} on {m} already holds files"),
                "Pick another folder for the new project, or add that one as it is by typing its path",
            ))
        }
        ExecutorError::NodeRequestFailed { message, .. } if names_folder(message, path) => error(
            ErrorCode::Invalid,
            message.clone(),
            "Pick another folder for the new project",
        ),
        _ => problem_error(&node_problem(m, &e)),
    }
}

/// Whether the node's message names the folder at `path`: as given, or `~/x` as the node expands it (`/home/me/x`).
fn names_folder(message: &str, path: &str) -> bool {
    message.contains(path)
        || path
            .strip_prefix('~')
            .is_some_and(|tail| tail.starts_with('/') && message.contains(tail))
}

/// `project_add` with `create`: the node makes the folder (`path`, else `<projectsRoot>/<name>`), empty or new, and
/// `git init`s it when asked; then it is added as a `path` is, a plain folder with no repo unless it was.
async fn create(
    hub: &Hub,
    m: &MachineId,
    input: &ProjectAddInput,
    dry_run: bool,
) -> Result<ProjectAddOutput, ToolError> {
    if !hub
        .link
        .node_can(m, fleetd_contracts::node_link::CAP_FOLDER_MAKE)
    {
        return Err(cant_make(m));
    }
    let title = input.title.as_ref().map(|t| t.as_str().trim().to_owned());
    let path = match &input.path {
        Some(p) => p
            .as_str()
            .strip_suffix('/')
            .unwrap_or(p.as_str())
            .to_owned(),
        None => {
            let root = hub
                .executors
                .repo_scan(m)
                .await
                .map_err(|e| problem_error(&node_problem(m, &e)))?
                .projects_root
                .ok_or_else(|| cant_make(m))?;
            let name = crate::hub::navi::slug_or(title.as_deref().unwrap_or_default(), "project");
            format!("{}/{name}", root.trim_end_matches('/'))
        }
    };
    let git_init = input.git_init == Some(true);
    // Checked first, making nothing: the folder as the node names it, and whether it could be made.
    let path = hub
        .executors
        .folder_make(m, &path, false, true)
        .await
        .map_err(|e| folder_refused(m, &path, e))?;
    // An empty folder that is already a project is that project, never a new one under another name, and it is left
    // as it is: no git init.
    if let Some(id) = hub.executors.project_at(m, &path) {
        let title = hub
            .store
            .project_get(&ProjectRef {
                machine_id: m.clone(),
                project_id: id.clone(),
            })?
            .map_or_else(|| id.to_string(), |p| p.title);
        return Err(problem_error(&problem(
            ProjectProblemCode::DestExists,
            format!("{path} on {m} is already the project {title}"),
            "Open that project, or pick another folder for the new one",
        )));
    }
    if dry_run {
        return Ok(ProjectAddOutput {
            next: Some(format!(
                "project_add with create makes {path} on {m}, a new project."
            )),
            ..dry(m.clone(), path, inspect::folder(), None)
        });
    }
    let path = hub
        .executors
        .folder_make(m, &path, git_init, false)
        .await
        .map_err(|e| folder_refused(m, &path, e))?;
    let facts = checkout(hub, m, &path).await?;
    let inspect = inspect_checkout(&facts).await?;
    let (project_id, created, inspect) =
        register(hub, m, &path, title.as_deref(), &facts, inspect, None).await?;
    Ok(ProjectAddOutput {
        next: Some(format!(
            "{}. Write to its lead with chat_send; project_repo_add adds a repo later.",
            inspect.lead_needs
        )),
        machine_id: m.clone(),
        path,
        project_id: Some(project_id),
        created,
        add_id: None,
        inspect: Some(inspect),
        clone: None,
        truncated: None,
    })
}

/// Why a clone can't go to `target`, which already exists.
fn dest_taken(m: &MachineId, repo: &GitHubRepo, target: &CloneTarget) -> ToolError {
    let p = if target.same_remote {
        problem(
            ProjectProblemCode::DestExists,
            format!("{m} already has a checkout of {repo} at {}", target.path),
            "Add that checkout instead (useExisting), or clone into another folder (dest)",
        )
    } else {
        problem(
            ProjectProblemCode::DestExists,
            format!(
                "{} already exists on {m} and is not a checkout of {repo}",
                target.path
            ),
            "Clone into another folder (dest), or move that one away",
        )
    };
    problem_error(&p)
}

/// What a finished clone becomes: a project, or a repo of one.
enum CloneInto {
    Project {
        title: Option<String>,
    },
    Repo {
        project: ProjectRef,
        name: Option<RepoName>,
    },
}

/// `project_add` with `dryRun`: what it would add, and for a url where it would clone; nothing is added.
fn dry(
    m: MachineId,
    path: String,
    inspect: ProjectInspect,
    clone: Option<CloneTarget>,
) -> ProjectAddOutput {
    let next = match &clone {
        Some(c) if c.same_remote => format!(
            "{} already has it at {}: project_add with useExisting adds that checkout.",
            c.machine_id, c.path
        ),
        Some(c) => format!("project_add clones it to {} on {}.", c.path, c.machine_id),
        None => "Add it with project_add.".into(),
    };
    ProjectAddOutput {
        next: Some(next),
        machine_id: m,
        path,
        project_id: None,
        created: false,
        add_id: None,
        inspect: Some(inspect),
        clone,
        truncated: None,
    }
}

/// Clones whose progress is in the event log with no `project.added` or `project.add_failed` after it: running now, or
/// cut off by a hub restart before `fail_interrupted` ran.
pub fn open_clones(
    events: &crate::hub::store::EventLog,
) -> Result<Vec<(Option<MachineId>, CloneProgressData)>, crate::hub::store::StoreError> {
    use std::collections::BTreeMap;
    let types = [
        HubEventType::ProjectCloneProgress,
        HubEventType::ProjectAdded,
        HubEventType::ProjectAddFailed,
    ];
    let mut open: BTreeMap<String, (Option<MachineId>, CloneProgressData)> = BTreeMap::new();
    let mut after = 0;
    loop {
        let page = events.page(after, Some(&types), None)?;
        for e in &page.events {
            let Some(id) = e
                .data
                .as_ref()
                .and_then(|d| d.get("addId"))
                .and_then(|v| v.as_str())
            else {
                continue;
            };
            if e.r#type == HubEventType::ProjectCloneProgress {
                if let Some(d) = e
                    .data
                    .clone()
                    .and_then(|d| serde_json::from_value::<CloneProgressData>(d).ok())
                {
                    open.insert(id.to_owned(), (e.machine_id.clone(), d));
                }
            } else {
                open.remove(id);
            }
        }
        if !page.more {
            break;
        }
        after = page.cursor;
    }
    Ok(open.into_values().collect())
}

/// Clones a previous hub process started and never finished: their progress is in the event log but no
/// `project.added` or `project.add_failed` follows. Each gets its `project.add_failed`, so nothing reads as running
/// forever. Run once at startup, before any new clone starts.
pub fn fail_interrupted(
    events: &crate::hub::store::EventLog,
    at: fleetd_contracts::ids::Timestamp,
) -> Result<usize, crate::hub::store::StoreError> {
    let open = open_clones(events)?;
    let n = open.len();
    for (machine_id, d) in open {
        let what = d
            .repo
            .as_ref()
            .map_or_else(|| d.path.clone(), |r| r.to_string());
        let data = inspect::fit_failed(ProjectAddFailedData {
            add_id: d.add_id,
            repo: d.repo,
            path: d.path,
            problem: problem(
                ProjectProblemCode::CloneFailed,
                format!("the hub restarted while cloning {what}"),
                "Add it again; a clone that finished on the machine is offered for reuse",
            ),
        });
        events.append(NewEvent {
            at: at.clone(),
            r#type: HubEventType::ProjectAddFailed,
            machine_id,
            project_id: None,
            thread_id: None,
            summary: data.problem.message.clone(),
            data: serde_json::to_value(&data).ok(),
            attention: None,
        })?;
    }
    Ok(n)
}

/// Progress events: on each phase change and its 100 %, else every 5 percent at most once a second.
fn progress_due(last: Option<&(Instant, ClonePhase, u8)>, phase: ClonePhase, percent: u8) -> bool {
    match last {
        None => true,
        Some((at, p, pct)) => {
            *p != phase
                || percent == 100 && *pct != 100
                || percent >= pct.saturating_add(5) && at.elapsed() >= Duration::from_secs(1)
        }
    }
}

async fn clone_and_register(
    hub: Arc<Hub>,
    m: MachineId,
    repo: GitHubRepo,
    path: String,
    into: CloneInto,
    mut run: crate::hub::executor::repos::CloneRun,
) {
    let add_id = AddId::unchecked(run.add_id.as_str());
    let emit = |r#type: HubEventType, summary: String, data: serde_json::Value| {
        let _ = hub.events.append(NewEvent {
            at: now(&hub),
            r#type,
            machine_id: Some(m.clone()),
            project_id: None,
            thread_id: None,
            summary: crate::hub::executor::shell_mapper::js_take(&summary, 200).to_owned(),
            data: Some(data),
            attention: None,
        });
    };
    let progress = |phase: ClonePhase, percent: Option<u8>, detail: Option<String>| {
        let data = CloneProgressData {
            add_id: add_id.clone(),
            repo: Some(repo.clone()),
            path: inspect::cut_path(&path, 500),
            phase,
            percent: percent.map(|p| fleetd_contracts::prim::Int::unchecked(i64::from(p))),
            detail: detail
                .map(|d| Text::unchecked(crate::hub::executor::shell_mapper::js_take(&d, 120))),
        };
        let pct = percent.map(|p| format!(" {p}%")).unwrap_or_default();
        let phase_name = serde_json::to_value(phase)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        emit(
            HubEventType::ProjectCloneProgress,
            format!(
                "cloning {repo} on {m}: {}{pct}",
                phase_name.replace('_', " ")
            ),
            serde_json::to_value(&data).unwrap_or_default(),
        );
    };
    progress(ClonePhase::Starting, None, None);
    let url = format!("https://github.com/{repo}");
    let clone = hub.executors.repo_clone(&m, &run.add_id, &url, &path);
    tokio::pin!(clone);
    let mut last: Option<(Instant, ClonePhase, u8)> =
        Some((Instant::now(), ClonePhase::Starting, 0));
    let result = loop {
        tokio::select! {
            result = &mut clone => break result,
            Some(frame) = run.progress.recv() => {
                let pct = frame.percent.map_or(0, |p| p.get() as u8);
                if progress_due(last.as_ref(), frame.phase, pct) {
                    last = Some((Instant::now(), frame.phase, pct));
                    progress(frame.phase, frame.percent.map(|p| p.get() as u8), frame.detail);
                }
            }
        }
    };
    let failed = |p: ProjectProblem| {
        let data = inspect::fit_failed(ProjectAddFailedData {
            add_id: add_id.clone(),
            repo: Some(repo.clone()),
            path: path.clone(),
            problem: p.clone(),
        });
        emit(
            HubEventType::ProjectAddFailed,
            p.message.clone(),
            serde_json::to_value(&data).unwrap_or_default(),
        );
    };
    let facts = match result {
        Ok(facts) => facts,
        Err(e) => {
            let message = match &e {
                ExecutorError::NodeRequestFailed { message, .. } => message.clone(),
                e => e.to_string(),
            };
            failed(inspect::clone_problem(&message, &repo, &m, &path));
            return;
        }
    };
    progress(ClonePhase::Inspecting, None, None);
    let inspect = match read_github(&repo, Some(&facts)).await {
        Ok(i) => i,
        Err(_) => inspect::build(
            Some(&repo),
            &GitHubAnswers::default(),
            Some(&facts),
            vec![],
            true,
        ),
    };
    let added = match &into {
        CloneInto::Project { title } => register(
            &hub,
            &m,
            &path,
            title.as_deref(),
            &facts,
            inspect,
            Some(add_id.clone()),
        )
        .await
        .map(drop),
        CloneInto::Repo { project, name } => repos::attach_checkout(
            &hub,
            project,
            name.as_ref(),
            &path,
            &facts,
            inspect,
            Some(add_id.clone()),
        )
        .await
        .map(drop),
    };
    if let Err(e) = added {
        let fix = match &into {
            CloneInto::Project { .. } => format!("Add the checkout at {path} on {m} as a project"),
            CloneInto::Repo { .. } => {
                format!("Add the checkout at {path} on {m} with project_repo_add")
            }
        };
        failed(problem(
            ProjectProblemCode::Other,
            format!(
                "{repo} was cloned to {path} on {m}, but adding it failed: {}",
                e.message
            ),
            fix,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::test_clock::ManualClock;
    use crate::hub::store::{EventLog, HubDb};

    #[test]
    fn a_clone_cut_off_by_a_hub_restart_fails_once() {
        let clock = ManualClock::at(1_792_000_000_000);
        let events = EventLog::new(HubDb::open_memory().unwrap(), clock.clone()).unwrap();
        let at = || fleetd_contracts::ids::Timestamp::from("2026-10-18T20:00:00.000Z".to_owned());
        let progress = |add_id: &str| NewEvent {
            at: at(),
            r#type: HubEventType::ProjectCloneProgress,
            machine_id: Some(MachineId::new("devbox").unwrap()),
            project_id: None,
            thread_id: None,
            summary: "cloning".into(),
            data: Some(
                serde_json::json!({ "addId": add_id, "repo": "acme/storefront", "path": "/home/me/src/storefront", "phase": "receiving", "percent": 40 }),
            ),
            attention: None,
        };
        events.append(progress("cut-off")).unwrap();
        events.append(progress("finished")).unwrap();
        events
            .append(NewEvent {
                r#type: HubEventType::ProjectAdded,
                data: Some(serde_json::json!({ "addId": "finished" })),
                ..progress("finished")
            })
            .unwrap();
        assert_eq!(fail_interrupted(&events, at()).unwrap(), 1);
        let failed = events
            .page(0, Some(&[HubEventType::ProjectAddFailed]), None)
            .unwrap()
            .events;
        assert_eq!(failed.len(), 1);
        let data = failed[0].data.as_ref().unwrap();
        assert_eq!(data["addId"], "cut-off");
        assert_eq!(data["code"], "clone_failed");
        assert_eq!(
            failed[0].machine_id.as_ref().map(MachineId::as_str),
            Some("devbox")
        );
        // The next start finds nothing open.
        assert_eq!(fail_interrupted(&events, at()).unwrap(), 0);
    }

    #[test]
    fn progress_events_are_throttled() {
        let long_ago = Instant::now() - Duration::from_secs(2);
        let just_now = Instant::now();
        assert!(progress_due(None, ClonePhase::Receiving, 0));
        assert!(progress_due(
            Some(&(just_now, ClonePhase::Starting, 0)),
            ClonePhase::Receiving,
            1
        ));
        assert!(!progress_due(
            Some(&(just_now, ClonePhase::Receiving, 10)),
            ClonePhase::Receiving,
            20
        ));
        assert!(!progress_due(
            Some(&(long_ago, ClonePhase::Receiving, 10)),
            ClonePhase::Receiving,
            12
        ));
        assert!(progress_due(
            Some(&(long_ago, ClonePhase::Receiving, 10)),
            ClonePhase::Receiving,
            15
        ));
    }
}
