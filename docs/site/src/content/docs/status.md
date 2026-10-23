---
title: Status
description: Each project's state and progress at a glance, in the app and in the terminal.
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
end for the project's pull requests. Hover it for detail: why it is blocked, the verified and in-flight shares, whether
it holds on paused work, the latest drops, and a source that has gone quiet ("out of date"). An MCP client reads the
same rows with `status_projects`, and one project's row with the history behind its bar with `status_get`.
Open Status with ⌘. (Ctrl+. on Linux), or from the sidebar.

Status never shows a finish time or an ETA. It shows state instead.

## In the terminal {#cli}

`fleetd status` on the hub machine prints the same rows, with why each bar last fell.

```console
$ fleetd status
Status at 14:02:07

billing: blocked: main CI is red on acme/billing
  [████████████████░░░░] 80% done, 80% verified · 0 agents · merged Invoice export #96 Thu 16:40

storefront: working
  [████████▒▒▒▒░░░░░░░░] 61% done, 40% verified · 2 agents · merged Webhook outbox #208 13:12:00
  ↓ 69% → 61% 14:00:00: +3 items: checkout redesign added
  ↓ 66% → 58% 13:20:00: CI failed on #212
```

| Command | Shows |
|---|---|
| `fleetd status` | Every project. |
| `fleetd status storefront` | One project, by id or title. |

| Option | Does |
|---|---|
| `--watch` | Keep it on screen and print the rows again after each change. |
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

- **Verified** means the item's PRs were merged by the merge train. A PR merged by hand doesn't count. A lead saying
  "done" moves nothing.
- **In flight** credit comes from stages fleetd observed itself: PR open (half the item), review passed, CI green,
  merged. Time spent inside a stage adds a little more, but only while an agent or the merge train is working on it,
  and never the next stage's credit. While an agent waits for an answer or for a usage limit to reset, the number holds
  what it earned, with a "held" line, and goes on from there when the agent resumes.
- **It reaches 100%** only when every required item is verified.
- **When it falls**, a `↓` line says why: work added, a review blocked, CI failed, a done item reopened, or work
  stopped because an agent finished, failed or was cancelled with nothing else running for its item.

Items are **must** or **polish**. Polish counts only when a project has no must items.

| Size | Points |
|---|---|
| `s` | 1 |
| `m` | 3 |
| `l` | 8 |

Work with no plan counts as one item until it gets one.

## Plans and markers {#plans}

A project's plan is milestones of [plan items](/docs/glossary#plan-item). The lead keeps it with `fleetd plan` and
links work to items with `--item P12`.

Scope can change, but never silently. After a milestone's first 10 minutes, adding, dropping or resizing an item needs
a reason (`--why`), and when the bar falls for it, the drop says so:

```text
  ↓ 80% → 72% 14:00:00: +3 items: time inspector added
```

Items the hub closes itself also get a marker, such as "−2 items: closed with W41, not separately verified".

## Stale data {#stale-data}

Status never shows old data as live. Each source has a normal rhythm, and the hub flags it stale when it goes quiet:

| Source | Normally | Stale after | Status says |
|---|---|---|---|
| A machine | a heartbeat every 15 s | 45 s of silence | "no heartbeat from devbox since 13:58" |
| GitHub | every train pass (15 s) | 180 s without a good answer | "GitHub not reached for 4m: …" |
| A merge train | every 15 s | 120 s | "the acme/storefront train hasn't run for 3m" |

A stale row keeps its last values and says `stale` with why and since when; in the terminal it prints a `STALE` line.
If the app loses the hub, the view greys out with "Not live: reconnecting"; `fleetd status --watch` prints "NOT LIVE:
reconnecting to the hub" over the last rows.

## How the hub follows GitHub {#github}

The hub reads GitHub itself: each train asks about its open PRs every 15 s, and about main's CI every minute.

