---
title: Steering
description: Redirect a lead or any agent while it works, see when it took your words in, and take a steer back.
---

You'll send a [steer](/docs/glossary#steer): a short message to an agent that is already working.

```text
skip the docs page, ship the API first
```

A steer goes straight to the agent. It doesn't wait for the lead's next wake, and each steer gets a
[receipt](#receipts) that says whether the agent took it in.

## Send a steer {#keys}

1. Open the order in the desktop app.
2. Type in the box under the lead's conversation.
3. Press one of two keys:

| Key | Label | What happens |
|---|---|---|
| Enter | Add to the lead's queue | The lead reads it at its [next step](#next-step). Nothing it is doing is cut short. |
| ⌘Enter (Ctrl+Enter) | Interrupt and redirect now | The lead's current step stops, and it reads your steer at once. |

When the agent is between turns, both keys do the same thing: it starts on your steer right away.

### What "next step" means {#next-step}

An agent works in steps: it thinks, runs a tool (a command, an edit, a search), reads the result, then decides what to
do next.

- **Enter** waits for the running tool to finish, then delivers your steer before the agent decides anything else.
  A test suite or a build runs to the end first. While it waits, the line above the box says what it waits for.
- **⌘Enter** stops the running tool (a long command is killed) and delivers your steer. Nothing else the agent had
  queued is dropped.

Use ⌘Enter when the running step is the thing you want stopped.

## Receipts {#receipts}

Each steer gets an id, such as `S12`, and its receipt shows under your message:

| Receipt | Means |
|---|---|
| queued | fleetd has it; the agent hasn't taken it in yet. You can still withdraw it. |
| delivered | The agent took it in. The receipt says how: a new turn, after the running tool, or by stopping that tool. |
| acknowledged | The agent's reply starts with "S12:" and says what it will do. The receipt quotes it. |
| not acknowledged | The agent's turn ended without naming S12. The receipt quotes what it said instead. |
| withdrawn | You took it back before the agent saw it. |
| failed | It couldn't be delivered. The receipt says why. |

Agents are asked to begin their next message with the steer's id. That is how fleetd knows the agent read your words
as yours.

:::tip[Not acknowledged?]
The agent saw the message but didn't say it would act on it. Read the quoted reply. If it is still doing the wrong
thing, send the steer again with ⌘Enter.
:::

If the agent's machine is offline, the steer waits ("waiting for lab-b (until 14:30)") and goes when the machine is
back. Past that time it fails. If your Claude usage is used up, it says when it will go ("held: usage resets 14:00").

## Steer any agent {#agents}

1. In an order, click an agent's lane: a writer, a reviewer, a verifier or the lead.
2. Its sheet opens: what it is doing now, its last steps, its steers, and a box with the same two keys.

When you steer an agent directly, its lead is told at its next wake: what you said, to whom, and that the agent now
works to it. The lead is never interrupted for this.

| The agent | Your steer |
|---|---|
| hasn't started yet | Reaches it with its instructions. |
| is working | Arrives at its next step, or at once with ⌘Enter. |
| has finished | Continues its conversation. |

## Take a steer back {#withdraw}

While a steer is still queued, click "withdraw" under it, or run `fleetd steer withdraw S12`. The agent never sees it.

Once delivered, a steer can't be taken back. Send another one that says what changed.

## When a steer changes the plan {#plan}

If your steer changes what the order delivers, the lead updates the plan in the same turn and names your steer:

```sh
fleetd plan drop P3 --steer S12
```

That also counts as acknowledging the steer. [Status](/docs/status) shows it on the order: "↳ you steered S12 14:02 ·
acknowledged · −1 item".

## From the command line {#cli}

`fleetd steer` speaks for you, so it needs a [human key](/docs/glossary#human-key).

1. On the hub, create one and keep it in a file only you can read:

   ```sh
   fleetd hub key create --human --name my-terminal > ~/.fleetd/me.key
   chmod 600 ~/.fleetd/me.key
   ```

2. Steer an order's lead (`W41`) or one agent (`T88`):

   ```sh
   fleetd steer W41 "skip the docs page; ship the API first" --key-file ~/.fleetd/me.key
   fleetd steer T88 "stop: the schema changed, rebase first" --now --wait --key-file ~/.fleetd/me.key
   ```

3. List recent steers, or take one back:

   ```sh
   fleetd steers W41 --key-file ~/.fleetd/me.key
   fleetd steer withdraw S12 --key-file ~/.fleetd/me.key
   ```

| Option | Does |
|---|---|
| `--now` | Same as ⌘Enter: stop the current step and deliver at once. |
| `--wait` | Print each receipt as it arrives. Exits 0 when acknowledged; 1 when not acknowledged, withdrawn or failed. |
| `--hub <url>` | The hub to use, from another machine. |

See the [CLI reference](/docs/reference/cli#steer).

A lead steers its own agents the same way with `fleetd task message T88 "<text>"`, adding `--now` to stop the
agent's current step.

From an MCP client: `steer_send {target: {workstreamId} | {taskId}, text, mode: "queue" | "now"}` (operate, human
key), `steer_withdraw {steerId}` and `steers_list {workstreamId?, taskId?}`.
