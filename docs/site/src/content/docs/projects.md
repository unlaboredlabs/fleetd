---
title: Projects
description: "Add a project, choose its branch and models, and how its lead plans the work."
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
   Write to its lead in the app's chat, or from any agent with chat_send; the lead starts with the first message.
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

Each project has one [lead](/docs/glossary#lead) and one chat with it. Your first message starts the lead: there is
nothing to start by hand. See [Chat with the lead](/docs/chat).

If the lead can't start, your message waits and the chat says why. Common causes:

| Cause | Fix, on the worker |
|---|---|
| `claude` is logged out | `claude auth login` |
| `claude` is outside the supported versions | See [claude versions](/docs/troubleshooting#claude) |
| The worker is offline | See [Machines](/docs/troubleshooting#machines) |

Once the worker is back with a working `claude`, the lead starts and reads every waiting message.

To keep a lead from starting by itself, set `lead.autoStart: false` in the project's
[policy file](/docs/config-and-files#policy). Messages then wait for `lead_start`.

## Max agents {#max-agents}

Each project has a cap on how many agents run at once, and the fleet has one across all projects. The hub enforces
both; the lead plans to them.

| Cap | Counts | Default | Set it |
|---|---|---|---|
| Per project: Max agents | The project's agents: writers, readers, reviewers, verifiers. Not the lead's own turns. | The fleet cap | Click "agents 6 / 12" in the project's chat header, or use Settings → Agents. From 1 up to the fleet cap. |
| Fleet-wide | Every running turn, leads included. | | Settings → Agents → Whole fleet. Needs an admin key. |

The header shows "· 2 waiting" when agents are queued. Before you save, the slider says what the change will do.

![The Max agents control open in storefront's chat header: a slider set to 12, from 1 up to 16 (the fleet's limit), with "6 agents running now" and Save.](/docs/img/max-agents.png)

From a terminal:

```sh
fleetd project set devbox/storefront --max-agents 3
fleetd project set devbox/storefront --max-agents 2 --pause-extras
fleetd project set --fleet-cap 20        # needs an admin key
```

From an [MCP client](/docs/mcp-clients): `cap_set {project: {projectRef, maxAgents, pauseExtras?}}` with an operate
key, or `cap_set {cap}` for the fleet cap with an admin key.

When the cap is reached:

- A new agent **queues**; it doesn't fail. The lead is told its place in line, and the hub starts it the moment a
  slot frees.
- Reviewers and verifiers count toward the cap, but a review that gates a merge goes first, so a low cap never stalls
  the merge train.

Changing it while work runs:

| You | What happens | The line in the chat |
|---|---|---|
| Lower the cap | Running agents finish their current work; new ones wait. Nothing is killed. | Max agents 6 → 3: 6 running finish their work; new agents wait. |
| Lower it and tick "Pause the 3 extras now" ("Pause the extra one now" for one) | Agents over the cap push their work in progress and wait. Each resumes when a slot frees. | Max agents 6 → 3: 3 agents push their work and wait; 3 keep running. |
| Raise the cap | Queued agents start at once, and the lead is told how many slots are free. | Max agents 3 → 6: 2 queued agents start now, 1 slot free. |

The lead plans to the cap: at most that many slices at once, the rest queued by value, each slot filled as it frees.
It never works around the cap: it doesn't do a writer's work itself, or ask you to raise it unless you asked about
speed. At a cap of 1 it works one piece at a time and says so once.

## Models and cost {#models}

By default the lead and every task run on `claude-opus-5-5` at high effort.

| To change | Do |
|---|---|
| The lead's model and effort | Call `lead_start {machineId, projectId, model, effort}` from an [MCP client](/docs/mcp-clients) before your first message to the project. They are saved for the project. |
| The tasks' model and effort | Set `defaults.model` and `defaults.effort` in the project's [policy file](/docs/config-and-files#policy), committed to the default branch. |

For example, to try fleetd cheaply on a test project:

1. Before your first message to it, call
   `lead_start {"machineId":"devbox","projectId":"<id>","model":"claude-haiku-5-5","effort":"low"}`. `fleetd project
   list` shows the ids.
2. Commit this `.fleetd/policy.yaml` to the default branch. Without `areas`, the project keeps the areas fleetd
   [infers from the repo](/docs/config-and-files#inferred-areas).

   ```yaml
   defaults:
     model: claude-haiku-5-5
     effort: low
   ```

## How the lead schedules work {#scheduling}

The lead plans each piece of work as small items, sized S, M or L, some waiting `after` others. It starts every item it can
in parallel while slots are free. fleetd keeps that going, but never starts work by itself:

| Rule | What happens |
|---|---|
| A free slot is offered | When a slot frees and the lead is idle, fleetd wakes it with the plan items that can start: brief frozen, not waiting on an open item, no task or PR yet. Finish-all work with room for another child is offered too. If nothing qualifies, the lead stays idle. |
| Once per change | A lead hears about the same runnable work once. It is told again only when that changes: an item is taken, done, added or unblocked. |
| Slices are reviewed as they land | A writer reports each finished PR (`report`, kind `slice_ready`), or marks its draft PR ready on GitHub. fleetd puts it on the train and starts its reviewers right away, while the writer goes on. A new commit is reviewed again from what changed. |

No gate relaxes. Every PR still gets its tier's reviews and green CI and goes through the train, done is still decided
by the done-when checks, and anything that needs your approval still waits for it. The reviewers fleetd starts count
against the slots and the lead's limit of 32 open tasks like any task.
