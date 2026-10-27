# W79 design: projects that hold zero or more repos

Status: design, partly built (stages 1 to 5). This records intent when written; the code is the source of
truth.
Check `git log` for what has landed.

## The model

- **A project is a workspace:** a lead and its own directory on its home machine. `ProjectRef {machineId, projectId}`
  names it, and stays the key of everything per project (lead, chat, orders, tasks, memory, env, checklist). No
  existing id changes.
- **It holds zero or more repos.** A plain directory with no git has none. A project added from a checkout has that
  checkout as its one repo, its **own repo**: the repo whose checkout is the project's `ProjectRef`.
- **A repo** (`ProjectRepo`, `crates/fleetd-contracts/src/repos.rs`) is `R<n>` (unique per hub, never reused), a
  name unique in its project (`[a-z0-9-]{1,32}`), the node checkout holding its files (a `ProjectRef`: a node
  "project" is just a checkout, so nodes need no new protocol), and the repo key and base its work lands on.
- Cut as speculative: a separate checkout ref type, several checkouts per repo, a "primary" flag, and a repo id on
  Changes and previews.
- Product answers: attaching a repo that is already its own project archives the old project read-only; a repo can be
  in several projects, with CI and train rules on the repo (per GitHub repo, on the train); a downstream PR waits
  while its upstream PR in the same order fails.

## Storage (1b)

One table, `repos` (`hub/store/migrations.rs`), keyed by `n` (`AUTOINCREMENT`, so a number is never handed out
twice), with the project it is in, its name, its checkout (`checkout_machine_id`, `checkout_project_id`), `repo_key`
and `base`, and `setup`/`preview` for per-repo settings (NULL: the project's own; read from 1c on). `hub/repos` owns
it.

**When a project has its own repo.** The hub only knows a directory is a git repo when adding it saw one (`project_add`
refuses anything else), or when its work is bound to a remote (`work_projects`). So the own repo is made:

- at hub start, for every cached project whose work is bound (the backfill, idempotent);
- when a node reports a project, when its work is bound, and when its repos are read;
- when `project_add` registers a checkout, with or without a remote.

A project whose directory isn't a git repo never gets one. A git checkout with no remote added before this hub has
none until a person adds it (stage 2). The own repo's `repo_key` and `base` follow `work_projects`: binding and
unbinding update both in the same transaction.

## The work-ledger scope (1d)

A repo's work lands on its `repo_key` and `base`: `work.scope_of_repo(R<n>)` reads them from its row, `None` while the
repo has no remote. `work.scope_of(ProjectRef)` is the project's own repo's scope, read from `work_projects` as before,
so a one-repo project's scope is unchanged, a plain directory has none, and a rolled-back hub, which writes only
`work_projects`, still works (the next read or hub start brings the own repo's row back in line). Projects on one repo
and base still share one view of the work in flight.

**Serving.** `ProjectSummary.repos` comes from `repos` whenever the hub serves a summary; a node's row never carries
it, so a node's refresh can't wipe it.

**Removal.** Removing a project removes its repos and every repo whose checkout it was.

## Settings per repo (1c)

A repo can have its own `setup` and `preview`; an empty one is the project's (`project_settings`, whose columns stay
so a hub rolled back still has its data). `project_settings_get`/`set` take a `repo` by name: they read the repo's
(else the project's) and write the repo's row, and the response names the repo in `settings.repo`. Without `repo`
they read and write the project's, as before. An unknown repo is `not_found`, with the project's repos in the fix.
`keepWorktrees`, the title, env and the medium profile stay the project's either way. `train` is the repo's (stage 4):
with `repo` it reads and writes `project_settings.train` of the repo's checkout, which is the project itself for its
own repo.

A task's launch (`tasks/wire.rs`) and a preview (`preview/mod.rs`) read their repo's setting, for now always the
project's own repo (none for a plain directory, which reads the project's): `projects::settings::task_setup` and
`preview_config`. An agent's approved `preview_config_propose` still writes the project's.

## Stages

1. The data model, with no change in behaviour: 1a contracts, 1b tables and store, then in parallel 1c settings per
   repo (`setup`, `preview`; `keep_worktrees`, env and the medium profile stay per project), 1d the work-ledger scope
   per repo, 1e tasks record their `repoId`, 1f Settings › Projects lists a project's repos.
2. Add and remove repos: `project_repo_add`/`list`/`remove` (MCP, `fleetd project repo`, a "+ Repo" in Settings ›
   Projects), and a project that is just a directory. A checkout attached to another project stops showing as its own.
3. Writers per repo: `spawn_agent` takes a `repo` (absent: the PR's repo, else the own one), launches in the repo's
   checkout, and checks duplicates, policy and skills against that repo; the lead's prompt lists the repos.
4. The train and PRs per repo: the train's git runs in a checkout of the repo; enqueue refuses PRs from repos outside
   the project.
5. Cross-repo merge order: `after: [prUrl]` on `change_enqueue`; the train holds a downstream PR while its upstream
   one hasn't merged, and tells the lead when the upstream one fails.
6. An order's preview across repos, each preview told the others' URLs.
7. Several machines per repo, with secrets sealed for each node.
8. Metrics per repo, rolled up per project.
9. Clean-up: drop `work_projects` and the old `project_settings` columns once no supported hub needs a rollback.

## Tasks record their repo (1e)

A new task stores the repo it works in, `Task.repoId` in its row's JSON (`hub/tasks/mod.rs` spawn): the project's own
repo, or none for a plain directory, as every task still works in the project's own directory. A row with no `repoId`
(every row an older hub stored, and a plain directory's) reads as the project's own repo when it has one
(`hub/tasks/records.rs`), so absent keeps meaning the project's own directory. Nothing reads it yet apart from the task
listings that serve it. Changes carry no repo id: a PR's project and GitHub repo name its repo.

## Settings › Projects lists the repos (1f)

A **Repos** section under the project's name (`app/desktop/.../settings/RepoSetting.tsx`) lists
`ProjectSummary.repos`: each repo's name, remote, base branch and checkout (its machine and path), and the setup and
preview it runs with, read with `project_settings_get` and `repo`. One the same as the project's, or one a hub before
1c refuses to read, shows as "uses the project's". A plain folder says "No repo, a plain folder". Read-only: adding and
removing repos is stage 2.

## The train per repo (4)

Each GitHub repo already had its own train lane (`trains.repo`), bound to the project that first enqueued one of its
PRs. The train now reads that repo's branch prefix (policy) and its rules (`project_settings.train`) from the repo's
checkout in that project (`Train::train_checkout`, through `TrainHost::github_repos`), not from the project's own
directory. For a one-repo project, that checkout is the project itself, so nothing changes.

`change_enqueue` refuses a PR whose GitHub repo isn't one of the project's repos (`repos.repo_key`), once the project
has two or more (stage 2). A project with one repo or none takes any repo, as before: its lead may enqueue another
repo's PR, such as a fork's upstream. The order
board and the Train tab already group by repo (`hub/orders` `trains()`, `TrainPane`), one train per repo. A task's PR
lookup reads its repo checkout's remote (stage 3).

## Merge order across repos (5)

`change_enqueue` takes `after: [prUrl]`, and the Change records it (`Change.after`, absent when empty). Enqueuing a PR
still in line adds the new `after` PRs to it; one already rebasing, in CI or merging is refused. `after` may name any
GitHub PR. The train refuses a PR listed in its own `after`, or an order that loops back; enqueues with `after` take one
lock from that check until their Change records them, so two at once can't wait on each other. `train/next.rs`
decides where each upstream PR stands. Its newest Change decides: merged lets the
downstream PR go; failed CI, blocking review findings, or refused (unless GitHub shows the PR merged) hold the
downstream PR as a failure. Anything else holds it as waiting. With no Change, GitHub decides. A ready downstream
Change waits in line with `lastError` "held: waiting on owner/name#n: why", which the app shows as held. GitHub's answer for an upstream with no open Change is
kept for 10 seconds, so a pass reads it once. Each pass tells the lead once about each failure that holds a Change. That note is kept in memory, so after a restart the lead
may be told again. An upstream merge kicks the trains of the PRs waiting on it.

## Stage 2: adding and removing repos

`project_repo_add`, `project_repo_list` and `project_repo_remove` (`hub/projects/repos.rs`), `fleetd project repo
add|list|remove`, and Add repo / Remove in Settings › Projects › Repos.

- **Add** takes a path or a GitHub URL on the project's machine, through `project_add`'s checkout and clone code. A
  directory that isn't a node project yet is registered as one (the checkout). The repo row is inserted with its name and
  with its key and base from the checkout's work binding. The event is `project.added`, on the project.
- **Attached checkouts are hidden.** `projects_shown` (the projects list, the status rows, the chats, the leads started
  for waiting orders) leaves out a node project that another project holds as a repo. `projects_list` keeps every node
  project, for the hub's own bookkeeping: pruning, binding, finding a session's project.
- **Archiving** is derived, not stored. A checkout that was a project of its own is archived while another project holds
  it. Attaching stops its lead's session. From then on its lead is refused at every start, resume and wake
  (`leads::lead::refuse_archived`), a steer at its orders is refused, and any send to its lead thread is refused where
  every turn goes out to the node (`Executors::send_with`, `repos::archived_lead`), whatever path it came by. Its spawns
  are refused, and `chat_send`, `project_repo_add` and
  `project_repo_remove` refuse it. Its records stay. Attaching refuses while its agents run. A project that holds repos
  of its own can't be attached.
- **Remove** deletes the row. `leads::removals` then cancels every live task whose `repoId` no row has. It runs again
  at hub start and after each `project.removed`, so losing a checkout's node project ends only that repo's tasks. The
  checkout stays on disk. It is a project of its own again once no project holds it. The own repo can't be removed.
  The hub emits `project.settings` (`data.repoRemoved`), which makes the app resync.
- **Env, MCP servers and skills reach every checkout.** `project_env_set` writes the project's checkouts too. A new
  checkout gets the project's variables through the node's `project_env_copy` (`CAP_PROJECT_ENV_COPY`), which copies
  secrets on the node, never through the hub. A session in a checkout gets the MCP servers and hub-kept skills of the
  projects holding it, ahead of its own (`mcp_servers::session_config`, `skills::bundles_in`). A checkout in several
  projects is shared as the repo is. Each project's `project_env_set` writes the checkout, so the last write of a
  name wins. A session there gets every holder's servers and skills: on a name clash, the holder that added the checkout
  first wins. Access is per machine, so this grants nothing new. Per-project values in
  one checkout wait for agents per repo (stage 3), which know their task's project.
- **The lead's first message** lists the repos (`leads::prompt::repos_block`) when the project holds any besides its
  own directory.
- `ProjectRepo.path` is the checkout's directory, read from the node's row, so a hidden checkout still shows where it
  is.

## Writers per repo (3)

`spawn_agent` takes an optional `repo` (a name). Absent, a task given a `pr` works in the project's repo whose
`repo_key` the PR's URL is on (so the train's reviewers run in the PR's repo), and any other in the project's own repo,
or the plain directory; an unknown name is `not_found` with the project's repo names. The task records the repo
(`Task.repoId`), and everything that touches files goes through `Tasks::checkout_of`: the repo's checkout for another
of the project's repos, else the project's own directory. A task whose repo the project no longer has fails to start
("its repo R2 was removed from the project") and its lead is told; it never falls back to the own directory. The launch runs
on that checkout's machine and node project, reads its default branch and `.fleetd/policy.yaml` there, and sends the
project and repo so `task_setup` reads the repo's setup; the PR lookup reads that checkout's `origin`. A task in
another repo needs a worktree: run in the checkout itself, its session would be the checkout's and its calls refused.
So a reader on a node without detached worktrees ("update <machine> to run agents in other repos"), or any task in a
repo with no commit yet ("repo <name> has no commits yet"), fails to start with that reason.

Duplicate checks use the repo's scope (`scope_of_repo` for another repo, the project's as before for its own).
`work::store::projects_in` also returns projects holding the scope through another repo, and the ledger counts a
project's task only in its own repo's scope (`scope_of_task`). "Also writing" lists writers in the same repo.

The lead's first message lists the repos (`repos_block`, stage 2) and says how to pick one with `repo`; `agents` (and
the spawn result) name the repos when there are several. The lead keeps working in its home directory. A session in a
checkout gets the env, MCP servers and skills of the projects holding it (stage 2).
