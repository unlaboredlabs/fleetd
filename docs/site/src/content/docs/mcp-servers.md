---
title: MCP servers
description: Give agents more tools, globally or per bot, from a command on their machine or a service over HTTP.
---

You can give fleetd's agents more tools through MCP servers: a GitHub or database server, your docs search, an internal
API. They live in **Connections**: the plain icon at the sidebar's foot, beside you (on the phone, Settings ›
**Connections**). It holds the few named services (Paper, Notion and [Tailscale](#tailnet)), then **Custom MCP**: every
other server, with where it stands and a menu with **Test**, **Edit**, **Bots** and **Disconnect**.

## Add a server {#add}

In Connections, click **+** beside **Custom MCP** (with none yet, **Add a custom MCP**). The form has:

| Field | Is |
|---|---|
| URL or Command | **URL**: an MCP server over HTTP (streamable HTTP, which also serves SSE). **Command**: a program each agent's claude starts on its machine, speaking MCP over stdin and stdout, typed as one line (`acme-mcp --read-only`; quote an argument with spaces). |
| Name | How agents see its tools: `mcp__<name>__<tool>`. Made from the URL's host or the command's package until you type one. Letters, digits, `_` and `-`; `fleetd` is taken by fleetd's own tools. |
| Headers or Environment | Each a name and a value picked from the [vault](/docs/vault): a team login's password or a variable. `Authorization` takes **Bearer** before the value unless you pick **As is**. See [Secrets](#secrets). |
| Bots | **Every bot** (bots made later too), or the ones you tick. Every agent of a bot that uses it gets it, its lead included. |

**Add and test** saves it and tests it at once; the line under the form says what came back. A server that offers
OAuth goes to its sign-in first ([Integrations](/docs/integrations#sign-in)), then is tested. Owners and admins add a
command or headers; anyone adds a URL that signs in.

A server you saved before Connections, for one bot alone, stays that bot's: its row says which bot, and **Edit** keeps
it there. A bot's server replaces a global one of the same name in that bot, for every role, even while the bot's
is off: that's how to turn a global server off for one bot.

A command server starts in the agent's working directory with the agent's environment, the
[bot's variables](/docs/projects#env) included, plus its own environment.

## When a change takes effect {#takes-effect}

An agent started after you save gets the change. A lead already running gets it at its next turn: when a
server it gets was added, edited or removed, or had its key replaced, that turn starts a fresh session, as
[a cold lead's does](/docs/what-agents-are-told#pinning), with the latest part of the chat. A turn in progress is never
cut short: the change waits for the next one. The chat then says once that the server is there ("docs is connected: I
can use it now"). A change that doesn't reach the lead, such as a server for writers only, leaves its session as it is.

A task already running keeps the servers its claude started with; fleetd hands it the change with its next message, and
it takes effect the next time that agent's process starts (after it was idle or stopped; it runs on through a node
restart). Removing a server works the same way.

## Secrets {#secrets}

A header's or variable's value comes from a vault item: the hub seals it to each machine's key itself, so the app never
holds it, and every use is in the item's activity. A value saved as a secret before the vault is kept as it was: sealed
in the app to each machine's key, as a [bot's secret variables](/docs/projects#env) are: a bot server's to its
machine, a global one's to every machine. The hub passes the sealed values on to the nodes without storing or logging them, and keeps only each
node's fingerprint of the value. The node keeps them in `~/.fleetd/node/mcp-secrets/` (mode `0600`) and puts them into
the MCP config it writes for each agent's claude (also `0600`). If an agent prints one, the node masks it as
`***<server>.<NAME>***` before the output leaves the machine, as it masks a bot's secrets.

A secret is never shown again. Editing a server keeps a saved one until you pick a vault item in its place.

:::caution
A machine that is offline when you save a global server with secrets doesn't get them, and its agents go without
that server. The list says which machines lack its secrets: save the server again once they are online.
:::

## Test {#test}

**Test** (a row's menu, or **Add and test**) has the node start the server (or connect to it), with its secrets, exactly as an agent's claude
would, and list its tools within 30 seconds. A bot's server is tested on its machine in the bot's checkout; a
global one on the first machine online. On failure it says why: a command that isn't on the machine's `PATH`, the
command's error output (secrets masked), an HTTP status such as 401 when a header is wrong, or no answer in time. A
server given no key that answers 401 and asks for OAuth sign-in says so; a signed-in server whose token it turns away
has the token renewed and is tested again.

## On your tailnet {#tailnet}

A server whose URL is on your tailnet (a MagicDNS name under `.ts.net`, or a `100.x` address) works through the
**Tailscale** connection in Connections, with nothing else to set: agents on a machine that's on the tailnet reach it
directly, others through the hub's route, and on fleetd's computers through your team's Tailscale. Its row carries
Tailscale's mark, and a Test says **through Tailscale**. While Tailscale isn't connected, the form and the row say so,
with **Connect Tailscale** for an admin.

## Your own MCP servers {#your-own}

Agents also get the MCP servers of each machine's own claude setup (`~/.claude.json`, a repo's `.mcp.json`), as
before. Turn **Machines' own MCP servers** off at the foot of Connections (owners and admins) to give them only
fleetd's tools and the servers configured here: claude then runs with `--strict-mcp-config`. fleetd's own tools
(`report`, `ask_lead`, the lead's tools) are always there and can't be replaced.

## From an MCP client {#tools}

`mcp_servers_get` lists the servers, `mcp_server_set` adds or replaces one (each secret sealed to each machine's
`boxPubKey`), `mcp_server_remove` removes one, `mcp_settings_set` turns your own servers on or off, and
`mcp_server_test` tests one, and `mcp_oauth_start` opens a bot server's [sign-in](/docs/integrations#sign-in). All
but `mcp_servers_get` take a human key.
