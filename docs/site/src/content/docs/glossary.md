---
title: Glossary
description: Every fleetd term in one or two sentences, with a link to where it is used.
---

Every fleetd term, A to Z. Each one links to the page that uses it most.

## Agent key {#agent-key}

A key that lets an MCP client or script call the hub, with a role (`read`, `operate` or `admin`). It starts with
`fld_` and is shown once. See [MCP clients](/docs/mcp-clients).

## Area {#area}

A named set of paths in a project, such as `docs: ["docs/**"]`. A writer task may only touch the areas it leases.
Set them in the [policy file](/docs/config-and-files#policy).

## Brief {#brief}

The plan a lead writes for an order before any work starts: what to build, and the done-when checks that prove it.

## Claim {#claim}

A lead saying an order is done (the `claim_done` tool). The hub then runs the done-when checks itself.

## Critical path {#critical-path}

The chain of work that decides when an order finishes. Shortening it makes the order finish sooner. See
[Where time went](/docs/time-inspector#critical-path).

## Decision {#decision}

Your answer to a lead's question in chat, which the lead logs in a searchable log so it never asks it again.

## Done-when check {#done-when-check}

A check in a brief that proves the order is finished: a PR merged, CI green, a command on a machine, an HTTP check,
a judge, or a person.

## Gated command {#gated-command}

A command a lead wants to run that is irreversible, costs money or uses a credential. It runs only after you approve
it. See [Approvals & secrets](/docs/approvals-and-secrets).

## Human key {#human-key}

A key that belongs to a person's device, such as the desktop app. Only a human key can approve commands, enter
secrets or steer.

## Hub {#hub}

The coordinator of a fleet. It runs on one always-on machine and stores all state. See [Concepts](/docs/concepts).

## Lead {#lead}

The long-running Claude session that plans a project's orders and runs its tasks. Each project has one. It never
writes code.

## Merge train {#merge-train}

The queue that merges a repo's pull requests after CI passes on the exact commit, in batches when they touch
different files. Only the train merges. See [Merge train](/docs/merge-train).

## Node {#node}

The fleetd process on a worker. It connects out to the hub and starts the Claude sessions.

## Order {#order}

One line that says what you want done, such as `fix the typo in the README`. Inside fleetd it is a workstream.

## Pairing code {#pairing-code}

A one-time code, such as `K4QW-7RNP`, that connects the desktop app or a new worker to the hub. It lasts 15 minutes.

## Plan item {#plan-item}

One piece of a project's plan, such as `P12`, sized `s`, `m` or `l`. [Status](/docs/status) counts progress in plan
items.

## Playbook {#playbook}

The instructions for a kind of order: a feature, a fix (`fix:`), research (`research:`) or finishing open work
(`finish:`).

## Policy file {#policy-file}

`.fleetd/policy.yaml` in a project's repo. It sets areas, tool rules and lead options. See
[Config & files](/docs/config-and-files#policy).

## Project {#project}

A git repo on a worker that fleetd works on. See [Projects & orders](/docs/projects-and-orders).

## Receipt {#receipt}

The status of a steer: queued, delivered, acknowledged, not acknowledged, withdrawn or failed. See
[Steering](/docs/steering#receipts).

## Reviewer {#reviewer}

A Claude session that reviews a pull request. Reviewers don't read the PR description; they judge the change.

## Session {#session}

One `claude` process doing one job, such as a lead, a writer or a reviewer.

## Slot {#slot}

Room for one running session. The hub caps how many sessions run at once.

## Steer {#steer}

A short message to an agent that is already working, such as "skip the docs page". See [Steering](/docs/steering).

## Task {#task}

One job a lead hands to a session: write code, review a PR, or research. Task ids look like `T88`.

## Tier {#tier}

The size of a change, `S`, `M` or `L`. It sets how many reviews a pull request needs. See
[Concepts](/docs/concepts#merge-train).

## Verifier {#verifier}

A session that checks that a large (`L`) change works, in addition to its two reviews.

## Wake {#wake}

A message that restarts a lead's work: a new order, a task result, an answer from you.

## Worker {#worker}

A machine that runs agents: any machine with a node. See [Machines](/docs/machines).

## Workstream {#workstream}

fleetd's record of an order, with an id such as `W41`.

## Writer {#writer}

A Claude session that changes code. Each writer gets its own git worktree and branch, and opens a pull request.
