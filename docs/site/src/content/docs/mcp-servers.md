---
title: Custom MCP servers
description: Give agents more tools by adding any MCP server, by URL or as a command on their machine.
---

Add an MCP server to give agents more tools: a database, your docs search, an internal API.

Servers live in **Connections**, the plain icon at the foot of the sidebar. On the phone: **Settings › Connections**.
Paper, Notion and Tailscale have their own rows: see [Connections](/docs/connections).

## Add a server {#add}

1. In Connections, press **+** next to **Custom MCP** (or **Add a custom MCP** when there are none).
2. Pick **URL** for a server over HTTP, or **Command** for a program the agent's machine runs.
3. Enter the URL or the command, such as `acme-mcp --read-only`.
4. Check the name. Agents see its tools as `mcp__<name>__<tool>`.
5. Add any **Headers** (for a URL) or **Environment** variables (for a command). Pick each value from the
   [vault](/docs/vault).
6. Under **Bots**, pick every bot or the ones that use it.
7. Press **Add and test**.

The test lists the server's tools, or says why it failed. A URL that asks you to sign in opens its
[sign-in](/docs/connections#sign-in) first.

For an `Authorization` header, fleetd adds `Bearer` before the value. Pick **No prefix** to send it as is.

Owners and admins can add commands, headers, and servers that need no sign-in. Anyone can add a server that signs in.

## Change, test or remove {#manage}

Each server's row has a menu:

- **Test**: starts the server as an agent would, and lists its tools within 30 seconds.
- **Edit**: change its settings. Saved secrets stay unless you pick another vault item.
- **Bots**: change which bots use it.
- **Disconnect**: remove it, and erase its secrets from every machine.

A bot's own server replaces a workspace-wide server of the same name in that bot. Use this to turn a workspace-wide
server off for one bot.

## When changes reach agents {#takes-effect}

- New agents get the change at once.
- A running lead gets it at its next turn. The chat says once when a server is connected.
- A running agent gets it the next time its session starts.

A server that doesn't answer within 3 seconds is left out of that start, and the chat says so once. Each start tries
again.

Agents on Google Antigravity reach every server too, through a search for the tools they need. See
[Models](/docs/models#gemini).

## Secrets {#secrets}

Header and variable values come from the vault. The workspace seals them for each machine and never stores them in the
clear. A secret is never shown again after you save it.

If an agent prints a secret, fleetd masks it before the output leaves the machine.

A machine that's offline when you save a workspace-wide server with secrets doesn't get them. The row lists such machines: save
the server again once they're back.

## Servers on your tailnet {#tailnet}

A URL on your tailnet (a `.ts.net` name or a `100.x` address) works through the **Tailscale** row in Connections, with
nothing else to set. Its test says **through Tailscale**. If Tailscale isn't connected yet, the form offers
**Connect Tailscale** to an admin.

## Servers from your own setup {#your-own}

Agents also get the MCP servers from their machine's own Claude Code setup (`~/.claude.json`, or a repo's
`.mcp.json`). fleetd's own tools are always there and can't be replaced.

## From an MCP client {#tools}

An [MCP client](/docs/mcp-clients) manages servers with `mcp_servers_get`, `mcp_server_set`, `mcp_server_remove` and
`mcp_server_test`. All but the first need a human key.
