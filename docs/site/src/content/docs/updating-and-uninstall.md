---
title: Updating & uninstall
description: Update fleetd and its app, pick a release channel, and remove fleetd from a machine.
---

Keep fleetd up to date, or remove it.

## Update {#update}

### From the app {#everything}

The hub looks for a newer build on its channel every 2 minutes. When it finds one, it downloads it ahead, checks it
against the checksum the release's `release.json` lists for it and keeps it, and its machines fetch it too. Each build
has its own download that never changes, so a release republished mid-download can't swap in another build. Each
downloads the build packed, about a third of its size, and checks it once unpacked; a cut-off download goes on from
where it stopped. Nothing is installed yet. For owners and admins, **Update** then shows under your name at the bottom
of the sidebar, and the menu there has one more row: **Update available**, with **Update**, which starts it. Members
see nothing until an update runs.

Click **Update**. It starts at once, with nothing more to confirm. Since the build is already downloaded and checked,
an update only swaps it in and restarts, in order:

1. **The hub** checks the kept build against that checksum again, keeps the binary it runs, and restarts on the new one.
   If the new build doesn't come up healthy within 90 seconds, the previous one is put back and restarted. If the
   hub had nothing ready yet, it downloads the build first.
2. **Every connected machine's node** does the same, all at once, as soon as the hub runs the new build. Its agents
   run under small hosts of their own that outlive the node, so they carry on through its restart, mid-step included
   (a build, a test run): the node doesn't wait for them. It waits only for what its restart would cut off: a live
   browser, device or desktop session, an approved command running, a check the merge train runs there, or a Navi
   mid-step. On a machine without systemd user scopes (macOS, a container), or when the new build's hosts speak
   another protocol, the agents can't carry on, so the node holds every tool call that hasn't started yet and waits
   for the ones running to end, as before. Either way it updates within 2 minutes, whatever still runs: what the
   restart cuts off carries on by itself. Meanwhile Settings › Hub › Machines › Updates says what the machines wait for and when
   they update at the latest (**Waiting for *n* agents to finish their step, *time* at the latest**). A screen whose
   task has ended doesn't count. Nothing is installed on a machine before the hub runs the new build. A machine
   already on the new build, or a newer one (updated with `fleetd update` on it, say), is never moved back.
3. **Each machine's Claude Code** goes to the version the new fleetd was tested with (`claude install <version>`).
   Sessions already running finish on the version they started with; new ones start on the new one. If the install
   fails, the machine keeps the version it had and the rest of the update goes on. The install downloads about 200 MB
   and gets 45 minutes, enough for a 1 Mbit/s link. See
   [Claude Code's version](/docs/machines#claude-version).
4. **The app** installs its own update and restarts, once every machine is done. It downloads that update in the
   background, so it is usually ready by then. A message you were typing is still there after the restart. Only the
   window where you pressed **Update** restarts this way, and it waits for the machines' wait too. Any other app
   window never restarts by itself: it waits for your click on **Restart to update**.

The hub itself never waits: agents don't need it mid-step. A fleetd tool call an agent makes during the hub's few
seconds of restart fails, and the agent tries it again. A machine counts as updated as soon as it is back on the new
build.

While the hub restarts, the app keeps everything on screen and redials every 250 ms, and a message you send meanwhile
goes once the hub is back. For an update, your name at the bottom of the sidebar says **Updating…**; past 10 seconds the
screens show as loading; past 30 seconds a line at the top says the hub isn't back yet, with **Try now**; past 2
minutes it is shown as offline. Any other restart or stop says nothing of updates and is shown as offline once it
passes 10 seconds. Back on the new build, it says **Updated** for 15 minutes. When the hub or a machine didn't take
the new build, it says **Not updated** to owners and admins, and the menu there has a row saying what didn't update
(**The hub didn't update**, **1 machine didn't update**) with **Try again**. When the hub itself didn't take it,
members read **Not updated** too, and their row says to ask an admin.

The 2 minutes are `drainMinutes` in `~/.fleetd/hub/update/settings.json` (`{"drainMinutes": 10}`; `0` doesn't wait),
read at each update.

**Update automatically**, in Settings › Hub › Machines › Updates (`"auto": true` in the same file), is off by default.
On, the hub installs a new build by itself as soon as it is ready, at most one update in 10 minutes: a build that comes
out within 10 minutes of the last update (yours or its own) waits for those 10 minutes to end, so builds that came out
in between install once, as the newest. It waits for agents as **Update** does. While a build waits for those 10
minutes, the page says **Installs by itself at *time***, with **Update now** to install it at once. A build the hub
didn't come up healthy on, and put back, isn't tried again by itself: the switch says it skips that build, a newer one
installs as usual, and **Update** still installs it. A machine an update left behind the hub (offline then, or failed)
is brought to the hub's build the same way, at the next look, even with nothing newer out. The switch has a line under
it only while the hub holds back, saying why: a build it put back, a local build of fleetd, or a channel it couldn't
read.

A machine installs the build it downloaded and checked when the update started, even if the channel has a newer one
by the time its agents let it restart: edge often does. The next update brings everything to that newer build.

The app names a machine that runs an older fleetd than the hub, with `fleetd update` to run on it, only once it has
been linked 12 minutes and is still behind: never while the hub's update of it is on its way. It clears as soon as the
machine links on the hub's build.

`fleetd update` on a machine holds its own node's agents and waits for their step, 2 minutes at most;
`fleetd update --now` doesn't wait.

Settings › Hub › Machines › Updates (**Check for Updates…** opens it) says one thing at a time, with at most
one button: **Up to date** and the build everything runs, **Update available** with **Update**, the update as it goes
in one line (**Updating the hub…**, then **Updating the machines · 2 of 3**), or what didn't go through. A machine
gets a line of its own only when it didn't update or runs an older build than the hub: its name and why, in one
sentence. Under it is the **Update automatically** switch. Settings › General shows the same status under Version.

When one part of an update fails, the others still finish:

- A failed download or a checksum mismatch changes nothing on that machine. When GitHub's download link for a release
  file fails (a server error or no answer), the file comes through GitHub's releases API instead, checked against
  `SHA256SUMS` the same way. When both fail, the machine's line says **GitHub's downloads are failing right now. Try
  again later.**
- A build that doesn't come up healthy is put back on its own, and the machine runs its previous build again.
- A machine that is offline is skipped: its line says it is offline, and it updates when it's back (by itself with
  **Update automatically** on, else with **Update**). One that runs a fleetd too old to update from the hub is
  skipped too, and its line says to run `fleetd update` on it once.
- If the hub itself didn't update, its machines aren't asked, and **Try again** tries the whole update again.
- If the hub moves to another build before every machine is done (with `fleetd update` on its machine, say), the update
  ends there: the machines still to go show as behind, and **Update** brings them to the hub's build.

An update that stops moving once the hub is done (a machine that never came back, say) says **The update stopped**,
with **Start over**. It shows when nothing has changed for 10 minutes, or at once when nothing in the hub drives the
update any more. Start over ends that update, with each machine still to go skipped, and starts a new one. It never
shows while the hub itself restarts.

After machines didn't update, the page says how many, names each with why, and has **Try again**. It runs the update
again: machines already on the hub's build are left alone, so only the ones behind are updated (their fleetd, then
their Claude Code). After a failure the app doesn't restart by itself, so the result stays on screen.

Updating needs a key with Admin on every machine, as `fleetd pair` gives the app. The first time, a hub from before
the Update button can't do this yet: the app says so, and `fleetd update` on the hub's machine once (see below) brings it
in. Machines that were online when you pressed Update get a while to reconnect after the hub restarts; one that was
offline, or doesn't come back, is skipped and named in the result.

An update never waits for work to finish, only for what a restart would cut off (2 minutes at most, by default). What
a restart cuts off carries on by itself:

- Leads and agents keep running through their node's restart, mid-step included: each runs under a small host process
  of its own that the restarted node picks up again. Agents whose process ended while their node was down resume in
  their threads and worktrees once their machine is back.
- The merge train takes up the change it was merging.
- An approved command that was running runs on through the hub's restart, and its node keeps the result: once the
  node links again, the command reports its real exit code and output. So does an approved `fleetd update`, which
  restarts its own hub; it restarts its node only once it has ended. Only a command its node's restart cut off goes
  back to you, saying it may have run and what to check before you approve it again. It never runs again by itself.

### From a terminal {#cli}

On a machine without the app (a headless worker, say), run:

```sh
fleetd update --check
fleetd update
```

It replaces the CLI, checked against the checksum in the release's `release.json`, then restarts the hub and node
services that run this binary: the hub at once, the node once its agents finish the step they're on (2 minutes at most;
`--now` doesn't wait). On a machine that runs agents, it then moves Claude Code to the version the new fleetd was tested
with, as the app's update does. What they were running carries on by itself, as above. `fleetd machine add <ssh-host>`
on the hub also copies the hub's binary to a worker.

`fleetd status` and `fleetd doctor` say when the CLI, the hub and the nodes run different versions.

### The desktop app {#app}

The app checks for updates when it opens, every 10 minutes and when you come back to its window, and downloads them
in the background; a newer build than one already downloaded replaces it. It downloads only the parts that changed since
the build it runs: about 7% of the AppImage, and about half of the Mac app (from its third update after an install on,
as it keeps the previous download to compare with). It shows in the same place and the same words as the hub's:
when the hub and its machines are up to date, Settings › Hub › Machines › Updates and Settings › General say **Update available**
with **Restart to update**, and **Update** shows under your name for everyone, with the same row in the menu there.
An update you don't install now installs the next time you quit.

- **Check for Updates…** is in the fleetd menu on macOS, in Help on Linux, and in the command palette.
- The `.deb` install can't update itself: the app offers the download and the `sudo apt install` command.

- An earlier fleetd app is replaced by the current one, which keeps its pairing.
- On macOS 11 the earlier app stays as it is: the current app needs macOS 12.
- On a Mac from before the current app, run `fleetd update` twice: the first updates the CLI, the second the app.

fleetd pins the `claude` version separately. See [Claude](/docs/troubleshooting#claude).

## Channels {#channels}

`fleetd update` stays on the channel you installed from. Releases are Edge builds for now: the newest build of main,
published after each merge.

Edge was called Nightly until it was renamed. A machine still on a Nightly build updates to Edge as before, and
`--channel nightly` or `FLEETD_CHANNEL=nightly` mean Edge.

| To | Run |
|---|---|
| Switch an install to stable | `fleetd update --channel stable` |
| Switch an install to Edge | `fleetd update --channel edge` |
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
