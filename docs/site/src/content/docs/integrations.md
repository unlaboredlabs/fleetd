---
title: Integrations
description: Connect a project to any MCP server, with a key or by signing in with your own account. Reads run unasked; everything else goes by the project's approval mode, and a card shows exactly what it would send.
---

A project's lead can reach any service with an MCP server. You connect each one yourself in the project's settings,
under **MCP servers** (the project's one list of them), with a key you make or by signing in with your own account. Your keys are sealed on the
project's machine, and the lead never sees them.

An integration reaches the project's lead alone: its agents never get one. Turn on **Agents get it too** when you add
a server to give it to the project's writers and reviewers as well: then none of its tools asks you, since an agent
can't stop to ask, and it is a [project MCP server](/docs/mcp-servers) with roles you edit. A project on a machine whose fleetd is
older takes none until that machine runs `fleetd update`.

## What runs unasked, and what asks {#policy}

The hub decides each call, not the lead. The model can't talk its way past it.

| | Examples | What happens |
|---|---|---|
| **Reads** | A tool whose name only reads (`search_tools`, `get_page`, `list_events`: a word such as get, list, search, find, read or fetch, and none that changes, sends, deletes or pays), a gateway's call of one (`call_read_tool` running `list_calendars`), and the tools you ticked as only reading when you connected the server | Runs without asking: no checker, no card, no line in the chat. One whose input holds a link (with or without `https://`: `www.…`, a host with a path, or anything under a key such as `url` or `site`; a file name or a domain in a search doesn't count) goes by the approval mode instead, since the server would fetch it with whatever it carries. A `query` or `track` tool is no read (a database runs any statement; analytics records what it gets), and neither is a gateway's call whose tool fleetd can't find in its input. |
| **Writes, sends, deletes, shares** | Every other tool | Goes by the project's [approval mode](/docs/projects#approvals). A new project starts in **YOLO**, where none asks you. With **Checker decides** a checker model judges it first: what you asked for runs, with one line in the chat; anything else asks you in the chat with exactly what it would send. With **Ask me about everything** each one asks you. |
| **Spending** | A `pay`, `purchase`, `checkout`, `book`, `reserve` or `subscribe` tool, and one that makes an order, a booking or a reservation (`create_order`, `confirm_booking`; reading one, such as `list_orders`, doesn't count) | Asks you, marked **Costs money**, and asks once more before it runs. Only you answer it, whatever the project's approval mode. |
| **Never** | Moving money between accounts (`transfer`, `send_money`, `send_transaction`), trading and crypto (`buy_stock`, `sell`, `buy_crypto`, and any `place_order` or `submit_order`, which could be a broker's), creating accounts in your name; sending or storing what looks like a password, key or token; a call too large to show on the card in full | Refused, even if you would approve it. The lead is told to leave it to you. A shop's checkout goes through a [purchase](/docs/projects#purchases) instead. |

The **Never** row and spending hold in every mode, YOLO included, and fleetd's own rules make the checker's go an
ask for a recipient only an email or a page named, a public share, a forwarding rule and the like (see
[Approvals](/docs/projects#approvals)). A gateway's call (`call_tool`, `call_write_tool`, naming the tool it runs in its
input) goes by the tool it runs too: `call_write_tool` running `create_order` spends, and one running `transfer_funds`
is refused. The same rules cover the MCP servers in your own claude setup: their tools are reads by the same names.

## The approval card {#card}

An ask shows in the project's chat as a card.

| Part | Shows |
|---|---|
| Heading | What kind of act it is, **Sends · MCP server** or **Deletes · MCP server**, then who asks: "Ada wants to use create_page on docs". A share, delete or spend says **Gives access**, **Can't be undone** or **Costs money** on the right. |
| Everything it sends | The tool's whole input as JSON, exactly as it runs once approved. A call too large to show whole is refused, never asked about. |

What kind of act it is comes from the tool's name: a name with send, reply or post sends; delete, remove or trash
deletes; share or grant shares; pay or buy spends; anything else changes something.

A character that hides or reorders text shows as a mark such as ⟨U+200B⟩, under **Contains hidden characters**. See
[Hidden characters](/docs/approvals-and-secrets#hidden).

A card the checker sent to you says why under the title. One it blocked says so in red, with **Approve
anyway** and **Keep it blocked**. The lead's final click on a site (`confirm_step`) shows **Confirms · on a site**, the
button and what it does, and the page's screenshot.

The buttons name the act: **Send it** and **Don't send**, **Share it**, **Delete it**, **Pay**, **Click it**, **Do it**. Either runs
exactly that input, or tells the lead no; <kbd>Enter</kbd> and <kbd>Esc</kbd> do the same. A delete or a spend asks once
more in the card before it runs. Once answered, the card folds to what you decided: "Approved: a send · you
approved at 09:12". The tool may still refuse or fail; what it did is in the project's chat.

## Connect a server {#custom}

**Add an MCP server** takes a URL (MCP's streamable HTTP) or a command started on the project's machine, and an optional
key: a header such as `Authorization: Bearer …`, or an environment variable. The key is sealed to the project's machine.
A service that signs you in with your account instead takes no key: leave it empty, and **Connect and test** offers
[Sign in](#sign-in).

After **Connect and test**, fleetd lists the server's tools. A tool whose name says it only reads is listed as a read
already; tick any other that only reads, and it runs unasked too. A tool its server marks read-only (MCP's
`readOnlyHint`) is ticked to start with. Every other tool goes by the project's approval mode. A tool the blocked list refuses (its name says transfer, payout, withdraw, trade, sell, sign up, create account
and the like) can't be ticked, and is never run.

**Test connection** on a connected server runs the test again and lists each tool by what the hub does with it.

## Sign in with your account {#sign-in}

Many hosted MCP servers take no key: you sign in on the service's own page instead (OAuth). fleetd does this as MCP's
[authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) says, with no
fleetd-run app in between:

1. **Connect and test** finds that the server asks you to sign in, and **Sign in** opens the service's sign-in page in
   your browser.
2. You sign in there and allow fleetd. The service sends your browser back to a page the hub serves,
   `<hub>/oauth/callback`, at the address this app reaches the hub by, so it works from any computer that reaches it.
3. The dialog moves on by itself: it tests the server and asks which tools may run unasked, as for a key. The lead gets
   the server at its next message, and says once that it is connected.

fleetd registers itself with the service where the service allows it (dynamic client registration). Where it doesn't,
the dialog says so and asks for an OAuth app of your own: make one in the service's developer settings, allow the
**Redirect URL** the dialog shows (copy it exactly), and enter its client ID and secret. The secret is sealed in the app
to the hub's own key. Signing in uses PKCE, and goes over https unless the service is on this machine or your tailnet.

**Renewing.** A sign-in's token lasts a while (often an hour). The hub renews it before it ends, from half its life left
and at most 30 minutes before, and hands the new one to the project's machine; the lead's next message picks it up,
without starting a new conversation. Scheduled runs use it the same way.

**When the service ends the sign-in** (you revoked fleetd's access, changed your password, or the sign-in expired with
no way to renew it), the server shows **Signed out** with the service's reason and **Reconnect**, the lead goes without
it, and its chat says so once: "mail is signed out: … the project can't use it until you press Reconnect". **Reconnect** signs
in again with the same app. If the service only can't be reached, the hub keeps trying every 2 minutes; once the token
has ended, the chat says that once too, and again when it works.

## Disconnect {#disconnect}

**Disconnect** removes the connection. The lead starts without it from its next message, and the key is erased from the
project's machine. To cut it off at the source too, revoke the key where you made it. A server you signed in to is signed
out at the service too, where the service offers that (token revocation).

## Where your credentials are {#credentials}

| What | Where |
|---|---|
| A server's key | Sealed in the app to the project's machine. The hub keeps only a fingerprint; the node keeps the value in `~/.fleetd/node/mcp-secrets/` (mode `0600`). See [MCP servers](/docs/mcp-servers#secrets). |
| A sign-in's tokens | The hub keeps the access and refresh tokens, and your own app's secret, sealed to its own key (`<hub home>/box.key`) in its database, since it renews them. Each access token is sealed to the project's machine as the server's `Authorization` header, where it is kept as a key is. |
| In the chat, transcripts, memory | Never. The node puts the key only into the MCP config it writes for the lead's claude (mode `0600`), not into its conversation; a call holding something that looks like a key is refused. |
