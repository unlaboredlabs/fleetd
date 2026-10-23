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

   It replaces the CLI, checked against the release's `SHA256SUMS`. Then it restarts the hub and node services that run this binary, but only when
   nothing runs on them.

   While a lead or agents are working, or a merge the hub is doing, an approved command or a clone is under way, it
   doesn't restart. It lists what runs, and the hub and node keep the version they run until their next restart. To
   restart them anyway, or to finish the update later, run:

   ```sh
   fleetd update --restart-now
   ```

   An install from before this check still restarts the hub and node unconditionally when it updates, because its
   own `fleetd update` does the restart. Run that one update while nothing runs.

3. Update each worker. Workers don't update themselves. Either:
   - run `fleetd update` on the worker, then `fleetd update --restart-now` once its agents are done (a worker can't
     ask the hub what runs on it), or
   - run `fleetd machine add <ssh-host>` on the hub, which copies the hub's binary over.

`fleetd status` and `fleetd doctor` say when the CLI, the hub and the nodes run different versions.

### The desktop app {#app}

The app checks for updates when it opens and every few hours, and downloads them in the background. When one is
found, the sidebar says **Update available**: click it to see what's new, then **Update and restart**. A message you
were typing is still there after the restart. An update you don't install now installs the next time you quit.

- **Check for Updates…** is in the fleetd menu on macOS, in Help on Linux, and in the command palette.
- The same window shows the hub's version. When the hub is older than the app, the sidebar says **Update the hub**.
  **Update the hub** lists what's running on the hub and gives you `fleetd update` to run on the hub's machine, with
  **Copy**; for a hub on this computer, **Run in Terminal** opens it for you and shows its result there. It restarts
  the hub only when nothing is running there; otherwise it says what is, and the hub keeps its old version until you
  run `fleetd update --restart-now` or it next restarts. The app's own restart never restarts the hub.
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
