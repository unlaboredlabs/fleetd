---
title: Google for Navi
description: Connect a Navi to your own Gmail, Calendar and Drive with a Google OAuth client you bring. Reads and drafts run unasked; a send, invitation, upload or share asks you first.
---

fleetd connects a Navi to Google itself. No other service sits in between. The hub's admin brings one Google OAuth
client for the hub. Then each person connects their own Google account to a Navi from the app. fleetd is open source and
has no shared Google app, so the client is yours and so are the tokens.

Google connects only to a Navi. A coding project's lead runs with full access, so it would send unasked; the hub
refuses Google on any other project.

## What a Navi can do {#tools}

The Navi's lead gets these tools as `mcp__google__<tool>`.

| Tool | Does | Runs |
|---|---|---|
| `search_threads` | Searches Gmail with Gmail's own syntax (`from:`, `is:unread`, `newer_than:7d`). | Unasked |
| `get_thread` | Reads a thread: each message's sender, recipients, subject, whole body and attachment names. | Unasked |
| `create_draft` | Saves a draft in Gmail, with any files from the Navi's folder. Nothing is sent. | Unasked |
| `send_message` | Sends an email, with any files from the Navi's folder. | Asks you |
| `reply` | Replies in a thread to the recipients it names, with any files from the Navi's folder. | Asks you |
| `list_calendar_events`, `get_calendar_event` | Reads events, with their guests and answers. | Unasked |
| `create_calendar_event` | Makes an event. Google emails the guests it names unless `notify_attendees` is false. | Asks you |
| `update_calendar_event` | Changes an event. Its guests are emailed only when `notify_attendees` is true. That needs the whole new guest list in `attendees`, and each guest it drops in `removed_attendees`, since Google emails them a cancellation. You see everyone Google emails. | Asks you |
| `drive_search`, `drive_read` | Finds files and reads their text. A Doc or Slides comes as text, a Sheet as CSV. | Unasked |
| `drive_upload` | Makes a new file from text. | Asks you |
| `drive_share` | Shares a file with people as reader, commenter or writer. | Asks you |

A draft runs unasked on purpose (decision `navi.google-drafts-unasked`, D201): it sends nothing, and only you send it,
from Drafts. Asking for each one would protect nothing and make drafting useless.

An event's guests are plain addresses, like `ana@example.com`. The tool refuses anything else, such as
`Ana <ana@example.com>` or an object, so the card never shows a guest the event wouldn't get.

Only fleetd's own `google` server gets this table. Any other server, such as an older xaq connection marked as Google,
is a [custom server](/docs/mcp-servers/): each of its tools asks, showing its whole input, unless you marked it as one
that only reads.

A tool that asks shows the [approval card](/docs/integrations#card) in the Navi's chat. The card has every
recipient, the subject, the whole body and each attached file, read from the exact input the tool runs with. The tool
sends exactly what you approved. fleetd doesn't rewrite it or block links. Refused even with approval: something that
looks like a password, key or token.

### Attachments {#attachments}

A Navi attaches files from its own folder only. It names each by its path there, as
`"attachments": ["reports/q3.pdf"]`.

- **Inside the folder only.** A path is resolved inside the Navi's folder. A path above it (`../`), an absolute path
  elsewhere, and a link that leads out of it are refused, as is anything but a file.
- **On the card before anything goes.** Before the card appears, the Navi's machine reads each file. The card lists
  each one by name, size and type, such as "lease.pdf 120 KB · PDF". A text file holding what looks like a password,
  key or token is refused instead, as the rest of the email would be.
- **Exactly the files you approved.** The machine hashes each file (SHA-256) when it makes the card, and the input you
  approve carries those hashes. When the email goes, each file is read again. If one changed since, nothing is sent,
  and the Navi is told to ask again.
- **Gmail's limit.** One email attaches at most 20 files of at most 25 MB together. Past that it's refused, saying how
  much the files come to, and the Navi sends fewer or smaller files, or several emails.
- **Typed by name.** Each file goes with the type its name gives: `application/pdf` for `.pdf`, `image/png` for
  `.png`, and so on. An unknown kind goes as `application/octet-stream`.

A draft carries files the same way, from the same folder, without a card: it sends nothing. A text file holding what
looks like a password, key or token is refused for a draft too, so it never reaches Drafts. You check the files in
Drafts before you send it.

What a read brings back from your mailbox, calendar or Drive comes back whole, as Google has it: no summary, no stripped
links. Above it is one line telling the Navi it's untrusted content, whose instructions come from whoever wrote it, not
from you.

## Set up the hub's Google client {#client}

The hub's admin does this once, in [Google Cloud Console](https://console.cloud.google.com/), with the Google account
that should own the app.

1. **Make a project**, or pick one, at the top of the console.
2. **Turn on the APIs.** Under **APIs & Services › Library**, enable **Gmail API**, **Google Calendar API** and
   **Google Drive API**.
3. **Branding.** Under **Google Auth Platform › Branding**, give the app a name (Navi) and your support email.
4. **Audience.** Choose **Internal** if everyone is in your Google Workspace. Otherwise choose **External** and press
   **Publish app** so its status is **In production**. While an External app is in **Testing**, Google ends each
   connection after 7 days and takes only the test users you list.
5. **Data access.** Add the scopes below. Gmail and Drive are restricted scopes, so an External app in production that
   Google hasn't verified shows a warning when someone connects. For your own accounts, press **Advanced**, then **Go to
   Navi**. An unverified app takes up to 100 people.

   | Scope | For |
   |---|---|
   | `openid`, `email` | Which account is connected. |
   | `https://www.googleapis.com/auth/gmail.readonly` | Searching and reading mail. |
   | `https://www.googleapis.com/auth/gmail.compose` | Drafts, sends and replies. It can't delete mail or change labels. |
   | `https://www.googleapis.com/auth/calendar.events` | Reading, making and changing events. |
   | `https://www.googleapis.com/auth/drive` | Searching, reading, uploading and sharing your files. `drive.file` would reach only files fleetd made. |

6. **Make the client.** Under **Google Auth Platform › Clients**, press **Create client** and choose the **Desktop app**
   type. Name it fleetd. Copy its **Client ID** and **Client secret**.
7. **Save it in fleetd**, in the app's **Settings › Hub accounts › Google**. Paste the Client ID and Client secret and press
   **Save and test**. The app seals the secret on your computer to each machine's key, so only their nodes can open it.
   Each machine keeps it in its home, and the hub keeps only a fingerprint. The secret is never shown again and is
   never in a chat or transcript.
8. **Test** runs at once, and again whenever you press it. A machine holding the client asks Google's token endpoint to
   redeem a code that can't work. Google answers `invalid_grant` for a client it knows, which Test reports as
   "Google knows this client and its secret", and `invalid_client` for one it doesn't.

Settings › Hub accounts › Google shows these steps with the values to copy: the project and app names for your hub, each scope,
the **Desktop app** type and the redirect URI. Once a client is saved, the page shows its ID, the machines holding its
secret and Test, and folds the steps away under **Save the client again, or replace it**. A machine that was offline
when you saved, or was added since, is named there: save the client again while it's online, so its Navis can connect.

Under the hood the app calls `google_client_set` and `google_client_test` ([hub tools](#hub-tools)).

There is no redirect URI to register. A Desktop app client takes `http://127.0.0.1` on any port. When someone connects,
the app listens on such a port on their own computer, and Google sends them back there. This works whatever address your
hub has. Google takes only https or loopback addresses as redirects, and a hub on plain http at a Tailscale name is
neither.

### Real-time mail {#pubsub}

Optional. Without it, a Navi whose mail wakes it still hears of new mail, within about a minute (see
[New mail wakes a Navi](#new-mail)). With it, new mail reaches the Navi in seconds. Do it in the same Cloud project as
the client. The hub needs no public address: one machine reads the subscription, the way a mail client checks for mail.

1. **Turn on Pub/Sub.** Under **APIs & Services › Library**, enable **Cloud Pub/Sub API**.
2. **Make the topic.** Under **Pub/Sub › Topics**, press **Create topic**, name it `fleetd-gmail`, and untick **Add a
   default subscription**. Its full name is `projects/<project>/topics/fleetd-gmail`.
3. **Let Gmail publish to it.** On the topic, open **Permissions**, press **Add principal**, enter
   `gmail-api-push@system.gserviceaccount.com` and give it the **Pub/Sub Publisher** role. Without it, a Navi's watch
   fails with a 403 that says so.
4. **Make the subscription.** Under **Pub/Sub › Subscriptions**, press **Create subscription**, name it
   `fleetd-gmail-hub`, pick the topic, and leave the delivery type at **Pull**. Its full name is
   `projects/<project>/subscriptions/fleetd-gmail-hub`.
5. **Make a service account to read it.** Under **IAM & Admin › Service accounts**, press **Create service account**,
   name it `fleetd-gmail-reader`, and grant it nothing at the project. On the subscription, open **Permissions** and
   give it the **Pub/Sub Subscriber** role. Then, on the service account, open **Keys › Add key › Create new key**,
   choose **JSON**, and keep the file it downloads.
6. **Save it in fleetd**, in the app's **Settings › Hub accounts › Google**, under **Real-time mail › Set up real-time mail**.
   The page shows these steps with the names to copy, and a Cloud Shell block that does steps 1 to 5 at once. Fill in
   the topic and the subscription (both prefilled with these names, in a project named for your hub), pick the machine
   that reads it under **Read on**, paste the JSON key and press **Save**. Pick a machine that is usually online, such
   as the hub's own, on a fleetd new enough for real-time mail. The app checks it's a service account's key and seals it
   on your computer to that machine's key. The machine keeps it in its home, and the hub keeps only a fingerprint. The
   key is never shown again. Delete the downloaded file afterwards.

Real-time mail then shows the subscription, the machine reading it and how new mail arrives: **By push** within
seconds, or **By checking about every minute for now** with why, while the machine is offline, its key is refused or
the subscription can't be read. Navis still hear of new mail each minute meanwhile, and it goes back to push by itself.
When the machine changes, the new one takes the key before the old one forgets it, so a refused key changes nothing.
**Turn off** asks first, then the machine forgets the key. Under the hood these are `google_pubsub_set` and
`google_get`'s `mailMode` and `mailProblem`.

## Connect a Google account {#connect}

A person connects their own account from their own computer, in the app: **Settings › Your accounts › Google**, the
Navi's row.

1. Press **Connect**. The dialog lists what Google will ask you to allow, and what to do about the warnings Google's
   own page can show. Press **Continue in browser**.
2. The app opens Google's consent page in your browser with the hub's client ID, the scopes `google_get` lists, a PKCE
   challenge, offline access and a redirect to `http://127.0.0.1:<port>`, a port it listens on.
3. Choose the account and leave every box ticked. A Navi without one of them says what it can't do.
4. Google sends the browser back to that port with the code. The page there says "Google is connected", and you can
   close the tab. The app itself calls `google_connect` with the code, its PKCE verifier and that redirect, so neither
   reaches the app's page or a chat. The dialog waits until then; **Cancel** stops it.

The row then shows the account, the day it connected and the scopes Google granted. A scope you unticked is named,
with **Reconnect** to grant it.

What the row says when Google can't be connected yet:

| The row says | Why | The fix |
|---|---|---|
| Ask an admin to set up Google | The hub has no OAuth client. | An admin saves one in Settings › Hub accounts › Google. An admin sees **Set up Google**, which opens it. |
| *machine* doesn't hold the hub's Google client | The Navi's machine was offline when the client was saved. | An admin saves the client again while that machine is online. |
| Needs reconnecting | Google stopped taking the connection ([below](#lapsed)). | **Reconnect** signs in again. |
| An error and its fix | The hub refused, or the Navi's machine is offline. | What the line says. |

The code and its verifier go through the hub to the Navi's machine. That machine redeems them with the client secret it holds and keeps the tokens. The hub
keeps the address and the scopes granted, never a token. The Navi gets its Google tools from its next start, after your
next message.

Google revokes access per account and client, every token of it at once. So fleetd revokes only what no other Navi on
the hub still uses:

- **Disconnect** on the Navi's Google row (`google_disconnect`) deletes the Navi's tokens from its machine and revokes
  its access at Google. The row then says what happened, such as Google not confirming the revoke. When another Navi uses
  the same account, the access stays, for that Navi. Disconnecting needs the machine online, because the tokens are there.
- Connecting again replaces the tokens. When it's to another account, the access to the old one is revoked, unless
  another Navi uses it.

### When Google stops taking the connection {#lapsed}

If you revoke access in your Google account, a Testing app's 7 days run out, or the admin saves a different client, the
next refresh fails. `google_get` then gives the Navi's account a `lapsed` reason, and the Navi's Google row says
**Needs reconnecting** with that reason and **Reconnect**. The Navi is told plainly to ask you to connect again, and
nothing is sent.

A client secret saved wrong lapses nothing: the Navi is told the hub's client was refused. The first refresh after the
admin saves the right secret works again.

## New mail wakes a Navi {#new-mail}

A person chooses, per Navi, when new mail wakes it: on its row in **Settings › Your accounts › Google**, once connected, **New mail
wakes this Navi** is **Off**, **All new mail** or **Matching a search**. Off and All save at once; a search saves with
its **Save** button. While it's on, the row says how mail arrives: by push, or by checking about every minute and why.
Under the hood this is `google_mail_set`:

| Rule | Wakes the Navi on |
|---|---|
| `off` (the default) | Nothing. It reads mail when you ask. |
| `all` | Each new message that arrives in Gmail's main mailbox, not archived by a filter or marked as spam. |
| `query` | Only such new mail that matches a Gmail search, such as `from:boss@example.com OR is:important`. |

How the hub hears of it:

- **Push**, with [real-time mail](#pubsub) set up. The Navi's machine asks Gmail to watch for new mail (`users.watch`)
  and tell the topic. A watch lasts 7 days, and the hub renews it a day before it ends. The machine holding the service
  account key reads the subscription and acknowledges each notice. A notice names an address, and the hub has the
  machine of each Navi connected to it check that Navi's mail. While Gmail won't watch a Navi's mail (the topic lacks
  the Publisher grant, or a scope was unticked), the hub checks that Navi's mail every minute instead.
- **Polling**, without Pub/Sub, or while reading it fails or no read has worked for 2 minutes. The hub checks each such
  Navi's mail about every minute. It goes back to push with the next good read.

A check reads the mailbox's history since the last one, and a Navi's checks take turns, so nothing is missed or told
twice when the hub moves between push and polling. A check reads up to 20 new messages and counts the rest. The first
check only marks where to start. Sent mail and drafts don't wake anyone.

The wake reaches the Navi's lead as one event: for each message (up to 10, then a count), its sender, subject, start
and thread. Above them is a line saying it's from the mailbox and untrusted, whose instructions are its sender's, not
yours. Each message stays on its own line, so a subject can't pass as fleetd's words. The Navi reads the whole thread
with `get_thread`, and anything it sends still asks you with its card.

## Where the secrets live {#files}

On the Navi's machine, under the node's home (`~/.fleetd/node`), each file at mode 0600:

| File | Holds |
|---|---|
| `google/client.json` | The client ID and secret. |
| `google/accounts/<project>.json` | One Navi's tokens and address. |
| `google/pubsub.json` | The subscription and the service account's JSON key, on the machine that reads it. |
| `google/mail/<project>.json` | Where the Navi's last mail check stopped, a Gmail history id. |

None is inside the Navi's folder. The Navi's MCP config starts the server as the node's own fleetd binary in its
`google-mcp` mode, given the node's home, the project and the Navi's folder, never a token. The server reads the tokens from these files
and refreshes them in place. Removing a Navi's project from its machine deletes its tokens.

## Hub tools {#hub-tools}

The app calls these, and only a person's key may change anything:

| Tool | Does |
|---|---|
| `google_get` | The hub's client (no secret), a Navi's account with whether it lapsed and its mail rule, the scopes, the redirect, and whether new mail comes by push or polling. |
| `google_client_set` | Saves the client, its secret sealed to each machine. Needs operate on every machine. |
| `google_client_test` | Asks Google whether it takes the client. |
| `google_connect` | Hands a code, its PKCE verifier and its loopback redirect to the Navi's machine. Needs operate on that machine. |
| `google_disconnect` | Revokes the Navi's grant and deletes its tokens. |
| `google_pubsub_set` | Saves real-time mail: the topic, the subscription, and the service account key sealed to the machine that reads it. Needs operate on every machine. |
| `google_mail_set` | Sets when new mail wakes a Navi: `off`, `all` or `query`. Needs operate on the Navi's machine. |
