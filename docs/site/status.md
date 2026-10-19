---
title: Status
section: Using fleetd
order: 72
description: How far along an order, a project or the fleet is, what it waits on and what is slower than usual, never stale.
---

Status answers "how far along is this, and what is it waiting on?" for one order, one project or the whole fleet: a
progress number fleetd verified itself, what the work waits on, what is slower than usual, what changed since you
last looked, the fleet's health and the risks worth knowing. Every part says how fresh it is, and a part that isn't
live says so. It never shows a finish time: agents are bad at judging time, so fleetd shows state instead and keeps
them working as fast as they can.

Open it in the [desktop app](desktop-app.md#status) with ⌘. (Ctrl+. on Linux), or from a terminal on the hub machine:

```console
$ fleetd status storefront
storefront  70%  polish 2/5    as of 14:02:07 (live)
  [████████████▒▒░░░░░░] 61% verified + 9% in flight
  11 of 18 required items verified
  ↓ from 74% · +3 items: checkout redesign added (14:00)
  ↓ from 66% · CI failed on #212 (13:20)
  Switching payments to the new provider, waiting on the full test run. Nothing needs you.   [generated]
  waiting on: P12 full test run: review of #212 → CI on #212 → merge   holds up P14, P16
  since you last looked here 09:12  7 merged, 3 verified, 1 failed, +3 items
health  main CI acme/storefront green as of 14:01:50 · 2 of 2 machines online · claude 58% 5h 41% wk · 8 running, slots 8/40
risks   check `e2e (safari)` failed on 2 PRs today
        P12 full test run is slower than usual in review (2h10m so far)
doing   P12 full test run   T88   critical path   waiting on review of #212 → CI on #212 → merge   holds up P14, P16   SLOWER THAN USUAL
        P15 provider cutover   T90   waiting on CI on #214
next    P14 switch the default provider (after P12), P16 docs page
done    P9 webhook outbox   #208 merged by the train 13:12 · check 2 passed C7
```

`fleetd status W41` shows one order and `fleetd status` the fleet. An order you just sent has nothing to show until
its lead writes the brief: status says `W41 is a draft: waiting for the lead's brief`, and `--watch` waits for it.
`--watch` keeps it on screen and prints each new version as the hub sends it; there is no refresh interval, so
nothing changes unless something happened. Elsewhere, add `--hub <url> --key-file <path>`. See the [CLI reference](cli.md#status) for every option.

## What the number means

The number is **verified** work plus credit for work **in flight**, as a share of the **required** work, by size. The
bar shows the two apart: solid (█) is verified, shaded (▒) is in flight.

- An item is verified only when fleetd checked it: its PRs were merged by the merge train (a PR merged by hand doesn't
  count) and the order's done-when checks it lists passed in the latest claim. A lead saying it's done moves nothing.
- An open item earns partial credit for each stage fleetd itself observed (task started, PR open, review passed, CI
  green, merged), weighted by how much of an item's work each stage usually takes in this project.
- The number reaches 100% only when every required item is verified. When it falls, a `↓` line says why: work was
  added, a review blocked, CI failed, or a done item reopened. It never falls without one.
- While an order's lead is still planning and there are no items yet, status says so instead of sitting at 0%.

Items are **must** or **polish**. Polish shows beside the number ("polish 2/5") and never holds it back. Sizes are s,
m and l, worth 1, 3 and 8 points, so a large item moves the number more than a small one.

An order without a plan counts as one must item sized by its tier, done when the order is. It enters the figure with a
marker ("+1 item: W41 (no plan yet)") and leaves it once it gets a plan, is stopped, or a day after it finishes. The
view lists it as a risk after half an hour ("W41 has no plan"), since its number can only jump from 0 to 100.

## Plans and markers

A project's plan is milestones of items. The project lead keeps it with `fleetd plan` and links work to items with
`--item P12` when it spawns a task or enqueues a PR; you can run the same commands in the project's folder. A project's
number covers its open milestones; a finished milestone leaves it with a marker ("M1 native runner done (12 items)").

Scope can change, but never silently. For the first 10 minutes of a milestone the lead is still planning and items
come and go freely. After that, adding, dropping or resizing an item needs a reason (`--why`), and the view shows it
next to the number:

```text
72%  ↓ from 80% · +3 items: time inspector added (14:00)
```

Items the hub closes itself get a marker too: open items of an order that finished without linking them ("−2 items:
closed with W41, not separately verified"), or of an order that was stopped.

## What it waits on

"Waiting on" follows the critical path: the item in progress that the most unfinished work runs through, what it
still waits on in order (items it is `--after`, then its remaining stages such as review, CI, merge and done-when
checks), and the items it holds up. Review is left out when the PR's tier asks for none. Each row under `doing` shows
its own path, `critical path` on that one item. An older hub without per-item paths lists up to three blockers
instead.

A PR the merge train can't move is listed under risks with the train's error: a checkout outside the node's
`cmdRoots` (with the fix, see [Config & files](config-and-files.md#fleetd)), a blocked train worktree, or a merge
GitHub refused.

An item that has spent over 1.5 times the usual time in its current stage is marked `SLOWER THAN USUAL` on its row and
listed under risks, measured against how long that stage normally takes in this project.

Status never shows an ETA or a finish time. Durations it has measured, such as how long a CI run took or how long ago
a machine was last seen, are observations and do show; the [time inspector](time-inspector.md) breaks a run down
into them.

## Since you last looked

"Since you last looked" counts what happened in this scope since then: merged PRs, verified items, started orders,
failures, new asks and scope changes. The app moves your mark when you leave the view after reading it for a few
seconds. `fleetd status` keeps its own mark on each machine ("since you last looked here"), moved each time it prints
or when `--watch` ends; the two never move each other. Marks older than the hub's 30 days of events read "more than 30
days ago".

## Stale data

Status never shows old data as live. Each part depends on a source, and the hub flags a source stale when it goes
quiet for longer than its normal rhythm:

| source | normally | stale after | the view says |
|---|---|---|---|
| a machine | a heartbeat every 15 s | 45 s of silence, until it's back | "no heartbeat from devbox for 4m"; after it wakes, "devbox slept 10m46s" |
| Claude usage | each Claude reply | its reset time passes, or its machine is stale | "5h reading from 13:10, before the 14:00 reset" |
| GitHub | every train pass (15 s) and main CI (60 s) | 180 s without a good answer | "GitHub not reached for 4m: …" |
| main CI | read every 60 s | its period plus 180 s unread | "main CI of acme/storefront unread since 14:05" |
| a merge train | every 15 s | 120 s | "the acme/storefront train hasn't run for 3m" |

A stale part keeps its last value with the time it's from and a warning, and the generated headline starts with "Not
live: …" naming what's missing. In the terminal, the first line says "NOT LIVE: 1 stale source" and a `stale` line
gives each one's reason. Just after the hub restarts, every source reads "not checked since the hub started" until it
reports in, which takes seconds.

If the app or `fleetd status --watch` loses the hub, the view greys out with "Not live: reconnecting · data from
14:02:07" and fetches a fresh copy when it's back.

## GitHub sync

The hub keeps track of PRs and CI on its own: each merge train asks GitHub about its open PRs every 15 s and about the
main branch's CI every minute. Requests for things that didn't change are free under GitHub's rate limit, so this
stays far below it even with many open PRs.

You can also let GitHub tell the hub about changes the moment they happen. It needs a public URL that GitHub can reach
and that forwards to the hub; fleetd never creates one, so bring your own (a reverse proxy, or a tunnel you already
use). Then, on the hub machine:

```sh
fleetd hub github-webhook --url https://hooks.example.com/github
```

That adds a webhook to every repo the train merges into. Turn it off with `fleetd hub github-webhook --off`. With
webhooks on, the hub checks main CI every 5 minutes instead of every minute; if it notices a change that no webhook
announced, it goes back to every minute for half an hour and lists it under risks. A webhook only makes the hub look
sooner: a lost or forged delivery can't change what it records.

## The headline

The sentence under the number is written by Claude (haiku, through your `claude` login on the hub, no tools) from a
short list of facts fleetd computed: the number, what's in progress, what it waits on and the top risks. It never
mentions time. Every
number in it must appear in those facts, or it's thrown away. It's rewritten only for views someone has open, at most
once a minute per view and 300 times a day.

When the facts change and the new sentence isn't written yet, or Claude can't be reached, the view shows a plain
template instead and labels it `template` with the reason. A generated sentence is never shown for facts it wasn't
written from. Change how it's written with `fleetd prompts edit status.headline` (see
[What agents are told](what-agents-are-told.md)).

## Notification

The app can post one desktop notification at 09:00 and 18:00 with the fleet's number, its headline and what happened
since the previous one. Turn it on in Settings → Notifications; it's off by default and respects quiet hours.
Clicking it opens Status.
