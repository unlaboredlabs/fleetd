---
title: Web app
description: Use fleetd cloud in a browser at app.fleetd.dev, with nothing to download. What it does, and what stays in the desktop app.
---

On fleetd cloud you can use fleetd in a browser: open [app.fleetd.dev](https://app.fleetd.dev) and sign in with
Google, GitHub or a code by email, as in the apps. It is the desktop app's own interface: your teams' bots, their
chats live as the lead writes, the panel beside a chat, Factory, Screens and taking a screen over, and Settings. With
several teams, each is a group in the sidebar, as [several hubs](/docs/several-hubs) are in the desktop app.

The web app is for fleetd cloud only. A hub you run yourself is used from the [desktop app](/docs/desktop-app) and the
[phone app](/docs/mobile).

## Getting started {#get-started}

After your first sign-in, a new team opens on **Get started**: the few steps between you and a first chat with a
bot's lead. The one step still to do is open; each one done keeps a line saying what it ended on.

1. **Connect a computer.** Agents run on a computer of yours: fleetd cloud hosts only the hub. Copy the line shown and
   paste it in a terminal on a Mac or Linux computer; it installs fleetd and joins. The line's code works once, for 15
   minutes, and the page makes a new line by itself when it runs out. If Claude isn't logged in on that computer,
   **Log in to Claude** opens Claude's sign-in page; paste the code it shows.
2. **Connect GitHub.** One trip to GitHub: you sign in, then choose the repositories fleetd's GitHub App may work on,
   and GitHub sends you back to the page. An organization member who can't install apps there asks an owner from
   GitHub's page. **Skip** goes on without GitHub; connect later from Settings › Your accounts › GitHub.
3. **Start a bot.** Pick a repository: fleetd clones it onto the computer and opens the bot's chat. **Empty bot** makes
   one with no repository.

**Skip for now** goes to the app. Until everything is done, the menu under your name has **Finish setting up** with
the steps left, which opens the page where you left off.

A teammate who joins by an invitation lands on the same page with the team's bots listed first, and their own GitHub
as one row under them.

## What stays in the desktop app {#desktop-only}

| In the desktop app only | On the web |
|---|---|
| Pair a hub of your own | Not offered: your teams come with the sign-in |
| **Set up this Mac for agents**, and **This computer** in Add machine | Add a machine with its join line, pasted in a terminal on that computer |
| **Connect this computer** opening a terminal | The same line, to copy |
| Showing or copying a [vault](/docs/vault) value (behind Touch ID), or making a secret variable plain | The vault lists its items; adding and editing work, values stay hidden |
| The menu bar icon, the app's own updates, folder pickers, Show in folder | Nothing to update: a reload gets the newest web app |
| App presence (Settings › General) | Not sent |

Notifications are the browser's: allow them for app.fleetd.dev when Settings › General › Notifications sends its
test. A chat's file downloads instead of opening. A report opens in its frame as in the app, served from your team's
own address, never app.fleetd.dev. Keyboard shortcuts the browser keeps for itself (such as ⌘W) do what the browser
does.

## Signing out {#sign-out}

Settings › Hubs & devices › fleetd account › **Sign out** ends the browser's session. A session lasts at most seven
days; the browser keeps no key and none of your chats, so nothing stays on a shared computer once you have signed out.
The web app shows up in [Devices](/docs/mobile#devices) as **Web browser**, where you can sign it out from elsewhere.

## How it fits together {#contract}

The web app is `app/desktop`'s renderer built with the browser's shell in place of Electron's (`pnpm build:web`, in
`app/desktop/src/web`). fleetd cloud builds it from the commit it pins and serves it at app.fleetd.dev. The browser
calls only that origin, the session being an HttpOnly cookie the cloud sets:

| Call | Answer |
|---|---|
| `GET /web/session` | `{ email, teams: [{ id, name, url }], invitations? }`, or 401 when signed out |
| `GET /web/sign-in?return=<path>` | WorkOS's sign-in, then back to that path |
| `POST /web/sign-out`, `POST /web/accept { accept }` | 204; `{ team }` for an invitation joined |
| `/t/<team>/app` | the team's hub socket: the cookie is its auth; `{"t":"ping"}` is answered `{"t":"pong"}` |
| `POST /t/<team>/web/frames` | `{ url }`: a report's page on the team's own address, `https://<team>.fleetd.dev/frames/<token>` |
| `/t/<team>/accounts/v1/invites…`, `POST /t/<team>/github/v1/install` | the team's invites by email and GitHub install page, as for the apps |
| `POST /t/<team>/github/v1/web/connect { return, install? }` | `{ url }`: GitHub's sign-in (then its install page), which the tab goes to; back at `return` with `?github=connected`, `installed`, `requested` or `failed&why=…` |
| `GET /t/<team>/github/v1/repos` | `{ repos: [{ owner, name, fullName, private, pushedAt?, defaultBranch, cloneUrl }], truncated? }`, newest push first; 404 while fleetd's App isn't installed |

Every call but a GET carries `x-fleetd-web: 1`, and the cloud takes a write or the socket only from the web app's own
origin, so a page elsewhere (an agent's report on a team's address among them) can't act with your session.
