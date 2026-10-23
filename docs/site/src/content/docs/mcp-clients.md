---
title: MCP clients
description: Connect Claude Code or another MCP client to the hub, and the tools it can use to chat with leads.
---

You'll connect an MCP client, such as Claude Code on your laptop, to the hub so it can chat with project leads.

## Connect Claude Code {#claude-code}

1. On the hub, create an [agent key](/docs/glossary#agent-key) and keep it in a file only you can read:

   ```sh
   (umask 077; fleetd hub key create --name laptop --role operate --machines '*' > ~/.fleetd/agent.key)
   ```

   The key is printed once, so this file is the only copy. The command also prints a line like this:

   ```text
   created key_tjw34bxe (fld_mwrgw4, operate:*). The key above is shown only once.
   ```

2. Copy the key to the machine that runs Claude Code, readable only by you. For example, from that machine:

   ```sh
   (umask 077; ssh hub 'cat ~/.fleetd/agent.key' > ~/.fleetd/agent.key)
   ```

   `hub` is the hub machine's SSH name. Create `~/.fleetd` first if this machine has no fleetd.

3. Add the hub's MCP endpoint, `<hub url>/mcp`, to Claude Code:

   ```sh
   claude mcp add --transport http fleetd http://hub.your-tailnet.ts.net:4790/mcp \
     --header "Authorization: Bearer $(cat ~/.fleetd/agent.key)"
   ```

4. In Claude Code, ask it how a project is doing. It reads the chat with `chat_history` and the status with
   `fleetd_status`.

:::note[Writing to a lead]
`chat_send` takes only a [human key](/docs/glossary#human-key), because the lead reads the message as yours. To let
Claude Code write to leads for you, create the key with `--human` in step 1:
`fleetd hub key create --human --name laptop`.
:::

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
URL=${FLEETD_HUB:-http://hub.your-tailnet.ts.net:4790}/mcp
AUTH="Authorization: Bearer $(cat "$FLEETD_KEY_FILE")"
post() { curl -s "$URL" -H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "$@"; }
SID=$(post -D - -o /dev/null -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"script","version":"1"}}}' | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
post -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
post -H "Mcp-Session-Id: $SID" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}"
```

Then call a tool:

```sh
FLEETD_HUB=http://hub.your-tailnet.ts.net:4790 FLEETD_KEY_FILE=~/.fleetd/agent.key sh mcp.sh status_projects '{}'
```

On a new hub with no projects yet, the output starts like this:

```text
{"id":1,"jsonrpc":"2.0","result":{"content":[{"text":"{\"next\":\"status_get with a project scope for the detail behind a row\",\"rows\":[]}", …
```

## Use a key from the CLI {#key-file}

| Command | Needs |
|---|---|
| `fleetd status`, `fleetd time` | Nothing on the hub machine. Elsewhere, `--hub <url> --key-file <file>`. |
| `fleetd steer`, `fleetd steers` | Always `--key-file` with a [human key](/docs/glossary#human-key). `--hub <url>` off the hub machine. |
| `fleetd retro` | Always `--hub <url>` and `--key-file <file>`. |

To make a human key file on the hub:

```sh
(umask 077; fleetd hub key create --human --name terminal > ~/.fleetd/human.key)
fleetd steers --key-file ~/.fleetd/human.key
```

## Roles

| Role | Can |
|---|---|
| `read` | Read chats, status, time and prompts. |
| `operate` | Also write to leads, set a project's max agents, and manage projects. |
| `admin` | Also change hub settings, such as timeline retention and GitHub webhooks. |

`--machines '*'` gives the role on every machine; `--machines devbox,laptop` limits it to those.

| Command | Does |
|---|---|
| `fleetd hub key list` | Lists keys. |
| `fleetd hub key revoke <keyId>` | Ends a key at once, also on a running hub. |

A [human key](/docs/glossary#human-key) (`fleetd hub key create --human`) is for a person's device. Some tools, such
as stopping a project, answering an approval or entering a secret, need one.

## Tools for the chat {#tools}

| Tool | Does | Role |
|---|---|---|
| `chat_send {projectRef, text, attachments?, clientRequestId}` | Write to a project's lead. It starts a turn when the lead is idle, steers it when it works, or waits while it starts. The lead reads it as your words. | operate, human key |
| `chat_history {projectRef, before?, after?, limit?}` | A page of a project's chat, oldest first; up to 100 messages. Without `before` or `after`, the newest. | read |
| `approval_answer {requestId, decision, message?}` | Approve or deny an approval item: `decision` is `approve` or `deny`; `message` is a denial's reason for the lead. | operate, human key |
| `secret_submit {requestId, sealed}` | Answer a secret item with a value sealed to the target machine. | operate, human key |
| `requests_list {projectRef?, state?}` | Secret and approval requests, newest first, with their state. A secret's value is never in it, only its fingerprint. | read |
| `project_stop {projectRef, reason?}` | Stop every running and queued agent of the project and tell the lead in its chat. Merged PRs, the lead and the chat stay. | operate, human key |
| `attachment_put {name, mime, dataB64}` | Upload a file (image, text or PDF, at most 5 MiB) for a message. | operate |
| `attachment_get {projectRef, attachmentId}` | Read a file attached to a project's chat. | read |
| `project_files {machineId, projectId, query}` | A project's files, for `@`-mentions. | read |
| `status_projects` | One row per project: its state word, verified and in-flight progress, agents running and the last merge. | read |
| `agents_list {projectRef?, endedSince?}` | Every agent of your projects: its role, task, what it's doing now, when it started and its PR. | read |
| `agent_work {machineId, threadId, before?, limit?}` | A page of one agent's recent messages, commands and edits, oldest first. Secrets show as `[secret]`. | read |
| `pr_list {projectRef, closedSince?}`, `pr_get {repo, number}` | A project's PRs, and one in detail: description, checks, reviews with their findings, its place in the merge queue and the agent that wrote it. | read |
| `pr_files {repo, number, offset?}`, `pr_diff {repo, number, path, offset?}` | A PR's changed files, and one file's diff a page at a time. | read |
| `workstream_list`, `workstream_get`, `thread_tail`, `fleetd_status` | Lower-level views of the lead's work. | read |

`projectRef` is `{"machineId": "devbox", "projectId": "<id>"}`; `fleetd project list` prints both, as
`<machineId>/<projectId>`.

`intake_submit` and the `order_*` tools are gone; for one release they answer with an error that points to
`chat_send`.

`clientRequestId` is any unique string you choose per request. Sending the same one again returns the same message
instead of a second one. `events_wait` waits for changes, so a client doesn't need to poll: a new message is a
`chat.message` event.

Tools for projects: `project_discover`, `project_inspect`, `project_add {path | url}` and `project_remove`. A clone
answers with an `addId`, then sends `project.clone_progress` events, then `project.added` or `project.add_failed`.

Every tool, generated from the code: [Agent tools](/docs/reference/agent-tools).
