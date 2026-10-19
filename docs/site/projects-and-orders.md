---
title: Projects & orders
section: Using fleetd
order: 50
description: Add a project, send an order, follow it, and see how "done" is checked.
---

## Add a project

```console
$ fleetd project add https://github.com/acme/storefront
cloning into /home/me/src/storefront on devbox
  starting
  receiving
  resolving
  inspecting
✓ ~/src/storefront cloned and added on devbox
Lead needs: no CI found: the merge train will only use local checks
Default branch: main
CI: none; required checks: none
Merge: unprotected, squash allowed
```

Give it a GitHub URL (or `owner/repo`) to clone the repo onto a worker, or a path to add a checkout that is already
there: `fleetd project add ~/src/storefront`. With nothing after `add`, in a terminal, it lists what it finds to pick
from: checkouts under `~/src`, `~/code`, `~/projects`, `~/dev` and similar on every worker, and your repos and your
orgs' repos from `gh repo list`.

- **Where.** A clone goes to the least busy online worker, into its `~/src` (or `~/code`, `~/projects`), unless you
  pass `--machine <id>` or `--dest <dir>`. A path is on this machine unless you pass `--machine`.
- **What the lead will need.** Before it clones, fleetd reads the repo's default branch, its CI (workflows and the
  checks the default branch requires) and its merge rules (branch protection, rulesets, whether squash merges are
  allowed), and says in one line what that means, such as `no CI found: the merge train will only use local checks`
  or `squash merges are off on acme/storefront`. Fix those on GitHub before the first PR.
- **Already cloned.** When the folder it would clone into already holds the same repo, `fleetd project add` offers
  to add that checkout; without a terminal, pass `--use-existing`.
- **gh.** fleetd reads GitHub through `gh` on the hub machine; `gh repo list` falls back to the worker when the hub's
  `gh` is logged out. A private repo clones on any worker where `gh auth login` was run.

When something is in the way (the worker is offline, the path is not a git repo, `gh` can't see the repo, the folder
exists), it says so with the command that fixes it. `fleetd project list` shows your projects, and `fleetd project
remove <machine>/<project>` stops a project's threads and forgets it; its files, branches and worktrees stay.

Agents do the same through MCP: `project_discover`, `project_inspect`, `project_add {path | url}` (a clone answers
with an `addId`, then `project.clone_progress` events, then `project.added` or `project.add_failed`) and
`project_remove`.

## Its lead

Each project has one lead, and the project's first order starts it: there is nothing to start by hand. The lead's
first message lists the order, and the app shows the lead starting.

If the lead can't start, because `claude` on the worker is logged out or outside the supported version range, or the
worker is offline, the order waits. The app's reply says why and what to run on the worker. Once the worker comes back
online with a usable `claude`, its lead starts and picks up every waiting order.

To choose the lead's model and effort, or to start it before any order, call `lead_start {machineId, projectId, model,
effort}` from an MCP client; the model and effort are saved for the project (default `claude-opus-5-5`, high). To keep
a project's lead from starting by itself, set `lead.autoStart: false` in its [policy file](config-and-files.md#policy):
orders then wait until `lead_start`, and the reply says so.

## Connect an MCP client

The hub's MCP endpoint is `<hub url>/mcp`. Give the client an agent key, shown once:

```console
$ fleetd hub key create --name ci-bot --role operate --machines '*'
fld_<key>
created key_tjw34bxe (fld_mwrgw4, operate:*). The key above is shown only once.
```

For Claude Code:

```sh
claude mcp add --transport http fleetd http://hub.your-tailnet.ts.net:4790/mcp --header "Authorization: Bearer fld_<key>"
```

Roles are `read`, `operate` and `admin`, on every machine (`'*'`) or a list. `fleetd hub key list` shows keys and
`fleetd hub key revoke <keyId>` ends one at once.

## Send an order

In the app, type one line in the board's composer and press Enter ([Give work](desktop-app.md#composer)). Pick the
project, or leave it to the hub, which reads a leading `@project`, else asks a quick router, else asks you. A prefix
picks the playbook: `fix:` or `bug:`, `research:`, `finish:`. Attach screenshots or files, or `@`-mention files,
orders and PRs; the lead gets them with the order.

From an MCP client: `intake_submit {text}`; `intake_preview {text}` says where it would go without sending it.

## Follow it

The lead freezes a brief, runs writer and reviewer tasks on your workers, and puts each PR on the merge train. The
board shows every order's phase and live agents; open one for its PRs, checks and the lead's conversation
([Follow an order](desktop-app.md#order)).

## How the lead schedules work {#scheduling}

The lead plans each order as small items (sizes S, M or L, some waiting `after` others) and starts every item it can in
parallel, as long as slots are free. fleetd keeps that going without ever starting work by itself:

- **A free slot is offered.** When a slot frees and the lead is idle, fleetd wakes it with the next plan items that
  can start: in an order whose brief is frozen, not waiting on another open item, and with no task or PR yet. A
  finish-all order with room for another child is offered too; its lead picks from the inventory. When nothing
  qualifies, the lead stays idle.
- **Once per change.** A lead hears about the same runnable work once. It is told again only when that changes: an
  item is taken, done, added or unblocked.
- **Slices are reviewed as they land.** A writer reports each finished PR with `report` (kind `slice_ready`); fleetd
  puts it on the train and starts its reviewers under the order's review rules right away, while the writer goes on. A
  new head is reviewed again from what changed, at the same blocking-only bar.

Nothing here relaxes a gate: every PR still gets its tier's reviews and green CI and goes through the train, done is
still decided by the done-when checks, and anything that needs your approval still waits for it. The slots board and
the lead's limit of 32 open tasks apply to the reviewers fleetd starts as to any task.

## Add to it, steer it, stop it

In the order, Enter adds your words to the lead's queue: it takes them in at its next step, after the tool it is
running. ⌘Enter (Ctrl+Enter) interrupts and redirects: its current step stops and it reads you at once. Each steer
gets a receipt, and any agent in the order can be steered the same way: see [Steering](steering.md).
Stop cancels the order's running and queued agents and withdraws its asks; merged PRs stay. A stopped order stays
stopped: send it again as a new order.

## Answer its questions

Questions land in the inbox (⌘I), numbered. Reply in one line, such as `1 go 2 nvm 3 b`: see
[the reply grammar](desktop-app.md#reply). Commands and secrets have their own flow:
[Approvals & secrets](approvals-and-secrets.md).

## Done, checked

The lead reports done with `fleetd claim done`. The hub then runs the brief's done-when checks itself, and only all of
them passing makes the workstream done. A failure wakes the lead with the exit code and output. `claims_list` shows
every claim with its evidence.

A done order cleans up after itself: its PRs still waiting (queued, in review, ready, needing a rebase, or with failed
CI) are closed on GitHub with a comment saying why, and its leftover tasks are cancelled. A PR the train is already
rebasing, checking or merging is left to land.

## MCP tools for orders {#tools}

| Tool | Does | Role |
|---|---|---|
| `intake_submit {text}` | send an order (optional `attachments`, `refs`) | operate |
| `intake_preview {text}` | where it would go, without sending | operate |
| `attachment_put {name, mime, dataB64}` | upload a file (image, text or PDF, at most 5 MiB) for an order or note | operate |
| `project_files {machineId, projectId, query}` | a project's files for `@`-mentions | read |
| `orders_board {projectRef?}` | open orders with their phase, agents, PRs, asks and the trains | read |
| `order_get {workstreamId}` | one order, plus its lead, finished agents and claims | read |
| `order_note {workstreamId, text, urgent?}` | add to an order; `urgent` wakes the lead now | operate, human key |
| `order_stop {workstreamId}` | stop an order | operate, human key |
| `workstream_list`, `workstream_get`, `thread_tail`, `fleetd_status` | the lower-level views | read |

`events_wait` long-polls for changes instead of polling. A human key is a person's paired device, not an agent key.
