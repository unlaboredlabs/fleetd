---
title: Integrations
description: Connect a bot to any MCP server, with a key or by signing in with your own account. Reads run unasked; everything else goes by the bot's approval mode, and a card shows exactly what it would send.
---

Agents reach any service with an MCP server, through **Connections**: the plain icon at the sidebar's foot, beside
you (on the phone, Settings › **Connections**). It holds a few named services that connect with one press,
[Paper](#paper) and [Notion](#notion), the team's [Tailscale](/docs/mcp-servers#tailnet), and any other server as a
[custom MCP](/docs/mcp-servers#add), its key picked from the [vault](/docs/vault). A connection is the team's: you
connect it once, and every bot's lead and agents use it, or the bots you tick under **Bots** in its row's menu.

A server saved for one bot's lead alone before Connections keeps working as it was, its writes asking by the bot's
approval mode; its row in Connections says which bot. A bot on a machine whose fleetd is older takes none until that
machine runs `fleetd update`.

## What runs unasked, and what asks {#policy}

The hub decides each call, not the lead. The model can't talk its way past it.

| | Examples | What happens |
|---|---|---|
| **Reads** | A tool whose name only reads (`search_tools`, `get_page`, `list_events`: a word such as get, list, search, find, read or fetch, and none that changes, sends, deletes or pays), a gateway's call of one (`call_read_tool` running `list_calendars`), and the tools you ticked as only reading when you connected the server | Runs without asking: no checker, no card, no line in the chat. One whose input holds a link (with or without `https://`: `www.…`, a host with a path, or anything under a key such as `url` or `site`; a file name or a domain in a search doesn't count) goes by the approval mode instead, since the server would fetch it with whatever it carries. A `query` or `track` tool is no read (a database runs any statement; analytics records what it gets), and neither is a gateway's call whose tool fleetd can't find in its input. |
| **Writes, sends, deletes, shares** | Every other tool | Goes by the bot's [approval mode](/docs/projects#approvals). A new bot starts in **YOLO**, where none asks you. With **Checker decides** a checker model judges it first: what you asked for runs, with one line in the chat; anything else asks you in the chat with exactly what it would send. With **Ask me about everything** each one asks you. |
| **Spending** | A `pay`, `purchase`, `checkout`, `book`, `reserve` or `subscribe` tool, and one that makes an order, a booking or a reservation (`create_order`, `confirm_booking`; reading one, such as `list_orders`, doesn't count) | Asks you, marked **Costs money**, and asks once more before it runs. Only you answer it, whatever the bot's approval mode. |
| **Never** | Moving money between accounts (`transfer`, `send_money`, `send_transaction`), trading and crypto (`buy_stock`, `sell`, `buy_crypto`, and any `place_order` or `submit_order`, which could be a broker's), creating accounts in your name; sending or storing what looks like a password, key or token; a call too large to show on the card in full | Refused, even if you would approve it. The lead is told to leave it to you. A shop's checkout goes through a [purchase](/docs/projects#purchases) instead. |

The **Never** row and spending hold in every mode, YOLO included, and fleetd's own rules make the checker's go an
ask for a recipient only an email or a page named, a public share, a forwarding rule and the like (see
[Approvals](/docs/projects#approvals)). A gateway's call (`call_tool`, `call_write_tool`, naming the tool it runs in its
input) goes by the tool it runs too: `call_write_tool` running `create_order` spends, and one running `transfer_funds`
is refused. The same rules cover the MCP servers in your own claude setup: their tools are reads by the same names.

## The approval card {#card}

An ask shows in the bot's chat as a card.

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
approved at 09:12". The tool may still refuse or fail; what it did is in the bot's chat.

## Connect a server {#custom}

**Add a custom MCP** in Connections takes a URL or a command, and headers or environment variables whose values come
from the vault ([MCP servers](/docs/mcp-servers#add)). A service that signs you in with your account instead takes no
key: leave the headers empty, and **Add and test** goes to [Sign in](#sign-in).

**Test** in a row's menu runs the test again: one plain line says it works and how many tools it lists (and, for a
URL with no key, that it needs no sign-in), that it asks you to sign in, or why it failed.

## Sign in with your account {#sign-in}

Many hosted MCP servers take no key: you sign in on the service's own page instead (OAuth). Such a sign-in is made once
for the team: any person on the hub connects it and signs in, and every bot's lead and agents get it, with no switch
per bot. The one who connected it, or an admin, disconnects it; anyone may sign in to it again. A server added to a
bot that turns out to sign in becomes the team's as you sign in, and sign-ins made per bot before this were carried
over as they were, so nobody signs in again (where two bots had each signed in, the newer sign-in is kept). fleetd does this as MCP's
[authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) says, with no
fleetd-run app in between:

1. **Connect** on a named service, or **Add and test** on a custom one that offers OAuth, opens the service's sign-in
   page in your browser.
2. You sign in there and allow fleetd. The service sends your browser back to a page the hub serves,
   `<hub>/oauth/callback`, at the address this app reaches the hub by, so it works from any computer that reaches it.
   Where that address is plain http and the hub has an https one (its `--url`, or a Tailscale Serve https address in
   front of its port), the page is at the https one, since many services accept only an https callback.
3. The dialog moves on by itself and tests the server. The lead gets the server at its next message, and says once
   that it is connected.

fleetd registers itself with the service where the service allows it (dynamic client registration). Where it doesn't,
the dialog says so and asks for an OAuth app of your own: make one in the service's developer settings, allow the
**Redirect URL** the dialog shows (copy it exactly), and enter its client ID and secret. The secret is sealed in the app
to the hub's own key. Signing in uses PKCE, and goes over https unless the service is on this machine or your tailnet.
A hub with no https address signs in to such a service only from its own machine: give it one (see
[Troubleshooting](/docs/troubleshooting#hub)) and sign in again.

**Renewing.** A sign-in's token may last an hour, or only minutes (Paper's last 5). The hub renews it before it ends,
from half its life left and at most 30 minutes before, and hands the new one to every machine a bot runs on (a machine
offline gets it once it is back). Agents never hold
the token themselves: their claude reaches a signed-in server through fleetd's MCP relay, which takes the machine's
newest token for each request, so an agent keeps the server for its whole session, the lead and tasks alike, on the
machine or in a hosted sandbox. If the server turns a token away anyway, the relay has the hub renew
it at once and sends again. Scheduled runs use it the same way. Where the service lists `offline_access` among its
scopes, fleetd asks for it (with `openid` where listed too), since some services send the refresh token renewing needs
only then.


**When the service ends the sign-in** (you revoked fleetd's access, changed your password, the sign-in expired with
no way to renew it, or the service turns away a token fleetd has just renewed), the server shows **Sign in needed**
with the service's reason, and each bot's chat says so once: "mail is signed out: … No bot can use it until you sign in again on it in Connections". The dead token leaves every machine (one offline, as soon as it is
back), so new agents start without the server; an agent already running is answered, at its next call, that the
sign-in has ended and that you sign in again from Connections, and carries on without it. **Sign in** on its row signs in again with the
same app. If the service only can't be reached, the hub keeps trying every 2 minutes; once the token has ended, the
row shows why, and the chat says so once, and again when it works. An agent whose call can't reach the server is told
so in plain words and keeps the server for its next call.

## Example: Paper {#paper}

Paper (paper.design) is a design canvas with a hosted MCP server. Every bot's agents use it with the Paper account the
team signed in with; no key and no Paper app on the bots' machines. It is a named service: **Paper** heads Connections, with
nothing to type.

1. **Connections › Paper › Connect**. On the phone: **Settings › Connections › Paper**.
2. Paper's sign-in page opens: sign in and allow fleetd. The row then says **Connected**, and **Test** lists Paper's
   tools.

Connect saves what adding it by hand would: a server named `paper` (or `paper-2` when that name is taken) at
`https://mcp.paper.design`, no key, for every bot. A `paper` server you added by hand at that URL shows as
this row. When the sign-in ends, the row says **Sign in needed**, with **Sign in**. Paper takes only an https or
loopback callback, so the hub needs an https address (its `--url`, or Tailscale Serve in front of its port) unless you
sign in on its machine.

Every bot's lead, writers and reviewers then read Paper files (structure, screenshots, styles, JSX, text), create and edit
artboards and frames, set text and styles, export images, and manage files, unasked. A writer that has the repo
checked out can design a screen in Paper, build it, and open the PR in one task. There is no Paper editor inside
fleetd: open the file in Paper's own app (web or desktop) to watch an agent's edits live, and ask agents to link the
file in their results.

**Plan.** Paper's free plan allows 100 MCP tool calls a week, about one small design session; a paid plan raises it.
Paper's pricing page (paper.design/pricing) has the current numbers, which may change while its hosted MCP is in early
access.

## Example: Notion {#notion}

Notion's hosted MCP server (`https://mcp.notion.com/mcp`) signs in with your Notion account, and fleetd registers
itself there, so there is no app to make and nothing to type.

1. **Connections › Notion › Connect**. On the phone: **Settings › Connections › Notion**.
2. Notion's page opens: pick the workspace and the pages to share, and allow fleetd. The row then says **Connected**.

Notion takes only an https or loopback callback, as Paper does: the hub needs an https address (its `--url`, or
Tailscale Serve in front of its port) unless you sign in on its machine.

## Disconnect {#disconnect}

**Disconnect**, in a row's menu, removes the connection. Agents start without it from their next message, and its key
is erased from every machine. To cut it off at the source too, revoke the key where you made it. A server you signed in to is signed
out at the service too, where the service offers that (token revocation).

## Where your credentials are {#credentials}

| What | Where |
|---|---|
| A server's key | Sealed in the app to the bot's machine. The hub keeps only a fingerprint; the node keeps the value in `~/.fleetd/node/mcp-secrets/` (mode `0600`). See [MCP servers](/docs/mcp-servers#secrets). |
| A sign-in's tokens | The hub keeps the access and refresh tokens, and your own app's secret, sealed to its own key (`<hub home>/box.key`) in its database, since it renews them. Each access token is sealed to every machine a bot runs on as the server's `Authorization` header, where it is kept as a key is. It never goes into an agent's MCP config: fleetd's MCP relay takes it from the node for each request. |
| In the chat, transcripts, memory | Never. The node puts the key only into the MCP config it writes for the lead's claude (mode `0600`), not into its conversation; a call holding something that looks like a key is refused. |
