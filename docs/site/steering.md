---
title: Steering
section: Using fleetd
order: 52
description: Redirect a lead or any agent while it works, know when it took your words in, and take a steer back.
---

A steer is a short message to an agent that is already working: "skip the docs page, ship the API first". It goes
straight to the agent, never waits for the lead's next wake, and every steer gets a receipt saying whether the agent
took it in and acted on it.

## The two keys {#keys}

In an order, the box under the conversation steers its lead:

| Key | Label | What happens |
|---|---|---|
| Enter | Add to the lead's queue | The lead takes it in at its next step, as its own turn. Nothing it is doing is cut short |
| ⌘Enter (Ctrl+Enter) | Interrupt and redirect now | The lead's current step is stopped and your steer is delivered at once |

When the agent is between turns, both keys do the same thing: it starts on your steer right away.

### What "next step" means {#next-step}

An agent works in steps: it thinks, runs a tool (a command, an edit, a search), reads the result, and decides what to
do next. Enter waits for the tool the agent is running to finish, then delivers your steer before it decides
anything else. Most tools take a second or two, but a test suite or a build can take minutes, and Enter waits for all
of it. While it waits, the line above the box says what it waits for ("S12 waits for the lead's next step
(`cargo test` running 1m12s)").

If the running step is the thing you want stopped, use ⌘Enter. The tool is stopped (a long command is killed), its
step ends there, and the agent starts on your steer. Nothing else the agent had queued is dropped.

## Receipts {#receipts}

Each steer gets an id, `S12`, and its receipt shows under your message in the conversation:

| Receipt | Means |
|---|---|
| queued | fleetd has it; the agent has not taken it in yet. "withdraw" is still possible |
| delivered | The agent took it in: it started a turn, came after the running tool, or stopped that tool (the receipt names it) |
| acknowledged | The agent's reply begins with "S12:" and says what it will do. The receipt quotes it |
| not acknowledged | The agent's turn ended without naming S12. The receipt quotes what it said instead |
| withdrawn | You took it back before the agent saw it |
| failed | It could not be delivered; the receipt says why |

Agents are asked to begin their next message with the steer's id. That is how fleetd knows, without guessing, that
your words were read as yours.

**Not acknowledged** means the agent saw the message but did not say it would act on it. It may have taken it for
text inside a tool's output, or carried on with its old plan. Read the quoted reply: if it is still doing the wrong
thing, send the steer again with ⌘Enter, which delivers it as its own turn.

If the agent's machine is offline, the steer waits with the receipt "waiting for lab-b (until 14:30)" and goes as
soon as the machine is back; past that time it fails. If your Claude usage is used up, it says "held: usage resets
14:00".

## Steer any agent {#agents}

Click an agent's lane in an order (a writer, a reviewer, a verifier, or the lead) to open its sheet: what it is doing
now, its last steps, its steers, and a box with the same two keys aimed at that agent.

When you steer an agent directly, its lead is told at its next wake: what you said, to whom, and that the agent now
works to it, so the lead keeps its plan in line instead of undoing your steer. The lead is never interrupted for it.
Once the agent acknowledges (or doesn't), the lead's summary of the order says so.

A steer to an agent that has not started yet reaches it with its instructions; one to an agent that has finished
continues its conversation.

## Take a steer back {#withdraw}

While a steer is still queued, "withdraw" under it (or `fleetd steer withdraw S12`) takes it back, and the agent never
sees it. Once it is delivered it cannot be unsaid: send another steer that says what changed.

## When a steer changes the plan {#plan}

If your steer changes what the order delivers, the lead updates the order's plan in the same turn and names your
steer. The status view then shows it on the order: "↳ you steered S12 14:02 · acknowledged ·
−1 item".

## From the command line {#cli}

`fleetd steer` speaks for you, so it needs a human key: create one on the hub machine with
[`fleetd hub key create --human`](cli.md#hub-key-create-human), and keep it in a file only you can read.

```sh
fleetd steer W41 "skip the docs page; ship the API first" --key-file ~/.fleetd/me.key
fleetd steer T88 "stop: the schema changed, rebase first" --now --wait --key-file ~/.fleetd/me.key
fleetd steers W41 --key-file ~/.fleetd/me.key
fleetd steer withdraw S12 --key-file ~/.fleetd/me.key
```

`W41` steers that order's lead, `T88` one agent. `--now` is ⌘Enter. `--wait` prints each receipt as it arrives and
exits 0 once the agent acknowledged, 1 if it was not acknowledged, withdrawn or failed. On another machine add
`--hub <url>`. See the [CLI reference](cli.md#steer).

A lead steers its own agents the same way with `fleetd task message T88 "<text>"`, adding `--now` to stop the agent's
current step.

From an MCP client: `steer_send {target: {workstreamId} | {taskId}, text, mode: "queue" | "now"}` (operate, human
key), `steer_withdraw {steerId}` and `steers_list {workstreamId?, taskId?}`.
