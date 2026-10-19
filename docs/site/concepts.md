---
title: Concepts
section: Get started
order: 30
description: The hub, nodes, leads, orders, asks and the merge train, one short section each.
---

## Hub

One per fleet, on an always-on machine (`fleetd hub start`, run as a service by `fleetd init`). It holds everything
that lasts: projects, leads, briefs, tasks, asks and decisions, the merge train, checks and wakes. It serves the
desktop app and one MCP endpoint, `<hub url>/mcp`, over all your machines. Its data is one SQLite file in
`~/.fleetd/hub`.

## Nodes

One `fleetd node` per machine that runs agents (a worker). The node dials out to the hub, so no worker opens a port.
It runs one `claude` process per live session, each writer in its own git worktree and branch. Sessions use your own
claude setup in `~/.claude`: the same login, proxy settings and MCP servers as the `claude` in your shell. The hub
machine is usually a worker too.

## Leads

Each project has one lead: a long-running `claude` session that turns orders into briefs, splits them into tasks
for writer and reviewer sessions, and never writes code itself. Leads run on `claude-opus-5-5` by default. A
project's first order starts its lead.

## Orders

An order is one line of intent, such as `fix the typo in the README`, sent from the app or with `intake_submit`
over MCP. The hub picks the project (a leading `@project` names it), opens a workstream and wakes the lead. The lead
freezes a brief with done-when checks, then spawns tasks. A slot board caps how many sessions run at once.

## Asks and decisions

A lead asks you only about product calls, money, credentials and irreversible steps. Asks arrive numbered, in
batches, in the app's inbox; you answer tersely (`1 go 2 nvm 3 b`). Each answer becomes a decision in a searchable
log, and an ask that a past decision already answers comes back at once without bothering you. Some asks need more
than words: approving an exact command, ticking off steps, or entering a secret. See
[Approvals & secrets](approvals-and-secrets.md).

## Merge train

Only fleetd merges. Each writer's PR goes on its repo's train, one serial queue per repo. The train rebases each
ready change onto its base, waits for CI on that exact head and squash-merges it. A head with no CI (the base requires
no check but `fleetd/train`, and no workflow has started a run for it within 90 seconds) merges on fleetd's own checks,
and the merge says so. A change's tier sets its reviews:
S needs none, M one clean review, L two plus a verifier, each bound to the current patch. A PR body needs a
`Source:` line naming what it serves. You can freeze a repo's train with `train_freeze`.

## Done, checked

A lead can't just say "done". `fleetd claim done` makes the hub run the workstream's done-when checks itself
(a PR merged, CI green, a command or test on a machine, an HTTP check, a judge, a person), and only all of them
passing makes it done. Each claim keeps its evidence and exit codes.
