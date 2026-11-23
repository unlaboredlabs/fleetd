---
title: Updating & uninstall
description: Update the hub, its machines and the apps, pick a release channel, and remove fleetd.
---

How to keep fleetd up to date, and how to remove it.

## Update from the app {#update}

When a new build is ready, owners and admins see **Update available** in the hub's menu at the top of the sidebar.

1. Click **Update**. Nothing else to confirm.
2. The hub restarts on the new build. If it isn't healthy within 90 seconds, it goes back to the old one.
3. Every machine then updates, and moves Claude Code to the version that build was tested with.
4. The app restarts last. A message you were typing is kept.

Agents keep working through the update, mid-step included. A machine waits at most 2 minutes for things a restart
would cut off, such as a live screen or a command you approved.

Settings › Hub › Machines › Updates shows how it's going and names any machine that didn't update, with **Try again**.
A machine that was offline updates when it's back.

### Update automatically {#everything}

Turn on **Update automatically** in Settings › Hub › Machines › Updates (off by default). The hub then installs each
new build once it's ready, at most once every 10 minutes. A build that failed to start isn't tried again by itself.

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

## Channels {#channels}

You start on Edge: a new build after each change to fleetd that passes its tests. `fleetd update` stays on the
channel you installed from.

- Switch to stable: `fleetd update --channel stable`
- Switch back to Edge: `fleetd update --channel edge`

## Remove a machine {#remove-worker}

On the hub:

```sh
fleetd machine remove <id>
```

Add `--purge` to delete its data too. See [Machines](/docs/machines#remove).

## Uninstall the hub {#uninstall}

Remove each machine first. Then, on the hub:

```console capture=uninstall
$ fleetd uninstall
no hub service at ~/.config/systemd/user/fleetd-hub.service
kept the hub's data in ~/.fleetd/hub; fleetd init starts it again, --purge deletes it
```

It removes the hub's service and keeps its data. `--purge` deletes the data in `~/.fleetd/hub` too.

## Remove the CLI and app {#remove}

```sh
curl -fsSL https://fleetd.sh | sh -s -- --uninstall
```

It runs `fleetd uninstall`, then removes the CLI and the app. Your data in `~/.fleetd` stays; delete it yourself if
you want it gone.
