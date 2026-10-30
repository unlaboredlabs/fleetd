---
title: Navi
description: "Personal assistants inside fleetd: make as many Navis as you like, each with its own chat, memory, folder and approvals."
---

A Navi is a personal assistant. It chats with you, remembers what matters, keeps your to-dos, reads the web, uses
screens, and works in a folder of its own. Make as many as you like: one for home, one for taxes, one for a side
project. Each is separate, with its own chat, memory and folder.

Under the hood a Navi is a [project](/docs/projects) with no repo, whose lead runs as an assistant. So it gets what
every project has, unchanged: [chat](/docs/chat), memory and its nightly refresh,
[automations](/docs/automations), [screens](/docs/browser-sessions), the checklist and
[approvals](/docs/approvals-and-secrets).

## Yours alone {#yours}

Each Navi belongs to the person who made it. Only you see your Navis, in the sidebar, on the Navi page and under
**Hubs › Hub links**. Only you use them: their chat and approvals, integrations and other tools, hub links, allowed
sites, sign-ins, settings, archive and delete. The hub refuses everyone else, admins included. An admin can only delete the Navi of someone removed from the hub. On a hub from before people, Navis made earlier
belong to the person whose device made them, else the hub's owner.

## In the app

Your Navis are pinned at the top of the sidebar, above Projects. With none yet, the sidebar shows **Meet Navi**. It
opens a page that says what Navi does, with a name box and one button, **Create your Navi**. Leave the name empty
and it's called Navi. Its chat opens once it's ready.

- **New** beside the Navi heading makes another one.
- A Navi's right-click menu has **Rename…**, **Open settings**, **Copy folder path** and **Archive**.
- Archive takes effect at once, with **Undo** in the notice. Archived Navis are listed on the Navi page (**New**
  opens it), each with **Bring back**.
- ⌘1–9 (Ctrl on Linux and Windows) number the Navis first, then the projects.

A Navi's chat is the project chat, framed for an assistant. The title is its name, and the box says *Message Ada*.
The gear beside its name opens its settings, where its memory and automations are kept. A
send or any other approval shows in the chat with **Approve** and **Deny**. The sidebar marks the Navi *approve*
until you answer.

The panel beside the chat has a Navi's own sections:

| Section | Shows |
|---|---|
| Asked | The work this Navi asked your other projects for, newest first. Each item shows the project (click to open its chat), when it was asked, the Navi's words, and each order opened for it (*In progress* with its latest headline, *Done* or *Stopped*). |
| Screens | The browsers and devices it uses, once your hub serves screens. |
| Plan | Its checklist. |
| History | What happened, and what you and the Navi decided. |

Asked shows on a hub that serves `navi_asks`. On any other hub, a Navi still tells you in its chat when work it asked
for lands.

## Make one from the terminal

```sh
fleetd navi create Ada
```

```text
✓ Ada is ready on devbox, in ~/.fleetd/node/navi/ada
Say hello in the app, or: fleetd chat devbox/3f2a… "hello" --key-file <your human key>
```

The Navi's lead starts with your first message. Its folder is `navi/<name>` under the machine's fleetd home, made
on the spot. A second Navi with the same name gets `ada-2`. `--machine <id>` picks the machine; by default it's the
least busy worker.

| Command | Does |
|---|---|
| `fleetd navi create <name>` | Make a Navi. |
| `fleetd navi list [--archived]` | The Navis, oldest first; `--archived` includes archived ones. |
| `fleetd navi rename <machine>/<navi> <name>` | Rename it. Its folder keeps its first name. |
| `fleetd navi archive <machine>/<navi>` | Stop its lead and set it aside. Its chat, memory and folder stay. |
| `fleetd navi unarchive <machine>/<navi>` | Bring it back. Its lead starts with your next message. |

`<navi>` is its id or its name. A message to an archived Navi waits until you bring it back.

## What it does on its own, and what it asks first

A Navi searches the web freely, and reads what its [integrations](/docs/integrations) hold and the factory's status. It
also writes drafts and notes in its folder, remembers and forgets, keeps its checklist, works screens and logs in with 1Password.

- **Files:** it reads and writes what you can on the machine, except your keys and logins (`~/.ssh`, `~/.config`
  and the rest), fleetd's own directory and other Navis'. What runs outside its sandbox later stays read-only, so it
  can't plant code that reads your keys: your shell's startup files, your programs (`~/.local/bin`, `~/.cargo/bin`,
  Homebrew's and the rest), git's config and hooks and the `.claude`, `.fleetd`, `.mcp.json` and `CLAUDE.md` of every
  project's checkout, and its own settings in its folder. If a checkout is moved aside and replaced, no lead or agent
  starts there until you check it and run `fleetd node trust <folder>` ([Security](/docs/security#navi-sandbox)). A policy
  file's allow rules don't apply to a Navi at all.
  Its folder is where its notes, drafts and downloads go.
- **Its own home:** each Navi has a home of its own, kept between sessions, where npm's global installs, `pip install --user`,
  `cargo install` and install scripts put what they install, on its `PATH`. What it starts in the background with
  `nohup` or `setsid` keeps running after its turn, until the machine or the node restarts. It has no root, `apt` or
  systemd services.
- **Sandbox:** a Navi's Claude Code and every command, MCP server and tool it starts run in an OS sandbox that holds
  those lines whatever a command tries ([Security](/docs/security#navi-sandbox)).
- **Commands:** its shell commands run without asking (decision `navi.shell-unasked`, D208). The sandbox is the
  guard. The one exception is a browser command that opens a site, which goes through the site rule below.
- **Sites:** a link you write in your own chat message is allowed as you send it, so the Navi fetches or opens it
  without asking. A link it finds itself, or reads in an email or on a page, isn't. The first time it fetches a page or
  opens a site in its browser, you're asked in its chat, with the site named. Approve once and it fetches and opens
  that site unasked from then on. In a browser command the URL must stand alone, plain or in single quotes
  (`agent-browser open 'https://example.org/a?b=c'`). Double quotes, shell characters, an `agent-browser open` inside
  a longer command, or a flag that changes the browser (`--session`, `--cdp`) asks each time. `www.` is the same site,
  a subdomain is another, and `localhost` is a site per port (`localhost:3000`). Only `http` and `https` name a site:
  `file:`, `data:`, `about:` and other schemes ask every time. The MCP tools `navi_sites` and `navi_site_revoke` list
  a Navi's sites, those from your links included, and take one back; a revoked site asks again.

**When the sandbox can't start, the Navi doesn't run.** Its chat says why and how to fix it. On Linux a Navi needs
bubblewrap: install it (`sudo apt install bubblewrap`, `sudo dnf install bubblewrap`, `sudo pacman -S bubblewrap`).
On Ubuntu 23.10 and later, AppArmor may also block the user namespaces bubblewrap uses; `bwrap --ro-bind / /
--unshare-all true` says so, and Ubuntu's `apparmor` package has a profile that allows them
(`/etc/apparmor.d/bwrap-userns-restrict`). A setuid-root `bwrap` (`ls -l $(which bwrap)` shows `rws`) runs unprivileged
for a Navi, so it needs unprivileged user namespaces too (on Debian before 11: `sudo sysctl
kernel.unprivileged_userns_clone=1`). A Mac uses its built-in `sandbox-exec`.

Anything hard to undo, or that someone else sees, waits for you every time: sending an email or message, accepting an
invite, making or changing a calendar event, uploading or sharing a file, spending, posting publicly, deleting,
signing or accepting terms, changing a password. There is no "always allow". Through an integration that's fleetd's
rule. Through a command, a site or a screen it's the Navi's instruction: it runs such a command with `gated_run`,
which asks with exactly that command.

This is enforced outside the model. A Navi's lead runs in Claude Code's `manual` permission mode with a short
allow-list ([Agent tools](/docs/reference/agent-tools#claude-code-tools)). Its file tools and fetches always raise a
permission prompt, whatever your own Claude Code settings allow. The node answers the file tools and the shell
commands. Every other prompt goes to the hub, which allows a site you allowed before or linked in your message.
Anything else becomes an approval in the Navi's chat, with the tool and exactly what it would get: the recipients, the
full text. **Approve** runs the tool with exactly that input. **Deny** tells the Navi you said no, with your reason if
you give one. A prompt that goes away on its own (the run ended) closes its approval. Moving money, trading and
creating accounts through an integration are blocked even if approved.

**What commands and screens can still do.** The site gate covers fetching and opening a site; it doesn't follow a page
after that, or a command's own network use. Browser commands inside an open page run unasked: clicks, fills, typing,
snapshots, a script in the page. A command such as `curl` reaches the network unasked too: the sandbox limits what a
command writes and reads, not where it sends. So commands and screens aren't held to the approval rule for sends, and
a click or a form that leads to another site isn't asked. Its Android, iOS and desktop screens (`agent-device`) don't
ask per site at all. Nor is the final Send or Pay button on a site you allowed: that final click is left to you by
instruction only. The Navi is told to hand it to you with a takeover, but that's its prompt, not fleetd's rules. Only
allow sites where that's fine, such as your bank's when you mean to watch.

## Sign-ins {#sign-ins}

A Navi's browser stays signed in. Sign in to a site once, yourself in a takeover or by the Navi, and its next browser
session is still signed in there. No login page, captcha or approve-on-your-phone step each time.

- **What's kept:** the browser's cookies and site data (local storage, IndexedDB), in a browser profile of the Navi's
  own. Its history, cache, open tabs, saved passwords and form entries are not kept. Logins filled from 1Password
  aren't saved either: each session that fills one still refuses to read it back.
- **Where:** on the Navi's machine, under fleetd's node directory (`browser/navis/<project id>`). The Navi's sandbox
  hides that directory, so the Navi's commands can't read the cookies. Only the browser fleetd starts for it uses them.
- **Whose:** that Navi's alone. Another Navi, a project's agents and the browser in a preview each start with a fresh,
  empty profile that is thrown away when the session ends.
- **One at a time:** one browser runs on the profile. If the Navi opens a second session while one is open in another
  of its chats, the second is refused until the first ends.
- **Its machine only:** a Navi's browser always runs on the Navi's own machine, where its profile and folder are,
  never on another one the hub would pick.
- **Files:** the browser touches no file on the machine outside the Navi's folder. It opens no `file://` page, whether
  asked for, linked to or redirected to. It uploads only files in the folder, not through a link out of it. It saves
  downloads only in the folder itself, each under a name of the browser's own so no site overwrites a file there;
  `agent-browser download <ref> ./<name>` saves one under the name you give. A project's agents keep the browser as
  before.

**To sign it out of everything,** open the Navi's settings (**Open settings** in its right-click menu), find
**Sign-ins** and click **Forget sign-ins…**. A browser session it has open now ends, and the profile is deleted. Its
chat, memory, folder and allowed sites stay. Deleting the Navi deletes its sign-ins too. To sign out of one site only,
ask the Navi to sign out there.

## Hub links {#hub-links}

A Navi can open and follow work in projects on another hub, such as a team hub when the Navi lives on your personal
one. You make a link key on the hub it reaches and add it to the Navi. It acts as you there, and either side can
revoke it. [Security](/docs/security#hub-links) has the rules.

**On the hub it reaches.** Open **Settings › Hubs**, **Hub links**, **Links to this hub** (with several hubs, *Links to* that hub), and click **Make a link key**:

1. Name the other hub as you think of it, such as *home*. Requests through the link read "*you* via home Navi"
   there.
2. Leave **Every project you can reach**, or pick **Only some projects** and tick them.
3. **Make link key** shows the key (`flk_…`) once. **Copy** takes it with the address other hubs reach this hub
   at: its HTTPS or tailnet URL. When the hub has no such address set, type it in the box that appears.

The list below shows the links made as you: what each is for, its projects, when it was last used, and **Revoke**.
An admin sees everyone's on **Settings › Hub › People**, under **Hub links**, each with the person it acts as.

**On the Navi's hub.** Open **Settings › Hubs**, **Hub links**, **Linked hubs**, and click **Link a
hub**. Paste what you copied into **Link key**: the address fills itself. Name the hub as the Navi should call it
(*acme*), then click **Link hub**. The app seals the key to this hub, which checks it with the other hub and never
shows it again. Then tell the Navi what you want ("ask the Shop lead on acme for saved carts"). It follows the
order and tells you when it lands.

Each linked hub shows its address, the person it acts as there and its projects (*only Shop, Website*, or *every
project of theirs*), and one word for its state:

| State | Means |
|---|---|
| Working | Its last call went through. |
| Can't reach | This hub can't reach the other one. The row gives the address and the reason, such as *connection refused*. A link needs the other hub reachable from this one over a tailnet or HTTPS. |
| Revoked | The other hub refused the key: it was revoked there, or you left that hub. Remove it, or make a new key there and add it. |

**Remove** deletes the key at once and asks the other hub to revoke it too. When that hub doesn't answer, the
notice says so: its link stays listed there until someone revokes it, but nothing can use it.

## Memory

A Navi keeps your private life (family, health, money, accounts) in its own memory, never in your user memory.
The agents of every piece of work you start read your user memory, so it holds only how you like to work. The nightly refresh tidies a Navi's memory as
it does any project's.

## Earlier in the chat {#earlier}

A Navi's new session sees only the latest part of its chat, but the hub keeps all of it. When you mention something
from before ("the dentist I told you about", "what we settled last week"), the Navi searches the whole chat by words,
within dates when you give them, and reads the messages around what it finds. It reads only its own chat, never
another project's or another person's Navi's. The tools are `chat_search` and `chat_read`, in
[Agent tools](/docs/reference/agent-tools).

## For the app and other clients

Navis are MCP tools on the hub: `navi_create {name, machineId?}`, `navi_list {archived?, machineId?}`,
`navi_rename {machineId, projectId, name}`, `navi_archive {machineId, projectId, archived?}`,
`navi_sites {machineId, projectId}` and `navi_site_revoke {machineId, projectId, site}`. A Navi's or project's
picture is `project_avatar_set {machineId, projectId, attachmentId?, crop?}` (an image from `attachment_put` and the
square to keep; no `attachmentId` removes it) and `project_avatar_get {machineId, projectId}`; a summary's `avatar`
names the one it has. Each returns the
Navi as a project summary with `kind: "assistant"`, `createdBy` (the id and name of the key that made it) and, once
archived, `archivedAt`. Every other project has no `kind`. Talk to a Navi with `chat_send`, as to any project.
`navi_asks {navi}` lists what a Navi asked other projects for, with the orders opened for each, on a hub whose ready
frame names the `navi_asks` feature. `navi_signins_forget {machineId, projectId}` forgets a Navi's
[sign-ins](#sign-ins); it needs the Navi's machine online and on a fleetd that keeps them. Hub links are `hub_links_get {navi?}`, `hub_link_mint {label, projects?}`,
`hub_link_revoke {linkId}`, `hub_link_add {navi, label, url, sealed}` (the key sealed to `boxPubKey` from
`hub_links_get`) and `hub_link_remove {linkId}`.
