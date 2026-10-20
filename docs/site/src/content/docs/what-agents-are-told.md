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

There is no hidden system prompt. fleetd's text reaches a model in one of three ways:

| Way | Used for |
|---|---|
| The first message of a session | Leads, tasks, reviewers, judges. |
| A later message into a session | Wakes, review findings, train news, nudges, [steers](/docs/steering). |
| The input of a one-shot `claude -p` with no tools | The retro. |

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
- Read short replies by item number: "1 go, 2 rec", "do it", "rec" (take the recommendations), "nvm" (drop it).
- Log every answer as a decision and check the decisions before asking, so it never asks the same question twice.
- Ask a human done-when check as one line, such as "looks good on your end?".
- Turn a reply that asks for work into work in the same turn. Work never closes while your latest reply asks for
  something not yet started; if the lead won't build it, it says why.

fleetd backs the last rule up: a done claim counts only for the brief it checked, so changing the brief to the build
voids a claim made before.

### No time estimates {#no-time}

fleetd never asks an agent how long something will take. Leads are told never to put an ETA or a duration in the chat,
a brief, a status line, a plan or a summary. Plan items are sized `s`, `m` or `l` instead.

What fleetd measures, such as CI runs and span durations, is shown as measured. See [Status](/docs/status).

### Max efficiency without compromising {#efficiency}

In place of a clock, leads are told to work for throughput:

- Keep every slot busy.
- Run work that touches separate areas in parallel.
- Have each slice reviewed as it lands, and put each finished PR on the train at once.
- End a turn only to wait on their agents, or when nothing approved can run.

### The agent cap {#cap}

Each project has a cap on how many agents run at once. Every wake tells the lead the live count, such as "agents: 7
running of 12, 2 queued". The lead is told to:

- Plan to the cap: at most that many slices at once, the rest queued by value, each started as a slot frees.
- Treat a queued spawn as normal. The hub starts it when a slot frees; the lead doesn't spawn it again.
- Never work around the cap: no doing an agent's work itself, no running agents one by one to dodge it, and no asking
  you to raise it unless you asked about speed.
- At a cap of 1, work one agent at a time and say so once in the chat.

Lowering the cap stops nothing that is running; raising it starts queued agents at once.

### Gates never relax {#gates}

Leads are also told that no gate relaxes for speed: reviews, CI, the train, done-when checks and your approvals stay
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
- One-shots have only the hub-wide level.
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
under "Custom instructions from the human". They are not added to the retro or wakes.

They are sized for about 500 characters; past that, `edit` warns. After your editor closes, `edit` prints any
warnings and asks `Save? [Y/n]` on the terminal. In a script, `</dev/null` takes the default, Yes.

## When fleetd changes a default you edited {#updates}

Your version stays in use.

- In Settings → Prompts, the prompt gets a warning dot. "Review the update" shows both changes, and you pick Save
  merged, Keep mine, or Use the new default.
- On the hub, `fleetd prompts list` marks it `update`, and `fleetd prompts diff <id>` shows both changes.

## When fleetd retires a prompt you edited {#retired}

A release can fold a prompt into another one or replace it with fixed text. Your edit to it then stops applying, but
fleetd keeps it. Settings → Prompts lists it with the prompt that covers it now: copy what you still want into that
one, then delete the old edit. From an MCP client, `prompts_list` returns these under `orphans`, and `prompt_reset`
with the old id deletes one.

An edited playbook file is listed the same way. Its review and check rules still apply, but its instructions no longer
reach the lead: the lead prompt has a section for each kind of work.

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
| `lead.start` | lead start and every lead\_restart, followed by the state block | the lead never writes code (prompt only); delegates only with \`spawn\_agent\`, no other agents; asks the human only for product, money or irreversible calls, in the chat, each with a recommendation (prompt only); secrets only through \`request\_secret\`; prod writes, spends and deletes only through \`gated\_run\`; never waits idle on an answer (prompt only); done only through \`claim\_done\`; every write says what it serves; only the merge train merges; never asks the same question twice; logs every answer with \`decide\` (prompt only); a reply that asks for work starts it before anything closes (prompt only); plans to the agent cap and never works around it (prompt only); never estimates time (prompt only); a frozen brief changes only with \`amend\` and the human's logged yes; never relaxes a review, CI, train, done-when or approval gate for speed |

### Tasks

| Id | Sent | Safety rules |
|---|---|---|
| `task.brief.write` | every write task attempt | changes only its areas; never merges; the train does; the PR body carries \`Source:\`; does the task itself, no subagents |

### Reviews and checks

| Id | Sent | Safety rules |
|---|---|---|
| `review.reviewer` | per PR head per review round, by the tier's rules; Claude or Codex | does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `review.verifier` | tier L, per PR head | works in a detached temporary worktree (prompt only); does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `judge` | per \`judge\` done-when check of each claim | trusts no claim in the artifacts (prompt only); ends with one review verdict (the \`report\` tool) |
| `judge.research` | per \`judge\` check of a research claim | trusts no claim in the artifacts (prompt only); ends with one review verdict (the \`report\` tool) |

### Messages

| Id | Sent | Safety rules |
|---|---|---|
| `steer.message` | per steer (steer\_send, task message), straight to the agent, at its next tool boundary or now | asks the agent to name the steer first, so its receipt can say it was acknowledged (prompt only) |

### One-shots

| Id | Sent | Safety rules |
|---|---|---|
| `retro` | each retro run (at most 2 a day) | uses no tools; at most 3 changes |

<!-- /prompt-table -->
