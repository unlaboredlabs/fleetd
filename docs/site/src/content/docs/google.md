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
| `create_draft` | Saves a draft in Gmail. Nothing is sent. | Unasked |
| `send_message` | Sends an email. | Asks you |
| `reply` | Replies in a thread to the recipients it names. | Asks you |
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
recipient, the subject and the whole body, read from the exact input the tool runs with. The tool sends exactly what
you approved. fleetd doesn't rewrite it or block links. Refused even with approval: something that looks like a
password, key or token, and an email with attachments, which aren't supported yet. You're never asked to approve a
send that would fail. To pass a file on, the Navi can share it from Drive.

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
7. **Save it in fleetd** with `google_client_set`: the client ID, and the secret sealed to each machine that runs Navis.
   Each machine keeps it in its home, and the hub keeps only a fingerprint.
8. **Test it** with `google_client_test`. A machine holding the client asks Google's token endpoint to redeem a code
   that can't work. Google's answer shows whether it knows the client and its secret.

There is no redirect URI to register. A Desktop app client takes `http://127.0.0.1` on any port. When someone connects,
the app listens on such a port on their own computer, and Google sends them back there. This works whatever address your
hub has. Google takes only https or loopback addresses as redirects, and a hub on plain http at a Tailscale name is
neither.

### Real-time mail {#pubsub}

Optional. Without it, a Navi whose mail wakes it still hears of new mail, within about a minute (see
[New mail wakes a Navi](#new-mail)). With it, new mail reaches the Navi in seconds. Do it in the same Cloud project as
the client. The hub needs no public address: one machine reads the subscription, the way a mail client checks for mail.

1. **Turn on Pub/Sub.** Under **APIs & Services › Library**, enable **Cloud Pub/Sub API**.
2. **Make the topic.** Under **Pub/Sub › Topics**, press **Create topic**, name it `navi-mail`, and untick **Add a
   default subscription**. Its full name is `projects/<project>/topics/navi-mail`.
3. **Let Gmail publish to it.** On the topic, open **Permissions**, press **Add principal**, enter
   `gmail-api-push@system.gserviceaccount.com` and give it the **Pub/Sub Publisher** role. Without it, a Navi's watch
   fails with a 403 that says so.
4. **Make the subscription.** Under **Pub/Sub › Subscriptions**, press **Create subscription**, name it `navi-mail`,
   pick the topic, and leave the delivery type at **Pull**. Its full name is
   `projects/<project>/subscriptions/navi-mail`.
5. **Make a service account to read it.** Under **IAM & Admin › Service accounts**, press **Create service account**,
   name it `navi-mail`, and grant it nothing at the project. On the subscription, open **Permissions** and give it the
   **Pub/Sub Subscriber** role. Then, on the service account, open **Keys › Add key › Create new key**, choose **JSON**,
   and keep the file it downloads.
6. **Save it in fleetd** with `google_pubsub_set`: the topic, the subscription, the machine that reads it, and the JSON
   key sealed to that machine. Pick a machine that is usually online, such as the hub's own. The machine checks the key
   and keeps it in its home, and the hub keeps only a fingerprint. Delete the downloaded file afterwards.

`google_get` then says `mailMode: push`. While the machine is offline, its key is refused, or the subscription can't be
read, it says `polling` and `mailProblem` says why, and Navis still hear of new mail each minute. `google_pubsub_set`
with no `pubsub` turns it off, and the machine forgets the key.

## Connect a Google account {#connect}

A person connects their own account from their own computer:

1. The client there (the app) opens Google's consent page with the hub's client ID, the scopes `google_get` lists, a
   PKCE challenge and a redirect to `http://127.0.0.1:<port>` on a port it listens on.
2. The person chooses the account and leaves every box ticked. A Navi without one of them says what it can't do.
3. Google sends the browser back to that port with a code, and the client calls `google_connect` with the code, its
   PKCE verifier and that redirect.

The code and its verifier go through the hub to the Navi's machine. That machine redeems them with the client secret it holds and keeps the tokens. The hub
keeps the address and the scopes granted, never a token. The Navi gets its Google tools from its next start, after your
next message.

Google revokes access per account and client, every token of it at once. So fleetd revokes only what no other Navi on
the hub still uses:

- `google_disconnect` deletes the Navi's tokens from its machine and revokes its access at Google. When another Navi uses
  the same account, the access stays, for that Navi. Disconnecting needs the machine online, because the tokens are there.
- Connecting again replaces the tokens. When it's to another account, the access to the old one is revoked, unless
  another Navi uses it.

### When Google stops taking the connection {#lapsed}

If you revoke access in your Google account, a Testing app's 7 days run out, or the admin saves a different client, the
next refresh fails. `google_get` then gives the Navi's account a `lapsed` reason, and the person connects again. The Navi
is told plainly to ask you to connect again, and nothing is sent.

A client secret saved wrong lapses nothing: the Navi is told the hub's client was refused. The first refresh after the
admin saves the right secret works again.

## New mail wakes a Navi {#new-mail}

A person chooses, per Navi, when new mail wakes it, with `google_mail_set`:

| Rule | Wakes the Navi on |
|---|---|
| `off` (the default) | Nothing. It reads mail when you ask. |
| `all` | Each new message in the inbox. |
| `query` | Only new inbox mail matching a Gmail search, such as `from:boss@example.com OR is:important`. |

How the hub hears of it:

- **Push**, with [real-time mail](#pubsub) set up. The Navi's machine asks Gmail to watch the inbox (`users.watch`) and
  tell the topic. A watch lasts 7 days, and the hub renews it a day before it ends. The machine holding the service
  account key reads the subscription and acknowledges each notice. A notice names an address, and the hub has the
  machine of each Navi connected to it check that Navi's inbox.
- **Polling**, without Pub/Sub, or while reading it fails or no read has worked for 2 minutes. The hub checks each such
  Navi's inbox about every minute. It goes back to push with the next good read.

A check reads the inbox's history since the last one, so nothing is missed or told twice when the hub moves between
push and polling. The first check only marks where to start. Sent mail and drafts don't wake anyone.

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
`google-mcp` mode, given the node's home and the project, never a token. The server reads the tokens from these files
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
