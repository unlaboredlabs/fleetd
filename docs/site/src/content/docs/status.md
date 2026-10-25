---
title: Status
description: Each project's state and its work in groups at a glance, in the app and in the terminal.
---

Status shows, for each project, what state it is in and where each piece of its work is.

## In the app {#app}

Status has one row per project:

| Column | Shows |
|---|---|
| State | `waiting on you`, `blocked`, `working` or `idle`. |
| Work | How many pieces of work are in each group: "1 waiting on you · 2 working · 1 landing · 9 done". |
| Agents | How many agents are running. |
| Last merged | When the latest pull request merged, with its day: "today 09:46", "yesterday 16:40", "Fri 15:12", "Oct 7". |

Under each row, its work is listed group by group, newest first. Click an item to open its agent, or its pull request,
in the panel beside the project's chat. Click a row to open that project's chat, or PRs at its end for the project's
pull requests. Rows needing you come first, then blocked, working and idle. An MCP client reads the same rows with
`status_get`. Open Status with ⌘. (Ctrl+. on Linux), or from the sidebar.

## The groups {#groups}

Each piece of work is in one group, from what fleetd saw happen, never from an agent's word:

| Group | Means |
|---|---|
| Waiting on you | Only you can move it: the lead's question in chat, a command to approve, a secret, or an agent's tool prompt. |
| In review | Its pull request waits for fleetd's reviewer, or is with it. |
| Working | An agent is queued or running on it. |
| Landing | The [merge train](/docs/merge-train) holds its pull request: review passed, rebasing, CI or merging. |
| Idle | Nothing runs or waits on it: its agent ended or is paused, or its pull request came back with nobody on it ("CI failed"). |
| Done | Merged in the last 7 days, or its agent finished in an order that closed. |

Idle and done work drops off after 7 days. Status never scores the work or shows a finish time.

## In the terminal {#cli}

`fleetd status` on the hub machine prints the same rows.

```console
$ fleetd status
Status at 14:02:07

billing: blocked: main CI is red on acme/billing
  1 idle · 3 done · 0 agents · merged Invoice export #96 Thu 16:40
  idle: fleetd/T19-retry (#204, CI failed)

storefront: working
  1 in review · 2 working · 1 landing · 9 done · 2 agents · merged Webhook outbox #208 13:12:00
  in review: Cart page keeps its scroll position (T44, #216)
  working: Currency export for invoices (T47)
  working: Receipts list pages by cursor (T46)
  landing: Search index warms on deploy (T41, #210)
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

