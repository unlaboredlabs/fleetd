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

## Navi sandbox {#navi-sandbox}

A [Navi](/docs/navi) reads mail and web pages that anyone can write, so fleetd assumes one may be talked into
something. Its tool checks (files only in its folder, sites asked once, sends always asked) run inside the session;
an OS sandbox holds when a command finds a way around them. Only Navis run in it; other agents don't.

Both systems apply the same fence. These are the paths, with `~` the machine user's home and `~/.claude` Claude
Code's config dir (or `$CLAUDE_CONFIG_DIR`).

**On Linux the home is an allow-list.** A Navi's `~` is empty and read-only, and only these come back:

- Its own folder and scratch dir, and its session's files from fleetd's directory (below).
- Read-only: Claude Code's install (`~/.local/bin`, and `~/.local/share/claude/versions` that `claude` links to),
  every directory on the session's `PATH` that is in the home (a `…/bin` as its whole install, so
  `~/.nvm/versions/node/v22` for node and npm), what a program there links to elsewhere in the home, `~/.claude` (but
  other sessions' records, below), `~/.gitconfig` and `~/.config/git`.
- Its own copy of `~/.claude.json` (below), and `~/.claude/.credentials.json`, read and written.
- `~/.cache`: its own, empty at first, kept with its session.

Anything else in the home, such as notes, shell startup files, another session's temporary files, or a file made
while it runs, isn't there at all. The list under **Can't read** still applies inside what comes back, for example
`~/.cargo/credentials.toml` when `~/.cargo/bin` is on the `PATH`. On macOS the home is as the machine has it, minus
the paths listed below.

**Writes**, on both: its folder (except `.claude`, `.fleetd`, `.mcp.json` and `agent-browser.json` in it), its
scratch dir, and Claude Code's files for its own session: its conversation in `~/.claude/projects/<its folder>`,
`~/.claude/session-env/<session>`, `~/.claude/file-history/<session>`, and the login file
`~/.claude/.credentials.json` when there is one. Claude Code saves a refreshed token there; one it couldn't save would
log out every session on the machine. Everything else takes no writes, `~/.claude/settings.json` included, so it
can't add hooks or MCP servers for other agents.

**`~/.claude.json`** holds every MCP server's settings, with their tokens, and every project's history. On Linux a
Navi gets its own copy in its place, made fresh at each start: without `mcpServers`, without `projects`, and without
any key named like a secret but Claude Code's own login. What it writes there stays in its copy. Its backups and other
copies beside it (`~/.claude.json.backup.*`) aren't in a Linux Navi's home at all. On macOS, where nothing can stand
in for a path, the real file and its copies are hidden.

**Can't read**, on both (on Linux, also anywhere else in the home):

- fleetd's directory: the hub, the node, worktrees, secrets and integration tokens, Chrome's profiles. Only its own
  session's files are read again: its MCP config, settings and skills, the `fleetd` binary and the node's socket,
  and the agent-browser and agent-device installs.
- Other projects' checkouts on the machine.
- Claude Code's record of other sessions: `~/.claude/projects` (but its own), `history.jsonl`, `file-history`,
  `session-env` and `sessions`; its IDE connections (`ide`, whose lock files hold a token) and its `backups`.
- Logins and keys: `~/.config`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.password-store`,
  `~/.local/share/keyrings`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials` and
  `credentials.toml`, `~/.android/adbkey`, `~/.mozilla`, `~/.pgpass`, `~/.vault-token`, `~/.azure`, `~/.terraform.d`,
  and `~/snap` (each snap's own data, logins included).
- Shell and REPL history: `~/.bash_history`, `~/.zsh_history`, fish's `~/.local/share/fish/fish_history`,
  `~/.python_history`, `~/.node_repl_history`.
- The X server: `~/.Xauthority` and `/tmp/.X11-unix`. `DISPLAY` and `XAUTHORITY` are unset.
- `~/.agent-browser`, where other sessions' browsers listen. Its own listens in its scratch dir.
- The docker socket (`/run/docker.sock`, `/var/run/docker.sock`).

| | Linux (bubblewrap) | macOS (`sandbox-exec`) |
|---|---|---|
| Also can't read | `$XDG_RUNTIME_DIR` (`/run/user/<uid>`): the user's D-Bus, systemd and SSH agent sockets, which would start commands outside. Their variables are unset. | `~/Library` whole: browser cookies, app tokens, keychain files. Claude Code reads its login through the keychain's daemon, not the files. |
| Abstract sockets | Landlock scopes them (Linux 6.12 and later): nothing inside connects to one made outside, such as an X server's or a D-Bus bus's. On an older kernel they stay reachable, and the machine's Navi sandbox check says so. | Not used on macOS |
| `/tmp` | Its own | The machine's, read-only. Its scratch dir is its `TMPDIR`. |
| Processes | Its own (`/proc`, a pid namespace): no other process, so no way back to the disk through one | Others are visible, as for any program |
| Claude Code's shared state | Shell snapshots, todos, tasks, plans, `statsig`, `debug` and the paste cache get a private copy per session | Read-only: `sandbox-exec` can't give a private copy. A Mac Navi's todo list, plan files and shell snapshot may not save. |
| Terminal | A session of its own (`--new-session`): it can't push keystrokes into the node's terminal | |
| Network | As before: the site gate decides | The same |

- **No sandbox, no Navi.** When bubblewrap is missing or can't start, the Navi doesn't run, and its chat says how to
  fix it ([Navi](/docs/navi)). fleetd never runs a Navi unsandboxed.
- **Each machine says which it gets.** Machines › Setup checks shows a **Navi sandbox** line per machine: bubblewrap
  with abstract sockets scoped; bubblewrap on a kernel too old to scope them (a warning, with the fix); or none, so
  Navis can't run there (with how to install bubblewrap).
- **What it doesn't cover.** The network is shared, as the site gate needs. On Linux before 6.12, abstract Unix
  sockets stay reachable, including an X server that accepts local connections without a cookie
  (`xhost +si:localuser`, the GNOME default). fleetd's own screens don't listen there. Its folder, its session's
  MCP config (with its own servers' tokens) and Claude Code's login are readable to it, since Claude Code needs them.
  Outside the home (and on macOS, inside it but for the hidden paths) the machine is readable, without writes.

## Hub links {#hub-links}

A hub link lets a Navi on one hub open and follow work in projects on another hub, for example from a personal hub
into a team hub. You make it on the hub it reaches and add it to the Navi on the other ([how](/docs/navi#hub-links)).

| Rule | Detail |
|---|---|
| It acts as you | A link key (`flk_…`) acts as you, at the lesser of your [role](/docs/people) on that hub and the grants of the device you made it on, never above operate, limited to the projects you pick or not. A read-only device can't make one. Removing you from the hub stops it. |
| Revoking a device leaves its links | By design, revoking a lost device doesn't stop the links made on it: they act as you, not as the device, and never gain rights it lacked. Revoke them too, in **Settings › Hubs**, **Links to this hub**, on that hub. |
| It does five things | List the projects it reaches, ask a project's lead for work, read their status, follow its own asks, revoke itself. It can't use `/mcp` or the app's connection, so it reads no chat and answers no approval, question or secret. |
| Its messages are never your answer | They go into the project's chat as "*you* via *label* Navi", an agent's input, like any Navi message. Approvals, secrets and merges still need you there. |
| The other hub sees only the requests | Not the Navi, its chat or its title. |
| The key stays sealed | The app seals it to the Navi's hub, which opens it only to call the other hub. Nothing shows it again. |
| A person names the host it calls | `hub_link_add` makes the Navi's hub contact the URL that a person with operate gives it. Only the Navi's owner or an admin adds or removes a Navi's links. |
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
