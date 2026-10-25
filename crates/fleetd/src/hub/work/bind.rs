//! Which repo and base a project's work lands on, read from its root on its machine with plain git, so it works on
//! any host: the repo key from `remote.origin.url` as configured, the base from `origin/HEAD` (what the node branches
//! worktrees from). Adding a project sets it once; projects that existed before are bound at hub start and whenever
//! their node connects (`run`); the landing scanner refreshes it every scan; callers that find a project unbound read
//! it here. A project whose origin goes away is unbound.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::prim::Line;
use fleetd_contracts::work::{RepoKey, WorkScope};

use super::BoxFut;
use crate::hub::api::Hub;
use crate::hub::link::NodeCommands;
use crate::hub::link::commands::CommandInput;
use crate::hub::store::StoreError;
use crate::hub::store::WaitInput;

/// One git command's exit code (`None` when it didn't exit on its own) and the last 2000 characters of its output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitOut {
    pub code: Option<i64>,
    pub out: String,
}

impl GitOut {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// How the hub runs git in a directory on a machine: the node link, or real git in tests.
pub trait NodeGit: Send + Sync {
    /// `None` when the node could not run it (offline, or the link dropped).
    fn git<'a>(
        &'a self,
        machine: &'a MachineId,
        cwd: &'a str,
        args: Vec<String>,
    ) -> BoxFut<'a, Option<GitOut>>;
}

/// Long enough for a fetch of a busy base.
const GIT_TIMEOUT_SEC: u32 = 300;

impl NodeGit for NodeCommands {
    fn git<'a>(
        &'a self,
        machine: &'a MachineId,
        cwd: &'a str,
        args: Vec<String>,
    ) -> BoxFut<'a, Option<GitOut>> {
        Box::pin(async move {
            let mut argv = vec!["git".to_owned()];
            argv.extend(args);
            let input = CommandInput {
                cwd: cwd.to_owned(),
                argv,
                timeout_sec: Some(GIT_TIMEOUT_SEC),
            };
            let out = self.run(machine, input).await.ok()?;
            Some(GitOut {
                code: out.exit_code.map(|c| c.get()),
                out: out.output_tail.to_string(),
            })
        })
    }
}

pub(crate) async fn git(
    node: &dyn NodeGit,
    machine: &MachineId,
    cwd: &str,
    args: &[&str],
) -> Option<GitOut> {
    let args = args.iter().map(|a| (*a).to_owned()).collect();
    node.git(machine, cwd, args).await
}

/// Reads the project's repo key and base from its root, records them when they changed, and returns them. `Ok(None)`
/// when the project has no remote (or is unknown). While its node can't answer, what was recorded before.
pub async fn bind_from_root(
    hub: &Hub,
    project: &ProjectRef,
) -> Result<Option<WorkScope>, StoreError> {
    let Some(summary) = hub.store.project_get(project)? else {
        return Ok(None);
    };
    bind_with(
        hub,
        hub.node_commands.as_ref(),
        project,
        &summary.workspace_root,
    )
    .await
}

pub(crate) async fn bind_with(
    hub: &Hub,
    node: &dyn NodeGit,
    project: &ProjectRef,
    root: &str,
) -> Result<Option<WorkScope>, StoreError> {
    let bound = hub.work.scope_of(project)?;
    let machine = &project.machine_id;
    let Some(remote) = git(
        node,
        machine,
        root,
        &["config", "--get", "remote.origin.url"],
    )
    .await
    else {
        return Ok(bound);
    };
    // `config --get` exits 1 when the key is unset: a checkout with no origin.
    let repo_key = remote
        .ok()
        .then(|| RepoKey::of(remote.out.trim()))
        .flatten();
    let Some(repo_key) = repo_key else {
        // Its origin went away: its work no longer lands anywhere fleetd can see.
        if bound.is_some() {
            hub.work.unbind_project(project)?;
        }
        return Ok(None);
    };
    let Some(base) = read_base(node, machine, root, &repo_key, bound.as_ref()).await else {
        // Pointed at another repo whose base can't be read yet: the old scope is wrong either way.
        if bound.as_ref().is_some_and(|b| b.repo_key != repo_key) {
            hub.work.unbind_project(project)?;
            return Ok(None);
        }
        return Ok(bound);
    };
    let scope = WorkScope { repo_key, base };
    if bound.as_ref() != Some(&scope) {
        hub.work.bind_project(project, &scope)?;
    }
    Ok(Some(scope))
}

/// How long one project's bind may take before the pass moves on to the next.
const BIND_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a pass waits for a node that just connected to be reachable.
const LINK_WAIT: Duration = Duration::from_secs(30);

/// Binds the projects that aren't bound yet (on `machine`, when given), one at a time, each for at most
/// `BIND_TIMEOUT`. Returns how many it bound.
pub async fn bind_unbound(hub: &Hub, node: &dyn NodeGit, machine: Option<&MachineId>) -> usize {
    let projects = match hub.store.projects_list(machine, None) {
        Ok(projects) => projects,
        Err(error) => {
            tracing::warn!(%error, "work: projects not read for binding");
            return 0;
        }
    };
    let mut bound = 0;
    for p in projects {
        let project = ProjectRef {
            machine_id: p.machine_id,
            project_id: p.project_id,
        };
        if !matches!(hub.work.scope_of(&project), Ok(None)) {
            continue;
        }
        let bind = bind_with(hub, node, &project, &p.workspace_root);
        match tokio::time::timeout(BIND_TIMEOUT, bind).await {
            Ok(Ok(Some(_))) => bound += 1,
            Ok(Ok(None)) => {}
            Ok(Err(error)) => {
                tracing::warn!(%error, project = %project.project_id, "work: bind failed")
            }
            Err(_) => tracing::warn!(project = %project.project_id, "work: bind timed out"),
        }
    }
    bound
}

/// The machines that came online after `cursor`, and the cursor past them; waits up to `timeout_sec` for one.
pub(crate) async fn machines_online(
    hub: &Hub,
    cursor: i64,
    timeout_sec: u64,
) -> (Vec<MachineId>, i64) {
    let input = WaitInput {
        cursor: Some(cursor),
        types: Some(vec![HubEventType::MachineOnline]),
        machine_id: None,
        timeout_sec,
    };
    match hub.events.wait(input).await {
        Ok(page) => {
            let machines = page
                .events
                .into_iter()
                .filter_map(|e| e.machine_id)
                .collect();
            (machines, page.cursor.max(cursor))
        }
        Err(error) => {
            tracing::warn!(%error, "work: machine.online not read");
            hub.clock.sleep(Duration::from_secs(1)).await;
            (Vec::new(), cursor)
        }
    }
}

/// Binds every unbound project at hub start, then a machine's unbound projects each time its node connects, in the
/// background, one at a time.
pub async fn run(hub: Arc<Hub>) {
    let mut cursor = hub.events.head();
    bind_unbound(&hub, hub.node_commands.as_ref(), None).await;
    loop {
        let (machines, next) = machines_online(&hub, cursor, 3600).await;
        cursor = next;
        for machine in machines {
            // machine.online can be logged before the hub's link to the node is live.
            let _ = tokio::time::timeout(LINK_WAIT, hub.executors.await_live(&machine)).await;
            bind_unbound(&hub, hub.node_commands.as_ref(), Some(&machine)).await;
        }
    }
}

/// `origin/HEAD` as the checkout has it (the lab points it at its slot's base); else what was recorded for the same
/// repo; else the remote's own HEAD.
async fn read_base(
    node: &dyn NodeGit,
    machine: &MachineId,
    root: &str,
    repo_key: &RepoKey,
    bound: Option<&WorkScope>,
) -> Option<Line<1, 250>> {
    let head = git(
        node,
        machine,
        root,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await?;
    if head.ok()
        && let Some(base) = head.out.trim().strip_prefix("origin/")
        && let Ok(base) = Line::new(base)
    {
        return Some(base);
    }
    if let Some(bound) = bound.filter(|b| &b.repo_key == repo_key) {
        return Some(bound.base.clone());
    }
    let remote = git(
        node,
        machine,
        root,
        &["ls-remote", "--symref", "origin", "HEAD"],
    )
    .await?;
    remote
        .ok()
        .then(|| remote_head(&remote.out))
        .flatten()
        .and_then(|b| Line::new(b).ok())
}

/// `ref: refs/heads/main\tHEAD` in `git ls-remote --symref origin HEAD` → `main`.
pub(crate) fn remote_head(out: &str) -> Option<&str> {
    out.lines().find_map(|line| {
        let (target, name) = line.strip_prefix("ref: ")?.split_once('\t')?;
        (name.trim() == "HEAD")
            .then(|| target.strip_prefix("refs/heads/"))
            .flatten()
    })
}
