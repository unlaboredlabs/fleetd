---
title: MCP clients
description: Connect Claude Code or another MCP client to the workspace, to read and write to your bots from there.
---

Connect Claude Code, or any MCP client, to your workspace, so it can read your bots' chats and status and write to their
leads.

## Connect Claude Code {#claude-code}

1. On the workspace machine, create a key and save it to a file only you can read:

   ```sh
   fleetd workspace key create --name laptop --role operate --machines '*' --out ~/.fleetd/agent.key
   ```

2. Copy the file to the computer that runs Claude Code, keeping it private:

   ```sh
   (umask 077; mkdir -p ~/.fleetd; ssh workspace 'cat ~/.fleetd/agent.key' > ~/.fleetd/agent.key)
   ```

   `workspace` is the workspace machine's SSH name.

3. Add the workspace to Claude Code. Use your workspace's address, followed by `/mcp`:

   ```sh
   claude mcp add --transport http fleetd http://fleetd.your-tailnet.ts.net:4790/mcp \
     --header "Authorization: Bearer $(cat ~/.fleetd/agent.key)"
   ```

4. Ask Claude Code how a bot is doing.

Don't add it with `--scope project`. That writes the key into the repo's `.mcp.json`, where it could be committed.

## Keys and roles {#roles}

Each key has a role:

- `read`: read chats, status and prompts.
- `operate`: also write to leads and manage bots.
- `admin`: also change workspace settings.

`--machines '*'` gives the role on every machine. `--machines devbox,laptop` limits it.

Manage keys on the workspace machine:

```sh
fleetd workspace key list
fleetd workspace key revoke <keyId>     # ends it at once
```

### Human keys {#human-key}

A human key speaks as you. Create one with `--human`:

```sh
fleetd workspace key create --human --name terminal --out ~/.fleetd/human.key
```

- With a human key, messages to a lead count as yours.
- With any other key, they count as an agent's. The lead treats them as input, never as your answer or approval.
- Stopping a bot, answering an approval or entering a secret needs a human key.

Don't give Claude Code a human key: it could then approve things as you.

## Claim work before you start it {#work}

fleetd keeps a list of the work in flight on each repo: its agents, PRs on the merge train, and what people have
claimed. Checking it first stops you building what an agent is already building.

Connected Claude Code does this by itself. Before a change, it claims the work, and tells you if an agent already has
it:

```text
> add a dark mode toggle to settings
● fleetd's agent is already building a dark mode toggle for settings. Shall I wait for its PR, or is this
  different work?
```

From a terminal, run `fleetd work` in your checkout:

```sh
export FLEETD_KEY_FILE=~/.fleetd/agent.key
fleetd work claim "dark mode toggle in settings"   # exits 1 if it's taken
fleetd work                                        # what's in flight here
fleetd work done                                   # your change landed
```

It works with any git host. A claim lasts 12 hours after you last renew it.

## From a script {#script}

The workspace speaks MCP over HTTP. A call first opens a session, then calls a tool. Save this as `mcp.sh`:

```sh
#!/bin/sh
# mcp.sh <tool> '<json arguments>'
URL=${FLEETD_URL:-http://fleetd.your-tailnet.ts.net:4790}/mcp
AUTH="Authorization: Bearer $(cat "$FLEETD_KEY_FILE")"
post() { curl -s "$URL" -H "$AUTH" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "$@"; }
SID=$(post -D - -o /dev/null -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"script","version":"1"}}}' | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
post -H "Mcp-Session-Id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
post -H "Mcp-Session-Id: $SID" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}"
```

Then call a tool:

```sh
FLEETD_KEY_FILE=~/.fleetd/agent.key sh mcp.sh status_get '{}'
```

## Common tools {#tools}

- `status_get`: one line per bot, with its state and running agents.
- `chat_history`, `chat_find`: read or search a bot's chat.
- `chat_send`: write to a bot's lead.
- `agents_list`: every agent, what it's doing and its PR.
- `pr_list`, `pr_get`: a bot's PRs, with checks and reviews.
- `approval_answer`, `secret_submit`: answer a request (human key only).
- `project_stop`: stop all of a bot's agents (human key only).

Most tools take a `projectRef`, such as `{"machineId": "devbox", "projectId": "<id>"}`. `fleetd project list` prints
both parts.

Every tool, with its inputs: [Agent tools](/docs/reference/agent-tools).
