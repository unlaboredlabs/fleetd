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
| Codes are one-time | Enrollment tokens and pairing codes work once and expire after 15 minutes; an [invite](/docs/people#invite) works once, for 7 days. |

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
count on that to stop an agent that goes looking. Isolating agents from your files is future work.

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

## People {#people}

Every human key belongs to a [person](/docs/people) with a hub role: owner, admin or member. A device never holds
more than its person's role allows: a member's device operates, even one paired with `admin`. Only owners and admins
invite people, change roles and change hub-wide settings, and the hub always keeps an owner. Removing a person
revokes all their devices at once.

Chat messages, approvals, secrets, decisions and checklist changes record the person, next to the device as
before. All projects are open to everyone on the hub, so give a hub only to people you trust with every project on
it. Navis are the exception: the hub shows and serves each only to its owner, admins included (only deleting a
removed person's Navi is an admin's). The hub's operator, and any agent on the hub machine, can read the hub's database: fleetd records who did what,
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
- One person's subscription runs only work they started, or their Navi. Removing a person forgets their token on
  every machine.

Like project secrets, the value is in the claude process's environment. Any process of the node's OS user can read
it, so the machine's owner and any agent running there could reach it, as [People](#people) says of the hub.

## Secrets and commands {#secrets}

- **Secrets never reach the hub in plain text.** The app seals each value to the target node's key (a libsodium
  sealed box). The hub relays it without storing it and keeps only its fingerprint.
- **Notifications** carry a one-line summary, never a secret.
- **An approved command runs exactly as stored**, and only after a person approves it.

## How leads run {#how-leads-run}

Every project's lead runs on its machine with the person's access and no sandbox (decision `projects.one-model`,
D310). It runs in Claude Code's `manual` permission mode, allowed unasked what a full-access lead does: it reads and
runs commands as you would, starts agents and works with repos. Only three things reach the person, by the project's
[approval mode](/docs/navi#approvals):

- A send through an [integration](/docs/integrations) (a server saved with `integration`); its reads run unasked. A
  server saved without `integration` runs every tool unasked, as it does for the project's agents, who never get an
  integration.
- A first fetch or browser visit to a site the person didn't give it (a link in their own message is given).
- `project_message`, `confirm_step` and `automation_confirm`.

A command that would wipe the machine or your home (`rm -rf ~`, `mkfs`) is refused, whoever approves it. A lead whose
project has no repo does its own work and keeps `Edit`, `Write`, `WebFetch` and `WebSearch`; a lead with repos leaves
those to its agents. Which one it is gets read at each lead start, so adding a repo changes it.

A machine whose node is older starts leads as before: a Navi in its sandbox, every other lead under full access. Such a
project takes no integration until that machine runs `fleetd update`.

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

## Cloud machines {#cloud}

[Cloud machines](/docs/cloud-machines) run on the hub owner's own boat.dev account; fleetd runs no service.

| Rule | Detail |
|---|---|
| The boat.dev key stays on the hub | Sealed in the app to the hub's own key, scoped to fleetd's boat.dev environment, with no `exec`, `file` or `snapshot` actions; its `ssh` action only lets the hub's own SSH key in. No cloud machine or agent gets it. |
| The hub stays private | The hub dials each machine it wakes over SSH, pins the host key boat.dev names, and holds one reverse forward its node reaches the hub through. The hub needs no public address, and boat.dev learns none of your network's. |
| The hub never runs commands there | The tunnel asks for no shell or command, and refuses every channel but its own forward. The hub's SSH key is made by the hub, sealed to its box key, and never leaves it. |
| boat.dev can see what runs there | As any host can, including the disk it keeps while a machine sleeps. Only projects an admin opts in run there; Reset deletes a machine with its disk and keys. |
| Agents have no sudo | The node and its agents run as a user of their own on each cloud machine. |
| A bill can't run on | Each awake machine has boat.dev's own 30-minute lease; budgets, the idle stop and a sweep every 10 minutes stop the rest, and `fleetd cloud stop` stops all. |

## Hub links {#hub-links}

A hub link lets a Navi on one hub open and follow work in projects on another hub, for example from a personal hub
into a team hub. You make it on the hub it reaches and add it to the Navi on the other ([how](/docs/navi#hub-links)).

| Rule | Detail |
|---|---|
| It acts as you | A link key (`flk_…`) acts as you, at the lesser of your [role](/docs/people) on that hub and the grants of the device you made it on, never above operate, limited to the projects you pick or not. A read-only device can't make one. Removing you from the hub stops it. |
| Revoking a device leaves its links | By design, revoking a lost device doesn't stop the links made on it: they act as you, not as the device, and never gain rights it lacked. Revoke them too, in **Settings › Hubs**, **Hub links**, on that hub. |
| It does five things | List the projects it reaches, ask a project's lead for work, read their status, follow its own asks, revoke itself. It can't use `/mcp` or the app's connection, so it reads no chat and answers no approval, question or secret. |
| Its messages are never your answer | They go into the project's chat as "*you* via *label* Navi", an agent's input, like any Navi message. Approvals, secrets and merges still need you there. |
| The other hub sees only the requests | Not the Navi, its chat or its title. |
| The key stays sealed | The app seals it to the Navi's hub, which opens it only to call the other hub. Nothing shows it again. |
| A person names the host it calls | `hub_link_add` makes the Navi's hub contact the URL that a person with operate gives it. Only the Navi's owner adds or removes its links. |
| Only the Navi's hub calls out | It must reach the other hub over HTTPS or a tailnet; plain HTTP elsewhere is refused. When it can't reach it, the Navi and the link say "Can't reach *label*" with the reason. |
| Revoke from either side | Removing it on the Navi's hub deletes the key at once and revokes it on the other hub when that answers. Revoking it on the other hub refuses its next call. A link unused for 90 days expires. |

## Software {#software}

- **Installs are checksummed.** The installer and `fleetd update` refuse any file whose SHA-256 doesn't match the
  release's `SHA256SUMS`.
- **`fleetd machine add` copies the hub's own binary** to a worker over SSH.
- **Models only through the `claude` CLI**, with the machine user's own claude setup. fleetd never calls a model or
  usage API itself.

## Report a vulnerability {#report}

Report it privately through GitHub's security advisories for
[unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd/security/advisories/new).
