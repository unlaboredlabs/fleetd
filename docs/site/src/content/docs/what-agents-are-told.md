---
title: What agents are told
description: Every prompt fleetd sends a model, how to read and edit it, your own instructions, and what a running agent keeps.
---

You'll read, edit and reset the prompts fleetd sends to Claude, and add your own instructions.

```sh
fleetd prompts list
fleetd prompts show lead.start
```

The prompts fleetd sends a model are listed in `fleetd prompts list`, in the app's Settings → Prompts, and in the
[table at the end of this page](#prompts). You can edit each one. Everything else, such as the event lines a lead is
woken with, is fixed text: see [Not editable](#not-editable).

## How a session gets its instructions {#how}

There is no hidden system prompt. fleetd's text reaches a model in one of two ways:

| Way | Used for |
|---|---|
| The first message of a session | Leads, tasks, reviewers, judges. |
| A later message into a session | Wakes, review findings, train news, nudges, [steers](/docs/steering). |

Your own claude setup still applies underneath. See [Config & files](/docs/config-and-files#claude).

Agents act through fleetd's MCP tools. The list, generated from the code, is in
[Agent tools](/docs/reference/agent-tools).

## Rules agents work by {#rules}

### How the lead talks to you {#chat}

Each project's lead talks to you in that project's chat. It is told to:

- Lead with the state: what is done, what is running, what is blocked.
- Keep it short and plain, with no internal ids, keys or branch names.
- Ask only for product, money or irreversible calls, as numbered items at the end of its message, each with its
  recommendation.
- Ask once, and never about something already decided. While a question is open the chat shows the lead is waiting on
  you, and it carries on with other approved work.
- Read short replies by item number: "1 go, 2 rec", "go" (yes to everything open), "nvm" (drop it), and log each
  answer as a decision.
- Start the work a reply asks for in the same turn.

### No time estimates {#no-time}

fleetd never asks an agent how long something will take, and the lead is told never to put an ETA or a duration
anywhere. Work is sized `s`, `m` or `l` instead. What fleetd measures, such as CI runs and span durations, is shown as
measured. See [Status](/docs/status).

### Running the work {#running}

The lead is also told to:

- Start every agent with `spawn_agent`, and wait for results in its next wake instead of polling.
- Treat work as done only when its done-when checks pass, and pass a `human` check only on your own answer.
- Ask for secrets with `request_secret` and run risky commands with `gated_run`, which you approve.
- Leave merging to the merge train, which merges only after green CI and review.
- Spawn slices in separate areas together, up to the [Max agents](/docs/projects#max-agents) cap. A spawn past the cap
  queues and starts by itself.
- Never relax a review, CI, approval or check to go faster. Idle is fine.

Most of this is also enforced by the hub, which refuses a call that breaks it and says why. See [Safety rules](#safety).

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
| Lead | `spawn_agent`, `message_agent`, `agent_status`, `list_agents`, `stop_agent`, plus `workstream_open`, `brief`, `decide`, `claim_done`, `plan_*`, `request_secret`, `gated_run` and more. |
| Task | `report` (a review verdict, or a writer's PR that is ready for review), `ask_lead` and `claim_done`. |

- Results come back in the lead's next wake, never by polling.
- The hub enforces the split whatever a prompt says: a task can't start, steer or stop agents.
- A lead has at most 32 tasks open at once.
- A refusal says why and what to do instead.

Every tool and its inputs: [Agent tools](/docs/reference/agent-tools). The lead-side `fleetd` commands stay, for you.

## Safety rules: code or prompt {#safety}

| Kind | Examples | If you edit the words away |
|---|---|---|
| Enforced in code | Secrets are sealed to a machine. Gated commands wait for you. The hub decides "done". | Agents hit refusals they weren't warned about. Nothing else changes. |
| Prompt only | The lead never writes code. Only the train merges. Reviewers don't read the PR description. | Nothing else stops it. |

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
under "Custom instructions from the human". They are not added to wakes.

They are sized for about 500 characters; past that, `edit` warns. After your editor closes, `edit` prints any
warnings and asks `Save? [Y/n]` on the terminal. In a script, `</dev/null` takes the default, Yes.

## When fleetd changes a default you edited {#updates}

Your version stays in use.

- In Settings → Prompts, the prompt gets a warning dot. "Review the update" shows both changes, and you pick Save
  merged, Keep mine, or Use the new default.
- On the hub, `fleetd prompts list` marks it `update`, and `fleetd prompts diff <id>` shows both changes.

## When fleetd retires a prompt you edited {#retired}

A release can fold a prompt into another one or replace it with fixed text. Your edit to it then stops applying, but
fleetd keeps it and never moves it for you.

1. Open Settings → Prompts. Under "Edits that no longer apply", each one says, for example, "Your edit to Wake: task
   finished (hub-wide) no longer applies", why, and which prompt to copy it into.
2. "Show your text" shows your old edit; "Copy your text" copies it.
3. Paste what you still want into the prompt it names. If none takes its place, use your
   [instructions](#instructions).
4. Delete the old edit.

From an MCP client, `prompts_list` returns these under `orphans`, and `prompt_reset` with the old id deletes one.

An edited playbook file is listed the same way. Its review and check rules still apply, but its instructions no longer
reach the lead: the lead prompt has a section for each kind of work.

## What a running agent keeps {#pinning}

Each session keeps the exact prompt versions it started with. An edit reaches new sessions at once: a task at its next
attempt, a lead at its next start. To give a running lead your edit now, restart it with `lead_restart` from an
[MCP client](/docs/mcp-clients).

## See exactly what an agent was told {#told}

In a project's chat, open "What the lead was told", or open an agent from the agents strip. It shows the exact first
message, which version of each prompt it used, and the tools it never gets.

On the hub machine:

```sh
fleetd prompts show --session <machine>/<thread>
```

`session_prompt_get` returns the same to an MCP client.

## Not editable {#not-editable}

### Wake events {#wake-events}

A lead is woken with its project's state, then one line per thing that happened since its last wake:

```
# project lab (devbox/lab), 2026-10-19T14:02:11.000Z
agents: 3 running of 6, 1 queued

## Work
- W2 running (bugfix): flaky login test
  done when: done:0 test login_flaky passes in acme/app

## Events
- PR #12 merged as 4f1c2a9e0b7d: https://github.com/acme/app/pull/12 (C4, tier S, serves done:0, by T4)
- T5 finished: port the parser (branch fleetd/T5-port, PR https://github.com/acme/app/pull/13)
  > Ported; 2 blockers left for review.
- T7 waiting for an answer: docs
  > Which branch should the docs go to?
- W4 research verdict STOP: candidate 1.2 vs baseline 1.1 (higher is better): improvement 0.1 (go line 5, stop line 2)
```

Each event is `- <subject> <what>: <detail>`, sometimes followed by `  > ` lines quoting an agent. The ids (W2, T5,
C4) are for the lead's tools; the lead doesn't repeat them to you. The format is fixed in code, so it is the same in
every project.

### Fixed messages {#fixed}

These are short notices, the same everywhere: the brief of a read-only or review task, a reviewer's note on what
changed since its last review, "fix your PR" (a rebase, red CI or blocking review findings), a denied tool call with
its reason, the plan's sizing warning, the pause and resume an agent gets when the max agents drops below it, the
watchdog's nudge and the note after a usage limit resets.

### Tool texts {#tool-texts}

MCP tool descriptions, fleetd's agent tools included, and what the hub answers back (each `next:` and `fix:`) are
tied to code: a description must match its tool, and a `next:` must name a real tool or command. See
[Agent tools](/docs/reference/agent-tools) and the [CLI reference](/docs/reference/cli).

## Every prompt {#prompts}

Generated from the registry in the binary this site was built with. `fleetd prompts show <id>` prints one.

<!-- prompt-table -->

### Lead

| Id | Sent | Safety rules |
|---|---|---|
| `lead.start` | lead start and every lead\_restart, followed by the state block | the lead never writes code (prompt only); asks the human only for product, money or irreversible calls (prompt only); asks as numbered items, each with a recommendation (prompt only); never estimates time (prompt only); secrets only through \`request\_secret\`; prod writes, spends and deletes only through \`gated\_run\`; only the merge train merges (prompt only); done only through \`claim\_done\` |

### Tasks

| Id | Sent | Safety rules |
|---|---|---|
| `task.brief.write` | every write task attempt | changes only its areas; never merges; the train does (prompt only) |

### Reviews and checks

| Id | Sent | Safety rules |
|---|---|---|
| `review.reviewer` | per PR head per review round, by the tier's rules; Claude or Codex | does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `review.verifier` | tier L, per PR head | does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `judge` | per \`judge\` done-when check of each claim | trusts no claim in the artifacts (prompt only); ends with one review verdict (the \`report\` tool) |
| `judge.research` | per \`judge\` check of a research claim | trusts no claim in the artifacts (prompt only); ends with one review verdict (the \`report\` tool) |

### Messages

| Id | Sent | Safety rules |
|---|---|---|
| `steer.message` | per steer (steer\_send, task message), straight to the agent, at its next tool boundary or now | asks the agent to name the steer first, so its receipt can say it was acknowledged (prompt only) |

<!-- /prompt-table -->
