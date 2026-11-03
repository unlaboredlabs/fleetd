---
title: The agents' Mac
description: One Mac that every agent uses from wherever it runs, for its shell, Xcode builds and iOS simulators, through the mac command.
---

Browsers, Linux desktops and Android emulators are cheap to start anywhere; Macs aren't. So fleetd lends one real Mac
to every agent at once. Its node runs as a standard macOS user of its own (`agents`: no admin, no Apple ID, no keys),
never in your account, and it runs no agents or [Navis](/docs/navi) itself. Agents stay on the machines their projects
live on and reach the Mac with the `mac` command, through the hub.

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
screen. It asks again from time to time: the check says when.

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
every project's agents (Navis never). Off, agents' `mac` commands (they come with the `mac` tool, in a later release)
answer that the Mac is turned off. Under it, the row
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

`--mac` writes `"mac": {"enabled": true}` in the node's `node.json`. It takes effect only on macOS and only when that
user is a standard one (not in `admin`, and `sudo -n` fails); otherwise the node offers agents no tool, and its
`mac_standard_user` check says why.

| Field | Default | What it does |
|---|---|---|
| `enabled` | off | This machine is the agents' Mac. |
| `simulators` | from its memory | How many iOS simulators agents may have booted at once. |
