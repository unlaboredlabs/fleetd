---
title: What agents are told
section: Using fleetd
order: 65
description: Every prompt fleetd sends a model, how to read, edit, reset and diff it, your own instructions, and what a running agent keeps.
---

Every word fleetd sends a model is listed here, readable in the app and the CLI, and editable. A session keeps the
text it started with.

## How a session gets its instructions

There is no hidden system prompt. fleetd's instructions are the first message of a session (lead, task, reviewer,
judge), later messages into it (wakes, review findings, train news, nudges), or the input of a one-shot `claude -p`
with no tools (the router, the retro). Your own claude setup applies as usual underneath
([Config & files](config-and-files.md)).

## The prompts {#prompts}

Grouped as in Settings → Prompts.

| Group | Ids | Sent |
|---|---|---|
| Lead | `lead.start`, `lead.digest` | at lead start and every restart; the digest also tops every wake |
| Tasks | `task.brief.write`, `task.brief.read`, `task.brief.review`, `task.review_findings`, `task.train_rebase`, `task.train_ci_failed` | at each task attempt, then into it |
| Reviews and checks | `review.reviewer`, `review.verifier`, `judge`, `judge.research` | per PR head by review tier; per `judge` done-when check |
| Wakes and messages | `wake.*`, `digest.*`, `watchdog.nudge`, `usage.continue`, `permission.denied.*` | into a running session: one line per event, a stalled run, a usage reset, a refused tool call |
| One-shots | `router`, `router.retry`, `retro` | per order without a project; per retro run |
| Playbooks | `playbook.feature`, `playbook.bugfix`, `playbook.research`, `playbook.finish-all` | in the lead's digest while an order uses it |

`fleetd prompts list` prints them all with where each comes from; `fleetd prompts show <id>` prints one.

## Safety rules: code or prompt {#safety}

Most rules don't depend on the prompt. fleetd enforces them in code whatever the text says: secrets are sealed to a
machine, gated commands wait for your tap, only the train merges, and done is decided by the hub running the checks.
Editing those words away only means agents hit refusals they weren't warned about.

A few rules live only in the prompt: reviewers don't read the PR description, no subagents, the lead never writes
code, a lead doesn't re-ask a decided question, and it asks you only about product, money, credentials or something
irreversible. Remove one of these and nothing else stops it.

## Edit a prompt

In the app: Settings → Prompts. Pick Global or a project at the top, open a prompt, edit, Save. Reset to default and
Diff are next to Save. On the hub machine:

```sh
fleetd prompts edit lead.start
fleetd prompts edit task.brief.write --project builder-1/app
fleetd prompts diff lead.start
fleetd prompts reset lead.start
```

`edit` opens `$VISUAL` or `$EDITOR`, shows the warnings and asks before saving. A project's version beats the global
one, which beats fleetd's. Playbooks have only the global level. Your versions are files under
`~/.fleetd/hub/prompts/` ([Config & files](config-and-files.md)); a hand edit there is read at hub start.

Prompts fill in `{{name}}` placeholders, such as `{{project}}`; the editor lists each prompt's own. Nothing else is
template syntax.

### Warnings {#warnings}

Saving never refuses text that isn't empty, but it warns:

| Warning | Means |
|---|---|
| a required placeholder is missing | that value no longer reaches the agent (for `task.brief.write` without `{{serves}}`, the PR's `Source:` line) |
| unknown placeholder | `{{name}}` isn't one this prompt fills; it is sent as written |
| a safety rule is missing | its wording is gone; the warning says whether fleetd still enforces it in code or nothing does |
| too long | past the prompt's budget; the digest cuts long playbook lines |

## Your own instructions {#instructions}

Settings → Instructions, Global or per project, or:

```sh
fleetd instructions edit
fleetd instructions edit --project builder-1/app
```

They are added to every lead's first message and every task brief (writers, reviewers and judges), global first, under
"Custom instructions from the human". Not to the router, the retro or wakes.

## When fleetd changes a default you edited

Your version stays in use. The prompt gets an "update" chip in Settings → Prompts and an inbox item; `fleetd prompts
diff <id>` shows what changed in fleetd's text and in yours since you edited it, and `edit` opens a merge of both.
Save it, keep yours, or reset. A safety rule the new default added and your text lacks shows as a warning.

## What a running agent keeps {#pinning}

Each session keeps the exact prompt versions it started with, wakes included. An edit reaches new sessions at once: a
task at its next attempt, a lead at its next start. To give a running lead your edit now, restart it with
`lead_restart` from an MCP client ([Its lead](projects-and-orders.md#its-lead)).

## See exactly what an agent was told {#told}

In an order, a lane's menu or the lead's header has "Show full prompt": the exact first message, which versions it
used (default, edited globally, project), your instructions, and the tools it may not use. Or:

```sh
fleetd prompts show --session <machine>/<thread>
```

Later messages are in the lead's conversation.

## Not editable: tool descriptions and CLI replies

MCP tool descriptions and what the lead-side CLI prints back (each `next:` and `fix:`) are the other half of a
protocol with code: a description must match its tool, a `next:` must name a real command. They are listed in the
[CLI reference](cli.md) and the [MCP tools](projects-and-orders.md#tools), not editable.
