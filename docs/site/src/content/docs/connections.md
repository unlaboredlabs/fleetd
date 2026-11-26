---
title: Connections
description: Connect Paper, Notion, Tailscale or any MCP server, so your bots' agents can use them.
---

Connections gives your bots' agents other services to use: Paper, Notion, your tailnet, or any MCP server.

Open it from the plain icon at the foot of the sidebar. On the phone: **Settings › Connections**.

A connection belongs to the whole team. Connect it once, and every bot's lead and agents can use it. To limit it,
pick bots under **Bots** in its row's menu.

## Connect Paper {#paper}

Paper (paper.design) is a design canvas. Agents can read and edit Paper files: artboards, text, styles, exports.

1. In Connections, press **Connect** on **Paper**.
2. Sign in on Paper's page and allow fleetd.
3. The row says **Connected**. **Test** in its menu lists Paper's tools.

Open the file in Paper's own app to watch an agent's edits live. Paper's free plan allows about 100 tool calls a week.

## Connect Notion {#notion}

1. In Connections, press **Connect** on **Notion**.
2. On Notion's page, pick the workspace and pages to share, and allow fleetd.
3. The row says **Connected**.

## Connect more than one account {#accounts}

You can connect Paper or Notion with more than one account, for example a personal and a work Notion.

1. In a connected service's row menu, press **Add another account**. On the phone, tap the row, then **Add Another
   Account**.
2. Keep the name it suggests (`notion-2`) or type your own (`notion-work`). Agents see its tools as
   `mcp__notion-work__…`.
3. On the service's page, switch to the other account and allow fleetd.

Each account gets its own row and is counted on its own in **Connected**. Each one signs in, takes its own **Bots**
and is disconnected separately. Disconnecting one leaves the others connected.

Paper and Notion only accept an https sign-in address. If your hub has no https address, sign in from the hub machine
itself. See [Troubleshooting](/docs/troubleshooting#hub).

## Connect Tailscale {#tailscale}

The **Tailscale** row lets agents reach servers on your tailnet, such as a private MCP server. An admin connects it.
See [Servers on your tailnet](/docs/mcp-servers#tailnet).

## Connect any other server {#custom}

Press **+** next to **Custom MCP**, then enter a URL or a command. See [Custom MCP servers](/docs/mcp-servers).

## Sign in with your account {#sign-in}

Many hosted MCP servers take no key: you sign in on the service's own page instead.

1. Press **Connect** on a named service, or **Add and test** on a custom server that asks to sign in.
2. Sign in on the service's page and allow fleetd.
3. The service sends you back. fleetd tests the server, and the lead says once that it's connected.

The sign-in is the team's: one person signs in, and every bot can use it. The person who connected it, or an admin,
can disconnect it.

If a service doesn't let fleetd register itself, the dialog asks for an OAuth app of your own. Create one in the
service's developer settings, allow the **Redirect URL** the dialog shows, and enter its client ID and secret.

fleetd renews sign-ins by itself. Agents never hold the token. If the service ends the sign-in, the row shows **Sign
in needed** and each bot's chat says so once. Press **Sign in** on the row to sign in again.

## What agents may do without asking {#policy}

The hub decides each tool call, not the lead.

- **Reads** run without asking: tools whose names only read, such as `get_page` or `list_events`, and tools you
  marked as reading. A read whose input holds a link goes by the approval mode instead.
- **Writes, sends, deletes and shares** follow the bot's [approval mode](/docs/approvals-and-secrets#modes). New bots start
  in **YOLO**, where nothing asks.
- **Spending** (pay, buy, book, subscribe) always asks you, marked **Costs money**, in every mode.
- **Never**: moving money between accounts, trading, creating accounts in your name, or sending something that looks
  like a password or key. These are refused even if you'd approve.

The same rules apply to MCP servers from your own Claude Code setup.

## Approval cards {#card}

When a call asks, the bot's chat shows a card:

- what kind of act it is, and who asks;
- the tool's whole input, exactly as it will run;
- buttons that name the act: **Send it** and **Don't send**, **Delete it**, **Pay**.

A delete or a payment asks once more before it runs. A card the checker blocked offers **Approve anyway** and
**Keep it blocked**.

## Disconnect {#disconnect}

Press **Disconnect** in a row's menu. Agents lose it from their next message, and its key is erased from every
machine. A signed-in service is signed out at the service too, where it allows that.

To cut access off completely, also revoke the key where you created it.

## Where credentials are kept {#credentials}

- **Keys**: sealed for each machine. Only the machine that runs the agent can read them.
- **Sign-ins**: sealed by the hub, which renews them. Agents reach the service through fleetd, never with the token
  itself.
- **Chats, transcripts and memory**: never. A call that holds something like a key is refused.
