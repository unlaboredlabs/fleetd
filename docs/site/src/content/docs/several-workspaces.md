---
title: Several workspaces
description: Pair the desktop app with more than one workspace and see all their work in one window.
---

The desktop app can be paired with several workspaces at once, for example your own bots on one and your company's on
another. Each workspace keeps its own machines, people and keys.

## Add a workspace {#add}

1. On the new workspace's machine, run `fleetd pair` to print a pairing code.
2. In the app, open Settings › Workspaces & devices and click **Add a workspace**.
3. Enter a name (Personal, Acme, anything), pick a color if you like, then the workspace's address and the code.
4. Click **Connect**. Your other workspaces stay connected.

Opening a `fleetd://pair` link adds a workspace the same way. A link for a workspace you already have pairs it again instead.

## Rename, recolor or remove {#manage}

Settings › Workspaces & devices lists each workspace.

- **Rename:** edit its name and press Enter.
- **Recolor:** click a swatch. The empty one means no color.
- **Pair again:** shown when the workspace refused this app's key.
- **Remove…:** the app forgets that workspace's key. Agents on it keep running.

### Restart a workspace {#restart}

Owners and admins see **Restart workspace…** on a workspace's row. The workspace is back in about a second: apps and machines
reconnect by themselves, and running agents carry on. Use it when a workspace needs to drop what it holds in memory, or to
move leads onto a changed model.

It works for a workspace run as a service (`fleetd init` sets one up). A workspace started by hand with `fleetd workspace start`
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
[Add a workspace](#add).

## Switch between workspaces {#sidebar}

The sidebar shows one workspace at a time, with its name at the top. To switch:

- click the name and pick a workspace;
- swipe left or right with two fingers on the sidebar;
- click a workspace's square at the bottom of the sidebar;
- press ⇧⌘] or ⇧⌘[ (Ctrl+Shift+] or Ctrl+Shift+[ on Linux).

Each workspace opens on the chat you last had open there. In the web app, the name at the top lists all your cloud
workspaces; on the phone, Settings › Workspaces lists every one it keeps.

## What needs you, on every workspace {#attention}

- **Sidebar:** a dot by the workspace's name means a bot on another workspace needs you.
- **Dock badge:** counts the bots that need you on every workspace.
- **Notifications:** come from every workspace, titled with its name.
- **Status** and **⌘K:** list every workspace's bots, under their workspace's name.

## Manage a workspace {#admin}

Settings' Workspace group manages one workspace at a time, named at the top ("Managing Acme"). Pick another workspace there to manage
it. Only workspaces where you're an owner or admin are listed.

## When a workspace is out of reach {#offline}

The workspace's name in the sidebar gets a dot. Click it to see what's wrong, with **Retry** or **Pair again**.

Only that workspace's bots are affected: they show as last seen, and your other workspaces keep working. The app reaches each
workspace directly, so a workspace only your company network reaches needs that network or its VPN.

## Where things are kept {#storage}

Each workspace's key is stored like the first one, encrypted by the OS where it can be ([Security](/docs/security#keys)).
The list of workspaces, with names and colors but no keys, is `desktop-hubs.json` in the app's folder. If that file
breaks, the app finds each workspace again from its saved key.
