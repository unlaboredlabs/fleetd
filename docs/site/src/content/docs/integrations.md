---
title: Integrations
description: Connect a Navi to any MCP server, with your own credentials. Tools you mark as reads run unasked; everything else goes by the Navi's approval mode, and a card shows exactly what it would send.
---

A Navi can reach any service with an MCP server. You connect each one yourself in the Navi's settings, under
**Integrations**, with credentials you make. Your keys are sealed on the Navi's machine, and the Navi never sees them.

Integrations connect only to a Navi. A coding project's lead runs with full access, so it would send unasked; the hub
refuses an integration on any other project.

## What runs unasked, and what asks {#policy}

The hub decides each call, not the Navi. The model can't talk its way past it.

| | Examples | What happens |
|---|---|---|
| **Reads** | The tools you ticked as only reading when you connected the server | Runs without asking. |
| **Writes, sends, deletes, shares** | Every other tool | Goes by the Navi's [approval mode](/docs/navi#approvals). By default a checker model judges it first: what you asked for runs, with one line in the chat; anything else asks you in the chat with exactly what it would send. With **Ask me about everything** each one asks you; with **YOLO** none does. |
| **Spending** | A `pay`, `purchase`, `checkout`, `book`, `reserve` or `subscribe` tool, and one that makes an order, a booking or a reservation (`create_order`, `confirm_booking`; reading one, such as `list_orders`, doesn't count) | Asks you, marked **Costs money**, and asks once more before it runs. Only you answer it, whatever approval mode the Navi runs in. |
| **Never** | Moving money between accounts (`transfer`, `send_money`, `send_transaction`), trading and crypto (`buy_stock`, `sell`, `buy_crypto`, and any `place_order` or `submit_order`, which could be a broker's), creating accounts in your name; sending or storing what looks like a password, key or token; a call too large to show on the card in full | Refused, even if you would approve it. The Navi is told to leave it to you. A shop's checkout goes through a [purchase](/docs/navi#purchases) instead. |

The **Never** row and spending hold in every mode, YOLO included, and fleetd's own rules make the checker's go an
ask for a recipient only an email or a page named, a public share, a forwarding rule and the like (see
[Approvals](/docs/navi#approvals)). The same rules cover the MCP servers in your own claude setup: none of their tools
counts as a read.

## The approval card {#card}

An ask shows in the Navi's chat as a card.

| Part | Shows |
|---|---|
| Heading | What kind of act it is, **Sends · MCP server** or **Deletes · MCP server**, then who asks: "Ada wants to use create_page on docs". A share, delete or spend says **Gives access**, **Can't be undone** or **Costs money** on the right. |
| Everything it sends | The tool's whole input as JSON, exactly as it runs once approved. A call too large to show whole is refused, never asked about. |

What kind of act it is comes from the tool's name: a name with send, reply or post sends; delete, remove or trash
deletes; share or grant shares; pay or buy spends; anything else changes something.

A character that hides or reorders text shows as a mark such as ⟨U+200B⟩, under **Contains hidden characters**. See
[Hidden characters](/docs/approvals-and-secrets#hidden).

A card the Navi's checker sent to you says why under the title. One it blocked says so in red, with **Approve
anyway** and **Keep it blocked**. A Navi's final click on a site (`confirm_step`) shows **Confirms · on a site**, the
button and what it does, and the page's screenshot.

The buttons name the act: **Send it** and **Don't send**, **Share it**, **Delete it**, **Pay**, **Click it**, **Do it**. Either runs
exactly that input, or tells the Navi no; <kbd>Enter</kbd> and <kbd>Esc</kbd> do the same. A delete or a spend asks once
more in the card before it runs. Once answered, the card folds to what you decided: "Approved: a send · you
approved at 09:12". The tool may still refuse or fail; what it did is in the Navi's chat.

## Connect a server {#custom}

**Add an MCP server** takes a URL (MCP's streamable HTTP) or a command started on the Navi's machine, and an optional
key: a header such as `Authorization: Bearer …`, or an environment variable. The key is sealed to the Navi's machine.

After **Connect and test**, fleetd lists the server's tools. Tick the ones that only read: they run unasked. A tool its
server marks read-only (MCP's `readOnlyHint`) is ticked to start with. Every tool you leave unticked asks you each
time. A tool the blocked list refuses (its name says transfer, payout, withdraw, trade, sell, sign up, create account
and the like) can't be ticked, and is never run.

**Test connection** on a connected server runs the test again and lists each tool by what the hub does with it.

## Disconnect {#disconnect}

**Disconnect** removes the connection. The Navi starts without it from its next message, and the key is erased from the
Navi's machine. To cut it off at the source too, revoke the key where you made it.

## Where your credentials are {#credentials}

| What | Where |
|---|---|
| A server's key | Sealed in the app to the Navi's machine. The hub keeps only a fingerprint; the node keeps the value in `~/.fleetd/node/mcp-secrets/` (mode `0600`). See [MCP servers](/docs/mcp-servers#secrets). |
| In the chat, transcripts, memory | Never. The node puts the key only into the MCP config it writes for the Navi's claude (mode `0600`), not into its conversation; a call holding something that looks like a key is refused. |
