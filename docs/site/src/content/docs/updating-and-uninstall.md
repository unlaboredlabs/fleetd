---
title: Updating & uninstall
description: Update fleetd and its app, pick a release channel, and remove fleetd from a machine.
---

Keep fleetd up to date, or remove it.

## Update {#update}

1. Check for an update:

   ```sh
   fleetd update --check
   ```

   Expected output when you are current:

   ```text
   fleetd 0.0.0-nightly.20261018.832ba8f is up to date (nightly)
   ```

2. Update the hub first:

   ```sh
   fleetd update
   ```

   It replaces the CLI, and the desktop app when the installer put it in its usual place. Then it restarts the hub and
   node services that run this binary. Every file is checked against the release's `SHA256SUMS`.

3. Update each worker. Workers don't update themselves. Either:
   - run `fleetd update` on the worker, or
   - run `fleetd machine add <ssh-host>` on the hub, which copies the hub's binary over.

### The desktop app {#app}

The app checks for updates when it opens and every few hours, and downloads them in the background. When one is
found, the sidebar says **Update available**: click it to see what's new, then **Update and restart**. A message you
were typing is still there after the restart. An update you don't install now installs the next time you quit.

- **Check for Updates…** is in the fleetd menu on macOS, in Help on Linux, and in the command palette.
- The same window shows the hub's version. When the hub is older than the app, the sidebar says **Update the hub**.
  **Update the hub** restarts the hub once its lead and agents finish; **Restart the hub now** asks first, naming
  what a restart would stop. When the hub can't update itself, the window shows `fleetd update` to run on the hub's
  machine, with **Copy**: it restarts the hub, so run it when nothing is working. The app's own restart never
  restarts the hub.
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
