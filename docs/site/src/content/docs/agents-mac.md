---
title: The agents' Mac
description: One Mac that every agent uses from wherever it runs, for its shell, Xcode builds and iOS simulators, through the mac command.
---

Browsers, Linux desktops and Android emulators are cheap to start anywhere; Macs aren't. So fleetd lends one real Mac
to every agent at once. Its node runs in the account logged in at the Mac's screen (yours is fine, an admin's too, or
a [user of its own](#own-user)), and it runs no agents or leads itself. Agents stay on the machines their projects
live on and reach the Mac with the `mac` command, through the hub.

## How an agent uses it {#use}

Every coding agent has `mac` on its PATH:

| Command | What it does |
|---|---|
| `mac push` | The agent's worktree as it is now, its commits, uncommitted changes and new files that git doesn't ignore, becomes its folder on the Mac. Only what the Mac doesn't hold yet goes across. |
| `mac run [--bg] [--env NAME]... [--] <command line>` | Runs the command line in that folder with the Mac's shell, as ssh would. It prints the output as it comes (stdout and stderr together) and exits with the command's exit code. `--bg` keeps it running and prints its job number. |
| `mac logs <job> [-f]` | A job's output so far; `-f` follows it to its end. |
| `mac ps` / `mac kill <job>` | The agent's jobs, and ending one (its whole process group). |
| `mac pull <path> [to]` | A file or folder from the agent's folder on the Mac into its worktree, as `cp -R` would: to `to` (into it, when it's a folder), or the path's last part. Nothing there is deleted: files go over the files of their names. A relative path starts in the pushed worktree there. |
| `mac sim start` / `mac sim end` | An [iOS simulator](#sim) of the agent's own on the Mac, and ending it. |

A typical turn:

```sh
mac push
mac run -- xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' test
mac pull ../DerivedData/Logs/Test out/test-logs
```

When `mac` can't reach a Mac (none joined, it's turned off, or it restarted and waits for its account to log in again), it says so
in one line and exits with 69; the agent carries on without it and says so.

## iOS simulators {#sim}

`mac sim start` gives the agent an iOS simulator of its own: a booted clone of the Mac's golden simulator, headless.
From then on the agent drives it with
[agent-device](https://github.com/callstack/agent-device), as it always has: an `agent-device` first on its PATH runs
each command on the Mac, already pointed at that simulator (pass no `--udid` or `--platform`). `agent-device` inside
`mac run` is pointed at it too.

```sh
mac sim start
mac push && mac run -- xcodebuild -scheme App -sdk iphonesimulator build
agent-device install ../DerivedData/Build/Products/Debug-iphonesimulator/App.app
agent-device open com.example.app
agent-device snapshot -i
agent-device screenshot shot.png && mac pull shot.png
mac sim end
```

agent-device runs in the agent's pushed worktree on the Mac (`repo/`, with its builds in `../DerivedData`), so the
files it reads and writes are there: `mac push` what it installs, `mac pull` what it writes. An agent holds one
simulator; asking again gives the same one. `mac sim end` deletes it with everything done in it, and so does 30
minutes with no `mac` command from that agent.

The Mac makes its golden simulator by itself once its tool is on (minutes, the first time: a boot to settle, then
agent-device's runner built with `xcodebuild`); until then `mac sim start` says it's still being made. It needs an iOS
runtime (the `mac_ios_runtime` check), and the doctor's `ios` check says where the golden stands. The simulators live
in a device set of the node's own (`~/.fleetd/node/device/ios/set`), apart from the ones in Xcode, and the golden is
the newest iOS runtime on a plain iPhone. The node keeps a clone booted for the next `mac sim start`, with
agent-device's runner already started in it, and boots another behind it; when boots keep failing it waits before the
next one, a minute doubling up to half an hour. It deletes the clones a stopped node left behind each time it starts.
They're always on: an older `"ios": {"enabled": false}` in its node.json is ignored. `"mac": {"simulators": N}` caps
them.

The Mac boots at most as many simulators at once as its memory allows: one for every 3 GB past the 8 GB the Mac keeps
for itself (2 on 16 GB, 8 on 32 GB), at least one. `"mac": {"simulators": N}` in its node.json sets another number. When all are
taken, `mac sim start` says so; the agent tries again later or does without.

## Each agent's folder {#folders}

The Mac keeps a folder per agent, `~/work/<task>` in the `agents` user's home:

- `repo/`: the worktree as the agent's last `mac push` left it. Files git ignores there (builds, `node_modules`, Pods)
  stay between pushes.
- `DerivedData/`: `xcodebuild`'s build folder for this agent alone. The `xcodebuild` on a job's PATH passes it to
  build, test and archive unless the command names its own `-derivedDataPath`.
- `tmp/` (a job's `TMPDIR`) and `jobs/` (each run's output).

A job gets `$FLEETD_MAC_DIR`, `$FLEETD_MAC_REPO`, `$FLEETD_MAC_DERIVED_DATA` and `$FLEETD_MAC_CACHE`, a folder every
agent shares (the `agents` user's own caches, such as Swift packages', are shared too). Homebrew belongs to you, not
to `agents`: an agent that needs a tool installs it under its own home.

A folder nothing touched for 3 days goes. Jobs end with the Mac's node: a restart or an update ends them.

## What crosses {#security}

- **Each step is sealed** by the agent's node to the Mac's key, with a fresh key for its answer: the hub sees who
  calls, never a command, a file or an output. The Mac takes each step once, and only within 5 minutes of when it was
  made.
- **No secrets by default.** A job gets none of the agent's project or order secrets, and none of the Mac node's
  environment beyond `HOME`, `PATH`, `USER` and the locale. `--env NAME` sends that one variable, for that command
  only; its value is masked in the job's output.
- **Files stay in their folders.** `push` reads only the agent's worktree, `pull` writes only into it (a folder comes
  back with no links), and the Mac reads only the agent's own folder for it.
- **Every `mac run` is in the agent's action log**, with its exit code once it ends. One whose `mac` stopped
  following it (a timeout, Ctrl-C) ends on the Mac a minute later, and its line closes with what the Mac says.
- **Agents share one macOS account**, the node's ([what stays shared](#shared)), which is why the Mac is a tool, never
  a runner ([turn it on](#setup)).

## Turn it on {#setup}

The agents' Mac is a tool, never a runner:

- No agent or lead runs there, whatever its [machine roles](/docs/machines#roles) say. Its agents role stays
  off, and no project can be added on it.
- It takes no secret: the app never seals a Claude account, an API key, a 1Password token, an MCP server's secret, a
  project's variable or a browser fill to it, and its node refuses one that comes anyway.
- Its node relays no `fleetd` call made on the Mac (every process there is some project's job): `fleetd` commands
  typed there answer "this Mac is a tool for agents elsewhere: run fleetd from your own machine".
A Mac nobody else uses (a Mac mini) is best. Release signing stays in CI.

### From the fleetd app on the Mac {#app}

The main way in needs no terminal:

1. On your main machine, open **Settings › Hub › Machines › Add machine › A Mac for agents**. It shows a 6-digit code,
   and the hub's address under it.
2. On the Mac, in the account it joins from (yours is fine), open the [fleetd app](/docs/desktop-app) and choose **Set
   up this Mac for agents**: on its first window, or in the **fleetd** menu when it's already signed in. A small
   window of its own opens, not the full app.
3. Type the code. The app looks for the hub without it: hubs it's signed in to, and machines on your tailnet answering
   on port 4790. One found is your hub; several, it asks which; none, it asks for the address. The code goes to that
   one hub only.

The app then does the rest, a step at a time: it installs the hub's own fleetd, joins as the agents' Mac (asking first
when that replaces a node, this Mac's or the hub's Mac of that name) and starts the node in this login. Then it opens
**Accessibility** and **Screen Recording** in System Settings and sees each switch as you turn it on, and ends with a
Test that turns green check by check. Each failure says what to do. Xcode's [one-time block](#xcode) still takes an
admin's Terminal; its checks say so when it's missing. Close the window partway and open it again from the
**fleetd** menu: it opens on where setup stands (still joining, the checks of a Mac joined already, or a code spent
with nothing joined and what to do next).

The code works once, for 10 minutes, and a new one replaces the one before. Wrong codes are limited per address (5 a
minute) and per code: ten wrong ones while it's open close it, and Add machine says so and makes a new one. Nothing
is locked hub-wide. Neither the code nor its enroll token gives a key to the hub: the app on the Mac stays signed out
unless you sign it in yourself.

### Or in Terminal {#terminal}

The same setup is the optional **A Mac for agents** step in **Settings › Hub › Setup** (and `fleetd init --step mac`),
and **Use Terminal instead** under the code in Add machine. You paste two things at the Mac and click two switches;
fleetd does the rest, and ends at the checks.


#### 1. Xcode, once {#xcode}

In Terminal on the Mac, in the account it joins from (yours is fine), paste:

```sh
# Xcode's licence and its system components, which only an admin can accept and install.
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
# Simulators and debugging with no password prompt, for this account.
sudo DevToolsSecurity -enable
sudo dseditgroup -o edit -a "$(id -un)" -t user _developer
```

Until an admin accepts Xcode's licence and installs its components, `xcodebuild` and `simctl` refuse to run. The
`_developer` group and `DevToolsSecurity` let simulators, `xcodebuild test` and debugging run without a password
prompt nobody is there to answer. Xcode itself comes from the App Store, and an iOS simulator runtime with
`xcodebuild -downloadPlatform iOS`.

#### 2. Join, at the Mac's screen {#join}

Paste the join line in Terminal on the Mac, logged in at its screen (or over Screen Sharing). `su` and ssh won't do:
launchd runs the node only inside a login at the screen, and the installer says so, before it changes anything, when
there's none. Add machine › A Mac for agents makes the line, with a one-time code that works for 15 minutes:

```sh
curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox.example.ts.net:4790 --code <code> --machine-id mac --mac
```

If this Mac runs fleetd already, give the line that machine's name: it [becomes the agents' Mac](#move) with its
history. `--mac` makes it the agents' Mac. It installs no app and needs no `claude`. The node runs as a LaunchAgent of
that account, and installs for itself, each pinned and checked by its digest:

- Node.js 24 (for agent-device), first on the node's `PATH`;
- [agent-device](https://github.com/callstack/agent-device), which drives iOS simulators;
- [agent-desktop](https://github.com/vercel-labs/agent-desktop), which drives the Mac's own apps.

Nothing comes from Homebrew. The node also keeps the Mac from sleeping while idle (an IOKit assertion, as `caffeinate`
takes); a closed laptop lid still sleeps.

#### 3. Two clicks at the Mac {#permissions}

Right after it joins, the line opens **System Settings › Privacy & Security › Accessibility** and waits; once fleetd
is on there, it opens **Screen Recording** and waits again. Turn on **fleetd** in each: Accessibility lets agents
click and type in the Mac's apps, Screen Recording lets you and agents see the screen. The node asked macOS for both
when it started, so fleetd is in each list. macOS may ask for an administrator's name and password: type it in that
System Settings dialog at the Mac itself, never through fleetd's view of its screen.

macOS gives a running process a new grant only once it starts again, so the node restarts itself within seconds of
each grant. While a grant is off, every 2 seconds, it asks a fresh process of its own (`fleetd node grants`) what
macOS has granted it, and when that one has a grant the node lacks, restarts (`fleetd node restart`), once for each
change. The restart ends any `mac run` jobs then running. The line then waits for the node's checks and lists any that
still fail, each with its fix. Should a grant still read off, restart the node yourself:

```sh
fleetd node restart
```

macOS asks again from time to time: the check says when. The setup step's **Test** reads every check; done means each
is green.

### A user of its own, optional {#own-user}

Agents act as the account the node runs in: their `mac run` commands can read what it can, your files and logins
included when it's yours. To keep them out of yours, give them a standard user of their own. In your own (admin)
account's Terminal:

```sh
# A standard user of its own for agents. You choose its password and keep it.
sudo sysadminctl -addUser agents -fullName "fleetd agents" -password -
sudo dseditgroup -o edit -a agents -t user _developer
# Your own home closed to other users, agents included.
chmod 700 ~
```

Made without `-adminUser`, it gets no FileVault secure token, so its password can't unlock the disk. `chmod 700 ~`
closes your home, which macOS leaves readable to other users (not `-R`: only the folder itself). Then log in as fleetd
agents at the Mac's screen (Apple menu › Lock Screen, then fleetd agents) and do steps 2 and 3 there.

## The checks {#checks}

The node checks the Mac every 30 seconds as its own account, and its grants every 2 seconds while one is off; the hub
adds `mac_one_node`. The setup step and the doctor show them as `<machine>/mac_<check>`; Test reads them again. On the
Mac itself the node writes its last checks to `~/.fleetd/node/mac-health.json`, which setup reads while it waits, and
touches `~/.fleetd/node/mac-health.checked` after each run of every check: setup ends on a run from after both grants,
with no check still in progress (its tools installing), and lists one still in progress as a warning, not a failure.

| Check | Passes when | Fix |
|---|---|---|
| `mac_developer` | The account is in `_developer`. | `sudo dseditgroup -o edit -a "$(id -un)" -t user _developer` |
| `mac_xcode` | A full Xcode is selected, its licence accepted and its first launch run. | [Step 1](#xcode)'s Xcode line, or `sudo xcode-select -s /Applications/Xcode.app` |
| `mac_ios_runtime` | `xcrun simctl list runtimes` has an available iOS runtime. | `xcodebuild -downloadPlatform iOS` |
| `mac_accessibility`, `mac_screen_recording` | macOS has given fleetd's node each grant (asked of a fresh process, `fleetd node grants`; reading never prompts). | Turn on fleetd in that pane at the Mac; the node restarts itself to take it up. |
| `mac_gui_session` | The node's account is the one at the Mac's screen (`console`). Behind someone else's session (`background`) it warns: builds and simulators work, the Mac's own apps need that account at the screen. | Switch to that account at the Mac, or use a Mac nobody sits at. |
| `mac_tools` | The pinned Node.js, agent-device and agent-desktop are installed. | The Mac must reach nodejs.org and registry.npmjs.org. |
| `mac_keep_awake` | The node holds its keep-awake assertion. | `sudo pmset -a sleep 0` |
| `mac_one_node` | No other machine of the hub is enrolled from this Mac (the hub compares the computer each node says it runs on). One that is: an older node there, joined under another name. | `fleetd machine remove <name>` on the hub. Where it ran in another account on the Mac, stop it there too: `launchctl bootout gui/$(id -u)/sh.fleetd.node; rm -rf ~/.fleetd/node`. |

A node from before the Mac could join from any account may still report `mac_standard_user`, `mac_other_homes`,
`mac_no_apple_id` and `mac_no_secure_token`; the setup step no longer counts them.

## After a restart {#restart}

The node runs inside its account's login session, so it starts only once that account logs in. With FileVault on,
macOS has no automatic login: after a restart the Mac shows offline, and its row says to log in again (at the Mac or
over Screen Sharing). Turning on automatic login means turning FileVault off: unattended restarts against a disk anyone
holding the Mac can read. That's your call.

## Agents may use this Mac {#switch}

**Settings › Hub › Machines › Machine roles** shows the agents' Mac with one switch, **Agents may use this Mac**, for
every project's agents. Off, agents' `mac` commands answer that the Mac is turned off. Under it, the row
says why agents can't use the Mac now, when they can't: offline, or a node that doesn't offer the tool.

## A Mac that runs fleetd already {#move}

A Mac joined as an ordinary machine becomes the agents' Mac under the same name, so its history stays:

1. Let the agents running on it finish, or stop them, and push any work they left.
2. In the same account, paste the line **Add machine › A Mac for agents** makes for its name: a machine of that name
   gets `--rejoin`, which enrolls it again with a new key, as the agents' Mac.

Joining under another name, or from another account (a [user of its own](#own-user)), leaves the old machine
enrolled: the `mac_one_node` check fails until you remove it with `fleetd machine remove <name>` on the hub, and, in
the account it ran in, `launchctl bootout gui/$(id -u)/sh.fleetd.node; rm -rf ~/.fleetd/node` (which deletes its
worktrees, unpushed work included). The fleetd app can stay: it's a client, not a node. A project that lived on the
Mac runs no agents there any more: add it on another machine, whose agents then use the Mac.

## What stays shared {#shared}

Every project's agents act as the node's account, so they can see each other's files, processes and simulators on the
Mac, and whatever that account can read: in your own account, your files, keychain prompts and browser logins too.
Put nothing there you wouldn't give every project, or give agents a [user of their own](#own-user). That account can
read the node's own key, as on any worker. Loopback ports are shared between macOS users too.

## node.json {#node-json}

`--mac` writes two keys in the node's `node.json`:

| Key | What it does |
|---|---|
| `"agentsMac": true` | This machine is the agents' Mac: a tool, never a runner. Only `--mac` sets it; no switch in the app turns it off. The node offers agents its tool on macOS, in whatever account it runs. |
| `"mac": {"enabled": true}` | Its own screen, which one agent at a time drives ([the Mac's screen](/docs/browser-sessions#mac)). Settings › Hub › Machines › Screens turns it off and on; the Mac stays a tool either way. |
| `"mac": {"simulators": N}` | How many [iOS simulators](#sim) agents may have booted at once. Absent: from the Mac's memory. Not written by `--mac`. |
| `"ios": {…}` | The [simulators](#sim)' golden and warm pool, by hand only: `enabled` (`false` turns them off; absent, on), `pool` (clones kept booted, absent 1, each 1–2 GB of memory) and `deviceType` (such as `iPhone 17 Pro`; absent, the newest plain iPhone of the newest iOS runtime; a change takes effect when the golden is made again: delete `device/ios/golden.json`). Not written by `--mac`. |
