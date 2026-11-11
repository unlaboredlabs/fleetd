---
title: Several hubs
description: Pair the desktop app with more than one hub, each under a name you pick, and see all of their work in one window.
---

The desktop app can be paired with several [hubs](/docs/glossary#hub) at once. Use this to keep work apart, for
example your own projects on one hub and your company's on another, each with its own machines, people and keys,
and still see all of it in one window.

Each hub gets a name you choose, such as Personal, Acme or Side project, and an optional colour. Names are free text,
not a fixed list.

## Add a hub {#add}

1. On the new hub, print a pairing code with `fleetd pair` (see [Pair it with the hub](/docs/desktop-app#pair)).
2. In the app, open Settings (⌘,) → Hubs and click **Add a hub**.
3. Enter a name, pick a colour if you like, then the hub's address and the code. Click **Connect**.

To connect with a key instead, click "Use a key instead". The hubs you already have stay connected the whole time.

A `fleetd://pair` link opened while the app is already connected to a hub adds a new hub too. The app asks for a name
first. A link or address for a hub you already have pairs that hub again instead of adding it twice.

## Rename, recolour or remove {#manage}

Settings › Hubs lists each hub with its address, its connection and where its key is kept.

| To | Do |
|---|---|
| Rename it | Edit **Name** and press Enter. |
| Change its colour | Click a swatch. The empty one means no colour. |
| Pair it again | Click **Pair again**. It shows when the hub refused this app's key. |
| Remove it | Click **Remove…**. The app forgets that hub's key and what it kept offline for it. Your other hubs stay as they are, and agents on the removed hub keep running. |

With only one hub, Remove is called "Disconnect and forget key", as before.

### Restart a hub {#restart}

On the row of a hub you are an owner or admin of, with Admin on every machine, **Restart hub…** restarts that hub in
place, the way an update restarts it. Members don't see the button, and the hub refuses them anyway. It asks first.
The hub is back in about a second: the row says **Restarting the hub…** until this app is connected again, every
other app and machine reconnects by itself, and running agents carry on. A message sent meanwhile goes once the hub is
back.

After such a restart, each lead whose [profile](/docs/projects#lead-profile) changed since it started comes back on
the current one, with its chat, memory and open orders; the row says how many. Leads already on it just carry on.

The hub restarts itself through the service `fleetd init` set up (the `fleetd-hub` systemd user unit, or its launchd
agent on a Mac). One started by hand with `fleetd hub start` says so instead: stop it and start it again on its machine.
The phone app has the same under Settings, **Restart Hub**, for admins.

## One sidebar {#sidebar}

Each hub's projects sit under its name in the sidebar, in the order you added the hubs. Click a hub's name to
collapse its group. A collapsed group still says how many of its projects need you. ⌘1 to ⌘9 count only the rows you
can see.

With one hub there is no name and no group, so the sidebar looks as it always has.

## Everything that needs you {#attention}

Every hub counts toward what needs you:

| Where | With several hubs |
|---|---|
| The sidebar | Each row's mark (reply, approve, secret, blocked) sits in its hub's group. |
| The Dock badge | Counts the projects that need you on every hub. |
| Notifications | Come from every hub, each under its own quiet hours. The title starts with the hub's name, and clicking one opens that hub's project. |
| Status | Has a section per hub, under its name. |
| Commands (⌘K) | Lists every hub's projects, each with its hub's name beside its machine. |

## Managing a hub {#admin}

Settings' Hub group manages one hub at a time. With several hubs, it names that hub, with its colour, above every page:
"Managing Acme". The button to make an invite names it too: **Create invite link to Acme**. To manage another hub,
pick it beside "Managing" at the top of the page. The page you're on stays open. Only the hubs where you're an
owner or admin are listed.

## When a hub is out of reach {#offline}

While a hub is out of reach, a small mark shows on your picture at the bottom of the sidebar, its tooltip naming the
hub. Click your name for a row per hub: its name beside a dot while it's connected, else what is wrong in a few words
with **Retry** or **Pair again**. A click on a connected hub's row opens it in Settings › You › Hubs, which says why a
hub is out of reach.

A hub that's out of reach only affects its own group. Its projects show as they were last seen, marked "as of 09:02",
and the other hubs keep working. A hub refusing the app's key doesn't lock the window either: its card says
"Key refused", and Settings › Hubs has **Pair again**.

The app reaches each hub directly, over your tailnet or HTTPS. A hub that only your company network reaches is out of
reach from home until you're on that network or its VPN.

## Where things are kept {#storage}

Each hub's key is kept the same way as the first one, encrypted by the OS where it can be (see
[Security](/docs/security)). The list of hubs, with their names and colours but no keys, is `desktop-hubs.json` in
the fleetd directory. The first hub keeps the files it always had, so an app updated from an earlier version simply
has one hub.

If `desktop-hubs.json` can't be read, no hub is lost. The app keeps the old file as `desktop-hubs.json.bad`, finds
each hub again from its saved key, and Settings › Hubs says so. The hubs come back under their host names, so rename
them if you like.
