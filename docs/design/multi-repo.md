# W79 design: projects that hold zero or more repos

Status: design, partly built (stages 1a, 1b and 1d). This records intent when written; the code is the source of truth.
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

## Stages

1. The data model, with no change in behaviour: 1a contracts, 1b tables and store, then in parallel 1c settings per
   repo (`setup`, `preview`; `keep_worktrees`, env and the medium profile stay per project), 1d the work-ledger scope
   per repo, 1e tasks record their `repoId`, 1f Settings › Projects lists a project's repos.
2. Add and remove repos: `project_repo_add`/`list`/`remove` (MCP, `fleetd project repo`, a "+ Repo" in Settings ›
   Projects), and a project that is just a directory. A checkout attached to another project stops showing as its own.
3. Writers per repo: `spawn_agent` takes a `repo` (required with two or more), launches in the repo's checkout, and
   checks duplicates, policy and skills against that repo; the lead's prompt lists the repos.
4. The train and PRs per repo: the train's git runs in a checkout of the repo; enqueue refuses PRs from repos outside
   the project.
5. Cross-repo merge order: `after: [prUrl]` on `change_enqueue`; the train holds a downstream PR while its upstream
   one hasn't merged, and tells the lead when the upstream one fails.
6. An order's preview across repos, each preview told the others' URLs.
7. Several machines per repo, with secrets sealed for each node.
8. Metrics per repo, rolled up per project.
9. Clean-up: drop `work_projects` and the old `project_settings` columns once no supported hub needs a rollback.
