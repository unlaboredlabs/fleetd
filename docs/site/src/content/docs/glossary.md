---
title: Glossary
description: Every fleetd term in one or two sentences, with a link to where it is used.
---

Every fleetd term, A to Z. Each one links to the page that uses it most.

## Agent key {#agent-key}

A key that lets an MCP client or script call the hub, with a role (`read`, `operate` or `admin`). It starts with
`fld_` and is shown once, or written to a file only you can read. What it writes in a chat shows as that agent's,
never yours. See [MCP clients](/docs/mcp-clients).

## Agents strip {#agents-strip}

The compact line under the lead's message in a chat: how many agents are working, one line each. It expands to their
lanes and time.

## Approval {#approval}

An item in the chat that shows a [gated command](#gated-command) with Approve and Deny. See
[Secrets & approvals](/docs/approvals-and-secrets#approve).

## Brief {#brief}

The plan a lead writes for a piece of work before it starts: what to build, and the done-when checks that prove it.

## Chat {#chat}

The one ongoing conversation with a project's lead. You give work and answer the lead there. See
[Chat with the lead](/docs/chat).

## Claim {#claim}

A lead saying the work is done (the `claim_done` tool). The hub then runs the done-when checks itself.

## Critical path {#critical-path}

The chain of work that decides when a piece of work finishes. Shortening it makes it finish sooner. See
[Where time went](/docs/time-inspector#critical-path).

## Decision {#decision}

Your answer to a lead's question, logged by the lead with `decide` in a searchable log. A later question that a
decision already answers is never asked again.

## Done-when check {#done-when-check}

A check in a brief that proves the work is finished: a PR merged, CI green, a command on a machine, an HTTP check, a
judge, or you, asked in one line in the chat.

## Gated command {#gated-command}

A command a lead wants to run that is irreversible, costs money or uses a credential. It runs only after you approve
it in the chat. See [Secrets & approvals](/docs/approvals-and-secrets).

## Hub {#hub}

The coordinator of a fleet. It runs on one always-on machine and stores all state. See [Concepts](/docs/concepts).

## Human key {#human-key}

A key that belongs to a person's device, such as the desktop app. Only a human key writes to a lead as you, approves
commands, enters secrets or steers: what it sends counts as yours.

## Lead {#lead}

The long-running Claude session that plans a project's work and runs its agents. Each project has one, and one chat
with you. It never writes code.

## Max agents {#max-agents}

The cap on how many agents run at once, per project and across the fleet. Agents over it queue. See
[Max agents](/docs/projects#max-agents).

## Merge train {#merge-train}

The queue that merges a repo's pull requests after CI passes on the exact commit, in batches when they touch
different files. Only the train merges. See [Merge train](/docs/merge-train).

## Needs-you dot {#needs-you}

The dot on a project in the sidebar: the lead's last message waits for your reply, or a secret or approval item is
open.

## Node {#node}

The fleetd process on a worker. It connects out to the hub and starts the Claude sessions.

## Pairing code {#pairing-code}

A one-time code, such as `K4QW-7RNP`, that connects the desktop app or a new worker to the hub. It lasts 15 minutes.

## Plan item {#plan-item}

One piece of a project's plan, such as `P12`, sized `s`, `m` or `l`. [Status](/docs/status) counts progress in plan
items.

## Playbook {#playbook}

The instructions a lead follows for a kind of work: a feature, a fix, research, or finishing open work.

## Policy file {#policy-file}

`.fleetd/policy.yaml` in a project's repo. It sets the tasks' model, tool rules and the branch prefix. See
[Config & files](/docs/config-and-files#policy).

## Project {#project}

A git repo on a worker that fleetd works on, with one lead and one chat. See [Projects](/docs/projects).

## Receipt {#receipt}

The small mark under a message you sent while the lead was working: whether it was queued, taken in, or acknowledged.
See [Steering](/docs/steering#receipts).

## Reviewer {#reviewer}

A Claude session that reviews a pull request. Reviewers don't read the PR description; they judge the change.

## Secret {#secret}

An item in the chat with a masked field. The value is sealed to one machine and never enters the transcript. See
[Secrets & approvals](/docs/approvals-and-secrets#secrets).

## Session {#session}

One `claude` process doing one job, such as a lead, a writer or a reviewer.

## Slot {#slot}

Room for one running session. The hub caps how many sessions run at once.

## Steer {#steer}

A message to an agent that is already working, such as "skip the docs page". In a chat, typing while the lead works
steers it. See [Steering](/docs/steering).

## Task {#task}

One job a lead hands to a session: write code, review a PR, or research.

## Tier {#tier}

The size of a change, `S`, `M` or `L`. It sets how many reviews a pull request needs. See
[Concepts](/docs/concepts#merge-train).

## Verifier {#verifier}

A session that checks that a large (`L`) change works, in addition to its two reviews.

## Wake {#wake}

A message that restarts a lead's work: your chat message, a task result, a merged PR.

## Worker {#worker}

A machine that runs agents: any machine with a node. See [Machines](/docs/machines).

## Workstream {#workstream}

fleetd's record of one piece of the lead's work, with an id such as `W41`. The lead keeps them; you never file one.

## Writer {#writer}

A Claude session that changes code. Each writer gets its own git worktree and branch, and opens a pull request.
