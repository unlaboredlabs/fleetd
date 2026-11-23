---
title: Steer and stop
description: Redirect the lead or one agent while it works, or stop it.
---

A steer is a message to the lead or an agent while it's already working. It changes course without starting over.

## Steer the lead {#lead}

1. Open the bot's chat.
2. While the lead works, type in the box. It says "It reads this at its next step."
3. Press Enter.

The lead reads it after the command it's running now finishes. A long build or test run ends first.

To cut in at once, press ⌘Enter (Ctrl+Enter on Linux and Windows). The running step stops and the lead reads your message now.

## What "next step" means {#next-step}

An agent works in steps: it thinks, runs a tool (a command, an edit, a search), reads the result, then decides.

- **Enter** waits for the running tool to finish, then delivers before the agent decides anything else.
- **⌘Enter** stops the running tool and delivers now. Nothing else is lost.

## Steer one agent {#agent}

1. Open the agent from the panel's **Agents** tab, or from the island above the message box.
2. Type in the box at the end of its work.
3. Press Enter, or ⌘Enter to stop its current step.

The lead hears what you told the agent, so its plan follows. An agent that has finished continues its conversation with your message. One that hasn't started yet can't be steered.

## Did it get through? {#receipts}

Each steer to an agent gets a small receipt under the box:

| Receipt | Means |
|---|---|
| queued | Not taken in yet. You can still withdraw it. |
| delivered | The agent took it in. |
| acknowledged | The agent replied, saying what it will do. |
| not acknowledged | It took it in but didn't reply. |
| withdrawn | You took it back. |
| failed or expired | It couldn't be delivered. The receipt says why. |

If the agent's machine is offline, the steer waits until it's back.

**Not acknowledged** and the agent still does the wrong thing? Send it again with ⌘Enter.

## Take a steer back {#withdraw}

While a steer is **queued**, click **Withdraw** on its receipt. Once delivered, it can't be taken back: send another one that says what changed.

## Stop {#stop}

- **One agent:** click **Stop** at the top of its panel. It ends at once and frees its slot.
- **The whole bot:** click **Stop** beside Send in the chat. The lead and every agent stop.

## From a terminal {#cli}

Both commands need a [personal key](/docs/chat#terminal).

```sh
# The lead: same as ⌘Enter in its chat
fleetd chat devbox/storefront "ship the API first" --now --key-file ~/.fleetd/human.key

# One agent, by the id the app shows (T88)
fleetd steer T88 "the schema changed, rebase first" --now --wait --key-file ~/.fleetd/human.key

# Take back a queued steer
fleetd steer withdraw S12 --key-file ~/.fleetd/human.key
```

`--wait` prints each receipt and exits 0 once the agent acknowledges. See the [CLI reference](/docs/reference/cli#steer).
