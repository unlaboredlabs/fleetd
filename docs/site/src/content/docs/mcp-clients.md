---
title: MCP clients
description: Connect Claude Code or another MCP client to the hub, and the tools it can use for orders.
---

You'll connect an MCP client, such as Claude Code on your laptop, to the hub so it can send and follow orders.

## Connect Claude Code

1. On the hub, create an [agent key](/docs/glossary#agent-key):

   ```sh
   fleetd hub key create --name ci-bot --role operate --machines '*'
   ```

   Expected output:

   ```text
   fld_<key>
   created key_tjw34bxe (fld_mwrgw4, operate:*). The key above is shown only once.
   ```

2. Add the hub's MCP endpoint, `<hub url>/mcp`, to Claude Code:

   ```sh
   claude mcp add --transport http fleetd http://hub.your-tailnet.ts.net:4790/mcp --header "Authorization: Bearer fld_<key>"
   ```

3. In Claude Code, ask it to send an order. It calls `intake_submit`.

## Roles

| Role | Can |
|---|---|
| `read` | Read orders, status, time and prompts. |
| `operate` | Also send orders, add notes and manage projects. |
| `admin` | Also change hub settings, such as timeline retention and GitHub webhooks. |

`--machines '*'` gives the role on every machine; `--machines devbox,laptop` limits it to those.

| Command | Does |
|---|---|
| `fleetd hub key list` | Lists keys. |
| `fleetd hub key revoke <keyId>` | Ends a key at once, also on a running hub. |

A [human key](/docs/glossary#human-key) (`fleetd hub key create --human`) is for a person's device. Some tools, such
as stopping an order or steering, need one.

## Tools for orders {#tools}

| Tool | Does | Role |
|---|---|---|
| `intake_submit {text}` | Send an order (optional `attachments`, `refs`). | operate |
| `intake_preview {text}` | Say where an order would go, without sending it. | operate |
| `attachment_put {name, mime, dataB64}` | Upload a file (image, text or PDF, at most 5 MiB) for an order or note. | operate |
| `project_files {machineId, projectId, query}` | A project's files, for `@`-mentions. | read |
| `orders_board {projectRef?}` | Open orders with their phase, agents, PRs, asks and trains. | read |
| `order_get {workstreamId}` | One order, with its lead, finished agents and claims. | read |
| `order_note {workstreamId, text, urgent?}` | Add to an order; `urgent` wakes the lead now. | operate, human key |
| `order_stop {workstreamId}` | Stop an order. | operate, human key |
| `workstream_list`, `workstream_get`, `thread_tail`, `fleetd_status` | Lower-level views. | read |

`events_wait` waits for changes, so a client doesn't need to poll.

Tools for projects: `project_discover`, `project_inspect`, `project_add {path | url}` and `project_remove`. A clone
answers with an `addId`, then sends `project.clone_progress` events, then `project.added` or `project.add_failed`.

Every tool, generated from the code: [Agent tools](/docs/reference/agent-tools).
