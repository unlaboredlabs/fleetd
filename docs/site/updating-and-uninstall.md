---
title: Updating & uninstall
section: Reference
order: 110
description: Update fleetd and its app, pick a release channel, and remove fleetd from a machine.
---

## Update

```console
$ fleetd update --check
fleetd 0.0.0-nightly.20261018.832ba8f is up to date (nightly)
```

```sh
fleetd update
```

It replaces the CLI, and the desktop app when the installer put it in its usual place, then restarts the hub and node
services that run this binary. Every file is checked against the release's `SHA256SUMS`. The app also updates itself
from the same release, and installs the update when you quit it. An earlier fleetd app is replaced by the current one,
which keeps its pairing; on macOS 11 it stays as it is, since the current app needs macOS 12.

Updating a Mac from before the current app: run `fleetd update` twice (the CLI first, then the app).

Workers don't update themselves. Update the hub first, then each worker: run `fleetd update` there, or
`fleetd machine add <ssh-host>` on the hub, which copies the hub's binary over. fleetd pins claude separately: see
[claude version](troubleshooting.md#claude_version).

## Channels

`fleetd update` stays on the channel you installed from. Releases are nightly builds for now; a stable channel comes
with the first release.

```sh
fleetd update --channel stable
curl -fsSL https://fleetd.sh | FLEETD_CHANNEL=stable sh
```

## Remove a machine

From the hub: `fleetd machine remove <id>`, with `--purge` to delete its data too. See
[Machines](machines.md#remove).

## Uninstall the hub

```console capture=uninstall
$ fleetd uninstall
no hub service at ~/.config/systemd/user/fleetd-hub.service
kept the hub's data in ~/.fleetd/hub; fleetd init starts it again, --purge deletes it
```

It stops and removes the hub's service (here there was none) and keeps its data. `--purge` also deletes
`~/.fleetd/hub`; stop a hub you run yourself first. Remove each worker before you purge the hub.

## Remove the CLI and app

```console
$ curl -fsSL https://fleetd.sh | sh -s -- --uninstall
no hub service at ~/.config/systemd/user/fleetd-hub.service
kept the hub's data in ~/.fleetd/hub; fleetd init starts it again, --purge deletes it
fleetd: removed the fleetd CLI and app. Your data in ~/.fleetd is still there; delete it yourself if you want it gone.
```

It runs `fleetd uninstall` first, then removes the CLI and the app. `~/.fleetd` stays.
