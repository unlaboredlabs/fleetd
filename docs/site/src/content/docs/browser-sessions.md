---
title: Screens
description: Watch the browsers, emulators and desktops your agents use, take them over, and open your own.
---

This page is for watching the screens your agents use, taking them over, and opening one yourself.

A screen is a browser, a Linux desktop, an Android emulator, an iOS simulator, or the agents' Mac's own screen. An
agent opens one when it needs it, works in it, and closes it when done. Every screen is recorded.

| Kind | Runs on | Agents drive it with |
|---|---|---|
| Browser | Any machine | agent-browser |
| Linux desktop | Linux | the desktop tool |
| Android | Linux with KVM | agent-device |
| iOS simulator | [The agents' Mac](/docs/agents-mac#sim), or [a Mac that runs agents](/docs/agents-mac#one-mac) | agent-device |
| Agents' Mac | The agents' Mac | the desktop tool, agent-desktop |

## The Screens page {#page}

Click **Screens** in the sidebar, at the bottom. It lists every screen in your bots:

- **Needs you**: screens whose agent asked you to take over, with its reason.
- **Live**: every running screen, with its bot, machine and the agent's latest step.
- **Recent**: screens that ended. Open one to replay it.

A bot's own screens are under **Agents › Screens** in the panel beside its chat.

A replay plays at 1×, 2× or 4×. Drag along its line or click a step to jump there: the picture changes straight to
that moment. A phone's replay keeps the phone's own shape, turned and folded as it was.

## Watch and take over {#takeover}

1. Open a live screen. You see it as the agent does, as it happens.
2. Click **Take over**. The mouse and keyboard are now yours, and the agent waits.
3. Do what's needed: solve a captcha, sign in, check something.
4. Click **Hand back**. The agent carries on from the page as you left it.

When an agent needs you, it asks with a reason. You get a notification on the desktop and on your phone, and the screen
shows under **Needs you**.

In a browser you control, the bar at the top is its address bar. On Android or an iPhone, your mouse is a finger: click
to tap, drag to swipe.

The recording notes that you took over, never what you typed.

## Open one yourself {#yours}

1. Click **New screen** (the **+** beside **Screens** in a bot's Agents tab, or on the Screens page).
2. Pick the kind: **Browser**, **iPhone**, **Android**, **Linux desktop** or **Agents' Mac**.
3. Pick the machine, and for an iPhone the model and iOS version.
4. Click **Open screen**. It opens with you in control.

**End screen** closes it. It also ends after 30 minutes without your input.

A browser you open on the bot's own machine uses the bot's saved sign-ins, so a site you sign in to stays signed in
for its lead.

If the machine is full, click **Wait for a slot**. You get the next free slot, ahead of any agent.

### Open a PR's build {#yours-pr}

An Android screen can open with a pull request's build installed. Pick the PR under **PR build**. The build must be
an `.apk` artifact from the PR's CI run, at most 64 MiB, with `android` or `apk` in its name.

### Phone controls {#phone-controls}

An iPhone or Android screen you control has a strip of controls beside it:

- **iPhone**: rotate, Home, Lock, Shake, light or dark, location, screenshot, and Fold on an iPhone Duo.
- **Android**: rotate, Home, Back, screenshot.

## The agents' Mac's screen {#mac}

The agents' Mac lends its own screen, shared by every agent:

- Several agents can work at once, each in its own app.
- Only one at a time moves the pointer or types. It's freed after 5 minutes without use.
- When you take over, the whole screen is yours until you hand it back.

Never type your own passwords or Apple ID into it: agents can see and draw anything there.

### On the Mac {#mac-setup}

The Mac's account must be logged in at the screen, unlocked, with fleetd allowed under **Screen Recording** and
**Accessibility**. See [Set up the agents' Mac](/docs/agents-mac#setup).

## Sign-ins from the vault {#logins}

An agent signs in to a site without seeing the password:

1. Add the login to the [vault](/docs/vault) with the sites it's for.
2. The agent asks fleetd to fill the field. fleetd types it in, only on those sites.
3. Every fill is logged on the item.

From the first fill, the screen hides filled values from the agent and its recording.

### What keeps the value from the agent {#sealed}

- fleetd types the value itself and submits the form in the same step.
- After a fill, the agent can't run its own scripts on the page, read field values, or change where a form sends.
- Filled values are scrubbed from the action log and page captures. Non-password fields show blurred.

Agents aren't sandboxed on their machine, so an agent set on getting around this could. Keep the vault to logins made
for agents.

### 1Password {#1password}

1Password is a place to [import from](/docs/vault#import) into the vault. Fills use the vault.

## What's recorded {#recording}

Each screen keeps:

- A video of the screen.
- A log of every step the agent took, and when you took over.
- For a browser, the page after each step.

Bot secrets are masked in the log and page captures. The video can't be masked: whatever showed is in it.

## Recordings on the workspace {#workspace}

The workspace keeps recordings for 30 days, and up to 20 GB per bot, oldest deleted first. Change the days with **Keep
screen recordings for** in **Settings › Workspace › Machines**.

## Screens in Settings {#settings}

A machine's page in **Settings › Workspace › Machines** has a **Screens** part:

- **At once**: how many screens it hosts at the same time (Auto or a number).
- A line for each kind that needs setup, with the command that fixes it.

There's no switch per kind. A Linux machine hosts every kind it can run; a kind it can't goes to another machine.

## Isolation {#isolation}

- Each browser is a fresh Chrome with an empty profile, thrown away at the end.
- Each Android emulator and Linux desktop is a fresh copy, thrown away at the end.
- Only the screen's own agent can drive it.

A bot's lead with no repo keeps one browser profile between screens, so its sign-ins last.

## Setup on each machine {#setup}

Most of this installs by itself. `fleetd doctor` says what's missing. iOS and the Mac's screen need
[the agents' Mac](/docs/agents-mac#setup).

### Browser {#browser-setup}

fleetd installs Chrome and agent-browser when the node starts. It needs Node.js.

### Linux desktop {#desktop-setup}

Needs docker, podman or Xvfb (`sudo apt install xvfb`).

### Android {#android-setup}

Needs Linux on x86_64 with KVM. If the check fails, run `sudo usermod -aG kvm $USER`. fleetd downloads about 2 GB the
first time an agent asks for one.

## Android screens {#android}

Each Android screen is a fresh Android 15 emulator, started from a warm copy in about a second. Agents on the same
machine can reach each other's emulators, so run agents that mustn't see each other on different machines.

## Linux desktop screens {#desktop}

Each Linux desktop is a 1280×800 display with a window manager and a terminal. With docker or podman it runs in a
fresh container that sees only the agent's own work, read-only.

## How an agent uses one {#use}

1. `session_start`, with what it's for.
2. Drive it with agent-browser, agent-device or the desktop tool.
3. `session_end`, or 30 minutes without use.

An agent has one screen at a time. When it needs a person, it calls `request_takeover`. See
[Agent tools](/docs/reference/agent-tools#session_start).
