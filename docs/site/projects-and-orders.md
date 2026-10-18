---
title: Projects & orders
section: Using fleetd
order: 50
description: Add a project, send an order, follow it, and see how "done" is checked.
---

## Add a project

Run `fleetd init` again and pick a repo: a checkout it finds on a worker, or a GitHub URL, which it clones. The rest
of your setup stays as it is.

From an MCP client, `project_add {machineId, path, title}` adds one and `project_remove {machineId, projectId}`
forgets it (its files, branches and worktrees stay).

## Its lead

Each project has one lead, and the project's first order starts it: there is nothing to start by hand. The lead's
first message lists the order, and the app shows the lead starting.

If the lead can't start, because `claude` on the worker is logged out or outside the supported version range, or the
worker is offline, the order waits. The app's reply says why and what to run on the worker. Once the worker comes back
online with a usable `claude`, its lead starts and picks up every waiting order.

To choose the lead's model and effort, or to start it before any order, call `lead_start {machineId, projectId, model,
effort}` from an MCP client; the model and effort are saved for the project (default `claude-opus-5-5`, high). To keep
a project's lead from starting by itself, set `lead.autoStart: false` in its [policy file](config-and-files.md#policy):
orders then wait until `lead_start`, and the reply says so.

## Connect an MCP client

The hub's MCP endpoint is `<hub url>/mcp`. Give the client an agent key, shown once:

```console
$ fleetd hub key create --name ci-bot --role operate --machines '*'
fld_<key>
created key_tjw34bxe (fld_mwrgw4, operate:*). The key above is shown only once.
```

For Claude Code:

```sh
claude mcp add --transport http fleetd http://hub.your-tailnet.ts.net:4790/mcp --header "Authorization: Bearer fld_<key>"
```

Roles are `read`, `operate` and `admin`, on every machine (`'*'`) or a list. `fleetd hub key list` shows keys and
`fleetd hub key revoke <keyId>` ends one at once.

## Send an order

In the app, type one line in the board's composer and press Enter ([Give work](desktop-app.md#composer)). Pick the
project, or leave it to the hub, which reads a leading `@project`, else asks a quick router, else asks you. A prefix
picks the playbook: `fix:` or `bug:`, `research:`, `finish:`. Attach screenshots or files, or `@`-mention files,
orders and PRs; the lead gets them with the order.

From an MCP client: `intake_submit {text}`; `intake_preview {text}` says where it would go without sending it.

## Follow it

The lead freezes a brief, runs writer and reviewer tasks on your workers, and puts each PR on the merge train. The
board shows every order's phase and live agents; open one for its PRs, checks and the lead's conversation
([Follow an order](desktop-app.md#order)).

## Add to it, steer it, stop it

In the order, Enter adds a note the lead reads at its next wake; ⌘Enter (Ctrl+Enter) or "Steer now" wakes it now.
Stop cancels the order's running and queued agents and withdraws its asks; merged PRs stay. A stopped order stays
stopped: send it again as a new order.

## Answer its questions

Questions land in the inbox (⌘I), numbered. Reply in one line, such as `1 go 2 nvm 3 b`: see
[the reply grammar](desktop-app.md#reply). Commands and secrets have their own flow:
[Approvals & secrets](approvals-and-secrets.md).

## Done, checked

The lead reports done with `fleetd claim done`. The hub then runs the brief's done-when checks itself, and only all of
them passing makes the workstream done. A failure wakes the lead with the exit code and output. `claims_list` shows
every claim with its evidence.

A done order cleans up after itself: its PRs still waiting (queued, in review, ready, needing a rebase, or with failed
CI) are closed on GitHub with a comment saying why, and its leftover tasks are cancelled. A PR the train is already
rebasing, checking or merging is left to land.

## MCP tools for orders {#tools}

| Tool | Does | Role |
|---|---|---|
| `intake_submit {text}` | send an order (optional `attachments`, `refs`) | operate |
| `intake_preview {text}` | where it would go, without sending | operate |
| `attachment_put {name, mime, dataB64}` | upload a file (image, text or PDF, at most 5 MiB) for an order or note | operate |
| `project_files {machineId, projectId, query}` | a project's files for `@`-mentions | read |
| `orders_board {projectRef?}` | open orders with their phase, agents, PRs, asks and the trains | read |
| `order_get {workstreamId}` | one order, plus its lead, finished agents and claims | read |
| `order_note {workstreamId, text, urgent?}` | add to an order; `urgent` wakes the lead now | operate, human key |
| `order_stop {workstreamId}` | stop an order | operate, human key |
| `workstream_list`, `workstream_get`, `thread_tail`, `fleetd_status` | the lower-level views | read |

`events_wait` long-polls for changes instead of polling. A human key is a person's paired device, not an agent key.
