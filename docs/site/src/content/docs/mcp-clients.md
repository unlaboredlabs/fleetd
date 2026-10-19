---
title: MCP clients
description: Connect Claude Code or another MCP client to the hub, and the tools it can use for orders.
---

You'll connect an MCP client, such as Claude Code on your laptop, to the hub so it can send and follow orders.

## Connect Claude Code {#claude-code}

1. On the hub, create an [agent key](/docs/glossary#agent-key) and keep it in a file only you can read:

   ```sh
   (umask 077; fleetd hub key create --name laptop --role operate --machines '*' > ~/.fleetd/agent.key)
   ```

   The key is printed once, so this file is the only copy. The command also prints a line like this:

   ```text
   created key_tjw34bxe (fld_mwrgw4, operate:*). The key above is shown only once.
   ```

2. Add the hub's MCP endpoint, `<hub url>/mcp`, to Claude Code:

   ```sh
   claude mcp add --transport http fleetd http://hub.your-tailnet.ts.net:4790/mcp \
     --header "Authorization: Bearer $(cat ~/.fleetd/agent.key)"
   ```

3. In Claude Code, ask it to send an order. It calls `intake_submit`.

`claude mcp add` writes to your Claude config. `--scope` picks where:

| Scope | Where it applies | Note |
|---|---|---|
| `local` (default) | This folder, only for you. | |
| `project` | Everyone who opens this repo: written to `.mcp.json`. | Don't use with a key in `--header`: you'd commit the key. |
| `user` | All your folders. | |

## From a script {#script}

The endpoint speaks MCP over HTTP. A call needs a session: `initialize`, then `tools/call` with the session id. This
script does both. Save it as `mcp.sh`:

```sh
#!/bin/sh
# mcp.sh <tool> '<json arguments>'
URL=${FLEETD_HUB:-http://127.0.0.1:4790}/mcp
AUTH="Authorization: Bearer $(cat "$FLEETD_KEY_FILE")"
post() { curl -s "$URL" -H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "$@"; }
SID=$(post -D - -o /dev/null -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"script","version":"1"}}}' | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
post -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
post -H "Mcp-Session-Id: $SID" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}"
```

Then call a tool:

```sh
FLEETD_HUB=http://127.0.0.1:4790 FLEETD_KEY_FILE=~/.fleetd/agent.key sh mcp.sh orders_board '{}'
```

Expected output starts like this:

```text
{"id":1,"jsonrpc":"2.0","result":{"content":[{"text":"{\"at\":\"2026-10-19T12:40:58.878Z\",\"next\":\"Open one with order_get; …
```

## Use a key from the CLI {#key-file}

`fleetd status`, `time`, `answer`, `steer` and `steers` take a key file with `--key-file`, and a hub with `--hub`. On
the hub machine they need neither. `answer` and `steer` need a [human key](/docs/glossary#human-key):

```sh
(umask 077; fleetd hub key create --human --name terminal > ~/.fleetd/human.key)
fleetd answer --key-file ~/.fleetd/human.key
```

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
| `intake_submit {text, clientRequestId}` | Send an order (optional `attachments`, `refs`). | operate |
| `intake_preview {text}` | Say where an order would go, without sending it. | operate |
| `attachment_put {name, mime, dataB64}` | Upload a file (image, text or PDF, at most 5 MiB) for an order or note. | operate |
| `project_files {machineId, projectId, query}` | A project's files, for `@`-mentions. | read |
| `orders_board {projectRef?}` | Open orders with their phase, agents, PRs, asks and trains. | read |
| `order_get {workstreamId}` | One order, with its lead, finished agents and claims. | read |
| `order_note {workstreamId, text, urgent?, clientRequestId}` | Add to an order; `urgent` wakes the lead now. | operate, human key |
| `order_stop {workstreamId}` | Stop an order. | operate, human key |
| `workstream_list`, `workstream_get`, `thread_tail`, `fleetd_status` | Lower-level views. | read |

`clientRequestId` is any unique string you choose per request. Retrying with the same one doesn't send the order or
note twice. `events_wait` waits for changes, so a client doesn't need to poll.

Tools for projects: `project_discover`, `project_inspect`, `project_add {path | url}` and `project_remove`. A clone
answers with an `addId`, then sends `project.clone_progress` events, then `project.added` or `project.add_failed`.

Every tool, generated from the code: [Agent tools](/docs/reference/agent-tools).
