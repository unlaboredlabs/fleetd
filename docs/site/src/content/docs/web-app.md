---
title: Web app
description: Use fleetd cloud in a browser at app.fleetd.dev, and what still needs the desktop app.
---

On fleetd cloud, you can use fleetd in a browser at [app.fleetd.dev](https://app.fleetd.dev), with nothing to
install. It's the same app as the desktop one: bots, chats, screens and settings.

The web app is for fleetd cloud only. A hub you run yourself uses the [desktop app](/docs/desktop-app) and the
[phone app](/docs/mobile).

## Get started {#get-started}

Sign in with Google, GitHub or a code sent by email. A new team opens on **Get started**:

1. **Where agents run**: a computer of yours, fleetd's computers, or both. For your own computer, paste the line shown
   into its terminal. fleetd's computers need a plan or credits; see [Billing](/docs/billing).
2. **Tailscale** (optional): lets agents on fleetd's computers reach your tailnet.
3. **Claude**: an API key, or a Claude login on your computer.
4. **GitHub**: sign in and pick the repos fleetd may work on.
5. **Start a bot**: pick a repo, or start an empty bot.

**Skip for now** takes you to the app. **Finish setting up**, in the team's menu at the top of the sidebar, brings you
back.

## What needs the desktop app {#desktop-only}

- Showing or copying a [vault](/docs/vault) value. The web app lists items and lets you add and edit them.
- Setting up the computer you're on as a machine with one click. On the web, copy the join line into a terminal.
- Folder pickers, the menu bar icon and app presence.

Notifications use the browser's: allow them for app.fleetd.dev. The web app updates when you reload.

## Sign out {#sign-out}

Settings › Hubs & devices › fleetd account › **Sign out**. Signing out clears the bots and chats the browser kept, so
nothing stays on a shared computer. A session lasts at most seven days.

You can also sign a browser out from another device, in [Devices](/docs/mobile#devices).

## Delete a team {#delete-team}

The team's owner deletes it at the bottom of Settings › Team: **Delete team**, then type the team's name. Its bots,
chats, memory and vault are gone for good, for everyone. Stop running agents and cancel a paid plan first.
