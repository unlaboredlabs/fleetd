---
title: Status
description: How far along an order, a project or the fleet is, what it waits on, and what is slower than usual.
---

Status shows how far along an [order](/docs/glossary#order), a project or the whole fleet is, and what the work is
waiting on.

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

Status never shows a finish time or an ETA. It shows state instead: what is verified, what is in flight, and what
blocks the rest.

## Open it

| Where | How |
|---|---|
| Desktop app | ⌘. (Ctrl+. on Linux). See [The desktop app](/docs/desktop-app#status). |
| Terminal, the whole fleet | `fleetd status` |
| Terminal, one project | `fleetd status storefront` |
| Terminal, one order | `fleetd status W41`. A new order shows "Nothing to show" (exit 3) until its lead has written the brief. |

| Option | Does |
|---|---|
| `--watch` | Keep it on screen and print each new version as the hub sends it. |
| `--json` | Print JSON. |
| `--hub <url> --key-file <path>` | Use a hub on another machine. |

See the [CLI reference](/docs/reference/cli#status).

## What the number means {#number}

The number is **verified** work plus credit for work **in flight**, as a share of the **required** work.

| In the bar | Means |
|---|---|
| █ solid | Verified: fleetd checked it. |
| ▒ shaded | In flight: partial credit for stages fleetd saw happen. |
| ░ empty | Not started. |

- **Verified** means the item's PRs were merged by the merge train, and its done-when checks passed. A PR merged by
  hand doesn't count. A lead saying "done" moves nothing.
- **In flight** credit comes from stages fleetd observed itself: task started, PR open, review passed, CI green,
  merged.
- **It reaches 100%** only when every required item is verified.
- **When it falls**, a `↓` line says why: work added, a review blocked, CI failed, or a done item reopened.

Items are **must** or **polish**. Polish shows beside the number ("polish 2/5") and never holds it back.

| Size | Points |
|---|---|
| `s` | 1 |
| `m` | 3 |
| `l` | 8 |

While a lead is still planning, status says so instead of showing 0%. An order with no plan counts as one item until
it gets one, and is listed as a risk if it stays without a plan.

## Plans and markers {#plans}

A project's plan is milestones of [plan items](/docs/glossary#plan-item). The lead keeps it with `fleetd plan` and
links work to items with `--item P12`.

Scope can change, but never silently. After a milestone's first 10 minutes, adding, dropping or resizing an item needs
a reason (`--why`), and status shows it next to the number:

```text
72%  ↓ from 80% · +3 items: time inspector added (14:00)
```

Items the hub closes itself also get a marker, such as "−2 items: closed with W41, not separately verified".

## What it waits on {#waits}

"Waiting on" follows the [critical path](/docs/glossary#critical-path):

1. The item in progress that the most unfinished work runs through.
2. What it still waits on, in order: earlier items, then review, CI, merge and done-when checks.
3. The items it holds up.

The stages, in pipeline order. "Waiting on" lists the ones left after the item's current stage:

| Step | Waits for |
|---|---|
| the brief | The lead to write the order's [brief](/docs/glossary#brief). |
| a writer | A [writer](/docs/glossary#writer) task to start. |
| the writer's push | The writer to push its branch. |
| a PR | The pull request to open. |
| review of #212 | Reviews of that PR, as its tier needs. |
| CI on #212 | CI on the PR's current commit. |
| merge | The merge train to rebase, check and merge it. |
| done-when checks | The hub to run the order's [done-when checks](/docs/glossary#done-when-check). |

"Waiting on" lists every stage left, even one this item skips, such as review for an `S` change. If it doesn't move,
see [An order is stuck](/docs/troubleshooting#stuck).

An item that has spent over 1.5 times the usual time in its current stage is marked `SLOWER THAN USUAL` and listed
under risks. "Usual" is measured from this project's own history.

## Since you last looked {#since}

Counts what happened in this scope since you last looked: merged PRs, verified items, started orders, failures, new
asks and scope changes.

- The app moves your mark when you leave the view after reading it.
- `fleetd status` keeps its own mark on each machine.
- The two marks never move each other.

## Stale data {#stale-data}

Status never shows old data as live. Each source has a normal rhythm, and the hub flags it stale when it goes quiet:

| Source | Normally | Stale after | Status says |
|---|---|---|---|
| A machine | a heartbeat every 15 s | 45 s of silence | "no heartbeat from devbox for 4m" |
| Claude usage | each Claude reply | its reset time passes | "5h reading from 13:10, before the 14:00 reset" |
| GitHub | every train pass (15 s) | 180 s without a good answer | "GitHub not reached for 4m: …" |
| Main CI | read every 60 s | its period plus 180 s | "main CI of acme/storefront unread since 14:05" |
| A merge train | every 15 s | 120 s | "the acme/storefront train hasn't run for 3m" |

A stale part keeps its last value, with its time and a warning. In the terminal, the first line says "NOT LIVE: 1 stale
source". If the app loses the hub, the view greys out with "Not live: reconnecting".

To tune when GitHub data counts as stale, see [Hub environment](/docs/config-and-files#env).

## Faster GitHub updates {#github}

The hub follows GitHub by itself: each train asks about its open PRs every 15 s, and about main's CI every minute.

To have GitHub tell the hub about changes as they happen:

1. Set up a public URL that GitHub can reach and that forwards to the hub, such as a reverse proxy. fleetd never
   creates one.
2. On the hub, turn on webhooks:

   ```sh
   fleetd hub github-webhook --url https://hooks.example.com/github
   ```

This adds a webhook to every repo the train merges into. Turn it off with `fleetd hub github-webhook --off`. A webhook
only makes the hub look sooner; a lost or forged delivery can't change what it records.

## The headline {#headline}

The sentence under the number is written by Claude (haiku, through your `claude` login on the hub, no tools) from
facts fleetd computed.

- It never mentions time.
- Every number in it must appear in those facts, or it is thrown away.
- When it can't be written, a plain template is shown instead, labelled `template`.

Change how it's written with `fleetd prompts edit status.headline`. See
[What agents are told](/docs/what-agents-are-told).

## Daily notification {#notification}

The app can post a desktop notification at 09:00 and 18:00 with the fleet's number, its headline and what happened
since the last one. Turn it on in Settings → General → Status digest. It is off by default and respects quiet hours.
