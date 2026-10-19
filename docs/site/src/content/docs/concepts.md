---
title: Concepts
description: The hub, nodes, Claude sessions and the clients that talk to them, and what happens to an order.
---

This page shows how fleetd's parts fit together and what happens to a piece of work. Every term is also in the
[Glossary](/docs/glossary).

## The parts

<figure>
<svg viewBox="0 0 680 400" role="img" aria-labelledby="fleet-title fleet-desc" style="width:100%;height:auto;max-width:680px" font-family="inherit" font-size="14" fill="none" stroke="currentColor">
<title id="fleet-title">fleetd's parts</title>
<desc id="fleet-desc">The desktop app and the CLI or MCP clients talk to the hub. Each node dials out to the hub and runs Claude sessions on its machine.</desc>
<defs><marker id="fleet-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="currentColor" stroke="none"/></marker></defs>
<rect x="110" y="16" width="200" height="48" rx="6"/>
<text x="210" y="45" text-anchor="middle" fill="currentColor" stroke="none">Desktop app</text>
<rect x="370" y="16" width="200" height="48" rx="6"/>
<text x="470" y="45" text-anchor="middle" fill="currentColor" stroke="none">CLI and MCP clients</text>
<path d="M210 64 300 126" marker-end="url(#fleet-arrow)" marker-start="url(#fleet-arrow)"/>
<path d="M470 64 380 126" marker-end="url(#fleet-arrow)" marker-start="url(#fleet-arrow)"/>
<rect x="190" y="128" width="300" height="64" rx="6" stroke-width="2"/>
<text x="340" y="156" text-anchor="middle" fill="currentColor" stroke="none" font-weight="600">Hub</text>
<text x="340" y="178" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">projects · orders · asks · merge train</text>
<path d="M175 260 290 194" marker-end="url(#fleet-arrow)"/>
<path d="M505 260 390 194" marker-end="url(#fleet-arrow)"/>
<text x="205" y="222" text-anchor="end" fill="currentColor" stroke="none" font-size="12">dials out</text>
<text x="475" y="222" fill="currentColor" stroke="none" font-size="12">dials out</text>
<rect x="30" y="262" width="290" height="124" rx="6"/>
<text x="175" y="286" text-anchor="middle" fill="currentColor" stroke="none" font-weight="600">Node on machine A</text>
<rect x="46" y="300" width="80" height="34" rx="4" stroke-dasharray="4 3"/>
<text x="86" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">lead</text>
<rect x="135" y="300" width="80" height="34" rx="4" stroke-dasharray="4 3"/>
<text x="175" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">writer</text>
<rect x="224" y="300" width="80" height="34" rx="4" stroke-dasharray="4 3"/>
<text x="264" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">reviewer</text>
<text x="175" y="366" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">claude sessions</text>
<rect x="360" y="262" width="290" height="124" rx="6"/>
<text x="505" y="286" text-anchor="middle" fill="currentColor" stroke="none" font-weight="600">Node on machine B</text>
<rect x="376" y="300" width="80" height="34" rx="4" stroke-dasharray="4 3"/>
<text x="416" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">writer</text>
<rect x="465" y="300" width="80" height="34" rx="4" stroke-dasharray="4 3"/>
<text x="505" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">writer</text>
<rect x="554" y="300" width="80" height="34" rx="4" stroke-dasharray="4 3"/>
<text x="594" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">verifier</text>
<text x="505" y="366" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">claude sessions</text>
</svg>
</figure>

| Part | What it is | How many |
|---|---|---|
| **Hub** | The coordinator. It stores all state and serves the app, the nodes and MCP clients on one port. | One per fleet, on an always-on machine. |
| **Node** | The fleetd process on a machine that runs agents. It connects out to the hub, so the machine opens no port. | One per worker. |
| **Worker** | Any machine with a node. The hub machine is usually a worker too. | As many as you like. |
| **Claude session** | One `claude` process doing one job: a lead, a writer, a reviewer. It uses your own `~/.claude` setup. | Many per node. |
| **Desktop app** | Where you give work, follow it and answer questions. | Any number of devices. |
| **CLI and MCP clients** | `fleetd` commands, and agents such as Claude Code connected to `<hub url>/mcp`. | Any number. |

The hub keeps its data in one SQLite file, `~/.fleetd/hub/hub.sqlite`. See [Config & files](/docs/config-and-files).

## What happens to an order

1. You send an **order**: one line, such as `fix the typo in the README`.
2. The hub picks the **project** (a git repo on a worker) and wakes its **lead**.
3. The lead writes a **brief**: the plan, and the done-when checks that prove the work is finished.
4. The lead starts **tasks**. Each writer gets its own git worktree and branch, and opens a pull request.
5. Reviewers check each pull request. The **merge train** merges it once CI passes on the exact commit.
6. The lead claims the order is done (`claim_done`). The hub runs the done-when checks itself, and only all of
   them passing makes it done.

When the lead needs a decision, it sends you an **ask**. You can redirect any agent while it works with a **steer**.

## The terms

### Hub {#hub}

One per fleet. It holds projects, leads, briefs, tasks, asks and decisions, the merge trains and checks. Start it
with `fleetd init`, which runs it as a service. It listens on port 4790 by default.

### Node and worker {#nodes}

Each worker runs one `fleetd node`. The node starts one `claude` process per live session, each writer in its own git
worktree. Sessions use your claude setup on that machine: the same login, proxy and MCP servers as `claude` in your
shell. See [Machines](/docs/machines).

### Lead {#leads}

Each project has one lead: a long-running Claude session that turns orders into briefs and tasks. It never writes
code. A project's first order starts it. It runs on `claude-opus-5-5` by default. Its tools are listed in
[Agent tools](/docs/reference/agent-tools).

### Order {#orders}

One line of intent, sent from the app, the CLI or MCP (`intake_submit`). A leading `@project` names the project;
otherwise the hub picks one or asks you. Inside fleetd an order is a **workstream**, with an id such as `W41`.

### Ask and decision {#asks}

A lead asks you only about product calls, money, credentials and irreversible steps. Asks arrive numbered in the
inbox, and you answer in one line (`1 go 2 nvm 3 b`). Each answer becomes a **decision** in a searchable log, so the
same question is never asked twice. See [Approvals & secrets](/docs/approvals-and-secrets) for commands and secrets.

### Merge train {#merge-train}

Only fleetd merges. Each repo has one train, a queue that rebases each ready pull request, waits for CI on that exact
commit, and squash-merges it. You can pause a repo's train with the `train_freeze` tool.

A pull request's **tier** sets its reviews:

| Tier | Reviews needed before merge |
|---|---|
| S | none |
| M | one clean review |
| L | two clean reviews and a verifier |

A repo with no CI merges on fleetd's own checks, and the merge says so. Each pull request body needs a `Source:`
line that names what it serves.

### Done, checked {#done}

A lead can't just say "done". It calls `claim_done`, and the hub runs the brief's done-when checks itself: a PR
merged, CI green, a command on a machine, an HTTP check, a judge, or a person. Each claim keeps its evidence and exit
codes.

## What agents can call

Leads and tasks act through fleetd's MCP tools, never Claude's own subagents. A lead starts agents with
`spawn_agent`; a task reports back with `report`, `ask_lead` and `claim_done`.

- [Agent tools](/docs/reference/agent-tools): every tool an agent can call, generated from the code.
- [What agents are told](/docs/what-agents-are-told): every prompt fleetd sends a model.
