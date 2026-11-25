---
title: Several hubs
description: Pair the desktop app with more than one hub and see all their work in one window.
---

The desktop app can be paired with several hubs at once, for example your own bots on one and your company's on
another. Each hub keeps its own machines, people and keys.

## Add a hub {#add}

1. On the new hub's machine, run `fleetd pair` to print a pairing code.
2. In the app, open Settings › Hubs & devices and click **Add a hub**.
3. Enter a name (Personal, Acme, anything), pick a colour if you like, then the hub's address and the code.
4. Click **Connect**. Your other hubs stay connected.

Opening a `fleetd://pair` link adds a hub the same way. A link for a hub you already have pairs it again instead.

## Rename, recolour or remove {#manage}

Settings › Hubs & devices lists each hub.

- **Rename:** edit its name and press Enter.
- **Recolour:** click a swatch. The empty one means no colour.
- **Pair again:** shown when the hub refused this app's key.
- **Remove…:** the app forgets that hub's key. Agents on it keep running.

### Restart a hub {#restart}

Owners and admins see **Restart hub…** on a hub's row. The hub is back in about a second: apps and machines
reconnect by themselves, and running agents carry on. Use it when a hub needs to drop what it holds in memory, or to
move leads onto a changed model.

It works for a hub run as a service (`fleetd init` sets one up). A hub started by hand with `fleetd hub start`
needs to be stopped and started again on its machine. The phone app has the same under Settings.

## Make a new workspace {#new}

Signed in to fleetd cloud, you can make another workspace of your own from the desktop app, the web app or the phone
app:

1. Click the workspace's name at the top of the sidebar. On the phone, open Settings › Workspaces.
2. Pick **New workspace…** and give it a name, or leave the name empty to have it named after you.
3. Click **Create**. The new workspace opens on its Get started.

A new workspace starts empty, with its own address, members, bots, plan and credits, and is billed on its own like
your first. One person can make up to 10. Past that, or when too many new workspaces were made from your network
recently, the app says so and what to do.

In the desktop app, **Connect a self-hosted workspace…** in the same menu pairs one you run yourself, as in
[Add a hub](#add).

## Switch between hubs {#sidebar}

The sidebar shows one hub at a time, with its name at the top. To switch:

- click the name and pick a hub;
- swipe left or right with two fingers on the sidebar;
- click a hub's square at the bottom of the sidebar;
- press ⇧⌘] or ⇧⌘[ (Ctrl+Shift+] or Ctrl+Shift+[ on Linux).

Each hub opens on the chat you last had open there. In the web app, the name at the top lists all your cloud
workspaces; on the phone, Settings › Workspaces lists every one it keeps.

## What needs you, on every hub {#attention}

- **Sidebar:** a dot by the hub's name means a bot on another hub needs you.
- **Dock badge:** counts the bots that need you on every hub.
- **Notifications:** come from every hub, titled with its name.
- **Status** and **⌘K:** list every hub's bots, under their hub's name.

## Manage a hub {#admin}

Settings' Hub group manages one hub at a time, named at the top ("Managing Acme"). Pick another hub there to manage
it. Only hubs where you're an owner or admin are listed.

## When a hub is out of reach {#offline}

The hub's name in the sidebar gets a dot. Click it to see what's wrong, with **Retry** or **Pair again**.

Only that hub's bots are affected: they show as last seen, and your other hubs keep working. The app reaches each
hub directly, so a hub only your company network reaches needs that network or its VPN.

## Where things are kept {#storage}

Each hub's key is stored like the first one, encrypted by the OS where it can be ([Security](/docs/security#keys)).
The list of hubs, with names and colours but no keys, is `desktop-hubs.json` in the app's folder. If that file
breaks, the app finds each hub again from its saved key.
