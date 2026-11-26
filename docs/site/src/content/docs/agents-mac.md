---
title: The agents' Mac
description: Lend one Mac to every agent for Xcode builds, iOS simulators and Mac apps.
---

This page is for setting up one Mac that every agent can use for Xcode builds, iOS simulators and Mac apps.

Agents keep running on their own machines and reach the Mac with the `mac` command. No agent runs on the Mac itself,
and it gets none of your bots' secrets. A Mac nobody else uses, such as a Mac mini, works best.

If your agents already run on a Mac, you don't need a second one: see [One Mac](#one-mac).

## One Mac {#one-mac}

A Mac that runs agents lends them its own Xcode and iOS simulators. Its agents use the same `mac` commands, on that
same Mac:

- `mac run` runs in the agent's worktree. `mac push` has nothing to copy, and `mac pull` copies within the worktree.
- `mac sim start` gives the agent one of that Mac's own simulators, from its own warm pool. agent-device drives it,
  and it shows under **Screens** like any agent's simulator.
- `mac run`, `mac push` and `mac sim start` print one line saying which Mac they used.

Nothing to set up beyond Xcode (the [Xcode block](#xcode) once, and an iOS runtime). The first `mac sim start` makes
the Mac's golden simulator, once: it takes a few minutes, and `mac sim start` waits for it. From then on one simulator
stays booted and ready for the next agent. A person can open an iPhone screen on that Mac from the start too. A Mac
without Xcode offers no simulators, and `mac sim start` says Xcode is missing. If Node.js isn't on the Mac, fleetd installs its own copy for agent-device.

At most two simulators run at once, the ready one and any `--device` model included. Change it on the Mac's page,
under **Screens › iOS simulators at once**; the Mac takes a new number at once.

Which Mac an agent uses:

| The agent runs on | `mac` uses |
|---|---|
| A Mac | That Mac, even when an agents' Mac is joined |
| Any other machine | The agents' Mac, as before |

A Mac lends its simulators only to its own agents, never to agents on other machines. **Agents may use this Mac**
switches the agents' Mac alone.

## Set it up {#setup}

### From the fleetd app {#app}

1. On your main computer, open **Settings › Workspace › Machines**, click **+**, then **A Mac for agents**. It shows a
   6-digit code.
2. On the Mac, open the [fleetd app](/docs/desktop-app) and choose **Set up this Mac for agents** (on its first
   screen, or in the **fleetd** menu).
3. Type the code. The app finds your workspace, installs fleetd and joins.
4. Click **Allow** for **Accessibility**, then **Screen Recording**, and turn on **fleetd** in each System Settings
   pane that opens. Then click **Allow** in macOS's screen capture prompt.
5. Wait for the checks to turn green.

The code works once, for 10 minutes.

### In Terminal {#terminal}

Choose **Use Terminal instead** under the code. Then, at the Mac's screen (not over ssh):

1. Run the Xcode block below once, if Xcode is installed.
2. Paste the join line it gives you. It installs fleetd, joins as the agents' Mac, and asks for the two permissions.

#### Xcode, once {#xcode}

```sh
sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch
sudo DevToolsSecurity -enable
sudo dseditgroup -o edit -a "$(id -un)" -t user _developer
```

Without these, builds and simulators stop at a password prompt nobody is there to answer. Get Xcode from the App
Store, and an iOS runtime with `xcodebuild -downloadPlatform iOS`.

#### The join line {#join}

```sh
curl -fsSL https://fleetd.sh | FLEETD_JOIN_CODE=<code> sh -s -- --join http://devbox.example.ts.net:4790 --machine-id mac --mac --version <workspace version>
```

Run it logged in at the Mac's screen, or over Screen Sharing. The code works once, for 15 minutes.

#### CocoaPods {#cocoapods}

`pod install` needs CocoaPods from Homebrew:

```sh
/opt/homebrew/bin/brew install cocoapods
```

### Keep it awake and unlocked {#awake}

Agents can't see or click a locked screen. In System Settings:

- **Lock Screen**: set **Require password after screen saver begins or display is turned off** to **Never**.
- **Energy**: turn on **Prevent automatic sleeping when the display is off**.

After a restart, log in to the Mac again: with FileVault on, fleetd can't start until you do.

### A user of its own {#own-user}

Agents act as the Mac account fleetd runs in, so they can read what it can. To keep them out of your files, make a
standard user for them and set up from there:

```sh
sudo sysadminctl -addUser agents -fullName "fleetd agents" -password -
sudo dseditgroup -o edit -a agents -t user _developer
chmod 700 ~
```

Then log in as fleetd agents at the Mac's screen and run setup there.

## How agents use it {#use}

| Command | Does |
|---|---|
| `mac push` | Copy the agent's work to its folder on the Mac |
| `mac run -- <command>` | Run a command there (`--bg` to keep it running) |
| `mac pull <path>` | Copy a file or folder back |
| `mac sim start` | Get an iOS simulator of its own |

A typical turn:

```sh
mac push
mac run -- xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 17' test
mac pull ../DerivedData/Logs/Test out/test-logs
```

A command gets none of the agent's secrets unless it passes one with `--env NAME`.

A job keeps running through an update's restarts of the workspace and the Mac's node. `mac run` picks up its output
where it stopped once the Mac is back.

Builds take turns. Each `xcodebuild` that builds (`expo run:ios` too) waits for one of the Mac's build slots: one per
4 cores, and one per 4 GB of memory past 8 GB, whichever allows fewer (2 on a 12-core, 16 GB Mac mini). Each build
gets its share of the cores. A build past them waits and says so in its output, then starts once one ends.

## iOS simulators {#sim}

`mac sim start` gives the agent its own iPhone simulator. The agent drives it with
[agent-device](https://github.com/callstack/agent-device), and `mac sim end` deletes it. An unused simulator ends
after 30 minutes.

- For another model: `mac sim start --device "iPad Pro 13-inch (M5)"`.
- When all simulators are in use, agents wait in line, first come first served.
- The Mac runs at most two simulators at once, the one kept ready included, or one with less than 11 GB of memory.
  Change it on the Mac's page in **Settings › Workspace › Machines**, under **Screens › iOS simulators at once**. Each
  takes about 3 GB.

### Watch or take over a simulator {#sim-screens}

Each simulator shows under **Screens**, named for its device and agent. Watch it live, click **Take over** to tap and
type in it yourself, and **Hand back** when done. See [Screens](/docs/browser-sessions#takeover).

To open a simulator of your own, choose **New screen › iPhone** and pick the model.

A simulator is recorded from its start to its end, watched or not. The recording is the live view itself, frame for
frame: upright as the simulator's screen is, and on an iPhone Duo the panel its fold lights. Its replay notes each turn
and fold.

The simulator shows inside a 3D model of its device: an iPhone Duo with its hinge, an iPhone with its island and
camera, and a plain phone for an Android. The model folds, opens and turns with the simulator, and the picture fills
its screen exactly. Drag around the screen to turn the model; double-click or **Face front** turns it back. The cube
button switches between 3D and a flat frame. A computer without WebGL shows the flat frame, and one that draws WebGL
without a graphics card starts flat until you pick 3D.

### Device controls {#sim-controls}

While you have control, a toolbar beside the simulator offers these. Agents run the same as `mac sim` commands:

- Home and Rotate; Rotate right, Lock, Shake and Location under **More**
- Light or dark appearance
- Text size (`mac sim text-size extra-large`)
- Location (`mac sim location 48.8584,2.2945`)
- Posture, on an iPhone Duo: Closed, Book (half-open), Open or Laptop (half-open on its side) (`mac sim fold laptop`)
- Screenshot (`mac sim screenshot shot.png`)

## Turn it off {#switch}

The Mac's page in **Settings › Workspace › Machines** has **Agents may use this Mac**. Turn it off and agents' `mac`
commands say the Mac is off.

To stop using the Mac for good, click **Stop being the agents' Mac** in the fleetd app's window on the Mac.

## Checks {#checks}

The Mac's page, the menu bar icon on the Mac and `fleetd doctor` show what's wrong, each with its fix:

| Check | Fix |
|---|---|
| Accessibility, Screen Recording | Turn on **fleetd** in System Settings › Privacy & Security |
| Screen capture | Click **Allow** in macOS's prompt |
| Developer tools | The [Xcode block](#xcode) |
| Xcode | Install it from the App Store, or select it with `sudo xcode-select -s` |
| iOS runtime | `xcodebuild -downloadPlatform iOS` |
| Screen lock, sleep | [Keep it awake and unlocked](#awake) |
| Tools | `brew install cocoapods`; the Mac must reach nodejs.org and npmjs.org |
| Disk | [Disk space](#disk) |

macOS asks again for Screen Recording from time to time. If a permission still reads off, run `fleetd node restart`
on the Mac.

### Xcode missing {#no-xcode}

The Mac joins without Xcode. Only builds and simulators wait for it, and the check turns green by itself once Xcode
is installed and selected.

## Disk space {#disk}

Each agent's folder on the Mac holds its pushed work, its own DerivedData and its job logs. It goes once its task
ends, with any job or simulator the task left running. Each agent keeps its last 20 job logs, each up to 256 MB.

Below 30 GB free, fleetd frees old builds first, then the folders of agents idle for an hour. An agent whose folder
went runs `mac push` again. Below 20 GB, new jobs, pushes and simulators are refused with how much is free, and the
Mac's page shows its disk as failing.

fleetd deletes only its own folders and the simulators it made. Free anything else yourself. Simulators no installed
Xcode can run take the most room:

```sh
xcrun simctl delete unavailable
```

## What agents share {#shared}

Every bot's agents use the same Mac account, so they can see each other's files on it. Put nothing there you wouldn't
give every bot, or use [a user of its own](#own-user).

## node.json {#node-json}

| Key | Does |
|---|---|
| `"agentsMac": true` | Makes this Mac the agents' Mac. Set by `--mac`. |
| `"mac": {"simulators": N}` | How many simulators run at once, unless **iOS simulators at once** is set |
| `"ios": {"deviceType": "…"}` | The default simulator model |
