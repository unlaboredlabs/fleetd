---
title: Web app
description: Use fleetd cloud in a browser at app.fleetd.dev, with nothing to download. What it does, and what stays in the desktop app.
---

On fleetd cloud you can use fleetd in a browser: open [app.fleetd.dev](https://app.fleetd.dev) and sign in with
Google, GitHub or a code by email, as in the apps. It is the desktop app's own interface: your teams' projects, their
chats live as the lead writes, the panel beside a chat, Factory, Screens and taking a screen over, and Settings. With
several teams, each is a group in the sidebar, as [several hubs](/docs/several-hubs) are in the desktop app.

The web app is for fleetd cloud only. A hub you run yourself is used from the [desktop app](/docs/desktop-app) and the
[phone app](/docs/mobile).

## What stays in the desktop app {#desktop-only}

| In the desktop app only | On the web |
|---|---|
| Pair a hub of your own | Not offered: your teams come with the sign-in |
| **Set up this Mac for agents**, and **This computer** in Add machine | Add a machine with its join line, pasted in a terminal on that computer |
| **Connect this computer** opening a terminal | The same line, to copy |
| Showing or copying a [vault](/docs/vault) value (behind Touch ID), or making a secret variable plain | The vault lists its items; adding and editing work, values stay hidden |
| Connecting your own GitHub (its sign-in comes back to the app on your computer) | Connect it once in the desktop app; installing fleetd's GitHub App works on the web |
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

Every call but a GET carries `x-fleetd-web: 1`, and the cloud takes a write or the socket only from the web app's own
origin, so a page elsewhere (an agent's report on a team's address among them) can't act with your session.
