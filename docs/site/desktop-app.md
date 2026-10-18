---
title: The desktop app
section: Using fleetd
order: 70
description: Pair the app with your hub, answer the inbox in one line, and the keyboard shortcuts.
---

The app is where you send orders, answer asks, approve commands and enter secrets. Install it with
`curl -fsSL https://fleetd.sh | sh -s -- --app` ([Install](install.md)).

## Pair it with the hub

On the hub machine the app pairs by itself. On another computer, print a code on the hub:

```console capture=pair
$ fleetd pair
Pairing code: ZYZ6-5Q97  (single use, valid until 2026-10-18T13:48:01.677Z)
Hub address:  http://127.0.0.1:4778
Pairing link: fleetd://pair?hub=http%3A%2F%2F127.0.0.1%3A4778&code=ZYZ6-5Q97

The fleetd app on this machine pairs by itself when it opens. On another device, open the
app and enter the code and hub address above, or open the link there.
```

Enter the address and code on the app's "Connect to your fleetd hub" screen, or open the `fleetd://pair` link. The
code works once, for 15 minutes. The app keeps its key in the OS keychain, never in a file. Settings (⌘,) shows the
hub it is paired with and disconnects it; "Connect to a hub…" in the palette pairs with another.

## Inbox and replies {#reply}

The inbox (⌘1) lists what needs you, in numbered batches. Answer a whole batch in one line in the reply box at the
bottom of every screen. Typing anywhere outside a field goes there.

| Reply | Means |
|---|---|
| `1 go` | accept item 1 (also `yes`, `y`, `ok`, `rec`) |
| `2 nvm` | reject item 2 (also `no`, `drop`, `skip`, `n`) |
| `3 b` | pick option b of item 3 (`a` to `f`) |
| `1-3 go` | the same answer for items 1 to 3 |
| `2: use the staging bucket` | answer in your own words |
| `4 later` | not now; it stays open |
| `5 done` | you did a checklist's steps |
| `recs fine` | accept every recommendation not mentioned |
| `#B4 1 go` | answer batch 4, not the latest |
| `pref: no new dependencies` | a standing preference for every lead |
| `forget D12` | drop decision 12 |

Mix them: `1 go 2 nvm 3 b`. A reply the app can't read changes nothing and shows a hint. Up in the empty reply box
recalls what you sent before.

Asks that block work also raise a desktop notification: at most one every 20 minutes, with the rest folded in as "+N
more", and only urgent ones in quiet hours (23:00 to 08:00 unless a `policy.quiet_hours` decision says otherwise).

## Shortcuts

⌘ on macOS is Ctrl on Linux.

| Keys | Does |
|---|---|
| ⌘K | Command palette: every project, thread, open ask and action |
| ⌘N | New order |
| ⌘1 / ⌘2 / ⌘3 | Inbox / Projects / Machines |
| ⌘, | Settings |
| ⌘B | Toggle the sidebar |
| ↑ ↓ | Move the selection in a list or the palette (also Ctrl+P / Ctrl+N in the palette) |
| Enter | Open the selected project, run the palette item, or send |
| Shift+Enter | New line in a reply or order |
| Esc | Clear the field, close a dialog, or go back to Projects |
| Tab / Shift+Tab | Next / previous control |
| ⌘Q | Quit |
| ⌃⌘F (macOS), F11 (Linux) | Full screen |
| ⌘H, ⌥⌘H, ⌘M (macOS) | Hide, hide others, minimize |

Text fields follow the usual editing keys of each platform (word motion, undo and redo, select all).
