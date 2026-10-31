---
title: Agent tools
description: The tools fleetd gives each agent, the Claude Code tools it blocks, the settings it forces and the limits the hub enforces.
sidebar: { order: 20 }
---

Generated from fleetd's source by `cargo run -p docsgen`, so it matches the code. Don't edit this file by hand: CI fails when it differs from the generator's output.

Every agent fleetd starts is a Claude Code session. fleetd adds its own MCP server, named `fleetd`, with the tools for the agent's role. Claude Code shows them as `mcp__fleetd__<tool>`. Each call goes to the hub, which checks it whatever the prompt says.

## Roles

The app shows each agent's role on its lane. The role decides the fleetd tools; every session gets the same [Claude Code tools](#claude-code-tools).

| Role | How it starts | fleetd tools | Can start agents |
|---|---|---|---|
| Lead | One per project, started by the project's first order | [Lead tools](#lead-tools) | Yes |
| Implementer | `spawn_agent` with kind `write`. Gets its own worktree and branch | [Task tools](#task-tools) | No |
| Reader | `spawn_agent` with kind `read` | [Task tools](#task-tools) | No |
| Reviewer | `spawn_agent` with kind `review` | [Task tools](#task-tools) | No |
| QA | `spawn_agent` with kind `review` and `qa: true` | [Task tools](#task-tools) | No |

## Hub limits

The hub checks these on every fleetd call a session makes, through its MCP tools or a `fleetd` command in its shell. A refusal says why and what to do instead.

| Limit | Value |
|---|---|
| Who can start agents | A lead, with `spawn_agent`. A task's agent can't. |
| Depth | 1. A lead is depth 0 and its tasks depth 1; nothing goes deeper. |
| Open tasks per lead | 32, or twice the project's max agents when that is more (queued, running or idle). |
| Agents running at once, per project | The project's max agents, which a person sets (`cap_set`, the chat's Max agents); unset, its machine's cap within the fleet cap. A spawn over it queues and starts by itself; a review goes ahead of queued writers. The lead is not an agent and doesn't count. |
| Agents running at once, per machine | The machine's max agents, which a person may set up to the fleet cap (`cap_set`, `fleetd machine set`, Settings › Hub › Machines). Unset: what the machine fits, one per CPU less one in eight, and 2 GB of memory each after a quarter (4 to 16 GB) is left for the system, at most 64. Either way new agents pause while memory in use runs short, and wait for 5 GB of disk each above the free-space floor. |
| Agents running at once, fleet-wide | The machines' caps added up, unless a person set a fleet cap. |
| Calls a task's agent may make | `report`, `ask_lead`, `brief_read`, `decisions_search`, `review_read`, `wait_ci`, `preview_suggest`, `preview_config_propose`, `chat_image`. Every other call is refused. |
| Gated commands (`gated_run`) | Classes `irreversible`, `money`, `credential`. Run only after a human approves; at most 14400 s. |

These limits cover calls to fleetd, not what the agent's own shell can do. A task runs with full Bash, so `gated_run` is not the only way it could run a command. A process that leaves its session's process tree (for example with `setsid`) and scrubs its environment counts as you, with no limits: see "Known limit" on the Security page. Run agents you don't trust as a different OS user.

## Lead tools

Every lead gets these.

| Tool | What it does | Needs a human |
|---|---|---|
| [`spawn_agent`](#spawn_agent) | Start a fleetd agent (a task) with its own session, slot and lane. | No |
| [`message_agent`](#message_agent) | Steer a task: a running one takes the message at its next tool boundary (now: true stops its current step first), a waiting one gets it as its answer, and an ended one continues in its own thread. | No |
| [`agents`](#agents) | The project's tasks as stored (state, queued reason, thread, result), newest first: one by taskId, or filtered by state or workstream. | No |
| [`stop_agent`](#stop_agent) | Stop a task: interrupts its thread and releases its slot. | No |
| [`brief`](#brief) | Open and start work. | No |
| [`request_secret`](#request_secret) | Ask the human for a secret (a key, a token, a password). | The human enters the value in chat; you see only its fingerprint. |
| [`request_withdraw`](#request_withdraw) | Take back a secret request or a command approval you no longer need (the human said so in chat). | No |
| [`decide`](#decide) | Log a decision: one you made yourself, or the human's answer to a question you asked in chat (so you never ask it twice). | No |
| [`close`](#close) | The workstream is done: say why in one line. | No |
| [`gated_run`](#gated_run) | A prod write, spend, delete or credential use: the chat shows the human exactly this argv with Approve / Deny, and the node runs it only once approved; secrets come from the node's own sinks. | A human approves the exact command in chat before the node runs it. |
| [`decisions_search`](#decisions_search) | Search this project's decisions (and the global ones) by words, or read one by its id (D12), whole. | No |
| [`remember`](#remember) | Keep one entry in memory, in plain words, for every later session: scope user for how the person whose message you answer works everywhere (tone, taste, standing rules; their own memory), project for this project (MEMORY.md, or a topic file for detail). | No |
| [`forget`](#forget) | Remove one entry from memory: entry quotes words of exactly one entry, as it reads now; scope and topic as for remember. | No |
| [`memory_read`](#memory_read) | Read one of this project's memory topic files (MEMORY.md lists them). | No |
| [`nudge`](#nudge) | Flag the chat message you just wrote for the human's look, with reason in a few words ("the Machines page redesign"): the app shows it as something to look at, below your questions, until they have seen it, for a day at most. | No |
| [`automation_create`](#automation_create) | Make an automation for this project: a name, the prompt each run gives you as a new order, and optionally a schedule (5-field cron and an IANA tz, such as 0 9 \* \* 1-5 in Europe/Berlin). | No |
| [`automation_list`](#automation_list) | This project's automations with their schedule, next run, paused state and last run. | No |
| [`automation_update`](#automation_update) | Change an automation's name, prompt or schedule (removeSchedule: true takes it off); fields left out stay. | No |
| [`automation_pause`](#automation_pause) | Pause (paused: true) or resume an automation. | No |
| [`automation_delete`](#automation_delete) | Delete an automation and its run history; orders its runs opened stay. | No |
| [`automation_run`](#automation_run) | Run an automation now: it opens its order, which reaches you in a later wake. | No |
| [`automation_runs`](#automation_runs) | An automation's runs, newest first, with the order each opened; with runId, that run and its whole webhook body. | No |
| [`checklist`](#checklist) | Keep the project's checklist: the to-dos the human sees beside the chat, each todo, doing or done. | No |
| [`skill_install`](#skill_install) | Install skills (SKILL.md workflows) from a skills.sh source (owner/repo, owner/repo@skill, a GitHub URL) for this project (scope project; global skills take an admin, so the human installs those); pinned to the commit fetched, and the human updates it from Settings > Skills. | No |
| [`project_message`](#project_message) | A Navi's call: write to another project's lead in its chat, as this Navi, never as the person: "please add X", or a question. | No |
| [`factory_status`](#factory_status) | A Navi's call: the other projects in one read, or the one named: each one's state (working, waiting on the person, blocked, idle), a red main, running agents, open orders, its checklist not done, its last merge and merges over 7 days, and this Navi's asks to it with the orders opened for them, plus the hubs this Navi is linked to. | No |
| [`chat_search`](#chat_search) | A Navi's call: search your own chat, all of it, back to its start, for the messages holding every one of words (any order and case), optionally from and to a day (2026-10-20) or time, in UTC. | No |
| [`chat_read`](#chat_read) | A Navi's call: read the messages around one of your own chat by its id from chat_search, oldest first: before and after say how many on each side (5 when absent, at most 10). | No |
| [`usage_resume`](#usage_resume) | Lift the usage pause on your project's machine now and send every agent parked there "continue": only once you know its login has capacity again (the human says so, or a turn of yours just went through). | No |
| [`change_enqueue`](#change_enqueue) | Put a PR no task's result put there on its repo's merge train; only the train merges. | No |
| [`review_read`](#review_read) | Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. | No |
| [`preview_suggest`](#preview_suggest) | Suggest the person try a PR themselves, where a human test clearly matters (a UI change, copy in several languages, a mobile build): one line with a Try it button in the chat and the PR, once per PR, which the app also shows as something to look at until the person has seen it. | No |
| [`preview_config_propose`](#preview_config_propose) | Propose how Try it runs this project's web app, once you know: setup commands (install), build, a start command that serves on 127.0.0.1:$PORT, the ready path and the lockfiles setup depends on. | A person approves the proposed setting in chat before it is saved. |
| [`chat_image`](#chat_image) | Put an image you made in this project's chat: use it for screenshots of UI changes, instead of a link. | No |
| [`preview_start`](#preview_start) | Start a preview of a PR (or an order's PRs merged together) for the person to try: only when the person asked for it in the message you are answering, never on your own (use preview_suggest for that). | No |
| [`session_start`](#session_start) | Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end (a Navi's browser instead keeps its own profile, so the sites it signed into stay signed in). | No |
| [`desktop`](#desktop) | Act on your Linux desktop session (session_start kind linux_desktop), with computer-use actions plus launch. | No |
| [`session_end`](#session_end) | Close your browser session: the browser and its profile are thrown away (a Navi's profile stays, with its sign-ins), and its recording goes to the hub. | No |
| [`request_takeover`](#request_takeover) | Ask a person to take your browser over, for what only they can do: a captcha, a login confirmation only they can give, a judgement call. | No |
| [`fill_credential`](#fill_credential) | Fill a login field of your browser session from 1Password without seeing the value: ref is its secret reference (op://&lt;vault>/&lt;item>/&lt;field>, ?attribute=otp for a one-time code), target the field's CSS selector. | No |

### spawn_agent

Start a fleetd agent (a task) with its own session, slot and lane. title is what the human sees: a short plain outcome ("Saved carts survive a sign-out"), never an id, status or PR number. kind write|read|review; a writer gets its own worktree and branch; a review task needs pr. repo names the project's repo it works in when it has several (its worktree, branch, setup and PR are that repo's); without it, an agent given pr works in the PR's repo, any other in the project's own. profile names one of the profiles your first message lists, the default when left out; one the project doesn't allow is refused, and reviews always run on the default. A full slot board queues it and it starts by itself. A writer is checked against the work in flight on its repo: one that repeats it is refused (taken, or a possible duplicate); if it is different work, call again with notDuplicateOf and notDuplicateWhy. A person's claim is theirs: ask in chat. The result names the other writers running in its repo and the work elsewhere it may overlap. Its result arrives in a later wake: end your turn instead of waiting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no | Every task gets its own worktree: a writer on its own branch, a reader or reviewer detached. One of `write`, `read`, `review`. Default `"write"`. |
| `notDuplicateOf` | string[] | no | A writer refused as a possible duplicate: the ids it was refused for (`T12`, `C7`), when this is different work. Needs `notDuplicateWhy`. At most 10 items. |
| `notDuplicateWhy` | string | no | Why it is different work, in one line; kept in the hub's log. At most 200 characters. |
| `paths` | string[] | no | The files a writer will change, repo-relative (`app/theme.ts`, `app/settings/**`): matched against the work in flight. At most 50 items. |
| `pr` | string | no |  |
| `profile` | string | no | Matches `^[a-z0-9][a-z0-9._-]{0,31}$`. |
| `prompt` | string | yes | At most 8000 characters. |
| `qa` | boolean | no |  |
| `repo` | string | no | The project's repo it works in, by name: its worktree, branch, setup and PR are that repo's. Absent: the repo of `pr` when the project has it, else the project's own repo, or its plain directory. |
| `title` | string | yes | One line. At most 80 characters. |
| `workstreamId` | string | yes | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "spawn_agent",
  "arguments": {
    "kind": "write",
    "prompt": "Limit uploads to 10 a minute per API key. Over the limit, answer 429 with Retry-After.",
    "title": "Rate-limit the upload API",
    "workstreamId": "W3"
  }
}
```

### message_agent

Steer a task: a running one takes the message at its next tool boundary (now: true stops its current step first), a waiting one gets it as its answer, and an ended one continues in its own thread.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message` | string | yes | At most 8000 characters. |
| `now` | boolean | no | Default `false`. |
| `taskId` | string | yes | `T<n>`, e.g. `T1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "message_agent",
  "arguments": {
    "message": "Keep the old endpoint working until the mobile client ships.",
    "taskId": "T7"
  }
}
```

### agents

The project's tasks as stored (state, queued reason, thread, result), newest first: one by taskId, or filtered by state or workstream.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `state` | string | no | One of `queued`, `running`, `idle`, `done`, `failed`, `cancelled`. |
| `taskId` | string | no | Just this task. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "agents",
  "arguments": {
    "state": "running"
  }
}
```

### stop_agent

Stop a task: interrupts its thread and releases its slot.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | no | At most 200 characters. |
| `taskId` | string | yes | `T<n>`, e.g. `T1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "stop_agent",
  "arguments": {
    "reason": "T9 covers this now.",
    "taskId": "T7"
  }
}
```

### brief

Open and start work. Without workstreamId it opens a new order from text (the human's words) and this brief, and starts it: new work from the chat starts this way, even when every order is closed. With workstreamId it sets that workstream's brief (goal, why, pointers, constraints, doneWhen lines) and starts it, or edits it later. An order opened for a Navi's message gives asked, its N&lt;n> handle, so the Navi hears when it lands.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `asked` | string | no | The Navi message (`project_message`) this order is opened for, so that Navi hears when it lands. |
| `brief` | object | yes |  |
| `brief.constraints` | string[] | yes | At most 20 items. |
| `brief.doneWhen` | string[] | yes | At least one. At most 20 items. |
| `brief.goal` | string | yes | At most 1000 characters. |
| `brief.pointers` | string[] | yes | At most 20 items. |
| `brief.why` | string | yes | At most 2000 characters. |
| `text` | string | no | The order in the human's words, when this opens the workstream. At most 4000 characters. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "brief",
  "arguments": {
    "brief": {
      "constraints": [
        "No new service; use the existing Redis."
      ],
      "doneWhen": [
        "A client past its limit gets 429 with Retry-After."
      ],
      "goal": "Uploads are rate-limited per API key.",
      "pointers": [
        "api/src/upload.rs"
      ],
      "why": "One client's retry loop took the upload service down."
    },
    "text": "Rate-limit the upload API"
  }
}
```

### request_secret

Ask the human for a secret (a key, a token, a password). The app shows a masked field in the chat; the value is sealed to the sink's machine and written there, and never enters a transcript. Only its fingerprint arrives, in a later wake. For a variable an agent asked for, use sink order:&lt;machine>:&lt;its order>: only that order's agents get it, at their next turn, until the order closes.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `envName` | string | no | An env: or order: sink's variable, when not the one the key names. |
| `key` | string | yes | The secret's name, a dotted slug such as "stripe.test_key". |
| `sink` | string | yes | Where the value is written: env:&lt;machine>:&lt;file> (one NAME=value line), file:&lt;machine>:&lt;path>, or order:&lt;machine>:&lt;order id> (one variable of that order's agents on the project's machine, until it closes). |
| `text` | string | yes | One line on why it is needed. At most 500 characters. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** The human enters the value in chat; you see only its fingerprint.

```json
{
  "name": "request_secret",
  "arguments": {
    "key": "stripe.test_key",
    "sink": "env:shop-box:/srv/shop/.env",
    "text": "The Stripe test key for checkout",
    "workstreamId": "W3"
  }
}
```

### request_withdraw

Take back a secret request or a command approval you no longer need (the human said so in chat).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `requestId` | string | yes | `Q<n>`, e.g. `Q1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "request_withdraw",
  "arguments": {
    "requestId": "Q4"
  }
}
```

### decide

Log a decision: one you made yourself, or the human's answer to a question you asked in chat (so you never ask it twice).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)\*, at most 80. |
| `scope` | string | no | One of `project`, `workstream`. Default `"workstream"`. |
| `value` | string | yes | At most 2000 characters. |
| `why` | string | no | At most 2000 characters. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "decide",
  "arguments": {
    "key": "api.pagination",
    "value": "cursor",
    "why": "Stable when rows are inserted mid-scroll."
  }
}
```

### close

The workstream is done: say why in one line. Its agents still queued, running or waiting are stopped; the merge train's reviewers are left to the train.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `why` | string | yes | One line on why it is done, as the human would read it. At most 500 characters. |
| `workstreamId` | string | yes | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "close",
  "arguments": {
    "why": "The rate limit is merged and live.",
    "workstreamId": "W3"
  }
}
```

### gated_run

A prod write, spend, delete or credential use: the chat shows the human exactly this argv with Approve / Deny, and the node runs it only once approved; secrets come from the node's own sinks. The exit code and output tail arrive in a later wake.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `argv` | string[] | yes | At most 64 items. |
| `class` | string | yes | One of `irreversible`, `money`, `credential`. |
| `cwd` | string | no | An absolute path. |
| `reason` | string | yes | At most 500 characters. |
| `secretEnv` | object[] | no | At most 20 items. |
| `secretEnv[].name` | string | yes | Matches `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. |
| `secretEnv[].secretKey` | string | yes | Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)\*, at most 80. |
| `timeoutSec` | integer | no | 1 to 14400. Default `1800`. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** A human approves the exact command in chat before the node runs it.

```json
{
  "name": "gated_run",
  "arguments": {
    "argv": [
      "fly",
      "deploy",
      "--app",
      "shop-prod"
    ],
    "class": "irreversible",
    "reason": "Ship the upload rate limit to production.",
    "workstreamId": "W3"
  }
}
```

### decisions_search

Search this project's decisions (and the global ones) by words, or read one by its id (D12), whole. Another project's decisions are refused.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | At most 200 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "decisions_search",
  "arguments": {
    "query": "pagination"
  }
}
```

### remember

Keep one entry in memory, in plain words, for every later session: scope user for how the person whose message you answer works everywhere (tone, taste, standing rules; their own memory), project for this project (MEMORY.md, or a topic file for detail). With replaces (words of one entry, quoted exactly) it takes that entry's place: never keep two versions. A write past a file's cap is refused: merge or replace entries, then call again. The chat shows the human what you remembered, with Undo. Never a secret.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `replaces` | string | no | Words of the entry this one replaces, quoted exactly; it must match one entry of the file. At most 1000 characters. |
| `scope` | string | yes | One of `user` (The person's own memory: how they work across every project. One shared `user.md` on a hub from before people), `project` (This project's `MEMORY.md`, or one of its topic files). |
| `text` | string | yes | One line. At most 1000 characters. |
| `topic` | string | no | Project scope only: the topic file; absent, `MEMORY.md`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "remember",
  "arguments": {
    "replaces": "Use npm",
    "scope": "project",
    "text": "No npm here: use pnpm."
  }
}
```

### forget

Remove one entry from memory: entry quotes words of exactly one entry, as it reads now; scope and topic as for remember. For an entry that no longer holds (done, superseded, contradicted); say why in reason. To change an entry, remember with replaces instead. The chat shows the human what you forgot, with Undo.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entry` | string | yes | Words of the entry to remove, quoted exactly; they must match one entry of the file. At most 1000 characters. |
| `reason` | string | no | One line. At most 300 characters. |
| `scope` | string | yes | One of `user` (The person's own memory: how they work across every project. One shared `user.md` on a hub from before people), `project` (This project's `MEMORY.md`, or one of its topic files). |
| `topic` | string | no | Project scope only: the topic file; absent, `MEMORY.md`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "forget",
  "arguments": {
    "entry": "Deploys freeze on Fridays",
    "reason": "The freeze ended with the launch.",
    "scope": "project"
  }
}
```

### memory_read

Read one of this project's memory topic files (MEMORY.md lists them).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | string | yes | Lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "memory_read",
  "arguments": {
    "topic": "deploys"
  }
}
```

### nudge

Flag the chat message you just wrote for the human's look, with reason in a few words ("the Machines page redesign"): the app shows it as something to look at, below your questions, until they have seen it, for a day at most. Only for a showcase, something to try or a risk, never routine news; a project keeps only a few, a newer one clearing the oldest. Write the message first, then call it. No notification goes out.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | yes | What to look at, in a few words: "the Machines page redesign". At most 200 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "nudge",
  "arguments": {
    "reason": "the new checkout page"
  }
}
```

### automation_create

Make an automation for this project: a name, the prompt each run gives you as a new order, and optionally a schedule (5-field cron and an IANA tz, such as 0 9 \* \* 1-5 in Europe/Berlin). Runs start work on their own; reviews, the train and approvals still apply. Only a person adds a webhook, in the app.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | One line. At most 80 characters. |
| `prompt` | string | yes | At most 2000 characters. |
| `schedule` | object | no | Absent: it runs only on Run now (and a webhook, once a person adds one). |
| `schedule.cron` | string | yes | One line. At most 100 characters. |
| `schedule.tz` | string | yes |  |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_create",
  "arguments": {
    "name": "Weekly dependency check",
    "prompt": "Check the dependencies for updates and open one PR with the safe ones.",
    "schedule": {
      "cron": "0 9 * * 1",
      "tz": "Europe/Berlin"
    }
  }
}
```

### automation_list

This project's automations with their schedule, next run, paused state and last run.

No parameters.

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_list",
  "arguments": {}
}
```

### automation_update

Change an automation's name, prompt or schedule (removeSchedule: true takes it off); fields left out stay.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | yes | Matches `^au_[A-Za-z0-9_-]{6,40}$`. |
| `name` | string | no | One line. At most 80 characters. |
| `prompt` | string | no | At most 2000 characters. |
| `removeSchedule` | boolean | no | True: take its schedule off. |
| `schedule` | object | no | Standard 5-field cron (or @daily, @hourly…) read in `tz`; the hub parses it. |
| `schedule.cron` | string | yes | One line. At most 100 characters. |
| `schedule.tz` | string | yes |  |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_update",
  "arguments": {
    "automationId": "au_k3Jd8sQp2xYz",
    "schedule": {
      "cron": "0 9 * * 1-5",
      "tz": "Europe/Berlin"
    }
  }
}
```

### automation_pause

Pause (paused: true) or resume an automation. Paused, its schedule and webhook start nothing; resumed, the schedule goes on from now.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | yes | Matches `^au_[A-Za-z0-9_-]{6,40}$`. |
| `paused` | boolean | yes |  |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_pause",
  "arguments": {
    "automationId": "au_k3Jd8sQp2xYz",
    "paused": true
  }
}
```

### automation_delete

Delete an automation and its run history; orders its runs opened stay.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | yes | Matches `^au_[A-Za-z0-9_-]{6,40}$`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_delete",
  "arguments": {
    "automationId": "au_k3Jd8sQp2xYz"
  }
}
```

### automation_run

Run an automation now: it opens its order, which reaches you in a later wake. Skipped while its last run's order is still open.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | yes | Matches `^au_[A-Za-z0-9_-]{6,40}$`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_run",
  "arguments": {
    "automationId": "au_k3Jd8sQp2xYz"
  }
}
```

### automation_runs

An automation's runs, newest first, with the order each opened; with runId, that run and its whole webhook body.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `automationId` | string | yes | Matches `^au_[A-Za-z0-9_-]{6,40}$`. |
| `runId` | string | no | Matches `^ar_[A-Za-z0-9_-]{6,40}$`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "automation_runs",
  "arguments": {
    "automationId": "au_k3Jd8sQp2xYz",
    "runId": "ar_Qm7tZr1vBn4w"
  }
}
```

### checklist

Keep the project's checklist: the to-dos the human sees beside the chat, each todo, doing or done. An item's text is a short plain outcome ("Gift cards apply before tax"), never a status, id or PR number: its state and link carry those. Add items without an id, change one by its id (text, state, link to its PR, agent or workstream), or remove it; replace sets the whole list. Returns the list.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `items` | object[] | no | At most 50 items. |
| `items[].id` | integer | no | At least 1. |
| `items[].link` | object | no | Replaces the item's link; `{}` clears it. |
| `items[].link.pr` | string | no | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `items[].link.taskId` | string | no | `T<n>`, e.g. `T1`. |
| `items[].link.workstreamId` | string | no | `W<n>`, e.g. `W1`. |
| `items[].remove` | boolean | no |  |
| `items[].state` | string | no | One of `todo`, `doing`, `done`. |
| `items[].text` | string | no | One line. At most 200 characters. |
| `replace` | boolean | no |  |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "checklist",
  "arguments": {
    "items": [
      {
        "id": 2,
        "state": "done"
      },
      {
        "id": 3,
        "link": {
          "pr": "https://github.com/acme/shop/pull/42"
        },
        "state": "doing"
      },
      {
        "text": "Ship the rate limit to production"
      }
    ]
  }
}
```

### skill_install

Install skills (SKILL.md workflows) from a skills.sh source (owner/repo, owner/repo@skill, a GitHub URL) for this project (scope project; global skills take an admin, so the human installs those); pinned to the commit fetched, and the human updates it from Settings > Skills. Agents list it as fleetd:&lt;name> and run it with the Skill tool.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | yes | The hub's two scopes, which a person (and a lead's `skill_install`) writes. One of `project`, `global`. |
| `skill` | string | no | Only this skill of the source; absent, every skill it has. |
| `source` | string | yes | `owner/repo`, `owner/repo@skill`, a GitHub URL (`/tree/<ref>/<path>` too) or any git URL. At most 500 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "skill_install",
  "arguments": {
    "scope": "project",
    "source": "vercel-labs/agent-skills@web-design-guidelines"
  }
}
```

### project_message

A Navi's call: write to another project's lead in its chat, as this Navi, never as the person: "please add X", or a question. Its lead reads it as input, never as the person's answer or approval, and may open an order for it. Returns a handle (N&lt;n>); a later wake says when an order opened for it opens, closes, merges or fails. project is a title or project id from factory_status. With hub (a linked hub's label, from factory_status's hubs), it goes to that project on the other hub, as the person via this Navi. Open an order this way only when the person asked for it in this conversation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hub` | string | no | A linked hub, by its label: the project is there. Absent: this hub. At most 40 characters. |
| `project` | string | yes | The project: its title, as factory_status names it, or its project id. At most 200 characters. |
| `text` | string | yes | At most 4000 characters. |

**Who may call:** a Navi's lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "project_message",
  "arguments": {
    "project": "storefront",
    "text": "Please add gift cards at checkout; the person asked for it this morning."
  }
}
```

### factory_status

A Navi's call: the other projects in one read, or the one named: each one's state (working, waiting on the person, blocked, idle), a red main, running agents, open orders, its checklist not done, its last merge and merges over 7 days, and this Navi's asks to it with the orders opened for them, plus the hubs this Navi is linked to. With hub, the projects the link reaches on that hub instead. Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hub` | string | no | A linked hub, by its label: its projects this Navi reaches through the link. Absent: this hub. At most 40 characters. |
| `project` | string | no | One project, by title or project id; absent, every project but this one. At most 200 characters. |

**Who may call:** a Navi's lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "factory_status",
  "arguments": {
    "project": "storefront"
  }
}
```

### chat_search

A Navi's call: search your own chat, all of it, back to its start, for the messages holding every one of words (any order and case), optionally from and to a day (2026-10-20) or time, in UTC. Newest first, 20 a page, each with its id, time, author (human is the person, lead is you) and its text around the words; before (the last id of a page) reads the next. Only this chat, never another's. Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `before` | string | no | The next page: the hits older than this message, the last one of the page before. |
| `from` | string | no | From this day (2026-10-20) or time (2026-10-20T09:00:00Z), in UTC. Absent: from the chat's start. At most 40 characters. |
| `to` | string | no | Up to this day, all of it, or this time, in UTC. Absent: up to now. At most 40 characters. |
| `words` | string | yes | The words a message holds, every one of them, in any order and case: "dentist saturday". At most 200 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "chat_search",
  "arguments": {
    "from": "2026-10-01",
    "words": "dentist saturday"
  }
}
```

### chat_read

A Navi's call: read the messages around one of your own chat by its id from chat_search, oldest first: before and after say how many on each side (5 when absent, at most 10). With both 0 it reads that one message whole. Read-only.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `after` | integer | no | How many after it; absent, 5. 0 to 10. |
| `before` | integer | no | How many messages before it; absent, 5. 0 to 10. |
| `messageId` | string | yes | The message, by its id from chat_search. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "chat_read",
  "arguments": {
    "after": 3,
    "before": 3,
    "messageId": "m412"
  }
}
```

### usage_resume

Lift the usage pause on your project's machine now and send every agent parked there "continue": only once you know its login has capacity again (the human says so, or a turn of yours just went through). At most once per 10 minutes per machine; an agent whose login is still limited parks again with the real reset. The human can also press Resume in the app or run fleetd usage resume &lt;machine>.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `machineId` | string | no | The project's machine; absent means it. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "usage_resume",
  "arguments": {
    "machineId": "devbox"
  }
}
```

### change_enqueue

Put a PR no task's result put there on its repo's merge train; only the train merges. `after` names PRs, in this repo or any other, that must merge first: the train holds this one until they have, and tells you when one of them fails. A PR on the train that its review's findings block, enqueued again, gets a fresh full review of the same patch: for findings you resolved without a new push (by narrowing the brief).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `after` | string[] | no | PRs, in this repo or any other, that must merge first: the train holds this one until each has merged. Enqueuing a PR already on the train adds these to it, unless it is already being merged. At most 20 items. |
| `prUrl` | string | yes | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `taskId` | string | no | `T<n>`, e.g. `T1`. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "change_enqueue",
  "arguments": {
    "prUrl": "https://github.com/acme/shop/pull/42",
    "workstreamId": "W3"
  }
}
```

### review_read

Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. pr (its URL or number) picks one; without it, a task reads all its own PRs, a reviewer the PR it reviews, and a lead its project's PRs in the merge queue. Another project's reviews are refused.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr` | string | no | The PR: its URL or its number. Absent: a task's every PR, a lead's PRs in the merge queue. At most 500 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "review_read",
  "arguments": {
    "pr": "https://github.com/acme/storefront/pull/7"
  }
}
```

### preview_suggest

Suggest the person try a PR themselves, where a human test clearly matters (a UI change, copy in several languages, a mobile build): one line with a Try it button in the chat and the PR, once per PR, which the app also shows as something to look at until the person has seen it. why says what to look at, in plain words. Nothing starts from it: only the person starts a preview.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prUrl` | string | yes | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `why` | string | yes | One line. At most 300 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "preview_suggest",
  "arguments": {
    "prUrl": "https://github.com/acme/storefront/pull/7",
    "why": "The checkout's buttons read differently in German and Dutch"
  }
}
```

### preview_config_propose

Propose how Try it runs this project's web app, once you know: setup commands (install), build, a start command that serves on 127.0.0.1:$PORT, the ready path and the lockfiles setup depends on. The person sees it as an approval card; nothing is saved until they approve, and the outcome arrives in a wake.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `config` | object | yes | A project's preview setting (Settings › Projects › Try it, or `project_settings_set {preview}`). Nothing runs because of it: it says how to run a preview someone asks for. |
| `config.idleMinutes` | integer | no | A preview no one used for this many minutes ends. 5 to 240. Default `30`. |
| `config.web` | object | no | How a project's web app is built and run for a preview, each command with `sh -c` in the preview's worktree and the project's variables, as setup commands run (#501). |
| `config.web.build` | string | no | Builds the app; none for an app the start command builds itself. At most 2000 characters. |
| `config.web.inputs` | string[] | no | Files whose contents decide what setup makes, such as lockfiles. At most 20 items. |
| `config.web.ready` | string | no | Asked until it answers, for at most 2 minutes after the start. Default `"/"`. |
| `config.web.setup` | string[] | no | Run first, in order: install dependencies, generate code. Skipped when `inputs` haven't changed since a preview of this project last ran them on this machine. At most 20 items. |
| `config.web.start` | string | yes | Serves the app on `127.0.0.1:$PORT`; it runs until the preview ends. At most 2000 characters. |
| `why` | string | yes | One line. At most 300 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** A person approves the proposed setting in chat before it is saved.

```json
{
  "name": "preview_config_propose",
  "arguments": {
    "config": {
      "web": {
        "build": "pnpm build",
        "inputs": [
          "pnpm-lock.yaml"
        ],
        "setup": [
          "pnpm install --frozen-lockfile"
        ],
        "start": "pnpm preview --port $PORT --host 127.0.0.1"
      }
    },
    "why": "The storefront is a Vite app"
  }
}
```

### chat_image

Put an image you made in this project's chat: use it for screenshots of UI changes, instead of a link. path is a png, jpeg, webp or gif file inside your working directory (relative, or absolute inside it; nothing outside it is read), at most 25 MiB. Returns its attachmentId. A lead shows it in its message with an image block ({"v":1,"kind":"image","attachmentId":"F12","caption":"…"}); a task puts the id in its result for its lead to show. Unshown, it is deleted after 24 h.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | The image file: relative to your working directory, or absolute inside it. At most 1000 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "chat_image",
  "arguments": {
    "path": "shots/checkout-after.png"
  }
}
```

### preview_start

Start a preview of a PR (or an order's PRs merged together) for the person to try: only when the person asked for it in the message you are answering, never on your own (use preview_suggest for that). It runs on a machine that can host it and opens in the app; previews_list in the app shows it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `of` | object | yes | What a preview is of: one PR, or an order's PRs merged together onto their base on a scratch branch (D162). One of these shapes: {kind, number, repo}; {kind, workstreamId}. |
| `target` | string | no | What a preview runs: phase 1 is the web; Android, iOS and the desktop follow (docs/design/try-it.md, Phases). One of `web`. Default `"web"`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "preview_start",
  "arguments": {
    "of": {
      "kind": "pr",
      "number": 7,
      "repo": "acme/storefront"
    }
  }
}
```

### session_start

Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end (a Navi's browser instead keeps its own profile, so the sites it signed into stay signed in). It is recorded (video, the page after each step, a line per agent-browser command) for the person to replay. Drive it with the agent-browser CLI in Bash, which is already pointed at it: pass no --cdp and launch no browser of your own. purpose: one line on what for. kind android instead opens a fresh Android emulator (Android 15), driven with the agent-device CLI, which is already pointed at it: pass no --serial or --platform. kind ios opens a fresh iOS simulator on a Mac the same way: pass no --udid or --platform. kind linux_desktop opens a fresh Linux desktop (1280x800, a window manager, xterm), driven with the desktop tool.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no | `android` for an Android emulator, `ios` for an iOS simulator, each driven with agent-device; `linux_desktop` for a Linux desktop, driven with the `desktop` tool; absent for a browser. One of `browser`, `android`, `ios`, `linux_desktop`. |
| `purpose` | string | yes | What you need the browser for, in one line; the person replaying it sees it. At most 200 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "session_start",
  "arguments": {
    "purpose": "Check that signup works on the staging site"
  }
}
```

### desktop

Act on your Linux desktop session (session_start kind linux_desktop), with computer-use actions plus launch. screenshot returns the screen as an image; left_click, right_click, middle_click, double_click, triple_click and mouse_move at coordinate [x, y] in the screenshot's pixels; left_click_drag from start_coordinate to coordinate; type text; key with xdotool key names in text (Return, ctrl+s, alt+F4); scroll with scroll_direction and scroll_amount at coordinate; wait duration seconds; cursor_position; launch: text is a shell command started on the desktop (in your working directory where the desktop can see it). Take a screenshot after acting to see what happened.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes | One of `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `type`, `key`, `scroll`, `wait`, `cursor_position`, `launch`. |
| `coordinate` | integer[] | no | `[x, y]`: where to click, move the mouse to, scroll at, or end a drag. At most 2 items. |
| `duration` | integer | no | `wait`: seconds; absent: 1. 1 to 30. |
| `scroll_amount` | integer | no | Wheel clicks; absent: 3. 1 to 50. |
| `scroll_direction` | string | no | One of `up`, `down`, `left`, `right`. |
| `start_coordinate` | integer[] | no | `[x, y]`: where a `left_click_drag` starts. At most 2 items. |
| `text` | string | no | `type`: the text. `key`: keys as xdotool names them, `+` between those pressed together (`Return`, `ctrl+s`, `alt+F4`). `launch`: a shell command started on the desktop (`xterm`, `./target/debug/app`). At most 10000 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "desktop",
  "arguments": {
    "action": "left_click",
    "coordinate": [
      640,
      412
    ]
  }
}
```

### session_end

Close your browser session: the browser and its profile are thrown away (a Navi's profile stays, with its sign-ins), and its recording goes to the hub.

No parameters.

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "session_end",
  "arguments": {}
}
```

### request_takeover

Ask a person to take your browser over, for what only they can do: a captcha, a login confirmation only they can give, a judgement call. reason says what they should do, in one line; it shows under waiting on you in the app, and they watch the page live. Carry on meanwhile: while they drive, your agent-browser commands answer that a person has control; after they hand it back, your next command sees the page as they left it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | yes | What the person should do, in one line. At most 500 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "request_takeover",
  "arguments": {
    "reason": "Solve the captcha on the signup page, then hand the browser back"
  }
}
```

### fill_credential

Fill a login field of your browser session from 1Password without seeing the value: ref is its secret reference (op://&lt;vault>/&lt;item>/&lt;field>, ?attribute=otp for a one-time code), target the field's CSS selector. The node fills it only on the item's own website, then submits the field's form in the same step; submit: false fills a field before the last of its form (a username before its password). From the first fill on, the session refuses reading values back (agent-browser eval and get value among them). Ask your lead for the reference; never ask anyone for a password.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | A 1Password secret reference: `op://<vault>/<item>/<field>`, `?attribute=otp` for a one-time code. |
| `submit` | boolean | no | False to fill without submitting, for a field before the last of its form (a username before its password). Absent: true. |
| `target` | string | yes | The field to fill: a CSS selector (`input[name=password]`, `#otp`). At most 500 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "fill_credential",
  "arguments": {
    "ref": "op://Staging/Shop admin/password",
    "target": "input[name=password]"
  }
}
```

## Task tools

Every task's agent gets these: implementers, readers, reviewers and QA.

| Tool | What it does | Needs a human |
|---|---|---|
| [`decisions_search`](#decisions_search-task) | Search this project's decisions (and the global ones) by words, or read one by its id (D12), whole. | No |
| [`report`](#report) | Record your review verdict once, before your final message: the number of blocking and non-blocking findings and a summary of each. | No |
| [`ask_lead`](#ask_lead) | Ask your lead a question. | No |
| [`brief_read`](#brief_read) | Read your workstream's brief, whole: its goal, why, pointers, constraints and done-when. | No |
| [`wait_ci`](#wait_ci) | Be woken when CI finishes: a GitHub Actions run, or the checks on a PR's current head. | No |
| [`review_read`](#review_read-task) | Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. | No |
| [`preview_suggest`](#preview_suggest-task) | Suggest the person try a PR themselves, where a human test clearly matters (a UI change, copy in several languages, a mobile build): one line with a Try it button in the chat and the PR, once per PR, which the app also shows as something to look at until the person has seen it. | No |
| [`preview_config_propose`](#preview_config_propose-task) | Propose how Try it runs this project's web app, once you know: setup commands (install), build, a start command that serves on 127.0.0.1:$PORT, the ready path and the lockfiles setup depends on. | A person approves the proposed setting in chat before it is saved. |
| [`chat_image`](#chat_image-task) | Put an image you made in this project's chat: use it for screenshots of UI changes, instead of a link. | No |
| [`session_start`](#session_start-task) | Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end (a Navi's browser instead keeps its own profile, so the sites it signed into stay signed in). | No |
| [`desktop`](#desktop-task) | Act on your Linux desktop session (session_start kind linux_desktop), with computer-use actions plus launch. | No |
| [`session_end`](#session_end-task) | Close your browser session: the browser and its profile are thrown away (a Navi's profile stays, with its sign-ins), and its recording goes to the hub. | No |
| [`request_takeover`](#request_takeover-task) | Ask a person to take your browser over, for what only they can do: a captcha, a login confirmation only they can give, a judgement call. | No |
| [`fill_credential`](#fill_credential-task) | Fill a login field of your browser session from 1Password without seeing the value: ref is its secret reference (op://&lt;vault>/&lt;item>/&lt;field>, ?attribute=otp for a one-time code), target the field's CSS selector. | No |

### decisions_search (task)

Search this project's decisions (and the global ones) by words, or read one by its id (D12), whole. Another project's decisions are refused.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | At most 200 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "decisions_search",
  "arguments": {
    "query": "pagination"
  }
}
```

### report

Record your review verdict once, before your final message: the number of blocking and non-blocking findings and a summary of each. fleetd fills in your task and the head you reviewed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `blocking` | integer | yes |  |
| `nonBlocking` | integer | yes |  |
| `summary` | string | yes | At most 4000 characters. |

**Who may call:** a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "report",
  "arguments": {
    "blocking": 0,
    "nonBlocking": 2,
    "summary": "The limiter is correct. Two nits: a magic number and a missing test for the reset."
  }
}
```

### ask_lead

Ask your lead a question. Carry on with what you can; the answer arrives as a message. If you can't go on without it, end your turn: the answer continues this thread. For a variable that is not set, name it and say why; never put a secret's value in the question.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | At most 4000 characters. |

**Who may call:** a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "ask_lead",
  "arguments": {
    "question": "Should the limit apply to admin keys too?"
  }
}
```

### brief_read

Read your workstream's brief, whole: its goal, why, pointers, constraints and done-when.

No parameters.

**Who may call:** a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "brief_read",
  "arguments": {}
}
```

### wait_ci

Be woken when CI finishes: a GitHub Actions run, or the checks on a PR's current head. url is the run's (`https://github.com/<owner>/<repo>/actions/runs/<id>`; `gh run view <id> --json url -q .url`) or the PR's. Then end your turn: when it finishes, this thread continues with one line, the outcome and the failing jobs. Never end a turn saying you'll wait for a run without it: nothing else wakes you.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | An Actions run's URL (`…/actions/runs/<id>`, anything after it ignored) or a PR's, in one of the project's repos. At most 500 characters. |

**Who may call:** a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "wait_ci",
  "arguments": {
    "url": "https://github.com/acme/storefront/actions/runs/4242"
  }
}
```

### review_read (task)

Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. pr (its URL or number) picks one; without it, a task reads all its own PRs, a reviewer the PR it reviews, and a lead its project's PRs in the merge queue. Another project's reviews are refused.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pr` | string | no | The PR: its URL or its number. Absent: a task's every PR, a lead's PRs in the merge queue. At most 500 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "review_read",
  "arguments": {
    "pr": "https://github.com/acme/storefront/pull/7"
  }
}
```

### preview_suggest (task)

Suggest the person try a PR themselves, where a human test clearly matters (a UI change, copy in several languages, a mobile build): one line with a Try it button in the chat and the PR, once per PR, which the app also shows as something to look at until the person has seen it. why says what to look at, in plain words. Nothing starts from it: only the person starts a preview.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prUrl` | string | yes | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `why` | string | yes | One line. At most 300 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "preview_suggest",
  "arguments": {
    "prUrl": "https://github.com/acme/storefront/pull/7",
    "why": "The checkout's buttons read differently in German and Dutch"
  }
}
```

### preview_config_propose (task)

Propose how Try it runs this project's web app, once you know: setup commands (install), build, a start command that serves on 127.0.0.1:$PORT, the ready path and the lockfiles setup depends on. The person sees it as an approval card; nothing is saved until they approve, and the outcome arrives in a wake.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `config` | object | yes | A project's preview setting (Settings › Projects › Try it, or `project_settings_set {preview}`). Nothing runs because of it: it says how to run a preview someone asks for. |
| `config.idleMinutes` | integer | no | A preview no one used for this many minutes ends. 5 to 240. Default `30`. |
| `config.web` | object | no | How a project's web app is built and run for a preview, each command with `sh -c` in the preview's worktree and the project's variables, as setup commands run (#501). |
| `config.web.build` | string | no | Builds the app; none for an app the start command builds itself. At most 2000 characters. |
| `config.web.inputs` | string[] | no | Files whose contents decide what setup makes, such as lockfiles. At most 20 items. |
| `config.web.ready` | string | no | Asked until it answers, for at most 2 minutes after the start. Default `"/"`. |
| `config.web.setup` | string[] | no | Run first, in order: install dependencies, generate code. Skipped when `inputs` haven't changed since a preview of this project last ran them on this machine. At most 20 items. |
| `config.web.start` | string | yes | Serves the app on `127.0.0.1:$PORT`; it runs until the preview ends. At most 2000 characters. |
| `why` | string | yes | One line. At most 300 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** A person approves the proposed setting in chat before it is saved.

```json
{
  "name": "preview_config_propose",
  "arguments": {
    "config": {
      "web": {
        "build": "pnpm build",
        "inputs": [
          "pnpm-lock.yaml"
        ],
        "setup": [
          "pnpm install --frozen-lockfile"
        ],
        "start": "pnpm preview --port $PORT --host 127.0.0.1"
      }
    },
    "why": "The storefront is a Vite app"
  }
}
```

### chat_image (task)

Put an image you made in this project's chat: use it for screenshots of UI changes, instead of a link. path is a png, jpeg, webp or gif file inside your working directory (relative, or absolute inside it; nothing outside it is read), at most 25 MiB. Returns its attachmentId. A lead shows it in its message with an image block ({"v":1,"kind":"image","attachmentId":"F12","caption":"…"}); a task puts the id in its result for its lead to show. Unshown, it is deleted after 24 h.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | The image file: relative to your working directory, or absolute inside it. At most 1000 characters. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "chat_image",
  "arguments": {
    "path": "shots/checkout-after.png"
  }
}
```

### session_start (task)

Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end (a Navi's browser instead keeps its own profile, so the sites it signed into stay signed in). It is recorded (video, the page after each step, a line per agent-browser command) for the person to replay. Drive it with the agent-browser CLI in Bash, which is already pointed at it: pass no --cdp and launch no browser of your own. purpose: one line on what for. kind android instead opens a fresh Android emulator (Android 15), driven with the agent-device CLI, which is already pointed at it: pass no --serial or --platform. kind ios opens a fresh iOS simulator on a Mac the same way: pass no --udid or --platform. kind linux_desktop opens a fresh Linux desktop (1280x800, a window manager, xterm), driven with the desktop tool.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no | `android` for an Android emulator, `ios` for an iOS simulator, each driven with agent-device; `linux_desktop` for a Linux desktop, driven with the `desktop` tool; absent for a browser. One of `browser`, `android`, `ios`, `linux_desktop`. |
| `purpose` | string | yes | What you need the browser for, in one line; the person replaying it sees it. At most 200 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "session_start",
  "arguments": {
    "purpose": "Check that signup works on the staging site"
  }
}
```

### desktop (task)

Act on your Linux desktop session (session_start kind linux_desktop), with computer-use actions plus launch. screenshot returns the screen as an image; left_click, right_click, middle_click, double_click, triple_click and mouse_move at coordinate [x, y] in the screenshot's pixels; left_click_drag from start_coordinate to coordinate; type text; key with xdotool key names in text (Return, ctrl+s, alt+F4); scroll with scroll_direction and scroll_amount at coordinate; wait duration seconds; cursor_position; launch: text is a shell command started on the desktop (in your working directory where the desktop can see it). Take a screenshot after acting to see what happened.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | yes | One of `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `type`, `key`, `scroll`, `wait`, `cursor_position`, `launch`. |
| `coordinate` | integer[] | no | `[x, y]`: where to click, move the mouse to, scroll at, or end a drag. At most 2 items. |
| `duration` | integer | no | `wait`: seconds; absent: 1. 1 to 30. |
| `scroll_amount` | integer | no | Wheel clicks; absent: 3. 1 to 50. |
| `scroll_direction` | string | no | One of `up`, `down`, `left`, `right`. |
| `start_coordinate` | integer[] | no | `[x, y]`: where a `left_click_drag` starts. At most 2 items. |
| `text` | string | no | `type`: the text. `key`: keys as xdotool names them, `+` between those pressed together (`Return`, `ctrl+s`, `alt+F4`). `launch`: a shell command started on the desktop (`xterm`, `./target/debug/app`). At most 10000 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "desktop",
  "arguments": {
    "action": "left_click",
    "coordinate": [
      640,
      412
    ]
  }
}
```

### session_end (task)

Close your browser session: the browser and its profile are thrown away (a Navi's profile stays, with its sign-ins), and its recording goes to the hub.

No parameters.

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "session_end",
  "arguments": {}
}
```

### request_takeover (task)

Ask a person to take your browser over, for what only they can do: a captcha, a login confirmation only they can give, a judgement call. reason says what they should do, in one line; it shows under waiting on you in the app, and they watch the page live. Carry on meanwhile: while they drive, your agent-browser commands answer that a person has control; after they hand it back, your next command sees the page as they left it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `reason` | string | yes | What the person should do, in one line. At most 500 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "request_takeover",
  "arguments": {
    "reason": "Solve the captcha on the signup page, then hand the browser back"
  }
}
```

### fill_credential (task)

Fill a login field of your browser session from 1Password without seeing the value: ref is its secret reference (op://&lt;vault>/&lt;item>/&lt;field>, ?attribute=otp for a one-time code), target the field's CSS selector. The node fills it only on the item's own website, then submits the field's form in the same step; submit: false fills a field before the last of its form (a username before its password). From the first fill on, the session refuses reading values back (agent-browser eval and get value among them). Ask your lead for the reference; never ask anyone for a password.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ref` | string | yes | A 1Password secret reference: `op://<vault>/<item>/<field>`, `?attribute=otp` for a one-time code. |
| `submit` | boolean | no | False to fill without submitting, for a field before the last of its form (a username before its password). Absent: true. |
| `target` | string | yes | The field to fill: a CSS selector (`input[name=password]`, `#otp`). At most 500 characters. |

**Who may call:** a lead, a task's agent, answered by its node, which runs the browser. **Needs a human:** no.

```json
{
  "name": "fill_credential",
  "arguments": {
    "ref": "op://Staging/Shop admin/password",
    "target": "input[name=password]"
  }
}
```

## Claude Code tools

Listed for Claude Code 2.1.302, as recorded. fleetd is tested with 2.1.314.

**Allowed:** `Bash`, `DesignSync`, `Edit`, `NotebookEdit`, `Read`, `ReportFindings`, `Skill`, `ToolSearch`, `WebFetch`, `WebSearch`, `Write`.

A project's policy file can deny more with `tools.deny`.

**Blocked**, in `--disallowedTools` and in the `permissions.deny` of fleetd's settings, so your own settings can't turn them back on:

| Tool | Why |
|---|---|
| `Task`, `Agent` | fleetd manages agents (spawn_agent). Task and Agent are one tool: init lists Task, the model sees Agent, and denying either removes both. |
| `Workflow`, `ListAgents`, `SendMessage`, `TaskStop`, `TaskOutput`, `TeamCreate`, `TeamDelete` | fleetd manages agents. Every agent is a fleetd task with its own session, slot, worktree, lane, steering and receipts, started with spawn_agent. |
| `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` | Nobody sits at a terminal to answer it, so the run would stall. Agents use ask or ask_lead. |
| `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` | fleetd schedules work (tasks, wakes), never inside one claude process the node may restart. |
| `EnterWorktree`, `ExitWorktree` | fleetd owns worktrees, one per writer. A session that moves its own folder can't be resumed. |
| `Bash(claude *)`, `Bash(*bin/claude)`, `Bash(*bin/claude *)`, `Bash(*/claude -*)`, `Bash(*claude/versions/*)`, `Bash(npx *claude*)`, `Bash(bunx *claude*)`, `Bash(*@anthropic-ai/claude-code*)`, `Bash(*sh -*c *claude*)`, `Bash(env *claude*)`, `Bash(exec *claude*)`, `Bash(xargs *claude*)` | A claude started inside a session runs outside fleetd's slots, with its own subagents and any model. Agents start agents with spawn_agent. |

fleetd also blocks any tool like these that a newer Claude Code adds: a session whose tool list still offers one is stopped, and every later session on that machine blocks it.

**Blocked for fleetd's agents**, in `--disallowedTools`; threads you start keep them:

| Tool | Sessions | Why |
|---|---|---|
| `ReportFindings` | Leads and task agents | Agents report a review with fleetd's own `report`. |
| `DesignSync`, `NotebookEdit` | Leads and task agents | Unused by fleetd's agents, and tool schemas ride on every request. |
| `Edit`, `Write` | Leads | The lead never changes files: its agents do. |
| `WebFetch`, `WebSearch` | Leads | The lead's agents read the web; the lead routes. |

**A Navi's lead** keeps `Edit`, `Write`, `WebFetch` and `WebSearch`, and runs in `manual` permission mode: any tool not below asks first. Its file tools and fetches always ask, in its settings' `permissions.ask`, whatever your own settings allow. The node answers a file tool as the Navi's sandbox has it: allowed but where the sandbox hides or keeps read-only (and for its `.claude`, `.mcp.json` and `.fleetd`), refused there whoever approves it ([Navi sandbox](/docs/security#navi-sandbox), D234). A policy file's allow rules don't apply to it. The node also answers a shell command: it runs, held by the OS sandbox (decision `navi.shell-unasked`, D208), unless it opens a site in the browser. A fetch or `agent-browser open` goes through without asking to a site the person allowed at its first visit or linked in their own chat message. Any other ask reaches the person as an approval in the Navi's chat, showing the tool and exactly what it would get.

| Allowed without asking | Why |
|---|---|
| `WebSearch` | A search sends only its query, to the search provider. |
| `Skill` | Loads a skill's instructions; runs nothing. |
| `mcp__fleetd` | fleetd's own tools, which the hub checks on every call. |
| `Bash(agent-device *)` | Screens work as they do for every lead; a final Send or Pay click is the person's, through request_takeover. |

| Always asked | Why |
|---|---|
| `Read`, `Glob`, `Grep` | A Navi reads anything but what its sandbox hides. |
| `Edit`, `Write`, `NotebookEdit` | A Navi writes anything but what its sandbox hides or keeps read-only. |
| `WebFetch` | A Navi fetches a site unasked only once the person allowed or linked it. |

## Settings fleetd forces

Set in the claude process's environment. "In settings" marks the ones also in fleetd's settings file for a session, which outranks the `env` in your own settings.

| Variable | Value | Where | In settings | Why |
|---|---|---|---|---|
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1` | Every claude fleetd starts | yes | Takes run_in_background out of Bash and Agent and refuses it: a background job outlives the turn fleetd tracks. |
| `CLAUDE_CODE_DISABLE_WORKFLOWS` | `1` | Every claude fleetd starts | yes | Removes the Workflow tool: fleetd manages agents. |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | `1` | Every claude fleetd starts | yes | Removes the built-in Explore and Plan agents: fleetd manages agents. |
| `CLAUDE_CODE_DISABLE_AGENT_VIEW` | `1` | Every claude fleetd starts | yes | Removes the built-in claude agent: fleetd manages agents. |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | removed | Every claude fleetd starts | yes | Agent teams: fleetd manages agents. |
| `CLAUDE_CODE_COORDINATOR_MODE` | removed | Every claude fleetd starts | yes | Coordinator mode turns a session into one that only delegates (its tools become Task, ListAgents, SendMessage, TaskStop, Workflow). |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1`, and `autoMemoryEnabled: false` | Every claude fleetd starts | yes | fleetd owns an agent's context (briefs, decisions, instructions). Notes claude keeps per folder would carry stale, unreviewed text from one agent's worktree to the next. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | The high profile's model: `claude-opus-5-5` unless a setting chose another | Every claude fleetd starts | yes | claude's background helper calls (session titles and the like) run on the default profile's model like the lead and every review, not on the haiku model claude picks by default. |
| `DISABLE_AUTOUPDATER` | `1` | Sessions | yes | Keeps the claude fleetd checked. An update mid-run would swap the binary under a live session. |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` | `1` | Sessions | no | A refusal at startup arrives as a result fleetd can read, not only as stderr. |
| `ENABLE_TOOL_SEARCH` | `true` unless your environment or `claude.env` sets it | Every claude fleetd starts | no | Tool schemas load when a tool is used, not on every request. fleetd's own tools always load at start. |
| `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` | `1h` unless your environment or `claude.env` sets it | Navis' leads | yes | A Navi's lead idles between a person's messages, like a lead between wakes. |
| `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` | `1h` unless your environment or `claude.env` sets it | Leads | yes | A lead idles between wakes, often more than 5 minutes while reviews and CI run, and would otherwise rewrite its whole context to the prompt cache on those wakes. |
| `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` | `1h` unless your environment or `claude.env` sets it | Threads you start | yes | A person's thread idles while they read and reply. |
| `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` | `5m` unless your environment or `claude.env` sets it | Task agents | yes | A task's agent (writer, reader, reviewer, CI fix) works in one burst and ends, so a 1-hour write pays for an hour it never uses. |
| `BASH_MAX_TIMEOUT_MS` | `280000` unless your environment or `claude.env` sets it | Task agents | yes | No one command outlives a task agent's 5-minute prompt cache: past it, the agent's next request writes its whole context to the cache again. A longer suite is CI's job. |
| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` | removed | Sessions | no | claude sets it for its own children and treats a process that has it as nested inside another session. |

## What your own setup adds

fleetd starts sessions with your own Claude Code setup underneath.

| Your setup | In a session |
|---|---|
| MCP servers (user, project, local) | Loaded. fleetd adds its `fleetd` server next to them. |
| Skills, plugins, hooks, `CLAUDE.md` | Loaded as in your own `claude`. |
| Allow and deny rules | Applied. fleetd's blocked tools stay blocked: its settings outrank yours. |
| Your own agents (`~/.claude/agents`) | Listed, but nothing can start them: the Agent tool is blocked. |
| Env in your settings | Applied, except the switches above, which fleetd sets last. |

A project's policy file can add rules for its sessions: `tools.allow` and `tools.deny` (Claude Code rule syntax).

### See it in a session

| Where | What you see |
|---|---|
| App: open an agent in the panel's Agents tab, then **What it was told** | "What the writer was told": the exact system prompt and first message, which prompt versions it used and the tools it never gets. |
| CLI on the hub machine: `fleetd prompts show --session <machine>/<thread>` | The system prompt and first message alone. |
| MCP client: `session_prompt_get` | The same as the app. |
| `claude mcp list` in the project's folder | Your own MCP servers, which the session loads too. |
