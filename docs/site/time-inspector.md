---
title: Where time went
section: Using fleetd
order: 75
description: See what your agents spent their time on and what they waited for, and find what slows orders down.
---

fleetd records where every agent's time goes: model time, each tool call, and every wait (for a slot, for CI, for
the train, for you). It keeps this for each order, project, machine and the whole fleet. Use it to find what makes
orders slow: the test suite an agent ran eight times, the CI check that finishes last, the ask that waited an hour on
your answer.

The numbers come from what fleetd already sees: the `claude` stream on each machine and the hub's own events. It
makes no extra model calls and does not poll for them, so recording costs next to nothing.

Open it in the [desktop app](desktop-app.md#time), or from a terminal on the hub machine:

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

`fleetd time storefront` shows a project and `fleetd time` the whole fleet, over the last 7 days unless you pass
`--since` (`24h`, `30d`, or a date). Each finding ends with the command that lists the spans behind it. See the
[CLI reference](cli.md#time) for every option.

## What it measures

Time falls into seven groups, the same colors and words everywhere:

| group | is |
|---|---|
| model | claude writing: the wait for its first token, thinking, and output |
| tools | tool calls: Bash commands, reads, edits, web, MCP, and the checks fleetd runs for "done" |
| machine | the machine or provider: starting `claude`, API retries, compaction, `claude`'s own work between steps |
| queue | waiting for fleetd: a free slot, an area lease, a usage limit, an offline machine, a lead's wake |
| you | waiting on you: blocking asks, approvals, asks held in a batch before you saw them |
| pipeline | CI, review and the merge train: in line, rebasing, each CI check, merging |
| idle | a session alive with nothing to do; never counted against an order |

Two numbers come back everywhere, and they mean different things:

- **Wall time** is the clock: an order runs from when you sent it to when it was done.
- **Agent time** adds up every agent's time. Three writers working for an hour at once are three hours of agent time
  in one hour of wall time; **parallelism** is the ratio. Within one agent, one PR or one task, each moment
  counts once, so its parts add up to its total. Asks are the exception: two asks open at the same time both count
  as waiting on you.

"Slowest commands" counts each call on its own, from start to finish. When an agent runs several tools at once,
those calls overlap, so their totals can add up to more than the agent's tool time.

## Reading the critical path {#critical-path}

The critical path is the one chain of work that decided when the order finished. Start from the end of the order
and walk back: at each moment, take whatever finished last, then whatever that was waiting on, back to the start.
Its rows add up to the order's wall time exactly.

To make an order faster, shorten what is on the path. Work off the path ran in parallel with it, so speeding it up
changes nothing. In the example above, the 34 minutes the order waited for your answer about `deploy.region` are on the path:
answering sooner would have finished the order sooner. Most of the 51 minutes of `cargo test --workspace` are off
it, because other work ran at the same time; only 9 of them held the order up.

Two waits that happen at once, such as two writers each queued for a slot, count once on the path and twice in
agent time. When nothing was running at some moment of the path, it shows as "nothing running" and the coverage
line says so; that points at missing data, not at idle time.

## Waits behind free capacity {#serial-waits}

Some findings point at work that ran one thing after another while the fleet had room for more. Each ends with
what to change:

| finding | means | fix |
|---|---|---|
| `queue_wait` | a task waited for a slot although the fleet had free ones (its project's share, or the slots kept for lead turns), or a PR waited in the train's line while other PRs' CI ran | raise the share or the cap with `cap_set`; batch PRs that touch different files |
| `contention` | tasks waited one after another for one area lease, or for one machine's claude usage | define narrower areas in `.fleetd/policy.yaml` (without one, every write task takes the single area `all`); a larger plan or another machine |
| `idle_lead` | a lead sat idle while a plan item of its running order was ready to start and slots were free | the lead should start ready items before its turn ends |
| `slots_underused` | two or more ready plan items waited at the same time while slots were free | start ready items together |

A plan item counts as ready once its order runs and every item it comes after is done, until its lead spawns a task for
it; an ask that blocks the order pauses it. Short gaps while fleetd wakes a lead don't count. A finding appears once
its wait adds up to 5 minutes in the range.

## What is not exact {#limits}

fleetd shows only what it can see. Where a number is a bound or a rule rather than a measurement, the views say so:

- **The wait for the first token** mixes `claude`'s own preparation, the network, the provider's queue and reading
  the prompt. They can't be told apart. `claude`'s own total of API time per run is shown beside it as a check.
- **Thinking and output** inside one answer are split as they stream in; a summarized thinking block can arrive in
  bursts. The answer's total time and its thinking tokens are exact.
- **When a tool starts.** `claude` doesn't report it; fleetd uses the moment the tool call arrived, which in tests
  was within about 10 ms. With several tools at once, each one's time is an upper bound; the group's time is exact.
- **Background commands** (`run_in_background`) and anything still running after its tool call returns are not
  seen. The span ends when the call returns.
- **Exit codes** are exact for failed Bash commands. A successful one shows 0. Other tools show only ok or failed.
- **Lining up machines.** Each machine's spans use its own clock, moved onto the hub's. Durations on one machine are
  exact; where lanes from two machines meet, they can be off by the network delay (milliseconds on a LAN, tens of
  milliseconds over a tailnet). GitHub's times are whole seconds.
- **CI queueing on GitHub** shows only when fleetd knows when the commit was pushed (the train pushed it, or an
  agent did with `git push`).
- **The lead's time** serves every order its wake was about. It is split equally between them, and the views say
  "split".
- **Waiting on you** runs from when the ask reached your inbox to your answer. When you actually saw it is not
  knowable.

The coverage line says whether the timeline is complete. It says "incomplete" when a machine runs an older fleetd
that doesn't send timings, when a machine was away so long that it dropped old timings, or when the hub was too busy
to keep some, when the range is so busy that only its newest part could be read, and when the range reaches back past
the details the hub still keeps (see below). It never fills a gap with a guess.

## How long it is kept {#retention}

The hub keeps every span for 30 days by default, and daily totals and each finished order's critical path for 400
days. A range that reaches back further than the spans still shows how agent time split across the groups for those
days, from the daily totals; the commands, CI checks and findings cover only the days that still have spans, and the
coverage line says from when. Change it with an admin key, from 1 to 365
days:

```sh
fleetd time --retention 90
```

or in the app's Settings, under Data, which also shows how much space it takes. A busy fleet uses a few MB a day.
