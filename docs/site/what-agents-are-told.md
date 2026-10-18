---
title: What agents are told
section: Using fleetd
order: 65
description: Every prompt fleetd sends a model, how to read, edit, reset and diff it, your own instructions, and what a running agent keeps.
---

Every word fleetd sends a model is listed on this page and in `fleetd prompts list`, and you can edit each one. A
session keeps the text it started with.

## How a session gets its instructions

There is no hidden system prompt. fleetd's instructions are the first message of a session (lead, task, reviewer,
judge), later messages into it (wakes, review findings, train news, nudges), or the input of a one-shot `claude -p`
with no tools (the router, the retro). Your own claude setup applies as usual underneath
([Config & files](config-and-files.md)). [Every prompt](#prompts) is listed at the end of this page.

## Safety rules: code or prompt {#safety}

Most rules don't depend on the prompt. fleetd enforces them in code whatever the text says: secrets are sealed to a
machine, gated commands wait for your tap, only the train merges, and done is decided by the hub running the checks.
Editing those words away only means agents hit refusals they weren't warned about.

Some rules live only in the prompt, marked "prompt only" in the table below: the lead never writes code, reviewers
don't read the PR description, a lead doesn't re-ask a decided question and asks you only about product, money,
credentials or something irreversible. Remove one and nothing else stops it.

## Edit a prompt

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

```sh
fleetd instructions edit
fleetd instructions edit --project builder-1/app
fleetd instructions show
```

They are added to every lead's first message and every task brief (writers, reviewers and judges), global first, under
"Custom instructions from the human". Not to the router, the retro or wakes.

## When fleetd changes a default you edited

Your version stays in use, and `fleetd prompts list` marks the prompt `update`. Then `fleetd prompts diff <id>` shows
what fleetd changed and what you changed since you edited it, and `edit` opens both merged. Save it, or reset. A
safety rule the new default added and your text lacks shows as a warning.

Playbooks are the exception: an edited playbook gets no notice when fleetd's version changes. After an update,
compare it with `fleetd prompts diff playbook.<name>`.

## What a running agent keeps {#pinning}

Each session keeps the exact prompt versions it started with, wakes included. An edit reaches new sessions at once: a
task at its next attempt, a lead at its next start. To give a running lead your edit now, restart it with
`lead_restart` from an MCP client ([Its lead](projects-and-orders.md#its-lead)).

## See exactly what an agent was told {#told}

```sh
fleetd prompts show --session <machine>/<thread>
```

prints the exact first message a session was sent; `session_prompt_get` from an MCP client also returns which version
of each prompt it used and the tools it may not use. Later messages are in the lead's conversation in the app.

## Not editable: tool descriptions and CLI replies

MCP tool descriptions and what the lead-side CLI prints back (each `next:` and `fix:`) are the other half of a
protocol with code: a description must match its tool, a `next:` must name a real command. See the
[CLI reference](cli.md) and the [order tools](projects-and-orders.md#tools).

## Every prompt {#prompts}

Generated from the registry in the binary this site was built with. `fleetd prompts show <id>` prints one.

{{prompt-table}}
