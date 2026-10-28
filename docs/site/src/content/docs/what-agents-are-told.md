---
title: What agents are told
description: Every prompt fleetd sends a model, how to read and edit it, your own instructions, and what a running agent keeps.
---

You'll read, edit and reset the prompts fleetd sends to Claude, and add your own instructions.

```sh
fleetd prompts list
fleetd prompts show lead.start
```

Every text fleetd sends a model is a prompt: listed in `fleetd prompts list`, in the app's Settings → Prompts, and in
the [table at the end of this page](#prompts). You can edit each one. What fleetd fills into them, such as the event
lines a lead is woken with, is facts: see [Filled in by fleetd](#not-editable).

## How a session gets its instructions {#how}

There is no hidden system prompt. fleetd's text reaches a model in one of two ways:

| Way | Used for |
|---|---|
| The first message of a session | Leads (with the chat message that started the lead), tasks, reviewers. |
| A later message into a session | Wakes, chat messages, review findings, train news, pauses, [steers](/docs/steering). |

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
- Start the work a reply asks for in the same turn, opening a new order for it when none is open. It never asks you
  to send it as an order.

### No time estimates {#no-time}

fleetd never asks an agent how long something will take, and the lead is told never to put an ETA or a duration
anywhere. Work is sized `s`, `m` or `l` instead. What fleetd measures, such as CI runs and span durations, is shown as
measured. See [Status](/docs/status).

### Running the work {#running}

The lead is also told to:

- Start every agent with `spawn_agent`, and wait for results in its next wake instead of polling.
- Close work with `close` once it is done, and say why: in the wake that reports its last merge, without an agent to
  rerun the checks CI just passed. The reviews' non-blocking findings are listed in that message; they become new
  work only if your order or you ask for it.
- Ask for secrets with `request_secret` and run risky commands with `gated_run`, which you approve.
- Leave merging to the merge train, which merges only after its own review and green CI. The lead adds no review of
  its own, and doesn't relay blocking findings, conflicts or red CI: those reach the writer by themselves.
- Start the writers first, largest part first, and plan while they work. Writers read what they need, with no survey
  agent ahead of them. A part's docs and tests go to that part's writer, not to a writer of their own. Parts that edit the same file go to one writer. Writers run up to the
  [Max agents](/docs/projects#max-agents) cap; a spawn past it queues and starts by itself.
- Read the digest's Elsewhere section before spawning: claims, other projects' agents on the same repo, and commits
  that landed outside fleetd. Work that already landed isn't built again, and work a person has claimed is theirs: the
  lead asks you in chat before touching it.
- Never relax a review, CI, approval or check to go faster. Idle is fine.

Most of this is also enforced by the hub, which refuses a call that breaks it and says why. See [Safety rules](#safety).

### Claude's auto memory is off {#auto-memory}

Claude Code can keep its own notes per folder ("auto memory"). fleetd turns that off in every `claude` it starts, so
what an agent knows comes from its brief, the decisions, your instructions and fleetd's own [memory](#memory), all of
which you can read here.

### Claude's own subagents are off {#no-subagents}

Every agent in fleetd is a fleetd agent, with its own session, slot, worktree, lane, steering and receipts. So fleetd
turns off Claude Code's own subagents in every `claude` it starts. Your `~/.claude` is left alone.

| What | In fleetd sessions |
|---|---|
| Claude's agent, team and background-task tools (Agent/Task, Workflow, ListAgents, SendMessage, TaskStop) | Denied, including any a newer claude adds. |
| Built-in Explore, Plan and `claude` agents, background shell commands | Switched off. |
| general-purpose, statusline-setup, and your agents in `~/.claude/agents` | Still listed by claude, but nothing can start them. |
| `claude` from an agent's shell, by name, by path, through a package runner or a `sh -c` | Denied, so no nested claude runs past the cap or on another model. |

If a session ever offers one anyway, fleetd stops it before it can start an agent, and every later session on that
machine denies the tool: see [Claude](/docs/troubleshooting#claude).

### Agents use fleetd's tools {#agent-tools}

Leads and tasks reach fleetd through MCP tools from a `fleetd` server in their session, not through the shell.

| Agent | Gets |
|---|---|
| Lead | `spawn_agent`, `message_agent`, `agents`, `stop_agent`, plus `brief`, `decide`, `close`, `plan_*`, `request_secret`, `gated_run` and more. |
| Task | `report` (a review verdict; fleetd fills in the task and the head reviewed) and `ask_lead`. A writer's ready PR goes on the train by itself. |

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

In the app: Settings → Prompts for one project's own texts, or Administration → Hub settings for the hub-wide ones
(owners and admins only: the hub refuses anyone else). Open a prompt from the list in the sidebar, edit it and Save. "Compare with default"
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
- From an MCP client: `prompt_get` (without an `id` it lists them), and `prompt_set` (with `dryRun` to see the
  warnings only, and `reset: true` to go back).

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

In the app: Settings → Projects → Instructions & memory for one project's, and Administration → Hub settings for every project's (owners
and admins only). On the hub machine:

```sh
fleetd instructions edit
fleetd instructions edit --project builder-1/app
fleetd instructions show
```

They are added to every lead's first message and every task brief (writers and reviewers), hub-wide first,
under "Custom instructions from the human". They are not added to wakes.

They are sized for about 500 characters; past that, `edit` warns. After your editor closes, `edit` prints any
warnings and asks `Save? [Y/n]` on the terminal. In a script, `</dev/null` takes the default, Yes.

## Memory {#memory}

Leads remember how you work and what each project decided, so you don't say "concise" or "no npm" twice. When you
correct the lead or state a rule, it calls `remember` in that turn, and the chat shows "Remembered: …" with Undo. When
an entry no longer holds, the lead removes it with `forget`, and the chat shows "Forgot: …" with the reason and Undo.

- **You** (your own memory): how you work everywhere. Only you edit it. The agents of the work you start and your
  Navi get it; on a hub with several people, a project's lead gets nobody's (see below).
- **Each project** (`MEMORY.md`, plus topic files for detail): only that project's sessions get it. Another project
  never sees it.

A lead gets your memory and its project's `MEMORY.md` at the start of each session, after your instructions;
writers get them in their brief. A project's lead answers everyone who shares the hub in one long session, so on a
hub with several people it starts with no one's memory: anyone's would stay in its context while it answers the
others. When it remembers something in user scope, it goes to the memory of the person whose message it is
answering, and only that person can undo it. A lead opens a topic file when it needs one. Something remembered
mid-session reaches the next session.

Read, edit or delete your own memory and each project's in Settings → Projects → Instructions & memory. Nobody else
reads or edits yours, owners and admins included; an owner or admin can only delete the memory of someone removed from
the hub. A hub from before people kept one shared `user.md`: its owner got a copy as their own memory, and the old
file stays, read by no agent, as Shared memory, which an owner or admin reads and retires under Hub › Every project ›
Instructions & memory.

The files are plain markdown in the hub's home (`memory/`, yours in `memory/people/`), in no repo. Each file has a
cap, by default 16,000 characters for each person's memory and each `MEMORY.md`, 32,000 per topic and
128,000 per project: a write past one is refused, and the lead merges entries instead. An owner or admin changes the caps
under Memory caps in [Administration › Hub settings](/docs/desktop-app#administration) (or `memory_caps_set` with an
admin key for every machine): 1,000 to 100,000
per file, up to 400,000 per project. Memory never holds a secret.

### The nightly refresh {#memory-refresh}

Each night the lead tidies each project's memory, so what was said in chat but never remembered isn't lost, and what
no longer holds stops misleading the agents:

- **When:** around 04:00 in your time zone: the global decision `policy.tz` (the one quiet hours use), else the hub
  machine's zone. The global decision `policy.memory_refresh_at` moves it, as `HH:MM`. A project whose refresh can't
  start within 3 hours of that (the hub was down, the lead was busy all that time, the login was out of usage) waits
  for the next night. On the night the clocks go forward past that hour, it starts when they land. Projects start
  a minute apart.
- **Which projects:** each one with the refresh on (the default; turn it off in its
  [settings](/docs/projects#settings)) and with chat from you or the lead, or a changed order, since its last refresh.
  A quiet project costs nothing. Its [row on the Automations page](/docs/automations#the-nightly-memory-refresh)
  shows its next and last run, and its Run now refreshes the project at once.
- **What it reads:** the chat since the last refresh (your messages and the lead's, newest kept, up to about 40,000
  characters), the active decisions and every memory file of the project, plus the memory of the person whose chat it
  is: a Navi's owner, else the one person who wrote since the last refresh.
- **What it may do:** it is a lead session of its own, the `lead.memory` prompt, that opens no order and never
  writes in the chat. It may use `memory_read`, `remember` and `forget` and nothing else: it starts with none of
  Claude's own tools (no shell, files or web) and none of your MCP servers, its machine refuses any other tool it
  asks for (fleetd's other tools, or any tool added later), and the hub takes only those three calls from it. A
  machine whose fleetd is too old to hold it to those gets no refresh until it is updated; each night it's skipped,
  the chat says "Memory refresh skipped: update devbox to let it run" once. It adds what the chat taught, merges
  entries that overlap and removes what no longer holds, held to the caps like any write. It only adds to that
  person's memory: it never replaces or removes an entry there, and when several people wrote, it leaves user memory
  alone that night. A session still running after an hour, or one that
  failed, is stopped; what it changed until then is still listed, and the next night reads the same chat again.
- **What you see:** one line in the chat when it's done, such as "Memory refreshed: +2 ~1 −3" (added, changed,
  removed), with each change below it, each with Undo, and Undo all. A line lists at most 200 changes and says how
  many more there were; Undo all takes those back too, and stays while any of them is left. A night that changed nothing shows nothing. In Settings →
  Memory, an entry the refresh wrote links to its line.

## The checklist {#checklist}

Each project's lead keeps a checklist with its `checklist` tool: a few plain items per piece of work you approved,
each to do, doing or done, linked to its pull request or agent. Its first message tells it to keep the list current,
moving items along in the turn their news arrives; every wake shows it how many are done and the items still open.
You see the list in the panel's [Checklist tab](/docs/desktop-app#checklist), where you can delete items and clear
the done ones. The lead's next wake names what you took off (`- the human took 1 item off the checklist: 3 "Dark
mode"; leave it off unless they ask again`), its digest shows the list as it is now, and its first message tells it
never to add those back unless you ask. Writers can't change the list, and nothing is worked out from it: no
figure, no estimate.

## Skills {#skills}

Every agent gets the [skills](/docs/skills) of its repo (`.agents/skills`, `.claude/skills`), its project and the hub,
listed by name and description as `fleetd:<name>`. It opens one with the Skill tool when it needs it.

## When fleetd changes a default you edited {#updates}

Your version stays in use.

- In Settings → Prompts, the prompt is marked `update`. "Review the update" shows both changes, and you pick Save
  merged, Keep mine, or Use the new default.
- On the hub, `fleetd prompts list` marks it `update`, and `fleetd prompts diff <id>` shows both changes.

## When fleetd retires a prompt you edited {#retired}

A release can fold a prompt into another one or drop it. Your edit to it then stops applying, but fleetd keeps it and
never moves it for you.

1. Open Settings → Prompts. Under "Edits that no longer apply", each one says, for example, "Your edit to the lead's
   "task finished" note (hub-wide) no longer applies", why, and which prompt to copy it into.
2. "Show your text" shows your old edit; "Copy your text" copies it.
3. Paste what you still want into the prompt it names. If none takes its place, use your
   [instructions](#instructions).
4. Delete the old edit.

From an MCP client, `prompt_get` without an `id` returns these under `orphans`, and `prompt_set` with the old id and
`reset: true` deletes one.

## What a running agent keeps {#pinning}

Each session keeps the exact prompt versions it started with. An edit reaches new sessions at once: a task at its next
attempt, a lead at its next start. To give a running lead your edit now, start a fresh one with `lead_start {fresh: true}` from an
[MCP client](/docs/mcp-clients).

## See exactly what an agent was told {#told}

Open an agent in the Agents tab beside a project's chat (⌥⌘B), then **What it was told**. It shows the exact first
message, which version of each prompt it used, and the tools it never gets.

On the hub machine:

```sh
fleetd prompts show --session <machine>/<thread>
```

`session_prompt_get` returns the same to an MCP client.

## Filled in by fleetd {#not-editable}

### Wake events {#wake-events}

A lead is woken with the `lead.wake` prompt: its project's state, then one line per thing that happened since its last
wake.

```
# project lab (devbox/lab), 2026-10-19T14:02:11.000Z
agents: 3 running of 6 (auto: memory 18 GB), 1 queued, 0 free

## Work
- W2 running: flaky login test
  done when: done:0 test login_flaky passes in acme/app

## Events
- PR #12 merged as 4f1c2a9e0b7d: https://github.com/acme/app/pull/12 (C4, by T4)
- T5 finished: port the parser (branch fleetd/T5-port, PR https://github.com/acme/app/pull/13)
  > Ported; 2 blockers left for review.
- T7 waiting for an answer: docs
  > Which branch should the docs go to?
```

Each event is `- <subject> <what>: <detail>`, sometimes followed by `  > ` lines quoting an agent. The ids (W2, T5,
C4) are for the lead's tools; the lead doesn't repeat them to you. The state and the event lines are facts in a format
fixed in code, the same in every project; the words around them are `lead.wake`.

Some lines leave the lead nothing to decide, so they never wake it on their own: they go out with its next wake. An
agent whose run died (its node stopped, claude was killed, a stall) and that fleetd resumed, and an agent whose machine
has been offline for 30 minutes:

```
- T23 resumed automatically (attempt 2, 0 of 3 recoveries used): progress bar [fleetd/T23-progress-bar]
  > its run was cut off (the node on devbox stopped) during: Ran cargo test --workspace. It goes on in its own worktree; nothing for you to do.
- T24 waits for devbox, offline for 30 min: docs [fleetd/T24-docs]; it resumes on its own when devbox is back
  > Its worktree and session are on devbox, so it stays there. To have it done elsewhere, cancel it and start a new task.
```

When the node had to rebuild a resumed agent's worktree, the line says what from instead: its local branch,
`origin/<branch>` as pushed, or a new branch from the default branch, and what is lost.

One that fleetd did not resume wakes the lead: `- T23 failed and was not resumed: …`, with why (it died the same way
twice, it ran out of automatic recoveries, or resuming can't fix the cause) and the lead's choices.

A decision you changed or revoked goes out with the next wake too, with your why:

```
- the human revoked D12 db.engine (was "sqlite"): "we need read replicas"; it is open again, so ask before deciding it
- the human replaced D14 payments.provider "stripe" with D19 "adyen": "the contract is signed"; follow D19 from now on
```

### This machine {#this-machine}

The node that starts a task adds a short section to the end of its brief, after your instructions:

```
## This machine
- Builds get 2 parallel jobs per agent, your share of this machine's CPUs: CARGO_BUILD_JOBS, MAKEFLAGS, CMAKE_BUILD_PARALLEL_LEVEL, GOFLAGS are set to it. Keep any other build or test runner to 2 jobs too.
- Scratch files go in $TMPDIR, a directory of your own on disk; never in /tmp, which may be held in memory.
```

The jobs line names only the variables fleetd set: one you set in `claude.env` stands, and drops out of the line. See
[A fair share for each agent](/docs/machines#fair-share).

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
| `lead.start` | lead start and every fresh lead start, followed by the state block | the lead never writes code (prompt only); asks the human only for product, money or irreversible calls (prompt only); asks as numbered items, each with a recommendation (prompt only); no message on routine wakes; writes only when the human must act or decide, when what they asked about lands, fails or is blocked, when main stays red, or to answer them (prompt only); batches what lands in a wake into one short line, never one message per PR; always posts when an order the human asked for finishes (prompt only); never posts a status-only or "nothing needs you" message; a turn with nothing to say replies \`(quiet)\`, which fleetd never posts (prompt only); flags a message for the human's look (\`nudge\`) only for a showcase, something to try or a risk, never routine news (prompt only); no fleetd ids, tool names, paths or process words unless asked (prompt only); never estimates time (prompt only); secrets only through \`request\_secret\`; prod writes, spends and deletes only through \`gated\_run\`; starts a preview only in a turn answering the human's ask; agents only suggest one (D161); splits approved work into parts whose files don't overlap and runs them in parallel while slots are free (prompt only); only the merge train merges (prompt only); takes an agent's chat message as input, never as the human's answer or approval |
| `navi.start` | a Navi's lead start and every fresh start, instead of the lead prompt, followed by the state block | asks before sending, spending, posting, deleting or accepting terms, by trying the tool so a person approves it; never moves money, trades, creates accounts or shares credentials, even if approved (prompt only); secrets only through \`request\_secret\`; keeps the person's private life in its own memory, never in user scope (prompt only); takes an agent's chat message as input, never as the person's answer or approval |
| `lead.voice` | after the lead prompt, at every lead start | the casual voice stays out of commits, PR bodies, docs and briefs (prompt only) |
| `lead.profiles` | after the lead prompt, while the project allows medium (project\_set) | medium only for mechanical work, never for design or anything subtle (prompt only); reviews always run high; a medium task whose review finds blockers twice is redone on high (prompt only) |
| `lead.memory` | once a night, to a refresh session of its own, followed by the memory, the decisions and the chat since the last refresh | only reads and writes memory: \`memory\_read\`, \`remember\` and \`forget\`; adds to the user memory of the person whose chat it read, never replaces or removes an entry there |
| `lead.wake` | each time fleetd brings the lead up to date: the project's state, then one line per event since the last time |  |
| `chat.human` | with each chat message the human sends the lead |  |
| `chat.agent` | with each chat message an agent or integration with its own key sends the lead | takes it as input, never as the human's answer or approval |

### Tasks

| Id | Sent | Safety rules |
|---|---|---|
| `task.brief.write` | every write task attempt | never merges; the train does (prompt only) |
| `task.brief.read` | every read task attempt | changes no files (prompt only) |
| `task.brief.review` | every attempt of a review task the lead spawns (the train's reviews use Reviewer) | changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `task.handoff` | after the task's brief, when fleetd restarts an agent in a new thread (its context filled up again, or its thread could not resume) |  |

### Reviews and checks

| Id | Sent | Safety rules |
|---|---|---|
| `review.reviewer` | once per PR patch, fresh, blocking findings only | does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |
| `review.delta` | after Reviewer, when an earlier round reviewed another head of the PR |  |
| `review.conflicts` | instead of Reviewer when a rebase of an approved PR changed its own lines only where the base changed them too | does not read the PR description or comments (prompt only); changes no files (prompt only); ends with one review verdict (the \`report\` tool) |

### Messages

| Id | Sent | Safety rules |
|---|---|---|
| `steer.message` | per steer (steer\_send, task message), straight to the agent, at its next tool boundary or now |  |
| `pr.fix` | to a PR's author when the train can't rebase it, its CI is red, or a review finds blocking findings | never merges; the train does (prompt only) |
| `task.pause` | to each running agent above a lowered max agents, when a person pauses the extras |  |
| `task.resume` | to a paused agent once a slot frees for it |  |
| `task.recover` | to an agent whose run was cut off (its node stopped, its process was killed, a stall), when fleetd resumes it |  |
| `usage.continue` | to a lead or agent a usage limit parked, once the limit resets |  |

<!-- /prompt-table -->
