---
title: Several hubs
description: Pair the desktop app with more than one hub, each under a name you pick, and see all of their work in one window.
---

The desktop app can be paired with several [hubs](/docs/glossary#hub) at once. Use this to keep work apart, for
example your own bots on one hub and your company's on another, each with its own machines, people and keys,
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

Settings › Hubs & devices lists each hub with its address, its connection and where its key is kept.

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

Pick how the sidebar carries your hubs in the menu under your name, **Sidebar**: **List**, **Hubs** or **Rail**. The
app keeps your pick on this computer (in the web app, in this browser) and redraws the sidebar at once.

- **List** (the default): every hub's bots in one list, newest first, your pins as a row of capsules over it. Each row
  starts with a quiet word for where the bot lives: its section, or its hub's name when it's in none.
- **Hubs**: one hub at a time. Its name at the top opens the list of your hubs; a dot by its name means a bot on
  another hub needs you. Under it, that hub's pins, its bots, then your sections under their labels.
- **Rail**: your hubs as small squares down the sidebar's edge, a dot on one whose bots need you. Beside them, that
  hub's pins and bots, with your sections as tabs over them.

Opening a bot from elsewhere (a notification, ⌘K) shows its hub. ⌘1 to ⌘9 count the rows you can see, in order. With
one hub, List and Hubs show the same bots, with no hub's name on any row.

## Everything that needs you {#attention}

Every hub counts toward what needs you:

| Where | With several hubs |
|---|---|
| The sidebar | Each row's mark (reply, approve, secret, blocked) sits on its bot's row; in Hubs and Rail, a hub that isn't on show carries a dot. |
| The Dock badge | Counts the bots that need you on every hub. |
| Notifications | Come from every hub, each under its own quiet hours. The title starts with the hub's name, and clicking one opens that hub's bot. |
| Status | Has a section per hub, under its name. |
| Commands (⌘K) | Lists every hub's bots, each with its hub's name beside its machine. |

## Managing a hub {#admin}

Settings' Hub group manages one hub at a time. With several hubs, it names that hub, with its colour, above every page:
"Managing Acme". The button to make an invite names it too: **Create invite link to Acme**. To manage another hub,
pick it beside "Managing" at the top of the page. The page you're on stays open. Only the hubs where you're an
owner or admin are listed.

## When a hub is out of reach {#offline}

While a hub is out of reach, a small mark shows on your picture at the bottom of the sidebar, its tooltip naming the
hub. Click your name for a row per hub: its name beside a dot while it's connected, else what is wrong in a few words
with **Retry** or **Pair again**. A click on a connected hub's row opens it in Settings › You › Hubs & devices, which says why a
hub is out of reach.

A hub that's out of reach only affects its own group. Its bots show as they were last seen, marked "as of 09:02",
and the other hubs keep working. A hub refusing the app's key doesn't lock the window either: its row in the menu
says "Acme refused the key", with **Pair again**.

The app reaches each hub directly, over your tailnet or HTTPS. A hub that only your company network reaches is out of
reach from home until you're on that network or its VPN.

## Where things are kept {#storage}

Each hub's key is kept the same way as the first one, encrypted by the OS where it can be (see
[Security](/docs/security)). The list of hubs, with their names and colours but no keys, is `desktop-hubs.json` in
the fleetd directory. The first hub keeps the files it always had, so an app updated from an earlier version simply
has one hub.

If `desktop-hubs.json` can't be read, no hub is lost. The app keeps the old file as `desktop-hubs.json.bad`, finds
each hub again from its saved key, and Settings › Hubs & devices says so. The hubs come back under their host names, so rename
them if you like.
