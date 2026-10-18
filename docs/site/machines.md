---
title: Machines
section: Using fleetd
order: 40
description: Add workers to the hub, log in their Claude, remove them, and check their health.
---

A worker is any machine that runs agents. It needs the `claude` CLI, and for now the same OS and CPU as the hub.
Run these on the hub.

## Add a machine the hub can reach over SSH

Run `fleetd init` again and pick it from the list (hosts from `~/.ssh/config` and your tailnet), or name it:

```sh
fleetd machine add homeserver
```

It copies the hub's own fleetd there, enrolls the node with a one-time token, runs it as a user service and waits
until the machine is online. It prints every remote command before it runs it. `--dry-run` only prints the plan:

```console capture=machine-add
$ fleetd machine add builder-1 --dry-run
dry run: nothing runs. Planned for a fresh Linux machine at builder-1 (home /home/demo); a real run first reads the machine's state and leaves out what is already done:
[probe] read the machine's state (read-only)
[1/6] create fleetd's directories
[2/6] install fleetd 0.0.0
[3/6] create fleetd's Claude login file (empty, 0600)
[4/6] write the node service
[5/6] enroll the node with a one-time token (sent on stdin)
[6/6] (re)start the node
[hub] wait until builder-1 is online
[exit 0]
```

It is safe to run again: a real run reads the machine's state first and skips what is done.

## Add this machine {#local}

```sh
fleetd machine add --local
```

The same steps, run here without SSH. Use it to make the hub machine a worker too, or to repair it. `fleetd init`
does this when you pick "(this machine)".

## Add a machine the hub can't reach

For a laptop behind NAT, or anything without SSH from the hub, print a one-line join command on the hub and paste
it on the new machine:

```console
$ fleetd pair --worker laptop
On laptop, run:

  curl -fsSL https://fleetd.sh | sh && ~/.local/bin/fleetd init --join http://hub.your-tailnet.ts.net:4790 --code <code> --machine-id laptop --git-identity 'ada-lovelace <1234567+ada-lovelace@users.noreply.github.com>'

The code works once, until 2026-10-18T13:35:46.366Z. laptop needs claude installed and must reach the hub at that address.
```

The code lasts 15 minutes. The machine must reach the hub's address. Run the command again later to repair the
worker; `--rejoin` enrolls it again with a new code.

## Log in fleetd's Claude on a worker

The node runs `claude` with its own config dir, so your own login doesn't carry over. On the worker:

```sh
CLAUDE_CONFIG_DIR=~/.fleetd/claude claude auth login
```

Or run `claude setup-token` and put `CLAUDE_CODE_OAUTH_TOKEN=<token>` in `~/.fleetd/claude.env`. When `fleetd init`
sets a machine up, it offers to run the login for you. On the hub machine, it also offers to copy a token or gateway
variables that your shell has into `claude.env`.

## Remove a machine {#remove}

```sh
fleetd machine remove homeserver
```

It stops and removes the node's service there and revokes its key on the hub. `--purge` also deletes
`~/.fleetd/node`, `~/.fleetd/claude` and `~/.fleetd/claude.env` on that machine. For a machine that joined with
`pair --worker`, only the key is revoked; stop its node there yourself:

```console
$ fleetd machine remove laptop
laptop was not set up by fleetd machine add from this hub, so only its key is revoked here; stop its node by hand.
revoked laptop's node key; the hub refuses that node from now on.
```

## Check health

```sh
fleetd doctor
```

It checks the hub and every machine (online, claude version and login, commit identity, disk, usage breaker) and
prints the fix for each problem. The app's Machines screen shows the same checks. Every finding and its fix:
[Troubleshooting](troubleshooting.md).
