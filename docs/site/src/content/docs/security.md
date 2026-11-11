---
title: Security model
description: What fleetd trusts, how keys and secrets move, and how to report a vulnerability.
---

What fleetd trusts and why. fleetd is built for one person or a small team running their own fleet.

## Network {#network}

| Rule | Detail |
|---|---|
| The hub is never public by default | `fleetd init` listens on your tailnet address, or on `127.0.0.1` without Tailscale. |
| Plain HTTP only on loopback or a tailnet | Tailscale's tunnel is encrypted. Anywhere else, put HTTPS in front: see [the HTTPS check](/docs/troubleshooting#hub). |
| Nodes connect out | A worker's node connects to the hub and proves itself with its own key pair. No worker opens a port beyond loopback: the [browser proxy](/docs/browser-sessions#isolation) listens on `127.0.0.1` only, with a token per agent session. |
| Codes are one-time | Enrollment tokens and pairing codes work once and expire after 15 minutes; an [invite](/docs/people#invite) works once, for 7 days. [The agents' Mac's](/docs/agents-mac#app) 6-digit setup code works once, for 10 minutes, one at a time; it goes to one hub only, and ten wrong codes tried while it's open close it (5 a minute per address), never locking the hub. |

## Keys {#keys}

| Key | How it is protected |
|---|---|
| [Agent key](/docs/glossary#agent-key) (`fld_…`) | Shown once. The hub stores only its hash and prefix. A revoked key stops on its next request. |
| [Human key](/docs/glossary#human-key) | Held by a person's device. The desktop app encrypts it with the OS keychain or keyring; without one, it is a file only you can read (`0600`). |
| Node key | `~/.fleetd/node/node-key.pem` on each worker. |

Each key has `read`, `operate` or `admin` rights, on every machine or a named list. Only human keys enter secrets
and approve commands, so no agent can approve itself.

A pairing code carries the role it was printed with: `fleetd pair` gives the device `admin` on every machine, so the
person at the hub can change its settings from the app, and `fleetd pair --role read` or `--role operate` gives a
lesser device less. The role is fixed when the code is made; the device that redeems it cannot ask for more. A key
paired before keeps its role: if the app says it lacks `admin`, run `fleetd pair` on the hub machine and pair again.
The desktop app's Pair a phone makes the same kind of code (one use, 15 minutes) for a phone of yours. The phone gets
no more than the role of the device that made the code. Its QR holds only the hub's address and that code.

Agents run as the same OS user as the hub, so anything that can read the hub home (its keys and its database) an
agent can reach too. Human key files are no exception: keep yours outside the hub home and your projects, but don't
count on that to stop an agent that goes looking. [What an agent can reach](#agent-reach) says what that means on a
machine, and how fleetd keeps it small.

### The node socket {#node-socket}

Lead-side calls reach the hub through `~/.fleetd/node/node.sock` (mode `0600`). The node tells who is calling from
the process tree, not from anything the caller says:

| Caller | Acts as |
|---|---|
| A process that descends from a session's `claude` (its tools, its shell commands) | That session, a lead or a task, on its own project only. |
| Any other process | You, on the project whose workspace holds its working directory. |

A task can't start, steer or stop agents, and a call that names another session is refused.

:::caution[Known limit]
A process that deliberately leaves its session's process tree (for example with `setsid`) and scrubs its environment
is treated as you. Any process of the node's OS user can do what that user can. Run agents you don't trust as a
different OS user.
:::

### The fleetd CLI inside a session {#cli-in-session}

On the hub's machine the `fleetd` CLI acts with the hub home's own admin key (`cli.key`), and some commands
(`fleetd hub key`, `people`, `pair`, `prompts`, `vault`) write the hub's database and key files directly. A person
at their terminal keeps all of that. Inside an agent's session, the CLI talking to that session's node's own hub only
reads: `status`, lists and history work, and anything that would change the hub (a tool above `read`, a chat
message, a key, a prompt edit, the vault's key, adding or removing a machine) is refused with one line. It says what
works instead: the lead's own fleetd tools set up its project (`repo_add`, `repo_remove`, `project_setup`) and
propose a new one (`project_propose`), and a task asks its lead. A hub the session started itself, with its own
`FLEETD_HOME`, keeps working in full, writes included.

:::caution[A rail, not a wall]
This stops an agent changing the hub by accident through the CLI, as one did on a test it forgot to point at its own
throwaway hub. It doesn't stop one that means to: an agent on the hub's machine runs as the same OS user, so it can
still read the hub home's files, `cli.key` and the database among them, and use them without the CLI. A real wall is
the hub running as a separate OS user, which fleetd doesn't set up.
:::

## What an agent can reach on a machine {#agent-reach}

An agent runs as the OS user its machine's node runs as, which is usually you, with no sandbox (as
[leads run](#how-leads-run)). So on its machine it can reach what you can:

- your files: your home, your projects, and any key or token kept in them;
- your logins there: `gh`, your SSH keys and agent, git's credentials, and other CLIs you have logged in;
- fleetd's own files in `~/.fleetd`: the node's key, and the secrets the node holds for the work it runs: projects'
  secret variables, Claude tokens, and each person's sealed 1Password service account token. On the hub's machine,
  that includes the [vault](#vault)'s root key and database, so the whole vault.

fleetd keeps those values out of agents' environments and transcripts, but an agent that goes looking can read the
files they are in. Keeping agents out takes a separate OS user, which fleetd doesn't set up on its own (on the agents'
Mac it is [an optional step](/docs/agents-mac)). So fleetd keeps what those tokens open small instead:

- **1Password reads one vault.** fleetd's service account reads exactly one vault, made for fleetd, holding only the
  logins agents sign in with and the card a project buys with. A service account reads only the vaults it was made with,
  and 1Password can't add more later, so whatever else is in your 1Password stays out of reach even of an agent that
  reads the token.
- **A card that can't cost much.** Keep a virtual card with a monthly limit, or a low-limit card, in that vault: never
  your main card.
- **Checked.** The [1Password setup step](/docs/quick-start#setup-steps) and the doctor's `hub/onepassword_vault`
  check read each saved token's last Test: the names of the vaults it reads, never an item. One vault passes. More,
  or none, wants a look, with what to do: make a service account that reads only fleetd's vault, paste its token, and
  revoke the old one ([troubleshooting](/docs/troubleshooting#hub)). Test lists the vaults with that person's own token
  on a machine holding it.
- A project's own `OP_SERVICE_ACCOUNT_TOKEN` variable is a secret the hub never tests: make it the same
  way, one vault of its own.

Run agents on machines with nothing else on them you'd mind them reading, and keep the rest of your 1Password in
vaults fleetd's service account doesn't read.

## People {#people}

Every human key belongs to a [person](/docs/people) with a hub role: owner, admin or member. A device never holds
more than its person's role allows: a member's device operates, even one paired with `admin`. Only owners and admins
invite people, change roles and change hub-wide settings, and the hub always keeps an owner. Removing a person
revokes all their devices at once, and with them the [hub links](#hub-links) they made.

Chat messages, approvals, secrets, decisions and checklist changes record the person, next to the device as
before. A shared project is open to everyone on the hub, so give a hub only to people you trust with every shared project
on it. An [Only me](/docs/projects#only-me) project is the exception: the hub shows and serves it only to its owner,
admins included. An admin may only turn its Only me off, or delete one of a person since removed. The hub's operator, and any agent on the hub machine, can read the hub's database: fleetd records who did what,
but it keeps nothing private from them.

## Claude accounts {#claude}

The hub's API key and each person's subscription token (see [Claude accounts](/docs/people#claude)) go the way of
every other secret:
- The app seals the value to each machine's key. The hub relays the boxes and keeps only each machine's fingerprint,
  never the value. No agent key can set, read or test them.
- The node keeps the value in a 0600 file in its home. It passes it only to the claude processes of work on that
  account, and masks it in everything those sessions report, transcripts included.
- A session on an account drops the machine's own key, token and gateway variables, so they can't outrank it. One
  whose account the node no longer holds fails to start; it never falls back to the machine's own login. A node too
  old to run accounts gets no work on one.
- One person's subscription runs only work they started, or their Only me projects. Removing a person forgets their token on
  every machine.

Like project secrets, the value is in the claude process's environment. Any process of the node's OS user can read
it, so the machine's owner and any agent running there could reach it, as [People](#people) says of the hub.

## The vault {#vault}

The [vault](/docs/vault) keeps logins, cards, addresses and variables encrypted on the hub.

- **At rest.** Each item is sealed with AES-256-GCM under a data key of its own, made new at every change, and that
  key is wrapped by the vault's root key. Each ciphertext is bound to its item, kind, scope and version, so one moved
  into another row or scope doesn't open. The root key is in `~/.fleetd/vault/root.key` (0600 in a 0700 folder),
  outside `~/.fleetd/hub`, or in the system keychain, or behind a passphrase. A copy of the hub's database alone
  opens no value; it does show labels, login sites, a card's brand and last four digits, an address's country,
  variable names, secret fingerprints and the activity log.
- **In transit.** The app seals what you type to the hub's own box key, even inside TLS. The hub seals a fill or a
  variable to the one node that uses it, and a reveal to a one-time key the app makes for it.
- **Use.** A fill goes only to the node hosting that browser session, for an item the session's project, order or
  person may use, on one of the item's sites; cards only at a purchase recorded in that session. Fills are rate-limited
  and every use, refusal and reveal is in the activity log, never with a value. Agents have no tool to show, create,
  change, delete or share an item.
- **Reveal.** Only from a person's device, by the item's owner (for a project's, its creator or an admin; for the
  hub's, an admin), behind Touch ID or a system confirm on the desktop and Face ID or the passcode on the phone, at
  most 30 an hour. On Linux and Windows the desktop's confirm is one click: lock your computer when you leave it.
- **Its limit.** Agents run as the same OS user as the node, and on the hub's machine as the hub
  ([above](#agent-reach)): an agent there can read the root key file and the database, so the whole vault, much as it
  could read every node secret before. A passphrase keeps the key off the disk, but not from a process of the same
  user that waits for the next unlock. The vault narrows everything else: what leaks through transcripts, logs,
  recordings and the agent's tools, and what a machine that isn't the hub ever holds.

## Secrets and commands {#secrets}

- **Secrets never reach the hub in plain text.** The app seals each value to the hub's own key for the
  [vault](#vault), or to the target node's key on a hub without one (a libsodium sealed box). Lists keep only a
  secret's fingerprint.
- **Notifications** carry a one-line summary, never a secret.
- **An approved command runs exactly as stored**, and only after a person approves it.

## How leads run {#how-leads-run}

Every project's lead runs on its machine with the person's access and no sandbox (decision `projects.one-model`,
D310). It runs in Claude Code's `manual` permission mode, allowed unasked what a full-access lead does: it reads and
runs commands as you would, starts agents and works with repos. Only three things reach the person, by the project's
[approval mode](/docs/projects#approvals) (a new project starts in YOLO, where none of them asks; pick Checker decides
or Ask me about everything to be asked):

- A send through an [integration](/docs/integrations) (a server saved with `integration`); its reads run unasked. A
  server saved without `integration` runs every tool unasked, as it does for the project's agents, who never get an
  integration.
- A first fetch or browser visit to a site the person didn't give it (a link in their own message is given).
- `project_message`, `confirm_step` and `automation_confirm`.

A command that would wipe the machine or your home (`rm -rf ~`, `mkfs`) is refused, whoever approves it. A project
that had a home of its own from an earlier fleetd still runs its lead's commands there (`navis/<project id>/home` in
the node's directory), with what it installed there first on their `PATH`; its agents use yours. A lead whose
project has no repo does its own work and keeps `Edit`, `Write`, `WebFetch` and `WebSearch`; a lead with repos leaves
those to its agents. Which one it is gets read at each lead start, so adding a repo changes it.

A machine whose node is older starts leads the old way: an Only me project's in a sandbox, any other's with full
access. Those other projects take no integration until that machine runs `fleetd update`.

## The agents' Mac's screen {#mac-screen}

The [agents' Mac](/docs/browser-sessions#mac) lends the desktop of the account its node runs in to one agent at a
time: yours, when it joined from your account (an administrator's included), or a [user of its
own](/docs/agents-mac#own-user), which keeps agents out of your files and logins.

| Rule | Detail |
|---|---|
| Never your passwords | The viewer is badged **Agents' Mac**. Agents can draw a fake sign-in or admin dialog there, and read what's typed: never type your own passwords, an Apple ID or an admin password into it. `fill_credential` isn't offered there. |
| No secrets sent | A Mac screen's start is sealed to the Mac with its relay key alone: none of the agent's secrets go to the Mac's node, which every agent there shares. |
| DevTools stay on the Mac | An app agent-desktop launches with `--cdp` listens on the Mac's loopback only, and is closed when its session ends. |
| Only while it can be seen | The node checks at every start that its session is on the Mac's screen and unlocked, so an agent never drives a screen nobody could watch. |

## Hub links {#hub-links}

A hub link lets a project on one hub open and follow work in projects on another hub, for example from a personal
hub into a team hub. You make it on the hub it reaches and add it to the project on the other
([how](/docs/projects#hub-links)).

| Rule | Detail |
|---|---|
| It acts as you | A link key (`flk_…`) acts as you, at the lesser of your [role](/docs/people) on that hub and the grants of the device you made it on, never above operate, limited to the projects you pick or not. A read-only device can't make one. Removing you from the hub stops it. |
| It goes with its device | Revoking a device (signing it out, or `fleetd hub key revoke`) revokes every link made on it in the same step, so a lost device leaves no link working behind it. The sign-out confirm says how many go. Links made on your other devices keep working. |
| It does five things | List the projects it reaches, ask a project's lead for work, read their status, follow its own asks, revoke itself. It can't use `/mcp` or the app's connection, so it reads no chat and answers no approval, question or secret. |
| Its messages are never your answer | They go into the project's chat as "*you* via *label*", an agent's input, like any message from another project's lead. Approvals, secrets and merges still need you there. |
| The other hub sees only the requests | Not the project that asks, its chat or its title. |
| The key stays sealed | The app seals it to the asking project's hub, which opens it only to call the other hub. Nothing shows it again. |
| A person names the host it calls | `hub_link_add` makes the project's hub contact the URL that a person with operate gives it. On an Only me project, only its owner adds or removes its links. |
| Only the project's hub calls out | It must reach the other hub over HTTPS or a tailnet; plain HTTP elsewhere is refused. When it can't reach it, the lead and the link say "Can't reach *label*" with the reason. |
| Revoke from either side | Removing it on the project's hub deletes the key at once and revokes it on the other hub when that answers. Revoking it on the other hub refuses its next call. A link unused for 90 days expires. |

## Software {#software}

- **Installs are checksummed.** The installer and `fleetd update` refuse any file whose SHA-256 doesn't match the
  release's `SHA256SUMS`.
- **`fleetd machine add` copies the hub's own binary** to a worker over SSH; for another OS or CPU, the same
  version's release build, checked against its `SHA256SUMS`.
- **Models only through the `claude` CLI**, with the machine user's own claude setup. fleetd never calls a model or
  usage API itself.

## Report a vulnerability {#report}

Report it privately through GitHub's security advisories for
[unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd/security/advisories/new).
