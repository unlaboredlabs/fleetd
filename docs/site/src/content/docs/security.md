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

## Navi sandbox {#navi-sandbox}

A [Navi](/docs/navi) reads mail and web pages that anyone can write, so fleetd assumes one may be talked into
something. Its tool checks (sites asked once unless you linked them, sends always asked) run inside the session. Its
shell commands run unasked (decision `navi.shell-unasked`, D208): the OS sandbox is their guard, and holds when a
command finds a way around the checks. Only Navis run in it; other agents don't.

The sandbox guards what matters and leaves the rest open (decision `navi.sandbox-open-home`, D234): a Navi installs
and runs things as you would, and can't read your keys and logins or fleetd's own files. Both systems apply the same
fence. These are the paths, with `~` the machine user's home and `~/.claude` Claude Code's config dir (or
`$CLAUDE_CONFIG_DIR`).

**Its own home.** Each Navi has a home of its own in fleetd's node directory, `navis/<project id>/home`, kept across
sessions and restarts and deleted with the Navi. It is `HOME` for its commands, with `~/.local/bin`, `~/bin`,
`~/.cargo/bin`, `~/go/bin`, `~/.bun/bin` and `~/.deno/bin` first on their `PATH`, npm's global prefix at `~/.local`
and `PIP_BREAK_SYSTEM_PACKAGES=1`, so `npm i -g`, `pip install --user`, `cargo install`, `go install` and
`curl … | sh` installers put what they install there. `RUSTUP_HOME` points at your `~/.rustup` when you have one, so
your toolchains still run. Claude Code itself keeps your `HOME`, where its login is. No Navi sees another's home.

**Writes**, on both: anywhere you can write on the machine, except:

- What it can't read (below).
- Startup files that run on their own, read-only: `~/.profile`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`,
  `~/.bash_logout`, `~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.zlogin`, `~/.zlogout`, `~/.pam_environment`,
  `~/.xprofile`, `~/.xsessionrc`, `~/.xinitrc` and `~/.local/share/systemd`. A line it added there would run outside
  its sandbox.
- The programs the node runs, read-only: Claude Code's install, every directory on the session's `PATH` that is in
  your home (a `…/bin` as its whole install, so `~/.nvm/versions/node/v22` for node and npm, and `~/.cargo` for
  `~/.cargo/bin`), and the install a program there links to elsewhere in the home.
- `~/.claude` (but its own session's files: its conversation in `~/.claude/projects/<its folder>`,
  `~/.claude/session-env/<session>`, `~/.claude/file-history/<session>`, and the login file
  `~/.claude/.credentials.json`, where Claude Code saves a refreshed token), so it can't add hooks or MCP servers for
  other agents. Also `~/.gitconfig`, git's `~/.config/git/config`, `ignore` and `attributes`, and `~/.rustup`.
- In its folder: `.claude`, `.fleetd`, `.mcp.json` and `agent-browser.json`.

**`~/.claude.json`** holds every MCP server's settings, with their tokens, and every project's history. On Linux a
Navi gets its own copy in its place, made fresh at each start: without `mcpServers`, without `projects`, and without
any key named like a secret but Claude Code's own login. What it writes there stays in its copy. Its backups and other
copies beside it (`~/.claude.json.backup.*`) aren't in a Linux Navi's home at all. On macOS, where nothing can stand
in for a path, the real file and its copies are hidden.

**Can't read**, on both:

- fleetd's directory: the hub, the node, worktrees, secrets and integration tokens, Chrome's profiles, and every
  other Navi's folder and home. Only its own folder, home and session's files are there: its MCP config, settings and
  skills, the `fleetd` binary and the node's socket, and the agent-browser and agent-device installs.
- Claude Code's record of other sessions: `~/.claude/projects` (but its own), `history.jsonl`, `file-history`,
  `session-env` and `sessions`; its IDE connections (`ide`, whose lock files hold a token) and its `backups`.
- Logins and keys: `~/.config` (but git's `config`, `ignore` and `attributes` in `~/.config/git`, never its
  `credentials`), `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.password-store`,
  `~/.local/share/keyrings`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials` and
  `credentials.toml`, `~/.android/adbkey`, `~/.mozilla`, `~/.pgpass`, `~/.vault-token`, `~/.azure`, `~/.terraform.d`,
  and `~/snap` (each snap's own data, logins included).
- Shell and REPL history: `~/.bash_history`, `~/.zsh_history`, fish's `~/.local/share/fish/fish_history`,
  `~/.python_history`, `~/.node_repl_history`.
- The X server: `~/.Xauthority` and `/tmp/.X11-unix`. `DISPLAY` and `XAUTHORITY` are unset.
- `~/.agent-browser`, where other sessions' browsers listen. Its own listens in its scratch dir.
- The docker socket (`/run/docker.sock`, `/var/run/docker.sock`).

Everything else reads as it does for you: your code, your notes, other projects' checkouts.

**On Linux the home is listed.** A Navi's `~` is read-only, with each entry it had when the session started bound
back, but the hidden ones. A link there stays a link, so one into a hidden path leads nowhere. Nothing new appears at
the top of your home while it runs, such as another session's temporary copy of `~/.claude.json`, and it can't make a
new file there (a startup file of a shell you don't use yet). Inside an entry, it writes as you do.

**Background processes.** On Linux each Navi has a box: a long-lived bubblewrap with its own user, pid and IPC
namespaces, started with its first session and ended when the node stops. Every session of the Navi runs in it, with
its own mounts. What a command leaves running (`nohup …&`, `setsid`) is reparented to the box's init, not killed at
the end of the turn, and the next turn finds it. The box's processes see each other and nothing else on the machine.
Its sessions share one `/tmp`, emptied when the box starts. On macOS a detached process outlives the session already.
Nothing comes back after the node or the machine restarts, and there is no root, `apt` or systemd service.

| | Linux (bubblewrap) | macOS (`sandbox-exec`) |
|---|---|---|
| Also can't read | `$XDG_RUNTIME_DIR` (`/run/user/<uid>`): the user's D-Bus, systemd and SSH agent sockets, which would start commands outside. Their variables are unset. `/sys` is read-only. | `~/Library` whole: browser cookies, app tokens, keychain files. Claude Code reads its login through the keychain's daemon, not the files. |
| Abstract sockets | Landlock scopes them (Linux 6.12 and later): nothing inside connects to one made outside, such as an X server's or a D-Bus bus's, nor to one a process of an earlier turn made. On an older kernel they stay reachable, and the machine's Navi sandbox check says so. | Not used on macOS |
| `/tmp` | The Navi's own, shared by its sessions, emptied when its box starts | The machine's. Its commands' `TMPDIR` is its own `navis/<project id>/tmp`; Claude Code's own temp dir (`CLAUDE_CODE_TMPDIR`) is its scratch dir. |
| Processes | Its box's (`/proc`, a pid namespace): no other process, so no way back to the disk through one. A process from an earlier turn can be signalled, not traced. | Others are visible, as for any program |
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
  It can write what you run later yourself: a script in your code, a program in a `PATH` directory the node doesn't
  use. A path hidden here but reachable through another mount of the same disk (a bind mount you made) is reachable
  there too.

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
