---
title: What agents are told
section: Using fleetd
order: 65
description: Every prompt fleetd sends a model, how to read, edit, reset and diff it, your own instructions, and what a running agent keeps.
---

Every word fleetd sends a model is listed on this page, in the app's Settings → Prompts and in `fleetd prompts list`,
and you can edit each one. A session keeps the text it started with.

## How a session gets its instructions

There is no hidden system prompt. fleetd's instructions are the first message of a session (lead, task, reviewer,
judge), later messages into it (wakes, review findings, train news, nudges), or the input of a one-shot `claude -p`
with no tools (the router, the retro). Your own claude setup applies as usual underneath
([Config & files](config-and-files.md)). [Every prompt](#prompts) is listed at the end of this page.

A [steer](steering.md) reaches the agent as one short message from you, wrapped in the `steer.message` prompt,
which asks it to begin its reply with the steer's id. When you steer an agent directly, its lead hears about it in a
wake line (`wake.agent_steer`).

## No time estimates {#no-time}

Agents are bad at judging time, so fleetd never asks one for an estimate. No prompt asks for an ETA, a duration or
"this should take", and leads are told never to put one in a brief, an ask, a status line, a plan or a summary. Plan
items and research budgets are sized S, M or L instead. What fleetd measures (CI runs, span durations, ages) is
shown as measured; see [Status](status.md).

## Max efficiency without compromising {#efficiency}

In place of a clock, leads are told to work for throughput: keep every slot busy, run work that touches separate areas
in parallel, have each slice reviewed as it lands, put each finished PR on the train at once, and end a turn only to
wait on their agents or when nothing approved can run. They are also told that no gate relaxes for speed: reviews,
CI, the train, done-when checks and your approvals stay exactly as they are, and no filler work is made up to fill a
slot. fleetd backs this up with two wakes, never with a spawn of its own ([How the lead schedules
work](projects-and-orders.md#scheduling)).

## Claude's auto memory is off {#auto-memory}

Claude Code can keep its own notes per folder ("auto memory") and read them back in later sessions. fleetd turns that
off in every claude it starts, whatever your `~/.claude/settings.json` says: what an agent knows comes from its brief,
the decisions and your instructions, all of which you can read here, not from notes another agent left behind in a
worktree. `fleetd doctor` shows "claude auto memory off" for each machine once a session has run there. A project
turns it back on for its sessions with `claude: { autoMemory: true }` in its
[policy file](config-and-files.md#policy).

## Claude's own subagents are off {#no-subagents}

Every agent in fleetd is a fleetd agent: its own session, slot, worktree, lane, steering and receipts. So fleetd turns
Claude Code's own subagent system off in every claude it starts, and gives agents fleetd's tools instead. Your
`~/.claude` is left alone; this applies to fleetd's sessions only.

- Claude's agent, team and background-task tools (Agent/Task, Workflow, ListAgents, SendMessage, TaskStop and any
  like them the installed claude has) are denied. fleetd reads the installed claude's tool list when it checks the
  runner, so a tool a new claude version adds is denied too.
- Its built-in Explore, Plan and `claude` agents and background shell commands are switched off. Two built-in
  agents (general-purpose, statusline-setup) and your own agents from `~/.claude/agents` still appear in claude's
  list, since no setting removes them, but nothing can start them.
- `fleetd doctor` shows "Claude subagents off (fleetd manages agents)" for each machine. If a session ever offers one
  of them anyway, the check fails, no new session starts on that machine and the fix is to install the claude version
  fleetd was tested with.

Leads and tasks reach fleetd through MCP tools from a `fleetd` server in their session, not through the shell. A lead
gets `spawn_agent`, `message_agent`, `agent_status`, `list_agents` and `stop_agent`, plus `ask`, `decide`, `brief`,
`claim_done`, `plan_*`, `gated_run` and the rest of what it used to run as `fleetd` commands. A task gets three:
`report` (a review verdict, or a writer's PR that is ready for review), `ask_lead` and `claim_done`. Results come back in the lead's next wake, never by polling.
The hub enforces the split whatever a prompt says: a task can't start, steer or stop agents, and a lead has at most
32 tasks open at once. A refusal says why and what to do instead. The lead-side `fleetd` commands stay for you.
[Agent tools](reference/agent-tools.md) lists every tool with its parameters, the blocked Claude Code tools and the
settings fleetd forces, generated from the code.

## Safety rules: code or prompt {#safety}

Most rules don't depend on the prompt. fleetd enforces them in code whatever the text says: secrets are sealed to a
machine, gated commands wait for your tap, only the train merges, and done is decided by the hub running the checks.
Editing those words away only means agents hit refusals they weren't warned about.

Some rules live only in the prompt, marked "prompt only" in the table below: the lead never writes code, reviewers
don't read the PR description, a lead doesn't re-ask a decided question and asks you only about product, money,
credentials or something irreversible. Remove one and nothing else stops it.

## Edit a prompt

In the app: Settings → Prompts. Pick Hub-wide or a project in "Texts for", open a prompt, edit it and Save; "Compare
with default" shows your changes, "Reset to default" drops them. Click a placeholder to insert it. Warnings show as you
type and never stop a save.

On the hub machine:

```sh
fleetd prompts show lead.start
fleetd prompts edit lead.start
fleetd prompts edit task.brief.write --project builder-1/app
fleetd prompts diff lead.start
fleetd prompts reset lead.start
```

`edit` opens `$VISUAL` or `$EDITOR`, prints the warnings and asks `Save? [Y/n]`. `diff` shows fleetd's text against
yours; `show --default` prints fleetd's. A project's version beats the global one, which beats fleetd's; one-shots and
playbooks have only the global level. Your versions are files under `~/.fleetd/hub/prompts/`
([Config & files](config-and-files.md)); change them with `fleetd prompts edit`, not by hand. From an MCP client:
`prompts_list`, `prompt_get`, `prompt_set` (with `dryRun` to see the warnings only) and `prompt_reset`.

Prompts fill in `{{name}}` placeholders, such as `{{project}}`. Nothing else is template syntax.

### Warnings {#warnings}

Saving never refuses text that isn't empty, but it warns:

| Warning | Means |
|---|---|
| a required placeholder is missing | that value no longer reaches the agent (for `task.brief.write` without `{{serves}}`, the PR's `Source:` line) |
| unknown placeholder | `{{name}}` isn't one this prompt fills; it is sent as written |
| a safety rule is missing | its wording is gone; the warning says whether fleetd still enforces it in code or nothing does |
| too long | over three times the length of fleetd's text |

## Your own instructions {#instructions}

In the app: Settings → Instructions, for every project or one project. On the hub machine:

```sh
fleetd instructions edit
fleetd instructions edit --project builder-1/app
fleetd instructions show
```

They are added to every lead's first message and every task brief (writers, reviewers and judges), global first, under
"Custom instructions from the human". Not to the router, the retro or wakes.

## When fleetd changes a default you edited

Your version stays in use. In Settings → Prompts the prompt gets a warning dot and "fleetd's default changed since you
edited this. Your text stays in effect until you save it again." "Review the update" shows what fleetd changed and
what you changed, above both merged: Save merged, Keep mine, or Use the new default. On the hub machine,
`fleetd prompts list` marks it `update`, `fleetd prompts diff <id>` shows both changes and `edit` opens the merge. A
safety rule the new default added and your text lacks shows as a warning.

Playbooks are the exception: an edited playbook gets no notice when fleetd's version changes. After an update,
compare it with `fleetd prompts diff playbook.<name>`.

## What a running agent keeps {#pinning}

Each session keeps the exact prompt versions it started with, wakes included. An edit reaches new sessions at once: a
task at its next attempt, a lead at its next start. To give a running lead your edit now, restart it with
`lead_restart` from an MCP client ([Its lead](projects-and-orders.md#its-lead)).

## See exactly what an agent was told {#told}

In an order, "Show full prompt" on an agent's lane or in the lead's header opens the exact first message that session
was sent, which version of each prompt it used (fleetd's, your hub-wide edit, the project's, your instructions) and
the tools it never gets. On the hub machine, the message alone:

```sh
fleetd prompts show --session <machine>/<thread>
```

`session_prompt_get` returns the same to an MCP client. Later messages are in the lead's conversation.

## Not editable: tool descriptions and CLI replies

MCP tool descriptions (fleetd's agent tools included) and what the hub answers back (each `next:` and `fix:`) are the
other half of a protocol with code: a description must match its tool, a `next:` must name a real tool or command. See the
[CLI reference](cli.md) and the [order tools](projects-and-orders.md#tools).

## Every prompt {#prompts}

Generated from the registry in the binary this site was built with. `fleetd prompts show <id>` prints one.

{{prompt-table}}
