---
title: Glossary
description: Every fleetd term in one or two sentences, with a link to where it is used.
---

Every fleetd term, A to Z. Each one links to the page that uses it most.

## Agent key {#agent-key}

A key that lets an MCP client or script call the hub, with a role (`read`, `operate` or `admin`). It starts with
`fld_` and is shown once, or written to a file only you can read. What it writes in a chat shows as that agent's,
never yours. See [MCP clients](/docs/mcp-clients).

## Agents' Mac {#agents-mac}

A Mac that lends iOS simulators, Xcode builds and its own screen to agents on your other machines, through the hub. It
runs no agents itself. See [The agents' Mac](/docs/agents-mac).

## Agents strip {#agents-strip}

The slim row above a chat's message box while agents work: a dot per agent, how many are working or need you, and
what the busiest one is doing. It opens to a row per agent.

## Approval {#approval}

An item in the chat that shows a [gated command](#gated-command) with Approve and Deny. See
[Secrets & approvals](/docs/approvals-and-secrets#approve).

## Artifact {#artifact}

A report too long for a chat message, in Markdown or HTML, that the lead or an agent publishes in a project's chat.
Each new version under the same name is kept. See [Reports in Artifacts](/docs/chat#artifacts).

## Automation {#automation}

A prompt kept for a project with what starts it: a schedule, a one-time date, a webhook or Run now. Each run opens an
[order](#workstream) for the lead. See [Automations](/docs/automations).

## Brief {#brief}

The plan a lead writes for a piece of work before it starts: what to build, and what done looks like.

## Chat {#chat}

The one ongoing conversation with a project's lead. You give work and answer the lead there. See
[Chat with the lead](/docs/chat).

## Checklist {#checklist}

The lead's to-do list for a project: a few items per piece of work, each to do, doing or done. You see it in the
panel's Plan tab. See [The checklist](/docs/what-agents-are-told#checklist).

## Critical path {#critical-path}

The chain of work that decides when a piece of work finishes. Shortening it makes it finish sooner. See
[Where time went](/docs/time-inspector#critical-path).

## Decision {#decision}

Your answer to a lead's question, logged by the lead with `decide` in a searchable log. A later question that a
decision already answers is never asked again.

## Done-when {#done-when}

A line in a brief saying what done looks like. Writers and reviewers read it; the lead closes the work, with why, once
it holds.

## Gated command {#gated-command}

A command a lead wants to run that is irreversible, costs money or uses a credential. It runs only after you approve
it in the chat. See [Secrets & approvals](/docs/approvals-and-secrets).

## Hub {#hub}

The coordinator of a fleet. It runs on one always-on machine and stores all state. See [Concepts](/docs/concepts).

## Hub link {#hub-link}

A key that lets a project on one hub ask for work in projects on another hub, acting as you. See
[Hub links](/docs/projects#hub-links).

## Human key {#human-key}

A key that belongs to a person's device, such as the desktop app. Only a human key writes to a lead as you, approves
commands, enters secrets or steers: what it sends counts as yours. Every human key belongs to a
[person](#person).

## Invite {#invite}

A [pairing code](#pairing-code) bound to a new person, or to another device of someone on the hub, from
`fleetd invite`. It works once, for 7 days. See [People & invites](/docs/people#invite).

## Lead {#lead}

The long-running Claude session that plans a project's work and runs its agents. Each project has one, and one chat
with you. With repos it never writes code: its writers do. With none, it does the work itself.

## Max agents {#max-agents}

The cap on how many agents run at once, per project and across the fleet. Agents over it queue. See
[Max agents](/docs/projects#max-agents).

## Merge train {#merge-train}

The queue that merges a repo's pull requests after CI passes on the exact commit, in batches when several are ready.
Only the train merges. See [Merge train](/docs/merge-train).

## Needs-you word {#needs-you}

The word on a project in the sidebar when it wants you: "reply" while the lead's last message waits for your answer,
"secret" or "approve" while such an item is open, "blocked" when something outside the work holds it up. A dot there
means only a new message from the lead.

## Node {#node}

The fleetd process on a worker. It connects out to the hub and starts the Claude sessions.

## Only me {#only-me}

A project's switch that keeps it to its owner: only they see it and use it, admins included. On by default for a
project with no repo. See [Only me](/docs/projects#only-me).

## Order {#order}

One piece of work you asked a lead for, with an id such as `W41`. The lead opens and closes it; you never file one.
The tools call it a [workstream](#workstream).

## Pairing code {#pairing-code}

A one-time code, such as `K4QW-7RNP`, that connects the desktop app or a new worker to the hub. It lasts 15 minutes.
The app's code grants the role it was printed with (`fleetd pair --role`, default `admin`).

## Person {#person}

Someone on the hub, with a name and a role (owner, admin or member), who owns their devices. What they do is recorded
under their name. See [People & invites](/docs/people).

## Policy file {#policy-file}

An optional `.fleetd/policy.yaml` in a project's checkout. It sets tool rules and the branch prefix. See
[Config & files](/docs/config-and-files#policy).

## Project {#project}

A chat with one lead, in a folder of its own on a worker, holding zero or more git repos. With repos, its lead
plans the work and its agents open pull requests; with none, the lead does the work itself. Every project has the
same abilities: memory, automations, screens, kept sign-ins, purchases and skills. See
[Projects](/docs/projects).

## Receipt {#receipt}

The small mark under a message you sent while the lead was working: whether it was queued, taken in, or acknowledged.
See [Steering](/docs/steering#receipts).

## Reviewer {#reviewer}

A Claude session that reviews a pull request. Reviewers don't read the PR description; they judge the change.

## Screen {#screen}

A browser, Android emulator or Linux desktop an agent opens with `session_start`, or the agents' Mac's screen it borrows. You can watch it live,
take it over and replay its recording. See [Screens](/docs/browser-sessions).

## Secret {#secret}

An item in the chat with a masked field. The value is sealed to one machine and never enters the transcript. See
[Secrets & approvals](/docs/approvals-and-secrets#secrets).

## Session {#session}

One `claude` process doing one job, such as a lead, a writer or a reviewer.

## Skill {#skill}

A `SKILL.md` workflow an agent follows when it fits: from the repo, installed, or saved by a project's lead as it
learns. See [Skills](/docs/skills).

## Slot {#slot}

Room for one running agent. The hub caps how many agents run at once, per project and fleet-wide.

## Steer {#steer}

A message to an agent that is already working, such as "skip the docs page". In a chat, typing while the lead works
steers it. See [Steering](/docs/steering).

## Task profile {#task-profile}

A named model, reasoning level and fast mode that agents run on. The hub keeps them and picks the default and the
one leads start on; each project allows some for its agents. See [Models and cost](/docs/projects#models).

## Task {#task}

One job a lead hands to a session: write code, review a PR, or research.

## Wake {#wake}

A message that restarts a lead's work: your chat message, a task result, a merged PR.

## Worker {#worker}

A machine that runs agents: any machine with a node. See [Machines](/docs/machines).

## Workstream {#workstream}

fleetd's record of an [order](#order), with an id such as `W41`, as the tools and the CLI name it
(`workstreamId`, `fleetd time W41`). The lead keeps them; you never file one. Each is open until the lead closes it as
done, or it is stopped. Its agents show under it
in the panel's Agents.

## Writer {#writer}

A Claude session that changes code. Each writer gets its own git worktree and branch, and opens a pull request.
