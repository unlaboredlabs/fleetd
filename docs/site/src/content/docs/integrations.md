---
title: Integrations
description: Connect a Navi to Notion and any MCP server, with your own credentials. Reads run unasked; every write, send or delete asks you, on a card that shows exactly what it would do.
---

A Navi can reach your notes and any service with an MCP server. You connect each one yourself in the Navi's settings,
with credentials you make: fleetd is open source and has no shared app. Your keys are sealed on the Navi's machine, and
the Navi never sees them. The same rules and the same approval card cover every integration, Gmail, Calendar and Drive
([Google for Navi](/docs/google)) included. A Navi's settings list them under **Integrations**: Notion and the MCP
servers you added. Its Google is in **Settings › Your accounts**, beside your other accounts.

Integrations connect only to a Navi. A coding project's lead runs with full access, so it would send unasked; the hub
refuses an integration on any other project.

## What runs unasked, and what asks {#policy}

The hub decides from a table of every tool, not the Navi. The model can't talk its way past it.

| | Examples | What happens |
|---|---|---|
| **Reads** | Search and read mail, list events, search Drive, read a file, search Notion, read a page; save a Gmail draft, which sends nothing (decision `navi.google-drafts-unasked`, D201) | Runs without asking. |
| **Writes, sends, deletes, shares** | Send or reply to an email; create or change an event; upload or share a Drive file; change or trash a Notion page | Asks you in the chat, **every time**, with exactly what it would do. There is no "always allow". |
| **Spending** | A custom server's `pay`, `purchase` or `checkout` tool | Asks you, marked **Costs money**, and asks once more before it runs. |
| **Never** | Moving money between accounts (`transfer`, `send_money`, `send_transaction`), trading (`buy_stock`, `sell`, and any `place_order` or `submit_order`, a shop's or a restaurant's too), creating accounts in your name; sending or storing what looks like a password, key or token, a file's text included; a call too large to show on the card in full; an email attaching a file from outside the Navi's folder ([Google for Navi](/docs/google#attachments)) | Refused, even if you would approve it. The Navi is told to leave it to you. Place orders yourself, or through a screen you take over. |

A tool the table doesn't know asks. That covers a tool added to an integration later, a custom server's tools and the MCP
servers in your own claude setup.

## The approval card {#card}

An ask shows in the Navi's chat as a card. Every value on it is read from the exact input the tool runs with. None of
it is a summary the Navi wrote.

| Row | Shows |
|---|---|
| Heading | What it does and where, **Sends · Google** or **Deletes · Notion**, then who asks: "Ada wants to send an email". A share, delete or spend says **Gives access**, **Can't be undone** or **Costs money** on the right; a send lets its recipients speak. |
| From | The account it acts as. |
| To, Cc, Bcc | Every recipient, as the tool gets them. An address outside the From account's domain says "outside example.com" after it; Bcc says "hidden from the others". An event's guests are its To. |
| Reaches | Who gets it when the tool picks them, as a reply does: "That message's sender", or "Everyone on that message". |
| Subject or Title | The email's subject, the event's or the page's title. |
| Attached | Each file, with its size and type: "lease.pdf 120 KB · PDF". |
| When | An event's start and end. |
| On | The message, event, page or file it acts on. |
| Body | The whole text that goes out or goes in, under a hairline. A long one folds, with **Show all** in place. |
| Everything it sends | The tool's whole input as JSON, closed until you open it, so nothing is hidden behind the rows. A call too large to show whole is refused, never asked about. |

The buttons name the act: **Send it** and **Don't send**, **Share it**, **Delete it**, **Pay**. Either runs exactly that
input, or tells the Navi no; <kbd>Enter</kbd> and <kbd>Esc</kbd> do the same. A delete or a spend asks once more in the
card before it runs. Once answered, the card folds to what you decided: "Approved: send an email to ana@example.com and 2
more · you approved at 09:12". The tool may still refuse or fail; what it did is in the Navi's chat.

## Notion {#notion}

Notion comes through its official MCP server, [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server),
with an integration you make in your own workspace. It runs on the Navi's machine, which needs Node.js.

1. Open `notion.so/profile/integrations` in Notion and create a **new integration**:
   **Internal**, in the workspace the Navi should use. Name it Navi.
2. Under **Capabilities**, keep Read content, Update content and Insert content. Add the comment ones if the Navi
   should comment.
3. Copy its **Internal Integration Secret**. It starts with `ntn_` (`secret_` on older ones).
4. **Share pages with it.** On each page the Navi may use, open the ••• menu → **Connections** and add Navi. Pages
   under it come along. The Navi sees nothing you haven't shared.
5. In fleetd, the Navi's **Integrations** → Notion → **Connect**. Paste the secret, then **Connect and test**. It is
   saved as the sealed `NOTION_TOKEN` of the server.

Reads (search, retrieving pages, blocks, databases and comments, queries) run unasked. Creating or changing pages,
blocks, databases and comments asks. Deleting a block, or moving a page to the trash (`archived` or `in_trash`), asks
as a delete.

Notion's hosted server (`mcp.notion.com`) signs in with OAuth only, which a connection here doesn't do: use the official
server above.

## Any other MCP server {#custom}

**Add an MCP server** takes a URL (MCP's streamable HTTP) or a command started on the Navi's machine, and an optional
key: a header such as `Authorization: Bearer …`, or an environment variable. The key is sealed like the others.

After **Connect and test**, fleetd lists the server's tools. Tick the ones that only read: they run unasked. A tool its
server marks read-only (MCP's `readOnlyHint`) is ticked to start with. Every tool you leave unticked asks you each
time. A tool the blocked list refuses (its name says transfer, payout, withdraw, trade, sell, sign up, create account
and the like) can't be ticked, and is never run.

## Disconnect {#disconnect}

**Disconnect** removes the connection. The Navi starts without it from its next message, and the key is erased from the
Navi's machine. To cut it off at the source too:

- Notion: delete the integration at notion.so/profile/integrations.
- A custom server: revoke the key where you made it.

## Where your credentials are {#credentials}

| What | Where |
|---|---|
| Notion's integration secret, a custom server's key | Sealed in the app to the Navi's machine. The hub keeps only a fingerprint; the node keeps the value in `~/.fleetd/node/mcp-secrets/` (mode `0600`). See [MCP servers](/docs/mcp-servers#secrets). |
| In the chat, transcripts, memory | Never. The node puts the key only into the MCP config it writes for the Navi's claude (mode `0600`), not into its conversation; a send or page holding something that looks like a key is refused. |

## Troubleshooting {#troubleshooting}

| The test says | Do |
|---|---|
| Notion refused the token | Copy the integration's secret again from notion.so/profile/integrations. |
| Notion's server didn't start | Install Node.js on the Navi's machine. |
| Notion finds nothing | Share the pages with the integration (••• → Connections). |
