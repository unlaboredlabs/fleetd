//! Which repo and base a project's work lands on, read from its root on its machine with plain git, so it works on
//! any host: the repo key from `remote.origin.url` as configured, the base from `origin/HEAD` (what the node branches
//! worktrees from). Adding a project sets it once; callers that find a project unbound read it here.
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::prim::Line;
use fleetd_contracts::work::{RepoKey, WorkScope};

use super::BoxFut;
use crate::hub::api::Hub;
use crate::hub::link::NodeCommands;
use crate::hub::link::commands::CommandInput;
use crate::hub::store::StoreError;

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
        return Ok(None);
    };
    let Some(base) = read_base(node, machine, root, &repo_key, bound.as_ref()).await else {
        return Ok(bound.filter(|b| b.repo_key == repo_key));
    };
    let scope = WorkScope { repo_key, base };
    if bound.as_ref() != Some(&scope) {
        hub.work.bind_project(project, &scope)?;
    }
    Ok(Some(scope))
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
