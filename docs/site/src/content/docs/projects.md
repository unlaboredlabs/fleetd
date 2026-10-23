---
title: Projects
description: "Add a project, choose its branch and task profiles, and how its lead plans the work."
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
   Lead needs: no CI found: the merge train holds its PRs until the repo has CI
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

## Max agents {#max-agents}

Each project has a cap on how many agents run at once, and the fleet has one across all projects. The hub enforces
both; the lead plans to them.

| Cap | Counts | Default | Set it |
|---|---|---|---|
| Per project: Max agents | The project's agents: writers, readers, reviewers. Not the lead. | The fleet cap | Click "agents 6 / 12" in the project's chat header, or use Settings → Agents. From 1 up to the fleet cap. |
| Fleet-wide | Every project's agents together. Not the leads. | | Settings → Agents → Whole fleet. Needs an admin key. |

The header shows "· 2 queued" when agents wait their turn. While you move the slider it says what the change will do; it
applies when you let go, with Undo. A fleet cap below a project's own max gets a warning.

Writers in a project run side by side, each in its own worktree and branch. The lead gives them slices that touch
separate files; if two PRs still conflict, the [merge train](/docs/merge-train) sends the later one back to its writer.

![The Max agents control open in storefront's chat header: a slider set to 12, from 1 up to 16 (the fleet's limit), with "6 agents running now".](/docs/img/max-agents.png)

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
- New agents also wait while their machine is short of disk or CPU ([Disk and load](/docs/machines#guard)).
- Reviewers count toward the cap, but a review that gates a merge goes first, so a low cap never stalls
  the merge train.

Changing it while work runs:

| You | What happens | The line in the chat |
|---|---|---|
| Lower the cap | Running agents finish their current work; new ones wait. Nothing is killed. | Max agents 6 → 3: 6 running finish their work; new agents wait. |
| Lower it, then click "Pause the 3 extras now" ("Pause the extra one now" for one) | Agents over the cap push their work in progress and wait. Each resumes when a slot frees. | Two lines: Max agents 6 → 3: 6 running finish their work; new agents wait. Then: Max agents 3: 3 agents push their work and wait; 3 keep running. |
| Raise the cap | Queued agents start at once, and the lead is told how many slots are free. | Max agents 3 → 6: 2 queued agents start now, 1 slot free. |

The lead plans to the cap: at most that many slices at once, the rest queued by value, each slot filled as it frees.
It never works around the cap: it doesn't do a writer's work itself, or ask you to raise it unless you asked about
speed. At a cap of 1 it works one piece at a time and says so once.

## Models and cost {#models}

Every agent runs on `claude-opus-5-5`, with one of two profiles:

| Profile | Effort | Runs |
|---|---|---|
| `high` | high | The default. The lead, every review, every helper call, and every task the lead doesn't mark medium. |
| `medium` | medium | Mechanical tasks the lead picks: dead-code deletions, renames, test removals, doc fixes, moving files, plain wiring, screenshot recaptures. Never design, concurrency, auth or secrets, approvals or the merge train. |

The lead picks the profile for each task it starts. A medium task whose review finds blockers twice is redone on high.
Each agent's profile shows on its lane (`T12 medium`), and the time
view splits agent time and output tokens by profile, so you can see what medium saves.

| To change | Do |
|---|---|
| Whether the lead may use medium | Settings → Agents → the project's Medium allowed switch, or `fleetd project set <machine>/<project> --medium off`: every new task runs on high. `--medium on` allows medium again (the default). |
| When the lead picks medium | Edit the **Task profiles** prompt (`lead.profiles`) like any [prompt](/docs/what-agents-are-told). It takes effect at the lead's next start. |

There is no other model or effort: no setting, flag or policy key picks one. An older policy file's `defaults.model`
and `defaults.effort` are ignored.

## How the lead schedules work {#scheduling}

The lead plans each piece of work as small items, sized S, M or L, some waiting `after` others. It starts every item it can
in parallel. Spawns past the cap queue and start by themselves as slots free, and the lead is woken whenever an agent
finishes or a PR merges. fleetd never starts work of its own.

Slices are reviewed as they land: once a writer's PR is ready (not a draft), on its branch or one named after it,
fleetd puts it on the train and starts its reviewers, while the writer goes on. On a repo whose PRs have never been on
the train, that starts with the writer's result. A new commit is reviewed again from what changed.

No gate relaxes. Every PR still gets its review and green CI and goes through the train, and anything that needs
your approval still waits for it. The reviewers fleetd starts count against the slots and the lead's limit of 32 open
tasks like any task.
