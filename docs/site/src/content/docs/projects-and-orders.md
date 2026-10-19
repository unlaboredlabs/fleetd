---
title: Projects & orders
description: Add a project, send it an order, follow the order, and see how "done" is checked.
---

You'll add a repo as a [project](/docs/glossary#project), send it work, and follow that work to merged pull requests.

## Add a project {#add-a-project}

1. Add a GitHub repo. fleetd clones it onto a worker:

   ```sh
   fleetd project add https://github.com/acme/storefront
   ```

   Expected output:

   ```text
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
   Give it an order in the app's composer, or from any agent with intake_submit; its lead starts with the first one.
   ```

2. Read the `Lead needs:` line. It names anything to fix on GitHub before the first pull request, such as
   `squash merges are off on acme/storefront`.

### What you can pass

| You pass | fleetd does |
|---|---|
| A GitHub URL or `owner/repo` | Clones it onto the least busy online worker, into `~/src` (or `~/code`, `~/projects`). |
| A path, such as `~/src/storefront` | Adds that existing checkout on this machine. |
| Nothing, in a terminal | Lists checkouts on every worker and your repos from `gh repo list`, to pick from. |

| Option | Does |
|---|---|
| `--machine <id>` | Clone to, or look for the path on, that worker. |
| `--dest <dir>` | Clone into that folder. |
| `--use-existing` | Add the folder's checkout when it already holds the same repo. Without a terminal, this is how you accept it. |

:::caution[Checkouts must be under your home directory]
A node runs commands only under its `cmdRoots`, which default to your home directory. `fleetd project add` refuses a
checkout elsewhere, such as in `/tmp`, and says how to fix it: list its folder in `cmdRoots` in
[`node.json`](/docs/config-and-files#node-json) and restart the node. A new `--dest` folder counts where it will be.
:::

fleetd reads GitHub through `gh` on the hub machine. A private repo clones on any worker where `gh auth login` was run.
When something is in the way, such as an offline worker or a folder that exists, it prints the command that fixes it.

### List and remove projects

```sh
fleetd project list
fleetd project remove devbox/storefront
```

`list` prints each project as `<machineId>/<projectId>`, its title and its folder. `remove` stops the project's agents and forgets it. Its files, branches and worktrees stay.

## Which branch fleetd works on {#branches}

| What | Is |
|---|---|
| The base each writer branches from | The checkout's `origin/HEAD`, else its current branch. |
| A task's branch | `fleetd/T<n>-<slug>`, such as `fleetd/T1-fix-readme-typo`. Change the `fleetd/` prefix with `branchPrefix` in the [policy file](/docs/config-and-files#policy). |
| Where the merge train merges | Each pull request's base branch. See [Merge train](/docs/merge-train). |

The `Default branch:` line that `project add` prints is GitHub's default branch. fleetd uses it to watch main's CI and
to read its protection rules. To work against another branch, point the checkout's `origin/HEAD` at it on the worker:

```sh
git remote set-head origin release
```

## Its lead {#its-lead}

Each project has one [lead](/docs/glossary#lead). The project's first order starts it: there is nothing to start by
hand.

If the lead can't start, the order waits and the app says why. Common causes:

| Cause | Fix, on the worker |
|---|---|
| `claude` is logged out | `claude auth login` |
| `claude` is outside the supported versions | See [claude versions](/docs/troubleshooting#claude) |
| The worker is offline | See [Machines](/docs/troubleshooting#machines) |

Once the worker is back with a working `claude`, the lead starts and picks up every waiting order.

To keep a lead from starting by itself, set `lead.autoStart: false` in the project's
[policy file](/docs/config-and-files#policy). Orders then wait for `lead_start`.

## Models and cost {#models}

By default the lead and every task run on `claude-opus-5-5` at high effort.

| To change | Do |
|---|---|
| The lead's model and effort | Call `lead_start {machineId, projectId, model, effort}` from an [MCP client](/docs/mcp-clients) before the project's first order. They are saved for the project. |
| The tasks' model and effort | Set `defaults.model` and `defaults.effort` in the project's [policy file](/docs/config-and-files#policy), committed to the default branch. |

For example, to try fleetd cheaply on a test project:

1. Before its first order, call
   `lead_start {"machineId":"devbox","projectId":"<id>","model":"claude-haiku-5-5","effort":"low"}`. `fleetd project
   list` shows the ids.
2. Commit this `.fleetd/policy.yaml` to the default branch. `areas` is required in every policy file; `all` lets
   writers touch the whole repo.

   ```yaml
   areas:
     all: ["**"]
   defaults:
     model: claude-haiku-5-5
     effort: low
   ```

## Send an order {#send}

In the desktop app, type one line in the board's order box and press Enter. See [Give work](/docs/desktop-app#composer).

```text
@storefront fix: checkout button is misaligned on mobile Safari
```

| Part | Means |
|---|---|
| `@storefront` | Optional. The project. Without it, the hub picks one or asks you. |
| `fix:` | Optional. The [playbook](/docs/glossary#playbook): `fix:` or `bug:`, `research:`, `finish:`. The default is a feature. |
| The rest | What you want, in your words. |

You can attach screenshots or files, and `@`-mention files, orders and PRs. The lead gets them with the order.

From an [MCP client](/docs/mcp-clients), `intake_submit {text, clientRequestId}` sends an order, and
`intake_preview {text}` shows where it would go.

## Follow it {#follow}

The lead writes a [brief](/docs/glossary#brief), runs writer and reviewer tasks on your workers, and puts each pull
request on the [merge train](/docs/glossary#merge-train).

- The board shows every order's phase and live agents.
- Open an order to see its PRs, checks and the lead's conversation. See [Follow an order](/docs/desktop-app#order).
- From a terminal: `fleetd status W41`. See [Status](/docs/status).

## How the lead schedules work {#scheduling}

The lead plans each order as small items, sized S, M or L, some waiting `after` others. It starts every item it can
in parallel while slots are free. fleetd keeps that going, but never starts work by itself:

| Rule | What happens |
|---|---|
| A free slot is offered | When a slot frees and the lead is idle, fleetd wakes it with the plan items that can start: brief frozen, not waiting on an open item, no task or PR yet. A finish-all order with room for another child is offered too. If nothing qualifies, the lead stays idle. |
| Once per change | A lead hears about the same runnable work once. It is told again only when that changes: an item is taken, done, added or unblocked. |
| Slices are reviewed as they land | A writer reports each finished PR (`report`, kind `slice_ready`), or marks its draft PR ready on GitHub. fleetd puts it on the train and starts its reviewers right away, while the writer goes on. A new commit is reviewed again from what changed. |

No gate relaxes. Every PR still gets its tier's reviews and green CI and goes through the train, done is still decided
by the done-when checks, and anything that needs your approval still waits for it. The reviewers fleetd starts count
against the slots and the lead's limit of 32 open tasks like any task.

## Change or stop it {#steer}

| You want to | In the order view | The lead |
|---|---|---|
| Add something | Type it, press Enter | Reads it at its next step. |
| Redirect it now | Type it, press ⌘Enter (Ctrl+Enter) | Stops its current step and reads it at once. |
| Stop the order | "Stop", then confirm | Cancels running and queued agents, withdraws its asks. Merged PRs stay. |

A stopped order stays stopped. To retry, send it again as a new order. You can steer any agent, not only the lead: see
[Steering](/docs/steering).

## Answer its questions {#answer}

Questions land in the inbox (⌘I), numbered. Reply in one line, such as `1 go 2 nvm 3 b`. See
[the reply format](/docs/desktop-app#reply). Commands and secrets have their own flow:
[Approvals & secrets](/docs/approvals-and-secrets).

## Done, checked {#done}

1. The lead calls `claim_done`.
2. The hub runs the brief's done-when checks itself.
3. Only all of them passing makes the order done. A failure wakes the lead with the exit code and output.

An order never closes over its review fixes: a task fixing what a review found, or a pull request a review sent back.
While one is open, `claim_done` is refused, and a claim whose checks pass meanwhile keeps the order open. The lead
says so in chat and claims again once the fixes land.

`claims_list` shows every claim with its evidence.

A done order cleans up after itself:

- Its pull requests still waiting (queued, in review, needing a rebase, or with failed CI) are closed on GitHub with a
  comment saying why.
- Its leftover tasks are cancelled, except review fixes, which keep going.
- A pull request the train is already rebasing, checking or merging is left to land.
