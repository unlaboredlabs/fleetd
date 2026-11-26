---
title: Security
description: What fleetd protects, what it doesn't, and how to keep your machines safe.
---

What fleetd protects, what it doesn't, and how to set up your machines safely. fleetd is built for one person or a
small team that trusts each other.

## The short version

- Agents run as your OS user, with no sandbox. On their machine, they can reach what you can.
- So run agents on machines with nothing on them you'd mind them reading.
- Give a workspace only to people you trust with every bot on it, and each other's vault logins.
- fleetd keeps secrets out of agents' tools, transcripts and logs, and limits what its own keys can open.

## What an agent can reach {#agent-reach}

An agent runs as the OS user its machine runs fleetd as, usually you. On that machine it can reach:

- your files, and any key or token kept in them;
- your logins there: `gh`, SSH keys, git credentials and other CLIs you signed in to;
- fleetd's own files in `~/.fleetd`: the machine's key and the secrets it holds for its work. On the workspace's machine,
  that includes the workspace's database and the vault's key.

fleetd keeps these values out of agents' environments and transcripts, but an agent that goes looking can read the
files. A separate OS user is the only real wall, and fleetd doesn't set one up (except, optionally, on
[the agents' Mac](/docs/agents-mac)).

So keep what those files open small:

1. **Use a dedicated 1Password vault.** fleetd's 1Password service account should read only one vault, made for
   fleetd. A service account can't be given more vaults later, so the rest of your 1Password stays out of reach.
   `fleetd doctor` warns when a saved token reads more than one.
2. **Use a card that can't cost much.** A virtual or low-limit card, never your main one.
3. **Keep agent machines clean.** Nothing on them you'd mind an agent reading.

## How leads run {#how-leads-run}

Each bot's lead runs on its machine with your access and no sandbox. Its shell commands run without asking, except
one that would wipe the machine or your home (`rm -rf ~`, `mkfs`), which is always refused.

Only a few actions wait for you, depending on the bot's [approval mode](/docs/approvals-and-secrets#modes):

- a send through a [connection](/docs/connections);
- a first visit to a site you didn't give it (a link in your own message counts as given);
- a final Confirm or Submit on a site (`confirm_step`), and letting an automation run on its own.

New bots start in **YOLO**, where none of these ask. Pick **Checker decides** or **Ask me about everything** to be
asked. [Agent tools](/docs/reference/agent-tools#what-a-lead-does-without-asking) lists exactly what a lead may do
unasked.

## Network {#network}

- **The workspace isn't public.** `fleetd init` listens on your Tailscale address, or on `127.0.0.1` without Tailscale.
- **Plain HTTP only on loopback or Tailscale**, whose tunnel is encrypted. Anywhere else, put HTTPS in front.
- **Machines connect out.** Each proves itself with its own key pair, and none opens a port beyond loopback.
- **Codes work once.** Pairing and machine codes expire after 15 minutes, invites after 7 days. The agents' Mac's
  6-digit setup code lasts 10 minutes and closes after 10 wrong tries.

## Keys and devices {#keys}

- **Agent keys** (`fld_…`, for MCP clients and scripts) are shown once. The workspace keeps only their hash. A revoked key
  stops on its next request.
- **Device keys** belong to a person's app. The desktop app keeps its key in the OS keychain, or in a file only you
  can read when there is none.
- **Machine keys** live in `~/.fleetd/node/node-key.pem` on each machine.

Each key is `read`, `operate` or `admin`, on every machine or a list. Only a person's device can enter secrets or
approve commands, so no agent can approve itself.

A pairing code carries its role: `fleetd pair` gives `admin`, `fleetd pair --role operate` gives less. A device
never gets more than its code, and never more than its person's role allows.

### Which agent is calling {#node-socket}

Agents reach the workspace through their machine's socket, `~/.fleetd/node/node.sock` (mode `0600`). The machine works out
who is calling from the process tree, not from anything the caller says:

- A process started by an agent's session acts as that agent, on its own bot only.
- Any other process acts as you.

:::caution[Known limit]
A process that deliberately leaves its session's process tree (for example with `setsid`) is treated as you. Run
agents you don't trust as a different OS user.
:::

### The fleetd CLI inside a session {#cli-in-session}

Inside an agent's session, the `fleetd` CLI only reads the workspace: `status`, lists and history work, and anything that
would change the workspace is refused with what to do instead. This stops an agent changing the workspace by accident. It
doesn't stop one that means to, since it can read the workspace's files directly.

## People {#people}

Every person on a workspace is an owner, admin or member. Only owners and admins invite people, change roles and change
workspace-wide settings. The workspace always keeps an owner. Removing a person signs out all their devices at once.

Every bot is open to everyone on the workspace, and fleetd records who did what. Work only you should see goes on a workspace of
your own. Whoever runs the workspace's machine, and any agent on it, can read the workspace's database.

## Claude accounts {#claude}

The workspace's API key and each person's [subscription token](/docs/people#claude) are handled like any other secret:

- The app seals the value to each machine's key. The workspace only passes it on and never sees it.
- The machine passes it only to the agents on that account, and masks it in everything they report.
- One person's subscription runs only work they started. Removing them forgets their token everywhere.

The value is in the agent's environment, so any process of that OS user can read it.

## The vault {#vault}

The [vault](/docs/vault) keeps logins, cards, addresses and variables encrypted on the workspace.

- **Stored encrypted.** Each item is sealed with AES-256-GCM under its own key, wrapped by the vault's root key. The
  root key sits outside the workspace's folder, in your keychain, or behind a passphrase. A copy of the database alone opens
  nothing.
- **Sealed in transit.** What you type is sealed to the workspace. A fill is sealed to the one machine that uses it.
- **Filled, never shown.** Agents fill a login only on that login's own sites, and a card only at a checkout they
  recorded first. They have no tool to show, change or delete an item. Fills are rate-limited and logged, never with a value.
- **Revealed only by people.** An item's creator or an admin can reveal it, behind Touch ID, Face ID or a system
  confirm, at most 30 times an hour.
- **Its limit.** An agent on the workspace's machine can read the root key file and the database, so the whole vault. Run
  agents on other machines if that matters to you.

## Secrets and commands {#secrets}

- **Secrets never reach the workspace in plain text.** The app seals each value before sending it. Lists show only a
  fingerprint.
- **Notifications** carry a one-line summary, never a secret.
- **An approved command runs exactly as you saw it**, and only after you approve it.

## The agents' Mac {#mac-screen}

The [agents' Mac](/docs/agents-mac) lends its screen to agents.

- **Never type your own passwords there.** Agents can draw a fake sign-in dialog and read what you type. The viewer is
  badged **Agents' Mac** so you know where you are.
- **No secrets go to the Mac.** Agents' secrets stay on their own machines.
- **Only while it can be seen.** Agents drive the screen only while it is on and unlocked.
- **Your files stay yours** if the Mac joined from [a user of its own](/docs/agents-mac#own-user).

## Software {#software}

- **Installs are checksummed.** The installer, `fleetd update` and `fleetd machine add` refuse any file that doesn't
  match the release's `SHA256SUMS`.
- **Models only through `claude`.** fleetd never calls a model API itself.

## Report a vulnerability {#report}

Report it privately through GitHub's
[security advisories for unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd/security/advisories/new).
