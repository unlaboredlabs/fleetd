---
title: The agents' Mac
description: One Mac that every agent uses from wherever it runs, for its shell, Xcode builds and iOS simulators, through the mac command.
---

Browsers, Linux desktops and Android emulators are cheap to start anywhere; Macs aren't. So fleetd lends one real Mac
to every agent at once. Its node runs as a standard macOS user of its own (`agents`: no admin, no Apple ID, no keys),
never in your account, and it runs no agents or [Navis](/docs/navi) itself. Agents stay on the machines their projects
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

When `mac` can't reach a Mac (none joined, it's turned off, or it restarted and waits for its agents login), it says so
in one line and exits with 69; the agent carries on without it and says so.

## iOS simulators {#sim}

`mac sim start` gives the agent an iOS simulator of its own: a booted clone of the Mac's golden simulator, from the
same warm pool as [iOS screens](/docs/browser-sessions#ios), headless. From then on the agent drives it with
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
- **Agents share one macOS user** ([what stays shared](#shared)), which is why the Mac is a tool, never a
  runner ([turn it on](#setup)).

## Turn it on {#setup}

The agents' Mac is a tool, never a runner:

- No agent, lead or Navi runs there, whatever its [machine roles](/docs/machines#roles) say. Its agents role stays
  off, and no project can be added on it.
- It takes no secret: the app never seals a Claude account, an API key, a 1Password token, an MCP server's secret, a
  project's variable or a browser fill to it, and its node refuses one that comes anyway.
- Its node relays no `fleetd` call made on the Mac (every process there is some project's job): `fleetd` commands
  typed there answer "this Mac is a tool for agents elsewhere: run fleetd from your own machine".
- Your own account on the Mac runs no fleetd node.

A Mac nobody else uses (a Mac mini) is best: then there's no Apple ID, iCloud keychain or browser login on its disk at
all. Release signing stays in CI.


The setup is the optional **A Mac for agents** step in **Settings › Hub › Setup** (and `fleetd init --step mac`), and
**Settings › Hub › Machines › Add machine › A Mac for agents**. You do three things; fleetd does the rest.

### 1. In your own account: make the agents' user {#admin}

On the Mac, in your own (admin) account's Terminal, paste:

```sh
# A standard (non-admin) user of its own for agents. You choose its password and keep it.
sudo sysadminctl -addUser agents -fullName "fleetd agents" -password -
# Simulators and debugging for that user, with no admin prompt.
sudo dseditgroup -o edit -a agents -t user _developer
sudo DevToolsSecurity -enable
# Xcode's licence and its system components, which only an admin can accept and install.
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
# Your own home closed to every other user, agents included.
chmod 700 ~
```

| Line | Why |
|---|---|
| `sysadminctl -addUser` | Agents act as this user. A standard user can't install system software, change settings for others or read your files. Made without `-adminUser`, it gets no FileVault secure token, so its password can't unlock the disk. Keep its password in your password manager: you log it in after the Mac restarts. |
| `dseditgroup … _developer`, `DevToolsSecurity -enable` | Simulators, `xcodebuild test` and debugging without asking for an admin's password, which agents don't have. |
| `xcodebuild -license accept`, `-runFirstLaunch` | Until an admin accepts Xcode's licence and installs its components, `xcodebuild` and `simctl` refuse to run. |
| `chmod 700 ~` | macOS leaves homes readable by other users (`drwxr-xr-x`, or `drwxr-x---` with group `staff`, which every user is in). This closes yours. Not `-R`: only the folder itself. |

Xcode itself comes from the App Store in your account, and an iOS simulator runtime with `xcodebuild
-downloadPlatform iOS` there.

### 2. Log in as fleetd agents and join {#join}

Log out (or switch user), log in as **fleetd agents**, and paste the join line in its Terminal. Add machine › A Mac for
agents makes it, with a one-time code that works for 15 minutes:

```sh
curl -fsSL https://fleetd.sh | sh -s -- --join http://devbox.example.ts.net:4790 --code <code> --machine-id mac --mac
```

`--mac` makes it the agents' Mac. The installer refuses an admin user, or one that can `sudo` without a password,
before it downloads anything; it installs no app there, and needs no `claude`. The node runs as a LaunchAgent of
`agents`, and installs for itself, each pinned and checked by its digest:

- Node.js 24 (for agent-device), first on the node's `PATH`;
- [agent-device](https://github.com/callstack/agent-device), which drives iOS simulators;
- [agent-desktop](https://github.com/vercel-labs/agent-desktop), which drives the Mac's own apps.

Nothing comes from your Homebrew, which agents can't write. The node also keeps the Mac from sleeping while idle
(an IOKit assertion, as `caffeinate` takes); a closed laptop lid still sleeps.

### 3. Two clicks at the Mac {#permissions}

Still logged in as fleetd agents, open **System Settings › Privacy & Security** and turn on **fleetd** in
**Accessibility** (agents click and type in the Mac's apps) and **Screen Recording** (you and agents see the screen).
The node asked macOS for both when it started, so fleetd is in each list. macOS may ask for an administrator's
name and password: type yours in that System Settings dialog at the Mac itself, never through fleetd's view of its
screen. Then restart the node in fleetd agents' Terminal, since macOS gives a running process a new grant only once
it starts again:

```sh
launchctl kickstart -k gui/$(id -u)/sh.fleetd.node
```

macOS asks again from time to time: the check says when.

Never grant Terminal, an editor or any app you use yourself in the agents' user: a grant reaches everything that app
runs.

## The checks {#checks}

The node checks the Mac every 30 seconds, as agents with no admin, so each check tests what a process of that
user can do. The setup step and the doctor show them as `<machine>/mac_<check>`; Test reads them again.

| Check | Passes when | Fix |
|---|---|---|
| `mac_standard_user` | The user isn't in `admin`, and `sudo -n true` fails. While it fails, the node offers agents no tool. | Users & Groups in your account: turn off "Allow this user to administer this computer". |
| `mac_other_homes` | No other `/Users/*` home opens for it. | `chmod 700 ~` in that person's account. |
| `mac_no_apple_id` | No Apple ID is signed in for it. | Sign out in System Settings, as fleetd agents. |
| `mac_no_secure_token` | `sysadminctl -secureTokenStatus` says DISABLED. | `sudo sysadminctl -secureTokenOff agents …` in your account. |
| `mac_developer` | It is in `_developer`. | `sudo dseditgroup -o edit -a agents -t user _developer` |
| `mac_xcode` | A full Xcode is selected, its licence accepted and its first launch run. | The admin block's Xcode lines, or `sudo xcode-select -s /Applications/Xcode.app` |
| `mac_ios_runtime` | `xcrun simctl list runtimes` has an available iOS runtime. | `xcodebuild -downloadPlatform iOS` in your account. |
| `mac_accessibility`, `mac_screen_recording` | macOS says the node has each grant (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`; reading never prompts). | Turn on fleetd in that pane, as fleetd agents. |
| `mac_gui_session` | fleetd agents is the user at the Mac's screen (`console`). Behind someone else's session (`background`) it warns: builds and simulators work, the Mac's own apps need fleetd agents at the screen. | Switch to fleetd agents at the Mac, or use a Mac nobody sits at. |
| `mac_tools` | The pinned Node.js, agent-device and agent-desktop are installed. | The Mac must reach nodejs.org and registry.npmjs.org. |
| `mac_keep_awake` | The node holds its keep-awake assertion. | `sudo pmset -a sleep 0` in your account. |

## After a restart {#restart}

The node runs inside fleetd agents' login session, so it starts only once that user logs in. With FileVault on, macOS
has no automatic login: after a restart the Mac shows offline, and its row says to log in as fleetd agents (at the Mac
or over Screen Sharing). Turning on automatic login for fleetd agents means turning FileVault off: unattended restarts
against a disk anyone holding the Mac can read. That's your call.

## Agents may use this Mac {#switch}

**Settings › Hub › Machines › Machine roles** shows the agents' Mac with one switch, **Agents may use this Mac**, for
every project's agents (Navis never). Off, agents' `mac` commands answer that the Mac is turned off. Under it, the row
says why agents can't use the Mac now, when they can't: offline, or a node that doesn't offer the tool.

## Move a Mac that runs fleetd in your account {#move}

A Mac already joined from your own account moves into the agents' user under the same name, so its history stays:

1. Let the agents running on it finish, or stop them, and push any work they left: removing the old node in step 4
   deletes its worktrees, uncommitted and unpushed work included.
2. Do [steps 1 and 3](#setup) as above.
3. As fleetd agents, paste the line **Add machine › A Mac for agents** makes for its name: a machine of that name
   gets `--rejoin`, which enrolls it again with a new key.
4. In your own account, stop and remove the old node:

   ```sh
   launchctl bootout gui/$(id -u)/sh.fleetd.node; rm -rf ~/.fleetd/node
   ```

The new key means the old node would be refused anyway. The fleetd app can stay in your account: it's a client, not a
node. A project that lived on the Mac runs no agents there any more: add it on another machine, whose agents then use
the Mac.

## What stays shared {#shared}

Every project's agents act as the same `agents` user, so they can see each other's files, processes and
simulators on the Mac. Put nothing there you wouldn't give every project. The same user can read the node's own key,
as on any worker. Loopback ports are shared between macOS users too: a server you run in your own account on the same
Mac is reachable from the agents' user.

## node.json {#node-json}

`--mac` writes two keys in the node's `node.json`:

| Key | What it does |
|---|---|
| `"agentsMac": true` | This machine is the agents' Mac: a tool, never a runner. Only `--mac` sets it; no switch in the app turns it off. The node offers agents its tool only on macOS and while its user is a standard one (not in `admin`, and `sudo -n` fails); otherwise its `mac_standard_user` check says why. |
| `"mac": {"enabled": true}` | Its own screen, which one agent at a time drives ([the Mac's screen](/docs/browser-sessions#mac)). Settings › Hub › Machines › Screens turns it off and on; the Mac stays a tool either way. |
| `"mac": {"simulators": N}` | How many [iOS simulators](#sim) agents may have booted at once. Absent: from the Mac's memory. Not written by `--mac`. |
