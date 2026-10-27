---
title: Updating & uninstall
description: Update fleetd and its app, pick a release channel, and remove fleetd from a machine.
---

Keep fleetd up to date, or remove it.

## Update {#update}

### From the app {#everything}

The hub looks for a newer build on its channel every 10 minutes. When it finds one, it downloads it ahead, checks it
against the release's `SHA256SUMS` and keeps it, and its machines fetch it too. Nothing is installed yet. The app then
shows one quiet notice, **fleetd *version* is ready**, with a few lines on what's new and an **Update** button. It shows
once per version and never again for it; the sidebar keeps a small **Update** until you do.

Click **Update**, in the notice or the sidebar. Since the build is already downloaded and checked, an update only swaps
it in and restarts, in order:

1. **The hub** checks the kept build against `SHA256SUMS` again, keeps the binary it runs, and restarts on the new one.
   If the new build doesn't come up healthy within 90 seconds, the previous one is put back and restarted. If the
   hub had nothing ready yet, it downloads the build first.
2. **Every connected machine's node** does the same, all at once, as soon as the hub runs the new build. Nothing is
   installed on a machine before the hub runs the new build. A machine running something that can't carry on through a
   restart (a live browser, device or desktop session, or a preview) waits until it's idle, says so on its line, and
   updates then. A screen whose task has ended doesn't count. The other machines don't wait for it. A machine still
   busy after 4 hours is skipped, with **Retry** on its line. A machine already on the new build, or a newer one
   (updated with `fleetd update` on it, say), is never moved back: its line says which build it runs.
3. **Each machine's Claude Code** goes to the version the new fleetd was tested with (`claude install <version>`).
   Sessions already running finish on the version they started with; new ones start on the new one. If the install
   fails, the machine keeps the version it had and the rest of the update goes on. See
   [Claude Code's version](/docs/machines#claude-version).
4. **The app** installs its own update and restarts, once every machine is done. It downloads that update in the
   background, so it is usually ready by then. A message you were typing is still there after the restart. Only the
   window where you pressed **Update** restarts this way, and it waits for a busy machine too, up to those 4 hours:
   its line says **Waiting** until then. Any other app window never restarts by itself: it waits for your click on
   **Update** or **Restart to update**.

Nothing waits on a timer: each restart starts as soon as the build is in place, and each part shows as updated as soon
as its machine is back on the new build.

The update sheet has one overall state at the top and one line per part: the hub, each machine, Claude Code and the app.
Each line says **Waiting**, **Updating…**, **Done** or **Failed**, with the reason in one line. Each step, with the
hub's own words and each part's version, is behind **Details**. When everything is done, the sheet closes itself and
the sidebar says **Updated**; hover it for the version.

When a part fails, the others still finish:

- A failed download or a checksum mismatch changes nothing on that machine.
- A build that doesn't come up healthy is put back on its own, and the machine runs its previous build again.
- A machine that is offline, or runs a fleetd too old to update from the hub, is skipped and says how to update it.
- If the hub itself didn't update, its machines aren't asked, and **Update** tries the whole update again.
- If the hub moves to another build before every machine is done (with `fleetd update` on its machine, say), the update
  ends there: each machine still to go says the hub moved on, and **Update** brings them to the newest build.

A failed or skipped machine has **Retry** on its line, which updates just that machine (its fleetd, then its Claude
Code) to the build the hub runs. If the hub has moved to another build since (with `fleetd update` on its machine,
say), Retry says so instead, and **Update** brings every machine to the hub's build. After a part failed, the app
doesn't restart by itself, so the result stays on screen: its line has **Update** instead.

Updating needs a key with Admin on every machine, as `fleetd pair` gives the app. The first time, a hub from before
the Update button can't do this yet: the app says so, and `fleetd update` on the hub's machine once (see below) brings it
in. Machines that were online when you pressed Update get a while to reconnect after the hub restarts; one that was
offline, or doesn't come back, is skipped and named in the result.

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
binary right away. On a machine that runs agents, it then moves Claude Code to the version the new fleetd was tested
with, as the app's update does. What they were running carries on by itself, as above. `fleetd machine add <ssh-host>` on the hub
also copies the hub's binary to a worker.

`fleetd status` and `fleetd doctor` say when the CLI, the hub and the nodes run different versions.

### The desktop app {#app}

The app checks for updates when it opens, every 10 minutes and when you come back to its window, and downloads them
in the background; a newer build than one already downloaded replaces it. It has its own line in the update sheet, and
its own **Update and restart** under **Details**. An update you don't install now installs the next time you quit.

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
