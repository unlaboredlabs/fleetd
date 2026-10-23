---
title: Concepts
description: The hub, nodes, Claude sessions and the clients that talk to them, and how work flows from a chat to a merge.
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
<text x="340" y="178" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">projects · lead chats · merge train</text>
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
<text x="594" y="322" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">reviewer</text>
<text x="505" y="366" text-anchor="middle" fill="currentColor" stroke="none" font-size="12">claude sessions</text>
</svg>
</figure>

| Part | What it is | How many |
|---|---|---|
| **Hub** | The coordinator. It stores all state and serves the app, the nodes and MCP clients on one port. | One per fleet, on an always-on machine. |
| **Node** | The fleetd process on a machine that runs agents. It connects out to the hub, so the machine opens no port. | One per worker. |
| **Worker** | Any machine with a node. The hub machine is usually a worker too. | As many as you like. |
| **Claude session** | One `claude` process doing one job: a lead, a writer, a reviewer. It uses your own `~/.claude` setup. | Many per node. |
| **Desktop app** | Where you chat with each project's lead and see the fleet's status. | Any number of devices. |
| **CLI and MCP clients** | `fleetd` commands, and agents such as Claude Code connected to `<hub url>/mcp`. | Any number. |

The hub keeps its data in one SQLite file, `~/.fleetd/hub/hub.sqlite`. See [Config & files](/docs/config-and-files).

## How work flows {#flow}

1. You open a **project** (a git repo on a worker) and write to its **lead** in the chat, such as
   `fix the typo in the README`.
2. The lead plans the work: what to build, and the done-when checks that prove it is finished.
3. The lead starts **tasks**. Each writer gets its own git worktree and branch, and opens a pull request.
4. Reviewers check each pull request. The **merge train** merges it once CI passes on the exact commit.
5. The lead claims the work is done (`claim_done`). The hub runs the done-when checks itself, and only all of them
   passing makes it done.
6. The lead tells you in the chat.

When the lead needs a decision, it asks you in the chat. Typing while it works **steers** it.

## The terms

### Hub {#hub}

One per fleet. It holds projects, the lead chats, plans, tasks, decisions, the merge trains and checks. Start it
with `fleetd init`, which runs it as a service. It listens on port 4790 by default.

### Node and worker {#nodes}

Each worker runs one `fleetd node`. The node starts one `claude` process per live session, each writer in its own git
worktree. Sessions use your claude setup on that machine: the same login, proxy and MCP servers as `claude` in your
shell. See [Machines](/docs/machines).

### Lead and its chat {#leads}

Each project has one lead: a long-running Claude session that plans the work and runs the agents. It never writes
code. You talk to it in one ongoing chat per project, in plain messages; it answers short, state first. Your first
message starts it. It runs on `claude-opus-5-5` by default. See [Chat with the lead](/docs/chat).

The lead keeps its own plan and bookkeeping. Inside fleetd a piece of work is a **workstream**; you never file one.
Its tools are listed in [Agent tools](/docs/reference/agent-tools).

### Decisions {#decide}

A lead asks only about product calls, money and irreversible steps, in the chat, as numbered items with a
recommendation each. You reply tersely (`1 go, 2 rec`) or in your own words. The lead logs each answer with `decide`,
into a searchable decision log, so it never asks the same question twice.

### Secrets and approvals {#inline-items}

Two things never travel as chat text. They show as items inside the chat:

| Item | Shows | You |
|---|---|---|
| Secret | A masked field: the machine and where the value goes | Type the value. It is sealed to that machine and never enters the transcript. |
| Approval | The exact command a lead wants to run, why, and where | Approve or Deny. |

See [Secrets & approvals](/docs/approvals-and-secrets).

### The agents strip {#strip}

Fleet activity stays quiet inside the chat: a compact strip under the lead's message says how many agents are
working, one line each, and expands to their lanes and time. Pull requests and merges show as one-line events.

### Max agents {#max-agents}

A per-project cap, and a fleet-wide one, on how many agents run at once. Agents over the cap queue rather than fail,
and the lead plans its work to the cap. See [Max agents](/docs/projects#max-agents).

### Merge train {#merge-train}

Only fleetd merges. Each repo has one train, a queue that rebases each ready pull request, waits for CI on that exact
commit, and squash-merges it. Ready PRs that touch different files merge together in one CI run. See
[Merge train](/docs/merge-train).

Every pull request merges on one clean review of its current commit plus green CI. A repo with no CI holds its PRs
until it has some.

### Done, checked {#done}

A lead can't just say "done". It calls `claim_done`, and the hub runs the brief's done-when checks itself: a PR
merged, CI green, a command on a machine, an HTTP check, a judge, or a person. Each claim keeps its evidence and exit
codes.

## What agents can call

Leads and tasks act through fleetd's MCP tools, never Claude's own subagents. A lead starts agents with
`spawn_agent`; a task reports back with `report` and `ask_lead`.

- [Agent tools](/docs/reference/agent-tools): every tool an agent can call, generated from the code.
- [What agents are told](/docs/what-agents-are-told): every prompt fleetd sends a model.
