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

## Make one

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

A Navi searches the web freely, and reads your connected mail, calendar and files and the factory's status. It also
writes drafts and notes in its folder, remembers and forgets, keeps its checklist, works screens and logs in with
1Password.

- **Files:** it reads and writes only inside its own folder. A read or an edit anywhere else is refused, whoever
  approves it, so your keys, its MCP servers' tokens and other projects stay out of its reach. It can't change its own
  Claude Code settings, MCP servers or fleetd policy in its folder either (`.claude`, `.mcp.json`, `.fleetd`), and a
  policy file's allow rules don't apply to a Navi at all.
- **Sites:** the first time it fetches a page or opens a site in its browser, you're asked in its chat, with the site
  named. Approve once and it fetches and opens that site unasked from then on, with a plain URL: one with `?` or
  `&`, quotes or other shell characters in a browser command asks each time. `www.` is the same site, a subdomain is
  another, and `localhost` is a site per port (`localhost:3000`). Only `http` and `https` name a site: `file:`,
  `data:`, `about:` and other schemes ask every time. The MCP tools `navi_sites` and `navi_site_revoke` list a
  Navi's sites and take one back; a revoked site asks again.

Anything hard to undo, or that someone else sees, waits for you every time: sending an email or message, accepting
an invite, spending, posting publicly, deleting, signing or accepting terms, changing a password. There is no
"always allow".

This is enforced outside the model. A Navi's lead runs in Claude Code's `manual` permission mode with a short
allow-list ([Agent tools](/docs/reference/agent-tools#claude-code-tools)). Its file tools and fetches always raise a
permission prompt, whatever your own Claude Code settings allow. The node answers the file tools. Every other prompt
goes to the hub, which allows a site you allowed before. Anything else becomes an approval in the Navi's chat, with
the tool and exactly what it would get: the recipients, the full text. **Approve** runs the tool with exactly that
input. **Deny** tells the Navi you said no, with your reason if you give one. A prompt that goes away on its own (the
run ended) closes its approval. Moving money, trading and creating accounts through an integration are blocked even
if approved.

**What screens can still do.** The site gate covers opening a site; it doesn't follow a page after that. Inside a
page it already opened, a Navi clicks, types and fills unasked, which is how screens work, so a click or a form that
leads to another site isn't asked. Its Android, iOS and desktop screens (`agent-device`) don't ask per site at all.
Nor is the final Send or Pay button on a site you allowed. The Navi is told to hand that last click to you with a
takeover, but that's its prompt, not fleetd's rules. Only allow sites where that's fine, such as your bank's when you
mean to watch.

## Memory

A Navi keeps your private life (family, health, money, accounts) in its own memory, never in `user.md`. Every
project's lead reads `user.md`, so it holds only how you like to work. The nightly refresh tidies a Navi's memory as
it does any project's.

## For the app and other clients

Navis are MCP tools on the hub: `navi_create {name, machineId?}`, `navi_list {archived?, machineId?}`,
`navi_rename {machineId, projectId, name}`, `navi_archive {machineId, projectId, archived?}`,
`navi_sites {machineId, projectId}` and `navi_site_revoke {machineId, projectId, site}`. Each returns the
Navi as a project summary with `kind: "assistant"`, `createdBy` (the id and name of the key that made it) and, once
archived, `archivedAt`. Every other project has no `kind`. Talk to a Navi with `chat_send`, as to any project.
