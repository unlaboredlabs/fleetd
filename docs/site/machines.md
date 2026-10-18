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

## Claude on a worker

Sessions use the worker's own claude setup (`~/.claude`), so if `claude` works in your shell there, it works for
fleetd: your login, a proxy set in `~/.claude/settings.json` and your MCP servers included. If it is not logged in,
log in as you normally do:

```sh
claude auth login
```

Behind a proxy, log in with your proxy instead. `fleetd doctor` shows each worker's claude, login and proxy. See
[The Claude login](config-and-files.md#claude) for a dedicated profile per machine.

## Remove a machine {#remove}

```sh
fleetd machine remove homeserver
```

It stops and removes the node's service there and revokes its key on the hub. `--purge` also deletes
`~/.fleetd/node` and `~/.fleetd/claude.env` on that machine; your own `~/.claude` stays. For a machine that joined with
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

It checks the hub and every machine (online, claude version and login, commit identity, disk, sleep when idle, usage
breaker) and prints the fix for each problem. The app's Machines screen shows the same checks. Every finding and its fix:
[Troubleshooting](troubleshooting.md).
