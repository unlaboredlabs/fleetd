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
| Agents running at once, per machine | The machine's max agents, which a person may set up to the fleet cap (`cap_set`, `fleetd machine set`, Settings > Agents). Unset: what the machine fits, one per CPU less one in eight, and 2 GB of memory each after a quarter (4 to 16 GB) is left for the system, at most 64. Either way new agents pause while memory in use runs short, and wait for 5 GB of disk each above the free-space floor. |
| Agents running at once, fleet-wide | The machines' caps added up, unless a person set a fleet cap. |
| Calls a task's agent may make | `report`, `ask_lead`, `brief_read`, `decisions_search`, `review_read`. Every other call is refused. |
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
| [`remember`](#remember) | Keep one entry in memory, in plain words, for every later session: scope user for how the human works everywhere (tone, taste, standing rules), project for this project (MEMORY.md, or a topic file for detail). | No |
| [`memory_read`](#memory_read) | Read one of this project's memory topic files (MEMORY.md lists them). | No |
| [`automation_create`](#automation_create) | Make an automation for this project: a name, the prompt each run gives you as a new order, and optionally a schedule (5-field cron and an IANA tz, such as 0 9 \* \* 1-5 in Europe/Berlin). | No |
| [`automation_list`](#automation_list) | This project's automations with their schedule, next run, paused state and last run. | No |
| [`automation_update`](#automation_update) | Change an automation's name, prompt or schedule (removeSchedule: true takes it off); fields left out stay. | No |
| [`automation_pause`](#automation_pause) | Pause (paused: true) or resume an automation. | No |
| [`automation_delete`](#automation_delete) | Delete an automation and its run history; orders its runs opened stay. | No |
| [`automation_run`](#automation_run) | Run an automation now: it opens its order, which reaches you in a later wake. | No |
| [`automation_runs`](#automation_runs) | An automation's runs, newest first, with the order each opened; with runId, that run and its whole webhook body. | No |
| [`checklist`](#checklist) | Keep the project's checklist: the to-dos the human sees beside the chat, each todo, doing or done. | No |
| [`skill_install`](#skill_install) | Install skills (SKILL.md workflows) from a skills.sh source (owner/repo, owner/repo@skill, a GitHub URL) for this project (scope project; global skills take an admin, so the human installs those); pinned to the commit fetched, and the human updates it from Settings > Skills. | No |
| [`usage_resume`](#usage_resume) | Lift the usage pause on your project's machine now and send every agent parked there "continue": only once you know its login has capacity again (the human says so, or a turn of yours just went through). | No |
| [`change_enqueue`](#change_enqueue) | Put a PR no task's result put there on its repo's merge train; only the train merges. | No |
| [`review_read`](#review_read) | Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. | No |
| [`session_start`](#session_start) | Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end. | No |
| [`session_end`](#session_end) | Close your browser session: the browser and its profile are thrown away, and its recording goes to the hub. | No |
| [`request_takeover`](#request_takeover) | Ask a person to take your browser over, for what only they can do: a captcha, a login confirmation only they can give, a judgement call. | No |
| [`fill_credential`](#fill_credential) | Fill a login field of your browser session from 1Password without seeing the value: ref is its secret reference (op://&lt;vault>/&lt;item>/&lt;field>, ?attribute=otp for a one-time code), target the field's CSS selector. | No |

### spawn_agent

Start a fleetd agent (a task) with its own session, slot and lane. title is what the human sees: a short plain outcome ("Saved carts survive a sign-out"), never an id, status or PR number. kind write|read|review; a writer gets its own worktree and branch; a review task needs pr. profile is high by default; medium is for mechanical work only, and reviews always run high. A full slot board queues it and it starts by itself. A writer is checked against the work in flight on the repo: one that repeats it is refused (taken, or a possible duplicate); if it is different work, call again with notDuplicateOf and notDuplicateWhy. A person's claim is theirs: ask in chat. The result names the other writers running in the project and the work elsewhere it may overlap. Its result arrives in a later wake: end your turn instead of waiting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | no | Every task gets its own worktree: a writer on its own branch, a reader or reviewer detached. One of `write`, `read`, `review`. Default `"write"`. |
| `notDuplicateOf` | string[] | no | A writer refused as a possible duplicate: the ids it was refused for (`T12`, `C7`), when this is different work. Needs `notDuplicateWhy`. At most 10 items. |
| `notDuplicateWhy` | string | no | Why it is different work, in one line; kept in the hub's log. At most 200 characters. |
| `paths` | string[] | no | The files a writer will change, repo-relative (`app/theme.ts`, `app/settings/**`): matched against the work in flight. At most 50 items. |
| `pr` | string | no |  |
| `profile` | string | no | What an agent runs on. There are exactly two: `high` is the default and what the lead, every reviewer and every helper call run; `medium` is for mechanical tasks the lead picks. The node's runner picks the model and effort of each. One of `high`, `medium`. |
| `prompt` | string | yes | At most 8000 characters. |
| `qa` | boolean | no |  |
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

Open and start work. Without workstreamId it opens a new order from text (the human's words) and this brief, and starts it: new work from the chat starts this way, even when every order is closed. With workstreamId it sets that workstream's brief (goal, why, pointers, constraints, doneWhen lines) and starts it, or edits it later.

| Parameter | Type | Required | Description |
|---|---|---|---|
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

The workstream is done: say why in one line. It stops nothing; stop any agent of it you no longer need.

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

Keep one entry in memory, in plain words, for every later session: scope user for how the human works everywhere (tone, taste, standing rules), project for this project (MEMORY.md, or a topic file for detail). With replaces (words of one entry, quoted exactly) it takes that entry's place: never keep two versions. A write past a file's cap is refused: merge or replace entries, then call again. The chat shows the human what you remembered, with Undo. Never a secret.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `replaces` | string | no | Words of the entry this one replaces, quoted exactly; it must match one entry of the file. At most 1000 characters. |
| `scope` | string | yes | One of `user` (`user.md`: how the human works across every project), `project` (This project's `MEMORY.md`, or one of its topic files). |
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

Put a PR no task's result put there on its repo's merge train; only the train merges.

| Parameter | Type | Required | Description |
|---|---|---|---|
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

Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. pr (its URL or number) picks one; without it, a task reads all its own PRs and a lead its project's PRs in the merge queue. Another project's reviews are refused.

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

### session_start

Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end. It is recorded (video, the page after each step, a line per agent-browser command) for the person to replay. Drive it with the agent-browser CLI in Bash, which is already pointed at it: pass no --cdp and launch no browser of your own. purpose: one line on what for.

| Parameter | Type | Required | Description |
|---|---|---|---|
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

### session_end

Close your browser session: the browser and its profile are thrown away, and its recording goes to the hub.

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
| [`review_read`](#review_read-task) | Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. | No |
| [`session_start`](#session_start-task) | Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end. | No |
| [`session_end`](#session_end-task) | Close your browser session: the browser and its profile are thrown away, and its recording goes to the hub. | No |
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

### review_read (task)

Read every finding of the latest reviews of your PRs, blocking and non-blocking, in full, each with path:line. pr (its URL or number) picks one; without it, a task reads all its own PRs and a lead its project's PRs in the merge queue. Another project's reviews are refused.

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

### session_start (task)

Open a browser session: a fresh Chrome with an empty profile, only yours, thrown away at session_end. It is recorded (video, the page after each step, a line per agent-browser command) for the person to replay. Drive it with the agent-browser CLI in Bash, which is already pointed at it: pass no --cdp and launch no browser of your own. purpose: one line on what for.

| Parameter | Type | Required | Description |
|---|---|---|---|
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

### session_end (task)

Close your browser session: the browser and its profile are thrown away, and its recording goes to the hub.

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

Listed for Claude Code 2.1.302, the version fleetd is tested with.

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
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claude-opus-5-5` | Every claude fleetd starts | yes | claude's background helper calls (session titles and the like) run on Opus 5.5 like everything else fleetd starts, not on the haiku model claude picks by default. |
| `DISABLE_AUTOUPDATER` | `1` | Sessions | yes | Keeps the claude fleetd checked. An update mid-run would swap the binary under a live session. |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` | `1` | Sessions | no | A refusal at startup arrives as a result fleetd can read, not only as stderr. |
| `ENABLE_TOOL_SEARCH` | `true` unless your environment or `claude.env` sets it | Every claude fleetd starts | no | Tool schemas load when a tool is used, not on every request. fleetd's own tools always load at start. |
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
| App: open an agent in the panel's Agents tab, then **What it was told** | "What the writer was told": the exact first message, which prompt versions it used and the tools it never gets. |
| CLI on the hub machine: `fleetd prompts show --session <machine>/<thread>` | The first message alone. |
| MCP client: `session_prompt_get` | The same as the app. |
| `claude mcp list` in the project's folder | Your own MCP servers, which the session loads too. |
