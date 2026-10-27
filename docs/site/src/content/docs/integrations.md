---
title: Integrations
description: Connect a Navi to Gmail, Calendar and Drive, Notion and any MCP server, with your own credentials. Reads run unasked; every write, send or delete asks you.
---

A Navi can reach your mail, calendar, files and notes. You connect each one yourself in the Navi's settings, with
credentials you make: fleetd is open source and has no shared Google or Notion app. Your keys are sealed on the Navi's
machine, and the Navi never sees them.

Integrations connect only to a Navi. A coding project's lead runs with full access, so it would send unasked; the hub
refuses an integration on any other project.

## What runs unasked, and what asks {#policy}

The hub decides from a table of every tool, not the Navi. The model can't talk its way past it.

| | Examples | What happens |
|---|---|---|
| **Reads** | Search and read mail, list events, check free/busy, search Drive, read a doc, search Notion, read a page | Runs without asking. |
| **Writes, sends, deletes, shares** | Send, reply or forward an email; save a draft; label, archive or trash mail; create, change or delete an event; answer an invitation; change a doc, sheet or Notion page; trash a file | Asks you in the chat, **every time**, with exactly what it would do. There is no "always allow". |
| **Spending** | A custom server's `pay`, `purchase` or `checkout` tool | Asks you, marked **Costs money**, and asks once more before it runs. |
| **Never** | Moving money between accounts (`transfer`, `send_money`, `send_transaction`), trading (`buy_stock`, `sell`, and any `place_order` or `submit_order`, a shop's or a restaurant's too), creating accounts in your name; sending or storing anything that looks like a password, key or token; a call too large to show on the card in full | Refused, even if you would approve it. The Navi is told to leave it to you. Place orders yourself, or through a screen you take over. |

A tool the table doesn't know asks. That covers one xaq adds later, a custom server's tools and the MCP servers in your
own claude setup.

## The approval card {#card}

An ask shows in the Navi's chat as a card. Every value on it is read from the exact input the tool runs with. None of
it is a summary the Navi wrote.

| Row | Shows |
|---|---|
| Heading | What it does and where: **Sends · Google**, **Deletes · Notion**. **Reaches other people**, **Can't be undone** or **Costs money** on the right. |
| From | The account it acts as. |
| To, Cc, Bcc | Every recipient, as the tool gets them. An event's guests are its To. |
| Reaches | Who gets it when the tool picks them, as a reply does: "That message's sender", or "Everyone on that message". |
| Subject or Title | The email's subject, the event's or the page's title. |
| When | An event's start and end. |
| On | The message, event, page or file it acts on. |
| Body | The whole text that goes out or goes in, under a hairline. A body over 20,000 characters is cut here, saying so. |
| Everything it sends | The tool's whole input as JSON, behind a disclosure, so nothing is hidden behind the rows. |

**Approve** runs exactly that input. **Deny**, or <kbd>Esc</kbd>, tells the Navi no. A delete or a spend asks once
more in the card before it runs.

## Google: Gmail, Calendar and Drive {#google}

Google comes through [xaq](https://www.npmjs.com/package/xaq-cli), a small self-hosted broker that holds your Google sign-in
and gives the Navi one MCP endpoint and one key. fleetd uses xaq rather than its own Google code for three reasons:

- Gmail's read scopes are restricted, so each person needs their own Google Cloud app. xaq's setup walks you through
  making it.
- It keeps the refresh token encrypted on its own machine and refreshes it.
- It hands the Navi mail cleaned of hidden text and marked untrusted, and keeps its own guardrails (approval on send,
  send caps, recipient allowlists) as a second layer behind fleetd's approvals.

### 1. Run xaq {#xaq}

On the Navi's machine (or any machine it can reach), with Node.js 22.13 or newer:

```sh
npx xaq-cli
```

Open the link it prints. To keep it running, `npx xaq-cli service install`. Its address is `http://127.0.0.1:8425` by
default. See [xaq's own guide](https://www.npmjs.com/package/xaq-cli) for running it behind a proxy or on another
machine.

### 2. Make your Google Cloud app {#google-cloud}

xaq's setup shows each of these steps with the exact values. In brief, in the
[Google Cloud console](https://console.cloud.google.com/):

1. Create a project, for example "Navi".
2. Enable the **Gmail API** and the **Google Calendar API**. For Drive, also enable the **Google Drive API**, and the
   **Docs**, **Sheets** and **Slides** APIs.
3. Set up the **OAuth consent screen** (Google Auth Platform → Branding and Audience):
   - Audience **Internal** if every account is in your Google Workspace, **External** for `@gmail.com`.
   - For External, **publish the app to In production**. Left in Testing, Google signs you out after 7 days.
   - Google's verification isn't needed for your own use: on consent, click Advanced → Go to (app name).
4. **Credentials → Create credentials → OAuth client ID**, of type **Web application**, with this **authorized
   redirect URI**:

   ```text
   http://localhost:8425/oauth/callback
   ```

   That is `<xaq's address>/oauth/callback`. Use `localhost`, not `127.0.0.1`, for a local xaq. For an xaq at
   `https://mail.example.com` it is `https://mail.example.com/oauth/callback`. fleetd's connect screen shows the one for
   the address you type.
5. Copy the **client ID** and **client secret** into xaq's setup. xaq keeps them on its machine, encrypted, and never
   gives them to an agent.

### 3. Connect your account in xaq {#xaq-account}

In xaq's setup, choose **Gmail and Calendar** and sign in with Google. For Drive, Docs and Sheets, add **Google
Workspace** (Connections → Add connection) and sign in again.

### 4. Make Navi's agent in xaq {#xaq-agent}

In xaq, **Agents → New agent**, named Navi:

| Setting | Set to |
|---|---|
| Grants on your account | `read`, `draft`, `send`, `organize`, `trash`; `calendar.read` and `calendar.write` |
| Connections | Google Workspace, for Drive |
| Send mode | **Approval**. Keep xaq's own guardrails on as a second layer: after you approve a send on fleetd's card, xaq asks once more on its own approve page before anything leaves. Never Direct. |
| Allowed recipients, send caps | Optional, and worth it: xaq refuses a send outside them, whatever was approved. |
| Tool list | **All tools**. In search mode the hub can't tell xaq's tools apart, and each one asks. |

Copy the agent's key. It starts with `aib_`.

### 5. Connect it in fleetd {#google-connect}

In the app, open Settings → **Projects** → your Navi → **Integrations**, and click **Connect** next to Google. Paste
xaq's address and the agent key, then click **Connect and test**. The key is sealed on this computer to the Navi's
machine. The test lists xaq's tools by what fleetd does with them, for example "26 tools read freely · 12 ask you each time".

Not set up yet? The connect dialog has the same five steps. If xaq isn't running, **Test connection** says so and how
to start it.

| Navi reads unasked | Navi asks first |
|---|---|
| `search_threads`, `get_thread`, `get_message`, attachments, labels, mail events | `send_message`, `reply`, `forward`, `create_draft`, `mark_read`, `archive`, `modify_labels`, `trash` |
| `list_calendars`, `list_calendar_events`, `get_calendar_event`, `get_free_busy` | `create_calendar_event`, `update_calendar_event` (a send when it has guests), `delete_calendar_event`, `respond_to_invitation` |
| Drive search, list, get and export; reading Docs, Sheets, Slides and comments | Creating, changing and trashing files; overwriting a doc, clearing cells, deleting a tab or slide |

## Notion {#notion}

Notion comes through its official MCP server, [`@notionhq/notion-mcp-server`](https://github.com/makenotion/notion-mcp-server),
with an integration you make in your own workspace. It runs on the Navi's machine with `npx`, so that machine needs
Node.js.

1. Open [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create a **new integration**:
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

Notion's hosted server (`mcp.notion.com`) signs in with OAuth only. To use it, connect it in xaq and grant the Navi's
agent that connection; it then comes through the Google connection, with the same rules.

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

- Google: delete Navi's agent in xaq.
- Notion: delete the integration at notion.so/profile/integrations.
- A custom server: revoke the key where you made it.

## Where your credentials are {#credentials}

| What | Where |
|---|---|
| Google OAuth client ID and secret, Google refresh tokens | xaq's machine, encrypted by xaq. Never in fleetd. |
| xaq's agent key, Notion's integration secret, a custom server's key | Sealed in the app to the Navi's machine. The hub keeps only a fingerprint; the node keeps the value in `~/.fleetd/node/mcp-secrets/` (mode `0600`). See [MCP servers](/docs/mcp-servers#secrets). |
| In the chat, transcripts, memory | Never. The node puts the key only into the MCP config it writes for the Navi's claude (mode `0600`), not into its conversation; a send or page holding something that looks like a key is refused. |

## Troubleshooting {#troubleshooting}

| The test says | Do |
|---|---|
| xaq isn't answering at … | Start xaq on that machine (`npx xaq-cli`, or `npx xaq-cli service install`), or fix the address. |
| xaq refused the key | Make a new key for Navi's agent in xaq and connect again. |
| xaq answered but lists no tools | Give Navi's agent a grant on your account in xaq (and Google Workspace for Drive). |
| Notion refused the token | Copy the integration's secret again from notion.so/profile/integrations. |
| Notion's server didn't start | Install Node.js on the Navi's machine. |
| Notion finds nothing | Share the pages with the integration (••• → Connections). |
| Google signs you out after a week | Publish the consent screen to In production. |
