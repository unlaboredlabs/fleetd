---
title: Browser sessions
description: Agents open a fresh Chrome or Android emulator of their own, drive it with agent-browser or agent-device, and leave a recording on the hub.
---

An agent that needs a web page (to check a signup form on staging, read a dashboard, reproduce a bug) opens a browser
session. It gets a fresh Chrome on its machine that no other session shares, drives it with the
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI, and closes it when done. You can watch it live in the
app and take it over. The node records the session and uploads the recording to the hub.

## How an agent uses one {#use}

1. **`session_start`** with a one-line purpose. The node takes a Chrome it already launched, with an empty profile, so
   the session starts in a few milliseconds.
2. **agent-browser** in Bash: `agent-browser open <url>`, `snapshot -i`, `click @e3`, `fill @e2 "text"`. Every lead's
   and task's claude has it on its `PATH`, already pointed at its own session, with agent-browser's skill loaded. The
   agent runs `agent-browser skills get core` once for how to use it.
3. **`session_end`**. The node kills that Chrome, deletes its profile, and uploads the recording.

An agent has one session open at a time. Its session also ends when the agent's claude exits (its work is done, it was
stopped or it went idle), or after 30 minutes without an `agent-browser` command. When the agent needs a person (a
captcha, a confirmation only you can give), it calls **`request_takeover`** with what you should do. The tools are on
the [Agent tools](/docs/reference/agent-tools#session_start) page.

## Watch and take over {#takeover}

A live session streams its page to the app as you watch it: the node sends its frames only while someone watches.
**Take over** gives you the mouse and keyboard on the page. While you have control, the agent's `agent-browser`
commands answer that a person has control, and the agent carries on with other work. **Hand back** returns control: the
agent's next command sees the page as you left it, what you typed included. The recording's action log says who took
over and when, but not what you typed.

A session whose agent asked for you shows under **waiting on you** with its reason, until you take it over or it ends.

Any key that can read the session's machine may watch. Taking over and typing take a person's device with operate
there. MCP clients use `browser_control` to take over and hand back.

## Isolation {#isolation}

- **A fresh browser per session.** Each session gets its own Chrome process and its own empty profile directory.
  Both are thrown away at the end, so no cookie, login or cache from one session reaches the next.
- **No open debugging port.** Chrome is started with `--remote-debugging-pipe`: only the node holds a connection to
  it. agent-browser reaches it through the node's proxy on `127.0.0.1`, at an address with a token of its own for each
  agent's session, which only that agent's environment names. An unknown token is refused, and so is any address while
  its agent has no session open. Agents run as one OS user, though, so an agent that reads another's environment could
  use its token.
- **Chrome's own sandbox**, wherever the machine allows it. A machine without unprivileged user namespaces (Ubuntu
  23.10 and later restrict them by default) runs the pinned headless shell with `--no-sandbox`, and the node's log says
  so once. System Chrome brings its own sandbox helper, so `chrome` set to it keeps the sandbox there.
- **The node's own connection is hidden from the agent.** The node uses its connection for the recording. The
  agent's driver never sees the node's target sessions or screencast frames.

Agents aren't sandboxed on their machine (see [Security](/docs/security#keys)). These measures keep sessions apart and
recorded. They can't stop an agent that sets out to get around them, for example by starting a browser of its own.

## What's recorded {#recording}

| File | Holds |
|---|---|
| `video` | A WebM (VP9, 1280×800, 25 frames a second), made from the node's own screencast of the page the agent is on. |
| `actions` | One JSON line per step: `session_start`, each `agent-browser` command with the start of its output, how long it took and when in the video it ran, and `session_end`. A step that clicked or typed names the element it acted on: the agent's ref for it (`@e3`), a CSS selector, and its box in the video's pixels. A person's takeover and handback are steps too. |
| `dom` | The page's HTML after each step that changed it, with its URL and title, and that step's element. |

Before anything leaves the machine, the node scrubs the text files. The project's
[secret variables](/docs/projects#env) and the session's MCP secrets are masked as `***NAME***`, in every form a page
shows them: as written, JSON- or HTML-escaped, URL-encoded, and in base64, inside a longer string too. A video can't be
scrubbed: whatever showed on the page is in it.

## On the hub {#hub}

The hub keeps each recording for **30 days**, and up to **20 GB** per project, deleting a project's oldest first. It
checks every hour. An upload still in progress counts toward the size; one its machine never finished (a day after it
started) is deleted like a recording. An expired session keeps its row, with no files. An admin key on every machine
changes both limits with `browser_retention_set`.

The app and any [MCP client](/docs/mcp-clients) read sessions with `browser_sessions`: each one's agent and task,
purpose, state (`live`, `uploading`, `recorded`, `lost` or `expired`) and files. They read a file with
`browser_recording_get`, 512 KiB at a time. A `browser.session` event says when one started, ended or landed.

## On each machine {#setup}

The node sets the browser up itself, in the background, with Node.js, the first time an agent asks for a session (or
as soon as it starts, with `"enabled": true`):

- Chrome's headless shell and an ffmpeg, the builds of Playwright 1.64.1, with Playwright's own installer, under
  `~/.fleetd/node/browser/ms-playwright`;
- agent-browser 0.39.4, the package's native binary for the machine, under `~/.fleetd/node/browser/agent-browser`.

The versions are pinned: a node updates them only when a fleetd release changes the pin. Until the install finishes,
`session_start` says the browser is still being installed. On a machine without Node.js, `session_start` explains why it
can't start one. A machine without an ffmpeg records sessions without their video, and each session's note says so.

Settings go under `browser` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `false` turns browser sessions off on this machine. `true` installs the browser when the node starts rather than at the first session. Absent: on, installed at the first session. |
| `chrome` | A Chrome or headless shell to use instead of the pinned one. |
| `ffmpeg` | An ffmpeg to use instead of the pinned one. It needs MJPEG in and `libvpx-vp9` out. |
| `pool` | Chromes kept launched for the next sessions. Absent: 1. Each waiting Chrome takes about 0.5 GB of memory. |
| `sandbox` | `true` requires Chrome's own sandbox: a machine that refuses it starts no browser. `false` turns it off. Absent: on wherever the machine allows it, else off. |
| `idleMinutes` | End a session after this many minutes without an `agent-browser` command. Absent: 30. |

## Android sessions {#android}

An agent that needs a phone app (to check an Android build, or a site on a phone) opens an Android session:
**`session_start`** with `kind` `android`. It gets a fresh Android 15 emulator on its machine, drives it with
Callstack's [agent-device](https://github.com/callstack/agent-device) CLI (`agent-device open settings`, `snapshot -i`,
`press @e3 --settle`), and ends it with **`session_end`**. agent-device is on its `PATH` with its skill, already
pointed at the session's emulator. Only agent-device gets the node's SDK and adb (on adb server port 15037, never a
person's 5037): an agent's own `ANDROID_HOME`, `PATH` and adb stay as they were. The session tools, the one-session-at-a-time rule, the action log, the hub's
storage and its limits are the same as a browser session's.

- **A fresh emulator per session.** The node boots its virtual device once, cold, and saves its Quick Boot snapshot.
  Each session gets its own copy, started from that snapshot with `-read-only`: nothing done in it is kept, and the
  copy is killed at `session_end`.
- **Starts from a warm pool.** A copy boots in about 8 seconds on a KVM machine. The node keeps one booted for the
  next session and boots another behind it, so `session_start` takes well under a second.
- **Recorded through scrcpy.** The node runs [scrcpy](https://github.com/Genymobile/scrcpy)'s server on the emulator
  and decodes its screen stream itself. The recording is an `actions` file as a browser session's, and a `video` (a
  WebM, VP9, 576×1280). There's no `dom` file.

Emulators are kept apart from each other, not from the agents on their machine: an agent with adb can reach another
session's emulator by its serial. Run agents that mustn't see each other's devices on different machines.

### On each machine {#android-setup}

Android sessions need Linux on x86_64 with KVM: the user running the node must be able to open `/dev/kvm` read-write.
The doctor's `android` check says when it can't, and the fix (usually `sudo usermod -aG kvm $USER`, then a restart of
the node; an ACL set with `setfacl` is lost whenever udev makes `/dev/kvm` again). A machine runs them only while that
check passes, and lists `session_android` to the hub.

Nothing is installed until a person opts a machine in with `"device": {"enabled": true}` in its node.json. The node
then installs everything the first time an agent asks for an Android session, about 2 GB under
`~/.fleetd/node/device`, each download checked against its pinned digest:

- Google's platform-tools 37.0.1 (adb), emulator 37.2.12 and the Android 15 (API 35) Google APIs x86_64 system image;
- scrcpy's server 5.0.1, and an ffmpeg 6.0.1 static build that decodes its stream;
- agent-device 0.21.31, its npm package checked against npm's integrity digest (it has no dependencies, and runs on
  Node.js 22.12 or later), with its skill.

It then boots the emulator once to save its snapshot. Until that's done, `session_start` says it is still installing.

Settings go under `device` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `true` opts this machine in: the first Android session installs the emulator. `false` turns Android sessions off. Absent: on only where they are installed already; nothing is installed. |
| `pool` | Emulators kept booted for the next sessions. Absent: 1. Each takes about 2 GB of memory. |
| `idleMinutes` | End a session after this many minutes without an `agent-device` command. Absent: 30. |
