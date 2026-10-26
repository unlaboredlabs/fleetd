---
title: Updating & uninstall
description: Update fleetd and its app, pick a release channel, and remove fleetd from a machine.
---

Keep fleetd up to date, or remove it.

## Update {#update}

### From the app {#everything}

When the hub, one of its machines or the app has a newer build on its channel, the sidebar says **Update available**.
Click it, then **Update**. One click updates everything, in order:

1. **The hub** downloads the channel's newest build, checks it against the release's `SHA256SUMS`, keeps the binary it
   runs, and restarts on the new one. If the new build doesn't come up healthy within 90 seconds, the previous one is
   put back and restarted.
2. **Every connected machine's node** does the same, once the hub runs the new build.
3. **The app** installs its own update and restarts. A message you were typing is still there after the restart.

The sheet shows each part as it goes: downloading, restarting, updated, up to date, and if something went wrong, which
part and why. A failed download or a checksum mismatch changes nothing. A build that didn't come up is put back, and
the hub's machines aren't asked if the hub itself didn't update. A machine that is offline, or that runs a fleetd too old
to update from the hub, is skipped and says how to update it. When a part fails, the app doesn't restart, so the
result stays on screen.

Updating needs a key with Admin on every machine, as `fleetd pair` gives the app.

An update never waits for work to finish. Restarts happen right away, and what they cut off carries on by itself:

- A lead's turn and running agents resume in their threads and worktrees once their machine is back.
- The merge train takes up the change it was merging.
- An approved command that was running goes back to you as interrupted, with its result unknown. It never runs again
  by itself: check whether it ran before you approve it again.

### From a terminal {#cli}

On a machine without the app (a headless worker, say), run:

```sh
fleetd update --check
fleetd update
```

It replaces the CLI, checked against the release's `SHA256SUMS`, then restarts the hub and node services that run this
binary right away. What they were running carries on by itself, as above. `fleetd machine add <ssh-host>` on the hub
also copies the hub's binary to a worker.

`fleetd status` and `fleetd doctor` say when the CLI, the hub and the nodes run different versions.

### The desktop app {#app}

The app checks for updates when it opens, every 10 minutes and when you come back to its window, and downloads them
in the background; a newer build than one already downloaded replaces it. Its own update is also in the sheet, with
**Update and restart** and what's new. An update you don't install now installs the next time you quit.

- **Check for Updates…** is in the fleetd menu on macOS, in Help on Linux, and in the command palette.
- The `.deb` install can't update itself: the app offers the download and the `sudo apt install` command.

- An earlier fleetd app is replaced by the current one, which keeps its pairing.
- On macOS 11 the earlier app stays as it is: the current app needs macOS 12.
- On a Mac from before the current app, run `fleetd update` twice: the first updates the CLI, the second the app.

fleetd pins the `claude` version separately. See [Claude](/docs/troubleshooting#claude).

## Channels {#channels}

`fleetd update` stays on the channel you installed from. Releases are nightly builds for now.

| To | Run |
|---|---|
| Switch an install to stable | `fleetd update --channel stable` |
| Install from stable | `curl -fsSL https://fleetd.sh \| FLEETD_CHANNEL=stable sh` |

## Remove a worker {#remove-worker}

On the hub:

```sh
fleetd machine remove <id>
```

Add `--purge` to delete its data too. See [Machines](/docs/machines#remove).

## Uninstall the hub {#uninstall}

Remove each worker first. Then, on the hub:

```console capture=uninstall
$ fleetd uninstall
no hub service at ~/.config/systemd/user/fleetd-hub.service
kept the hub's data in ~/.fleetd/hub; fleetd init starts it again, --purge deletes it
```

It stops and removes the hub's service (here there was none) and keeps its data.

| Option | Also does |
|---|---|
| `--purge` | Deletes `~/.fleetd/hub`. Stop a hub you run yourself first. |

## Remove the CLI and app {#remove}

```sh
curl -fsSL https://fleetd.sh | sh -s -- --uninstall
```

Expected output:

```text
no hub service at ~/.config/systemd/user/fleetd-hub.service
kept the hub's data in ~/.fleetd/hub; fleetd init starts it again, --purge deletes it
fleetd: removed the fleetd CLI and app. Your data in ~/.fleetd is still there; delete it yourself if you want it gone.
```

It runs `fleetd uninstall` first, then removes the CLI and the app. `~/.fleetd` stays; delete it yourself if you want
it gone.
