---
title: Screens
description: Agents open a fresh Chrome, Android emulator or Linux desktop of their own, or borrow the agents' Mac's screen, drive it with agent-browser, agent-device, agent-desktop or their desktop tool, and leave a recording on the hub.
---

An agent that needs a web page (to check a signup form on staging, read a dashboard, reproduce a bug) opens a browser
screen. It gets a fresh Chrome on its machine that no other screen shares, drives it with the
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI, and closes it when done. You can watch it live in the
app and take it over. The node records the screen and uploads the recording to the hub.

A screen is any of these an agent opens: a browser, an [Android emulator](#android), a
[Linux desktop](#desktop), or the [agents' Mac's own screen](#mac), which agents take turns on. iOS simulators aren't
screens: agents start their own on [the agents' Mac](/docs/agents-mac#sim) ([iOS screens are gone](#ios)). You can
[open one yourself](#yours) too. The app shows every project's on the [Screens page](#page), and each
project's under **Agents › Screens**. The agent tools that open and close one keep their names, `session_start` and
`session_end`.

## The Screens page {#page}

**Screens** in the sidebar says "needs you" when a screen asks for you, else how many are live: one count for the
whole hub (`screens_count`), read again as screens start, change hands and end. The page shows every screen of the
projects you can see, in three groups:

- **Needs you**: screens whose agent asked you to take over, each with a large picture, its reason and **Take over**.
- **Live**: a grid of pictures. Over each, its project and where it runs (`Browser · devbox`, `Android · buildbox`,
  `Agents' Mac`); under it, what it's for, its state, who has it and the agent's latest step (`Typed "SAVE10" in @e12`,
  `Tapped "Add to cart"`).
- **Recent**: screens that ended, newest first, with how they ended and when: the first 12, then **Show more**.

Opening a screen gives its live view or replay the whole page, with a back arrow to the wall. **New screen** at the top
right opens a short sentence: the kind, the machine with its slots in use, and the project. A full machine
gives you its next free slot. **All screens**, the icon beside **Screens** in a project's Agents tab in the panel, opens the page too.

The pictures are cheap by design. While the page is on screen, the hub takes one frame of each live screen every 20
seconds, shrinks it to at most 640 pixels a side and sends it to each app showing the page. It takes no capture of its
own: it watches each screen briefly, as the live view does, and the node answers a watch with the screen's newest frame
at once. Nobody showing the page means no watch at all, and a hidden window counts as not showing it. The latest step
comes from each node's heartbeat (every 15 seconds): the newest line of each live screen's action log, scrubbed as
it was logged.

## How an agent uses one {#use}

1. **`session_start`** with a one-line purpose. The node takes a Chrome it already launched, with an empty profile, so
   the screen starts in a few milliseconds.
2. **agent-browser** in Bash: `agent-browser open <url>`, `snapshot -i`, `click @e3`, `fill @e2 "text"`. Every lead's
   and task's claude has it on its `PATH`, already pointed at its own screen, with agent-browser's skill loaded. The
   agent runs `agent-browser skills get core` once for how to use it.
3. **`session_end`**. The node kills that Chrome, deletes its profile, and uploads the recording.

The browser of a lead that does its own work (a project with no repo) is the exception: it keeps one profile of the
project's own between sessions, launched fresh for each session rather than taken warm, so the sites it signed into
stay signed in ([Projects › Sign-ins](/docs/projects#sign-ins)).

An agent has one screen open at a time. Its screen also ends when the agent's claude exits (its work is done, it was
stopped or it went idle), or after 30 minutes without an `agent-browser` command. A screen never outlives its task:
once the task is cancelled (its order closed, say), or has stayed done or failed for 30 minutes with nothing waking it,
the hub ends any screen it left open and the node kills it, wherever it runs. A task waiting between turns (on
`wait_ci`, or a message from its lead) keeps its screen, and its claude, for the screen's 30 minutes: a next turn
within them picks the screen up. When a node starts, it kills any Chrome or other process an earlier session left
running in its scratch folder. When the agent needs a person (a
captcha, a confirmation only you can give), it calls **`request_takeover`** with what you should do. The tools are on
the [Agent tools](/docs/reference/agent-tools#session_start) page.
The hub decides which machine a screen runs on, by the machines' [roles](/docs/machines#roles): the agent's own when it
hosts screens and has a free screen slot, else another that can, driven through the hub.

## Watch and take over {#takeover}

In the app, **Agents › Screens** lists them: those waiting on you, the live ones, then the recent ones. A live screen
takes the panel's whole width. It streams its page, with its address, to the app as you watch it: the node sends its frames only while
someone watches, and a slow connection skips frames rather than falling behind. Each new watcher, a phone beside the
desktop say, gets the screen's newest frame at once, even on a page that isn't changing.
**Take over** gives you the mouse and keyboard on the page once the screen's machine confirms it. While you have
control, the agent's `agent-browser` commands answer that a person has control, and the agent carries on with other
work. **Hand back** returns control: the
agent's next command sees the page as you left it, what you typed included. The recording's action log says who took
over and when, but not what you typed.

While a browser is yours, the frame's bar is its address bar. Type an address and press Enter to go there (a bare
`example.com` goes over https, `localhost:5173` over http), or use back, forward and reload. It goes only to `http`
and `https` pages, never to `file:` or the browser's own pages.

A screen whose agent asked for you shows under **waiting on you** with its reason, until you take it over or it ends.
The ask is a notification too, on the desktop and on your phone, where tapping it opens the screen's live view.

On the [phone](/docs/mobile#screens), a live screen shows as a card in its chat, and opens full screen: pinch to zoom,
**Take Over**, then a tap clicks, a drag scrolls and a held touch presses and drags; the keyboard button types into the
page, the site at the top is its address bar, and **Hand Back** returns it. It's the same live view and takeover, at most 12 frames a second.

On a slow link the live view shows the newest frame, not a backlog. The app acks each frame, and the hub sends the next
one as the link is about to finish the last, so what you see and what your keys do lag by about a frame's trip, not by
seconds of queued frames. When frames have to wait, the hub tells the screen's machine how much the slowest watcher's
link carries, and the machine sends less. An app or hub from before this paces nothing, as before.

Once it has ended, the screen plays its recording, the panel's whole width. **Steps**, at the end of the player's
controls, opens its steps beside the recording (under it in a narrow panel). Each step jumps the recording to its
moment and opens the page as that step found it. Press **Steps** again to close them. They start closed each time you
open a screen.

Any key that can read the screen's machine may watch. Taking over and typing take a person's device with operate
there. MCP clients use `browser_control` to take over and hand back.

## Open one yourself {#yours}

You can open a screen of your own: **New screen**, the plus beside **Screens** in a project's Agents tab in the panel, on the
[Screens page](#page), or **New screen…** in the command palette (⌘K) for the project on screen. On the phone, **New Screen** is on a project's
ⓘ page ([Phone app](/docs/mobile#screens)).

1. **Pick the kind**: a browser, an Android emulator, a Linux desktop or the agents' Mac. A kind no machine can host
   says why under its name (`Turned off`, `Needs a Mac`, `Installing`, `Offline`, `Needs an update`). Pick it for the
   reason in full, from the machines' nodes, and its one fix: an owner or admin gets **Turn on** where the kind is only
   switched off on a machine (it turns it on there, as [Settings](#settings) does), or a button to the part of
   Settings › Hub › Machines that fixes it; anyone else is told whom to ask.
2. **Pick the machine.** The list has only the machines that can host that kind (the sessions role, the kind set up,
   and a current fleetd), each with its screens in use: `1 of 2 screens in use`.
3. **Pick a PR** (optional, Android): one of the project's open PRs, whose CI build is installed before you get
   it ([below](#yours-pr)). If the PRs can't be read, the picker says why, with Retry.
4. **Open screen.** It opens in the panel's live view with you in control from the start, and lists under Screens as
   yours. **End screen** closes it. It also ends after the machine's idle timeout without your input: 30 minutes
   unless set in [Settings](#settings). The picker says the machine's own.

Your screen is recorded and kept like an agent's, and plays back the same way once it ends. There's no agent to hand it
to, so it has no Hand back. You need operate on the project's machine to open one, as to take a screen over.

A browser you open on a project's own machine runs on the profile the project keeps
([Projects › Sign-ins](/docs/projects#sign-ins)): a site you sign in to there stays signed in for its lead. While the
lead's browser is on that profile, yours opens on a fresh one, and so does one on another machine. One browser at a
time runs on the profile, so close yours before the lead needs its own.

### When a machine is full {#yours-full}

Your screen takes one of the machine's [screen slots](/docs/machines#roles), as an agent's does. On a full machine the
picker says so (`Full: 2 of 2 screens in use`) and its button becomes **Wait for a slot**. Your wait shows at the top of
Screens, with your place in line and Cancel, until your screen opens there. The next slot that frees on that machine
goes to the oldest person waiting, before any agent's: an agent asking meanwhile is told the machine is full, with how
many people wait. An agent's running screen is never ended to make room. A wait gives up after 30 minutes.

### A PR's build {#yours-pr}

An Android emulator can open with a PR's build installed. The hub takes the newest artifact of a CI run on the PR's
head whose name says what it's for: `android` or `apk` for an `.apk` (`fleetd-android-apk`). It downloads it with its
`gh` (as the [GitHub App](/docs/github/) where it's installed), starts the screen, sends the file to the screen's
machine sealed with that screen's key, and runs `agent-device install` there. Then the screen is yours.

That can take minutes (an emulator starting first), so it goes on in the hub. **Open screen** takes the slot at
once, and no agent or other person can take it while the build downloads. The picker then shows how far it is: reading
the build and starting, then installing. It lands in the live view once the screen is yours. If you close the picker,
the screen still opens: it shows at the top of Screens until then, and then lists as yours.

- A PR without a build is refused at once, in plain words: its CI still running, its build expired (GitHub keeps
  artifacts only so long: re-run its CI), or no run that uploaded one. Nothing starts.
- A build that doesn't install closes the screen. Its row in Screens says why, in agent-device's words, until you clear
  it.
- A build can be at most 64 MiB.
- A wait with a PR gets its build when its slot frees.

MCP clients use `screen_open` and `screen_end`. `browser_sessions` lists your screens on their way beside the screens,
each with its `stage` (`waiting`, `starting`, `installing`, `failed` with an `error`) and, once it starts, the
screen's `threadId`. Each move is a `screen.wait` event. `screen_open` takes the PR as `pr: { repo, number }` and then
answers at once, its screen on its way. `screen_end` with the waitId gives up a wait or clears a failed one.

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
  so once. System Chrome brings its own sandbox helper, so `FLEETD_CHROME` set to it keeps the sandbox there.
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

## Logins from the vault {#logins}

An agent signs in to a site without seeing the password. It names a [vault](/docs/vault) login, and the node types
the value into the page itself.

1. **Add the login to the team vault** (Settings › You › Vault), with the websites it signs in to.
   The node fills a field only on a page of one of those sites (the same host, or a subdomain of it), and submits only
   to a form that sends there. A login with no site fills nowhere. Shared-hosting suffixes (`github.io`,
   `vercel.app`, `netlify.app`, `pages.dev`, `herokuapp.com` and the like) match only as whole hosts.
2. **The agent fills and submits in one step.** It opens the login page with agent-browser, then calls
   [`fill_credential`](/docs/reference/agent-tools#fill_credential) with the item (its label, or its `V…` id) and
   field, and the field's CSS selector: `item: "Shop", field: "username"` into `#email` with `submit: false`, then
   `field: "password"` into `#password`, which submits the form. `field: "otp"` types the current one-time code,
   made on the hub, so the seed never leaves it. `vault_items` lists the logins the agent may use, by label and site.
3. **The hub checks before it sends.** The node hosting the browser asks the hub for the value. The hub checks, from
   its own records, which project and order the session works for, that the item is in the team vault
   ([who uses what](/docs/vault#scopes)) and that the page is on its sites. Only then does it seal the value to that
   node. Each fill, and each refusal, is in the item's activity.

## Logins from 1Password {#1password}

1Password is only a place to [import from](/docs/vault#import) now: fills use the vault. Your service account token
(Settings › You › Your accounts › 1Password) lets you and your leads search it and bring items in. Make it read one
vault made for fleetd ([why](/docs/security#agent-reach)). For this release, `fill_credential` still takes an `op://`
reference: it fills from the vault item imported from it, else reads 1Password as before and proposes importing the
item. A project's own `OP_SERVICE_ACCOUNT_TOKEN` variable still serves those references, and the node keeps any token
to itself (no agent, setup command or MCP server gets it in its environment). In the release after, `op://` references
are refused.

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
its size. An expired screen keeps its row, with no files. An owner or admin changes the days under
**Settings › Hub › Machines › Recordings**; the size limit stays as a safety net. An admin key on every machine changes
both with `browser_retention_set`.

The app and any [MCP client](/docs/mcp-clients) read screens with `browser_sessions`: each one's agent and task,
purpose, state (`live`, `uploading`, `recorded`, `lost` or `expired`) and files. They read a file with
`browser_recording_get`, 512 KiB at a time. A `browser.session` event says when one started, ended or landed.

## Turn screens on in Settings {#settings}

A machine's page in **Settings › Hub › Machines**, for a hub's owners and admins, has a **Screens** part when the
machine hosts screens:

- **A switch per kind**: Browser, Android, Linux desktop and Agents' Mac. Under each, what the machine's node says:
  ready, off, installing, or what stands in the way (no KVM, no docker or Xvfb, no grants). A kind the machine can't
  run at all (the agents' Mac on Linux) can't be switched on, and says why. There's no iOS switch: the agents' Mac
  lends its [simulators](/docs/agents-mac#sim) to agents.
- **The agents' Mac has one switch, Agents' Mac.** It offers only its own screen: no browser, Android or Linux
  desktop runs there, so its row has none of their switches, and New screen never offers it for them.
- **How many at once**: its screen cap, Auto or a number ([Machine roles](/docs/machines#roles)).
- **When an idle screen ends**: after 30 minutes without a command, said in a line, for every kind but the agents'
  Mac, whose screen goes back after 5 minutes so the next agent isn't kept waiting.

**Recordings**, on Settings › Hub › Machines itself, sets how many days the hub keeps them, for every project
([On the hub](#hub)).

A switch writes the machine's node.json for you: the kind's `enabled`; the rest of the file stays as it is. Turning Android on opts the machine in, so it installs what it needs, as the setting
below does by hand. A node reads its screen settings as it starts, so it restarts itself to apply a change once no
screen is live on it. As for an [update](/docs/updating-and-uninstall), it first holds its agents' tool calls and
waits for the ones mid-step to finish (10 minutes at most), so the restart finds them between steps; they carry on
after it. Until then a kind turned on says it starts once the node restarts. A node that doesn't run as
the service `fleetd machine add` sets up saves the change and says to restart it. The machine has to be online, and
its fleetd new enough: an older one's switches show what it hosts but don't move. MCP clients use
`machine_screens_set`, and `machine_roles` reads each kind's reason (`off`), switch (`on`) and `idleMinutes`, its idle timeout. On the
agents' Mac, `machine_roles` lists only `mac`, and `machine_screens_set` takes only `host` `mac`.

## On each machine {#setup}

The node sets the browser up itself, in the background, with Node.js, as soon as it starts, so it is ready, or nearly,
by the time an agent asks for a screen:

- Chrome's headless shell and an ffmpeg, the builds of Playwright 1.64.1, with Playwright's own installer, under
  `~/.fleetd/node/browser/ms-playwright`;
- agent-browser 0.39.4, the package's native binary for the machine, under `~/.fleetd/node/browser/agent-browser`.

The versions are pinned: a node updates them only when a fleetd release changes the pin. A `session_start` during the
install waits up to 30 seconds for it, then opens the screen; if the install takes longer, it says which step the
install is on and how long it has run, and a retry once it is done opens the screen. If the install fails while a
`session_start` waits, that start answers with its error. If it fails after the start stopped waiting, the next
`session_start` answers with the error without downloading again. Any later `session_start` tries the install again,
as does the first one after an install that failed as the node started (say, before the network was up). On a machine
without Node.js, `session_start` explains why it can't start one. A machine without an ffmpeg records screens without
their video, and each screen's note says so.

Settings go under `browser` in [node.json](/docs/config-and-files#node-json) (`enabled` from [Settings](#settings)
too). The node keeps one Chrome launched for the next screen, about 0.5 GB of memory. A screen ends after 30
minutes without an `agent-browser` command.

| Key | Means |
|---|---|
| `enabled` | `false` turns browser screens off on this machine. Absent or `true`: on, and the node installs the browser as it starts. |
| `sandbox` | `true` requires Chrome's own sandbox: a machine that refuses it starts no browser. `false` turns it off. Absent: on wherever the machine allows it, else off. |

For fleetd's own development, the node's environment can point it at other binaries: `FLEETD_CHROME` (a Chrome or
headless shell) and `FLEETD_FFMPEG` (Matroska and MJPEG in, `libvpx-vp9` out). With `PLAYWRIGHT_BROWSERS_PATH` set,
the node finds and installs Chrome and ffmpeg there instead of under its home: the labs point their throwaway nodes
at the user's own Playwright cache, so a new node doesn't download Chrome again.

### How long a screen takes to start {#start-time}

Set `FLEETD_LOG=info,fleetd::stages=debug` in the hub's or node's environment to see where a screen's start spends
its time. Each stage goes to the log as it ends, with its own time (`ms`) and the start's so far (`total_ms`):

- **hub screen_open**: `checks`, `seal` and `place`, the hub placing a person's screen and taking its slot;
- **hub screen launch**: `node start` (the node's answer), `recorded` (the node's report of it live) and `control`
  (the person's control, confirmed by the node);
- **node browser**: `install`, `warm browser`, `cold browser` or `kept browser` (from the pool, launched now, or
  launched on a project's kept profile), `secrets` and `session open`, which **node browser open** splits into
  `recorder`, `discover` and `page`;
- **node desktop**: `prepare`, `warm display` or `cold display` (with **node display**'s `xvfb` or `container`),
  `connect`, `secrets` and `session open`.

A browser screen's end goes the same way, as **node browser end**: `captures` (the page after the last steps),
`screencast`, `video` (ffmpeg finishing it), `browser` and `scrub`.

The log also has each screen's first frame on its machine, when the hub asked for its frames, and how long the hub
waited for the first. `FLEETD_LOG` takes the filter `RUST_LOG` does; without it, the log has info and above.

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
  next screen, with scrcpy's server already on it, and boots another behind it, so `session_start` takes well under a
  second and the stream starts without a copy.
- **Recorded through scrcpy.** The node runs [scrcpy](https://github.com/Genymobile/scrcpy)'s server on the emulator
  and decodes its screen stream itself. The recording is an `actions` file as a browser screen's, and a `video` (a
  WebM, VP9, 576×1280). There's no `dom` file.

Emulators are kept apart from each other, not from the agents on their machine: an agent with adb can reach another
screen's emulator by its serial. Run agents that mustn't see each other's devices on different machines.

### On each machine {#android-setup}

Android screens need Linux on x86_64 with KVM: the user running the node must be able to open `/dev/kvm` read-write.
The doctor's `android` check says when it can't, and the fix: usually `sudo usermod -aG kvm $USER`. The node then starts
the emulator through `sg kvm`, which gives it the new group without a restart (restarting the node alone wouldn't: it
keeps its systemd user manager's old groups). An ACL set with `setfacl` is lost whenever udev makes `/dev/kvm` again. A machine runs them only while that
check passes, and lists `session_android` to the hub.

Nothing is installed until a person opts a machine in: Android's switch in [Settings](#settings), or
`"device": {"enabled": true}` in its node.json. The node
then installs everything the first time an agent asks for an Android screen, about 2 GB under
`~/.fleetd/node/device`, each download checked against its pinned digest:

- Google's platform-tools 37.0.1 (adb), emulator 37.2.12 and the Android 15 (API 35) Google APIs x86_64 system image;
- scrcpy's server 5.0.1, and an ffmpeg 6.0.1 static build that decodes its stream;
- agent-device 0.21.31, its npm package checked against npm's integrity digest (it has no dependencies, and runs on
  Node.js 22.12 or later), with its skill.

It then boots the emulator once to save its snapshot. Until that's done, `session_start` says it is still installing.

Settings go under `device` in [node.json](/docs/config-and-files#node-json). The node keeps one emulator booted for
the next screen, about 2 GB of memory. A person's screen ends after 30 minutes without a tap or
key.

| Key | Means |
|---|---|
| `enabled` | `true` opts this machine in: the first Android screen installs the emulator. `false` turns Android screens off. Absent: on only where they are installed already; nothing is installed. |

## iOS screens are gone {#ios}

iOS simulators aren't a kind of screen any more (decision `mac.shared-mac`, D298). An agent starts one of its own on
[the agents' Mac](/docs/agents-mac#sim) with `mac sim start` and drives it with
[agent-device](https://github.com/callstack/agent-device) as before. New screen and the Screens part of a machine's page in Settings › Hub › Machines
offer no iOS; the agents' Mac is the one Apple kind there, and says `Needs a Mac` with its fix while none is set up.

For one release, `ios` stays as a legacy value. `session_start` with `kind` `ios` answers with the way to
`mac sim start`, and so does the hub, to an older node or app asking for an iOS screen (`screen_open`); nothing starts.
Past iOS screens still list, and their recordings still play.

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
node uses Xvfb where it has one, and tries the build again at its next start. The recording's video needs an ffmpeg: the browser screens' or the Android screens' one.

Settings go under `desktop` in [node.json](/docs/config-and-files#node-json). The node keeps one display started for
the next screen. A screen ends after 30 minutes without a `desktop` action.

| Key | Means |
|---|---|
| `enabled` | `false` turns desktop screens off on this machine. `true` prepares them (builds the image, starts a display) when the node starts. Absent: on, prepared at the first screen. |
| `backend` | `container` or `xvfb` only. Absent: a container where docker or podman answers, else Xvfb. |

For fleetd's own development, the node's environment can override what it runs: `FLEETD_DESKTOP_RUNTIME` (a docker
or podman), `FLEETD_DESKTOP_IMAGE` (an image instead of the pinned one; it must start Xvfb on `:0` with
`-auth /fleetd/xauth`), `FLEETD_XVFB` and `FLEETD_FFMPEG`.

## The agents' Mac's screen {#mac}

On a Mac set aside for agents, the desktop of the account its fleetd node runs in (yours is fine) is a screen too:
**`session_start`** with `kind` `mac`, the only kind the agents' Mac hosts (its node's `browser`, `device` and
`desktop` settings are ignored). Unlike the other kinds there is only one, so agents take turns on it:

- **One holder at a time.** The first agent to open it holds it. Another agent's `session_start` still opens a session,
  but it only observes: its `desktop` tool's `screenshot`, `cursor_position` and `wait`, and agent-desktop's reading
  commands (`snapshot`, `find`, `get`, `is`, `list-apps`, ...), work; its other actions answer who holds the screen.
  Once the holder ends, the observer's next action takes the screen.
- **Idle release.** A Mac screen session with no action for 5 minutes ends, and the screen is free for the next one.
- **Your takeover takes it.** Taking over any Mac screen session, or opening one yourself from **New screen ›
  Agents' Mac**, makes it yours: the agent that held it only observes until you're done.

The agent drives it with its `desktop` tool: the same computer-use actions as a Linux desktop (`key` also takes
`cmd` and `option`, as in `cmd+s`), `launch` (a shell command, such as `open -a TextEdit`), and `agent_desktop`, which
runs one [agent-desktop](https://github.com/vercel-labs/agent-desktop) command on the Mac: it reads an app's
accessibility tree into refs (`snapshot --app Finder -i`) and acts on them (`click @s8f3k2p9:e12`) without moving the
pointer. The Mac's node runs agent-desktop itself, a pinned release, so it acts under the node's own grants; each
session gets its own agent-desktop folder, thrown away at its end. An app agent-desktop launches with `--cdp` keeps
its DevTools port on the Mac's loopback (a launch naming another address is refused) and is closed when the session
ends. Apps the agent opened otherwise stay open on the Mac, as yours would.

What the screen is, and isn't:

- **It's the node's account at the Mac's screen**: yours, when the Mac joined from your account, or a [user of its
  own](/docs/agents-mac#own-user). The viewer is badged **Agents' Mac**. Agents can read and draw anything there, a
  fake sign-in dialog included: never type your own passwords, an Apple ID or an admin password into it.
  `fill_credential` isn't offered on it, and the Mac's node is sent none of an agent's secrets.
- **It needs the node's session on the screen, unlocked.** macOS gives a session that is switched to the background or
  locked only black frames, and drops its input. So the kind is offered only while the node's account is the one
  logged in at the Mac's screen, unlocked, and the node checks it again at every start. Otherwise Settings and New
  screen say exactly what stands in the way: the screen is locked, another user has it, nobody is logged in, or a grant
  is missing.
- **Recorded as any screen**: the video while a session holds the screen, and its action log, a line per action and
  agent-desktop command. Recordings go to the hub's storage, under the same retention.

### On the Mac {#mac-setup}

On the [agents' Mac](/docs/agents-mac#setup):

1. Keep the node's account logged in at the Mac's screen. Turn its screen lock off (System Settings › Lock Screen ›
   Require password: Never), and its screen saver and display sleep: a locked screen is blind.
2. Allow fleetd in System Settings › Privacy & Security › **Screen Recording** and **Accessibility** in that session;
   the join opens both, and the node restarts itself to take each up. The Screens setting's fix opens the right pane.
   macOS asks again for Screen Recording about once a month.
3. Turn **Agents' Mac** on under Screens, on the Mac's page in Settings › Hub › Machines. The node installs agent-desktop as it starts.

Settings go under `mac` in [node.json](/docs/config-and-files#node-json):

| Key | Means |
|---|---|
| `enabled` | `true` lends the Mac's screen. Absent or `false`: off. |
