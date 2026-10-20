---
title: Where time went
description: See what your agents spent their time on and what they waited for, and find what slows work down.
---

You'll find what made a piece of work slow: the test suite an agent ran many times, the CI check that finished last,
or the question that waited on your reply.

```console
$ fleetd time W41
W41 Add three short pages  done
wall 1h42m  critical path 1h42m  agent time 3h25m  parallelism 2.0x  coverage complete

critical path  1h42m
  you            34m  33%  deploy.region 34m
  ci             22m  22%  rust (macos) 14m, rust (linux) 8m
  model          18m  18%
  tools          15m  15%  cargo test --workspace 9m, src/pages.rs 6m
  review          9m   9%
  queue           4m   4%

agent time  3h25m
  model     1h11m  35%  output 37m  thinking 22m  first token 12m
  tools       52m  25%  Bash 41m (212)  Read 6m  Edit 3m  MCP 2m
  you         34m  17%
  pipeline    31m  15%  CI 22m  review 9m
  queue        9m   4%
  machine      8m   4%  retries 5m  startup 3m

slowest commands           n  total  median  failed
  cargo test --workspace  22    51m   2m10s  3
  npm run build           14    19m   1m20s  0

findings
  1. agents ran the full test suite `cargo test --workspace` 22× (51 min); 14 runs followed no edit
     fleetd time W41 --spans full_suite_repeat
  2. CI check `rust (macos)` adds 6 min on the critical path of this order
     fleetd time W41 --spans ci_check_critical
```

These are measured durations of work that already happened, not estimates. fleetd records them from the `claude`
stream on each machine and the hub's own events, with no extra model calls.

## Open it

| Where | How |
|---|---|
| Desktop app | Time in the sidebar, or expand the agents strip in a chat. See [The desktop app](/docs/desktop-app#time). |
| Terminal, one piece of work | `fleetd time W41`, with its [workstream](/docs/glossary#workstream) id |
| Terminal, one project | `fleetd time storefront` |
| Terminal, the whole fleet | `fleetd time` |

| Option | Does |
|---|---|
| `--since <range>` | How far back: `24h`, `30d`, or a date. Default: 7 days. |
| `--spans <rule>` | List the spans behind a finding. Each finding prints its own command. |
| `--json` | Print JSON. |

See the [CLI reference](/docs/reference/cli#time).

## The groups {#groups}

Time falls into seven groups, with the same names and colors everywhere:

| Group | Is |
|---|---|
| model | Claude writing: the wait for its first token, thinking, and output. |
| tools | Tool calls: Bash commands, reads, edits, web, MCP, and fleetd's "done" checks. |
| machine | Starting `claude`, API retries, compaction, and `claude`'s own work between steps. |
| queue | Waiting for fleetd: a free slot, an area lease, a usage limit, an offline machine, a lead's wake. |
| you | Waiting on you: your reply, a secret, an approval. |
| pipeline | CI, review and the merge train. |
| idle | A session alive with nothing to do. Never counted against the work. |

## Wall time and agent time {#wall-vs-agent}

| Number | Means |
|---|---|
| **Wall time** | The clock: from when the work started to when it was done. |
| **Agent time** | Every agent's time added up. Three writers working for an hour at once are three hours of agent time. |
| **Parallelism** | Agent time divided by wall time. |

"Slowest commands" counts each call from start to finish. When an agent runs tools in parallel, their totals can add up
to more than its tool time.

## Read the critical path {#critical-path}

The [critical path](/docs/glossary#critical-path) is the one chain of work that decided when the work finished. Its rows add up to the wall time.

**To make work finish sooner, shorten what is on the path.** Work off the path ran in parallel, so speeding it up changes
nothing.

In the example above:

- The 34 minutes waiting for your answer about `deploy.region` are on the path. Replying sooner would have finished
  it sooner.
- `cargo test --workspace` took 51 minutes in total, but only 9 of them held the work up.

"Nothing running" on the path points at missing data, not idle time. The coverage line says so.

## Waits behind free capacity {#serial-waits}

Some findings point at work that waited while the fleet had room for more. Each one ends with what to change:

| Finding | Means | Fix |
|---|---|---|
| `queue_wait` | A task waited for a slot while the fleet had free ones (its project's max agents, or the slots kept for lead turns). Or a ready PR waited out a CI run it couldn't join, because the [batch](/docs/merge-train#batches) was full or batching was off. | Raise the project's max agents or the fleet cap (`fleetd project set`). Raise `FLEETD_TRAIN_BATCH_MAX`, or fix why batching turned off for the repo. |
| `contention` | Tasks waited one after another for one area lease, or for one machine's claude usage. | Define narrower areas in `.fleetd/policy.yaml` (without them, every write task takes the one area `all`). For usage: a larger plan, or another machine. |
| `idle_lead` | A [lead](/docs/glossary#lead) sat idle while one of its plan items was ready to start and slots were free. | The lead should start ready items before its turn ends. |
| `slots_underused` | Two or more ready plan items waited at the same time while slots were free. | Start ready items together. |

A plan item counts as ready while its work runs (not stopped, failed, idle or being verified) and every item it comes
after is done, until its lead starts a task for it. A question to you that blocks the work pauses it. None of these count:

- time with no free slot;
- time when the machine is parked on its usage limit or offline;
- short gaps while fleetd wakes a lead.

A finding appears once its wait adds up to 5 minutes in the range.

## What is not exact {#limits}

Where a number is a bound rather than a measurement, the views say so.

| Number | Limit |
|---|---|
| First token wait | Mixes `claude`'s preparation, the network, the provider's queue and reading the prompt. |
| Thinking vs output | Split as they stream in. The answer's total time is exact. |
| Tool start | `claude` doesn't report it; fleetd uses when the tool call arrived. With parallel tools, each one's time is an upper bound. |
| Background commands | Not seen after the tool call returns. |
| Exit codes | Exact for failed Bash commands. Other tools show only ok or failed. |
| Across machines | Each machine's clock is aligned to the hub's. Lanes from two machines can be off by the network delay. |
| CI queueing | Shown only when fleetd knows when the commit was pushed. |
| The [lead](/docs/glossary#lead)'s time | Split equally between the pieces of work its wake was about, marked "split". |
| Waiting on you | From when the lead asked in the chat to your reply. |

The coverage line says "incomplete" when data is missing, for example from a machine running an older fleetd, or from
before the retention window. It never fills a gap with a guess.

## How long it is kept {#retention}

| Data | Kept |
|---|---|
| Every span | 30 days by default (1 to 365). |
| Daily totals and each piece of work's critical path | 400 days. |

Change it with an admin key:

```sh
fleetd time --retention 90
```

Or in the app: Settings → General → Time data, which also shows how much space it takes.
