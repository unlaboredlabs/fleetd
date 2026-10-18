---
title: The desktop app
section: Using fleetd
order: 70
description: Pair the app with your hub, give the fleet work from the board, follow an order, see its status, answer the inbox, and the shortcuts.
---

The app is where you give work, follow it, answer asks, approve commands and enter secrets. Install it with
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
code works once, for 15 minutes. The app keeps its key in the OS keychain (an unsigned Mac build: in a file only you can read). Settings (⌘,) shows the
hub it is paired with and disconnects it; "Connect to a hub…" in the palette pairs with another.

## The board

The app opens on the board with the composer focused: type what the fleet should do and press Enter. Under it, what
needs you, then every open order grouped by project (⌘⇧G groups by status). Each card shows its phase, up to four
live agents (role, what each is doing now), its PRs and the lead's next step. Cards don't move under the pointer or
the selection; they resort 2 s after you leave. Machine load and the merge train sit in strips at the bottom.

The sidebar lists Board, Machines, and each project with its orders; an amber dot means an order needs you. Hold ⌘ to
see the ⌘1-⌘9 jump keys.

## Give work {#composer}

- **Project**: the picker (⌘⇧P) says where the order goes and why: chosen, selected in the sidebar, the router's
  guess, last used, or "the hub picks". A leading `@project ` also picks it.
- **Type**: the type picker (⌘⇧T), or a prefix: `fix:` or `bug:`, `research:`, `finish:`. The default is a feature.
- **Attach**: up to 8 files (images, text, PDF; 5 MiB each) by "+ attach" (⌘⇧A), paste or drop. A paste over 3,500
  bytes becomes `pasted-N.txt`. The lead finds them in `.fleetd/attachments/<W>/` of the project, kept out of git.
- **Mention**: `@` opens a menu of the project's files, orders and PRs; ↑ ↓ and Enter or Tab pick one.

An order is at most 4,000 bytes; attach the detail. It appears as a card at once. If the hub can't tell the project,
the card asks which one; if sending fails, it offers Retry and Edit. In an order, ⌘N opens a composer over it, so you
keep your place.

## Follow an order {#order}

Click a card (or select it and press Enter). The left side has its agents, PRs and done-when checks with their
results; the right side is the project lead's conversation, focused on this order: finished turns fold to one line
("Worked for 48s · ran 3 commands") and runs about other orders collapse.

The box under the conversation talks to the lead:

| Do | How | The lead |
|---|---|---|
| Add to the lead's queue | Enter | takes it in at its next step, after the tool it is running ([what that means](steering.md#next-step)) |
| Interrupt and redirect | ⌘Enter, or "Interrupt and redirect" | stops its current step and reads it at once |
| Stop | "Stop W…" (⌘⇧.), then confirm | its running agents are cancelled and its asks withdrawn; merged PRs stay |
| Reorder | "Reorder" on a stopped order | nothing yet: its text goes back into the composer, to send as a new order |

Each steer shows its receipt under it: queued, delivered, acknowledged or not acknowledged
([Receipts](steering.md#receipts)); a queued one has "withdraw". Click an agent's lane to steer that agent instead.
A stopped order isn't reopened. ⌘[ and ⌘] go to the previous and next order, Esc back to the board.

## Status {#status}

⌘. opens Status for what you're looking at: the open order, the selected project, or the whole fleet; ⌘. again goes
back. It's also in the sidebar above Board, in the palette ("Status", "Status for W41") and on an order's header. It
shows the progress fleetd verified, the ETA from measured speed, what the work waits on, what changed since you last
looked, then health, what needs you, risks, and the items in progress, next and done. What needs you has the inbox's
one-tap answers.

It updates as things happen, without a refresh. A part whose source has gone quiet gets a warning outline with
"stale 4m" and the reason, and keeps its last value. While the app is reconnecting the whole view greys out with
"Not live: reconnecting", and after it reconnects it shows empty bars until the fresh numbers arrive. What the number
means and how the ETA is measured: [Status](status.md).

## Inbox and replies {#reply}

⌘I opens the inbox panel; the badge in the title bar counts what needs you. In the panel, 1-9 select an item, Enter
takes its recommendation, `n` answers no, Esc closes. Or answer a whole batch in one line in its reply field:

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

Mix them: `1 go 2 nvm 3 b`. A reply the app can't read changes nothing and shows a hint.

Asks that block work also raise a desktop notification: at most one every 20 minutes, with the rest folded in as "+N
more", and only urgent ones in quiet hours (23:00 to 08:00 unless a `policy.quiet_hours` decision says otherwise).
Clicking it opens the ask.

## Settings

Settings (⌘,) has General (appearance, motion, the hub connection), Prompts and Instructions; the last two are in
[What agents are told](what-agents-are-told.md). Motion: System follows the OS's reduce-motion setting,
Reduced turns the brief card and lane transitions off, Full keeps them. Nothing in the app animates continuously.

## Where time went {#time}

The Time button in an order's header (also ⌘K `time`, and Time in the sidebar for a project, a machine or the fleet)
shows where the time went, in three tabs. Timeline draws each agent, PR, CI check and ask as a lane, with the
critical path underlined; hover a bar for the command, its duration and exit code, and click it to open the
transcript at that step. Breakdown adds up agent time by group, with the slowest commands and CI checks. Insights
lists the findings, each with "show spans" to see the bars behind it. The filter bar picks the range, project,
order, machine and role, and compares two periods. How to read it, and what is not exact:
[Where time went](time-inspector.md).

## Shortcuts

⌘ on macOS is Ctrl on Linux.

| Keys | Does |
|---|---|
| ⌘N | New order (over the order view when one is open) |
| ⌘L | Focus the composer |
| ⌘K | Command palette: projects, orders (by id too), asks and actions; always offers "New order: <what you typed>" |
| ⌘I | Inbox panel |
| ⌘0 | Board |
| ⌘1 to ⌘9 | Open the nth order in the sidebar |
| ⌘⇧G | Group the board by project or by status |
| ⌘[ / ⌘] | Previous / next order |
| ⌘. | Status for the open order, the selected project or the fleet |
| ⌘⇧. | Stop the open order (asks to confirm) |
| ⌘, | Settings |
| ⌘B | Toggle the sidebar |
| Enter | Send an order; in an order, add to the lead's queue |
| ⌘Enter | In an order, interrupt and redirect the lead now |
| Shift+Enter | New line |
| ⌘⇧P / ⌘⇧T / ⌘⇧A | In the composer: project picker / type picker / attach |
| ↑ ↓ (or j k) | Move the selection on the board, in a menu or the palette (also Ctrl+P / Ctrl+N in the palette) |
| Enter | Open the selected card, run the palette item, pick from a menu |
| Esc | Close a menu, the stop confirm or the inbox panel; from an order, back to the board |
| Tab / Shift+Tab | Next / previous control |
| ⌘Q | Quit |
| ⌃⌘F (macOS), F11 (Linux) | Full screen |
| ⌘H, ⌥⌘H, ⌘M (macOS) | Hide, hide others, minimize |

Typing with no field focused goes to the composer on screen. Text fields follow the usual editing keys of each
platform (word motion, undo and redo, select all).
