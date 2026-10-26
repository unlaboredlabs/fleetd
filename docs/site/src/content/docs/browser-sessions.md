---
title: Browser sessions
description: Agents open a fresh Chrome of their own, drive it with agent-browser, and leave a recording on the hub.
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
**Take over** gives you the mouse and keyboard on the page once the session's machine confirms it. While you have control, the agent's `agent-browser`
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
