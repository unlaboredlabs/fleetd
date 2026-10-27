---
title: Screens
description: Agents open a fresh Chrome, Android emulator, iOS simulator or Linux desktop of their own, drive it with agent-browser, agent-device or their desktop tool, and leave a recording on the hub.
---

An agent that needs a web page (to check a signup form on staging, read a dashboard, reproduce a bug) opens a browser
screen. It gets a fresh Chrome on its machine that no other screen shares, drives it with the
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI, and closes it when done. You can watch it live in the
app and take it over. The node records the screen and uploads the recording to the hub.

A screen is any of these an agent opens: a browser, an [Android emulator](#android), an [iOS simulator](#ios) or a
[Linux desktop](#desktop). The app lists them under **Agents › Screens**. The agent tools that open and close one keep
their names, `session_start` and `session_end`.

## How an agent uses one {#use}

1. **`session_start`** with a one-line purpose. The node takes a Chrome it already launched, with an empty profile, so
   the screen starts in a few milliseconds.
2. **agent-browser** in Bash: `agent-browser open <url>`, `snapshot -i`, `click @e3`, `fill @e2 "text"`. Every lead's
   and task's claude has it on its `PATH`, already pointed at its own screen, with agent-browser's skill loaded. The
   agent runs `agent-browser skills get core` once for how to use it.
3. **`session_end`**. The node kills that Chrome, deletes its profile, and uploads the recording.

An agent has one screen open at a time. Its screen also ends when the agent's claude exits (its work is done, it was
stopped or it went idle), or after 30 minutes without an `agent-browser` command. When the agent needs a person (a
captcha, a confirmation only you can give), it calls **`request_takeover`** with what you should do. The tools are on
the [Agent tools](/docs/reference/agent-tools#session_start) page.
The hub decides which machine a screen runs on, by the machines' [roles](/docs/machines#roles): the agent's own when it
hosts screens and has a free screen slot, else another that can, driven through the hub.

## Watch and take over {#takeover}

In the app, **Agents › Screens** lists them: those waiting on you, the live ones, then the recent ones. A live screen
takes the panel's whole width. It streams its page, with its address, to the app as you watch it: the node sends its frames only while
someone watches, and a slow connection skips frames rather than falling behind.
**Take over** gives you the mouse and keyboard on the page once the screen's machine confirms it. While you have
control, the agent's `agent-browser` commands answer that a person has control, and the agent carries on with other
work. **Hand back** returns control: the
agent's next command sees the page as you left it, what you typed included. The recording's action log says who took
over and when, but not what you typed.

A screen whose agent asked for you shows under **waiting on you** with its reason, until you take it over or it ends.

Once it has ended, the screen plays its recording, the panel's whole width. **Steps**, at the end of the player's
controls, opens its steps beside the recording (under it in a narrow panel). Each step jumps the recording to its
moment and opens the page as that step found it. Press **Steps** again to close them. They start closed each time you
open a screen.

Any key that can read the screen's machine may watch. Taking over and typing take a person's device with operate
there. MCP clients use `browser_control` to take over and hand back.

## Isolation {#isolation}

- **A fresh browser per screen.** Each screen gets its own Chrome process and its own empty profile directory.
  Both are thrown away at the end, so no cookie, login or cache from one screen reaches the next.
- **No open debugging port.** Chrome is started with `--remote-debugging-pipe`: only the node holds a connection to
  it. agent-browser reaches it through the node's proxy on `127.0.0.1`, at an address with a token of its own for each
  agent's screen, which only that agent's environment names. An unknown token is refused, and so is any address while
  its agent has no screen open. Agents run as one OS user, though, so an agent that reads another's environment could
  use its token.
- **Chrome's own sandbox**, wherever the machine allows it. A machine without unprivileged user namespaces (Ubuntu
  23.10 and later restrict them by default) runs the pinned headless shell with `--no-sandbox`, and the node's log says
  so once. System Chrome brings its own sandbox helper, so `chrome` set to it keeps the sandbox there.
- **The node's own connection is hidden from the agent.** The node uses its connection for the recording. The
  agent's driver never sees the node's target sessions or screencast frames.

Agents aren't sandboxed on their machine (see [Security](/docs/security#keys)). These measures keep screens apart and
recorded. They can't stop an agent that sets out to get around them, for example by starting a browser of its own.

## What's recorded {#recording}

| File | Holds |
|---|---|
| `video` | A WebM (VP9, 1280×800, 25 frames a second), made from the node's own screencast of the page the agent is on. |
| `actions` | One JSON line per step: `session_start`, each `agent-browser` command with the start of its output, how long it took and when in the video it ran, each `fill_credential` with its reference, and `session_end`. A step that clicked or typed names the element it acted on: the agent's ref for it (`@e3`), a CSS selector, and its box in the video's pixels. A person's takeover and handback are steps too. |
| `dom` | The page's HTML after each step that changed it, with its URL and title, and that step's element. |

Before anything leaves the machine, the node scrubs the text files. The project's
[secret variables](/docs/projects#env) and the screen's MCP secrets are masked as `***NAME***`, in every form a page
shows them: as written, JSON- or HTML-escaped, URL-encoded or encoded as a form submits it, and in base64, inside a
longer string too. Each value filled from 1Password is masked so too, as `***op://…***`. A video can't be
scrubbed: whatever showed on the page is in it.

## Logins from 1Password {#1password}

An agent signs in to a site without seeing the password. It names a 1Password secret reference, and the node types
the value into the page itself.

1. **Give the project a service account token.** In 1Password, make a service account that can read the vault with
   the agents' logins. Set its token as `OP_SERVICE_ACCOUNT_TOKEN`, a secret [project variable](/docs/projects#env), or
   enter it when the lead asks for it with `request_secret` (an [order's variable](/docs/approvals-and-secrets#order-variables)).
   The node keeps it to itself: no agent, worktree setup command or MCP server gets it in its environment (the node's
   1Password helper reads it on its standard input, not from its environment either), and it is masked like any
   secret.
2. **Give each login item its website.** The node fills a field only on a page of the item's website (the same host,
   or a subdomain of it), and submits only to a form that sends there. An item with no website fills nowhere. The
   website is the one of exactly the item the reference names: by its ID, or by its title when no other item in that
   vault has it (if two do, put the item's ID in the reference).
3. **The agent fills and submits in one step.** It opens the login page with agent-browser, then calls
   [`fill_credential`](/docs/reference/agent-tools#fill_credential) with the reference and the field's CSS selector:
   `op://Agents/Shop/username` into `#email` with `submit: false`, then `op://Agents/Shop/password` into `#password`,
   which submits the form. A one-time code is `op://Agents/Shop/one-time password?attribute=otp`.

The node reads references with the 1Password SDK (`@1password/sdk` 0.5.0, run with Node.js and installed at the
first fill under `~/.fleetd/node/browser/onepassword`; an install that takes over 3 minutes is stopped). A screen
lists the vaults and a vault's items once, keeps what it read, except one-time codes, and waits and tries again when
1Password rate-limits the token. Service accounts have hourly and daily read limits, and a
machine stuck in a loop could use up the account's day for every machine, so agents are told not to retry a failed
fill in a loop.

### What keeps the value from the agent {#sealed}

- The node types the value over its own connection, never through the agent's proxy, and submits in the same step.
- From the first fill, the screen is sealed until it ends:
  - every answer and event the agent's browser connection gets is scrubbed of each filled value, in every form a page
    or an encoding shows it (base64, URL encoding, HTML and JSON escapes), request bodies in network events included;
  - only agent-browser's own scripts run: the proxy parses each script the agent's connection sends and compares its
    shape (the script with its strings, numbers and booleans left out) with the shapes of the scripts agent-browser
    0.39.4 runs, pinned in fleetd. So snapshots, clicks, typing, scrolling and `get text` work as before, and a script
    that reads a field and reshapes or sends it is refused;
  - nothing may change where a form sends, what a page loads or links to, its event handlers or HTML, or a field's
    type or style, by script or by DOM command, nor read the clipboard;
  - nothing may test a filled value against guesses: a field's validation (`pattern`, `minlength`, `maxlength`, `min`,
    `max`, `required`, `step`) can't be set, selectors that ask a field's state (`:invalid`, `:valid`,
    `:user-invalid`, `:user-valid`, `:placeholder-shown`, `:autofill`, `[value…]`) are refused however they're
    escaped, style rules can't be added, and a filled field takes no DOM write at all;
  - the proxy refuses page and DOM snapshots, MHTML and PDF, request bodies and request interception;
  - agent-browser's `eval` and `get value` are denied (its policy file names its internal actions, `evaluate` and
    `inputvalue`).
- A filled field that isn't a password field, such as a one-time code or a username, shows as dots and blurred, so
  the video and the live view don't show it either.
- The action log, the DOM trace and everything the agent's session reports are scrubbed of filled values. The hub gets
  how many logins were filled, never a value.

:::caution
Agents aren't sandboxed on their machine. These measures cover the agent's tools and its connection to the browser.
An agent that sets out to get around them can: by reading the token from the node's files, or with a script it put in
the page before the fill. And a page that shows a filled value, as text or in an attribute, could still be probed one
guess at a time (agent-browser's `wait --text` answers yes or no). Copy and paste isn't covered either: part of a
filled field that isn't a password field (a username, a one-time code) could be copied into another field and read
there. Give the service account access only to a vault of
logins made for agents.
:::

## On the hub {#hub}

The hub keeps each recording for **30 days**, and up to **20 GB** per project, deleting a project's oldest first. It
checks every hour. An upload still in progress counts toward the size, and is never cut short. One its machine never
finished is treated as a recording from a day after it started: it goes past the 30 days, or when its project is over
its size. An expired screen keeps its row, with no files. An admin key on every machine
changes both limits with `browser_retention_set`.

The app and any [MCP client](/docs/mcp-clients) read screens with `browser_sessions`: each one's agent and task,
purpose, state (`live`, `uploading`, `recorded`, `lost` or `expired`) and files. They read a file with
`browser_recording_get`, 512 KiB at a time. A `browser.session` event says when one started, ended or landed.

## On each machine {#setup}

The node sets the browser up itself, in the background, with Node.js, the first time an agent asks for a screen (or
as soon as it starts, with `"enabled": true`):

- Chrome's headless shell and an ffmpeg, the builds of Playwright 1.64.1, with Playwright's own installer, under
  `~/.fleetd/node/browser/ms-playwright`;
- agent-browser 0.39.4, the package's native binary for the machine, under `~/.fleetd/node/browser/agent-browser`.

The versions are pinned: a node updates them only when a fleetd release changes the pin. Until the install finishes,
`session_start` says the browser is still being installed. On a machine without Node.js, `session_start` explains why it
can't start one. A machine without an ffmpeg records screens without their video, and each screen's note says so.

Settings go under `browser` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `false` turns browser screens off on this machine. `true` installs the browser when the node starts rather than at the first screen. Absent: on, installed at the first screen. |
| `chrome` | A Chrome or headless shell to use instead of the pinned one. |
| `ffmpeg` | An ffmpeg to use instead of the pinned one. It needs MJPEG in and `libvpx-vp9` out. |
| `pool` | Chromes kept launched for the next screens. Absent: 1. Each waiting Chrome takes about 0.5 GB of memory. |
| `sandbox` | `true` requires Chrome's own sandbox: a machine that refuses it starts no browser. `false` turns it off. Absent: on wherever the machine allows it, else off. |
| `idleMinutes` | End a screen after this many minutes without an `agent-browser` command. Absent: 30. |

## Android screens {#android}

An agent that needs Android (to check an Android build, or how a site looks on Android) opens an Android screen:
**`session_start`** with `kind` `android`. It gets a fresh Android 15 emulator on its machine, drives it with
Callstack's [agent-device](https://github.com/callstack/agent-device) CLI (`agent-device open settings`, `snapshot -i`,
`press @e3 --settle`), and ends it with **`session_end`**. agent-device is on its `PATH` with its skill, already
pointed at the screen's emulator. Only agent-device gets the node's SDK and adb (on adb server port 15037, never a
person's 5037): an agent's own `ANDROID_HOME`, `PATH` and adb stay as they were. `session_start` and `session_end`
work as for a browser; `fill_credential` and `request_takeover` are refused in an Android screen for now. The
one-screen-at-a-time rule, the action log, the hub's storage and its limits are the same as a browser screen's.

You can [watch an Android screen and take it over](#takeover) as you do a browser screen. Your mouse is one
finger: a press touches the screen, a drag while pressed swipes, and the release lifts it. The wheel scrolls, a key
that types goes to the device as text, and other keys go as keys (Enter, Backspace, the arrows). While you have
control, the agent's `agent-device` commands answer that a person has control.

- **A fresh emulator per screen.** The node boots its virtual device once, cold, and saves its Quick Boot snapshot.
  Each screen gets its own copy, started from that snapshot with `-read-only`: nothing done in it is kept, and the
  copy is killed at `session_end`.
- **Starts from a warm pool.** A copy boots in about 8 seconds on a KVM machine. The node keeps one booted for the
  next screen and boots another behind it, so `session_start` takes well under a second.
- **Recorded through scrcpy.** The node runs [scrcpy](https://github.com/Genymobile/scrcpy)'s server on the emulator
  and decodes its screen stream itself. The recording is an `actions` file as a browser screen's, and a `video` (a
  WebM, VP9, 576×1280). There's no `dom` file.

Emulators are kept apart from each other, not from the agents on their machine: an agent with adb can reach another
screen's emulator by its serial. Run agents that mustn't see each other's devices on different machines.

### On each machine {#android-setup}

Android screens need Linux on x86_64 with KVM: the user running the node must be able to open `/dev/kvm` read-write.
The doctor's `android` check says when it can't, and the fix (usually `sudo usermod -aG kvm $USER`, then a restart of
the node; an ACL set with `setfacl` is lost whenever udev makes `/dev/kvm` again). A machine runs them only while that
check passes, and lists `session_android` to the hub.

Nothing is installed until a person opts a machine in with `"device": {"enabled": true}` in its node.json. The node
then installs everything the first time an agent asks for an Android screen, about 2 GB under
`~/.fleetd/node/device`, each download checked against its pinned digest:

- Google's platform-tools 37.0.1 (adb), emulator 37.2.12 and the Android 15 (API 35) Google APIs x86_64 system image;
- scrcpy's server 5.0.1, and an ffmpeg 6.0.1 static build that decodes its stream;
- agent-device 0.21.31, its npm package checked against npm's integrity digest (it has no dependencies, and runs on
  Node.js 22.12 or later), with its skill.

It then boots the emulator once to save its snapshot. Until that's done, `session_start` says it is still installing.

Settings go under `device` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `true` opts this machine in: the first Android screen installs the emulator. `false` turns Android screens off. Absent: on only where they are installed already; nothing is installed. |
| `pool` | Emulators kept booted for the next screens. Absent: 1. Each takes about 2 GB of memory. |
| `idleMinutes` | End a screen after this many minutes without an `agent-device` command. Absent: 30. |

## iOS screens {#ios}

On a Mac with Xcode, an agent opens an iOS screen with **`session_start`** and `kind` `ios`. It gets a fresh iOS
simulator and drives it with [agent-device](https://github.com/callstack/agent-device), as in an Android screen
(`agent-device open com.apple.Preferences`, `snapshot -i`, `press @e3 --settle`). agent-device is already pointed at
the screen's simulator by its udid. Only agent-device is told about the node's simulators: an agent's own `xcrun
simctl` and Xcode stay as they were. The screen tools, the one-screen-at-a-time rule, the action log and the hub's
storage work as for a browser screen.

- **A fresh simulator per screen.** The node keeps its simulators in a device set of its own
  (`~/.fleetd/node/device/ios/set`), apart from the ones in Xcode. It makes one golden simulator there: the newest iOS
  runtime on a plain iPhone. It boots the golden once, waits for its first-boot work to settle, has agent-device build
  its XCTest runner for it, and shuts it down. Each screen gets a clone of the golden (`simctl clone`), which is
  deleted at `session_end` along with everything done in it.
- **Starts from a warm pool.** The node keeps one clone booted for the next screen and clones and boots another
  behind it, so `session_start` doesn't wait for a boot. With no clone ready, `session_start` answers at once that
  one is starting and about how long it takes, rather than wait out the boot. When boots keep failing, the pool waits
  before the next one: a minute, doubling up to half an hour, and back to normal after a boot that works. An
  agent-device command takes longer the first time in a screen, while its runner starts on the clone.
- **Recorded by the simulator.** The video is `simctl io recordVideo`'s H.264 MP4 (`video_mp4`), at the screen's full
  size. The action log is the same as an Android screen's, and there's no `dom` file.
- **Live view and takeover.** `simctl` can't stream, so a person watching gets screenshots in a loop, which runs only
  while someone watches. Their taps, drags, scrolls and typing go through agent-device, one command at a time.

### On each Mac {#ios-setup}

iOS screens need macOS with Xcode, an iOS simulator runtime (Xcode > Settings > Components, or
`xcodebuild -downloadPlatform iOS`), and Node.js 22.12 or later for agent-device. The doctor's `ios` check shows on
every Mac with Xcode. It fails with the fix when something is missing (`sudo xcode-select --switch
/Applications/Xcode.app` when only the command line tools are selected). A Mac lists `session_ios` to the hub only once
its golden simulator is made.

Nothing is made until a person opts a Mac in with `"ios": {"enabled": true}` in its node.json. The node then installs
agent-device 0.21.31 (the same pin Android screens use) and makes the golden. That takes minutes: the boot that
settles, and an `xcodebuild` of agent-device's runner. Until it's done, `session_start` says the Mac is still making
it. The node deletes clones that a stopped node left behind each time it starts.

Settings go under `ios` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `true` opts this Mac in: the node makes its golden simulator and keeps clones booted. `false` turns iOS screens off. Absent: on only where the golden is made already. |
| `pool` | Clones kept booted for the next screens. Absent: 1. Each takes 1–2 GB of memory. |
| `idleMinutes` | End a screen after this many minutes without an `agent-device` command. Absent: 30. |
| `deviceType` | The simulator's device type by name, such as `iPhone 17 Pro`. Absent: the newest plain iPhone of the newest iOS runtime. A change takes effect when the golden is made again (delete `device/ios/golden.json`). |

## Linux desktop screens {#desktop}

An agent that needs a desktop app (to check a GTK or Electron build, or anything with a window) opens a desktop
screen: **`session_start`** with `kind` `linux_desktop`. It gets a 1280×800 X display of its own with a window
manager, drives it with its **`desktop`** tool, and ends it with **`session_end`**. The tool takes the actions of
Anthropic's computer-use tool: `screenshot` (the screen comes back as an image), `left_click`, `right_click`,
`middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `type`, `key` (xdotool names:
`Return`, `ctrl+s`, `alt+F4`), `scroll`, `wait` and `cursor_position`, plus **`launch`**, which starts a shell command
on the desktop (`xterm`, `./target/debug/app`). The screen tools, the one-screen-at-a-time rule, takeover, the
action log, the hub's storage and its limits are the same as a browser screen's.

- **A fresh display per screen.** Where the node has docker or podman, each screen gets a fresh container of the
  pinned image, which runs Xvfb, Openbox and xterm. Apps launched in it see none of the machine but the agent's own
  worktree, read-only at the same path; they write in `/home/desktop` or `/tmp`, which go with the container.
  Without a container runtime, each screen gets an Xvfb of its own on the machine, and its apps run as the node's
  user with a fresh, empty home directory. Either way the display, and everything on it, is thrown away at
  `session_end`.
- **Starts from a warm pool.** The node keeps one display started for the next screen and starts another behind it,
  so `session_start` takes a few milliseconds. A container that mounts the agent's worktree can't come from the pool
  (a running container takes no new folder), so it starts then, in about a second. The first screen after the node
  starts waits while it prepares, about a second when there's no image to build.
- **Only the node and the screen's apps reach the display.** Each X server takes a random cookie, and with Xvfb it
  listens on its socket file alone. The node does the agent's actions itself over its own X11 connection: it reads the
  screen and types and clicks through XTEST, as xdotool does. So while you have control, the agent's `desktop` actions
  answer that a person has control, and after you hand back, its next action takes control again.
- **Recorded from the screen.** The node reads the screen ten times a second while anything on it changes. The
  recording is an `actions` file as a browser screen's (each `desktop` action with its arguments, scrubbed of the
  screen's secrets) and a `video` (a WebM, VP9, 1280×800). There's no `dom` file.

Apps launched in a container run on its Debian, so a binary built on a newer machine may need the Xvfb backend
(`"backend": "xvfb"`).

### On each machine {#desktop-setup}

Desktop screens need docker or podman, or Xvfb (`sudo apt install xvfb`). The doctor's `desktop` check says which the
machine uses, or what to install. A machine that can host them lists `session_linux_desktop` to the hub.

Nothing starts until an agent first asks for a desktop screen (or as soon as the node starts, with
`"enabled": true`). Then, with a container runtime that answers `docker info` (or podman's), the node builds the
pinned image once (a few minutes) as `localhost/fleetd-desktop:<hash>`: Debian 13 pinned by digest, with its packages
from snapshot.debian.org at a fixed date. Screens that ask meanwhile are told to come back. If the build fails, the
node uses Xvfb where it has one, and tries the build again at its next start. The recording's video needs an ffmpeg: the browser screens' or the Android screens' one, or `ffmpeg` below.

Settings go under `desktop` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `false` turns desktop screens off on this machine. `true` prepares them (builds the image, fills the pool) when the node starts. Absent: on, prepared at the first screen. |
| `backend` | `container` or `xvfb` only. Absent: a container where docker or podman answers, else Xvfb. |
| `runtime` | The docker or podman to use instead of the one on the `PATH`. |
| `image` | An image to run instead of building the pinned one. It must start Xvfb on `:0` with `-auth /fleetd/xauth`. |
| `xvfb` | The Xvfb to use instead of the one on the `PATH`. |
| `ffmpeg` | An ffmpeg for the video. It needs MJPEG in and `libvpx-vp9` out. |
| `pool` | Displays kept started for the next screens. Absent: 1. |
| `idleMinutes` | End a screen after this many minutes without a `desktop` action. Absent: 30. |
