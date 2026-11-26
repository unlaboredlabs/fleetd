---
title: What agents are told
description: See what fleetd tells its agents, add your own instructions, and edit the built-in prompts.
---

Every text fleetd sends to an agent is a prompt you can read and change. Most of the time, your own instructions are
all you need.

## Add your own instructions {#instructions}

1. Open the bot's settings, then **Instructions & memory**.
2. Write your instructions, such as "Use pnpm, never npm" or "Every UI change needs a screenshot".

For every bot at once, an owner or admin uses **Settings › Workspace › Bot defaults › Instructions**.

Instructions go to the lead and to every agent the bot starts: workspace-wide ones first, then the bot's. Keep them short,
around 500 characters. Every agent reads them.

From the workspace machine:

```sh
fleetd instructions edit                        # every bot
fleetd instructions edit --project devbox/shop  # one bot
fleetd instructions show
```

## See what an agent was told {#told}

Open an agent from the Agents panel beside a bot's chat, then press **What it was told**. It shows the agent's exact
first message and which prompts it got.

## Edit a built-in prompt {#edit}

1. Open the bot's **Instructions & memory**, then **Built-in prompts** at the foot of the page.
2. Open a prompt, edit it and press **Save**.
3. To undo your edit, press **Reset to the built-in**.

Edits for every bot live under **Settings › Workspace › Bot defaults › Instructions**, for owners and admins. A bot's own
edit wins over the workspace-wide one.

From the workspace machine:

```sh
fleetd prompts list
fleetd prompts show lead.start
fleetd prompts edit lead.start
fleetd prompts diff lead.start      # fleetd's text against yours
fleetd prompts reset lead.start
```

Prompts fill in placeholders written as `{{name}}`, such as `{{project}}`.

### Warnings {#warnings}

Saving never refuses your text, but it warns you when:

- a placeholder it needs is gone;
- a placeholder isn't one this prompt knows;
- you removed a safety rule's wording, and whether fleetd's code still enforces that rule;
- the prompt grew past three times fleetd's length. Every agent that gets it pays for the extra.

Some rules live only in the prompt: for example, "the lead never writes code". Remove their wording, and nothing else
stops it.

### When fleetd updates a prompt you edited {#updates}

Your version stays in use. The prompt shows **built-in changed**. Open it to see both changes, then pick **Save both
changes**, **Keep mine** or **Use the new built-in**.

When fleetd retires a prompt you edited, it shows **no longer sent**. Opening it names the prompt to copy your text
into.

## When edits take effect {#pinning}

An agent keeps the prompts it started with. Your edit reaches:

- new agents at once;
- a lead at its next fresh start. A lead starts fresh by itself after an hour idle, or when its MCP servers change.

A fresh lead keeps its chat, memory and open work. It reads the recent chat before answering.

## How agents work {#rules}

fleetd's built-in prompts tell agents to work like this. Your instructions can change most of it.

**The lead, in chat:**

- leads with what's done, running or blocked, in short plain words;
- asks only about product, money or irreversible calls, as numbered questions, each with its recommendation;
- understands short replies such as "1 go, 2 rec", or "go" for yes to everything;
- never gives time estimates. Work is sized small, medium or large instead;
- never writes code itself, and leaves merging to the [merge train](/docs/merge-train).

**Writers:**

- keep each PR to one change a person can review in one sitting;
- prove each PR in its description: screenshots for UI, numbers for speed, tests for fixes;
- end the description with an `Unsure:` line, which the reviewer checks;
- run the repo's pre-push check before pushing, through `fleetd-heavy` so it takes its turn for the machine's
  [heavy-run slots](/docs/machines#fair-share). A repo can enforce the check with
  [`.fleetd/pre-push.json`](/docs/config-and-files#pre-push).

**Everyone:**

- waits for CI or long jobs without polling, and is woken when they finish;
- is told when the machine can't reach GitHub, and carries on once it can.

### Your time zone {#your-time}

Each message reaches the lead with when you wrote it, on your clock. "Tonight" or "at 6" means your evening and your
6 o'clock. Your zone comes from your app or phone.

## What fleetd turns off {#turned-off}

fleetd changes a few Claude Code defaults in every session it starts. Your own `~/.claude` setup is left alone.

### Claude's own subagents {#no-subagents}

Every agent in fleetd is a fleetd agent, which you can see, steer and stop. So Claude Code's own subagent and
background-task tools are off, and an agent can't start another `claude` from its shell.

### Claude's auto memory {#auto-memory}

Claude Code's per-folder notes are off. What agents know comes from your instructions and fleetd's
[memory](/docs/memory), which you can read and edit.

### Heavy language servers {#language-servers}

Some language servers hold gigabytes of memory per agent: rust-analyzer, clangd, and the Java and Kotlin servers.
fleetd turns these Claude Code plugins off. Agents still build, test and read code.

To turn them back on:

- for one bot, add the bot variable `HEAVY_LANGUAGE_SERVERS` with the value `1`;
- for a whole machine, put `HEAVY_LANGUAGE_SERVERS=1` in its [`claude.env`](/docs/config-and-files).

Plan on about 5 GB more per agent, and lower the machine's max agents to match.

## Every prompt {#prompts}

Generated from fleetd's code. `fleetd prompts show <id>` prints one.

<!-- prompt-table -->

### Lead

| Id | Sent |
|---|---|
| `lead.start` | lead start and every fresh lead start, followed by the state block |
| `assistant.start` | a lead's start and every fresh start in a bot with no repo, instead of the lead prompt, followed by the state block |
| `lead.voice` | after the lead prompt, at every lead start |
| `assistant.voice` | after the lead with no repo prompt, at every start of a lead in a bot with no repo, instead of the lead's voice |
| `lead.profiles` | after the lead prompt, while the bot allows more than the default profile (its Allowed profiles) |
| `lead.memory` | once a night, to a refresh session of its own, followed by the memory, the decisions and the chat since the last refresh |
| `lead.wake` | each time fleetd brings the lead up to date: the bot's state, then one line per event since the last time |
| `chat.human` | with each chat message the human sends the lead |
| `chat.agent` | with each chat message an agent or integration with its own key sends the lead |

### Tasks

| Id | Sent |
|---|---|
| `task.brief.write` | every write task attempt |
| `task.brief.read` | every read task attempt |
| `task.brief.review` | every attempt of a review task the lead spawns (the train's reviews use Reviewer) |
| `task.handoff` | after the task's brief, when fleetd restarts an agent in a new thread (its context filled up again, or its thread could not resume) |

### Reviews and checks

| Id | Sent |
|---|---|
| `review.reviewer` | once per PR patch, fresh, blocking findings only |
| `review.delta` | after Reviewer, when an earlier round reviewed another head of the PR |
| `review.unsure` | after Reviewer, when the PR's description has an \`Unsure:\` line that names a doubt |
| `review.conflicts` | instead of Reviewer when a rebase of an approved PR changed its own lines only where the base changed them too |

### Messages

| Id | Sent |
|---|---|
| `steer.message` | per steer (steer\_send, task message), straight to the agent, at its next tool boundary or now |
| `agent.message` | per agent\_message, from another agent of the bot, at the agent's next tool boundary or with its next run |
| `review.unreported` | to a train reviewer whose turn ended without a verdict, once, before a new reviewer starts |
| `pr.fix` | to a PR's author when the train can't rebase it, its CI is red, or a review finds blocking findings |
| `task.pause` | to each running agent above a lowered max agents, when a person pauses the extras |
| `task.resume` | to a paused agent once a slot frees for it |
| `task.recover` | to an agent whose run was cut off (its node stopped, its process was killed, a stall), when fleetd resumes it |
| `usage.continue` | to a lead or agent a usage limit parked, once the limit resets |

<!-- /prompt-table -->
