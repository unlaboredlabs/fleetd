---
title: What agents are told
description: Every prompt fleetd sends a model, how to read and edit it, your own instructions, and what a running agent keeps.
---

You'll read, edit and reset the prompts fleetd sends to Claude, and add your own instructions.

```sh
fleetd prompts list
fleetd prompts show lead.start
```

Every word fleetd sends a model is listed in `fleetd prompts list`, in the app's Settings → Prompts, and in the
[table at the end of this page](#prompts). You can edit each one.

## How a session gets its instructions {#how}

There is no hidden system prompt. fleetd's text reaches a model in one of three ways:

| Way | Used for |
|---|---|
| The first message of a session | Leads, tasks, reviewers, judges. |
| A later message into a session | Wakes, review findings, train news, nudges, [steers](/docs/steering). |
| The input of a one-shot `claude -p` with no tools | The order router, the retro, the status headline. |

Your own claude setup still applies underneath. See [Config & files](/docs/config-and-files#claude).

Agents act through fleetd's MCP tools. The list, generated from the code, is in
[Agent tools](/docs/reference/agent-tools).

## Rules agents work by {#rules}

### No time estimates {#no-time}

fleetd never asks an agent how long something will take. Leads are told never to put an ETA or a duration in a brief,
an ask, a status line, a plan or a summary. Plan items are sized `s`, `m` or `l` instead.

What fleetd measures, such as CI runs and span durations, is shown as measured. See [Status](/docs/status).

### Max efficiency without compromising {#efficiency}

In place of a clock, leads are told to work for throughput:

- Keep every slot busy.
- Run work that touches separate areas in parallel.
- Have each slice reviewed as it lands, and put each finished PR on the train at once.
- End a turn only to wait on their agents, or when nothing approved can run.

They are also told that no gate relaxes for speed: reviews, CI, the train, done-when checks and your approvals stay
exactly as they are, and no filler work is made up to fill a slot. fleetd backs this up with two wakes, never with a
task of its own. See [How the lead schedules work](/docs/projects-and-orders#scheduling).

### Claude's auto memory is off {#auto-memory}

Claude Code can keep its own notes per folder ("auto memory"). fleetd turns that off in every `claude` it starts, so
what an agent knows comes from its brief, the decisions and your instructions, all of which you can read here.

`fleetd doctor` shows "claude auto memory off" for each machine. To turn it back on for one project, set
`claude: { autoMemory: true }` in its [policy file](/docs/config-and-files#policy).

### Claude's own subagents are off {#no-subagents}

Every agent in fleetd is a fleetd agent, with its own session, slot, worktree, lane, steering and receipts. So fleetd
turns off Claude Code's own subagents in every `claude` it starts. Your `~/.claude` is left alone.

| What | In fleetd sessions |
|---|---|
| Claude's agent, team and background-task tools (Agent/Task, Workflow, ListAgents, SendMessage, TaskStop) | Denied, including any a newer claude adds. |
| Built-in Explore, Plan and `claude` agents, background shell commands | Switched off. |
| general-purpose, statusline-setup, and your agents in `~/.claude/agents` | Still listed by claude, but nothing can start them. |

`fleetd doctor` shows "Claude subagents off (fleetd manages agents)" for each machine. If a session ever offers one
anyway, that machine starts no new sessions until it is fixed: see [Claude](/docs/troubleshooting#claude).

### Agents use fleetd's tools {#agent-tools}

Leads and tasks reach fleetd through MCP tools from a `fleetd` server in their session, not through the shell.

| Agent | Gets |
|---|---|
| Lead | `spawn_agent`, `message_agent`, `agent_status`, `list_agents`, `stop_agent`, plus `ask`, `decide`, `brief`, `claim_done`, `plan_*`, `gated_run` and more. |
| Task | `report` (a review verdict, or a writer's PR that is ready for review), `ask_lead` and `claim_done`. |

- Results come back in the lead's next wake, never by polling.
- The hub enforces the split whatever a prompt says: a task can't start, steer or stop agents.
- A lead has at most 32 tasks open at once.
- A refusal says why and what to do instead.

Every tool and its inputs: [Agent tools](/docs/reference/agent-tools). The lead-side `fleetd` commands stay, for you.

## Safety rules: code or prompt {#safety}

| Kind | Examples | If you edit the words away |
|---|---|---|
| Enforced in code | Secrets are sealed to a machine. Gated commands wait for you. Only the train merges. The hub decides "done". | Agents hit refusals they weren't warned about. Nothing else changes. |
| Prompt only | The lead never writes code. Reviewers don't read the PR description. A lead doesn't re-ask a decided question. | Nothing else stops it. |

The [table below](#prompts) marks prompt-only rules.

## Edit a prompt {#edit}

In the app: Settings → Prompts. Pick hub-wide or one project, open a prompt, edit it and Save. "Compare with default"
shows your changes; "Reset to default" drops them.

On the hub machine:

| Command | Does |
|---|---|
| `fleetd prompts show lead.start` | Print the text in effect. `--default` prints fleetd's. |
| `fleetd prompts edit lead.start` | Edit in `$VISUAL` or `$EDITOR`, see warnings, then `Save? [Y/n]`. |
| `fleetd prompts edit task.brief.write --project builder-1/app` | Edit one project's version. |
| `fleetd prompts diff lead.start` | fleetd's text against yours. |
| `fleetd prompts reset lead.start` | Go back to fleetd's text. |

- A project's version beats the hub-wide one, which beats fleetd's.
- One-shots and playbooks have only the hub-wide level.
- Your versions are files under `~/.fleetd/hub/prompts/`. Change them with `fleetd prompts edit`, not by hand.
- From an MCP client: `prompts_list`, `prompt_get`, `prompt_set` (with `dryRun` to see the warnings only) and
  `prompt_reset`.

Prompts fill in `{{name}}` placeholders, such as `{{project}}`. Nothing else is template syntax.

### Warnings {#warnings}

Saving never refuses text that isn't empty, but it warns:

| Warning | Means |
|---|---|
| A required placeholder is missing | That value no longer reaches the agent. |
| Unknown placeholder | `{{name}}` isn't one this prompt fills; it is sent as written. |
| A safety rule is missing | Its wording is gone. The warning says whether code still enforces it. |
| Too long | Over three times the length of fleetd's text, plus 500 characters. Every session that gets it pays for it. |

## Your own instructions {#instructions}

In the app: Settings → Instructions. On the hub machine:

```sh
fleetd instructions edit
fleetd instructions edit --project builder-1/app
fleetd instructions show
```

They are added to every lead's first message and every task brief (writers, reviewers and judges), hub-wide first,
under "Custom instructions from the human". They are not added to the router, the retro or wakes.

They are sized for about 500 characters; past that, `edit` warns. After your editor closes, `edit` prints any
warnings and asks `Save? [Y/n]` on the terminal. In a script, `</dev/null` takes the default, Yes.

## When fleetd changes a default you edited {#updates}

Your version stays in use.

- In Settings → Prompts, the prompt gets a warning dot. "Review the update" shows both changes, and you pick Save
  merged, Keep mine, or Use the new default.
- On the hub, `fleetd prompts list` marks it `update`, and `fleetd prompts diff <id>` shows both changes.

:::caution
An edited playbook gets no notice when fleetd's version changes. After an update, check it with
`fleetd prompts diff playbook.<name>`.
:::

## What a running agent keeps {#pinning}

Each session keeps the exact prompt versions it started with. An edit reaches new sessions at once: a task at its next
attempt, a lead at its next start. To give a running lead your edit now, restart it with `lead_restart` from an
[MCP client](/docs/mcp-clients).

## See exactly what an agent was told {#told}

In an order, click "What the lead was told", or open an agent's sheet. It shows the exact first message, which version
of each prompt it used, and the tools it never gets.

On the hub machine:

```sh
fleetd prompts show --session <machine>/<thread>
```

`session_prompt_get` returns the same to an MCP client.

## Not editable {#not-editable}

MCP tool descriptions, fleetd's agent tools included, and what the hub answers back (each `next:` and `fix:`) are
tied to code: a description must match its tool, and a `next:` must name a real tool or command. See
[Agent tools](/docs/reference/agent-tools) and the [CLI reference](/docs/reference/cli).

## Every prompt {#prompts}

Generated from the registry in the binary this site was built with. `fleetd prompts show <id>` prints one.

<!-- prompt-table -->

### Lead

| Id | Sent | Safety rules |
|---|---|---|
| `lead.start` | lead start and every lead\_restart, followed by the digest | the lead never writes code (prompt only); delegates only with \`spawn\_agent\`, no other agents; asks the human only about product, money, credentials, irreversible (prompt only); secrets only through \`ask\` with kind secret; prod writes, spends and deletes only through \`gated\_run\`; never blocks on a question (\`proceededOnRec\`) (prompt only); done only through \`claim\_done\`; every write says what it serves; only the merge train merges; never re-asks a key the digest lists (prompt only); a frozen brief changes only with \`amend\`; never relaxes a review, CI, train, done-when or approval gate for speed |
| `lead.digest` | the top of the lead's first message and of every wake | the digest is the truth, over the lead's memory (prompt only) |
| `plan.granularity` | when \`plan\_add\` (or \`plan\_edit\` with a size) gets an item with no size or one bigger than m |  |

### Tasks

| Id | Sent | Safety rules |
|---|---|---|
| `task.brief.write` | every write task attempt | changes only its areas; never merges; the train does; the PR body carries \`Source:\`; does the task itself, no subagents |
| `task.brief.read` | every read task attempt | changes no files (prompt only); does the task itself, no subagents |
| `task.brief.review` | every review, verifier and judge task attempt | changes no files (prompt only); does the task itself, no subagents; ends with one review verdict (the \`report\` tool) |
| `task.train_rebase` | per PR the train could not rebase |  |
| `task.train_ci_failed` | per PR whose CI failed or timed out |  |

### Reviews and checks

| Id | Sent | Safety rules |
|---|---|---|
| `wake.claim_failed` | per failed done claim |  |
| `wake.claim_passed` | per claim that passed late |  |
| `wake.claim_held` | per claim that passed while write work of the order had not landed |  |
| `wake.order_done_work_kept` | per order that became done, not through a claim, while some of its write work had not landed |  |
| `wake.research_verdict.go` | per research claim that went GO |  |
| `wake.research_verdict.stop` | per research claim that went STOP | STOP is a success (prompt only) |
| `wake.research_verdict.inconclusive` | per research claim that was inconclusive |  |
| `review.reviewer` | per PR head per review round, by the tier's rules; Claude or Codex | does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `review.delta` | after the reviewer's or verifier's text, when the PR was reviewed at an earlier head |  |
| `review.verifier` | tier L, per PR head | works in a detached temporary worktree (prompt only); does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `judge` | per \`judge\` done-when check of each claim | trusts no claim in the artifacts (prompt only); ends with one review verdict (the \`report\` tool) |
| `judge.research` | per \`judge\` check of a research claim | trusts no claim in the artifacts (prompt only); ends with one review verdict (the \`report\` tool) |
| `task.review_findings` | per blocking review verdict | never merges; the train does |

### Wakes and messages

| Id | Sent | Safety rules |
|---|---|---|
| `digest.workstream.no_brief` | each digest, per draft order |  |
| `digest.finish_all_idle` | each digest, per idle finish-all order |  |
| `digest.answer.withdrawn` | each digest, per dropped ask |  |
| `digest.answer.skipped` | each digest, per skipped ask |  |
| `digest.tasks.running` | each digest, per running task |  |
| `digest.tasks.idle` | each digest, per idle task |  |
| `digest.tasks.queued` | each digest, per queued task |  |
| `digest.tasks.ended` | each digest, per task ended since the last wake |  |
| `digest.train.repo` | each digest, per train |  |
| `digest.train.merged` | each digest, per merge since the last wake |  |
| `digest.train.parked` | each digest, per PR needing a rebase or red CI |  |
| `digest.train.waived` | each digest, per waived PR |  |
| `wake.frame` | every wake |  |
| `wake.intent` | per new order |  |
| `wake.intent.playbook` | per new order with a playbook the digest does not show |  |
| `wake.intent.playbook_listed` | per new order with a playbook the digest shows |  |
| `wake.decision` | per decision the human recorded in the project |  |
| `wake.answers` | per batch of answers |  |
| `wake.task_result` | per task that completed or failed |  |
| `wake.task_cancelled` | per cancelled task |  |
| `wake.task_waiting` | per task waiting on input | asks the human only about product, money, credentials, irreversible (prompt only) |
| `wake.task_start_failed` | per queued task that failed to start (its result) |  |
| `wake.train.line` | when the train could not reach a PR's author task |  |
| `wake.train.left` | per PR the train abandoned |  |
| `wake.train.merged` | per merge |  |
| `wake.train.gave_up` | per PR GitHub refused to merge too often |  |
| `wake.train.refused` | per task PR the train would not take |  |
| `steer.message` | per steer (steer\_send, task message), straight to the agent, at its next tool boundary or now | asks the agent to name the steer first, so its receipt can say it was acknowledged (prompt only) |
| `wake.agent_steer` | per steer\_send to a task, at the lead's next wake (debounced, never an interrupt) |  |
| `wake.order_refs` | per new order with references or attachments |  |
| `wake.order_stopped` | per order that project\_stop stops | does no more work on a stopped order (prompt only) |
| `wake.runnable` | when a slot frees, the lead is idle and approved, unblocked work no task has taken waits; once per change in that work | the lead decides what to start; the hub never spawns (prompt only) |
| `wake.order_idle` | when the lead ends a turn with a frozen order and nothing under way |  |
| `wake.scheduled_late` | a wake\_set message that fired late |  |
| `wake.scheduled_held` | a wake\_set message held by a usage pause |  |
| `watchdog.nudge` | once per stalled run |  |
| `usage.continue` | per parked thread when the usage limit resets |  |
| `permission.denied.policy` | per tool call a tools.deny rule refuses (tool result) |  |
| `permission.denied.withdrawn` | per tool ask withdrawn before an answer (tool result) | does not retry the call (prompt only) |
| `permission.denied.human` | per tool ask the human denied (tool result) |  |
| `permission.denied.answer` | per tool call denied with thread\_answer and no message (tool result) |  |

### One-shots

| Id | Sent | Safety rules |
|---|---|---|
| `router` | each order without @project or a template prefix | uses no tools; replies with JSON only (prompt only) |
| `status.headline` | when a viewed status scope's facts change | uses no tools; replies with one line of at most 160 characters; uses only numbers from the facts; never estimates time |
| `router.retry` | once per order, after an unusable first answer |  |
| `retro` | each retro run (at most 2 a day) | uses no tools; at most 3 changes |

### Playbooks

| Id | Sent | Safety rules |
|---|---|---|
| `playbook.bugfix` | in the digest and the intake wake, while an order follows it | never merges; the train does |
| `playbook.feature` | in the digest and the intake wake, while an order follows it | never merges; the train does |
| `playbook.research` | in the digest and the intake wake, while an order follows it | STOP is a success (prompt only) |
| `playbook.finish-all` | in the digest and the intake wake, while an order follows it |  |

<!-- /prompt-table -->
