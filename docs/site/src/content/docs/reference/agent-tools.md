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
| Finish-all lead | A lead whose workstream runs the finish-all playbook. It also uses `inventory` and `workstream_spawn` | [Lead tools](#lead-tools) | Yes, child workstreams too |
| Implementer | `spawn_agent` with kind `write`. Gets its own worktree and branch | [Task tools](#task-tools) | No |
| Reader | `spawn_agent` with kind `read` | [Task tools](#task-tools) | No |
| Reviewer | `spawn_agent` with kind `review` | [Task tools](#task-tools) | No |
| Verifier | A review task the review gate starts as the verifier | [Task tools](#task-tools) | No |
| QA | `spawn_agent` with kind `review` and `qa: true` | [Task tools](#task-tools) | No |
| Retro | One `claude -p` on the hub that proposes playbook changes from incidents; not a session | None, no MCP servers | No |

The retro's Claude Code tools: none. fleetd starts it with `--tools ""`, `--strict-mcp-config` and `--safe-mode`.

## Hub limits

The hub checks these on every fleetd call a session makes, through its MCP tools or a `fleetd` command in its shell. A refusal says why and what to do instead.

| Limit | Value |
|---|---|
| Who can start agents | A lead, with `spawn_agent`, `workstream_spawn`. A task's agent can't. |
| Depth | 1. A lead is depth 0 and its tasks depth 1; nothing goes deeper. |
| Open tasks per lead | 32 (queued, running or idle). Slots cap what runs at once. |
| Calls a task's agent may make | `report`, `ask_lead`, `claim_done`. Every other call is refused. |
| Finish-all children open at once | 5 by default; the policy file's `finishAll.maxChildren` changes it. |
| What a child workstream may serve | `issue`, `defect`, `done`. Never invented work. |
| Gated commands (`gated_run`) | Classes `irreversible`, `money`, `credential`. Run only after a human approves; at most 1800 s. |
| What a lead may ask the human (`ask`) | Classes `product`, `money`, `credential`, `irreversible`. Anything else it decides itself (`decide`). |

These limits cover calls to fleetd, not what the agent's own shell can do. A task runs with full Bash, so `gated_run` is not the only way it could run a command. A process that leaves its session's process tree (for example with `setsid`) and scrubs its environment counts as you, with no limits: see "Known limit" on the Security page. Run agents you don't trust as a different OS user.

## Lead tools

Every lead gets these, the finish-all lead included.

| Tool | What it does | Needs a human |
|---|---|---|
| [`spawn_agent`](#spawn_agent) | Start a fleetd agent (a task) with its own session, slot and lane. | No |
| [`message_agent`](#message_agent) | Steer a task: a running one takes the message at its next tool boundary (now: true stops its current step first), a waiting one gets it as its answer, and an ended one continues in its own thread. | No |
| [`agent_status`](#agent_status) | One task as stored: state, queued reason, thread, result. | No |
| [`list_agents`](#list_agents) | The project's tasks, newest first, optionally by state or workstream. | No |
| [`stop_agent`](#stop_agent) | Stop a task: interrupts its thread and releases its slot and leases. | No |
| [`brief`](#brief) | Freeze a draft workstream's brief (goal, why, pointers, constraints, doneWhen checks, tier, estimate) and start it. | Changing a frozen brief (amend) needs an ask the human approved. |
| [`ask`](#ask) | Ask the human about product, money, credentials or irreversible actions only, with a dotted decision key and your recommendation. | No |
| [`ask_withdraw`](#ask_withdraw) | Withdraw an ask, naming the existing decision that answers it (use). | No |
| [`decide`](#decide) | Log a decision you made yourself (anything that is not product, money, credentials or irreversible). | No |
| [`claim_done`](#claim_done) | Claim a workstream done: fleetd runs its frozen done-when checks itself, and only all of them passing makes it done. | No |
| [`gated_run`](#gated_run) | A prod write, spend, delete or credential use: the node runs exactly this argv only after a human approves it; secrets come from the node's own sinks. | A human approves the exact command (an approve ask) before the node runs it. |
| [`plan_milestone`](#plan_milestone) | Add a milestone to the project's plan. | No |
| [`plan_add`](#plan_add) | Add a plan item (must or polish, size s\|m\|l, after other items). | No |
| [`plan_edit`](#plan_edit) | Change a plan item. | No |
| [`plan_drop`](#plan_drop) | Drop a plan item, with why or steer. | No |
| [`plan_show`](#plan_show) | The project's plan. | No |
| [`status_set`](#status_set) | Your one-line status for a workstream; it shows as "lead says". | No |
| [`decisions_search`](#decisions_search) | Search the decision log. | No |
| [`change_enqueue`](#change_enqueue) | Put a PR no task's result put there on its repo's merge train; only the train merges. | No |
| [`change_status`](#change_status) | A merge-train change as stored. | No |
| [`workstream_spawn`](#workstream_spawn) | A finish-all lead starts a child workstream for one item with a value source. | No |
| [`inventory`](#inventory) | The project's open work, ranked. | No |

### spawn_agent

Start a fleetd agent (a task) with its own session, slot and lane. kind write|read|review; a writer needs areas from the project's policy and serves (done:&lt;n>, issue:&lt;ref>, defect:&lt;text> or ask:&lt;id>) and gets its own worktree and branch; a review task needs pr. model and effort are optional. A busy area or a full slot board queues it and it starts by itself. Its result arrives in a later wake: end your turn instead of waiting.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `areas` | string[] | no | At most 20 items. |
| `effort` | string | no | One of `low`, `medium`, `high`, `max`. |
| `estimateMinutes` | number | no | Older leads only: fleetd no longer asks for time estimates and the CLI no longer sends one. |
| `item` | string | no | The plan item this task works on; refused when it belongs to another order. |
| `kind` | string | no | Only write tasks get a worktree and leases. One of `write`, `read`, `review`. Default `"write"`. |
| `model` | string | no |  |
| `pr` | string | no |  |
| `prompt` | string | yes | At most 8000 characters. |
| `qa` | boolean | no |  |
| `serves` | string | no |  |
| `tier` | string | no | One of `S`, `M`, `L`. |
| `title` | string | yes | One line. At most 80 characters. |
| `workstreamId` | string | yes | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "spawn_agent",
  "arguments": {
    "areas": [
      "api"
    ],
    "kind": "write",
    "prompt": "Limit uploads to 10 a minute per API key. Over the limit, answer 429 with Retry-After.",
    "serves": "done:0",
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

### agent_status

One task as stored: state, queued reason, thread, result.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | yes | `T<n>`, e.g. `T1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "agent_status",
  "arguments": {
    "taskId": "T7"
  }
}
```

### list_agents

The project's tasks, newest first, optionally by state or workstream.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `state` | string | no | One of `queued`, `running`, `idle`, `done`, `failed`, `cancelled`. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "list_agents",
  "arguments": {
    "state": "running"
  }
}
```

### stop_agent

Stop a task: interrupts its thread and releases its slot and leases.

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

Freeze a draft workstream's brief (goal, why, pointers, constraints, doneWhen checks, tier, estimate) and start it. A frozen brief changes only with amend: an ask the human answered approving it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `amend` | string | no | The human-answered ask that approved changing an already frozen brief. |
| `brief` | object | yes | A `Brief` whose `tier` may be left out, as `fleetd brief create` takes it; the playbook's `tierDefault` fills it. |
| `brief.baseline` | string | no | At most 1000 characters. |
| `brief.budget` | object | no |  |
| `brief.budget.agentHours` | number | no | Older briefs only; a lead now gives `size`. |
| `brief.budget.size` | string | no | How big a research spend the lead allows, relative like plan sizes; never a time guess. One of `S`, `M`, `L`. |
| `brief.constraints` | string[] | yes | At most 20 items. |
| `brief.decisionRule` | object | no | Applied to the improvement: candidate − baseline, negated when lower is better. GO when it is at least `goAtLeast`, STOP when it is below `stopBelow`, INCONCLUSIVE in between. |
| `brief.decisionRule.better` | string | yes | One of `higher`, `lower`. |
| `brief.decisionRule.goAtLeast` | number | yes |  |
| `brief.decisionRule.stopBelow` | number | yes |  |
| `brief.doneWhen` | object[] | yes | At most 20 items. |
| `brief.estimate` | object | no |  |
| `brief.estimate.gates` | string[] | yes | At most 20 items. |
| `brief.estimate.rawMinutes` | number | yes |  |
| `brief.goal` | string | yes | At most 1000 characters. |
| `brief.metric` | string | no | One line. At most 200 characters. |
| `brief.pointers` | string[] | yes | At most 20 items. |
| `brief.tier` | string | no | One of `S`, `M`, `L`. |
| `brief.why` | string | yes | At most 2000 characters. |
| `workstreamId` | string | yes | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** Changing a frozen brief (amend) needs an ask the human approved.

```json
{
  "name": "brief",
  "arguments": {
    "brief": {
      "constraints": [
        "No new service; use the existing Redis."
      ],
      "doneWhen": [
        {
          "repo": "acme/shop",
          "type": "pr_merged"
        }
      ],
      "goal": "Uploads are rate-limited per API key.",
      "pointers": [
        "api/src/upload.rs"
      ],
      "tier": "S",
      "why": "One client's retry loop took the upload service down."
    },
    "workstreamId": "W3"
  }
}
```

### ask

Ask the human about product, money, credentials or irreversible actions only, with a dotted decision key and your recommendation. kind do: steps a human performs; kind secret: a value sealed to a machine (you only see its fingerprint). Never block on it: carry on (proceededOnRec) or with other work. The answer arrives in a later wake.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `blocks` | string | no | At most 200 characters. Default `"nothing"`. |
| `class` | string | yes | Any string: the hub refuses classes outside AskClass with the "decide this yourself" fix text. |
| `context` | string | no | At most 400 characters. |
| `envName` | string | no | An env: sink's variable, when the key's own name (`secret_env_name`) is not wanted or valid. |
| `key` | string | yes | Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)\*, at most 80. |
| `kind` | string | no | One of `decide`, `do`, `secret`. Default `"decide"`. |
| `options` | object[] | no | At most 6 items. |
| `options[].consequence` | string | no | One line, what happens if the human picks it. Absent only on asks stored before labels. At most 200 characters. |
| `options[].key` | string | yes | The decision value recorded when the human picks it, e.g. "public-snapshot". At most 2000 characters. |
| `options[].label` | string | no | A few words, e.g. "Public snapshot". Absent only on asks stored before labels: show `humanize_key`. At most 80 characters. |
| `proceededOnRec` | boolean | no | Default `false`. |
| `recommendation` | string | no | The key of one of `options`. At most 2000 characters. |
| `recommendationWhy` | string | no | One line. At most 200 characters. |
| `sink` | string | no | Required for secret; the ask's key names the secret. |
| `steps` | object[] | no | At most 20 items. |
| `steps[].command` | string | no |  |
| `steps[].expect` | string | no | What the human should see when the step worked. At most 500 characters. |
| `steps[].text` | string | yes | At most 500 characters. |
| `steps[].where` | string | yes | A machineId or "browser". |
| `text` | string | yes | The question, one short line. At most 500 characters. |
| `verify` | object | no | Do only. One of these shapes: {pr, repo, type}; {ref, repo, type}; {contains, status, type, url}; {argv, expectExit, machineId, type}; {repo, testId, type}; {criteria, type}; {question, type}. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "ask",
  "arguments": {
    "class": "money",
    "key": "billing.provider",
    "options": [
      {
        "consequence": "2.9% + 30c a charge; live this week.",
        "key": "stripe",
        "label": "Stripe"
      },
      {
        "consequence": "5% + 50c; handles sales tax for you.",
        "key": "paddle",
        "label": "Paddle"
      }
    ],
    "proceededOnRec": true,
    "recommendation": "stripe",
    "recommendationWhy": "Cheaper at our volume, and the team knows it.",
    "text": "Which payment provider should checkout use?"
  }
}
```

### ask_withdraw

Withdraw an ask, naming the existing decision that answers it (use).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `askId` | string | yes | `A<n>`, e.g. `A1`. |
| `use` | string | no | The existing decision that answers it. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "ask_withdraw",
  "arguments": {
    "askId": "A4",
    "use": "D12"
  }
}
```

### decide

Log a decision you made yourself (anything that is not product, money, credentials or irreversible).

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

### claim_done

Claim a workstream done: fleetd runs its frozen done-when checks itself, and only all of them passing makes it done. A failed claim says what failed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `closeOver` | string | no | At most 300 characters. |
| `workstreamId` | string | yes | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "claim_done",
  "arguments": {
    "workstreamId": "W3"
  }
}
```

### gated_run

A prod write, spend, delete or credential use: the node runs exactly this argv only after a human approves it; secrets come from the node's own sinks. The exit code and output tail arrive in a later wake.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `argv` | string[] | yes | At most 64 items. |
| `class` | string | yes | One of `irreversible`, `money`, `credential`. |
| `cwd` | string | no | An absolute path. |
| `reason` | string | yes | At most 500 characters. |
| `secretEnv` | object[] | no | At most 20 items. |
| `secretEnv[].name` | string | yes | Matches `^[A-Za-z_][A-Za-z0-9_]{0,127}$`. |
| `secretEnv[].secretKey` | string | yes | Lowercase dotted slug, [a-z0-9]+(.[a-z0-9_-]+)\*, at most 80. |
| `timeoutSec` | integer | no | 1 to 1800. Default `1800`. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** A human approves the exact command (an approve ask) before the node runs it.

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

### plan_milestone

Add a milestone to the project's plan.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `position` | integer | no |  |
| `title` | string | yes | One line. At most 120 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "plan_milestone",
  "arguments": {
    "title": "Public beta"
  }
}
```

### plan_add

Add a plan item (must or polish, size s|m|l, after other items). After a milestone's first 10 minutes a change needs why, or steer when the human's steer asked for it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `after` | string[] | no | At most 20 items. |
| `check` | integer | no | 0 to 19. |
| `milestoneId` | string | yes | `M<n>`, e.g. `M1`. |
| `pr` | string | no | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `size` | string | no | Absent: `m`, with a warning to size it. One of `s`, `m`, `l`. |
| `steer` | string | no | The change carries out a steer; it stands in for `--why` and acknowledges the steer. |
| `title` | string | yes | One line. At most 120 characters. |
| `weight` | string | no | One of `must` (Counts toward the headline number), `polish` (Shown beside the number, never in it). Default `"must"`. |
| `why` | string | no | One line. At most 200 characters. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "plan_add",
  "arguments": {
    "milestoneId": "M1",
    "size": "s",
    "title": "Rate-limit uploads",
    "weight": "must"
  }
}
```

### plan_edit

Change a plan item.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `after` | string[] | no | Replaces the list. At most 20 items. |
| `checkAdd` | integer[] | no | At most 20 items. |
| `checkRemove` | integer[] | no | At most 20 items. |
| `itemId` | string | yes | `P<n>`, e.g. `P1`. |
| `milestoneId` | string | no | `M<n>`, e.g. `M1`. |
| `position` | integer | no |  |
| `prAdd` | string[] | no | At most 20 items. |
| `prRemove` | string[] | no | At most 20 items. |
| `size` | string | no | One of `s`, `m`, `l`. |
| `steer` | string | no | `--steer S12`, as on `plan add`. |
| `title` | string | no | One line. At most 120 characters. |
| `weight` | string | no | One of `must` (Counts toward the headline number), `polish` (Shown beside the number, never in it). |
| `why` | string | no | One line. At most 200 characters. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "plan_edit",
  "arguments": {
    "itemId": "P4",
    "size": "m",
    "why": "The limiter needs a shared store."
  }
}
```

### plan_drop

Drop a plan item, with why or steer.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `itemId` | string | yes | `P<n>`, e.g. `P1`. |
| `steer` | string | no | `--steer S12`, as on `plan add`. |
| `why` | string | no | One line. At most 200 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "plan_drop",
  "arguments": {
    "itemId": "P6",
    "why": "The client already throttles."
  }
}
```

### plan_show

The project's plan.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "plan_show",
  "arguments": {}
}
```

### status_set

Your one-line status for a workstream; it shows as "lead says".

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | One line. At most 280 characters. |
| `workstreamId` | string | no | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "status_set",
  "arguments": {
    "text": "Limiter merged; checking the 429 path.",
    "workstreamId": "W3"
  }
}
```

### decisions_search

Search the decision log.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | At most 200 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "decisions_search",
  "arguments": {
    "query": "pagination"
  }
}
```

### change_enqueue

Put a PR no task's result put there on its repo's merge train; only the train merges.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `item` | string | no | Stores the PR as a link of that plan item (for a PR no task of the item wrote). |
| `prUrl` | string | yes | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `serves` | string | no |  |
| `taskId` | string | no | `T<n>`, e.g. `T1`. |
| `tier` | string | no | One of `S`, `M`, `L`. |
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

### change_status

A merge-train change as stored.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `changeId` | string | yes | `X<n>`, e.g. `X1`. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "change_status",
  "arguments": {
    "changeId": "X12"
  }
}
```

### workstream_spawn

A finish-all lead starts a child workstream for one item with a value source.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `serves` | string | yes |  |
| `template` | string | no | The prefixes `bug:`/`fix:`, `research:` and `finish:` pick bugfix, research and finish-all. One of `bugfix`, `feature`, `research`, `finish-all`. |
| `text` | string | yes | At most 4000 characters. |

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "workstream_spawn",
  "arguments": {
    "serves": "issue:#88",
    "text": "Fix the flaky upload test"
  }
}
```

### inventory

The project's open work, ranked.

No parameters.

**Who may call:** a lead, checked by the hub. **Needs a human:** no.

```json
{
  "name": "inventory",
  "arguments": {}
}
```

## Task tools

Every task's agent gets these: implementers, readers, reviewers, verifiers and QA.

| Tool | What it does | Needs a human |
|---|---|---|
| [`report`](#report) | A reviewer records its verdict once, before its final message: the full SHA it reviewed, the number of blocking and non-blocking findings and a one-paragraph summary. | No |
| [`ask_lead`](#ask_lead) | Ask your lead a question. | No |
| [`claim_done`](#claim_done-task) | Claim your workstream done: fleetd runs its done-when checks itself. | No |

### report

A reviewer records its verdict once, before its final message: the full SHA it reviewed, the number of blocking and non-blocking findings and a one-paragraph summary. A writer reports each slice whose PR is complete with kind slice_ready and its prUrl: its review starts at once while you go on with the next slice.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `blocking` | integer | no |  |
| `kind` | string | no | Verdict (the default) for a review, slice_ready for a writer's PR that is ready. One of `verdict`, `slice_ready`. |
| `metricValues` | object | no | A research workstream's judge reports its metric for the baseline and the candidate; the hub computes the verdict. |
| `metricValues.baseline` | number | yes |  |
| `metricValues.candidate` | number | yes |  |
| `nonBlocking` | integer | no |  |
| `prHeadSha` | string | no | Full lowercase hex commit SHA, 40 or 64 characters. |
| `prUrl` | string | no | Like `https://github.com/<owner>/<name>/pull/<n>`. |
| `summary` | string | no | At most 1000 characters. |
| `taskId` | string | no | `T<n>`, e.g. `T1`. |

**Who may call:** a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "report",
  "arguments": {
    "blocking": 0,
    "nonBlocking": 2,
    "prHeadSha": "3f2a9c0d41b7e85a6c2f19d0e4b3a7c8d5e6f102",
    "summary": "The limiter is correct. Two nits: a magic number and a missing test for the reset.",
    "taskId": "T8"
  }
}
```

### ask_lead

Ask your lead a question. Carry on with what you can; the answer arrives as a message. If you can't go on without it, end your turn: the answer continues this thread.

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

### claim_done (task)

Claim your workstream done: fleetd runs its done-when checks itself.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `closeOver` | string | no | At most 300 characters. |
| `workstreamId` | string | yes | `W<n>`, e.g. `W1`. |

**Who may call:** a lead, a task's agent, checked by the hub. **Needs a human:** no.

```json
{
  "name": "claim_done",
  "arguments": {
    "workstreamId": "W3"
  }
}
```

## Claude Code tools

The same for every session. The retro gets none. Listed for Claude Code 2.1.302, the version fleetd is tested with.

**Allowed:** `Bash`, `DesignSync`, `Edit`, `NotebookEdit`, `Read`, `ReportFindings`, `Skill`, `ToolSearch`, `WebFetch`, `WebSearch`, `Write`.

A project's policy file can deny more with `tools.deny`. In a run started approval-required, Claude Code asks before it uses a tool and the question comes to you; `tools.allow` answers it ahead of time.

**Blocked**, in `--disallowedTools` and in the `permissions.deny` of fleetd's settings, so your own settings can't turn them back on:

| Tool | Why |
|---|---|
| `Task`, `Agent` | fleetd manages agents (spawn_agent). Task and Agent are one tool: init lists Task, the model sees Agent, and denying either removes both. |
| `Workflow`, `ListAgents`, `SendMessage`, `TaskStop`, `TaskOutput`, `TeamCreate`, `TeamDelete` | fleetd manages agents. Every agent is a fleetd task with its own session, slot, worktree, lane, steering and receipts, started with spawn_agent. |
| `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` | Nobody sits at a terminal to answer it, so the run would stall. Agents use ask or ask_lead. |
| `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup` | fleetd schedules work (tasks, wakes), never inside one claude process the node may restart. |
| `EnterWorktree`, `ExitWorktree` | fleetd owns worktrees, one per writer. A session that moves its own folder can't be resumed. |

fleetd also blocks any tool like these that a newer Claude Code adds: it reads the installed claude's tool list when it checks the machine, and a session that still offers one fails the check.

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
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1`, and `autoMemoryEnabled: false` | Every claude fleetd starts | yes | fleetd owns an agent's context (briefs, decisions, instructions). Notes claude keeps per folder would carry stale, unreviewed text from one agent's worktree to the next. A project opts back in with claude.autoMemory: true in its policy file. |
| `DISABLE_AUTOUPDATER` | `1` | Sessions | yes | Keeps the claude fleetd checked. An update mid-run would swap the binary under a live session. |
| `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` | `1` | Sessions | no | A refusal at startup arrives as a result fleetd can read, not only as stderr. |
| `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` | removed | Sessions | no | claude sets it for its own children and treats a process that has it as nested inside another session. |

## What your own setup adds

fleetd starts sessions with your own Claude Code setup underneath. The retro is the exception: it runs in safe mode with none of it (see [Roles](#roles)).

| Your setup | In a session |
|---|---|
| MCP servers (user, project, local) | Loaded. fleetd adds its `fleetd` server next to them. |
| Skills, plugins, hooks, `CLAUDE.md` | Loaded as in your own `claude`. |
| Allow and deny rules | Applied. fleetd's blocked tools stay blocked: its settings outrank yours. |
| Your own agents (`~/.claude/agents`) | Listed, but nothing can start them: the Agent tool is blocked. |
| Env in your settings | Applied, except the switches above, which fleetd sets last. |

A project's policy file can add rules for its sessions: `tools.allow` and `tools.deny` (Claude Code rule syntax), and `claude.autoMemory: true`.

### See it in a session

| Where | What you see |
|---|---|
| App: an order, then **Show full prompt** on an agent's lane | "What T1 was told": the exact first message, which prompt versions it used and the tools it never gets. |
| CLI on the hub machine: `fleetd prompts show --session <machine>/<thread>` | The first message alone. |
| MCP client: `session_prompt_get` | The same as the app. |
| `claude mcp list` in the project's folder | Your own MCP servers, which the session loads too. |
