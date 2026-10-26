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
A session runs on the agent's own machine, and needs it to have the sessions [role](/docs/machines#roles) and a free
session slot.

## Watch and take over {#takeover}

A live session streams its page, with its address, to the app as you watch it: the node sends its frames only while
someone watches, and a slow connection skips frames rather than falling behind.
**Take over** gives you the mouse and keyboard on the page once the session's machine confirms it. While you have
control, the agent's `agent-browser` commands answer that a person has control, and the agent carries on with other
work. **Hand back** returns control: the
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
| `actions` | One JSON line per step: `session_start`, each `agent-browser` command with the start of its output, how long it took and when in the video it ran, each `fill_credential` with its reference, and `session_end`. A step that clicked or typed names the element it acted on: the agent's ref for it (`@e3`), a CSS selector, and its box in the video's pixels. A person's takeover and handback are steps too. |
| `dom` | The page's HTML after each step that changed it, with its URL and title, and that step's element. |

Before anything leaves the machine, the node scrubs the text files. The project's
[secret variables](/docs/projects#env) and the session's MCP secrets are masked as `***NAME***`, in every form a page
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
first fill under `~/.fleetd/node/browser/onepassword`; an install that takes over 3 minutes is stopped). A session
lists the vaults and a vault's items once, keeps what it read, except one-time codes, and waits and tries again when
1Password rate-limits the token. Service accounts have hourly and daily read limits, and a
machine stuck in a loop could use up the account's day for every machine, so agents are told not to retry a failed
fill in a loop.

### What keeps the value from the agent {#sealed}

- The node types the value over its own connection, never through the agent's proxy, and submits in the same step.
- From the first fill, the session is sealed until it ends:
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
its size. An expired session keeps its row, with no files. An admin key on every machine
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

An agent that needs Android (to check an Android build, or how a site looks on Android) opens an Android session:
**`session_start`** with `kind` `android`. It gets a fresh Android 15 emulator on its machine, drives it with
Callstack's [agent-device](https://github.com/callstack/agent-device) CLI (`agent-device open settings`, `snapshot -i`,
`press @e3 --settle`), and ends it with **`session_end`**. agent-device is on its `PATH` with its skill, already
pointed at the session's emulator. Only agent-device gets the node's SDK and adb (on adb server port 15037, never a
person's 5037): an agent's own `ANDROID_HOME`, `PATH` and adb stay as they were. `session_start` and `session_end`
work as for a browser; `fill_credential` and `request_takeover` are refused in an Android session for now. The
one-session-at-a-time rule, the action log, the hub's storage and its limits are the same as a browser session's.

You can [watch an Android session and take it over](#takeover) as you do a browser session. Your mouse is one
finger: a press touches the screen, a drag while pressed swipes, and the release lifts it. The wheel scrolls, a key
that types goes to the device as text, and other keys go as keys (Enter, Backspace, the arrows). While you have
control, the agent's `agent-device` commands answer that a person has control.

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
