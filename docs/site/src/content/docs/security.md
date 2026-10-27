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
it. The hub's operator, and any agent on the hub machine, can read the hub's database: fleetd records who did what,
but it keeps nothing private from them.

## Secrets and commands {#secrets}

- **Secrets never reach the hub in plain text.** The app seals each value to the target node's key (a libsodium
  sealed box). The hub relays it without storing it and keeps only its fingerprint.
- **Notifications** carry a one-line summary, never a secret.
- **An approved command runs exactly as stored**, and only after a person approves it.

## Hub links {#hub-links}

A hub link lets a Navi on one hub open and follow work in projects on another hub, for example from a personal hub
into a team hub. You make it on the hub it reaches and add it to the Navi on the other.

| Rule | Detail |
|---|---|
| It acts as you | A link key (`flk_…`) acts as you, at your [role](/docs/people) on that hub, limited to the projects you pick or not. Removing you from the hub stops it; revoking the device you made it on doesn't. |
| It does five things | List the projects it reaches, ask a project's lead for work, read their status, follow its own asks, revoke itself. It can't use `/mcp` or the app's connection, so it reads no chat and answers no approval, question or secret. |
| Its messages are never your answer | They go into the project's chat as "*you* via *label* Navi", an agent's input, like any Navi message. Approvals, secrets and merges still need you there. |
| The other hub sees only the requests | Not the Navi, its chat or its title. |
| The key stays sealed | The app seals it to the Navi's hub, which opens it only to call the other hub. Nothing shows it again. |
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
