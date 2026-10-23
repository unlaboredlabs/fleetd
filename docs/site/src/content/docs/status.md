---
title: Status
description: Each project's state and progress at a glance, and the terminal's full view of what the work waits on.
---

Status shows, for each project, what state it is in and how far along its work is.

## In the app {#app}

Status has one row per project:

| Column | Shows |
|---|---|
| State | `waiting on you`, `blocked`, `working` or `idle`. |
| Progress | The two-tone bar: solid is verified work, lighter is credit for work in flight. "no progress yet" while the lead plans or nothing can be counted. |
| Agents | How many agents are running. |
| Last merged | When the latest pull request merged, with its day: "today 09:46", "yesterday 16:40", "Fri 15:12", "Oct 7". |

Rows needing you come first, then blocked, working and idle. Click a row to open that project's chat, or PRs at its
end for the project's pull requests. Hover it for detail: why it is blocked, the verified and in-flight shares, the
latest drops, and a source that has gone quiet ("out of date").
An MCP client reads the same rows with `status_projects`.
Open Status with ⌘. (Ctrl+. on Linux), or from the sidebar.

Status never shows a finish time or an ETA. It shows state instead.

## In the terminal {#cli}

`fleetd status` on the hub machine gives the full view: progress, why it fell, what the work waits on, health and
risks.

```console
$ fleetd status storefront
storefront  70%  polish 2/5    as of 14:02:07 (live)
  [████████████▒▒░░░░░░] 61% verified + 9% in flight
  11 of 18 required items verified
  ↓ from 74% · +3 items: checkout redesign added (14:00)
  ↓ from 66% · CI failed on #212 (13:20)
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

| Command | Shows |
|---|---|
| `fleetd status` | The whole fleet. |
| `fleetd status storefront` | One project. |
| `fleetd status W41` | One piece of the lead's work (a [workstream](/docs/glossary#workstream)). A new one says `W41 is a draft: waiting for the lead's brief` until the lead has planned it; `--watch` waits for it. |

| Option | Does |
|---|---|
| `--watch` | Keep it on screen and print each new version as the hub sends it. |
| `--json` | Print JSON. |
| `--hub <url> --key-file <path>` | Use a hub on another machine. |

See the [CLI reference](/docs/reference/cli#status). The rest of this page explains that view.

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
  merged. Time spent inside a stage adds a little more, but only while an agent or the merge train is working on it.
- **It reaches 100%** only when every required item is verified.
- **When it falls**, a `↓` line says why: work added, a review blocked, CI failed, a done item reopened, or work
  stopped because an agent finished, failed or was cancelled with nothing else running for its item.

Items are **must** or **polish**. Polish shows beside the number ("polish 2/5") and never holds it back.

| Size | Points |
|---|---|
| `s` | 1 |
| `m` | 3 |
| `l` | 8 |

While a lead is still planning, status says so instead of showing 0%. Work with no plan counts as one item until
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
| the brief | The lead to plan the work (its [brief](/docs/glossary#brief)). |
| a writer | A [writer](/docs/glossary#writer) task to start. |
| the writer's push | The writer to push its branch. |
| a PR | The pull request to open. |
| review of #212 | Reviews of that PR. Left out when its tier needs none, as for an `S` change. |
| CI on #212 | CI on the PR's current commit. |
| merge | The merge train to rebase, check and merge it. |
| done-when checks | The hub to run the work's [done-when checks](/docs/glossary#done-when-check). |

If the merge train can't move a PR, risks list it with the train's error. For a checkout outside the node's `cmdRoots`
that includes the fix. If it doesn't move, see [Work is stuck](/docs/troubleshooting#stuck).

An item that has spent over 1.5 times the usual time in its current stage is marked `SLOWER THAN USUAL` and listed
under risks. "Usual" is measured from this project's own history.

`--json` also shows how much of the slot cap was held over the last hour (`health.slots.utilization`), as measured.
When work waited while slots sat free, [Where time went](/docs/time-inspector#serial-waits) names it and the fix.

## Since you last looked {#since}

Counts what happened in this scope since you last looked: merged PRs, verified items, started work, failures and
scope changes.

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
