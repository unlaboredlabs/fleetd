---
title: Updating & uninstall
description: Update the hub, its machines and the apps, pick an update speed, and remove fleetd.
---

How to keep fleetd up to date, and how to remove it.

## Update from the app {#update}

When a new build is ready, owners and admins see **Update available** in the hub's menu at the top of the sidebar.

1. Click **Update**. Nothing else to confirm.
2. The hub restarts on the new build and checks itself. If it isn't healthy within 90 seconds, or a machine doesn't
   reconnect, or lead turns fail, it goes back to the old one. See [Self-check and rollback](/docs/releases#self-check).
3. Every machine then updates, and moves Claude Code to the version that build was tested with.
4. The app restarts last. A message you were typing is kept.

Agents keep working through the update, mid-step included. A machine waits at most 2 minutes for things a restart
would cut off, such as a live screen or a command you approved.

Settings › Hub › Machines › Updates shows how it's going and names any machine that didn't update, with **Try again**.
A machine that was offline updates when it's back.

### Update automatically {#everything}

Turn on **Update automatically** in Settings › Hub › Machines › Updates (off by default). The hub then installs each
new build once it reaches the hub's [stage](/docs/releases#rings), at most once every 10 minutes. A build that failed
to start isn't tried again by itself.

## Update from a terminal {#cli}

On a machine without the app, such as a server:

```sh
fleetd update --check
fleetd update
```

It replaces the CLI and restarts the hub and node on that machine. The node waits up to 2 minutes for its agents'
current step; `--now` doesn't wait.

`fleetd status` and `fleetd doctor` tell you when the hub and machines run different versions.

## The desktop app {#app}

The app checks for updates on its own and downloads them in the background. When one is ready, Settings › General
shows **Restart to update**. If you don't restart, it installs the next time you quit.

- **Check for Updates…** is in the fleetd menu on macOS, in Help on Linux, and in the command palette.
- The Linux `.deb` package can't update itself: the app shows the download and the install command.

## Update speed {#channels}

**Fast** (default) takes each build within hours of it passing fleetd's own checks. **Steady** takes only builds that
have been out for 2 days. Set it in Settings › Hub › Machines › Updates, or run `fleetd update --speed steady`. See
[Builds & rollout](/docs/releases#speed).

## Remove a machine {#remove-worker}

On the hub:

```sh
fleetd machine remove <id>
```

It stops the machine's node and its agents, and the hub forgets it. Add `--purge` to delete its data too. A machine
that still runs a bot's lead is refused unless you add `--force`, which deletes those bots. See
[Machines](/docs/machines#remove).

## Remove fleetd from a machine {#remove}

On each machine, the hub's included:

```sh
curl -fsSL https://fleetd.sh | sh -s -- --uninstall
```

It runs `fleetd uninstall` first, which stops and removes everything fleetd runs there:

- the node's service, and the agents it left running, their Claude sessions included;
- the hub's service, on the hub's machine;
- the root drop-in setup wrote so the services keep running, and linger if fleetd turned it on. Without sudo it
  prints the one command to run as root.

Then it checks that no fleetd service or process is left, and only then removes the CLI and the app. If something
still runs, it names it with its pid and keeps the CLI, so you can stop it and run the uninstall again.

Your data in `~/.fleetd` stays; delete it yourself if you want it gone.

On the hub, uninstalling names any machine that still runs this hub's node. Run the same line there. A machine that
joined by itself stays listed on its hub until an admin removes it in Settings › Hub › Machines.

## Uninstall from a terminal {#uninstall}

`fleetd uninstall` alone does the first half: it removes fleetd's services on this machine and keeps the CLI.

```console capture=uninstall
$ fleetd uninstall
no hub service at ~/.config/systemd/user/fleetd-hub.service
kept the hub's data in ~/.fleetd/hub; fleetd init starts it again, --purge deletes it
```

`--purge` also deletes the hub's data in `~/.fleetd/hub` and the node's files.

## If the hub's port is taken {#port}

If another program takes the hub's port, systemd keeps starting the hub every 5 seconds, and the hub is back within
seconds of the port coming free. `fleetd init` names the program holding the port, and gives the command that moves
the hub to a free port on the same address instead.
