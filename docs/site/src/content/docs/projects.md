---
title: Projects
description: "Add a project, choose its branch, task profiles and settings, and how its lead plans the work."
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
To also remove the worktrees its agents worked in, delete it from the app instead: see [Delete a project](#delete).

## Project settings {#settings}

Open a project's settings in the desktop app: Settings → Projects, then pick the project. Machines → a project's
**…** menu → **Settings…** opens the same page.

| Setting | Does |
|---|---|
| Name | How fleetd shows the project. Its folder keeps its own name. |
| Keep finished worktrees | Off (the default): a reader's worktree goes when its task finishes, and a writer's once its pull request merges. On: they stay on the machine. |
| Environment variables | Variables every new agent of the project gets. See [Environment variables](#env). |
| MCP servers | The project's own MCP servers for its agents, and the global ones it gets. See [MCP servers](/docs/mcp-servers). |
| Delete project | See [Delete a project](#delete). |

The page also shows where the project's worktrees live on its machine (`~/.fleetd/node/worktrees/<project>/`, one per
agent), the branch new ones start from (the repo's default branch, freshly fetched; see [Which branch](#branches)),
and how many are there now. That part needs the machine online.

### Environment variables {#env}

Add one at a time with **Add variable**, or paste a `.env` file with **Paste .env**. A pasted file may use `export`,
quotes and `#` comments, and a quoted value may run over several lines, as a certificate chain or a service account's
JSON does. A name that looks like a credential (`STRIPE_KEY`, `GH_TOKEN`, `DB_PASSWORD`) starts as a secret, and each
one can be switched.

| Kind | Where its value lives | Shown |
|---|---|---|
| Plain | The hub and the project's machine. | In the list. |
| Secret | Only the project's machine. | Never again: only its fingerprint (the first 8 hex characters of its SHA-256) and its size. |

A secret is sealed in the app to its machine's key, as a [secret request](/docs/approvals-and-secrets#secrets) is. The
hub passes the sealed value on without storing or logging it. The node keeps the project's variables in a file of its
own in `~/.fleetd/node/project-env/`, mode `0600`, and adds them to every claude it starts for the project from then on.
An agent already running gets a change at its next start. To change a secret, type a new value: the old one is never
shown.

If an agent prints a secret (`printenv`, a stack trace, a config dump), the node replaces it with `***NAME***` before
the output leaves the machine, in command output, the agent's replies and live text alike. Exactly these are masked:

- the whole value, and its base64 and URL encodings;
- for a secret of several lines, each whole line of 8 characters or more, wherever it appears. PEM armor lines such as
  `-----BEGIN CERTIFICATE-----` are the same in every file and stay readable.

Only exact matches are caught. Part of a line (`head -c 20` of a key, one field cut from a line), the value in another
encoding, or a value under 4 characters goes out as printed, so keep secrets out of output where you can. A line of a
secret is masked even where the same text comes from somewhere else, such as a generic line of a JSON file.

The hub and the app never get a secret's value: they see its name, its fingerprint and its size in bytes (the size
counts toward the project's total).

Names are letters, digits and `_`. fleetd sets `HOME`, `PATH`, `USER`, `TMPDIR` (and `TMP`, `TEMP`) and every
`FLEETD_` variable itself, and a project can't change how claude itself runs: `ANTHROPIC_*` and `CLAUDE*` names are
refused. A variable the node already gives every session, from its own environment or
[`claude.env`](/docs/config-and-files), keeps the node's value.

| Limit | Is |
|---|---|
| Variables in a project | 100 |
| One value, plain or secret | 64 KiB, any number of lines, no NUL character |
| All of a project's values together | 512 KiB: every one goes into every agent's environment, and the system refuses to start a process whose environment is too large |

:::caution
Setting a variable needs the project's machine online. Nothing is queued.
:::

From an MCP client: `project_settings_get` reads a project's settings, `project_settings_set` renames it or sets
`keepWorktrees`, and `project_env_set` sets and removes variables, a secret sealed to the machine's `boxPubKey`.
`project_env_set` takes only a human key.

### Delete a project {#delete}

**Delete project…** stops the project's agents, removes the worktrees they worked in, and forgets the project and its
settings. Type the project's name to confirm. If any of its worktrees has uncommitted changes, the dialog names them:
those changes are lost. The app lists the worktrees again when you click it, so Delete waits while the project's
machine is offline or can't list them.

What stays: the checkout itself, untouched, every branch (so every commit stays reachable), your own worktrees of the
repo, and its pull requests on GitHub. Add the folder again any time; the toast after a delete has **Add it again**.

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

Each machine runs as many agents at once as it fits, each project has a cap of its own, and you may set one across the
whole fleet. The hub enforces all of them; the lead plans to them.

| Cap | Counts | Default | Set it |
|---|---|---|---|
| Per machine | Every project's agents on the machine. Not the leads. | What it fits: one per CPU less one in eight, and 2 GB of memory each after a quarter of it (4 to 16 GB) is left for the system, at most 64. An 8 GB laptop fits 2, a 32 GB one 12. | node.json's `memPerAgentGb` changes the 2 GB. |
| Per project: Max agents | The project's agents: writers, readers, reviewers. Not the lead. | Its machine's cap | Click "agents 6 / 12" in the project's chat header, or use Settings → Agents. |
| Fleet-wide | Every project's agents together. Not the leads. | None: the machines' caps added up | Settings → Agents → Whole fleet. Needs an admin key. A fleet cap saved before stays until you change it. |

New agents on a machine also wait for disk: 5 GB each (`diskPerAgentGb`) above the free-space floor, with agents started
in the last 10 minutes still counted, since their worktrees haven't grown yet. The lead's state line names what sets
its cap, e.g. "agents: 4 running of 6 (auto: memory 18 GB), 2 queued".

The memory figure only sizes a machine's default cap. No agent waits for the memory it might take: a Max agents you set
starts that many, as far as the machine's cap and disk allow. What does hold new agents back is memory really in use, the
[guard's pause](/docs/machines#guard) at 90%.

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
