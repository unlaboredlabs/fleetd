---
title: The desktop app
section: Using fleetd
order: 70
description: Pair the app with your hub, give the fleet work, follow an order, see its status, answer the inbox, and the shortcuts.
---

The app is where you give work, follow it, answer asks, approve commands and enter secrets. Install it with
`curl -fsSL https://fleetd.sh | sh -s -- --app` ([Install](install.md)). It updates itself; `fleetd update` updates it
too.

## Pair it with the hub

On the hub machine the app pairs by itself. On another computer, print a code on the hub:

```console capture=pair
$ fleetd pair
Pairing code: PMJW-Q2J7  (single use, valid until 2026-10-19T16:02:14.452Z)
Hub address:  http://127.0.0.1:4778
Pairing link: fleetd://pair?hub=http%3A%2F%2F127.0.0.1%3A4778&code=PMJW-Q2J7

The fleetd app on this machine pairs by itself when it opens. On another device, open the
app and enter the code and hub address above, or open the link there.
```

Enter the address and code in the app, or open the `fleetd://pair` link. The code works once, for 15 minutes. The app
keeps its key encrypted with the OS keychain; without one (Linux with no keyring, an unsigned Mac build) it keeps it
in a file only you can read. Settings (⌘,) shows the hub it is paired with and disconnects it; "Connect to a hub…" in
the palette pairs with another.

## Give work {#composer}

The app opens on the board, ready to type: say what the fleet should do and press Enter. The board shows what needs
you and every open order with its agents, PRs and how far along the merge train each is.

![The board with one order on it: three PRs, each with two reviewers and a verifier at work under it, and the merge train below.](/docs/img/board.png)

- **Project**: the project picker (⌘⇧P) or a leading `@project `. Without one, the hub picks and says why.
- **Type**: the type picker (⌘⇧T), or a prefix: `fix:` or `bug:`, `research:`, `finish:`. The default is a feature.
- **Attach**: up to 8 files (images, text, PDF; 5 MiB each) with ⌘⇧A, paste or drop. A paste over 3,500 bytes becomes
  `pasted-N.txt`. The lead finds them in `.fleetd/attachments/<W>/` of the project, kept out of git.
- **Mention**: `@` offers the project's files, orders and PRs.

An order is at most 4,000 bytes; attach the detail. If the hub can't tell the project, the order asks which one. To
add a project, use Add next to Projects: paste a GitHub URL or `owner/repo`, or drop a folder or a link on the app
([Add a project](projects-and-orders.md#add-a-project)).

![The Add project sheet cloning acme/checkout-v2: the clone at 42%, then inspect and register still to come.](/docs/img/add-project.png)

## Follow an order {#order}

Open an order for its agents, PRs and done-when checks, and the project lead's conversation about it. The box under
the conversation talks to the lead:

| Do | How | The lead |
|---|---|---|
| Add to the lead's queue | Enter | takes it in at its next step, after the tool it is running ([what that means](steering.md#next-step)) |
| Interrupt and redirect | ⌘Enter | stops its current step and reads it at once |
| Stop | ⌘⇧., then confirm | its running agents are cancelled and its asks withdrawn; merged PRs stay |
| Reorder | Reorder, on a stopped order | its text goes back into the composer, to send as a new order |

Each steer shows whether it was queued, delivered and acknowledged ([Receipts](steering.md#receipts)); a queued one
can be withdrawn. Pick an agent to steer that agent instead. A stopped order isn't reopened.

![An order's fleet with the steer sheet open for its verifier: what it was told, its last items, and the box that steers it.](/docs/img/steering.png)

## Status {#status}

⌘. shows Status for what you're looking at: the open order, the selected project, or the whole fleet. It shows the
progress fleetd verified, what the work waits on, what changed since you last looked, health, what needs you and
risks. It stays live; a part whose source went quiet is marked stale with the reason and keeps its last value. What
the number means: [Status](status.md).

## Inbox and replies {#reply}

⌘I opens the inbox. 1-9 select an item, Enter takes its recommendation, `n` answers no. Or answer a whole batch in
one line in its reply field (or in the palette):

| Reply | Means |
|---|---|
| `1 go` | accept item 1 (also `yes`, `y`, `ok`, `rec`) |
| `2 nvm` | reject item 2 (also `no`, `drop`, `n`) |
| `3 b` | pick option b of item 3 (`a` to `f`; `a` is the recommendation) |
| `4 skip` | skip a question for now: the lead keeps its recommendation, nothing is recorded |
| `1-3 go` | the same answer for items 1 to 3 |
| `2: use the staging bucket` | answer in your own words |
| `4 later` | not now; it stays open |
| `5 done` | you did a checklist's steps |
| `recs fine` | accept every recommendation not mentioned |
| `#B4 1 go` | answer batch 4, not the latest |
| `pref: no new dependencies` | a standing preference for every lead |
| `forget D12` | drop decision 12 |

Mix them: `1 go 2 nvm 3 b`. A reply the app can't read changes nothing. You have 10 seconds to take back an answer to
a question before its lead hears of it. From a terminal, `fleetd answer --key-file <human key>` lists the open
questions, and `fleetd answer "1 b" --key-file …` replies.

Asks that block work also raise a desktop notification: at most one every 20 minutes, with the rest folded in, and
only urgent ones in quiet hours (23:00 to 08:00 unless a `policy.quiet_hours` decision says otherwise).

## Where time went {#time}

Time, in an order's header, the sidebar or the palette, shows where the time of an order, a project, a machine or the
fleet went: each agent, PR, CI check and ask on a timeline with the critical path marked, totals by group with the
slowest commands and checks, and the findings. Open a step to read its transcript. How to read it, and what is not
exact: [Where time went](time-inspector.md).

![Where an order's time went: a lane per agent, PR, CI check and ask, the critical path underlined, and the legend.](/docs/img/time.png)

## Settings

Settings (⌘,) has General (appearance, motion, the hub connection and the hub's own options), Prompts and
Instructions; the last two are in [What agents are told](what-agents-are-told.md).

## Shortcuts

⌘/ lists every shortcut, and ⌘K finds any command by name. ⌘ is Ctrl on Linux.

| Keys | Does |
|---|---|
| ⌘K | Command palette: projects, orders, asks and actions, or a new order from what you typed |
| ⌘N | New order |
| ⌘I | Inbox |
| ⌘0 | Board |
| ⌘1 to ⌘9 | The nth order in the sidebar |
| ⌘[ / ⌘] | Previous / next order |
| ⌘. | Status |
| ⌘, | Settings |
