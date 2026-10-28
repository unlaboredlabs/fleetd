---
title: MCP servers
description: Give agents more tools, globally or per project, from a command on their machine or a service over HTTP.
---

You can give fleetd's agents more tools through MCP servers: a GitHub or database server, your docs search, an internal
API. Configure them in the desktop app, for every project or for one, and pick which agents get each.

A Navi's Notion, and servers whose tools should ask before they write, are connected under
its [Integrations](/docs/integrations) instead.

## Add a server {#add}

Global servers are in Settings › **Hub** › **Every project** › **Tools & skills**, for the hub's owners and admins only; a
project's own are in Settings › the project › **Agents** › **MCP servers**. Click **Add server**, then fill in:

| Field | Is |
|---|---|
| Name | How agents see its tools: `mcp__<name>__<tool>`. Letters, digits, `_` and `-`. `fleetd` is taken by fleetd's own tools. |
| How agents reach it | **Command**: a program each agent's claude starts on its machine, speaking MCP over stdin and stdout, with its arguments one per line and its environment. **HTTP** (MCP's streamable HTTP) or **SSE** (its older event-stream transport): a URL, with headers. |
| Environment or headers | Each value plain or secret. See [Secrets](#secrets). |
| Who gets it | **Lead**, **Writers** (write tasks' agents), **Reviewers** (review and read tasks' agents). A thread you start yourself gets none. |
| On | Off keeps it saved but gives it to no one. |

A project's server replaces a global one of the same name in that project, for every role, even while the project's
is off: that's how to turn a global server off for one project.

A command server starts in the agent's working directory with the agent's environment, the
[project's variables](/docs/projects#env) included, plus its own environment.

A Navi with a Google account connected also gets fleetd's own `google` server, for its lead only: see
[Google for Navi](/docs/google). It replaces a server of the same name in that Navi.

## When a change takes effect {#takes-effect}

An agent started after you save gets the change. An agent already running keeps the servers its claude started with;
fleetd hands it the change with its next message, and it takes effect the next time that agent's process starts (after
it was idle, stopped or the node restarted). Removing a server works the same way.

## Secrets {#secrets}

Mark a value **Secret** for a token, a password or an `Authorization` header. It is sealed in the app to each machine's
key, as a [project's secret variables](/docs/projects#env) are: a project server's to its machine, a global one's to
every machine. The hub passes the sealed values on to the nodes without storing or logging them, and keeps only each
node's fingerprint of the value. The node keeps them in `~/.fleetd/node/mcp-secrets/` (mode `0600`) and puts them into
the MCP config it writes for each agent's claude (also `0600`). If an agent prints one, the node masks it as
`***<server>.<NAME>***` before the output leaves the machine, as it masks a project's secrets.

A secret is never shown again. Editing a server keeps a saved secret you leave blank; type a value to replace it.

:::caution
A machine that is offline when you save a global server with secrets doesn't get them, and its agents go without
that server. The list says which machines lack its secrets: save the server again once they are online.
:::

## Test connection {#test}

**Test connection** has the node start the server (or connect to it), with its secrets, exactly as an agent's claude
would, and list its tools within 30 seconds. A project's server is tested on its machine in the project's checkout; a
global one on the first machine online. On failure it says why: a command that isn't on the machine's `PATH`, the
command's error output (secrets masked), an HTTP status such as 401 when a header is wrong, or no answer in time.

## Your own MCP servers {#your-own}

Agents also get the MCP servers of your own claude setup (`~/.claude.json`, a repo's `.mcp.json`), as before. Turn
**Agents also get their own MCP servers** off in Settings › Hub › Every project › Tools & skills to give them only fleetd's tools and the servers
configured here: claude then runs with `--strict-mcp-config`. fleetd's own tools (`report`, `ask_lead`, the lead's
tools) are always there and can't be replaced.

## From an MCP client {#tools}

`mcp_servers_get` lists the servers, `mcp_server_set` adds or replaces one (each secret sealed to each machine's
`boxPubKey`), `mcp_server_remove` removes one, `mcp_settings_set` turns your own servers on or off, and
`mcp_server_test` tests one. All but `mcp_servers_get` take a human key.
