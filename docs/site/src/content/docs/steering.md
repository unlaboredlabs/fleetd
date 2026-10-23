---
title: Steering
description: Redirect the lead or one agent while it works, see when it took your words in, and take a steer back.
---

You'll send a [steer](/docs/glossary#steer): a short message to an agent that is already working. In a project's chat,
any message you send while the lead works is a steer.

```text
skip the docs page, ship the API first
```

A steer goes straight to the agent. It doesn't wait for the lead's next wake, and each steer gets a small
[receipt](#receipts) that says whether the agent took it in.

## Send a steer {#keys}

1. Open the project's chat in the desktop app.
2. While the lead works, type in the box at the bottom. It says "Message the lead. It reads this at its next step."
3. Press Enter.

The lead reads your message at its [next step](#next-step). Nothing it is doing is cut short. When the lead is idle,
the same message starts its next turn instead.

To stop the running step and deliver at once, press ⌘Enter (Ctrl+Enter on Linux and Windows) instead. The box shows
"⌘↩ stops its step and sends now" whenever the lead works. When it's idle, ⌘Enter sends as Enter does. Either way your
words are a chat message like any other; one sent with ⌘Enter says under it that the lead stopped its step to read it.
From a terminal, `fleetd chat <project> "…" --now` does the same.

### What "next step" means {#next-step}

An agent works in steps: it thinks, runs a tool (a command, an edit, a search), reads the result, then decides what to
do next.

- **A steer** waits for the running tool to finish, then reaches the agent before it decides anything else. A test
  suite or a build runs to the end first.
- **⌘Enter** (or `--now`) stops the running tool (a long command is killed) and delivers your steer. Nothing else the agent had
  queued is dropped.

## Receipts {#receipts}

Each steer to an agent (and each `fleetd steer` to an order's lead) gets a receipt. In the app it shows under the
agent's box; from a terminal it carries the steer's id, such as `S12`. A message to the lead in its chat has its
own line instead (see [Chat](/docs/chat#steer)).

| Receipt | Means |
|---|---|
| queued | fleetd has it; the agent hasn't taken it in yet. You can still withdraw it. |
| delivered | The agent took it in. The receipt says how: a new turn, after the running tool, or by stopping that tool. |
| acknowledged | The agent replied after taking it in, saying what it will do. Under an agent's box, the receipt quotes it. |
| not acknowledged | The agent's turn ended without a reply after taking it in. |
| withdrawn | You took it back before the agent saw it. |
| failed | It couldn't be delivered. The receipt says why. |
| expired | The agent's machine stayed offline past the hub's queue time, so it was never delivered. |

:::tip[Not acknowledged?]
The agent took the message in but ended its turn without replying. If it is still doing the wrong thing, send it
again with ⌘Enter (or `fleetd steer … --now`) to stop its current step.
:::

If the agent's machine is offline, the steer waits ("waiting for lab-b (until 14:30)") and goes when the machine is
back. Past that time it is **expired**.

## Steer one agent {#agents}

Open an agent from **Agents** (or the agents strip in its project's chat) and type in the box under its work. Enter
sends at its next step; ⌘Enter stops its current step. Your recent steers to it show above the box with their
receipts. From a terminal, `fleetd steer T88 "…"` does the same.

Its lead is told at its next wake: what you said, to whom, and that the agent now works to it. The lead is never
interrupted for this.

| The agent | Your steer |
|---|---|
| is working | Arrives at its next step, or at once with ⌘Enter (`--now`). |
| has finished | Continues its conversation. |
| hasn't started yet | Is refused: "T88 has not started yet." Wait for it to start, or cancel it and spawn it with the new prompt. |

## Take a steer back {#withdraw}

While a steer is still queued, click **Withdraw** on its receipt, or run `fleetd steer withdraw S12`. The agent never
sees it.

Once delivered, a steer can't be taken back. Send another one that says what changed.

## When a steer changes the plan {#plan}

If your steer changes what the work delivers, the lead updates the plan in the same turn and names your steer (S12)
on the change.

That also counts as acknowledging the steer.

## From the command line {#cli}

`fleetd steer` speaks for you, so it needs a [human key](/docs/glossary#human-key).

1. On the hub, create one and keep it in a file only you can read:

   ```sh
   (umask 077; fleetd hub key create --human --name terminal > ~/.fleetd/human.key)
   ```

2. Steer one agent (`T88`), or the lead working on `W41`. To reach the lead in its chat, use
   `fleetd chat <project> "…" --now` instead: that is the same message ⌘Enter sends.

   ```sh
   fleetd steer W41 "skip the docs page; ship the API first" --key-file ~/.fleetd/human.key
   fleetd steer T88 "stop: the schema changed, rebase first" --now --wait --key-file ~/.fleetd/human.key
   ```

3. List recent steers, or take one back:

   ```sh
   fleetd steers W41 --key-file ~/.fleetd/human.key
   fleetd steer withdraw S12 --key-file ~/.fleetd/human.key
   ```

| Option | Does |
|---|---|
| `--now` | Stop the current step and deliver at once. |
| `--wait` | Print each receipt as it arrives. Exits 0 when acknowledged; 1 when not acknowledged, withdrawn, failed or expired. |
| `--hub <url>` | The hub to use, from another machine. |

See the [CLI reference](/docs/reference/cli#steer).

A lead steers its own agents the same way through its own task message call, and can stop the agent's current step.

From an MCP client: `steer_send {target: {workstreamId} | {taskId}, text, mode: "queue" | "now", clientRequestId}`
(operate, human key), `steer_withdraw {steerId}`; `order_get {workstreamId}` lists the order's newest steers. `clientRequestId` is any
unique string; sending the same one again doesn't send the steer twice. To the lead in its chat, ⌘Enter is
`chat_send {projectRef, text, now: true, clientRequestId}` (human key).
