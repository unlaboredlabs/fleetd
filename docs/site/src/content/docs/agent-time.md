---
title: Agent time
description: See where your agents' time went and what slowed the work down.
---

Agent time shows what a piece of work spent its time on, so you can see what made it slow: a test suite run too often, a slow CI check, or a question that waited on you.

## Open it {#open}

- **In the app:** click the Factory icon at the foot of the sidebar (⌘;), then **Agent time**. Or pick **Agent time** in the command palette (⌘K).
- **In the terminal:** run `fleetd time` for everything, or add a bot's name.

Pick "All work" for totals, or one piece of work by its title.

```console
$ fleetd time storefront --since 30d
```

`--since` takes a span like `24h` or `30d`, or a date. The default is 7 days.

## The time groups {#groups}

Time falls into seven groups:

| Group | Is |
|---|---|
| model | Claude thinking and writing |
| tools | Commands, edits, searches, web |
| machine | Starting up, retries, compaction |
| queue | Waiting for a free slot or a usage limit |
| you | Waiting on your reply or approval |
| pipeline | CI, review and the merge train |
| idle | Open but doing nothing (not counted) |

## Read it {#critical-path}

- **Wall time** is the clock, from start to done.
- **Agent time** adds up every agent. Three agents working an hour at once make three hours.
- **Critical path** is the one chain of steps that decided when the work finished.

To finish work sooner, shorten what's on the critical path. Speeding up anything else changes nothing, because it ran alongside.

## Findings {#findings}

Agent time points out commands worth fixing:

- The whole test suite ran 5 or more times. Ask for targeted tests.
- One command ran 3 or more times in a row with nothing changed between runs.
- The slowest commands overall.

## Good to know {#details}

- Every number is measured, never estimated. Where data is missing, the view says "incomplete" rather than guess.
- Detailed timelines are kept 30 days; daily totals 400 days.
